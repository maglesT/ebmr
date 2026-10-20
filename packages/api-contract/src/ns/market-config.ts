/**
 * Namespace `marketConfig` (Phase 7 slice 7g, work package WP3; decision 0025: every act has a screen): the master-record,
 * compendial, market and plant configuration acts that had a database function and no route. Every route runs the
 * database's own function under the person's named account; the database checks the right and every rule, and its refusal
 * is answered in its own words.
 *
 *  - master records: the regulatory assessment of an MBR change per market and its validation assessment
 *    (`recipe.add_change_regulatory`, `recipe.add_change_validation`; MBR.CHANGE_RECORD; PR-04), the periodic review of an
 *    approved version (`recipe.record_periodic_review`; MBR.APPROVE; PR-05), unlinking a risk assessment from a draft
 *    (`recipe.unlink_risk_assessment`; MBR.AUTHOR); the EU qualified-person register is signed (signable QP_REGISTER,
 *    meaning QP_REGISTERED, `recipe.register_qp`; RECORD.QA_REVIEW; ST-10);
 *  - a new master record (slice 7h, B1-B4): raising its change record and recording a risk assessment
 *    (`recipe.record_change_record`, `recipe.record_risk_assessment`; MBR.CHANGE_RECORD), linking the assessment to the
 *    draft and setting the draft's change record, effective-from and review due (`recipe.link_risk_assessment`,
 *    `recipe.set_draft_attributes`; MBR.AUTHOR), and importing the sandbox test-run result as SANDBOX_RUN evidence
 *    (`recipe.record_evidence`; MBR.AUTHOR; decision D-P7R-16: hash and sandbox stamp checked, a test package GMP
 *    exported for this version on its current content);
 *  - compendial rule sets: QA records the verification of a rule set version against the official text
 *    (`tab.record_rule_set_verification`) and signs it (signable RULE_SET_VERIFY, meaning COMPENDIAL_RULE_SET_VERIFIED,
 *    `tab.sign_rule_set_verification`; MBR.APPROVE; IN-34); a reference document version is retired or withdrawn with a
 *    reason (`tab.retire_reference_document`; MASTERDATA.CHANGE);
 *  - market policies (decision D-P7R-3: they stay in v1.0) and site values: a policy is defined and given new versions
 *    under a change record that covers area MARKET_POLICY (DI-09); a loosening needs another person's
 *    POLICY_LOOSENING_APPROVED signature (signable MARKET_LOOSENING), which the server finds on the version's record and
 *    the database checks (INV-47); a tightening already in force is applied to an issued batch with a change reference
 *    and a reason (MARKET.POLICY_TIGHTEN_BATCH). A site value is set under a change record covering area SITE_VALUE; a
 *    loosening of a guidance value needs a justification reference and QA's SITE_VALUE_LOOSENING_APPROVED signature
 *    (signable MARKET_LOOSENING; IN-52, ST-01). The batch issue pins the policies in force (market.pin_policies_for_batch,
 *    run inside the GMP batch issue, never from a screen);
 *  - plant: alarm codes (GMP-critical, deviation required; DI-49), equipment campaigns (IN-26), the maximum age of a
 *    utility feed's reading, and the line isolations of the blister register (IN-38); MASTERDATA.CHANGE.
 */
import { z } from 'zod';
import { CalendarDate, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';
import { ChangeRecordNumber, IsoInstant } from './config.ts';

const Text = (max: number) => z.string().trim().min(1).max(max);
const Code = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'a code of letters, digits, dot, underscore or hyphen');
const UpperCode = z.string().regex(/^[A-Z][A-Z0-9_.-]{0,63}$/, 'an upper-case code');
const IsoDate = CalendarDate('a date as YYYY-MM-DD');
const MarketCode = z.string().regex(/^[A-Z]{2}$/, 'a two-letter market code');
const PositiveWhole = (max: number) => z.string().regex(/^[1-9][0-9]{0,5}$/, 'a whole number').refine((s) => BigInt(s) <= BigInt(max), `at most ${String(max)}`);

// ---------------------------------------------------------------------------------------------
// Master records
// ---------------------------------------------------------------------------------------------

export const MbrChangeRecordView = z.strictObject({
  changeRecordId: Uuid,
  number: z.string(),
  title: z.string(),
  changeClass: z.string(),
  processImpacting: z.boolean(),
  recordedAt: Instant,
  validations: z.array(z.strictObject({ id: Uuid, validationRef: z.string(), description: z.string().nullable(), recordedBy: PersonRef, recordedAt: Instant })),
  regulatory: z.array(z.strictObject({ id: Uuid, market: z.string(), reportingCategory: z.string(), reference: z.string().nullable(), recordedBy: PersonRef, recordedAt: Instant })),
});
export type MbrChangeRecordView = z.infer<typeof MbrChangeRecordView>;

export const PeriodicReviewOutcome = z.enum(['NO_CHANGE', 'REVISION_REQUIRED', 'RETIREMENT_PROPOSED']);
export const MbrReviewView = z.strictObject({
  versionId: Uuid,
  state: z.string(),
  reviews: z.array(z.strictObject({ reviewId: Uuid, outcome: PeriodicReviewOutcome, summary: z.string(), nextDue: z.string(), reviewedBy: PersonRef, recordedAt: Instant })),
  riskAssessments: z.array(z.strictObject({ riskAssessmentId: Uuid, code: z.string(), version: z.string(), riskClass: z.string(), rationaleRef: z.string(), subjects: z.array(z.string()) })),
  /** Slice 7h (B3): the draft's attributes, set by the author (recipe.set_draft_attributes; PR-02, PR-05, PR-06). */
  draft: z.strictObject({
    changeRecord: z.strictObject({ changeRecordId: Uuid, number: z.string(), title: z.string() }).nullable(),
    effectiveFrom: Instant.nullable(),
    reviewDue: z.string().nullable(),
  }),
  /** Slice 7h (B4): the verification evidence of the exact current content (recipe.evidence_status; DI-04). */
  evidence: z.strictObject({
    contentHash: z.string(),
    complete: z.boolean(),
    missing: z.array(z.string()),
    items: z.array(z.strictObject({ kind: z.enum(['VALIDATOR', 'VERIFICATION', 'TEST_VECTORS', 'SANDBOX_RUN']), result: z.enum(['PASS', 'FAIL']), problems: z.array(z.string()) })),
  }),
});
export type MbrReviewView = z.infer<typeof MbrReviewView>;

/** Slice 7h (B2): a recorded risk assessment (recipe.record_risk_assessment; MBR.CHANGE_RECORD; PR-07). */
export const RiskAssessmentView = z.strictObject({
  riskAssessmentId: Uuid,
  code: z.string(),
  version: z.string(),
  title: z.string(),
  riskClass: z.string(),
  rationaleRef: z.string(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type RiskAssessmentView = z.infer<typeof RiskAssessmentView>;

/**
 * Slice 7h (B4, decision D-P7R-16): a sandbox test-run result (`ebmr.test-run-result` v1) in the GMP exchange inbox
 * `to-gmp/` for this version, as the importer's checks find it (problem null when it can be imported).
 */
export const SandboxRunResultView = z.strictObject({
  fileName: z.string(),
  resultHash: z.string(),
  runId: z.string(),
  batchNumber: z.string(),
  runStatus: z.string(),
  passed: z.boolean(),
  contentHash: z.string(),
  exportedAt: Instant,
  exporter: z.string(),
  imported: z.boolean(),
  problem: z.string().nullable(),
});
export type SandboxRunResultView = z.infer<typeof SandboxRunResultView>;

export const QpRegisterView = z.strictObject({
  importers: z.array(z.strictObject({ code: z.string(), name: z.string(), miaNumber: z.string() })),
  /** People who hold the EU qualified-person role now (the candidates to register). */
  candidates: z.array(PersonRef),
  entries: z.array(z.strictObject({ entryId: Uuid, person: PersonRef, action: z.enum(['REGISTER', 'WITHDRAW']), importerCode: z.string(), miaNumber: z.string(), by: PersonRef, recordedAt: Instant })),
});
export type QpRegisterView = z.infer<typeof QpRegisterView>;

// ---------------------------------------------------------------------------------------------
// Compendial rule sets and reference documents
// ---------------------------------------------------------------------------------------------

export const RuleSetVerificationView = z.strictObject({
  code: z.string(),
  version: z.number().int(),
  test: z.string(),
  pharmacopoeia: z.string(),
  markets: z.array(z.string()),
  confidence: z.string(),
  source: z.string(),
  /** Why the version is not verified now, or null when its latest verification is signed and valid. */
  problem: z.string().nullable(),
  verification: z
    .strictObject({ verificationId: Uuid, documentRef: z.string(), note: z.string(), recordedBy: PersonRef, recordedAt: Instant, signedBy: PersonRef.nullable(), signedAt: Instant.nullable() })
    .nullable(),
});
export type RuleSetVerificationView = z.infer<typeof RuleSetVerificationView>;

// ---------------------------------------------------------------------------------------------
// Market policies and site values
// ---------------------------------------------------------------------------------------------

export const MarketPolicyView = z.strictObject({
  code: z.string(),
  title: z.string(),
  level: z.enum(['VENDOR', 'TENANT']),
  controls: z.array(z.string()),
  /** Least strict first. */
  positions: z.array(z.string()),
  defaultPosition: z.string(),
  looseningRequires: z.string(),
  /** The position in force now. */
  current: z.string().nullable(),
  versions: z.array(
    z.strictObject({
      versionId: Uuid,
      version: z.number().int(),
      position: z.string(),
      direction: z.enum(['INITIAL', 'TIGHTENING', 'LOOSENING', 'UNCHANGED']),
      effectiveFrom: Instant,
      recordedAt: Instant,
      author: PersonRef,
      approver: PersonRef.nullable(),
      changeRef: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});
export type MarketPolicyView = z.infer<typeof MarketPolicyView>;

export const BatchPoliciesView = z.strictObject({
  batchId: Uuid,
  pins: z.array(z.strictObject({ policy: z.string(), pinKind: z.enum(['ISSUE', 'TIGHTENING']), version: z.number().int(), position: z.string(), issueInstant: Instant, recordedAt: Instant, changeRef: z.string().nullable(), reason: z.string().nullable() })),
});
export type BatchPoliciesView = z.infer<typeof BatchPoliciesView>;

export const SiteValuesView = z.strictObject({
  sites: z.array(z.strictObject({ siteId: Uuid, code: z.string(), markets: z.array(z.string()) })),
  values: z.array(
    z.strictObject({
      siteValueId: Uuid,
      site: z.string(),
      key: z.string(),
      /** The value as text (a decimal, a category, true or false). */
      value: z.string(),
      unit: z.string(),
      effectiveFrom: z.string(),
      outcome: z.enum(['TIGHTER', 'EQUAL', 'LOOSENED']),
      justificationRef: z.string().nullable(),
      qaApprover: PersonRef.nullable(),
      recordedBy: PersonRef,
      recordedAt: Instant,
    }),
  ),
});
export type SiteValuesView = z.infer<typeof SiteValuesView>;

export const SiteValuePreviewView = z.strictObject({
  outcome: z.enum(['TIGHTER', 'EQUAL', 'LOOSENING', 'REFUSED']),
  code: z.string().nullable(),
  message: z.string().nullable(),
  /** The value the rule tables resolve for this site, as text, and its floor type. */
  resolvedValue: z.string().nullable(),
  floorType: z.string().nullable(),
  /** A loosening with a justification reference: whether QA's approval of exactly it is signed (valid) now. */
  approvalSigned: z.boolean(),
});
export type SiteValuePreviewView = z.infer<typeof SiteValuePreviewView>;

// ---------------------------------------------------------------------------------------------
// Plant
// ---------------------------------------------------------------------------------------------

export const AlarmCodeView = z.strictObject({
  source: z.enum(['EBMR', 'OPCUA', 'EMS']),
  code: z.string(),
  version: z.number().int(),
  gmpCritical: z.boolean(),
  deviationRequired: z.boolean(),
  description: z.string(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type AlarmCodeView = z.infer<typeof AlarmCodeView>;

export const CampaignView = z.strictObject({
  campaignId: Uuid,
  equipmentCode: z.string().nullable(),
  areaCode: z.string().nullable(),
  product: z.string(),
  maxBatches: z.string(),
  maxDays: z.string(),
  validationRef: z.string(),
  openedBy: PersonRef,
  openedAt: Instant,
  closedBy: PersonRef.nullable(),
  closedAt: Instant.nullable(),
  closeReason: z.string().nullable(),
});
export type CampaignView = z.infer<typeof CampaignView>;

export const UtilityFeedAgeView = z.strictObject({
  classCode: z.string(),
  /** The maximum age in whole minutes, as text. */
  maxAgeMinutes: z.string(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type UtilityFeedAgeView = z.infer<typeof UtilityFeedAgeView>;

export const LineIsolationView = z.strictObject({ isolationId: Uuid, area: z.string(), isolated: z.boolean(), reference: z.string(), recordedBy: PersonRef, recordedAt: Instant });
export type LineIsolationView = z.infer<typeof LineIsolationView>;

export const PlantConfigView = z.strictObject({
  alarmCodes: z.array(AlarmCodeView),
  campaigns: z.array(CampaignView),
  feedAges: z.array(UtilityFeedAgeView),
  utilityClasses: z.array(z.string()),
  lineIsolations: z.array(LineIsolationView),
  lines: z.array(z.string()),
});
export type PlantConfigView = z.infer<typeof PlantConfigView>;

const ConfigChange = { changeRecord: ChangeRecordNumber, reason: Text(2000) };
const changeRecordParams = z.strictObject({ changeRecordId: Uuid });
const versionParams = z.strictObject({ versionId: Uuid });
const ruleSetParams = z.strictObject({ code: z.string().regex(/^[A-Z][A-Z-]{1,39}$/), version: z.string().regex(/^[1-9][0-9]{0,8}$/) });

export const marketConfig = {
  // Master records
  changeRecords: defineRoute({
    id: 'marketConfig.changeRecords', method: 'GET', path: '/api/mbr/change-records', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The MBR change records with their validation and per-market regulatory assessments (PR-04)',
    response: z.strictObject({ changeRecords: z.array(MbrChangeRecordView) }),
  }),
  addChangeRegulatory: defineRoute({
    id: 'marketConfig.addChangeRegulatory', method: 'POST', path: '/api/mbr/change-records/:changeRecordId/regulatory', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Record the regulatory assessment of an MBR change for one market: its reporting category and reference (MBR.CHANGE_RECORD; PR-04)',
    params: changeRecordParams,
    body: withAttribution({ market: MarketCode, reportingCategory: Text(120), reference: Text(200).optional() }),
    response: MbrChangeRecordView,
  }),
  addChangeValidation: defineRoute({
    id: 'marketConfig.addChangeValidation', method: 'POST', path: '/api/mbr/change-records/:changeRecordId/validation', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Record the validation assessment of an MBR change: the validation it rests on (MBR.CHANGE_RECORD)',
    params: changeRecordParams,
    body: withAttribution({ validationRef: Text(200), description: Text(2000).optional() }),
    response: MbrChangeRecordView,
  }),
  versionReview: defineRoute({
    id: 'marketConfig.versionReview', method: 'GET', path: '/api/mbr/versions/:versionId/review', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The periodic reviews of an MBR version and the risk assessments linked to it now (PR-05, PR-07)',
    params: versionParams, response: MbrReviewView,
  }),
  recordPeriodicReview: defineRoute({
    id: 'marketConfig.recordPeriodicReview', method: 'POST', path: '/api/mbr/versions/:versionId/periodic-reviews', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Record the periodic review of an approved MBR version with its outcome and the next due date (MBR.APPROVE; PR-05)',
    params: versionParams,
    body: withAttribution({ outcome: PeriodicReviewOutcome, summary: Text(2000), nextDue: IsoDate }),
    response: MbrReviewView,
  }),
  // Slice 7h (B1-B4): the acts a new master record needs before its Prepared signature.
  recordChangeRecord: defineRoute({
    id: 'marketConfig.recordChangeRecord', method: 'POST', path: '/api/mbr/change-records', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Raise the change record of a master-record change: number, title, class, process impact and optionally its validation (recipe.record_change_record; MBR.CHANGE_RECORD; PR-06)',
    body: withAttribution({
      number: ChangeRecordNumber,
      title: Text(200),
      changeClass: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
      processImpacting: z.boolean(),
      qmsReference: Text(120).optional(),
      validationRef: Text(200).optional(),
      validationDescription: Text(2000).optional(),
    }),
    response: MbrChangeRecordView,
  }),
  riskAssessments: defineRoute({
    id: 'marketConfig.riskAssessments', method: 'GET', path: '/api/mbr/risk-assessments', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The recorded risk assessments a draft can be linked to (PR-07)',
    response: z.strictObject({ riskAssessments: z.array(RiskAssessmentView) }),
  }),
  recordRiskAssessment: defineRoute({
    id: 'marketConfig.recordRiskAssessment', method: 'POST', path: '/api/mbr/risk-assessments', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Record a versioned risk assessment: code, version, title, risk class and the rationale reference (recipe.record_risk_assessment; MBR.CHANGE_RECORD; PR-07)',
    body: withAttribution({ code: Code, version: Text(20), title: Text(200), riskClass: Text(40), rationaleRef: Text(200) }),
    response: RiskAssessmentView,
  }),
  linkRiskAssessment: defineRoute({
    id: 'marketConfig.linkRiskAssessment', method: 'POST', path: '/api/mbr/versions/:versionId/risk-assessments', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Link a risk assessment to a draft MBR version, for the whole master or for listed elements (recipe.link_risk_assessment; MBR.AUTHOR; PR-07)',
    params: versionParams,
    body: withAttribution({ riskAssessmentId: Uuid, subjects: z.array(Code).max(200).optional() }),
    response: MbrReviewView,
  }),
  setDraftAttributes: defineRoute({
    id: 'marketConfig.setDraftAttributes', method: 'POST', path: '/api/mbr/versions/:versionId/draft-attributes', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Set the draft\'s change record, effective-from instant and periodic-review due date; a member left out keeps its value (recipe.set_draft_attributes; MBR.AUTHOR; PR-02, PR-05, PR-06)',
    params: versionParams,
    body: withAttribution({ changeRecordId: Uuid.nullable().optional(), effectiveFrom: IsoInstant.nullable().optional(), reviewDue: IsoDate.nullable().optional() }),
    response: MbrReviewView,
  }),
  sandboxRunResults: defineRoute({
    id: 'marketConfig.sandboxRunResults', method: 'GET', path: '/api/mbr/versions/:versionId/sandbox-run-results', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The sandbox test-run results for this version in the exchange inbox to-gmp, with the importer\'s checks (DI-05, INV-18)',
    params: versionParams,
    response: z.strictObject({ results: z.array(SandboxRunResultView) }),
  }),
  importSandboxRunResult: defineRoute({
    id: 'marketConfig.importSandboxRunResult', method: 'POST', path: '/api/mbr/versions/:versionId/sandbox-run-results', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Import a sandbox test-run result (from the exchange inbox by its file name, or uploaded as its text): hash and sandbox stamp checked, a test package GMP exported for this version on its current content, recorded as SANDBOX_RUN evidence (recipe.record_evidence; MBR.AUTHOR; DI-04, DI-05, INV-18)',
    params: versionParams,
    body: withAttribution({ fileName: z.string().regex(/^[0-9a-f]{64}\.json$/, 'a result file name <resultHash>.json').optional(), text: z.string().min(2).max(1_000_000).optional() }),
    response: MbrReviewView,
  }),
  unlinkRiskAssessment: defineRoute({
    id: 'marketConfig.unlinkRiskAssessment', method: 'POST', path: '/api/mbr/versions/:versionId/risk-assessments/:riskAssessmentId/unlink', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Unlink a risk assessment from a draft MBR version (MBR.AUTHOR; PR-07)',
    params: z.strictObject({ versionId: Uuid, riskAssessmentId: Uuid }),
    body: withAttribution({}),
    response: MbrReviewView,
  }),
  qpRegister: defineRoute({
    id: 'marketConfig.qpRegister', method: 'GET', path: '/api/qp-register', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The EU qualified-person register: entries, the registered importers and the people who may be registered; registering is signed (QP_REGISTER)',
    response: QpRegisterView,
  }),
  // Compendial rule sets and reference documents
  ruleSets: defineRoute({
    id: 'marketConfig.ruleSets', method: 'GET', path: '/api/compendial-rule-sets', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The compendial rule set versions with QA\'s verification against the official text and its signature (IN-34)',
    response: z.strictObject({ ruleSets: z.array(RuleSetVerificationView) }),
  }),
  recordRuleSetVerification: defineRoute({
    id: 'marketConfig.recordRuleSetVerification', method: 'POST', path: '/api/compendial-rule-sets/:code/:version/verification', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Record QA\'s verification of a rule set version against the official text (MBR.APPROVE); the same person then signs it (RULE_SET_VERIFY)',
    params: ruleSetParams,
    body: withAttribution({ documentRef: Text(200), note: Text(2000) }),
    response: RuleSetVerificationView,
  }),
  retireReferenceDocument: defineRoute({
    id: 'marketConfig.retireReferenceDocument', method: 'POST', path: '/api/reference-documents/:documentId/retirement', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Retire or withdraw a reference document version from a date, with the reason (MASTERDATA.CHANGE)',
    params: z.strictObject({ documentId: Uuid }),
    body: withAttribution({ status: z.enum(['RETIRED', 'WITHDRAWN']), effectiveFrom: IsoDate, reason: Text(2000) }),
    response: z.strictObject({ retirementId: Uuid }),
  }),
  // Market policies and site values
  policies: defineRoute({
    id: 'marketConfig.policies', method: 'GET', path: '/api/market/policies', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The market policy switches with every version, its author and, for a loosening, its approver (INV-47)',
    response: z.strictObject({ policies: z.array(MarketPolicyView) }),
  }),
  definePolicy: defineRoute({
    id: 'marketConfig.definePolicy', method: 'POST', path: '/api/market/policies', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Define a tenant policy switch; its version 1 is the default position, in force now (MARKET.POLICY_CHANGE, under a change record: DI-09)',
    body: withAttribution({
      code: Code, title: Text(200), controls: z.array(z.string().regex(/^[A-Z]{2,3}-[0-9]{2}$/)).max(20).default([]),
      positions: z.array(UpperCode).min(2).max(10), defaultPosition: UpperCode, looseningRequires: z.enum(['QA_APPROVAL', 'CHANGE_CONTROL']), ...ConfigChange,
    }),
    response: MarketPolicyView,
  }),
  setPolicyVersion: defineRoute({
    id: 'marketConfig.setPolicyVersion', method: 'POST', path: '/api/market/policies/:code/versions', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'A new version of a policy from now or a later instant; a loosening needs another person\'s approval signature (MARKET_LOOSENING) and a change reference (INV-47, DI-09)',
    params: z.strictObject({ code: Code }),
    body: withAttribution({ position: UpperCode, effectiveFrom: IsoInstant.optional(), changeRef: Text(120), ...ConfigChange }),
    response: MarketPolicyView,
  }),
  batchPolicies: defineRoute({
    id: 'marketConfig.batchPolicies', method: 'GET', path: '/api/market/batches/:batchId/policies', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The policy versions a batch pinned at issue and every tightening applied since (INV-47)',
    params: z.strictObject({ batchId: Uuid }), response: BatchPoliciesView,
  }),
  applyPolicyTightening: defineRoute({
    id: 'marketConfig.applyPolicyTightening', method: 'POST', path: '/api/market/batches/:batchId/policies/:code/tightening', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Apply a stricter policy version already in force to an issued batch, with the change reference and the reason (MARKET.POLICY_TIGHTEN_BATCH; INV-47)',
    params: z.strictObject({ batchId: Uuid, code: Code }),
    body: withAttribution({ versionId: Uuid, changeRef: Text(120), reason: Text(2000) }),
    response: BatchPoliciesView,
  }),
  siteValues: defineRoute({
    id: 'marketConfig.siteValues', method: 'GET', path: '/api/market/site-values', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The sites of the market configuration and every site value recorded (IN-52, ST-01)',
    response: SiteValuesView,
  }),
  previewSiteValue: defineRoute({
    id: 'marketConfig.previewSiteValue', method: 'GET', path: '/api/market/site-values/preview', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'What setting a site value would decide (tighter, equal, a loosening that needs approval, or refused), without writing anything',
    query: z.strictObject({ site: Code, key: Code, value: Text(64), effectiveFrom: IsoDate, justificationRef: Text(120).optional() }),
    response: SiteValuePreviewView,
  }),
  setSiteValue: defineRoute({
    id: 'marketConfig.setSiteValue', method: 'POST', path: '/api/market/site-values', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Set a site value for a rule key from a date (MARKET.SITE_VALUE_SET, under a change record); a loosening needs a justification reference and QA\'s approval signature',
    body: withAttribution({ site: Code, key: Code, value: Text(64), effectiveFrom: IsoDate, justificationRef: Text(120).optional(), ...ConfigChange }),
    response: SiteValuesView,
  }),
  // Plant
  plantConfig: defineRoute({
    id: 'marketConfig.plantConfig', method: 'GET', path: '/api/plant/configuration', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The plant configuration: alarm codes, equipment campaigns, utility feed ages and line isolations',
    response: PlantConfigView,
  }),
  defineAlarmCode: defineRoute({
    id: 'marketConfig.defineAlarmCode', method: 'POST', path: '/api/plant/alarm-codes', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Configure a plant alarm code (a new version): whether it is GMP-critical and whether a deviation must be cited (MASTERDATA.CHANGE; DI-49)',
    body: withAttribution({ source: z.enum(['EBMR', 'OPCUA', 'EMS']), code: UpperCode, gmpCritical: z.boolean(), deviationRequired: z.boolean(), description: Text(500) }),
    response: PlantConfigView,
  }),
  openCampaign: defineRoute({
    id: 'marketConfig.openCampaign', method: 'POST', path: '/api/plant/campaigns', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Open an equipment campaign on one process unit or one room for a product, with its limits and the validation of its cleaning interval (MASTERDATA.CHANGE; IN-26)',
    body: withAttribution({ equipmentCode: Code.optional(), areaCode: Code.optional(), product: Code, maxBatches: PositiveWhole(1000), maxDays: PositiveWhole(366), validationRef: Text(200) }),
    response: PlantConfigView,
  }),
  closeCampaign: defineRoute({
    id: 'marketConfig.closeCampaign', method: 'POST', path: '/api/plant/campaigns/:campaignId/closure', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Close an open equipment campaign, stating why (MASTERDATA.CHANGE)',
    params: z.strictObject({ campaignId: Uuid }),
    body: withAttribution({ reason: Text(2000) }),
    response: PlantConfigView,
  }),
  setUtilityFeedAge: defineRoute({
    id: 'marketConfig.setUtilityFeedAge', method: 'POST', path: '/api/plant/utility-feed-ages', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Set the maximum age of a utility class\'s feed reading, in minutes (at most a day; MASTERDATA.CHANGE)',
    body: withAttribution({ classCode: Code, maxAgeMinutes: PositiveWhole(1440) }),
    response: PlantConfigView,
  }),
  recordLineIsolation: defineRoute({
    id: 'marketConfig.recordLineIsolation', method: 'POST', path: '/api/plant/line-isolations', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'Record whether a packaging line is isolated, citing the qualification it rests on (blister register; MASTERDATA.CHANGE; IN-38)',
    body: withAttribution({ area: Code, isolated: z.boolean(), reference: z.string().regex(/^[!-~][ -~]{0,127}$/, 'printable text, up to 128 characters') }),
    response: PlantConfigView,
  }),
} as const;
