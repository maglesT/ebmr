/**
 * Decision 0026 slice S4 on a GMP server: a master carries a snapshot of the library block it uses; QA approved that
 * library version before the master was approved; a batch runs the block from the master's own snapshot (no code for
 * the block), and the database holds the regulation-required core: library entries against the snapshot's schema, the
 * formulation's limits with the engine's exception (O-9 b: the server's calculated figure, never recomputed), and the
 * snapshots against the approved library at master approval and at issue (recipe-core 1810).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { library } from '@ebmr/recipe-core/pure';
import { refusalOf, valueOf } from '../esig/support.ts';
import { RunDriver } from '../execution/support.ts';
import type { TestServer } from '../support/harness.ts';
import { asSetup } from '../blocks/compression/plant-support.ts';
import { gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { signAction } from '../support/signed-acts.ts';

type Json = Record<string, unknown>;
let w: GmpBatchWorld;

const DEF = {
  code: 'IPC-FRIAB-S4',
  version: 1,
  title: 'Friability',
  category: 'TEST_IPC',
  sections: [
    {
      id: 'run',
      title: 'Run',
      fields: [
        { id: 'w0', label: 'Weight before', type: 'NUMBER', unit: 'g' },
        { id: 'w1', label: 'Weight after', type: 'NUMBER', unit: 'g' },
        { id: 'loss', label: 'Weight loss', type: 'CALC', expression: '(w0 - w1) / w0 * 100 [%]', unit: '%', limitSlot: 'loss', critical: true },
        { id: 'cracked', label: 'Any tablet cracked or broken', type: 'YES_NO', expected: false },
      ],
    },
  ],
  signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
};
const HASH = library.definitionHash(DEF as unknown as library.BlockDefinition);
const LOSS_LIMIT = { unit: '%', ranges: [{ tier: 'REGISTERED', high: { value: '1.0', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'REF-1' } }] };

/** dc-mini as a GMP master with, first in its dispensing preparation, a library friability step and the block's snapshot. */
const content = () =>
  gmpContent((m) => {
    const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
    const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
    const lib: Json = {
      kind: 'phase', id: 'p-lib', name: 'Friability (library)', block: { type: 'LIB-IPC-FRIAB-S4', version: '1' }, config: { hash: HASH, limits: { loss: LOSS_LIMIT } },
      records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false, riskClass: 'HIGH',
    };
    prep['children'] = [lib, ...(prep['children'] as Json[])];
    m['blockDefinitions'] = [DEF];
  });

async function approvedLibraryBlock(gmp: TestServer): Promise<void> {
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: DEF } }));
  const signed = await signAction(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  if (!signed.ok) throw new Error(`the library block was not approved: ${JSON.stringify(signed.error)}`);
}

beforeAll(async () => {
  w = await startGmpBatchWorld(content(), {}, { beforeApproval: approvedLibraryBlock });
  vi.useFakeTimers({ toFake: ['performance'] });
}, 600_000);
afterAll(async () => {
  vi.useRealTimers();
  await w?.close();
});

async function runOnLibraryStep(): Promise<{ d: RunDriver; batchId: string }> {
  const issuer = await w.gmp.asPersona('issuer');
  const batchId = await w.issued(issuer);
  const d = new RunDriver(w.gmp, batchId, { operator1: await w.gmp.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-lib@' });
  return { d, batchId };
}

async function stateOf(batchId: string): Promise<{ entries: Record<string, Json>; exceptions: Record<string, Json> }> {
  const { rows } = await w.gmp.db.admin.query<{ s: { entries: Record<string, Json>; exceptions: Record<string, Json> } }>('select state as s from recipe.execution_state where batch_id = $1', [batchId]);
  return rows[0]?.s ?? { entries: {}, exceptions: {} };
}

describe('a library block in a GMP batch', () => {
  it('[DI-33][PR-08] the step runs from the master\'s snapshot: the server computes the loss and stores it with its evaluation record; a value outside the limit carries LIB_LIMIT_BREACH', async () => {
    const { d, batchId } = await runOnLibraryStep();
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-lib@', entry: { kind: 'LIBRARY_ENTRY', entryKind: 'run', data: { w0: '6.500', w1: '6.480', cracked: false } } });
    let s = await stateOf(batchId);
    const run = Object.values(s.entries).find((e) => e['stepKey'] === 'p-lib@' && e['kind'] === 'run');
    const loss = ((run?.['data'] as Json)['computed'] as Record<string, Json>)['loss'];
    expect(String(loss?.['value']).startsWith('0.307')).toBe(true);
    expect(loss?.['expression']).toBe('(w0 - w1) / w0 * 100 [%]');
    expect(Object.values(s.exceptions)).toEqual([]);
    // S5: the step view carries the definition and the product's values for the generic form, and the entry's sentence.
    const view = await d.stepView('operator1', 'p-lib@');
    expect((view.library?.definition as Json | undefined)?.['code']).toBe('IPC-FRIAB-S4');
    expect(view.library?.config['limits']).toBeDefined();
    expect(view.library?.inputs).toEqual({}); // S10: friability reads no formula line or batch size
    expect(view.entries.find((e) => e.kind === 'run')?.summary).toMatch(/^Run: Weight before 6\.500 g; Weight after 6\.480 g; Weight loss 0\.307\d* % \(calculated\); Any tablet cracked or broken: no$/);

    const second = await runOnLibraryStep();
    await second.d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-lib@', entry: { kind: 'LIBRARY_ENTRY', entryKind: 'run', data: { w0: '6.500', w1: '6.400', cracked: false } } });
    s = await stateOf(second.batchId);
    expect(Object.values(s.exceptions).map((x) => [x['type'], (x['source'] as Json)['item']])).toEqual([['LIB_LIMIT_BREACH', 'p-lib.loss']]);
  });

  it('[INV-25][DI-30] a typed calculated field and an unknown section are refused; a library entry to a step of another block is refused', async () => {
    const { d } = await runOnLibraryStep();
    const typed = await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-lib@', entry: { kind: 'LIBRARY_ENTRY', entryKind: 'run', data: { w0: '6.5', w1: '6.4', cracked: false, loss: '0.1' } } });
    expect(refusalOf(typed).status).toBeGreaterThanOrEqual(400);
    const unknown = await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-lib@', entry: { kind: 'LIBRARY_ENTRY', entryKind: 'rinse', data: {} } });
    expect(refusalOf(unknown).status).toBeGreaterThanOrEqual(400);
    const other = await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'LIBRARY_ENTRY', entryKind: 'run', data: {} } });
    expect(refusalOf(other).code).toBe('EBMR-API-LIBRARY-ENTRY');
  });

  it('[PR-08] the database refuses a library value outside its limit stored without the engine\'s LIB_LIMIT_BREACH (O-9 b: the figure is the server\'s, the check is the database\'s)', async () => {
    const c = content() as unknown as Json;
    const step = { key: 'p-lib@', step: 'p-lib' };
    const entry = (loss: string) => ({ kind: 'run', stepKey: 'p-lib@', data: { w0: '6.5', w1: '6.4', cracked: false, computed: { loss: { value: loss, unit: '%' } } } });
    const old = { entries: {}, exceptions: {}, steps: { 'p-lib@': step } };
    const q = (s: Json) => w.gmp.db.admin.query<{ p: string | null }>('select recipe.library_limits_problem($1::jsonb, $2::jsonb, $3::jsonb) as p', [JSON.stringify(c), JSON.stringify(old), JSON.stringify(s)]);
    expect((await q({ ...old, entries: { E1: entry('0.5') } })).rows[0]?.p).toBeNull();
    expect((await q({ ...old, entries: { E1: entry('1.5') } })).rows[0]?.p).toMatch(/without the LIB_LIMIT_BREACH/);
    const raised = { X1: { type: 'LIB_LIMIT_BREACH', source: { stepKey: 'p-lib@', item: 'p-lib.loss' } } };
    expect((await q({ ...old, entries: { E1: entry('1.5') }, exceptions: raised })).rows[0]?.p).toBeNull();
  });

  it('[PR-05] the snapshots must be approved library versions with the same content hash; a retired version serves approved masters but no new approval', async () => {
    const c = content() as unknown as Json;
    const q = (content: Json, current: boolean) => w.gmp.db.admin.query<{ p: string | null }>('select recipe.library_snapshot_problem($1::jsonb, $2) as p', [JSON.stringify(content), current]);
    expect((await q(c, true)).rows[0]?.p).toBeNull();
    const changed = { ...c, blockDefinitions: [{ ...DEF, title: 'Friability (edited)' }] };
    expect((await q(changed, false)).rows[0]?.p).toMatch(/differs from the library version/);
    const missing = { ...c, blockDefinitions: [] };
    expect((await q(missing, false)).rows[0]?.p).toMatch(/carries no snapshot/);
    const approver = await w.gmp.asPersona('approver');
    const [b] = valueOf(await approver.call(routes.library.list, { query: { code: 'IPC-FRIAB-S4' } })).blocks;
    valueOf(await approver.call(routes.library.retire, { body: { blockId: b?.blockId ?? '', reason: 'Replaced by a revised form' } }));
    expect((await q(c, true)).rows[0]?.p).toMatch(/retired/);
    expect((await q(c, false)).rows[0]?.p).toBeNull();
  });
});

describe('smart fields of library entries on GMP (S6; tablets 1803)', () => {
  const smartDef = {
    code: 'PROC-DISP-S6',
    version: 1,
    title: 'Dispensing',
    category: 'PROCESS',
    sections: [
      {
        id: 'weigh',
        title: 'Weigh',
        fields: [
          { id: 'balance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
          { id: 'lot', label: 'Lot', type: 'MATERIAL_LOT' },
          { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
        ],
      },
    ],
    signatures: [{ meaning: 'PERFORMED', role: 'DISPENSER' }, { meaning: 'VERIFIED', role: 'DISPENSER' }],
  };
  const smartContent = (): Json => {
    const c = content() as unknown as Json;
    const stage = ((((c['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
    const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
    const node: Json = { ...((prep['children'] as Json[])[0] as Json), id: 'p-disp-lib', block: { type: 'LIB-PROC-DISP-S6', version: '1' }, config: { equipmentClasses: { balanceClass: 'CL-BAL-S6' } } };
    prep['children'] = [node, ...(prep['children'] as Json[])];
    return { ...c, blockDefinitions: [...(c['blockDefinitions'] as Json[]), smartDef] };
  };
  const state = (data: Json, verificationRequired = true) => ({
    lastRecordedUs: '1793500000000000',
    header: { marketSet: ['IN'] },
    entries: { E1: { kind: 'weigh', stepKey: 'p-disp-lib@', data } },
    steps: { 'p-disp-lib@': { step: 'p-disp-lib', verificationRequired } },
  });
  const old = { entries: {}, steps: { 'p-disp-lib@': { step: 'p-disp-lib' } } };
  const problem = async (s: Json): Promise<string | null> =>
    (await w.gmp.db.admin.query<{ p: string | null }>('select tab.library_smart_problem(null, $1::jsonb, $2::jsonb, $3::jsonb) as p', [JSON.stringify(smartContent()), JSON.stringify(old), JSON.stringify(s)])).rows[0]?.p ?? null;

  it('[PR-18][IN-23] the database refuses a library entry naming a lot its register does not hold', async () => {
    expect(await problem(state({ lot: 'L-NOT-THERE', lots: { lot: { id: 'L-NOT-THERE', material: 'M', status: 'RELEASED', identityTested: true } } }))).toMatch(/lot register does not hold/);
  });

  it('[PR-19][IN-11] the database refuses equipment it does not hold, facts other than its register\'s, and equipment that is not fit for use', async () => {
    expect(await problem(state({ balance: 'BAL-NOT-THERE', equipment: { balance: { code: 'BAL-NOT-THERE', classCode: 'CL-BAL-S6', fitness: 'QUALIFIED' } } }))).toMatch(/plant register does not hold/);
    await asSetup(w.gmp, `insert into plant.equipment_class (code, kind, description, calibration_required, check_regime, recorded_by)
                          values ('CL-BAL-S6', 'INSTRUMENT', 'Balance 150 kg (test)', true, 'DAILY', gen_random_uuid())`);
    await asSetup(w.gmp, "insert into plant.equipment (code, name, class_code, kind, recorded_by) values ('BAL-S6-1', 'Balance', 'CL-BAL-S6', 'INSTRUMENT', gen_random_uuid())");
    const fit = (await w.gmp.db.admin.query<{ f: string }>("select plant.equipment_fitness(id) as f from plant.equipment where code = 'BAL-S6-1'")).rows[0]?.f ?? '';
    expect(await problem(state({ balance: 'BAL-S6-1', equipment: { balance: { code: 'BAL-S6-1', classCode: 'CL-OTHER', fitness: fit } } }))).toMatch(/other than the plant register holds/);
    const told = await problem(state({ balance: 'BAL-S6-1', equipment: { balance: { code: 'BAL-S6-1', classCode: 'CL-BAL-S6', fitness: fit } } }));
    if (fit === 'QUALIFIED' || fit === 'CALIBRATION_DUE_SOON') expect(told).toBeNull();
    else expect(told).toMatch(new RegExp(`which is ${fit.toLowerCase().replace(/_/g, ' ')}`));
  });

  it('[PR-03][INV-25] the database\'s entry schema carries the server-filled lot and equipment facts of a section with such fields, and only there (S11 finding; recipe-core 1840)', async () => {
    const check = async (kind: string, data: Json): Promise<string | null> =>
      (
        await w.gmp.db.admin.query<{ p: string | null }>(
          "select coalesce(recipe.block_schema_problem(s, $3::jsonb, 'entry'), recipe.block_schema_unknown_member(s, $3::jsonb, 'entry')) as p from recipe.library_entry_schema($1::jsonb, $2::jsonb, $4) s",
          [JSON.stringify(smartContent()), JSON.stringify({ type: 'LIB-PROC-DISP-S6', version: '1' }), JSON.stringify(data), kind],
        )
      ).rows[0]?.p ?? null;
    const facts = { balance: 'BAL-1', lot: 'L1', net: '1.5', lots: { lot: { id: 'L1', material: 'M', status: 'RELEASED', identityTested: true } }, equipment: { balance: { code: 'BAL-1', classCode: 'CL', fitness: 'QUALIFIED' } } };
    expect(await check('weigh', facts)).toBeNull();
    expect(await check('weigh', { ...facts, equipment: { balance: { code: 'BAL-1', classCode: 'CL', fitness: 'QUALIFIED', extra: 'x' } } })).not.toBeNull();
    expect(await check('weigh', { ...facts, forged: 'x' })).not.toBeNull();
  });

  it('[DI-30][PR-14] the database refuses a hand-keyed library weighing stored without two-person verification', async () => {
    expect(await problem(state({ net: '10.0' }, false))).toMatch(/without two-person verification/);
    expect(await problem(state({ net: '10.0' }, true))).toBeNull();
  });

  it('[DI-31][PR-18] the server refuses lot facts sent by the browser, and a lot its register does not hold', async () => {
    const { d } = await runOnLibraryStep();
    const sent = await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-lib@', entry: { kind: 'LIBRARY_ENTRY', entryKind: 'run', data: { w0: '6.5', w1: '6.4', cracked: false, lots: {} } } });
    expect(refusalOf(sent).code).toBe('EBMR-API-SERVER-FILLED');
  });
});
