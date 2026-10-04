/**
 * Phase 2 exit review F12, round 9 (the lane's round-2 verification; DI-05, PR-18, INV-18; tablets 0600, recipe-core
 * 0341; ADR 0012): what the sandbox's registers let into a test run's record, and the batch numbers of its stub batches.
 *
 * Decision F12.6 left as "reported, not decided here" two texts the application role writes that no identifier rule
 * reads, and the verification found neither needs the owner. One is a test lot's material code (tab.sandbox_lot, any code
 * of the form tablets 0200 allows, L2409-0017 among them): tablets 0370 binds the lot an entry names to the register,
 * material included, so a weighing of a lot registered with the material L2409-0017, which the engine refuses as the
 * wrong material, recorded that text in the refused row's entry and evidence. Now a lot a test run names is of a material
 * the batch's MBR names (tablets 0600, EBMR-EXE-078). (The other, the purpose of a scale-reading claim, is tested in
 * test/devices/claim.test.ts.)
 *
 * The verification also found recipe.stub_batch (the Phase 2 stand-in for batches of the MBR life cycle) without the
 * sandbox identifier guard in a sandbox: a stub batch planned there could carry a real-format batch number. Now
 * recipe-core 0341 guards its batch number as site services 0690 guards an allocated one (EBMR-SBX-022 in a sandbox,
 * EBMR-SBX-021 for a TEST- number in a GMP installation).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { openPersonaSession } from '@ebmr/test-kit';
import { registerLots } from '../../src/features/execution/seed.ts';
import { actorOf, messageOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, rowsOf, RunDriver, startExecServer, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const LOT = 'L2409-0017';
const PCM = 'p-disp-pcm@';

/** dc-mini at the paracetamol weighing, started by operator1 (the steps before it done as the server does them). */
async function atWeighing(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  const step = async (key: string, entries: Parameters<RunDriver['ok']>[1][], verify: boolean) => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: key });
    for (const e of entries) await d.ok('operator1', e);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
    if (verify) await d.signed('verifier1', { type: 'VERIFY', stepKey: key, meaning: 'VERIFIED' });
  };
  await step('p-disp-clear@', [
    { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
    { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
  ], true);
  await step('p-disp-bal@', [{ type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } }], false);
  await step('p-disp-sop@', [{ type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } }], false);
  await step('p-disp-calc@', [], false);
  await d.ok('operator1', { type: 'START_STEP', stepKey: PCM });
  return d;
}

/** A hand-keyed weighing of `lotCode` at the paracetamol line (51.250 - 1.250 kg), as the floor sends it. */
const weighing = (lotCode: string) => ({ type: 'RECORD_ENTRY' as const, stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode, manual: { gross: '51.250', tare: '1.250', unit: 'kg' } } });

/** Rows, states and content versions of run `runId` holding `text`. */
async function recordHolding(runId: string, text: string): Promise<{ rows: number; state: number; contents: number }> {
  const like = `%${text}%`;
  const count = async (sql: string) => Number((await sbx.db.admin.query<{ n: string }>(sql, [runId, like])).rows[0]?.n ?? '0');
  return {
    rows: await count('select count(*)::text as n from recipe.execution_command where batch_id = $1 and (command::text like $2 or evidence::text like $2 or coalesce(refusal::text, \'\') like $2)'),
    state: await count('select count(*)::text as n from recipe.execution_state where batch_id = $1 and state::text like $2'),
    contents: await count(`select count(*)::text as n from (
       select content from recipe.execution_step_content where batch_id = $1 union all select content from recipe.execution_stage_content where batch_id = $1
       union all select content from recipe.execution_exception_content where batch_id = $1 union all select content from recipe.execution_point_content where batch_id = $1) x
      where x.content::text like $2`),
  };
}

describe('F12 round 9: what the sandbox\'s registers let into a test run\'s record (DI-05, PR-18, INV-18)', () => {
  it('[DI-05][PR-18] round 9 (tablets 0600): a lot a test run names is of a material the batch\'s MBR names: a weighing of a test lot registered with the material L2409-0017, which the engine refuses as the wrong material, is refused (EBMR-EXE-078) and nothing in the record holds L2409-0017; a cellulose lot at the paracetamol line is still recorded refused (G07-WRONG-MATERIAL), and a paracetamol lot whose material name is L2409-0017 is weighed with nothing in the record holding that name', async () => {
    const steward = await openPersonaSession(sbx.db, sbx.seed, 'steward');
    await registerLots(sbx.db.app, { ...steward, correlationId: randomUUID() }, [
      { lotCode: 'TEST-L26-0901', materialCode: LOT, materialName: 'Paracetamol, direct-compression grade', status: 'RELEASED', identityTested: true, expiresInDays: 730, retestInDays: 365 },
      { lotCode: 'TEST-L26-0902', materialCode: 'MAT-PCM', materialName: LOT, status: 'RELEASED', identityTested: true, expiresInDays: 730, retestInDays: 365 },
    ]);
    const d = await atWeighing();
    const lotShaped = await d.command('operator1', weighing('TEST-L26-0901'));
    expect(outcomeOf(lotShaped)).toBe('422:EBMR-EXE-078');
    expect(JSON.stringify(lotShaped)).toMatch(/lot TEST-L26-0901 is of material L2409-0017, which the MBR of this batch does not name \(its bill of materials names MAT-MCC, MAT-MGS, MAT-PCM\); a lot a test run names is of a material its MBR names \(DI-05, PR-18\)\./);
    expect(await recordHolding(d.runId, LOT)).toEqual({ rows: 0, state: 0, contents: 0 });

    // The engine's refusal of a lot of another material of the same MBR is still recorded.
    expect(outcomeOf(await d.command('operator1', weighing('TEST-L26-0102')))).toBe('422:G07-WRONG-MATERIAL');
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'RECORD_ENTRY' && !x.accepted).map((x) => x.refusal?.code)).toEqual(['G07-WRONG-MATERIAL']);
    // A lot's material name is the register's, shown on the screen and recorded in no row.
    await d.ok('operator1', weighing('TEST-L26-0902'));
    expect(await recordHolding(d.runId, LOT)).toEqual({ rows: 0, state: 0, contents: 0 });
  }, 300_000);

  it('[DI-05][INV-18] round 9 (recipe-core 0341): a stub batch planned in the sandbox carries a test batch number: L2409-0017 is refused (EBMR-SBX-022) and no stub batch holds it; TEST-B26-0901 is planned', async () => {
    // An MBR family, written as the owner with its triggers off: set-up only (the sandbox seeds no MBR author).
    const familyId = randomUUID();
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(
        `insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes, created_by_person, created_by_account)
         values ($1, 'TEST-FAM-R9', 'Round 9 family', 'tablets', 'PROCESSING', 'TEST-PCM500', 'Paracetamol', '500 mg', 'TABLET', '[{"id": "BS-1", "quantity": {"value": "100000", "unit": "1"}}]', gen_random_uuid(), gen_random_uuid())`,
        [familyId],
      );
      await c.query('commit');
    } finally {
      c.release();
    }
    const issuer = await sbx.asPersona('issuer');
    const plan = async (batchNumber: string) =>
      messageOf(withCommand(sbx.db.app, await actorOf(sbx, issuer, 'issuer'), (cl) => cl.query('select recipe.create_stub_batch($1::jsonb)', [JSON.stringify({ batchNumber, familyId, markets: ['IN'], site: 'TEST-SITE', line: 'TEST-LINE', batchSize: 'BS-1' })])));
    expect(await plan(LOT)).toMatch(/^"L2409-0017" is not a test batch number: in the sandbox every batch number starts with TEST- \(for example TEST-B24-0001\), so a real GMP identifier is never reused \(DI-05\)\. \[EBMR-SBX-022\]$/);
    expect((await sbx.db.admin.query('select 1 from recipe.stub_batch where batch_number = $1', [LOT])).rowCount).toBe(0);
    expect(await plan('TEST-B26-0901')).toBe('ok');
    expect((await sbx.db.admin.query('select 1 from recipe.stub_batch where batch_number = $1', ['TEST-B26-0901'])).rowCount).toBe(1);
  }, 120_000);
});
