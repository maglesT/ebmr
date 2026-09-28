/**
 * Designer test support (module C2): a GMP server copy with the designer seed applied (DEMO-ONLY reference
 * documents and the kernel and tablets rule tables, recorded and published by the master-data steward), and the
 * dc-mini template as parsed content.
 */
import type { ActorContext } from '@ebmr/kernel';
import { flow } from '@ebmr/recipe-core/pure';
import { openPersonaSession } from '@ebmr/test-kit';
import { publishRuleTables } from '../../src/platform/rule-tables.ts';
import { seedReferenceDocuments } from '../../src/features/designer/seed.ts';
import template from '../../src/features/designer/templates/dc-mini.mbr.json' with { type: 'json' };
import { routes, type Result, type VersionView } from '@ebmr/api-contract';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';

export async function stewardActor(server: TestServer): Promise<ActorContext> {
  const a = await openPersonaSession(server.db, server.seed, 'steward');
  return { ...a, reasonCode: 'TEST_SETUP', reasonText: 'designer test set-up' };
}

/** Publishes the kernel and tablets rule tables as the steward. */
export async function publishTables(server: TestServer): Promise<void> {
  await publishRuleTables({ pools: { app: server.db.app } }, await stewardActor(server));
}

export interface DesignerServerOptions {
  /** Record the DEMO-ONLY reference documents (default true). */
  references?: boolean;
  /** Publish the kernel and tablets rule tables (default true). */
  ruleTables?: boolean;
  /** Extra EBMR_* variables. */
  env?: Record<string, string>;
}

export async function startDesignerServer(opts: DesignerServerOptions = {}): Promise<TestServer> {
  const server = await startServer('GMP', opts.env ? { env: opts.env } : {});
  try {
    if (opts.references !== false) await seedReferenceDocuments(server.db.app, await stewardActor(server));
    if (opts.ruleTables !== false) await publishTables(server);
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}

/** A fresh deep copy of the dc-mini template content (JSON). */
export function templateJson(): Record<string, unknown> {
  return structuredClone(template);
}

/** The template parsed into the typed model (throws when it does not parse). */
export function templateMbr(mutate?: (json: Record<string, unknown>) => void): flow.MbrContent {
  const json = templateJson();
  mutate?.(json);
  const parsed = flow.parseMbr(json);
  if (!parsed.ok) throw new Error(`the template does not parse: ${parsed.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return parsed.mbr;
}

/** A refusal result: its status and code (fails the test when the call succeeded). */
export function refusalOf<T>(r: Result<T>): { status: number; code: string; kind: string; why: string; controls: string[] } {
  if (r.ok) throw new Error(`expected a refusal, got ${r.status}`);
  if (r.error.kind !== 'REFUSAL') throw new Error(`expected a refusal, got ${JSON.stringify(r.error)}`);
  const f = r.error.envelope.refusal;
  return { status: r.error.status, code: f.code, kind: f.kind, why: f.why, controls: f.controls };
}

/** The value of a successful result (fails the test with the refusal otherwise). */
export function valueOf<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
}

export const NEW_FAMILY = {
  templateId: 'dc-mini',
  familyCode: 'PCM500-DC',
  product: { code: 'PCM500', name: 'Paracetamol tablets', strength: '500 mg' },
  batchSizes: [
    { quantity: '60.000', unit: 'kg' },
    { quantity: '30.000', unit: 'kg' },
  ],
  markets: ['IN'],
};

/** Creates a family from the template as the author; returns the new DRAFT version. */
export async function createFamily(author: TestBrowser, overrides: Partial<typeof NEW_FAMILY> = {}): Promise<VersionView> {
  return valueOf(await author.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, ...overrides } }));
}

/** Saves content as a new revision of the version (baseRevision = the view's revision). */
export async function saveContent(author: TestBrowser, v: VersionView, content: unknown, note = 'test change'): Promise<Result<VersionView>> {
  return author.call(routes.designer.saveContent, { params: { versionId: v.versionId }, body: { baseRevision: v.revision, content: content as VersionView['content'], note } });
}

/** A deep copy of a version's content (typed MBR content), mutated. */
export function edited(v: VersionView, mutate: (c: flow.MbrContent) => void): flow.MbrContent {
  const c = structuredClone(v.content) as unknown as flow.MbrContent;
  mutate(c);
  return c;
}

/** Removes a step from its parent sequence by id (returns true when found). */
export function removeNode(c: flow.MbrContent, id: string): boolean {
  let removed = false;
  flow.walk(c.procedure.body, (n) => {
    if (removed || n.kind !== 'sequence') return;
    const i = n.children.findIndex((ch) => ch.id === id);
    if (i >= 0) {
      n.children.splice(i, 1);
      removed = true;
    }
  });
  return removed;
}

/** A phase of the procedure tree by id (throws when there is none). */
export function findPhase(c: flow.MbrContent, id: string): flow.PhaseNode {
  let found: flow.PhaseNode | undefined;
  flow.walk(c.procedure.body, (n) => {
    if (n.id === id && n.kind === 'phase') found = n;
  });
  if (!found) throw new Error(`no phase ${id}`);
  return found;
}

/** A parameter by id (throws when there is none). */
export function parameter(c: flow.MbrContent, id: string): flow.Parameter {
  const p = c.parameters.find((x) => x.id === id);
  if (!p) throw new Error(`no parameter ${id}`);
  return p;
}
