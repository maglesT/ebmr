/**
 * The output fingerprint of the engine (ADR 0010; DI-10, DI-34, INV-19): one fixed run, stored row by row as the
 * execution store stores it (ISSUE, COMMAND, PREPARE, SWEEP at their trusted clocks), and the hash of what the engine
 * answers to each row: accepted or the refusal's rule code, the events hash and the state hash (the state's own
 * `engineVersion` stamp left out, so the fingerprint is the engine's behaviour and not its label). Replay compares
 * exactly these hashes, so two engines with different fingerprints replay a stored batch differently: a batch stored
 * by one would look tampered with under the other.
 *
 * The run touches what changed between released versions: time facts noticed inside a person's command and signing
 * preparation, a clock regression, the meaning of a verification (a witness or a generic VERIFIED where the step
 * requires its own check) and of a PERFORMED signature on a block with its own perform meaning, (since 1.2.0) the
 * resolution of a computed net weight (an output container weighed at 0.001 kg whose net ends in zeros), (since
 * 1.3.0) the total of containers weighed in another unit (one in g, one in a unit the total cannot be counted in),
 * (since 1.4.0) the check of a step holding a critical value typed by hand without the printout its MBR names (a later
 * review, then a witness) and (since 1.5.0) the check of such a step once its witness window has passed, and of a step
 * the MBR declares WITNESSED once the run moved on (a witness, then a later review that raises WITNESS_LATE for QA), and
 * (since 1.6.0) the hand-over of a step in progress and its take-over (L-07), an invalidation without the assignable
 * cause its investigation concluded, and an abort without its checklist confirmed.
 *
 * This module depends on `src` only (no test helper), with the MBR written out in full, so the fingerprint moves only
 * when the engine, its blocks or the expression language answer differently. It is also run against earlier commits
 * to record their fingerprints (test/engine/engine-version.test.ts).
 */
import { genericBlockRegistry } from '../../src/blocks/generic/index.ts';
import { eventsHash, hashJson, stateHash } from '../../src/engine/codec.ts';
import { defineBatch, type BatchDefinition } from '../../src/engine/definition.ts';
import { issue, prepareForSignature, step, sweep } from '../../src/engine/engine.ts';
import type { Actor, BatchState, Command, EngineEvent } from '../../src/engine/types.ts';
import { createExprService } from '../../src/flow/expr-adapter.ts';
import type { MbrContent, PhaseNode } from '../../src/flow/model.ts';

const MIN = 60_000_000n;
/** 2026-09-28T08:00:00Z in epoch microseconds. */
const T0 = 1_790_582_400_000_000n;

const person = (id: string, roles: string[]): Actor => ({ id, kind: 'PERSON', roles });
const OP1 = person('OP1', ['PRODUCTION_OPERATOR', 'OPERATOR']);
const OP2 = person('OP2', ['PRODUCTION_OPERATOR', 'OPERATOR']);
const VER1 = person('VER1', ['PRODUCTION_VERIFIER', 'VERIFIER']);
const VER2 = person('VER2', ['PRODUCTION_VERIFIER', 'VERIFIER']);
const SUP1 = person('SUP1', ['PRODUCTION_SUPERVISOR']);
const QA1 = person('QA1', ['QA']);
const HEAD1 = person('HEAD1', ['HEAD_OF_PRODUCTION']);

function phaseNode(id: string, extra: Partial<PhaseNode> = {}): PhaseNode {
  return {
    kind: 'phase',
    id,
    name: `Step ${id}`,
    block: { type: 'G-04', version: '1' },
    config: {},
    records: [],
    computes: [],
    reads: [],
    consumes: [],
    produces: [],
    uses: [],
    equipment: [],
    signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'VERIFIER' } },
    significant: false,
    riskClass: 'LOW',
    ...extra,
  };
}

/** mix (timed: 15 min at most, warned 5 min before), a G-10 line clearance, a G-22 output weighing, and an end step. */
export function fingerprintMbr(): MbrContent {
  return {
    format: 'ebmr.mbr-content',
    formatVersion: 1,
    header: {
      family: 'ENGINE-FINGERPRINT',
      title: 'Engine fingerprint run',
      edition: 'tablets',
      recordKind: 'PROCESSING',
      product: { code: 'P', name: 'Product', strength: '1 mg', dosageForm: 'Tablet' },
      batchSizes: [{ id: 'BS', quantity: { value: '1', unit: 'kg' } }],
      marketSet: ['IN'],
      predicates: {},
      variants: [],
    },
    riskScale: { ref: 'RSK', classes: ['LOW', 'HIGH'] },
    references: [{ id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) }],
    library: [],
    inputs: [],
    bom: [],
    intermediates: [{ id: 'I-OUT', name: 'Output', finalOutput: true }],
    parameters: [
      { id: 'outNet', name: 'Output (net)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
      // Typed by hand from a printout the MBR names as its evidence (1.4.0).
      {
        id: 'endTime',
        name: 'End time on the printout',
        valueType: 'DECIMAL',
        unit: 'min',
        precision: { kind: 'DECIMALS', digits: 0 },
        role: 'OBSERVATION',
        criticality: 'CRITICAL',
        riskClass: 'HIGH',
        capture: 'MANUAL',
        evidence: 'PRINTOUT',
        accuracyCheck: 'SECOND_PERSON',
      },
      // The same, checked after its witness window (1.5.0).
      {
        id: 'lateTime',
        name: 'Late time on the printout',
        valueType: 'DECIMAL',
        unit: 'min',
        precision: { kind: 'DECIMALS', digits: 0 },
        role: 'OBSERVATION',
        criticality: 'CRITICAL',
        riskClass: 'HIGH',
        capture: 'MANUAL',
        evidence: 'PRINTOUT',
        accuracyCheck: 'SECOND_PERSON',
      },
      // Keyed by hand in a step that is handed over (1.6.0).
      { id: 'handTime', name: 'Hand-over time', valueType: 'DECIMAL', unit: 'min', precision: { kind: 'DECIMALS', digits: 0 }, role: 'OBSERVATION', criticality: 'NON_CRITICAL', riskClass: 'LOW', capture: 'MANUAL' },
    ],
    calculations: [],
    yieldCheckpoints: [],
    acceptanceSchemes: [],
    timeConstraints: [
      {
        id: 'TC-MIX',
        name: 'Mixing time',
        kind: 'TIMER',
        from: { node: 'mix', event: 'START' },
        to: { node: 'mix', event: 'END' },
        max: { value: '15', unit: 'min' },
        warnBefore: { value: '5', unit: 'min' },
        source: { kind: 'VALIDATION_REPORT', ref: 'VR' },
        breach: 'EXCEPTION',
        pauses: 'INCLUDED',
      },
    ],
    riskReductions: [],
    goldenCases: [],
    procedure: {
      id: 'PROC',
      name: 'Procedure',
      body: {
        kind: 'sequence',
        id: 'proc-seq',
        children: [
          {
            kind: 'stage',
            id: 'S',
            name: 'Stage',
            binding: { rooms: [], equipment: [] },
            purpose: 'NON_MATERIAL',
            responsibleRole: 'HEAD_OF_PRODUCTION',
            body: {
              kind: 'operation',
              id: 'O',
              name: 'Operation',
              body: {
                kind: 'sequence',
                id: 'ops',
                children: [
                  phaseNode('mix'),
                  phaseNode('clear', { block: { type: 'G-10', version: '1' }, significant: true }),
                  phaseNode('out', { block: { type: 'G-22', version: '1' }, records: ['outNet'], produces: ['I-OUT'] }),
                  phaseNode('end', { records: ['endTime'] }),
                  // Three branches at once (1.5.0): a value typed by hand checked after its witness window, a step the MBR
                  // declares WITNESSED, and a step started after that one's act, so the run moved on.
                  {
                    kind: 'parallel',
                    id: 'par',
                    branches: [
                      { id: 'b-late', name: 'Late', body: phaseNode('late', { records: ['lateTime'] }) },
                      { id: 'b-wit', name: 'Witnessed', body: phaseNode('wit', { signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'WITNESSED', role: 'VERIFIER' } } }) },
                      { id: 'b-side', name: 'Side', body: phaseNode('side') },
                      // A step handed over by its performer to another (1.6.0).
                      { id: 'b-hand', name: 'Hand-over', body: phaseNode('hand', { records: ['handTime'] }) },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };
}

export function fingerprintDefinition(): BatchDefinition {
  return defineBatch(fingerprintMbr(), { registry: genericBlockRegistry(), expressions: createExprService(), installation: 'SANDBOX' });
}

type Row =
  | { kind: 'COMMAND'; at: bigint; command: Command }
  | { kind: 'SWEEP'; at: bigint }
  | { kind: 'PREPARE'; at: bigint; actor: Actor; target: Parameters<typeof prepareForSignature>[2] };

const signed = (id: string, meaning: string, signer: Actor) => ({ id, meaning, signer: signer.id });

type CommandInput = Command extends infer C ? (C extends Command ? Omit<C, 'commandId'> : never) : never;

/** The rows after ISSUE, in order. Some are refused by one engine version and accepted by another, on purpose. */
function rows(): Row[] {
  const at = (minutes: number): bigint => T0 + BigInt(minutes) * MIN;
  const c = (minutes: number, command: CommandInput, n: number): Row => ({ kind: 'COMMAND', at: at(minutes), command: { commandId: `FP-${n}`, ...command } as Command });
  const checklist = { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' })) };
  const previous = { kind: 'PREVIOUS_BATCH', product: 'Ibuprofen 400 mg tablets', batchNumber: 'TEST-B26-0099' };
  return [
    c(1, { type: 'START_STEP', actor: OP1, step: 'mix', context: [] }, 1),
    // The warning, then the maximum, noticed by the sweeper and by a person's own command.
    { kind: 'SWEEP', at: at(12) },
    c(17, { type: 'RAISE_EXCEPTION', actor: QA1, description: 'observation on the floor', severity: 'ALERT' }, 2),
    // The trusted clock goes back, seen by a person's command.
    c(16, { type: 'RAISE_EXCEPTION', actor: QA1, description: 'second observation', severity: 'ALERT' }, 3),
    { kind: 'PREPARE', at: at(18), actor: QA1, target: { type: 'DISPOSITION_EXCEPTION' } },
    c(19, { type: 'SIGN_PERFORMED', actor: OP1, step: 'mix', context: [], signature: signed('FP-S1', 'PERFORMED', OP1) }, 4),
    // A witness in place of the step's check, then the check.
    c(20, { type: 'VERIFY', actor: VER1, step: 'mix', context: [], signature: signed('FP-S2', 'WITNESSED', VER1) }, 5),
    c(21, { type: 'VERIFY', actor: VER1, step: 'mix', context: [], signature: signed('FP-S3', 'VERIFIED', VER1) }, 6),
    c(22, { type: 'START_STEP', actor: OP2, step: 'clear', context: [] }, 7),
    c(23, { type: 'RECORD_ENTRY', actor: OP2, step: 'clear', context: [], entry: checklist }, 8),
    c(24, { type: 'RECORD_ENTRY', actor: OP2, step: 'clear', context: [], entry: previous }, 9),
    // The generic PERFORMED on a block with its own perform meaning, then the block's own.
    { kind: 'PREPARE', at: at(25), actor: OP2, target: { type: 'SIGN_PERFORMED', step: 'clear', context: [] } },
    c(25, { type: 'SIGN_PERFORMED', actor: OP2, step: 'clear', context: [], signature: signed('FP-S4', 'PERFORMED', OP2) }, 10),
    c(26, { type: 'SIGN_PERFORMED', actor: OP2, step: 'clear', context: [], signature: signed('FP-S5', 'LINE_CLEARANCE_PERFORMED', OP2) }, 11),
    // The generic VERIFIED on a block with its own check, then the block's own.
    c(27, { type: 'VERIFY', actor: VER2, step: 'clear', context: [], signature: signed('FP-S6', 'VERIFIED', VER2) }, 12),
    c(28, { type: 'VERIFY', actor: VER2, step: 'clear', context: [], signature: signed('FP-S7', 'LINE_CLEARANCE_VERIFIED', VER2) }, 13),
    // An output container weighed at 0.001 kg: its net and the recorded quantity keep that resolution (1.2.0).
    c(29, { type: 'START_STEP', actor: OP1, step: 'out', context: [] }, 14),
    c(30, { type: 'RECORD_ENTRY', actor: OP1, step: 'out', context: [], entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-OUT', gross: '26.100', tare: '1.100', unit: 'kg', balance: 'BAL-2', source: 'DEVICE' } }, 15),
    // A container weighed in g counts into the quantity in kg at its own resolution (8000.0 g is 8.0000 kg), and a weight
    // in a unit the total cannot be counted in exactly is refused (1.3.0); the step signed performed computes the total.
    c(31, { type: 'RECORD_ENTRY', actor: OP1, step: 'out', context: [], entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-OUT', gross: '9250.0', tare: '1250.0', unit: 'g', balance: 'BAL-2', source: 'DEVICE' } }, 16),
    c(32, { type: 'RECORD_ENTRY', actor: OP1, step: 'out', context: [], entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-OUT', gross: '2.000', tare: '1.000', unit: 'kg{wet}', balance: 'BAL-2', source: 'DEVICE' } }, 17),
    c(33, { type: 'SIGN_PERFORMED', actor: OP1, step: 'out', context: [], signature: signed('FP-S8', 'PERFORMED', OP1) }, 18),
    c(34, { type: 'VERIFY', actor: VER2, step: 'out', context: [], signature: signed('FP-S9', 'VERIFIED', VER2) }, 19),
    // A critical value typed by hand without the printout its MBR names: its check is a witness, not a later review (1.4.0).
    c(35, { type: 'START_STEP', actor: OP2, step: 'end', context: [] }, 20),
    c(36, { type: 'RECORD_DATA', actor: OP2, step: 'end', context: [], item: 'endTime', value: { kind: 'DECIMAL', value: '36', unit: 'min' }, source: { mode: 'MANUAL' } }, 21),
    c(37, { type: 'SIGN_PERFORMED', actor: OP2, step: 'end', context: [], signature: signed('FP-S10', 'PERFORMED', OP2) }, 22),
    c(38, { type: 'VERIFY', actor: VER1, step: 'end', context: [], signature: signed('FP-S11', 'VERIFIED', VER1) }, 23),
    c(39, { type: 'VERIFY', actor: VER1, step: 'end', context: [], signature: signed('FP-S12', 'WITNESSED', VER1) }, 24),
    { kind: 'SWEEP', at: at(40) },
    // The same value checked six minutes after the act, past the witness window: a witness, then a later review (1.5.0).
    c(41, { type: 'START_STEP', actor: OP2, step: 'late', context: [] }, 25),
    c(42, { type: 'RECORD_DATA', actor: OP2, step: 'late', context: [], item: 'lateTime', value: { kind: 'DECIMAL', value: '42', unit: 'min' }, source: { mode: 'MANUAL' } }, 26),
    c(43, { type: 'SIGN_PERFORMED', actor: OP2, step: 'late', context: [], signature: signed('FP-S13', 'PERFORMED', OP2) }, 27),
    c(49, { type: 'VERIFY', actor: VER1, step: 'late', context: [], signature: signed('FP-S14', 'WITNESSED', VER1) }, 28),
    c(49, { type: 'VERIFY', actor: VER1, step: 'late', context: [], signature: signed('FP-S15', 'VERIFIED', VER1) }, 29),
    // A step the MBR declares WITNESSED, and another step started after its act: the run moved on (1.5.0).
    c(50, { type: 'START_STEP', actor: OP1, step: 'wit', context: [] }, 30),
    c(51, { type: 'SIGN_PERFORMED', actor: OP1, step: 'wit', context: [], signature: signed('FP-S16', 'PERFORMED', OP1) }, 31),
    c(52, { type: 'START_STEP', actor: OP2, step: 'side', context: [] }, 32),
    c(53, { type: 'VERIFY', actor: VER2, step: 'wit', context: [], signature: signed('FP-S17', 'WITNESSED', VER2) }, 33),
    c(53, { type: 'VERIFY', actor: VER2, step: 'wit', context: [], signature: signed('FP-S18', 'VERIFIED', VER2) }, 34),
    { kind: 'SWEEP', at: at(54) },
    // A step in progress handed over by its performer to another, signed by a supervisor and approved by QA; the
    // outgoing performer no longer signs it, the incoming one takes it over and signs, a third person verifies (1.6.0).
    c(55, { type: 'START_STEP', actor: OP1, step: 'hand', context: [] }, 35),
    c(56, { type: 'RECORD_DATA', actor: OP1, step: 'hand', context: [], item: 'handTime', value: { kind: 'DECIMAL', value: '56', unit: 'min' }, source: { mode: 'MANUAL' } }, 36),
    c(57, { type: 'HAND_OVER_STEP', actor: SUP1, step: 'hand', context: [], outgoing: OP1.id, incoming: OP2.id, reason: 'end of shift', signature: signed('FP-S19', 'HANDOVER_APPROVED', SUP1), approval: { approver: QA1, signature: signed('FP-S20', 'HANDOVER_APPROVED', QA1) } }, 37),
    c(58, { type: 'TAKE_OVER_STEP', actor: OP2, step: 'hand', context: [] }, 38),
    c(59, { type: 'SIGN_PERFORMED', actor: OP1, step: 'hand', context: [], signature: signed('FP-S21', 'PERFORMED', OP1) }, 39),
    c(59, { type: 'SIGN_PERFORMED', actor: OP2, step: 'hand', context: [], signature: signed('FP-S22', 'PERFORMED', OP2) }, 40),
    c(60, { type: 'VERIFY', actor: VER1, step: 'hand', context: [], signature: signed('FP-S23', 'VERIFIED', VER1) }, 41),
    // An invalidation without the assignable cause its investigation concluded, then with it (1.6.0).
    c(61, { type: 'INVALIDATE_RESULT', actor: SUP1, point: 'DP-3', investigationRef: 'TEST-OOS-1', reason: 'printout misread', approval: { approver: QA1, signature: signed('FP-S24', 'INVALIDATION_APPROVED', QA1) } } as unknown as CommandInput, 42),
    c(62, { type: 'INVALIDATE_RESULT', actor: SUP1, point: 'DP-3', investigationRef: 'TEST-OOS-1', assignableCause: 'printer clock fault', reason: 'printout misread', approval: { approver: QA1, signature: signed('FP-S25', 'INVALIDATION_APPROVED', QA1) } }, 43),
    // An abort without its checklist confirmed, then with it (1.6.0).
    c(63, { type: 'ABORT_BATCH', actor: SUP1, reason: 'contamination', approvals: [{ approver: HEAD1, signature: signed('FP-S26', 'BATCH_ABORT_APPROVED', HEAD1) }, { approver: QA1, signature: signed('FP-S27', 'BATCH_ABORT_APPROVED', QA1) }] } as unknown as CommandInput, 44),
    c(64, { type: 'ABORT_BATCH', actor: SUP1, reason: 'contamination', checklist: { outputsHeld: true, equipmentSetDirty: true, materialsSecured: true }, approvals: [{ approver: HEAD1, signature: signed('FP-S28', 'BATCH_ABORT_APPROVED', HEAD1) }, { approver: QA1, signature: signed('FP-S29', 'BATCH_ABORT_APPROVED', QA1) }] }, 45),
  ];
}

export interface RowOutcome {
  seq: number;
  kind: 'ISSUE' | Row['kind'];
  /** The command type, or the kind for ISSUE, PREPARE and SWEEP. */
  what: string;
  /** ACCEPTED or the refusal's rule code. */
  answer: string;
  eventsHash: string;
  stateHash: string;
}

/** The state hash without the version label the state carries (the behaviour, not the name). */
function behaviourHash(state: BatchState): string {
  return stateHash({ ...state, engineVersion: '(any)' });
}

/** Runs the fixed rows through the engine and returns each row's outcome and the fingerprint of them all. */
export function engineFingerprint(): { hash: string; rows: RowOutcome[] } {
  const def = fingerprintDefinition();
  const out: RowOutcome[] = [];
  const record = (kind: RowOutcome['kind'], what: string, answer: string, state: BatchState, events: EngineEvent[]): void => {
    out.push({ seq: out.length + 1, kind, what, answer, eventsHash: eventsHash(events), stateHash: behaviourHash(state) });
  };
  const issued = issue(def, { batchId: 'BATCH-FP', batchNumber: 'TEST-FP-0001', batchSize: 'BS', marketSet: ['IN'], inputs: {}, issuedBy: SUP1 }, { nowUs: T0 });
  let state = issued.state;
  record('ISSUE', 'ISSUE', 'ACCEPTED', state, issued.events);
  for (const row of rows()) {
    if (row.kind === 'SWEEP') {
      const r = sweep(def, state, { nowUs: row.at });
      state = r.state;
      record('SWEEP', 'SWEEP', 'ACCEPTED', state, r.events);
    } else if (row.kind === 'PREPARE') {
      const r = prepareForSignature(def, state, row.target, row.actor, { nowUs: row.at });
      state = r.state;
      record('PREPARE', `PREPARE ${row.target.type}`, 'ACCEPTED', state, r.events);
    } else {
      const r = step(def, state, row.command, { nowUs: row.at });
      state = r.state;
      record('COMMAND', row.command.type, r.accepted ? 'ACCEPTED' : (r.refusal?.code ?? 'DUPLICATE'), state, r.events);
    }
  }
  return { hash: hashJson(out.map((r) => ({ ...r }))), rows: out };
}
