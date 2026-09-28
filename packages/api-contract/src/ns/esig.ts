/**
 * Namespace `esig` (C1): the e-signature ceremony (Phase 2 apps plan section 6).
 *  1. GET content: the exact canonical text to be signed (for engine actions, a pure preview of the step as
 *     it will be after the sweep and finalisation), its hash and next content version.
 *  2. POST challenges: a command attributed by the signer's tap on a kiosk; refuses a client hash that does
 *     not match (EBMR-ESIG-013, "The record changed while you were reviewing it").
 *  3. POST sign: credentials once, then dry-run, seal and apply in one idempotent command.
 * Secrets are never cached, logged or re-sent; a lost response reloads the signatures instead.
 */
import { z } from 'zod';
import { DeviceProof, Instant, IntegerString, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';
import { SignableAction } from '../signable.ts';

/** A signature as the manifestation shows it (DI-36): name, user ID, role, meaning, date and time with offset and zone. */
export const ManifestationView = z.strictObject({
  signatureId: Uuid,
  signer: PersonRef,
  meaning: z.string().min(1),
  /** Plain-language meaning, e.g. "Performed by", "Verified by". */
  meaningText: z.string().min(1),
  signedAt: Instant,
  zone: z.string(),
  /** False once superseded by a new content version or invalidated (INV-09). */
  valid: z.boolean(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  contentVersion: IntegerString,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ManifestationView = z.infer<typeof ManifestationView>;

export const SignableContentView = z.strictObject({
  aggregateType: z.string(),
  aggregateId: z.string(),
  /** The content version the challenge must name (the next one when a preview will add a PREPARE row). */
  contentVersion: IntegerString,
  /** The exact canonical text; the client hashes it with expr sha256Hex and shows it in a disclosure. */
  canonicalText: z.string(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  meaning: z.string(),
  meaningText: z.string(),
  title: z.string(),
  /** True when the text is a pure preview (the state will be prepared at challenge time). */
  preview: z.boolean(),
  /** Renderer input: `kind` batch_step, batch_stage, mbr_version or fallback, plus its data. */
  rendering: z.looseObject({ kind: z.string() }),
});
export type SignableContentView = z.infer<typeof SignableContentView>;

export const SignatureComponent = z.enum(['USER_ID', 'PASSWORD', 'PIN']);

export const ChallengeView = z.strictObject({
  challengeId: Uuid,
  aggregateType: z.string(),
  aggregateId: z.string(),
  contentVersion: IntegerString,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  meaning: z.string(),
  expiresAt: Instant,
  expiresInSeconds: z.number().int().positive(),
  /** What the signer must enter now: PIN on a kiosk (the badge was tapped for the challenge); user ID and password in the office. */
  requires: z.array(SignatureComponent).min(1),
  /** The manifestation as it will appear (legal name, user ID, role, meaning, zone), shown before signing. */
  manifestation: z.strictObject({
    legalName: z.string(),
    loginName: z.string(),
    role: z.string(),
    meaning: z.string(),
    meaningText: z.string(),
    zone: z.string(),
  }),
});
export type ChallengeView = z.infer<typeof ChallengeView>;

export const SignatureCredentials = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('PIN'), pin: z.string().min(4).max(12) }),
  z.strictObject({ kind: z.literal('PASSWORD'), loginName: z.string().min(1).max(128), password: z.string().min(1).max(256) }),
]);
export type SignatureCredentials = z.infer<typeof SignatureCredentials>;

export const SignOutcomeView = z.strictObject({
  manifestation: ManifestationView,
  /** The handler's result (for ENGINE_COMMAND: the new StepScreenView), or null. */
  result: z.looseObject({}).nullable(),
});
export type SignOutcomeView = z.infer<typeof SignOutcomeView>;

export const esig = {
  content: defineRoute({
    id: 'esig.content',
    method: 'GET',
    path: '/api/esig/content',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The exact content to be signed, its hash and content version (a pure preview for engine actions)',
    query: z.strictObject({ aggregateType: z.string().min(1), aggregateId: z.string().min(1), intent: z.string().min(1) }),
    response: SignableContentView,
  }),
  createChallenge: defineRoute({
    id: 'esig.createChallenge',
    method: 'POST',
    path: '/api/esig/challenges',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Prepare the record at database time and open a 120 s signing challenge for the reviewed content hash',
    body: withAttribution({
      aggregateType: z.string().min(1),
      aggregateId: z.string().min(1),
      contentVersion: IntegerString,
      meaning: z.string().min(1),
      clientContentHash: z.string().regex(/^[0-9a-f]{64}$/),
      action: SignableAction,
    }),
    response: ChallengeView,
  }),
  sign: defineRoute({
    id: 'esig.sign',
    method: 'POST',
    path: '/api/esig/sign',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    summary: 'Authenticate the signer for the challenge, then dry-run, seal and apply in one command',
    body: z.strictObject({ challengeId: Uuid, credentials: SignatureCredentials, proof: DeviceProof, action: SignableAction }),
    response: SignOutcomeView,
  }),
  signatures: defineRoute({
    id: 'esig.signatures',
    method: 'GET',
    path: '/api/esig/signatures',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'Signatures on an aggregate, with their validity',
    query: z.strictObject({ aggregateType: z.string().min(1), aggregateId: z.string().min(1) }),
    response: z.strictObject({ signatures: z.array(ManifestationView) }),
  }),
} as const;
