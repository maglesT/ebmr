/**
 * Nelson's run rules 1, 2, 3 and 5 (D-6A-7: only these four, to keep false alarms low), on the standardised points
 * z = (plotted - centre) / sigma of the point. Each hit names the points it covers (indices into the series).
 *   NELSON_1  one point beyond 3 sigma from the centre line;
 *   NELSON_2  nine or more points in a row on the same side of the centre line (a point on the line breaks the run);
 *   NELSON_3  six or more points in a row steadily increasing or decreasing;
 *   NELSON_5  two of three points in a row beyond 2 sigma on the same side (the beyond points are named; windows that
 *             overlap are one hit).
 * A run is reported once, as its longest extent.
 */
export type NelsonRule = 'NELSON_1' | 'NELSON_2' | 'NELSON_3' | 'NELSON_5';

export interface RuleHit {
  readonly rule: NelsonRule;
  /** The indices of the points of the hit, ascending. */
  readonly points: readonly number[];
  /** +1 above the centre line (or increasing), -1 below (or decreasing). */
  readonly direction: 1 | -1;
}

function nelson1(z: readonly number[]): RuleHit[] {
  const out: RuleHit[] = [];
  z.forEach((v, i) => {
    if (Math.abs(v) > 3) out.push({ rule: 'NELSON_1', points: [i], direction: v > 0 ? 1 : -1 });
  });
  return out;
}

function nelson2(z: readonly number[], length = 9): RuleHit[] {
  const out: RuleHit[] = [];
  let start = 0;
  for (let i = 1; i <= z.length; i++) {
    const side = (k: number): number => Math.sign(z[k]!);
    const sameRun = i < z.length && side(i) !== 0 && side(i) === side(start);
    if (sameRun) continue;
    if (side(start) !== 0 && i - start >= length) out.push({ rule: 'NELSON_2', points: range(start, i), direction: side(start) > 0 ? 1 : -1 });
    start = i;
  }
  return out;
}

function nelson3(z: readonly number[], length = 6): RuleHit[] {
  const out: RuleHit[] = [];
  // steps[k] is the direction from point k to point k + 1; a run of equal non-zero steps a..b covers points a..b + 1.
  const steps = z.slice(1).map((v, k) => Math.sign(v - z[k]!));
  let a = 0;
  for (let k = 1; k <= steps.length; k++) {
    if (k < steps.length && steps[k] === steps[a]) continue;
    const dir = steps[a] ?? 0;
    if (dir !== 0 && k - a + 1 >= length) out.push({ rule: 'NELSON_3', points: range(a, k + 1), direction: dir > 0 ? 1 : -1 });
    a = k;
  }
  return out;
}

function nelson5(z: readonly number[]): RuleHit[] {
  const out: RuleHit[] = [];
  for (const side of [1, -1] as const) {
    let current: number[] | null = null;
    let lastWindow = -10;
    for (let w = 0; w + 3 <= z.length; w++) {
      const beyond = [w, w + 1, w + 2].filter((k) => side * z[k]! > 2);
      if (beyond.length < 2) continue;
      if (current && w <= lastWindow + 2) {
        for (const k of beyond) if (!current.includes(k)) current.push(k);
      } else {
        if (current) out.push({ rule: 'NELSON_5', points: [...current].sort((a, b) => a - b), direction: side });
        current = [...beyond];
      }
      lastWindow = w;
    }
    if (current) out.push({ rule: 'NELSON_5', points: [...current].sort((a, b) => a - b), direction: side });
  }
  return out.sort((a, b) => a.points[0]! - b.points[0]!);
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, k) => from + k);

/** The hits of the chosen rules, in rule order and then by first point. */
export function nelsonHits(z: readonly number[], rules: readonly string[]): RuleHit[] {
  const out: RuleHit[] = [];
  if (rules.includes('NELSON_1')) out.push(...nelson1(z));
  if (rules.includes('NELSON_2')) out.push(...nelson2(z));
  if (rules.includes('NELSON_3')) out.push(...nelson3(z));
  if (rules.includes('NELSON_5')) out.push(...nelson5(z));
  return out;
}

export const RULE_TEXT: Readonly<Record<NelsonRule, string>> = {
  NELSON_1: 'Nelson rule 1: a point beyond 3 sigma from the centre line',
  NELSON_2: 'Nelson rule 2: nine or more points in a row on one side of the centre line',
  NELSON_3: 'Nelson rule 3: six or more points in a row steadily increasing or decreasing',
  NELSON_5: 'Nelson rule 5: two of three points in a row beyond 2 sigma on the same side',
};
