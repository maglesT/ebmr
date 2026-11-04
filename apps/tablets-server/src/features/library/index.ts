/**
 * The library of block definitions (decision 0026, slice S3; recipe-core sql/1800_library_blocks.sql).
 *
 * An author drafts the next version of a block definition; the server checks its form first (recipe-core library
 * checkBlockDefinition: errors refuse, warnings are returned) and the database keeps the shape, the content hash, the
 * version order and who may do what (MBR.AUTHOR drafts, MBR.APPROVE approves and retires). QA approves with a
 * LIBRARY_BLOCK_APPROVED signature (signable action LIBRARY_ACT), never the author; an approved version is retired
 * with a reason.
 */
import { routes, type LibraryBlockView, type SignableAction } from '@ebmr/api-contract';
import { librarySeed } from '@ebmr/recipe-core';
import { library } from '@ebmr/recipe-core/pure';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { EXPRESSIONS } from '../designer/adapters/expressions.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type Db = Pick<pg.Pool, 'query'>;
type LibraryAct = Extract<SignableAction, { kind: 'LIBRARY_ACT' }>;

interface BlockRow {
  id: string;
  code: string;
  version: number;
  title: string;
  category: string;
  state: LibraryBlockView['state'];
  content_hash: string;
  definition: Record<string, unknown>;
  drafted_by: string;
  drafted_us: string;
  approved_by: string | null;
  approved_us: string | null;
  retired_us: string | null;
  reason: string | null;
}

async function blocks(app: AppContext, db: Db, filter: { id?: string; code?: string | undefined; state?: string | undefined; edition?: string | undefined }): Promise<LibraryBlockView[]> {
  const { rows } = await db.query<BlockRow>(
    `select b.id, b.code, b.version, b.title, b.category, recipe.library_block_state(b.id) as state, b.content_hash, b.definition,
            b.drafted_by_person as drafted_by, ${usOf('b.drafted_at')} as drafted_us,
            a.approved_by_person as approved_by, case when a.approved_at is null then null else ${usOf('a.approved_at')} end as approved_us,
            case when r.retired_at is null then null else ${usOf('r.retired_at')} end as retired_us, r.reason
       from recipe.library_block b
       left join recipe.library_block_approval a on a.block_id = b.id
       left join recipe.library_block_retirement r on r.block_id = b.id
      where ($1::uuid is null or b.id = $1) and ($2::text is null or b.code = $2)
        and ($3::text is null or recipe.library_block_state(b.id) = $3)
        and ($4::text is null or recipe.library_block_edition(b.definition) in ($4, 'generic'))
      order by b.code, b.version desc limit 1000`,
    [filter.id ?? null, filter.code ?? null, filter.state ?? null, filter.edition ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.drafted_by, r.approved_by]));
  return rows.map((r) => ({
    blockId: r.id,
    code: r.code,
    version: r.version,
    title: r.title,
    category: r.category,
    edition: library.blockEdition(r.definition),
    state: r.state,
    contentHash: r.content_hash,
    definition: r.definition,
    draftedBy: personRef(people, r.drafted_by, 'AUTHOR'),
    draftedAt: app.formatInstant(r.drafted_us),
    approvedBy: r.approved_by ? personRef(people, r.approved_by, 'APPROVER') : null,
    approvedAt: r.approved_us ? app.formatInstant(r.approved_us) : null,
    retiredAt: r.retired_us ? app.formatInstant(r.retired_us) : null,
    retirementReason: r.reason,
  }));
}

function checkDefinition(definition: Record<string, unknown>): library.LibraryProblem[] {
  return library.checkBlockDefinition(definition as unknown as library.BlockDefinition, EXPRESSIONS);
}

export function libraryActHandler(app: AppContext): SignableActionHandler<LibraryAct> {
  return dbActHandler<LibraryAct>(app, {
    kind: 'LIBRARY_ACT',
    aggregateTypes: ['library_block'],
    target: (a) => ({ aggregateType: 'library_block', aggregateId: a.subjectId, meaning: 'LIBRARY_BLOCK_APPROVED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select recipe.approve_library_block($1, $2)', [a.subjectId, signatureId]);
      return { act: a.act, subjectId: a.subjectId };
    },
  });
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(libraryActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.library, {
    list: async ({ query, requireSession }) => {
      requireSession();
      return { blocks: await blocks(app, pool, { code: query.code, state: query.state, edition: query.edition }) };
    },
    check: ({ body, requireSession }) => {
      requireSession();
      return Promise.resolve({ problems: checkDefinition(body.definition) });
    },
    draft: async ({ body, actor, idempotencyKey, requestHash }) => {
      const problems = checkDefinition(body.definition);
      const errors = problems.filter((p) => p.severity === 'ERROR');
      if (errors.length > 0) {
        throw refusal(422, {
          code: errors[0]?.code ?? 'LIB-INVALID',
          kind: 'INVALID_INPUT',
          whatHappened: 'The block definition was not stored: it has problems to fix first.',
          why: errors.map((p) => `${p.path}: ${p.message}`).join(' '),
          controls: [...new Set(errors.flatMap((p) => p.controls))],
          whatYouCanDo: ['Correct each problem listed and store the definition again.'],
        });
      }
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ r: { blockId: string } }>('select recipe.draft_library_block($1::jsonb) as r', [JSON.stringify(body.definition)]);
        return rows[0]?.r.blockId ?? '';
      });
      const [block] = await blocks(app, pool, { id: out.result });
      if (!block) throw refusal(404, { code: 'LIB-NOT-FOUND', kind: 'STALE', whatHappened: 'The stored block could not be read back.' });
      return { block, warnings: problems.filter((p) => p.severity === 'WARNING') };
    },
    loadCatalogue: async ({ actor, idempotencyKey, requestHash }) => {
      // S7: the catalogue goes into the library as drafts through the same command as any author's draft; codes the
      // library already holds are left alone (a site's own versions are never overwritten). The deferred hard-capsule
      // blocks are not loaded (owner, 3 November 2026; R3-CAT-4).
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.require_library_author()');
        const { rows } = await c.query<{ code: string }>('select distinct code from recipe.library_block');
        const held = new Set(rows.map((r) => r.code));
        const drafted: string[] = [];
        const skipped: string[] = [];
        for (const item of librarySeed.TABLETS_CATALOGUE) {
          const def = item.definition;
          if (held.has(def.code) || checkDefinition(def as unknown as Record<string, unknown>).some((p) => p.severity === 'ERROR')) {
            skipped.push(def.code);
            continue;
          }
          await c.query('select recipe.draft_library_block($1::jsonb)', [JSON.stringify(def)]);
          drafted.push(def.code);
        }
        return { drafted, skipped };
      });
      return out.result;
    },
    retire: async ({ body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.retire_library_block($1, $2)', [body.blockId, body.reason]);
        return body.blockId;
      });
      const [block] = await blocks(app, pool, { id: body.blockId });
      if (!block) throw refusal(404, { code: 'LIB-NOT-FOUND', kind: 'STALE', whatHappened: 'The library block could not be read back.' });
      return block;
    },
  });
  return Promise.resolve();
}
