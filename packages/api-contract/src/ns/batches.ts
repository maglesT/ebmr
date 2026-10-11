/**
 * Namespace `batches` (Phase 3 slice 6, D-S6-1, GMP): the running GMP batch under `/api/batches/*`. The sandbox keeps
 * `/api/test-runs/*` (namespace `execution`); both mount the same handlers and each installation answers only its own
 * family (the other answers 404). A GMP batch's id is its run id: views reuse the execution views.
 *
 * Besides the run views: the void of an attempt is proposed as an act for QA's approval (no route deletes an entry,
 * DI-24); the SSCC register of the batch (TB-24); the sources a TB-08 or G-24@2 addition may take, with the facts the
 * database reads for each (never the browser's).
 */
import { z } from 'zod';
import { DecimalString, Empty, Instant, PersonRef, RunVersion, Uuid, withAttribution } from '../common.ts';
import { ActId, ClientIntent, StepKey } from '../intents.ts';
import { defineRoute } from '../route.ts';
import { CommandResultView, ReplayReportView, RunSummaryView, RunView, StepScreenView, TimelineEntryView, WorkQueueItem } from './execution.ts';

const batchParams = z.strictObject({ batchId: Uuid });
const stepParams = z.strictObject({ batchId: Uuid, stepKey: StepKey });

/** An act proposed for approval before it is recorded (recipe.propose_act): QA signs its meaning on aggregate batch_act. */
export const ProposedActView = z.strictObject({
  /** The act's aggregate id (batch_act): <batch>:act@<state version>:<hash of the act>; the void is sent at that state version. */
  actId: ActId,
  batchId: Uuid,
  /** The engine command the act will be (VOID_ATTEMPT). */
  commandType: z.literal('VOID_ATTEMPT'),
  /** The meaning the approver signs (VOID_AUTHORISED). */
  meaning: z.string(),
  aggregateType: z.literal('batch_act'),
  proposedBy: PersonRef,
  proposedAt: Instant,
});
export type ProposedActView = z.infer<typeof ProposedActView>;

/** One SSCC the database issued for the batch (tab.sscc_issue), with the shipper entry that used it, if any. */
export const SsccView = z.strictObject({
  sscc: z.string().regex(/^[0-9]{18}$/),
  stepKey: z.string(),
  issuedAt: Instant,
  issuedBy: PersonRef,
  /** The shipper entry that names it: packs and whether it is the part shipper; null while unused. */
  shipper: z.strictObject({ packs: z.string(), part: z.boolean() }).nullable(),
});
export type SsccView = z.infer<typeof SsccView>;

export const SsccRegisterView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  ssccs: z.array(SsccView),
});
export type SsccRegisterView = z.infer<typeof SsccRegisterView>;

/**
 * A source an addition (TB-08 case 1 or 2, G-24@2) may take: a residue container reserved under RESIDUE_RESERVED or a
 * container of an authorised reprocessing, with the facts the database reads (remaining quantity, the source batch's
 * expiry, the authorisation) and why it may not be used now.
 */
export const AdditionSourceView = z.strictObject({
  containerId: Uuid,
  label: z.string(),
  sourceBatchNumber: z.string(),
  product: z.string(),
  intermediate: z.string().nullable(),
  remaining: DecimalString,
  unit: z.string(),
  sourceExpiry: Instant.nullable(),
  reservedAt: Instant.nullable(),
  /** The reprocessing authorisation that covers it (case 2), if any. */
  authorisationId: Uuid.nullable(),
  /** Why the database would refuse it for this step now (null: usable). */
  problem: z.string().nullable(),
});
export type AdditionSourceView = z.infer<typeof AdditionSourceView>;

export const batches = {
  list: defineRoute({
    id: 'batches.list',
    method: 'GET',
    path: '/api/batches',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'GMP batches of the site (issued, running, on hold, complete)',
    query: z.strictObject({ status: z.enum(['ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED']).optional() }),
    response: z.strictObject({ batches: z.array(RunSummaryView) }),
  }),
  batch: defineRoute({
    id: 'batches.batch',
    method: 'GET',
    path: '/api/batches/:batchId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'GMP batch overview: stages, steps, exceptions, holds, timers',
    params: batchParams,
    response: RunView,
  }),
  step: defineRoute({
    id: 'batches.step',
    method: 'GET',
    path: '/api/batches/:batchId/steps/:stepKey',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The step screen of one step instance of a GMP batch',
    params: stepParams,
    response: StepScreenView,
  }),
  workQueue: defineRoute({
    id: 'batches.workQueue',
    method: 'GET',
    path: '/api/batches/:batchId/work-queue',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: '"What you can do now" in one GMP batch, for this terminal\'s room',
    params: batchParams,
    response: z.strictObject({ items: z.array(WorkQueueItem) }),
  }),
  timeline: defineRoute({
    id: 'batches.timeline',
    method: 'GET',
    path: '/api/batches/:batchId/timeline',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Every engine call of the GMP batch (issue, commands, prepares, sweeps), refusals included',
    params: batchParams,
    response: z.strictObject({ entries: z.array(TimelineEntryView) }),
  }),
  command: defineRoute({
    id: 'batches.command',
    method: 'POST',
    path: '/api/batches/:batchId/commands',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'One plain client intent (no signature) on a GMP batch, resolved by the server into an engine command',
    params: batchParams,
    body: withAttribution({
      expectedVersion: RunVersion,
      intent: ClientIntent,
      viewStepKey: StepKey.optional(),
    }),
    response: CommandResultView,
  }),
  verifyReplay: defineRoute({
    id: 'batches.verifyReplay',
    method: 'POST',
    path: '/api/batches/:batchId/verify-replay',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Replay the stored rows of the GMP batch and report identical or the first difference',
    params: batchParams,
    body: Empty,
    response: ReplayReportView,
  }),
  proposeAct: defineRoute({
    id: 'batches.proposeAct',
    method: 'POST',
    path: '/api/batches/:batchId/acts',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Propose a void of an attempt for QA\'s approval (the approval is signed on the act; the void is then sent as a command)',
    params: batchParams,
    body: z.strictObject({
      intent: z.strictObject({
        type: z.literal('VOID_ATTEMPT'),
        stepKey: StepKey,
        item: z.string().min(1).max(128),
        reason: z.string().trim().min(1).max(2000),
        point: z.string().min(1).max(128).optional(),
      }),
    }),
    response: ProposedActView,
  }),
  sscc: defineRoute({
    id: 'batches.sscc',
    method: 'GET',
    path: '/api/batches/:batchId/sscc',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The SSCC register of the batch: each SSCC the database issued and the shipper that used it',
    params: batchParams,
    response: SsccRegisterView,
  }),
  issueSscc: defineRoute({
    id: 'batches.issueSscc',
    method: 'POST',
    path: '/api/batches/:batchId/steps/:stepKey/sscc',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Issue the next SSCC for a TB-24 step of the batch (number and check digit from the database, PR-42)',
    params: stepParams,
    body: z.strictObject({}),
    response: SsccView,
  }),
  additionSources: defineRoute({
    id: 'batches.additionSources',
    method: 'GET',
    path: '/api/batches/:batchId/steps/:stepKey/addition-sources',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The sources a TB-08 or G-24@2 addition of this step may take, with the facts the database reads for each',
    params: stepParams,
    response: z.strictObject({ stepKey: StepKey, block: z.string(), sources: z.array(AdditionSourceView) }),
  }),
} as const;
