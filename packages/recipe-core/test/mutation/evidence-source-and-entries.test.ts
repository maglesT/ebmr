/**
 * Kill tests of the SQL mutation group evidence-source-and-entries (tools/sql-mutation/src/targets.ts), for the two pure
 * checks of recipe-core it mutates: recipe.entry_data_problem (sql 0313: a new entry holds what its command sent) and
 * recipe.new_container_problem (sql 0317: a container a row registers is the one its entry registers). Both are read
 * as packages/recipe-core/test/execution/entry-data-sql.test.ts reads them: on the rows of the engine's own runs, each
 * forged in one fact.
 *
 * Mutation batch 2 (e236af3) left these readings untested:
 *  - a state before the row that holds no entries map (or no containers map): every entry and container of the state
 *    after is then new, and is read (0313, 0317: `not coalesce(... ? key, false)`); a forged one is refused;
 *  - the start data of a START_STEP stands behind its START_DATA entry only, never behind an entry of another kind
 *    (0313);
 *  - only the accepted RECORD_ENTRY of a step registers a container: a command of another type, or naming no step, is
 *    refused before anything else is read (0317);
 *  - a container is registered only by a dispensing weighing at a G-07 step or an output weighing at a G-22 step, and
 *    by no entry of a step the MBR does not hold, nor an entry stored under another step or with no data (0317).
 * The trigger-level checks of the group (the command row, the readings of a device entry, the identifiers of a test
 * run) are in apps/tablets-server/test/mutation/evidence-source-and-entries.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeCommand, encodeState } from '../../src/engine/codec.ts';
import type { BatchState } from '../../src/engine/types.ts';
import { autopilot, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, Run } from '../engine/support.ts';

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
  command: Json;
  before: Json;
  after: Json;
}

const enc = (s: BatchState): Json => JSON.parse(JSON.stringify(encodeState(s))) as Json;

/** The rows of the granulation fixture's golden run (the engine's own), and its MBR content. */
function granulation(): { mbr: unknown; rows: Row[] } {
  const run = Run.issue(fixtureDefinition('tablet-granulation-compression'), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
  let before = run.state;
  expect(autopilot(run, GRANULATION_SCENARIO)).toBe('COMPLETE');
  const rows: Row[] = [];
  for (const [i, e] of run.log.entries()) {
    rows.push({ label: `#${i + 1} ${e.command.type}`, accepted: e.result.accepted, command: encodeCommand(e.command) as Json, before: enc(before), after: enc(e.result.state) });
    before = e.result.state;
  }
  return { mbr: run.def.mbr, rows };
}

const entries = (s: Json): Record<string, Json> => (s['entries'] as Record<string, Json> | undefined) ?? {};
const containers = (s: Json): Record<string, Json> => (s['containers'] as Record<string, Json> | undefined) ?? {};
const newEntries = (r: Row): string[] => Object.keys(entries(r.after)).filter((k) => !(k in entries(r.before)));
const newContainers = (r: Row): string[] => Object.keys(containers(r.after)).filter((k) => !(k in containers(r.before)));

/** The first accepted row of `rows` that `pred` picks. */
function first(rows: Row[], pred: (r: Row) => boolean): Row {
  const r = rows.find((x) => x.accepted && pred(x));
  if (!r) throw new Error('SETUP: no such row in the engine\'s run');
  return r;
}

/** `state` without its member `m` (a state that holds no such map). */
const without = (state: Json, m: string): Json => Object.fromEntries(Object.entries(state).filter(([k]) => k !== m));

async function entryProblem(r: Pick<Row, 'accepted' | 'command' | 'before' | 'after'>, kind = 'COMMAND'): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.entry_data_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb) as p', [
    JSON.stringify(r.before),
    JSON.stringify(r.after),
    kind,
    r.accepted,
    JSON.stringify(r.command),
  ]);
  return rows[0]?.p ?? null;
}

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

describe('recipe.entry_data_problem (sql 0313): a new entry holds what its command sent (DI-30, DI-05)', () => {
  it('[DI-30][DI-05] when the state before the row holds no entries map, every entry of the state after is new and is read: one holding another value than its command sent is refused', async () => {
    const { rows } = granulation();
    const previous = first(rows, (x) => newEntries(x).some((k) => entries(x.after)[k]?.['kind'] === 'PREVIOUS_BATCH'));
    const [k] = newEntries(previous) as [string];
    const entry = entries(previous.after)[k] as Json;
    // The state before holds no entries map; the state after holds the row's entry alone.
    const noMap = (data: Json): Row => ({ ...previous, before: without(previous.before, 'entries'), after: { ...previous.after, entries: { [k]: { ...entry, data } } } });
    const sent = entry['data'] as Json;
    expect(await entryProblem(noMap(sent))).toBeNull();
    expect(await entryProblem(noMap({ ...sent, batchNumber: 'B24-0001' }))).toBe(`stores another batchNumber in entry ${k} (PREVIOUS_BATCH) than its command sent`);
  }, 300_000);

  it('[DI-30][DI-05] the start data of a START_STEP stands behind its START_DATA entry only: an entry of another kind that the start brings in is refused, whatever it holds', async () => {
    const start = { type: 'START_STEP', step: 'p-rework', context: [], blockData: { reason: 'Sieve torn', authorisedBy: 'QA-7' } };
    const before = { entries: {} };
    const stored = (kind: string, data: Json): Row => ({ label: kind, accepted: true, command: start, before, after: { entries: { 'EN-1': { id: 'EN-1', kind, stepKey: 'p-rework@', data } } } });
    // The start data as the block stores it, and the same start data stored with another value.
    expect(await entryProblem(stored('START_DATA', { reason: 'Sieve torn', authorisedBy: 'QA-7' }))).toBeNull();
    expect(await entryProblem(stored('START_DATA', { reason: 'Sieve torn', authorisedBy: 'QA-9' }))).toBe('stores another authorisedBy in entry EN-1 (START_DATA) than its command sent');
    // An entry of another kind holding exactly the start data: nothing the START_STEP sent stands behind it.
    expect(await entryProblem(stored('CLEARANCE_CHECK', { reason: 'Sieve torn', authorisedBy: 'QA-7' }))).toBe('stores entry EN-1 (CLEARANCE_CHECK), and no data its command sent stands behind it');
  }, 300_000);
});

describe('recipe.new_container_problem (sql 0317): a container a row registers is the one its entry registers (DI-30, DI-05)', () => {
  it('[DI-30][DI-05] when the state before the row holds no containers map, or no entries map, every container and entry of the state after is new and is read', async () => {
    const { mbr, rows } = granulation();
    const weighing = first(rows, (x) => newContainers(x).length === 1 && newEntries(x).some((k) => entries(x.after)[k]?.['kind'] === 'CONTAINER_WEIGHING'));
    const [wk] = newEntries(weighing) as [string];
    const [ck] = newContainers(weighing) as [string];
    expect(await containerProblem(mbr, weighing)).toBeNull();

    // No containers map before: the weighing's container is new, and it is read; with other facts it is refused, and a
    // preparation adds none.
    const noContainers: Row = { ...weighing, before: without(weighing.before, 'containers') };
    expect(await containerProblem(mbr, noContainers)).toBeNull();
    const otherFacts = structuredClone(noContainers);
    (containers(otherFacts.after)[ck] as Json)['holds'] = 'BOM-OTHER';
    expect(await containerProblem(mbr, otherFacts)).toEqual(expect.stringContaining(`registers container ${ck} with other facts than its entry ${wk} gives (`));
    expect(await containerProblem(mbr, noContainers, 'PREPARE')).toBe(`adds container ${ck}; only the accepted RECORD_ENTRY of an entry that registers it adds one`);

    // No entries map before: every entry of the state after is new, so a container beside the run's whole record is
    // refused, and beside the weighing's entry alone it is the weighing's.
    const all = Object.keys(entries(weighing.after)).length;
    expect(all).toBeGreaterThan(1);
    const noEntries: Row = { ...weighing, before: without(weighing.before, 'entries') };
    expect(await containerProblem(mbr, noEntries)).toBe(`adds container ${ck} beside ${all} new entries; a container is registered by the one entry its row records`);
    const alone: Row = { ...noEntries, after: { ...weighing.after, entries: { [wk]: entries(weighing.after)[wk] } } };
    expect(await containerProblem(mbr, alone)).toBeNull();
  }, 300_000);

  it('[DI-30][DI-05] only the accepted RECORD_ENTRY of a step registers a container: the weighing\'s state recorded under a command of another type, or one naming no step, is refused', async () => {
    const { mbr, rows } = granulation();
    const weighing = first(rows, (x) => newContainers(x).length === 1 && newEntries(x).some((k) => entries(x.after)[k]?.['kind'] === 'CONTAINER_WEIGHING'));
    const [ck] = newContainers(weighing) as [string];
    const only = `adds container ${ck}; only the accepted RECORD_ENTRY of an entry that registers it adds one`;
    // Another command type, with the weighing's step and entry.
    expect(await containerProblem(mbr, { ...weighing, command: { ...weighing.command, type: 'START_STEP' } })).toBe(only);
    expect(await containerProblem(mbr, { ...weighing, command: { ...weighing.command, type: 'CORRECT_ENTRY' } })).toBe(only);
    // The weighing's command naming no step, or naming it otherwise than as a text.
    expect(await containerProblem(mbr, { ...weighing, command: without(weighing.command, 'step') })).toBe(only);
    expect(await containerProblem(mbr, { ...weighing, command: { ...weighing.command, step: ['p'] } })).toBe(only);
  }, 300_000);

  it('[DI-30][DI-05][INV-25] a container is registered only by a dispensing weighing at a G-07 step or an output weighing at a G-22 step: an output at the weighing\'s step, a weighing at the output\'s step, either at a step the MBR does not hold, an entry stored under another step or holding no data is refused', async () => {
    const { mbr, rows } = granulation();
    const weighing = first(rows, (x) => newContainers(x).length === 1 && newEntries(x).some((k) => entries(x.after)[k]?.['kind'] === 'CONTAINER_WEIGHING'));
    const output = first(rows, (x) => newContainers(x).length === 1 && newEntries(x).some((k) => entries(x.after)[k]?.['kind'] === 'OUTPUT_CONTAINER'));
    const stepOf = (r: Row): string => String(r.command['step']);
    const keyOf = (r: Row): string => String(entries(r.after)[newEntries(r)[0] ?? '']?.['stepKey']);
    /** Row `r` moved to step `step` whole: its command, its new entry and its new container all name that step. */
    const movedTo = (r: Row, step: string): Row => {
      const moved = structuredClone(r);
      const key = `${step}${keyOf(r).slice(keyOf(r).indexOf('@'))}`;
      moved.command['step'] = step;
      for (const k of newEntries(r)) (entries(moved.after)[k] as Json)['stepKey'] = key;
      for (const k of newContainers(r)) (containers(moved.after)[k] as Json)['producedBy'] = key;
      return moved;
    };
    /** `step`, which the MBR holds. */
    const inMbr = (step: string): string => {
      if (!JSON.stringify(mbr).includes(`"id":"${step}"`)) throw new Error(`SETUP: the MBR has no step ${step}`);
      return step;
    };
    const [wk] = newEntries(weighing) as [string];
    const [ok] = newEntries(output) as [string];
    const [wc] = newContainers(weighing) as [string];
    const [oc] = newContainers(output) as [string];
    const weighStep = inMbr(stepOf(weighing));
    const outStep = inMbr(stepOf(output));
    const refused = (container: string, entry: string, kind: string, key: string, block: string) =>
      `adds container ${container} beside entry ${entry} (${kind}) of step ${key}, whose block (${block}) registers no container with such an entry`;
    const keyAt = (r: Row, step: string) => `${step}${keyOf(r).slice(keyOf(r).indexOf('@'))}`;

    // The honest rows pass.
    expect(await containerProblem(mbr, weighing)).toBeNull();
    expect(await containerProblem(mbr, output)).toBeNull();
    // An output weighing at the dispensing weighing's (G-07) step, a dispensing weighing at the output's (G-22) step.
    expect(await containerProblem(mbr, movedTo(output, weighStep))).toBe(refused(oc, ok, 'OUTPUT_CONTAINER', keyAt(output, weighStep), 'G-07'));
    expect(await containerProblem(mbr, movedTo(weighing, outStep))).toBe(refused(wc, wk, 'CONTAINER_WEIGHING', keyAt(weighing, outStep), 'G-22'));
    // Either at a step the MBR does not hold (no block registers anything there).
    expect(await containerProblem(mbr, movedTo(weighing, 'p-not-in-mbr'))).toBe(refused(wc, wk, 'CONTAINER_WEIGHING', keyAt(weighing, 'p-not-in-mbr'), 'none'));
    expect(await containerProblem(mbr, movedTo(output, 'p-not-in-mbr'))).toBe(refused(oc, ok, 'OUTPUT_CONTAINER', keyAt(output, 'p-not-in-mbr'), 'none'));
    // The weighing's entry stored under another step than the row's (its container produced by the row's step).
    const elsewhere = structuredClone(weighing);
    (entries(elsewhere.after)[wk] as Json)['stepKey'] = keyAt(weighing, outStep);
    expect(await containerProblem(mbr, elsewhere)).toBe(refused(wc, wk, 'CONTAINER_WEIGHING', keyOf(weighing), 'G-07'));
    // The weighing's entry holding no data.
    for (const data of ['net 50 kg', null, [1]]) {
      const noData = structuredClone(weighing);
      (entries(noData.after)[wk] as Json)['data'] = data;
      expect(await containerProblem(mbr, noData), JSON.stringify(data)).toBe(refused(wc, wk, 'CONTAINER_WEIGHING', keyOf(weighing), 'G-07'));
    }
  }, 300_000);
});
