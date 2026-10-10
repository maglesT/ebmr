/**
 * Compendial rule sets of the Tablets edition IPC blocks (tablets spec E.1 to E.5; S-8, S-10; D-S3-2). A rule set is
 * versioned master data: its code and version, the pharmacopoeia, the test, the markets it binds in-process, the tablet
 * types it covers, its parameters (decimal text, never a JavaScript number for a GMP value), a confidence, a source
 * reference and the dates it is effective from and to. Values are paraphrased from the spec's tables; no pharmacopoeia
 * text is reproduced. The database holds the same rows (tablets 0890, tab.compendial_rule_set); a test compares them.
 *
 * Market resolution (IN-34, IN-52): India is in every batch's market set, so the IP rule set is always bound for an
 * in-process test; the rule sets of the batch's other markets are bound beside it and every one must pass (ALL_APPLY,
 * ADR 0008 decision 4): for band rules of the same shape that is the tightest band, for time limits the shortest. The
 * in-house "legacy" weight table (IN-34) is bound only where the MBR opts in, and since it is never tighter than IP it
 * can never loosen the result. Every evaluation records the codes and versions it used (DI-10).
 *
 * Codes hold no digits: a test run's record holds them, and the sandbox identifier rule reads a word with a letter and
 * a digit as a possible real batch or lot number.
 */

export const TABLET_TYPES = [
  'UNCOATED',
  'FILM_COATED',
  'SUGAR_COATED',
  'OTHER_COATED',
  'GASTRO_RESISTANT',
  'EFFERVESCENT',
  'SOLUBLE',
  'DISPERSIBLE',
  'ORODISPERSIBLE',
  'CHEWABLE',
] as const;
export type TabletType = (typeof TABLET_TYPES)[number];

export type RuleTest = 'UNIFORMITY_OF_WEIGHT' | 'WEIGHT_VARIATION' | 'SUBDIVISION' | 'FRIABILITY' | 'DISINTEGRATION';
export type Pharmacopoeia = 'IP' | 'PH_EUR' | 'USP' | 'IN_HOUSE';
export type Confidence = 'HIGH' | 'MEDIUM_HIGH' | 'MEDIUM' | 'MEDIUM_LOW' | 'LOW' | 'NOT_APPLICABLE';

export interface Band {
  /** Upper end of the average-mass range in mg; absent for the last band. */
  upToMg?: string;
  inclusive?: boolean;
  /** Deviation allowed from the measured average, %. */
  percent: string;
}

export interface UniformityParams {
  units: number;
  bands: Band[];
  maxOutside: number;
  maxOutsideDouble: number;
}

export interface WeightVariationParams {
  firstUnits: number;
  totalUnits: number;
  firstK: string;
  secondK: string;
  acceptanceLimit: string;
  unitLimitPercent: string;
  referenceLow: string;
  referenceHigh: string;
  avDecimals: number;
}

export interface SubdivisionParams {
  units: number;
  innerPercent: string;
  outerPercent: string;
  maxOutsideInner: number;
  maxOutsideOuter: number;
}

export interface FriabilityParams {
  maxLossPercent: string;
  rotations: number;
  rpmMin: string;
  rpmMax: string;
  targetSampleGrams: string;
  heavyUnitMg: string;
  heavyUnitCount: number;
  repeatRuns: number;
  lossDecimals: number;
}

export interface DisintegrationType {
  /** Time limit in minutes; absent where the monograph sets it (USP). */
  minutes?: string;
  tempMin: string;
  tempMax: string;
  /** Gastro-resistant: the acid stage in minutes (no disintegration or cracks), then the buffer stage of `minutes`. */
  acidMinutes?: string;
}

export interface DisintegrationParams {
  units: number;
  /** Retest staging: when failMin to failMax units fail, retestUnits more are tested; pass when passMin of all pass. */
  staging: { failMin: number; failMax: number; retestUnits: number; passMin: number };
  types: Partial<Record<TabletType, DisintegrationType>>;
}

export type RuleParams = UniformityParams | WeightVariationParams | SubdivisionParams | FriabilityParams | DisintegrationParams;

export interface RuleSet {
  code: string;
  version: number;
  test: RuleTest;
  pharmacopoeia: Pharmacopoeia;
  /** Markets whose batches it binds in-process; empty for an in-house table the MBR opts into. */
  markets: string[];
  tabletTypes: TabletType[];
  params: RuleParams;
  confidence: Confidence;
  source: string;
  effectiveFrom: string;
  effectiveTo?: string;
  note?: string;
}

const UOW_BANDS: Band[] = [
  { upToMg: '80', inclusive: true, percent: '10' },
  { upToMg: '250', inclusive: false, percent: '7.5' },
  { percent: '5' },
];

const WV: WeightVariationParams = {
  firstUnits: 10,
  totalUnits: 30,
  firstK: '2.4',
  secondK: '2.0',
  acceptanceLimit: '15.0',
  unitLimitPercent: '25.0',
  referenceLow: '98.5',
  referenceHigh: '101.5',
  avDecimals: 1,
};

const FRIABILITY: FriabilityParams = {
  maxLossPercent: '1.0',
  rotations: 100,
  rpmMin: '24',
  rpmMax: '26',
  targetSampleGrams: '6.5',
  heavyUnitMg: '650',
  heavyUnitCount: 10,
  repeatRuns: 3,
  lossDecimals: 1,
};

const BODY = { tempMin: '35', tempMax: '39' };
const COOL = { tempMin: '15', tempMax: '25' };
const STAGING = { failMin: 1, failMax: 2, retestUnits: 12, passMin: 16 };

/** The shipped rule sets (version 1 each). */
export const RULE_SETS: readonly RuleSet[] = [
  {
    code: 'IP-UOW',
    version: 1,
    test: 'UNIFORMITY_OF_WEIGHT',
    pharmacopoeia: 'IP',
    markets: ['IN'],
    tabletTypes: ['UNCOATED', 'FILM_COATED'],
    params: { units: 20, bands: UOW_BANDS, maxOutside: 2, maxOutsideDouble: 0 },
    confidence: 'MEDIUM',
    source: 'Indian Pharmacopoeia uniformity of weight, bands as tablets spec E.2 and control IN-34 (IP 2026 text not seen)',
    effectiveFrom: '2023-12-28',
    note: 'Consistent with the sample BMR (plus or minus 7.5 % of the average); confirm against IP 2026 (India G-8).',
  },
  {
    code: 'PHEUR-UOW',
    version: 1,
    test: 'UNIFORMITY_OF_WEIGHT',
    pharmacopoeia: 'PH_EUR',
    markets: ['EU'],
    tabletTypes: ['UNCOATED', 'FILM_COATED'],
    params: { units: 20, bands: UOW_BANDS, maxOutside: 2, maxOutsideDouble: 0 },
    confidence: 'HIGH',
    source: 'Ph. Eur. uniformity of mass of single-dose preparations, tablet row (tablets spec E.2)',
    effectiveFrom: '2023-12-28',
    note: 'Sugar-coated tablets are outside the tablet row (medium confidence). Effective date not verified.',
  },
  {
    code: 'LEGACY-UOW',
    version: 1,
    test: 'UNIFORMITY_OF_WEIGHT',
    pharmacopoeia: 'IN_HOUSE',
    markets: [],
    tabletTypes: ['UNCOATED', 'FILM_COATED', 'SUGAR_COATED', 'OTHER_COATED', 'GASTRO_RESISTANT', 'EFFERVESCENT', 'SOLUBLE', 'DISPERSIBLE', 'ORODISPERSIBLE', 'CHEWABLE'],
    params: {
      units: 20,
      bands: [
        { upToMg: '130', inclusive: true, percent: '10' },
        { upToMg: '324', inclusive: true, percent: '7.5' },
        { percent: '5' },
      ],
      maxOutside: 2,
      maxOutsideDouble: 0,
    },
    confidence: 'NOT_APPLICABLE',
    source: 'In-house legacy table of control IN-34 (the dietary-supplement values, not a USP requirement for drug tablets)',
    effectiveFrom: '2023-12-28',
    note: 'Bound only where the MBR opts in; IP and Ph. Eur. are equal or tighter at every weight. Inclusivity at 324 mg not verified.',
  },
  {
    code: 'IP-UDU',
    version: 1,
    test: 'WEIGHT_VARIATION',
    pharmacopoeia: 'IP',
    markets: ['IN'],
    tabletTypes: ['UNCOATED', 'FILM_COATED'],
    params: WV,
    confidence: 'LOW',
    source: 'Indian Pharmacopoeia uniformity of dosage units by weight variation (adoption of the harmonised chapter not confirmed; tablets spec E.3)',
    effectiveFrom: '2023-12-28',
  },
  {
    code: 'PHEUR-UDU',
    version: 1,
    test: 'WEIGHT_VARIATION',
    pharmacopoeia: 'PH_EUR',
    markets: ['EU'],
    tabletTypes: ['UNCOATED', 'FILM_COATED'],
    params: WV,
    confidence: 'MEDIUM_HIGH',
    source: 'Ph. Eur. uniformity of dosage units, weight variation by acceptance value (harmonised; tablets spec C-14, E.3)',
    effectiveFrom: '2023-12-28',
  },
  {
    code: 'USP-UDU',
    version: 1,
    test: 'WEIGHT_VARIATION',
    pharmacopoeia: 'USP',
    markets: ['US'],
    tabletTypes: ['UNCOATED', 'FILM_COATED'],
    params: WV,
    confidence: 'MEDIUM_HIGH',
    source: 'USP uniformity of dosage units, weight variation by acceptance value (harmonised; tablets spec C-14, E.3)',
    effectiveFrom: '2023-08-01',
  },
  {
    code: 'PHEUR-SUBDIVISION',
    version: 1,
    test: 'SUBDIVISION',
    pharmacopoeia: 'PH_EUR',
    markets: ['EU'],
    tabletTypes: ['UNCOATED', 'FILM_COATED'],
    params: { units: 30, innerPercent: '15', outerPercent: '25', maxOutsideInner: 1, maxOutsideOuter: 0 },
    confidence: 'MEDIUM',
    source: 'Ph. Eur. monograph Tablets, subdivision of scored tablets (tablets spec TB-12 mode (e))',
    effectiveFrom: '2023-12-28',
    note: 'Recollection; verify against the current text.',
  },
  {
    code: 'IP-FRIABILITY',
    version: 1,
    test: 'FRIABILITY',
    pharmacopoeia: 'IP',
    markets: ['IN'],
    tabletTypes: ['UNCOATED', 'FILM_COATED', 'SUGAR_COATED', 'OTHER_COATED', 'GASTRO_RESISTANT', 'EFFERVESCENT', 'SOLUBLE', 'DISPERSIBLE', 'ORODISPERSIBLE', 'CHEWABLE'],
    params: FRIABILITY,
    confidence: 'MEDIUM_LOW',
    source: 'Indian Pharmacopoeia friability, expected to follow the harmonised procedure (tablets spec E.4; IP 2026 not seen)',
    effectiveFrom: '2023-12-28',
  },
  {
    code: 'PHEUR-FRIABILITY',
    version: 1,
    test: 'FRIABILITY',
    pharmacopoeia: 'PH_EUR',
    markets: ['EU'],
    tabletTypes: ['UNCOATED', 'FILM_COATED', 'SUGAR_COATED', 'OTHER_COATED', 'GASTRO_RESISTANT', 'EFFERVESCENT', 'SOLUBLE', 'DISPERSIBLE', 'ORODISPERSIBLE', 'CHEWABLE'],
    params: FRIABILITY,
    confidence: 'HIGH',
    source: 'Ph. Eur. friability of uncoated tablets (harmonised; tablets spec E.4)',
    effectiveFrom: '2023-08-01',
  },
  {
    code: 'USP-FRIABILITY',
    version: 1,
    test: 'FRIABILITY',
    pharmacopoeia: 'USP',
    markets: ['US'],
    tabletTypes: ['UNCOATED', 'FILM_COATED', 'SUGAR_COATED', 'OTHER_COATED', 'GASTRO_RESISTANT', 'EFFERVESCENT', 'SOLUBLE', 'DISPERSIBLE', 'ORODISPERSIBLE', 'CHEWABLE'],
    params: FRIABILITY,
    confidence: 'HIGH',
    source: 'USP tablet friability (informational chapter, harmonised; tablets spec E.4): the 1.0 % binds once the specification adopts it',
    effectiveFrom: '2023-08-01',
  },
  {
    code: 'IP-DISINTEGRATION',
    version: 1,
    test: 'DISINTEGRATION',
    pharmacopoeia: 'IP',
    markets: ['IN'],
    tabletTypes: ['UNCOATED', 'FILM_COATED', 'SUGAR_COATED', 'OTHER_COATED', 'GASTRO_RESISTANT', 'EFFERVESCENT', 'SOLUBLE', 'DISPERSIBLE', 'ORODISPERSIBLE'],
    params: {
      units: 6,
      staging: STAGING,
      types: {
        UNCOATED: { minutes: '15', ...BODY },
        FILM_COATED: { minutes: '30', ...BODY },
        SUGAR_COATED: { minutes: '60', ...BODY },
        OTHER_COATED: { minutes: '60', ...BODY },
        GASTRO_RESISTANT: { minutes: '60', acidMinutes: '120', ...BODY },
        EFFERVESCENT: { minutes: '5', ...COOL },
        SOLUBLE: { minutes: '3', ...COOL },
        DISPERSIBLE: { minutes: '3', ...COOL },
        ORODISPERSIBLE: { minutes: '3', ...BODY },
      },
    },
    confidence: 'LOW',
    source: 'Indian Pharmacopoeia disintegration, expected to follow the limits of tablets spec E.5 (IP 2026 not seen)',
    effectiveFrom: '2023-12-28',
  },
  {
    code: 'PHEUR-DISINTEGRATION',
    version: 1,
    test: 'DISINTEGRATION',
    pharmacopoeia: 'PH_EUR',
    markets: ['EU'],
    tabletTypes: ['UNCOATED', 'FILM_COATED', 'SUGAR_COATED', 'OTHER_COATED', 'GASTRO_RESISTANT', 'EFFERVESCENT', 'SOLUBLE', 'DISPERSIBLE', 'ORODISPERSIBLE'],
    params: {
      units: 6,
      staging: STAGING,
      types: {
        UNCOATED: { minutes: '15', ...BODY },
        FILM_COATED: { minutes: '30', ...BODY },
        SUGAR_COATED: { minutes: '60', ...BODY },
        OTHER_COATED: { minutes: '60', ...BODY },
        GASTRO_RESISTANT: { minutes: '60', acidMinutes: '120', ...BODY },
        EFFERVESCENT: { minutes: '5', ...COOL },
        SOLUBLE: { minutes: '3', ...COOL },
        DISPERSIBLE: { minutes: '3', ...COOL },
        ORODISPERSIBLE: { minutes: '3', ...BODY },
      },
    },
    confidence: 'MEDIUM',
    source: 'Ph. Eur. disintegration of tablets and the monograph Tablets (tablets spec E.5)',
    effectiveFrom: '2023-12-28',
    note: 'Uncoated 15 min high confidence; the other types medium or lower; retest staging as harmonised wording.',
  },
  {
    code: 'USP-DISINTEGRATION',
    version: 1,
    test: 'DISINTEGRATION',
    pharmacopoeia: 'USP',
    markets: ['US'],
    tabletTypes: ['UNCOATED', 'FILM_COATED', 'SUGAR_COATED', 'OTHER_COATED', 'GASTRO_RESISTANT', 'EFFERVESCENT', 'SOLUBLE', 'DISPERSIBLE', 'ORODISPERSIBLE'],
    params: {
      units: 6,
      staging: STAGING,
      types: {
        UNCOATED: BODY,
        FILM_COATED: BODY,
        SUGAR_COATED: BODY,
        OTHER_COATED: BODY,
        GASTRO_RESISTANT: BODY,
        EFFERVESCENT: BODY,
        SOLUBLE: BODY,
        DISPERSIBLE: BODY,
        ORODISPERSIBLE: BODY,
      },
    },
    confidence: 'HIGH',
    source: 'USP disintegration (harmonised apparatus and staging; the time is the monograph\'s, tablets spec E.5)',
    effectiveFrom: '2023-12-28',
  },
];

/** The UTC date of an instant in epoch microseconds (YYYY-MM-DD). */
export function utcDate(us: bigint): string {
  // Days since 1970-01-01 to a civil date (proleptic Gregorian), in integers only.
  let z = us / 86_400_000_000n - (us < 0n && us % 86_400_000_000n !== 0n ? 1n : 0n) + 719_468n;
  const era = (z >= 0n ? z : z - 146_096n) / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const day = doy - (153n * mp + 2n) / 5n + 1n;
  const month = mp < 10n ? mp + 3n : mp - 9n;
  z = yoe + era * 400n + (month <= 2n ? 1n : 0n);
  const pad = (n: bigint, w: number) => n.toString().padStart(w, '0');
  return `${pad(z, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * The rule sets bound for `test` on a batch of `markets` (IN always included), for tablet type `type`, effective on
 * `date` (YYYY-MM-DD): those of the batch's markets, plus the in-house table where the MBR opts in (`optIn`); the latest
 * version of a code effective on that date. Sorted by code.
 */
export function resolveRuleSets(test: RuleTest, markets: readonly string[], type: TabletType | undefined, date: string, optIn = false): RuleSet[] {
  const set = new Set([...markets, 'IN']);
  const out = new Map<string, RuleSet>();
  for (const r of RULE_SETS) {
    if (r.test !== test) continue;
    if (!(r.markets.some((m) => set.has(m)) || (optIn && r.pharmacopoeia === 'IN_HOUSE'))) continue;
    if (type === undefined || !r.tabletTypes.includes(type)) continue;
    if (r.effectiveFrom > date || (r.effectiveTo !== undefined && r.effectiveTo <= date)) continue;
    const prev = out.get(r.code);
    if (!prev || prev.version < r.version) out.set(r.code, r);
  }
  return [...out.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * Markets whose pharmacopoeia has, by decision recorded here, no in-process rule set for a test (review 3c finding 5):
 * the batch's market is covered by this record instead of a rule set. Any other batch market without a rule set for the
 * test and tablet type fails the check closed. The database holds the same rows (tablets 0890,
 * tab.compendial_not_applicable).
 */
export interface NotApplicable {
  test: RuleTest;
  market: string;
  reason: string;
  source: string;
  effectiveFrom: string;
}

export const NOT_APPLICABLE: readonly NotApplicable[] = [
  {
    test: 'UNIFORMITY_OF_WEIGHT',
    market: 'US',
    reason: 'USP-NF sets no compendial in-process weight band for drug tablets; in-process limits are in-house, derived from process data, and uniformity is judged at release by uniformity of dosage units',
    source: '21 CFR 211.110(b); tablets spec E.2 (USP-NF row)',
    effectiveFrom: '2023-12-28',
  },
];

/**
 * The batch's markets (IN always) that neither a rule set bound for `test` and `type` on `date` nor a not-applicable
 * record covers (sorted): a check is refused while any remains (fail closed).
 */
export function uncoveredMarkets(test: RuleTest, markets: readonly string[], type: TabletType | undefined, date: string): string[] {
  const bound = resolveRuleSets(test, markets, type, date);
  return [...new Set([...markets, 'IN'])]
    .filter((m) => !bound.some((r) => r.markets.includes(m)))
    .filter((m) => !NOT_APPLICABLE.some((n) => n.test === test && n.market === m && n.effectiveFrom <= date))
    .sort();
}

/**
 * The procedure parameter `key` the bound rule sets share (sample size, rotations, staging, ...): the value when every set
 * gives the same, undefined when they differ (a check is then refused: the sets do not say one procedure).
 */
export function shared<T = unknown>(sets: readonly RuleSet[], key: string): T | undefined {
  const vs = sets.map((r) => JSON.stringify((r.params as unknown as Record<string, unknown>)[key]));
  return vs.length > 0 && vs.every((v) => v === vs[0]) ? ((sets[0]?.params as unknown as Record<string, unknown>)[key] as T) : undefined;
}

/** The procedure keys each test's bound rule sets must agree on. */
export const PROCEDURE_KEYS: Record<RuleTest, readonly string[]> = {
  UNIFORMITY_OF_WEIGHT: ['units'],
  WEIGHT_VARIATION: ['firstUnits', 'totalUnits'],
  SUBDIVISION: ['units'],
  FRIABILITY: ['rotations', 'rpmMin', 'rpmMax', 'targetSampleGrams', 'heavyUnitMg', 'heavyUnitCount', 'repeatRuns', 'lossDecimals'],
  DISINTEGRATION: ['units', 'staging'],
};

/** Why the bound rule sets cannot be used for a check: a market not covered, or procedures that differ; else undefined. */
export function ruleSetProblem(test: RuleTest, sets: readonly RuleSet[], markets: readonly string[], type: TabletType | undefined, date: string): string | undefined {
  const open = uncoveredMarkets(test, markets, type, date);
  if (open.length > 0) return `no rule set covers ${String(type)} tablets for market ${open.join(', ')}, and no record says none applies`;
  const differ = PROCEDURE_KEYS[test].filter((k) => shared(sets, k) === undefined);
  if (sets.length > 0 && differ.length > 0) return `the bound rule sets give different procedures (${differ.join(', ')})`;
  return undefined;
}

/** The rule sets an earlier entry recorded ([{code, version}]), as shipped. */
export function recorded(refs: unknown): RuleSet[] {
  const list = Array.isArray(refs) ? (refs as { code?: unknown; version?: unknown }[]) : [];
  return list.map((x) => RULE_SETS.find((r) => r.code === x.code && r.version === x.version)).filter((r): r is RuleSet => r !== undefined);
}

export const ref = (r: RuleSet): { code: string; version: number } => ({ code: r.code, version: r.version });
