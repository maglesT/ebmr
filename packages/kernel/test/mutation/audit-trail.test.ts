/**
 * The audit trail, guard by guard (SQL mutation group "audit-trail": kernel.begin_command,
 * kernel.set_actor_context, kernel.actor_context_validated, kernel.current_actor,
 * kernel.append_audit_event, kernel.audit_row_change and kernel.verify_chain in kernel 0010). The
 * module tests in test/audit and test/identity go through kernel.begin_command and the audited test
 * tables; these tests close the gaps the SQL mutation run (tools/sql-mutation) found: every refusal
 * is asserted by its stable EBMR code and message, the audit writer is exercised directly (through
 * kernel.audit_business_event, which the application may call), and every tamper-evidence check of
 * kernel.verify_chain is proven to fire on its own, with the other checks satisfied.
 *
 * Controls: DI-22 (who, what, when, how and why of every GMP change; only contexts installed by
 * kernel code are attributed, ADR-0016), DI-23 (always on, tamper-evident, the altered entry is
 * named), DI-24 (changes and removals need a reason); invariants INV-07 (every GMP write is attributed
 * to a declared actor in the same transaction), INV-08 (every chain verifies from its last checkpoint)
 * and INV-16 (recorded_at is the database clock).
 *
 * Tampering needs superuser rights; it always runs in a superuser transaction that is rolled back
 * (asSuperuserTransaction), and kernel.verify_chain is asked inside that transaction.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/audit/verify.ts';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { asSuperuserTransaction, expectRefused } from '../identity/helpers.ts';
import { seedActor, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let op: SeededActor;
beforeAll(async () => {
  db = await createTestDatabase();
  op = await seedActor(db, { legalName: 'Audit Mutation Operator', acknowledgeEsig: false });
});
afterAll(async () => {
  // pool.end() resolves before its sockets close; DROP DATABASE ... WITH (FORCE) may then terminate a
  // closing client, which the pool re-emits as an 'error' event. That is teardown noise, not a result.
  for (const pool of [db.admin, db.app]) pool.on('error', () => undefined);
  await db.drop();
});

const INSERT_SAMPLE = 'insert into testgmp.sample (batch_id, value) values ($1, $2) returning id';
const BUSINESS = "select kernel.audit_business_event($1, 'weighing recorded, 12.503 kg, balance B-17') as id";
const INDEXED = 'indexed columns differ from the hashed payload';
const HEAD = 'chain head does not match the last event (events removed or head altered)';

/** The seeded operator in a new command (fresh correlation ID). */
const cmd = (extra: Partial<ActorContext> = {}): ActorContext => ({ ...op, correlationId: randomUUID(), ...extra });
const ctxJson = (a: ActorContext): string => JSON.stringify(toDbContext(a));

async function insertSample(batchId: string, value: string, ctx = cmd()): Promise<string> {
  return withCommand(db.app, ctx, async (c) => (await c.query<{ id: string }>(INSERT_SAMPLE, [batchId, value])).rows[0]?.id ?? '');
}

/** A chain `batch:<id>` of `n` INSERT events, one command each. */
async function chainOf(n: number): Promise<string> {
  const batch = randomUUID();
  for (let i = 1; i <= n; i++) await insertSample(batch, String(i));
  return `batch:${batch}`;
}

async function eventCount(chainKey: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>('select count(*) as n from kernel.audit_event where chain_key = $1', [chainKey]);
  return Number(rows[0]?.n);
}

/** A brand-new application-role connection: nothing has ever set ebmr.ctx in it. */
async function onFreshConnection<T>(work: (c: pg.Client) => Promise<T>, as: 'app' | 'admin' = 'app'): Promise<T> {
  const c = new pg.Client({ connectionString: as === 'app' ? urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }) : urlFor(db.name) });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

/** An application-role transaction that is always rolled back. */
async function inAppTransaction(work: (c: pg.PoolClient) => Promise<unknown>): Promise<void> {
  const c = await db.app.connect();
  try {
    await c.query('begin');
    await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** One statement that must be refused with `code`, inside a savepoint of an open transaction. */
async function refusedIn(c: pg.PoolClient | pg.Client, sql: string, params: unknown[], code: string, fragment?: string | RegExp): Promise<void> {
  await c.query('savepoint refused');
  try {
    await expectRefused(c.query(sql, params), code, fragment);
  } finally {
    await c.query('rollback to savepoint refused');
  }
}

/** Like withCommand, for a raw database context (to send values the TypeScript type does not allow). */
async function withCommandRaw<T>(ctx: Record<string, string>, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.app.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(ctx)]);
    const result = await work(c);
    await c.query('commit');
    return result;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

describe('kernel.begin_command: the actor context is checked before anything is attributed', () => {
  it('[INV-07][DI-22] a missing actor context, or one that is not a JSON object, is refused as "actor context is required"', async () => {
    const valid = toDbContext(cmd());
    for (const raw of [null, '[]', JSON.stringify([valid]), JSON.stringify('UI'), '42', 'null']) {
      await expectRefused(db.app.query('select kernel.begin_command($1::jsonb)', [raw]), 'EBMR-AUDIT-001', /^EBMR-AUDIT-001 actor context is required$/);
    }
  });

  it('[INV-07][DI-22] only the sources UI, API, INTEGRATION and SYSTEM are accepted, even for a real, active person on its own session', async () => {
    const batch = randomUUID();
    for (const source of ['KIOSK', 'ui', 'CONSOLE', 'SCRIPT']) {
      const ctx = { ...toDbContext(cmd()), source };
      await expectRefused(
        withCommandRaw(ctx, (c) => c.query(INSERT_SAMPLE, [batch, '1'])),
        'EBMR-AUDIT-001',
        /source must be UI, API, INTEGRATION or SYSTEM/,
      );
    }
    expect(await eventCount(`batch:${batch}`)).toBe(0);
    // The same person, session and device with a listed source is accepted and recorded with it.
    await insertSample(batch, '1', cmd({ source: 'API' }));
    const { rows } = await db.app.query<{ source: string }>("select payload ->> 'source' as source from kernel.audit_event where chain_key = $1", [`batch:${batch}`]);
    expect(rows).toEqual([{ source: 'API' }]);
  });
});

describe('only a context installed by kernel code in this transaction is an actor (ADR-0016)', () => {
  it('[INV-07][DI-22] on a connection that never declared an actor, current_actor() is empty and a GMP write or business entry is refused with EBMR-AUDIT-001', async () => {
    const batch = randomUUID();
    await onFreshConnection(async (c) => {
      const { rows } = await c.query<{ actor: unknown }>('select kernel.current_actor() as actor');
      expect(rows[0]?.actor).toBeNull();
    });
    await onFreshConnection((c) => expectRefused(c.query(INSERT_SAMPLE, [batch, '1']), 'EBMR-AUDIT-001', /no actor context: call kernel.begin_command first/));
    await onFreshConnection((c) => expectRefused(c.query(BUSINESS, [`batch:${batch}`]), 'EBMR-AUDIT-001', /no actor context: call kernel.begin_command first/));
    expect(await eventCount(`batch:${batch}`)).toBe(0);
  });

  it('[INV-07][DI-22] the audit writer itself refuses a business entry with no actor (EBMR-AUDIT-001) and with a context set by set_config (EBMR-AUDIT-009)', async () => {
    const key = `batch:${randomUUID()}`;
    await expectRefused(db.app.query(BUSINESS, [key]), 'EBMR-AUDIT-001', /no actor context/);
    await inAppTransaction(async (c) => {
      await c.query("select set_config('ebmr.ctx', '', true)");
      await refusedIn(c, BUSINESS, [key], 'EBMR-AUDIT-001', /no actor context/);
      // A well-formed context of a real, active person, but not installed by kernel.begin_command.
      await c.query("select set_config('ebmr.ctx', $1, true)", [ctxJson(cmd())]);
      await refusedIn(c, BUSINESS, [key], 'EBMR-AUDIT-009', /not established by kernel.begin_command/);
      // The same after the transaction has written something (it has a transaction ID).
      await c.query('select pg_current_xact_id()');
      await refusedIn(c, BUSINESS, [key], 'EBMR-AUDIT-009');
    });
    expect(await eventCount(key)).toBe(0);
  });

  it('[DI-22][DI-23][INV-07] a context not established by kernel code is ignored at once, without touching the marker table: a lock held on it neither delays nor fails the answer', async () => {
    // A transaction with no transaction ID cannot own a marker, so a context set by set_config in it is
    // rejected before kernel.command_marker is even looked at. Maintenance on the marker table (VACUUM
    // FULL, TRUNCATE, ALTER, autovacuum's truncation) holds this lock, and a hot standby never has a
    // transaction ID; neither may turn "no actor" into a lock wait or an error.
    const key = `batch:${randomUUID()}`;
    await asSuperuserTransaction(db, async (locker) => {
      await locker.query('lock table kernel.command_marker in access exclusive mode');
      await onFreshConnection(async (c) => {
        await c.query("set lock_timeout = '500ms'");
        await c.query('begin');
        try {
          await c.query("select set_config('ebmr.ctx', $1, true)", [ctxJson(cmd())]);
          const { rows } = await c.query<{ actor: unknown; xact: string | null }>(
            'select kernel.current_actor() as actor, pg_current_xact_id_if_assigned()::text as xact',
          );
          expect(rows[0]).toEqual({ actor: null, xact: null });
          // The audit writer refuses the same context for what it is, not with a lock timeout.
          await refusedIn(c, BUSINESS, [key], 'EBMR-AUDIT-009', /not established by kernel.begin_command/);
        } finally {
          await c.query('rollback');
        }
      });
    });
    expect(await eventCount(key)).toBe(0);
  });

  it('[INV-07][DI-22] a validated command whose context is overwritten with text that is not JSON has no actor: current_actor() is empty and writes are refused', async () => {
    const batch = randomUUID();
    await inAppTransaction(async (c) => {
      await c.query('select kernel.begin_command($1::jsonb)', [ctxJson(cmd())]);
      await c.query(INSERT_SAMPLE, [batch, '1']);
      await c.query("select set_config('ebmr.ctx', 'operator 17, trust me', true)");
      const { rows } = await c.query<{ actor: unknown }>('select kernel.current_actor() as actor');
      expect(rows[0]?.actor).toBeNull();
      await refusedIn(c, INSERT_SAMPLE, [batch, '2'], 'EBMR-AUDIT-009');
      await refusedIn(c, BUSINESS, [`batch:${batch}`], 'EBMR-AUDIT-009');
    });
  });

  it('[INV-07][DI-24] a change or removal without a declared actor is refused as "no actor context" (EBMR-AUDIT-001), not merely for a missing reason', async () => {
    const batch = randomUUID();
    const id = await insertSample(batch, '3.5');
    await expectRefused(db.app.query("update testgmp.sample set note = 'edited' where id = $1", [id]), 'EBMR-AUDIT-001', /no actor context/);
    await expectRefused(db.app.query('delete from testgmp.sample where id = $1', [id]), 'EBMR-AUDIT-001', /no actor context/);
    // The same through a connection that never declared an actor.
    await onFreshConnection((c) => expectRefused(c.query("update testgmp.sample set note = 'edited' where id = $1", [id]), 'EBMR-AUDIT-001'));
    const { rows } = await db.app.query<{ value: string; note: string | null }>('select value::text as value, note from testgmp.sample where id = $1', [id]);
    expect(rows).toEqual([{ value: '3.5', note: null }]);
    expect(await eventCount(`batch:${batch}`)).toBe(1);
  });

  it('[INV-07][DI-22] kernel code changes the actor context of its own transaction only: a session-level ebmr.ctx is left as it was and is never trusted', async () => {
    const sessionValue = ctxJson(cmd());
    const batch = randomUUID();
    await onFreshConnection(async (c) => {
      await c.query("select set_config('ebmr.ctx', $1, false)", [sessionValue]);
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [ctxJson(cmd())]);
      await c.query(INSERT_SAMPLE, [batch, '1']);
      // Owner-level code clears the context (as the catalogue migrations do after their inserts).
      await c.query('select kernel.set_actor_context(null)');
      expect((await c.query<{ actor: unknown }>('select kernel.current_actor() as actor')).rows[0]?.actor).toBeNull();
      await refusedIn(c, INSERT_SAMPLE, [batch, '2'], 'EBMR-AUDIT-001');
      await c.query('commit');
      const { rows } = await c.query<{ v: string; actor: unknown }>("select current_setting('ebmr.ctx') as v, kernel.current_actor() as actor");
      expect(rows[0]).toEqual({ v: sessionValue, actor: null });
      await expectRefused(c.query(INSERT_SAMPLE, [batch, '3']), 'EBMR-AUDIT-009');
    }, 'admin');
    expect(await eventCount(`batch:${batch}`)).toBe(1);
  });

  it('[INV-07][DI-22] an internal actor installed inside a command and then restored through kernel.set_actor_context leaves the command attributed to its own actor; set_config cannot put either context back', async () => {
    const outer = cmd();
    const batch = randomUUID();
    await asSuperuserTransaction(db, async (c) => {
      await c.query('select kernel.begin_command($1::jsonb)', [ctxJson(outer)]);
      await c.query(INSERT_SAMPLE, [batch, '1']);
      // What iam.authn_change_secret and the installation bootstrap keep before they switch: the validated actor.
      const saved = (await c.query<{ actor: Record<string, string> }>('select kernel.current_actor() as actor')).rows[0]?.actor;
      expect(saved).toEqual(toDbContext(outer));
      const savedText = (await c.query<{ v: string }>("select current_setting('ebmr.ctx') as v")).rows[0]?.v ?? '';
      const internal = { ...toDbContext(outer), role_code: 'SELF_SERVICE', reason_code: 'CREDENTIAL_CHANGE', reason_text: 'internal step' };
      await c.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify(internal)]);
      await c.query(INSERT_SAMPLE, [batch, '2']);
      // ADR-0016: only the context installed last is validated. set_config back to the command's own
      // context is not a restore: that context stopped counting when the internal actor was installed.
      await c.query("select set_config('ebmr.ctx', $1, true)", [savedText]);
      expect((await c.query<{ actor: unknown }>('select kernel.current_actor() as actor')).rows[0]?.actor).toBeNull();
      await refusedIn(c, INSERT_SAMPLE, [batch, '22'], 'EBMR-AUDIT-009');
      // The restore goes through the kernel, with the context current_actor() returned before the switch.
      await c.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify(saved)]);
      const { rows: now } = await c.query<{ actor: Record<string, string> | null }>('select kernel.current_actor() as actor');
      expect(now[0]?.actor).toEqual(toDbContext(outer));
      await c.query(INSERT_SAMPLE, [batch, '3']);
      // The internal actor's context is gone for good: set_config cannot bring it back either.
      await c.query("select set_config('ebmr.ctx', $1, true)", [JSON.stringify(internal)]);
      expect((await c.query<{ actor: unknown }>('select kernel.current_actor() as actor')).rows[0]?.actor).toBeNull();
      await refusedIn(c, INSERT_SAMPLE, [batch, '4'], 'EBMR-AUDIT-009');
      const { rows } = await c.query<{ role: string }>(
        "select payload -> 'actor' ->> 'role_code' as role from kernel.audit_event where chain_key = $1 order by seq",
        [`batch:${batch}`],
      );
      expect(rows.map((r) => r.role)).toEqual(['OPERATOR', 'SELF_SERVICE', 'OPERATOR']);
    });
  });

  it('[INV-07][DI-22] each new command prunes the markers of its own connection\'s finished transactions, so only the current one is left', async () => {
    const batch = randomUUID();
    await onFreshConnection(async (c) => {
      const pid = (await c.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
      const xacts: string[] = [];
      for (const v of ['1', '2', '3']) {
        await c.query('begin');
        await c.query('select kernel.begin_command($1::jsonb)', [ctxJson(cmd())]);
        await c.query(INSERT_SAMPLE, [batch, v]);
        xacts.push((await c.query<{ x: string }>('select pg_current_xact_id()::text as x')).rows[0]?.x ?? '');
        await c.query('commit');
      }
      const { rows } = await db.admin.query<{ x: string }>('select xact_id::text as x from kernel.command_marker where backend_pid = $1', [pid]);
      expect(rows).toEqual([{ x: xacts[2] }]);
    });
    expect(await eventCount(`batch:${batch}`)).toBe(3);
  });
});

describe('kernel.audit_row_change: a change or removal after first entry needs a reason (outline 5.4)', () => {
  it('[DI-24][DI-22] a change or removal needs both halves of the reason: a reason code without a text, or a text without a code, is refused (EBMR-AUDIT-002) and nothing changes', async () => {
    const batch = randomUUID();
    const id = await insertSample(batch, '4.25');
    const halves: Partial<ActorContext>[] = [
      { reasonCode: 'TRANSCRIPTION_ERROR' }, // a code, no text
      { reasonCode: 'TRANSCRIPTION_ERROR', reasonText: ' \t ' }, // a code, a blank text
      { reasonText: 'wrong digit entered' }, // a text, no code
      { reasonCode: '  ', reasonText: 'wrong digit entered' }, // a blank code, a text
    ];
    for (const reason of halves) {
      await expectRefused(
        withCommand(db.app, cmd(reason), (c) => c.query("update testgmp.sample set note = 'edited' where id = $1", [id])),
        'EBMR-AUDIT-002',
        /^EBMR-AUDIT-002 a reason is required to update testgmp\.sample: give a reason code and a reason text$/,
      );
      await expectRefused(
        withCommand(db.app, cmd(reason), (c) => c.query('delete from testgmp.sample where id = $1', [id])),
        'EBMR-AUDIT-002',
        /^EBMR-AUDIT-002 a reason is required to delete testgmp\.sample: give a reason code and a reason text$/,
      );
    }
    const { rows } = await db.app.query<{ value: string; note: string | null }>('select value::text as value, note from testgmp.sample where id = $1', [id]);
    expect(rows).toEqual([{ value: '4.25', note: null }]);
    expect(await eventCount(`batch:${batch}`)).toBe(1);
    // Both halves given: the same change is accepted and recorded with its reason.
    await withCommand(db.app, cmd({ reasonCode: 'TRANSCRIPTION_ERROR', reasonText: 'wrong digit entered' }), (c) =>
      c.query("update testgmp.sample set note = 'edited' where id = $1", [id]));
    const { rows: trail } = await db.app.query<{ action: string; code: string | null; text: string | null }>(
      "select action, payload ->> 'reason_code' as code, payload ->> 'reason_text' as text from kernel.audit_event where chain_key = $1 order by seq",
      [`batch:${batch}`],
    );
    expect(trail.map((e) => [e.action, e.code, e.text])).toEqual([
      ['INSERT', null, null],
      ['UPDATE', 'TRANSCRIPTION_ERROR', 'wrong digit entered'],
    ]);
  });
});

describe('an audited table that is not registered refuses writes', () => {
  it('[DI-23][INV-07] a table carrying the audit trigger without a registration, or whose registration was removed, refuses every write (EBMR-AUDIT-003)', async () => {
    await asSuperuserTransaction(db, async (c) => {
      await c.query('create table testgmp.unregistered (id uuid primary key default gen_random_uuid(), batch_id uuid not null, value numeric not null)');
      await c.query('create trigger zz_audit_testgmp_unregistered after insert or update or delete on testgmp.unregistered for each row execute function kernel.audit_row_change()');
      await c.query('select kernel.begin_command($1::jsonb)', [ctxJson(cmd())]);
      await refusedIn(c, 'insert into testgmp.unregistered (batch_id, value) values (gen_random_uuid(), 1)', [], 'EBMR-AUDIT-003', /testgmp\.unregistered is not registered for audit/);
    });
    await asSuperuserTransaction(db, async (c) => {
      await c.query("delete from kernel.audited_table where table_name = 'testgmp.sample'::regclass");
      await c.query('select kernel.begin_command($1::jsonb)', [ctxJson(cmd())]);
      await refusedIn(c, INSERT_SAMPLE, [randomUUID(), '1'], 'EBMR-AUDIT-003', /testgmp\.sample is not registered for audit/);
    });
  });
});

describe('kernel.verify_chain: every check fires on its own', () => {
  it('[INV-08][DI-23] a chain verified from a later sequence number (its checkpoint) links to the stored hash of the event before it', async () => {
    // The chain under test is interleaved with another chain, so neither is stored contiguously.
    const batch = randomUUID();
    const other = randomUUID();
    await insertSample(other, '0');
    for (const v of ['1', '2', '3', '4']) {
      await insertSample(batch, v);
      await insertSample(other, v);
    }
    const key = `batch:${batch}`;
    for (const from of [1, 2, 3, 4]) expect(await verifyChain(db.app, key, from)).toEqual([]);
    expect(await verifyChain(db.app, `batch:${other}`, 3)).toEqual([]);
    // A forged hash of the event just before the starting point is detected at the starting point.
    await asSuperuserTransaction(db, async (c) => {
      await c.query("update kernel.audit_event set hash = sha256('forged'::bytea) where chain_key = $1 and seq = 2", [key]);
      expect(await verifyChain(c, key, 3)).toEqual([{ chainKey: key, seq: 3, problem: 'prev_hash does not match the previous event' }]);
    });
  });

  it('[INV-08][DI-23] deleting the first entry and renumbering the next one, hashes recomputed, is caught by the hashed sequence number', async () => {
    const key = await chainOf(2);
    await asSuperuserTransaction(db, async (c) => {
      await c.query('delete from kernel.audit_event where chain_key = $1 and seq = 1', [key]);
      await c.query(
        `update kernel.audit_event
            set seq = 1, prev_hash = sha256(convert_to('genesis:' || chain_key, 'UTF8')),
                hash = sha256(sha256(convert_to('genesis:' || chain_key, 'UTF8')) || convert_to(payload::text, 'UTF8'))
          where chain_key = $1 and seq = 2`,
        [key],
      );
      await c.query(
        `update kernel.audit_chain_head h set last_seq = 1, last_hash = e.hash, last_event = e.id
           from kernel.audit_event e where h.chain_key = $1 and e.chain_key = $1 and e.seq = 1`,
        [key],
      );
      expect(await verifyChain(c, key)).toEqual([{ chainKey: key, seq: 1, problem: INDEXED }]);
    });
  });

  it('[INV-08][DI-23] an entry moved to another record\'s chain, hashes recomputed, is caught by the hashed chain key', async () => {
    const key = await chainOf(1);
    const moved = `batch:${randomUUID()}`;
    await asSuperuserTransaction(db, async (c) => {
      await c.query(
        `update kernel.audit_event
            set chain_key = $2::text, prev_hash = sha256(convert_to('genesis:' || $2::text, 'UTF8')),
                hash = sha256(sha256(convert_to('genesis:' || $2::text, 'UTF8')) || convert_to(payload::text, 'UTF8'))
          where chain_key = $1 and seq = 1`,
        [key, moved],
      );
      // A consistent forger also gives the target chain a matching head, so only the chain-key check can fire.
      await c.query(
        `insert into kernel.audit_chain_head (chain_key, last_seq, last_hash, last_event)
         select e.chain_key, e.seq, e.hash, e.id from kernel.audit_event e where e.chain_key = $1`,
        [moved],
      );
      expect(await verifyChain(c, moved)).toEqual([{ chainKey: moved, seq: 1, problem: INDEXED }]);
    });
  });

  it('[INV-08][DI-23][DI-22] changing only the stored action, correlation ID or recorded time of an entry is detected and the entry is named', async () => {
    const tampers: [string, string][] = [
      ['action', "update kernel.audit_event set action = 'UPDATE' where chain_key = $1 and seq = 2"],
      ['correlation ID', 'update kernel.audit_event set correlation_id = gen_random_uuid() where chain_key = $1 and seq = 2'],
      ['recorded time (INV-16)', "update kernel.audit_event set recorded_at = recorded_at - interval '1 hour' where chain_key = $1 and seq = 2"],
    ];
    for (const [what, sql] of tampers) {
      const key = await chainOf(3);
      await asSuperuserTransaction(db, async (c) => {
        await c.query(sql, [key]);
        expect(await verifyChain(c, key), what).toEqual([{ chainKey: key, seq: 2, problem: INDEXED }]);
      });
    }
  });

  it('[INV-08][DI-23][DI-22] changing only the stored table or only the stored record ID of an entry is detected and the entry is named', async () => {
    // Each column on its own: the other indexed columns still match the hashed payload, and the hash
    // itself is untouched (it covers the payload, not the stored columns), so only this check can fire.
    const tampers: [string, string][] = [
      ['table', "update kernel.audit_event set table_name = 'testgmp.reading' where chain_key = $1 and seq = 2"],
      ['record ID', 'update kernel.audit_event set record_id = gen_random_uuid()::text where chain_key = $1 and seq = 2'],
    ];
    for (const [what, sql] of tampers) {
      const key = await chainOf(3);
      await asSuperuserTransaction(db, async (c) => {
        const { rowCount } = await c.query(sql, [key]);
        expect(rowCount, what).toBe(1);
        expect(await verifyChain(c, key), what).toEqual([{ chainKey: key, seq: 2, problem: INDEXED }]);
      });
      expect(await verifyChain(db.app, key), what).toEqual([]);
    }
  });

  it('[INV-08][DI-23] removing the last entry with the head hash repointed, or overwriting only the head hash, is detected at the head', async () => {
    const truncated = await chainOf(3);
    await asSuperuserTransaction(db, async (c) => {
      await c.query('delete from kernel.audit_event where chain_key = $1 and seq = 3', [truncated]);
      await c.query('update kernel.audit_chain_head h set last_hash = e.hash from kernel.audit_event e where h.chain_key = $1 and e.chain_key = $1 and e.seq = 2', [truncated]);
      expect(await verifyChain(c, truncated)).toEqual([{ chainKey: truncated, seq: 3, problem: HEAD }]);
    });
    const overwritten = await chainOf(3);
    await asSuperuserTransaction(db, async (c) => {
      await c.query("update kernel.audit_chain_head set last_hash = sha256('forged'::bytea) where chain_key = $1", [overwritten]);
      expect(await verifyChain(c, overwritten)).toEqual([{ chainKey: overwritten, seq: 3, problem: HEAD }]);
    });
    expect(await verifyChain(db.app, truncated)).toEqual([]);
    expect(await verifyChain(db.app, overwritten)).toEqual([]);
  });
});
