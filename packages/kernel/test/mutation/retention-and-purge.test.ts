/**
 * Retention end and controlled purge, guard by guard (SQL mutation group "retention-and-purge":
 * records.approve_purge, records.purge, records.disposal_refusals and records.insert_only_trigger in
 * kernel 0440). The scenario tests in records/retention-purge.test.ts prove the happy paths and the
 * common refusals; these tests close the gaps the SQL mutation run (tools/sql-mutation) found: every
 * refusal is asserted by its stable EBMR code, every boundary is proven from both sides, and the
 * locking that makes a purge safe against a concurrent change is proven with a second command left
 * open while the purge or the approval runs.
 *
 * Controls: DI-47 (retention periods, holds, QA-approved disposal that leaves a disposal record),
 * DI-37 (the approval is the approver's own signature of that disposal); invariants INV-22 (nothing
 * is purged on or before its retain-until, including the maximum over its dependants, or while on
 * hold; purge only through the retention function, with tombstone and checkpoint) and INV-08 (every
 * audit chain verifies).
 *
 * States the product never produces by itself (a register entry written outside
 * records.register_true_copy, a chain rewritten and re-hashed, an event slipped into a chain) are
 * arranged with the superuser; the control itself is always exercised through the records
 * functions, as the application role.
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/audit/verify.ts';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import type { RetentionInputs } from '../../src/records/retention.ts';
import { approvePurge, createRetentionSchedule, linkRetentionDependency, placeLegalHold, purge, retentionOf } from '../../src/records/retention-store.ts';
import { BUNDLE_FORMAT, buildTrueCopyBundle, registerTrueCopy } from '../../src/records/true-copy.ts';
import { SEED_ZONE, type SeededActor } from '../identity/seed.ts';
import {
  again,
  approveDisposal,
  correctEntry,
  createStubTables,
  disposalAggregate,
  insertEntry,
  insertReading,
  recordType,
  registerType,
  scalar,
  signerActor,
  signFor,
  testActor,
  withReason,
  allowRetention,
} from '../records/helpers.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let operator: ActorContext;
/** A second person writing GMP rows (a command locks its actor's session, so concurrent commands need two). */
let stores: ActorContext;
let qa: ActorContext;
let qa2: SeededActor;
let retentionJob: ActorContext;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAST_BATCH: RetentionInputs = { markets: ['IN', 'US'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' };
const BATCH_TABLES = ['stub_b4.batch_entry', 'stub_b4.batch_reading'];

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  // A second stub aggregate whose insert-only rows another record can reference (component parts
  // and their uses), for the delete passes of the purge.
  await db.admin.query(`
    create schema if not exists stub_rp authorization ebmr_owner;
    set role ebmr_owner;
    grant usage on schema stub_rp to ebmr_app;
    create table stub_rp.part (
      id uuid primary key default gen_random_uuid(),
      lot_id uuid not null,
      note text not null
    );
    create table stub_rp.part_use (
      id uuid primary key default gen_random_uuid(),
      use_id uuid not null,
      part_id uuid references stub_rp.part (id),
      note text not null
    );
    grant select, insert on stub_rp.part to ebmr_app;
    grant select, insert, update on stub_rp.part_use to ebmr_app;
    select kernel.register_audited_table('stub_rp.part', 'rp_part', 'lot_id', true);
    select kernel.register_audited_table('stub_rp.part_use', 'rp_use', 'use_id', false);
    reset role;
  `);
  // Only aggregate types their module declares for retention can have a schedule (F29, F75).
  await allowRetention(db, 'rp_part', ['BATCH_RECORD']);
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  await registerType(db, recordType('COMPONENT_LOT_RECORD', { retentionKey: 'SUPPORTING_RECORD' }));
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  stores = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Stores Operator' });
  qa = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Reviewer' });
  qa2 = await signerActor(db, 'QA_REVIEWER', 'QA Manager');
  retentionJob = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'retention job' });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A batch with one corrected entry and one insert-only reading, plus its retention schedule. */
async function batchWithRecords(inputs: RetentionInputs): Promise<string> {
  const batch = randomUUID();
  const entry = await insertEntry(db, operator, batch, '12.503');
  await correctEntry(db, operator, entry, '12.530');
  await insertReading(db, operator, batch, '7.10');
  await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', inputs));
  return batch;
}

async function insertPart(lot: string): Promise<string> {
  return withCommand(db.app, again(operator), async (c) => {
    const { rows } = await c.query<{ id: string }>("insert into stub_rp.part (lot_id, note) values ($1, 'received') returning id", [lot]);
    return rows[0]?.id ?? '';
  });
}

async function insertPartUse(use: string, partId: string): Promise<void> {
  await withCommand(db.app, again(operator), (c) => c.query("insert into stub_rp.part_use (use_id, part_id, note) values ($1, $2, 'consumed')", [use, partId]));
}

/** A component part lot record (one insert-only row) with an ended retention and its QA disposal approval. */
async function approvedPartLot(): Promise<{ lot: string; key: string; partId: string }> {
  const lot = randomUUID();
  const partId = await insertPart(lot);
  await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'rp_part', lot, 'BATCH_PROCESSING_RECORD', PAST_BATCH));
  const key = `rp_part:${lot}`;
  await approve(key);
  return { lot, key, partId };
}

// QA's disposal approval carries a RECORD_DISPOSAL_APPROVED signature of the record at its retain-until (DI-37).
const approve = (key: string, trueCopyId?: string) => approveDisposal(db, qa2, key, 'retention ended; archived true copy verified', trueCopyId);
const purgeContext = () => withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal');
const runPurge = (key: string) => withCommand(db.app, purgeContext(), (c) => purge(c, key));

const count = (pool: pg.Pool, sql: string, params: unknown[] = []) => scalar<string>(pool, `select count(*)::text as v from ${sql}`, params);
const batchRows = (batch: string) => count(db.app, 'stub_b4.batch_entry where batch_id = $1', [batch]);
const tombstones = (key: string) => count(db.admin, 'records.tombstone where record_key = $1', [key]);
const approvals = (key: string) => count(db.admin, 'records.purge_approval where record_key = $1', [key]);

async function registerCopy(key: string): Promise<string> {
  return withCommand(db.app, again(qa2), async (c) => registerTrueCopy(c, await buildTrueCopyBundle(db.app, { chainKey: key, tables: BATCH_TABLES }), 'archive before disposal'));
}

async function chainHead(key: string): Promise<{ seq: number; hash: Buffer }> {
  const { rows } = await db.admin.query<{ seq: string; hash: Buffer }>('select last_seq::text as seq, last_hash as hash from kernel.audit_chain_head where chain_key = $1', [key]);
  const head = rows[0];
  if (!head) throw new Error(`${key} has no chain head`);
  return { seq: Number(head.seq), hash: head.hash };
}

// A command of its own connection, left open while another command runs (the concurrency tests).
interface OpenCommand {
  client: pg.Client;
  pid: number;
}

/**
 * Runs `work` with commands on connections of their own and ends them all afterwards (an open
 * transaction rolls back), even while a statement still waits. kernel.begin_command locks the
 * actor's session, so each open command acts for a different actor.
 */
async function withOpenCommands(work: (open: (ctx: ActorContext) => Promise<OpenCommand>) => Promise<void>): Promise<void> {
  const opened: OpenCommand[] = [];
  const open = async (ctx: ActorContext): Promise<OpenCommand> => {
    const client = new pg.Client({ connectionString: urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }) });
    client.on('error', () => undefined); // the connection is ended below
    await client.connect();
    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const command = { client, pid: rows[0]?.pid ?? 0 };
    opened.push(command);
    await client.query('begin');
    await client.query("set local lock_timeout = '10s'"); // an actor already acting fails fast
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    await client.query('set local lock_timeout to default');
    return command;
  };
  try {
    await work(open);
  } finally {
    for (const c of opened) await db.admin.query('select pg_terminate_backend($1)', [c.pid]).catch(() => undefined);
    for (const c of opened) await c.client.end().catch(() => undefined);
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
interface Running<T> {
  readonly settled: boolean;
  readonly outcome: Promise<Outcome<T>>;
}

/** A statement started without waiting for it. */
function start<T>(p: Promise<T>): Running<T> {
  const state = { settled: false };
  const outcome = p.then(
    (value): Outcome<T> => {
      state.settled = true;
      return { ok: true, value };
    },
    (error: unknown): Outcome<T> => {
      state.settled = true;
      return { ok: false, error };
    },
  );
  return {
    get settled() {
      return state.settled;
    },
    outcome,
  };
}

async function result<T>(r: Running<T>): Promise<T> {
  const o = await r.outcome;
  if (!o.ok) throw o.error;
  return o.value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting until ${what}`);
}

/** The backend waits for a lock another transaction holds. */
async function waitsForLock(pid: number): Promise<boolean> {
  const { rows } = await db.admin.query<{ w: string | null }>('select wait_event_type as w from pg_stat_activity where pid = $1', [pid]);
  return rows[0]?.w === 'Lock';
}

/** The backend waits for a lock on this table. */
async function waitsForTable(pid: number, table: string): Promise<boolean> {
  const n = await count(db.admin, "pg_locks where pid = $1 and not granted and locktype = 'relation' and relation = $2::regclass", [pid, table]);
  return n !== '0';
}


// ---------------------------------------------------------------------------------------------
// The disposal approval
// ---------------------------------------------------------------------------------------------

describe('DI-47 disposal approval', () => {
  it('[DI-47][DI-37] a disposal approval without a reason is refused as such (EBMR-REC-035), even with a valid approval signature', async () => {
    const key = `batch:${await batchWithRecords(PAST_BATCH)}`;
    const signature = await signFor(db, qa2, await disposalAggregate(db, key), 'RECORD_DISPOSAL_APPROVED', 'DISPOSABLE');
    for (const reason of [' ', '', null]) {
      await expect(
        withCommand(db.app, again(qa2), (c) => c.query('select records.approve_purge($1, $2, $3)', [key, signature, reason])),
        `reason ${JSON.stringify(reason)}`,
      ).rejects.toThrow('EBMR-REC-035 a disposal approval needs a reason');
    }
    expect(await approvals(key)).toBe('0');
    // The same signature with a reason is accepted: the refusal was the missing reason.
    await expect(withCommand(db.app, again(qa2), (c) => approvePurge(c, key, signature, 'retention ended'))).resolves.toMatch(UUID);
    expect(await approvals(key)).toBe('1');
  });

  it('[DI-47][DI-37] an approval cites only an archived true copy of that same record (EBMR-REC-035); a copy of another record or an unknown copy is refused', async () => {
    const key = `batch:${await batchWithRecords(PAST_BATCH)}`;
    const otherKey = `batch:${await batchWithRecords(PAST_BATCH)}`;
    const copyOfOther = await registerCopy(otherKey);
    const ownCopy = await registerCopy(key);
    const signature = await signFor(db, qa2, await disposalAggregate(db, key), 'RECORD_DISPOSAL_APPROVED', 'DISPOSABLE');
    const approveCiting = (copy: string) => withCommand(db.app, again(qa2), (c) => approvePurge(c, key, signature, 'retention ended', copy));
    await expect(approveCiting(copyOfOther)).rejects.toThrow(`EBMR-REC-035 true copy ${copyOfOther} is not a copy of ${key}`);
    const unknown = randomUUID();
    await expect(approveCiting(unknown)).rejects.toThrow(`EBMR-REC-035 true copy ${unknown} is not a copy of ${key}`);
    expect(await approvals(key)).toBe('0');
    // Citing its own archived copy, with a signature that covers that copy, is accepted.
    await expect(approve(key, ownCopy)).resolves.toMatch(UUID);
    expect(await scalar<string>(db.admin, 'select true_copy_id::text as v from records.purge_approval where record_key = $1', [key])).toBe(ownCopy);
  });

  it('[DI-47][INV-22] an approval waits for a retention change of the record in progress, then refuses at the new retain-until (EBMR-REC-031)', async () => {
    const key = `batch:${await batchWithRecords(PAST_BATCH)}`;
    const signature = await signFor(db, qa2, await disposalAggregate(db, key), 'RECORD_DISPOSAL_APPROVED', 'DISPOSABLE');
    await withOpenCommands(async (open) => {
      const change = await open(again(qa));
      const approval = await open(again(qa2));
      await change.client.query('select records.update_retention_inputs($1, $2::jsonb, $3)', [key, JSON.stringify({ expiryDate: '2030-01-31' }), 'expiry corrected after stability data']);
      const run = start(approval.client.query('select records.approve_purge($1, $2, $3) as id', [key, signature, 'retention ended']));
      await waitFor('the approval waits for the retention change', async () => run.settled || (await waitsForLock(approval.pid)));
      await change.client.query('commit');
      await expect(result(run)).rejects.toThrow(new RegExp(`EBMR-REC-031 ${key} must be kept until 2031-01-31`));
    });
    expect(await approvals(key)).toBe('0');
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Eligibility: the retain-until day
// ---------------------------------------------------------------------------------------------

describe('INV-22 retain-until boundary', () => {
  it('[DI-47][INV-22] on its retain-until date a record is still kept (EBMR-REC-031); from the next site day it may be disposed of', async ({ skip }) => {
    // A schedule keeps the site's zone (a caller's other zone is refused: F84), so the boundary is the site's day.
    const zone = SEED_ZONE;
    const today = await scalar<string>(db.app, "select to_char((clock_timestamp() at time zone $1)::date, 'YYYY-MM-DD') as v", [zone]);
    // No retain-until falls on 29 February (every rule adds whole years to a real date), so on that site day
    // the on-the-day case cannot be arranged; the test then has nothing to prove.
    if (today.endsWith('-02-29')) skip();
    // IN and US keep batch records one year after expiry.
    const expiryFor = (daysBefore: number) =>
      scalar<string>(db.app, "select to_char(($1::date - $2::int - interval '1 year')::date, 'YYYY-MM-DD') as v", [today, daysBefore]);
    const onTheDay = randomUUID();
    const dayAfter = randomUUID();
    const onTheDayExpiry = await expiryFor(0);
    const dayAfterExpiry = await expiryFor(1);
    await withCommand(db.app, again(qa), async (c) => {
      await createRetentionSchedule(c, 'batch', onTheDay, 'BATCH_PROCESSING_RECORD', { markets: ['IN', 'US'], expiryDate: onTheDayExpiry }, zone);
      await createRetentionSchedule(c, 'batch', dayAfter, 'BATCH_PROCESSING_RECORD', { markets: ['IN', 'US'], expiryDate: dayAfterExpiry }, zone);
    });

    const kept = await retentionOf(db.app, 'batch', onTheDay);
    expect(kept.siteDate).toBe(today);
    expect(kept.effective).toMatchObject({ status: 'DATED', retainUntil: today });
    expect(kept.refusals.map((r) => r.code)).toEqual(['EBMR-REC-031']);
    expect(kept.refusals[0]?.detail).toContain(`must be kept until ${today} (site date ${today})`);
    await expect(approve(`batch:${onTheDay}`)).rejects.toThrow(`EBMR-REC-031 batch:${onTheDay} must be kept until ${today}`);
    await expect(runPurge(`batch:${onTheDay}`)).rejects.toThrow('EBMR-REC-031');

    const ended = await retentionOf(db.app, 'batch', dayAfter);
    expect(ended.effective.status).toBe('DATED');
    expect((ended.effective.retainUntil ?? '') < today).toBe(true);
    expect(ended.refusals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The archived true copy must cover the record as kept
// ---------------------------------------------------------------------------------------------

describe('INV-22 true copy covers the record as kept', () => {
  it('[DI-47][INV-22] a record changed after it was archived is not purged, even when its chain was rewritten and re-hashed to verify (EBMR-REC-038)', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await withCommand(db.app, again(operator), (c) => c.query("select kernel.audit_business_event($1, 'line clearance confirmed')", [key]));
    const copy = await registerCopy(key);
    await approve(key, copy);
    const archived = await chainHead(key);

    // The superuser rewrites the last event and recomputes its hash and the chain head: the chain
    // verifies on its own, at the same sequence number; only the archive shows the change.
    const { rows } = await db.admin.query<{ hash: Buffer }>(
      `with t as (select e.id, e.prev_hash, jsonb_set(e.payload, '{body,message}', '"line clearance not performed"') as p
                    from kernel.audit_event e where e.chain_key = $1 and e.seq = $2)
       update kernel.audit_event e set payload = t.p, hash = sha256(t.prev_hash || convert_to(t.p::text, 'UTF8'))
         from t where e.id = t.id returning e.hash`,
      [key, archived.seq],
    );
    await db.admin.query('update kernel.audit_chain_head set last_hash = $2 where chain_key = $1', [key, rows[0]?.hash]);
    expect(await verifyChain(db.app, key)).toEqual([]);
    const now = await chainHead(key);
    expect(now.seq).toBe(archived.seq);
    expect(now.hash.equals(archived.hash)).toBe(false);

    await expect(runPurge(key)).rejects.toThrow(
      `EBMR-REC-038 true copy ${copy} covers ${key} up to seq ${archived.seq}, but the record now ends at seq ${now.seq}; archive it again before purging`,
    );
    expect(await batchRows(batch)).toBe('1');
    expect(await tombstones(key)).toBe('0');
  });

  it('[DI-47][INV-22] a register entry naming the head hash at another sequence number does not cover the record (EBMR-REC-038)', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    const head = await chainHead(key);
    // Written outside records.register_true_copy (which would refuse it): the hash of the current
    // head, recorded one sequence number earlier.
    const forged = await withCommand(db.admin, again(qa2), async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into records.true_copy (record_key, head_seq, head_hash, manifest_sha256, bundle_format, purpose, created_by_person)
         values ($1, $2, $3, $4, $5, 'archive before disposal', $6) returning id`,
        [key, head.seq - 1, head.hash, createHash('sha256').update(`manifest of ${key}`).digest('hex'), BUNDLE_FORMAT, qa2.personId],
      );
      return rows[0]?.id ?? '';
    });
    await approve(key, forged);
    await expect(runPurge(key)).rejects.toThrow(`EBMR-REC-038 true copy ${forged} covers ${key} up to seq ${head.seq - 1}, but the record now ends at seq ${head.seq}`);
    expect(await batchRows(batch)).toBe('1');
    expect(await tombstones(key)).toBe('0');
  });
});

// ---------------------------------------------------------------------------------------------
// Deleting the rows and sealing the chain
// ---------------------------------------------------------------------------------------------

describe('INV-22 deleting the rows and sealing the chain', () => {
  it('[INV-22][DI-47] rows still referenced by another record stop the purge (EBMR-REC-037); nothing is deleted', async () => {
    const { lot, key, partId } = await approvedPartLot();
    const use = randomUUID();
    await insertPartUse(use, partId);
    await expect(
      withCommand(db.app, purgeContext(), async (c) => {
        await c.query("set local statement_timeout = '20s'");
        return purge(c, key);
      }),
    ).rejects.toThrow(new RegExp(`^EBMR-REC-037 rows of ${key} are still referenced by other records \\(.*stub_rp\\.part.*\\); purge refused$`));
    expect(await count(db.app, 'stub_rp.part where lot_id = $1', [lot])).toBe('1');
    expect(await tombstones(key)).toBe('0');
  });

  it('[INV-22][DI-47] a table whose rows are still referenced is retried in a later pass: a reference released meanwhile lets the purge complete', async () => {
    const { lot, key, partId } = await approvedPartLot();
    const use = randomUUID();
    await insertPartUse(use, partId);
    await withOpenCommands(async (open) => {
      const otherWrite = await open(again(stores));
      const correction = await open(withReason(operator, 'CORRECTION', 'wrong part lot referenced'));
      const purging = await open(purgeContext());
      // The correction releases the reference (not committed yet); another part lot is being written.
      await correction.client.query('update stub_rp.part_use set part_id = null where use_id = $1', [use]);
      await otherWrite.client.query("insert into stub_rp.part (lot_id, note) values ($1, 'received')", [randomUUID()]);
      const run = start(purging.client.query<{ id: string }>('select records.purge($1) as id', [key]));
      // First pass: disabling the table's insert-only guard waits for the other write.
      await waitFor('the first pass waits for stub_rp.part', async () => run.settled || (await waitsForTable(purging.pid, 'stub_rp.part')));
      // The correction then writes to the same table and queues behind the purge.
      const queued = start(correction.client.query("insert into stub_rp.part (lot_id, note) values ($1, 'received')", [randomUUID()]));
      await waitFor('the correction queues behind the purge', async () => queued.settled || (await waitsForTable(correction.pid, 'stub_rp.part')));
      // The other write ends: the first pass runs while the reference is still committed and fails
      // on it; leaving the pass frees the table, so the queued write goes ahead of the next pass.
      await otherWrite.client.query('commit');
      await result(queued);
      await waitFor('the next pass waits for the correction', async () => run.settled || (await waitsForTable(purging.pid, 'stub_rp.part')));
      await correction.client.query('commit');
      const tombstone = (await result(run)).rows[0]?.id;
      await purging.client.query('commit');
      expect(tombstone).toMatch(UUID);
    });
    expect(await count(db.app, 'stub_rp.part where lot_id = $1', [lot])).toBe('0');
    expect(await count(db.app, 'stub_rp.part_use where use_id = $1 and part_id is null', [use])).toBe('1');
    expect(await tombstones(key)).toBe('1');
  }, 60_000);

  it('[INV-22][INV-08][DI-47] an event slipped into the chain while the purge seals it is caught: the chain is incomplete and nothing is purged (EBMR-REC-034)', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await approve(key);
    const kept = (await chainHead(key)).seq;
    const tamper = await db.admin.connect();
    try {
      await withOpenCommands(async (open) => {
        const purging = await open(purgeContext());
        // A superuser session copies an event far beyond the head and takes the checkpoint sequence
        // numbers the purge will seal, so the purge's final checkpoint waits for this session.
        await tamper.query('begin');
        await tamper.query(
          `insert into kernel.audit_event (chain_key, seq, prev_hash, hash, recorded_at, correlation_id, action, table_name, record_id, payload)
           select chain_key, 1000000, prev_hash, hash, recorded_at, correlation_id, action, table_name, record_id, payload
             from kernel.audit_event where chain_key = $1 and seq = 1`,
          [key],
        );
        await tamper.query(
          `insert into kernel.audit_checkpoint (chain_key, seq, hash, event_count, reason)
           select $1, s, decode('00', 'hex'), s, 'tampering' from generate_series($2::bigint + 1, $2::bigint + 20) s`,
          [key, kept],
        );
        const run = start(purging.client.query('select records.purge($1) as id', [key]));
        await waitFor('the purge waits to seal its checkpoint', async () => run.settled || (await waitsForLock(purging.pid)));
        await tamper.query('commit');
        await expect(result(run)).rejects.toThrow(`EBMR-REC-034 the audit chain of ${key} is incomplete; it is not purged`);
      });
    } finally {
      await tamper.query('rollback').catch(() => undefined);
      tamper.release();
    }
    expect(await batchRows(batch)).toBe('1');
    expect(await tombstones(key)).toBe('0');
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Serialisation with changes to the record and its dependants
// ---------------------------------------------------------------------------------------------

describe('INV-22 purge serialises with retention changes and blockers', () => {
  it('[DI-47][INV-22] a retention change of the record in progress: the purge waits for it, then refuses at the new retain-until (EBMR-REC-031)', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await approve(key);
    await withOpenCommands(async (open) => {
      const change = await open(again(qa));
      const purging = await open(purgeContext());
      await change.client.query('select records.update_retention_inputs($1, $2::jsonb, $3)', [key, JSON.stringify({ expiryDate: '2030-01-31' }), 'expiry corrected after stability data']);
      const run = start(purging.client.query('select records.purge($1) as id', [key]));
      await waitFor('the purge waits for the retention change', async () => run.settled || (await waitsForLock(purging.pid)));
      await change.client.query('commit');
      await expect(result(run)).rejects.toThrow(new RegExp(`EBMR-REC-031 ${key} must be kept until 2031-01-31`));
    });
    expect(await batchRows(batch)).toBe('1');
    expect(await tombstones(key)).toBe('0');
  }, 60_000);

  it('[DI-47][INV-22] a legal hold being placed on the record: the purge waits for it, then refuses (EBMR-REC-032)', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await approve(key);
    await withOpenCommands(async (open) => {
      const hold = await open(again(qa));
      const purging = await open(purgeContext());
      await hold.client.query("select records.place_legal_hold('batch', $1, 'regulatory inspection request', 'INSP-2026-11')", [batch]);
      const run = start(purging.client.query('select records.purge($1) as id', [key]));
      await waitFor('the purge waits for the hold', async () => run.settled || (await waitsForLock(purging.pid)));
      await hold.client.query('commit');
      await expect(result(run)).rejects.toThrow('EBMR-REC-032 HOLD LEGAL INSP-2026-11 blocks disposal');
    });
    expect(await batchRows(batch)).toBe('1');
    expect(await tombstones(key)).toBe('0');
  }, 60_000);

  // This test must create the first retention dependency of this database: then only the correct
  // closure (supporting record -> its dependants) reaches the dependant.
  it('[DI-47][INV-22] a legal hold being placed on a dependant: the purge of the supporting record waits for it, then refuses (EBMR-REC-032)', async () => {
    expect(await count(db.admin, 'records.retention_dependency')).toBe('0');
    const lot = randomUUID();
    const dependant = await batchWithRecords(PAST_BATCH);
    await withCommand(db.app, again(operator), (c) => c.query("insert into stub_b4.lot_record (lot_id, note) values ($1, 'received')", [lot]));
    await withCommand(db.app, again(qa), async (c) => {
      await createRetentionSchedule(c, 'component_lot', lot, 'COMPONENT_LOT_RECORD', { markets: ['IN'] });
      await linkRetentionDependency(c, `component_lot:${lot}`, `batch:${dependant}`, 'COMPONENT_LOT_CONSUMED');
    });
    const key = `component_lot:${lot}`;
    await approve(key);
    await withOpenCommands(async (open) => {
      const hold = await open(again(qa));
      const purging = await open(purgeContext());
      await hold.client.query("select records.place_legal_hold('batch', $1, 'product complaint under investigation', 'CMP-2026-04')", [dependant]);
      const run = start(purging.client.query('select records.purge($1) as id', [key]));
      await waitFor('the purge waits for the hold on the dependant', async () => run.settled || (await waitsForLock(purging.pid)));
      await hold.client.query('commit');
      await expect(result(run)).rejects.toThrow(`EBMR-REC-032 HOLD LEGAL CMP-2026-04 blocks disposal of dependant batch:${dependant}`);
    });
    expect(await count(db.app, 'stub_b4.lot_record where lot_id = $1', [lot])).toBe('1');
    expect(await tombstones(key)).toBe('0');
  }, 60_000);

  it('[DI-47][INV-22] eligibility and purge look only at the record and its dependants: holds and changes on unrelated records neither block nor delay them', async () => {
    // An unrelated batch on hold, the dependant of a lot; it supports nothing of the purged record.
    const lot = randomUUID();
    const unrelated = await batchWithRecords(PAST_BATCH);
    await withCommand(db.app, again(qa), async (c) => {
      await createRetentionSchedule(c, 'component_lot', lot, 'COMPONENT_LOT_RECORD', { markets: ['IN'] });
      await linkRetentionDependency(c, `component_lot:${lot}`, `batch:${unrelated}`, 'COMPONENT_LOT_CONSUMED');
      await placeLegalHold(c, 'batch', unrelated, 'product liability claim', 'LEGAL-2026-09');
    });
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    expect((await retentionOf(db.app, 'batch', batch)).refusals).toEqual([]);
    await approve(key);

    // While a retention change and another hold on the unrelated batch are in progress, the purge
    // neither waits for them nor refuses.
    await withOpenCommands(async (open) => {
      const change = await open(again(qa));
      const purging = await open(purgeContext());
      await change.client.query('select records.update_retention_inputs($1, $2::jsonb, $3)', [`batch:${unrelated}`, JSON.stringify({ expiryDate: '2010-06-30' }), 'expiry corrected']);
      await change.client.query("select records.place_legal_hold('batch', $1, 'second claim', 'LEGAL-2026-12')", [unrelated]);
      await purging.client.query("set local lock_timeout = '3s'");
      const { rows } = await purging.client.query<{ id: string }>('select records.purge($1) as id', [key]);
      await purging.client.query('commit');
      expect(rows[0]?.id).toMatch(UUID);
    });
    expect(await batchRows(batch)).toBe('0');
    expect(await tombstones(key)).toBe('1');
    expect(await batchRows(unrelated)).toBe('1');
  }, 60_000);
});
