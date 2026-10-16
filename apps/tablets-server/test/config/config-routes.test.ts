/**
 * Configuration change control over HTTP (Phase 6 slice 6f, builder A; contract ns/config.ts; kernel 1195, recipe-core
 * 1050; DI-09, DI-26). A steward raises a change record for the RBE rules; an RBE rule saved under it before QA approves
 * it is refused; QA approves it through the ceremony (CONFIG_CHANGE_ACT, CONFIG_CHANGE_APPROVED); another QA person then
 * saves a rule version under it; the configuration as of a date and the diff show it with the change record; once the
 * record is closed nothing more changes under it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let server: TestServer;
let steward: TestBrowser;
let qa: TestBrowser;
let qa2: TestBrowser;

beforeAll(async () => {
  server = await startSigningServer('GMP');
  [steward, qa, qa2] = await Promise.all([server.asPersona('steward'), server.asPersona('qaInvestigator'), server.asPersona('qaApprover2')]);
}, 600_000);
afterAll(async () => {
  await server?.close();
});

const codeIn = (r: Parameters<typeof refusalOf>[0]): string => {
  const f = refusalOf(r);
  return `${f.code} ${f.why}`.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? f.code;
};
const now = async (): Promise<string> => (await server.db.admin.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0]!.t;

describe('configuration change records and RBE rules over HTTP (DI-09, DI-26)', () => {
  it('[DI-09][DI-26] an RBE rule is changed only under a change record QA approved with its signature; the change shows in the diff with the record', async () => {
    const number = `CR-HTTP-${Date.now().toString(36).toUpperCase()}`;
    const raised = valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number, title: 'Late entries as action', description: 'Late entries shown at least as ACTION', areas: ['RBE_RULE'] } }));
    expect(raised).toMatchObject({ number, state: 'OPEN', areas: ['RBE_RULE'], signable: { aggregateType: 'config_change_record', aggregateId: number } });
    const body = { included: true, minSeverity: 'ACTION' as const, rationale: 'Late entries need QA review', changeRecord: number };
    expect(codeIn(await qa2.call(routes.config.setRbeRule, { params: { category: 'LATE_ENTRY' }, body }))).toBe('EBMR-CFG-003');
    // The steward is not of the quality unit: no approval; QA signs it.
    expect((await signAction(server, steward, 'steward', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number })).ok).toBe(false);
    const signed = await signAction(server, qa, 'qaInvestigator', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number });
    expect(signed.ok).toBe(true);
    const listed = valueOf(await qa.call(routes.config.changeRecords, { query: { state: 'APPROVED' } })).changeRecords.find((r) => r.number === number);
    expect(listed).toMatchObject({ state: 'APPROVED', approvedBy: { legalName: 'Divya Menon' } });

    const t1 = await now();
    const rule = valueOf(await qa2.call(routes.config.setRbeRule, { params: { category: 'LATE_ENTRY' }, body }));
    expect(rule).toMatchObject({ category: 'LATE_ENTRY', mandatory: true, included: true, minSeverity: 'ACTION', version: 1 });
    const t2 = await now();
    const diff = valueOf(await qa.call(routes.config.diff, { query: { from: t1, to: t2 } }));
    expect(diff.differences.map((d) => [d.area, d.itemKey, d.before, d.after?.['min_severity'], d.after?.['version'], d.changeRecords])).toEqual([['RBE_RULE', 'LATE_ENTRY', null, 'ACTION', 1, [number]]]);
    const asOf = valueOf(await qa.call(routes.config.asOf, { query: { at: t2, area: 'RBE_RULE' } }));
    expect(asOf.items).toEqual([expect.objectContaining({ itemKey: 'LATE_ENTRY', basis: 'CHANGE_RECORD', changeRecord: number })]);

    // A mandatory category stays on the review; a closed record changes nothing more.
    expect(codeIn(await qa2.call(routes.config.setRbeRule, { params: { category: 'LATE_ENTRY' }, body: { ...body, included: false } }))).toBe('EBMR-RBE-002');
    valueOf(await steward.call(routes.config.closeChangeRecord, { params: { number }, body: { note: 'Rule in force' } }));
    expect(codeIn(await qa2.call(routes.config.setRbeRule, { params: { category: 'LATE_ENTRY' }, body: { ...body, minSeverity: 'CRITICAL' } }))).toBe('EBMR-CFG-003');
    expect(valueOf(await qa.call(routes.config.rbeRules, { query: {} })).rules.find((r) => r.category === 'LATE_ENTRY')).toMatchObject({ minSeverity: 'ACTION', version: 1 });
  });

  it('[DI-09] a platform setting (an adapter mode) is not changed under an unknown change record, and the settings list shows the definitions', async () => {
    const settings = valueOf(await qa.call(routes.config.settings, {})).settings;
    expect(settings.find((s) => s.key === 'integration.mode.qms_status')).toMatchObject({ value: 'STAND_IN', allowedValues: ['STAND_IN', 'MIRROR'] });
    const r = await steward.call(routes.config.setSetting, { params: { key: 'integration.mode.qms_status' }, body: { value: 'MIRROR', changeRecord: 'CR-UNKNOWN', reason: 'QMS live' } });
    expect(r.ok).toBe(false);
    expect(valueOf(await qa.call(routes.config.settings, {})).settings.find((s) => s.key === 'integration.mode.qms_status')?.value).toBe('STAND_IN');
  });
});
