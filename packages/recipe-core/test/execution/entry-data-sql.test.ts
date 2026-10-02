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
