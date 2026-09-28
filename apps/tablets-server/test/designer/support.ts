/**
 * Designer test support (module C2): a GMP server copy with the designer seed applied (DEMO-ONLY reference
 * documents and the kernel and tablets rule tables, recorded and published by the master-data steward), and the
 * dc-mini template as parsed content.
 */
import type { ActorContext } from '@ebmr/kernel';
import { flow } from '@ebmr/recipe-core/pure';
import { openPersonaSession } from '@ebmr/test-kit';
import { seedReferenceDocuments, seedRuleTables } from '../../src/features/designer/seed.ts';
import template from '../../src/features/designer/templates/dc-mini.mbr.json' with { type: 'json' };
import { startServer, type TestServer } from '../support/harness.ts';

export async function stewardActor(server: TestServer): Promise<ActorContext> {
  const a = await openPersonaSession(server.db, server.seed, 'steward');
  return { ...a, reasonCode: 'TEST_SETUP', reasonText: 'designer test set-up' };
}

export interface DesignerServerOptions {
  /** Record the DEMO-ONLY reference documents (default true). */
  references?: boolean;
  /** Publish the kernel and tablets rule tables (default true). */
  ruleTables?: boolean;
}

export async function startDesignerServer(opts: DesignerServerOptions = {}): Promise<TestServer> {
  const server = await startServer('GMP');
  try {
    if (opts.references !== false) await seedReferenceDocuments(server.db.app, await stewardActor(server));
    if (opts.ruleTables !== false) await seedRuleTables(server.db.app, await stewardActor(server));
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}

/** A fresh deep copy of the dc-mini template content (JSON). */
export function templateJson(): Record<string, unknown> {
  return structuredClone(template) as Record<string, unknown>;
}

/** The template parsed into the typed model (throws when it does not parse). */
export function templateMbr(mutate?: (json: Record<string, unknown>) => void): flow.MbrContent {
  const json = templateJson();
  mutate?.(json);
  const parsed = flow.parseMbr(json);
  if (!parsed.ok) throw new Error(`the template does not parse: ${parsed.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return parsed.mbr;
}
