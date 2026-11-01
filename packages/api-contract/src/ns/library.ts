/**
 * The library of block definitions (decision 0026, slice S3): blocks as data, drafted by an author, approved by QA with
 * a LIBRARY_BLOCK_APPROVED signature (never by the author; signable action LIBRARY_ACT) and retired with a reason.
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

export const LibraryBlockState = z.enum(['DRAFT', 'APPROVED', 'RETIRED']);

export const LibraryBlockView = z.strictObject({
  blockId: Uuid,
  code: z.string(),
  version: z.number().int().min(1),
  title: z.string(),
  category: z.string(),
  state: LibraryBlockState,
  contentHash: z.string(),
  /** The definition as stored (recipe-core library BlockDefinition). */
  definition: z.record(z.string(), z.unknown()),
  draftedBy: PersonRef,
  draftedAt: Instant,
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
  retiredAt: Instant.nullable(),
  retirementReason: z.string().nullable(),
});
export type LibraryBlockView = z.infer<typeof LibraryBlockView>;

/** A problem the definition check found (recipe-core library checkBlockDefinition); warnings do not refuse a draft. */
export const LibraryProblemView = z.strictObject({ code: z.string(), severity: z.enum(['ERROR', 'WARNING']), path: z.string(), message: z.string(), controls: z.array(z.string()) });

export const library = {
  list: defineRoute({
    id: 'library.list',
    method: 'GET',
    path: '/api/library/blocks',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Library block versions, newest first, optionally of one code or state',
    query: z.strictObject({ code: z.string().regex(/^[A-Z][A-Z0-9-]{1,39}$/).optional(), state: LibraryBlockState.optional() }),
    response: z.strictObject({ blocks: z.array(LibraryBlockView) }),
  }),
  check: defineRoute({
    id: 'library.check',
    method: 'POST',
    path: '/api/library/blocks/check',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Check a block definition (typed fields, units, calculations, repeats, signatures) without storing it',
    body: z.strictObject({ definition: z.record(z.string(), z.unknown()) }),
    response: z.strictObject({ problems: z.array(LibraryProblemView) }),
  }),
  draft: defineRoute({
    id: 'library.draft',
    method: 'POST',
    path: '/api/library/blocks',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Store the next version of a library block definition (author); it is used once QA approves it (LIBRARY_ACT)',
    body: withAttribution({ definition: z.record(z.string(), z.unknown()) }),
    response: z.strictObject({ block: LibraryBlockView, warnings: z.array(LibraryProblemView) }),
  }),
  retire: defineRoute({
    id: 'library.retire',
    method: 'POST',
    path: '/api/library/blocks/retire',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Retire an approved library block version with a reason (QA); formulations that pinned it keep their pin',
    body: withAttribution({ blockId: Uuid, reason: z.string().trim().min(1).max(2000) }),
    response: LibraryBlockView,
  }),
};
