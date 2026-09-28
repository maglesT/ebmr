/**
 * Selection of the MBR version a batch may use at issue (INV-01; ADR 0014 item 6; outline 5.2.1),
 * as a pure function over the facts the database holds. The database function
 * recipe.select_version_for_issue is the authority (it runs in the issue transaction and again in the
 * pin trigger); this model states the rule in one place for readers, lets the designer and the issue
 * screen explain a refusal before the command, and is proven equal to the database function by a
 * model-based test and law-checked by property tests.
 *
 * Rule: the newest version CURRENT for every market in the set; otherwise the newest version CURRENT
 * or BRIDGING for every market; otherwise refused with an explanation per market. A cell is valid at
 * `at` when effectiveFrom <= at < validUntil (open when absent) and its version was APPROVED at `at`
 * and past its own effective date. A BRIDGING cell is usable only when the batch's market set
 * includes a market where the bridging's successor is not CURRENT-valid (in the same scope, at `at`).
 * India must be in every set (INV-28); the batch size must be one of the family's (PR-01).
 *
 * Instants are ISO-8601 UTC strings of one fixed format (the database's recipe.utc_text), which
 * order correctly as text.
 */
import type { IssueScope, MarketCode, SelectionBasis } from './types.ts';

export interface VersionFacts {
  id: string;
  number: number;
  /** The version's own effective date (PR-02); never usable before it. */
  effectiveFrom: string | null;
  /** When the version entered APPROVED, and when it left it (RETIRED or WITHDRAWN), if it did. */
  approvedFrom: string | null;
  approvedUntil: string | null;
  /** Markets of the version's content header (the master is linked to them, PR-04). */
  markets: MarketCode[];
}

export interface CellFacts {
  id: string;
  authorisationId: string;
  versionId: string;
  market: MarketCode;
  site: string;
  line: string;
  batchSize: string;
  kind: 'CURRENT' | 'BRIDGING';
  effectiveFrom: string;
  validUntil: string | null;
  successorVersionId: string | null;
}

export interface SelectionInput {
  family: string;
  batchSizes: readonly string[];
  versions: readonly VersionFacts[];
  cells: readonly CellFacts[];
  markets: readonly MarketCode[];
  scope: IssueScope;
  at: string;
}

export type ModelSelection =
  | { ok: true; rule: 'CURRENT_FOR_EVERY_MARKET' | 'CURRENT_OR_BRIDGING'; versionId: string; versionNumber: number; basis: SelectionBasis[] }
  | { ok: false; reason: string; markets?: { market: MarketCode; current: number[]; bridging: number[]; linked: boolean }[] };

interface Valid {
  cell: CellFacts;
  version: VersionFacts;
  validity: 'CURRENT' | 'BRIDGING';
}

const within = (from: string, until: string | null, at: string): boolean => from <= at && (until === null || at < until);

/** The cells valid at `at` for the scope and market set (CURRENT, and BRIDGING the set may use). */
export function validCells(input: SelectionInput, markets: readonly MarketCode[]): Valid[] {
  const versions = new Map(input.versions.map((v) => [v.id, v]));
  const base: { cell: CellFacts; version: VersionFacts }[] = [];
  for (const cell of input.cells) {
    const version = versions.get(cell.versionId);
    if (!version) continue;
    if (cell.site !== input.scope.site || cell.line !== input.scope.line || cell.batchSize !== input.scope.batch_size) continue;
    if (!markets.includes(cell.market)) continue;
    if (!within(cell.effectiveFrom, cell.validUntil, input.at)) continue;
    if (version.effectiveFrom === null || version.effectiveFrom > input.at) continue;
    if (version.approvedFrom === null || !within(version.approvedFrom, version.approvedUntil, input.at)) continue;
    base.push({ cell, version });
  }
  const current = base.filter((x) => x.cell.kind === 'CURRENT');
  const out: Valid[] = current.map((x) => ({ ...x, validity: 'CURRENT' }));
  for (const b of base) {
    if (b.cell.kind !== 'BRIDGING') continue;
    const gap = markets.some((m) => !current.some((s) => s.cell.versionId === b.cell.successorVersionId && s.cell.market === m));
    if (gap) out.push({ ...b, validity: 'BRIDGING' });
  }
  return out;
}

function newestCovering(valid: readonly Valid[], markets: readonly MarketCode[]): VersionFacts | undefined {
  const byVersion = new Map<string, { version: VersionFacts; markets: Set<string> }>();
  for (const v of valid) {
    const entry = byVersion.get(v.version.id) ?? { version: v.version, markets: new Set<string>() };
    entry.markets.add(v.cell.market);
    byVersion.set(v.version.id, entry);
  }
  return [...byVersion.values()].filter((e) => markets.every((m) => e.markets.has(m))).sort((a, b) => b.version.number - a.version.number)[0]?.version;
}

export function selectVersion(input: SelectionInput): ModelSelection {
  const markets = [...new Set(input.markets)].sort();
  if (markets.length === 0 || markets.some((m) => !/^[A-Z]{2}$/.test(m))) return { ok: false, reason: 'A batch names its market set as two-letter market codes (INV-01)' };
  if (!markets.includes('IN')) return { ok: false, reason: 'India (IN) must be in every market set (INV-28; INV-01)' };
  if (!input.scope.site.trim() || !input.scope.line.trim() || !input.scope.batch_size.trim()) return { ok: false, reason: 'A batch names its scope: site, line and batch size (INV-01)' };
  if (!input.batchSizes.includes(input.scope.batch_size)) return { ok: false, reason: `Batch size ${input.scope.batch_size} is not an approved batch size of family ${input.family} (PR-01; INV-01)` };
  const valid = validCells(input, markets);
  const current = newestCovering(
    valid.filter((v) => v.validity === 'CURRENT'),
    markets,
  );
  const chosen = current ?? newestCovering(valid, markets);
  if (chosen) {
    const basis = markets.map((m) => {
      const candidates = valid.filter((v) => v.version.id === chosen.id && v.cell.market === m).sort((a, b) => (a.validity === b.validity ? 0 : a.validity === 'CURRENT' ? -1 : 1));
      const c = candidates[0] as Valid;
      return { market: m, validity: c.validity, cell_id: c.cell.id, authorisation_id: c.cell.authorisationId };
    });
    return { ok: true, rule: current ? 'CURRENT_FOR_EVERY_MARKET' : 'CURRENT_OR_BRIDGING', versionId: chosen.id, versionNumber: chosen.number, basis };
  }
  const detail = markets.map((m) => ({
    market: m,
    current: [...new Set(valid.filter((v) => v.cell.market === m && v.validity === 'CURRENT').map((v) => v.version.number))].sort((a, b) => b - a),
    bridging: [...new Set(valid.filter((v) => v.cell.market === m && v.validity === 'BRIDGING').map((v) => v.version.number))].sort((a, b) => b - a),
    linked: input.versions.some((v) => v.approvedFrom !== null && v.markets.includes(m)),
  }));
  return { ok: false, reason: `No single version of MBR family ${input.family} is CURRENT or BRIDGING for every market in {${markets.join(', ')}}`, markets: detail };
}
