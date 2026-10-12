/**
 * The reads the record-lock screens show, read again after every act (route ids, so `useRefresh` invalidates each by
 * its prefix). A record amendment suspends the release of the lots made from the record, so the release reads are
 * read again too.
 */
import { routes, type RecordLockState } from '@ebmr/api-contract';
import type { StateTone } from '@ebmr/ui-kit';
import { RELEASE_READS, words } from '../release/reads.ts';

export { words };

export const RECORDS_READS: readonly string[] = [
  routes.records.locks.id,
  routes.records.lock.id,
  routes.records.bulk.id,
  routes.records.brightStockHolds.id,
  ...RELEASE_READS,
];

/** The chip tone of a record's lock state (display only). */
export function lockTone(s: RecordLockState): StateTone {
  return s === 'LOCKED' ? 'ok' : s === 'UNDER_AMENDMENT' ? 'warning' : 'neutral';
}
