/**
 * Compendial acceptance-table hook (ADR 0005 decision 6; brief A1 item 3).
 *
 * Pharmacopoeial tables (e.g. the uniformity-of-mass deviation band by average mass, tablets spec
 * E.2) are validated master data owned by the rule-set model (tablets spec E.1: versioned, with a
 * source, a confidence and a QA verification record). expr does not ship their values: it defines
 * the table shape, validates it, and gives the exact lookup semantics used by table_lookup(). The
 * host supplies the tables (at design time for checking, at run time for evaluation) and every
 * lookup is recorded with the table id, version and row.
 */
import { Dec } from '../decimal/dec.ts';
import { rCmp, toRational, type Rational } from '../decimal/exact.ts';
import { diagnostic, type Diagnostic } from '../diagnostics.ts';
import { isTag, tagUnitProblem, type Tag } from '../units/tags.ts';
import { parseUnit, UnitError } from '../units/unit.ts';

export interface AcceptanceTableBound {
  /** Decimal text in the key unit. */
  readonly value: string;
  readonly inclusive: boolean;
}

export interface AcceptanceTableRow {
  /** Lower end of the key range; absent = unbounded. */
  readonly from?: AcceptanceTableBound;
  /** Upper end of the key range; absent = unbounded. */
  readonly to?: AcceptanceTableBound;
  /** Result in the result unit, as decimal text. */
  readonly result: string;
}

export interface AcceptanceTable {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  /** Pharmacopoeia chapter and edition, e.g. "Ph. Eur. 2.9.5 (11th edition)". */
  readonly source: string;
  readonly key: { readonly unit: string; readonly tag?: Tag };
  readonly result: { readonly unit: string; readonly tag?: Tag };
  readonly rows: readonly AcceptanceTableRow[];
}

/** Tables available to a calculation, by id. */
export type AcceptanceTableCatalog = Readonly<Record<string, AcceptanceTable>>;

function inRange(key: Rational, row: AcceptanceTableRow): boolean {
  if (row.from !== undefined) {
    const c = rCmp(key, toRational(Dec.parse(row.from.value)));
    if (row.from.inclusive ? c < 0 : c <= 0) return false;
  }
  if (row.to !== undefined) {
    const c = rCmp(key, toRational(Dec.parse(row.to.value)));
    if (row.to.inclusive ? c > 0 : c >= 0) return false;
  }
  return true;
}

/** Checks a table: ids, units, tags, decimal texts, ranges that are non-empty and never overlap. */
export function validateAcceptanceTable(table: AcceptanceTable): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, text: string): void => {
    out.push(diagnostic(code, 'ERROR', `Acceptance table "${table.id}": ${text}`));
  };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(table.id)) err('EXPR-TBL-001', 'the id must be lower-case letters, digits, ".", "_" or "-"');
  if (table.version.length === 0) err('EXPR-TBL-001', 'a version is required');
  if (table.source.trim().length === 0) err('EXPR-TBL-001', 'the pharmacopoeial source (chapter and edition) is required');
  for (const [what, spec] of [['key', table.key] as const, ['result', table.result] as const]) {
    try {
      const u = parseUnit(spec.unit);
      if (spec.tag !== undefined) {
        if (!isTag(spec.tag)) err('EXPR-TBL-002', `the ${what} tag "${String(spec.tag)}" is unknown`);
        else {
          const p = tagUnitProblem(spec.tag, u);
          if (p !== undefined) err('EXPR-TBL-002', `the ${what} tag does not fit its unit: ${p}`);
        }
      }
      if (u.scale !== 'LINEAR') err('EXPR-TBL-002', `the ${what} cannot be an absolute temperature`);
    } catch (e) {
      if (e instanceof UnitError) err('EXPR-TBL-002', `the ${what} unit is invalid: ${e.message}`);
      else throw e;
    }
  }
  if (table.rows.length === 0) err('EXPR-TBL-003', 'it has no rows');
  const ranges: { from?: Dec; fromInc: boolean; to?: Dec; toInc: boolean; i: number }[] = [];
  table.rows.forEach((row, i) => {
    for (const text of [row.from?.value, row.to?.value, row.result]) {
      if (text !== undefined && !Dec.isValid(text)) err('EXPR-TBL-004', `row ${String(i + 1)}: "${text}" is not a decimal`);
    }
    if (!Dec.isValid(row.result) || (row.from !== undefined && !Dec.isValid(row.from.value)) || (row.to !== undefined && !Dec.isValid(row.to.value))) return;
    const from = row.from === undefined ? undefined : Dec.parse(row.from.value);
    const to = row.to === undefined ? undefined : Dec.parse(row.to.value);
    if (from !== undefined && to !== undefined && (from.gt(to) || (from.eq(to) && !(row.from?.inclusive === true && row.to?.inclusive === true)))) {
      err('EXPR-TBL-005', `row ${String(i + 1)}: the range is empty`);
      return;
    }
    ranges.push({ ...(from === undefined ? {} : { from }), fromInc: row.from?.inclusive ?? true, ...(to === undefined ? {} : { to }), toInc: row.to?.inclusive ?? true, i });
  });
  // Two ranges overlap unless one ends before the other starts.
  for (let a = 0; a < ranges.length; a += 1) {
    for (let b = a + 1; b < ranges.length; b += 1) {
      const x = ranges[a];
      const y = ranges[b];
      if (x === undefined || y === undefined) continue;
      const before = (p: typeof x, q: typeof x): boolean => p.to !== undefined && q.from !== undefined && (p.to.lt(q.from) || (p.to.eq(q.from) && !(p.toInc && q.fromInc)));
      if (!before(x, y) && !before(y, x)) err('EXPR-TBL-006', `rows ${String(x.i + 1)} and ${String(y.i + 1)} overlap`);
    }
  }
  return out;
}

/** The row whose range holds `key` (exact, in the key unit), or undefined. Row numbers start at 0. */
export function lookupAcceptanceTable(table: AcceptanceTable, key: Dec | Rational): { row: number; result: Dec } | undefined {
  const k = key instanceof Dec ? toRational(key) : key;
  for (let i = 0; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    if (row !== undefined && inRange(k, row)) return { row: i, result: Dec.parse(row.result) };
  }
  return undefined;
}
