/**
 * The plots of slice 6A-3 as inline SVG (advisory statistics only): a statistic per batch against its limit (T-squared,
 * Q), the scores of the first two components, and a batch's contributions as bars. Each plot has a text alternative and
 * the screens list the same numbers in a table.
 */
const W = 640;
const H = 220;
const PAD = { left: 56, right: 80, top: 12, bottom: 28 };
const INK = 'var(--ebmr-text, #1b1b1b)';
const MUTED = 'var(--ebmr-muted, #6b6b6b)';
const ALERT = 'var(--ebmr-error-fg, #a4161a)';
const INFO = 'var(--ebmr-info-fg, #0b4f8a)';

const scale = (lo: number, hi: number, a: number, b: number) => (v: number): number => a + ((v - lo) / (hi - lo || 1)) * (b - a);

export interface Point {
  label: string;
  value: number;
  /** Above its own limit. */
  above: boolean;
  /** A reference batch (drawn hollow). */
  reference: boolean;
}

/** A statistic per batch, in completion order, with its limit lines. */
export function LimitPlot({ title, points, limits, testId }: { title: string; points: readonly Point[]; limits: readonly { value: number; label: string }[]; testId: string }) {
  const all = [0, ...points.map((p) => p.value), ...limits.map((l) => l.value)];
  const hi = Math.max(...all) * 1.08 || 1;
  const y = scale(0, hi, H - PAD.bottom, PAD.top);
  const x = scale(0, Math.max(points.length - 1, 1), PAD.left, W - PAD.right);
  const above = points.filter((p) => p.above).length;
  return (
    <figure style={{ margin: 0 }} data-testid={testId}>
      <svg viewBox={`0 0 ${W.toString()} ${H.toString()}`} role="img" aria-label={`${title}: ${points.length.toString()} batches, ${above.toString()} above the limit`} style={{ width: '100%', maxWidth: W }}>
        {limits.map((l) => (
          <g key={l.label}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(l.value)} y2={y(l.value)} stroke={INFO} strokeDasharray="6 3" />
            <text x={W - PAD.right + 4} y={y(l.value) + 4} fontSize={11} fill={INFO}>{l.label}</text>
          </g>
        ))}
        {points.map((p, k) => (
          <circle key={p.label} cx={x(k)} cy={y(p.value)} r={p.above ? 4.5 : 3} fill={p.reference ? 'none' : p.above ? ALERT : INK} stroke={p.above ? ALERT : INK}>
            <title>{`${p.label}: ${p.value.toPrecision(4)}${p.reference ? ' (reference batch)' : ''}${p.above ? ' (above the limit)' : ''}`}</title>
          </circle>
        ))}
        <text x={PAD.left} y={H - 8} fontSize={11} fill={MUTED}>batches in completion order →</text>
      </svg>
      <figcaption>{title} (advisory statistics, not GMP values; hollow: reference batch)</figcaption>
    </figure>
  );
}

/** The scores of the first two components (or the first against batch order when the model keeps one). */
export function ScoresPlot({ points, testId }: { points: readonly { label: string; scores: readonly number[]; flagged: boolean; reference: boolean }[]; testId: string }) {
  const two = points.every((p) => p.scores.length >= 2);
  const xs = points.map((p, k) => (two ? p.scores[0]! : k));
  const ys = points.map((p) => (two ? p.scores[1]! : p.scores[0] ?? 0));
  const pad = (v: readonly number[]) => [Math.min(...v, 0), Math.max(...v, 0)] as const;
  const [x0, x1] = pad(xs);
  const [y0, y1] = pad(ys);
  const x = scale(x0, x1, PAD.left, W - PAD.right);
  const y = scale(y0, y1, H - PAD.bottom, PAD.top);
  return (
    <figure style={{ margin: 0 }} data-testid={testId}>
      <svg viewBox={`0 0 ${W.toString()} ${H.toString()}`} role="img" aria-label={`Scores plot of ${points.length.toString()} batches`} style={{ width: '100%', maxWidth: W }}>
        <line x1={x(0)} x2={x(0)} y1={PAD.top} y2={H - PAD.bottom} stroke={MUTED} />
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke={MUTED} />
        {points.map((p, k) => (
          <circle key={p.label} cx={x(xs[k]!)} cy={y(ys[k]!)} r={p.flagged ? 4.5 : 3} fill={p.reference ? 'none' : p.flagged ? ALERT : INK} stroke={p.flagged ? ALERT : INK}>
            <title>{`${p.label}: ${p.scores.map((s) => s.toPrecision(3)).join(', ')}`}</title>
          </circle>
        ))}
        <text x={PAD.left} y={H - 8} fontSize={11} fill={MUTED}>{two ? 'component 1 →, component 2 ↑' : 'batch order →, component 1 ↑'}</text>
      </svg>
      <figcaption>Scores of the batches on the model&apos;s components (advisory statistics, not GMP values)</figcaption>
    </figure>
  );
}

/** A batch's contributions to T-squared and Q, one pair of bars per variable. */
export function ContributionBars({ rows, testId }: { rows: readonly { variable: string; t2: number; q: number }[]; testId: string }) {
  const rowH = 26;
  const h = PAD.top + rows.length * rowH + PAD.bottom;
  const max = Math.max(...rows.flatMap((r) => [Math.abs(r.t2), r.q]), 1e-12);
  const left = 200;
  const half = (W - left - 20) / 2;
  const w = (v: number) => (Math.abs(v) / max) * (half - 10);
  return (
    <figure style={{ margin: 0 }} data-testid={testId}>
      <svg viewBox={`0 0 ${W.toString()} ${h.toString()}`} role="img" aria-label={`Contributions of ${rows.length.toString()} variables to T-squared and Q`} style={{ width: '100%', maxWidth: W }}>
        <text x={left} y={10} fontSize={11} fill={INFO}>T-squared</text>
        <text x={left + half} y={10} fontSize={11} fill={ALERT}>Q</text>
        {rows.map((r, k) => (
          <g key={r.variable} data-testid={`${testId}-${r.variable}`}>
            <text x={4} y={PAD.top + k * rowH + 16} fontSize={11} fill={INK}>{r.variable}</text>
            <rect x={left} y={PAD.top + k * rowH + 6} width={w(r.t2)} height={10} fill={INFO}><title>{`T-squared contribution ${r.t2.toPrecision(4)}`}</title></rect>
            <rect x={left + half} y={PAD.top + k * rowH + 6} width={w(r.q)} height={10} fill={ALERT}><title>{`Q contribution ${r.q.toPrecision(4)}`}</title></rect>
          </g>
        ))}
      </svg>
      <figcaption>Each variable&apos;s contribution (advisory statistics, not GMP values)</figcaption>
    </figure>
  );
}
