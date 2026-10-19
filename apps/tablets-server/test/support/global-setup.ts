/**
 * Global set-up of the Vitest `server` project (plan section 3): one GMP template (kernel, site services,
 * recipe-core and tablets SQL) and one sandbox template (provisioned once as ebmr_sandbox_tpl<hex>), both
 * bootstrapped and seeded with the persona catalogue through test-kit. Test files copy them
 * (support/harness.ts); the seeds, with their DEMO-ONLY credentials and keys, reach the files through provide().
 * The GMP template also holds an approved validation summary of its release (slice 7c, DI-03: a GMP batch needs one),
 * approved by the seed's QA person through a real signed act (test-kit seededValidationActs, D-P7-12).
 *
 * It also declares the test cluster's listener share (kernel 0980, decision X41): each test file that starts the gateway
 * listener runs one of its own, on its own database, and the files run in parallel, so the cluster runs several
 * listeners of the sandbox kind at once. The share of one listener (8, which kernel 0980 sets) would let only one of them
 * open its connections; TEST_LISTENER_SHARE is declared instead (kernel.apply_listener_share), which kernel 0980 keeps
 * on every later migration. Role attributes are cluster-wide and the declaration stays after the run (a development
 * cluster); a production cluster with one listener keeps 8. test/devices/listener-one-share.test.ts runs a listener
 * under that share of 8 on a login of its own.
 *
 * The declaration would hide a kernel 0980 that no longer applies the share, since it sets every limit the tests then
 * read. So before declaring it, the set-up checks what migrating the templates left (listenerShareProblems) and fails
 * the run if a listener role holds less than one listener's share or an application role anything but the cluster's
 * slots less its listener role's share. On a fresh cluster (CI) only the migration can have set them.
 * packages/kernel/test/security/listener-roles.test.ts requires the exact values of the migration itself on any
 * cluster, whatever this set-up declared: kernel 0980 run on a fresh cluster's roles, in a transaction rolled back at
 * the end, must give each listener role 8 and each application role the slots less 8; and a database migrated to 0980
 * with the application roles unlimited must keep each listener role's share and level its application role with it.
 *
 * EBMR_SERVER_TEMPLATES (optional) names a JSON file holding prepared templates and their seeds, { gmp: { template, seed },
 * sandbox: { template, seed } } (ServerTemplates), to use instead of building them: they are used as they are and kept,
 * and the listener share is not declared again. The SQL mutation harness (tools/sql-mutation) builds the pair once with
 * buildServerTemplates, so the seeds are exactly what the tests expect, and gives each mutant copies of both. When the
 * variable is unset nothing here changes.
 */
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import type { TestProject } from 'vitest/node';
import {
  approveValidationSummary,
  asAdmin,
  bootstrapInstallation,
  createTemplateDatabase,
  dropDatabase,
  editionMigrationSources,
  openDatabase,
  provisionSandboxTemplate,
  seedDemoSite,
  seededValidationActs,
  type SiteSeed,
} from '@ebmr/test-kit';

/** The GMP and sandbox templates the test files copy, with the seeds (DEMO-ONLY credentials and keys) they hold. */
export interface ServerTemplates {
  gmp: { template: string; seed: SiteSeed };
  sandbox: { template: string; seed: SiteSeed };
}

declare module 'vitest' {
  export interface ProvidedContext {
    serverTemplates: ServerTemplates;
  }
}

/** Names a JSON file of prepared templates (ServerTemplates) the set-up uses instead of building its own. */
export const PREPARED_TEMPLATES_ENV = 'EBMR_SERVER_TEMPLATES';

export const TABLETS_SQL = new URL('../../sql', import.meta.url).pathname;

/**
 * Names a JSON file (mode 0600) holding the SQL mutant under test (PreparedMutant), set by the SQL mutation harness
 * (tools/sql-mutation) for the server project. A test that builds a database of its own from the migrations instead of
 * copying the prepared templates (operations/support.ts freshTemplate, the first-run set-up) applies the mutant there
 * with applyPreparedMutant, as the harness applies it to its template copies; unset, nothing changes.
 */
export const MUTANT_ENV = 'EBMR_SQL_MUTANT';

/** The mutated function (regprocedure text), its owner and the CREATE OR REPLACE statement of the mutant. */
export interface PreparedMutant {
  identity: string;
  owner: string;
  statement: string;
}

/**
 * Applies the mutant MUTANT_ENV names to `database`, as the function's owner, when the function exists there; true when
 * applied. Without MUTANT_ENV it does nothing (false).
 */
export async function applyPreparedMutant(database: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const file = env[MUTANT_ENV];
  if (file === undefined || file === '') return false;
  const m = JSON.parse(readFileSync(file, 'utf8')) as PreparedMutant;
  return asAdmin(database, async (c) => {
    const found = await c.query<{ oid: number | null }>('select to_regprocedure($1)::oid as oid', [m.identity]);
    if (!found.rows[0]?.oid) return false;
    await c.query('begin');
    try {
      await c.query(`set local role "${m.owner.replace(/"/g, '""')}"`);
      await c.query(m.statement);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
    return true;
  });
}

/**
 * The listener share declared for the test cluster: five listeners' worth (8 each), more than the test files the
 * project runs at once on the CI's 4 CPUs (3), each with at most one listener (5 connections) and a probe pool or two
 * of the listener's login. The application roles keep the cluster's slots less this (57 of the default 97).
 */
export const TEST_LISTENER_SHARE = 40;

/** One listener's share of the cluster's connections: the least kernel 0980 gives a listener role. */
const ONE_LISTENER_SHARE = 8;

/** The connection limits of the application and listener roles, and the cluster's slots for roles that are not superusers. */
export interface RoleLimits {
  slots: number;
  /** Connection limit by role name (-1: none). */
  of: ReadonlyMap<string, number>;
}

export async function readRoleLimits(c: Pick<pg.Client, 'query'>): Promise<RoleLimits> {
  const { rows } = await c.query<{ rolname: string; limit: number; slots: number }>(
    `select r.rolname, r.rolconnlimit as limit,
            current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int
              - coalesce(current_setting('reserved_connections', true), '0')::int as slots
       from pg_roles r where r.rolname in ('ebmr_app', 'ebmr_sandbox', 'ebmr_listener', 'ebmr_sandbox_listener')`,
  );
  return { slots: rows[0]?.slots ?? 0, of: new Map(rows.map((r) => [r.rolname, r.limit])) };
}

/**
 * What is wrong with the listener roles' and the application roles' connection limits as kernel 0980 leaves them
 * (decisions X38, X41): each listener role holds at least one listener's share, and the application role of its kind
 * the cluster's slots for roles that are not superusers less that share. Empty when nothing is.
 */
export function listenerShareProblems(limits: RoleLimits): string[] {
  const problems: string[] = [];
  for (const [app, listener] of [['ebmr_app', 'ebmr_listener'], ['ebmr_sandbox', 'ebmr_sandbox_listener']] as const) {
    const share = limits.of.get(listener);
    const appLimit = limits.of.get(app);
    if (share === undefined || appLimit === undefined) {
      problems.push(`${share === undefined ? listener : app} does not exist`);
    } else if (share < ONE_LISTENER_SHARE) {
      problems.push(`${listener} has connection limit ${String(share)}, less than one listener's share (${String(ONE_LISTENER_SHARE)})`);
    } else if (appLimit !== limits.slots - share) {
      problems.push(
        `${app} has connection limit ${String(appLimit)}, not the cluster's ${String(limits.slots)} slots less ${listener}'s share (${String(limits.slots - share)})`,
      );
    }
  }
  return problems;
}

export function tabletsMigrationSources() {
  return editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]);
}

/**
 * Prepared templates from a JSON file (PREPARED_TEMPLATES_ENV): both templates named, a GMP template under a GMP name
 * and a sandbox template under a sandbox name, each with the seed of its own kind. Anything else fails the run.
 */
export function readPreparedTemplates(file: string): ServerTemplates {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<'gmp' | 'sandbox', Partial<{ template: unknown; seed: Partial<SiteSeed> }>>>;
  for (const [kind, installation] of [['gmp', 'GMP'], ['sandbox', 'SANDBOX']] as const) {
    const t = parsed[kind];
    if (typeof t?.template !== 'string' || t.template === '' || t.seed?.installation !== installation) {
      throw new Error(`${PREPARED_TEMPLATES_ENV} (${file}): ${kind} needs a template name and the seed of a ${installation} installation`);
    }
    if (t.template.startsWith('ebmr_sandbox_') !== (kind === 'sandbox')) {
      throw new Error(`${PREPARED_TEMPLATES_ENV} (${file}): ${t.template} is not a ${installation} database name (DI-05)`);
    }
  }
  return parsed as ServerTemplates;
}

/**
 * Builds and seeds both templates, checks what migrating them left of the listener share (kernel 0980) and declares the
 * test cluster's share. On a failure both templates are dropped and the error is thrown.
 */
export async function buildServerTemplates(): Promise<ServerTemplates> {
  const sources = tabletsMigrationSources();
  const [gmp, sandbox] = await Promise.all([
    (async () => {
      const template = await createTemplateDatabase(sources, { prefix: 'ebmr_stpl' });
      const db = openDatabase(template, 'GMP');
      try {
        const seed = await seedDemoSite(db, 'GMP', await bootstrapInstallation(template, 'GMP'));
        // Slice 7c (DI-03, D-P7-12): the GMP template's release has an approved validation summary, through QA's real
        // signed act, so every copy may issue GMP batches (recipe-core 1250).
        await approveValidationSummary(await seededValidationActs(db, seed));
        return { template, seed };
      } finally {
        await db.close();
      }
    })(),
    (async () => {
      const provisioned = await provisionSandboxTemplate(sources);
      const db = openDatabase(provisioned.database, 'SANDBOX');
      try {
        return { template: provisioned.database, seed: await seedDemoSite(db, 'SANDBOX', provisioned.bootstrap, { personaSets: 1 }) };
      } finally {
        await db.close();
      }
    })(),
  ]);
  try {
    await asAdmin(gmp.template, async (c) => {
      const problems = listenerShareProblems(await readRoleLimits(c));
      if (problems.length > 0) {
        throw new Error(`Migrating the test templates did not apply the evidence listener's share (kernel 0980, decision X41): ${problems.join('; ')}.`);
      }
      await c.query('select kernel.apply_listener_share($1)', [TEST_LISTENER_SHARE]);
    });
  } catch (error) {
    // No teardown runs for a set-up that failed: the templates are dropped here.
    await dropDatabase(gmp.template);
    await dropDatabase(sandbox.template);
    throw error;
  }
  return { gmp, sandbox };
}

/**
 * The templates of a run and their teardown: the prepared ones named by PREPARED_TEMPLATES_ENV, used as they are and kept
 * (nothing is built, nothing is dropped); otherwise a pair built by `build`, dropped at the teardown.
 */
export async function serverTemplatesFor(
  env: NodeJS.ProcessEnv = process.env,
  build: () => Promise<ServerTemplates> = buildServerTemplates,
): Promise<{ templates: ServerTemplates; teardown: () => Promise<void> }> {
  const prepared = env[PREPARED_TEMPLATES_ENV];
  if (prepared) return { templates: readPreparedTemplates(prepared), teardown: () => Promise.resolve() };
  const templates = await build();
  return {
    templates,
    teardown: async () => {
      await dropDatabase(templates.gmp.template);
      await dropDatabase(templates.sandbox.template);
    },
  };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Prepared templates (the SQL mutation harness gives each mutant copies of its own) are used as they are and kept.
  const { templates, teardown } = await serverTemplatesFor();
  project.provide('serverTemplates', templates);
  return teardown;
}
