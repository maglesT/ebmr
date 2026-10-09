/**
 * Kill tests of the SQL mutation group weighing (tools/sql-mutation/src/targets.ts), for the pure checks of recipe-core
 * it mutates: recipe.weighing_net_problem (sql 0321), recipe.weighing_label_problem, recipe.block_total_problem and
 * recipe.weighing_totals_problem (0322), recipe.phase_records (0323). They are read on the weighings, labels and block
 * values of the engine's own golden run of the granulation fixture, each forged in one fact, and on the fixture's own
 * MBR with one of its nodes changed (INV-25, PR-19, DI-30).
 *
 * Mutation batch 2 (e236af3) left these readings untested:
 *  - a gross or a tare that is a JSON number is no decimal text, even where gross minus tare comes to the recorded net
 *    (0321);
 *  - a weighing gives a label quantity only when its net and its unit are both text (0322);
 *  - a block value is computed from exactly its step's weighings: one that names another weighing in place of one of
 *    its own, or one of them twice, with as many names as the step has weighings, or whose list of weighings is no list,
 *    is not their total; nor is a value of another kind than DECIMAL holding the right figure (0322);
 *  - a state before the row that holds no points map: every block value of the state after is new and is read (0322);
 *  - the items a phase records are read only where exactly one library element answers a call, with a body and a
 *    list of symbols, and only from a phase that has a list of records (0323: fail closed).
 * The trigger-level checks of the group are in apps/tablets-server/test/mutation/weighing.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeState } from '../../src/engine/codec.ts';
import { autopilot, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, Run } from '../engine/support.ts';
import { clone, loadFixture } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await db.admin.query<{ v: T }>(sql, params);
  return rows[0]?.v as T;
}

/** The granulation fixture's golden run (the engine's own): its MBR, its batch number and its final state as stored. */
function golden(): { mbr: Json; batch: string; state: Json } {
  const run = Run.issue(fixtureDefinition('tablet-granulation-compression'), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
  expect(autopilot(run, GRANULATION_SCENARIO)).toBe('COMPLETE');
  return { mbr: JSON.parse(JSON.stringify(run.def.mbr)) as Json, batch: run.state.header.batchNumber, state: JSON.parse(JSON.stringify(encodeState(run.state))) as Json };
}

const entriesOf = (s: Json): Record<string, Json> => s['entries'] as Record<string, Json>;
const pointsOf = (s: Json): Record<string, Json> => s['points'] as Record<string, Json>;
const dataOf = (e: Json): Json => e['data'] as Json;

/** The first weighing entry of `kind` at step `stepKey` in the state. */
function weighingAt(s: Json, stepKey: string, kind = 'CONTAINER_WEIGHING'): Json {
  const e = Object.values(entriesOf(s)).find((x) => x['stepKey'] === stepKey && x['kind'] === kind);
  if (!e) throw new Error(`SETUP: no ${kind} at ${stepKey} in the golden run`);
  return e;
}

/** The block value of `item` (source BLOCK) in the state. */
function blockValue(s: Json, item: string): Json {
  const p = Object.values(pointsOf(s)).find((x) => x['item'] === item && (x['source'] as Json)['mode'] === 'BLOCK');
  if (!p) throw new Error(`SETUP: no block value of ${item} in the golden run`);
  return p;
}

/** A copy of entry `e` with its data changed by `edit`. */
function withData(e: Json, edit: (d: Json) => void): Json {
  const x = structuredClone(e);
  edit(dataOf(x));
  return x;
}

const netProblem = async (entry: Json): Promise<string> => (await one<string | null>('select recipe.weighing_net_problem($1::jsonb) as v', [JSON.stringify(entry)])) ?? 'null';

describe('recipe.weighing_net_problem (sql 0321): a net weight is gross minus tare, written as decimal text (INV-25, PR-19)', () => {
  it('[INV-25][PR-19][DI-30] a weighing whose gross or tare is a JSON number is refused as no decimal text, though gross minus tare comes to its net; every weighing of the golden run passes', async () => {
    const { state } = golden();
    const all = Object.values(entriesOf(state)).filter((e) => e['kind'] === 'CONTAINER_WEIGHING' || e['kind'] === 'OUTPUT_CONTAINER');
    expect(all.length).toBeGreaterThan(5);
    for (const e of all) expect(await netProblem(e), String(e['id'])).toBe('null');
    // 9.992 - 1.250 = 8.742, as the engine wrote it; the same figures as JSON numbers are not what the balance printed.
    const api = weighingAt(state, 'p-disp-api@');
    expect(dataOf(api)).toMatchObject({ gross: '9.992', tare: '1.250', net: '8.742' });
    const output = weighingAt(state, 'p-blend-out@', 'OUTPUT_CONTAINER');
    expect({
      grossNumber: await netProblem(withData(api, (d) => void (d['gross'] = Number(d['gross'])))),
      tareNumber: await netProblem(withData(api, (d) => void (d['tare'] = Number(d['tare'])))),
      outputGrossNumber: await netProblem(withData(output, (d) => void (d['gross'] = Number(d['gross'])))),
      outputTareNumber: await netProblem(withData(output, (d) => void (d['tare'] = Number(d['tare'])))),
    }).toEqual({
      grossNumber: '(CONTAINER_WEIGHING) with no gross and tare as decimal text',
      tareNumber: '(CONTAINER_WEIGHING) with no gross and tare as decimal text',
      outputGrossNumber: '(OUTPUT_CONTAINER) with no gross and tare as decimal text',
      outputTareNumber: '(OUTPUT_CONTAINER) with no gross and tare as decimal text',
    });
  }, 300_000);
});

describe('recipe.weighing_label_problem (sql 0322): a container\'s label carries its weighing\'s own net and unit (PR-19, INV-25)', () => {
  it('[PR-19][INV-25][DI-30] a label quantity is given only by a net and a unit that are both text: a label stating one for a net or a unit written as a JSON number is refused; the golden run\'s labels pass', async () => {
    const { mbr, batch, state } = golden();
    const label = async (entry: Json): Promise<string> =>
      (await one<string | null>('select recipe.weighing_label_problem($1::jsonb, $2, $3::jsonb) as v', [JSON.stringify(entry), batch, JSON.stringify(mbr)])) ?? 'null';
    const api = weighingAt(state, 'p-disp-api@');
    expect(await label(api)).toBe('null');
    const { label: honest } = dataOf(api) as { label: Json };
    // The net written as the number 8.742 and the label saying "8.742 kg": the weighing gives no quantity, so no label
    // stating one is its own. Likewise a unit written as a number.
    const netNumber = withData(api, (d) => {
      d['net'] = 8.742;
    });
    const unitNumber = withData(api, (d) => {
      d['unit'] = 1000;
      d['label'] = { ...honest, quantity: '8.742 1000' };
    });
    expect(honest).toEqual({ component: 'MAT-ATV', lot: 'AR-BOM-ATV', quantity: '8.742 kg', batch: 'B0001', product: 'ATV-40-FCT', container: 'C-API-1' });
    expect({ netNumber: await label(netNumber), unitNumber: await label(unitNumber) }).toEqual({
      netNumber: '(CONTAINER_WEIGHING) labelled {"lot": "AR-BOM-ATV", "batch": "B0001", "product": "ATV-40-FCT", "quantity": "8.742 kg", "component": "MAT-ATV", "container": "C-API-1"}, where its weighing and the batch give {"lot": "AR-BOM-ATV", "batch": "B0001", "product": "ATV-40-FCT", "component": "MAT-ATV", "container": "C-API-1"}',
      unitNumber: '(CONTAINER_WEIGHING) labelled {"lot": "AR-BOM-ATV", "batch": "B0001", "product": "ATV-40-FCT", "quantity": "8.742 1000", "component": "MAT-ATV", "container": "C-API-1"}, where its weighing and the batch give {"lot": "AR-BOM-ATV", "batch": "B0001", "product": "ATV-40-FCT", "component": "MAT-ATV", "container": "C-API-1"}',
    });
  }, 300_000);
});

describe('recipe.block_total_problem and recipe.weighing_totals_problem (sql 0322): the quantity a step\'s weighings count into is their total (INV-25, PR-19)', () => {
  it('[INV-25][PR-19][DI-30] a dispensed quantity computed from another step\'s weighing in place of one of its own, from one of its own twice, or from no list of weighings is refused, with as many names as the step has weighings; the golden run\'s totals pass', async () => {
    const { state } = golden();
    const exc = blockValue(state, 'excipientsDispensed');
    const key = String(exc['id']);
    const own = (exc['source'] as { entries: string[] }).entries;
    expect(own.length).toBeGreaterThan(2);
    const apiWeighing = String(weighingAt(state, 'p-disp-api@')['id']);
    const total = async (s: Json): Promise<string> => (await one<string | null>('select recipe.block_total_problem($1::jsonb, $2, $3) as v', [JSON.stringify(s), key, 'kg'])) ?? 'null';
    const named = (entries: unknown): Json => {
      const s = structuredClone(state);
      (pointsOf(s)[key]?.['source'] as Json)['entries'] = entries;
      return s;
    };
    const first = own[0] as string;
    expect(await total(state)).toBe('null');
    const where = `block value ${key} of excipientsDispensed at p-disp-exc@, computed from the weighings`;
    // The weighings its step records, as the database lists them (by entry key).
    const recorded = JSON.stringify([...own].sort()).replace(/","/g, '", "');
    expect({
      anotherStepsWeighing: await total(named([...own.slice(0, -1), apiWeighing])),
      oneOfItsOwnTwice: await total(named([...own.slice(0, -1), first])),
      notAList: await total(named(Object.fromEntries(own.map((e) => [e, e])))),
      aText: await total(named(own.join(','))),
    }).toEqual({
      anotherStepsWeighing: `${where} ${JSON.stringify([...own.slice(0, -1), apiWeighing]).replace(/","/g, '", "')}, where its step records the weighings ${recorded}`,
      oneOfItsOwnTwice: `${where} ${JSON.stringify([...own.slice(0, -1), first]).replace(/","/g, '", "')}, where its step records the weighings ${recorded}`,
      notAList: `${where} {${own.map((e) => `"${e}": "${e}"`).join(', ')}}, where its step records the weighings ${recorded}`,
      aText: `${where} "${own.join(',')}", where its step records the weighings ${recorded}`,
    });
  }, 300_000);

  it('[INV-25][PR-19][DI-30] a dispensed quantity holding the weighings\' figure as a value of another kind than DECIMAL is refused', async () => {
    const { state } = golden();
    const exc = blockValue(state, 'excipientsDispensed');
    const key = String(exc['id']);
    expect(exc['value']).toEqual({ kind: 'DECIMAL', value: '43.260', unit: 'kg' });
    const total = async (value: Json): Promise<string> => {
      const s = structuredClone(state);
      (pointsOf(s)[key] as Json)['value'] = value;
      return (await one<string | null>('select recipe.block_total_problem($1::jsonb, $2, $3) as v', [JSON.stringify(s), key, 'kg'])) ?? 'null';
    };
    const named = JSON.stringify([...(exc['source'] as { entries: string[] }).entries].sort()).replace(/","/g, '", "');
    expect({ integer: await total({ kind: 'INTEGER', value: '43.260', unit: 'kg' }), text: await total({ kind: 'TEXT', value: '43.260', unit: 'kg' }) }).toEqual({
      integer: `block value ${key} of excipientsDispensed at p-disp-exc@ as {"kind": "INTEGER", "unit": "kg", "value": "43.260"}, where the nets of its weighings ${named} come to 43.260 kg at the resolution they were weighed at`,
      text: `block value ${key} of excipientsDispensed at p-disp-exc@ as {"kind": "TEXT", "unit": "kg", "value": "43.260"}, where the nets of its weighings ${named} come to 43.260 kg at the resolution they were weighed at`,
    });
  }, 300_000);

  it('[INV-25][PR-19][DI-30] when the state before the row holds no points map, every block value of the state after is new and is read: one that is not its weighings\' total is refused, the honest ones pass', async () => {
    const { mbr, state } = golden();
    const api = blockValue(state, 'apiDispensed');
    const key = String(api['id']);
    // The state before: the same steps (no step leaves IN_PROGRESS), no points map at all.
    const before = Object.fromEntries(Object.entries(state).filter(([k]) => k !== 'points'));
    const totals = async (after: Json): Promise<string> =>
      (await one<string | null>('select recipe.weighing_totals_problem($1::jsonb, $2::jsonb, $3::jsonb) as v', [JSON.stringify(before), JSON.stringify(after), JSON.stringify(mbr)])) ?? 'null';
    expect(await totals(state)).toBe('null');
    const forged = structuredClone(state);
    (pointsOf(forged)[key] as Json)['value'] = { kind: 'DECIMAL', value: '8.74', unit: 'kg' };
    expect(await totals(forged)).toBe(`block value ${key} of apiDispensed at p-disp-api@ as {"kind": "DECIMAL", "unit": "kg", "value": "8.74"}, where the nets of its weighings ["${String(weighingAt(state, 'p-disp-api@')['id'])}"] come to 8.742 kg at the resolution they were weighed at`);
  }, 300_000);
});

describe('recipe.phase_records (sql 0323): the items a phase records, read only where the MBR answers it one way (INV-25, PR-19)', () => {
  type Node = Json & { kind?: string; id?: string };
  const find = (n: unknown, id: string): Node | undefined => {
    if (Array.isArray(n)) {
      for (const x of n) {
        const f = find(x, id);
        if (f) return f;
      }
      return undefined;
    }
    if (n === null || typeof n !== 'object') return undefined;
    if ((n as Node).id === id && typeof (n as Node).kind === 'string') return n as Node;
    for (const v of Object.values(n)) {
      const f = find(v, id);
      if (f) return f;
    }
    return undefined;
  };
  const records = async (content: unknown, step: string): Promise<string> => JSON.stringify(await one<string[] | null>('select recipe.phase_records($1::jsonb, $2) as v', [JSON.stringify(content), step]));
  const itemProblem = async (entry: unknown, content: unknown): Promise<string> =>
    (await one<string | null>('select recipe.weighing_item_problem($1::jsonb, $2::jsonb) as v', [JSON.stringify(entry), JSON.stringify(content)])) ?? 'null';

  it('[INV-25][PR-19] a library call answered by two elements of its name, or by one whose body is a list or whose symbols are no list, records nothing the database reads (fail closed)', async () => {
    const m = clone(loadFixture('tablet-granulation-compression')) as unknown as Json;
    const library = m['library'] as Json[];
    expect(library.map((e) => e['ref'])).toEqual(['LIB-LOD']);
    expect(await records(m, 'c-lod/lod-test')).toBe('["lod"]');
    const twice = structuredClone(m);
    (twice['library'] as Json[]).push(structuredClone(library[0] as Json));
    const bodyList = structuredClone(m);
    const el = (bodyList['library'] as Json[])[0] as Json;
    el['body'] = [el['body']];
    const symbolsMap = structuredClone(m);
    const el2 = (symbolsMap['library'] as Json[])[0] as Json;
    el2['symbols'] = { lodValue: 'lodValue', analyser: 'analyser' };
    // The element's phase recording nothing, its symbols gone: no binding is read, and nothing is answered.
    const noSymbols = structuredClone(m);
    const el3 = (noSymbols['library'] as Json[])[0] as Json;
    delete el3['symbols'];
    (el3['body'] as Json)['records'] = [];
    expect({
      twice: await records(twice, 'c-lod/lod-test'),
      bodyList: await records(bodyList, 'c-lod/lod-test'),
      symbolsMap: await records(symbolsMap, 'c-lod/lod-test'),
      noSymbols: await records(noSymbols, 'c-lod/lod-test'),
    }).toEqual({ twice: 'null', bodyList: 'null', symbolsMap: 'null', noSymbols: 'null' });
  }, 120_000);

  it('[INV-25][PR-19][DI-30] a hold point records no items, and a phase without a list of records records none the database reads: a dispensed container at such a step is refused as at a step the database cannot read', async () => {
    const m = clone(loadFixture('tablet-granulation-compression')) as unknown as Json;
    expect(find(m['procedure'], 'H-OVERDRY')?.kind).toBe('holdPoint');
    (find(m['procedure'], 'H-OVERDRY') as Json)['records'] = ['driedNet'];
    expect(await records(m, 'p-disp-api')).toBe('["apiDispensed"]');
    const noRecords = structuredClone(m);
    delete (find(noRecords['procedure'], 'p-disp-api') as Json)['records'];
    expect({ holdPoint: await records(m, 'H-OVERDRY'), noRecords: await records(noRecords, 'p-disp-api') }).toEqual({ holdPoint: 'null', noRecords: 'null' });
    const weighing = { stepKey: 'p-disp-api@', kind: 'CONTAINER_WEIGHING', data: { item: 'apiDispensed', net: '8.742', unit: 'kg' } };
    expect(await itemProblem(weighing, m)).toBe('null');
    expect(await itemProblem(weighing, noRecords)).toBe("(CONTAINER_WEIGHING) at p-disp-api@, whose step is no phase of the batch's MBR the database can read");
  }, 120_000);
});
