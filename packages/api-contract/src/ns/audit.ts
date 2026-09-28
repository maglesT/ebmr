/**
 * Namespace `audit` (C1, both installations): the hash-chained audit trail viewer (Phase 2 apps plan
 * section 11). Read-only: no route edits, disables or purges anything (a route inventory test proves it).
 */
import { z } from 'zod';
import { Instant, IntegerString, PersonRef } from '../common.ts';
import { defineRoute } from '../route.ts';

export const AuditEventView = z.strictObject({
  eventId: z.string(),
  chainKey: z.string(),
  seq: IntegerString,
  at: Instant,
  /** BUSINESS: a plain-language business entry; ROW: a captured field change. */
  kind: z.enum(['BUSINESS', 'ROW']),
  action: z.string(),
  summary: z.string(),
  table: z.string().nullable(),
  recordId: z.string().nullable(),
  /** Who (legal name, user ID, role); null for the installation pipeline. */
  who: PersonRef.nullable(),
  device: z.string().nullable(),
  /** Why: the reason given, if any. */
  why: z.string().nullable(),
  correlationId: z.string().nullable(),
  changes: z.array(z.strictObject({ field: z.string(), old: z.string().nullable(), new: z.string().nullable() })),
});
export type AuditEventView = z.infer<typeof AuditEventView>;

export const AuditChainView = z.strictObject({
  chainKey: z.string(),
  label: z.string(),
  events: z.number().int().nonnegative(),
  lastAt: Instant.nullable(),
});

export const ChainVerificationView = z.strictObject({
  chainKey: z.string(),
  ok: z.boolean(),
  events: z.number().int().nonnegative(),
  problems: z.array(z.string()),
  verifiedAt: Instant,
});
export type ChainVerificationView = z.infer<typeof ChainVerificationView>;

export const audit = {
  chains: defineRoute({
    id: 'audit.chains',
    method: 'GET',
    path: '/api/audit/chains',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'Audit chains, optionally by key prefix (mbr_version:, batch:)',
    query: z.strictObject({ prefix: z.string().optional() }),
    response: z.strictObject({ chains: z.array(AuditChainView) }),
  }),
  events: defineRoute({
    id: 'audit.events',
    method: 'GET',
    path: '/api/audit/events',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'Audit events by chain, correlation, person and time, business entries first, keyset paging',
    query: z.strictObject({
      chainKey: z.string().optional(),
      correlationId: z.string().optional(),
      personId: z.string().optional(),
      /** Epoch microseconds, inclusive. */
      from: z.string().regex(/^-?\d+$/).optional(),
      to: z.string().regex(/^-?\d+$/).optional(),
      cursor: z.string().optional(),
      limit: z.string().regex(/^[1-9]\d{0,2}$/).optional(),
    }),
    response: z.strictObject({ events: z.array(AuditEventView), nextCursor: z.string().nullable() }),
  }),
  verifyChain: defineRoute({
    id: 'audit.verifyChain',
    method: 'GET',
    path: '/api/audit/chains/:chainKey/verify',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'Verify one hash chain (kernel verifyChain)',
    params: z.strictObject({ chainKey: z.string().min(1) }),
    response: ChainVerificationView,
  }),
} as const;
