/**
 * What the audit trail's settled horizon relies on in the kernel (DI-22; review P11, kernel items K1/K2).
 *
 * The tablets viewer pages audit entries across chains by entry id. An id is drawn when the row is inserted, not when
 * its transaction commits, so the viewer stops at a horizon: the highest id below which no transaction that holds a
 * write lock on kernel.audit_event can still commit an entry (apps/tablets-server/src/features/audit/horizon.ts). That
 * is sound only while these kernel facts hold, so each is pinned here, next to the kernel that provides them:
 *  - the id is an identity GENERATED ALWAYS with a cache of 1, a step of 1 and no cycling, so ids follow the order in
 *    which rows are inserted, across sessions, and never go back (a larger cache hands each session its own block);
 *  - nobody but the owner can draw an id, move the sequence, insert an entry or renumber one: no grant on the sequence,
 *    no INSERT or UPDATE on the table for anyone else, and no login role that can act as the owner or write all data;
 *  - the owner's own code has one writer, kernel.append_audit_event, which takes the id from the identity; no routine
 *    overrides the identity or updates an entry; the routines that move sequences (the continuity restore procedure)
 *    plan the audit id's move forward only; and no rule or row trigger can change an entry's id on its way in;
 *  - a transaction that appends an entry holds RowExclusiveLock on kernel.audit_event from before it draws the id until
 *    it ends, while a transaction that has only a transaction id (it wrote elsewhere) holds none.
 * If one of these has to change, the horizon has to change with it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toDbContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

/** Routines of this database (not the system catalogs) whose source matches a case-insensitive regular expression. */
async function routinesMatching(pattern: string): Promise<string[]> {
  const { rows } = await db.admin.query<{ routine: string }>(
    `select p.oid::regprocedure::text as routine
       from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc ~* $1
      order by p.oid::regprocedure::text collate "C"`,
    [pattern],
  );
  return rows.map((r) => r.routine);
}

/** The SQLSTATE a statement fails with as `role`, or 'allowed'. */
async function outcomeAs(role: string, statement: string): Promise<string> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query(statement);
    return 'allowed';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

describe('the kernel facts the audit horizon relies on (DI-22)', () => {
  it('[DI-22] audit entry ids come from an identity generated always, cache 1, step 1, no cycle, and its sequence grants nothing', async () => {
    const { rows } = await db.admin.query<{ identity: string; seq: string; cache: string; step: string; cycles: boolean; grants: string[] }>(
      `select a.attidentity::text as identity, pg_get_serial_sequence('kernel.audit_event', 'id') as seq,
              s.seqcache::text as cache, s.seqincrement::text as step, s.seqcycle as cycles,
              array(select x.privilege_type || ' to ' || x.grantee::regrole::text
                      from pg_class c cross join lateral aclexplode(c.relacl) x
                     where c.oid = s.seqrelid and x.grantee <> c.relowner
                     order by 1) as grants
         from pg_attribute a
         join pg_sequence s on s.seqrelid = pg_get_serial_sequence('kernel.audit_event', 'id')::regclass
        where a.attrelid = 'kernel.audit_event'::regclass and a.attname = 'id'`,
    );
    expect(rows[0]).toEqual({ identity: 'a', seq: 'kernel.audit_event_id_seq', cache: '1', step: '1', cycles: false, grants: [] });
  });

  it('[DI-22] no login role of the kernel can draw an audit id, move its sequence, insert an entry or renumber one', async () => {
    // Table grants to anyone but the owner: reading only.
    const { rows: tableGrants } = await db.admin.query<{ grant: string }>(
      `select x.privilege_type || ' to ' || x.grantee::regrole::text as grant
         from pg_class c cross join lateral aclexplode(c.relacl) x
        where c.oid = 'kernel.audit_event'::regclass and x.grantee <> c.relowner and x.privilege_type <> 'SELECT'`,
    );
    expect(tableGrants).toEqual([]);

    // No login role of the kernel (the application, the authentication service, the sandbox) can act as the owner or
    // holds a predefined role that writes all data.
    const { rows: roles } = await db.admin.query<{ role: string; owner: boolean; writeAll: boolean }>(
      `select r.rolname as role,
              pg_has_role(r.oid, (select c.relowner from pg_class c where c.oid = 'kernel.audit_event'::regclass), 'MEMBER') as owner,
              pg_has_role(r.oid, 'pg_write_all_data', 'MEMBER') as "writeAll"
         from pg_roles r where r.rolcanlogin and not r.rolsuper and r.rolname like 'ebmr\\_%' order by 1`,
    );
    const kernelRoles = roles.map((r) => r.role);
    expect(kernelRoles).toEqual(expect.arrayContaining(['ebmr_app', 'ebmr_authn']));
    expect(roles.filter((r) => r.owner || r.writeAll)).toEqual([]);

    // Each of them, tried one by one, is refused (42501) whatever it attempts.
    const attempts = [
      `select nextval('kernel.audit_event_id_seq')`,
      `select setval('kernel.audit_event_id_seq', 1)`,
      `insert into kernel.audit_event (chain_key, seq, prev_hash, hash, recorded_at, correlation_id, action, payload)
       values ('p11:x', 1, '\\x00', '\\x00', now(), gen_random_uuid(), 'BUSINESS', '{}')`,
      `insert into kernel.audit_event (id, chain_key, seq, prev_hash, hash, recorded_at, correlation_id, action, payload)
       overriding system value values (1, 'p11:x', 1, '\\x00', '\\x00', now(), gen_random_uuid(), 'BUSINESS', '{}')`,
      `update kernel.audit_event set id = default where false`,
    ];
    for (const role of kernelRoles) {
      for (const statement of attempts) {
        expect({ role, statement, outcome: await outcomeAs(role, statement) }).toEqual({ role, statement, outcome: '42501' });
      }
    }
  });

  it('[DI-22] the owner has one audit writer, which takes the id from the identity; nothing else inserts, renumbers or moves audit ids back', async () => {
    const insertsEntries = '\\minsert\\s+into\\s+(kernel\\s*\\.\\s*)?"?audit_event"?[\\s(]';
    expect(await routinesMatching(insertsEntries)).toEqual(['kernel.append_audit_event(text,text,text,text,jsonb)']);
    const { rows } = await db.admin.query<{ src: string }>(`select prosrc as src from pg_proc where oid = 'kernel.append_audit_event(text,text,text,text,jsonb)'::regprocedure`);
    const inserts = [...(rows[0]?.src ?? '').matchAll(/insert\s+into\s+kernel\.audit_event\s*\(([^)]*)\)/gi)].map((m) => (m[1] ?? '').split(',').map((c) => c.trim()));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).not.toContain('id');
    expect(inserts[0]).toContain('chain_key');

    // No routine overrides the identity of an audit entry or updates an entry (an UPDATE could set id = DEFAULT). The
    // search sees the routines that name the table (in PostgreSQL's regular expressions `.` also matches a newline).
    expect(await routinesMatching('\\maudit_event\\M')).toContain('kernel.append_audit_event(text,text,text,text,jsonb)');
    expect(await routinesMatching('\\maudit_event\\M.*\\moverriding\\M|\\moverriding\\M.*\\maudit_event\\M')).toEqual([]);
    expect(await routinesMatching('\\mupdate\\s+(only\\s+)?(kernel\\s*\\.\\s*)?"?audit_event\\M')).toEqual([]);

    // The sequence is named by one routine, which only reads its last value (no nextval, no setval by name).
    expect(await routinesMatching("audit_event_id_seq|pg_get_serial_sequence\\s*\\(\\s*'kernel\\.audit_event'")).toEqual(['platform.audit_position()']);
    // Sequences are moved only by the continuity restore procedure, which plans every move of the audit id forward.
    expect(await routinesMatching('\\msetval\\s*\\(')).toEqual(['continuity.after_restore(uuid,jsonb,bigint,jsonb)', 'continuity.secure_identifiers(jsonb,jsonb,bigint)']);
    for (const secured of [false, true]) {
      const { rows: plan } = await db.admin.query<{ before: string; after: string }>(
        `select m ->> 'value_before' as before, m ->> 'value_after' as after
           from jsonb_array_elements(continuity.plan_sequence_moves('[]'::jsonb, 1, $1)) m where m ->> 'sequence_key' = 'kernel.audit_event.id'`,
        [secured],
      );
      expect(plan).toHaveLength(1);
      expect(BigInt(plan[0]?.after ?? '0') >= BigInt(plan[0]?.before ?? '1')).toBe(true);
    }

    // Nothing on the way in can change an entry's id: no rule, and no row-level trigger before INSERT or UPDATE.
    const { rows: rules } = await db.admin.query(`select rulename from pg_rules where schemaname = 'kernel' and tablename = 'audit_event'`);
    expect(rules).toEqual([]);
    const { rows: rowTriggers } = await db.admin.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid = 'kernel.audit_event'::regclass and not tgisinternal
          and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & (4 | 16)) <> 0`,
    );
    expect(rowTriggers).toEqual([]);
  });

  it('[DI-22] an appending transaction holds RowExclusiveLock on kernel.audit_event from before it draws its id until it ends; one with only a transaction id holds none', async () => {
    const actor = await seededTestActor(db, { legalName: 'Horizon Writer' });
    const writer = await db.app.connect();
    const blocker = await db.admin.connect();
    const other = await db.admin.connect();
    const pidOf = async (c: typeof writer) => (await c.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid ?? 0;
    const locksOf = async (pid: number, granted: boolean) =>
      (
        await db.admin.query<{ mode: string }>(
          `select l.mode from pg_locks l
            where l.pid = $1 and l.locktype = 'relation' and l.relation = 'kernel.audit_event'::regclass and l.granted = $2 order by 1`,
          [pid, granted],
        )
      ).rows.map((r) => r.mode);
    const lastDrawn = async () => BigInt((await db.admin.query<{ v: string | null }>(`select pg_sequence_last_value('kernel.audit_event_id_seq')::text as v`)).rows[0]?.v ?? '0');
    try {
      const pid = await pidOf(writer);
      await writer.query('begin');
      await writer.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...actor, correlationId: randomUUID() }))]);
      // A command that has not appended an entry holds no lock on the table.
      expect(await locksOf(pid, true)).toEqual([]);

      // A lock that conflicts with RowExclusiveLock: the writer has to wait for it, and while it waits it has drawn no id.
      await blocker.query('begin');
      await blocker.query('lock table kernel.audit_event in share mode');
      const drawnBefore = await lastDrawn();
      const appended = writer.query<{ id: string }>(`select kernel.audit_business_event($1, 'horizon assumption', '{}'::jsonb)::text as id`, [`kernel_p11:${randomUUID()}`]);
      await vi.waitFor(async () => expect(await locksOf(pid, false)).toEqual(['RowExclusiveLock']), { timeout: 10_000, interval: 20 });
      expect(await lastDrawn()).toBe(drawnBefore);
      await blocker.query('commit');
      const id = BigInt((await appended).rows[0]?.id ?? '0');
      expect(id > drawnBefore).toBe(true);

      // The statement is over, the transaction is not: the lock is held until the transaction ends.
      expect(await locksOf(pid, true)).toEqual(['RowExclusiveLock']);
      await writer.query('commit');
      expect(await locksOf(pid, true)).toEqual([]);

      // A transaction with a transaction id that wrote no audit entry.
      const otherPid = await pidOf(other);
      await other.query('begin');
      await other.query('select pg_current_xact_id()');
      expect(await locksOf(otherPid, true)).toEqual([]);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      await writer.query('rollback').catch(() => undefined);
      await other.query('rollback').catch(() => undefined);
      blocker.release();
      writer.release();
      other.release();
    }
  });
});
