/**
 * Audit trail components (module C1; DI-22, DI-23): the entry list grouped by command, with field changes, and the
 * chain verification badge.
 */
export { AuditEventList, groupByCommand, utcText, type AuditGroup } from './AuditEventList.tsx';
export { ChainVerifyBadge, type ChainVerifyBadgeProps } from './ChainVerifyBadge.tsx';
