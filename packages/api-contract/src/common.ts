/**
 * Wire rules shared by every namespace (Phase 2 apps plan section 4, "Wire rules" and "Refusal envelope").
 *
 *  - GMP decimals travel as DecimalString text, never as JSON numbers (and never in exponent form).
 *  - Instants travel as {us, text}: UTC epoch microseconds as a decimal string plus the site-time text the
 *    server formatted (kernel time.siteTime); the browser never formats GMP time.
 *  - Persons travel as {personId, legalName, loginName, role}.
 *  - Every non-2xx response is a RefusalEnvelope.
 *  - Text travels only if a record can hold it: no U+0000 and no UTF-16 surrogate without its other half, in any
 *    string or member name of a route's params, query or body (storableText; review F30-F33).
 * JSON numbers are used only for counts, indices and versions (safe integers).
 */
import { z } from 'zod';
import { unstorableText } from '@ebmr/expr';

export const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** A GMP decimal as text, e.g. "12.503" or "-0.5". JSON numbers and exponent forms are refused. */
export const DecimalString = z
  .string()
  .regex(DECIMAL_PATTERN, 'a decimal travels as plain decimal text such as 12.503, never as a number or in exponent form');
export type DecimalString = z.infer<typeof DecimalString>;

/** A non-negative integer as text (content versions, sequence numbers beyond 2^53 in the database). */
export const IntegerString = z.string().regex(/^(0|[1-9][0-9]*)$/, 'a whole number as text');

/** UTC epoch microseconds as text (may be negative before 1970). */
export const EpochMicros = z.string().regex(/^-?(0|[1-9][0-9]*)$/, 'UTC epoch microseconds as text');

export const Uuid = z.uuid();

/** Base64url (or base64) text without line breaks: device keys, nonces, signatures. */
export const Base64Text = z.string().regex(/^[A-Za-z0-9_+/-]+={0,2}$/, 'base64 text');

export const InstallationKind = z.enum(['GMP', 'SANDBOX']);
export type InstallationKind = z.infer<typeof InstallationKind>;

/** A point in time: epoch microseconds and the server's site-time text, e.g. "28-SEP-2026 14:05:03 +05:30 (Asia/Kolkata)". */
export const Instant = z.strictObject({
  us: EpochMicros,
  text: z.string().min(1),
});
export type Instant = z.infer<typeof Instant>;

/** A person as shown on every screen, signature and audit entry. `role` is the role they acted in. */
export const PersonRef = z.strictObject({
  personId: Uuid,
  legalName: z.string().min(1),
  loginName: z.string().min(1),
  role: z.string(),
});
export type PersonRef = z.infer<typeof PersonRef>;

/** The TEST, NOT GMP watermark (kernel sandbox.watermarkFor); null on GMP output. */
export const Watermark = z.strictObject({
  text: z.literal('TEST, NOT GMP'),
  source: z.enum(['SANDBOX', 'SANDBOX_TEST_RUN', 'TRAINING', 'SIMULATION', 'ANALYTICS']),
  notice: z.string().min(1),
  control: z.literal('DI-05'),
});
export type Watermark = z.infer<typeof Watermark>;

// ---------------------------------------------------------------------------------------------
// Text a record can hold (review F30-F33)

/** A string or member name holding text no record can hold, at `path` (a member name is reported at its object). */
export interface UnstorableTextIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Every string and member name of `value` that holds text no record can hold (at most `limit`): U+0000, which
 * PostgreSQL text and jsonb refuse, or a UTF-16 surrogate without its other half, which jsonb refuses and UTF-8
 * encoding (node-postgres, the browser's fetch) silently replaces with U+FFFD, so a record would hold a character
 * nobody sent. The walk keeps its own stack: no nesting depth overflows the call stack. The value is never echoed.
 */
export function unstorableTextIssues(value: unknown, limit = 10): UnstorableTextIssue[] {
  // Each place keeps its parent and its key, not a copy of its path: the walk stays linear in the size of the value.
  interface Place {
    v: unknown;
    parent: Place | null;
    key: string | number;
  }
  const pathOf = (place: Place): (string | number)[] => {
    const path: (string | number)[] = [];
    for (let p: Place | null = place; p !== null && p.parent !== null; p = p.parent) path.push(p.key);
    return path.reverse();
  };
  const out: UnstorableTextIssue[] = [];
  const stack: Place[] = [{ v: value, parent: null, key: '' }];
  while (stack.length > 0 && out.length < limit) {
    const place = stack.pop() as Place;
    const v = place.v;
    if (typeof v === 'string') {
      const problem = unstorableText(v);
      if (problem !== null) out.push({ path: pathOf(place), message: `holds ${problem}, which no record can hold: enter the text again without it` });
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i -= 1) stack.push({ v: v[i] as unknown, parent: place, key: i });
    } else if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      for (const [k] of entries) {
        const problem = unstorableText(k);
        if (problem !== null) out.push({ path: pathOf(place), message: `has a member name holding ${problem}, which no record can hold` });
      }
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [k, x] = entries[i] as [string, unknown];
        if (unstorableText(k) === null) stack.push({ v: x, parent: place, key: k });
      }
    }
  }
  return out.slice(0, limit);
}

/**
 * `schema`, refusing as well any string or member name, at any depth, that holds text no record can hold, each named
 * by its path. defineRoute applies it to the params, query and body of every route, so the server answers such a
 * request 400 INVALID_INPUT naming the field before any hook, handler, hash or database call sees the text.
 */
export function storableText<S extends z.ZodType>(schema: S): S {
  return schema.superRefine((value, ctx) => {
    for (const issue of unstorableTextIssues(value)) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });
}

// ---------------------------------------------------------------------------------------------
// Values

/** A value as it travels: decimals as DecimalString, instants as epoch microseconds text. */
export const DataValueWire = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('DECIMAL'), value: DecimalString, unit: z.string().min(1) }),
  z.strictObject({ kind: z.literal('COUNT'), value: IntegerString }),
  z.strictObject({ kind: z.literal('BOOLEAN'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('CATEGORY'), value: z.string().min(1) }),
  z.strictObject({ kind: z.literal('TEXT'), value: z.string() }),
  z.strictObject({ kind: z.literal('INSTANT'), us: EpochMicros }),
  z.strictObject({ kind: z.literal('SERIES'), values: z.array(DecimalString).min(1), unit: z.string().min(1) }),
]);
export type DataValueWire = z.infer<typeof DataValueWire>;

// ---------------------------------------------------------------------------------------------
// Devices and attribution (plan section 5)

/**
 * Proof of possession of the browser's device key: an ECDSA P-256 signature (IEEE P1363, as WebCrypto
 * produces it) over `nonce|METHOD|path|sha256hex(canonical JSON of the body without its proof)`.
 * The fingerprint is SHA-256 of the SPKI DER (kernel identity.deviceFingerprint).
 */
export const DeviceProof = z.strictObject({
  spki: Base64Text,
  nonce: z.string().min(16).max(128),
  sig: Base64Text,
});
export type DeviceProof = z.infer<typeof DeviceProof>;

/**
 * The longest PIN: every kiosk PIN pad stops at this many digits (sign-in, unlock, switch, signing), so the kernel
 * refuses a longer new PIN (identity MAX_PIN_LENGTH, the same number; review F05).
 */
export const PIN_MAX_LENGTH = 12;

/**
 * A badge UID as the kernel reads one (iam.badge_uid_hash, EBMR-IAM-060): colons, hyphens and white space removed,
 * upper case, 8 to 64 hexadecimal digits. Null for text that cannot be a badge UID, such as a PIN keyed into a badge
 * field or a secret the browser filled in: the badge prompts send nothing then, so nothing is counted or alerted
 * (review F56).
 */
export function badgeUidOf(text: string): string | null {
  const uid = text.replace(/[:\s-]/g, '').toUpperCase();
  return /^[0-9A-F]{8,64}$/.test(uid) ? uid : null;
}

/**
 * Per-entry attribution on SHARED and GRADE_A_B devices (INV-40): a badge tap by the session's own person,
 * with the device proof. TAP_PIN device classes add the PIN (decision D8).
 */
export const Attribution = z.strictObject({
  method: z.literal('BADGE_TAP'),
  badgeUid: z.string().min(1).max(64),
  pin: z.string().min(4).max(PIN_MAX_LENGTH).optional(),
  proof: DeviceProof,
});
export type Attribution = z.infer<typeof Attribution>;

/** Adds the optional attribution member to a FRESH_ON_SHARED route body (the server enforces it on shared devices). */
export function withAttribution<const S extends z.ZodRawShape>(shape: S) {
  return z.strictObject({ ...shape, attribution: Attribution.optional() });
}

// ---------------------------------------------------------------------------------------------
// Refusals

export const REFUSAL_KINDS = [
  'NOT_ENABLED',
  'NOT_ALLOWED',
  'INDEPENDENCE',
  'STALE',
  'BLOCKED_BY_EXCEPTION',
  'AUTH_FAILED',
  'LOCKED',
  'INVALID_INPUT',
  'NOT_SAVED',
  'CONTENT_CHANGED',
  'SWITCH_USER',
] as const;
export const RefusalKind = z.enum(REFUSAL_KINDS);
export type RefusalKind = z.infer<typeof RefusalKind>;

/** Plain-language refusal: what happened, why (the engine's or kernel's own message), what to do, who can help. */
export const Refusal = z.strictObject({
  /** Stable code, e.g. EBMR-IAM-140, ENG-STEP-ORDER, EBMR-PLAT-041, MUST_CHANGE_SECRET. */
  code: z.string().min(1),
  kind: RefusalKind,
  whatHappened: z.string().min(1),
  why: z.string(),
  controls: z.array(z.string()),
  whatYouCanDo: z.array(z.string()),
  whoCanHelp: z.array(z.string()),
  /** Extra facts for the screen, e.g. {switchToLegalName} for SWITCH_USER or {roles} for a role choice. */
  details: z.record(z.string(), z.string()).optional(),
});
export type Refusal = z.infer<typeof Refusal>;

export const RefusalEnvelope = z.strictObject({
  refusal: Refusal,
  correlationId: z.string().min(1),
  retryable: z.boolean(),
});
export type RefusalEnvelope = z.infer<typeof RefusalEnvelope>;

/** HTTP status for each situation (plan section 4). */
export const REFUSAL_STATUS = {
  SCHEMA: 400,
  NO_SESSION: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RULE: 422,
  LOCKED: 423,
  PRECONDITION_REQUIRED: 428,
  TOO_MANY_REQUESTS: 429,
  NOT_IMPLEMENTED: 501,
  UNAVAILABLE: 503,
} as const;

/** Shared small views. */
export const SignableRef = z.strictObject({
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
});
export type SignableRef = z.infer<typeof SignableRef>;

export const Empty = z.strictObject({});
