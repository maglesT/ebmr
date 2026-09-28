/**
 * Protected numbers and the restore procedure, guard by guard (SQL mutation group "protected-numbers":
 * continuity.next_counter_value, reserve_counter_ceiling, approve_restore_event,
 * restore_event_is_approved and after_restore in kernel 0600). The scenario tests in
 * continuity/numbers.test.ts and continuity/restore.test.ts go through the TypeScript wrappers, which
 * check some conditions themselves before the database sees them; these tests call the database
 * functions directly, so every refusal is proven where it is enforced, with its own error message.
 *
 * Controls: DI-45 (restore procedure, two persons, signed approval), DI-37 (the approval is the
 * approver's own signature); invariants INV-27 (identifiers are never reused, including after a
 * restore), INV-08 (a restore event covers a gap only once approved) and INV-03 (the operator never
 * approves their own restore).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileLedger } from '../../src/continuity/ledger.ts';
import { reserveCounterBlock } from '../../src/continuity/numbers.ts';
import { approveRestoreEvent, recordRestoreEvent } from '../../src/continuity/restore.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { revokeRoleGrant } from '../../src/identity/admin.ts';
import { backupTestDatabase, dbTime, ensureSealKey, installNumberStub, restoreCopy, signerActor, signFor, tempDir, tempLedger, testActor } from '../continuity/helpers.ts';
import { seedActor, seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { inSecondRole } from '../records/helpers.ts';
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
const SMALL = 'test.pn_seq:small'; // a registered PG sequence with maximum 1000 and restore margin 10

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = tempLedger('pn-mutation', dir.path);
  ops = await testActor(db, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
  operator = await testActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'Restore Operator' });
  qa1 = await signerActor(db, 'QA_REVIEWER', 'QA Approver One');
  qa2 = await signerActor(db, 'QA_REVIEWER', 'QA Approver Two');
  await ensureSealKey(db);
  for (const [key, block] of [[A, 5], [B, 5], [C, 7], [K, 5], [R, 5], [U, 5]] as const) await installNumberStub(db, key, block);

  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('create sequence testgmp.pn_small_seq maxvalue 1000');
    await c.query('alter sequence testgmp.pn_small_seq owner to ebmr_owner');
    await c.query('set local role ebmr_owner');
    await c.query("select continuity.register_protected_sequence($1, 'testgmp.pn_small_seq'::regclass, 'OTHER', 'test', 'Test identifiers with a small maximum', 10)", [SMALL]);
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

/** continuity.after_restore called directly: the high-water marks and the margin go in unchanged. */
const complete = (eventId: string, highWater: unknown, margin: string | null = '1', target: TestDatabase = db) =>
  withCommand(target.app, operator, async (c) =>
    (
      await c.query<Bump>(
        `select sequence_key, source_kind, value_before::text, external_value::text, value_after::text
           from continuity.after_restore($1, $2::jsonb, $3::bigint)`,
        [eventId, highWater === null ? null : JSON.stringify(highWater), margin],
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
    // protected source where it was (no move without its sequence_bump record). (The DDL log counts the
    // test's own create and drop sequence statements.)
    const positions = async () =>
      (await db.admin.query<{ k: string; v: string }>(
        `select sequence_key as k, coalesce(pg_sequence_last_value(pg_sequence), 0)::text as v from continuity.protected_sequence
          where source_kind = 'PG_SEQUENCE' and sequence_key <> 'kernel.ddl_log.id' order by 1`,
      )).rows;
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
});
