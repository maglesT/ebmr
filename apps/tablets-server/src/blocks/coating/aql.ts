/**
 * Attribute sampling by AQL for TB-20 (tablets spec TB-20; Phase 3 slice 3d, D-S3-2): the sampling scheme is master data
 * with its source and effective date, never pasted text. The numbers are the published single-sampling scheme of
 * ISO 2859-1 (ANSI/ASQ Z1.4 has the same tables): the sample-size code letter by lot size and general inspection level,
 * the sample size of each letter, and the acceptance and rejection numbers by letter and AQL for normal and tightened
 * inspection, where an arrow in the published table sends the user to the first plan below or above it. The tables are
 * held here in that structure: per severity, the cell of letter i and AQL column j depends only on the diagonal i + j
 * (a plan, or an arrow DOWN or UP), which is how the published tables are laid out. The database holds the expanded
 * plans (tab.aql_sample_code, tab.aql_plan, tablets 0910) and a test compares them with this file.
 *
 * Confidence: medium (recalled from the published scheme, secondary use); the expert checks every row against the
 * current text before validation (review backlog, slice 3d). The company chooses the AQL values (no regulatory numbers).
 */
export const AQL_SCHEME = {
  code: 'AQL-SINGLE-SAMPLING',
  version: '1',
  source: 'ISO 2859-1:1999 (ANSI/ASQ Z1.4-2003): Table I (sample-size code letters), Table II-A (single sampling, normal), Table II-B (single sampling, tightened)',
  effectiveFrom: '1999-11-15',
  confidence: 'MEDIUM',
} as const;

export const INSPECTION_LEVELS = ['I', 'II', 'III'] as const;
export type InspectionLevel = (typeof INSPECTION_LEVELS)[number];
export const SEVERITIES = ['NORMAL', 'TIGHTENED'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The code letters and their sample sizes, in order (index i). */
export const LETTERS = [
  ['A', 2n], ['B', 3n], ['C', 5n], ['D', 8n], ['E', 13n], ['F', 20n], ['G', 32n], ['H', 50n],
  ['J', 80n], ['K', 125n], ['L', 200n], ['M', 315n], ['N', 500n], ['P', 800n], ['Q', 1250n], ['R', 2000n],
] as const;

/** The AQL columns of the published table (index j); the block accepts 0.065 to 4.0. */
export const AQL_COLUMNS = ['0.010', '0.015', '0.025', '0.040', '0.065', '0.10', '0.15', '0.25', '0.40', '0.65', '1.0', '1.5', '2.5', '4.0'] as const;
export const SUPPORTED_AQLS: readonly string[] = AQL_COLUMNS.slice(4);

/** Table I: lot size ranges (inclusive; the last open) and the letter for levels I, II, III. */
export const SAMPLE_CODE_ROWS: readonly { from: bigint; to?: bigint; letters: readonly [string, string, string] }[] = [
  { from: 2n, to: 8n, letters: ['A', 'A', 'B'] },
  { from: 9n, to: 15n, letters: ['A', 'B', 'C'] },
  { from: 16n, to: 25n, letters: ['B', 'C', 'D'] },
  { from: 26n, to: 50n, letters: ['C', 'D', 'E'] },
  { from: 51n, to: 90n, letters: ['C', 'E', 'F'] },
  { from: 91n, to: 150n, letters: ['D', 'F', 'G'] },
  { from: 151n, to: 280n, letters: ['E', 'G', 'H'] },
  { from: 281n, to: 500n, letters: ['F', 'H', 'J'] },
  { from: 501n, to: 1200n, letters: ['G', 'J', 'K'] },
  { from: 1201n, to: 3200n, letters: ['H', 'K', 'L'] },
  { from: 3201n, to: 10000n, letters: ['J', 'L', 'M'] },
  { from: 10001n, to: 35000n, letters: ['K', 'M', 'N'] },
  { from: 35001n, to: 150000n, letters: ['L', 'N', 'P'] },
  { from: 150001n, to: 500000n, letters: ['M', 'P', 'Q'] },
  { from: 500001n, letters: ['N', 'Q', 'R'] },
];

type Cell = readonly [bigint, bigint] | 'DOWN' | 'UP';

/**
 * Tables II-A and II-B by diagonal d = i + j: below `first` the arrow points down, above the last listed diagonal it
 * points up. Normal: 0/1 on d = 14, an up arrow and a down arrow, then 1/2 to 21/22. Tightened: 0/1 on d = 15, two down
 * arrows, then 1/2 to 18/19.
 */
export const DIAGONALS: Readonly<Record<Severity, { first: number; cells: readonly Cell[] }>> = {
  NORMAL: { first: 14, cells: [[0n, 1n], 'UP', 'DOWN', [1n, 2n], [2n, 3n], [3n, 4n], [5n, 6n], [7n, 8n], [10n, 11n], [14n, 15n], [21n, 22n]] },
  TIGHTENED: { first: 15, cells: [[0n, 1n], 'DOWN', 'DOWN', [1n, 2n], [2n, 3n], [3n, 4n], [5n, 6n], [8n, 9n], [12n, 13n], [18n, 19n]] },
};

function cell(severity: Severity, i: number, j: number): Cell {
  const t = DIAGONALS[severity];
  const k = i + j - t.first;
  if (k < 0) return 'DOWN';
  return t.cells[k] ?? 'UP';
}

export interface Plan {
  letter: string;
  /** Sample size of the plan (after the arrows). */
  n: bigint;
  ac: bigint;
  re: bigint;
}

/** The plan of letter `letter` at AQL `aql` (a column of the table), following the arrows; undefined off the table. */
export function planOf(severity: Severity, letter: string, aql: string): Plan | undefined {
  let i = LETTERS.findIndex(([l]) => l === letter);
  const j = (AQL_COLUMNS as readonly string[]).indexOf(aql);
  if (i < 0 || j < 0) return undefined;
  for (;;) {
    const c = cell(severity, i, j);
    if (c === 'DOWN') i += 1;
    else if (c === 'UP') i -= 1;
    else {
      const l = LETTERS[i];
      return l ? { letter: l[0], n: l[1], ac: c[0], re: c[1] } : undefined;
    }
    if (i < 0 || i >= LETTERS.length) return undefined;
  }
}

/** Table I: the letter for a lot of `lotSize` units at inspection level `level` (undefined below 2 units). */
export function codeLetter(lotSize: bigint, level: InspectionLevel): string | undefined {
  const row = SAMPLE_CODE_ROWS.find((r) => lotSize >= r.from && (r.to === undefined || lotSize <= r.to));
  return row?.letters[INSPECTION_LEVELS.indexOf(level)];
}

/** Every plan of the table, expanded (the rows tablets 0910 holds). */
export function expandedPlans(): { severity: Severity; letter: string; aql: string; plan: Plan | undefined }[] {
  const out: { severity: Severity; letter: string; aql: string; plan: Plan | undefined }[] = [];
  for (const severity of SEVERITIES) for (const [letter] of LETTERS) for (const aql of SUPPORTED_AQLS) out.push({ severity, letter, aql, plan: planOf(severity, letter, aql) });
  return out;
}
