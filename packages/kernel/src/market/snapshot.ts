/**
 * Build a resolver snapshot straight from a validated rule-table document, for simulation and
 * tests without a database. Row ids are the row refs. Production resolutions use a published
 * version (loadRuleTableVersion), whose rows have database ids.
 */
import { MarketRuleError } from './errors.ts';
import type { RuleKeyDoc, RuleTableDocument, RuleTableSnapshot, SnapshotRow } from './types.ts';
import { validateRuleTableDocument } from './validate.ts';

export function snapshotFromDocument(doc: RuleTableDocument, versionId = `file:${doc.table}.v${doc.version}`): RuleTableSnapshot {
  const problems = validateRuleTableDocument(doc);
  if (problems.length > 0) {
    const [first] = problems;
    throw new MarketRuleError(first?.code ?? 'EBMR-MKT-010', first?.message ?? 'invalid rule table');
  }
  const keys = new Map<string, RuleKeyDoc>(doc.keys.map((k) => [k.key, k]));
  const rows: SnapshotRow[] = doc.rows.map((r) => ({
    id: r.ref,
    ref: r.ref,
    key: r.key,
    market: r.market,
    predicate: r.predicate ?? {},
    value: r.value,
    unit: r.unit,
    floor: r.floor,
    hardFloor: r.hardFloor ?? null,
    source: r.source,
    verification: r.verification,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo ?? null,
    note: r.note ?? null,
  }));
  return Object.freeze({ versionId, tableCode: doc.table, version: doc.version, keys, rows: Object.freeze(rows) });
}
