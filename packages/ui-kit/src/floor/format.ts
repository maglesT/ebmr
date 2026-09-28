/**
 * Plain-language helpers for floor screens. They only arrange what the server sent (statuses, limits, persons);
 * none of them evaluates a limit, decides availability or formats a GMP time (the server's Instant.text is shown).
 */
import { ROLE_TITLES, type ExceptionView, type PersonRef } from '@ebmr/api-contract';
import type { StateTone } from '../tokens/tokens.ts';
import { FLOOR_EN, ft, type FloorMessageKey } from './messages.ts';

/** A step or stage status as colour + icon + word (the word comes from the server's statusText where it has one). */
export function stepTone(status: string): StateTone {
  switch (status) {
    case 'COMPLETED':
    case 'SIGNED_OFF':
    case 'EXECUTION_COMPLETE':
      return 'ok';
    case 'IN_PROGRESS':
      return 'info';
    case 'ENABLED':
    case 'ISSUED':
      return 'pending';
    case 'AWAITING_VERIFICATION':
    case 'AWAITING_SIGN_OFF':
    case 'ON_HOLD':
      return 'warning';
    case 'ABORTED':
    case 'CANCELLED':
      return 'error';
    default:
      return 'neutral';
  }
}

export function severityTone(e: Pick<ExceptionView, 'severity' | 'blocking' | 'status'>): StateTone {
  if (e.status === 'DISPOSITIONED') return 'ok';
  if (e.blocking || e.severity === 'CRITICAL') return 'error';
  return e.severity === 'ACTION' ? 'warning' : 'pending';
}

/** The title of a role (engine or kernel vocabulary), or the code itself when unknown. */
export function roleTitle(role: string): string {
  return ROLE_TITLES[role] ?? role;
}

export function personLine(p: PersonRef): string {
  return ft('attempt.by', { name: p.legalName, login: p.loginName, role: roleTitle(p.role) });
}

/** The floor catalogue text for a server enum value under a prefix (e.g. limits.tier + ALERT), or the value itself. */
export function enumText(prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  return key in FLOOR_EN ? ft(key as FloorMessageKey) : value;
}

/** Seconds as m:ss or h:mm:ss for display countdowns. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}
