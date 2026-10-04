/**
 * Kill tests of the SQL mutation group execution-steps-and-order (tools/sql-mutation; build outline 9.1): the
 * database's own reading of the order of the steps, of the acts on them and of the starts and ends they record
 * (recipe-core sql 0307, 0308, 0311, 0316; Phase 2 exit review F66 and F67; DI-34, PR-13, INV-19, IN-15, INV-20, PR-30,
 * PR-08, PR-45, DI-27).
 *
 * Each test states a rule of those migrations' headers on the procedure as the engine expands it and on states of the
 * engine's own runs (the golden granulation run and small MBRs), and checks the database's answer exactly: the
 * honest row passes, the forged or malformed one is refused with its reason. The functions are called as the triggers
 * call them, with the batch's flow from recipe.flow_tree; the trigger-level rules (the row's kind, verdict and act)
 * are tested through the store in apps/tablets-server/test/mutation/execution-steps-and-order.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeCommand, encodeState, type JsonValue } from '../../src/engine/codec.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import { step } from '../../src/engine/engine.ts';
import type { BatchState, Command } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { endpoint, errors, mbrWith, phase, validate } from '../flow/support.ts';
import { autopilot, define, done, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, OP1, OP2, param, QA1, Run, sig, SUP1 } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;
type Frames = { construct: string; index: number }[];

const enc = (s: BatchState): Json => JSON.parse(JSON.stringify(encodeState(s))) as Json;
const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const hold = (id: string): FlowNode => ({ kind: 'holdPoint', id, name: `QA release ${id}`, role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] });
const source = { kind: 'VALIDATION_REPORT' as const, ref: 'V-1' };

/** One value of a database function, called with JSON arguments ($n::jsonb where the SQL says so). */
async function one<T>(sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await db.admin.query<{ v: T | null }>(sql, params.map((p) => (typeof p === 'object' && p !== null ? JSON.stringify(p) : p)));
  return rows[0]?.v ?? null;
}

let goldenCache: { run: Run; start: BatchState; final: Json } | undefined;
/** The golden granulation run to EXECUTION_COMPLETE (two sub-lots, the drying loop, the alternatives, a parallel section). */
function golden(): { run: Run; start: BatchState; final: Json } {
  if (goldenCache) return goldenCache;
  const run = Run.issue(fixtureDefinition('tablet-granulation-compression'), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
  const start = run.state;
  expect(autopilot(run, GRANULATION_SCENARIO)).toBe('COMPLETE');
  goldenCache = { run, start, final: enc(run.state) };
  return goldenCache;
}

const R = (k: number): Frames => [{ construct: 'R-SUBLOT', index: k }];
const stepsOf = (s: Json): Record<string, Json> => s['steps'] as Record<string, Json>;
const decisionsOf = (s: Json): Record<string, Json> => s['decisions'] as Record<string, Json>;

/** recipe.step_order_problem of instance `inst` in state `s`, with the tree of `mbr` (at `before`: the invariant form). */
const orderProblem = (mbr: unknown, s: Json, inst: unknown, before: number | null = null): Promise<string | null> =>
  one<string>('select recipe.step_order_problem(recipe.flow_tree($1::jsonb), $2::jsonb, $3::jsonb, $4::numeric) as v', [mbr, s, inst, before]);

/** One row as the store writes it, encoded. */
interface Row {
  label: string;
  kind: 'ISSUE' | 'COMMAND';
  accepted: boolean;
  command: JsonValue;
  before: Json;
  after: Json;
}

function rowsOf(run: Run, start: BatchState): Row[] {
  const rows: Row[] = [{ label: 'ISSUE', kind: 'ISSUE', accepted: true, command: { type: 'ISSUE' }, before: {}, after: enc(start) }];
  let before = start;
  for (const [i, e] of run.log.entries()) {
    const label = `#${i + 1} ${e.command.type}${'step' in e.command ? ` ${e.command.step}` : ''}${e.result.accepted ? '' : ' (refused)'}`;
    rows.push({ label, kind: 'COMMAND', accepted: e.result.accepted, command: encodeCommand(e.command), before: enc(before), after: enc(e.result.state) });
    before = e.result.state;
  }
  return rows;
}

/** Every objection of recipe.step_order_problem to the instances each row brings in (0307 header item 2). */
async function orderObjections(mbr: MbrContent, rows: readonly Row[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const before = (r.before['steps'] as Json | undefined) ?? {};
    for (const [k, inst] of Object.entries(stepsOf(r.after))) {
      if (k in before) continue;
      const p = await orderProblem(mbr, r.after, inst);
      if (p !== null) out[`${r.label}: ${k}`] = p;
    }
  }
  return out;
}

/** recipe.own_node_event_problem of row `r` (0312, 0314, 0316). */
const nodeEventProblem = (mbr: unknown, r: Pick<Row, 'kind' | 'accepted' | 'command' | 'before' | 'after'>): Promise<string | null> =>
  one<string>('select recipe.own_node_event_problem(recipe.flow_tree($1::jsonb), $2::jsonb, $3::jsonb, $4, $5, $6::jsonb) as v', [mbr, r.before, r.after, r.kind, r.accepted, r.command]);

async function nodeEventObjections(mbr: MbrContent, rows: readonly Row[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const p = await nodeEventProblem(mbr, r);
    if (p !== null) out[r.label] = p;
  }
  return out;
}

/** recipe.minimum_duration_problem of a row moving the state from `before` to `after` (0308 header item 1). */
const minimumProblem = (mbr: unknown, before: Json, after: Json): Promise<string | null> =>
  one<string>('select recipe.minimum_duration_problem($1::jsonb, recipe.flow_tree($1::jsonb), $2::jsonb, $3::jsonb) as v', [mbr, before, after]);

/** The engine's result of `command` on a definition without the minimum durations (the rule the engine refuses by taken out). */
function withoutMinimum(def: BatchDefinition, before: BatchState, command: Command, nowUs: bigint): BatchState {
  const lax: BatchDefinition = {
    ...def,
    constraints: def.constraints.map((rc) => {
      const tc = { ...rc.tc };
      delete tc.min;
      return { ...rc, tc };
    }),
  };
  const r = step(lax, before, command, { nowUs });
  if (!r.accepted) throw new Error(`SETUP: the definition without the minimum refuses too: ${JSON.stringify(r.refusal)}`);
  return r.state;
}

describe('the procedure as the database reads it (0307 recipe.flow_tree; DI-34, PR-13)', () => {
  it('[DI-34][PR-13] library calls are expanded at every depth, and a procedure the engine could not expand is named as unreadable, never read past', async () => {
    const ph = (id: string): Json => ({ kind: 'phase', id });
    const content = (body: Json, library: Json[] = []): Json => ({ procedure: { id: 'P', body }, library });
    const tree = (c: Json): Promise<{ ids?: Record<string, { kind: string; path: unknown[] }>; bad?: string } | null> => one('select recipe.flow_tree($1::jsonb) as v', [c]);
    // A library element that calls another one: both are inlined under the ids of their calls.
    const nested = await tree(
      content({ kind: 'sequence', id: 'root', children: [ph('a'), { kind: 'libraryCall', id: 'c1', element: 'LIB-A' }] }, [
        { ref: 'LIB-A', body: { kind: 'sequence', id: 'sa', children: [ph('x'), { kind: 'libraryCall', id: 'c2', element: 'LIB-B' }] } },
        { ref: 'LIB-B', body: ph('y') },
      ]),
    );
    expect(nested?.bad).toBeUndefined();
    expect(Object.keys(nested?.ids ?? {}).sort()).toEqual(['a', 'c1', 'c1/c2', 'c1/c2/y', 'c1/sa', 'c1/x', 'root']);
    expect(nested?.ids?.['c1/c2/y']?.kind).toBe('phase');
    // A node without an id, a node of no kind a procedure has, a library call naming no element. (A call naming its own
    // element is not given here: a mutant that misses it expands it without end.)
    expect((await tree(content({ kind: 'sequence', id: 'root', children: [ph('a'), { kind: 'phase', name: 'no id' }] })))?.bad).toBe('a node of the procedure has no id');
    expect((await tree(content({ kind: 'sequence', id: 'root', children: [{ kind: 'gateway', id: 'g' }] })))?.bad).toBe('node g is of no kind a procedure has (gateway)');
    expect((await tree(content({ kind: 'sequence', id: 'root', children: [{ kind: 'libraryCall', id: 'c9' }] })))?.bad).toBe('library call c9 names no element or its own element');
  });
});

describe('F66: a step instance only where the token can be (0307 recipe.step_order_problem; DI-34, PR-13, INV-19)', () => {
  const framesProblem = 'its frames are not one per enclosing loop and replicate section, outermost first, each a whole number from 1';

  it('[DI-34][PR-13][INV-19] frames name exactly the enclosing loops and replicate sections, outermost first, each index a whole number from 1; unknown constructs or frames fit nothing', async () => {
    const { run, final } = golden();
    const mbr = run.def.mbr;
    const steps = stepsOf(final);
    const inst = (st: string, frames: unknown[], key: string): Json => ({ ...(steps[`${st}@R-SUBLOT=1`] ?? {}), key, step: st, frames, status: 'ENABLED' });
    expect(await orderProblem(mbr, final, steps['p-gran-clear@R-SUBLOT=1']), 'the control').toBeNull();
    // One frame, as many as the step has, but naming the drying loop where the replicate section encloses it.
    expect(await orderProblem(mbr, final, inst('p-gran-clear', [{ construct: 'L-DRY', index: 1 }], 'p-gran-clear@L-DRY=1'))).toBe(framesProblem);
    // The index given as text: a whole number is a JSON number.
    expect(await orderProblem(mbr, final, inst('p-gran-clear', [{ construct: 'R-SUBLOT', index: '1' }], 'p-gran-clear@R-SUBLOT=1'))).toBe(framesProblem);
    // A node the tree does not have (no list of constructs), or no frames at all: nothing fits (fail closed).
    expect(await one<boolean>("select recipe.frames_fit(recipe.flow_within(recipe.flow_tree($1::jsonb), 'p-not-in-the-mbr'), '[]'::jsonb) as v", [mbr])).toBe(false);
    expect(await one<boolean>("select recipe.frames_fit(recipe.flow_within(recipe.flow_tree($1::jsonb), 'p-disp-bal'), null::jsonb) as v", [mbr])).toBe(false);
    expect(await one<boolean>("select recipe.frames_fit(recipe.flow_within(recipe.flow_tree($1::jsonb), 'p-disp-bal'), '[]'::jsonb) as v", [mbr])).toBe(true);
  }, 300_000);

  it('[DI-34][PR-13] a step of a sub-lot needs the count the replicate section decided: no decided count, no sub-lot', async () => {
    const { run, final } = golden();
    const undecided = structuredClone(final);
    delete decisionsOf(undecided)['R-SUBLOT@'];
    expect(await orderProblem(run.def.mbr, undecided, stepsOf(final)['p-gran-clear@R-SUBLOT=1'])).toBe('sub-lot 1 of R-SUBLOT is not one its decided count gives');
    expect(await orderProblem(run.def.mbr, final, stepsOf(final)['p-gran-clear@R-SUBLOT=1'])).toBeNull();
  }, 300_000);

  it('[DI-34][PR-13] inside the branch an alternative took, the steps before the instance must be finished: a step of that branch in progress holds the token back', async () => {
    const { run, final } = golden();
    expect(decisionsOf(final)['ALT-IPA@R-SUBLOT=2']?.['outcome'], 'SETUP: sub-lot 2 took the extra IPA').toBe('b-extra-ipa');
    const s = structuredClone(final);
    const ipa = stepsOf(s)['p-extra-ipa@R-SUBLOT=2'] as Json;
    ipa['status'] = 'IN_PROGRESS';
    delete ipa['firstCompletedSeq'];
    expect(await orderProblem(run.def.mbr, s, stepsOf(final)['p-wetmass@R-SUBLOT=2'])).toBe('ALT-IPA comes before it and has not been left: step p-extra-ipa@R-SUBLOT=2 is in progress');
    expect(await orderProblem(run.def.mbr, final, stepsOf(final)['p-wetmass@R-SUBLOT=2'])).toBeNull();
  }, 300_000);

  it('[DI-34][PR-13][INV-19] the invariant query\'s form: a step first finished at the very sequence number the next one was enabled at came before it', async () => {
    const { run, final } = golden();
    const bal = stepsOf(final)['p-disp-bal@'] as Json;
    const enabled = bal['enabledSeq'] as number;
    const s = structuredClone(final);
    (stepsOf(s)['p-disp-clear@'] as Json)['firstCompletedSeq'] = enabled;
    expect(await orderProblem(run.def.mbr, s, bal, enabled)).toBeNull();
    (stepsOf(s)['p-disp-clear@'] as Json)['firstCompletedSeq'] = enabled + 1;
    expect(await orderProblem(run.def.mbr, s, bal, enabled)).toBe(`p-disp-clear comes before it and has not been left: step p-disp-clear@ is first finished at ${enabled + 1}`);
  }, 300_000);

  it('[DI-34][PR-13][INV-19] a step after an alternative waits for the branch the alternative took, not for the constructs of the branch it did not take', async () => {
    // The untaken branch holds an operation with an alternative of its own, which is never decided.
    const mbr = mbrWith(
      seq('ops', phase('w', { records: ['m'] }), {
        kind: 'alternative', id: 'alt', decision: { mode: 'DATA' },
        branches: [
          {
            id: 'big', name: 'Big', guard: 'm > 5 [kg]',
            body: { kind: 'operation', id: 'O-BIG', name: 'Big charge', body: seq('big-seq', phase('pb'), {
              kind: 'alternative', id: 'alt2', decision: { mode: 'DATA' },
              branches: [{ id: 'x', name: 'Extra large', guard: 'm > 9 [kg]', body: phase('px') }, { id: 'y', name: 'Large', otherwise: true, body: phase('py') }],
            }) },
          },
          { id: 'small', name: 'Small', otherwise: true, body: phase('ps') },
        ],
      }, phase('end')),
      { parameters: [param('m')] },
    );
    const run = Run.issue(define(mbr));
    const start = run.state;
    done(run, 'w', { m: '3.00' });
    done(run, 'ps');
    expect(run.status('end'), 'SETUP: the step after the alternative is reached').toBe('ENABLED');
    expect(run.status('px'), 'SETUP: the untaken branch is not applicable').toBe('NOT_APPLICABLE');
    expect(await orderObjections(mbr, rowsOf(run, start))).toEqual({});
    // The alternative itself still has to be decided on the branch.
    const undecided = structuredClone(enc(run.state));
    delete decisionsOf(undecided)['alt@'];
    expect(await orderProblem(mbr, undecided, stepsOf(enc(run.state))['end@'])).toBe('alt comes before it and has not been left: alternative alt@ is not decided');
  }, 120_000);

  it('[IN-15][DI-34] a stage frame that is new in the row appears signed off only by its own accepted SIGN_OFF_STAGE', async () => {
    const stageProblem = (before: unknown, after: unknown, kind: string, accepted: boolean, command: unknown): Promise<string | null> =>
      one<string>('select recipe.stage_sign_off_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb) as v', [before, after, kind, accepted, command]);
    const signed = { 'S@L=2': { key: 'S@L=2', stage: 'S', frames: [{ construct: 'L', index: 2 }], signOff: { by: 'SUP1', signature: 'SIG-1', at: { $u: '1' }, valid: true } } };
    expect(await stageProblem({}, signed, 'COMMAND', true, { type: 'RECORD_ENTRY' })).toBe('the sign-off of stage S@L=2 changes in a row that does not sign it off');
    expect(await stageProblem({}, signed, 'COMMAND', true, { type: 'SIGN_OFF_STAGE', stage: 'S', context: [{ construct: 'L', index: 2 }] })).toBeNull();
  });
});

describe('F67: minimum durations measured within the constraint instance (0308 recipe.minimum_duration_problem, recipe.shared_constructs; INV-20, PR-30)', () => {
  it('[INV-20][PR-30][PR-45] a hold point released before a minimum ending in its release is refused; at exactly the minimum it is accepted', async () => {
    const mbr = mbrWith(seq('ops', phase('a'), hold('H'), phase('b')), {
      timeConstraints: [{ id: 'TC-H', name: 'Settling before release', kind: 'TIMER', from: { node: 'a', event: 'END' }, to: { node: 'H', event: 'END' }, min: { value: '10', unit: 'min' }, source, breach: 'EXCEPTION', pauses: 'INCLUDED' }],
    });
    const def = define(mbr);
    const run = Run.issue(def);
    done(run, 'a');
    run.minutes(4);
    const release: Command = { type: 'DISPOSITION_HOLD_POINT', commandId: 'C-RELEASE-H', actor: QA1, step: 'H', context: [], disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) };
    expect(run.refused(release).code).toBe('ENG-MIN-DURATION');
    expect(await minimumProblem(mbr, enc(run.state), enc(withoutMinimum(def, run.state, release, run.nowUs)))).toBe('end of H@ comes 4 min after the end of a, before the minimum of 10 min of Settling before release');
    run.minutes(6);
    const before = run.state;
    run.ok({ ...release, commandId: 'C-RELEASE-H-2' });
    expect(run.status('H')).toBe('COMPLETED');
    expect(await minimumProblem(mbr, enc(before), enc(run.state))).toBeNull();
  }, 120_000);

  it('[INV-20][PR-30][DI-27] a node event without a readable time is not measured here: the node-event check refuses it as malformed (EBMR-EXE-026)', async () => {
    const mbr = mbrWith(seq('ops', phase('a'), phase('b')), {
      timeConstraints: [{ id: 'TC-GAP', name: 'Wait before b', kind: 'TIMER', from: { node: 'a', event: 'START' }, to: { node: 'b', event: 'START' }, min: { value: '5', unit: 'min' }, source, breach: 'EXCEPTION', pauses: 'INCLUDED' }],
    });
    const event = (node: string, at: unknown): Json => ({ node, event: 'START', frames: [], at });
    const before = { nodeEvents: { 'a|START|': event('a', { $u: '1000000000' }) } };
    const after = (at: unknown): Json => ({ nodeEvents: { ...before.nodeEvents, 'b|START|': event('b', at) } });
    expect(await minimumProblem(mbr, before, after({ $u: '1060000000' }))).toBe('start of b@ comes 1 min after the start of a, before the minimum of 5 min of Wait before b');
    expect(await minimumProblem(mbr, before, after({ $u: 'soon' }))).toBeNull();
    expect(await minimumProblem(mbr, before, after({ $u: '1300000000' }))).toBeNull();
  });

  it('[INV-20][PR-30] the constraint instance is the frames of the constructs both ends share: none, the sub-lot, or the sub-lot and the loop iteration; unknown when an end is not in the procedure', async () => {
    const { run } = golden();
    const shared = (a: string, b: string): Promise<number | null> =>
      one<number>('select recipe.shared_constructs(recipe.flow_within(t.tree, $2), recipe.flow_within(t.tree, $3)) as v from (select recipe.flow_tree($1::jsonb) as tree) t', [run.def.mbr, a, b]);
    expect(await shared('p-drycycle', 'p-drycycle')).toBe(2);
    expect(await shared('p-drycycle', 'c-lod/lod-test')).toBe(2);
    expect(await shared('p-drycycle', 'p-gran-clear')).toBe(1);
    expect(await shared('p-gran-clear', 'p-drycycle')).toBe(1);
    expect(await shared('p-gran-clear', 'p-gran-clear')).toBe(1);
    expect(await shared('p-disp-bal', 'p-drycycle')).toBe(0);
    expect(await shared('p-not-in-the-mbr', 'p-drycycle')).toBeNull();
    expect(await shared('p-drycycle', 'p-not-in-the-mbr')).toBeNull();
  }, 300_000);
});

describe('F67: blocks reach what the execution graph reaches (0308 recipe.flow_reaches, recipe.blocking_exceptions_problem; PR-08, PR-13)', () => {
  it('[PR-08][PR-13] an anchor that opens a construct blocks what lies inside it and after it, not what came before; a loop reaches all of its body through its loop-back edge', async () => {
    const { run, final } = golden();
    const mbr = run.def.mbr;
    const reach = (from: string, inside: boolean, to: string): Promise<boolean | null> =>
      one<boolean>('select recipe.flow_reaches(recipe.flow_tree($1::jsonb), $2, $3, $4) as v', [mbr, from, inside, to]);
    expect(await reach('L-DRY', false, 'p-drycycle')).toBe(true);
    expect(await reach('L-DRY', false, 'c-lod/lod-test')).toBe(true);
    // A decision that could not be evaluated at the operator's choice of sub-lot 1 blocks its branches and what follows.
    const blocked = async (target: string, frames: Frames): Promise<string | null> =>
      one<string>('select recipe.blocking_exceptions_problem(recipe.flow_tree($1::jsonb), $2::jsonb, $3::jsonb, $4) as v', [
        mbr,
        { ...final, exceptions: { 'EX-9': {
          id: 'EX-9', type: 'DECISION_NOT_EVALUABLE', title: 'Extra IPA decision could not be evaluated', severity: 'ACTION', status: 'OPEN', deviationRequired: true,
          source: { stepKey: 'p-binder-add@R-SUBLOT=1', step: 'p-binder-add', frames: R(1) },
          block: { steps: [], until: 'DEVIATION', downstream: { node: 'xor-split:ALT-IPA', frames: R(1) } },
        } } },
        { key: `${target}@R-SUBLOT=${frames[0]?.index ?? 0}`, step: target, frames, status: 'ENABLED' },
        'START',
      ]);
    const message = (key: string) => `step ${key} cannot start while these exceptions are unresolved: EX-9 Extra IPA decision could not be evaluated (needs a linked deviation)`;
    expect(await blocked('p-extra-ipa', R(1))).toBe(message('p-extra-ipa@R-SUBLOT=1'));
    expect(await blocked('p-wetmass', R(1))).toBe(message('p-wetmass@R-SUBLOT=1'));
    expect(await blocked('p-binder-prep', R(1))).toBeNull();
    expect(await blocked('p-extra-ipa', R(2))).toBeNull();
  }, 300_000);
});

describe('F66 round 2: a status moves only by the act that moves it (0311 recipe.step_status_problem; DI-34, PR-13)', () => {
  const inst = (key: string, status: string): Json => ({ key, step: key.split('@')[0], kind: 'PHASE', frames: [], status });
  const steps = (s: Record<string, string>, points: Json = {}): Json => ({ steps: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, inst(k, v)])), points });
  const statusProblem = (before: unknown, after: unknown, command: unknown): Promise<string | null> =>
    one<string>('select recipe.step_status_problem($1::jsonb, $2::jsonb, $3, $4, $5::jsonb) as v', [before, after, 'COMMAND', true, command]);
  const moved = (k: string, a: string, b: string) => `moves step instance ${k} from ${a} to ${b}; the engine moves a step only along its life cycle, by the act that moves it`;

  it('[DI-34][PR-13][PR-14] a skip skips its own step, a verification completes its own step, an invalidation reopens its step for the re-test and nothing else', async () => {
    expect(await statusProblem(steps({ 'a@': 'ENABLED', 'b@': 'ENABLED' }), steps({ 'a@': 'SKIPPED', 'b@': 'SKIPPED' }), { type: 'REQUEST_SKIP', step: 'a', context: [] })).toBe(moved('b@', 'enabled', 'skipped'));
    expect(await statusProblem(steps({ 'a@': 'ENABLED', 'b@': 'ENABLED' }), steps({ 'a@': 'SKIPPED', 'b@': 'ENABLED' }), { type: 'REQUEST_SKIP', step: 'a', context: [] })).toBeNull();
    expect(await statusProblem(steps({ 'a@': 'AWAITING_VERIFICATION', 'b@': 'AWAITING_VERIFICATION' }), steps({ 'a@': 'COMPLETED', 'b@': 'COMPLETED' }), { type: 'VERIFY', step: 'a', context: [] })).toBe(
      moved('b@', 'awaiting verification', 'completed'),
    );
    const point = { 'DP-1': { id: 'DP-1', stepKey: 'a@' } };
    const invalidation = { type: 'INVALIDATE_RESULT', point: 'DP-1' };
    expect(await statusProblem(steps({ 'a@': 'COMPLETED' }, point), steps({ 'a@': 'IN_PROGRESS' }, point), invalidation)).toBeNull();
    expect(await statusProblem(steps({ 'a@': 'COMPLETED' }, point), steps({ 'a@': 'ENABLED' }, point), invalidation)).toBe(moved('a@', 'completed', 'enabled'));
    expect(await statusProblem(steps({ 'a@': 'AWAITING_VERIFICATION' }, point), steps({ 'a@': 'SKIPPED' }, point), invalidation)).toBe(moved('a@', 'awaiting verification', 'skipped'));
  });
});

describe('F67 rounds 2 and 3: the starts and ends the acts and the token record (0312, 0316 recipe.own_node_event_problem, recipe.flow_node_left, recipe.flow_content_left; INV-20, DI-27)', () => {
  it('[INV-20][DI-27][PR-14] a PERFORMED signature that leaves its step in progress (another person\'s entries still unsigned) ends nothing; the last one records the END', async () => {
    const mbr = mbrWith(seq('ops', phase('t', { records: ['h', 'g'] }), phase('z')), { parameters: [param('h'), param('g')] });
    const run = Run.issue(define(mbr));
    const start = run.state;
    run.start('t');
    run.record('t', 'h', { kind: 'DECIMAL', value: '5.00', unit: 'kg' });
    run.record('t', 'g', { kind: 'DECIMAL', value: '6.00', unit: 'kg' }, { who: OP2 });
    run.perform('t');
    expect(run.status('t'), 'SETUP: OP2 has not signed for its entry').toBe('IN_PROGRESS');
    expect(run.state.nodeEvents['t|END|']).toBeUndefined();
    run.perform('t', [], OP2);
    expect(run.state.nodeEvents['t|END|']).toBeDefined();
    run.verify('t');
    expect(await nodeEventObjections(mbr, rowsOf(run, start))).toEqual({});
  }, 120_000);

  it('[INV-20][DI-27][PR-45] a hold point not approved ends nothing (the batch goes on QA hold); a refused sign-off is not held to the END of its stage', async () => {
    const mbr = mbrWith(seq('ops', phase('a'), hold('H'), phase('b')));
    const run = Run.issue(define(mbr));
    const start = run.state;
    run.refused({ type: 'SIGN_OFF_STAGE', actor: SUP1, stage: 'S', context: [], signature: sig('STAGE_SIGNED_OFF', SUP1) });
    done(run, 'a');
    run.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H', context: [], disposition: 'NOT_APPROVED', signature: sig('HOLD_POINT_NOT_RELEASED', QA1) });
    expect(run.status('H'), 'SETUP: not released').toBe('ENABLED');
    const rows = rowsOf(run, start);
    expect(rows.some((r) => !r.accepted && (r.command as Json)['type'] === 'SIGN_OFF_STAGE'), 'SETUP: the refused sign-off is a row').toBe(true);
    expect(await nodeEventObjections(mbr, rows)).toEqual({});
  }, 120_000);

  it('[INV-20][DI-27] a loop\'s exit is new in the row also when the state before held no decisions at all: its END is required', async () => {
    const mbr = mbrWith(
      seq('ops', { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 3, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: seq('body', phase('dry'), phase('test', { records: ['ep'] })) }, phase('after')),
      { parameters: [endpoint('ep')] },
    );
    const run = Run.issue(define(mbr));
    const f = [{ construct: 'L', index: 1 }];
    done(run, 'dry', {}, f);
    run.start('test', f);
    run.record('test', 'ep', { kind: 'DECIMAL', value: '0.8', unit: '%' }, { frames: f });
    run.perform('test', f);
    run.verify('test', f);
    const before = enc(run.state);
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f });
    const after = enc(run.state);
    expect(decisionsOf(after)['L@L=1']?.['outcome'], 'SETUP: the loop exits').toBe('EXIT');
    const command = encodeCommand(run.log[run.log.length - 1]?.command as Command);
    const noEnd = structuredClone(after);
    delete (noEnd['nodeEvents'] as Json)['L|END|'];
    const noDecisions = structuredClone(before);
    delete noDecisions['decisions'];
    expect(await nodeEventProblem(mbr, { kind: 'COMMAND', accepted: true, command, before: noDecisions, after: noEnd })).toBe('ends loop L (EXIT) but records no END event of it (L|END|)');
    expect(await nodeEventProblem(mbr, { kind: 'COMMAND', accepted: true, command, before, after })).toBeNull();
  }, 120_000);

  it('[INV-20][DI-27][DI-34][INV-19] only an iteration of a loop ends the loop: a branch of an alternative inside it may be named EXIT, and choosing that branch records no END of the loop or of the alternative', async () => {
    // A validated MBR: the operator's choice inside the mixing loop names its branches as the author chose, here EXIT
    // (discharge through the exit chute) and RECYCLE. The choice is a decision of the alternative in the iteration's
    // frames; the loop's END comes with the COMPLETE_LOOP_ITERATION whose exit condition holds (0312 header item 5).
    const pinned = mbrWith(seq('none')).references;
    const mbr = mbrWith(
      seq('ops', {
        kind: 'loop', id: 'L', name: 'Mix until uniform', maxIterations: 3, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' },
        body: seq('body', phase('mix'), {
          kind: 'alternative', id: 'ROUTE', decision: { mode: 'OPERATOR_CHOICE', roles: ['PRODUCTION_SUPERVISOR'], reasonRequired: true },
          branches: [{ id: 'EXIT', name: 'Discharge through the exit chute', body: phase('chute') }, { id: 'RECYCLE', name: 'Back to the mixer', body: phase('recycle') }],
        }, phase('test', { records: ['ep'], system: { kind: 'OTHER', ref: 'SYS-LOD' } })),
      }, phase('after')),
      {
        parameters: [endpoint('ep')],
        references: [...pinned, { id: 'VR', kind: 'VALIDATION_REPORT', code: 'VR-MIX', version: '1', hash: 'b'.repeat(64) }, { id: 'SYS-LOD', kind: 'COMPUTERISED_SYSTEM', code: 'CS-LOD', version: '1', hash: 'c'.repeat(64) }],
      },
    );
    expect(errors(validate(mbr)), 'SETUP: the validator passes the MBR').toEqual([]);
    const run = Run.issue(define(mbr));
    const start = run.state;
    const f = [{ construct: 'L', index: 1 }];
    done(run, 'mix', {}, f);
    run.ok({ type: 'CHOOSE_ALTERNATIVE', actor: SUP1, construct: 'ROUTE', context: f, branch: 'EXIT', reason: 'Granules discharged through the exit chute' });
    expect(decisionsOf(enc(run.state))['ROUTE@L=1']?.['outcome'], 'SETUP: the branch named EXIT is taken').toBe('EXIT');
    expect(Object.keys(run.state.nodeEvents).filter((k) => k.startsWith('L|') || k.startsWith('ROUTE|')), 'the choice ends nothing').toEqual(['L|START|', 'ROUTE|START|L=1']);
    done(run, 'chute', {}, f);
    run.start('test', f);
    run.record('test', 'ep', { kind: 'DECIMAL', value: '0.8', unit: '%' }, { frames: f });
    run.perform('test', f);
    run.verify('test', f);
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'L', context: f });
    expect(decisionsOf(enc(run.state))['L@L=1']?.['outcome'], 'SETUP: the loop exits').toBe('EXIT');
    done(run, 'after');
    expect(run.state.nodeEvents['L|END|']).toBeDefined();
    expect(await nodeEventObjections(mbr, rowsOf(run, start))).toEqual({});
  }, 120_000);

  it('[INV-20][DI-27][DI-34] inside a sub-lot, a step brought in after an operation needs the END of every construct the token went through inside it (0314)', async () => {
    const { run, start } = golden();
    const rows = rowsOf(run, start);
    const arrival = rows.find((r) => (stepsOf(r.after)['p-binder-add@R-SUBLOT=1'] ?? {})['status'] === 'ENABLED' && !('p-binder-add@R-SUBLOT=1' in ((r.before['steps'] as Json | undefined) ?? {})));
    if (!arrival) throw new Error('SETUP: no row brings in p-binder-add@R-SUBLOT=1');
    expect(Object.keys(arrival.after['nodeEvents'] as Json), 'SETUP: the same row ends the parallel section').toContain('P-MIX|END|R-SUBLOT=1');
    const forged = structuredClone(arrival);
    delete (forged.after['nodeEvents'] as Json)['P-MIX|END|R-SUBLOT=1'];
    expect(await nodeEventProblem(run.def.mbr, forged)).toBe(
      'brings in step p-binder-add@R-SUBLOT=1, which comes after parallel P-MIX, but records no END event of that parallel (P-MIX|END|R-SUBLOT=1)',
    );
    expect(await nodeEventProblem(run.def.mbr, arrival)).toBeNull();
  }, 300_000);

  it('[INV-20][DI-27] the token has left a node: a phase finished (not one set not applicable), a library call whose body it left, a construct whose END is recorded; never an unknown node, never without node events', async () => {
    const { run, final } = golden();
    const mbr = run.def.mbr;
    const left = (s: Json, id: string, frames: Frames): Promise<boolean | null> =>
      one<boolean>('select recipe.flow_node_left(recipe.flow_tree($1::jsonb), $2::jsonb, $3, $4::jsonb) as v', [mbr, s, id, frames]);
    const dry = [...R(1), { construct: 'L-DRY', index: 1 }];
    expect(await left(final, 'p-gran-clear', R(1))).toBe(true);
    expect(await left(final, 'p-extra-ipa', R(1)), 'set not applicable').toBe(false);
    expect(await left(final, 'c-lod', dry)).toBe(true);
    const unfinished = structuredClone(final);
    const lod = stepsOf(unfinished)['c-lod/lod-test@R-SUBLOT=1/L-DRY=1'] as Json;
    lod['status'] = 'IN_PROGRESS';
    delete lod['firstCompletedSeq'];
    expect(await left(unfinished, 'c-lod', dry)).toBe(false);
    expect(await left(final, 'S-DISP', [])).toBe(true);
    expect(await left(final, 'p-not-in-the-mbr', [])).toBe(false);
    const noEvents = structuredClone(final);
    delete noEvents['nodeEvents'];
    expect(await left(noEvents, 'S-DISP', [])).toBe(false);
  }, 300_000);

  it('[INV-20][DI-27] the token has finished what a construct holds: every branch of a parallel section, the branch an alternative decided (an empty one at once), every sub-lot of the decided count; nothing for another kind of node', async () => {
    const { run, final } = golden();
    const mbr = run.def.mbr;
    const content = (s: Json, id: string, frames: Frames): Promise<boolean | null> =>
      one<boolean>('select recipe.flow_content_left(recipe.flow_tree($1::jsonb), $2::jsonb, $3, $4::jsonb) as v', [mbr, s, id, frames]);
    expect(await content(final, 'O-GRAN-PREP', R(1))).toBe(true);
    expect(await content(final, 'P-MIX', R(1))).toBe(true);
    expect(await content(final, 'ALT-IPA', R(1)), 'sub-lot 1 chose the empty branch').toBe(true);
    expect(await content(final, 'ALT-IPA', R(2)), 'sub-lot 2 took the extra IPA').toBe(true);
    expect(await content(final, 'R-SUBLOT', [])).toBe(true);
    expect(await content(final, 'S-DISP', []), 'a stage ends at its sign-off').toBe(false);
    const undecided = structuredClone(final);
    delete decisionsOf(undecided)['ALT-IPA@R-SUBLOT=1'];
    expect(await content(undecided, 'ALT-IPA', R(1))).toBe(false);
    const unreadable = structuredClone(final);
    (decisionsOf(unreadable)['R-SUBLOT@'] as Json)['outcome'] = 'two';
    expect(await content(unreadable, 'R-SUBLOT', [])).toBe(false);
  }, 300_000);

  it('[INV-20][DI-27][DI-34] a parallel section without a branch is never finished: its join has nothing to join (the validator refuses such a section, FLOW-CONSTRUCTS)', async () => {
    const empty = { kind: 'parallel', id: 'P', name: 'Nothing in parallel', branches: [] } as unknown as FlowNode;
    const mbr = mbrWith(seq('ops', phase('a'), empty, phase('b')));
    const s = { steps: {}, decisions: {}, nodeEvents: { 'P|START|': { node: 'P', event: 'START', frames: [], at: { $u: '1000000' } } } };
    expect(await one<boolean>('select recipe.flow_content_left(recipe.flow_tree($1::jsonb), $2::jsonb, $3, $4::jsonb) as v', [mbr, s, 'P', []])).toBe(false);
  });
});
