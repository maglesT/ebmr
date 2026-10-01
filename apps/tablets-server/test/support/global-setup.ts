/**
 * Global set-up of the Vitest `server` project (plan section 3): one GMP template (kernel, site services,
 * recipe-core and tablets SQL) and one sandbox template (provisioned once as ebmr_sandbox_tpl<hex>), both
 * bootstrapped and seeded with the persona catalogue through test-kit. Test files copy them
 * (support/harness.ts); the seeds, with their DEMO-ONLY credentials and keys, reach the files through provide().
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
 */
import type pg from 'pg';
import type { TestProject } from 'vitest/node';
import {
  asAdmin,
  bootstrapInstallation,
  createTemplateDatabase,
  dropDatabase,
  editionMigrationSources,
  openDatabase,
  provisionSandboxTemplate,
  seedDemoSite,
  type SiteSeed,
} from '@ebmr/test-kit';

declare module 'vitest' {
  export interface ProvidedContext {
    serverTemplates: { gmp: { template: string; seed: SiteSeed }; sandbox: { template: string; seed: SiteSeed } };
  }
}

export const TABLETS_SQL = new URL('../../sql', import.meta.url).pathname;

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

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const sources = tabletsMigrationSources();
  const [gmp, sandbox] = await Promise.all([
    (async () => {
      const template = await createTemplateDatabase(sources, { prefix: 'ebmr_stpl' });
      const db = openDatabase(template, 'GMP');
      try {
        return { template, seed: await seedDemoSite(db, 'GMP', await bootstrapInstallation(template, 'GMP')) };
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
  project.provide('serverTemplates', { gmp, sandbox });
  return async () => {
    await dropDatabase(gmp.template);
    await dropDatabase(sandbox.template);
  };
}
