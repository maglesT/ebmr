/**
 * The golden band chart (Phase 6A slice 6A-6; method GBP.DTW_BAND; DI-51): over the profile's normalised step time,
 * the band of the reference batches (shaded), the reference curve (the medoid, dashed) and the batch's curve aligned to
 * it (solid), with the points outside the band marked. Every number drawn is a statistic of the advisory profile, never
 * a GMP value: the raw samples as recorded are listed in the table beside the chart (ProfileOverlay).
 */
const W = 600;
const H = 220;
const PAD = 8;

export interface BandChartProps {
  low: readonly number[];
  high: readonly number[];
  reference: readonly number[];
  curve: readonly number[];
  unit: string;
}

export function BandChart({ low, high, reference, curve, unit }: BandChartProps) {
  const n = Math.max(low.length, 2);
  const all = [...low, ...high, ...reference, ...curve];
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all) : 1;
  const x = (j: number): number => PAD + (j * (W - 2 * PAD)) / (n - 1);
  const y = (v: number): number => (hi === lo ? H / 2 : PAD + ((hi - v) * (H - 2 * PAD)) / (hi - lo));
  const line = (vs: readonly number[]): string => vs.map((v, j) => `${x(j).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const band = `${line(high)} ${[...low].map((v, j) => ({ v, j })).reverse().map(({ v, j }) => `${x(j).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}`;
  const outside = curve.map((v, j) => ({ v, j })).filter(({ v, j }) => v < (low[j] ?? v) || v > (high[j] ?? v));
  return (
    <figure data-testid="profile-band-chart">
      <svg viewBox={`0 0 ${W.toString()} ${H.toString()}`} width="100%" role="img" aria-label={`Golden band of the reference batches with the batch curve (${unit}, advisory)`}>
        <polygon points={band} fill="var(--ebmr-band, #cfe3f7)" stroke="none" data-testid="profile-band" />
        <polyline points={line(reference)} fill="none" stroke="#555" strokeDasharray="4 3" strokeWidth={1} data-testid="profile-reference" />
        <polyline points={line(curve)} fill="none" stroke="#0b5" strokeWidth={1.5} data-testid="profile-curve" />
        {outside.map(({ v, j }) => <circle key={j} cx={x(j)} cy={y(v)} r={2.5} fill="#c30" data-testid="profile-outside" />)}
      </svg>
      <figcaption>
        Shaded: the band of the reference batches. Dashed: the reference curve. Solid: this batch, aligned by dynamic time warping. Red: points outside the band.
        Normalised step time from left to right, {unit} upwards. Advisory statistics, not GMP values.
      </figcaption>
    </figure>
  );
}
