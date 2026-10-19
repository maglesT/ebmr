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
import { DeviceProof, Instant, IntegerString, PersonRef, PIN_MAX_LENGTH, Uuid, withAttribution } from '../common.ts';
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

/**
 * India DSC (IN-10; kernel 1203): what the signer's Class 3 token must sign through the local signing bridge, present on a
 * challenge only when its meaning needs a DSC now. `statement` is the exact text (canonical JSON over the challenge, the
 * content hash and the meaning); `banner` is shown while the trust anchor is a test certificate authority.
 */
export const DscRequirementView = z.strictObject({
  mode: z.enum(['TEST_CA', 'LICENSED']),
  statement: z.string().min(1),
  banner: z.string().nullable(),
});
export type DscRequirementView = z.infer<typeof DscRequirementView>;

/** The token's signature over the statement (base64) and its certificate chain (base64 DER, the signer's first, root last). */
export const DscSubmission = z.strictObject({
  signature: z.string().regex(/^[A-Za-z0-9+/=]{40,1400}$/),
  chain: z.array(z.string().regex(/^[A-Za-z0-9+/=]{100,22000}$/)).min(2).max(6),
});
export type DscSubmission = z.infer<typeof DscSubmission>;

export const DscConfigurationView = z.strictObject({
  mode: z.enum(['OFF', 'TEST_CA', 'LICENSED']),
  /** Shown while the anchor is a test certificate authority (decision 0001 item 3). */
  banner: z.string().nullable(),
  anchors: z.array(z.strictObject({ anchorId: Uuid, kind: z.enum(['TEST_CA', 'LICENSED']), label: z.string(), subject: z.string(), rootSha256: z.string(), recordedAt: z.string(), live: z.boolean() })),
  meanings: z.array(z.strictObject({ meaning: z.string(), required: z.boolean() })),
});
export type DscConfigurationView = z.infer<typeof DscConfigurationView>;

/**
 * The signer's own DSC enrolment (kernel 1206; IN-10): a DSC is accepted only from the certificate enrolled for the person
 * who signs. `statement` is what the token signs to enrol (the person and the account); null while the option is off.
 */
export const DscEnrolmentView = z.strictObject({
  statement: z.string().min(1).nullable(),
  banner: z.string().nullable(),
  enrolments: z.array(z.strictObject({
    enrolmentId: Uuid,
    leafSubject: z.string(),
    leafSerial: z.string(),
    leafSha256: z.string(),
    leafValidTo: z.string(),
    anchorLabel: z.string(),
    recordedAt: z.string(),
    live: z.boolean(),
  })),
});
export type DscEnrolmentView = z.infer<typeof DscEnrolmentView>;

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
  /** Phase 6 slice 6f (IN-10): the DSC second signature this meaning needs now. */
  dsc: DscRequirementView.optional(),
});
export type ChallengeView = z.infer<typeof ChallengeView>;

export const SignatureCredentials = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('PIN'), pin: z.string().min(4).max(PIN_MAX_LENGTH) }),
  z.strictObject({ kind: z.literal('PASSWORD'), loginName: z.string().min(1).max(128), password: z.string().min(1).max(256) }),
]);
export type SignatureCredentials = z.infer<typeof SignatureCredentials>;

export const SignOutcomeView = z.strictObject({
  manifestation: ManifestationView,
  /** The handler's result (for ENGINE_COMMAND: the new StepScreenView), or null. */
  result: z.looseObject({}).nullable(),
  /** The second signature row of a two-row ceremony (D-P4-5), when the request carried a companion challenge. */
  companion: ManifestationView.optional(),
});
export type SignOutcomeView = z.infer<typeof SignOutcomeView>;

/**
 * Phase 3 slice 6: the record a signable action signs and the meaning, as the server computes them (the browser never
 * derives an aggregate id, e.g. qc_extra_testing:<batch>/<decision>/<tests>, or a meaning that depends on the record's
 * state, e.g. a lot rejected from quarantine). `meaning` null: the person chooses it (the challenge names it). The
 * signature still binds through the preview, challenge and sign ceremony.
 */
export const SignableDescriptorView = z.strictObject({
  kind: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  meaning: z.string().nullable(),
  expectedState: z.string().nullable(),
  /**
   * Phase 4 slice 4 (D-P4-5): the second record and meaning signed in the same ceremony (the client opens a challenge for
   * each and signs once with `companionChallengeId`); absent for a one-row act.
   */
  companion: z.strictObject({ aggregateType: z.string(), aggregateId: z.string(), meaning: z.string(), expectedState: z.string().nullable() }).optional(),
});
export type SignableDescriptorView = z.infer<typeof SignableDescriptorView>;

// ---------------------------------------------------------------------------------------------
// Phase 7 slice 7g-3 (WP1; decision 0025): the signature catalogue and the seal keys from a screen (kernel 0210, 0220).

const MeaningCategory = z.enum(['MASTER_RECORD', 'BATCH_RECORD', 'EXECUTION', 'VERIFICATION', 'EXCEPTION', 'LOGBOOK', 'LABORATORY', 'REVIEW', 'RELEASE', 'RECORDS']);
const MeaningRoleClass = z.enum(['PERFORMER', 'VERIFIER', 'WITNESS', 'SUPERVISOR', 'AUTHORISER', 'APPROVER', 'REVIEWER', 'RELEASE']);
const MeaningCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
const PermissionCode = z.string().regex(/^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)+$/);
const CatalogueChangeRecord = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'a change-record number (letters, digits, . _ / -)');

/** One signature meaning type in force (its latest version), vendor (minimum) or customer. */
export const MeaningTypeView = z.strictObject({
  code: MeaningCode,
  version: z.string(),
  origin: z.enum(['VENDOR', 'CUSTOMER']),
  status: z.enum(['ACTIVE', 'RETIRED']),
  category: z.string(),
  roleClass: z.string(),
  title: z.string(),
  meaningText: z.string(),
  permissions: z.array(z.string()),
  independentOf: z.array(z.string()),
  excludesPerformers: z.boolean(),
  excludesInvolved: z.boolean(),
  witness: z.boolean(),
  reauth: z.enum(['ALL_COMPONENTS', 'SESSION_RELAXABLE']),
  delegable: z.boolean(),
  definedAt: Instant,
});
export type MeaningTypeView = z.infer<typeof MeaningTypeView>;

/** What a customer type, or a new version of a type, says (members left out keep their value; a new type's defaults are the database's). */
export const MeaningTypeChanges = z.strictObject({
  category: MeaningCategory.optional(),
  roleClass: MeaningRoleClass.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  meaningText: z.string().trim().min(1).max(500).optional(),
  permissions: z.array(PermissionCode).min(1).max(20).optional(),
  independentOf: z.array(MeaningCode).max(20).optional(),
  excludesPerformers: z.boolean().optional(),
  excludesInvolved: z.boolean().optional(),
  witness: z.boolean().optional(),
  reauth: z.enum(['ALL_COMPONENTS', 'SESSION_RELAXABLE']).optional(),
  delegable: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
});
export type MeaningTypeChanges = z.infer<typeof MeaningTypeChanges>;

export const SealKeyView = z.strictObject({
  keyId: z.string(),
  algorithm: z.enum(['HMAC-SHA256', 'ED25519']),
  description: z.string(),
  registeredAt: Instant,
  retired: z.strictObject({ reason: z.string(), at: Instant }).nullable(),
});
export type SealKeyView = z.infer<typeof SealKeyView>;

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
    body: z.strictObject({
      challengeId: Uuid,
      credentials: SignatureCredentials,
      proof: DeviceProof,
      action: SignableAction,
      /**
       * Phase 4 slice 4 (D-P4-5): the second challenge of a two-row ceremony (the descriptor names its record and meaning).
       * The credentials are entered once; each challenge gets its own authentication event and signature row, in one
       * command with the act.
       */
      companionChallengeId: Uuid.optional(),
      /** Phase 6 slice 6f (IN-10): the DSC over the challenge's statement, when the challenge asked for one. */
      dsc: DscSubmission.optional(),
    }),
    response: SignOutcomeView,
  }),
  describe: defineRoute({
    id: 'esig.describe',
    method: 'POST',
    path: '/api/esig/describe',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'What a signable action signs (aggregate, meaning, expected state), computed by the server for the action as the person would send it (one call per choice)',
    body: z.strictObject({ action: SignableAction }),
    response: SignableDescriptorView,
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
  dscConfiguration: defineRoute({
    id: 'esig.dscConfiguration',
    method: 'GET',
    path: '/api/esig/dsc',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The India DSC option: its mode, trust anchors and the meanings that need a DSC (IN-10)',
    response: DscConfigurationView,
  }),
  setDscMode: defineRoute({
    id: 'esig.setDscMode',
    method: 'POST',
    path: '/api/esig/dsc/mode',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Switch the India DSC option (OFF, TEST_CA; LICENSED stays refused until a licensed provider is configured) under a change record (QA)',
    body: withAttribution({ mode: z.enum(['OFF', 'TEST_CA', 'LICENSED']), changeRecord: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/), reason: z.string().trim().min(1).max(2000) }),
    response: DscConfigurationView,
  }),
  registerDscAnchor: defineRoute({
    id: 'esig.registerDscAnchor',
    method: 'POST',
    path: '/api/esig/dsc/anchors',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Register the trust anchor (root certificate, base64 DER) DSC chains must end at; TEST_CA only in v1 (QA, change record)',
    body: withAttribution({
      kind: z.enum(['TEST_CA', 'LICENSED']),
      label: z.string().trim().min(1).max(200),
      rootCertificate: z.string().regex(/^[A-Za-z0-9+/=]{100,22000}$/),
      changeRecord: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/),
      reason: z.string().trim().min(1).max(2000),
    }),
    response: DscConfigurationView,
  }),
  setDscMeaning: defineRoute({
    id: 'esig.setDscMeaning',
    method: 'POST',
    path: '/api/esig/dsc/meanings',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Whether a signature meaning needs a DSC while the option is on (QA, change record)',
    body: withAttribution({ meaning: z.string().min(1).max(64), required: z.boolean(), changeRecord: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/), reason: z.string().trim().min(1).max(2000) }),
    response: DscConfigurationView,
  }),
  dscEnrolment: defineRoute({
    id: 'esig.dscEnrolment',
    method: 'GET',
    path: '/api/esig/dsc/enrolment',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The signed-in person\'s DSC enrolments and the statement their token signs to enrol a certificate (IN-10)',
    response: DscEnrolmentView,
  }),
  enrolDsc: defineRoute({
    id: 'esig.enrolDsc',
    method: 'POST',
    path: '/api/esig/dsc/enrolment',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Enrol the certificate of your own token: its signature over the enrolment statement and its chain (IN-10)',
    body: withAttribution({ dsc: DscSubmission }),
    response: DscEnrolmentView,
  }),
  endDscEnrolment: defineRoute({
    id: 'esig.endDscEnrolment',
    method: 'POST',
    path: '/api/esig/dsc/enrolment/end',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'End a DSC enrolment (a lost token, a new certificate): your own, or anyone\'s as QA (IN-10)',
    body: withAttribution({ enrolmentId: Uuid, reason: z.string().trim().min(1).max(2000) }),
    response: DscEnrolmentView,
  }),
  meaningTypes: defineRoute({
    id: 'esig.meaningTypes',
    method: 'GET',
    path: '/api/esig/meaning-types',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The signature catalogue: every meaning type in force (latest version), the vendor minimum set and the customer types',
    response: z.strictObject({ meaningTypes: z.array(MeaningTypeView) }),
  }),
  addMeaningType: defineRoute({
    id: 'esig.addMeaningType',
    method: 'POST',
    path: '/api/esig/meaning-types',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'A customer signature point: a new meaning type under an approved change record covering ESIG_MEANING (MBR.APPROVE)',
    body: z.strictObject({
      code: MeaningCode,
      definition: MeaningTypeChanges.extend({ category: MeaningCategory, roleClass: MeaningRoleClass, title: z.string().trim().min(1).max(200), meaningText: z.string().trim().min(1).max(500), permissions: z.array(PermissionCode).min(1).max(20) }).omit({ status: true }),
      changeRecord: CatalogueChangeRecord,
      reason: z.string().trim().min(1).max(2000),
    }),
    response: MeaningTypeView,
  }),
  configureMeaningType: defineRoute({
    id: 'esig.configureMeaningType',
    method: 'POST',
    path: '/api/esig/meaning-types/:code',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'A new version of a meaning type (who may sign, independence, re-authentication; a customer type retired) under an approved change record (MBR.APPROVE)',
    params: z.strictObject({ code: MeaningCode }),
    body: z.strictObject({ changes: MeaningTypeChanges, changeRecord: CatalogueChangeRecord, reason: z.string().trim().min(1).max(2000) }),
    response: MeaningTypeView,
  }),
  sealKeys: defineRoute({
    id: 'esig.sealKeys',
    method: 'GET',
    path: '/api/esig/seal-keys',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The record-seal keys of the installation, each with its retirement',
    response: z.strictObject({ sealKeys: z.array(SealKeyView) }),
  }),
  retireSealKey: defineRoute({
    id: 'esig.retireSealKey',
    method: 'POST',
    path: '/api/esig/seal-keys/:keyId/retire',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Retire a record-seal key, with the reason and the change record it is done under (SYSTEM.CONFIGURE)',
    params: z.strictObject({ keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/) }),
    body: z.strictObject({ changeRecord: CatalogueChangeRecord, reason: z.string().trim().min(1).max(2000) }),
    response: z.strictObject({ sealKeys: z.array(SealKeyView) }),
  }),
} as const;
