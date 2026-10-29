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

/**
 * Slice 7u (R10 #14): a state code in plain words ("EXECUTION_COMPLETE" -> "execution complete", "QA_REVIEWED" ->
 * "QA reviewed"), for a state shown inside a sentence.
 */
export function stateWords(code: string): string {
  return code.replace(/_/g, ' ').toLowerCase().replace(/\b(qa|qc|qp|ipc|lims|erp)\b/g, (w) => w.toUpperCase());
}

/** UCUM annotations of a count as people read them (slice 7u, R10 #15). */
const COUNT_UNITS: Readonly<Record<string, string>> = {
  '{tbl}': 'tablets', '{tablets}': 'tablets', '{tab}': 'tablets', '{cap}': 'capsules', '{lbl}': 'labels', '{label}': 'labels', '{labels}': 'labels',
  '{u}': 'units', '{unit}': 'units', '{units}': 'units', '{ea}': 'units', '{pack}': 'packs', '{packs}': 'packs', '{ctn}': 'cartons', '{carton}': 'cartons', '{bottle}': 'bottles', '1': 'units',
};

/**
 * Slice 7u (R10 #15): a unit as people read it after a quantity: "{tbl}" -> "tablets", "1" (a plain count) -> "units",
 * another annotation without its braces; a unit of measure ("kg", "%") as it is.
 */
export function unitText(unit: string | null | undefined): string {
  if (!unit) return '';
  return COUNT_UNITS[unit] ?? (/^\{[^{}]+\}$/.test(unit) ? unit.slice(1, -1) : unit);
}

/** A quantity with its unit as people read it ("1000 tablets", "20000 units", "12.5 kg"). */
export function quantityText(quantity: string, unit: string | null | undefined): string {
  const u = unitText(unit);
  return u === '' ? quantity : `${quantity} ${u}`;
}
