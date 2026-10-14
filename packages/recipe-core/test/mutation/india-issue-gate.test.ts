/**
 * The India issue gate, rule by rule (SQL mutation group "india-issue-gate": recipe-core 0890, 0891, 0912; decision
 * 0012). These tests close the gaps the Phase 4 focused mutation run found in test/release/india.test.ts: the re-check of
 * the gates in the transaction that writes the batch, the hazard classes a product counts (an approved class and a later
 * one pending approval), the risk assessment a refusal names, and the refusals of a malformed dedication record.
 *
 * Controls: IN-30 (licence basis of the issue), IN-27 (hazard dedication).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as execution from '../../src/execution/index.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let erp: SeededActor;
const dir = tempDir('india-gate');
const ledger = tempLedger('india-gate', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  await withCommand(db.admin, await cmd(db, steward), (c) =>
    c.query("insert into plant.area (code, kind, name, segregated, negative_pressure, recorded_by) values ('L1', 'LINE', 'Line 1', false, true, gen_random_uuid()) on conflict (code) do nothing"));
}, 600_000);
afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const sqlAs = async <T>(who: SeededActor, text: string, params: unknown[] = []): Promise<T> =>
  w.run(who, async (c) => ((await c.query(text, params)).rows[0] as { r: T } | undefined)?.r as T);

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Record<string, unknown>)['block'] as Record<string, unknown> | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

type Master = { familyId: string; content: MbrContent; product: string; strength: string };
/** An effective master authorised for IN on line L1, licensed (the World records and approves its licence). */
async function effective(): Promise<Master> {
  const m = uniqueContent(FIXTURE, ['EU', 'IN', 'US']);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  const def: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: 'IN: registration on file' };
  await w.authorise(def);
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'N{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  const f = (await db.app.query<{ s: string }>('select strength as s from recipe.mbr_family where id = $1', [v.familyId])).rows[0]!.s;
  return { familyId: v.familyId, content, product: content.header.product.code, strength: f };
}

async function plan(m: Master): Promise<string> {
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, m.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: m.familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder })),
  );
  return batchId;
}

const issueSignatures = new Map<string, string>();
/** Issues planned batch `batchId`; a refused attempt keeps the issuer's ISSUED signature for the next one. */
async function issue(batchId: string): Promise<void> {
  const signatureId = issueSignatures.get(batchId) ?? (await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED'));
  issueSignatures.set(batchId, signatureId);
  await w.run(
    w.cast.issuer,
    (c) =>
      execution.issueGmpBatch(c, {
        batchId,
        signatureId,
        define: (x) => define(x, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
        request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] } },
      }),
    reason('batch issued for the test'),
  );
}

describe('the gates re-checked where the batch is written (recipe-core 0891, recipe.record_batch_licence_basis)', () => {
  it('[IN-30] a licence suspended after the issue check and before the batch row is written refuses the issue: the trigger on the batch store checks the gates again', async () => {
    const m = await effective();
    const b = await plan(m);
    const licenceId = (await db.app.query<{ id: string }>("select site.licence_basis($1, $2, $3, clock_timestamp()) ->> 'licenceId' as id", [SITE, m.product, m.strength])).rows[0]!.id;
    // A concurrent suspension committed between the check and the insert, stood in for by a test trigger that suspends the
    // licence just before the batch row is inserted (dropped below).
    const fn = `test_suspend_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await db.admin.query(`
      create function public.${fn}() returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
      begin
        insert into site.licence_suspension (licence_id, reason_text, suspended_by_person, suspended_by_account)
        values ('${licenceId}', 'Suspended by the authority while the batch was being issued', '${w.cast.qa.personId}', '${w.cast.qa.accountId}');
        return new;
      end $f$;
      create trigger ${fn} before insert on recipe.batch_execution for each row execute function public.${fn}();`);
    try {
      expect(await messageOf(issue(b))).toMatch(/suspended or cancelled.*EBMR-IND-040/);
    } finally {
      await db.admin.query(`drop trigger ${fn} on recipe.batch_execution; drop function public.${fn}();`);
    }
    expect((await db.app.query('select 1 from recipe.batch_execution where id = $1', [b])).rowCount).toBe(0);
    expect((await db.app.query('select 1 from site.licence_suspension where licence_id = $1', [licenceId])).rowCount).toBe(0);
    await issue(b);
    expect((await db.app.query<{ licence_id: string }>('select licence_id from recipe.batch_licence_basis where batch_id = $1', [b])).rows[0]).toEqual({ licence_id: licenceId });
  });
});

describe('the hazard classes of a product and the dedication of a line (recipe-core 0890, 0912)', () => {
  const classify = (product: string, hazardClass: string, ref: string): Promise<string> =>
    sqlAs<string>(w.cast.qa, 'select plant.record_product_hazard($1::jsonb) as r', [JSON.stringify({ productCode: product, hazardClass, riskAssessmentRef: ref })]);
  async function approve(id: string): Promise<void> {
    const sig = await w.sign(w.cast.qa2, 'hazard_classification', id, 'HAZARD_CLASSIFICATION_APPROVED', 'RECORDED');
    await w.run(w.cast.qa2, (c) => c.query('select plant.approve_product_hazard($1, $2)', [id, sig]));
  }
  const classes = async (product: string): Promise<string[]> =>
    (await db.app.query<{ c: string[] }>('select plant.product_hazard_classes($1) as c', [product])).rows[0]!.c;
  const problem = async (product: string, area: string): Promise<string | null> =>
    (await db.app.query<{ p: string | null }>('select plant.hazard_area_problem($1, $2) as p', [product, area])).rows[0]?.p ?? null;

  it('[IN-27] a product counts its approved class and a later class pending approval, whatever other products\' records were approved', async () => {
    const other = `HZ-${randomUUID().slice(0, 8).toUpperCase()}`;
    await approve(await classify(other, 'STEROID', 'RA-OTHER'));
    const p = `HZ-${randomUUID().slice(0, 8).toUpperCase()}`;
    await classify(p, 'SEX_HORMONE', 'RA-PENDING-ONLY');
    expect(await classes(p)).toEqual(['SEX_HORMONE']);
    await approve(await classify(p, 'CYTOTOXIC', 'RA-APPROVED'));
    expect(await classes(p)).toEqual(['CYTOTOXIC']);
    await classify(p, 'STEROID', 'RA-LATER');
    expect(await classes(p)).toEqual(['CYTOTOXIC', 'STEROID']);
  });

  it('[IN-27] the refusal names the risk assessment of the product\'s own record of that class, not another product\'s', async () => {
    const p = `HZ-${randomUUID().slice(0, 8).toUpperCase()}`;
    await approve(await classify(p, 'CYTOTOXIC', 'RA-OWN-2026-01'));
    const q = `HZ-${randomUUID().slice(0, 8).toUpperCase()}`;
    await approve(await classify(q, 'CYTOTOXIC', 'RA-OTHER-2026-02'));
    const area = `L-${randomUUID().slice(0, 6).toUpperCase()}`;
    await withCommand(db.admin, await cmd(db, steward), (c) =>
      c.query("insert into plant.area (code, kind, name, segregated, negative_pressure, recorded_by) values ($1, 'LINE', 'Hazard test line', false, true, gen_random_uuid())", [area]));
    const message = await problem(p, area);
    expect(message).toMatch(/classed CYTOTOXIC \(risk assessment RA-OWN-2026-01\)/);
    expect(message).not.toMatch(/RA-OTHER/);
  });

  it('[IN-27] [DI-35] an unknown record is not approved; a record is approved once and only while it is the latest; the approval is recorded by its signer', async () => {
    const none = '00000000-0000-4000-8000-000000000000';
    const qa3 = await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Tara Third-QA' });
    const p = `HZ-${randomUUID().slice(0, 8).toUpperCase()}`;
    const first = await classify(p, 'STEROID', 'RA-1');
    const sig = await w.sign(w.cast.qa2, 'hazard_classification', first, 'HAZARD_CLASSIFICATION_APPROVED', 'RECORDED');
    expect(await messageOf(w.run(w.cast.qa2, (c) => c.query('select plant.approve_product_hazard($1, $2)', [none, sig])))).toMatch(/EBMR-IND-060 unknown hazard classification/);
    expect(await messageOf(w.run(qa3, (c) => c.query('select plant.approve_product_hazard($1, $2)', [first, sig])))).toMatch(/EBMR-IND-063 the approval is recorded by the person who signed it/);
    await w.run(w.cast.qa2, (c) => c.query('select plant.approve_product_hazard($1, $2)', [first, sig]));
    const again = await w.sign(qa3, 'hazard_classification', first, 'HAZARD_CLASSIFICATION_APPROVED', 'APPROVED').catch(() => null);
    if (again) expect(await messageOf(w.run(qa3, (c) => c.query('select plant.approve_product_hazard($1, $2)', [first, again])))).toMatch(/EBMR-IND-061 .* is APPROVED/);
    const older = await classify(p, 'CYTOTOXIC', 'RA-2');
    const olderSig = await w.sign(w.cast.qa2, 'hazard_classification', older, 'HAZARD_CLASSIFICATION_APPROVED', 'RECORDED');
    await classify(p, 'SEX_HORMONE', 'RA-3');
    expect(await messageOf(w.run(w.cast.qa2, (c) => c.query('select plant.approve_product_hazard($1, $2)', [older, olderSig])))).toMatch(/EBMR-IND-061 this classification of .* is SUPERSEDED/);

    const dedicate = (): Promise<string> =>
      sqlAs<string>(w.cast.qa, 'select plant.record_area_dedication($1::jsonb) as r', [JSON.stringify({ areaCode: 'L1', hazardClass: 'SEX_HORMONE', dedicated: true, breathingAir: 'NOT_USED', justification: 'Dedicated line' })]);
    const d1 = await dedicate();
    const dsig = await w.sign(w.cast.qa2, 'area_dedication', d1, 'AREA_DEDICATION_APPROVED', 'RECORDED');
    expect(await messageOf(w.run(w.cast.qa2, (c) => c.query('select plant.approve_area_dedication($1, $2)', [none, dsig])))).toMatch(/EBMR-IND-060 unknown area dedication/);
    await dedicate();
    expect(await messageOf(w.run(w.cast.qa2, (c) => c.query('select plant.approve_area_dedication($1, $2)', [d1, dsig])))).toMatch(/EBMR-IND-061 this dedication of L1 is SUPERSEDED/);
  });

  it('[IN-27] a dedication record is superseded only by a later record of the same room or line and the same class', async () => {
    const area = `L-${randomUUID().slice(0, 6).toUpperCase()}`;
    const area2 = `L-${randomUUID().slice(0, 6).toUpperCase()}`;
    for (const a of [area, area2]) {
      await withCommand(db.admin, await cmd(db, steward), (c) =>
        c.query("insert into plant.area (code, kind, name, segregated, negative_pressure, recorded_by) values ($1, 'LINE', 'Hazard test line', false, true, gen_random_uuid())", [a]));
    }
    const dedicate = (areaCode: string, hazardClass: string): Promise<string> =>
      sqlAs<string>(w.cast.qa, 'select plant.record_area_dedication($1::jsonb) as r', [JSON.stringify({ areaCode, hazardClass, dedicated: true, breathingAir: 'BACKED_UP', justification: 'Contained line' })]);
    const state = async (id: string): Promise<string> => (await db.app.query<{ s: string }>('select plant.dedication_record_state($1) as s', [id])).rows[0]!.s;
    const first = await dedicate(area, 'CYTOTOXIC');
    await dedicate(area, 'STEROID');
    await dedicate(area2, 'CYTOTOXIC');
    expect(await state(first)).toBe('RECORDED');
    await dedicate(area, 'CYTOTOXIC');
    expect(await state(first)).toBe('SUPERSEDED');
  });

  it('[IN-27] a dedication record names whether the line is dedicated, an existing room or line, a hazard class, the breathing air and its justification', async () => {
    const rec = (p: unknown): Promise<string> => messageOf(sqlAs(w.cast.qa, 'select plant.record_area_dedication($1::jsonb) as r', [p === null ? null : JSON.stringify(p)]));
    const ok = { areaCode: 'L1', hazardClass: 'CYTOTOXIC', dedicated: true, breathingAir: 'BACKED_UP', justification: 'Contained line' };
    const NAMES = /EBMR-IND-036 a dedication names the room or line, the hazard class, whether it is dedicated/;
    expect(await rec(null)).toMatch(NAMES);
    expect(await rec({ ...ok, dedicated: undefined })).toMatch(NAMES);
    expect(await rec({ ...ok, dedicated: 'yes' })).toMatch(NAMES);
    expect(await rec({ ...ok, areaCode: 'NO-SUCH-LINE' })).toMatch(/EBMR-IND-036 NO-SUCH-LINE is no room or line of the plant/);
    expect(await rec({ ...ok, areaCode: undefined })).toMatch(/EBMR-IND-036 NULL is no room or line of the plant/);
    const INCOMPLETE = /EBMR-IND-036 a dedication names a hazard class \(SEX_HORMONE, STEROID or CYTOTOXIC\), the breathing-air supply/;
    expect(await rec({ ...ok, hazardClass: 'NONE' })).toMatch(INCOMPLETE);
    expect(await rec({ ...ok, breathingAir: 'MAYBE' })).toMatch(INCOMPLETE);
    expect(await rec({ ...ok, justification: undefined })).toMatch(INCOMPLETE);
  });
});
