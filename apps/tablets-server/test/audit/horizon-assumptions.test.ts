/**
 * Review P11 (DI-22): what the audit list's settled horizon (src/features/audit/horizon.ts) relies on in the kernel.
 * If one of these ever changes, paging across chains could skip an entry that commits late, so each is pinned here:
 *  - kernel.audit_event.id is an identity GENERATED ALWAYS with a cache of 1 and a positive step, so ids follow the
 *    order in which rows are inserted, across sessions (a larger cache hands each session its own block of ids);
 *  - no role the server connects as can draw an id outside an INSERT (no USAGE or UPDATE on the sequence, no INSERT
 *    on the table), and the sequence grants nothing to anyone but its owner;
 *  - a transaction that has appended an audit entry holds a write lock on kernel.audit_event until it ends, and a
 *    transaction that has only an xid (it wrote elsewhere) holds none;
 *  - the edition's own SQL adds no other audit writer: across every routine of this database, only
 *    kernel.append_audit_event inserts entries, none overrides the identity or updates an entry, and only the
 *    continuity restore procedure moves sequences.
 * The kernel pins the same facts for its own database in packages/kernel/test/audit/horizon-assumptions.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toDbContext } from '@ebmr/kernel';
import { startServer, type TestServer } from '../support/harness.ts';
import { actorOfBrowser } from '../esig/support.ts';

let gmp: TestServer;

beforeAll(async () => {
  gmp = await startServer('GMP');
});
afterAll(async () => {
  await gmp?.close();
});

const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'allowed';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

describe('P11: the kernel assumptions of the audit horizon', () => {
  it('[DI-22] audit entry ids come from an identity generated always, cache 1, step up, that nobody but its owner can draw from', async () => {
    const { rows } = await gmp.db.admin.query<{ identity: string; cache: string; step: string; seq: string; grants: string[] }>(
      `select a.attidentity::text as identity, s.seqcache::text as cache, s.seqincrement::text as step,
              pg_get_serial_sequence('kernel.audit_event', 'id') as seq,
              array(select x.privilege_type || ' to ' || x.grantee::regrole::text
                      from pg_class c cross join lateral aclexplode(c.relacl) x
                     where c.oid = pg_get_serial_sequence('kernel.audit_event', 'id')::regclass and x.grantee <> c.relowner
                     order by 1) as grants
         from pg_attribute a
         join pg_sequence s on s.seqrelid = pg_get_serial_sequence('kernel.audit_event', 'id')::regclass
        where a.attrelid = 'kernel.audit_event'::regclass and a.attname = 'id'`,
    );
    expect(rows[0]).toEqual({ identity: 'a', cache: '1', step: '1', seq: 'kernel.audit_event_id_seq', grants: [] });

    // The server's own roles (the application, the authentication service) can neither draw an id nor insert an entry.
    const roles = [
      { pool: gmp.db.app, setRole: undefined },
      { pool: gmp.db.authn.pool, setRole: gmp.db.authn.setRole },
    ];
    for (const { pool, setRole } of roles) {
      const c = await pool.connect();
      try {
        if (setRole) await c.query(`set role ${setRole}`);
        for (const statement of [
          `select nextval('kernel.audit_event_id_seq')`,
          `select setval('kernel.audit_event_id_seq', 1)`,
          `insert into kernel.audit_event (chain_key, seq, prev_hash, hash, recorded_at, correlation_id, action, payload)
           values ('p11:x', 1, '\\x00', '\\x00', now(), gen_random_uuid(), 'BUSINESS', '{}')`,
        ]) {
          expect({ setRole, statement, outcome: await refusal(() => c.query(statement)) }).toEqual({ setRole, statement, outcome: '42501' });
        }
      } finally {
        if (setRole) await c.query('reset role').catch(() => undefined);
        c.release();
      }
    }
  });

  it('[DI-22] a transaction that appended an audit entry holds a write lock on kernel.audit_event until it ends; one that only wrote elsewhere holds none', async () => {
    const author = await gmp.asPersona('author');
    const writer = await gmp.db.app.connect();
    const other = await gmp.db.admin.connect();
    const locksOf = async (pid: number) =>
      (
        await gmp.db.admin.query<{ mode: string }>(
          `select l.mode from pg_locks l where l.pid = $1 and l.locktype = 'relation' and l.relation = 'kernel.audit_event'::regclass and l.granted order by 1`,
          [pid],
        )
      ).rows.map((r) => r.mode);
    try {
      await writer.query('begin');
      const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid ?? 0;
      await writer.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await actorOfBrowser(gmp, author, 'author')))]);
      await writer.query(`select kernel.audit_business_event($1, 'horizon assumption', '{}'::jsonb)`, [`review_p11:${randomUUID()}`]);
      // The statement is over, the transaction is not: the lock is still held.
      expect(await locksOf(pid)).toContain('RowExclusiveLock');
      await writer.query('commit');
      expect(await locksOf(pid)).toEqual([]);

      // A transaction with an xid that wrote no audit entry.
      await other.query('begin');
      const otherPid = (await other.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid ?? 0;
      await other.query('select txid_current()');
      expect(await locksOf(otherPid)).toEqual([]);
    } finally {
      await writer.query('rollback').catch(() => undefined);
      await other.query('rollback').catch(() => undefined);
      writer.release();
      other.release();
    }
  });

  it('[DI-22] the edition database has one audit writer: no routine but kernel.append_audit_event inserts entries, overrides their identity, updates them or moves sequences outside the restore procedure', async () => {
    const matching = async (pattern: string): Promise<string[]> =>
      (
        await gmp.db.admin.query<{ routine: string }>(
          `select p.oid::regprocedure::text as routine
             from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc ~* $1
            order by p.oid::regprocedure::text collate "C"`,
          [pattern],
        )
      ).rows.map((r) => r.routine);
    expect(await matching('\\minsert\\s+into\\s+(kernel\\s*\\.\\s*)?"?audit_event"?[\\s(]')).toEqual(['kernel.append_audit_event(text,text,text,text,jsonb)']);
    expect(await matching('\\maudit_event\\M.*\\moverriding\\M|\\moverriding\\M.*\\maudit_event\\M')).toEqual([]);
    expect(await matching('\\mupdate\\s+(only\\s+)?(kernel\\s*\\.\\s*)?"?audit_event\\M')).toEqual([]);
    expect(await matching("audit_event_id_seq|pg_get_serial_sequence\\s*\\(\\s*'kernel\\.audit_event'")).toEqual(['platform.audit_position()']);
    expect(await matching('\\msetval\\s*\\(')).toEqual(['continuity.after_restore(uuid,jsonb,bigint,jsonb)', 'continuity.secure_identifiers(jsonb,jsonb,bigint)']);
  });
});
