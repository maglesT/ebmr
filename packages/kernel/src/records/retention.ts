/**
 * Retention computation (DI-47, INV-22; outline 3.3.6). Pure functions, no I/O.
 *
 * The database holds an exact mirror (records.normalize_retention_inputs, records.evaluate_retention,
 * records.compute_effective_retention) and that copy is authoritative for purge: INV-22 must hold even
 * if the application is wrong, so the database never accepts a retain-until computed elsewhere. This
 * TypeScript copy serves previews, explanations and what-if questions; a property-based test proves
 * both give identical results for the same inputs and rule set.
 */
import { addPeriod, compareDates, isCalendarDate, type CalendarDate } from './calendar.ts';
import {
  RETENTION_RULE_SET,
  type Market,
  type RetentionAnchor,
  type RetentionKey,
  type RetentionRule,
  type RetentionRuleSet,
} from './retention-rules.ts';

export interface RetentionInputs {
  /** The batch's market set; IN is always present (INV-28). */
  markets: Market[];
  licenceForm?: 'FORM_25' | 'FORM_28' | null;
  manufactureDate?: CalendarDate | null;
  /** Labelled expiry; for an aborted batch, the nominal expiry it would have had. */
  expiryDate?: CalendarDate | null;
  otcExpiryExempt?: boolean;
  /** Date distribution of the batch was completed (US OTC products exempt from expiry dating). */
  distributionDate?: CalendarDate | null;
  /** QP certification date received from the EU importer; absent = pending (retention OPEN). */
  euCertificationDate?: CalendarDate | null;
  /** The EU disposition ended without certification (rejected by QP, ineligible, ...). */
  euNeverCertified?: boolean;
  dispositionDate?: CalendarDate | null;
  abortCancelDate?: CalendarDate | null;
  /** DSCSA records: date of the last transaction the record covers. */
  lastTransactionDate?: CalendarDate | null;
  /** Validation raw data: date the marketing authorisation ended; absent = still in force. */
  maEndDate?: CalendarDate | null;
}

/** Inputs with every key present, dates validated and markets sorted (as stored by the database). */
export interface NormalizedRetentionInputs {
  markets: Market[];
  licenceForm: 'FORM_25' | 'FORM_28' | null;
  manufactureDate: CalendarDate | null;
  expiryDate: CalendarDate | null;
  otcExpiryExempt: boolean;
  distributionDate: CalendarDate | null;
  euCertificationDate: CalendarDate | null;
  euNeverCertified: boolean;
  dispositionDate: CalendarDate | null;
  abortCancelDate: CalendarDate | null;
  lastTransactionDate: CalendarDate | null;
  maEndDate: CalendarDate | null;
}

export interface RuleEvaluation {
  ruleId: string;
  status: 'DATED' | 'OPEN';
  date: CalendarDate | null;
  reason: string | null;
}

export interface OwnRetention {
  ruleSetVersion: string;
  /** NONE: no rule applies to the record itself (it may still inherit from its dependants). */
  status: 'DATED' | 'OPEN' | 'NONE';
  retainUntil: CalendarDate | null;
  latestDated: CalendarDate | null;
  governingRules: string[];
  openReasons: string[];
  evaluated: RuleEvaluation[];
}

export interface RetentionNode {
  recordKey: string;
  own: OwnRetention;
  hasDependants: boolean;
}

export interface EffectiveRetention {
  status: 'DATED' | 'OPEN';
  retainUntil: CalendarDate | null;
  latestDated: CalendarDate | null;
  governedBy: string[];
  openBecause: { recordKey: string; reasons: string[] }[];
  recordsConsidered: number;
}

const DATE_KEYS = [
  'manufactureDate',
  'expiryDate',
  'distributionDate',
  'euCertificationDate',
  'dispositionDate',
  'abortCancelDate',
  'lastTransactionDate',
  'maEndDate',
] as const;
const BOOL_KEYS = ['otcExpiryExempt', 'euNeverCertified'] as const;
const MARKETS: readonly Market[] = ['EU', 'IN', 'US'];

const ANCHOR_INPUT: Record<Exclude<RetentionAnchor, 'OPEN'>, (typeof DATE_KEYS)[number]> = {
  EXPIRY: 'expiryDate',
  MANUFACTURE: 'manufactureDate',
  DISTRIBUTION: 'distributionDate',
  EU_CERTIFICATION: 'euCertificationDate',
  DISPOSITION: 'dispositionDate',
  ABORT_CANCEL: 'abortCancelDate',
  TRANSACTION: 'lastTransactionDate',
  MA_END: 'maEndDate',
};

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Mirror of records.normalize_retention_inputs; throws EBMR-REC-020 on invalid inputs. */
export function normalizeRetentionInputs(inputs: RetentionInputs): NormalizedRetentionInputs {
  const raw = inputs as unknown as Record<string, unknown>;
  const allowed = new Set<string>(['markets', 'licenceForm', ...DATE_KEYS, ...BOOL_KEYS]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`EBMR-REC-020 unknown retention input ${key}`);
  }
  if (!Array.isArray(inputs.markets)) throw new Error('EBMR-REC-020 retention inputs need the market set');
  const markets = [...new Set(inputs.markets)].sort(byCodeUnit);
  if (markets.some((m) => !MARKETS.includes(m))) throw new Error('EBMR-REC-020 markets must be IN, US or EU');
  if (!markets.includes('IN')) throw new Error('EBMR-REC-020 India is in every market set (INV-28); IN is missing');
  const licenceForm = inputs.licenceForm ?? null;
  if (licenceForm !== null && licenceForm !== 'FORM_25' && licenceForm !== 'FORM_28') {
    throw new Error('EBMR-REC-020 licenceForm must be FORM_25, FORM_28 or null');
  }
  const bool = (key: (typeof BOOL_KEYS)[number]): boolean => {
    const v = raw[key];
    if (v === undefined || v === null) return false;
    if (typeof v !== 'boolean') throw new Error(`EBMR-REC-020 ${key} must be true or false`);
    return v;
  };
  const date = (key: (typeof DATE_KEYS)[number]): CalendarDate | null => {
    const v = raw[key];
    if (v === undefined || v === null) return null;
    if (!isCalendarDate(v)) throw new Error(`EBMR-REC-020 ${key} is not a valid calendar date`);
    return v;
  };
  const out: NormalizedRetentionInputs = {
    markets,
    licenceForm,
    manufactureDate: date('manufactureDate'),
    expiryDate: date('expiryDate'),
    otcExpiryExempt: bool('otcExpiryExempt'),
    distributionDate: date('distributionDate'),
    euCertificationDate: date('euCertificationDate'),
    euNeverCertified: bool('euNeverCertified'),
    dispositionDate: date('dispositionDate'),
    abortCancelDate: date('abortCancelDate'),
    lastTransactionDate: date('lastTransactionDate'),
    maEndDate: date('maEndDate'),
  };
  if (out.euCertificationDate !== null && out.euNeverCertified) {
    throw new Error('EBMR-REC-020 a batch cannot be both certified and never certified for the EU');
  }
  if (out.expiryDate !== null && out.manufactureDate !== null && compareDates(out.expiryDate, out.manufactureDate) < 0) {
    throw new Error('EBMR-REC-020 the expiry date lies before the manufacturing date');
  }
  return out;
}

function facts(inputs: NormalizedRetentionInputs): Record<string, string | boolean | null> {
  return {
    licenceForm: inputs.licenceForm,
    expiryLabelled: inputs.expiryDate !== null,
    otcExpiryExempt: inputs.otcExpiryExempt,
    euCertification: inputs.euCertificationDate !== null ? 'CERTIFIED' : inputs.euNeverCertified ? 'NEVER_CERTIFIED' : 'PENDING',
    aborted: inputs.abortCancelDate !== null,
    maInForce: inputs.maEndDate === null,
  };
}

function applies(rule: RetentionRule, key: RetentionKey, inputs: NormalizedRetentionInputs, f: Record<string, string | boolean | null>): boolean {
  if (!rule.retentionKeys.includes(key)) return false;
  if (rule.market !== null && !inputs.markets.includes(rule.market)) return false;
  return Object.entries(rule.predicate).every(([k, v]) => (f[k] ?? null) === v);
}

/** The record's own retention from its rules (mirror of records.evaluate_retention). */
export function evaluateOwnRetention(
  retentionKey: RetentionKey,
  inputs: RetentionInputs,
  ruleSet: RetentionRuleSet = RETENTION_RULE_SET,
): OwnRetention {
  const n = normalizeRetentionInputs(inputs);
  const f = facts(n);
  const rules = ruleSet.rules.filter((r) => applies(r, retentionKey, n, f)).sort((a, b) => byCodeUnit(a.ruleId, b.ruleId));
  const evaluated: RuleEvaluation[] = [];
  const open: string[] = [];
  let max: CalendarDate | null = null;
  let governing: string[] = [];
  for (const rule of rules) {
    if (rule.anchor === 'OPEN') {
      const reason = rule.openReason ?? 'OPEN';
      evaluated.push({ ruleId: rule.ruleId, status: 'OPEN', date: null, reason });
      open.push(reason);
      continue;
    }
    const anchor = n[ANCHOR_INPUT[rule.anchor]];
    if (anchor === null) {
      const reason = `MISSING_INPUT:${rule.anchor}`;
      evaluated.push({ ruleId: rule.ruleId, status: 'OPEN', date: null, reason });
      open.push(reason);
      continue;
    }
    const date = addPeriod(anchor, rule.period.years, rule.period.months);
    evaluated.push({ ruleId: rule.ruleId, status: 'DATED', date, reason: null });
    if (max === null || compareDates(date, max) > 0) {
      max = date;
      governing = [rule.ruleId];
    } else if (date === max) {
      governing.push(rule.ruleId);
    }
  }
  const openReasons = [...new Set(open)].sort(byCodeUnit);
  const status = rules.length === 0 ? 'NONE' : openReasons.length > 0 ? 'OPEN' : 'DATED';
  return {
    ruleSetVersion: ruleSet.version,
    status,
    retainUntil: status === 'DATED' ? max : null,
    latestDated: max,
    governingRules: openReasons.length > 0 ? evaluated.filter((e) => e.status === 'OPEN').map((e) => e.ruleId) : governing,
    openReasons,
    evaluated,
  };
}

/**
 * Retention dependency (outline 3.3.6): a record's effective retention combines its own rules with
 * every record that depends on it, transitively (`nodes` = the record plus that closure). OPEN when any
 * of them is OPEN, or has no applicable rule and no dependants; otherwise the latest date wins.
 * Mirror of records.compute_effective_retention.
 */
export function combineEffectiveRetention(nodes: RetentionNode[]): EffectiveRetention {
  const sorted = [...nodes].sort((a, b) => byCodeUnit(a.recordKey, b.recordKey));
  let openBecause = sorted
    .filter((n) => n.own.status === 'OPEN' || (n.own.status === 'NONE' && !n.hasDependants))
    .map((n) => ({ recordKey: n.recordKey, reasons: n.own.status === 'OPEN' ? n.own.openReasons : ['NO_RULE_APPLIES'] }));
  let max: CalendarDate | null = null;
  for (const n of sorted) {
    if (n.own.status === 'DATED' && n.own.retainUntil !== null && (max === null || compareDates(n.own.retainUntil, max) > 0)) max = n.own.retainUntil;
  }
  // Defensive: without any dated record there is no date to dispose at, so retention stays open.
  if (openBecause.length === 0 && max === null) {
    openBecause = sorted.filter((n) => n.own.status === 'NONE').map((n) => ({ recordKey: n.recordKey, reasons: ['NO_RULE_APPLIES'] }));
  }
  const isOpen = openBecause.length > 0 || max === null;
  return {
    status: isOpen ? 'OPEN' : 'DATED',
    retainUntil: isOpen ? null : max,
    latestDated: max,
    governedBy: isOpen ? [] : sorted.filter((n) => n.own.status === 'DATED' && n.own.retainUntil === max).map((n) => n.recordKey),
    openBecause,
    recordsConsidered: sorted.length,
  };
}
