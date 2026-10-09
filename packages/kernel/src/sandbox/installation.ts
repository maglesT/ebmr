/**
 * Installation kind (DI-05, INV-18). Every database migrated with the kernel carries a marker, set
 * once at provisioning and never changed: GMP (edition and site databases) or SANDBOX
 * (ebmr_sandbox_<edition>, the store shared by sandbox test runs, training and simulation mode).
 * The database is the authority (kernel.installation_kind(), migration 0800); these helpers read it.
 */
import type pg from 'pg';

export type InstallationKind = 'GMP' | 'SANDBOX';
export const INSTALLATION_KINDS: readonly InstallationKind[] = ['GMP', 'SANDBOX'];

/** Anything that can run a query: a pool, a pooled client or a plain client. */
export type Queryable = pg.Pool | pg.PoolClient | pg.Client;

/** A sandbox database name: ebmr_sandbox_<edition>, lower case (the database refuses a mismatch). */
export const SANDBOX_DATABASE_PATTERN = /^ebmr_sandbox_[a-z][a-z0-9_]{0,49}$/;

/** True when a database name lies in the sandbox namespace (any letter case), as the database decides it. */
export function isSandboxDatabaseName(name: string): boolean {
  return name.toLowerCase().startsWith('ebmr_sandbox_');
}

/** The sandbox database name of an edition, e.g. `tablets` -> `ebmr_sandbox_tablets`. */
export function sandboxDatabaseName(edition: string): string {
  const name = `ebmr_sandbox_${edition}`;
  if (!SANDBOX_DATABASE_PATTERN.test(name)) {
    throw new Error(`"${edition}" cannot name a sandbox database: use lower-case letters, digits and underscores, starting with a letter (DI-05). [EBMR-SBX-006]`);
  }
  return name;
}

export class InstallationKindError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${message} [${code}]`);
    this.name = 'InstallationKindError';
    this.code = code;
  }
}

/** The installation kind of the connected database. Throws when the marker is missing or disagrees with the name. */
export async function readInstallationKind(db: Queryable): Promise<InstallationKind> {
  const { rows } = await db.query<{ kind: InstallationKind }>('select kernel.installation_kind() as kind');
  const kind = rows[0]?.kind;
  if (kind !== 'GMP' && kind !== 'SANDBOX') throw new InstallationKindError('EBMR-SBX-001', 'The database reported no installation kind (DI-05).');
  return kind;
}

/**
 * Start-up guard for servers, jobs and adapters: a GMP server refuses to run against a sandbox and a
 * sandbox server refuses to run against a GMP database, so a wrong connection string fails at once.
 */
export async function assertInstallationKind(db: Queryable, expected: InstallationKind): Promise<void> {
  const actual = await readInstallationKind(db);
  if (actual !== expected) {
    throw new InstallationKindError(
      'EBMR-SBX-007',
      `This process expects a ${expected} database but is connected to a ${actual} database; it refuses to run so that test and GMP data never mix (DI-05, INV-18).`,
    );
  }
}

/**
 * What every export, rendering and true-copy bundle states about its origin. A consumer that brings
 * data into a GMP database (a true-copy import, a lot-transfer package) accepts only GMP origin.
 */
export interface InstallationStamp {
  installationKind: InstallationKind;
  /** 'TEST, NOT GMP' for a sandbox, null for GMP. */
  watermark: string | null;
}

export async function readInstallationStamp(db: Queryable): Promise<InstallationStamp> {
  const { rows } = await db.query<{ kind: InstallationKind; watermark: string | null }>(
    'select kernel.installation_kind() as kind, sandbox.watermark() as watermark',
  );
  const row = rows[0];
  if (!row || (row.kind !== 'GMP' && row.kind !== 'SANDBOX')) throw new InstallationKindError('EBMR-SBX-001', 'The database reported no installation kind (DI-05).');
  return { installationKind: row.kind, watermark: row.watermark };
}

/**
 * Refuses anything whose origin is not a GMP installation (DI-05: a non-GMP record is never
 * converted into, or merged with, a GMP record). `what` names the item for the message.
 */
export function assertGmpOrigin(stamp: InstallationStamp | null | undefined, what: string): void {
  if (!stamp || stamp.installationKind !== 'GMP' || stamp.watermark !== null) {
    const origin = stamp ? stamp.installationKind : 'unknown';
    throw new InstallationKindError(
      'EBMR-SBX-013',
      `${what} comes from a ${origin} installation, not a GMP one; sandbox, training and simulation output is never taken into GMP records (DI-05, INV-18).`,
    );
  }
}
