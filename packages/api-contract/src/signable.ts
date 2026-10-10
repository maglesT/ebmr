/**
 * Signable actions (Phase 2 apps plan section 6). The e-signature endpoints (C1) look up a handler in the
 * server's SignableActionRegistry by `kind`; the handler supplies aggregate, meaning, expected state,
 * previewContent, prepareForChallenge, dryRun and apply.
 *  - ENGINE_COMMAND (C3): a signature-bearing engine intent on a sandbox test run.
 *  - MBR_TRANSITION (C2, A2): prepared, checked, approved and regulatory signatures on an MBR version.
 *  - GMP_BATCH_ISSUE (C3, GMP; Phase 3 slice 2b): the issuer's ISSUED signature on a planned GMP batch's issue content,
 *    and the issue in the same command, with the issuer's own reason (EBMR-AUDIT-002).
 *  - ESIG_STUB: test-only, over the kernel's esig_stub aggregate, so the ceremony is tested before C3 lands.
 */
import { z } from 'zod';
import { DataValueWire, RunVersion, Uuid } from './common.ts';
import { SignedIntent } from './intents.ts';

export const SignableAction = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ENGINE_COMMAND'),
    runId: Uuid,
    /** Run version the person reviewed (optimistic locking; stale gives 409). */
    expectedVersion: RunVersion,
    intent: SignedIntent,
  }),
  z.strictObject({
    kind: z.literal('MBR_TRANSITION'),
    versionId: Uuid,
    transition: z.enum(['SUBMIT', 'CHECK', 'APPROVE', 'REGULATORY_CONFIRM']),
    baseRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('GMP_BATCH_ISSUE'),
    batchId: Uuid,
    /** The issuer's own reason for the issue, both halves (DI-22, DI-24). */
    reason: z.strictObject({ code: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(2000) }),
    variants: z.record(z.string(), z.string()),
    inputs: z.record(z.string(), DataValueWire),
  }),
  z.strictObject({
    kind: z.literal('ESIG_STUB'),
    stubId: Uuid,
  }),
]);
export type SignableAction = z.infer<typeof SignableAction>;
export type SignableKind = SignableAction['kind'];
