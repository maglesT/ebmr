/**
 * Namespace `execution` (C3): test packages and test batches (TEST-) in the sandbox, GMP batches planned from an effective
 * MBR version in GMP (Phase 3 slice 2b), and on both installations the work queue and lots (Phase 2 apps plan sections 7
 * and 9). Since Phase 3 slice 6 (D-S6-1) the running test batch (`/api/test-runs/*`: runs, run, step, timeline, replay,
 * commands) is the sandbox's only; a GMP batch runs under `/api/batches/*` (namespace `batches`, same handlers). The GMP batch is issued through the e-signature ceremony (signable action
 * GMP_BATCH_ISSUE, meaning ISSUED); test packages stay sandbox-only and GMP batches GMP-only (DI-05, INV-18).
 *
 * The browser never decides GMP outcomes: `actions` come from the server (availableActions by dry-run through
 * the engine), limit verdicts appear only in the view after the server committed, and values are never
 * pre-filled.
 */
import { z } from 'zod';
import { DataValueWire, DecimalString, Empty, Instant, IntegerString, PersonRef, RunVersion, SignableRef, Uuid, Watermark, withAttribution } from '../common.ts';
import { ClientIntent, StepKey } from '../intents.ts';
import { BlockEntryFormView } from '../tablet-entries.ts';
import { defineRoute } from '../route.ts';
import { ScaleStatusView } from './devices.ts';
import { ManifestationView } from './esig.ts';
import { ProductRef } from './designer.ts';
import { PlantEntryAct } from './plant-floor.ts';

export const BatchStatus = z.enum(['ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED']);
export const StepStatus = z.enum(['PENDING', 'ENABLED', 'IN_PROGRESS', 'ATTEMPT_HANDED_OVER', 'AWAITING_VERIFICATION', 'COMPLETED', 'NOT_APPLICABLE', 'SKIPPED']);
export const LimitTierWire = z.enum(['REGISTERED', 'VALIDATED', 'INTERNAL_ACTION', 'ALERT']);

/** What the person can do now, as the server's dry-run of the engine decided it. */
export const ActionName = z.enum([
  'START_STEP',
  'RECORD_DATA',
  'RECORD_ENTRY',
  'SIGN_PERFORMED',
  'VERIFY',
  'WITNESS',
  'DISPOSITION_HOLD_POINT',
  'SIGN_OFF_STAGE',
  'RAISE_EXCEPTION',
  'ATTACH_DEVIATION',
  'DISPOSITION_EXCEPTION',
  'HOLD_BATCH',
  'RELEASE_HOLD',
  'COMPLETE_LOOP_ITERATION',
  /** Phase 3 slice 6: void an attempt without a result, with a reason and QA's approval (never a delete). */
  'VOID_ATTEMPT',
]);
export const ActionView = z.strictObject({
  action: ActionName,
  available: z.boolean(),
  /** The one primary action of the step card. */
  primary: z.boolean(),
  requires: z.enum(['NONE', 'TAP', 'SIGNATURE']),
  /** Signature meaning for SIGNATURE actions (PERFORMED, VERIFIED, ...). */
  meaning: z.string().nullable(),
  /** Why it is not available (the engine's own refusal), or a hint. */
  reason: z.string().nullable(),
  /** Target of the action when it is not the step itself (exception id, stage key, hold id). */
  target: z.string().nullable(),
  /**
   * Who can do it when this viewer cannot, in words: for a verification or witness refused to a person who worked on
   * the step, or whose role may not check it, the roles that may, and who may not (INV-03). Empty otherwise.
   */
  whoCanHelp: z.array(z.string()),
});
export type ActionView = z.infer<typeof ActionView>;

export const TimerView = z.strictObject({
  constraint: z.string(),
  name: z.string(),
  kind: z.enum(['TIMER', 'HOLD', 'PROCESS_WINDOW', 'USE_BY', 'EXPOSURE']),
  status: z.enum(['RUNNING', 'WARNING', 'BREACHED', 'MET', 'VOIDED']),
  startedAt: Instant.nullable(),
  /** Minimum and maximum instants, when set; the browser counts down from the server offset. */
  minAt: Instant.nullable(),
  maxAt: Instant.nullable(),
});

export const LimitView = z.strictObject({
  tier: LimitTierWire,
  low: z.strictObject({ value: DecimalString, inclusive: z.boolean() }).nullable(),
  high: z.strictObject({ value: DecimalString, inclusive: z.boolean() }).nullable(),
  /** Source kind and reference, e.g. VALIDATION_REPORT VR-BLEND-01. */
  source: z.strictObject({ kind: z.string(), ref: z.string(), text: z.string() }),
  rounding: z.string(),
});

export const AttemptView = z.strictObject({
  pointId: z.string(),
  attempt: z.number().int().positive(),
  version: z.number().int().positive(),
  value: DataValueWire.nullable(),
  /** "You entered 12.503 kg" style echo of the stored value with its unit. */
  echo: z.string(),
  by: PersonRef,
  at: Instant,
  source: z.strictObject({
    mode: z.enum(['MANUAL', 'DEVICE', 'SCAN', 'AUTOMATION', 'LIMS', 'BLOCK']),
    deviceCode: z.string().nullable(),
    raw: z.string().nullable(),
    code: z.string().nullable(),
  }),
  /** The server's limit evaluation after commit (never computed in the browser). */
  verdict: z.strictObject({ tier: LimitTierWire.nullable(), failed: z.boolean(), text: z.string() }).nullable(),
  flags: z.array(z.string()),
  status: z.enum(['VALID', 'SUPERSEDED', 'INVALIDATED']),
});

export const FieldView = z.strictObject({
  item: z.string(),
  name: z.string(),
  valueType: z.enum(['DECIMAL', 'COUNT', 'BOOLEAN', 'CATEGORY', 'TEXT', 'INSTANT']),
  unit: z.string().nullable(),
  precision: z.strictObject({ kind: z.enum(['DECIMALS', 'SIGNIFICANT_FIGURES']), digits: z.number().int().nonnegative() }).nullable(),
  categories: z.array(z.string()).nullable(),
  capture: z.enum(['MANUAL', 'DEVICE', 'AUTOMATION', 'SCAN', 'LIMS']),
  target: z.strictObject({ value: DataValueWire, source: z.string() }).nullable(),
  limits: z.array(LimitView),
  attempts: z.array(AttemptView),
  /** Computed by the block or a calculation: shown, never typed (INV-25). */
  computed: z.boolean(),
  required: z.boolean(),
});
export type FieldView = z.infer<typeof FieldView>;

export const EntryView = z.strictObject({
  entryId: z.string(),
  kind: z.string(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()),
  by: PersonRef,
  at: Instant,
});

/** A form the renderer (or the schema-driven fallback) shows for one entry kind of the step's block. */
export const EntryFormView = z.strictObject({
  kind: z.string(),
  title: z.string(),
  description: z.string(),
  fields: z.array(
    z.strictObject({
      name: z.string(),
      label: z.string(),
      type: z.enum(['decimal', 'integer', 'string', 'boolean', 'enum', 'reading', 'lot', 'container', 'checklist']),
      unit: z.string().nullable(),
      options: z.array(z.strictObject({ value: z.string(), label: z.string() })).nullable(),
      required: z.boolean(),
      description: z.string(),
    }),
  ),
});

export const ExceptionView = z.strictObject({
  exceptionId: z.string(),
  type: z.string(),
  title: z.string(),
  category: z.string(),
  severity: z.enum(['ALERT', 'ACTION', 'CRITICAL']),
  tier: LimitTierWire.nullable(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  /** It stops completion or downstream steps until a deviation is linked or it is dispositioned. */
  blocking: z.boolean(),
  whatToDo: z.string(),
  /** Roles (and names, when known) the exception is routed to. */
  routedTo: z.array(z.string()),
  status: z.enum(['OPEN', 'DISPOSITIONED']),
  deviationRef: z.string().nullable(),
  raisedAt: Instant,
  raisedBy: PersonRef.nullable(),
  controls: z.array(z.string()),
});
export type ExceptionView = z.infer<typeof ExceptionView>;

export const RunHeaderView = z.strictObject({
  runId: Uuid,
  batchNumber: z.string(),
  /** The record the master makes (processing, packaging or reprocessing), for the screens' links to its containers, line completion and bulk (R10 #13). */
  recordKind: z.enum(['PROCESSING', 'PACKAGING', 'REPROCESSING']).optional(),
  product: ProductRef,
  markets: z.array(z.string()),
  status: BatchStatus,
  statusText: z.string(),
  /** TEST, NOT GMP on a sandbox test run; null on a GMP batch (DI-05: the installation decides, never the run). */
  watermark: Watermark.nullable(),
  /** Run version (optimistic locking: commands send it back as expectedVersion). */
  version: z.number().int().nonnegative(),
  mbr: z.strictObject({ familyCode: z.string(), versionNumber: z.string(), revision: z.number().int().nonnegative(), contentHash: z.string() }),
  stage: z.strictObject({ stageKey: z.string(), number: z.string(), name: z.string() }).nullable(),
  room: z.string().nullable(),
  equipment: z.array(z.strictObject({ ref: z.string(), code: z.string(), name: z.string() })),
  timers: z.array(TimerView),
  /**
   * The scale of the step's room (C5 via the device port), when the step weighs: an ONLINE one whenever one is, else the
   * room's only scale. The step's room is the viewer's terminal room when it is one the stage names (or the stage names
   * none), else the stage's first room.
   */
  scale: ScaleStatusView.nullable(),
  /** Every scale of that room with its status, when the step weighs: each ONLINE one can be captured from; keying weights by hand is open only while none is online. */
  scales: z.array(ScaleStatusView),
  /** The person signed in on this terminal. */
  identity: PersonRef.nullable(),
  lastSavedAt: Instant.nullable(),
});
export type RunHeaderView = z.infer<typeof RunHeaderView>;

export const StepScreenView = z.strictObject({
  /** Server time of this view (display countdowns start from it). */
  asOf: Instant,
  run: RunHeaderView,
  step: z.strictObject({
    stepKey: StepKey,
    stepId: z.string(),
    /** `2.1.3`, with loop and sub-lot suffix when the step repeats (`2.1.3 (sub-lot 2)`). */
    number: z.string(),
    ordinal: z.number().int().positive(),
    of: z.number().int().positive(),
    title: z.string(),
    kind: z.enum(['PHASE', 'HOLD']),
    /** `G-04@1`; null for hold points. */
    block: z.string().nullable(),
    blockTitle: z.string().nullable(),
    status: StepStatus,
    statusText: z.string(),
    instruction: z.strictObject({
      text: z.string(),
      sop: z.strictObject({ refId: z.string(), code: z.string(), title: z.string(), version: z.string(), hash: z.string() }).nullable(),
    }),
    /** Dispositions a hold point offers. */
    dispositions: z.array(z.string()),
  }),
  fields: z.array(FieldView),
  entries: z.array(EntryView),
  entryForms: z.array(EntryFormView),
  /**
   * Phase 3 slice 6: the entry kinds of the step's block the browser sends as a BLOCK_ENTRY (tablet blocks, G-06@1,
   * G-21@1, G-24@2; the typed kinds excluded), each with the block's own schema; empty for other blocks.
   */
  blockEntries: z.array(BlockEntryFormView),
  /**
   * Phase 7 slice 7l (R1): the entries of other steps of the batch that an entry of this step names (a TB-03 preparation
   * a binder addition or a coating suspension uses), so the person picks one instead of typing its id; empty when the
   * step's block names none.
   */
  citable: z.array(EntryView).optional(),
  /**
   * Phase 7 slice 7l (R1): the alternative the step's branch belongs to when a person chooses it (OPERATOR_CHOICE): its
   * branches, the roles that may choose and the branch chosen (null while undecided), so the authorised person
   * chooses it on the step screen with a reason (CHOOSE_ALTERNATIVE; the engine decides, DI-34, PR-13).
   */
  alternative: z
    .strictObject({
      construct: z.string(),
      /** The step-key context of the alternative's instance (empty outside loops and sub-lots). */
      context: z.string(),
      branches: z.array(z.strictObject({ id: z.string(), name: z.string() })),
      roles: z.array(z.string()),
      chosen: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /**
   * Phase 7 slice 7l (R1): the innermost loop the step's instance runs in (its iteration, and whether that iteration was
   * completed), so the person ends the iteration on the step screen once the step is completed (COMPLETE_LOOP_ITERATION;
   * the engine decides from the loop's exit condition whether another iteration follows, INV-19).
   */
  loop: z.strictObject({ construct: z.string(), name: z.string(), iteration: z.number().int().positive(), completed: z.boolean() }).nullable().optional(),
  exceptions: z.array(ExceptionView),
  signatures: z.array(ManifestationView),
  actions: z.array(ActionView),
  /** The signable aggregate of this step (batch_step), for the ceremony. */
  signable: SignableRef.nullable(),
  /**
   * R3.8 (hosted-demo trials): on a GMP weighing step, each BOM line the step dispenses with the quantity the batch's
   * production order needs, the net weighed so far for the batch (its containers' entries in the line's unit) and what
   * is still to weigh (negative: weighed over the order's quantity). Advisory: the reconciliation stays the record's.
   */
  bomRemaining: z
    .array(
      z.strictObject({
        bomLine: z.string(),
        material: z.string(),
        unit: z.string(),
        required: DecimalString,
        weighed: DecimalString,
        remaining: DecimalString,
        /** R10 #2: ORDER, the production order's quantity; POTENCY, the target of the step's potency calculation (TB-01). */
        basis: z.enum(['ORDER', 'POTENCY']).optional(),
      }),
    )
    .optional(),
  /**
   * R10 #1 (owner's rabeprazole demo): the result of the step's governing potency calculation (TB-01), read from its
   * stored entry: each lot with its approved assay and as-is potency, the active's and the compensating excipient's
   * targets, the total, and the summary sentence. Display only; the entry is the record.
   */
  potency: z
    .strictObject({
      lots: z.array(
        z.strictObject({
          lotCode: z.string(),
          basis: z.string(),
          assay: DecimalString,
          water: DecimalString.nullable(),
          lod: DecimalString.nullable(),
          asIs: DecimalString,
          baseEquivalent: DecimalString,
          target: DecimalString,
          /** R13: the lot's approved result has changed since this calculation (a new calculation is needed). */
          changed: z.boolean(),
        }),
      ),
      active: z.strictObject({ bomLine: z.string(), material: z.string(), unit: z.string(), standard: DecimalString, target: DecimalString }),
      excipient: z.strictObject({ bomLine: z.string(), material: z.string(), unit: z.string(), standard: DecimalString, target: DecimalString }).nullable(),
      total: DecimalString,
      summary: z.string(),
    })
    .nullable()
    .optional(),
});
export type StepScreenView = z.infer<typeof StepScreenView>;

export const StepSummaryView = z.strictObject({
  stepKey: StepKey,
  stepId: z.string(),
  number: z.string(),
  title: z.string(),
  block: z.string().nullable(),
  status: StepStatus,
  statusText: z.string(),
  openExceptions: z.number().int().nonnegative(),
});

export const StageView = z.strictObject({
  stageKey: z.string(),
  stageId: z.string(),
  number: z.string(),
  name: z.string(),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_SIGN_OFF', 'SIGNED_OFF']),
  /** Derived, never typed (G-02): completed per MBR, or with deviations. */
  summary: z.strictObject({ statement: z.enum(['COMPLETED_PER_MBR', 'COMPLETED_WITH_DEVIATIONS']), exceptions: z.array(z.string()), deviations: z.array(z.string()) }).nullable(),
  signOff: ManifestationView.nullable(),
  signable: SignableRef.nullable(),
  steps: z.array(StepSummaryView),
});

export const HoldView = z.strictObject({
  holdId: z.string(),
  type: z.enum(['SUPERVISOR', 'QA']),
  reason: z.string(),
  placedBy: PersonRef.nullable(),
  at: Instant,
  automatic: z.boolean(),
  released: z.strictObject({ by: PersonRef, reason: z.string(), at: Instant }).nullable(),
});

export const RunView = z.strictObject({
  asOf: Instant,
  header: RunHeaderView,
  stages: z.array(StageView),
  exceptions: z.array(ExceptionView),
  holds: z.array(HoldView),
  /** Run-level actions (hold, release). */
  actions: z.array(ActionView),
  /** Audit chain of the run, e.g. batch:<id>. */
  auditChain: z.string(),
});
export type RunView = z.infer<typeof RunView>;

export const RunSummaryView = z.strictObject({
  runId: Uuid,
  batchNumber: z.string(),
  product: ProductRef,
  markets: z.array(z.string()),
  status: BatchStatus,
  statusText: z.string(),
  issuedAt: Instant,
  version: z.number().int().nonnegative(),
  openExceptions: z.number().int().nonnegative(),
});

export const WorkQueueItem = z.strictObject({
  runId: Uuid,
  batchNumber: z.string(),
  product: ProductRef,
  stepKey: StepKey,
  number: z.string(),
  title: z.string(),
  stage: z.string(),
  room: z.string().nullable(),
  status: StepStatus,
  statusText: z.string(),
  /** Greyed with the server's reason when not available. */
  action: ActionView,
});
export type WorkQueueItem = z.infer<typeof WorkQueueItem>;

export const TestPackageView = z.strictObject({
  packageId: z.string(),
  packageHash: z.string(),
  fileName: z.string(),
  familyCode: z.string(),
  product: ProductRef,
  versionNumber: z.string(),
  revision: z.number().int().nonnegative(),
  state: z.string(),
  contentHash: z.string(),
  exportedAt: Instant,
  exporter: z.string(),
  /** The exporting installation (must be GMP to import). */
  sourceInstallation: z.enum(['GMP', 'SANDBOX']),
  imported: z.boolean(),
  importedAt: Instant.nullable(),
  /** Why the package cannot be imported (unexecutable record, wrong origin, hash mismatch). */
  problem: z.string().nullable(),
});
export type TestPackageView = z.infer<typeof TestPackageView>;

export const IssueFormView = z.strictObject({
  packageId: z.string(),
  product: ProductRef,
  /** Approved discrete batch sizes only (PR-01). */
  batchSizes: z.array(z.strictObject({ id: z.string(), quantity: DecimalString, unit: z.string(), label: z.string() })),
  markets: z.array(z.strictObject({ code: z.string(), locked: z.boolean() })),
  variants: z.array(z.strictObject({ id: z.string(), name: z.string(), options: z.array(z.string()) })),
  inputs: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      valueType: z.string(),
      unit: z.string().nullable(),
      source: z.string(),
      required: z.boolean(),
      /**
       * R3.1 (D-7k-1): the value the master implies (the tablet count: batch size / target tablet weight), the form's
       * pre-filled value; one further from it than the tolerance is issued only with the issuer's confirmation.
       */
      expected: z.strictObject({ value: z.string(), basis: z.string(), tolerancePercent: z.string() }).optional(),
    }),
  ),
});

export const ReplayReportView = z.strictObject({
  runId: Uuid,
  identical: z.boolean(),
  rows: z.number().int().nonnegative(),
  firstDifference: z.strictObject({ seq: IntegerString, field: z.string(), expected: z.string(), actual: z.string() }).nullable(),
  invariantViolations: z.array(z.string()),
  checkedAt: Instant,
});

/** Slice 7h (decision D-P7R-16): the test-run result written for GMP; the file text is offered for download too. */
export const RunResultExportView = z.strictObject({
  fileName: z.string(),
  resultHash: z.string(),
  passed: z.boolean(),
  fileText: z.string(),
});
export type RunResultExportView = z.infer<typeof RunResultExportView>;

export const TimelineEntryView = z.strictObject({
  seq: IntegerString,
  kind: z.enum(['ISSUE', 'COMMAND', 'PREPARE', 'SWEEP']),
  at: Instant,
  actor: PersonRef.nullable(),
  summary: z.string(),
  accepted: z.boolean(),
  refusal: z.string().nullable(),
});

export const LotView = z.strictObject({
  lotCode: z.string(),
  material: z.strictObject({ code: z.string(), name: z.string() }),
  status: z.string(),
  expiry: z.string().nullable(),
  retest: z.string().nullable(),
  identityTested: z.boolean(),
});

/**
 * Slice 7o (R4, R8): what a lot carries for the blocks besides its status: the current approved assay result a
 * potency-adjusted dispensing reads (TB-01; tablets 0841) and the artwork version a printed packaging lot was checked
 * with (G-21; tablets 0950).
 */
export const LotQualityView = z.strictObject({
  lotCode: z.string(),
  assay: z
    .strictObject({
      basis: z.enum(['AS_IS', 'ANHYDROUS_WATER', 'DRIED_LOD', 'ANHYDROUS_SOLVENT_FREE']),
      assay: z.string(),
      water: z.string().nullable(),
      lod: z.string().nullable(),
      solvents: z.string().nullable(),
      certificateRef: z.string(),
      recordedAt: Instant,
      /** R13: the lot's as-is potency in % from the result's values (exact; null when it cannot be computed). */
      asIs: z.string().nullable().optional(),
      /** R13 (GMP): false while a LIMS result it came from is no longer approved (a dispensing cannot use it). */
      usable: z.boolean().optional(),
      /** R13 (GMP): the approved LIMS results each value was copied from. */
      sources: z.array(z.strictObject({ value: z.enum(['assay', 'water', 'lod', 'solvents']), resultId: Uuid, testCode: z.string(), result: z.string(), unit: z.string(), state: z.string() })).optional(),
    })
    .nullable(),
  artwork: z.string().nullable(),
  /** R13: every assay result of the lot, newest first, with who recorded it, when and why it replaced the one before. */
  history: z
    .array(
      z.strictObject({
        basis: z.string(),
        assay: z.string(),
        water: z.string().nullable(),
        lod: z.string().nullable(),
        solvents: z.string().nullable(),
        asIs: z.string().nullable(),
        certificateRef: z.string(),
        reason: z.string().nullable(),
        by: z.string(),
        recordedAt: Instant,
        current: z.boolean(),
      }),
    )
    .optional(),
});

export const CommandResultView = z.strictObject({
  /** The engine accepted the command (refusals are persisted and returned as a 422 refusal instead). */
  accepted: z.literal(true),
  version: z.number().int().nonnegative(),
  /** The step the command targeted (or `viewStepKey`), as it is now. */
  step: StepScreenView.nullable(),
});

/** A GMP batch planned from an effective MBR version (recipe-core 0501), waiting for the issuer's ISSUED signature. */
export const PlannedBatchView = z.strictObject({
  batchId: Uuid,
  /** From the site's batch-number register (never reused). */
  batchNumber: z.string(),
  familyCode: z.string(),
  product: ProductRef,
  versionNumber: z.string(),
  contentHash: z.string(),
  markets: z.array(z.string()),
  site: z.string(),
  line: z.string(),
  batchSize: z.string(),
  controlRecipeId: Uuid,
  /** What the issue needs (the issuer signs the batch's issue content with ISSUED, then the batch is issued). */
  variants: z.array(z.strictObject({ id: z.string(), name: z.string(), options: z.array(z.string()) })),
  inputs: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      valueType: z.string(),
      unit: z.string().nullable(),
      source: z.string(),
      required: z.boolean(),
      /**
       * R3.1 (D-7k-1): the value the master implies (the tablet count: batch size / target tablet weight), the form's
       * pre-filled value; one further from it than the tolerance is issued only with the issuer's confirmation.
       */
      expected: z.strictObject({ value: z.string(), basis: z.string(), tolerancePercent: z.string() }).optional(),
    }),
  ),
});
export type PlannedBatchView = z.infer<typeof PlannedBatchView>;

const runIdParams = z.strictObject({ runId: Uuid });

/**
 * Phase 7 slice 7g (WP4, decision 0025): the batch data of a G-21 packaging step (tablets 0951, 1201): the current version
 * the database computed (batch number, manufacture date, expiry from the product master; the MRP a person gave where the
 * market's pack shows it), who gave it and the second person who checked an MRP (IN-31), and the print jobs released on
 * it with their state (PR-36; a job released on earlier data is void, L-29).
 */
export const PackagingBatchDataView = z.strictObject({
  batchId: Uuid,
  stepKey: StepKey,
  current: z
    .strictObject({
      version: z.number().int().positive(),
      fields: z.record(z.string(), z.string()),
      reason: z.string().nullable(),
      recordedBy: PersonRef,
      recordedAt: Instant,
      checkedBy: PersonRef.nullable(),
      checkedAt: Instant.nullable(),
    })
    .nullable(),
  jobs: z.array(
    z.strictObject({
      jobId: z.string(),
      device: z.string(),
      layout: z.string(),
      dataVersion: z.number().int().positive(),
      state: z.string(),
      releasedBy: PersonRef,
      releasedAt: Instant,
    }),
  ),
});
export type PackagingBatchDataView = z.infer<typeof PackagingBatchDataView>;

/** The result of a metal-detector or reject-gate challenge (tablets 0872): passed, or the output it held. */
export const DetectorChallengeView = z.strictObject({
  challengeId: Uuid,
  passed: z.boolean(),
  /** The containers of the press held by a failed challenge (labels), as the database answered. */
  held: z.array(z.string()),
});
export type DetectorChallengeView = z.infer<typeof DetectorChallengeView>;

const packagingStep = { batchId: Uuid, stepKey: StepKey };
const LayoutRef = z.string().regex(/^[ -~]{1,64}$/, 'a layout reference of printable characters');

export const execution = {
  testPackages: defineRoute({
    id: 'execution.testPackages',
    method: 'GET',
    path: '/api/test-packages',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'Test packages in the exchange inbox and those already imported',
    response: z.strictObject({ packages: z.array(TestPackageView) }),
  }),
  importPackage: defineRoute({
    id: 'execution.importPackage',
    method: 'POST',
    path: '/api/test-packages/:packageId/import',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Import a package: hashes recomputed, GMP origin required, parse and defineBatch(SANDBOX)',
    params: z.strictObject({ packageId: z.string().min(1) }),
    body: withAttribution({}),
    response: TestPackageView,
  }),
  issueForm: defineRoute({
    id: 'execution.issueForm',
    method: 'GET',
    path: '/api/test-packages/:packageId/issue-form',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'What a test batch of this package needs at issue',
    params: z.strictObject({ packageId: z.string().min(1) }),
    response: IssueFormView,
  }),
  issue: defineRoute({
    id: 'execution.issue',
    method: 'POST',
    path: '/api/test-runs',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Issue a TEST- batch (number allocated by the server; policy, engine version and registry pinned)',
    body: withAttribution({
      packageId: z.string().min(1),
      batchSize: z.string().min(1),
      markets: z.array(z.string()).min(1),
      variants: z.record(z.string(), z.string()),
      inputs: z.record(z.string(), DataValueWire),
    }),
    response: RunView,
  }),
  planBatch: defineRoute({
    id: 'execution.planBatch',
    method: 'POST',
    path: '/api/batches',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Plan a GMP batch from the MBR version effective for its markets and scope: register number, pin and control recipe (issued once signed ISSUED)',
    body: withAttribution({
      familyId: Uuid,
      markets: z.array(z.string().min(1)).min(1),
      site: z.string().min(1),
      line: z.string().min(1),
      batchSize: z.string().min(1),
      /**
       * Phase 7 slice 7g (WP4; PR-47, IN-19): a whole-batch reprocessing batch on a master of record kind REPROCESSING is
       * planned with the quality unit's authorised request (recipe.prepare_reprocessing_issue); the database refuses one
       * without it, and a request not authorised.
       */
      reprocessingRequest: Uuid.optional(),
      /**
       * Phase 7 slice 7i (G2, P7H-4): the ERP production order planned against (the order card the planner used). The
       * database checks it exists, has planned no batch yet and matches the master's product, strength, site and batch
       * size; without it the oldest open order of the family's product and size is taken, as before.
       */
      erpOrder: z.string().min(1).max(64).optional(),
    }),
    response: PlannedBatchView,
  }),
  runs: defineRoute({
    id: 'execution.runs',
    method: 'GET',
    path: '/api/test-runs',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'Test runs',
    response: z.strictObject({ runs: z.array(RunSummaryView) }),
  }),
  run: defineRoute({
    id: 'execution.run',
    method: 'GET',
    path: '/api/test-runs/:runId',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'Run overview: stages, steps, exceptions, holds, timers',
    params: runIdParams,
    response: RunView,
  }),
  step: defineRoute({
    id: 'execution.step',
    method: 'GET',
    path: '/api/test-runs/:runId/steps/:stepKey',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'The step screen of one step instance',
    params: z.strictObject({ runId: Uuid, stepKey: StepKey }),
    response: StepScreenView,
  }),
  workQueue: defineRoute({
    id: 'execution.workQueue',
    method: 'GET',
    path: '/api/work-queue',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: '"What you can do now" for this terminal\'s room',
    response: z.strictObject({ items: z.array(WorkQueueItem) }),
  }),
  timeline: defineRoute({
    id: 'execution.timeline',
    method: 'GET',
    path: '/api/test-runs/:runId/timeline',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'Every engine call of the run (issue, commands, prepares, sweeps), refusals included',
    params: runIdParams,
    response: z.strictObject({ entries: z.array(TimelineEntryView) }),
  }),
  verifyReplay: defineRoute({
    id: 'execution.verifyReplay',
    method: 'POST',
    path: '/api/test-runs/:runId/verify-replay',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'Replay the stored rows and report identical or the first difference',
    params: runIdParams,
    body: Empty,
    response: ReplayReportView,
  }),
  exportRunResult: defineRoute({
    id: 'execution.exportRunResult',
    method: 'POST',
    path: '/api/test-runs/:runId/result-package',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'Write the run\'s test-run result (ebmr.test-run-result v1: coverage, replay, pass or fail, the sandbox stamp, its hash) write-once to the exchange folder to-gmp, for the GMP version\'s SANDBOX_RUN evidence (slice 7h; decision D-P7R-16; DI-05)',
    params: runIdParams,
    body: Empty,
    response: RunResultExportView,
  }),
  // Slice 7j (R4, D-7j-9): the sandbox's test lots on screen, so a master with new materials can be test-run.
  testLots: defineRoute({
    id: 'execution.testLots',
    method: 'GET',
    path: '/api/test-lots',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'The TEST- lots registered in the sandbox (DEMO and test data only)',
    response: z.strictObject({ lots: z.array(LotView) }),
  }),
  registerTestLot: defineRoute({
    id: 'execution.registerTestLot',
    method: 'POST',
    path: '/api/test-lots',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Register a released, identity-tested TEST- lot of a material for sandbox test runs (MASTERDATA.CHANGE; a lot is never changed)',
    body: withAttribution({
      lotCode: z.string().regex(/^TEST-[A-Z0-9-]{1,36}$/),
      materialCode: z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/),
      materialName: z.string().trim().min(1).max(200),
      /** Days from now to the expiry (the sandbox's database time). */
      expiresInDays: z.number().int().min(1).max(3650),
    }),
    response: LotView,
  }),
  // Slice 7o (R4, R8): a lot's assay result for TB-01 and a printed lot's artwork version for G-21 on screen, on both
  // installations (a TEST- lot in the sandbox, MASTERDATA.CHANGE; a site lot on GMP, QC.RESULT_RECORD; the database's rules).
  lotQuality: defineRoute({
    id: 'execution.lotQuality',
    method: 'GET',
    path: '/api/lots/:code/quality',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The current approved assay result and the artwork version of a lot (TB-01, G-21)',
    params: z.strictObject({ code: z.string().min(1).max(64) }),
    response: LotQualityView,
  }),
  recordLotAssay: defineRoute({
    id: 'execution.recordLotAssay',
    method: 'POST',
    path: '/api/lots/:code/assay',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record the approved assay result of a lot that a potency-adjusted dispensing reads (tab.record_lot_assay; a later one supersedes with a reason)',
    params: z.strictObject({ code: z.string().min(1).max(64) }),
    body: withAttribution({
      basis: z.enum(['AS_IS', 'ANHYDROUS_WATER', 'DRIED_LOD', 'ANHYDROUS_SOLVENT_FREE']),
      /** Sandbox: the values typed from the test lot's certificate. GMP: the approved LIMS results named by id (a typed value is refused). */
      assay: DecimalString.optional(),
      water: DecimalString.optional(),
      lod: DecimalString.optional(),
      solvents: DecimalString.optional(),
      assayResultId: Uuid.optional(),
      waterResultId: Uuid.optional(),
      lodResultId: Uuid.optional(),
      solventsResultId: Uuid.optional(),
      certificateRef: z.string().trim().min(1).max(128),
      reason: z.string().trim().min(1).max(2000).optional(),
    }),
    response: LotQualityView,
  }),
  recordLotArtwork: defineRoute({
    id: 'execution.recordLotArtwork',
    method: 'POST',
    path: '/api/lots/:code/artwork',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record the artwork version a printed packaging lot was checked with (tab.record_lot_artwork; once per lot)',
    params: z.strictObject({ code: z.string().min(1).max(64) }),
    body: withAttribution({ artwork: z.string().regex(/^[!-~]{1,64}$/) }),
    response: LotQualityView,
  }),
  lot: defineRoute({
    id: 'execution.lot',
    method: 'GET',
    path: '/api/lots/:code',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'A lot as the server knows it (status, expiry, retest, identity test): a TEST- lot in the sandbox, a material lot of the site in GMP',
    params: z.strictObject({ code: z.string().min(1) }),
    response: LotView,
  }),
  command: defineRoute({
    id: 'execution.command',
    method: 'POST',
    path: '/api/test-runs/:runId/commands',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'One plain client intent (no signature), resolved by the server into an engine command',
    params: runIdParams,
    body: withAttribution({
      expectedVersion: RunVersion,
      intent: ClientIntent,
      /** Step to return in the response when the intent is run-level (hold, deviation link). */
      viewStepKey: StepKey.optional(),
    }),
    response: CommandResultView,
  }),
  plantEntry: defineRoute({
    id: 'execution.plantEntry',
    method: 'POST',
    path: '/api/test-runs/:runId/steps/:stepKey/plant-entries',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'The sandbox family of batches.plantEntry (slice 7o, D-7o-1): a test run\'s plant act and its record in the step as one act',
    params: z.strictObject({ runId: Uuid, stepKey: StepKey }),
    body: withAttribution({ expectedVersion: RunVersion, act: PlantEntryAct }),
    response: CommandResultView,
  }),
  // Phase 7 slice 7g (WP4): the packaging step's batch data, its second-person check and the print job; the detector challenge.
  packagingBatchData: defineRoute({
    id: 'execution.packagingBatchData',
    method: 'GET',
    path: '/api/steps/packaging-batch-data',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The batch data of a packaging step (current version, who gave it, the MRP\'s second-person check) and the print jobs released on it',
    query: z.strictObject(packagingStep),
    response: PackagingBatchDataView,
  }),
  recordPackagingBatchData: defineRoute({
    id: 'execution.recordPackagingBatchData',
    method: 'POST',
    path: '/api/steps/packaging-batch-data',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record the batch data of a packaging step (STEP.EXECUTE): the database computes batch, dates and expiry; the MRP where the pack shows it; a new version only with the person\'s reason, voiding the jobs released on the earlier data',
    body: withAttribution({
      ...packagingStep,
      mrp: z.string().regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/, 'an amount in rupees with at most 2 decimals').optional(),
      reason: z.string().trim().min(1).max(2000).optional(),
    }),
    response: PackagingBatchDataView,
  }),
  checkPackagingBatchData: defineRoute({
    id: 'execution.checkPackagingBatchData',
    method: 'POST',
    path: '/api/steps/packaging-batch-data/check',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'A second person checks the current batch data version with its MRP (STEP.VERIFY; never the person who gave it, IN-31)',
    body: withAttribution({ ...packagingStep, version: z.number().int().positive() }),
    response: PackagingBatchDataView,
  }),
  releasePrintJob: defineRoute({
    id: 'execution.releasePrintJob',
    method: 'POST',
    path: '/api/steps/print-jobs',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Release a print job of a packaging step to a printer of the step (STEP.EXECUTE): only the record\'s batch data, a checked MRP, on the line cleared for the order (PR-36, IN-31)',
    body: withAttribution({ ...packagingStep, device: z.string().trim().min(1).max(64), layout: LayoutRef }),
    response: PackagingBatchDataView,
  }),
  recordDetectorChallenge: defineRoute({
    id: 'execution.recordDetectorChallenge',
    method: 'POST',
    path: '/api/detector-challenges',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record a metal-detector or reject-gate challenge of a press in use by the batch with certified test pieces of the register (STEP.EXECUTE; a failure holds the press output, IN-36)',
    body: withAttribution({
      batchId: Uuid,
      press: z.string().trim().min(1).max(64),
      device: z.enum(['METAL_DETECTOR', 'REJECT_GATE']),
      deviceCode: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'the detector\'s code: capitals, digits, _ and -'),
      timing: z.enum(['START', 'INTERVAL', 'AFTER_STOPPAGE', 'END']),
      pieces: z.array(z.strictObject({ piece: z.string().trim().min(1).max(64), detected: z.boolean(), rejected: z.boolean() })).min(1).max(20),
    }),
    response: DetectorChallengeView,
  }),
} as const;
