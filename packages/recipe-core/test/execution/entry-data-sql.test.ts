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
 *
 * Round 5 (sql 0330: recipe.entry_block_problem; the round-4 verification): the members a block builds rather than
 * takes from the command were compared by nothing. An acknowledgement naming sop B24-0001 and sopVersion L2409-0017,
 * where the MBR pins SOP-DISP-001 version 1, was stored. Now every entry a row adds holds exactly the data its block
 * builds (the SOP reference, a sample's id and label, a source addition's case, the person, the passed flags, the
 * whole command where the block keeps it), as an entry record of the row's own time and events, leaves its step
 * needing the check the block asks for, and meets the accept rules that read only the MBR, the batch and the entry
 * (a checklist's answers, a sampling plan, a lot's usability, a disposal, a source addition, a reprocessing's
 * authorisation). Every entry of every block's golden fixture, of both golden runs and of runs made for the kinds they
 * leave out passes, and every kind the blocks of this release record is among them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { BlockVersion } from '../../src/blocks/contract.ts';
import { GENERIC_BLOCK_VERSIONS } from '../../src/blocks/generic/index.ts';
import { DEFAULT_CLEARANCE_CHECKLIST, DEFAULT_STATUS_CHECKS } from '../../src/blocks/generic/status.ts';
import { encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import type { BatchState } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { fixtureMbr } from '../blocks/support.ts';
import { mbrWith, phase, type FixtureName } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP2, PACKAGING_SCENARIO, Run, SUP1, T0 } from '../engine/support.ts';

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

describe('F12 round 5: an entry holds exactly what its block builds and accepts (DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47)', () => {
  interface MRow extends Row {
    mbr: MbrContent;
  }
  const G = (type: string) => ({ type, version: '1' });
  const steps = (st: Json): Record<string, Json> => (st['steps'] as Record<string, Json> | undefined) ?? {};

  async function blockProblem(r: MRow): Promise<string | null> {
    const { rows } = await db.admin.query<{ p: string | null }>('select recipe.entry_block_problem($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb) as p', [
      JSON.stringify(r.mbr),
      JSON.stringify(r.before),
      JSON.stringify(r.after),
      JSON.stringify(r.command),
    ]);
    return rows[0]?.p ?? null;
  }

  /** The rows of a run of `mbr` (issued with `issue`, its state set up by `setup`) that `script` drives. */
  function rowsFor(mbr: MbrContent, script: (run: Run) => void, issue: Parameters<typeof Run.issue>[1] = {}, setup: (run: Run) => void = () => undefined): MRow[] {
    const run = Run.issue(define(mbr), issue, T0);
    setup(run);
    const start = structuredClone(run.state);
    script(run);
    return rowsOf(run, start).map((r) => ({ ...r, mbr }));
  }

  /** The rows of a block's golden fixture: issued, started (with its start data), its script, PERFORMED and the check. */
  function fixtureRows(b: BlockVersion): MRow[] {
    const f = b.goldenFixture;
    if (!f) throw new Error('SETUP: no fixture');
    const inputs = Object.fromEntries(
      (f.inputs ?? []).map((i) => [i.id, { value: i.valueType === 'COUNT' ? { kind: 'COUNT' as const, value: i.value } : { kind: 'DECIMAL' as const, value: i.value, unit: i.unit ?? '1' }, source: 'golden fixture' }]),
    );
    return rowsFor(
      fixtureMbr(b),
      (run) => {
        const startData = f.script.find((s): s is { startData: Record<string, unknown> } => 'startData' in s)?.startData;
        run.start('p', [], undefined, startData);
        for (const s of f.script) {
          if ('record' in s) run.record('p', s.record, s.value, { source: run.def.analysis.parameters.get(s.record)?.capture === 'MANUAL' ? { mode: 'MANUAL' } : { mode: 'DEVICE', device: 'DEV-G' } });
          else if ('entry' in s) run.entry('p', s.entry);
          else if ('advanceUs' in s) run.advance(s.advanceUs);
        }
      },
      { inputs },
      (run) => {
        for (const c of f.containers ?? []) run.state.containers[c.id] = { id: c.id, holds: c.holds, holdsKind: c.holdsKind, producedBy: 'setup@', producedIn: [], status: 'QUARANTINE' };
      },
    );
  }

  const seqOf = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
  const SOP = { id: 'SOP-1', kind: 'SOP' as const, code: 'SOP-GRAN-004', version: '7', hash: 'd'.repeat(64) };
  const LOT = { id: 'AR-9', material: 'MAT-M', status: 'RELEASED', identityTested: true };
  const BOM = [{ id: 'B', material: 'MAT-M', role: 'ACTIVE' as const, quantity: { value: '1', unit: 'kg' } }];

  /** Runs made for what the golden fixtures leave out: each named row adds the entry its name says. */
  function specialRows(): Record<string, MRow> {
    const out: Record<string, MRow> = {};
    const name = (rows: MRow[], ...names: string[]): void => {
      const adding = rows.filter((r) => Object.keys(entries(r.after)).some((k) => !(k in entries(r.before))));
      names.forEach((n, i) => {
        const r = adding[i];
        if (!r) throw new Error(`SETUP: no row for ${n}`);
        out[n] = r;
      });
    };
    // G-03: an acknowledgement of the SOP its step names (with and without the version shown), one with no SOP.
    name(
      rowsFor(mbrWith(seqOf('ops', phase('read', { block: G('G-03'), config: { sop: 'SOP-1', acknowledgement: 'READ' } }), phase('plain', { block: G('G-03'), config: { acknowledgement: 'CONFIRM_PERFORMED' } })), { references: [SOP] }), (run) => {
        run.start('read');
        run.entry('read', { kind: 'ACKNOWLEDGE', mode: 'READ', sopVersion: '7' });
        run.entry('read', { kind: 'ACKNOWLEDGE', mode: 'READ' });
        run.perform('read');
        run.verify('read');
        run.start('plain');
        run.entry('plain', { kind: 'ACKNOWLEDGE', mode: 'CONFIRM_PERFORMED' });
      }),
      'ackSop', 'ackSopNoVersion', 'ackPlain',
    );
    // G-12 in a sub-lot: the id and label carry the sub-lot; a sample from a named container.
    const subLot = mbrWith(seqOf('ops', phase('pre'), { kind: 'replicate', id: 'R', name: 'Sub-lots', count: { mode: 'RUNTIME', min: 1, max: 2, reasonRequired: true }, instances: 'SEQUENTIAL', subLotPrefix: 'SL', body: phase('smp', { block: G('G-12'), config: { locations: 2, purpose: 'BU' } }) }, phase('after')));
    const i1 = [{ construct: 'R', index: 1 }];
    name(
      rowsFor(subLot, (run) => {
        done(run, 'pre');
        run.ok({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: 'R', count: 1, reason: 'one load' });
        run.start('smp', i1);
        run.entry('smp', { kind: 'SAMPLE', point: 'L1', purpose: 'BU', units: 1 }, i1);
        run.entry('smp', { kind: 'SAMPLE', point: 'L2', purpose: 'BU', units: 2, container: 'TEST-C-9' }, i1);
      }),
      'sampleSubLot', 'sampleContainer',
    );
    // G-15: a transfer issued by one person and received by another.
    name(
      rowsFor(mbrWith(seqOf('ops', phase('xfer', { block: G('G-15'), config: { transfer: true } }))), (run) => {
        run.start('xfer');
        run.entry('xfer', { kind: 'TRANSFER_ISSUED', material: 'Granules', quantity: { value: '1', unit: 'kg' } });
        run.entry('xfer', { kind: 'TRANSFER_RECEIVED', material: 'Granules' }, [], OP2);
      }),
      'transferIssued', 'transferReceived',
    );
    // G-05: a scanned paper original (needs the check) and a photo.
    name(
      rowsFor(mbrWith(seqOf('ops', phase('att', { block: G('G-05') }))), (run) => {
        run.start('att');
        run.entry('att', { kind: 'ATTACHMENT', sha256: 'a'.repeat(64), mediaType: 'application/pdf', description: 'Printout of the blender', paperOriginal: true });
        run.entry('att', { kind: 'ATTACHMENT', sha256: 'b'.repeat(64), mediaType: 'image/png', description: 'Photo of the label' });
      }),
      'attachmentPaper', 'attachmentPhoto',
    );
    // G-10 with an item that may be not applicable.
    name(
      rowsFor(mbrWith(seqOf('ops', phase('clr', { block: G('G-10'), config: { checklist: [{ id: 'AREA', text: 'Area clean', expected: 'CONFIRMED_OR_NOT_APPLICABLE' }, { id: 'DOCS', text: 'No documents', expected: 'CONFIRMED' }] } }))), (run) => {
        run.start('clr');
        run.entry('clr', { kind: 'CLEARANCE_CHECK', answers: [{ id: 'AREA', answer: 'NOT_APPLICABLE' }, { id: 'DOCS', answer: 'CONFIRMED' }] });
      }),
      'clearanceNotApplicable',
    );
    // G-07 keyed by hand for a batch for the US (an identity-tested lot); G-08 charging a lot with its quantity.
    const weigh = mbrWith(seqOf('ops', phase('w', { block: G('G-07'), consumes: ['B'], records: ['q'] })), {
      bom: BOM,
      references: [{ id: 'MAT-M', kind: 'MATERIAL', code: 'M-CODE', version: '1', hash: 'c'.repeat(64) }],
      parameters: [{ id: 'q', name: 'q', valueType: 'DECIMAL', unit: 'kg', role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' }],
    });
    weigh.header = { ...weigh.header, marketSet: ['IN', 'US'] };
    name(
      rowsFor(
        weigh,
        (run) => {
          run.start('w');
          run.entry('w', { kind: 'CONTAINER_WEIGHING', item: 'q', bomLine: 'B', container: 'C-1', lot: { ...LOT, material: 'M-CODE', expiresAtUs: String(T0 + 10n ** 12n) }, gross: '2.000', tare: '1.000', unit: 'kg', balance: 'BAL-1', source: 'MANUAL' });
        },
        { marketSet: ['IN', 'US'] },
      ),
      'weighingManual',
    );
    name(
      rowsFor(mbrWith(seqOf('ops', phase('k', { block: G('G-08'), consumes: ['B'] })), { bom: BOM }), (run) => {
        run.start('k');
        run.entry('k', { kind: 'CHARGE_LOT', bomLine: 'B', container: 'TEST-K-1', lot: LOT, quantity: { value: '1', unit: 'kg' } });
      }),
      'chargeLotQuantity',
    );
    // G-23: a reject in its container and a return of material that is not batch coded.
    name(
      rowsFor(mbrWith(seqOf('ops', phase('dis', { block: G('G-23') }))), (run) => {
        run.start('dis');
        run.entry('dis', { kind: 'DISPOSAL', category: 'REJECT_CONTAINER', material: 'Tablets', quantity: { value: '2', unit: 'kg' }, container: 'TEST-R-1' });
        run.entry('dis', { kind: 'DISPOSAL', category: 'RETURN_TO_STORES', material: 'Foil', batchCoded: false, quantity: { value: '3', unit: 'kg' } });
      }),
      'disposalReject', 'disposalReturn',
    );
    // G-24: a reprocessing addition limited to one source batch; a validated re-treatment needs no authorisation.
    name(
      rowsFor(mbrWith(seqOf('ops', phase('add', { block: G('G-24'), reprocessing: { case: 'REPROCESSING_ADDITION', maxSourceBatches: 1, maxAge: { value: '30', unit: 'd' } } }))), (run) => {
        run.start('add', [], undefined, { investigationRef: 'INV-1', riskEvaluationRef: 'RA-1', authorisationRef: 'AUTH-1', authorisedBy: 'QA1' });
        run.entry('add', { kind: 'SOURCE_ADDITION', sourceBatch: 'TEST-B26-0007', productCode: 'P', quantity: { value: '0.01', unit: 'kg' }, manufacturedAtUs: String(T0 - 10n ** 12n) });
        run.entry('add', { kind: 'SOURCE_ADDITION', sourceBatch: 'TEST-B26-0007', productCode: 'P', quantity: { value: '0.01', unit: 'kg' }, manufacturedAtUs: String(T0 - 10n ** 12n) });
      }),
      'additionStart', 'addition', 'additionSameSource',
    );
    const retreat = rowsFor(mbrWith(seqOf('ops', phase('rt', { block: G('G-24'), reprocessing: { case: 'VALIDATED_RETREATMENT' } }))), (run) => void run.start('rt'));
    if (!retreat[0]) throw new Error('SETUP: no re-treatment start');
    out['retreatmentStart'] = retreat[0];
    return out;
  }

  /** Row `r` with the entry it adds (and the state after, the state before, the command) changed by `change`. */
  function forge(r: MRow, change: (x: { e: Json; data: Json; after: Json; before: Json; command: Json; mbr: Json }) => void): MRow {
    const f = structuredClone(r);
    const [k] = added(f);
    const e = entries(f.after)[k] as Json;
    change({ e, data: e['data'] as Json, after: f.after, before: f.before, command: f.command as Json, mbr: f.mbr as unknown as Json });
    return f;
  }
  const about = (r: MRow): string => {
    const [k, e] = added(r);
    return `entry ${k} (${String(e['kind'])}) of step ${String(e['stepKey'])}`;
  };
  /** `about(r)` as a regular expression. */
  const aboutRe = (r: MRow): string => about(r).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  it('[DI-05][DI-10][DI-30][PR-14][PR-18][PR-23][PR-29][PR-34][PR-40][PR-47] every entry of the engine\'s own runs passes: every block\'s golden fixture, both golden runs and runs of the kinds they leave out; every entry kind of this release\'s blocks is among them, and the database\'s default checklists are the blocks\'', async () => {
    const kinds = new Set<string>();
    const out: Record<string, string> = {};
    const all: [string, MRow][] = [];
    for (const b of GENERIC_BLOCK_VERSIONS) if (b.level === 'PHASE' && b.goldenFixture) for (const r of fixtureRows(b)) all.push([`${b.type} ${r.label}`, r]);
    for (const { name, rows } of runs()) {
      const mbr = fixtureDefinition(name as FixtureName).mbr;
      for (const r of rows) all.push([`${name} ${r.label}`, { ...r, mbr }]);
    }
    for (const [n, r] of Object.entries(specialRows())) all.push([n, r]);
    for (const [label, r] of all) {
      const p = await blockProblem(r);
      if (p !== null) out[label] = p;
      for (const [k, e] of Object.entries(entries(r.after))) if (!(k in entries(r.before))) kinds.add(String(e['kind']));
    }
    expect(out).toEqual({});
    const registered = new Set(GENERIC_BLOCK_VERSIONS.flatMap((b) => [...Object.keys(b.dataSchema?.entries ?? {}), ...(b.dataSchema?.startData ? ['START_DATA'] : [])]));
    expect([...kinds].sort()).toEqual([...registered].sort());
    // The checks and checklist the database applies when the configuration names none are the blocks' defaults.
    const { rows } = await db.admin.query<{ s: string[]; c: unknown }>("select recipe.status_check_ids('{}'::jsonb) as s, recipe.clearance_items('{}'::jsonb) as c");
    expect(rows[0]?.s).toEqual(DEFAULT_STATUS_CHECKS.map((c) => c.id));
    expect(rows[0]?.c).toEqual(DEFAULT_CLEARANCE_CHECKLIST.map((c) => ({ id: c.id, expected: c.expected })));
  }, 300_000);

  it('[DI-05][DI-10][DI-30] the round-4 verification\'s acknowledgement naming sop B24-0001 and sopVersion L2409-0017, and every other acknowledgement the block does not build, is refused', async () => {
    const s = specialRows();
    const ack = s['ackSop'] as MRow;
    const plain = s['ackPlain'] as MRow;
    const outcomes = {
      verifierProbe: await blockProblem(forge(ack, ({ data }) => Object.assign(data, { sop: 'B24-0001', sopVersion: 'L2409-0017' }))),
      otherSop: await blockProblem(forge(ack, ({ data }) => Object.assign(data, { sop: 'SOP-CLEAN-003', sopVersion: '7' }))),
      otherVersion: await blockProblem(forge(ack, ({ data, command }) => {
        data['sopVersion'] = '6';
        (command['entry'] as Json)['sopVersion'] = '6';
      })),
      otherHash: await blockProblem(forge(ack, ({ data }) => void (data['sopHash'] = 'e'.repeat(64)))),
      sopDropped: await blockProblem(forge(ack, ({ data }) => void delete data['sop'])),
      sopAdded: await blockProblem(forge(plain, ({ data }) => Object.assign(data, { sop: 'B24-0001', sopVersion: 'L2409-0017', sopHash: null }))),
      otherMode: await blockProblem(forge(plain, ({ data, command }) => {
        data['mode'] = 'READ';
        (command['entry'] as Json)['mode'] = 'READ';
      })),
      otherPerson: await blockProblem(forge(ack, ({ data }) => void (data['acknowledgedBy'] = 'OP2'))),
    };
    expect(outcomes).toEqual({
      verifierProbe: `stores ${about(ack)} with sop "B24-0001", where its block writes "SOP-GRAN-004"`,
      otherSop: `stores ${about(ack)} with sop "SOP-CLEAN-003", where its block writes "SOP-GRAN-004"`,
      otherVersion: `stores ${about(ack)} with sopVersion "6", where its block writes "7"`,
      otherHash: `stores ${about(ack)} with sopHash "${'e'.repeat(64)}", where its block writes "${'d'.repeat(64)}"`,
      sopDropped: `stores ${about(ack)} with sop (no such member), where its block writes "SOP-GRAN-004"`,
      sopAdded: `stores ${about(plain)} with sop "B24-0001", where its block writes (no such member)`,
      otherMode: `stores ${about(plain)} with mode "READ", where its block writes "CONFIRM_PERFORMED"`,
      otherPerson: `stores ${about(ack)} with acknowledgedBy "OP2", where its block writes "OP1"`,
    });
    for (const r of [ack, s['ackSopNoVersion'] as MRow, plain]) expect(await blockProblem(r), r.label).toBeNull();
  }, 300_000);

  it('[DI-05][DI-30][PR-29] a sample whose id or label is not the one the block builds from the batch, the MBR\'s product, the step, its sub-lot, the person and the time, or that is not of the sampling plan, is refused', async () => {
    const s = specialRows();
    const sample = s['sampleSubLot'] as MRow;
    const second = s['sampleContainer'] as MRow;
    const id = String((added(sample)[1]['data'] as Json)['sampleId']);
    expect(id).toBe('B0001/smp/B0001-SL1/S1');
    expect(String((added(second)[1]['data'] as Json)['sampleId'])).toBe('B0001/smp/B0001-SL1/S2');
    const label = (data: Json): Json => data['label'] as Json;
    const outcomes = {
      realBatchId: await blockProblem(forge(sample, ({ data }) => {
        data['sampleId'] = 'B24-0001/smp/S1';
        label(data)['sample'] = 'B24-0001/smp/S1';
      })),
      noSubLot: await blockProblem(forge(sample, ({ data }) => {
        data['sampleId'] = 'B0001/smp/S1';
        label(data)['sample'] = 'B0001/smp/S1';
      })),
      renumbered: await blockProblem(forge(second, ({ data }) => {
        data['sampleId'] = 'B0001/smp/B0001-SL1/S1';
        label(data)['sample'] = 'B0001/smp/B0001-SL1/S1';
      })),
      labelBatch: await blockProblem(forge(sample, ({ data }) => void (label(data)['batch'] = 'B24-0001'))),
      labelProduct: await blockProblem(forge(sample, ({ data }) => void (label(data)['product'] = 'PCM500'))),
      labelSampler: await blockProblem(forge(sample, ({ data }) => void (label(data)['sampler'] = 'OP2'))),
      labelTime: await blockProblem(forge(sample, ({ data }) => void (label(data)['takenAtUs'] = String(T0 - 1n)))),
      containerDropped: await blockProblem(forge(second, ({ data }) => void delete data['container'])),
      notPlanned: await blockProblem(forge(sample, ({ data, command }) => {
        data['point'] = 'L9';
        (command['entry'] as Json)['point'] = 'L9';
      })),
    };
    const labelled = (r: MRow, got: string, writes: string): unknown =>
      expect.stringMatching(new RegExp(`^stores ${aboutRe(r)} with label \\{.*"sample": "${got}".*\\}, where its block writes \\{.*"sample": "${writes}".*\\}$`));
    expect(outcomes).toEqual({
      realBatchId: labelled(sample, 'B24-0001/smp/S1', 'B0001/smp/B0001-SL1/S1'),
      noSubLot: labelled(sample, 'B0001/smp/S1', 'B0001/smp/B0001-SL1/S1'),
      renumbered: labelled(second, 'B0001/smp/B0001-SL1/S1', 'B0001/smp/B0001-SL1/S2'),
      labelBatch: expect.stringMatching(new RegExp(`^stores ${aboutRe(sample)} with label \\{.*"batch": "B24-0001".*\\}, where its block writes \\{.*"batch": "B0001".*\\}$`)) as unknown,
      labelProduct: expect.stringMatching(/with label \{.*"product": "PCM500".*\}, where its block writes \{.*"product": "P".*\}$/) as unknown,
      labelSampler: expect.stringMatching(/with label \{.*"sampler": "OP2".*\}, where its block writes \{.*"sampler": "OP1".*\}$/) as unknown,
      labelTime: expect.stringMatching(new RegExp(`with label \\{.*"takenAtUs": "${String(T0 - 1n)}".*\\}, where its block writes \\{.*"takenAtUs": "\\d+".*\\}$`)) as unknown,
      containerDropped: `stores ${about(second)} with container (no such member), where its block writes "TEST-C-9"`,
      notPlanned: `stores ${about(sample)} taken at point L9 for BU, which is not in the sampling plan of its step (G12-NOT-PLANNED)`,
    });
    for (const r of [sample, second]) expect(await blockProblem(r), r.label).toBeNull();
  }, 300_000);

  it('[DI-05][DI-30][PR-47] a source addition of another product, at a step that is no addition step, with another case, of chained, too old or too many sources, and a reprocessing started without the quality unit\'s authorisation or authorised by its own performer, are refused', async () => {
    const s = specialRows();
    const add = s['addition'] as MRow;
    const same = s['additionSameSource'] as MRow;
    const start = s['additionStart'] as MRow;
    const fixture = fixtureRows(GENERIC_BLOCK_VERSIONS.find((b) => b.type === 'G-24') as BlockVersion);
    const recovery = fixture.find((r) => Object.values(entries(r.after)).some((e) => e['kind'] === 'SOURCE_ADDITION' && !(String(e['id']) in entries(r.before)))) as MRow;
    const node = (mbr: Json): Json => {
      const find = (n: unknown): Json | undefined => {
        if (Array.isArray(n)) for (const x of n) { const f = find(x); if (f) return f; }
        else if (n !== null && typeof n === 'object') {
          if ((n as Json)['kind'] === 'phase' && (n as Json)['block'] && ((n as Json)['block'] as Json)['type'] === 'G-24') return n as Json;
          for (const v of Object.values(n)) { const f = find(v); if (f) return f; }
        }
        return undefined;
      };
      return find(mbr) as Json;
    };
    const cmd = (command: Json): Json => command['entry'] as Json;
    const outcomes = {
      otherProduct: await blockProblem(forge(add, ({ data, command }) => {
        data['productCode'] = 'PCM500';
        cmd(command)['productCode'] = 'PCM500';
      })),
      otherCase: await blockProblem(forge(add, ({ data }) => void (data['case'] = 'RECOVERY'))),
      noAdditionStep: await blockProblem(forge(add, ({ mbr }) => void (node(mbr)['reprocessing'] = { case: 'WHOLE_BATCH' }))),
      chained: await blockProblem(forge(add, ({ data, command }) => {
        data['containsRecovered'] = true;
        cmd(command)['containsRecovered'] = true;
      })),
      tooOld: await blockProblem(forge(add, ({ data, command }) => {
        data['manufacturedAtUs'] = '1000000';
        cmd(command)['manufacturedAtUs'] = '1000000';
      })),
      tooManySources: await blockProblem(forge(same, ({ data, command }) => {
        data['sourceBatch'] = 'TEST-B26-0008';
        cmd(command)['sourceBatch'] = 'TEST-B26-0008';
      })),
      memberDropped: await blockProblem(forge(recovery, ({ data }) => void delete data['manufacturedAtUs'])),
      selfAuthorised: await blockProblem(forge(start, ({ data, command }) => {
        data['authorisedBy'] = 'OP1';
        (command['blockData'] as Json)['authorisedBy'] = 'OP1';
      })),
      notAuthorised: await blockProblem(forge(start, ({ after, command, e }) => {
        delete entries(after)[String(e['id'])];
        delete command['blockData'];
      })),
    };
    expect(outcomes).toEqual({
      otherProduct: `stores ${about(add)} of material of product PCM500 added to a batch of P (G24-OTHER-PRODUCT)`,
      otherCase: `stores ${about(add)} with case "RECOVERY", where its block writes "REPROCESSING_ADDITION"`,
      noAdditionStep: `stores ${about(add)} at a step that is no recovery or reprocessing-addition step (G24-NO-ADDITION)`,
      chained: `stores ${about(add)} from batch TEST-B26-0007, which itself contains recovered material (G24-CHAINED)`,
      tooOld: `stores ${about(add)} from batch TEST-B26-0007, which is older than the MBR's maximum of 30 d (G24-TOO-OLD)`,
      tooManySources: `stores ${about(same)}, which brings the source batches of its step above the MBR's 1 (G24-TOO-MANY-SOURCES)`,
      memberDropped: `stores ${about(recovery)} with manufacturedAtUs (no such member), where its block writes "1790000000000000"`,
      selfAuthorised: `stores ${about(start)} authorised by the person who starts the step; a reprocessing is authorised by the quality unit (G24-SELF-AUTHORISED)`,
      notAuthorised: 'starts reprocessing step add@ without the quality unit\'s prior authorisation (G24-NOT-AUTHORISED)',
    });
    for (const r of [add, same, start, recovery, s['retreatmentStart'] as MRow]) expect(await blockProblem(r), r.label).toBeNull();
  }, 300_000);

  it('[DI-05][DI-30][PR-14][PR-18][PR-23][PR-34][PR-40] what every other block builds is bound too: the person, the passed flags, an output\'s status, a paper original, the whole command a block keeps, no member of its own; the entry record; the check an entry asks for; a checklist\'s answers, a lot\'s usability and a disposal\'s rules', async () => {
    const s = specialRows();
    const [granulation] = runs();
    const gmbr = fixtureDefinition('tablet-granulation-compression').mbr;
    const g = (kind: string): MRow => {
      const r = granulation?.rows.find((x) => x.accepted && Object.entries(entries(x.after)).some(([k, e]) => !(k in entries(x.before)) && e['kind'] === kind));
      if (!r) throw new Error(`SETUP: no ${kind}`);
      return { ...r, mbr: gmbr };
    };
    const fixtureOf = (type: string, kind: string): MRow => {
      const r = fixtureRows(GENERIC_BLOCK_VERSIONS.find((b) => b.type === type) as BlockVersion).find((x) => Object.entries(entries(x.after)).some(([k, e]) => !(k in entries(x.before)) && e['kind'] === kind));
      if (!r) throw new Error(`SETUP: no ${kind}`);
      return r;
    };
    const status = g('EQUIPMENT_STATUS');
    const clearance = g('CLEARANCE_CHECK');
    const previous = g('PREVIOUS_BATCH');
    const weighing = g('CONTAINER_WEIGHING');
    const output = g('OUTPUT_CONTAINER');
    const charge = g('CHARGE_CONTAINER');
    const lotCharge = s['chargeLotQuantity'] as MRow;
    const manual = s['weighingManual'] as MRow;
    const paper = s['attachmentPaper'] as MRow;
    const photo = s['attachmentPhoto'] as MRow;
    const issued = s['transferIssued'] as MRow;
    const received = s['transferReceived'] as MRow;
    const destroy = fixtureOf('G-23', 'DISPOSAL');
    const reject = s['disposalReject'] as MRow;
    const ret = s['disposalReturn'] as MRow;
    const failing = fixtureOf('G-09', 'EQUIPMENT_STATUS');
    const notApplicable = s['clearanceNotApplicable'] as MRow;
    const cmd = (command: Json): Json => command['entry'] as Json;
    const lot = (data: Json, command: Json, change: Json): void => {
      Object.assign(data['lot'] as Json, change);
      Object.assign(cmd(command)['lot'] as Json, change);
    };
    const notVerifying = (r: MRow): MRow => forge(r, ({ after, e }) => void (steps(after)[String(e['stepKey'])] = { ...steps(after)[String(e['stepKey'])], verificationRequired: false }));
    const outcomes = {
      // The person each block writes.
      attestedBy: await blockProblem(forge(status, ({ data }) => void (data['attestedBy'] = 'OP2'))),
      checkedBy: await blockProblem(forge(clearance, ({ data }) => void (data['checkedBy'] = 'OP2'))),
      recordedBy: await blockProblem(forge(previous, ({ data }) => void (data['recordedBy'] = 'OP2'))),
      transferBy: await blockProblem(forge(received, ({ data }) => void (data['by'] = 'OP1'))),
      attachedBy: await blockProblem(forge(photo, ({ data }) => void (data['attachedBy'] = 'OP2'))),
      // The flags and members a block builds.
      equipmentPassed: await blockProblem(forge(failing, ({ data }) => void (data['passed'] = true))),
      clearancePassed: await blockProblem(forge(clearance, ({ data }) => void (data['passed'] = false))),
      outputStatus: await blockProblem(forge(output, ({ data }) => void (data['status'] = 'RELEASED'))),
      paperOriginal: await blockProblem(forge(paper, ({ data }) => void (data['paperOriginal'] = false))),
      // The whole command a block keeps, and no member of its own beside it.
      disposalDropped: await blockProblem(forge(destroy, ({ data }) => void delete data['batchCoded'])),
      transferDropped: await blockProblem(forge(issued, ({ data }) => void delete data['quantity'])),
      extraMember: await blockProblem(forge(previous, ({ data }) => void (data['batch'] = 'B24-0001'))),
      weighingExtra: await blockProblem(forge(weighing, ({ data }) => void (data['lotNumber'] = 'L2409-0017'))),
      chargeExtra: await blockProblem(forge(charge, ({ data }) => void (data['scannedBatch'] = 'B24-0001'))),
      lotQuantityDropped: await blockProblem(forge(lotCharge, ({ data }) => void delete data['quantity'])),
      // The entry record.
      backdated: await blockProblem(forge(previous, ({ e }) => void (e['recordedAt'] = { $u: String(T0) }))),
      otherId: await blockProblem(forge(previous, ({ e }) => void (e['id'] = 'EN-999'))),
      recordExtra: await blockProblem(forge(previous, ({ e }) => void (e['voided'] = false))),
      otherSeq: await blockProblem(forge(previous, ({ e }) => void (e['recordedSeq'] = 1))),
      // The check an entry asks for.
      manualUnchecked: await blockProblem(notVerifying(manual)),
      paperUnchecked: await blockProblem(notVerifying(paper)),
      clearanceUnchecked: await blockProblem(notVerifying(clearance)),
      // A checklist answers exactly its step's list.
      statusOmitted: await blockProblem(forge(failing, ({ data, command }) => {
        const keep = (a: unknown): boolean => (a as Json)['id'] !== 'DAILY_CHECK';
        data['answers'] = (data['answers'] as unknown[]).filter(keep);
        cmd(command)['answers'] = (cmd(command)['answers'] as unknown[]).filter(keep);
        data['passed'] = true;
      })),
      statusTwice: await blockProblem(forge(status, ({ data, command }) => {
        data['answers'] = [...(data['answers'] as unknown[]), { id: 'CLEAN', answer: 'YES' }];
        cmd(command)['answers'] = [...(cmd(command)['answers'] as unknown[]), { id: 'CLEAN', answer: 'YES' }];
      })),
      clearanceUnknown: await blockProblem(forge(clearance, ({ data, command }) => {
        data['answers'] = [...(data['answers'] as unknown[]), { id: 'EXTRA', answer: 'CONFIRMED' }];
        cmd(command)['answers'] = [...(cmd(command)['answers'] as unknown[]), { id: 'EXTRA', answer: 'CONFIRMED' }];
      })),
      clearanceNotApplicable: await blockProblem(forge(notApplicable, ({ data, command }) => {
        const na = [{ id: 'AREA', answer: 'CONFIRMED' }, { id: 'DOCS', answer: 'NOT_APPLICABLE' }];
        data['answers'] = na;
        cmd(command)['answers'] = na;
      })),
      // A lot is usable.
      lotQuarantine: await blockProblem(forge(weighing, ({ data, command }) => lot(data, command, { status: 'QUARANTINE' }))),
      lotExpired: await blockProblem(forge(manual, ({ data, command }) => lot(data, command, { expiresAtUs: String(T0) }))),
      lotRetest: await blockProblem(forge(lotCharge, ({ data, command }) => lot(data, command, { retestAtUs: '1' }))),
      lotIdentity: await blockProblem(forge(manual, ({ data, command }) => lot(data, command, { identityTested: false }))),
      lotMaterial: await blockProblem(forge(lotCharge, ({ data, command }) => lot(data, command, { material: 'MAT-OTHER' }))),
      // A disposal's rules.
      batchCodedReturned: await blockProblem(forge(ret, ({ data, command }) => {
        data['batchCoded'] = true;
        cmd(command)['batchCoded'] = true;
      })),
      destructionNoMethod: await blockProblem(forge(destroy, ({ data, command }) => {
        delete data['method'];
        delete cmd(command)['method'];
      })),
      rejectNoContainer: await blockProblem(forge(reject, ({ data, command }) => {
        delete data['container'];
        delete cmd(command)['container'];
      })),
      destructionUnwitnessed: await blockProblem(forge(destroy, ({ mbr }) => {
        const p = ((((((mbr['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json)['body'] as Json)['children'] as Json[];
        (p[0] as Json)['signatures'] = { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'VERIFIER' } };
      })),
    };
    const lotOf = (r: MRow): string => String(((added(r)[1]['data'] as Json)['lot'] as Json)['id']);
    expect(outcomes).toEqual({
      attestedBy: `stores ${about(status)} with attestedBy "OP2", where its block writes "OP1"`,
      checkedBy: `stores ${about(clearance)} with checkedBy "OP2", where its block writes "OP1"`,
      recordedBy: `stores ${about(previous)} with recordedBy "OP2", where its block writes "OP1"`,
      transferBy: `stores ${about(received)} with by "OP1", where its block writes "OP2"`,
      attachedBy: `stores ${about(photo)} with attachedBy "OP2", where its block writes "OP1"`,
      equipmentPassed: `stores ${about(failing)} with passed true, where its block writes false`,
      clearancePassed: `stores ${about(clearance)} with passed false, where its block writes true`,
      outputStatus: `stores ${about(output)} with status "RELEASED", where its block writes "QUARANTINE"`,
      paperOriginal: `stores ${about(paper)} with paperOriginal false, where its block writes true`,
      disposalDropped: `stores ${about(destroy)} with batchCoded (no such member), where its block writes true`,
      transferDropped: `stores ${about(issued)} with quantity (no such member), where its block writes {"unit": "kg", "value": "1"}`,
      extraMember: `stores ${about(previous)} with batch "B24-0001", where its block writes (no such member)`,
      weighingExtra: `stores ${about(weighing)} with lotNumber "L2409-0017", where its block writes (no such member)`,
      chargeExtra: `stores ${about(charge)} with scannedBatch "B24-0001", where its block writes (no such member)`,
      lotQuantityDropped: `stores ${about(lotCharge)} with quantity (no such member), where its block writes {"unit": "kg", "value": "1"}`,
      backdated: expect.stringMatching(new RegExp(`^stores ${aboutRe(previous)} recorded at ${String(T0)}, not at the row's trusted time \\d+$`)) as unknown,
      otherId: `stores ${about(previous)} under another id (EN-999)`,
      recordExtra: `stores ${about(previous)} with members the engine does not write (voided)`,
      otherSeq: expect.stringMatching(new RegExp(`^stores ${aboutRe(previous)} with recordedSeq 1, which is not an event of this row \\(after \\d+, up to \\d+\\)$`)) as unknown,
      manualUnchecked: `stores ${about(manual)}, which needs a second person's check of its step, and the step does not require it (PR-14)`,
      paperUnchecked: `stores ${about(paper)}, which needs a second person's check of its step, and the step does not require it (PR-14)`,
      clearanceUnchecked: `stores ${about(clearance)}, which needs a second person's check of its step, and the step does not require it (PR-14)`,
      statusOmitted: `stores ${about(failing)} that does not answer DAILY_CHECK; every item of its step's list is answered (G09-ANSWERS)`,
      statusTwice: `stores ${about(status)} that answers CLEAN more than once (G09-ANSWERS)`,
      clearanceUnknown: `stores ${about(clearance)} that answers EXTRA, which is not on the list of its step (NO_PREVIOUS_MATERIAL, NO_PREVIOUS_DOCUMENTS, EQUIPMENT_CLEAN_LABEL) (G10-ANSWERS)`,
      clearanceNotApplicable: `stores ${about(notApplicable)} that answers DOCS not applicable, which its step's list requires confirmed (G10-NOT-APPLICABLE)`,
      lotQuarantine: `stores ${about(weighing)} whose lot ${lotOf(weighing)} is QUARANTINE; only a released lot is used (G07-LOT-STATUS)`,
      lotExpired: `stores ${about(manual)} whose lot AR-9 is past its expiry date (G07-LOT-EXPIRED)`,
      lotRetest: `stores ${about(lotCharge)} whose lot AR-9 is past its retest date (G07-LOT-RETEST)`,
      lotIdentity: `stores ${about(manual)} whose lot AR-9 has no identity-test result, and the batch is for IN, US (G07-LOT-IDENTITY)`,
      lotMaterial: `stores ${about(lotCharge)} whose lot AR-9 is of material MAT-OTHER, not the item the MBR names (MAT-M) (G07-WRONG-MATERIAL)`,
      batchCodedReturned: `stores ${about(ret)} returning batch-coded Foil to stores; batch-coded leftovers are only destroyed (G23-BATCH-CODED)`,
      destructionNoMethod: `stores ${about(destroy)}, a destruction that names no method (G23-METHOD)`,
      rejectNoContainer: `stores ${about(reject)}, a reject held in no identified container (G23-CONTAINER)`,
      destructionUnwitnessed: `stores ${about(destroy)}, a destruction at a step whose check is not a witness (G23-WITNESS)`,
    });
    for (const r of [status, clearance, previous, weighing, output, charge, lotCharge, manual, paper, photo, issued, received, destroy, reject, ret, failing, notApplicable]) expect(await blockProblem(r), r.label).toBeNull();
  }, 300_000);
});
