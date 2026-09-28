/**
 * Vitest global setup: build one template database per test run (unique name, so parallel runs
 * never collide) and hand its name to the test files through `provide`.
 *
 * EBMR_MIGRATIONS (optional regex) limits which kernel/site-services migration files are applied,
 * e.g. "^0(0|1)" while developing one module in isolation. The full suite always applies everything.
 * EBMR_TEMPLATE_DB (optional) names an already migrated template to use instead of building one.
 */
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { KERNEL_MIGRATIONS, migrate, type MigrationSource } from '../../src/db/migrate.ts';
import { ADMIN_URL, urlFor } from './db.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // A prepared template (the SQL mutation harness builds one per mutant) is used as it is and kept.
  const prepared = process.env['EBMR_TEMPLATE_DB'];
  if (prepared) {
    project.provide('templateDb', prepared);
    return () => Promise.resolve();
  }
  const template = `ebmr_tpl_${randomBytes(5).toString('hex')}`;
  const server = new pg.Client({ connectionString: ADMIN_URL });
  await server.connect();
  await server.query(`create database ${template}`);
  await server.end();

  const filter = process.env['EBMR_MIGRATIONS'] ? new RegExp(process.env['EBMR_MIGRATIONS']) : undefined;
  const sources: MigrationSource[] = [{ ...KERNEL_MIGRATIONS, ...(filter ? { include: filter } : {}) }];
  const siteServices = new URL('../../../site-services/sql', import.meta.url).pathname;
  if (existsSync(siteServices)) sources.push({ namespace: 'site-services', directory: siteServices, ...(filter ? { include: filter } : {}) });
  // recipe-core's schema is applied to every edition database after the kernel (ADR 0011).
  const recipeCore = new URL('../../../recipe-core/sql', import.meta.url).pathname;
  if (existsSync(recipeCore)) sources.push({ namespace: 'recipe-core', directory: recipeCore, ...(filter ? { include: filter } : {}) });
  sources.push({ namespace: 'test-fixtures', directory: new URL('.', import.meta.url).pathname });

  const client = new pg.Client({ connectionString: urlFor(template) });
  await client.connect();
  try {
    await migrate(client, sources);
  } finally {
    await client.end();
  }
  project.provide('templateDb', template);

  return async () => {
    const s = new pg.Client({ connectionString: ADMIN_URL });
    await s.connect();
    await s.query(`drop database if exists ${template} with (force)`);
    await s.end();
  };
}
