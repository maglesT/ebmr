/**
 * Error classes of inbound messages and the acknowledgment and retry rule (Phase 6 slice 6a-0; DI-31).
 *
 * Every refusal of an inbound message falls in exactly one class. The class decides what the adapter does next:
 *
 *  | Class         | Meaning                                                                          | Retry? |
 *  |---------------|----------------------------------------------------------------------------------|--------|
 *  | MALFORMED     | the envelope or payload does not match its schema, or an unsupported version      | no     |
 *  | DUPLICATE     | the idempotency key was accepted before with a different payload hash             | no     |
 *  | OUT_OF_ORDER  | the sequence number is already taken by another message                           | no     |
 *  | WRONG_IDENTITY| the message names a lot, batch, material, equipment or source the eBMR does not hold | no   |
 *  | OUT_OF_RANGE  | a value lies outside what the receiving command accepts (unit, range, precision)  | no     |
 *  | STALE         | the message is older than the value the eBMR already holds for the same record    | no     |
 *  | PARTIAL       | the message arrived incomplete (a cut transfer, a missing part of a multi-part set)| no    |
 *  | TRANSPORT     | the eBMR could not be reached or the transaction could not commit                 | yes    |
 *
 * A same-key same-hash duplicate is not a refusal: `platform.accept_inbound_detail` returns outcome DUPLICATE with
 * the first message's id, and the adapter acknowledges it like an accepted message (the source resent it because it
 * never saw the first acknowledgment).
 *
 * Gaps and late messages are not refusals either: the database accepts the message and raises an integration alarm
 * (SEQUENCE_GAP, OUT_OF_ORDER) in the same transaction.
 *
 * The acknowledgment rule (ACK_RULE):
 *  1. Acknowledge to the source only after the eBMR transaction has committed: the message (ACCEPTED or DUPLICATE),
 *     or the refusal recorded with `platform.record_inbound_refusal` in its own command (which raises the alarm).
 *     Never acknowledge before the commit; a crash between commit and acknowledgment only causes a duplicate.
 *  2. A TRANSPORT failure is retried with the same envelope (same idempotency key) after retryDelayMs(attempt), for
 *     ever: a message is never dropped. The adapter's health shows the age of its oldest unsent message.
 *  3. Every other class is permanent: record the refusal once, then send the source a negative acknowledgment naming
 *     the class; the source corrects the data and sends a new message with a new idempotency key.
 */
import { z } from 'zod';

export const ERROR_CLASSES = ['MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'WRONG_IDENTITY', 'OUT_OF_RANGE', 'STALE', 'PARTIAL', 'TRANSPORT'] as const;
export const ErrorClass = z.enum(ERROR_CLASSES);
export type ErrorClass = z.infer<typeof ErrorClass>;

/** Classes whose refusal `platform.record_inbound_refusal` records (TRANSPORT is retried, never recorded as a refusal). */
export const REFUSAL_CLASSES = ERROR_CLASSES.filter((c): c is Exclude<ErrorClass, 'TRANSPORT'> => c !== 'TRANSPORT');

export const RETRYABLE: Readonly<Record<ErrorClass, boolean>> = {
  MALFORMED: false,
  DUPLICATE: false,
  OUT_OF_ORDER: false,
  WRONG_IDENTITY: false,
  OUT_OF_RANGE: false,
  STALE: false,
  PARTIAL: false,
  TRANSPORT: true,
};

/** Back-off of the retry rule: 1 s, 2 s, 4 s, ... capped at 5 minutes; attempts are never limited. */
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 300_000;
export function retryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt counts from 1');
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 20));
}

/** What the adapter does with a message after an outcome. */
export type AckAction = 'ACK' | 'RECORD_REFUSAL_THEN_NACK' | 'RETRY';
/** After an accept outcome (ACCEPTED, or DUPLICATE of a message accepted before) or a failure of a class. */
export function ackAction(result: { outcome: 'ACCEPTED' | 'DUPLICATE' } | { errorClass: ErrorClass }): AckAction {
  if ('outcome' in result) return 'ACK';
  return RETRYABLE[result.errorClass] ? 'RETRY' : 'RECORD_REFUSAL_THEN_NACK';
}

/** The kernel's refusal codes of the inbound path (kernel 1180) and their class. */
export const KERNEL_INBOUND_CODES: Readonly<Record<string, ErrorClass>> = {
  'EBMR-INT-001': 'MALFORMED',
  'EBMR-INT-003': 'WRONG_IDENTITY',
  'EBMR-INT-004': 'MALFORMED',
  'EBMR-INT-005': 'DUPLICATE',
  'EBMR-INT-006': 'OUT_OF_ORDER',
  'EBMR-INT-010': 'STALE',
  // Slice 7a (kernel 1305): an envelope of a signing source reached a receiving command without its verification.
  'EBMR-INT-030': 'WRONG_IDENTITY',
};

/** SQLSTATE classes that mean "try again": connection exceptions, serialisation failures, deadlocks, shutdown. */
const TRANSPORT_SQLSTATE = /^(08...|40001|40P01|57P0[1-3]|53...)$/;

/**
 * The class of a failure, from its EBMR code (kernel codes above, then the system contract's own codes) or its
 * SQLSTATE. Undefined when neither is known: the worker treats that as a defect, alarms through its health and retries
 * nothing (an unknown refusal must be looked at, not repeated).
 */
export function classifyFailure(
  failure: { ebmrCode?: string | undefined; sqlState?: string | undefined; network?: boolean | undefined },
  systemCodes: Readonly<Record<string, ErrorClass>> = {},
): ErrorClass | undefined {
  if (failure.network) return 'TRANSPORT';
  if (failure.ebmrCode) {
    const c = KERNEL_INBOUND_CODES[failure.ebmrCode] ?? systemCodes[failure.ebmrCode];
    if (c) return c;
  }
  if (failure.sqlState && TRANSPORT_SQLSTATE.test(failure.sqlState)) return 'TRANSPORT';
  return undefined;
}

/** An inbound failure with its class, thrown by adapter code. */
export class InboundError extends Error {
  readonly errorClass: ErrorClass;
  readonly ebmrCode: string | undefined;
  constructor(errorClass: ErrorClass, message: string, ebmrCode?: string) {
    super(message);
    this.name = 'InboundError';
    this.errorClass = errorClass;
    this.ebmrCode = ebmrCode;
  }
  get retryable(): boolean {
    return RETRYABLE[this.errorClass];
  }
}

/** Integration alarm kinds (`platform.integration_alarm.kind`): the refusal classes plus what the database detects. */
export const ALARM_KINDS = ['SEQUENCE_GAP', 'OUT_OF_ORDER', 'MALFORMED', 'DUPLICATE', 'WRONG_IDENTITY', 'OUT_OF_RANGE', 'STALE', 'PARTIAL', 'TRANSPORT', 'RECONCILIATION_MISMATCH', 'SERIES_GAP'] as const;
export const AlarmKind = z.enum(ALARM_KINDS);
export type AlarmKind = z.infer<typeof AlarmKind>;
export const AlarmSeverity = z.enum(['MINOR', 'MAJOR', 'CRITICAL']);
export type AlarmSeverity = z.infer<typeof AlarmSeverity>;
