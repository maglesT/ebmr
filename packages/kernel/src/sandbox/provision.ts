/**
 * Provisioning of the sandbox database (DI-05, INV-18; ADR 0001 item 2; build outline 4.4, 6.5).
 *
 * A sandbox is a physically separate database, ebmr_sandbox_<edition>, built from the same
 * migrations as the edition's GMP database. It is never a copy of a GMP database: it is created
 * empty and migrated, and only approved MBR versions and master-data snapshots are loaded into it
 * afterwards (docs/design/sandbox.md). Provisioning:
 *   1. creates the database from template0 and closes it to PUBLIC at once;
 *   2. runs the migrations with ebmr.installation_kind = 'SANDBOX', so kernel migration 0800 marks
 *      the database SANDBOX (permanently);
 *   3. applies the connect policy (only ebmr_sandbox may connect; the GMP roles may not);
 *   4. gives ebmr_sandbox exactly the object privileges the GMP application and authentication roles
 *      hold in this database (it is never made a member of them, since role membership is cluster-wide);
 *   5. runs the segregation invariant query and fails unless it returns nothing.
 * Upgrades repeat steps 2-5; run upgradeSandboxDatabase after every release, never plain migrate().
 */
import pg from 'pg';
import { migrate, type AppliedMigration, type MigrationSource } from '../db/migrate.ts';
import { InstallationKindError, SANDBOX_DATABASE_PATTERN, readInstallationKind, type Queryable } from './installation.ts';

export const SANDBOX_ROLE = 'ebmr_sandbox';

export interface SandboxDatabaseOptions {
  /** Superuser connection to the cluster (the migration pipeline's); its database part is ignored. */
  adminUrl: string;
  /** ebmr_sandbox_<edition>, lower case. */
  database: string;
  /** The same migration sources, in the same order, as the edition's GMP database. */
  sources: MigrationSource[];
}

export interface SandboxReport {
  database: string;
  installationKind: 'SANDBOX';
  /** True when this call created the database. */
  created: boolean;
  applied: AppliedMigration[];
  /** Grants and revokes issued to bring ebmr_sandbox's privileges level with the GMP roles'. */
  privilegeChanges: number;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

function checkName(database: string): void {
  if (!SANDBOX_DATABASE_PATTERN.test(database)) {
    throw new InstallationKindError(
      'EBMR-SBX-006',
      `"${database}" is not a sandbox database name: use ebmr_sandbox_<edition> in lower case, so a sandbox can never be taken for a GMP database (DI-05).`,
    );
  }
}

async function databaseExists(admin: pg.Client, database: string): Promise<boolean> {
  const { rows } = await admin.query('select 1 from pg_catalog.pg_database where datname = $1', [database]);
  return rows.length > 0;
}

async function withAdmin<T>(adminUrl: string, work: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

/** Re-applies who may connect to the connected database (as its owner or a superuser); needed after
 * CREATE DATABASE ... TEMPLATE or a data-only restore, which do not copy database privileges. */
export async function applyConnectPolicy(db: Queryable): Promise<void> {
  await db.query('select sandbox.apply_connect_policy()');
}

/** Rows of the segregation invariant query; empty in a correctly provisioned GMP or sandbox database. */
export async function segregationProblems(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ problem: string }>('select p as problem from sandbox.segregation_problems() p');
  return rows.map((r) => r.problem);
}

async function prepare(opts: SandboxDatabaseOptions, created: boolean): Promise<SandboxReport> {
  const client = new pg.Client({ connectionString: withDatabase(opts.adminUrl, opts.database) });
  await client.connect();
  try {
    // Session-level on purpose: migrate() runs each file in its own transaction on this connection.
    await client.query("select pg_catalog.set_config('ebmr.installation_kind', 'SANDBOX', false)");
    const applied = await migrate(client, opts.sources);
    const kind = await readInstallationKind(client);
    if (kind !== 'SANDBOX') {
      throw new InstallationKindError('EBMR-SBX-033', `Database ${opts.database} is marked ${kind}; it is not a sandbox and is left untouched (DI-05, INV-18).`);
    }
    await applyConnectPolicy(client);
    const { rows } = await client.query<{ n: number }>('select sandbox.mirror_application_privileges() as n');
    const problems = await segregationProblems(client);
    if (problems.length > 0) {
      throw new InstallationKindError('EBMR-SBX-034', `Sandbox ${opts.database} failed its segregation check (DI-05, INV-18): ${problems.join('; ')}.`);
    }
    return { database: opts.database, installationKind: 'SANDBOX', created, applied, privilegeChanges: rows[0]?.n ?? 0 };
  } finally {
    await client.end();
  }
}

/** Creates, migrates, marks and secures a new sandbox database. Refuses an existing database. */
export async function provisionSandboxDatabase(opts: SandboxDatabaseOptions): Promise<SandboxReport> {
  checkName(opts.database);
  await withAdmin(opts.adminUrl, async (admin) => {
    if (await databaseExists(admin, opts.database)) {
      throw new InstallationKindError('EBMR-SBX-031', `Database ${opts.database} already exists; a sandbox is provisioned once and then upgraded (upgradeSandboxDatabase) (DI-05).`);
    }
    // Outside the clean-up below: a concurrent provisioning of the same name fails here and drops nothing.
    await admin.query(`create database ${quoteIdent(opts.database)} template template0 encoding 'UTF8'`);
  });
  try {
    await withAdmin(opts.adminUrl, (admin) => admin.query(`revoke connect, temporary on database ${quoteIdent(opts.database)} from public`));
    return await prepare(opts, true);
  } catch (error) {
    // A half-provisioned sandbox is never left behind.
    await withAdmin(opts.adminUrl, (admin) => admin.query(`drop database if exists ${quoteIdent(opts.database)} with (force)`));
    throw error;
  }
}

/** Migrates an existing sandbox to the given sources and re-levels its privileges. Refuses a GMP database. */
export async function upgradeSandboxDatabase(opts: SandboxDatabaseOptions): Promise<SandboxReport> {
  checkName(opts.database);
  await withAdmin(opts.adminUrl, async (admin) => {
    if (!(await databaseExists(admin, opts.database))) {
      throw new InstallationKindError('EBMR-SBX-032', `Sandbox database ${opts.database} does not exist; provision it first (DI-05).`);
    }
  });
  // Look before migrating: a database that already carries a marker must carry SANDBOX.
  const probe = new pg.Client({ connectionString: withDatabase(opts.adminUrl, opts.database) });
  await probe.connect();
  try {
    const { rows } = await probe.query<{ marked: boolean }>("select pg_catalog.to_regclass('sandbox.installation') is not null as marked");
    if (rows[0]?.marked) {
      const kind = await readInstallationKind(probe);
      if (kind !== 'SANDBOX') {
        throw new InstallationKindError('EBMR-SBX-033', `Database ${opts.database} is marked ${kind}; it is not a sandbox and is left untouched (DI-05, INV-18).`);
      }
    }
  } finally {
    await probe.end();
  }
  return prepare(opts, false);
}
