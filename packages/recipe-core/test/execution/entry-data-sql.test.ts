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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { BlockVersion } from '../../src/blocks/contract.ts';
import { GENERIC_BLOCK_VERSIONS } from '../../src/blocks/generic/index.ts';
import { DEFAULT_CLEARANCE_CHECKLIST, DEFAULT_STATUS_CHECKS } from '../../src/blocks/generic/status.ts';
import { validateSchema, type FieldSchema } from '../../src/blocks/schema.ts';
import { encode, encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import { DEFAULT_POLICY, type Actor, type Approval, type BatchState, type Command, type CommandType, type DataSource, type DataValue, type EnginePolicy, type IssueRequest, type OccurredAt, type SignatureRef, type SignatureTarget } from '../../src/engine/types.ts';
import type { Frame } from '../../src/flow/tokens.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { fixtureMbr } from '../blocks/support.ts';
import { mbrWith, phase, type FixtureName } from '../flow/support.ts';
import { libraryBlockType, libraryBlockVersion } from '../../src/library/index.ts';
import { SEED_CATALOGUE } from '../../src/library/seed/index.ts';
import { expr } from '../flow/support.ts';
import { autopilot, define, done, testRegistry, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, OP2, PACKAGING_SCENARIO, Run, sig, SUP1, T0 } from '../engine/support.ts';

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

// Rounds 5 and 6: rows of runs made for each block (with the MBR they ran on), and forged copies of them.
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

describe('F12 round 5: an entry holds exactly what its block builds and accepts (DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47)', () => {
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

// ---------------------------------------------------------------------------------------------
// Round 6 (sql 0332): the data schema of the step's block version, as the engine checks it before the block sees an entry.

/** A block schema as recipe.block_data_schema holds it: blocks/schema.ts without descriptions and defaults, a pattern as its source. */
function schemaJson(s: FieldSchema): Json {
  const o: Json = { type: s.type };
  switch (s.type) {
    case 'string':
      if (s.enum) o['enum'] = [...s.enum];
      if (s.pattern) {
        if (s.pattern.flags !== '') throw new Error(`SETUP: pattern ${String(s.pattern)} has flags the database does not read`);
        o['pattern'] = s.pattern.source;
      }
      break;
    case 'decimal':
      if (s.min !== undefined) o['min'] = s.min;
      if (s.minExclusive === true) o['minExclusive'] = true;
      break;
    case 'integer':
      if (s.min !== undefined) o['min'] = s.min;
      if (s.max !== undefined) o['max'] = s.max;
      break;
    case 'object':
      o['fields'] = Object.fromEntries(Object.entries(s.fields).map(([k, f]) => [k, schemaJson(f)]));
      break;
    case 'array':
      o['items'] = schemaJson(s.items);
      if (s.minItems !== undefined) o['minItems'] = s.minItems;
      if (s.maxItems !== undefined) o['maxItems'] = s.maxItems;
      break;
    case 'record':
      o['values'] = schemaJson(s.values);
      break;
    case 'boolean':
      break;
  }
  if (s.optional === true) o['optional'] = true;
  return o;
}

/** recipe.entry_schema_problem of row `r` (a COMMAND row, accepted or refused, as the trigger reads it). */
async function schemaProblem(r: MRow): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.entry_schema_problem($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5) as p', [
    JSON.stringify(r.mbr),
    JSON.stringify(r.before),
    JSON.stringify(r.after),
    JSON.stringify(r.command),
    r.accepted,
  ]);
  return rows[0]?.p ?? null;
}

/** recipe.block_schema_problem of each [schema, value, path], in order. */
async function sqlSchemaProblems(cases: readonly (readonly [Json, unknown, string])[]): Promise<(string | null)[]> {
  const { rows } = await db.admin.query<{ p: (string | null)[] }>(
    "select coalesce(array_agg(recipe.block_schema_problem(x.c -> 0, x.c -> 1, x.c ->> 2) order by x.i), '{}') as p from jsonb_array_elements($1::jsonb) with ordinality x (c, i)",
    [JSON.stringify(cases)],
  );
  return rows[0]?.p ?? [];
}

/** Every row of the engine's own runs that rounds 5 and 6 read: each block's golden fixture, both golden runs, the special runs. */
function engineRows(): [string, MRow][] {
  const all: [string, MRow][] = [];
  for (const b of GENERIC_BLOCK_VERSIONS) if (b.level === 'PHASE' && b.goldenFixture) for (const r of fixtureRows(b)) all.push([`${b.type} ${r.label}`, r]);
  for (const { name, rows } of runs()) {
    const mbr = fixtureDefinition(name as FixtureName).mbr;
    for (const r of rows) all.push([`${name} ${r.label}`, { ...r, mbr }]);
  }
  for (const [n, r] of Object.entries(specialRows())) all.push([n, r]);
  return all;
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Values that break one rule or another of a schema member, set in place of a member's value. */
const PROBES: unknown[] = [null, 0, -1, 1.5, 100001, 9007199254740992, '', 'x', 'NO', 'no', 'true', 'released', '-0', '01', '1.', '1e2', '0', '-0.5', 'lower_id', true, false, [], [{}], {}, { id: 'X' }];

/** `value` (meeting `schema`) and its variants: every probe in its place, and each member, item or value of it varied likewise. */
function variants(schema: FieldSchema, value: unknown, depth = 0): unknown[] {
  const out: unknown[] = [value, ...PROBES];
  if (depth > 2) return out;
  if (schema.type === 'object' && isObject(value)) {
    out.push({ ...value, lotNumber: 'L2409-0017' });
    for (const [k, f] of Object.entries(schema.fields)) {
      const without = { ...value };
      delete without[k];
      out.push(without);
      for (const v of variants(f, value[k], depth + 1)) out.push({ ...value, [k]: v });
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && value.length > 0) {
    const items = value as unknown[];
    out.push([], [...items, ...items], Array.from({ length: (schema.maxItems ?? 1) + 1 }, () => items[0]));
    for (const v of variants(schema.items, items[0], depth + 1)) out.push([v, ...items.slice(1)]);
  }
  if (schema.type === 'record' && isObject(value)) for (const [k, x] of Object.entries(value)) for (const v of variants(schema.values, x, depth + 1)) out.push({ ...value, [k]: v });
  return out;
}

type ForgeArgs = Parameters<Parameters<typeof forge>[1]>[0];
/** Member `m` of the new entry's data and of what its command sent (its entry, or its start data) set to `v`; deleted for undefined. */
const both = (m: string, v: unknown) => ({ data, command, e }: ForgeArgs): void => {
  const sent = (e['kind'] === 'START_DATA' ? command['blockData'] : command['entry']) as Json;
  for (const o of [data, sent]) {
    if (v === undefined) delete o[m];
    else o[m] = v;
  }
};
/** Member `m` of what the row's command sent only. */
const sentOnly = (m: string, v: unknown) => ({ command, e }: ForgeArgs): void => {
  ((e['kind'] === 'START_DATA' ? command['blockData'] : command['entry']) as Json)[m] = v;
};
const stepOfCommand = (r: MRow): string => String((r.command as Json)['step']);
const addsKind = (r: Row, kind: string): boolean => r.accepted && Object.entries(entries(r.after)).some(([k, e]) => !(k in entries(r.before)) && e['kind'] === kind);

describe('F12 round 6: an entry and a step\'s start data meet the data schema of the step\'s block version and are of a kind it records (DI-05, DI-30, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47)', () => {
  let cached: [string, MRow][] | undefined;
  const all = (): [string, MRow][] => (cached ??= engineRows());
  /** The special row named `name`, else the first row of the engine's runs that adds an entry of kind `name`. */
  const row = (name: string): MRow => {
    const r = all().find(([n]) => n === name)?.[1] ?? all().find(([, x]) => addsKind(x, name))?.[1];
    if (!r) throw new Error(`SETUP: no row ${name}`);
    return r;
  };
  const entryRefusal = (r: MRow, block: string, problem: string): string => `records at step ${stepOfCommand(r)} an entry that does not meet the data schema of block ${block}: ${problem} (ENG-ENTRY-SCHEMA)`;

  it('[DI-30][DI-05] the database holds the data schemas of every block version as the block registry declares them, each entry kind and the start data, and nothing can change them', async () => {
    const want: Record<string, Json> = {};
    for (const b of GENERIC_BLOCK_VERSIONS) {
      if (b.dataSchema?.startData) want[`${b.type}@${b.version} START START_DATA`] = schemaJson(b.dataSchema.startData);
      for (const [k, s] of Object.entries(b.dataSchema?.entries ?? {})) {
        expect(k, `${b.type}@${b.version} names an entry kind as the state names start data`).not.toBe('START_DATA');
        want[`${b.type}@${b.version} ENTRY ${k}`] = schemaJson(s);
      }
    }
    const { rows } = await db.admin.query<{ k: string; schema: Json }>("select block_type || '@' || block_version || ' ' || part || ' ' || entry_kind as k, schema from recipe.block_data_schema");
    expect(Object.fromEntries(rows.map((r) => [r.k, r.schema]))).toEqual(want);
    await expect(db.admin.query("update recipe.block_data_schema set schema = '{\"type\": \"object\", \"fields\": {}}' where entry_kind = 'SAMPLE'")).rejects.toThrow(/EBMR-AUDIT-004 recipe\.block_data_schema is insert-only/);
    await expect(db.admin.query("delete from recipe.block_data_schema where entry_kind = 'SAMPLE'")).rejects.toThrow(/EBMR-AUDIT-004/);
  });

  it('[DI-30][DI-05] the database reads a value against a block schema as the engine does: every entry and start data of the engine\'s own runs, every configuration of the blocks\' golden fixtures, and their forged variants get the same verdict, the database naming one of the engine\'s problems', async () => {
    const cases: { schema: FieldSchema; value: unknown; path: string }[] = [];
    const add = (schema: FieldSchema, value: unknown, path: string): void => {
      for (const v of variants(schema, value)) cases.push({ schema, value: JSON.parse(JSON.stringify(v ?? null)) as unknown, path });
    };
    const seen = new Set<string>();
    for (const [, r] of all()) {
      const c = r.command as Json;
      const block = (k: string) => GENERIC_BLOCK_VERSIONS.find((b) => b.dataSchema?.entries[k] !== undefined);
      if (r.accepted && c['type'] === 'RECORD_ENTRY') {
        const { kind, ...payload } = c['entry'] as Json;
        const schema = block(String(kind))?.dataSchema?.entries[String(kind)];
        if (schema && !seen.has(`${String(kind)}`)) {
          seen.add(String(kind));
          add(schema, payload, String(kind));
        }
      }
      if (r.accepted && c['type'] === 'START_STEP' && c['blockData'] !== undefined && !seen.has('START_DATA')) {
        seen.add('START_DATA');
        const schema = GENERIC_BLOCK_VERSIONS.find((b) => b.dataSchema?.startData)?.dataSchema?.startData as FieldSchema;
        add(schema, c['blockData'], 'startData');
      }
    }
    for (const b of GENERIC_BLOCK_VERSIONS) if (b.configSchema && b.goldenFixture) add(b.configSchema, b.goldenFixture.phase.config, `${b.type}.config`);
    // Members no block version of this release uses, read the same way.
    add({ type: 'decimal', min: '0', minExclusive: true, description: 'x' }, '0.5', 'exclusive');
    for (const v of ['0', '0.000', '-0.1', '0.001']) add({ type: 'decimal', min: '0', minExclusive: true, description: 'x' }, v, 'exclusive');
    add({ type: 'integer', min: -5, max: 5, description: 'x' }, -5, 'bounds');
    add({ type: 'record', description: 'x', values: { type: 'integer', min: 1, description: 'x' } }, { a: 1, b: 2 }, 'map');
    expect([...seen].sort()).toEqual([...new Set(GENERIC_BLOCK_VERSIONS.flatMap((b) => [...Object.keys(b.dataSchema?.entries ?? {}), ...(b.dataSchema?.startData ? ['START_DATA'] : [])]))].sort());
    const got = await sqlSchemaProblems(cases.map((c) => [schemaJson(c.schema), c.value, c.path] as const));
    const differ: unknown[] = [];
    const messages = new Set<string>();
    cases.forEach((c, i) => {
      const engine = validateSchema(c.schema, c.value, c.path).map((p) => `${p.path} ${p.message}`);
      const sql = got[i] ?? null;
      if (sql === null ? engine.length > 0 : !engine.includes(sql)) differ.push({ path: c.path, value: c.value, engine, sql });
      if (sql !== null) messages.add(sql.replace(/^\S+ /, '').replace(/\d+/g, 'N').replace(/one of .*/, 'one of'));
    });
    expect(differ).toEqual([]);
    expect(cases.length).toBeGreaterThan(3000);
    // Every rule of the schema language refused something.
    expect([...messages].sort()).toEqual([
      'allows at most N items', 'has an invalid format', 'is not a field of this block (unknown fields are refused)', 'is required',
      'must be a decimal written as text (e.g. "N.N"), never a number', 'must be a list', 'must be a non-empty text', 'must be a whole number',
      'must be an object', 'must be at least N', 'must be at most N', 'must be greater than N', 'must be one of', 'must be true or false', 'needs at least N items',
    ]);
    // A schema of a type the database does not read fails closed.
    expect(await sqlSchemaProblems([[{ type: 'tuple' }, 1, 'x'], [{}, 1, 'y']])).toEqual(['x has a schema of a type the database does not read (tuple)', 'y has a schema of a type the database does not read (none)']);
  }, 300_000);

  it('[DI-05][DI-30][PR-18][PR-23][PR-29][PR-34][PR-40][PR-47] every entry and start data of the engine\'s own runs meets its block\'s schema in the database: every block\'s golden fixture, both golden runs and the runs of the kinds they leave out, every kind among them', async () => {
    const out: Record<string, string> = {};
    const kinds = new Set<string>();
    for (const [label, r] of all()) {
      const p = await schemaProblem(r);
      if (p !== null) out[label] = p;
      for (const [k, e] of Object.entries(entries(r.after))) if (!(k in entries(r.before))) kinds.add(String(e['kind']));
    }
    expect(out).toEqual({});
    const { rows } = await db.admin.query<{ k: string }>('select distinct entry_kind as k from recipe.block_data_schema order by 1');
    expect([...kinds].sort()).toEqual(rows.map((r) => r.k));
  }, 300_000);

  it('[DI-05][DI-30] the round-5 verification\'s weighing whose command and data both carry lotNumber L2409-0017, and a member of its own in the command and the data of every block that keeps or copies the command, or in the command of every other block, passes the earlier checks and is refused', async () => {
    const weighing = row('CONTAINER_WEIGHING');
    const lot = { lotNumber: 'L2409-0017' };
    const copied: [string, string, MRow][] = [
      ['weighing', 'G-07@1', forge(weighing, both('lotNumber', 'L2409-0017'))],
      ['output', 'G-22@1', forge(row('OUTPUT_CONTAINER'), both('lotNumber', 'L2409-0017'))],
      ['disposal', 'G-23@1', forge(row('disposalReject'), both('lotNumber', 'L2409-0017'))],
      ['transferIssued', 'G-15@1', forge(row('transferIssued'), both('lotNumber', 'L2409-0017'))],
      ['transferReceived', 'G-15@1', forge(row('transferReceived'), both('lotNumber', 'L2409-0017'))],
      ['addition', 'G-24@1', forge(row('addition'), both('lotNumber', 'L2409-0017'))],
    ];
    const built: [string, string, MRow][] = [
      ['acknowledge', 'G-03@1', forge(row('ackSop'), sentOnly('lotNumber', 'L2409-0017'))],
      ['attachment', 'G-05@1', forge(row('attachmentPhoto'), sentOnly('lotNumber', 'L2409-0017'))],
      ['chargeLot', 'G-08@1', forge(row('chargeLotQuantity'), sentOnly('lotNumber', 'L2409-0017'))],
      ['chargeContainer', 'G-08@1', forge(row('CHARGE_CONTAINER'), sentOnly('lotNumber', 'L2409-0017'))],
      ['previousBatch', 'G-10@1', forge(row('PREVIOUS_BATCH'), sentOnly('lotNumber', 'L2409-0017'))],
      ['clearance', 'G-10@1', forge(row('CLEARANCE_CHECK'), sentOnly('lotNumber', 'L2409-0017'))],
      ['status', 'G-09@1', forge(row('EQUIPMENT_STATUS'), sentOnly('lotNumber', 'L2409-0017'))],
      ['sample', 'G-12@1', forge(row('sampleSubLot'), sentOnly('lotNumber', 'L2409-0017'))],
    ];
    const start = forge(row('additionStart'), both('lotNumber', 'L2409-0017'));
    const earlier: Record<string, unknown> = {};
    const outcomes: Record<string, string | null> = {};
    const want: Record<string, string> = {};
    for (const [n, block, r] of [...copied, ...built]) {
      earlier[n] = { block: await blockProblem(r), data: await problem(r) };
      outcomes[n] = await schemaProblem(r);
      want[n] = entryRefusal(r, block, `${String(added(r)[1]['kind'])}.lotNumber is not a field of this block (unknown fields are refused)`);
    }
    earlier['start'] = { block: await blockProblem(start), data: await problem(start) };
    outcomes['start'] = await schemaProblem(start);
    want['start'] = `starts step ${stepOfCommand(start)} with start data that does not meet the start-data schema of block G-24@1: startData.lotNumber is not a field of this block (unknown fields are refused) (ENG-ENTRY-SCHEMA)`;
    // 0313 and 0330 let every one of them through: the command and the data agree, and the block keeps what was sent.
    expect(Object.values(earlier).filter((x) => JSON.stringify(x) !== JSON.stringify({ block: null, data: null }))).toEqual([]);
    expect(outcomes).toEqual(want);
    expect((added(copied[0]?.[2] as MRow)[1]['data'] as Json)['lotNumber']).toBe(lot.lotNumber);
    for (const r of [weighing, row('addition'), row('additionStart')]) expect(await schemaProblem(r), r.label).toBeNull();
  }, 300_000);

  it('[PR-34][PR-23][DI-30] a line clearance answered NO and an equipment status answered no, which the earlier checks stored as passed, are refused, and so is an answer with a member of its own', async () => {
    // Checks the engine stored as passed: every answer CONFIRMED or YES.
    const passed = (kind: string): MRow => {
      const r = all().find(([, x]) => addsKind(x, kind) && (added(x)[1]['data'] as Json)['passed'] === true)?.[1];
      if (!r) throw new Error(`SETUP: no passed ${kind}`);
      return r;
    };
    const clearance = passed('CLEARANCE_CHECK');
    const status = passed('EQUIPMENT_STATUS');
    const answer = (i: number, v: string) => ({ data, command }: ForgeArgs): void => {
      for (const list of [data['answers'], (command['entry'] as Json)['answers']] as Json[][]) (list[i] as Json)['answer'] = v;
    };
    const clearanceNo = forge(clearance, answer(0, 'NO'));
    const statusNo = forge(status, answer(1, 'no'));
    const noted = forge(clearance, ({ command }) => void ((((command['entry'] as Json)['answers'] as Json[])[0] as Json)['note'] = 'see logbook'));
    for (const r of [clearanceNo, statusNo]) expect({ block: await blockProblem(r), data: await problem(r) }, r.label).toEqual({ block: null, data: null });
    expect([clearanceNo, statusNo].map((r) => (added(r)[1]['data'] as Json)['passed'])).toEqual([true, true]);
    expect({ clearanceNo: await schemaProblem(clearanceNo), statusNo: await schemaProblem(statusNo), noted: await schemaProblem(noted) }).toEqual({
      clearanceNo: entryRefusal(clearanceNo, 'G-10@1', 'CLEARANCE_CHECK.answers[0].answer must be one of CONFIRMED, NOT_CONFIRMED, NOT_APPLICABLE'),
      statusNo: entryRefusal(statusNo, 'G-09@1', 'EQUIPMENT_STATUS.answers[1].answer must be one of YES, NO'),
      noted: entryRefusal(noted, 'G-10@1', 'CLEARANCE_CHECK.answers[0].note is not a field of this block (unknown fields are refused)'),
    });
  }, 300_000);

  it('[PR-47][DI-30] reprocessing start data that is empty, holds only its authoriser or leaves out a reference, a source addition without manufacturedAtUs or with it as a number, or with containsRecovered or a quantity of another type, and start data at a step whose block takes none, are refused', async () => {
    const start = row('additionStart');
    const addition = row('addition');
    const startWith = (blockData: Json) => ({ data, command }: ForgeArgs): void => {
      for (const k of Object.keys(data)) delete data[k];
      Object.assign(data, blockData);
      command['blockData'] = structuredClone(blockData);
    };
    const forged = {
      startEmpty: forge(start, startWith({})),
      startAuthoriserOnly: forge(start, startWith({ authorisedBy: 'QA1' })),
      startNoRiskEvaluation: forge(start, both('riskEvaluationRef', undefined)),
      additionUndated: forge(addition, both('manufacturedAtUs', undefined)),
      additionDatedNumber: forge(addition, both('manufacturedAtUs', 1)),
      additionRecoveredText: forge(addition, both('containsRecovered', 'true')),
      additionNoQuantity: forge(addition, both('quantity', undefined)),
    };
    const earlier: Record<string, unknown> = {};
    const outcomes: Record<string, string | null> = {};
    for (const [n, r] of Object.entries(forged)) {
      earlier[n] = { block: await blockProblem(r), data: await problem(r) };
      outcomes[n] = await schemaProblem(r);
    }
    expect(Object.entries(earlier).filter(([, x]) => JSON.stringify(x) !== JSON.stringify({ block: null, data: null }))).toEqual([]);
    const startRefusal = (problemText: string): string => `starts step ${stepOfCommand(start)} with start data that does not meet the start-data schema of block G-24@1: ${problemText} (ENG-ENTRY-SCHEMA)`;
    expect(outcomes).toEqual({
      startEmpty: startRefusal('startData.authorisationRef is required'),
      startAuthoriserOnly: startRefusal('startData.authorisationRef is required'),
      startNoRiskEvaluation: startRefusal('startData.riskEvaluationRef is required'),
      additionUndated: entryRefusal(addition, 'G-24@1', 'SOURCE_ADDITION.manufacturedAtUs is required'),
      additionDatedNumber: entryRefusal(addition, 'G-24@1', 'SOURCE_ADDITION.manufacturedAtUs must be a non-empty text'),
      additionRecoveredText: entryRefusal(addition, 'G-24@1', 'SOURCE_ADDITION.containsRecovered must be true or false'),
      additionNoQuantity: entryRefusal(addition, 'G-24@1', 'SOURCE_ADDITION.quantity is required'),
    });
    // Start data at a step whose block takes none (an acknowledgement's), on the row that starts it.
    const ackStart = rowsFor(mbrWith(seqOf('ops', phase('read', { block: G('G-03'), config: { acknowledgement: 'READ' } }))), (run) => void run.start('read'))[0];
    if (!ackStart) throw new Error('SETUP: no start');
    expect(await schemaProblem(ackStart)).toBeNull();
    expect(await schemaProblem({ ...ackStart, command: { ...(ackStart.command as Json), blockData: { investigationRef: 'INV-1' } } })).toBe('starts step read with start data, and its block G-03@1 takes none (ENG-ENTRY-SCHEMA)');
  }, 300_000);

  it('[PR-29][PR-40][PR-18][PR-14][DI-30] a sample of 0, too many or a fraction of units, a disposal of an unknown category with no method or batch-coded as text, a weighed lot dated by a number or identity-tested as text, a weighing keyed by hand as manual, a weight as a number and a paper original as text pass the earlier checks and are refused', async () => {
    const sample = row('sampleSubLot');
    const destroy = row('disposalReject');
    const ret = row('disposalReturn');
    const manual = row('weighingManual');
    const photo = row('attachmentPhoto');
    const lotMember = (m: string, v: unknown) => ({ data, command }: ForgeArgs): void => {
      for (const l of [data['lot'], (command['entry'] as Json)['lot']] as Json[]) l[m] = v;
    };
    const forged: Record<string, [MRow, string]> = {
      sampleNone: [forge(sample, both('units', 0)), 'SAMPLE.units must be at least 1'],
      sampleTooMany: [forge(sample, both('units', 100001)), 'SAMPLE.units must be at most 100000'],
      sampleFraction: [forge(sample, both('units', 1.5)), 'SAMPLE.units must be a whole number'],
      disposalReturn: [forge(destroy, ({ data, command, e }) => {
        both('category', 'RETURN')({ data, command, e } as ForgeArgs);
        both('container', undefined)({ data, command, e } as ForgeArgs);
      }), 'DISPOSAL.category must be one of RETURN_TO_STORES, REJECT_CONTAINER, WASTE, DESTRUCTION'],
      disposalCodedText: [forge(ret, both('batchCoded', 'true')), 'DISPOSAL.batchCoded must be true or false'],
      lotDatedNumber: [forge(manual, lotMember('expiresAtUs', 1)), 'CONTAINER_WEIGHING.lot.expiresAtUs must be a non-empty text'],
      lotIdentityText: [forge(manual, lotMember('identityTested', 'false')), 'CONTAINER_WEIGHING.lot.identityTested must be true or false'],
      weighingSourceLower: [forge(manual, ({ data, command, e, after }) => {
        both('source', 'manual')({ data, command, e, after } as ForgeArgs);
        steps(after)[String(e['stepKey'])] = { ...steps(after)[String(e['stepKey'])], verificationRequired: false };
      }), 'CONTAINER_WEIGHING.source must be one of DEVICE, MANUAL'],
      weighingGrossNumber: [forge(manual, both('gross', 2)), 'CONTAINER_WEIGHING.gross must be a decimal written as text (e.g. "0.5"), never a number'],
      paperText: [forge(photo, sentOnly('paperOriginal', 'true')), 'ATTACHMENT.paperOriginal must be true or false'],
    };
    const earlier: Record<string, unknown> = {};
    const outcomes: Record<string, string | null> = {};
    const want: Record<string, string> = {};
    const blockOf: Record<string, string> = { SAMPLE: 'G-12@1', DISPOSAL: 'G-23@1', CONTAINER_WEIGHING: 'G-07@1', ATTACHMENT: 'G-05@1' };
    for (const [n, [r, why]] of Object.entries(forged)) {
      earlier[n] = await blockProblem(r);
      outcomes[n] = await schemaProblem(r);
      want[n] = entryRefusal(r, blockOf[String(added(r)[1]['kind'])] ?? '?', why);
    }
    // 0330 lets each through (a disposal of an unknown category meets none of G-23's rules; a manual weighing written in lower case needs no check).
    expect(Object.entries(earlier).filter(([, p]) => p !== null)).toEqual([]);
    expect(outcomes).toEqual(want);
  }, 300_000);

  it('[DI-30][DI-05][PR-19] an entry of a kind its step\'s block does not record is refused, whether the row that adds it was accepted or not: a dispensed container renamed CONTAINER_WEIGHING_2, a previous batch at a weighing step, start data recorded as an entry, an entry naming no kind; a stored entry\'s data that breaks its schema is refused although its command meets it; and every kind a block records has its own rules in 0330', async () => {
    const weighing = row('CONTAINER_WEIGHING');
    const kindAs = (kind: string, change: (x: ForgeArgs) => void = () => undefined) => (x: ForgeArgs): void => {
      x.e['kind'] = kind;
      (x.command['entry'] as Json)['kind'] = kind;
      change(x);
    };
    const renamed = forge(weighing, kindAs('CONTAINER_WEIGHING_2'));
    const previousHere = forge(weighing, kindAs('PREVIOUS_BATCH', ({ data, command, e }) => {
      for (const k of Object.keys(data)) delete data[k];
      Object.assign(data, { product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999', recordedBy: e['enteredBy'] });
      command['entry'] = { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' };
    }));
    const startAsEntry = forge(row('addition'), kindAs('START_DATA'));
    const noKind = forge(weighing, ({ command }) => void delete (command['entry'] as Json)['kind']);
    // 0330 checks nothing of a kind it has no rules for.
    expect(await blockProblem(renamed)).toBeNull();
    expect({
      renamed: await schemaProblem(renamed),
      previousHere: await schemaProblem(previousHere),
      startAsEntry: await schemaProblem(startAsEntry),
      noKind: await schemaProblem(noKind),
      renamedRefused: await schemaProblem({ ...renamed, accepted: false, command: { ...(renamed.command as Json), entry: { ...((renamed.command as Json)['entry'] as Json), kind: 'CONTAINER_WEIGHING' } } }),
    }).toEqual({
      renamed: `records an entry of kind CONTAINER_WEIGHING_2 at step ${stepOfCommand(weighing)}, whose block G-07@1 does not record that kind (ENG-ENTRY-KIND)`,
      previousHere: `records an entry of kind PREVIOUS_BATCH at step ${stepOfCommand(weighing)}, whose block G-07@1 does not record that kind (ENG-ENTRY-KIND)`,
      startAsEntry: `records an entry of kind START_DATA at step ${stepOfCommand(row('addition'))}, whose block G-24@1 does not record that kind (ENG-ENTRY-KIND)`,
      noKind: `records at step ${stepOfCommand(weighing)} an entry that names no kind (ENG-ENTRY-KIND)`,
      // A row that is not an accepted command adds no entry the engine would add: its kind is read all the same.
      renamedRefused: `stores ${about(renamed)}, a kind its block G-07@1 does not record (ENG-ENTRY-KIND)`,
    });
    // What the stored entry holds meets the schema too, its command aside.
    const sample = row('sampleSubLot');
    const start = row('additionStart');
    expect({
      sampleUnits: await schemaProblem(forge(sample, ({ data }) => void (data['units'] = 0))),
      sampleData: await schemaProblem(forge(sample, ({ e }) => void (e['data'] = 'x'))),
      startData: await schemaProblem(forge(start, ({ data }) => void delete data['investigationRef'])),
    }).toEqual({
      sampleUnits: `stores ${about(sample)} whose data does not meet the data schema of block G-12@1: SAMPLE.units must be at least 1 (ENG-ENTRY-SCHEMA)`,
      sampleData: `stores ${about(sample)} whose data does not meet the data schema of block G-12@1: SAMPLE must be an object (ENG-ENTRY-SCHEMA)`,
      startData: `stores ${about(start)} whose data does not meet the data schema of block G-24@1: startData.investigationRef is required (ENG-ENTRY-SCHEMA)`,
    });
    // So 0330's branch for a kind it has no rules for is never reached: each kind a block records has its rules there.
    const { rows } = await db.admin.query<{ k: string }>('select entry_kind as k from recipe.block_data_schema order by 1');
    const unbuilt: string[] = [];
    for (const { k } of rows) {
      const r = all().find(([, x]) => addsKind(x, k))?.[1];
      if (!r) throw new Error(`SETUP: no row adds ${k}`);
      if (!/with zzForged "x", where its block writes \(no such member\)$/.test((await blockProblem(forge(r, ({ data }) => void (data['zzForged'] = 'x')))) ?? '')) unbuilt.push(k);
    }
    expect(unbuilt).toEqual([]);
  }, 300_000);
  it('[INV-25][PR-19][DI-30] T2 round 4: a weighing is taken only under the kind its step\'s block records, a dispensed container at a G-07 step and an output container at a G-22 step; renamed, which the weighing checks (0321-0323) and 0330 do not read, each is refused, and the honest ones pass', async () => {
    const weighing = row('CONTAINER_WEIGHING');
    const output = row('OUTPUT_CONTAINER');
    const renamedAs = (kind: string) => (x: { e: Json; command: Json }): void => {
      x.e['kind'] = kind;
      (x.command['entry'] as Json)['kind'] = kind;
    };
    const forged = { weighing2: forge(weighing, renamedAs('CONTAINER_WEIGHING_2')), output2: forge(output, renamedAs('OUTPUT_CONTAINER_2')) };
    // What the weighing checks read of each entry (0323 reads the kinds CONTAINER_WEIGHING and OUTPUT_CONTAINER only;
    // 0321 and 0322 likewise) and 0330's rules: nothing.
    const weighingProblem = async (r: MRow): Promise<string | null> =>
      (await db.admin.query<{ p: string | null }>('select recipe.weighing_item_problem($1::jsonb, $2::jsonb) as p', [JSON.stringify(added(r)[1]), JSON.stringify(r.mbr)])).rows[0]?.p ?? null;
    for (const r of Object.values(forged)) {
      expect(await weighingProblem(r)).toBeNull();
      expect(await blockProblem(r)).toBeNull();
    }
    expect({ weighing2: await schemaProblem(forged.weighing2), output2: await schemaProblem(forged.output2), weighing: await schemaProblem(weighing), output: await schemaProblem(output) }).toEqual({
      weighing2: `records an entry of kind CONTAINER_WEIGHING_2 at step ${stepOfCommand(weighing)}, whose block G-07@1 does not record that kind (ENG-ENTRY-KIND)`,
      output2: `records an entry of kind OUTPUT_CONTAINER_2 at step ${stepOfCommand(output)}, whose block G-22@1 does not record that kind (ENG-ENTRY-KIND)`,
      weighing: null,
      output: null,
    });
    // The kinds the database takes at each block are the registry's: G-07 a dispensed container, G-22 an output container.
    const { rows } = await db.admin.query<{ b: string; k: string[] }>("select block_type as b, array_agg(entry_kind order by entry_kind) as k from recipe.block_data_schema where block_type in ('G-07', 'G-22') group by 1 order by 1");
    expect(rows).toEqual([{ b: 'G-07', k: ['CONTAINER_WEIGHING'] }, { b: 'G-22', k: ['OUTPUT_CONTAINER'] }]);
  }, 300_000);
  it('[DI-05][DI-30] a refused row keeps what was sent, which the engine refused, but never a member no block version declares for its kind of entry or for start data, at any depth', async () => {
    const weighing = row('CONTAINER_WEIGHING');
    const clearance = row('CLEARANCE_CHECK');
    const start = row('additionStart');
    /** Row `r` as a refused row whose command's entry (or start data) is changed by `change`, adding nothing to the state. */
    const refused = (r: MRow, change: (sent: Json, command: Json) => void): MRow => {
      const command = structuredClone(r.command) as Json;
      change(((command['type'] === 'START_STEP' ? command['blockData'] : command['entry']) ?? {}) as Json, command);
      return { ...r, accepted: false, command: command as JsonValue, after: r.before };
    };
    const answers = (sent: Json): Json[] => sent['answers'] as Json[];
    const outcomes = {
      // What the engine refuses (for its schema, or a kind the step's block does not record), as an application that let it through sends it: recorded.
      answeredNo: await schemaProblem(refused(clearance, (sent) => void ((answers(sent)[0] as Json)['answer'] = 'NO'))),
      lowerId: await schemaProblem(refused(clearance, (sent) => void ((answers(sent)[0] as Json)['id'] = 'lower_id'))),
      grossNumber: await schemaProblem(refused(weighing, (sent) => void (sent['gross'] = 2))),
      otherKind: await schemaProblem(refused(weighing, (_sent, command) => void (command['entry'] = { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' }))),
      startNoRefs: await schemaProblem(refused(start, (sent) => void delete sent['investigationRef'])),
      // A member of its own, where a real identifier would sit unread: refused.
      lotNumber: await schemaProblem(refused(weighing, (sent) => void (sent['lotNumber'] = 'L2409-0017'))),
      lotMember: await schemaProblem(refused(weighing, (sent) => void ((sent['lot'] as Json)['lotNumber'] = 'L2409-0017'))),
      answerMember: await schemaProblem(refused(clearance, (sent) => void ((answers(sent)[1] as Json)['lot'] = 'L2409-0017'))),
      startMember: await schemaProblem(refused(start, (sent) => void (sent['lotNumber'] = 'L2409-0017'))),
      otherKindMembers: await schemaProblem(refused(weighing, (sent) => void (sent['kind'] = 'PREVIOUS_BATCH'))),
      unknownKind: await schemaProblem(refused(weighing, (sent) => void (sent['kind'] = 'LOT_NOTE'))),
      noKind: await schemaProblem(refused(weighing, (sent) => void delete sent['kind'])),
      noEntry: await schemaProblem(refused(weighing, (_sent, command) => void (command['entry'] = 'L2409-0017'))),
    };
    const step = (r: MRow): string => stepOfCommand(r);
    expect(outcomes).toEqual({
      answeredNo: null,
      lowerId: null,
      grossNumber: null,
      otherKind: null,
      startNoRefs: null,
      lotNumber: `records at step ${step(weighing)} a refused entry holding a member no block version declares for it: CONTAINER_WEIGHING.lotNumber is not a field of this block (unknown fields are refused) (ENG-ENTRY-SCHEMA)`,
      lotMember: `records at step ${step(weighing)} a refused entry holding a member no block version declares for it: CONTAINER_WEIGHING.lot.lotNumber is not a field of this block (unknown fields are refused) (ENG-ENTRY-SCHEMA)`,
      answerMember: `records at step ${step(clearance)} a refused entry holding a member no block version declares for it: CLEARANCE_CHECK.answers[1].lot is not a field of this block (unknown fields are refused) (ENG-ENTRY-SCHEMA)`,
      startMember: `records at step ${step(start)} refused start data holding a member no block version declares for it: startData.lotNumber is not a field of this block (unknown fields are refused) (ENG-ENTRY-SCHEMA)`,
      otherKindMembers: `records at step ${step(weighing)} a refused entry holding a member no block version declares for it: PREVIOUS_BATCH.balance is not a field of this block (unknown fields are refused) (ENG-ENTRY-SCHEMA)`,
      unknownKind: `records at step ${step(weighing)} a refused entry of kind LOT_NOTE, which no block version records (ENG-ENTRY-KIND)`,
      noKind: `records at step ${step(weighing)} a refused entry that names no kind (ENG-ENTRY-KIND)`,
      noEntry: `records at step ${step(weighing)} a refused entry that names no kind (ENG-ENTRY-KIND)`,
    });
    // The members of a map's values are read too (a configuration's expected answers, here as a schema of its own).
    const map = { type: 'object', fields: { expected: { type: 'record', values: { type: 'object', fields: { answer: { type: 'string' } } } } } };
    const { rows } = await db.admin.query<{ ok: string | null; bad: string | null; scalar: string | null }>(
      "select recipe.block_schema_unknown_member($1::jsonb, '{\"expected\": {\"q1\": {\"answer\": \"YES\"}}}'::jsonb, 'c') as ok, recipe.block_schema_unknown_member($1::jsonb, '{\"expected\": {\"q1\": {\"answer\": \"YES\", \"lot\": \"L2409-0017\"}}}'::jsonb, 'c') as bad, recipe.block_schema_unknown_member($1::jsonb, '{\"expected\": 1}'::jsonb, 'c') as scalar",
      [JSON.stringify(map)],
    );
    expect(rows[0]).toEqual({ ok: null, bad: 'c.expected.q1.lot is not a field of this block (unknown fields are refused)', scalar: null });
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------
// Round 7 (sql 0335; the round-6 verification): the command of every row and the evidence stored with it.

/**
 * The members of type T, listed: leaving one out is a compile error (the second argument becomes required), and so is
 * naming one T does not have. So the lists below are the engine's types, and the test compares the database's with them.
 */
const membersOf =
  <T,>() =>
  <const L extends readonly (keyof T & string)[]>(list: L, ...exact: [Exclude<keyof T, L[number]>] extends [never] ? [] : [missing: Exclude<keyof T, L[number]>]): L => {
    void exact;
    return list;
  };
type Of<K extends CommandType> = Extract<Command, { type: K }>;
const BASE = ['type', 'commandId', 'actor', 'expectedVersion'] as const;
const COMMAND_MEMBERS = {
  START_STEP: membersOf<Of<'START_STEP'>>()([...BASE, 'step', 'context', 'occurredAt', 'blockData']),
  RECORD_DATA: membersOf<Of<'RECORD_DATA'>>()([...BASE, 'step', 'context', 'item', 'value', 'source', 'occurredAt', 'reason']),
  RECORD_ENTRY: membersOf<Of<'RECORD_ENTRY'>>()([...BASE, 'step', 'context', 'entry', 'occurredAt']),
  SIGN_PERFORMED: membersOf<Of<'SIGN_PERFORMED'>>()([...BASE, 'step', 'context', 'signature', 'occurredAt']),
  VERIFY: membersOf<Of<'VERIFY'>>()([...BASE, 'step', 'context', 'signature']),
  CHOOSE_ALTERNATIVE: membersOf<Of<'CHOOSE_ALTERNATIVE'>>()([...BASE, 'construct', 'context', 'branch', 'reason']),
  CHOOSE_REPLICATE_COUNT: membersOf<Of<'CHOOSE_REPLICATE_COUNT'>>()([...BASE, 'construct', 'context', 'count', 'reason']),
  COMPLETE_LOOP_ITERATION: membersOf<Of<'COMPLETE_LOOP_ITERATION'>>()([...BASE, 'construct', 'context']),
  REQUEST_SKIP: membersOf<Of<'REQUEST_SKIP'>>()([...BASE, 'step', 'context', 'reason', 'approval']),
  DISPOSITION_HOLD_POINT: membersOf<Of<'DISPOSITION_HOLD_POINT'>>()([...BASE, 'step', 'context', 'disposition', 'signature', 'comment']),
  SIGN_OFF_STAGE: membersOf<Of<'SIGN_OFF_STAGE'>>()([...BASE, 'stage', 'context', 'signature']),
  RAISE_EXCEPTION: membersOf<Of<'RAISE_EXCEPTION'>>()([...BASE, 'step', 'context', 'description', 'severity']),
  ATTACH_DEVIATION: membersOf<Of<'ATTACH_DEVIATION'>>()([...BASE, 'exception', 'deviationRef']),
  DISPOSITION_EXCEPTION: membersOf<Of<'DISPOSITION_EXCEPTION'>>()([...BASE, 'exception', 'outcome', 'justification', 'signature']),
  HOLD_BATCH: membersOf<Of<'HOLD_BATCH'>>()([...BASE, 'holdType', 'reason']),
  RELEASE_HOLD: membersOf<Of<'RELEASE_HOLD'>>()([...BASE, 'hold', 'reason']),
  CORRECT_ENTRY: membersOf<Of<'CORRECT_ENTRY'>>()([...BASE, 'point', 'value', 'reason', 'signature', 'evidence', 'approval']),
  VOID_ATTEMPT: membersOf<Of<'VOID_ATTEMPT'>>()([...BASE, 'step', 'context', 'item', 'reason', 'point', 'approval']),
  INVALIDATE_RESULT: membersOf<Of<'INVALIDATE_RESULT'>>()([...BASE, 'point', 'investigationRef', 'assignableCause', 'reason', 'approval']),
  ABORT_BATCH: membersOf<Of<'ABORT_BATCH'>>()([...BASE, 'reason', 'checklist', 'approvals']),
  CANCEL_BATCH: membersOf<Of<'CANCEL_BATCH'>>()([...BASE, 'reason', 'signature']),
  HAND_OVER_STEP: membersOf<Of<'HAND_OVER_STEP'>>()([...BASE, 'step', 'context', 'outgoing', 'incoming', 'reason', 'signature', 'approval']),
  TAKE_OVER_STEP: membersOf<Of<'TAKE_OVER_STEP'>>()([...BASE, 'step', 'context']),
} satisfies Record<CommandType, readonly string[]>;
const VALUE_MEMBERS = {
  DECIMAL: membersOf<Extract<DataValue, { kind: 'DECIMAL' }>>()(['kind', 'value', 'unit']),
  COUNT: membersOf<Extract<DataValue, { kind: 'COUNT' }>>()(['kind', 'value']),
  BOOLEAN: membersOf<Extract<DataValue, { kind: 'BOOLEAN' }>>()(['kind', 'value']),
  CATEGORY: membersOf<Extract<DataValue, { kind: 'CATEGORY' }>>()(['kind', 'value']),
  TEXT: membersOf<Extract<DataValue, { kind: 'TEXT' }>>()(['kind', 'value']),
  INSTANT: membersOf<Extract<DataValue, { kind: 'INSTANT' }>>()(['kind', 'us']),
  SERIES: membersOf<Extract<DataValue, { kind: 'SERIES' }>>()(['kind', 'values', 'unit']),
} satisfies Record<DataValue['kind'], readonly string[]>;
const SOURCE_MEMBERS = {
  MANUAL: membersOf<Extract<DataSource, { mode: 'MANUAL' }>>()(['mode', 'evidence']),
  DEVICE: membersOf<Extract<DataSource, { mode: 'DEVICE' }>>()(['mode', 'device', 'raw']),
  SCAN: membersOf<Extract<DataSource, { mode: 'SCAN' }>>()(['mode', 'code']),
  AUTOMATION: membersOf<Extract<DataSource, { mode: 'AUTOMATION' }>>()(['mode', 'system', 'tag']),
  LIMS: membersOf<Extract<DataSource, { mode: 'LIMS' }>>()(['mode', 'resultRef']),
  BLOCK: membersOf<Extract<DataSource, { mode: 'BLOCK' }>>()(['mode', 'entries']),
} satisfies Record<DataSource['mode'], readonly string[]>;
const NESTED_MEMBERS = {
  actor: membersOf<Actor>()(['id', 'kind', 'roles']),
  frame: membersOf<Frame>()(['construct', 'index']),
  occurredAt: membersOf<OccurredAt>()(['us', 'trust']),
  signature: membersOf<SignatureRef>()(['id', 'meaning', 'signer']),
  approval: membersOf<Approval>()(['approver', 'signature']),
  correctionEvidence: membersOf<NonNullable<Of<'CORRECT_ENTRY'>['evidence']>>()(['kind', 'sha256']),
  manualEvidence: membersOf<NonNullable<Extract<DataSource, { mode: 'MANUAL' }>['evidence']>>()(['kind', 'sha256']),
  prepareTarget: membersOf<SignatureTarget>()(['type', 'step', 'context']),
  issueRequest: membersOf<IssueRequest>()(['batchId', 'batchNumber', 'batchSize', 'marketSet', 'purpose', 'variants', 'inputs', 'issuedBy', 'issueSignature']),
  issueInput: membersOf<IssueRequest['inputs'][string]>()(['value', 'source']),
  policy: membersOf<EnginePolicy>()(['oneVerifierMode', 'voidNeedsQaApproval', 'criticalCorrectionNeedsApproval', 'qaRoles', 'supervisorRoles', 'productionHeadRoles', 'replicateCountRoles', 'fallbackVerifierRoles', 'witnessWindowUs']),
};

/** recipe.command_member_problem of each [row kind, command, refused], read against the shape of its kind and type, in order. */
async function shapeProblems(cases: readonly (readonly [string, unknown, boolean])[]): Promise<(string | null)[]> {
  const { rows } = await db.admin.query<{ p: (string | null)[] }>(
    "select coalesce(array_agg(recipe.command_member_problem(recipe.command_shape(x.c ->> 0, x.c -> 1 ->> 'type'), x.c -> 1, 'command', (x.c ->> 2)::boolean) order by x.i), '{}') as p from jsonb_array_elements($1::jsonb) with ordinality x (c, i)",
    [JSON.stringify(cases)],
  );
  return rows[0]?.p ?? [];
}

/** recipe.execution_row_problem of a row of a sandbox batch of package PKG in room DISP-1. */
async function rowProblem(kind: string, commandId: string, command: unknown, accepted: boolean, evidence: unknown = {}): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>("select recipe.execution_row_problem($1, $2, $3::jsonb, $4, $5::jsonb, 'DISP-1', $6, 'SANDBOX') as p", [
    kind,
    commandId,
    JSON.stringify(command),
    accepted,
    JSON.stringify(evidence),
    PKG,
  ]);
  return rows[0]?.p ?? null;
}

const PKG = 'a'.repeat(64);
const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fields = (shape: unknown): Json => ((shape as Json)['fields'] ?? {}) as Json;
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/** Every place of `v` outside an entry and start data, as a path of members and indices, with its value. */
function places(v: unknown, path: (string | number)[] = []): { path: (string | number)[]; value: unknown }[] {
  const out = [{ path, value: v }];
  if (Array.isArray(v)) v.forEach((x, i) => out.push(...places(x, [...path, i])));
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) if (!(path.length === 0 && (k === 'entry' || k === 'blockData'))) out.push(...places(x, [...path, k]));
  return out;
}
/** `v` with the value at `path` replaced by `f` of it. */
function at(v: unknown, path: readonly (string | number)[], f: (x: unknown) => unknown): unknown {
  if (path.length === 0) return f(v);
  const [head, ...rest] = path;
  if (Array.isArray(v)) return (v as unknown[]).map((x, i) => (i === head ? at(x, rest, f) : x));
  return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, k === head ? at(x, rest, f) : x]));
}

/** One command of every engine type, every optional member given, typed by the engine's own Command type. */
const TYPED_COMMANDS: Command[] = (() => {
  const actor: Actor = { id: 'P-1', kind: 'PERSON', roles: ['PRODUCTION_OPERATOR'] };
  const approver: Actor = { id: 'P-2', kind: 'PERSON', roles: ['QA'] };
  const signature: SignatureRef = { id: 'S-1', meaning: 'PERFORMED', signer: actor.id };
  const approval: Approval = { approver, signature: { id: 'S-2', meaning: 'CORRECTION_APPROVED', signer: approver.id } };
  const context: Frame[] = [{ construct: 'loop', index: 1 }];
  const occurredAt: OccurredAt = { us: 1_800_000_000_000_000n, trust: 'DEVICE_SYNCED' };
  const b = { commandId: 'C-1', actor, expectedVersion: 3 };
  const values: DataValue[] = [
    { kind: 'DECIMAL', value: '1.5', unit: 'kg' },
    { kind: 'COUNT', value: '3' },
    { kind: 'BOOLEAN', value: true },
    { kind: 'CATEGORY', value: 'A' },
    { kind: 'TEXT', value: '' },
    { kind: 'INSTANT', us: 1_800_000_000_000_000n },
    { kind: 'SERIES', values: ['1.0', '1.1'], unit: 'g' },
  ];
  const sources: DataSource[] = [
    { mode: 'MANUAL', evidence: { kind: 'PRINTOUT', sha256: 'c'.repeat(64) } },
    { mode: 'DEVICE', device: 'TEST-BAL-01', raw: 'ST,GS 1.5 kg' },
    { mode: 'SCAN', code: 'TEST-PUNCH-01' },
    { mode: 'AUTOMATION', system: 'SCADA', tag: 'T-1' },
    { mode: 'LIMS', resultRef: 'R-1' },
    { mode: 'BLOCK', entries: ['EN-1'] },
  ];
  return [
    { ...b, type: 'START_STEP', step: 's', context, occurredAt, blockData: { investigationRef: 'I', riskEvaluationRef: 'R', authorisationRef: 'A', authorisedBy: 'P-2' } },
    ...values.map((value, i): Command => ({ ...b, type: 'RECORD_DATA', step: 's', context, item: 'x', value, source: sources[i % sources.length] ?? { mode: 'MANUAL' }, occurredAt, reason: 'late' })),
    { ...b, type: 'RECORD_ENTRY', step: 's', context, entry: { kind: 'PREVIOUS_BATCH', product: 'P', batchNumber: 'TEST-B26-0001' }, occurredAt },
    { ...b, type: 'SIGN_PERFORMED', step: 's', context, signature, occurredAt },
    { ...b, type: 'VERIFY', step: 's', context, signature },
    { ...b, type: 'CHOOSE_ALTERNATIVE', construct: 'alt', context, branch: 'b', reason: 'r' },
    { ...b, type: 'CHOOSE_REPLICATE_COUNT', construct: 'rep', context, count: 2, reason: 'r' },
    { ...b, type: 'COMPLETE_LOOP_ITERATION', construct: 'loop', context },
    { ...b, type: 'REQUEST_SKIP', step: 's', context, reason: 'r', approval },
    { ...b, type: 'DISPOSITION_HOLD_POINT', step: 'h', context, disposition: 'APPROVED', signature, comment: 'c' },
    { ...b, type: 'SIGN_OFF_STAGE', stage: 'S', context, signature },
    { ...b, type: 'RAISE_EXCEPTION', step: 's', context, description: 'd', severity: 'ALERT' },
    { ...b, type: 'ATTACH_DEVIATION', exception: 'EX-1', deviationRef: 'TEST-DEV-1' },
    { ...b, type: 'DISPOSITION_EXCEPTION', exception: 'EX-1', outcome: 'NO_IMPACT', justification: 'j', signature },
    { ...b, type: 'HOLD_BATCH', holdType: 'QA', reason: 'r' },
    { ...b, type: 'RELEASE_HOLD', hold: 'H-1', reason: 'r' },
    { ...b, type: 'CORRECT_ENTRY', point: 'DP-1', value: { kind: 'DECIMAL', value: '2', unit: 'kg' }, reason: 'r', signature, evidence: { kind: 'DEVICE_RAW', sha256: 'd'.repeat(64) }, approval },
    { ...b, type: 'VOID_ATTEMPT', step: 's', context, item: 'x', reason: 'r', point: 'DP-1', approval },
    { ...b, type: 'INVALIDATE_RESULT', point: 'DP-1', investigationRef: 'INV-1', assignableCause: 'The investigation found an assignable cause', reason: 'r', approval },
    { ...b, type: 'ABORT_BATCH', reason: 'r', checklist: { outputsHeld: true, equipmentSetDirty: true, materialsSecured: true }, approvals: [approval, approval] },
    { ...b, type: 'CANCEL_BATCH', reason: 'r', signature },
    { ...b, type: 'HAND_OVER_STEP', step: 's', context, outgoing: 'p1', incoming: actor, reason: 'r', signature, approval },
    { ...b, type: 'TAKE_OVER_STEP', step: 's', context },
  ];
})();

describe('F12 round 7: a row records the engine command of its type with exactly its members, each of its JSON type, and the evidence the server records (DI-05, DI-30)', () => {
  let cached: [string, MRow][] | undefined;
  const all = (): [string, MRow][] => (cached ??= engineRows());
  const firstOf = (type: string): MRow => {
    const r = all().find(([, x]) => (x.command as Json)['type'] === type)?.[1];
    if (!r) throw new Error(`SETUP: no ${type} command`);
    return r;
  };
  const entryRow = (kind: string): MRow => {
    const r = all().find(([, x]) => (x.command as Json)['type'] === 'RECORD_ENTRY' && ((x.command as Json)['entry'] as Json)['kind'] === kind)?.[1];
    if (!r) throw new Error(`SETUP: no ${kind} entry`);
    return r;
  };

  it('[DI-05][DI-30] the database holds the members of every engine command type, of its actor, frames, times, signatures, approvals, values and sources, of a preparation\'s target and of an issue request as the engine\'s TypeScript types declare them (a compile-time list), and nothing else', async () => {
    const shape = async (kind: string, type: string | null): Promise<Json> => {
      const { rows } = await db.admin.query<{ s: Json | null }>('select recipe.command_shape($1, $2) as s', [kind, type]);
      return rows[0]?.s ?? {};
    };
    const got: Record<string, string[]> = {};
    const want: Record<string, string[]> = {};
    for (const [type, members] of Object.entries(COMMAND_MEMBERS)) {
      want[type] = sorted(members);
      got[type] = sorted(Object.keys(fields(await shape('COMMAND', type))));
    }
    const data = fields(await shape('COMMAND', 'RECORD_DATA'));
    const corr = fields(await shape('COMMAND', 'CORRECT_ENTRY'));
    const variants = (u: unknown): Json => ((u as Json)['variants'] ?? {}) as Json;
    for (const [k, members] of Object.entries(VALUE_MEMBERS)) [want[`value ${k}`], got[`value ${k}`]] = [sorted(members), sorted(Object.keys(fields(variants(data['value'])[k])))];
    for (const [k, members] of Object.entries(SOURCE_MEMBERS)) [want[`source ${k}`], got[`source ${k}`]] = [sorted(members), sorted(Object.keys(fields(variants(data['source'])[k])))];
    const prepare = fields(await shape('PREPARE', null));
    const issue = fields(await shape('ISSUE', null));
    const request = fields(issue['request']);
    const nested: Record<keyof typeof NESTED_MEMBERS, unknown> = {
      actor: data['actor'],
      frame: (data['context'] as Json)['items'],
      occurredAt: data['occurredAt'],
      signature: corr['signature'],
      approval: corr['approval'],
      correctionEvidence: corr['evidence'],
      manualEvidence: fields(variants(data['source'])['MANUAL'])['evidence'],
      prepareTarget: prepare['target'],
      issueRequest: issue['request'],
      issueInput: (request['inputs'] as Json)['values'],
      policy: null,
    };
    for (const [k, members] of Object.entries(NESTED_MEMBERS)) if (k !== 'policy') [want[k], got[k]] = [sorted(members), sorted(Object.keys(fields(nested[k as keyof typeof NESTED_MEMBERS])))];
    expect(got).toEqual(want);
    // A preparation targets an engine command type; a sweep is its type alone; an issue holds the request.
    expect(sorted(((fields(prepare['target'])['type'] as Json)['enum'] as string[]) ?? [])).toEqual(sorted(Object.keys(COMMAND_MEMBERS)));
    expect(sorted(Object.keys(prepare))).toEqual(['actor', 'meaning', 'target', 'type']);
    expect(Object.keys(fields(await shape('SWEEP', null)))).toEqual(['type']);
    expect(sorted(Object.keys(issue))).toEqual(['request', 'type']);
    // The pinned policy: exactly EnginePolicy's members, each of them required.
    const policy = encode(DEFAULT_POLICY) as Json;
    const { rows } = await db.admin.query<{ p: (string | null)[] }>(
      "select coalesce(array_agg(recipe.engine_policy_problem(x.v) order by x.i), '{}') as p from jsonb_array_elements($1::jsonb) with ordinality x (v, i)",
      [JSON.stringify([policy, ...NESTED_MEMBERS.policy.map((m) => Object.fromEntries(Object.entries(policy).filter(([k]) => k !== m)))])],
    );
    expect(rows[0]?.p).toEqual([null, ...NESTED_MEMBERS.policy.map((m) => `policy.${m} is missing`)]);
  }, 120_000);

  it('[DI-05][DI-30] every command of the engine\'s own runs (every block\'s golden fixture, both golden runs, the special runs) has the members and JSON types of its type in the database, as accepted and as a refused row', async () => {
    const cases: [string, unknown, boolean][] = [];
    const labels: string[] = [];
    for (const [label, r] of all()) {
      for (const refused of [!r.accepted, true]) {
        cases.push(['COMMAND', r.command, refused]);
        labels.push(`${label}${refused ? ' (refused)' : ''}`);
      }
    }
    const problems = await shapeProblems(cases);
    const out: Record<string, string> = {};
    problems.forEach((p, i) => {
      if (p !== null) out[labels[i] ?? '?'] = p;
    });
    expect(out).toEqual({});
    expect(sorted(new Set(all().map(([, r]) => String((r.command as Json)['type']))))).toEqual(
      sorted(['CHOOSE_ALTERNATIVE', 'CHOOSE_REPLICATE_COUNT', 'COMPLETE_LOOP_ITERATION', 'DISPOSITION_HOLD_POINT', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_OFF_STAGE', 'SIGN_PERFORMED', 'START_STEP', 'VERIFY']),
    );
    // Every engine command type with every optional member, as the TypeScript types build them (the runs leave some out).
    const typed = TYPED_COMMANDS.map((c) => encodeCommand(c));
    expect(sorted(new Set(TYPED_COMMANDS.map((c) => c.type)))).toEqual(sorted(Object.keys(COMMAND_MEMBERS)));
    expect(await shapeProblems(typed.flatMap((c) => [['COMMAND', c, false] as const, ['COMMAND', c, true] as const]))).toEqual(typed.flatMap(() => [null, null]));
  }, 300_000);

  it('[DI-05][DI-30] a member of its own anywhere in a command of the engine\'s own runs (at its top, in its actor, frames, times, signatures, values and sources), and any member given another JSON type, is refused, accepted or refused; the round-6 verification\'s probes A, D, E and F among them', async () => {
    const types = sorted(new Set(all().map(([, r]) => String((r.command as Json)['type']))));
    const cases: [string, unknown, boolean][] = [];
    const labels: string[] = [];
    for (const type of types) {
      const command = firstOf(type).command;
      for (const { path, value } of places(command)) {
        for (const refused of [false, true]) {
          if (isObject(value)) {
            cases.push(['COMMAND', at(command, path, (x) => ({ ...(x as Json), lotNumber: 'L2409-0017' })), refused]);
            labels.push(`${type} ${['command', ...path].join('.')} + lotNumber${refused ? ' (refused)' : ''}`);
          }
          cases.push(['COMMAND', at(command, path, (x) => (Array.isArray(x) ? { lotNumber: 'L2409-0017' } : ['L2409-0017'])), refused]);
          labels.push(`${type} ${['command', ...path].join('.')} retyped${refused ? ' (refused)' : ''}`);
        }
      }
    }
    const problems = await shapeProblems(cases);
    const passed = labels.filter((_, i) => problems[i] === null);
    expect(passed).toEqual([]);
    expect(cases.length).toBeGreaterThan(200);
    // The verification's probes, with the database's words.
    const clearance = entryRow('CLEARANCE_CHECK').command as Json;
    const start = firstOf('START_STEP').command as Json;
    const probes = await shapeProblems([
      ['COMMAND', { ...clearance, lotNumber: 'L2409-0017' }, false],
      ['COMMAND', { ...start, entry: { kind: 'CONTAINER_WEIGHING', lotNumber: 'L2409-0017' } }, false],
      ['COMMAND', { ...clearance, lotNumber: 'L2409-0017' }, true],
      ['COMMAND', { ...clearance, entry: { ...(clearance['entry'] as Json), answers: 'L2409-0017' } }, true],
      ['COMMAND', { ...clearance, entry: { ...(clearance['entry'] as Json), answers: [['L2409-0017']] } }, true],
      ['COMMAND', { ...clearance, blockData: { lotNumber: 'L2409-0017' } }, true],
      ['COMMAND', { ...start, blockData: 'L2409-0017' }, true],
      ['COMMAND', { ...start, blockData: ['L2409-0017'] }, true],
      ['COMMAND', { ...start, entry: { kind: 'CLEARANCE_CHECK', lotNumber: 'L2409-0017' } }, true],
    ]);
    expect(probes).toEqual([
      'command.lotNumber is a member a RECORD_ENTRY command does not declare',
      'command.entry is a member a START_STEP command does not declare',
      'command.lotNumber is a member a RECORD_ENTRY command does not declare',
      'command.entry.answers must be a list',
      'command.entry.answers[0] must be an object',
      'command.blockData is a member a RECORD_ENTRY command does not declare',
      'command.blockData must be an object',
      'command.blockData must be an object',
      'command.entry is a member a START_STEP command does not declare',
    ]);
  }, 300_000);

  it('[DI-05][DI-30] a refused row\'s entry and start data have the JSON type their block declares wherever it declares an object, a list or a map, and a single value wherever it declares one, so 0332\'s walk reaches every leaf; a single value of another kind is recorded as sent; on an accepted row 0332 holds them to the whole schema', async () => {
    const weighing = entryRow('CONTAINER_WEIGHING');
    const clearance = entryRow('CLEARANCE_CHECK');
    const disposal = all().find(([n]) => n === 'disposal')?.[1] ?? entryRow('DISPOSAL');
    const start = all().find(([n]) => n === 'additionStart')?.[1];
    if (!start) throw new Error('SETUP: no additionStart');
    const sent = (r: MRow, change: (e: Json) => void): Json => {
      const command = structuredClone(r.command) as Json;
      change((command['type'] === 'START_STEP' ? command['blockData'] : command['entry']) as Json);
      return command;
    };
    const answers = (e: Json): Json[] => e['answers'] as Json[];
    const forged: Record<string, [Json, string | null]> = {
      lotText: [sent(weighing, (e) => void (e['lot'] = 'L2409-0017')), 'command.entry.lot must be an object'],
      grossObject: [sent(weighing, (e) => void (e['gross'] = { lot: 'L2409-0017' })), 'command.entry.gross must be a single value (a text, a number, true or false), not an object'],
      idList: [sent(clearance, (e) => void ((answers(e)[0] as Json)['id'] = ['L2409-0017'])), 'command.entry.answers[0].id must be a single value (a text, a number, true or false), not a list'],
      answersText: [sent(clearance, (e) => void (e['answers'] = 'L2409-0017')), 'command.entry.answers must be a list'],
      answerItemText: [sent(clearance, (e) => void (answers(e)[1] = 'L2409-0017' as unknown as Json)), 'command.entry.answers[1] must be an object'],
      quantityList: [sent(disposal, (e) => void (e['quantity'] = ['L2409-0017'])), 'command.entry.quantity must be an object'],
      startRefList: [sent(start, (e) => void (e['investigationRef'] = ['L2409-0017'])), 'command.blockData.investigationRef must be a single value (a text, a number, true or false), not a list'],
      // What the engine refuses for a single value, as sent: recorded.
      grossNumber: [sent(weighing, (e) => void (e['gross'] = 2)), null],
      answeredNo: [sent(clearance, (e) => void ((answers(e)[0] as Json)['answer'] = 'NO')), null],
      lowerId: [sent(clearance, (e) => void ((answers(e)[0] as Json)['id'] = 'lower_id')), null],
      startNoRefs: [sent(start, (e) => void delete e['investigationRef']), null],
    };
    const names = Object.keys(forged);
    const refused = await shapeProblems(names.map((n) => ['COMMAND', forged[n]?.[0], true] as const));
    expect(Object.fromEntries(names.map((n, i) => [n, refused[i]]))).toEqual(Object.fromEntries(names.map((n) => [n, forged[n]?.[1]])));
    // On an accepted row this check reads only that they are objects; 0332 refuses the same entries there in full.
    const accepted = await shapeProblems(names.map((n) => ['COMMAND', forged[n]?.[0], false] as const));
    expect(accepted.every((p) => p === null)).toBe(true);
    for (const n of ['lotText', 'answersText', 'grossNumber', 'answeredNo']) {
      const r = n.startsWith('lot') || n.startsWith('gross') ? weighing : clearance;
      expect(await schemaProblem({ ...r, command: forged[n]?.[0] as JsonValue, accepted: true }), n).not.toBeNull();
    }
  }, 300_000);

  it('[DI-05][DI-30] a preparation, a sweep and an issue record exactly their members: a member of its own in a preparation or its target, besides a sweep\'s type, in an issue request, an input of its header or its issuer, and the request\'s members of another type, are refused', async () => {
    const actor = { id: UUID(1), kind: 'PERSON', roles: ['PRODUCTION_OPERATOR'] };
    const prepare = { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: 'p', context: [] }, actor, meaning: 'PERFORMED' };
    const request = encode({ batchId: UUID(2), batchNumber: 'TEST-B26-0001', batchSize: 'BS-1', marketSet: ['IN'], purpose: 'VALIDATION', variants: {}, inputs: { n: { value: { kind: 'COUNT', value: '100000' }, source: 'Batch header, entered at issue by TEST-ISSUER' } }, issuedBy: actor }) as Json;
    const issue = { type: 'ISSUE', request };
    const cases: Record<string, [string, unknown, string | null]> = {
      prepare: ['PREPARE', prepare, null],
      prepareNoMeaning: ['PREPARE', { type: 'PREPARE', target: { type: 'VERIFY' }, actor }, null],
      prepareMember: ['PREPARE', { ...prepare, lotNumber: 'L2409-0017' }, 'command.lotNumber is a member a preparation for a signature does not declare'],
      prepareTarget: ['PREPARE', { ...prepare, target: { ...prepare.target, lot: 'L2409-0017' } }, 'command.target.lot is a member command.target does not declare'],
      prepareTargetType: ['PREPARE', { ...prepare, target: { type: 'L2409-0017' } }, `command.target.type must be one of ${Object.keys(COMMAND_MEMBERS).join(', ')}`],
      sweep: ['SWEEP', { type: 'SWEEP' }, null],
      sweepMember: ['SWEEP', { type: 'SWEEP', lotNumber: 'L2409-0017' }, 'command.lotNumber is a member a sweep does not declare'],
      issue: ['ISSUE', issue, null],
      requestMember: ['ISSUE', { ...issue, request: { ...request, lotNumber: 'L2409-0017' } }, 'command.request.lotNumber is a member an issue request does not declare'],
      inputMember: ['ISSUE', { ...issue, request: { ...request, inputs: { n: { value: { kind: 'COUNT', value: '1' }, source: 's', lot: 'L2409-0017' } } } }, 'command.request.inputs.n.lot is a member command.request.inputs.n does not declare'],
      issuerMember: ['ISSUE', { ...issue, request: { ...request, issuedBy: { ...actor, lot: 'L2409-0017' } } }, 'command.request.issuedBy.lot is a member command.request.issuedBy does not declare'],
      marketsText: ['ISSUE', { ...issue, request: { ...request, marketSet: 'L2409-0017' } }, 'command.request.marketSet must be a list'],
      variantList: ['ISSUE', { ...issue, request: { ...request, variants: { v: ['L2409-0017'] } } }, 'command.request.variants.v must be a text'],
      issueMember: ['ISSUE', { ...issue, lotNumber: 'L2409-0017' }, 'command.lotNumber is a member an issue does not declare'],
    };
    const names = Object.keys(cases);
    const got = await shapeProblems(names.map((n) => [cases[n]?.[0] ?? '', cases[n]?.[1], false] as const));
    expect(Object.fromEntries(names.map((n, i) => [n, got[i]]))).toEqual(Object.fromEntries(names.map((n) => [n, cases[n]?.[2]])));
    // The pinned policy: a member of its own, a role that is no engine role, a window that is no microsecond count.
    const policy = encode(DEFAULT_POLICY) as Json;
    const { rows } = await db.admin.query<{ p: (string | null)[] }>(
      "select coalesce(array_agg(recipe.engine_policy_problem(x.v) order by x.i), '{}') as p from jsonb_array_elements($1::jsonb) with ordinality x (v, i)",
      [JSON.stringify([policy, { ...policy, lotNumber: 'L2409-0017' }, { ...policy, qaRoles: ['QA', 'L2409-0017'] }, { ...policy, witnessWindowUs: 300000000 }, { ...policy, witnessWindowUs: { $u: '300000000', lot: 'L2409-0017' } }])],
    );
    expect(rows[0]?.p).toEqual([
      null,
      'policy.lotNumber is a member the engine policy does not declare',
      'policy.qaRoles[1] "L2409-0017" is not an engine role',
      'policy.witnessWindowUs must be a microsecond count ({"$u": "<digits>"})',
      'policy.witnessWindowUs must be a microsecond count ({"$u": "<digits>"})',
    ]);
  }, 120_000);

  it('[DI-05][DI-30][DI-31][DI-32][PR-18][PR-20] a row\'s command id is one the server gives, its signatures name a signature (or the dry run\'s placeholder), a meaning of the kernel and the person who gives them, and its evidence is exactly what the server records with it: the server\'s own rows pass, and the round-6 verification\'s probe C and every member forged into evidence are refused', async () => {
    const actor = { id: UUID(1), kind: 'PERSON', roles: ['PRODUCTION_OPERATOR'] };
    const base = { commandId: UUID(3), actor, expectedVersion: 4, step: 'p-disp-pcm', context: [] };
    const clearance = { ...base, step: 'p-disp-clear', type: 'RECORD_ENTRY', entry: { kind: 'CLEARANCE_CHECK', answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'CONFIRMED' }] } };
    const lot = { id: 'TEST-L26-0101', material: 'MAT-PCM', status: 'RELEASED', expiresAtUs: '1900000000000000', identityTested: true };
    const weighing = (source: 'DEVICE' | 'MANUAL') => ({ ...base, type: 'RECORD_ENTRY', entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', container: 'TEST-B26-0001/C1', lot, gross: '26.250', tare: '1.250', unit: 'kg', balance: 'TEST-BAL-01', source } });
    const reading = (purpose: string, n: number) => ({ purpose, readingId: UUID(n), deviceCode: 'TEST-BAL-01', value: purpose === 'TARE' ? '1.250' : '26.250', unit: 'kg', raw: `ST,GS ${purpose === 'TARE' ? '1.250' : '26.250'} kg`, sourceTimeUs: '1800000000000000', trust: 'DEVICE_SYNCED' });
    const readings = [reading('TARE', 10), reading('GROSS', 11)];
    const lotEvidence = { code: lot.id, material: lot.material, status: lot.status };
    const manual = { room: 'DISP-1', balance: 'TEST-BAL-01', declaredBalance: null, scales: [{ deviceCode: 'TEST-BAL-01', status: 'OFFLINE', lastHeartbeatUs: '1800000000000000' }] };
    const signature = { id: UUID(20), meaning: 'PERFORMED', signer: actor.id };
    const performed = { ...base, type: 'SIGN_PERFORMED', commandId: `ESIG:${UUID(20)}`, signature };
    const dry = { ...performed, commandId: `ESIG-DRY:${UUID(21)}`, signature: { ...signature, id: '$dry-run' } };
    const charge = { ...base, type: 'RECORD_ENTRY', entry: { kind: 'CHARGE_CONTAINER', container: 'TEST-B26-0001/C1', scannedBatch: 'TEST-B26-0001' } };
    const scanned = { ...base, type: 'RECORD_DATA', item: 'punchSet', value: { kind: 'TEXT', value: 'TEST-PUNCH-01' }, source: { mode: 'MANUAL' } };
    const approver = { id: UUID(5), kind: 'PERSON', roles: ['PRODUCTION_SUPERVISOR'] };
    const correction = { ...base, type: 'CORRECT_ENTRY', commandId: UUID(6), point: 'DP-1', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, reason: 'typing error', signature: { ...signature, id: UUID(22), meaning: 'CORRECTED' }, approval: { approver, signature: { id: UUID(23), meaning: 'CORRECTION_APPROVED', signer: approver.id } } };
    delete (correction as Json)['step'];
    delete (correction as Json)['context'];
    const prepare = { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: 'p-disp-pcm', context: [] }, actor, meaning: 'PERFORMED' };
    const key = { idempotencyKey: UUID(30) };
    type Case = [kind: string, commandId: string, command: unknown, accepted: boolean, evidence: unknown, expected: string | null];
    const cases: Record<string, Case> = {
      // The server's own rows.
      clearance: ['COMMAND', UUID(3), clearance, true, key, null],
      manualWeighing: ['COMMAND', UUID(3), weighing('MANUAL'), true, { ...key, manual, lot: lotEvidence }, null],
      deviceWeighing: ['COMMAND', UUID(3), weighing('DEVICE'), true, { ...key, readings, lot: lotEvidence }, null],
      staleWeighing: ['COMMAND', UUID(3), weighing('DEVICE'), false, { ...key, namedReadings: readings, lot: lotEvidence }, null],
      charge: ['COMMAND', UUID(3), charge, true, { ...key, scanned: 'TEST-B26-0001/C1' }, null],
      scannedValue: ['COMMAND', UUID(3), scanned, true, { ...key, unattestedScan: { code: 'TEST-PUNCH-01', recordedAs: 'MANUAL' } }, null],
      performed: ['COMMAND', `ESIG:${UUID(20)}`, performed, true, { signatureId: UUID(20) }, null],
      refusedBeforeSigning: ['COMMAND', `ESIG-DRY:${UUID(21)}`, dry, false, { signing: 'refused before signing', meaning: 'PERFORMED' }, null],
      correction: ['COMMAND', UUID(6), correction, true, {}, null],
      prepare: ['PREPARE', `PREPARE:${UUID(7)}`, prepare, true, {}, null],
      sweep: ['SWEEP', `SWEEP:${UUID(8)}`, { type: 'SWEEP' }, true, {}, null],
      issue: ['ISSUE', `ISSUE:${UUID(2)}`, { type: 'ISSUE', request: encode({ batchId: UUID(2), batchNumber: 'TEST-B26-0001', batchSize: 'BS-1', marketSet: ['IN'], inputs: {}, issuedBy: actor }) }, true, { packageHash: PKG }, null],
      // Command ids.
      commandId: ['COMMAND', 'L2409-0017', { ...clearance, commandId: 'L2409-0017' }, true, {}, 'its command id L2409-0017 is not one the server gives a COMMAND row'],
      prepareId: ['PREPARE', UUID(7), prepare, true, {}, `its command id ${UUID(7)} is not one the server gives a PREPARE row`],
      // Signatures.
      signatureId: ['COMMAND', `ESIG:${UUID(20)}`, { ...performed, signature: { ...signature, id: 'L2409-0017' } }, false, {}, 'command.signature.id must be a signature id, or the placeholder of a dry run'],
      signatureMeaning: ['COMMAND', `ESIG-DRY:${UUID(21)}`, { ...dry, signature: { ...dry.signature, meaning: 'L2409-0017' } }, false, {}, 'command.signature.meaning "L2409-0017" is not a signature meaning of the kernel'],
      signer: ['COMMAND', `ESIG-DRY:${UUID(21)}`, { ...dry, signature: { ...dry.signature, signer: 'L2409-0017' } }, false, {}, 'command.signature.signer must be the person who gives it'],
      approvalSigner: ['COMMAND', UUID(6), { ...correction, approval: { approver, signature: { ...correction.approval.signature, signer: actor.id } } }, true, {}, 'command.approval.signature.signer must be the person who gives it'],
      prepareMeaning: ['PREPARE', `PREPARE:${UUID(7)}`, { ...prepare, meaning: 'L2409-0017' }, true, {}, 'command.meaning "L2409-0017" is not a signature meaning of the kernel'],
      // Evidence: the round-6 verification's probe C, and every member forged.
      probeC: ['COMMAND', UUID(3), clearance, true, { lotNumber: 'L2409-0017' }, 'evidence.lotNumber is a member the server does not record with a RECORD_ENTRY command of a CLEARANCE_CHECK entry'],
      notObject: ['COMMAND', UUID(3), clearance, true, ['L2409-0017'], 'evidence must be an object'],
      key: ['COMMAND', UUID(3), clearance, true, { idempotencyKey: 'L2409-0017' }, 'evidence.idempotencyKey must be the idempotency key of the request (a UUID)'],
      prepareEvidence: ['PREPARE', `PREPARE:${UUID(7)}`, prepare, true, key, 'evidence.idempotencyKey is a member the server does not record with a preparation for a signature'],
      sweepEvidence: ['SWEEP', `SWEEP:${UUID(8)}`, { type: 'SWEEP' }, true, { lotNumber: 'L2409-0017' }, 'evidence.lotNumber is a member the server does not record with a sweep'],
      packageHash: ['ISSUE', `ISSUE:${UUID(2)}`, { type: 'ISSUE', request: encode({ batchId: UUID(2), batchNumber: 'TEST-B26-0001', batchSize: 'BS-1', marketSet: ['IN'], inputs: {}, issuedBy: actor }) }, true, { packageHash: 'b'.repeat(64) }, 'evidence.packageHash must be the package the batch is issued from'],
      lotOnClearance: ['COMMAND', UUID(3), clearance, true, { lot: lotEvidence }, 'evidence.lot is a member the server does not record with a RECORD_ENTRY command of a CLEARANCE_CHECK entry'],
      lotCode: ['COMMAND', UUID(3), weighing('MANUAL'), true, { manual, lot: { ...lotEvidence, code: 'L2409-0017' } }, 'evidence.lot must be the code, material and status of the lot its entry names'],
      lotMember: ['COMMAND', UUID(3), weighing('MANUAL'), true, { manual, lot: { ...lotEvidence, lotNumber: 'L2409-0017' } }, 'evidence.lot must be the code, material and status of the lot its entry names'],
      readingsOnManual: ['COMMAND', UUID(3), weighing('MANUAL'), true, { readings }, 'evidence.readings is recorded only with an entry captured from a device'],
      manualOnDevice: ['COMMAND', UUID(3), weighing('DEVICE'), true, { manual }, 'evidence.manual is recorded only with an entry keyed by hand'],
      bothReadings: ['COMMAND', UUID(3), weighing('DEVICE'), true, { readings, namedReadings: readings }, 'evidence names its readings both as used (readings) and as not used (namedReadings)'],
      readingMember: ['COMMAND', UUID(3), weighing('DEVICE'), true, { readings: [{ ...reading('TARE', 10), lot: 'L2409-0017' }, reading('GROSS', 11)] }, 'evidence.readings[0].lot is a member evidence.readings[0] does not declare'],
      readingRaw: ['COMMAND', UUID(3), weighing('DEVICE'), true, { readings: [{ ...reading('TARE', 10), raw: ['L2409-0017'] }, reading('GROSS', 11)] }, 'evidence.readings[0].raw must be a text'],
      readingDevice: ['COMMAND', UUID(3), weighing('DEVICE'), false, { namedReadings: [reading('TARE', 10), { ...reading('GROSS', 11), deviceCode: 'L2409-0017' }] }, null],
      readingId: ['COMMAND', UUID(3), weighing('DEVICE'), true, { readings: [{ ...reading('TARE', 10), readingId: 'L2409-0017' }, reading('GROSS', 11)] }, 'evidence.readings[0].readingId has an invalid format'],
      manualMember: ['COMMAND', UUID(3), weighing('MANUAL'), true, { manual: { ...manual, lot: 'L2409-0017' } }, 'evidence.manual.lot is a member evidence.manual does not declare'],
      manualRoom: ['COMMAND', UUID(3), weighing('MANUAL'), true, { manual: { ...manual, room: 'L2409-0017' } }, 'evidence.manual.room must be the room of the row (DISP-1)'],
      manualBalance: ['COMMAND', UUID(3), weighing('MANUAL'), true, { manual: { ...manual, balance: 'L2409-0017' } }, 'evidence.manual.balance must be the balance its entry names'],
      declaredBalance: ['COMMAND', UUID(3), weighing('MANUAL'), true, { manual: { ...manual, declaredBalance: 'L2409-0017' } }, 'evidence.manual.declaredBalance must be the balance its entry names, or null'],
      scaleDevice: ['COMMAND', UUID(3), weighing('MANUAL'), true, { manual: { ...manual, scales: [{ ...manual.scales[0], deviceCode: 'L2409-0017' }] } }, null],
      scaleMember: ['COMMAND', UUID(3), weighing('MANUAL'), true, { manual: { ...manual, scales: [{ ...manual.scales[0], lot: 'L2409-0017' }] } }, 'evidence.manual.scales[0].lot is a member evidence.manual.scales[0] does not declare'],
      scanned: ['COMMAND', UUID(3), charge, true, { scanned: 'L2409-0017' }, 'evidence.scanned must be the container label its entry charges'],
      unattestedScanMember: ['COMMAND', UUID(3), scanned, true, { unattestedScan: { code: 'TEST-PUNCH-01', recordedAs: 'MANUAL', lot: 'L2409-0017' } }, 'evidence.unattestedScan.lot is a member evidence.unattestedScan does not declare'],
      unattestedScanDevice: ['COMMAND', UUID(3), { ...scanned, source: { mode: 'DEVICE', device: 'TEST-BAL-01' } }, true, { unattestedScan: { code: 'TEST-PUNCH-01', recordedAs: 'MANUAL' } }, 'evidence.unattestedScan is recorded only with a value keyed by hand'],
      signatureIdOther: ['COMMAND', `ESIG:${UUID(20)}`, performed, true, { signatureId: 'L2409-0017' }, 'evidence.signatureId must be the signature its command applies'],
      signingOnAccepted: ['COMMAND', `ESIG:${UUID(20)}`, performed, true, { signing: 'refused before signing', meaning: 'PERFORMED' }, 'evidence.meaning is a member the server does not record with a SIGN_PERFORMED command'],
      signingWords: ['COMMAND', `ESIG-DRY:${UUID(21)}`, dry, false, { signing: 'L2409-0017', meaning: 'PERFORMED' }, 'evidence of a signed command refused before signing is {signing: "refused before signing", meaning: the meaning of its signature}'],
      signingMeaning: ['COMMAND', `ESIG-DRY:${UUID(21)}`, dry, false, { signing: 'refused before signing', meaning: 'L2409-0017' }, 'evidence of a signed command refused before signing is {signing: "refused before signing", meaning: the meaning of its signature}'],
      signingAlone: ['COMMAND', `ESIG-DRY:${UUID(21)}`, dry, false, { signing: 'refused before signing' }, 'evidence.signing and evidence.meaning are recorded together'],
    };
    const got: Record<string, string | null> = {};
    for (const [n, [kind, id, command, accepted, evidence]] of Object.entries(cases)) got[n] = await rowProblem(kind, id, command, accepted, evidence);
    const sandboxDevice = (path: string): string => `${path} "L2409-0017" is not a test device label: in the sandbox every device label starts with TEST- (for example TEST-SCALE-01), so a real GMP identifier is never reused (DI-05)`;
    expect(got).toEqual({
      ...Object.fromEntries(Object.entries(cases).map(([n, c]) => [n, c[5]])),
      readingDevice: sandboxDevice('evidence.namedReadings[1].deviceCode'),
      scaleDevice: sandboxDevice('evidence.manual.scales[0].deviceCode'),
    });
  }, 120_000);

  it('[DI-05][DI-30][DI-34] a refused row records the engine\'s refusal as the engine builds it ({code, message, controls}) and an accepted row none: the refusals of commands the engine and a block refuse, and every rule code and control the engine\'s and the blocks\' sources name, meet the database\'s rule; a member of its own, a code or a control of another form, controls as a text and a refusal on an accepted row are refused', async () => {
    const problems = async (cases: readonly (readonly [boolean, unknown])[]): Promise<(string | null)[]> => {
      const { rows } = await db.admin.query<{ p: (string | null)[] }>(
        "select coalesce(array_agg(recipe.refusal_problem((x.c ->> 0)::boolean, case when jsonb_typeof(x.c -> 1) = 'null' then null else x.c -> 1 end) order by x.i), '{}') as p from jsonb_array_elements($1::jsonb) with ordinality x (c, i)",
        [JSON.stringify(cases)],
      );
      return rows[0]?.p ?? [];
    };
    // Refusals the engine and a block give.
    const run = Run.issue(fixtureDefinition('tablet-granulation-compression'), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    const first = Object.values(run.state.steps).find((i) => i.status === 'ENABLED');
    if (!first) throw new Error('SETUP: no enabled step');
    const clr = Run.issue(define(mbrWith(seqOf('ops', phase('clr', { block: G('G-10'), config: { checklist: [{ id: 'AREA', text: 'Area clean', expected: 'CONFIRMED' }, { id: 'DOCS', text: 'No documents', expected: 'CONFIRMED' }] } })))));
    clr.start('clr');
    const refused = [
      run.exec({ type: 'START_STEP', actor: OP2, step: 'no-such-step', context: [] }),
      run.exec({ type: 'START_STEP', actor: OP2, step: first.step, context: [], expectedVersion: 999 }),
      run.exec({ type: 'VERIFY', actor: OP2, step: first.step, context: [], signature: sig('VERIFIED', OP2) }),
      run.exec({ type: 'RELEASE_HOLD', actor: SUP1, hold: 'H-9', reason: 'no such hold' }),
      run.exec({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: 'EX-9', deviationRef: 'TEST-DEV-9' }),
      clr.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'clr', context: [], entry: { kind: 'CLEARANCE_CHECK', answers: [{ id: 'AREA', answer: 'CONFIRMED' }] } }),
      clr.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'clr', context: [], entry: { kind: 'CLEARANCE_CHECK', answers: 'L2409-0017' } }),
    ].map((r) => {
      if (r.accepted || !r.refusal) throw new Error('SETUP: a command was not refused');
      return JSON.parse(JSON.stringify(r.refusal)) as Json;
    });
    expect(sorted(new Set(refused.map((r) => String(r['code']).split('-')[0] ?? '')))).toEqual(['ENG', 'G10']);
    expect(await problems(refused.map((r) => [false, r] as const))).toEqual(refused.map(() => null));
    // Every rule code and control named in the engine's and the blocks' sources.
    const root = new URL('../../src/', import.meta.url).pathname;
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const codes = new Set<string>();
    const controls = new Set<string>();
    for (const f of [...files(join(root, 'engine')), ...files(join(root, 'blocks'))]) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:refuse\(|code:|Problems\()\s*'([A-Z][A-Z0-9-]*)'/g)) if (m[1]) codes.add(m[1]);
      for (const m of text.matchAll(/controls:\s*\[([^\]]*)\]|refuse\([^;]*?,\s*\[([^\]]*)\]\s*\)/g)) for (const q of (m[1] ?? m[2] ?? '').matchAll(/'([^']+)'/g)) if (q[1]) controls.add(q[1]);
    }
    expect(codes.size).toBeGreaterThan(80);
    expect(controls.size).toBeGreaterThan(40);
    const named = [...codes].map((code) => [false, { code, message: 'm', controls: ['DI-34'] }] as const);
    const ctl = [...controls].map((c) => [false, { code: 'ENG-X', message: 'm', controls: [c] }] as const);
    const got = await problems([...named, ...ctl]);
    const odd = [...[...codes].map((c) => `code ${c}`), ...[...controls].map((c) => `control ${c}`)].filter((_, i) => got[i] !== null);
    expect(odd).toEqual([]);
    // Forged.
    const own = refused[0] ?? {};
    expect(
      await problems([
        [false, { ...own, lotNumber: 'L2409-0017' }],
        [false, { ...own, code: 'L2409-0017' }],
        [false, { ...own, controls: ['DI-30', 'L2409-0017'] }],
        [false, { ...own, controls: 'L2409-0017' }],
        [false, { code: own['code'], message: own['message'] }],
        [false, null],
        [true, own],
        [true, null],
      ]),
    ).toEqual([
      "refusal.lotNumber is a member the engine's refusal does not declare",
      'refusal.code has an invalid format',
      'refusal.controls[1] has an invalid format',
      'refusal.controls must be a list',
      'refusal.controls is missing',
      'refusal must be an object',
      'an accepted row records no refusal',
      null,
    ]);
  }, 120_000);

  it('[DI-05][DI-30][DI-34] a refused library step entry is recorded with the library\'s own refusal (LIB-..., sql 1874): an entry a library block refuses on a GMP batch keeps its reason, and every code and control the library\'s sources name meets the rule (Capsules C3 finding: before, the writer answered EBMR-EXE-126)', async () => {
    const problems = async (cases: readonly unknown[]): Promise<(string | null)[]> => {
      const { rows } = await db.admin.query<{ p: (string | null)[] }>(
        'select coalesce(array_agg(recipe.refusal_problem(false, x.c) order by x.i), \'{}\') as p from jsonb_array_elements($1::jsonb) with ordinality x (c, i)',
        [JSON.stringify(cases)],
      );
      return rows[0]?.p ?? [];
    };
    // A library step refuses an entry that leaves a required field empty; the engine's refusal keeps the block's code.
    const item = SEED_CATALOGUE.find((x) => x.definition.code === 'PROC-DRY-MIX');
    if (!item) throw new Error('SETUP: no PROC-DRY-MIX in the catalogue');
    const def = item.definition;
    const p = phase('p', { block: { type: libraryBlockType(def.code), version: String(def.version) }, config: item.exampleUse as never });
    const run = Run.issue(define(mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }), { registry: testRegistry().extend(libraryBlockVersion(def, expr)) }));
    run.start('p');
    const r = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'mix' } });
    if (r.accepted || !r.refusal) throw new Error('SETUP: the empty library entry was not refused');
    const refusal = JSON.parse(JSON.stringify(r.refusal)) as Json;
    expect(String(refusal['code'])).toMatch(/^LIB-/);
    expect(await problems([refusal])).toEqual([null]);
    // Every code and control the library's sources name.
    const dir = new URL('../../src/library/', import.meta.url).pathname;
    const codes = new Set<string>();
    const controls = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/problem\(\s*'(LIB-[A-Z0-9-]+)'/g)) if (m[1]) codes.add(m[1]);
      for (const m of text.matchAll(/problem\(\s*'LIB-[A-Z0-9-]+'[^;]*?,\s*\[([^\]]*)\]\s*\)/g)) for (const q of (m[1] ?? '').matchAll(/'([^']+)'/g)) if (q[1]) controls.add(q[1]);
    }
    expect(codes.size).toBeGreaterThan(10);
    const got = await problems([...[...codes].map((code) => ({ code, message: 'm', controls: ['DI-34'] })), ...[...controls].map((c) => ({ code: 'LIB-X', message: 'm', controls: [c] }))]);
    expect([...[...codes].map((c) => `code ${c}`), ...[...controls].map((c) => `control ${c}`)].filter((_, i) => got[i] !== null)).toEqual([]);
    // A code of another prefix is still refused.
    expect(await problems([{ ...refusal, code: 'LIBX-1' }, { ...refusal, code: 'L2409-0017' }])).toEqual(['refusal.code has an invalid format', 'refusal.code has an invalid format']);
  }, 120_000);

  it('[DI-05][DI-10][DI-34] a batch is issued only with a request its MBR accepts, as the engine checks it at issue: the requests of both golden fixtures pass; a batch size, market, variant, variant choice or input the MBR does not hold, an input left out, given without its source or as another type, are refused', async () => {
    const problem = async (content: unknown, request: unknown): Promise<string | null> => {
      const { rows } = await db.admin.query<{ p: string | null }>('select recipe.issue_request_problem($1::jsonb, $2::jsonb) as p', [JSON.stringify(content), JSON.stringify(request)]);
      return rows[0]?.p ?? null;
    };
    const requestOf = (name: FixtureName): { mbr: MbrContent; request: Json } => {
      const mbr = fixtureDefinition(name).mbr;
      const request: IssueRequest = {
        batchId: 'BATCH-1', batchNumber: 'B0001', batchSize: mbr.header.batchSizes[0]?.id ?? '', marketSet: [...mbr.header.marketSet], inputs: FIXTURE_INPUTS[name] ?? {}, issuedBy: SUP1,
        ...(name === 'tablet-blister-packaging' ? { variants: { packDestination: 'US-EXPORT' } } : {}),
      };
      // The engine accepts it.
      Run.issue(fixtureDefinition(name), request);
      return { mbr, request: encode(request) as Json };
    };
    const g = requestOf('tablet-granulation-compression');
    const p = requestOf('tablet-blister-packaging');
    expect({ granulation: await problem(g.mbr, g.request), packaging: await problem(p.mbr, p.request) }).toEqual({ granulation: null, packaging: null });
    const firstInput = (r: Json): string => Object.keys(r['inputs'] as Json)[0] ?? '';
    const gi = firstInput(g.request);
    const typeOf = (id: string): string => String(g.mbr.inputs.find((i) => i.id === id)?.valueType);
    const forged = async (base: { mbr: MbrContent; request: Json }, change: (r: Json) => void): Promise<string | null> => {
      const r = structuredClone(base.request);
      change(r);
      return problem(base.mbr, r);
    };
    expect({
      size: await forged(g, (r) => void (r['batchSize'] = 'L2409-0017')),
      noIndia: await forged(g, (r) => void (r['marketSet'] = (r['marketSet'] as string[]).filter((m) => m !== 'IN'))),
      market: await forged(g, (r) => void (r['marketSet'] = [...(r['marketSet'] as string[]), 'L2409-0017'])),
      variantChoice: await forged(p, (r) => void (r['variants'] = { packDestination: 'L2409-0017' })),
      variantLeftOut: await forged(p, (r) => void delete r['variants']),
      variantOther: await forged(g, (r) => void (r['variants'] = { 'L2409-0017': 'X' })),
      inputOther: await forged(g, (r) => void ((r['inputs'] as Json)['L2409-0017'] = { value: { kind: 'TEXT', value: 'X' }, source: 's' })),
      inputLeftOut: await forged(g, (r) => void delete (r['inputs'] as Json)[gi]),
      inputNoSource: await forged(g, (r) => void (((r['inputs'] as Json)[gi] as Json)['source'] = '  ')),
      inputType: await forged(g, (r) => void (((r['inputs'] as Json)[gi] as Json)['value'] = { kind: 'TEXT', value: 'L2409-0017' })),
    }).toEqual({
      size: 'the batch size L2409-0017 is not one of the approved sizes of its MBR (ENG-ISSUE-SIZE)',
      noIndia: 'its market set does not hold India (IN), which every market set holds (ENG-ISSUE-MARKETS)',
      market: 'its market set names L2409-0017, a market its MBR is not approved for (ENG-ISSUE-MARKETS)',
      variantChoice: 'variant packDestination of its MBR is not given one of its values (ENG-ISSUE-VARIANT)',
      variantLeftOut: 'variant packDestination of its MBR is not given one of its values (ENG-ISSUE-VARIANT)',
      variantOther: 'it names L2409-0017, which is not a variant of its MBR (ENG-ISSUE-VARIANT)',
      inputOther: 'it gives L2409-0017, which is not a header or master-data input of its MBR (ENG-ISSUE-INPUT)',
      inputLeftOut: `input ${gi} of its MBR is not given (ENG-ISSUE-INPUT)`,
      inputNoSource: `input ${gi} is given without its source (ENG-ISSUE-INPUT)`,
      inputType: `input ${gi} is not given as its declared type ${typeOf(gi)} (ENG-ISSUE-INPUT)`,
    });
  }, 120_000);
});
