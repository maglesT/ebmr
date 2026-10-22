/**
 * Requirement R3.1 (hosted-demo trials, October 2026; decision D-7k-1): a batch size in tablets mistyped at issue (10000
 * for 100000) was accepted, and the dispensing reconciliation later read 1000 %. The master implies the count: its batch
 * size (a mass) divided by the target tablet weight of its compression (the first `targetWeightMg` of the procedure). The
 * issue form is pre-filled with that count; an entered count more than TOLERANCE_PERCENT away from it is refused at issue
 * unless the issuer confirms it with their own reason, which the record keeps with the value (the input's source).
 *
 * The check is the server's (the issue's dry run and its apply), not the database's: the expectation is read from the
 * control recipe's content, which the database stores as a document and never interprets; the value itself is the
 * engine's, pinned in the record at issue (D-7k-1). Decimal arithmetic only (expr Dec), never a JavaScript number.
 */
import { Dec } from '@ebmr/expr';

/** How far (in per cent of the master's count) an entered count may be from it without a confirmation. */
export const TOLERANCE_PERCENT = '10';

/** Milligrams per unit of the master's batch size (mass units only). */
const MG_PER: Readonly<Record<string, string>> = { kg: '1000000', g: '1000', mg: '1' };

export interface InputExpectation {
  value: string;
  basis: string;
  tolerancePercent: string;
}

interface DeclaredInput {
  id: string;
  name: string;
  valueType: string;
}

interface MasterLike {
  header: { batchSizes: readonly { id: string; quantity: { value: string; unit: string } }[] };
  inputs: readonly DeclaredInput[];
  procedure: unknown;
}

/** The first `targetWeightMg` in the procedure, in document order (the compression's target, before any coat). */
function firstTargetWeightMg(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const x of node) {
      const found = firstTargetWeightMg(x);
      if (found !== null) return found;
    }
    return null;
  }
  if (node !== null && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o['targetWeightMg'] === 'string' && Dec.isValid(o['targetWeightMg'])) return o['targetWeightMg'];
    for (const v of Object.values(o)) {
      const found = firstTargetWeightMg(v);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Whether an issue input is the batch's tablet count (a COUNT named for tablets). */
export function isTabletCount(i: DeclaredInput): boolean {
  return i.valueType === 'COUNT' && (i.id === 'tabletsPerBatch' || /tablet/i.test(i.name));
}

/** The tablet count the master implies for its batch size `batchSizeId`, with how it is computed, or null. */
export function expectedTabletCount(mbr: MasterLike, batchSizeId: string): InputExpectation | null {
  const size = mbr.header.batchSizes.find((b) => b.id === batchSizeId);
  const factor = size ? MG_PER[size.quantity.unit] : undefined;
  const target = firstTargetWeightMg(mbr.procedure);
  if (!size || factor === undefined || target === null || !Dec.isValid(size.quantity.value)) return null;
  const weight = Dec.parse(target);
  if (!weight.isPositive()) return null;
  const count = Dec.parse(size.quantity.value).times(Dec.parse(factor)).div(weight).roundToDecimals(0, 'HALF_UP');
  return { value: count.toString(), basis: `batch size ${size.quantity.value} ${size.quantity.unit} / target tablet weight ${target} mg`, tolerancePercent: TOLERANCE_PERCENT };
}

/** The expectation of each issue input that has one (the tablet count), by input id. */
export function inputExpectations(mbr: MasterLike, batchSizeId: string): Map<string, InputExpectation> {
  const out = new Map<string, InputExpectation>();
  const expected = expectedTabletCount(mbr, batchSizeId);
  if (!expected) return out;
  for (const i of mbr.inputs) if (isTabletCount(i)) out.set(i.id, expected);
  return out;
}

/** How far `entered` is from `expected`, in per cent of `expected` (two decimals), or null when `entered` is no number. */
export function deviationPercent(entered: string, expected: string): string | null {
  if (!Dec.isValid(entered)) return null;
  const e = Dec.parse(expected);
  if (e.isZero()) return null;
  return Dec.parse(entered).minus(e).abs().times(Dec.HUNDRED).div(e).roundToDecimals(2, 'HALF_UP').toString();
}

export interface CountProblem {
  inputId: string;
  name: string;
  entered: string;
  expected: InputExpectation;
  deviation: string;
}

/**
 * The tablet counts of an issue that are further from the master's than the tolerance and carry no confirmation: each
 * must be corrected or confirmed with the issuer's reason (`confirmations`, by input id).
 */
export function unconfirmedCounts(mbr: MasterLike, batchSizeId: string, inputs: Readonly<Record<string, { kind: string; value?: unknown }>>, confirmations: Readonly<Record<string, string>> = {}): CountProblem[] {
  const out: CountProblem[] = [];
  for (const [id, expected] of inputExpectations(mbr, batchSizeId)) {
    const v = inputs[id];
    if (!v || typeof v.value !== 'string') continue;
    const deviation = deviationPercent(v.value, expected.value);
    if (deviation === null || Dec.parse(deviation).lte(Dec.parse(expected.tolerancePercent))) continue;
    if ((confirmations[id] ?? '').trim() !== '') continue;
    out.push({ inputId: id, name: mbr.inputs.find((i) => i.id === id)?.name ?? id, entered: v.value, expected, deviation });
  }
  return out;
}
