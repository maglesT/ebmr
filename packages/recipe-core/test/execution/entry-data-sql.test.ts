/**
 * The database's check that a new entry holds what its command sent, member for member, for every kind of entry
 * (recipe-core sql/0313: recipe.entry_data_problem; Phase 2 exit review F12, round 2; DI-30, DI-05).
 *
 * 0300 bound only the weighing facts of a new entry to its command: a RECORD_ENTRY whose command named a test batch
 * could store the real previous batch in the state. The blocks take members over from the command under the same name
 * (their entry schemas refuse unknown members) and add others under names of their own. Were the check stricter than
 * the blocks, an honest entry would be refused; so every entry the engine's own runs store passes (both golden
 * fixtures: weighings, charges, outputs, samples, clearances, equipment checks, disposals; an acknowledgement of the
 * MBR's own SOP version), and an entry that holds another value than its command sent is refused, with the member it
 * names.
 *
 * Round 3 (sql 0317: recipe.new_container_problem): a container a row registers was bound to its row only by its step
 * and status; a PREVIOUS_BATCH entry was stored with a real-format container registered beside it. Now a new container
 * is exactly the one the row's entry registers: a dispensing weighing's (G-07) or an output weighing's (G-22), under the
 * id the entry names or the block builds, with the entry's facts; every container of the engine's own runs passes.
 *
 * Round 4 (sql 0328: recipe.entry_reference_problem): what such a container holds was taken from its entry and never
 * compared with the MBR; an output holding L2409-0017 was stored. Now an entry names only what its step's node in the
 * MBR names (a BOM line it dispenses or charges, an intermediate it produces, a container it charges, equipment it
 * checks) and a row consumes only the containers its charges name; every entry of the engine's own runs passes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import type { BatchState } from '../../src/engine/types.ts';
import type { FlowNode } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { autopilot, define, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, PACKAGING_SCENARIO, Run } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

interface Row {
  label: string;
  accepted: boolean;
  command: JsonValue;
  before: Json;
  after: Json;
}

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const enc = (s: BatchState): Json => JSON.parse(JSON.stringify(encodeState(s))) as Json;

function rowsOf(run: Run, start: BatchState): Row[] {
  const rows: Row[] = [];
  let before = start;
  for (const [i, e] of run.log.entries()) {
    rows.push({ label: `#${i + 1} ${e.command.type}${'step' in e.command ? ` ${e.command.step}` : ''}`, accepted: e.result.accepted, command: encodeCommand(e.command), before: enc(before), after: enc(e.result.state) });
    before = e.result.state;
  }
  return rows;
}

async function problem(r: Pick<Row, 'accepted' | 'command' | 'before' | 'after'>, kind = 'COMMAND'): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.entry_data_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb) as p', [
    JSON.stringify(r.before),
    JSON.stringify(r.after),
    kind,
    r.accepted,
    JSON.stringify(r.command),
  ]);
  return rows[0]?.p ?? null;
}

const entries = (s: Json): Record<string, Json> => (s['entries'] as Record<string, Json> | undefined) ?? {};
/** The entry row `r` adds (the first). */
const added = (r: Row): [string, Json] => {
  const e = Object.entries(entries(r.after)).find(([k]) => !(k in entries(r.before)));
  if (!e) throw new Error(`SETUP: ${r.label} adds no entry`);
  return e;
};
/** Row `r` with member `m` of the data of the entry it adds set to `value`. */
function withData(r: Row, m: string, value: unknown): Row {
  const after = structuredClone(r.after);
  const [k] = added(r);
  (entries(after)[k]?.['data'] as Json)[m] = value;
  return { ...r, after };
}

const runs = (): { name: string; rows: Row[] }[] =>
  (['tablet-granulation-compression', 'tablet-blister-packaging'] as const).map((name) => {
    const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants: name === 'tablet-blister-packaging' ? { packDestination: 'US-EXPORT' } : {} });
    const start = run.state;
    expect(autopilot(run, name === 'tablet-granulation-compression' ? GRANULATION_SCENARIO : PACKAGING_SCENARIO)).toBe('COMPLETE');
    return { name, rows: rowsOf(run, start) };
  });

describe('F12 round 2: a new entry holds what its command sent (DI-30, DI-05)', () => {
  it('[DI-30][DI-05][DI-14] every entry the engine\'s own runs store passes: weighings, charges, outputs, samples, clearances, equipment checks, acknowledgements, start data', async () => {
    const kinds = new Set<string>();
    for (const { name, rows } of runs()) {
      const out: Record<string, string> = {};
      for (const r of rows) {
        const p = await problem(r);
        if (p !== null) out[r.label] = p;
        for (const [k, e] of Object.entries(entries(r.after))) if (!(k in entries(r.before))) kinds.add(String(e['kind']));
      }
      expect(out, name).toEqual({});
    }
    expect([...kinds].sort()).toEqual(['CHARGE_CONTAINER', 'CHARGE_LOT', 'CLEARANCE_CHECK', 'CONTAINER_WEIGHING', 'DISPOSAL', 'EQUIPMENT_STATUS', 'OUTPUT_CONTAINER', 'PREVIOUS_BATCH', 'SAMPLE']);
    // An acknowledgement of the MBR's own SOP version, and start data, as the blocks store them.
    const ack = Run.issue(define(mbrWith(seq('ops', phase('read', { block: { type: 'G-03', version: '1' }, config: { sop: 'SOP-1', acknowledgement: 'READ' } })), { references: [{ id: 'SOP-1', kind: 'SOP', code: 'SOP-GRAN-004', version: '7', hash: 'd'.repeat(64) }] })));
    const ackStart = ack.state;
    ack.start('read');
    ack.entry('read', { kind: 'ACKNOWLEDGE', mode: 'READ', sopVersion: '7' });
    for (const r of rowsOf(ack, ackStart)) expect(await problem(r), r.label).toBeNull();
    expect(Object.values(ack.state.entries).map((e) => e.data['sopVersion'])).toEqual(['7']);
  }, 300_000);

  it('[DI-30][DI-05] an entry that holds another value than its command sent is refused: the verifier\'s previous batch and product, a weighed container or lot, a sample\'s point, a checklist\'s answers', async () => {
    const [granulation] = runs();
    const rows = granulation?.rows ?? [];
    const first = (kind: string): Row => {
      const r = rows.find((x) => x.accepted && Object.entries(entries(x.after)).some(([k, e]) => !(k in entries(x.before)) && e['kind'] === kind));
      if (!r) throw new Error(`SETUP: no ${kind} entry`);
      return r;
    };
    const previous = first('PREVIOUS_BATCH');
    const [pk] = added(previous);
    // The round-2 verification's row: the command names a test batch, the state the real one and the real product.
    expect(await problem(withData(previous, 'batchNumber', 'B24-0001'))).toBe(`stores another batchNumber in entry ${pk} (PREVIOUS_BATCH) than its command sent`);
    expect(await problem(withData(previous, 'product', 'Paracetamol 500 mg tablets'))).toBe(`stores another product in entry ${pk} (PREVIOUS_BATCH) than its command sent`);
    const weighing = first('CONTAINER_WEIGHING');
    const [wk, we] = added(weighing);
    expect(await problem(withData(weighing, 'container', 'L2409-0017'))).toBe(`stores another container in entry ${wk} (CONTAINER_WEIGHING) than its command sent`);
    expect(await problem(withData(weighing, 'lot', { ...((we['data'] as Json)['lot'] as Json), id: 'L2409-0017' }))).toBe(`stores another lot in entry ${wk} (CONTAINER_WEIGHING) than its command sent`);
    const sample = first('SAMPLE');
    const [sk] = added(sample);
    expect(await problem(withData(sample, 'point', 'ELSEWHERE'))).toBe(`stores another point in entry ${sk} (SAMPLE) than its command sent`);
    // A checklist's answers are taken over as sent.
    const clearance = first('CLEARANCE_CHECK');
    const [ck] = added(clearance);
    expect(await problem(withData(clearance, 'answers', []))).toBe(`stores another answers in entry ${ck} (CLEARANCE_CHECK) than its command sent`);
    // The members a block adds are its own: the person, a label.
    expect(await problem(withData(previous, 'recordedBy', 'SOMEONE'))).toBeNull();
    expect(await problem(withData(weighing, 'label', {}))).toBeNull();
    // An entry with no data its command sent behind it: a START_DATA without start data, an entry in a row that records none.
    const noData = structuredClone(previous);
    const [nk] = added(noData);
    (entries(noData.after)[nk] as Json)['data'] = 'B24-0001';
    expect(await problem(noData)).toBe(`stores entry ${nk} (PREVIOUS_BATCH), and no data its command sent stands behind it`);
    expect(await problem({ ...previous, accepted: false })).toBe(`stores entry ${pk} (PREVIOUS_BATCH), and no data its command sent stands behind it`);
    // The honest rows pass.
    for (const r of [previous, weighing, sample, clearance]) expect(await problem(r), r.label).toBeNull();
  }, 300_000);
});

describe('F12 round 3: a container a row registers is the one its entry names (DI-30, DI-05)', () => {
  const containers = (st: Json): Record<string, Json> => (st['containers'] as Record<string, Json> | undefined) ?? {};
  const newContainers = (r: Row): string[] => Object.keys(containers(r.after)).filter((k) => !(k in containers(r.before)));
  const granulation = (): { mbr: unknown; rows: Row[] } => {
    const run = Run.issue(fixtureDefinition('tablet-granulation-compression'), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    const start = run.state;
    expect(autopilot(run, GRANULATION_SCENARIO)).toBe('COMPLETE');
    return { mbr: run.def.mbr, rows: rowsOf(run, start) };
  };
  async function containerProblem(mbr: unknown, r: Pick<Row, 'accepted' | 'command' | 'before' | 'after'>, kind = 'COMMAND'): Promise<string | null> {
    const { rows } = await db.admin.query<{ p: string | null }>('select recipe.new_container_problem($1::jsonb, $2::jsonb, $3::jsonb, $4, $5, $6::jsonb) as p', [
      JSON.stringify(mbr),
      JSON.stringify(r.before),
      JSON.stringify(r.after),
      kind,
      r.accepted,
      JSON.stringify(r.command),
    ]);
    return rows[0]?.p ?? null;
  }

  it('[DI-30][DI-05] every container the engine\'s own runs register passes: dispensed containers and output containers, named by the entry or built by the block', async () => {
    let named = 0;
    let built = 0;
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants: name === 'tablet-blister-packaging' ? { packDestination: 'US-EXPORT' } : {} });
      const start = run.state;
      expect(autopilot(run, name === 'tablet-granulation-compression' ? GRANULATION_SCENARIO : PACKAGING_SCENARIO)).toBe('COMPLETE');
      const out: Record<string, string> = {};
      for (const r of rowsOf(run, start)) {
        const p = await containerProblem(run.def.mbr, r);
        if (p !== null) out[r.label] = p;
        if (newContainers(r).length > 0) {
          if ('container' in (((r.command as Json)['entry'] as Json | undefined) ?? {})) named += 1;
          else built += 1;
        }
      }
      expect(out, name).toEqual({});
    }
    expect(named, 'containers named by their entry').toBeGreaterThan(0);
    expect(built, 'output containers whose id the block builds').toBeGreaterThan(0);
  }, 300_000);

  it('[DI-30][DI-05] a container that is not the one its entry registers is refused: the verifier\'s container beside a previous batch, another id, a second container, other facts, a row that records no entry', async () => {
    const { mbr, rows } = granulation();
    const firstAdding = (pred: (r: Row) => boolean): Row => {
      const r = rows.find((x) => x.accepted && pred(x));
      if (!r) throw new Error('SETUP: no such row');
      return r;
    };
    const previous = firstAdding((x) => Object.entries(entries(x.after)).some(([k, e]) => !(k in entries(x.before)) && e['kind'] === 'PREVIOUS_BATCH'));
    const [pk, pe] = added(previous);
    const stepKey = String(pe['stepKey']);
    // The round-3 verification's row: a real-format container registered beside the previous batch.
    const forged = structuredClone(previous);
    forged.after['containers'] = { ...containers(forged.after), 'L2409-0017': { id: 'L2409-0017', holds: 'BOM-API', holdsKind: 'BOM_LINE', producedBy: stepKey, producedIn: [], status: 'QUARANTINE' } };
    expect(await containerProblem(mbr, forged)).toBe(`adds container L2409-0017 beside entry ${pk} (PREVIOUS_BATCH) of step ${stepKey}, whose block (G-10) registers no container with such an entry`);
    // A dispensing weighing's container under another id than its entry names, or with a second container beside it.
    const weighing = firstAdding((x) => newContainers(x).length === 1 && Object.values(entries(x.after)).some((e) => e['kind'] === 'CONTAINER_WEIGHING'));
    const [wk] = added(weighing);
    const [ck] = newContainers(weighing) as [string];
    const own = containers(weighing.after)[ck] as Json;
    const renamed = structuredClone(weighing);
    delete containers(renamed.after)[ck];
    containers(renamed.after)['L2409-0017'] = { ...own, id: 'L2409-0017' };
    expect(await containerProblem(mbr, renamed)).toBe(`registers container L2409-0017, which is not the container its entry ${wk} names or the block builds (${ck})`);
    const second = structuredClone(weighing);
    containers(second.after)['L2409-0017'] = { ...own, id: 'L2409-0017' };
    expect(await containerProblem(mbr, second)).toBe(`adds 2 containers (${[ck, 'L2409-0017'].sort().join(', ')}); an entry registers one container`);
    const otherFacts = structuredClone(weighing);
    (containers(otherFacts.after)[ck] as Json)['holds'] = 'BOM-OTHER';
    expect(await containerProblem(mbr, otherFacts)).toContain(`registers container ${ck} with other facts than its entry ${wk} gives (`);
    // An output container whose id is not the one the block builds.
    const output = firstAdding((x) => newContainers(x).length === 1 && !('container' in (((x.command as Json)['entry'] as Json | undefined) ?? {})));
    const [ok] = newContainers(output) as [string];
    const shifted = structuredClone(output);
    const moved = `${ok.slice(0, ok.lastIndexOf('/'))}/99`;
    delete containers(shifted.after)[ok];
    containers(shifted.after)[moved] = { ...(containers(output.after)[ok] as Json), id: moved };
    expect(await containerProblem(mbr, shifted)).toBe(`registers container ${moved}, which is not the container its entry ${added(output)[0]} names or the block builds (${ok})`);
    // Only an accepted RECORD_ENTRY registers one.
    expect(await containerProblem(mbr, { ...weighing, accepted: false })).toBe(`adds container ${ck}; only the accepted RECORD_ENTRY of an entry that registers it adds one`);
    // The honest rows pass.
    for (const r of [previous, weighing, output]) expect(await containerProblem(mbr, r), r.label).toBeNull();
  }, 300_000);
});

describe('F12 round 4: an entry names only what its step\'s node in the MBR names (DI-05, DI-30, PR-18, PR-21, PR-23)', () => {
  const containers = (st: Json): Record<string, Json> => (st['containers'] as Record<string, Json> | undefined) ?? {};
  const steps = (st: Json): Record<string, Json> => (st['steps'] as Record<string, Json> | undefined) ?? {};
  const consumed = (r: Row): string[] => Object.entries(containers(r.after)).filter(([k, c]) => c['status'] === 'CONSUMED' && containers(r.before)[k]?.['status'] !== 'CONSUMED').map(([k]) => k);
  async function referenceProblem(mbr: unknown, r: Pick<Row, 'command' | 'before' | 'after'>): Promise<string | null> {
    const { rows } = await db.admin.query<{ p: string | null }>('select recipe.entry_reference_problem($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb) as p', [
      JSON.stringify(mbr),
      JSON.stringify(r.before),
      JSON.stringify(r.after),
      JSON.stringify(r.command),
    ]);
    return rows[0]?.p ?? null;
  }
  const fixtureRuns = (): { name: string; mbr: unknown; rows: Row[] }[] =>
    (['tablet-granulation-compression', 'tablet-blister-packaging'] as const).map((name) => {
      const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants: name === 'tablet-blister-packaging' ? { packDestination: 'US-EXPORT' } : {} });
      const start = run.state;
      expect(autopilot(run, name === 'tablet-granulation-compression' ? GRANULATION_SCENARIO : PACKAGING_SCENARIO)).toBe('COMPLETE');
      return { name, mbr: run.def.mbr, rows: rowsOf(run, start) };
    });

  it('[DI-05][DI-30][PR-18][PR-21][PR-23] every entry and every charge of the engine\'s own runs passes: weighings, lot and container charges, outputs, equipment checks', async () => {
    const kinds = new Set<string>();
    let charged = 0;
    for (const { name, mbr, rows } of fixtureRuns()) {
      const out: Record<string, string> = {};
      for (const r of rows) {
        const p = await referenceProblem(mbr, r);
        if (p !== null) out[r.label] = p;
        for (const [k, e] of Object.entries(entries(r.after))) if (!(k in entries(r.before))) kinds.add(String(e['kind']));
        charged += consumed(r).length;
      }
      expect(out, name).toEqual({});
    }
    expect([...kinds]).toEqual(expect.arrayContaining(['CONTAINER_WEIGHING', 'CHARGE_LOT', 'CHARGE_CONTAINER', 'OUTPUT_CONTAINER', 'EQUIPMENT_STATUS']));
    expect(charged, 'containers charged').toBeGreaterThan(0);
  }, 300_000);

  it('[DI-05][DI-30][PR-18][PR-21][PR-23] an entry that names what its step\'s node does not is refused: a BOM line not in the BOM or not this step\'s, an intermediate the step does not produce, a container charge of an unknown, consumed, unplanned or other sub-lot\'s container, with other contents or another label, a consumption no charge names, equipment the step does not check', async () => {
    const runs = fixtureRuns();
    const mbrOf = new Map<Row, unknown>(runs.flatMap((x) => x.rows.map((r) => [r, x.mbr] as const)));
    const rows = runs.flatMap((x) => x.rows);
    const adding = (kind: string, pred: (r: Row) => boolean = () => true): Row => {
      const r = rows.find((x) => x.accepted && Object.entries(entries(x.after)).some(([k, e]) => !(k in entries(x.before)) && e['kind'] === kind) && pred(x));
      if (!r) throw new Error(`SETUP: no ${kind} row`);
      return r;
    };
    const stepOf = (r: Row): string => String(added(r)[1]['stepKey']);
    /** The MBR node of the step the row's entry is at (found by id anywhere in the procedure or library). */
    const stepNode = (r: Row): unknown => {
      const id = String(steps(r.after)[stepOf(r)]?.['step']).split('/').pop();
      const find = (n: unknown): unknown => {
        if (Array.isArray(n)) for (const x of n) { const f = find(x); if (f) return f; }
        else if (n !== null && typeof n === 'object') {
          if ((n as Json)['kind'] === 'phase' && (n as Json)['id'] === id) return n;
          for (const v of Object.values(n)) { const f = find(v); if (f) return f; }
        }
        return undefined;
      };
      return find(mbrOf.get(r));
    };
    const idOf = (r: Row): string => added(r)[0];
    const edit = (r: Row, change: (data: Json, after: Json, before: Json, command: Json) => void): Row => {
      const f = structuredClone(r);
      const [k] = added(f);
      change(entries(f.after)[k]?.['data'] as Json, f.after, f.before, f.command as Json);
      mbrOf.set(f, mbrOf.get(r));
      return f;
    };
    const check = (r: Row): Promise<string | null> => referenceProblem(mbrOf.get(r), r);
    const weighing = adding('CONTAINER_WEIGHING');
    const lot = adding('CHARGE_LOT');
    const output = adding('OUTPUT_CONTAINER');
    const charge = adding('CHARGE_CONTAINER');
    // An equipment check of a step that lists equipment for a status check.
    const status = adding('EQUIPMENT_STATUS', (r) => JSON.stringify(stepNode(r)).includes('STATUS_CHECK'));
    const chargedId = String((entries(charge.after)[idOf(charge)]?.['data'] as Json)['container']);
    const chargedHolds = String((entries(charge.after)[idOf(charge)]?.['data'] as Json)['holds']);
    // A quarantine container of the state before the charge that the charge does not name.
    const otherQuarantine = Object.entries(containers(charge.before)).find(([k, c]) => k !== chargedId && c['status'] === 'QUARANTINE')?.[0];
    // A BOM line the weighing's step does not dispense (another line of the BOM).
    const otherLine = ((mbrOf.get(weighing) as Json)['bom'] as Json[]).map((b) => String(b['id'])).find((b) => b !== (entries(weighing.after)[idOf(weighing)]?.['data'] as Json)['bomLine']);
    if (!otherLine || !otherQuarantine) throw new Error('SETUP');
    const outcomes = {
      weighingUnknownLine: await check(edit(weighing, (d) => void (d['bomLine'] = 'L2409-0017'))),
      weighingOtherLine: await check(edit(weighing, (d) => void (d['bomLine'] = otherLine))),
      lotUnknownLine: await check(edit(lot, (d) => void (d['bomLine'] = 'L2409-0017'))),
      outputIntermediate: await check(edit(output, (d) => void (d['intermediate'] = 'L2409-0017'))),
      chargeUnknown: await check(edit(charge, (d) => void (d['container'] = 'TEST-L26-9999'))),
      chargeConsumed: await check(edit(charge, (_d, _a, before) => void (containers(before)[chargedId] = { ...containers(before)[chargedId], status: 'CONSUMED', consumedBy: 'elsewhere@' }))),
      chargeOtherContents: await check(edit(charge, (d) => void (d['holds'] = 'L2409-0017'))),
      chargeUnplanned: await check(edit(charge, (d, _a, before) => {
        d['holds'] = 'I-NOT-USED';
        containers(before)[chargedId] = { ...containers(before)[chargedId], holds: 'I-NOT-USED' };
      })),
      chargeOtherSubLot: await check(edit(charge, (_d, after, before) => {
        steps(after)[stepOf(charge)] = { ...steps(after)[stepOf(charge)], frames: [{ construct: 'R-SPLIT', index: 1 }] };
        containers(before)[chargedId] = { ...containers(before)[chargedId], producedIn: [{ construct: 'R-SPLIT', index: 2 }] };
      })),
      chargeOtherLabel: await check(edit(charge, (_d, _a, _b, command) => void ((command['entry'] as Json)['scannedBatch'] = 'TEST-B26-0002'))),
      consumedUnnamed: await check(edit(charge, (_d, after) => void (containers(after)[otherQuarantine] = { ...containers(after)[otherQuarantine], status: 'CONSUMED', consumedBy: stepOf(charge) }))),
      consumedByNoCharge: await check(edit(weighing, (_d, after, before) => {
        containers(before)['TEST-C-1'] = { id: 'TEST-C-1', holds: 'X', holdsKind: 'BOM_LINE', producedBy: 'a@', producedIn: [], status: 'QUARANTINE' };
        containers(after)['TEST-C-1'] = { ...containers(before)['TEST-C-1'], status: 'CONSUMED', consumedBy: stepOf(weighing) };
      })),
      statusOtherEquipment: await check(edit(status, (d) => void (d['equipmentRef'] = 'L2409-0017'))),
    };
    const w = `entry ${idOf(weighing)} (CONTAINER_WEIGHING) of step ${stepOf(weighing)}`;
    const ws = String(steps(weighing.after)[stepOf(weighing)]?.['step']);
    const c = `entry ${idOf(charge)} (CHARGE_CONTAINER) of step ${stepOf(charge)}`;
    const cs = String(steps(charge.after)[stepOf(charge)]?.['step']);
    const { statusOtherEquipment, ...rest } = outcomes;
    expect(statusOtherEquipment).toMatch(new RegExp(`^stores entry ${idOf(status)} \\(EQUIPMENT_STATUS\\) of step ${stepOf(status).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} for equipment L2409-0017, which step \\S+ does not check \\(.+\\)$`));
    expect(rest).toEqual({
      weighingUnknownLine: `stores ${w} with BOM line L2409-0017, which is not a line of the MBR's bill of materials that step ${ws} dispenses`,
      weighingOtherLine: `stores ${w} with BOM line ${otherLine}, which is not a line of the MBR's bill of materials that step ${ws} dispenses`,
      lotUnknownLine: `stores entry ${idOf(lot)} (CHARGE_LOT) of step ${stepOf(lot)} with BOM line L2409-0017, which is not a line of the MBR's bill of materials that step ${String(steps(lot.after)[stepOf(lot)]?.['step'])} charges`,
      outputIntermediate: `stores entry ${idOf(output)} (OUTPUT_CONTAINER) of step ${stepOf(output)} holding intermediate L2409-0017, which step ${String(steps(output.after)[stepOf(output)]?.['step'])} does not produce`,
      chargeUnknown: `stores ${c} charging container TEST-L26-9999, which the batch did not hold in quarantine before the row`,
      chargeConsumed: `stores ${c} charging container ${chargedId}, which the batch did not hold in quarantine before the row`,
      chargeOtherContents: `stores ${c} stating that container ${chargedId} holds L2409-0017, where it holds ${chargedHolds}`,
      chargeUnplanned: `stores ${c} charging container ${chargedId}, which holds I-NOT-USED (${String(containers(charge.before)[chargedId]?.['holdsKind'])}), and step ${cs} does not charge it`,
      chargeOtherSubLot: `stores ${c} charging container ${chargedId}, which belongs to another instance of a construct around step ${stepOf(charge)}`,
      chargeOtherLabel: `stores ${c} charging container ${chargedId} whose scanned label shows batch TEST-B26-0002, not this batch ${String((charge.after['header'] as Json)['batchNumber'])}`,
      consumedUnnamed: `marks container(s) ${[chargedId, otherQuarantine].sort().join(', ')} consumed, where the charges it records name ${chargedId}`,
      consumedByNoCharge: `marks container(s) TEST-C-1 consumed, where the charges it records name (none)`,
    });
    // The honest rows pass.
    for (const r of [weighing, lot, output, charge, status]) expect(await check(r), r.label).toBeNull();
  }, 300_000);
});
