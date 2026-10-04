/**
 * The checks of what a row's new entries name, hold and look like, rule by rule (SQL mutation group
 * "entry-references-and-schema": recipe.node_names and recipe.entry_reference_problem of recipe-core 0328,
 * recipe.status_check_ids, recipe.clearance_items, recipe.lot_usability_problem and recipe.entry_block_problem of 0330,
 * recipe.block_schema_problem, recipe.block_schema_unknown_member and recipe.entry_schema_problem of 0332). These tests
 * close the gaps the SQL mutation run (tools/sql-mutation, batch 2) found in packages/recipe-core/test/execution
 * entry-data-sql.test.ts: each rule is shown from the side it refuses, with the words it refuses in, and from the side
 * it lets through, at its boundary, on rows of the engine's own runs (forged where the rule is about a forgery).
 * recipe.lot_usability_problem is the one 0372 replaces: the run's surviving mutant #6 read a BOM line that names null
 * as its material the way the engine does, so the migration fixed the function rather than a test locking 0330 in.
 *
 * Controls: DI-05 (no identifier in the record that the MBR does not give it), DI-10 and DI-30 (an entry holds what its
 * block builds and meets its block's data schema), PR-14 (the second person an entry asks for), PR-18 (lot usability),
 * PR-21 (charges of planned material only), PR-23 (equipment status), PR-29 (sampling plan), PR-34 (line clearance),
 * PR-47 (reprocessing). The rules the triggers of 0328, 0330 and 0332 add around these functions (which rows they read,
 * the words of their refusal) are tested through the application role in
 * apps/tablets-server/test/mutation/entry-references-and-schema.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { BlockVersion } from '../../src/blocks/contract.ts';
import { GENERIC_BLOCK_VERSIONS } from '../../src/blocks/generic/index.ts';
import { clearanceChecklist, DEFAULT_CLEARANCE_CHECKLIST, DEFAULT_STATUS_CHECKS, statusChecks } from '../../src/blocks/generic/status.ts';
import { validateSchema, type FieldSchema } from '../../src/blocks/schema.ts';
import { encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import type { BatchState } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { fixtureMbr } from '../blocks/support.ts';
import { findPhase, mbrWith, phase } from '../flow/support.ts';
import { define, OP1, Run, sig, T0 } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

/** A row of a run as the database reads it: its command (accepted or refused), the states around it, the MBR. */
interface Row {
  label: string;
  accepted: boolean;
  command: JsonValue;
  before: Json;
  after: Json;
  mbr: MbrContent;
}

const enc = (s: BatchState): Json => JSON.parse(JSON.stringify(encodeState(s))) as Json;
const G = (type: string) => ({ type, version: '1' });
const seqOf = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const DAY_US = 86_400_000_000n;

/** The rows of a run of `mbr` (issued with `issue`, its state set up by `setup`) that `script` drives. */
function rowsFor(mbr: MbrContent, script: (run: Run) => void, issue: Parameters<typeof Run.issue>[1] = {}, setup: (run: Run) => void = () => undefined): Row[] {
  const run = Run.issue(define(mbr), issue, T0);
  setup(run);
  let before = structuredClone(run.state);
  script(run);
  return run.log.map((e, i) => {
    const r: Row = { label: `#${i + 1} ${e.command.type}`, accepted: e.result.accepted, command: encodeCommand(e.command), before: enc(before), after: enc(e.result.state), mbr };
    before = e.result.state;
    return r;
  });
}

/** The rows of block `type`'s golden fixture: issued, started (with its start data) and its script. */
function fixtureRows(type: string): Row[] {
  const b = GENERIC_BLOCK_VERSIONS.find((x) => x.type === type) as BlockVersion;
  const f = b.goldenFixture;
  if (!f) throw new Error(`SETUP: ${type} has no fixture`);
  const inputs = Object.fromEntries(
    (f.inputs ?? []).map((i) => [i.id, { value: i.valueType === 'COUNT' ? { kind: 'COUNT' as const, value: i.value } : { kind: 'DECIMAL' as const, value: i.value, unit: i.unit ?? '1' }, source: 'golden fixture' }]),
  );
  return rowsFor(
    fixtureMbr(b),
    (run) => {
      const startData = f.script.find((s): s is { startData: Record<string, unknown> } => 'startData' in s)?.startData;
      run.start('p', [], undefined, startData);
      for (const s of f.script) if ('entry' in s) run.entry('p', s.entry);
    },
    { inputs },
    (run) => {
      for (const c of f.containers ?? []) run.state.containers[c.id] = { id: c.id, holds: c.holds, holdsKind: c.holdsKind, producedBy: 'setup@', producedIn: [], status: 'QUARANTINE' };
    },
  );
}

const entriesOf = (s: Json): Record<string, Json> => (s['entries'] as Record<string, Json> | undefined) ?? {};
const containersOf = (s: Json): Record<string, Json> => (s['containers'] as Record<string, Json> | undefined) ?? {};
const stepsOf = (s: Json): Record<string, Json> => (s['steps'] as Record<string, Json> | undefined) ?? {};
/** The entry row `r` adds (the first). */
function added(r: Row): [string, Json] {
  const e = Object.entries(entriesOf(r.after)).find(([k]) => !(k in entriesOf(r.before)));
  if (!e) throw new Error(`SETUP: ${r.label} adds no entry`);
  return e;
}
/** The first accepted row of `rows` that adds an entry of kind `kind`. */
function adding(rows: readonly Row[], kind: string): Row {
  const r = rows.find((x) => x.accepted && Object.entries(entriesOf(x.after)).some(([k, e]) => !(k in entriesOf(x.before)) && e['kind'] === kind));
  if (!r) throw new Error(`SETUP: no row adds ${kind}`);
  return r;
}
/** `entry <id> (<kind>) of step <key>`, as the checks name the entry row `r` adds. */
function about(r: Row): string {
  const [k, e] = added(r);
  return `entry ${k} (${String(e['kind'])}) of step ${String(e['stepKey'])}`;
}
/** A copy of row `r` with the entry it adds (its data), the states, the command or the MBR changed by `change`. */
function forge(r: Row, change: (x: { e: Json; data: Json; after: Json; before: Json; command: Json; sent: Json; mbr: MbrContent }) => void): Row {
  const f = structuredClone(r);
  const [k] = added(f);
  const e = entriesOf(f.after)[k] as Json;
  const command = f.command as Json;
  change({ e, data: e['data'] as Json, after: f.after, before: f.before, command, sent: (command['entry'] ?? command['blockData']) as Json, mbr: f.mbr });
  return f;
}
/** Row `r` with the step of the entry it adds not needing a second person's check. */
const unchecked = (r: Row): Row => forge(r, ({ after, e }) => void ((stepsOf(after)[String(e['stepKey'])] as Json)['verificationRequired'] = false));

async function sqlOf(fn: string, r: Row, withVerdict = false): Promise<string | null> {
  const args = [JSON.stringify(r.mbr), JSON.stringify(r.before), JSON.stringify(r.after), JSON.stringify(r.command), ...(withVerdict ? [r.accepted] : [])];
  const { rows } = await db.admin.query<{ p: string | null }>(`select recipe.${fn}($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb${withVerdict ? ', $5' : ''}) as p`, args);
  return rows[0]?.p ?? null;
}
const referenceProblem = (r: Row) => sqlOf('entry_reference_problem', r);
const blockProblem = (r: Row) => sqlOf('entry_block_problem', r);
const schemaProblem = (r: Row) => sqlOf('entry_schema_problem', r, true);

describe('recipe-core 0328: an entry names only what its step\'s node in the MBR names (DI-05, DI-30, PR-18, PR-21, PR-23)', () => {
  it('[DI-05][DI-30][PR-18][PR-21] a weighing names a line of the bill of materials its step dispenses: the single line of a one-line bill passes, a line the step lists that the bill does not hold is refused', async () => {
    const weighing = adding(fixtureRows('G-07'), 'CONTAINER_WEIGHING');
    expect(weighing.mbr.bom.map((b) => b.id)).toEqual(['BOM-API']);
    // The step lists a line the bill of materials does not hold (an MBR the server would not define, forged).
    const ghost = forge(weighing, ({ data, sent, mbr }) => {
      findPhase(mbr, 'p').consumes = ['BOM-API', 'BOM-GHOST'];
      data['bomLine'] = 'BOM-GHOST';
      sent['bomLine'] = 'BOM-GHOST';
    });
    expect({ honest: await referenceProblem(weighing), ghost: await referenceProblem(ghost) }).toEqual({
      honest: null,
      ghost: `stores ${about(ghost)} with BOM line BOM-GHOST, which is not a line of the MBR's bill of materials that step p dispenses`,
    });
  }, 120_000);

  it('[DI-05][DI-30][PR-18] an output names an intermediate its step produces: one that names none is refused, as one that names another', async () => {
    const output = adding(fixtureRows('G-22'), 'OUTPUT_CONTAINER');
    const unnamed = forge(output, ({ data }) => void delete data['intermediate']);
    const other = forge(output, ({ data }) => void (data['intermediate'] = 'I-WET'));
    expect({ honest: await referenceProblem(output), unnamed: await referenceProblem(unnamed), other: await referenceProblem(other) }).toEqual({
      honest: null,
      unnamed: `stores ${about(unnamed)} holding intermediate (none), which step p does not produce`,
      other: `stores ${about(other)} holding intermediate I-WET, which step p does not produce`,
    });
  }, 120_000);

  it('[DI-05][PR-21] a container charge charges what its step charges: a dispensed container of a BOM line the step consumes passes; one of a line it does not consume, and one whose contents are of no stated kind, are refused (G08-UNPLANNED)', async () => {
    const mbr = mbrWith(seqOf('ops', phase('k', { block: G('G-08'), consumes: ['B'], uses: ['I-X'] })), {
      bom: [
        { id: 'B', material: 'MAT-M', role: 'ACTIVE', quantity: { value: '1', unit: 'kg' } },
        { id: 'B2', material: 'MAT-M', role: 'EXCIPIENT', quantity: { value: '1', unit: 'kg' } },
      ],
      intermediates: [{ id: 'I-X', name: 'Kit' }],
    });
    const charge = adding(
      rowsFor(mbr, (run) => {
        run.start('k');
        run.entry('k', { kind: 'CHARGE_CONTAINER', container: 'K-1', scannedBatch: '$BATCH' });
      }, {}, (run) => void (run.state.containers['K-1'] = { id: 'K-1', holds: 'B', holdsKind: 'BOM_LINE', producedBy: 'w@', producedIn: [], status: 'QUARANTINE' })),
      'CHARGE_CONTAINER',
    );
    /** The charged container K-1 (before the row) holding `holds`, of kind `kind` (none: no kind stated). */
    const holding = (holds: string, kind?: string) => ({ data, before }: { data: Json; before: Json }): void => {
      const c: Json = { ...(containersOf(before)['K-1'] as Json), holds };
      if (kind === undefined) delete c['holdsKind'];
      else c['holdsKind'] = kind;
      containersOf(before)['K-1'] = c;
      data['holds'] = holds;
    };
    const otherLine = forge(charge, holding('B2', 'BOM_LINE'));
    const kindless = forge(charge, holding('I-X'));
    const c = `${about(charge)} charging container K-1`;
    expect({ honest: await referenceProblem(charge), otherLine: await referenceProblem(otherLine), kindless: await referenceProblem(kindless) }).toEqual({
      honest: null,
      otherLine: `stores ${c}, which holds B2 (BOM_LINE), and step k does not charge it`,
      kindless: `stores ${c}, which holds I-X (?), and step k does not charge it`,
    });
  }, 120_000);

  it('[DI-05][PR-23] an equipment status names equipment its step lists for a status check: any equipment where the step lists none, and one that names no equipment where it does is refused', async () => {
    const free = adding(
      rowsFor(mbrWith(seqOf('ops', phase('st', { block: G('G-09') }))), (run) => {
        run.start('st');
        run.entry('st', { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL-9', labelId: 'LBL-9', answers: DEFAULT_STATUS_CHECKS.map((c) => ({ id: c.id, answer: 'YES' })) });
      }),
      'EQUIPMENT_STATUS',
    );
    expect(findPhase(free.mbr, 'st').equipment).toEqual([]);
    const listed = adding(fixtureRows('G-09'), 'EQUIPMENT_STATUS');
    const unnamed = forge(listed, ({ data }) => void delete data['equipmentRef']);
    expect({ free: await referenceProblem(free), listed: await referenceProblem(listed), unnamed: await referenceProblem(unnamed) }).toEqual({
      free: null,
      listed: null,
      unnamed: `stores ${about(unnamed)} for equipment (none), which step p does not check (BAL)`,
    });
  }, 120_000);
});

describe('recipe-core 0330: the checklists, the lot and the entry its block builds (DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-47)', () => {
  it('[PR-23][PR-34] a step\'s checks and checklist are its configuration\'s when it lists any, else the block\'s defaults, as the blocks read them (status.ts statusChecks, clearanceChecklist)', async () => {
    const configs: Json[] = [
      {},
      { checks: [] },
      { checks: [{ id: 'SPEED', text: 'Speed set' }, 'TEXT', { id: 'TEMP', text: 'Temperature set' }] },
      { checklist: [] },
      { checklist: [{ id: 'AREA', text: 'Area clean', expected: 'CONFIRMED_OR_NOT_APPLICABLE' }, 'TEXT', { id: 'DOCS', text: 'No documents' }] },
    ];
    const { rows } = await db.admin.query<{ s: string[]; c: unknown }>(
      'select recipe.status_check_ids(x.c) as s, recipe.clearance_items(x.c) as c from jsonb_array_elements($1::jsonb) with ordinality x (c, i) order by x.i',
      [JSON.stringify(configs)],
    );
    expect(rows).toEqual(configs.map((c) => ({ s: statusChecks(c).map((x) => x.id), c: clearanceChecklist(c).map((x) => ({ id: x.id, expected: x.expected })) })));
    // The lists the configurations above lead to.
    expect(rows.map((r) => r.s)).toEqual([
      DEFAULT_STATUS_CHECKS.map((c) => c.id), DEFAULT_STATUS_CHECKS.map((c) => c.id), ['SPEED', 'TEMP'], DEFAULT_STATUS_CHECKS.map((c) => c.id), DEFAULT_STATUS_CHECKS.map((c) => c.id),
    ]);
    expect(rows[3]?.c).toEqual(DEFAULT_CLEARANCE_CHECKLIST.map((c) => ({ id: c.id, expected: c.expected })));
    expect(rows[4]?.c).toEqual([{ id: 'AREA', expected: 'CONFIRMED_OR_NOT_APPLICABLE' }, { id: 'DOCS', expected: 'CONFIRMED' }]);
  });

  it('[PR-18] a lot is usable only when it is of the line\'s material or its code, released, before its retest date (that instant included), and identity-tested for a batch for a market other than India', async () => {
    const content = {
      bom: [{ id: 'B', material: 'MAT-M', role: 'ACTIVE', quantity: { value: '1', unit: 'kg' } }],
      references: [{ id: 'MAT-M', kind: 'MATERIAL', code: 'M-CODE', version: '1', hash: 'c'.repeat(64) }],
    };
    const now = 1_790_000_000_000_000n;
    const lot = { id: 'AR-9', material: 'MAT-M', status: 'RELEASED', identityTested: true };
    const cases: [string, Json, string[]][] = [
      ['material', lot, ['IN']],
      ['code', { ...lot, material: 'M-CODE' }, ['IN']],
      ['otherMaterial', { ...lot, material: 'MAT-OTHER' }, ['IN']],
      ['retestNow', { ...lot, retestAtUs: String(now) }, ['IN']],
      ['retestLater', { ...lot, retestAtUs: String(now + 1n) }, ['IN']],
      ['untestedForUs', { ...lot, identityTested: false }, ['US']],
      ['untestedForIndia', { ...lot, identityTested: false }, ['IN']],
    ];
    const { rows } = await db.admin.query<{ p: (string | null)[] }>(
      "select array_agg(recipe.lot_usability_problem($1::jsonb, '\"B\"'::jsonb, x.c -> 0, $2::numeric, x.c -> 1) order by x.i) as p from jsonb_array_elements($3::jsonb) with ordinality x (c, i)",
      [JSON.stringify(content), now.toString(), JSON.stringify(cases.map(([, l, m]) => [l, m]))],
    );
    expect(Object.fromEntries(cases.map(([n], i) => [n, rows[0]?.p[i] ?? null]))).toEqual({
      material: null,
      code: null,
      otherMaterial: 'lot AR-9 is of material MAT-OTHER, not the item the MBR names (M-CODE) (G07-WRONG-MATERIAL)',
      retestNow: 'lot AR-9 is past its retest date (G07-LOT-RETEST)',
      retestLater: null,
      untestedForUs: 'lot AR-9 has no identity-test result, and the batch is for US (G07-LOT-IDENTITY)',
      untestedForIndia: null,
    });
  });

  it('[PR-18][IN-23][PR-21] a lot is of the material its BOM line names even where the line names null (sql 0372): the engine refuses that lot (G07-WRONG-MATERIAL), and so does the database, for the lot and for the row that stores its charge', async () => {
    const lot = { id: 'AR-9', material: 'MAT-M', status: 'RELEASED', identityTested: true };
    const bomOf = (material: string | null) => [{ id: 'B', material, role: 'ACTIVE', quantity: { value: '1', unit: 'kg' } }] as unknown as MbrContent['bom'];
    const chargeMbr = (material: string | null): MbrContent => mbrWith(seqOf('ops', phase('k', { block: G('G-08'), consumes: ['B'] })), { bom: bomOf(material) });
    const entry = { kind: 'CHARGE_LOT', bomLine: 'B', container: 'TEST-K-1', lot, quantity: { value: '1', unit: 'kg' } };
    // The engine on an MBR whose BOM line names null as its material (its parser defines no such MBR; a test package
    // imported through the application role can hold one): the lot is not of the item the MBR names.
    const run = Run.issue(define(chargeMbr(null)), {}, T0);
    run.start('k');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'k', context: [], entry }, 'G07-WRONG-MATERIAL').message).toContain('Lot AR-9 is MAT-M, not the item the MBR names (null)');
    // The engine's accepted charge of the line of MAT-M, and the same row read against an MBR whose line names null.
    const charge = adding(rowsFor(chargeMbr('MAT-M'), (r) => {
      r.start('k');
      r.entry('k', entry);
    }), 'CHARGE_LOT');
    const nullLine = forge(charge, ({ mbr }) => void (mbr.bom = bomOf(null)));
    const { rows } = await db.admin.query<{ p: string | null }>(
      "select recipe.lot_usability_problem($1::jsonb, '\"B\"'::jsonb, $2::jsonb, 0, '[\"IN\"]'::jsonb) as p",
      [JSON.stringify({ bom: bomOf(null) }), JSON.stringify({ ...lot, material: 'MAT-X' })],
    );
    expect({ lot: rows[0]?.p ?? null, honest: await blockProblem(charge), nullLine: await blockProblem(nullLine) }).toEqual({
      lot: 'lot AR-9 is of material MAT-X, not the item the MBR names (null) (G07-WRONG-MATERIAL)',
      honest: null,
      nullLine: `stores ${about(nullLine)} whose lot AR-9 is of material MAT-M, not the item the MBR names (null) (G07-WRONG-MATERIAL)`,
    });
  }, 120_000);

  it('[DI-30][DI-05] an entry is recorded by an event of its own row: an entry numbered with the last event before the row, or after the row\'s last, is refused', async () => {
    const status = adding(fixtureRows('G-09'), 'EQUIPMENT_STATUS');
    const s0 = Number(status.before['seq']);
    const s1 = Number(status.after['seq']);
    const numbered = (n: number): Row => forge(status, ({ e }) => void (e['recordedSeq'] = n));
    expect(Number(added(status)[1]['recordedSeq'])).toBeGreaterThan(s0);
    expect({ honest: await blockProblem(status), last: await blockProblem(numbered(s1)), before: await blockProblem(numbered(s0)), after: await blockProblem(numbered(s1 + 1)) }).toEqual({
      honest: null,
      last: null,
      before: `stores ${about(status)} with recordedSeq ${s0}, which is not an event of this row (after ${s0}, up to ${s1})`,
      after: `stores ${about(status)} with recordedSeq ${s1 + 1}, which is not an event of this row (after ${s0}, up to ${s1})`,
    });
  }, 120_000);

  it('[PR-14][DI-30] only a weighing or an output keyed by hand, and a scanned paper original, ask for the second person\'s check: a weighing and an output that name no source and a photo do not', async () => {
    const weighing = adding(fixtureRows('G-07'), 'CONTAINER_WEIGHING');
    const output = adding(fixtureRows('G-22'), 'OUTPUT_CONTAINER');
    const sourceless = (r: Row): Row => unchecked(forge(r, ({ data, sent }) => {
      delete data['source'];
      delete sent['source'];
    }));
    const attachments = rowsFor(mbrWith(seqOf('ops', phase('att', { block: G('G-05') }))), (run) => {
      run.start('att');
      run.entry('att', { kind: 'ATTACHMENT', sha256: 'b'.repeat(64), mediaType: 'image/png', description: 'Photo of the label' });
      run.entry('att', { kind: 'ATTACHMENT', sha256: 'a'.repeat(64), mediaType: 'application/pdf', description: 'Printout of the blender', paperOriginal: true });
    });
    const photo = adding(attachments, 'ATTACHMENT');
    const paper = attachments[attachments.length - 1] as Row;
    expect(stepsOf(photo.after)['att@']?.['verificationRequired']).toBe(false);
    expect(stepsOf(paper.after)['att@']?.['verificationRequired']).toBe(true);
    const paperUnchecked = unchecked(paper);
    expect({
      weighing: await blockProblem(sourceless(weighing)),
      output: await blockProblem(sourceless(output)),
      photo: await blockProblem(photo),
      paper: await blockProblem(paper),
      paperUnchecked: await blockProblem(paperUnchecked),
    }).toEqual({
      weighing: null,
      output: null,
      photo: null,
      paper: null,
      paperUnchecked: `stores ${about(paperUnchecked)}, which needs a second person's check of its step, and the step does not require it (PR-14)`,
    });
  }, 120_000);

  it('[PR-29][DI-05][DI-30] a sample is of its step\'s sampling plan (the step\'s plan when it lists one, else its locations), numbered among the samples of its own step, of the sub-lot of its replicate frame only, and names a container only when one is named', async () => {
    const plan = [{ point: 'TOP', purpose: 'ASSAY', units: 1, destructive: true }];
    const rows = rowsFor(
      mbrWith(seqOf('ops', phase('s1', { block: G('G-12'), sampling: plan }), phase('s2', { block: G('G-12'), config: { locations: 2, purpose: 'BU' } }))),
      (run) => {
        run.start('s1');
        run.entry('s1', { kind: 'SAMPLE', point: 'TOP', purpose: 'ASSAY', units: 1 });
        run.perform('s1');
        run.verify('s1');
        run.start('s2');
        run.entry('s2', { kind: 'SAMPLE', point: 'L1', purpose: 'BU', units: 1 });
      },
    );
    const samples = rows.filter((r) => r.accepted && Object.keys(entriesOf(r.after)).length > Object.keys(entriesOf(r.before)).length);
    const [first, second] = samples as [Row, Row];
    expect([first, second].map((r) => (added(r)[1]['data'] as Json)['sampleId'])).toEqual(['B0001/s1/S1', 'B0001/s2/S1']);
    const at = (point: string) => ({ data, sent }: { data: Json; sent: Json }): void => {
      data['point'] = point;
      sent['point'] = point;
    };
    // The plan of a step that lists one (and no locations); the locations of a step whose plan is empty.
    const unplanned = forge(first, at('ELSEWHERE'));
    const emptyPlan = (r: Row): Row => forge(r, ({ mbr }) => void (findPhase(mbr, 's2').sampling = []));
    const outsideLocations = emptyPlan(forge(second, at('L9')));
    // A sub-lot that encloses no frame is no sub-lot of a replicate frame (engine view.ts: the inner replicate frame's).
    const frameless = forge(first, ({ after }) => void (after['subLots'] = { 'R@': { key: 'R@', construct: 'R', frames: [], index: 0, id: 'B0001-SL0' } }));
    // A container named by an empty text is no container (G-12 keeps one only when one is named).
    const emptyContainer = forge(first, ({ sent }) => void (sent['container'] = ''));
    expect({
      first: await blockProblem(first),
      second: await blockProblem(second),
      secondEmptyPlan: await blockProblem(emptyPlan(second)),
      unplanned: await blockProblem(unplanned),
      outsideLocations: await blockProblem(outsideLocations),
      frameless: await blockProblem(frameless),
      emptyContainer: await blockProblem(emptyContainer),
    }).toEqual({
      first: null,
      second: null,
      secondEmptyPlan: null,
      unplanned: `stores ${about(unplanned)} taken at point ELSEWHERE for ASSAY, which is not in the sampling plan of its step (G12-NOT-PLANNED)`,
      outsideLocations: `stores ${about(outsideLocations)} taken at point L9 for BU, which is not in the sampling plan of its step (G12-NOT-PLANNED)`,
      frameless: null,
      emptyContainer: null,
    });
  }, 120_000);

  it('[PR-47][DI-30] a source addition exactly as old as the MBR\'s maximum age is taken, one microsecond older is refused (G24-TOO-OLD); and start data recorded at another step is no prior authorisation of a reprocessing step (G24-NOT-AUTHORISED)', async () => {
    const maxAge = 30n * DAY_US;
    const rows = rowsFor(mbrWith(seqOf('ops', phase('add', { block: G('G-24'), reprocessing: { case: 'REPROCESSING_ADDITION', maxSourceBatches: 1, maxAge: { value: '30', unit: 'd' } } }))), (run) => {
      run.start('add', [], undefined, { investigationRef: 'INV-1', riskEvaluationRef: 'RA-1', authorisationRef: 'AUTH-1', authorisedBy: 'QA1' });
      run.entry('add', { kind: 'SOURCE_ADDITION', sourceBatch: 'TEST-B26-0007', productCode: 'P', quantity: { value: '0.01', unit: 'kg' }, manufacturedAtUs: String(T0 - maxAge) });
    });
    const start = adding(rows, 'START_DATA');
    const addition = adding(rows, 'SOURCE_ADDITION');
    const older = forge(addition, ({ data, sent }) => {
      data['manufacturedAtUs'] = String(T0 - maxAge - 1n);
      sent['manufacturedAtUs'] = String(T0 - maxAge - 1n);
    });
    const elsewhere = forge(start, ({ e }) => void (e['stepKey'] = 'elsewhere@'));
    expect({ addition: await blockProblem(addition), older: await blockProblem(older), start: await blockProblem(start), elsewhere: await blockProblem(elsewhere) }).toEqual({
      addition: null,
      older: `stores ${about(older)} from batch TEST-B26-0007, which is older than the MBR's maximum of 30 d (G24-TOO-OLD)`,
      start: null,
      elsewhere: 'starts reprocessing step add@ without the quality unit\'s prior authorisation (G24-NOT-AUTHORISED)',
    });
  }, 120_000);
});

describe('recipe-core 0332: an entry and a step\'s start data meet the data schema of the step\'s block version (DI-05, DI-30)', () => {
  const schemaOf = async (kind: string): Promise<Json> =>
    (await db.admin.query<{ s: Json }>('select schema as s from recipe.block_data_schema where entry_kind = $1', [kind])).rows[0]?.s ?? {};
  const registered = (kind: string): FieldSchema => {
    const s = GENERIC_BLOCK_VERSIONS.map((b) => b.dataSchema?.entries[kind]).find((x) => x !== undefined);
    if (!s) throw new Error(`SETUP: no block records ${kind}`);
    return s;
  };
  async function problems(cases: readonly (readonly [Json, unknown, string])[], fn = 'block_schema_problem'): Promise<(string | null)[]> {
    const { rows } = await db.admin.query<{ p: (string | null)[] }>(
      `select array_agg(recipe.${fn}(x.c -> 0, x.c -> 1, x.c ->> 2) order by x.i) as p from jsonb_array_elements($1::jsonb) with ordinality x (c, i)`,
      [JSON.stringify(cases)],
    );
    return rows[0]?.p ?? [];
  }

  it('[DI-30] a whole number, a bound and a list length are read up to and including their limit, as the engine reads them: the largest safe integer, units of 100000, a status of 20 answers', async () => {
    const sample = await schemaOf('SAMPLE');
    const status = await schemaOf('EQUIPMENT_STATUS');
    const answers = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `CHECK_${i + 1}`, answer: 'YES' }));
    const unit = { point: 'TOP', purpose: 'ASSAY' };
    const cases: [string, Json, FieldSchema, unknown][] = [
      ['safe', { type: 'integer' }, { type: 'integer', description: 'x' }, 9007199254740991],
      ['safeNegative', { type: 'integer' }, { type: 'integer', description: 'x' }, -9007199254740991],
      ['unsafe', { type: 'integer' }, { type: 'integer', description: 'x' }, 9007199254740992],
      ['unitsAtMost', sample, registered('SAMPLE'), { ...unit, units: 100000 }],
      ['unitsAbove', sample, registered('SAMPLE'), { ...unit, units: 100001 }],
      ['answersAtMost', status, registered('EQUIPMENT_STATUS'), { equipmentRef: 'BAL', labelId: 'LBL', answers: answers(20) }],
      ['answersAbove', status, registered('EQUIPMENT_STATUS'), { equipmentRef: 'BAL', labelId: 'LBL', answers: answers(21) }],
    ];
    const got = await problems(cases.map(([, s, , v]) => [s, v, 'v'] as const));
    const outcome = Object.fromEntries(cases.map(([n], i) => [n, got[i] ?? null]));
    expect(outcome).toEqual({
      safe: null,
      safeNegative: null,
      unsafe: 'v must be a whole number',
      unitsAtMost: null,
      unitsAbove: 'v.units must be at most 100000',
      answersAtMost: null,
      answersAbove: 'v.answers allows at most 20 items',
    });
    // The engine's verdicts on the same values.
    expect(Object.fromEntries(cases.map(([n, , s, v]) => [n, validateSchema(s, v, 'v').map((p) => `${p.path} ${p.message}`)[0] ?? null]))).toEqual(outcome);
  });

  it('[DI-30][DI-05] an object schema that declares no fields fails closed: every member of the value is one it does not declare, in the check of an accepted entry and in that of a refused one', async () => {
    const bare = { type: 'object' };
    expect({
      problem: await problems([[bare, { lotNumber: 'L2409-0017' }, 'o'], [bare, {}, 'o']]),
      unknown: await problems([[bare, { lotNumber: 'L2409-0017' }, 'o'], [bare, {}, 'o']], 'block_schema_unknown_member'),
    }).toEqual({
      problem: ['o.lotNumber is not a field of this block (unknown fields are refused)', null],
      unknown: ['o.lotNumber is not a field of this block (unknown fields are refused)', null],
    });
  });

  it('[DI-05] what a refused row is held to reads names, not types: a list sent as an object or as a text names no member the schema does not declare', async () => {
    const clearance = await schemaOf('CLEARANCE_CHECK');
    expect(await problems([
      [clearance, { answers: { first: { id: 'NO_PREVIOUS_MATERIAL', answer: 'NO' } } }, 'CLEARANCE_CHECK'],
      [clearance, { answers: 'NO' }, 'CLEARANCE_CHECK'],
      [clearance, { answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'NO', lot: 'L2409-0017' }] }, 'CLEARANCE_CHECK'],
    ], 'block_schema_unknown_member')).toEqual([null, null, 'CLEARANCE_CHECK.answers[0].lot is not a field of this block (unknown fields are refused)']);
  });

  it('[DI-30][DI-05] a row answers for the entries it adds: an entry recorded before it (before 0332 read the schema) is not read again', async () => {
    const rows = rowsFor(mbrWith(seqOf('ops', phase('smp', { block: G('G-12') }))), (run) => {
      run.start('smp');
      run.entry('smp', { kind: 'SAMPLE', point: 'TOP', purpose: 'ASSAY', units: 1 });
      run.entry('smp', { kind: 'SAMPLE', point: 'MIDDLE', purpose: 'ASSAY', units: 1 });
    });
    const second = rows[rows.length - 1] as Row;
    const [first] = added(adding(rows, 'SAMPLE'));
    const legacy = structuredClone(second);
    for (const s of [legacy.before, legacy.after]) ((entriesOf(s)[first] as Json)['data'] as Json)['units'] = 0;
    // The same entry added by the row is refused.
    const adds = adding(rows, 'SAMPLE');
    const zero = forge(adds, ({ data }) => void (data['units'] = 0));
    expect({ second: await schemaProblem(second), legacy: await schemaProblem(legacy), zero: await schemaProblem(zero) }).toEqual({
      second: null,
      legacy: null,
      zero: `stores ${about(zero)} whose data does not meet the data schema of block G-12@1: SAMPLE.units must be at least 1 (ENG-ENTRY-SCHEMA)`,
    });
  }, 120_000);

  it('[DI-30][DI-05] a refused row is read for start data only when it is a START_STEP that carries some: a refused START_STEP without start data, and a refused signature, are recorded as refused', async () => {
    const rows = rowsFor(mbrWith(seqOf('ops', phase('p'), phase('q'))), (run) => {
      run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig('PERFORMED', OP1) });
      run.exec({ type: 'START_STEP', actor: OP1, step: 'q', context: [] });
    });
    const [signature, start] = rows as [Row, Row];
    expect([signature, start].map((r) => r.accepted)).toEqual([false, false]);
    // The command of another type that carries a member named blockData (0335 refuses that member in the row) is not start data.
    const carrying = { ...signature, command: { ...(signature.command as Json), blockData: { investigationRef: 'INV-1' } } as JsonValue };
    expect({ signature: await schemaProblem(signature), carrying: await schemaProblem(carrying), start: await schemaProblem(start) }).toEqual({ signature: null, carrying: null, start: null });
    // A refused START_STEP that carries start data is read: a member no block version declares is refused.
    const startWith = { ...start, command: { ...(start.command as Json), blockData: { investigationRef: 'INV-1', lotNumber: 'L2409-0017' } } as JsonValue };
    expect(await schemaProblem(startWith)).toBe('records at step q refused start data holding a member no block version declares for it: startData.lotNumber is not a field of this block (unknown fields are refused) (ENG-ENTRY-SCHEMA)');
  }, 120_000);
});
