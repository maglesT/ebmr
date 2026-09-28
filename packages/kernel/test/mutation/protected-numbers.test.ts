/**
 * Protected numbers and the restore procedure, guard by guard (SQL mutation group "protected-numbers":
 * continuity.next_counter_value, prepare_counter_reservation, counter_scope, reserve_counter_ceiling,
 * secure_identifiers, approve_restore_event, restore_event_is_approved, after_restore,
 * compare_external_anchors and verify_external_anchors in kernel 0600). The scenario tests in
 * continuity/numbers.test.ts, continuity/restore.test.ts and continuity/anchors.test.ts go through the
 * TypeScript wrappers, which check some conditions themselves before the database sees them; these
 * tests call the database functions directly, so every refusal is proven where it is enforced, with
 * its own error message.
 *
 * Controls: DI-45 (restore procedure, two persons, signed approval), DI-37 (the approval is the
 * approver's own signature), DI-17 (a counter's ceilings are reserved only under a grant covering its
 * scope); invariants INV-27 (identifiers are never reused, including after a restore), INV-08 (a
 * restore event covers a gap only once approved, and only for history it discarded) and INV-03 (the
 * operator never approves their own restore).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileLedger } from '../../src/continuity/ledger.ts';
import { reserveCounterBlock } from '../../src/continuity/numbers.ts';
import { approveRestoreEvent, recordRestoreEvent } from '../../src/continuity/restore.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { revokeRoleGrant } from '../../src/identity/admin.ts';
import { backupTestDatabase, dbTime, ensureSealKey, installNumberStub, restoreCopy, signerActor, signFor, tempDir, tempLedger, testActor } from '../continuity/helpers.ts';
import { SEED_SITE, seedActor, seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { again, inSecondRole } from '../records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

const dir = tempDir('pn-mutation');
let db: TestDatabase;
let ledger: FileLedger;
/** Service account that acknowledges write-ahead ceilings and issues numbers. */
let ops: ActorContext;
/** System administrator who records and completes restores (CONTINUITY.RESTORE_OPERATE). */
let operator: ActorContext;
/** QA reviewers who approve restores with a RESTORE_APPROVED signature (CONTINUITY.RESTORE_APPROVE). */
let qa1: SeededActor;
let qa2: SeededActor;

// Counters of the write-ahead tests (block sizes 5, 5 and 7) and of the restore tests (block 5).
const A = 'test.pn:A';
const B = 'test.pn:B';
const C = 'test.pn:C';
const K = 'test.pn:K'; // values issued before the restore
const R = 'test.pn:R'; // a block reserved, nothing issued yet
const U = 'test.pn:U'; // never used
const S = 'test.pn:S'; // a block fully issued before the server starts again
const T = 'test.pn:T'; // a block partly issued before the server starts again
const SITE9 = 'test.pn:SITE9'; // a counter registered for another site than the one the actors work at
const SMALL = 'test.pn_seq:small'; // a registered PG sequence with maximum 1000 and restore margin 10

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = tempLedger('pn-mutation', dir.path);
  ops = await testActor(db, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
  operator = await testActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'Restore Operator' });
  qa1 = await signerActor(db, 'QA_REVIEWER', 'QA Approver One');
  qa2 = await signerActor(db, 'QA_REVIEWER', 'QA Approver Two');
  await ensureSealKey(db);
  for (const [key, block] of [[A, 5], [B, 5], [C, 7], [K, 5], [R, 5], [U, 5], [S, 5], [T, 5]] as const) await installNumberStub(db, key, block);

  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('create sequence testgmp.pn_small_seq maxvalue 1000');
    await c.query('alter sequence testgmp.pn_small_seq owner to ebmr_owner');
    await c.query('set local role ebmr_owner');
    await c.query("select continuity.register_protected_sequence($1, 'testgmp.pn_small_seq'::regclass, 'OTHER', 'test', 'Test identifiers with a small maximum', 10)", [SMALL]);
    // The owning module registers the counter with its site (as site-services does for a site's numbering rule).
    await c.query("select continuity.register_protected_counter($1, 'OTHER', 'test', 'Test counter of site SITE-9', 5, '{\"site\": \"SITE-9\"}'::jsonb)", [SITE9]);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}, 120_000);

afterAll(async () => {
  await db?.drop();
  dir.cleanup();
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** continuity.reserve_counter_ceiling exactly as the application role calls it (after writing the ledger). */
const reserve = (key: string, floor: string | null, ceiling: string | null, receipt: string | null, target: TestDatabase = db) =>
  withCommand(target.app, ops, async (c) =>
    (await c.query<{ v: string }>('select continuity.reserve_counter_ceiling($1, $2::bigint, $3::bigint, $4)::text as v', [key, floor, ceiling, receipt])).rows[0]?.v,
  );

/** A value of a protected counter, drawn by the owning module's SECURITY DEFINER function. */
const issue = (key: string, target: TestDatabase = db) =>
  withCommand(target.app, ops, async (c) => (await c.query<{ v: string }>('select testgmp.issue_number($1)::text as v', [key])).rows[0]?.v);

async function counter(key: string, target: TestDatabase = db) {
  const { rows } = await target.app.query<{ last_value: string; reserved_ceiling: string; ceiling_incarnation: string | null }>(
    'select last_value::text, reserved_ceiling::text, ceiling_incarnation from continuity.counter where sequence_key = $1',
    [key],
  );
  return rows[0];
}

async function count(sql: string, params: unknown[] = [], target: TestDatabase = db): Promise<number> {
  const { rows } = await target.app.query<{ n: string }>(`select count(*)::text as n from (${sql}) x`, params);
  return Number(rows[0]?.n);
}

/** continuity.prepare_counter_reservation (the step before anything is written to the ledger), called directly. */
const prepare = (key: string) =>
  withCommand(db.app, ops, async (c) =>
    (await c.query<{ last_value: string | null }>('select last_value::text from continuity.prepare_counter_reservation($1)', [key])).rows,
  );

/** As the table owner: the block in force looks as if it had been reserved before the server started. */
async function reservedBeforeServerStart(key: string): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role ebmr_owner');
    await c.query("update continuity.counter set ceiling_started_at = pg_postmaster_start_time() - interval '1 hour' where sequence_key = $1", [key]);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

async function bumpsOf(key: string, target: TestDatabase = db) {
  const { rows } = await target.app.query<{ reason: string; value_before: string; value_after: string }>(
    'select reason, value_before::text, value_after::text from continuity.sequence_bump where sequence_key = $1 order by recorded_at',
    [key],
  );
  return rows;
}

/**
 * Where every registered PG sequence stands. setval is not transactional, so a refusal that comes
 * after a move would show here. (The DDL log is left out: it counts the tests' own DDL.)
 */
async function sequencePositions(target: TestDatabase = db): Promise<{ k: string; v: string }[]> {
  const { rows } = await target.admin.query<{ k: string; v: string }>(
    `select sequence_key as k, coalesce(pg_sequence_last_value(pg_sequence), 0)::text as v from continuity.protected_sequence
      where source_kind = 'PG_SEQUENCE' and sequence_key <> 'kernel.ddl_log.id' order by 1`,
  );
  return rows;
}

async function recordEvent(by: ActorContext, approvers: string[]): Promise<string> {
  const recorded = await recordRestoreEvent(db.app, by, ledger, {
    eventKind: 'FAILOVER',
    performedAt: await dbTime(db),
    reason: 'Failover to the standby after a storage fault',
    changeReference: `CHG-${randomUUID().slice(0, 8)}`,
    approverPersonIds: approvers,
  });
  return recorded.restoreEventId;
}

/** The approver's own RESTORE_APPROVED signature of the recorded event (DI-37), made through the signing flow. */
const signRestore = (approver: SeededActor, eventId: string) =>
  signFor(db, approver, { type: 'restore_event', id: eventId }, 'RESTORE_APPROVED', 'RECORDED', { registerKey: false });

async function approveSigned(approver: SeededActor, eventId: string): Promise<void> {
  await approveRestoreEvent(db.app, approver, eventId, await signRestore(approver, eventId));
}

const approveWith = (approver: ActorContext, eventId: string, signatureId: string | null) =>
  approveRestoreEvent(db.app, approver, eventId, signatureId ?? undefined);

async function approvers(eventId: string): Promise<string[]> {
  const { rows } = await db.app.query<{ p: string }>(
    'select approver_person_id::text as p from continuity.restore_event_approval where restore_event_id = $1 order by recorded_at',
    [eventId],
  );
  return rows.map((r) => r.p);
}

async function isApproved(eventId: string): Promise<boolean | undefined> {
  const { rows } = await db.app.query<{ ok: boolean }>('select continuity.restore_event_is_approved($1) as ok', [eventId]);
  return rows[0]?.ok;
}

async function status(eventId: string, target: TestDatabase = db): Promise<string | undefined> {
  const { rows } = await target.app.query<{ status: string }>('select status from continuity.restore_event_status where id = $1', [eventId]);
  return rows[0]?.status;
}

interface Bump {
  sequence_key: string;
  source_kind: string;
  value_before: string;
  external_value: string | null;
  value_after: string;
}

/** continuity.after_restore called directly: the high-water marks, the margin and the login names go in unchanged. */
const complete = (eventId: string, highWater: unknown, margin: string | null = '1', target: TestDatabase = db, loginNames: unknown = [], by: ActorContext = operator) =>
  withCommand(target.app, by, async (c) =>
    (
      await c.query<Bump>(
        `select sequence_key, source_kind, value_before::text, external_value::text, value_after::text
           from continuity.after_restore($1, $2::jsonb, $3::bigint, $4::jsonb)`,
        [eventId, highWater === null ? null : JSON.stringify(highWater), margin, loginNames === null ? null : JSON.stringify(loginNames)],
      )
    ).rows,
  );

/**
 * What a complete external ledger holds for the counters: every ceiling the database acknowledged was
 * written there first (write-ahead), so the ledger's highest ceiling is the acknowledged one.
 */
async function ledgerCeilings(target: TestDatabase = db): Promise<{ sequence_key: string; value: string }[]> {
  const { rows } = await target.app.query<{ sequence_key: string; value: string }>(
    'select sequence_key, reserved_ceiling::text as value from continuity.counter where reserved_ceiling > 0 order by 1',
  );
  return rows;
}

const completions = (eventId: string, target: TestDatabase = db) =>
  count('select 1 from continuity.restore_completion where restore_event_id = $1', [eventId], target);

// ---------------------------------------------------------------------------------------------
// Counters: next value and write-ahead reservation
// ---------------------------------------------------------------------------------------------

describe('protected counters', () => {
  it('[INV-27] a key that is not a registered counter is refused as such: no value is issued and no ceiling is recorded (EBMR-CONT-010)', async () => {
    await expect(issue('test.pn:missing')).rejects.toThrow('EBMR-CONT-010 test.pn:missing is not a protected counter');
    await expect(reserve('test.pn:missing', '0', '5', 'ledger:x')).rejects.toThrow('EBMR-CONT-010 test.pn:missing is not a protected counter');
    // A registered PG sequence is protected, but it is not a counter: it has no write-ahead ceiling.
    await expect(reserve('kernel.audit_event.id', '0', '5', 'ledger:x')).rejects.toThrow('EBMR-CONT-010 kernel.audit_event.id is not a protected counter');
    expect(await count("select 1 from continuity.ceiling_reservation where sequence_key in ('test.pn:missing', 'kernel.audit_event.id')")).toBe(0);
  });

  it('[INV-27] a reservation needs a non-negative external floor, a new ceiling and a ledger receipt (EBMR-CONT-014)', async () => {
    const refused = 'EBMR-CONT-014 a reservation needs the external floor, the new ceiling and the ledger receipt';
    const cases: [string | null, string | null, string | null][] = [
      [null, '5', 'ledger:a1'],
      ['-1', '5', 'ledger:a1'],
      ['0', null, 'ledger:a1'],
      ['0', '5', null],
      ['0', '5', ''],
      ['0', '5', '   '],
    ];
    for (const [floor, ceiling, receipt] of cases) {
      await expect(reserve(A, floor, ceiling, receipt), JSON.stringify([floor, ceiling, receipt])).rejects.toThrow(refused);
    }
    expect(await counter(A)).toEqual({ last_value: '0', reserved_ceiling: '0', ceiling_incarnation: null });
    expect(await count('select 1 from continuity.ceiling_reservation where sequence_key = $1', [A])).toBe(0);
    // The same reservation with all three present is acknowledged.
    expect(await reserve(A, '0', '5', 'ledger:a1')).toBe('5');
  });

  it('[INV-27] repeating an acknowledged reservation returns the ceiling in force and records nothing new', async () => {
    expect(await reserve(B, '0', '5', 'ledger:b1')).toBe('5');
    // The acknowledgement was lost and the same reservation arrives again.
    expect(await reserve(B, '0', '5', 'ledger:b1')).toBe('5');
    // An older, lower reservation arrives late: the higher ceiling already covers it.
    expect(await reserve(B, '0', '3', 'ledger:b0')).toBe('5');
    expect(await count('select 1 from continuity.ceiling_reservation where sequence_key = $1', [B])).toBe(1);
    expect(await counter(B)).toMatchObject({ last_value: '0', reserved_ceiling: '5' });
  });

  it('[INV-27] a new ceiling lies above every known value and at most one block beyond it (EBMR-CONT-014)', async () => {
    await expect(reserve(C, '0', '0', 'ledger:c0')).rejects.toThrow('EBMR-CONT-014 new ceiling 0 for test.pn:C must lie in (0, 7]');
    await expect(reserve(C, '0', '8', 'ledger:c0')).rejects.toThrow('EBMR-CONT-014 new ceiling 8 for test.pn:C must lie in (0, 7]');
    expect(await reserve(C, '0', '7', 'ledger:c1')).toBe('7');
    expect([await issue(C), await issue(C)]).toEqual(['1', '2']);
    // The ledger is ahead (12): a "new" ceiling that does not go beyond it reserves nothing and is refused,
    // and the skip to the ledger floor that it would have caused is not recorded either.
    await expect(reserve(C, '12', '12', 'ledger:c2')).rejects.toThrow('EBMR-CONT-014 new ceiling 12 for test.pn:C must lie in (12, 19]');
    expect(await counter(C)).toMatchObject({ last_value: '2', reserved_ceiling: '7' });
    expect(await count('select 1 from continuity.ceiling_reservation where sequence_key = $1', [C])).toBe(1);
    expect(await count('select 1 from continuity.sequence_bump where sequence_key = $1', [C])).toBe(0);
  });

  it('[INV-27] the first step of a reservation refuses a key that is not a registered counter, so no ceiling is written to the external ledger (EBMR-CONT-010)', async () => {
    const outside = tempLedger('pn-prepare', dir.path);
    // A registered PG sequence is protected, but it is not a counter: it has no write-ahead ceiling.
    for (const key of ['test.pn:missing', 'kernel.audit_event.id']) {
      await expect(prepare(key), key).rejects.toThrow(`EBMR-CONT-010 ${key} is not a protected counter`);
      await expect(reserveCounterBlock(db.app, ops, outside, key), key).rejects.toThrow(`EBMR-CONT-010 ${key} is not a protected counter`);
    }
    expect(await outside.entries()).toEqual([]);
    expect(await prepare(A)).toEqual([{ last_value: '0' }]);
  });

  it('[INV-27] after a server start only the values left in the block are retired: a block issued to its ceiling retires nothing and records no move (F55)', async () => {
    // S: its whole block (1..5) issued; T: two values of its block issued. Then the server starts again.
    expect(await reserve(S, '0', '5', 'ledger:s1')).toBe('5');
    const issued: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) issued.push(await issue(S));
    expect(issued).toEqual(['1', '2', '3', '4', '5']);
    expect(await reserve(T, '0', '5', 'ledger:t1')).toBe('5');
    expect([await issue(T), await issue(T)]).toEqual(['1', '2']);
    await reservedBeforeServerStart(S);
    await reservedBeforeServerStart(T);
    await expect(issue(S)).rejects.toThrow(`EBMR-CONT-011 the server started after the block of ${S} was reserved`);

    // S had nothing left to retire: its next block follows on, and no SERVER_RESTART move is recorded.
    expect(await reserve(S, '5', '10', 'ledger:s2')).toBe('10');
    expect(await bumpsOf(S)).toEqual([]);
    expect(await issue(S)).toBe('6');
    // T had 3..5 left: they are retired, and that move is recorded.
    expect(await reserve(T, '5', '10', 'ledger:t2')).toBe('10');
    expect(await bumpsOf(T)).toEqual([{ reason: 'SERVER_RESTART', value_before: '2', value_after: '5' }]);
    expect(await issue(T)).toBe('6');
  });

  it('[DI-17][INV-27] the ceilings of a counter registered for a site are reserved only under a grant covering that site, not the site the actor works at', async () => {
    // Both issuers work at the seed site; only one of them holds a grant for SITE-9, the counter's site.
    const atHome = await seedActor(db, { roleCode: 'BATCH_ISSUER', scope: { site: SEED_SITE }, acknowledgeEsig: false });
    const forSite9 = await seedActor(db, { roleCode: 'BATCH_ISSUER', scope: { site: 'SITE-9' }, acknowledgeEsig: false });
    const outside = tempLedger('pn-scope', dir.path);
    await expect(reserveCounterBlock(db.app, atHome, outside, SITE9)).rejects.toThrow(/^EBMR-IAM-040 .*CONTINUITY\.COUNTER_RESERVE/);
    await expect(
      withCommand(db.app, atHome, (c) => c.query("select continuity.reserve_counter_ceiling($1, 0, 5, 'ledger:site9')", [SITE9])),
    ).rejects.toThrow(/^EBMR-IAM-040 .*CONTINUITY\.COUNTER_RESERVE/);
    expect(await outside.entries()).toEqual([]);
    expect(await counter(SITE9)).toEqual({ last_value: '0', reserved_ceiling: '0', ceiling_incarnation: null });

    expect(await reserveCounterBlock(db.app, forSite9, outside, SITE9)).toBe(5n);
    expect(await counter(SITE9)).toMatchObject({ last_value: '0', reserved_ceiling: '5' });
  });
});

// ---------------------------------------------------------------------------------------------
// Restore events: approval and completion
// ---------------------------------------------------------------------------------------------

describe('restore events', () => {
  let e1: string; // two named approvers; completed by the main completion test
  let eb: string; // recorded by an operator who later moved to QA
  let e2: string; // approved by that former operator and by qa2

  beforeAll(async () => {
    // K: a block reserved (ledger first) and two values issued; R: a block reserved, nothing issued.
    await reserveCounterBlock(db.app, ops, ledger, K);
    expect([await issue(K), await issue(K)]).toEqual(['1', '2']);
    await reserveCounterBlock(db.app, ops, ledger, R);
  }, 60_000);

  it('[DI-45][INV-08][INV-27] a restore event that does not exist is never approved, approvable or completable', async () => {
    const id = randomUUID();
    expect(await isApproved(id)).toBe(false);
    await expect(approveWith(qa1, id, randomUUID())).rejects.toThrow(`EBMR-CONT-021 restore event ${id} does not exist`);
    await expect(complete(id, await ledgerCeilings())).rejects.toThrow(`EBMR-CONT-022 restore event ${id} does not exist`);
  });

  it('[DI-45][DI-37][INV-08] every named approver approves with their own RESTORE_APPROVED signature; one approval of two is not enough', async () => {
    e1 = await recordEvent(operator, [qa1.personId, qa2.personId]);
    const s1 = await signRestore(qa1, e1);
    await approveRestoreEvent(db.app, qa1, e1, s1);

    // One of two named approvers: not approved, and the restore cannot be completed.
    expect(await status(e1)).toBe('RECORDED');
    expect(await isApproved(e1)).toBe(false);
    await expect(complete(e1, await ledgerCeilings())).rejects.toThrow('EBMR-CONT-022 the restore event is not approved by every named approver');

    // The second approver cannot approve with the first approver's signature, nor without a signature.
    await expect(approveWith(qa2, e1, s1)).rejects.toThrow('EBMR-CONT-025 the restore-approval signature was made by another person');
    await expect(approveWith(qa2, e1, null)).rejects.toThrow("EBMR-CONT-025 approving a restore needs the approver's RESTORE_APPROVED signature");
    expect(await approvers(e1)).toEqual([qa1.personId]);

    // With their own signature the second approval is accepted next to the first.
    await approveSigned(qa2, e1);
    expect(await approvers(e1)).toEqual([qa1.personId, qa2.personId]);
    expect(await status(e1)).toBe('APPROVED');
    expect(await isApproved(e1)).toBe(true);
  });

  it('[DI-45][INV-08] an approval is refused when the stored restore event no longer matches its content hash', async () => {
    const e = await recordEvent(operator, [qa2.personId]);
    // A superuser rewrites the recorded event with triggers disabled (the change is not in the hash).
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("update continuity.restore_event set change_reference = 'CHG-ALTERED' where id = $1", [e]);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
    // The approver signs what is stored now; the approval is still refused.
    const signature = await signRestore(qa2, e);
    await expect(approveWith(qa2, e, signature)).rejects.toThrow('EBMR-CONT-021 the restore event no longer matches its content hash');
    expect(await approvers(e)).toEqual([]);
    expect(await isApproved(e)).toBe(false);
  });

  it('[DI-45][INV-27] completion refuses malformed high-water marks and a margin that is not positive (EBMR-CONT-022)', async () => {
    const marks = await ledgerCeilings();
    for (const hw of [null, {}]) {
      await expect(complete(e1, hw), JSON.stringify(hw)).rejects.toThrow('EBMR-CONT-022 external high-water marks must be a JSON array');
    }
    for (const margin of ['0', '-5', null]) {
      await expect(complete(e1, marks, margin), String(margin)).rejects.toThrow('EBMR-CONT-022 the margin for unregistered sequences must be positive');
    }
    expect(await completions(e1)).toBe(0);
    expect(await counter(K)).toMatchObject({ last_value: '2', reserved_ceiling: '5' });
  });

  it('[DI-45][INV-27] a counter the external ledger does not cover, or covers below its restored ceiling, stops the completion', async () => {
    const marks = await ledgerCeilings();
    const without = (key: string) => marks.filter((m) => m.sequence_key !== key);
    // K has issued values; R has only a reserved block: either way the ledger is incomplete.
    await expect(complete(e1, without(K))).rejects.toThrow(`EBMR-CONT-023 the external ledger has no ceiling for counter ${K}`);
    await expect(complete(e1, without(R))).rejects.toThrow(`EBMR-CONT-023 the external ledger has no ceiling for counter ${R}`);
    // The ledger holds a lower ceiling than the database acknowledged: the write-ahead record is missing.
    await expect(complete(e1, [...without(K), { sequence_key: K, value: '3' }])).rejects.toThrow(
      `EBMR-CONT-013 the external ledger (3) is behind the restored ceiling (5) for ${K}`,
    );
    expect(await completions(e1)).toBe(0);
    expect(await counter(K)).toMatchObject({ last_value: '2', reserved_ceiling: '5' });
    expect(await counter(R)).toMatchObject({ last_value: '0', reserved_ceiling: '5' });
  });

  it('[DI-45][INV-27] completion never moves a sequence beyond its maximum, registered or not (EBMR-CONT-024), and a refused completion moves nothing', async () => {
    const marks = await ledgerCeilings();
    // setval is not transactional: every check runs before the first move, so a refusal leaves every
    // protected source where it was (no move without its sequence_bump record).
    const positions = () => sequencePositions();
    const before = await positions();
    // Registered: max(0, 991) + restore margin 10 = 1001 > 1000.
    await expect(complete(e1, [...marks, { sequence_key: SMALL, value: '991' }])).rejects.toThrow(
      'EBMR-CONT-024 moving testgmp.pn_small_seq to 1001 would exceed its maximum 1000',
    );
    // Unregistered (safety net): 0 + margin 1000 > 50.
    await db.admin.query('create sequence testgmp.pn_tiny_seq maxvalue 50; alter sequence testgmp.pn_tiny_seq owner to ebmr_owner');
    try {
      await expect(complete(e1, marks, '1000')).rejects.toThrow('EBMR-CONT-024 moving testgmp.pn_tiny_seq to 1000 would exceed its maximum 50');
    } finally {
      await db.admin.query('drop sequence testgmp.pn_tiny_seq');
    }
    expect(await completions(e1)).toBe(0);
    expect(await positions()).toEqual(before);
    expect(await counter(K)).toMatchObject({ last_value: '2', reserved_ceiling: '5' });
  });

  it('[DI-45][INV-03][INV-08] the operator of a restore never approves it, even after moving to an approver role; their approval of another restore leaves this one approved', async () => {
    const former = await seedActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'Operator Later In QA' });
    eb = await recordEvent(former, [qa1.personId]);
    // The operator leaves IT for QA: the administrator grant is revoked, then QA_REVIEWER is granted.
    const { admin } = await seedAdministration(db);
    await withCommand(db.app, withReason(admin), (c) => revokeRoleGrant(c, former.seed.grantId, 'moved from IT to QA'));
    await inSecondRole(db, former, 'QA_REVIEWER');
    const formerQa: SeededActor = { ...former, roleCode: 'QA_REVIEWER' };

    await expect(approveWith(formerQa, eb, null)).rejects.toThrow('EBMR-CONT-021 the operator cannot approve their own restore (two persons are required)');
    expect(await approvers(eb)).toEqual([]);

    await approveSigned(qa1, eb);
    e2 = await recordEvent(operator, [formerQa.personId, qa2.personId]);
    await approveSigned(formerQa, e2);
    expect(await approvers(e2)).toEqual([formerQa.personId]);
    expect(await isApproved(e2)).toBe(false);
    // eb was approved by qa1, a different person from its operator; the operator's approval of e2 is irrelevant to it.
    expect(await isApproved(eb)).toBe(true);
    expect(await status(eb)).toBe('APPROVED');
  });

  it('[DI-45][INV-27] an approved restore completes: counters move to the ledger ceiling, sequences past their marks (up to their maximum), unregistered ones by the margin', async () => {
    await db.admin.query(`
      create sequence testgmp.pn_stray; alter sequence testgmp.pn_stray owner to ebmr_owner; select setval('testgmp.pn_stray', 41);
      create sequence testgmp.pn_edge maxvalue 100; alter sequence testgmp.pn_edge owner to ebmr_owner; select setval('testgmp.pn_edge', 99);`);
    const marks = [...(await ledgerCeilings()), { sequence_key: SMALL, value: '990' }];
    expect(marks).toEqual(expect.arrayContaining([{ sequence_key: K, value: '5' }, { sequence_key: R, value: '5' }]));
    expect(marks.find((m) => m.sequence_key === U)).toBeUndefined();

    const bumps = await complete(e1, marks, '1');
    const bump = (key: string) => bumps.find((b) => b.sequence_key === key);
    // The ledger ceiling equals the acknowledged one (the normal case): the counter moves to it.
    expect(bump(K)).toEqual({ sequence_key: K, source_kind: 'COUNTER', value_before: '2', external_value: '5', value_after: '5' });
    expect(bump(R)).toEqual({ sequence_key: R, source_kind: 'COUNTER', value_before: '0', external_value: '5', value_after: '5' });
    // A counter that never issued or reserved anything needs no ledger entry.
    expect(bump(U)).toEqual({ sequence_key: U, source_kind: 'COUNTER', value_before: '0', external_value: null, value_after: '0' });
    // 990 + 10 = 1000: exactly the maximum, which is allowed (it is not exceeded). The refused
    // completions above moved nothing; recording the first event secured the identifiers of this
    // database, which moved it to its margin (10) and recorded that move.
    expect(bump(SMALL)).toMatchObject({ source_kind: 'PG_SEQUENCE', external_value: '990', value_after: '1000' });
    expect(bump(SMALL)?.value_before).toBe('10');
    // Unregistered sequences owned by ebmr_owner move by the margin (1 is a positive margin), up to their maximum.
    expect(bump('unregistered:testgmp.pn_stray')).toMatchObject({ source_kind: 'PG_SEQUENCE', value_before: '41', external_value: null, value_after: '42' });
    expect(bump('unregistered:testgmp.pn_edge')).toMatchObject({ value_before: '99', value_after: '100' });

    // The value a sequence was moved to counts as used: the next one is above it.
    expect((await db.admin.query<{ v: string }>("select nextval('testgmp.pn_stray')::text as v")).rows[0]?.v).toBe('43');
    expect(await counter(K)).toEqual({ last_value: '5', reserved_ceiling: '5', ceiling_incarnation: null });
    expect(await counter(U)).toEqual({ last_value: '0', reserved_ceiling: '0', ceiling_incarnation: null });
    expect(await completions(e1)).toBe(1);
    expect(await status(e1)).toBe('COMPLETED');
    expect(await count("select 1 from continuity.sequence_bump where restore_event_id = $1 and sequence_key = 'unregistered:testgmp.pn_stray'", [e1])).toBe(1);

    // Test fixtures at their maximum would block the next completion in this database.
    await db.admin.query('drop sequence testgmp.pn_edge; alter sequence testgmp.pn_small_seq maxvalue 1000000');
  });

  it('[DI-45] a completed restore event takes no further approval; another pending event is still approved as usual', async () => {
    await expect(approveWith(qa1, e1, null)).rejects.toThrow('EBMR-CONT-021 the restore event is already completed');
    await approveSigned(qa2, e2);
    expect(await status(e2)).toBe('APPROVED');
  });

  it('[DI-45][INV-27] a restored copy refuses to complete an event recorded before the copy was made, and to acknowledge a ceiling reserved before it', async () => {
    // A block reserved under this database's incarnation, then the database is backed up and restored.
    expect(await reserveCounterBlock(db.app, ops, ledger, K)).toBe(10n);
    const backup = await backupTestDatabase(db, dir.path);
    const copy = await restoreCopy(db, backup, dir.path);
    try {
      expect(await status(eb, copy)).toBe('APPROVED');
      await expect(complete(eb, await ledgerCeilings(copy), '1', copy)).rejects.toThrow(
        'EBMR-CONT-022 the database incarnation changed after the restore event was recorded; record a new event',
      );
      expect(await completions(eb, copy)).toBe(0);
      const before = await counter(K, copy);
      expect(before).toMatchObject({ last_value: '5', reserved_ceiling: '10' });
      await expect(reserve(K, '10', '15', 'ledger:k-copy', copy)).rejects.toThrow(
        `EBMR-CONT-012 the database incarnation changed since the ceiling of ${K} was reserved; run the restore procedure first`,
      );
      expect(await counter(K, copy)).toEqual(before);
      await expect(issue(K, copy)).rejects.toThrow('EBMR-CONT-012');
    } finally {
      await copy.drop();
    }
  }, 60_000);

  it('[DI-45][INV-27] completion refuses login names from the external ledger that are not a JSON array, before anything moves (EBMR-CONT-022)', async () => {
    const marks = await ledgerCeilings();
    const before = await sequencePositions();
    for (const names of [null, {}, 'user.one']) {
      await expect(complete(e2, marks, '1', db, names), JSON.stringify(names)).rejects.toThrow(
        'EBMR-CONT-022 the login names from the external ledger must be a JSON array',
      );
    }
    expect(await completions(e2)).toBe(0);
    expect(await sequencePositions()).toEqual(before);
    expect(await status(e2)).toBe('APPROVED');
  });

  it('[DI-45][INV-27] where this database secured its identifiers, completion moves a sequence to the ledger mark plus its margin, not a margin beyond its own position', async () => {
    // This database secured its identifiers when the first event was recorded. SMALL stands at 1000
    // (completion of e1); the ledger's mark is 995: 995 + margin 10 = 1005 is passed. Values above
    // the ledger mark were issued here after securing, not before a restore.
    const marks = [...(await ledgerCeilings()), { sequence_key: SMALL, value: '995' }];
    const bumps = await complete(e2, marks, '1');
    expect(bumps.find((b) => b.sequence_key === SMALL)).toEqual({ sequence_key: SMALL, source_kind: 'PG_SEQUENCE', value_before: '1000', external_value: '995', value_after: '1005' });
    expect((await db.admin.query<{ v: string }>("select nextval('testgmp.pn_small_seq')::text as v")).rows[0]?.v).toBe('1006');
    expect(await status(e2)).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------------------------------------
// Securing the identifiers of a restored copy
// ---------------------------------------------------------------------------------------------

describe('a restored copy secures its identifiers before anything else', () => {
  let copy: TestDatabase;

  beforeAll(async () => {
    copy = await restoreCopy(db, await backupTestDatabase(db, dir.path), dir.path);
  }, 60_000);
  afterAll(async () => {
    await copy?.drop();
  });

  /** continuity.secure_identifiers called directly in the copy: the marks, login names and margin go in unchanged. */
  const secure = (highWater: unknown, loginNames: unknown, margin: string | null) =>
    withCommand(copy.app, operator, async (c) =>
      (
        await c.query<Bump>(
          `select sequence_key, source_kind, value_before::text, external_value::text, value_after::text
             from continuity.secure_identifiers($1::jsonb, $2::jsonb, $3::bigint)`,
          [highWater === null ? null : JSON.stringify(highWater), loginNames === null ? null : JSON.stringify(loginNames), margin],
        )
      ).rows,
    );
  const secured = async () => (await copy.app.query<{ ok: boolean }>('select continuity.identifiers_secured() as ok')).rows[0]?.ok;

  it('[INV-27] securing refuses high-water marks or login names that are not a JSON array and a margin that is not positive; the copy stays closed and nothing moves (EBMR-CONT-026)', async () => {
    expect(await secured()).toBe(false);
    const before = await sequencePositions(copy);
    const marksNotArray = 'EBMR-CONT-026 external high-water marks must be a JSON array';
    const namesNotArray = 'EBMR-CONT-026 the login names from the external ledger must be a JSON array';
    const marginNotPositive = 'EBMR-CONT-026 the margin for unregistered sequences must be positive';
    const cases: [unknown, unknown, string | null, string][] = [
      [null, [], '1000', marksNotArray],
      [{}, [], '1000', marksNotArray],
      [[], null, '1000', namesNotArray],
      [[], {}, '1000', namesNotArray],
      [[], [], null, marginNotPositive],
      [[], [], '0', marginNotPositive],
      [[], [], '-1', marginNotPositive],
    ];
    for (const [highWater, names, margin, refused] of cases) {
      await expect(secure(highWater, names, margin), JSON.stringify([highWater, names, margin])).rejects.toThrow(refused);
    }
    expect(await sequencePositions(copy)).toEqual(before);
    expect(await count("select 1 from continuity.database_incarnation where incarnation = continuity.current_incarnation()", [], copy)).toBe(0);
    expect(await secured()).toBe(false);
  });

  it('[INV-27] a copy moves every protected sequence past the larger of its restored position and the ledger mark by its margin, and unregistered ones by the margin given (1 is positive)', async () => {
    const before = new Map((await sequencePositions(copy)).map((p) => [p.k, BigInt(p.v)]));
    const smallBefore = before.get(SMALL) ?? -1n;
    expect(smallBefore).toBeGreaterThan(900n);
    const stray = BigInt((await copy.admin.query<{ v: string }>("select pg_sequence_last_value('testgmp.pn_stray')::text as v")).rows[0]?.v ?? '-1');

    // The ledger's mark (900) is below the restored position: the original may have issued values above
    // that position after the last export, so the margin (10) counts from the restored position.
    const moves = await secure([{ sequence_key: SMALL, value: '900' }], [], '1');
    expect(moves.find((m) => m.sequence_key === SMALL)).toEqual({
      sequence_key: SMALL, source_kind: 'PG_SEQUENCE', value_before: smallBefore.toString(), external_value: '900', value_after: (smallBefore + 10n).toString(),
    });
    expect(moves.find((m) => m.sequence_key === 'unregistered:testgmp.pn_stray')).toMatchObject({ value_before: stray.toString(), value_after: (stray + 1n).toString() });
    expect(await secured()).toBe(true);
    expect(await count("select 1 from continuity.sequence_bump where reason = 'IDENTIFIERS_SECURED' and sequence_key = $1 and value_after = $2", [SMALL, (smallBefore + 10n).toString()], copy)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// External anchors against the restored chains
// ---------------------------------------------------------------------------------------------

describe('external anchors: classification when a restore is recorded, and coverage by an approved restore event', () => {
  let adb: TestDatabase;
  let aops: ActorContext;
  let aoperator: ActorContext;
  let approver: SeededActor;
  let eventId: string;
  let reusedId: bigint;
  const C1 = randomUUID(); // chain batch:C1 ends at seq 2
  const C2 = randomUUID(); // chain batch:C2 ends at seq 3 (until a superuser removes its last entry)
  const chain1 = `batch:${C1}`;
  const chain2 = `batch:${C2}`;
  const RESTORE_POINT = '2026-03-02T09:00:00Z';
  const AFTER = '2026-03-02T10:00:00.000000Z';

  beforeAll(async () => {
    adb = await createTestDatabase();
    aops = await testActor(adb, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
    aoperator = await testActor(adb, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'Restore Operator' });
    approver = await signerActor(adb, 'QA_REVIEWER', 'QA Approver');
    await ensureSealKey(adb);
    for (const [batch, n] of [[C1, 2], [C2, 3]] as const) {
      for (let i = 1; i <= n; i++) {
        await withCommand(adb.app, again(aops), (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, $2)', [batch, String(i)]));
      }
    }
  }, 120_000);
  afterAll(async () => {
    await adb?.drop();
  });

  const hash = () => randomBytes(32).toString('hex');
  async function rootOf(heads: unknown[]): Promise<string> {
    return (await adb.app.query<{ r: string }>("select encode(kernel.merkle_root($1::jsonb), 'hex') as r", [JSON.stringify(heads)])).rows[0]?.r ?? '';
  }
  /** An external anchor record (as the ledger holds it) that this database did not export. */
  async function external(id: bigint, heads: Record<string, unknown>[], createdAt: string, root?: string): Promise<Record<string, unknown>> {
    return { anchor_id: id.toString(), created_at: createdAt, merkle_root_hex: root ?? (await rootOf(heads)), head_count: heads.length, heads };
  }
  async function compare(anchors: unknown[], restorePoint: string | null = RESTORE_POINT) {
    const { rows } = await adb.app.query<{ anchor_id: string; in_database: boolean; status: string; problem_chains: string[] }>(
      'select anchor_id::text, in_database, status, problem_chains from continuity.compare_external_anchors($1::jsonb, $2::timestamptz)',
      [JSON.stringify(anchors), restorePoint],
    );
    return rows;
  }
  const statusOf = async (anchor: unknown, restorePoint: string | null = RESTORE_POINT) => (await compare([anchor], restorePoint)).map((r) => r.status);
  async function verify(anchors: unknown[]) {
    const { rows } = await adb.app.query<{ anchor_id: string; status: string; problem: string | null; restore_event_id: string | null }>(
      'select anchor_id::text, status, problem, restore_event_id::text from continuity.verify_external_anchors($1::jsonb)',
      [JSON.stringify(anchors)],
    );
    return rows;
  }

  it('[INV-08] comparing and verifying external anchors refuse anything but a JSON array (EBMR-CONT-002)', async () => {
    for (const fn of ['compare_external_anchors', 'verify_external_anchors']) {
      for (const anchors of [null, {}, 'anchor']) {
        await expect(
          adb.app.query(`select * from continuity.${fn}($1::jsonb)`, [anchors === null ? null : JSON.stringify(anchors)]),
          `${fn} ${JSON.stringify(anchors)}`,
        ).rejects.toThrow('EBMR-CONT-002 external anchors must be a JSON array');
      }
      expect((await adb.app.query(`select * from continuity.${fn}('[]'::jsonb)`)).rows).toEqual([]);
    }
  });

  it('[INV-08][DI-45] lost history is discardable only when every differing head has a readable position and the anchor was created strictly after the restore point', async () => {
    const lost = { chain_key: chain1, seq: 3, hash_hex: hash() };
    // Lost history, anchored one microsecond after the restore point: discardable.
    expect(await statusOf(await external(900_000_001n, [lost], '2026-03-02T09:00:00.000001Z'))).toEqual(['DISCARDABLE']);
    // Anchored at the restore point itself: that anchor existed at the restore point, so the restored
    // database would hold it.
    expect(await statusOf(await external(900_000_001n, [lost], '2026-03-02T09:00:00.000000Z'))).toEqual(['UNEXPLAINED']);
    // Its creation time cannot be read, so it is not shown to lie after the restore point.
    expect(await statusOf(await external(900_000_001n, [lost], 'not a time'))).toEqual(['UNEXPLAINED']);
    // A differing head whose sequence number is not a number cannot show that the history was lost.
    expect(await statusOf(await external(900_000_002n, [{ chain_key: chain1, seq: 'three', hash_hex: hash() }], AFTER))).toEqual(['UNEXPLAINED']);
    // Nor can one without a sequence number, even next to a head that was lost (such a record has no
    // computable root either, see the next test).
    const noSeq = { chain_key: `batch:${randomUUID()}`, hash_hex: hash() };
    expect(await statusOf(await external(900_000_003n, [lost, noSeq], AFTER, 'ab'.repeat(32)))).toEqual(['UNEXPLAINED']);
  });

  it('[INV-08][DI-45] an external anchor record whose root cannot be checked against its heads (a head without its hash) is inconsistent: never discardable, and its root is reported', async () => {
    // A head without hash_hex has no Merkle leaf, so no root can be computed from the heads and the
    // claimed root is not verifiable. (Defect found in this review: the NULL root was never reported,
    // so such a record passed as lost history and a restore event could discard and later cover it.)
    const unverifiable = await external(900_000_004n, [{ chain_key: chain1, seq: 3 }], AFTER, 'ab'.repeat(32));
    expect(await statusOf(unverifiable)).toEqual(['UNEXPLAINED']);
    const problems = await adb.app.query<{ chain_key: string | null; problem: string }>(
      'select chain_key, problem from continuity.external_anchor_problems($1::jsonb) order by problem',
      [JSON.stringify(unverifiable)],
    );
    expect(problems.rows).toEqual([
      { chain_key: chain1, problem: `chain ${chain1} at seq 3 differs from external anchor 900000004` },
      { chain_key: null, problem: 'external anchor 900000004: root does not match its heads' },
    ]);
    // The same record with its hash and a root computed from its heads is lost history, as usual.
    expect(await statusOf(await external(900_000_004n, [{ chain_key: chain1, seq: 3, hash_hex: hash() }], AFTER))).toEqual(['DISCARDABLE']);
  });

  it('[INV-08][DI-45] an approved restore event covers only the history it discarded: not history the restore kept, and not an anchor id this database issued again', async () => {
    const { rows: seq } = await adb.admin.query<{ n: string }>(
      'select (case when is_called then last_value + 1 else last_value end)::text as n from kernel.audit_anchor_id_seq',
    );
    reusedId = BigInt(seq[0]?.n ?? '0');
    const lostId = reusedId + 1000n;
    // Two anchors of the lost window: chain1 (restored to seq 2) at seq 3 and at seq 4.
    const reused = await external(reusedId, [{ chain_key: chain1, seq: 3, hash_hex: hash() }], AFTER);
    const lost = await external(lostId, [{ chain_key: chain1, seq: 4, hash_hex: hash() }], AFTER);
    const event = {
      event_kind: 'FAILOVER', restore_point: RESTORE_POINT, performed_at: await dbTime(adb), reason: 'Failover to the standby after a storage fault',
      change_reference: `CHG-${randomUUID().slice(0, 8)}`, approver_person_ids: [approver.personId],
    };
    eventId = await withCommand(adb.app, aoperator, async (c) =>
      (await c.query<{ id: string }>('select continuity.record_restore_event($1::jsonb, $2::jsonb)::text as id', [JSON.stringify(event), JSON.stringify([reused, lost])])).rows[0]?.id ?? '',
    );
    const recorded = await adb.app.query<{ discarded: string[]; affected: string[] }>(
      'select array(select x::text from unnest(discarded_anchor_ids) x) as discarded, affected_chain_keys as affected from continuity.restore_event where id = $1',
      [eventId],
    );
    expect(recorded.rows).toEqual([{ discarded: [reusedId.toString(), lostId.toString()], affected: [chain1] }]);
    // Recorded, not approved: nothing is covered yet.
    expect((await verify([lost])).map((r) => r.status)).toEqual(['PROBLEM']);
    const signature = await signFor(adb, approver, { type: 'restore_event', id: eventId }, 'RESTORE_APPROVED', 'RECORDED', { registerKey: false });
    await approveRestoreEvent(adb.app, approver, eventId, signature);

    // The discarded history of the one affected chain is covered by the approved event.
    expect(await verify([lost])).toEqual([
      { anchor_id: lostId.toString(), status: 'COVERED', problem: `chain ${chain1} at seq 4 differs from external anchor ${lostId}`, restore_event_id: eventId },
    ]);
    // A copy under the discarded anchor's id that anchors chain1 at seq 2, where the restored chain still
    // ends: that is history the restore kept, and a different hash there is never covered.
    const kept = await external(lostId, [{ chain_key: chain1, seq: 2, hash_hex: hash() }], AFTER);
    expect(await verify([kept])).toEqual([
      { anchor_id: lostId.toString(), status: 'PROBLEM', problem: `chain ${chain1} at seq 2 differs from external anchor ${lostId}`, restore_event_id: null },
    ]);
    // This database issues the other discarded anchor id again: differences under that id are never covered.
    expect((await adb.app.query<{ id: string }>('select kernel.create_anchor()::text as id')).rows[0]?.id).toBe(reusedId.toString());
    const reissued = await verify([reused]);
    expect(reissued.map((r) => r.problem)).toEqual(
      expect.arrayContaining([`chain ${chain1} at seq 3 differs from external anchor ${reusedId}`, `external anchor ${reusedId} differs from the database copy of that anchor`]),
    );
    expect(reissued.every((r) => r.status === 'PROBLEM' && r.restore_event_id === null)).toBe(true);
  });

  it('[INV-08] an anchor this database still holds is never discardable: history it anchored that is now missing was removed here, not lost by a restore', async () => {
    // The ledger's copy of the anchor this database holds (a copy that does not name the exporting server).
    const { rows } = await adb.app.query<{ anchor: Record<string, unknown> }>(
      `select jsonb_build_object('anchor_id', a.id::text, 'created_at', continuity.utc_text(a.created_at), 'merkle_root_hex', encode(a.merkle_root, 'hex'),
                                 'head_count', a.head_count, 'heads', a.heads) as anchor
         from kernel.audit_anchor a where a.id = $1`,
      [reusedId.toString()],
    );
    const held = rows[0]?.anchor;
    expect(held).toBeDefined();
    expect(await compare([held], null)).toEqual([{ anchor_id: reusedId.toString(), in_database: true, status: 'MATCH', problem_chains: [] }]);

    // A superuser removes the last entry of chain2 (seq 3, which the anchor holds) with the triggers bypassed.
    const c = await adb.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query('delete from kernel.audit_event where chain_key = $1 and seq = 3', [chain2]);
      await c.query(
        `update kernel.audit_chain_head h set last_seq = e.seq, last_hash = e.hash, last_event = e.id
           from kernel.audit_event e where h.chain_key = $1 and e.chain_key = $1 and e.seq = 2`,
        [chain2],
      );
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
    expect(await compare([held], null)).toEqual([{ anchor_id: reusedId.toString(), in_database: true, status: 'UNEXPLAINED', problem_chains: [chain2] }]);
  });

  it('[DI-45][INV-27] where the identifiers were never secured (the database is bound by its own anchor export), completion moves a sequence past its restored position by the whole margin', async () => {
    const bound = await adb.app.query<{ bound_by: string }>('select bound_by from continuity.database_incarnation where incarnation = continuity.current_incarnation()');
    expect(bound.rows).toEqual([{ bound_by: 'ANCHOR_EXPORT' }]);
    // The anchor id issued above never reached the ledger (no mark): values above the ledger were issued
    // here, so the anchor-id sequence moves its whole margin (100000) past where it stands.
    const bumps = await complete(eventId, [], '1', adb, [], aoperator);
    const anchorIds = bumps.find((b) => b.sequence_key === 'kernel.audit_anchor.id');
    expect(anchorIds).toMatchObject({ source_kind: 'PG_SEQUENCE', value_before: reusedId.toString(), external_value: null });
    expect(anchorIds?.value_after).toBe((reusedId + 100_000n).toString());
    expect(await status(eventId, adb)).toBe('COMPLETED');
  });
});
