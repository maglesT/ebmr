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
  z.strictObject({ type: z.literal('ATTACH_DEVIATION'), exception: z.string().min(1), deviationRef: z.string().min(1).max(128) }),
  z.strictObject({ type: z.literal('HOLD_BATCH'), holdType: z.enum(['SUPERVISOR', 'QA']), reason: z.string().min(1).max(2000) }),
  z.strictObject({ type: z.literal('RELEASE_HOLD'), hold: z.string().min(1), reason: z.string().min(1).max(2000) }),
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
  CHOOSE_ALTERNATIVE: 'LATER',
  CHOOSE_REPLICATE_COUNT: 'LATER',
  COMPLETE_LOOP_ITERATION: 'LATER',
  REQUEST_SKIP: 'LATER',
  CORRECT_ENTRY: 'LATER',
  VOID_ATTEMPT: 'LATER',
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
