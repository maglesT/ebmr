/**
 * TB-01 calculations (tablets spec section C: C-01 as-is assay, C-02 salt-to-base factor, C-03 potency-adjusted quantity
 * of an active, C-04 compensating excipient), exact.
 *
 * Every intermediate is an exact rational of BigInt integers; nothing is rounded until a result is written. A result is
 * written in two ways only, both explicit: a dispensing target, rounded to the balance readability the MBR declares (an
 * active UP, so the target never falls below the calculated quantity and never delivers less than 100 % of the labelled
 * active; the compensating excipient to the nearest step, half away from zero), and a calculated value shown at six
 * decimals (half away from zero, display only). The database repeats the same arithmetic in numeric with the same
 * roundings and refuses a recorded calculation that differs (tablets 0842, recompute and compare), so the two must stay
 * bit-for-bit the same: integer quotients only, never a binary fraction, never a JavaScript number for a value.
 */
import { Dec } from '@ebmr/expr';

/** The basis the lot's assay is reported on (the CoA or LIMS result field), C-01. */
export const ASSAY_BASES = ['AS_IS', 'ANHYDROUS_WATER', 'DRIED_LOD', 'ANHYDROUS_SOLVENT_FREE'] as const;
export type AssayBasis = (typeof ASSAY_BASES)[number];

/** The approved assay result of one lot, as the lot register holds it (percent w/w, decimal text). */
export interface LotAssay {
  basis: AssayBasis;
  assay: string;
  water?: string;
  lod?: string;
  solvents?: string;
}

export interface PotencyInput {
  /** The BOM quantity of the active for the reference batch (decimal text in `unit`). */
  standardQuantity: string;
  /** BASE: the BOM states the label-claim moiety, the salt-to-base factor applies; FORM: it states the declared form at 100 %. */
  standardIs: 'BASE' | 'FORM';
  /** Molar masses of the declared form and of the base moiety, and the base moieties per formula unit (C-02). */
  form?: { molarMassForm: string; molarMassBase: string; baseMoieties: number };
  /** Registered overage in percent (0 unless registered). */
  overagePercent: string;
  /** One to three lots, each with its approved assay and, with more than one lot, its base-equivalent share. */
  lots: { assay: LotAssay; baseEquivalent?: string }[];
  /** The compensating excipient's BOM quantity and its approved range (all in `unit`), absent without compensation. */
  excipient?: { standard: string; min: string; max: string };
  /** The balance readability the targets are rounded to, in `unit`. */
  readability: string;
}

export interface PotencyLotResult {
  asIsAssay: string;
  baseEquivalent: string;
  calculated: string;
  target: string;
}

export interface PotencyResult {
  factor: string;
  standard: string;
  lots: PotencyLotResult[];
  excipient: { standard: string; calculated: string; target: string } | null;
  total: { standard: string; target: string };
  /** |sum of the adjusted active quantities - standard| / standard x 100, shown at six decimals. */
  adjustmentPercent: string;
}

export type PotencyOutcome = { ok: true; result: PotencyResult } | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------------------------
// Exact rationals

interface Q {
  readonly n: bigint;
  readonly d: bigint;
}

const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** The exact value of decimal text (a refused text is a programming error: the schemas admit decimals only). */
export function q(text: string): Q {
  if (!DECIMAL.test(text) || !Dec.isValid(text)) throw new Error(`${text} is not decimal text`);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const point = body.indexOf('.');
  const digits = point < 0 ? body : body.slice(0, point) + body.slice(point + 1);
  const scale = point < 0 ? 0 : body.length - point - 1;
  const n = BigInt(digits);
  return { n: negative ? -n : n, d: 10n ** BigInt(scale) };
}

const mul = (a: Q, b: Q): Q => ({ n: a.n * b.n, d: a.d * b.d });
const div = (a: Q, b: Q): Q => {
  if (b.n === 0n) throw new Error('division by zero');
  return b.n < 0n ? { n: -a.n * b.d, d: a.d * -b.n } : { n: a.n * b.d, d: a.d * b.n };
};
const add = (a: Q, b: Q): Q => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const sub = (a: Q, b: Q): Q => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const sign = (a: Q): -1n | 0n | 1n => (a.n === 0n ? 0n : a.n > 0n ? 1n : -1n);
const cmp = (a: Q, b: Q): -1n | 0n | 1n => sign(sub(a, b));
const HUNDRED: Q = { n: 100n, d: 1n };
const int = (k: bigint): Q => ({ n: k, d: 1n });

/** floor(a / b) for a >= 0, b > 0 (integer quotient, as numeric div() truncates). */
function quotient(a: bigint, b: bigint): bigint {
  return a / b;
}

/** decimal text of `r`'s written scale times the integer k (k x r, written at r's decimals; numeric multiplication). */
function times(k: bigint, step: string): string {
  const s = q(step);
  const scale = s.d.toString().length - 1;
  const v = k * s.n;
  const negative = v < 0n;
  const digits = (negative ? -v : v).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

/** x rounded to a multiple of `step`: UP (ceiling, for x > 0) or HALF_UP (half away from zero), written at step's scale. */
export function roundToStep(x: Q, step: string, mode: 'UP' | 'HALF_UP'): string {
  const s = q(step);
  // x / s = (x.n * s.d) / (x.d * s.n), both denominators positive.
  const num = x.n * s.d;
  const den = x.d * s.n;
  const neg = num < 0n;
  const a = neg ? -num : num;
  let k: bigint;
  if (mode === 'UP') {
    if (neg) throw new Error('an UP rounding is of a positive quantity');
    k = quotient(a, den) + (a % den === 0n ? 0n : 1n);
  } else {
    k = quotient(2n * a + den, 2n * den);
  }
  return times(neg ? -k : k, step);
}

/** Display at six decimals, half away from zero (a calculated value shown, never used for a decision). */
export const SIX = '0.000001';
export const show6 = (x: Q): string => roundToStep(x, SIX, 'HALF_UP');

/** Exact decimal text of a terminating rational without trailing fractional zeros (numeric trim_scale). */
export function exact(x: Q): string {
  let { n } = x;
  const { d } = x;
  let scale = 0;
  // d is a product of powers of ten here (every input is decimal text); bring it to 10^scale.
  let p = 1n;
  while (p < d || p % d !== 0n) {
    p *= 10n;
    scale += 1;
    if (scale > 200) throw new Error('not a terminating decimal');
  }
  n = (n * p) / d;
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(scale + 1, '0');
  let text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  if (scale > 0) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return neg && text !== '0' ? `-${text}` : text;
}

// ---------------------------------------------------------------------------------------------
// C-01 .. C-04

/** C-01: the as-is assay from the approved result on its basis, or why it cannot be computed (a missing value blocks). */
export function asIsAssay(a: LotAssay): { ok: true; value: Q } | { ok: false; message: string } {
  const assay = q(a.assay);
  const need = (what: 'water' | 'lod' | 'solvents'): Q | string => (a[what] === undefined ? `the ${what === 'lod' ? 'loss on drying' : what} result its basis needs is missing` : q(a[what]));
  let value: Q;
  switch (a.basis) {
    case 'AS_IS':
      value = assay;
      break;
    case 'ANHYDROUS_WATER': {
      const w = need('water');
      if (typeof w === 'string') return { ok: false, message: w };
      value = div(mul(assay, sub(HUNDRED, w)), HUNDRED);
      break;
    }
    case 'DRIED_LOD': {
      const l = need('lod');
      if (typeof l === 'string') return { ok: false, message: l };
      value = div(mul(assay, sub(HUNDRED, l)), HUNDRED);
      break;
    }
    case 'ANHYDROUS_SOLVENT_FREE': {
      const w = need('water');
      if (typeof w === 'string') return { ok: false, message: w };
      const s = need('solvents');
      if (typeof s === 'string') return { ok: false, message: s };
      value = div(mul(assay, sub(sub(HUNDRED, w), s)), HUNDRED);
      break;
    }
  }
  if (sign(value) <= 0n || cmp(value, int(200n)) > 0) return { ok: false, message: `the as-is assay ${exact(value)} % is not a usable assay (above 0 and at most 200 %)` };
  return { ok: true, value };
}

/** C-02: the salt-to-base factor MW_form / (moieties x MW_base); 1 when the standard is stated on the form. */
export function saltFactor(input: Pick<PotencyInput, 'standardIs' | 'form'>): Q {
  if (input.standardIs === 'FORM' || !input.form) return int(1n);
  return div(q(input.form.molarMassForm), mul(int(BigInt(input.form.baseMoieties)), q(input.form.molarMassBase)));
}

/** C-03 and C-04 for one batch: the targets of each lot of the active and of the compensating excipient. */
export function potencyTargets(input: PotencyInput): PotencyOutcome {
  const fail = (code: string, message: string): PotencyOutcome => ({ ok: false, code, message });
  if (input.lots.length < 1 || input.lots.length > 3) return fail('TB01-LOTS', 'an active is allocated across one to three lots');
  if (sign(q(input.readability)) <= 0n) return fail('TB01-READABILITY', 'the readability is positive');
  const f = saltFactor(input);
  // Base-equivalent the batch needs: Q_base x (100 + OV) / 100 (on the form itself when the standard is the form).
  const need = div(mul(q(input.standardQuantity), add(HUNDRED, q(input.overagePercent))), HUNDRED);
  // Standard quantity of the form at 100 % (C-03): Q_std = need x f.
  const qStd = mul(need, f);
  const shares: Q[] = [];
  if (input.lots.length === 1) {
    const only = input.lots[0];
    if (only?.baseEquivalent !== undefined && cmp(q(only.baseEquivalent), need) !== 0n) {
      return fail('TB01-ALLOCATION', `the one lot carries the whole base-equivalent of ${exact(need)}, not ${only.baseEquivalent}`);
    }
    shares.push(need);
  } else {
    let sum: Q = int(0n);
    for (const [i, l] of input.lots.entries()) {
      if (l.baseEquivalent === undefined) return fail('TB01-ALLOCATION', `lot ${i + 1} states no base-equivalent share: with more than one lot each states its share`);
      const b = q(l.baseEquivalent);
      if (sign(b) <= 0n) return fail('TB01-ALLOCATION', `lot ${i + 1} states a share that is not positive (${l.baseEquivalent})`);
      shares.push(b);
      sum = add(sum, b);
    }
    if (cmp(sum, need) !== 0n) return fail('TB01-ALLOCATION', `the lots' base-equivalent shares add up to ${exact(sum)}, not to the ${exact(need)} the batch needs`);
  }
  const lots: PotencyLotResult[] = [];
  let actSum: Q = int(0n);
  for (const [i, l] of input.lots.entries()) {
    const a = asIsAssay(l.assay);
    if (!a.ok) return fail('TB01-ASSAY', `lot ${i + 1}: ${a.message}`);
    const share = shares[i] as Q;
    // C-03: Q_act,i = b_i x f x 100 / A_asis,i
    const qAct = div(mul(mul(share, f), HUNDRED), a.value);
    actSum = add(actSum, qAct);
    const target = roundToStep(qAct, input.readability, 'UP');
    lots.push({ asIsAssay: exact(a.value), baseEquivalent: exact(share), calculated: show6(qAct), target });
  }
  let excipient: PotencyResult['excipient'] = null;
  let totalStd = qStd;
  let totalTarget = lots.reduce((acc, l) => add(acc, q(l.target)), int(0n));
  if (input.excipient) {
    const dStd = q(input.excipient.standard);
    // C-04: Q_dil = Q_dil,std - (sum Q_act,i - Q_std)
    const qDil = sub(dStd, sub(actSum, qStd));
    const target = roundToStep(qDil, input.readability, 'HALF_UP');
    if (sign(q(target)) < 0n) return fail('TB01-EXCIPIENT-NEGATIVE', `the compensating excipient would be ${target}, below zero`);
    if (cmp(q(target), q(input.excipient.min)) < 0n || cmp(q(target), q(input.excipient.max)) > 0n) {
      return fail('TB01-EXCIPIENT-RANGE', `the compensating excipient would be ${target}, outside its approved range ${input.excipient.min} to ${input.excipient.max}`);
    }
    excipient = { standard: input.excipient.standard, calculated: show6(qDil), target };
    totalStd = add(totalStd, dStd);
    totalTarget = add(totalTarget, q(target));
  }
  const adjustment = div(mul(sub(actSum, qStd), HUNDRED), qStd);
  return {
    ok: true,
    result: {
      factor: show6(f),
      standard: show6(qStd),
      lots,
      excipient,
      total: { standard: show6(totalStd), target: roundToStep(totalTarget, input.readability, 'HALF_UP') },
      adjustmentPercent: show6(sign(adjustment) < 0n ? { n: -adjustment.n, d: adjustment.d } : adjustment),
    },
  };
}
