/**
 * Audit-trail verification and the protections around it, as hardened after the Phase 1 exit review:
 *
 * - the scheduled verification job keeps every run and raises a critical alarm naming each altered
 *   entry (DI-23 "the verification job alarms and names the entry");
 * - a malformed payload value is reported for its entry instead of aborting the run (finding F8);
 * - the Merkle root of an anchor does not depend on the database collation (finding F7);
 * - a guard or audit trigger that is disabled, dropped or replaced stops GMP writes, and every DROP is
 *   in the DDL log (finding F4);
 * - the audit trigger renders rows in one canonical form whatever the application's session settings
 *   (completeness critic: session TimeZone), so a row hash can be reproduced later;
 * - moving a row to another aggregate shows in both aggregates' trails (finding F77).
 *
 * Controls: DI-22, DI-23, DI-25, DI-45, DI-47; invariants INV-06, INV-07, INV-08.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChainVerification, verifyAllChains, verifyChain } from '../../src/audit/verify.ts';
import { KERNEL_MIGRATIONS, migrate } from '../../src/db/migrate.ts';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { asSuperuserTransaction, expectRefused } from '../identity/helpers.ts';
import { ADMIN_URL, createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
let base: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seededTestActor(db, { legalName: 'Verification Operator' });
});

afterAll(async () => {
  await db.drop();
});

const HASH = 'hash does not match the payload (event altered)';
const INDEXED = 'indexed columns differ from the hashed payload';
const actor = (overrides: Partial<ActorContext> = {}): ActorContext => ({ ...base, correlationId: randomUUID(), ...overrides });

async function insertSample(batchId: string, value: string): Promise<string> {
  return withCommand(db.app, actor(), async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into testgmp.sample (batch_id, value) values ($1, $2) returning id', [batchId, value]);
    return rows[0]?.id ?? '';
  });
}

async function chainOf(n: number): Promise<string> {
  const batch = randomUUID();
  for (let i = 1; i <= n; i++) await insertSample(batch, String(i));
  return `batch:${batch}`;
}

describe('the verification job (DI-23)', () => {
  it('[DI-23][INV-08] every run is kept; an intact trail raises no alarm', async () => {
    await chainOf(2);
    const run = await runChainVerification(db.app);
    expect(run).toMatchObject({ problems: [], alarm: null });
    expect(run.chainsChecked).toBeGreaterThan(0);
    const { rows } = await db.app.query<{ problem_count: number; alarm_severity: string | null; run_by: string }>(
      'select problem_count, alarm_severity, run_by from kernel.audit_verification_run where id = $1', [run.runId]);
    expect(rows).toEqual([{ problem_count: 0, alarm_severity: null, run_by: 'ebmr_app' }]);
  });

  it('[DI-23][INV-08][DI-03][DI-44] a chain altered in the database raises a critical alarm that names the entry, announced at once; the run record cannot be changed', async () => {
    const altered = await chainOf(3);
    const headless = await chainOf(2);
    const listener = new pg.Client({ connectionString: urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }) });
    await listener.connect();
    const notices: Record<string, unknown>[] = [];
    listener.on('notification', (m) => notices.push(JSON.parse(m.payload ?? '{}') as Record<string, unknown>));
    await listener.query('listen ebmr_integrity_alarm');
    const { rows: saved } = await db.admin.query<{ payload: unknown }>('select payload from kernel.audit_event where chain_key = $1 and seq = 2', [altered]);
    try {
      // A person with database rights changes an entry, and removes another chain's head row.
      await db.admin.query("update kernel.audit_event set payload = jsonb_set(payload, '{body,new,value}', '99') where chain_key = $1 and seq = 2", [altered]);
      await db.admin.query('delete from kernel.audit_chain_head where chain_key = $1', [headless]);

      const run = await runChainVerification(db.app);
      expect(run.alarm).toBe('CRITICAL');
      expect(run.problems).toContainEqual({ chainKey: altered, seq: 2, problem: HASH });
      expect(run.problems).toContainEqual({ chainKey: headless, seq: 2, problem: 'chain head is missing although the chain has events (head deleted)' });
      // The same problems through the whole-database check.
      const all = await verifyAllChains(db.app);
      expect(all).toEqual(expect.arrayContaining(run.problems));

      // The alarm is announced on the monitoring channel, naming the run and the first entry.
      for (let i = 0; i < 50 && !notices.some((n) => n['run_id'] === run.runId); i++) await new Promise((r) => setTimeout(r, 100));
      expect(notices.find((n) => n['run_id'] === run.runId)).toMatchObject({ severity: 'CRITICAL', source: 'kernel.audit_verification_run', problem_count: run.problems.length });

      // The record of the run is insert-only: not for the application, not even for the owner.
      await expect(db.app.query('update kernel.audit_verification_run set problem_count = 0 where id = $1', [run.runId])).rejects.toThrow(/permission denied/);
      await expect(db.app.query('delete from kernel.audit_verification_run where id = $1', [run.runId])).rejects.toThrow(/permission denied/);
      await expectRefused(db.admin.query("update kernel.audit_verification_run set problems = '[]', problem_count = 0, alarm_severity = null where id = $1", [run.runId]), 'EBMR-AUDIT-004');
      await expectRefused(db.admin.query('delete from kernel.audit_verification_run where id = $1', [run.runId]), 'EBMR-AUDIT-004');
    } finally {
      await listener.end();
      await db.admin.query('update kernel.audit_event set payload = $2 where chain_key = $1 and seq = 2', [altered, saved[0]?.payload]);
      await db.admin.query(
        `insert into kernel.audit_chain_head (chain_key, last_seq, last_hash, last_event)
         select e.chain_key, e.seq, e.hash, e.id from kernel.audit_event e where e.chain_key = $1 order by e.seq desc limit 1`, [headless]);
    }
    expect(await verifyChain(db.app, altered)).toEqual([]);
    expect(await verifyChain(db.app, headless)).toEqual([]);
  });
});

describe('a malformed payload is named, not fatal (F8)', () => {
  it('[INV-08][DI-23] a payload sequence number or correlation ID that is not a number or a UUID is reported for its entry, and the other chains are still verified', async () => {
    const a = await chainOf(2);
    const b = await chainOf(2);
    const intact = await chainOf(1);
    await asSuperuserTransaction(db, async (c) => {
      await c.query("update kernel.audit_event set payload = jsonb_set(payload, '{correlation_id}', '\"not-a-uuid\"') where chain_key = $1 and seq = 1", [a]);
      await c.query("update kernel.audit_event set payload = jsonb_set(payload, '{seq}', '\"two\"') where chain_key = $1 and seq = 2", [b]);
      expect(await verifyChain(c, a)).toEqual([{ chainKey: a, seq: 1, problem: HASH }, { chainKey: a, seq: 1, problem: INDEXED }]);
      expect(await verifyChain(c, b)).toEqual([{ chainKey: b, seq: 2, problem: HASH }, { chainKey: b, seq: 2, problem: INDEXED }]);
      const all = await verifyAllChains(c);
      expect(all.filter((p) => p.chainKey === a || p.chainKey === b)).toHaveLength(4);
      expect(all.filter((p) => p.chainKey === intact)).toEqual([]);
    });
  });

  it('[INV-08][DI-23] an anchor whose head carries a malformed sequence number is reported, not an error', async () => {
    const key = await chainOf(1);
    const { rows } = await db.app.query<{ id: string }>('select kernel.create_anchor() as id');
    await asSuperuserTransaction(db, async (c) => {
      await c.query(
        `update kernel.audit_anchor a set heads = (select jsonb_agg(case when h ->> 'chain_key' = $2 then jsonb_set(h, '{seq}', '"one"') else h end)
                                                   from jsonb_array_elements(a.heads) h) where a.id = $1`, [rows[0]?.id, key]);
      const { rows: problems } = await c.query<{ problem: string }>('select problem from kernel.verify_anchor($1)', [rows[0]?.id]);
      expect(problems.map((p) => p.problem)).toEqual(['anchor root does not match its heads', `chain ${key} at seq one differs from the anchor`]);
    });
  });
});

describe('anchors are independent of the database collation (F7)', () => {
  it('[INV-08][DI-23][DI-45] the Merkle root and the head order of an anchor are the same in a database with a linguistic collation', async () => {
    // Real chain-key shapes that sort differently byte-wise and under en-US rules.
    const heads = ['batch:0a1b2c3d', 'batch_number_register:SITE-1', 'retention:k-1', 'retention_rule_set:v1', 'batch-x:1'].map((k, i) => ({
      chain_key: k, seq: i + 1, hash_hex: randomBytes(32).toString('hex'),
    }));
    const name = `ebmr_t_icu_${randomBytes(5).toString('hex')}`;
    const server = new pg.Client({ connectionString: ADMIN_URL });
    await server.connect();
    await server.query(`create database ${name} template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US' locale 'C.UTF-8'`);
    try {
      const icu = new pg.Client({ connectionString: urlFor(name) });
      await icu.connect();
      try {
        await migrate(icu, [{ ...KERNEL_MIGRATIONS, include: /^00(01|10)_/ }]);
        // Precondition: this database really orders the keys differently from byte order.
        const { rows: order } = await icu.query<{ k: string[]; c: string[] }>(
          'select array_agg(k order by k) as k, array_agg(k order by k collate "C") as c from unnest($1::text[]) k', [heads.map((h) => h.chain_key)]);
        expect(order[0]?.k).not.toEqual(order[0]?.c);

        const root = async (c: pg.Client | pg.Pool) =>
          (await c.query<{ r: string }>("select encode(kernel.merkle_root($1::jsonb), 'hex') as r", [JSON.stringify(heads)])).rows[0]?.r;
        expect(await root(icu)).toBe(await root(db.admin));

        // An anchor taken there lists its heads in byte order, so its root matches the one computed here.
        for (const h of heads) {
          await icu.query('insert into kernel.audit_chain_head (chain_key, last_seq, last_hash, last_event) values ($1, $2, decode($3, \'hex\'), 0)', [h.chain_key, h.seq, h.hash_hex]);
        }
        const { rows: created } = await icu.query<{ id: string }>('select kernel.create_anchor() as id');
        const { rows: anchor } = await icu.query<{ heads: { chain_key: string }[]; root: string }>(
          "select a.heads, encode(a.merkle_root, 'hex') as root from kernel.audit_anchor a where a.id = $1", [created[0]?.id]);
        expect(anchor[0]?.heads.map((h) => h.chain_key)).toEqual(order[0]?.c);
        expect(anchor[0]?.root).toBe(await root(db.admin));
      } finally {
        await icu.end();
      }
    } finally {
      await server.query(`drop database if exists ${name} with (force)`);
      await server.end();
    }
  });
});

describe('the audit trail\'s protection cannot be removed unseen (F4)', () => {
  const guard = async (c: pg.PoolClient): Promise<boolean> => (await c.query<{ ok: boolean }>('select kernel.audit_triggers_ok() as ok')).rows[0]?.ok ?? true;

  it('[DI-23][INV-06] a disabled truncate guard, or a guard or audit trigger replaced by one that calls another function, stops GMP writes (EBMR-AUDIT-005)', async () => {
    await asSuperuserTransaction(db, async (c) => {
      expect(await guard(c)).toBe(true);
      await c.query('alter table testgmp.reading disable trigger aa_no_truncate_testgmp_reading');
      expect(await guard(c)).toBe(false);
      await expectRefused(c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor()))]), 'EBMR-AUDIT-005');
    });
    for (const [trigger, table, timing] of [
      ['aa_insert_only_testgmp_reading', 'testgmp.reading', 'before update or delete'],
      ['zz_audit_testgmp_sample', 'testgmp.sample', 'after insert or update or delete'],
    ] as const) {
      await asSuperuserTransaction(db, async (c) => {
        await c.query("create function testgmp.let_through() returns trigger language plpgsql as $$ begin return null; end $$");
        await c.query(`drop trigger ${trigger} on ${table}`);
        await c.query(`create trigger ${trigger} ${timing} on ${table} for each row execute function testgmp.let_through()`);
        expect(await guard(c), trigger).toBe(false);
        const { rows } = await c.query<{ command_tag: string; object_identity: string }>(
          "select command_tag, object_identity from kernel.ddl_log where command_tag = 'DROP TRIGGER' and object_identity like $1", [`${trigger} on %`]);
        expect(rows.length, `DROP TRIGGER ${trigger} is in the DDL log`).toBeGreaterThan(0);
      });
    }
  });

  it('[DI-23] a dropped table and a dropped column are recorded in kernel.ddl_log', async () => {
    await asSuperuserTransaction(db, async (c) => {
      const { rows: before } = await c.query<{ id: string }>('select coalesce(max(id), 0)::text as id from kernel.ddl_log');
      await c.query('create table testgmp.scratch (id int, extra text)');
      await c.query('alter table testgmp.scratch drop column extra');
      await c.query('drop table testgmp.scratch');
      const { rows } = await c.query<{ command_tag: string; object_identity: string }>(
        'select command_tag, object_identity from kernel.ddl_log where id > $1::bigint order by id', [before[0]?.id]);
      expect(rows).toEqual(expect.arrayContaining([
        { command_tag: 'ALTER TABLE', object_identity: 'testgmp.scratch.extra' },
        { command_tag: 'DROP TABLE', object_identity: 'testgmp.scratch' },
      ]));
    });
  });
});

describe('one canonical form of a row, whatever the session settings (critic: session TimeZone)', () => {
  beforeAll(async () => {
    await db.admin.query(`
      set role ebmr_owner;
      create table testgmp.timed_reading (id uuid primary key default gen_random_uuid(), batch_id uuid not null,
        taken_at timestamptz not null, span interval not null, ratio double precision not null, during tstzrange not null);
      create table testgmp.timed_entry (id uuid primary key default gen_random_uuid(), batch_id uuid not null,
        taken_at timestamptz not null, span interval not null, ratio double precision not null, during tstzrange not null);
      grant select, insert on testgmp.timed_reading to ebmr_app;
      grant select, insert, update on testgmp.timed_entry to ebmr_app;
      select kernel.register_audited_table('testgmp.timed_reading', 'batch', 'batch_id', true);
      select kernel.register_audited_table('testgmp.timed_entry', 'batch', 'batch_id', false);
      reset role;`);
  });

  it('[DI-22][DI-47][INV-08] rows written from a session with another TimeZone, IntervalStyle, DateStyle and float setting are hashed and recorded exactly as a default session renders them', async () => {
    const batch = randomUUID();
    const odd = new pg.Client({ connectionString: urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }) });
    await odd.connect();
    let ids: { reading: string; entry: string };
    try {
      await odd.query("set timezone = 'Pacific/Kiritimati'; set intervalstyle = 'sql_standard'; set datestyle = 'SQL, DMY'; set extra_float_digits = -3");
      await odd.query('begin');
      await odd.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor()))]);
      const values = "($1, '2026-01-02T03:04:05.123456Z', interval '5 hours 30 minutes', 0.1::float8 + 0.2::float8, tstzrange('2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'))";
      const reading = (await odd.query<{ id: string }>(`insert into testgmp.timed_reading (batch_id, taken_at, span, ratio, during) values ${values} returning id`, [batch])).rows[0]?.id ?? '';
      const entry = (await odd.query<{ id: string }>(`insert into testgmp.timed_entry (batch_id, taken_at, span, ratio, during) values ${values} returning id`, [batch])).rows[0]?.id ?? '';
      await odd.query('commit');
      ids = { reading, entry };
      // The canonical form does not follow the session either.
      const { rows: inOdd } = await odd.query<{ j: string }>('select kernel.row_json(r)::text as j from testgmp.timed_entry r where r.id = $1', [entry]);
      const { rows: inDefault } = await db.app.query<{ j: string }>('select kernel.row_json(r)::text as j from testgmp.timed_entry r where r.id = $1', [entry]);
      expect(inOdd[0]?.j).toBe(inDefault[0]?.j);
    } finally {
      await odd.end();
    }

    // Insert-only: the recorded row hash is reproducible from a default session.
    const { rows: hashes } = await db.app.query<{ recorded: string; recomputed: string }>(
      `select e.payload -> 'body' ->> 'row_hash' as recorded,
              (select encode(sha256(convert_to(kernel.row_json(r)::text, 'UTF8')), 'hex') from testgmp.timed_reading r where r.id = $2) as recomputed
         from kernel.audit_event e where e.chain_key = $1 and e.table_name = 'testgmp.timed_reading'`,
      [`batch:${batch}`, ids.reading]);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]?.recorded).toBe(hashes[0]?.recomputed);

    // Mutable: the recorded values are the canonical ones (UTC offset, default interval and float output).
    const { rows: recorded } = await db.app.query<{ v: Record<string, unknown> }>(
      "select e.payload -> 'body' -> 'new' as v from kernel.audit_event e where e.chain_key = $1 and e.table_name = 'testgmp.timed_entry'", [`batch:${batch}`]);
    expect(recorded[0]?.v).toMatchObject({
      taken_at: '2026-01-02T03:04:05.123456+00:00',
      span: '05:30:00',
      ratio: 0.30000000000000004,
      during: '["2026-01-02 00:00:00+00","2026-01-03 00:00:00+00")',
    });
  });
});

describe('moving a row to another aggregate (F77)', () => {
  it('[DI-22][DI-25][INV-07] an entry moved to another batch appears in both batches\' trails, and both still verify', async () => {
    const from = randomUUID();
    const to = randomUUID();
    const id = await insertSample(from, '4.2');
    await withCommand(db.app, actor({ reasonCode: 'WRONG_BATCH', reasonText: 'entered against the wrong batch' }), (c) =>
      c.query('update testgmp.sample set batch_id = $1 where id = $2', [to, id]));
    const trail = async (batch: string) =>
      (await db.app.query<{ action: string; record_id: string; old_batch: string | null; new_batch: string | null }>(
        `select action, record_id, payload -> 'body' -> 'old' ->> 'batch_id' as old_batch, payload -> 'body' -> 'new' ->> 'batch_id' as new_batch
           from kernel.audit_event where chain_key = $1 order by seq`, [`batch:${batch}`])).rows;
    expect(await trail(from)).toEqual([
      { action: 'INSERT', record_id: id, old_batch: null, new_batch: from },
      { action: 'UPDATE', record_id: id, old_batch: from, new_batch: to },
    ]);
    expect(await trail(to)).toEqual([{ action: 'UPDATE', record_id: id, old_batch: from, new_batch: to }]);
    expect(await verifyChain(db.app, `batch:${from}`)).toEqual([]);
    expect(await verifyChain(db.app, `batch:${to}`)).toEqual([]);
  });
});
