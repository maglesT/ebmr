/**
 * The block contract (outline 6.6 "Block contract", L-61; ADR 0010 decisions 1, 3, 4; ADR 0011).
 *
 * A block type is vendor code, versioned as `type@version`. Each version carries configuration and
 * data schemas, an execution handler, its exception rules mapped to the review-by-exception taxonomy,
 * a simulator model (so the simulator and the engine agree), a golden fixture, tests, and the
 * rendering parts (shop-floor UI, review renderer, true-copy renderer, paper rendering, translations)
 * that arrive with the UI work. The registry reports which parts a version still lacks; CI will
 * refuse an incomplete version once the UI phase lands. Customers cannot create primitive types.
 *
 * Handlers never mutate engine state: they read a `HandlerView` and return effects (normalised
 * entries, computed items, containers, exceptions, notifications); the engine applies them.
 */
import type { Frame } from '../flow/tokens.ts';
import type { ExpressionService } from '../flow/expression-port.ts';
import type { JsonValue, MbrContent, Parameter, PhaseNode } from '../flow/model.ts';
import type {
  Actor,
  ContainerRecord,
  DataPoint,
  DataValue,
  EntryRecord,
  ExceptionSeverity,
  ReviewCategory,
} from '../engine/types.ts';
import type { FieldSchema, ObjectSchema } from './schema.ts';

/** Where a block acts: as a flow phase, or as part of the batch, a stage, a construct or a service. */
export type BlockLevel = 'PHASE' | 'BATCH' | 'STAGE' | 'HOLD_POINT' | 'CONSTRUCT' | 'SERVICE';

/** Contract parts every block version must have (outline 6.6). */
export const CONTRACT_PARTS = [
  'configSchema',
  'dataSchema',
  'handler',
  'exceptionRules',
  'simulatorModel',
  'goldenFixture',
  'tests',
  'shopFloorUi',
  'reviewRenderer',
  'trueCopyRenderer',
  'paperRendering',
  'translations',
] as const;
export type ContractPart = (typeof CONTRACT_PARTS)[number];

/** Parts delivered with the UI work (Phase 2 screens and Phase 4 renderers); reported, not yet required. */
export const RENDERING_PARTS: readonly ContractPart[] = ['shopFloorUi', 'reviewRenderer', 'trueCopyRenderer', 'paperRendering', 'translations'];

export interface HandlerProblem {
  /** Stable code, e.g. "G07-LOT-STATUS". */
  code: string;
  /** Plain language first, then rule and controls in brackets. */
  message: string;
  controls: string[];
}

/** An exception a handler raises; the engine turns it into an exception record (outline 5.2.4). */
export interface ExceptionDraft {
  type: string;
  title: string;
  controls: string[];
  severity: ExceptionSeverity;
  category: ReviewCategory;
  item?: string;
  /** What it blocks: nothing (register item), this step, the steps after it, or both. */
  blocks: 'NONE' | 'STEP' | 'DOWNSTREAM' | 'STEP_AND_DOWNSTREAM';
  until?: 'DEVIATION' | 'DISPOSITION';
  deviationRequired?: boolean;
  qaOnly?: boolean;
  registrationRelevant?: boolean;
  releaseBlocking?: boolean;
}

export interface Notification {
  roles: string[];
  message: string;
}

/** An exception type a block can raise, mapped to the review-by-exception taxonomy (DI-26). */
export interface ExceptionRule {
  type: string;
  category: ReviewCategory;
  severity: ExceptionSeverity;
  summary: string;
  controls: string[];
}

/** Read-only view of one step instance that the engine gives a handler. */
export interface HandlerView {
  readonly phase: PhaseNode;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly stepKey: string;
  readonly frames: readonly Frame[];
  readonly nowUs: bigint;
  readonly actor: Actor;
  readonly batch: { readonly batchId: string; readonly batchNumber: string; readonly productCode: string; readonly marketSet: readonly string[] };
  readonly mbr: MbrContent;
  readonly expr: ExpressionService;
  /** Entries recorded in this step instance (optionally of one kind), in order. */
  entries(kind?: string): readonly EntryRecord[];
  /** Every data point of an item in this step instance (all attempts and versions). */
  points(item: string): readonly DataPoint[];
  /** The effective value of an item as seen from this step (INV-41: first valid attempt governs). */
  effective(item: string): DataValue | undefined;
  /** Target values the phase reads, snapshotted when the step started. */
  target(item: string): DataValue | undefined;
  /** Containers registered in the batch. */
  containers(): readonly ContainerRecord[];
  parameter(id: string): Parameter | undefined;
}

export type EntryResult =
  | {
      ok: true;
      /** The normalised entry as stored (block-derived fields such as net weight included). */
      data: Record<string, unknown>;
      registerContainers?: { id: string; holds: string; holdsKind: 'INTERMEDIATE' | 'BOM_LINE'; net?: { value: string; unit: string } }[];
      consumeContainers?: string[];
      exceptions?: ExceptionDraft[];
      notifications?: Notification[];
    }
  | { ok: false; problems: HandlerProblem[] };

export interface ValueEffects {
  /** The value is a failing result for INV-41 (e.g. an unexpected answer). */
  failed?: boolean;
  exceptions?: ExceptionDraft[];
  notifications?: Notification[];
  /** Two-person verification becomes mandatory for this step (DI-30). */
  verificationRequired?: boolean;
}

export interface ComputedItem {
  item: string;
  value: DataValue;
  /** Entry ids the value was computed from (its provenance). */
  entries: string[];
}

/** The execution handler of a PHASE-level block version. Every function is optional and pure. */
export interface PhaseHandler {
  /** Parameters the block computes from its entries; the engine refuses typing them (INV-25). */
  computedItems?(phase: PhaseNode, mbr: MbrContent): string[];
  /** Extra start guard (e.g. G-24 QCU authorisation); `blockData` comes with START_STEP. */
  beforeStart?(view: HandlerView, blockData: Readonly<Record<string, unknown>> | undefined): HandlerProblem[];
  /** Validates and normalises one block entry (already checked against the data schema). */
  acceptEntry?(view: HandlerView, entry: Readonly<Record<string, unknown>> & { readonly kind: string }): EntryResult;
  /** Block rules on a recorded parameter value (expected answers, excursions, categorical IPC results). */
  onValue?(view: HandlerView, item: string, value: DataValue, point: DataPoint): ValueEffects;
  /** Items computed from entries at the PERFORMED transition (e.g. container totals). */
  computeItems?(view: HandlerView): ComputedItem[];
  /** Evaluations at the PERFORMED transition that raise exceptions (tolerance, sampling shortfall). */
  onPerform?(view: HandlerView): { exceptions?: ExceptionDraft[]; notifications?: Notification[] };
  /** Refusals at the PERFORMED transition (e.g. acknowledgement missing, containers not charged). */
  beforePerform?(view: HandlerView): HandlerProblem[];
  /** Signature meanings accepted for PERFORMED and for the check, besides the generic ones. */
  meanings?: { perform?: readonly string[]; check?: readonly string[] };
  /** The item that holds the executed quantity for target comparisons (dispensing, charge-in). */
  executedQuantityItem?(phase: PhaseNode, mbr: MbrContent): string | undefined;
  /** Tolerance of an executed target (outline 5.2.3 executed targets). */
  targetTolerance?(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>): { percent: string } | { absolute: { value: string; unit: string } } | undefined;
}

/** A definition-time problem with a phase's configuration (errors block; warnings need a justification). */
export interface ConfigProblem {
  code: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
  controls: string[];
}

/** What the simulator (and the engine test driver) needs to run a phase nominally. */
export interface SimulatorModel {
  /** Exception types this block can raise for a phase. */
  exceptionTypes(phase: PhaseNode): string[];
  /**
   * Block entries a nominal execution records, given the containers available in the batch. The
   * engine and the simulator run the same model, so a nominal path in one is a nominal path in the other.
   */
  nominalEntries(input: { phase: PhaseNode; config: Readonly<Record<string, JsonValue>>; mbr: MbrContent; containers: readonly ContainerRecord[]; target: (item: string) => DataValue | undefined }): (Record<string, unknown> & { kind: string })[];
}

/** A golden fixture: a phase of this block, a scripted execution and what must come out. */
export interface BlockGoldenFixture {
  description: string;
  /** The phase under test (the harness wraps it in a minimal MBR). */
  phase: Partial<PhaseNode> & Pick<PhaseNode, 'block' | 'config'>;
  parameters?: MbrContent['parameters'];
  calculations?: MbrContent['calculations'];
  intermediates?: MbrContent['intermediates'];
  bom?: MbrContent['bom'];
  yieldCheckpoints?: MbrContent['yieldCheckpoints'];
  /** Values of external inputs the calculations need. */
  inputs?: { id: string; valueType: 'DECIMAL' | 'COUNT'; unit?: string; value: string }[];
  /** Containers registered before the step (e.g. a kit for a charge-in). */
  containers?: { id: string; holds: string; holdsKind: 'INTERMEDIATE' | 'BOM_LINE' }[];
  script: ({ record: string; value: DataValue } | { entry: Record<string, unknown> & { kind: string } } | { advanceUs: bigint } | { startData: Record<string, unknown> })[];
  expect: {
    /** Exception types raised, sorted. */
    exceptions: string[];
    /** Items and calculations with their expected values (decimal text as written). */
    values?: Record<string, string>;
    /** The step reaches this status after the nominal perform and verify. */
    status: 'COMPLETED' | 'IN_PROGRESS' | 'AWAITING_VERIFICATION';
    /** When the perform is refused, the refusal code. */
    performRefusal?: string;
  };
}

/** A pointer to a rendering implementation (arrives with the UI and renderer work). */
export interface RendererSlot {
  module: string;
  version: string;
}

export interface BlockVersion {
  /** Canonical type id: G-xx (generic), TB-xx, IB-xx. */
  type: string;
  version: string;
  title: string;
  edition: 'generic' | 'tablets' | 'injectables';
  aliases: { tablets?: string; injectables?: string };
  level: BlockLevel;
  controls: string[];
  configSchema?: ObjectSchema;
  /** Block entry kinds and their schemas. PHASE blocks without entries declare an empty map. */
  dataSchema?: { entries: Readonly<Record<string, ObjectSchema>>; startData?: ObjectSchema };
  /** Cross-field configuration checks (beyond the schema). */
  checkConfig?(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[];
  handler?: PhaseHandler;
  /** For non-PHASE blocks: the engine functions that implement the block's execution. */
  engineImplementation?: string[];
  exceptionRules?: ExceptionRule[];
  simulatorModel?: SimulatorModel;
  goldenFixture?: BlockGoldenFixture;
  /** Test names that prove the block version. */
  tests?: string[];
  rendering?: {
    shopFloorUi?: RendererSlot;
    reviewRenderer?: RendererSlot;
    trueCopyRenderer?: RendererSlot;
    paperRendering?: RendererSlot;
    translations?: string[];
  };
  /** Configuration migrators from earlier versions (none for a first version). */
  configMigrators?: { from: string; migrate(config: Record<string, JsonValue>): Record<string, JsonValue> }[];
}

export type { FieldSchema, ObjectSchema };
