/**
 * The analytics routes over HTTP (Phase 6A slice 6A-1; contract ns/analytics.ts and ns/analytics-config.ts; kernel 1240
 * to 1245; ADR 0020; draft controls DI-51, DI-52, DI-53; PR-60; DI-09): the catalogue lists every method of the
 * registry and none changes GMP data; a method version is made effective only by a person holding ANALYTICS.METHOD under
 * a change record QA approved with its signature, and the methods page lists it with its validity and record; QA's
 * dispositions are the person's own, audited, superseded only with a reason; flags about a person need
 * ANALYTICS.DI_REVIEW; every read needs ANALYTICS.VIEW; the sandbox serves none of it.
 *
 * Flags are written as the analytics role through its functions (support.ts flagAs), as the runner writes them
 * (runner.test.ts proves the runner's own path).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METHOD_IDS, METHODS, defaultParameters } from '@ebmr/analytics';
import { routes } from '@ebmr/api-contract';
import { parametersSha256 } from '../../src/analytics/catalog.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';
import { flagAs, releaseMethodVersion } from './support.ts';

let gmp: TestServer;
let qa: TestBrowser;
let qa2: TestBrowser;
let head: TestBrowser;
let author: TestBrowser;
let steward: TestBrowser;
let diLead: TestBrowser;
let diLeadId: string;

const codeIn = (r: Parameters<typeof refusalOf>[0]): string => {
  const f = refusalOf(r);
  return `${f.code} ${f.why}`.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? f.code;
};

/** A change record covering `areas`, raised by the steward and approved by QA's signature. */
async function approvedChangeRecord(areas: string[]): Promise<string> {
  const number = `CR-ANA-${randomUUID().slice(0, 8).toUpperCase()}`;
  valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number, title: 'Analytics method in force', description: 'Advisory analytics method under change control', areas } }));
  const signed = await signAction(gmp, qa2, 'qaApprover2', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number });
  expect(signed.ok).toBe(true);
  return number;
}

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  [qa, qa2, head, author, steward] = await Promise.all([
    gmp.asPersona('qaInvestigator'), gmp.asPersona('qaApprover2'), gmp.asPersona('head1'), gmp.asPersona('author'), gmp.asPersona('steward'),
  ]);
  const lead = await grantedPerson(gmp, 'CSV_DI_LEAD', 'Lata Krishnan (DI lead)');
  diLeadId = lead.personId;
  diLead = await loginOf(gmp, lead);
  await releaseMethodVersion(gmp, 'SPC.IMR', 1);
  await releaseMethodVersion(gmp, 'ATA.RULES', 1);
}, 900_000);
afterAll(async () => {
  await gmp?.close();
});

describe('the analytics routes (GMP)', () => {
  it('[PR-60] the analytics catalogue lists every method and none changes GMP data', async () => {
    const c = valueOf(await qa.call(routes.analytics.catalog));
    expect(c).toMatchObject({ advisory: true, notForGmpDecisions: true, method: null, run: null });
    expect(c.methods.map((m) => m.id)).toEqual([...METHOD_IDS]);
    for (const m of c.methods) {
      const entry = METHODS[m.id];
      expect(m, m.id).toEqual({
        id: entry.id, title: entry.title, intendedUse: entry.intendedUse, slice: entry.slice, outputKinds: [...entry.outputKinds], flagRules: [...entry.flagRules],
        inputs: [...entry.inputs], changesGmpData: false, effectiveVersions: m.effectiveVersions,
      });
      expect(m.intendedUse, m.id).toMatch(/advisory/);
    }
    expect(c.methods.find((m) => m.id === 'SPC.IMR')!.effectiveVersions).toEqual([1]);
    expect(c.methods.find((m) => m.id === 'CAP.INDEX')!.effectiveVersions).toEqual([]);
    expect(c.inputs.filter((i) => i.ownerSlice === '6A-1').map((i) => i.name)).toEqual(['report.batch_fact_v1', 'report.batch_outcome_v1', 'report.cpp_value_v1', 'report.step_use_v1']);
  });

  it('[DI-52][DI-09] a method version without an approved change record is refused; under one it is listed with its intended use, parameters hash, validation reference, validity and change record', async () => {
    const parameters = defaultParameters('CAP.INDEX') as Record<string, unknown>;
    const body = { method: 'CAP.INDEX' as const, version: 1, status: 'EFFECTIVE' as const, title: 'Process capability', intendedUse: 'Show Cpk and Ppk with intervals (advisory)',
                   acceptanceJson: JSON.stringify({ referenceValues: 'within 1e-9 relative', falseAlarmRateMax: 0.05 }), parametersJson: JSON.stringify(parameters),
                   validationRef: 'VAL-ANA-CAP-1', reason: 'capability for the PQR annex' };
    expect(codeIn(await qa.call(routes.analyticsConfig.setMethodVersion, { body: { ...body, changeRecord: 'CR-NOT-THERE' } }))).toBe('EBMR-CFG-002');
    const other = await approvedChangeRecord(['RBE_RULE']);
    expect(codeIn(await qa.call(routes.analyticsConfig.setMethodVersion, { body: { ...body, changeRecord: other } }))).toBe('EBMR-CFG-004');
    const number = await approvedChangeRecord(['ANALYTICS_METHOD']);
    // The head of production may read analytics but not change a method; parameters that do not fit are refused.
    expect(codeIn(await head.call(routes.analyticsConfig.setMethodVersion, { body: { ...body, changeRecord: number } }))).toBe('EBMR-IAM-040');
    const bad = refusalOf(await qa.call(routes.analyticsConfig.setMethodVersion, { body: { ...body, parametersJson: JSON.stringify({ minBatches: 10 }), changeRecord: number } }));
    expect(bad).toMatchObject({ status: 422, code: 'EBMR-ANA-015' });
    expect(bad.why).toMatch(/minBatches is outside/);
    expect(refusalOf(await qa.call(routes.analyticsConfig.setMethodVersion, { body: { ...body, parametersJson: '[1, 2]', changeRecord: number } }))).toMatchObject({ status: 422, code: 'EBMR-ANA-015' });
    const made = valueOf(await qa.call(routes.analyticsConfig.setMethodVersion, { body: { ...body, changeRecord: number } }));
    expect(made.version).toMatchObject({
      method: 'CAP.INDEX', version: 1, status: 'EFFECTIVE', intendedUse: body.intendedUse, parametersSha256: parametersSha256(parameters),
      codeIdentity: '@ebmr/analytics 0.1.0 (commit development)', validationRef: 'VAL-ANA-CAP-1', validTo: null, changeRecord: number,
    });
    // Changed parameters under the same version: refused (a new version is needed).
    expect(codeIn(await qa.call(routes.analyticsConfig.setMethodVersion, { body: { ...body, parametersJson: JSON.stringify({ ...parameters, minBatches: 30 }), changeRecord: number } }))).toBe('EBMR-ANA-013');
    // Retired: the first row now has its end, and the catalogue shows no version in force.
    valueOf(await qa.call(routes.analyticsConfig.setMethodVersion, { body: { ...body, status: 'RETIRED', changeRecord: number } }));
    const page = valueOf(await head.call(routes.analytics.methods));
    const cap = page.versions.filter((v) => v.method === 'CAP.INDEX');
    expect(cap.map((v) => [v.status, v.validTo === null, v.changeRecord])).toEqual([['EFFECTIVE', false, number], ['RETIRED', true, number]]);
    expect(valueOf(await qa.call(routes.analytics.catalog)).methods.find((m) => m.id === 'CAP.INDEX')!.effectiveVersions).toEqual([]);
    // The configuration history shows the method like any other area, with its record.
    const areas = valueOf(await qa.call(routes.config.areas)).areas.map((a) => a.code);
    expect(areas).toEqual(expect.arrayContaining(['ANALYTICS_METHOD', 'ANALYTICS_REFERENCE']));
  });

  it('[DI-52] a disposition is recorded by the person who gave it, audited, and superseded only with a reason', async () => {
    const batchRef = randomUUID();
    const { flag } = await flagAs(gmp, 'SPC.IMR', 'BATCH', batchRef);
    const open = valueOf(await qa.call(routes.analytics.flags));
    const listed = open.flags.find((f) => f.flagId === flag);
    expect(listed).toMatchObject({ method: { id: 'SPC.IMR', version: 1 }, subjectKind: 'BATCH', subjectRef: batchRef, subjectLabel: batchRef, rule: 'NELSON_2', restricted: false, disposition: null, drill: null });
    expect(open).toMatchObject({ advisory: true, notForGmpDecisions: true });
    expect(open.dataAgeSeconds).toBeGreaterThan(0);
    // The head of production reads but does not disposition.
    expect(codeIn(await head.call(routes.analytics.dispose, { params: { flagId: flag }, body: { verdict: 'FALSE_ALARM', cause: 'not my call to make here' } }))).toBe('EBMR-IAM-040');
    const first = valueOf(await qa.call(routes.analytics.dispose, { params: { flagId: flag }, body: { verdict: 'FALSE_ALARM', cause: 'Gauge recalibrated before the batch', deviationRef: null } }));
    expect(first.disposition).toMatchObject({ verdict: 'FALSE_ALARM', person: { legalName: 'Divya Menon' }, current: true, supersedes: null });
    expect(first).toMatchObject({ method: { id: 'SPC.IMR', version: 1 } });
    expect(valueOf(await qa.call(routes.analytics.flags)).flags.some((f) => f.flagId === flag)).toBe(false);
    expect(codeIn(await qa2.call(routes.analytics.dispose, { params: { flagId: flag }, body: { verdict: 'TRUE_SIGNAL', cause: 'Seen again on the next batch' } }))).toBe('EBMR-ANA-008');
    expect(codeIn(await qa2.call(routes.analytics.dispose, { params: { flagId: flag }, body: { verdict: 'TRUE_SIGNAL', cause: 'Seen again on the next batch', supersedes: first.disposition.dispositionId } }))).toBe('EBMR-ANA-008');
    const second = valueOf(await qa2.call(routes.analytics.dispose, {
      params: { flagId: flag }, body: { verdict: 'TRUE_SIGNAL', cause: 'Seen again on the next batch', supersedes: first.disposition.dispositionId, reason: 'New evidence', deviationRef: 'DEV-2026-0042' },
    }));
    const detail = valueOf(await qa.call(routes.analytics.flag, { params: { flagId: flag } }));
    expect(detail.dispositions.map((d) => [d.verdict, d.person.legalName, d.current, d.reason, d.deviationRef])).toEqual([
      ['FALSE_ALARM', 'Divya Menon', false, null, null], ['TRUE_SIGNAL', 'Arvind Rao', true, 'New evidence', 'DEV-2026-0042'],
    ]);
    expect(detail.flag.disposition?.dispositionId).toBe(second.disposition.dispositionId);
    // The period list shows it with its current disposition.
    const { rows: today } = await gmp.db.admin.query<{ d: string }>("select to_char(statement_timestamp() at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as d");
    const period = valueOf(await qa.call(routes.analytics.flags, { query: { from: today[0]!.d, to: today[0]!.d } }));
    expect(period.flags.find((f) => f.flagId === flag)?.disposition?.verdict).toBe('TRUE_SIGNAL');
    expect(refusalOf(await qa.call(routes.analytics.flags, { query: { from: '2026-12-02', to: '2026-12-01' } })).status).toBe(400);
    // Audited under each person.
    const { rows: audit } = await gmp.db.admin.query<{ person: string }>(
      "select payload -> 'actor' ->> 'legal_name' as person from kernel.audit_event where table_name = 'analytics.flag_disposition' and chain_key = $1 order by seq", [`analytics_flag:${flag}`]);
    expect(audit.map((a) => a.person)).toEqual(['Divya Menon', 'Arvind Rao']);
    // The monitor counts the flag as dispositioned, and not as a false alarm (its current verdict is a real issue).
    const m = valueOf(await qa.call(routes.analytics.monitor)).rows.filter((r) => r.method === 'SPC.IMR');
    expect(m.length).toBeGreaterThan(0);
    expect(m.reduce((n, r) => n + r.flags, 0)).toBeGreaterThanOrEqual(1);
  });

  it('[DI-53] a person flag is unreadable without ANALYTICS.DI_REVIEW, also through the app role directly', async () => {
    const { flag } = await flagAs(gmp, 'ATA.RULES', 'PERSON', diLeadId);
    expect(codeIn(await qa.call(routes.analytics.flags, { query: { kind: 'PERSON' } }))).toBe('EBMR-ANA-007');
    expect(refusalOf(await qa.call(routes.analytics.flag, { params: { flagId: flag } })).status).toBe(404);
    expect(valueOf(await qa.call(routes.analytics.flags)).flags.some((f) => f.flagId === flag)).toBe(false);
    expect(valueOf(await diLead.call(routes.analytics.flags)).flags.some((f) => f.flagId === flag)).toBe(false);
    const listed = valueOf(await diLead.call(routes.analytics.flags, { query: { kind: 'PERSON' } })).flags.find((f) => f.flagId === flag);
    expect(listed).toMatchObject({ restricted: true, subjectKind: 'PERSON', subjectLabel: 'Lata Krishnan (DI lead)', method: { id: 'ATA.RULES', version: 1 } });
    expect(codeIn(await qa.call(routes.analytics.dispose, { params: { flagId: flag }, body: { verdict: 'FALSE_ALARM', cause: 'Shift change entries, documented' } }))).toBe('EBMR-ANA-007');
    const d = valueOf(await diLead.call(routes.analytics.dispose, { params: { flagId: flag }, body: { verdict: 'NOT_ASSESSABLE', cause: 'Shift change entries, documented' } }));
    expect(d.disposition).toMatchObject({ verdict: 'NOT_ASSESSABLE', current: true });
    expect(valueOf(await diLead.call(routes.analytics.flag, { params: { flagId: flag } })).dispositions).toHaveLength(1);
    // Open person flags: those without a disposition.
    expect(valueOf(await diLead.call(routes.analytics.flags, { query: { kind: 'PERSON' } })).flags.some((f) => f.flagId === flag)).toBe(false);
    for (const view of ['analytics.flag_v1', 'analytics.open_flag_v1', 'analytics.flag_disposition_v1']) {
      expect((await gmp.db.app.query(`select 1 from ${view} where flag_id = $1`, [flag])).rowCount, view).toBe(0);
    }
  });

  it('[DI-17] every analytics read needs ANALYTICS.VIEW; the sandbox serves no analytics route', async () => {
    for (const route of [routes.analytics.catalog, routes.analytics.methods, routes.analytics.monitor, routes.analytics.flags]) {
      expect(codeIn(await author.call(route)), route.id).toBe('EBMR-IAM-040');
    }
    expect(codeIn(await author.call(routes.analytics.flag, { params: { flagId: randomUUID() } }))).toBe('EBMR-IAM-040');
    expect(refusalOf(await qa.call(routes.analytics.flag, { params: { flagId: randomUUID() } })).status).toBe(404);
    const sbx = await startServer('SANDBOX');
    try {
      const r = await sbx.browser().call(routes.analytics.catalog);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === 'REFUSAL') expect(r.error.status).toBe(404);
    } finally {
      await sbx.close();
    }
  });
});
