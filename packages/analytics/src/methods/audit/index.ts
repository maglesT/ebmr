/**
 * The audit-trail methods of slice 6A-4 (decision 0016 item 8; D-6A-12; draft control DI-53): rules first (ATA.RULES),
 * then per-person baselines (ATA.BASELINE). No machine learning (decision 0023).
 */
export { ATA_BASELINE, BASELINE_METRICS, median, robustZ, runAuditBaseline, type AuditBaselineParameters, type BaselineMetric } from './baseline.ts';
export { compareIds, eventRef, instantMs, localHour, siteWeek, weekPlus, type AuditEvent, type AuditInput, type AuthEvent, type ManualDigit } from './input.ts';
export { ATA_RULES, AUDIT_RULES, MAX_EVIDENCE, auditRuleHits, quantileOfSorted, runAuditRules, type AuditRule, type AuditRulesParameters } from './rules.ts';
