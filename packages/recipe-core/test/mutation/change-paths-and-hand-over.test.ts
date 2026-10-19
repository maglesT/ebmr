/**
 * The exception register's own helpers, rule by rule (SQL mutation group "change-paths-and-hand-over", recipe-core
 * 0440): which exceptions only QA may disposition, and the register row an exception record gives (refused when the
 * record is not an object or names a review category the register does not know). The register's paths through a
 * running batch are in apps/tablets-server/test/execution (db-guards-exception-register, -change-paths, -hand-over)
 * and apps/tablets-server/test/mutation/change-paths-and-hand-over.test.ts.
 *
 * The register row is written by a superuser with session_replication_role = replica (no foreign keys, no audit) in a
 * transaction that is always rolled back: what is under test is the function's own refusal and the row it builds.
 *
 * Controls: DI-26, PR-08, PR-13; invariant INV-41.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext } from '../../../kernel/src/db/command.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 180_000);
afterAll(async () => {
  await db.drop();
});

const qaOnly = async (x: unknown): Promise<boolean> => (await db.admin.query<{ r: boolean }>('select recipe.exception_qa_only($1::jsonb) as r', [JSON.stringify(x)])).rows[0]?.r ?? false;

async function replica<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

const COMMAND = (batch: string) =>
  JSON.stringify({ batch_id: batch, seq: 7, recorded_at: '2026-10-01T08:00:00Z', now_us: 1, actor_person: randomUUID(), correlation_id: randomUUID() });
const register = (c: pg.PoolClient, batch: string, id: string, x: unknown) =>
  c.query('select recipe.register_exception(jsonb_populate_record(null::recipe.execution_command, $1::jsonb), $2, $3::jsonb)', [COMMAND(batch), id, JSON.stringify(x)]);

describe('only QA dispositions (PR-08, INV-41)', () => {
  it('[PR-08][INV-41] an exception is QA-only for the engine\'s flag, a REGISTERED or VALIDATED tier, or a decision-affecting correction, and for nothing else', async () => {
    expect(await qaOnly({})).toBe(false);
    expect(await qaOnly({ qaOnly: false, tier: 'ALERT', type: 'LIMIT_EXCURSION' })).toBe(false);
    expect(await qaOnly({ tier: 'INTERNAL_ACTION' })).toBe(false);
    expect(await qaOnly({ type: 'CORRECTION' })).toBe(false);
    expect(await qaOnly({ qaOnly: true })).toBe(true);
    expect(await qaOnly({ tier: 'REGISTERED' })).toBe(true);
    expect(await qaOnly({ tier: 'VALIDATED' })).toBe(true);
    expect(await qaOnly({ type: 'DECISION_AFFECTING_CORRECTION' })).toBe(true);
  });
});

describe('the register row of an exception record (DI-26)', () => {
  it('[DI-26][INV-41] a record that is not an object, or names an unknown review category, is refused with EXE-160', async () => {
    const batch = randomUUID();
    await replica(async (c) => {
      await expect(register(c, batch, 'X1', 'not an object')).rejects.toThrow(/is not an exception record.*EBMR-EXE-160/);
    });
    await replica(async (c) => {
      await expect(register(c, batch, 'X2', { category: 'NO_SUCH_CATEGORY', severity: 'ALERT' })).rejects.toThrow(/review category NO_SUCH_CATEGORY, which the register does not know.*EBMR-EXE-160/);
    });
  });

  it('[DI-26][PR-13] the row records the flags the record carries, false where it carries none', async () => {
    const batch = randomUUID();
    const row = async (x: Record<string, unknown>): Promise<Record<string, boolean> | undefined> =>
      replica(async (c) => {
        await register(c, batch, 'X3', x);
        return (
          await c.query<Record<string, boolean>>('select mandatory, qa_only, deviation_required, registration_relevant, release_blocking from recipe.exception_register where batch_id = $1', [batch])
        ).rows[0];
      });
    expect(await row({ category: 'FLOW', severity: 'ALERT', type: 'LOOP' })).toEqual({
      mandatory: true,
      qa_only: false,
      deviation_required: false,
      registration_relevant: false,
      release_blocking: false,
    });
    expect(await row({ category: 'FLOW', severity: 'ALERT', type: 'LOOP', deviationRequired: true, registrationRelevant: true, releaseBlocking: true })).toEqual({
      mandatory: true,
      qa_only: false,
      deviation_required: true,
      registration_relevant: true,
      release_blocking: true,
    });
  });
});

describe('recipe.check_approver_roles (recipe-core 0462): an approval is signed in the role the command asks', () => {
  /** The refusal for `refs` of a command of `type`; '' when none. The signatures named here hold no engine role. */
  const check = async (type: string, refs: unknown[]): Promise<string> => {
    try {
      await db.admin.query('select recipe.check_approver_roles($1, $2::jsonb)', [type, JSON.stringify(refs)]);
      return '';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const sig = (part: string) => ({ part, signer: 'Test Signer', ref: { id: randomUUID() } });

  it('[PR-14][DI-17][DI-35] a hand-over is signed by a production supervisor and approved by the quality unit', async () => {
    expect(await check('HAND_OVER_STEP', [sig('signature')])).toMatch(/The hand-over is signed by Test Signer, who held no engine role when signing; a hand-over is signed by a production supervisor .*\[EBMR-EXE-171\]/);
    expect(await check('HAND_OVER_STEP', [sig('approval')])).toMatch(/The approval of this HAND_OVER_STEP is signed by Test Signer, who held no engine role when signing; it is approved only by QA or QA_REVIEWER/);
  });

  it('[PR-13][DI-35] an abort is approved by the head of production and by QA; a correction by a supervisor or QA; a command the release does not check takes no approval', async () => {
    expect(await check('ABORT_BATCH', [sig('approval')])).toMatch(/The abort approval signed by Test Signer is neither the head of production's nor QA's .*\[EBMR-EXE-171\]/);
    expect(await check('ABORT_BATCH', [])).toMatch(/An abort is approved by the head of production and by QA, two different persons .*\[EBMR-EXE-171\]/);
    expect(await check('CORRECT_ENTRY', [sig('approval')])).toMatch(/it is approved only by PRODUCTION_SUPERVISOR or HEAD_OF_PRODUCTION or QA, as S25 and S28 ask/);
    expect(await check('VOID_ATTEMPT', [sig('approval')])).toMatch(/it is approved only by QA, as S25/);
    expect(await check('START_STEP', [sig('approval')])).toMatch(/START_STEP carries an approval this release does not check .*\[EBMR-EXE-171\]/);
    // Without approvals or signatures there is nothing to check, except for an abort.
    expect(await check('CORRECT_ENTRY', [])).toBe('');
    expect(await check('HAND_OVER_STEP', [])).toBe('');
  });
});

describe('recipe.review_exception on the only GMP batch of a database (recipe-core 1217; D-P7-1 item 4)', () => {
  it('[INV-30][DI-26] a query on a GMP batch before its production approval is refused even when no other GMP batch exists', async () => {
    // This database holds no GMP batch: one is written here (a GMP row, its exception) with the triggers off, and QA's
    // query asked in the same transaction, which is rolled back.
    const qa = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Only-batch QA' });
    const ctx = await cmd(db, qa, { reasonCode: 'TEST', reasonText: 'query on the only GMP batch' });
    const batch = randomUUID();
    const outcome = await replica(async (c) => {
      expect((await c.query("select count(*)::int as n from recipe.batch_execution where installation = 'GMP'")).rows[0]).toEqual({ n: 0 });
      await c.query(
        `insert into recipe.batch_execution (id, batch_number, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash,
                                             issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account,
                                             correlation_id, control_recipe_id, issue_signature_id)
         values ($1, 'ONLY-0001', $2, 'GMP', 'GMP_BATCH', 'fixture', $2, '{}', $2, '{}', '{IN}', 'BS-1', 'SITE-1', 'Asia/Kolkata', 0, $3, $3, $3, $4, $5)`,
        [batch, 'a'.repeat(64), randomUUID(), randomUUID(), randomUUID()],
      );
      await register(c, batch, 'X9', { category: 'FLOW', severity: 'ALERT', type: 'LOOP' });
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
      try {
        await c.query("select recipe.review_exception($1, 'X9', 'QUERIED', 'Why did the flow loop?', null)", [batch]);
        return 'ok';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(outcome).toMatch(/^EBMR-REV-065 the record is \S+; on a GMP batch a query and its answer belong to the QA review, after the production approval/);
  });
});

describe('recipe.review_exception reads the involvement from this batch\'s own state (recipe-core 1217; D-P7-1 item 4)', () => {
  it('[INV-03][DI-26] a person who performed the exception\'s raising step does not conclude its review, though neither raiser nor disposer', async () => {
    const qa = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Step-performer QA' });
    const ctx = await cmd(db, qa, { reasonCode: 'TEST', reasonText: 'escalation by a performer of the step' });
    const batch = randomUUID();
    const hex = 'b'.repeat(64);
    const outcome = await replica(async (c) => {
      await c.query(
        `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash,
                                             issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id)
         values ($1, 'TEST-INV-0001', $2, $2, 'SANDBOX', 'SANDBOX_TEST_RUN', 'fixture', $2, '{}', $2, '{}', '{IN}', 'BS-1', 'SITE-1', 'Asia/Kolkata', 0, $3, $3, $3)`,
        [batch, hex, randomUUID()],
      );
      const state = { exceptions: { X9: { source: { stepKey: 'S1' } } }, steps: { S1: { performers: [qa.personId] } }, points: {} };
      await c.query(
        `insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status)
         values ($1, $2::jsonb, 1, $3, 1, $3, 'IN_PROGRESS')`,
        [batch, JSON.stringify(state), hex],
      );
      await register(c, batch, 'X9', { category: 'FLOW', severity: 'ALERT', type: 'LOOP' });
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
      try {
        await c.query("select recipe.review_exception($1, 'X9', 'ESCALATED', 'Loop needs a deviation', 'TEST-DEV-0001')", [batch]);
        return 'ok';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(outcome).toMatch(/raised, worked in the step of, or dispositioned exception X9, so they cannot conclude its review \(INV-03, DI-26\)\. \[EBMR-EXE-165\]$/);
  });
});
