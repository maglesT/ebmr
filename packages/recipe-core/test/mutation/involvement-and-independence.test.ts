/**
 * Who was involved in what, and whether the run moved on, read by the pure functions of the store (SQL mutation group
 * "involvement-and-independence": recipe-core 0210, 0306, 0315). These tests close the gaps the SQL mutation run
 * (tools/sql-mutation) left in the group's tests, which only reached these functions through ordinary runs:
 *   - recipe.command_step_key (0315): the step instance a command acts on is the step and context of a command the
 *     engine gives a step, or the step of the data point a CORRECT_ENTRY or INVALIDATE_RESULT names as the stored state
 *     records it; a command of any other type, a point that is not a string id, and a point whose stored step is not a
 *     string give no step (INV-03, PR-13, PR-49);
 *   - recipe.next_step_started (0210): the run moved on after the act of a step instance when another instance started,
 *     or a block entry or a data point of another instance was recorded, at or after the act's end; a tie counts as
 *     moved on (fail closed), the instance's own entries and points and anything recorded before the end never do
 *     (DI-35, PR-14: a witness can no longer watch the act, EBMR-ESIG-051);
 *   - recipe.execution_violations (0306, 0503): in a GMP database, a test package is reported with exactly the SANDBOX_ONLY
 *     block versions its content holds, never one it does not hold (DI-05, INV-18); since slice 2b a GMP database issues
 *     GMP batches, and the same reading (recipe.sandbox_only_blocks_in, 0500) keeps SANDBOX_ONLY blocks out of their
 *     control recipes.
 *
 * The functions are private to the owner (the store's guards and the content provider call them); the tests call them
 * as the superuser, as the module tests do, with the commands and states the engine writes or a forgery of them (a row
 * landed by a restore is read by the same functions). The kernel's template database is a GMP installation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { encodeCommand, stepKey, type Command } from '../../src/engine/index.ts';
import { loadFixture } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

const PERSON = '11111111-1111-4111-8111-111111111111';
const SIG = '22222222-2222-4222-8222-222222222222';
const actor = { id: PERSON, kind: 'PERSON' as const, roles: ['PRODUCTION_OPERATOR'] };
const signature = (meaning: string) => ({ id: SIG, meaning, signer: PERSON });
const LOOP = [{ construct: 'L-DRY', index: 2 }];

describe('recipe.command_step_key: the step instance a command acts on (INV-03, PR-13, PR-49)', () => {
  /** recipe.command_step_key of the recorded command (its own type), the stored state's data points being `points`. */
  async function keyOf(command: unknown, points: unknown = {}, type?: string): Promise<string | null> {
    const recorded = command as Json;
    const { rows } = await db.admin.query<{ k: string | null }>('select recipe.command_step_key($1, $2::jsonb, $3::jsonb) as k', [
      type ?? recorded['type'],
      JSON.stringify(recorded),
      JSON.stringify(points),
    ]);
    return rows[0]?.k ?? null;
  }
  const points = { 'PT-1': { id: 'PT-1', item: 'lod', stepKey: stepKey('p-lod', LOOP), step: 'p-lod', frames: LOOP } };

  it('[INV-03][PR-13][PR-49] each command the engine gives a step names that step instance, a correction or an invalidation the step its data point was recorded at, and every other command none', async () => {
    const at = { step: 'p-lod', context: LOOP };
    const commands: Command[] = [
      { type: 'START_STEP', commandId: 'C-1', actor, ...at },
      { type: 'RECORD_DATA', commandId: 'C-2', actor, ...at, item: 'lod', value: { kind: 'DECIMAL', value: '2.1', unit: '%' }, source: { mode: 'MANUAL' } },
      { type: 'RECORD_ENTRY', commandId: 'C-3', actor, ...at, entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } },
      { type: 'SIGN_PERFORMED', commandId: 'C-4', actor, ...at, signature: signature('PERFORMED') },
      { type: 'VERIFY', commandId: 'C-5', actor, ...at, signature: signature('VERIFIED') },
      { type: 'REQUEST_SKIP', commandId: 'C-6', actor, ...at, reason: 'Not needed', approval: { approver: actor, signature: signature('SKIP_APPROVED') } },
      { type: 'DISPOSITION_HOLD_POINT', commandId: 'C-7', actor, ...at, disposition: 'APPROVED', signature: signature('HOLD_RELEASED') },
      { type: 'VOID_ATTEMPT', commandId: 'C-8', actor, ...at, item: 'lod', reason: 'Sample spilled' },
      { type: 'RAISE_EXCEPTION', commandId: 'C-9', actor, ...at, description: 'Dryer door ajar', severity: 'ALERT' },
      { type: 'CORRECT_ENTRY', commandId: 'C-10', actor, point: 'PT-1', value: { kind: 'DECIMAL', value: '2.2', unit: '%' }, reason: 'Typo', signature: signature('CORRECTED') },
      { type: 'INVALIDATE_RESULT', commandId: 'C-11', actor, point: 'PT-1', investigationRef: 'TEST-INV-1', assignableCause: 'The investigation found an assignable cause', reason: 'Assignable cause', approval: { approver: actor, signature: signature('INVALIDATION_APPROVED') } },
      // Commands that act on no step.
      { type: 'RAISE_EXCEPTION', commandId: 'C-12', actor, description: 'Label printer jammed', severity: 'ALERT' },
      { type: 'CHOOSE_ALTERNATIVE', commandId: 'C-13', actor, construct: 'A-1', context: LOOP, branch: 'B-1', reason: 'Dry route' },
      { type: 'SIGN_OFF_STAGE', commandId: 'C-14', actor, stage: 'S-1', context: LOOP, signature: signature('STAGE_SIGNED_OFF') },
      { type: 'DISPOSITION_EXCEPTION', commandId: 'C-15', actor, exception: 'EX-1', outcome: 'NO_IMPACT', justification: 'No impact', signature: signature('EXCEPTION_DISPOSITIONED') },
      { type: 'ATTACH_DEVIATION', commandId: 'C-16', actor, exception: 'EX-1', deviationRef: 'TEST-DEV-0001' },
    ];
    const keys: Record<string, string | null> = {};
    for (const c of commands) keys[`${c.commandId} ${c.type}`] = await keyOf(encodeCommand(c), points);
    const dryer = 'p-lod@L-DRY=2';
    expect(keys).toEqual({
      'C-1 START_STEP': dryer, 'C-2 RECORD_DATA': dryer, 'C-3 RECORD_ENTRY': dryer, 'C-4 SIGN_PERFORMED': dryer, 'C-5 VERIFY': dryer,
      'C-6 REQUEST_SKIP': dryer, 'C-7 DISPOSITION_HOLD_POINT': dryer, 'C-8 VOID_ATTEMPT': dryer, 'C-9 RAISE_EXCEPTION': dryer,
      'C-10 CORRECT_ENTRY': dryer, 'C-11 INVALIDATE_RESULT': dryer,
      'C-12 RAISE_EXCEPTION': null, 'C-13 CHOOSE_ALTERNATIVE': null, 'C-14 SIGN_OFF_STAGE': null, 'C-15 DISPOSITION_EXCEPTION': null, 'C-16 ATTACH_DEVIATION': null,
    });
  });

  it('[INV-03][PR-13][PR-49] a command that acts on no step names none even when its recorded JSON carries a step or a point, and a correction names none when its point is not a string id or the stored point names no step as a string (fail closed: a restore landed it so)', async () => {
    const choose = encodeCommand({ type: 'CHOOSE_ALTERNATIVE', commandId: 'C-1', actor, construct: 'A-1', context: [], branch: 'B-1', reason: 'Dry route' }) as Json;
    const attach = encodeCommand({ type: 'ATTACH_DEVIATION', commandId: 'C-2', actor, exception: 'EX-1', deviationRef: 'TEST-DEV-0001' }) as Json;
    const correct = encodeCommand({ type: 'CORRECT_ENTRY', commandId: 'C-3', actor, point: 'PT-1', value: { kind: 'DECIMAL', value: '2.2', unit: '%' }, reason: 'Typo', signature: signature('CORRECTED') }) as Json;
    const outcomes = {
      // A step member on a command type that acts on no step.
      chooseWithStep: await keyOf({ ...choose, step: 'p-lod', context: [] }, points),
      // A point member on a command type that is neither a correction nor an invalidation.
      attachWithPoint: await keyOf({ ...attach, point: 'PT-1' }, points),
      // A correction whose point is a number that a stored point's key spells.
      numericPoint: await keyOf({ ...correct, point: 1 }, { '1': { id: '1', stepKey: 'p-lod@' } }),
      // A correction of a point whose stored step is not a string.
      numericStepKey: await keyOf(correct, { 'PT-1': { id: 'PT-1', stepKey: 7 } }),
      objectStepKey: await keyOf(correct, { 'PT-1': { id: 'PT-1', stepKey: { key: 'p-lod@' } } }),
      unknownPoint: await keyOf(correct, {}),
      // The honest correction of the same point.
      honest: await keyOf(correct, points),
    };
    expect(outcomes).toEqual({
      chooseWithStep: null,
      attachWithPoint: null,
      numericPoint: null,
      numericStepKey: null,
      objectStepKey: null,
      unknownPoint: null,
      honest: 'p-lod@L-DRY=2',
    });
  });
});

describe('recipe.next_step_started: the run moved on after an act (DI-35, PR-14)', () => {
  const ENDED = 1_790_581_503_000_000n;
  const us = (n: bigint) => ({ $u: n.toString() });
  const OWN = 'p-disp-clear@';
  const NEXT = 'p-disp-bal@';

  /** recipe.next_step_started of a state holding only `parts` (steps, entries, points as the engine encodes them). */
  async function movedOn(parts: Json, ended: bigint | null = ENDED, key = OWN): Promise<boolean | null> {
    const { rows } = await db.admin.query<{ b: boolean | null }>('select recipe.next_step_started($1::jsonb, $2, $3::bigint) as b', [
      JSON.stringify({ steps: {}, entries: {}, points: {}, ...parts }),
      key,
      ended === null ? null : ended.toString(),
    ]);
    return rows[0]?.b ?? null;
  }
  const own = { key: OWN, step: 'p-disp-clear', status: 'COMPLETED', startedAt: us(ENDED - 60_000_000n), endedAt: us(ENDED) };
  const instance = (startedAt: bigint) => ({ [OWN]: own, [NEXT]: { key: NEXT, step: 'p-disp-bal', status: 'IN_PROGRESS', startedAt: us(startedAt) } });
  const entry = (stepKey: string, recordedAt: bigint) => ({ 'EN-1': { id: 'EN-1', stepKey, kind: 'EQUIPMENT_STATUS', data: {}, enteredBy: PERSON, recordedAt: us(recordedAt), recordedSeq: 9 } });
  const point = (stepKey: string, recordedAt: bigint) => ({
    'PT-1': { id: 'PT-1', item: 'balanceCheck', stepKey, step: stepKey.split('@')[0], frames: [], kind: 'VALUE', status: 'VALID', enteredBy: PERSON, recordedAt: us(recordedAt), recordedSeq: 9 },
  });

  it('[DI-35][PR-14] another step instance started in the very microsecond the act ended counts as moved on (a tie fails closed); one started before it does not', async () => {
    expect({
      startedAtTheEnd: await movedOn({ steps: instance(ENDED) }),
      startedAfter: await movedOn({ steps: instance(ENDED + 1n) }),
      startedBefore: await movedOn({ steps: instance(ENDED - 1n) }),
      onlyItself: await movedOn({ steps: { [OWN]: own } }),
      noEnd: await movedOn({ steps: instance(ENDED) }, null),
    }).toEqual({ startedAtTheEnd: true, startedAfter: true, startedBefore: false, onlyItself: false, noEnd: false });
  });

  it('[DI-35][PR-14] a block entry of another step instance recorded at or after the end counts as moved on, without any step started; the instance\'s own entries and an entry recorded before the end never do', async () => {
    expect({
      otherAtTheEnd: await movedOn({ steps: instance(ENDED - 5n), entries: entry(NEXT, ENDED) }),
      otherAfter: await movedOn({ steps: instance(ENDED - 5n), entries: entry(NEXT, ENDED + 1n) }),
      otherBefore: await movedOn({ steps: instance(ENDED - 5n), entries: entry(NEXT, ENDED - 1n) }),
      ownAfter: await movedOn({ steps: { [OWN]: own }, entries: entry(OWN, ENDED + 1_000_000n) }),
    }).toEqual({ otherAtTheEnd: true, otherAfter: true, otherBefore: false, ownAfter: false });
  });

  it('[DI-35][PR-14] a data point of another step instance recorded at or after the end counts as moved on, without any step started or entry recorded; the instance\'s own points and a point recorded before the end never do', async () => {
    expect({
      otherAtTheEnd: await movedOn({ steps: instance(ENDED - 5n), points: point(NEXT, ENDED) }),
      otherAfter: await movedOn({ steps: instance(ENDED - 5n), points: point(NEXT, ENDED + 1n) }),
      otherBefore: await movedOn({ steps: instance(ENDED - 5n), points: point(NEXT, ENDED - 1n) }),
      ownAfter: await movedOn({ steps: { [OWN]: own }, points: point(OWN, ENDED + 1_000_000n) }),
    }).toEqual({ otherAtTheEnd: true, otherAfter: true, otherBefore: false, ownAfter: false });
  });
});

describe('recipe.execution_violations in a GMP database: the SANDBOX_ONLY blocks a test package holds, kept out of GMP control recipes (DI-05, INV-18)', () => {
  /** A copy of `content` without the steps whose block is one of `types` (anywhere in the procedure). */
  function without(content: unknown, types: readonly string[]): unknown {
    if (Array.isArray(content)) {
      return content
        .filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Json)['block'] as Json | undefined)?.['type']))))
        .map((x) => without(x, types));
    }
    if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
    return content;
  }

  /** The block versions `content` holds, as `type@version`. */
  function blocksOf(content: unknown, into = new Set<string>()): Set<string> {
    if (Array.isArray(content)) for (const x of content) blocksOf(x, into);
    else if (content && typeof content === 'object') {
      const b = (content as Json)['block'] as Json | undefined;
      if (b && typeof b['type'] === 'string') into.add(`${b['type']}@${String(b['version'])}`);
      for (const v of Object.values(content)) blocksOf(v, into);
    }
    return into;
  }

  it('[DI-05][INV-18] packages landed in a GMP database behind the writers\' back are each reported with exactly the SANDBOX_ONLY block versions their content holds: both, one, or none', async () => {
    const { rows: sandboxOnly } = await db.admin.query<{ b: string }>("select block_type || '@' || block_version as b from recipe.sandbox_only_block order by 1");
    expect(sandboxOnly.map((r) => r.b), 'SETUP: the SANDBOX_ONLY blocks of Phase 2').toEqual(['G-09@1', 'G-10@1']);
    const full = loadFixture('tablet-granulation-compression') as unknown;
    const packages = {
      ['a'.repeat(64)]: full,
      ['b'.repeat(64)]: without(full, ['G-09']),
      ['c'.repeat(64)]: without(full, ['G-09', 'G-10']),
    };
    // Each package holds exactly the SANDBOX_ONLY blocks it is named for, and every one still holds other blocks of
    // version 1, the version of the SANDBOX_ONLY ones.
    const held = Object.values(packages).map((c) => [...blocksOf(c)].sort());
    expect(held.map((bs) => bs.filter((b) => sandboxOnly.some((r) => r.b === b)))).toEqual([['G-09@1', 'G-10@1'], ['G-10@1'], []]);
    for (const bs of held) expect(bs.filter((b) => b.endsWith('@1') && !sandboxOnly.some((r) => r.b === b)).length).toBeGreaterThan(3);
    const admin = await db.admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      for (const [hash, content] of Object.entries(packages)) {
        await admin.query(
          `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                            revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
           values ($1, $1 || '.json', '{}', $2::jsonb, $1, gen_random_uuid(), 'PCM500-DC', '{}', gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
                   gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
          [hash, JSON.stringify(content)],
        );
      }
      await admin.query('commit');
    } finally {
      admin.release();
    }
    const { rows } = await db.admin.query<{ batch_id: string | null; problem: string }>('select batch_id, problem from recipe.execution_violations()');
    const sandboxBlocks = rows.filter((r) => r.problem.startsWith('SANDBOX_ONLY')).map((r) => r.problem).sort();
    expect(sandboxBlocks).toEqual([
      `SANDBOX_ONLY block G-09@1 in package ${'a'.repeat(64)} held by a GMP database (DI-05, INV-18)`,
      `SANDBOX_ONLY block G-10@1 in package ${'a'.repeat(64)} held by a GMP database (DI-05, INV-18)`,
      `SANDBOX_ONLY block G-10@1 in package ${'b'.repeat(64)} held by a GMP database (DI-05, INV-18)`,
    ]);
    expect(rows.filter((r) => r.problem.startsWith('test package')).map((r) => r.problem).sort()).toEqual(
      Object.keys(packages).map((h) => `test package ${h} exists in a GMP database (DI-05, INV-18)`),
    );
    // The reading that keeps them out of a GMP batch's control recipe (recipe-core 0500) names exactly the same blocks.
    const read = await db.admin.query<{ b: string[] }>('select recipe.sandbox_only_blocks_in(x) as b from unnest($1::jsonb[]) x', [Object.values(packages).map((c) => JSON.stringify(c))]);
    expect(read.rows.map((r) => r.b)).toEqual([['G-09@1', 'G-10@1'], ['G-10@1'], []]);
  });
});
