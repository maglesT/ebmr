/**
 * MBR content model (ADR 0004; outline 6.1, 6.2, 6.3, 5.2.3, 5.2.4).
 *
 * The persisted master batch record is immutable, hashed JSON: an ISA-88 tree
 * procedure -> stage -> operation -> phase, where a phase is one configured block instance, arranged
 * only with block-structured constructs (sequence, all-join parallel, alternative, bounded
 * repeat-until loop, hold point, library call, replicate-per-sub-lot). There are no free edges.
 * Time constraints, the BOM, parameters and limits, calculations, yields, intermediates with hold
 * times, risk-based reductions and references are separate lists that the flow refers to by id.
 *
 * JSON rules (checked by `parseMbr`):
 * - GMP values (quantities, limits, durations, targets) are decimal-literal STRINGS, never numbers.
 * - Counts (iterations, instances, units sampled, decimals of precision) are JSON integers.
 * - Unknown fields are refused, so nothing unhashed or unvalidated can hide in the content.
 */
import type { AcceptanceScheme, LimitSource, LimitSpec, PharmacopoeiaEdition } from '../limits/model.ts';

export const MBR_FORMAT = 'ebmr.mbr-content';
export const MBR_FORMAT_VERSION = 1;

/** A GMP quantity: decimal literal plus UCUM unit. */
export interface Quantity {
  value: string;
  unit: string;
}

/**
 * The editions (API edition plan A0): the same list as the kernel's `EDITIONS` and the database's kernel.editions()
 * (this pure code may not import the kernel; a test ties the three together).
 */
export const EDITIONS = ['tablets', 'injectables', 'substance'] as const;
export type Edition = (typeof EDITIONS)[number];
/** REPROCESSING: a whole-batch reprocessing master (outline 5.2.9 case 1; D-S5-6), issued as a processing batch linked to its parents. */
export type RecordKind = 'PROCESSING' | 'PACKAGING' | 'REPROCESSING';

export interface MbrHeader {
  /** MBR family code (product x strength x batch size x line). Versions live in the MBR life cycle, not here. */
  family: string;
  title: string;
  edition: Edition;
  recordKind: RecordKind;
  product: { code: string; name: string; strength: string; dosageForm: string };
  /** Discrete approved batch sizes (PR-01): no free scaling. */
  batchSizes: { id: string; quantity: Quantity }[];
  /** India ('IN') is always present (INV-28); US and EU are added per product. */
  marketSet: string[];
  /** Predicate attributes the market engine needs (licence form, route, ...). */
  predicates: Record<string, string | boolean>;
  /** Issue-time variants: each has a closed domain; alternatives in ISSUE_VARIANT mode partition it. */
  variants: { id: string; values: string[] }[];
  /**
   * A packaging master's pack type (D-P4-13): an upper-case code such as ALU-PVC-BLISTER; with the product and the pack
   * size it is the packaging family's identity. Absent reads STANDARD; a processing master names none.
   */
  packType?: string;
  /**
   * The theoretical mass of one unit (mg) the batch sizes are computed from: a master started from an approved formula
   * records it (decision 0026 S11b), so the tablet count of each batch size is its mass divided by this, exactly (R3.1).
   */
  unitMassMg?: string;
}

/** A controlled, versioned risk scale (IN-02). */
export interface RiskScale {
  /** Reference id (in `references`) of the approved scale document. */
  ref: string;
  /** Classes, lowest risk first. */
  classes: string[];
}

export const REFERENCE_KINDS = [
  'SOP',
  'LIBRARY_ELEMENT',
  'MATERIAL',
  'EQUIPMENT_CLASS',
  'RULE_SET',
  'RISK_SCALE',
  'RISK_ASSESSMENT',
  'VALIDATION_REPORT',
  'HOLD_STUDY',
  'REGISTRATION',
  'PHARMACOPOEIA',
  'SPECIMEN',
  'TEMPLATE',
  'CCS',
  'DOCUMENT',
  'COMPUTERISED_SYSTEM',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** Every external thing the MBR relies on, pinned by version and (where it has content) hash (outline 6.5). */
export interface Reference {
  id: string;
  kind: ReferenceKind;
  code: string;
  version: string;
  /** SHA-256 hex of the referenced content, where the referenced item has hashable content. */
  hash?: string;
  title?: string;
}

/** Values available from the start of the batch: header and master-data constants. */
export interface ExternalInput {
  id: string;
  name: string;
  source: 'BATCH_HEADER' | 'MASTER_DATA';
  valueType: ValueKind;
  unit?: string;
  categories?: string[];
  /** Reference id for master data. */
  ref?: string;
}

export type BomRole = 'ACTIVE' | 'EXCIPIENT' | 'PROCESSING_AID' | 'PRIMARY_PACKAGING' | 'PRINTED_COMPONENT' | 'OTHER';

export interface BomLine {
  id: string;
  /** Reference id of the material version. */
  material: string;
  role: BomRole;
  /** Standard quantity for the reference batch size. */
  quantity: Quantity;
  /** Approved specimen reference; mandatory for printed components (PR-03, IN-14). */
  specimen?: string;
  /**
   * The deliberate excess over the label claim the standard quantity includes, as the approved formula states it (slice
   * 7q, C1; recipe-core 1740 checks it against the formula line): a percent or a quantity (mg per unit, or kg per batch
   * for a processing aid), with its reason. Shown on the master's bill of materials; the quantity already includes it.
   */
  overage?: BomOverage;
}

export interface BomOverage {
  reason: string;
  percent?: string;
  quantity?: Quantity;
}

export interface Intermediate {
  id: string;
  name: string;
  /** Maximum hold from the end of the producing step to the start of each consuming step (IN-13, INV-34). */
  holdTime?: { max: Quantity; source: LimitSource; storage?: string };
  /** True when the intermediate leaves the procedure (bulk to packaging): no consuming step inside the MBR. */
  finalOutput?: boolean;
}

export type ValueKind = 'DECIMAL' | 'COUNT' | 'BOOLEAN' | 'CATEGORY' | 'TEXT' | 'INSTANT';

/**
 * What a parameter is for. A loop may exit only on a PROCESS_ENDPOINT (ADR 0004); ACCEPTANCE_TEST and
 * RELEASE_TEST results follow the OOS path and can never drive a loop.
 */
export type ParameterRole = 'PROCESS_PARAMETER' | 'IPC' | 'PROCESS_ENDPOINT' | 'ACCEPTANCE_TEST' | 'RELEASE_TEST' | 'QUANTITY' | 'OBSERVATION';

/** How the value is captured; anything but MANUAL (or MANUAL with a photo/printout) is objective evidence. */
export type CaptureMode = 'MANUAL' | 'DEVICE' | 'AUTOMATION' | 'SCAN' | 'LIMS';

export interface Parameter {
  /** Identifier usable in expressions. */
  id: string;
  name: string;
  valueType: ValueKind;
  unit?: string;
  /** Semantic tag for % units (% w/w, % LOD, % yield ...); checked by the expression language. */
  semanticTag?: string;
  precision?: { kind: 'DECIMALS' | 'SIGNIFICANT_FIGURES'; digits: number };
  categories?: string[];
  /** Readings per capture (e.g. 20 tablet weights); more than 1 makes the value a series of that length. */
  readings?: number;
  role: ParameterRole;
  /** CRITICAL until classified (DI-07); NON_CRITICAL is a risk-based reduction (IN-02). */
  criticality: 'CRITICAL' | 'NON_CRITICAL';
  /** Risk class from the MBR's risk scale (IN-02). */
  riskClass: string;
  capture: CaptureMode;
  /** Photo or printout attached to a manual entry counts as objective evidence (outline 5.5). */
  evidence?: 'NONE' | 'PHOTO' | 'PRINTOUT';
  /** Accuracy check for critical manual entries (DI-30). */
  accuracyCheck?: 'SECOND_PERSON' | 'VALIDATED_DEVICE';
  target?: string;
  limits?: LimitSpec;
  /** Market rule key whose resolved value this limit must not be looser than (outline 3.3.5). */
  marketRule?: { key: string; bound: 'LOW' | 'HIGH' };
}

export interface Calculation {
  id: string;
  name: string;
  /** Expression in the expression language (@ebmr/expr), reading declared inputs by id. */
  expression: string;
  output: { valueType: 'DECIMAL' | 'COUNT' | 'BOOLEAN'; unit?: string; semanticTag?: string };
  criticality: 'CRITICAL' | 'NON_CRITICAL';
  riskClass: string;
  limits?: LimitSpec;
}

export interface YieldCheckpoint {
  id: string;
  name: string;
  kind: 'YIELD' | 'RECONCILIATION';
  /** Value (calculation, parameter or input) giving the theoretical quantity: the basis. */
  theoretical: string;
  /** Calculation giving the yield or reconciliation percentage. */
  result: string;
  basis: 'AS_IS' | 'DRY' | 'COUNT';
  /** Minimum and maximum (PR-31, PR-39, INV-34). */
  limits?: LimitSpec;
}

export type EventKind = 'START' | 'END';

/** A step event: the start or end of a phase, operation, stage, hold point, loop or replicate section. */
export interface NodeEvent {
  node: string;
  event: EventKind;
}

/** An event outside this record (equipment cleaning end, previous batch end): not part of the network check. */
export interface ExternalEvent {
  external: string;
  description: string;
}

export type EventRef = NodeEvent | ExternalEvent;

export type TimeConstraintKind = 'TIMER' | 'HOLD' | 'PROCESS_WINDOW' | 'USE_BY' | 'EXPOSURE';

export interface TimeConstraint {
  id: string;
  name: string;
  kind: TimeConstraintKind;
  from: EventRef;
  to: EventRef;
  min?: Quantity;
  max?: Quantity;
  /** Warn this long before the maximum is reached. */
  warnBefore?: Quantity;
  /** Validation or hold-study reference (ST-37, INV-34). */
  source?: LimitSource;
  /** Beyond the maximum: always an exception; BLOCK also stops the step and everything downstream. */
  breach: 'EXCEPTION' | 'EXCEPTION_AND_BLOCK';
  pauses: 'INCLUDED' | 'EXCLUDED';
  marketRule?: { key: string; bound: 'LOW' | 'HIGH' };
}

export const REDUCTION_KINDS = [
  /** S5a: one human verifier for a validated automated operation. */
  'ONE_VERIFIER',
  /** S24: no second person on a line clearance. */
  'NO_SECOND_PERSON_CLEARANCE',
  /** A step or parameter classified non-critical / minor. */
  'MINOR_CLASSIFICATION',
  /** IPC or sampling frequency below the default. */
  'REDUCED_IPC_FREQUENCY',
  /** Review by exception for steps under continuous monitoring. */
  'REVIEW_BY_EXCEPTION',
] as const;
// There is deliberately no reduction that lifts the checker of a significant step: performer-is-not-
// verifier on significant steps is locked (outline 7.2, S5); only S5a (ONE_VERIFIER) and S24 are switches.
export type ReductionKind = (typeof REDUCTION_KINDS)[number];

/** A risk-based reduction of a control (IN-02): risk class from the scale plus a linked rationale. */
export interface RiskReduction {
  id: string;
  kind: ReductionKind;
  /** Node ids or parameter/calculation ids the reduction applies to. */
  subjects: string[];
  riskClass?: string;
  /** Reference id of the risk assessment with the written rationale. */
  rationale?: string;
  /**
   * REVIEW_BY_EXCEPTION only (PR-52): the validation that shows the step's exceptions are reliably flagged; one of the
   * validations of the version's change record (recipe-core 1050 refuses SUBMIT otherwise).
   */
  validationRef?: string;
}

/** Author-confirmed golden inputs and expected results for calculations (outline 6.4, 6.5; DI-04). */
export interface GoldenCase {
  id: string;
  description: string;
  inputs: Record<string, GoldenValue>;
  expected: Record<string, GoldenValue>;
}

export type GoldenValue = { value: string; unit?: string } | { bool: boolean } | { category: string } | { series: string[]; unit?: string };

// ---------------------------------------------------------------------------------------------
// The flow tree

export interface StageEquipment {
  /** Local reference used by phases of this stage. */
  ref: string;
  /** Reference id of the equipment class version. */
  equipmentClass: string;
  /** PROCESS equipment is occupied exclusively; INSTRUMENT and UTILITY are not (outline 5.2.8). */
  kind: 'PROCESS' | 'INSTRUMENT' | 'UTILITY';
}

export interface StageNode {
  kind: 'stage';
  id: string;
  name: string;
  /** Room, line or equipment train the stage is bound to (ISA-88 unit procedure). */
  binding: { rooms: string[]; line?: string; equipment: StageEquipment[] };
  /** MATERIAL stages transform material (clearance first, yield last); NON_MATERIAL stages consume and produce nothing. */
  purpose: 'MATERIAL' | 'NON_MATERIAL';
  /** Role of the person responsible for the stage (IN-15). */
  responsibleRole: string;
  /**
   * A material stage with no yield of its own, with the author's reason (R-flow item 4): 21 CFR 211.103 asks for the
   * yield at the end of each appropriate phase, and the master says which phases are appropriate. The reason is approved
   * with the master; no further signature.
   */
  noYieldReason?: string;
  /**
   * The id of an earlier stage in the same room or on the same line whose clearance this stage continues (R-rest A6):
   * the batch stays in the cleared area, so the stage needs no clearance step of its own.
   */
  clearanceFrom?: string;
  body: FlowNode;
}

export interface OperationNode {
  kind: 'operation';
  id: string;
  name: string;
  body: FlowNode;
}

export type CheckMeaning = 'VERIFIED' | 'WITNESSED';

export interface PhaseSignatures {
  /** Role signing PERFORMED; absent only for automated phases whose one human checks (S5a). */
  perform?: { role: string };
  /** Second person: VERIFIED (review of recorded evidence) or WITNESSED (watched the act). */
  check?: { meaning: CheckMeaning; role: string };
}

/** Computerised system a phase relies on (DI-04). */
export interface ComputerisedSystem {
  kind: 'PLC' | 'SCADA' | 'WEIGHING' | 'CHECKWEIGHER' | 'VISION' | 'SERIALISATION' | 'STERILISER_CONTROLLER' | 'LYO_CONTROLLER' | 'FILTER_TESTER' | 'OTHER';
  /** Reference id of the system (validated configuration item). */
  ref: string;
  recipe?: string;
  recipeVersion?: string;
}

/** Process analytical technology step (DI-04): method, model version and acceptance criteria. */
export interface PatDefinition {
  method: string;
  model: string;
  modelVersion: string;
  /** Boolean expression over recorded values. */
  acceptance?: string;
}

/** The four cases of outline 5.2.9 (PR-47, IN-19). */
export type ReprocessingCase = 'WHOLE_BATCH_REPROCESSING' | 'REPROCESSING_ADDITION' | 'RECOVERY' | 'VALIDATED_RETREATMENT';

export interface PhaseNode {
  kind: 'phase';
  id: string;
  name: string;
  block: { type: string; version: string };
  /** Block configuration; validated by the block version's own schema (block contract, outline 6.6). */
  config: Record<string, JsonValue>;
  /** Parameters captured here (written). */
  records: string[];
  /** Calculations computed here, in order (written; their inputs are read). */
  computes: string[];
  /** Other values read here (targets shown, values checked). */
  reads: string[];
  /** BOM lines consumed here. */
  consumes: string[];
  /** Intermediates produced here (hold time starts at the end of this phase). */
  produces: string[];
  /** Intermediates used here (hold time ends at the start of this phase). */
  uses: string[];
  /** Stage equipment this phase checks or uses. */
  equipment: { ref: string; use: 'STATUS_CHECK' | 'USE' }[];
  yieldCheckpoint?: string;
  acceptanceScheme?: string;
  /** Sampling plan of an IPC phase (units per point and purpose). */
  sampling?: { point: string; purpose: string; units: number; destructive: boolean }[];
  signatures: PhaseSignatures;
  /** Significant step (PR-14): performer plus checker unless a declared risk-based reduction applies. */
  significant: boolean;
  riskClass: string;
  system?: ComputerisedSystem;
  pat?: PatDefinition;
  reprocessing?: { case: ReprocessingCase; maxPercent?: string; maxAge?: Quantity; maxSourceBatches?: number };
}

export interface SequenceNode {
  kind: 'sequence';
  id: string;
  children: FlowNode[];
}

export interface ParallelNode {
  kind: 'parallel';
  id: string;
  /** All branches start together; the join waits for every branch (no OR-join). */
  branches: { id: string; name: string; body: FlowNode }[];
}

export type Decision =
  /** Decided by recorded data: each branch has a guard; optionally one `otherwise` branch. */
  | { mode: 'DATA' }
  /** An authorised operator chooses, with a reason. */
  | { mode: 'OPERATOR_CHOICE'; roles: string[]; reasonRequired: true }
  /** Fixed at issue from a declared variant (header.variants). */
  | { mode: 'ISSUE_VARIANT'; variant: string };

export interface AlternativeBranch {
  id: string;
  name: string;
  /** DATA mode: boolean expression (exactly one branch may instead be `otherwise`). */
  guard?: string;
  otherwise?: boolean;
  /** ISSUE_VARIANT mode: variant values selecting this branch. */
  variantValues?: string[];
  /** Absent: an empty branch (the "no action" option); untaken branches become NOT_APPLICABLE. */
  body?: FlowNode;
}

export interface AlternativeNode {
  kind: 'alternative';
  id: string;
  decision: Decision;
  branches: AlternativeBranch[];
}

/** Repeat-until loop on a process endpoint (ADR 0004): bounded, every iteration kept, exception when exhausted. */
export interface LoopNode {
  kind: 'loop';
  id: string;
  name: string;
  body: FlowNode;
  /** Mandatory maximum iterations (a count, 1..100). */
  maxIterations: number;
  maxDuration?: Quantity;
  exit: {
    /** Boolean expression; true ends the loop. */
    condition: string;
    /** The process-endpoint parameter the condition reads; it must be written inside the body. */
    endpoint: string;
  };
}

export type ReplicateCount =
  /** Count from an MBR expression (e.g. batch size / working capacity), within min..max. */
  | { mode: 'EXPRESSION'; expression: string; min: number; max: number }
  /** Chosen at run time within min..max, with a reason. */
  | { mode: 'RUNTIME'; min: number; max: number; reasonRequired: true };

/** Replicate per sub-lot (ADR 0004; L-26): each instance gets a sub-lot id with its own data, timers, yields and sampling. */
export interface ReplicateNode {
  kind: 'replicate';
  id: string;
  name: string;
  body: FlowNode;
  count: ReplicateCount;
  /** CONCURRENT instances may overlap in time; SEQUENTIAL instances run one after the other. */
  instances: 'SEQUENTIAL' | 'CONCURRENT';
  subLotPrefix: string;
}

/** QA hold point: everything downstream is locked until the authorised signature (G-17). */
export interface HoldPointNode {
  kind: 'holdPoint';
  id: string;
  name: string;
  role: string;
  dispositions: string[];
}

/** Call of a pinned library element version; symbols used by the element are bound to MBR items. */
export interface LibraryCallNode {
  kind: 'libraryCall';
  id: string;
  /** Reference id (kind LIBRARY_ELEMENT) pinning element version and hash. */
  element: string;
  bind: Record<string, string>;
}

export type FlowNode = StageNode | OperationNode | PhaseNode | SequenceNode | ParallelNode | AlternativeNode | LoopNode | ReplicateNode | HoldPointNode | LibraryCallNode;
export type FlowNodeKind = FlowNode['kind'];

/** Level of the ISA-88 tree a construct sits at. */
export type Level = 'PROCEDURE' | 'STAGE' | 'OPERATION';

/** A reusable, separately approved flow fragment, embedded here as a pinned snapshot. */
export interface LibraryElement {
  /** Reference id this snapshot belongs to. */
  ref: string;
  /** Level the element's body sits at: STAGE (its body is operations) or OPERATION (phases). */
  level: 'STAGE' | 'OPERATION';
  /** Symbols (data items, equipment refs, BOM lines, intermediates) the caller must bind. */
  symbols: string[];
  body: FlowNode;
}

export interface Procedure {
  id: string;
  name: string;
  body: FlowNode;
}

export interface MbrContent {
  format: typeof MBR_FORMAT;
  formatVersion: typeof MBR_FORMAT_VERSION;
  header: MbrHeader;
  riskScale: RiskScale;
  references: Reference[];
  library: LibraryElement[];
  inputs: ExternalInput[];
  bom: BomLine[];
  intermediates: Intermediate[];
  parameters: Parameter[];
  calculations: Calculation[];
  yieldCheckpoints: YieldCheckpoint[];
  acceptanceSchemes: AcceptanceScheme[];
  timeConstraints: TimeConstraint[];
  riskReductions: RiskReduction[];
  goldenCases: GoldenCase[];
  procedure: Procedure;
  /**
   * Decision 0026 (S4): snapshots of the library block definitions the master uses, one per code@version its phases
   * name (recipe-core library BlockDefinition; checked by library/snapshotProblems). Absent when the master uses no
   * library block, so the content and its hash stay as they were for every earlier master.
   */
  blockDefinitions?: { [key: string]: JsonValue }[];
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type { LimitSource, LimitSpec, PharmacopoeiaEdition };

export function isNodeEvent(e: EventRef): e is NodeEvent {
  return 'node' in e;
}

/** Children of a node in document order (alternative branches without a body contribute nothing). */
export function childrenOf(node: FlowNode): FlowNode[] {
  switch (node.kind) {
    case 'stage':
    case 'operation':
    case 'loop':
    case 'replicate':
      return [node.body];
    case 'sequence':
      return node.children;
    case 'parallel':
      return node.branches.map((b) => b.body);
    case 'alternative':
      return node.branches.flatMap((b) => (b.body ? [b.body] : []));
    case 'phase':
    case 'holdPoint':
    case 'libraryCall':
      return [];
  }
}

/** Pre-order walk of a flow tree. */
export function walk(node: FlowNode, visit: (node: FlowNode, ancestors: readonly FlowNode[]) => void, ancestors: FlowNode[] = []): void {
  visit(node, ancestors);
  ancestors.push(node);
  for (const child of childrenOf(node)) walk(child, visit, ancestors);
  ancestors.pop();
}
