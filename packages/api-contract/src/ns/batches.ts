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
import { Code, PlannedHours, StepPlantView } from './plant-floor.ts';
import { CommandResultView, ReplayReportView, RunSummaryView, RunView, StepScreenView, TimelineEntryView, WorkQueueItem } from './execution.ts';

const batchParams = z.strictObject({ batchId: Uuid });
const stepParams = z.strictObject({ batchId: Uuid, stepKey: StepKey });

/**
 * R3.3 (hosted-demo trials; D-7k-2): the plant act a status or clearance step stands on, done and recorded in the step as
 * one act of the person (one badge tap on a kiosk): the start of the batch's use of a room or line of the step's stage
 * (on its verified clearance; a line names the order and artwork set it was cleared for), or the booking of a unit the
 * step checks (an instrument booked, a process unit's use started) for the hours given.
 */
export const PlantEntryAct = z.discriminatedUnion('act', [
  z.strictObject({ act: z.literal('START_AREA_OCCUPANCY'), areaCode: Code, order: z.string().trim().min(1).max(64).optional(), artworkSet: z.string().trim().min(1).max(64).optional() }),
  z.strictObject({ act: z.literal('BOOK_UNIT'), equipmentRef: z.string().trim().min(1).max(64), code: Code, plannedHours: PlannedHours }),
]);
export type PlantEntryAct = z.infer<typeof PlantEntryAct>;

/**
 * R3.10 (hosted-demo trials): the rooms and units a batch's stages need, stage by stage, each with its cleaning state
 * (the plant's own state: DIRTY needs a cleaning, CLEANING waits for its completion and verification), so the plant screen
 * starts the needed cleanings from one list. A stage signed off needs nothing more.
 */
export const CleaningNeedsView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  stages: z.array(
    z.strictObject({
      stageKey: z.string(),
      name: z.string(),
      status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'SIGNED_OFF']),
      rooms: z.array(z.strictObject({ code: z.string(), kind: z.enum(['ROOM', 'LINE']), state: z.string(), needsCleaning: z.boolean() })),
      units: z.array(z.strictObject({ ref: z.string(), classCode: z.string(), code: z.string(), name: z.string(), state: z.string(), needsCleaning: z.boolean() })),
    }),
  ),
});
export type CleaningNeedsView = z.infer<typeof CleaningNeedsView>;

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

/**
 * A printed packaging lot as the batch issues it now (tab.printed_lot_facts; Phase 7 slice 7h, gap report D2): exactly the
 * facts a G-21 ISSUE entry must carry (the database refuses an entry whose lot states other facts, PR-32, PR-33), so the
 * step screen fills them from the register when the operator scans the lot: its code, material, status, recorded artwork
 * version and expiry (UTC epoch microseconds as digits).
 */
export const PrintedLotFactsView = z.strictObject({
  id: z.string(),
  material: z.string(),
  status: z.string(),
  artwork: z.string(),
  expiresAtUs: z.string().regex(/^[0-9]+$/).optional(),
});
export type PrintedLotFactsView = z.infer<typeof PrintedLotFactsView>;

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

/** Bulk issued to a packaging order from its processing batch's usable containers (recipe-core 0701, exit review HIGH-3). */
export const BulkIssueView = z.strictObject({
  batchId: Uuid,
  parentBatchId: Uuid,
  containers: z.array(z.strictObject({ label: z.string(), containerId: Uuid, quantity: DecimalString, unit: z.enum(['kg', 'g', 'units']) })),
});
export type BulkIssueView = z.infer<typeof BulkIssueView>;

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
  plantEntry: defineRoute({
    id: 'batches.plantEntry',
    method: 'POST',
    path: '/api/batches/:batchId/steps/:stepKey/plant-entries',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Start the use of a room or line, or book a unit, and record it in the step as one act (R3.3; PR-34, PR-23, IN-21, INV-12); the database guards both',
    params: stepParams,
    body: withAttribution({ expectedVersion: RunVersion, act: PlantEntryAct }),
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
    attribution: 'FRESH_ON_SHARED',
    summary: 'Propose a void of an attempt for QA\'s approval (the approval is signed on the act; the void is then sent as a command)',
    params: batchParams,
    body: withAttribution({
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
    attribution: 'FRESH_ON_SHARED',
    summary: 'Issue the next SSCC for a TB-24 step of the batch (number and check digit from the database, PR-42)',
    params: stepParams,
    body: withAttribution({}),
    response: SsccView,
  }),
  issueBulk: defineRoute({
    id: 'batches.issueBulk',
    method: 'POST',
    path: '/api/batches/:batchId/bulk',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Issue the processing batch\'s usable containers (scanned labels) to the packaging order that packs it, once QA released it for packing (H-PACK); a packing step starts only then',
    params: batchParams,
    body: withAttribution({ labels: z.array(z.string().trim().min(1).max(64)).min(1).max(200) }),
    response: BulkIssueView,
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
  // Phase 7 slice 7h (WP-A): what the step screen offers its plant acts from (ns/plant-floor.ts).
  printedLot: defineRoute({
    id: 'batches.printedLot',
    method: 'GET',
    path: '/api/batches/:batchId/printed-lots/:code',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'A printed packaging lot as the batch issues it now (its code, material, status, recorded artwork and expiry), for the G-21 issue entry; 404 when it is no printed packaging lot with a recorded artwork',
    params: z.strictObject({ batchId: Uuid, code: z.string().min(1).max(64) }),
    response: PrintedLotFactsView,
  }),
  cleaningNeeds: defineRoute({
    id: 'batches.cleaningNeeds',
    method: 'GET',
    path: '/api/batches/:batchId/cleaning-needs',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The rooms and units the batch\'s stages need, each with its cleaning state (R3.10), so the needed cleanings start from one list',
    params: batchParams,
    response: CleaningNeedsView,
  }),
  stepPlant: defineRoute({
    id: 'batches.stepPlant',
    method: 'GET',
    path: '/api/batches/:batchId/steps/:stepKey/plant',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The plant facts of a step: its rooms and units, the batch\'s open occupancies and uses, its tooling and its containers, so the step\'s acts name them without typing',
    params: stepParams,
    response: StepPlantView,
  }),
} as const;
