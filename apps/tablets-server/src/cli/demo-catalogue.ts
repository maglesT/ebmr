/**
 * D-4 (demo gaps): the demo's library catalogue, ready for a new master. `pnpm demo:setup` loads the ready-made catalogue
 * (the same drafting as "Load the ready-made catalogue", draftSeedCatalogue) and approves every block through the real
 * signed act: the demo QA persona signs LIBRARY_BLOCK_APPROVED and recipe.approve_library_block records it, as for any
 * approval. So "Add library block" offers the whole catalogue of each edition on a fresh demo.
 *
 * The record says what was done (owner rule): each approval's command and signature carry the reason DEMO_CATALOGUE_REASON,
 * so the audit trail shows that the demo set-up made it, not a person who reviewed the block. DEMO-ONLY: it runs only on
 * a demo or E2E database (demoSeedRefusal), from the set-up CLI; product code never calls it (demo-catalogue test).
 *
 * Controls: PR-05 (versioned, QA-approved library content), DI-35 (the QA approval signature), DI-22 (the audit trail
 * records the act and its reason).
 */
import { randomUUID } from 'node:crypto';
import { withCommand } from '@ebmr/kernel';
import type pg from 'pg';
import { draftSeedCatalogue } from '../features/library/index.ts';
import type { FeatureSeedContext } from '../features/types.ts';

export const DEMO_CATALOGUE_REASON = 'Demo set-up: seed catalogue approved by the demo QA persona (demo:setup)';

export interface DemoCatalogueSeed {
  drafted: number;
  approved: number;
}

export async function seedDemoCatalogue(ctx: FeatureSeedContext, log: (message: string) => void): Promise<DemoCatalogueSeed> {
  const as = async <T>(persona: string, reasonText: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
    withCommand(ctx.pools.app, { ...(await ctx.actorFor(persona)), reasonText, correlationId: randomUUID() }, work);
  const { drafted } = await as('author', 'Demo set-up: seed catalogue loaded as drafts (demo:setup)', (c) => draftSeedCatalogue(c));
  const { rows } = await ctx.pools.admin.query<{ id: string }>("select id from recipe.library_block where recipe.library_block_state(id) = 'DRAFT' order by code, version");
  log(`demo catalogue: ${drafted.length} blocks drafted; approving ${rows.length} as the demo QA persona`);
  for (const { id } of rows) {
    const sig = await ctx.signAs('approver', { type: 'library_block', id }, 'LIBRARY_BLOCK_APPROVED', 'DRAFT', DEMO_CATALOGUE_REASON);
    await as('approver', DEMO_CATALOGUE_REASON, (c) => c.query('select recipe.approve_library_block($1, $2)', [id, sig]));
  }
  return { drafted: drafted.length, approved: rows.length };
}
