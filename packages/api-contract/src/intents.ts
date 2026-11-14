/**
 * Client intents are not engine commands (Phase 2 apps plan section 4, "Client commands are not engine
 * commands"; fix for browser-supplied facts, J1-3/J2-8).
 *
 * The browser says what the person did; the server resolves every fact the browser must not supply:
 *  - data sources are MANUAL or SCAN only (DEVICE, AUTOMATION, LIMS and BLOCK are server-set);
 *  - lots travel as codes (status, expiry, retest and identity testing come from the server's lot store);
 *  - device values travel as reading ids (value, unit, raw string, device and time trust come from the claim);
 *  - no actor, roles, SignatureRef, commandId or occurredAt trust: the server derives them.
 * Every object is strict, so an extra member (such as `actor` or `lot.status`) is refused, not ignored.
 *
 * Signature-bearing intents travel only inside an e-signature action (signable.ts).
 */
import { z } from 'zod';
import type { engine } from '@ebmr/recipe-core/pure';
import { DataValueWire, DecimalString, Uuid } from './common.ts';
import { TabletEntryKind } from './tablet-entries.ts';

/** An act proposed for approval on a batch (aggregate batch_act, recipe-core 0470). */
export const ActId = z.string().regex(/^[0-9a-f-]{36}:act@[0-9]{1,10}:[0-9a-f]{64}$/, 'an act id: <batch>:act@<state version>:<hash>');

/** A step instance: `<phase or hold point id>@<context key>` as the engine names it (e.g. `p-blend@` or `p-dry@R=2/L=3`). */
export const StepKey = z.string().min(2).max(512).regex(/@/, 'a step key names the step and its context: <step>@<context>');

/** Source of a manually entered or scanned value; anything else is set by the server. */
export const ClientDataSource = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('MANUAL'),
    evidence: z.strictObject({ kind: z.enum(['PHOTO', 'PRINTOUT']), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
  }),
  z.strictObject({ mode: z.literal('SCAN'), code: z.string().min(1).max(256) }),
]);
export type ClientDataSource = z.infer<typeof ClientDataSource>;

/**
 * Hand-entered weighing values when no scale of the room is online (the engine then requires a second person), and,
 * optionally, the balance of the room the operator read them from (`deviceCode`): the server records it as the
 * balance after checking that it is a scale of the step's room and that none of them is online (review finding P50).
 */
const ManualWeighing = z.strictObject({ tare: DecimalString, gross: DecimalString, unit: z.string().min(1), deviceCode: z.string().min(1).max(64).optional() });

/**
 * A member of a BLOCK_ENTRY's data, as the block's own schema takes it (recipe-core blocks/schema.ts): text (decimals as
 * decimal text, never numbers), a yes/no, a whole number, or a list or object of these. The engine validates it against
 * the block version's entry schema; the database's guards decide the rest.
 */
export type BlockFieldWire = string | boolean | number | BlockFieldWire[] | { [key: string]: BlockFieldWire };
export const BlockFieldWire: z.ZodType<BlockFieldWire> = z.lazy(() =>
  z.union([
    z.string().max(4000),
    z.boolean(),
    z.number().int().safe(),
    z.array(BlockFieldWire).max(500),
    z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), BlockFieldWire),
  ]),
);

/**
 * Block entries as the browser may send them, one variant per entry kind of the template's blocks.
 * Server-resolved fields are replaced by ids or codes.
 */
export const ClientEntry = z.discriminatedUnion('kind', [
  // G-07 Weighing and dispensing: the lot by code; tare and gross by reading id, or manual values.
  z.strictObject({
    kind: z.literal('CONTAINER_WEIGHING'),
    item: z.string().min(1),
    bomLine: z.string().min(1),
    container: z.string().min(1).optional(),
    lotCode: z.string().min(1),
    tareReadingId: Uuid.optional(),
    grossReadingId: Uuid.optional(),
    manual: ManualWeighing.optional(),
    /** TB-01 only: why a lot other than the first-expiring usable one is dispensed (PR-18). */
    fefoReason: z.string().min(1).max(2000).optional(),
  }),
  // TB-01 Potency calculation: the lots of the active by code, in allocation order; with more than one lot, each lot's
  // base-equivalent share. The server reads each lot's status and its approved assay result from the lot register.
  z.strictObject({
    kind: z.literal('POTENCY_CALCULATION'),
    lots: z.array(z.strictObject({ lotCode: z.string().min(1), baseEquivalent: DecimalString.optional() })).min(1).max(3),
  }),
  // G-08 Identification and charge-in: the scanned container label.
  z.strictObject({ kind: z.literal('CHARGE_CONTAINER'), containerCode: z.string().min(1) }),
  // G-10@1 Clearance checklist (SANDBOX_ONLY until Phase 3).
  z.strictObject({
    kind: z.literal('CLEARANCE_CHECK'),
    answers: z.array(z.strictObject({ id: z.string().min(1), answer: z.enum(['CONFIRMED', 'NOT_CONFIRMED', 'NOT_APPLICABLE']) })).min(1),
  }),
  z.strictObject({ kind: z.literal('PREVIOUS_BATCH'), product: z.string().min(1), batchNumber: z.string().min(1) }),
  // G-09@1 Equipment status by manual attestation (SANDBOX_ONLY until Phase 3).
  z.strictObject({
    kind: z.literal('EQUIPMENT_STATUS'),
    equipmentRef: z.string().min(1),
    labelId: z.string().min(1),
    answers: z.array(z.strictObject({ id: z.string().min(1), answer: z.enum(['YES', 'NO']) })).min(1),
  }),
  // G-03 Instruction and acknowledgement.
  z.strictObject({ kind: z.literal('ACKNOWLEDGE'), mode: z.enum(['READ', 'CONFIRM_PERFORMED']) }),
  // G-22 Output containers: tare and gross by reading id, or manual values.
  z.strictObject({
    kind: z.literal('OUTPUT_CONTAINER'),
    intermediate: z.string().min(1),
    container: z.string().min(1).optional(),
    tareReadingId: Uuid.optional(),
    grossReadingId: Uuid.optional(),
    manual: ManualWeighing.optional(),
  }),
  // Phase 3 slice 6 (D-S6-2): any entry of a tablet block, G-06@1, G-21@1 or G-24@2 by its kind; the server hands
  // {kind: entryKind, ...data} to the engine (no actor, source or time from the browser: `kind` is the entry kind's own).
  z.strictObject({
    kind: z.literal('BLOCK_ENTRY'),
    entryKind: TabletEntryKind,
    data: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine((k) => k !== 'kind', 'kind is the entry kind'), BlockFieldWire),
  }),
  // Decision 0026 (S4): an entry of a library block, by its section id (or TIMER_START / TIMER_STOP). The kinds come from
  // the master's own library snapshot, not from a list in code; the engine checks the entry against the block's schema
  // and the database against the snapshot (recipe-core 1810).
  z.strictObject({
    kind: z.literal('LIBRARY_ENTRY'),
    entryKind: z.string().regex(/^([a-z][A-Za-z0-9_]{0,39}|TIMER_START|TIMER_STOP)$/),
    data: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine((k) => k !== 'kind', 'kind is the entry kind'), BlockFieldWire),
  }),
]);
export type ClientEntry = z.infer<typeof ClientEntry>;
export type ClientEntryKind = ClientEntry['kind'];

/** Intents sent as plain commands (POST /api/test-runs/:runId/commands, FRESH_ON_SHARED). */
export const ClientIntent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('START_STEP'), stepKey: StepKey }),
  z.strictObject({
    type: z.literal('RECORD_DATA'),
    stepKey: StepKey,
    item: z.string().min(1),
    value: DataValueWire,
    source: ClientDataSource,
    /** Mandatory for a late entry. */
    reason: z.string().min(1).max(2000).optional(),
  }),
  z.strictObject({ type: z.literal('RECORD_ENTRY'), stepKey: StepKey, entry: ClientEntry }),
  z.strictObject({
    type: z.literal('RAISE_EXCEPTION'),
    stepKey: StepKey.optional(),
    description: z.string().min(1).max(2000),
    severity: z.enum(['ALERT', 'ACTION']),
  }),
  /**
   * The deviation linked to an exception: an existing one by its reference, or (owner retest of 13 November 2026, item 8;
   * GMP without the Deviations link) `raise`: a deviation raised, linked to the batch and attached to the exception in the
   * same command, so none is left raised and unattached. Exactly one of the two (the server refuses both or neither).
   */
  z.strictObject({
    type: z.literal('ATTACH_DEVIATION'),
    exception: z.string().min(1),
    deviationRef: z.string().min(1).max(128).optional(),
    raise: z.strictObject({ classification: z.enum(['MINOR', 'MAJOR', 'CRITICAL']), riskRationale: z.string().trim().min(10).max(2000) }).optional(),
  }),
  z.strictObject({ type: z.literal('HOLD_BATCH'), holdType: z.enum(['SUPERVISOR', 'QA']), reason: z.string().min(1).max(2000) }),
  z.strictObject({ type: z.literal('RELEASE_HOLD'), hold: z.string().min(1), reason: z.string().min(1).max(2000) }),
  // Phase 3 slice 6 (DI-24, DI-29): the void of an attempt that has no result yet, with the person's own reason; the
  // QA approval (S28) is QA's VOID_AUTHORISED signature on the act proposed first (POST /api/batches/:batchId/acts),
  // named by `approvalActId`. Nothing deletes an entry: there is no delete route.
  z.strictObject({
    type: z.literal('VOID_ATTEMPT'),
    stepKey: StepKey,
    item: z.string().min(1).max(128),
    reason: z.string().trim().min(1).max(2000),
    /** An existing data point of the item (refused when it holds a result). */
    point: z.string().min(1).max(128).optional(),
    approvalActId: ActId.optional(),
  }),
  // Phase 3 slice 6d (GB-T-01, INV-19): the end of an iteration of a bounded loop (the LOD re-dry, continued coating), named
  // by a step instance of the iteration; the engine evaluates the loop's exit condition on the recorded end point and
  // decides EXIT, CONTINUE or EXHAUSTED (never the person).
  z.strictObject({ type: z.literal('COMPLETE_LOOP_ITERATION'), stepKey: StepKey }),
  // Phase 3 slice 6d (GB-T-01, DI-34, PR-13): the person's choice at an operator-choice branch (the optional extra
  // granulating fluid), with the reason; `context` is the iteration or sub-lot the choice is made in, as a step key's
  // context ('R-GRAN=1'; empty outside them). The engine checks the decision mode, the roles and that the choice is due.
  z.strictObject({
    type: z.literal('CHOOSE_ALTERNATIVE'),
    construct: z.string().min(1).max(128),
    context: z.string().max(512).optional(),
    branch: z.string().min(1).max(128),
    reason: z.string().trim().min(1).max(2000),
  }),
]);
export type ClientIntent = z.infer<typeof ClientIntent>;

/** Intents that carry an e-signature: sent only inside an ENGINE_COMMAND signable action. */
export const SignedIntent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('SIGN_PERFORMED'), stepKey: StepKey }),
  z.strictObject({ type: z.literal('VERIFY'), stepKey: StepKey, meaning: z.enum(['VERIFIED', 'WITNESSED']) }),
  z.strictObject({
    type: z.literal('DISPOSITION_HOLD_POINT'),
    stepKey: StepKey,
    disposition: z.string().min(1),
    comment: z.string().max(2000).optional(),
  }),
  z.strictObject({ type: z.literal('SIGN_OFF_STAGE'), stageKey: z.string().min(1) }),
  z.strictObject({
    type: z.literal('DISPOSITION_EXCEPTION'),
    exception: z.string().min(1),
    outcome: z.enum(['NO_IMPACT', 'DEVIATION_RAISED']),
    justification: z.string().min(1).max(4000),
  }),
  // Phase 4 slice 1a (path (a), outline 5.2.3; DI-24): the correction of a manually entered value, signed CORRECTED by the
  // corrector with the person's own reason. A stored evidence document (its SHA-256) and the approval (the approver's
  // CORRECTION_APPROVED signature on the point, signable action CORRECTION_APPROVAL) are named when the rules need them:
  // critical data (S25); a failing value made passing, or a loop reading that missed its endpoint (QA, evidence).
  z.strictObject({
    type: z.literal('CORRECT_ENTRY'),
    point: z.string().min(1).max(256),
    value: DataValueWire,
    reason: z.string().trim().min(1).max(2000),
    evidence: z.strictObject({ kind: z.enum(['DEVICE_RAW', 'PRINTOUT', 'PHOTO']), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
    approvalSignatureId: Uuid.optional(),
  }),
]);
export type SignedIntent = z.infer<typeof SignedIntent>;

// ---------------------------------------------------------------------------------------------
// Exhaustive classification of the engine's commands (a new engine command is a compile error here).

export type CommandClass = 'CLIENT_PLAIN' | 'CLIENT_SIGNED' | 'SERVER_ONLY' | 'LATER';

export const ENGINE_COMMAND_CLASSES = {
  START_STEP: 'CLIENT_PLAIN',
  RECORD_DATA: 'CLIENT_PLAIN',
  RECORD_ENTRY: 'CLIENT_PLAIN',
  RAISE_EXCEPTION: 'CLIENT_PLAIN',
  ATTACH_DEVIATION: 'CLIENT_PLAIN',
  HOLD_BATCH: 'CLIENT_PLAIN',
  RELEASE_HOLD: 'CLIENT_PLAIN',
  SIGN_PERFORMED: 'CLIENT_SIGNED',
  VERIFY: 'CLIENT_SIGNED',
  DISPOSITION_HOLD_POINT: 'CLIENT_SIGNED',
  SIGN_OFF_STAGE: 'CLIENT_SIGNED',
  DISPOSITION_EXCEPTION: 'CLIENT_SIGNED',
  // A2: loop, alternative and replicate intents; corrections, voids, invalidations; skip, abort, cancel.
  CHOOSE_ALTERNATIVE: 'CLIENT_PLAIN',
  CHOOSE_REPLICATE_COUNT: 'LATER',
  COMPLETE_LOOP_ITERATION: 'CLIENT_PLAIN',
  REQUEST_SKIP: 'LATER',
  CORRECT_ENTRY: 'CLIENT_SIGNED',
  // Phase 3 slice 6: the void of an attempt, with its reason and the QA approval of the proposed act.
  VOID_ATTEMPT: 'CLIENT_PLAIN',
  INVALIDATE_RESULT: 'LATER',
  ABORT_BATCH: 'LATER',
  CANCEL_BATCH: 'LATER',
  // Phase 3 slice 2: hand-over of a step in progress and its take-over (L-07); screens in slice 6.
  HAND_OVER_STEP: 'LATER',
  TAKE_OVER_STEP: 'LATER',
} as const satisfies Record<engine.CommandType, CommandClass>;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type ClassOf<C extends CommandClass> = { [K in keyof typeof ENGINE_COMMAND_CLASSES]: (typeof ENGINE_COMMAND_CLASSES)[K] extends C ? K : never }[keyof typeof ENGINE_COMMAND_CLASSES];

/** Compile-time proofs: every engine command is classified, and the intents cover exactly their class. */
export type ContractProofs = [
  Expect<Equal<keyof typeof ENGINE_COMMAND_CLASSES, engine.CommandType>>,
  Expect<Equal<ClientIntent['type'], ClassOf<'CLIENT_PLAIN'>>>,
  Expect<Equal<SignedIntent['type'], ClassOf<'CLIENT_SIGNED'>>>,
];

export const CLIENT_PLAIN_TYPES = Object.keys(ENGINE_COMMAND_CLASSES).filter((k) => ENGINE_COMMAND_CLASSES[k as engine.CommandType] === 'CLIENT_PLAIN');
export const CLIENT_SIGNED_TYPES = Object.keys(ENGINE_COMMAND_CLASSES).filter((k) => ENGINE_COMMAND_CLASSES[k as engine.CommandType] === 'CLIENT_SIGNED');
