/**
 * The reads the master-record signing screens show, read again after every act (route ids, so `useRefresh` invalidates
 * each by prefix).
 */
import { routes } from '@ebmr/api-contract';
import type { StateTone } from '@ebmr/ui-kit';

export const MASTER_RECORD_READS: readonly string[] = [
  routes.designer.version.id,
  routes.designer.families.id,
  routes.esig.signatures.id,
  routes.designer.marketAuthorisations.id,
  routes.designer.specimens.id,
];

/** The four life-cycle signatures in order: who signs, the transition, the meaning and the state it needs. */
export const LIFECYCLE = [
  { transition: 'SUBMIT', meaning: 'PREPARED', label: 'Sign as prepared', signer: 'the MBR author', needs: 'IN_VERIFICATION' },
  { transition: 'CHECK', meaning: 'CHECKED', label: 'Sign as independently checked', signer: 'an MBR checker who did not prepare it', needs: 'SUBMITTED' },
  { transition: 'REGULATORY_CONFIRM', meaning: 'REGULATORY_CONFIRMED', label: 'Confirm the registration references', signer: 'the regulatory-conformity signer', needs: null },
  { transition: 'APPROVE', meaning: 'APPROVED', label: 'Approve for the quality unit', signer: 'a QA MBR approver who neither prepared nor checked it', needs: 'CHECKED' },
] as const;

/** The chip tone of a record's state (display only; what the state allows is the server's). */
export function stateTone(state: string): StateTone {
  if (state === 'APPROVED' || state === 'ACTIVE' || state === 'EFFECTIVE') return 'ok';
  if (state === 'WITHDRAWN' || state === 'RETIRED' || state === 'SUPERSEDED') return 'neutral';
  return 'pending';
}

/** Words for a state code. */
export function words(code: string): string {
  const w = code.toLowerCase().replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}
