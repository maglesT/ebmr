/**
 * RETENTION RULE PARAMETERS (interim; DI-47, PR-59, IN-08; build outline 3.3.6).
 *
 * This is the one place where the retention periods live until the market-profile engine (module B3)
 * serves them as rule keys. `proposedRuleKey` names the key each row should map to; the lead wires
 * them. The database holds the same rows in `records.retention_rule` (migration 0420), and a test
 * proves both copies are identical, so the rules cannot drift apart.
 *
 * Sources are paraphrased references, never regulation text. Verification markers follow the
 * outline: CHECKED = checked against the supplied primary text; S = secondary source only;
 * U = unconfirmed; P~ = clause number inferred; DESIGN = product default awaiting QA confirmation.
 *
 * Semantics (mirrored exactly by records.evaluate_retention in SQL):
 * - A rule applies when the record's retention key is in `retentionKeys`, its market is in the
 *   record's market set (null = every record), and every predicate fact matches.
 * - An applying rule gives anchor date + period (calendar arithmetic, see calendar.ts), or OPEN when
 *   its anchor is OPEN or the anchor date is missing (retention never ends on an unknown input).
 * - The record's own retain-until is the latest date over all applying rules; any OPEN rule keeps the
 *   whole record OPEN. Dependants then extend it (retention dependency, see retention.ts).
 */

export type Market = 'IN' | 'US' | 'EU';

export type RetentionKey = 'BATCH_RECORD' | 'SUPPORTING_RECORD' | 'DSCSA_RECORD' | 'VALIDATION_RAW_DATA';

export type RetentionAnchor =
  | 'EXPIRY'
  | 'MANUFACTURE'
  | 'DISTRIBUTION'
  | 'EU_CERTIFICATION'
  | 'DISPOSITION'
  | 'ABORT_CANCEL'
  | 'TRANSACTION'
  | 'MA_END'
  | 'OPEN';

export type Verification = 'CHECKED' | 'S' | 'U' | 'P~' | 'DESIGN';

/** Facts a predicate can test; derived from the inputs in retention.ts (and in SQL). */
export interface RetentionPredicate {
  licenceForm?: 'FORM_25' | 'FORM_28';
  expiryLabelled?: boolean;
  otcExpiryExempt?: boolean;
  euCertification?: 'PENDING' | 'CERTIFIED' | 'NEVER_CERTIFIED';
  aborted?: boolean;
  maInForce?: boolean;
}

export interface RetentionRule {
  ruleId: string;
  proposedRuleKey: string;
  retentionKeys: RetentionKey[];
  market: Market | null;
  predicate: RetentionPredicate;
  anchor: RetentionAnchor;
  period: { years: number; months: number };
  openReason: string | null;
  source: string;
  verification: Verification;
}

export interface RetentionRuleSet {
  version: string;
  rules: RetentionRule[];
}

const P = (years: number, months = 0) => ({ years, months });

export const RETENTION_RULE_SET: RetentionRuleSet = {
  version: 'RET-2026.1',
  rules: [
    {
      ruleId: 'IN_SCHEDULE_M_EXPIRY',
      proposedRuleKey: 'kernel.retention.batch.afterExpiry',
      retentionKeys: ['BATCH_RECORD'],
      market: 'IN',
      predicate: { expiryLabelled: true },
      anchor: 'EXPIRY',
      period: P(1),
      openReason: null,
      source: 'Revised Schedule M Part I 17.2: batch records kept at least one year after the expiry of the finished product',
      verification: 'P~',
    },
    {
      ruleId: 'IN_FORM25_MANUFACTURE',
      proposedRuleKey: 'kernel.retention.batch.afterManufacture',
      retentionKeys: ['BATCH_RECORD'],
      market: 'IN',
      predicate: { licenceForm: 'FORM_25' },
      anchor: 'MANUFACTURE',
      period: P(5),
      openReason: null,
      source: 'Drugs Rules Rule 74 conditions of a Form 25 licence with Schedule U: records kept five years from manufacture (India G-1)',
      verification: 'U',
    },
    {
      ruleId: 'IN_FORM28_EXPIRY',
      proposedRuleKey: 'kernel.retention.testRecords.afterExpiry',
      retentionKeys: ['BATCH_RECORD'],
      market: 'IN',
      predicate: { licenceForm: 'FORM_28', expiryLabelled: true },
      anchor: 'EXPIRY',
      period: P(2),
      openReason: null,
      source: 'Drugs Rules Rule 78 conditions of a Form 28 licence: test records kept two years after expiry where expiry is labelled (India G-1)',
      verification: 'U',
    },
    {
      ruleId: 'IN_FORM28_MANUFACTURE',
      proposedRuleKey: 'kernel.retention.testRecords.afterManufacture',
      retentionKeys: ['BATCH_RECORD'],
      market: 'IN',
      predicate: { licenceForm: 'FORM_28', expiryLabelled: false },
      anchor: 'MANUFACTURE',
      period: P(5),
      openReason: null,
      source: 'Drugs Rules Rule 78 conditions of a Form 28 licence: five years from manufacture where no expiry is labelled (India G-1)',
      verification: 'U',
    },
    {
      ruleId: 'US_EXPIRY',
      proposedRuleKey: 'kernel.retention.batch.afterExpiry',
      retentionKeys: ['BATCH_RECORD'],
      market: 'US',
      predicate: { otcExpiryExempt: false },
      anchor: 'EXPIRY',
      period: P(1),
      openReason: null,
      source: '21 CFR 211.180(a): batch records kept at least one year after the batch expiration date',
      verification: 'CHECKED',
    },
    {
      ruleId: 'US_OTC_DISTRIBUTION',
      proposedRuleKey: 'kernel.retention.batch.afterDistribution',
      retentionKeys: ['BATCH_RECORD'],
      market: 'US',
      predicate: { otcExpiryExempt: true },
      anchor: 'DISTRIBUTION',
      period: P(3),
      openReason: null,
      source: '21 CFR 211.180(a): OTC products exempt from expiration dating (211.137), three years after distribution of the batch',
      verification: 'CHECKED',
    },
    {
      ruleId: 'EU_EXPIRY',
      proposedRuleKey: 'kernel.retention.batch.afterExpiry',
      retentionKeys: ['BATCH_RECORD'],
      market: 'EU',
      predicate: {},
      anchor: 'EXPIRY',
      period: P(1),
      openReason: null,
      source: 'EU GMP Chapter 4, 4.11: batch documentation kept one year after batch expiry',
      verification: 'CHECKED',
    },
    {
      ruleId: 'EU_QP_CERTIFICATION',
      proposedRuleKey: 'kernel.retention.batch.afterCertification',
      retentionKeys: ['BATCH_RECORD'],
      market: 'EU',
      predicate: { euCertification: 'CERTIFIED' },
      anchor: 'EU_CERTIFICATION',
      period: P(5),
      openReason: null,
      source: 'EU GMP Chapter 4, 4.11: or at least five years after QP certification, whichever is longer',
      verification: 'CHECKED',
    },
    {
      ruleId: 'EU_CERTIFICATION_PENDING',
      proposedRuleKey: 'kernel.retention.batch.openUntilCertified',
      retentionKeys: ['BATCH_RECORD'],
      market: 'EU',
      predicate: { euCertification: 'PENDING', aborted: false },
      anchor: 'OPEN',
      period: P(0),
      openReason: 'PENDING_EU_CERTIFICATION',
      source: 'Owner decision record 0001 (default adopted): retention stays open until the EU certification date is received; DI-47',
      verification: 'DESIGN',
    },
    {
      ruleId: 'EU_NEVER_CERTIFIED_DISPOSITION',
      proposedRuleKey: 'kernel.retention.batch.afterDispositionUncertified',
      retentionKeys: ['BATCH_RECORD'],
      market: 'EU',
      predicate: { euCertification: 'NEVER_CERTIFIED' },
      anchor: 'DISPOSITION',
      period: P(5),
      openReason: null,
      source: 'Outline 3.3.6 and PR F-2: EU batch never certified, disposition plus five years (design default, QA to confirm)',
      verification: 'DESIGN',
    },
    {
      ruleId: 'ABORTED_NOMINAL_EXPIRY',
      proposedRuleKey: 'kernel.retention.abortedBatch.afterNominalExpiry',
      retentionKeys: ['BATCH_RECORD'],
      market: null,
      predicate: { aborted: true },
      anchor: 'EXPIRY',
      period: P(1),
      openReason: null,
      source: 'Outline 3.3.6: aborted or cancelled batch, nominal expiry it would have had plus one year (design default, QA to confirm)',
      verification: 'DESIGN',
    },
    {
      ruleId: 'ABORTED_CANCEL_DATE',
      proposedRuleKey: 'kernel.retention.abortedBatch.afterAbort',
      retentionKeys: ['BATCH_RECORD'],
      market: null,
      predicate: { aborted: true },
      anchor: 'ABORT_CANCEL',
      period: P(5),
      openReason: null,
      source: 'Outline 3.3.6: aborted or cancelled batch, abort or cancel date plus five years (design default, QA to confirm)',
      verification: 'DESIGN',
    },
    {
      ruleId: 'US_DSCSA_TRANSACTION',
      proposedRuleKey: 'kernel.retention.dscsa.afterTransaction',
      retentionKeys: ['DSCSA_RECORD'],
      market: 'US',
      predicate: {},
      anchor: 'TRANSACTION',
      period: P(6),
      openReason: null,
      source: 'DSCSA (FD&C Act 582): serial and transaction records kept at least six years after the transaction',
      verification: 'S',
    },
    {
      ruleId: 'EU_VALIDATION_MA_IN_FORCE',
      proposedRuleKey: 'kernel.retention.validationRawData.whileAuthorised',
      retentionKeys: ['VALIDATION_RAW_DATA'],
      market: 'EU',
      predicate: { maInForce: true },
      anchor: 'OPEN',
      period: P(0),
      openReason: 'MARKETING_AUTHORISATION_IN_FORCE',
      source: 'EU GMP Chapter 4, 4.12: documentation supporting the marketing authorisation kept while the authorisation is in force',
      verification: 'CHECKED',
    },
    {
      ruleId: 'EU_VALIDATION_MA_END',
      proposedRuleKey: 'kernel.retention.validationRawData.afterAuthorisationEnds',
      retentionKeys: ['VALIDATION_RAW_DATA'],
      market: 'EU',
      predicate: { maInForce: false },
      anchor: 'MA_END',
      period: P(0),
      openReason: null,
      source: 'EU GMP Chapter 4, 4.12: until the authorisation ends; batches released on it extend this through retention dependencies',
      verification: 'CHECKED',
    },
  ],
};
