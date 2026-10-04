/**
 * Who may connect, signal and hold what, guard by guard (SQL mutation group "connection-roles": kernel 0970
 * kernel.backend_signals_restricted, 0980 sandbox.apply_connect_policy, sandbox.mirror_application_privileges,
 * sandbox.segregation_problems and kernel.apply_listener_share, 0820 sandbox.direct_privileges). The scenario tests
 * (security/backend-signals, security/listener-roles, sandbox/bypass) show the policy holding as provisioned; these
 * tests take each rule to the input where it alone decides, and assert the exact answer:
 *  - the backend-signal policy takes EXECUTE on pg_cancel_backend and pg_terminate_backend from PUBLIC and from every
 *    role that is not a superuser, whatever other entries the function's privileges hold, keeps the superusers' own,
 *    and counts a grantee it cannot name as a role that may signal (fail closed); the policy cannot take such a grant
 *    away and does not complete (today with a syntax error from an empty REVOKE grantee, not a coded refusal: reported
 *    for the lead, so only the failure and the unchanged privileges are asserted);
 *  - the mirror runs only inside a sandbox (EBMR-SBX-030) and levels a column privilege as a column privilege;
 *  - the invariant query reports each way in by itself: a missing role, each elevated attribute on its own, a
 *    membership, a privilege on a column or a type, a GMP role or PUBLIC able to connect to a sandbox, and nothing
 *    in a database that is as provisioned. In a sandbox it failed outright ('role "..." does not exist') when a GMP
 *    login role was missing, because PostgreSQL evaluated has_database_privilege() before the EXISTS meant to guard
 *    it; kernel 1030 asks only about roles that exist, in role order (the tests marked kernel 1030 failed before it);
 *  - the listener's share accepts exactly one listener's 8 and a share that leaves the application role one slot, and
 *    levels each pair from that pair's own roles.
 *
 * The sandbox cases run in a copy of the migrated template (the functions as this run has them), re-marked SANDBOX under
 * a sandbox name and levelled as provisioning levels a sandbox (connect policy, then the mirror): the marker is
 * permanent, so it is replaced with the replication mode a data-only restore uses. Role attributes and memberships are
 * cluster-wide: every change to a role is made in a transaction that is rolled back, after taking pg_authid's lock as
 * kernel 0980 does, so a test changing roles beside this one waits instead of deadlocking, and no other session ever
 * sees the change.
 *
 * Controls: DI-05 and INV-18 (segregation of the sandbox), DI-17 and DI-30 (no login but a superuser's signals another
 * backend; the evidence listener's own roles), PR-20 (the listener's share of the connections).
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { segregationProblems } from '../../src/sandbox/provision.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { onServer, openSandbox, sandboxTestName, type TestSandbox } from '../sandbox/helpers.ts';

let gmp: TestDatabase;
let sbx: TestSandbox;
/** What the mirror answered when the sandbox below was levelled: the number of grants and revokes, or its error. */
let levelled: number | string;

/** Makes a sandbox of a copy of the migrated template: marked SANDBOX under a sandbox name, then levelled as provisioning does. */
async function sandboxFromTemplate(): Promise<TestSandbox> {
  const name = sandboxTestName();
  await onServer((s) => s.query(`create database "${name}" template "${inject('templateDb')}"`));
  const sandbox = openSandbox(name);
  sbx = sandbox;
  const c = await sandbox.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query('delete from sandbox.installation');
    await c.query('set local session_replication_role = origin');
    await c.query("insert into sandbox.installation (kind, database_name) values ('SANDBOX', current_database())");
    await c.query('commit');
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
  await sandbox.admin.query('select sandbox.apply_connect_policy()');
  // Asserted by the first sandbox test, so a mirror that cannot level a sandbox is reported there by name.
  levelled = await sandbox.admin.query<{ n: number }>('select sandbox.mirror_application_privileges() as n').then(
    (r) => r.rows[0]?.n ?? -1,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  return sandbox;
}

beforeAll(async () => {
  gmp = await createTestDatabase();
  await sandboxFromTemplate();
}, 120_000);

afterAll(async () => {
  await Promise.all([gmp?.drop(), sbx?.drop()]);
});

const hex = (n = 4): string => randomBytes(n).toString('hex');

/**
 * Runs `work` on a superuser connection of `pool` in a transaction that is always rolled back, pg_authid's lock taken
 * first (role changes are cluster-wide).
 */
async function rolledBack<T>(pool: pg.Pool, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('lock table pg_catalog.pg_authid in share row exclusive mode');
    return await work(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

/** The invariant query's rows, run as `role` (the product's login role of the database) inside the caller's transaction. */
async function problemsAs(c: pg.PoolClient, role: string): Promise<string[]> {
  await c.query('savepoint problems');
  try {
    await c.query(`set local role ${role}`);
    return (await c.query<{ p: string }>('select p from sandbox.segregation_problems() p')).rows.map((r) => r.p);
  } finally {
    await c.query('rollback to savepoint problems');
  }
}

/** The message a statement fails with, or 'ok'; the caller's transaction stays usable. */
async function outcome(c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<string> {
  await c.query('savepoint attempt');
  try {
    await c.query(sql, params);
    await c.query('release savepoint attempt');
    return 'ok';
  } catch (error) {
    await c.query('rollback to savepoint attempt');
    return error instanceof Error ? error.message : String(error);
  }
}

/** Renames a role aside, as if the cluster did not have it (it cannot be dropped: other databases hold grants to it). */
const renameAside = (c: pg.PoolClient, role: string): Promise<unknown> => c.query(`alter role ${role} rename to t_aside_${hex()}`);

const ELEVATED = 'has an elevated role attribute (superuser, createdb, createrole, replication, bypassrls or inherit)';
/** Each attribute the invariant query counts as elevated, each set on its own. */
const ATTRIBUTES = ['superuser', 'createdb', 'createrole', 'replication', 'bypassrls', 'inherit'] as const;

// ---------------------------------------------------------------------------------------------------------------------

describe('the backend-signal policy (kernel 0970, 0980)', () => {
  const CANCEL = 'pg_catalog.pg_cancel_backend(integer)';
  const TERMINATE = 'pg_catalog.pg_terminate_backend(integer, bigint)';
  const SIGNALS = [CANCEL, TERMINATE];
  /** The privileges of each signal function, by name. */
  const acls = async (c: pg.PoolClient): Promise<{ cancel?: string[]; terminate?: string[] }> =>
    Object.fromEntries(
      (
        await c.query<{ fn: string; acl: string[] }>(
          `select replace(p.proname, 'pg_', '') as fn, coalesce(p.proacl::text[], array[]::text[]) as acl
             from pg_catalog.pg_proc p where p.oid = any($1::regprocedure[]) order by 1`,
          [SIGNALS],
        )
      ).rows.map((r) => [r.fn.replace('_backend', ''), r.acl]),
    );
  const restricted = async (c: pg.PoolClient): Promise<boolean> =>
    (await c.query<{ r: boolean }>('select kernel.backend_signals_restricted() as r')).rows[0]?.r ?? true;
  const ownerOf = async (c: pg.PoolClient): Promise<string> =>
    (await c.query<{ o: string }>("select pg_get_userbyid(proowner) as o from pg_proc where oid = 'pg_catalog.pg_cancel_backend(integer)'::regprocedure")).rows[0]?.o ?? '';

  it('[DI-17][DI-30] the policy takes EXECUTE from PUBLIC and from each role that is not a superuser and leaves the superuser\'s own entry: the privileges after it are exactly the owner\'s', async () => {
    await rolledBack(gmp.admin, async (c) => {
      const owner = await ownerOf(c);
      const own = `${owner}=X/${owner}`;
      expect(await acls(c)).toEqual({ cancel: [own], terminate: [own] });
      await c.query(`grant execute on function ${CANCEL} to public, ebmr_app`);
      await c.query(`grant execute on function ${TERMINATE} to ebmr_authn`);
      expect(await acls(c)).toEqual({ cancel: [own, `=X/${owner}`, `ebmr_app=X/${owner}`], terminate: [own, `ebmr_authn=X/${owner}`] });
      expect(await restricted(c)).toBe(false);
      await c.query('select sandbox.apply_connect_policy()');
      expect(await acls(c)).toEqual({ cancel: [own], terminate: [own] });
      expect(await restricted(c)).toBe(true);
    });
  });

  it('[DI-17][DI-30] the policy takes EXECUTE from a role that is not a superuser also when it is the only entry left (the owner revoked its own)', async () => {
    await rolledBack(gmp.admin, async (c) => {
      const owner = await ownerOf(c);
      await c.query(`revoke execute on function ${CANCEL} from ${owner}`);
      await c.query(`grant execute on function ${CANCEL} to ebmr_app`);
      expect((await acls(c)).cancel).toEqual([`ebmr_app=X/${owner}`]);
      expect(await restricted(c)).toBe(false);
      await c.query('select sandbox.apply_connect_policy()');
      expect((await acls(c)).cancel).toEqual([]);
      expect((await c.query<{ ok: boolean }>(`select has_function_privilege('ebmr_app', $1, 'EXECUTE') as ok`, [CANCEL])).rows).toEqual([{ ok: false }]);
      expect(await restricted(c)).toBe(true);
    });
  });

  it('[DI-17][DI-30] a grant to a role the cluster does not know (a catalogue written directly) is counted as one that may signal: the installation is reported as not holding the policy, and the policy, which cannot take it away by name, does not complete and changes nothing', async () => {
    await rolledBack(gmp.admin, async (c) => {
      const owner = await ownerOf(c);
      const unknown = 4_294_967_000;
      expect((await c.query('select 1 from pg_catalog.pg_authid where oid = $1', [unknown])).rows).toEqual([]);
      await c.query(
        `update pg_catalog.pg_proc set proacl = array_append(proacl, makeaclitem($1::oid, proowner, 'EXECUTE', false))
          where oid = 'pg_catalog.pg_cancel_backend(integer)'::regprocedure`,
        [unknown],
      );
      // That grant alone: the policy is not held.
      expect(await acls(c)).toEqual({ cancel: [`${owner}=X/${owner}`, `${String(unknown)}=X/${owner}`], terminate: [`${owner}=X/${owner}`] });
      expect(await restricted(c)).toBe(false);
      // Beside a grant to PUBLIC, which the policy could take away: it takes away neither.
      await c.query(`grant execute on function ${TERMINATE} to public`);
      const before = await acls(c);
      expect(before).toEqual({ cancel: [`${owner}=X/${owner}`, `${String(unknown)}=X/${owner}`], terminate: [`${owner}=X/${owner}`, `=X/${owner}`] });
      expect(await outcome(c, 'select sandbox.apply_connect_policy()')).not.toBe('ok');
      expect(await acls(c)).toEqual(before);
      expect(await restricted(c)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the mirror of the application roles\' privileges (kernel 0820, 0980)', () => {
  it('[DI-05][INV-18] in a GMP database the mirror is refused (EBMR-SBX-030) and the sandbox roles still hold nothing there', async () => {
    const held = async (c: pg.PoolClient): Promise<number[]> =>
      (
        await c.query<{ n: number }>(
          "select (select count(*)::int from sandbox.direct_privileges('ebmr_sandbox')) as n union all select (select count(*)::int from sandbox.direct_privileges('ebmr_sandbox_listener'))",
        )
      ).rows.map((r) => r.n);
    await rolledBack(gmp.admin, async (c) => {
      // Something the mirror would copy to the sandbox listener as well.
      await c.query('grant usage on schema testgmp to ebmr_listener');
      expect(await held(c)).toEqual([0, 0]);
      expect(await outcome(c, 'select sandbox.mirror_application_privileges()')).toBe(
        'Privileges are copied to the sandbox role only inside a sandbox database; this is a GMP database, where the sandbox role holds nothing (DI-05, INV-18). [EBMR-SBX-030]',
      );
      expect(await held(c)).toEqual([0, 0]);
      expect(await problemsAs(c, 'ebmr_app')).toEqual([]);
    });
  });

  it('[DI-05][INV-18] in a sandbox the mirror gives the sandbox role a column privilege of the application roles as that column\'s privilege (not the table\'s), a table privilege as the table\'s, and takes a column privilege held beyond them back from that column only', async () => {
    expect(typeof levelled === 'number' && levelled > 300 ? 'levelled' : levelled).toBe('levelled');
    await rolledBack(sbx.admin, async (c) => {
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual([]);
      await c.query('create table testgmp.k_probe (a int, b int)');
      await c.query('grant select (a) on testgmp.k_probe to ebmr_app');
      await c.query('grant select on testgmp.k_probe to ebmr_authn');
      await c.query('create table testgmp.k_extra (a int, b int)');
      await c.query('grant update (b) on testgmp.k_extra to ebmr_sandbox');
      await c.query('grant select (a) on testgmp.k_extra to ebmr_sandbox, ebmr_app');
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual([
        'ebmr_sandbox lacks SELECT on column testgmp.k_probe (a)',
        'ebmr_sandbox lacks SELECT on table testgmp.k_probe',
        'ebmr_sandbox holds beyond the application roles UPDATE on column testgmp.k_extra (b)',
      ]);
      expect((await c.query<{ n: number }>('select sandbox.mirror_application_privileges() as n')).rows).toEqual([{ n: 3 }]);
      const { rows } = await c.query<{ probe_table: boolean; probe_a: boolean; extra_table: boolean; extra_a: boolean; extra_b: boolean }>(
        `select has_table_privilege('ebmr_sandbox', 'testgmp.k_probe', 'SELECT') as probe_table,
                has_column_privilege('ebmr_sandbox', 'testgmp.k_probe', 'a', 'SELECT') as probe_a,
                has_table_privilege('ebmr_sandbox', 'testgmp.k_extra', 'UPDATE') as extra_table,
                has_column_privilege('ebmr_sandbox', 'testgmp.k_extra', 'a', 'SELECT') as extra_a,
                has_column_privilege('ebmr_sandbox', 'testgmp.k_extra', 'b', 'UPDATE') as extra_b`,
      );
      expect(rows).toEqual([{ probe_table: true, probe_a: true, extra_table: false, extra_a: true, extra_b: false }]);
      const columns = await c.query<{ name: string; column_name: string | null; privilege: string }>(
        "select object_name as name, column_name, privilege from sandbox.direct_privileges('ebmr_sandbox') where object_name like 'testgmp.k\\_%' order by 1, 2 nulls first, 3",
      );
      expect(columns.rows).toEqual([
        { name: 'testgmp.k_extra', column_name: 'a', privilege: 'SELECT' },
        { name: 'testgmp.k_probe', column_name: null, privilege: 'SELECT' },
        { name: 'testgmp.k_probe', column_name: 'a', privilege: 'SELECT' },
      ]);
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the invariant query in a GMP database (kernel 0820, 0980)', () => {
  it('[DI-05][INV-18] a database as provisioned has no problem; without the sandbox role the query says only that it does not exist', async () => {
    expect(await segregationProblems(gmp.app)).toEqual([]);
    await rolledBack(gmp.admin, async (c) => {
      await renameAside(c, 'ebmr_sandbox');
      expect(await problemsAs(c, 'ebmr_app')).toEqual(['the sandbox role ebmr_sandbox does not exist']);
    });
  });

  it('[DI-05][INV-18] each elevated attribute of the sandbox role is reported on its own (a superuser can also connect)', async () => {
    await rolledBack(gmp.admin, async (c) => {
      for (const attribute of ATTRIBUTES) {
        await c.query('savepoint attribute');
        await c.query(`alter role ebmr_sandbox ${attribute}`);
        const expected = [`ebmr_sandbox ${ELEVATED}`];
        if (attribute === 'superuser') expected.push(`ebmr_sandbox can connect to the GMP database ${gmp.name}`);
        expect([attribute, await problemsAs(c, 'ebmr_app')]).toEqual([attribute, expected]);
        await c.query('rollback to savepoint attribute');
      }
      expect(await problemsAs(c, 'ebmr_app')).toEqual([]);
    });
  });

  it('[DI-05][INV-18] a membership of the sandbox role is reported with the role it is a member of, and only that role', async () => {
    await rolledBack(gmp.admin, async (c) => {
      await c.query('grant ebmr_app to ebmr_sandbox');
      expect(await problemsAs(c, 'ebmr_app')).toEqual(['ebmr_sandbox is a member of role ebmr_app']);
    });
  });

  it('[DI-17][DI-30] a listener role the cluster does not have is reported as missing, and nothing else is said of it', async () => {
    for (const role of ['ebmr_listener', 'ebmr_sandbox_listener']) {
      await rolledBack(gmp.admin, async (c) => {
        await renameAside(c, role);
        expect([role, await problemsAs(c, 'ebmr_app')]).toEqual([role, [`the listener role ${role} does not exist`]]);
      });
    }
  });

  it('[DI-17][DI-30] each elevated attribute of a listener role is reported on its own', async () => {
    await rolledBack(gmp.admin, async (c) => {
      for (const attribute of ATTRIBUTES) {
        await c.query('savepoint attribute');
        await c.query(`alter role ebmr_listener ${attribute}`);
        expect([attribute, await problemsAs(c, 'ebmr_app')]).toEqual([attribute, [`ebmr_listener ${ELEVATED}`]]);
        await c.query('rollback to savepoint attribute');
      }
      await c.query('alter role ebmr_sandbox_listener inherit');
      expect(await problemsAs(c, 'ebmr_app')).toEqual([`ebmr_sandbox_listener ${ELEVATED}`]);
    });
  });

  it('[DI-05][INV-18] a privilege of the sandbox role on one column is reported as that column\'s, and a privilege on a type held by others is not the sandbox role\'s', async () => {
    await rolledBack(gmp.admin, async (c) => {
      await c.query('create type testgmp.k_kind as enum (\'A\', \'B\')');
      await c.query('grant usage on type testgmp.k_kind to ebmr_app');
      expect(await problemsAs(c, 'ebmr_app')).toEqual([]);
      await c.query('grant select (value) on testgmp.sample to ebmr_sandbox');
      expect(await problemsAs(c, 'ebmr_app')).toEqual(['ebmr_sandbox holds SELECT on column testgmp.sample (value) in a GMP database']);
      await c.query('grant usage on type testgmp.k_kind to ebmr_sandbox');
      expect(await problemsAs(c, 'ebmr_app')).toEqual([
        'ebmr_sandbox holds SELECT on column testgmp.sample (value) in a GMP database',
        'ebmr_sandbox holds USAGE on type testgmp.k_kind in a GMP database',
      ]);
      expect(
        (await c.query("select object_kind, object_name, column_name, privilege from sandbox.direct_privileges('ebmr_sandbox') order by 1, 2, 3, 4")).rows,
      ).toEqual([
        { object_kind: 'COLUMN', object_name: 'testgmp.sample', column_name: 'value', privilege: 'SELECT' },
        { object_kind: 'TYPE', object_name: 'testgmp.k_kind', column_name: null, privilege: 'USAGE' },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the invariant query in a sandbox (kernel 0820, 0980)', () => {
  it('[DI-05][INV-18] a sandbox as provisioned has no problem: the mirror levelled the sandbox roles with the GMP roles\' privileges (hundreds of grants), no GMP role and not PUBLIC can connect, and the sandbox roles hold exactly the mirror', async () => {
    expect(typeof levelled === 'number' && levelled > 300 ? 'levelled' : levelled).toBe('levelled');
    expect(await segregationProblems(sbx.sandbox)).toEqual([]);
    const { rows } = await sbx.admin.query<{ role: string; connect: boolean }>(
      `select r as role, has_database_privilege(r, current_database(), 'CONNECT') as connect
         from unnest(array['ebmr_app', 'ebmr_authn', 'ebmr_listener', 'ebmr_sandbox', 'ebmr_sandbox_listener']) r order by 1`,
    );
    expect(rows).toEqual([
      { role: 'ebmr_app', connect: false },
      { role: 'ebmr_authn', connect: false },
      { role: 'ebmr_listener', connect: false },
      { role: 'ebmr_sandbox', connect: true },
      { role: 'ebmr_sandbox_listener', connect: true },
    ]);
  });

  it('[DI-05][INV-18] CONNECT for PUBLIC on the sandbox is reported, with each GMP role it lets in (in role order, kernel 1030); TEMPORARY for PUBLIC is not a way in', async () => {
    await rolledBack(sbx.admin, async (c) => {
      await c.query(`grant temporary on database "${sbx.name}" to public`);
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual([]);
      await c.query(`grant connect on database "${sbx.name}" to public`);
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual([
        `the GMP role ebmr_app can connect to the sandbox database ${sbx.name}`,
        `the GMP role ebmr_authn can connect to the sandbox database ${sbx.name}`,
        `the GMP role ebmr_listener can connect to the sandbox database ${sbx.name}`,
        `PUBLIC can connect to the sandbox database ${sbx.name}`,
      ]);
    });
  });

  it('[DI-05][INV-18][DI-17] CONNECT given to one GMP role is reported for that role alone', async () => {
    await rolledBack(sbx.admin, async (c) => {
      await c.query(`grant connect on database "${sbx.name}" to ebmr_authn`);
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual([`the GMP role ebmr_authn can connect to the sandbox database ${sbx.name}`]);
    });
  });

  it('[DI-05][INV-18][DI-17] without the sandbox listener role the query says only that it does not exist, not what that role would lack', async () => {
    await rolledBack(sbx.admin, async (c) => {
      await c.query('grant usage on schema testgmp to ebmr_listener, ebmr_sandbox_listener');
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual([]);
      await renameAside(c, 'ebmr_sandbox_listener');
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual(['the listener role ebmr_sandbox_listener does not exist']);
    });
  });

  it('[DI-05][INV-18][DI-17] without the GMP listener role the query says that it does not exist, and nothing of what the sandbox listener holds beyond it (kernel 1030)', async () => {
    await rolledBack(sbx.admin, async (c) => {
      await c.query('grant usage on schema testgmp to ebmr_listener, ebmr_sandbox_listener');
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual([]);
      await renameAside(c, 'ebmr_listener');
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual(['the listener role ebmr_listener does not exist']);
    });
  });

  it('[DI-05][INV-18][DI-17] a GMP role the cluster does not have is passed over, and a GMP role that can connect is still reported (kernel 1030)', async () => {
    await rolledBack(sbx.admin, async (c) => {
      await c.query(`grant connect on database "${sbx.name}" to ebmr_authn`);
      await renameAside(c, 'ebmr_listener');
      expect(await problemsAs(c, 'ebmr_sandbox')).toEqual([
        'the listener role ebmr_listener does not exist',
        `the GMP role ebmr_authn can connect to the sandbox database ${sbx.name}`,
      ]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the listener\'s share of the connections (kernel 0980)', () => {
  const limits = async (c: pg.PoolClient): Promise<{ slots: number; of: Record<string, number> }> => {
    const { rows } = await c.query<{ rolname: string; limit: number; slots: number }>(
      `select r.rolname, r.rolconnlimit as limit,
              current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int
                - coalesce(current_setting('reserved_connections', true), '0')::int as slots
         from pg_roles r where r.rolname in ('ebmr_app', 'ebmr_sandbox', 'ebmr_listener', 'ebmr_sandbox_listener') order by 1`,
    );
    return { slots: rows[0]?.slots ?? 0, of: Object.fromEntries(rows.map((r) => [r.rolname, r.limit])) };
  };

  it('[DI-17][DI-30][PR-20] a share of exactly one listener\'s 8 is accepted, and so is a share that leaves the application roles exactly one slot', async () => {
    await rolledBack(gmp.admin, async (c) => {
      const { slots } = await limits(c);
      expect(await outcome(c, 'select kernel.apply_listener_share(8)')).toBe('ok');
      expect((await limits(c)).of).toEqual({ ebmr_app: slots - 8, ebmr_listener: 8, ebmr_sandbox: slots - 8, ebmr_sandbox_listener: 8 });
      expect(await outcome(c, 'select kernel.apply_listener_share($1)', [slots - 1])).toBe('ok');
      expect((await limits(c)).of).toEqual({ ebmr_app: 1, ebmr_listener: slots - 1, ebmr_sandbox: 1, ebmr_sandbox_listener: slots - 1 });
      expect(await outcome(c, 'select kernel.apply_listener_share($1)', [slots])).toMatch(
        new RegExp(`^This cluster has ${String(slots)} connection slots for roles that are not superusers, too few to keep ${String(slots)} free for the evidence listener: raise max_connections \\(DI-30, PR-20\\)\\. \\[EBMR-SBX-036\\]$`),
      );
      expect((await limits(c)).of).toEqual({ ebmr_app: 1, ebmr_listener: slots - 1, ebmr_sandbox: 1, ebmr_sandbox_listener: slots - 1 });
    });
  });

  it('[DI-17][DI-30][PR-20] each pair is levelled from its own roles: on a cluster without the sandbox role the GMP pair is levelled and the sandbox listener left as it was', async () => {
    await rolledBack(gmp.admin, async (c) => {
      const before = await limits(c);
      await renameAside(c, 'ebmr_sandbox');
      expect(await outcome(c, 'select kernel.apply_listener_share(16)')).toBe('ok');
      expect((await limits(c)).of).toEqual({
        ebmr_app: before.slots - 16,
        ebmr_listener: 16,
        ebmr_sandbox_listener: before.of['ebmr_sandbox_listener'],
      });
    });
  });
});
