/**
 * Namespace `containers` (Phase 4 slice 1b, GMP): the output containers of a batch over HTTP (recipe-core 0420 to 0422,
 * 0740, 0741; tablets 1111). A container is opened for a batch and stage, closed with its net quantity, and, when an
 * in-process failure held it, sorted, rejected or released by QA. Every rule is the database's:
 *  - the close is WEIGHED (tare and gross scale readings claimed for it from a balance of the session's room) or TYPED;
 *    a typed net leaves the container unusable until a second person verifies it (CONTAINER_ACT VERIFY_CLOSE, meaning
 *    VERIFIED, never the closer: DI-30);
 *  - QA releases a held container (CONTAINER_ACT RELEASE, meaning OUTPUT_CONTAINER_RELEASED) only once its hold's
 *    exceptions are dispositioned and their deviations concluded (`releaseProblem` says why not yet).
 * Reads are plain SESSION routes; the commands are the person's own (FRESH_ON_SHARED on a kiosk).
 */
import { z } from 'zod';
import { DecimalString, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const Stage = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/);
const Code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$/);
const Stream = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/);
const Reason = z.strictObject({ code: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(2000) });

export const ContainerState = z.enum(['OPEN', 'CLOSED', 'HELD', 'SORTED', 'REJECTED', 'RELEASED_BY_QA']);
export type ContainerState = z.infer<typeof ContainerState>;

export const ContainerHoldView = z.strictObject({
  checkId: Uuid,
  result: z.enum(['FAIL', 'MISSED']),
  press: z.string(),
  stream: z.string().nullable(),
  /** The check's reference (`<block>:<step key>:...` from a block; free text from a direct record). */
  reference: z.string(),
  recordedAt: Instant,
});
export type ContainerHoldView = z.infer<typeof ContainerHoldView>;

export const ContainerView = z.strictObject({
  containerId: Uuid,
  label: z.string(),
  batchId: Uuid,
  batchNumber: z.string(),
  stage: z.string(),
  press: z.string().nullable(),
  stream: z.string().nullable(),
  unit: z.enum(['kg', 'g', 'units']),
  state: ContainerState,
  /** The state engine's version, sent back as expectedVersion by the next command. */
  version: z.number().int().positive(),
  openedBy: PersonRef,
  openedAt: Instant,
  netQuantity: DecimalString.nullable(),
  /** WEIGHED (scale readings) or TYPED; null while open (or for a close recorded before Phase 4). */
  closeBasis: z.enum(['WEIGHED', 'TYPED']).nullable(),
  closedBy: PersonRef.nullable(),
  closedAt: Instant.nullable(),
  /** The second person who verified a typed net (DI-30), or null. */
  netVerifiedBy: PersonRef.nullable(),
  holds: z.array(ContainerHoldView),
  /** Why it cannot be charged, merged or packed now (the database's words), or null. */
  usableProblem: z.string().nullable(),
  /** Why QA cannot release it now (held only), or null. */
  releaseProblem: z.string().nullable(),
});
export type ContainerView = z.infer<typeof ContainerView>;

const containerParams = z.strictObject({ containerId: Uuid });

export const containers = {
  list: defineRoute({
    id: 'containers.list',
    method: 'GET',
    path: '/api/containers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The output containers of a GMP batch, oldest first, with their close, holds, and why each is not usable or releasable',
    query: z.strictObject({ batchId: Uuid }),
    response: z.strictObject({ containers: z.array(ContainerView) }),
  }),
  open: defineRoute({
    id: 'containers.open',
    method: 'POST',
    path: '/api/containers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Open a container of the batch at a stage (label generated, product and strength taken from the batch); on a press and stream when given',
    body: withAttribution({ batchId: Uuid, stage: Stage, unit: z.enum(['kg', 'g', 'units']), press: Code.optional(), stream: Stream.optional() }),
    response: ContainerView,
  }),
  close: defineRoute({
    id: 'containers.close',
    method: 'POST',
    path: '/api/containers/:containerId/close',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Close a container with its net: weighed (tare and gross scale readings of the room) or typed (then a second person verifies it, CONTAINER_ACT VERIFY_CLOSE)',
    params: containerParams,
    body: withAttribution({
      expectedVersion: z.number().int().positive(),
      weighing: z.strictObject({ tareReadingId: Uuid, grossReadingId: Uuid }).optional(),
      typed: z.strictObject({ net: DecimalString }).optional(),
    }).refine((b) => (b.weighing === undefined) !== (b.typed === undefined), 'a close is either weighed or typed'),
    response: ContainerView,
  }),
  sort: defineRoute({
    id: 'containers.sort',
    method: 'POST',
    path: '/api/containers/:containerId/sort',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Sort a held container (100 % sorting after the failure), with the person\'s reason',
    params: containerParams,
    body: withAttribution({ expectedVersion: z.number().int().positive(), reason: Reason }),
    response: ContainerView,
  }),
  reject: defineRoute({
    id: 'containers.reject',
    method: 'POST',
    path: '/api/containers/:containerId/reject',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'QA rejects a held or sorted container, with the person\'s reason',
    params: containerParams,
    body: withAttribution({ expectedVersion: z.number().int().positive(), reason: Reason }),
    response: ContainerView,
  }),
} as const;
