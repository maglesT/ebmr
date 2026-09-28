/**
 * Global set-up of the Vitest `server` project (plan section 3): one GMP template (kernel, site services,
 * recipe-core and tablets SQL) and one sandbox template (provisioned once as ebmr_sandbox_tpl<hex>), both
 * bootstrapped and seeded with the persona catalogue through test-kit. Test files copy them
 * (support/harness.ts); the seeds, with their DEMO-ONLY credentials and keys, reach the files through provide().
 */
import type { TestProject } from 'vitest/node';
import {
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
  project.provide('serverTemplates', { gmp, sandbox });
  return async () => {
    await dropDatabase(gmp.template);
    await dropDatabase(sandbox.template);
  };
}
