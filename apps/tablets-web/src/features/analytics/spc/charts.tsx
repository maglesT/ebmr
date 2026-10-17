/**
 * The two plots of slice 6A-2 as inline SVG (advisory statistics only): a control chart (points in batch order with the
 * centre line, the control limits and, where stated, the master's specification limits; a point a run rule hit is
 * marked) and a funnel (each group's share of batches with a deviation against its size, with the comparison limits).
 * Each plot has a text alternative, and the screens list the same numbers in a table.
 */
import type { ReactNode } from 'react';

const W = 640;
const H = 220;
const PAD = { left: 56, right: 72, top: 12, bottom: 28 };
const INK = 'var(--ebmr-text, #1b1b1b)';
const MUTED = 'var(--ebmr-muted, #6b6b6b)';
const ALERT = 'var(--ebmr-error-fg, #a4161a)';
const INFO = 'var(--ebmr-info-fg, #0b4f8a)';

function scale(lo: number, hi: number, outLo: number, outHi: number): (v: number) => number {
  const span = hi - lo || 1;
  return (v) => outLo + ((v - lo) / span) * (outHi - outLo);
}

function HLine({ y, label, colour, dash }: { y: number; label: string; colour: string; dash?: string | undefined }) {
  return (
    <g>
      <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke={colour} strokeDasharray={dash} strokeWidth={1} />
      <text x={W - PAD.right + 4} y={y + 4} fontSize={11} fill={colour}>{label}</text>
    </g>
  );
}

export interface ChartLine {
  value: number;
  label: string;
  kind: 'centre' | 'control' | 'specification';
}

/** A control chart of `values` (in batch order) with its lines; `marked` points are drawn as rule hits. */
export function ControlPlot({ title, values, lines, marked, testId }: { title: string; values: readonly number[]; lines: readonly ChartLine[]; marked: readonly boolean[]; testId?: string }) {
  const all = [...values, ...lines.map((l) => l.value)];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const margin = (hi - lo) * 0.08 || 1;
  const y = scale(lo - margin, hi + margin, H - PAD.bottom, PAD.top);
  const x = scale(0, Math.max(values.length - 1, 1), PAD.left, W - PAD.right);
  const path = values.map((v, k) => `${k === 0 ? 'M' : 'L'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const colour = (k: ChartLine['kind']): string => (k === 'centre' ? INK : k === 'control' ? INFO : ALERT);
  const hits = marked.filter(Boolean).length;
  return (
    <figure style={{ margin: 0 }} data-testid={testId}>
      <svg viewBox={`0 0 ${W.toString()} ${H.toString()}`} role="img" aria-label={`${title}: ${values.length.toString()} points, ${hits.toString()} marked by a run rule`} style={{ width: '100%', maxWidth: W }}>
        {lines.map((l) => <HLine key={`${l.kind}-${l.label}`} y={y(l.value)} label={l.label} colour={colour(l.kind)} dash={l.kind === 'centre' ? undefined : l.kind === 'control' ? '6 3' : '2 3'} />)}
        <path d={path} fill="none" stroke={MUTED} strokeWidth={1.5} />
        {values.map((v, k) => (
          <circle key={k} cx={x(k)} cy={y(v)} r={marked[k] ? 4.5 : 3} fill={marked[k] ? ALERT : INK}>
            <title>{`Point ${(k + 1).toString()}: ${v.toPrecision(5)}${marked[k] ? ' (run rule)' : ''}`}</title>
          </circle>
        ))}
        <text x={PAD.left} y={H - 8} fontSize={11} fill={MUTED}>batches in completion order →</text>
      </svg>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

export interface FunnelGroup {
  group: string;
  batches: number;
  share: number;
  above: boolean;
  lower: number;
  upper: number;
}

/** A funnel plot: each group's share against its batches, the overall share and each group's comparison limits. */
export function FunnelPlot({ title, overall, groups, children }: { title: string; overall: number; groups: readonly FunnelGroup[]; children?: ReactNode }) {
  const maxN = Math.max(...groups.map((g) => g.batches), 1);
  const x = scale(0, maxN, PAD.left, W - PAD.right);
  const y = scale(0, 1, H - PAD.bottom, PAD.top);
  const byN = [...groups].sort((a, b) => a.batches - b.batches);
  const limit = (side: 'lower' | 'upper'): string => byN.map((g, k) => `${k === 0 ? 'M' : 'L'}${x(g.batches).toFixed(1)},${y(g[side]).toFixed(1)}`).join(' ');
  return (
    <figure style={{ margin: 0 }} data-testid="analytics-rates-funnel">
      <svg viewBox={`0 0 ${W.toString()} ${H.toString()}`} role="img" aria-label={`${title}: ${groups.length.toString()} groups, ${groups.filter((g) => g.above).length.toString()} above the rest`} style={{ width: '100%', maxWidth: W }}>
        <HLine y={y(overall)} label={`overall ${(overall * 100).toPrecision(3)} %`} colour={INK} />
        {byN.length > 1 ? <path d={limit('upper')} fill="none" stroke={INFO} strokeDasharray="6 3" /> : null}
        {byN.length > 1 ? <path d={limit('lower')} fill="none" stroke={INFO} strokeDasharray="6 3" /> : null}
        {groups.map((g) => (
          <g key={g.group}>
            <circle cx={x(g.batches)} cy={y(g.share)} r={g.above ? 5 : 3.5} fill={g.above ? ALERT : INK}>
              <title>{`${g.group}: ${(g.share * 100).toPrecision(3)} % of ${g.batches.toString()} batches${g.above ? ' (above the rest)' : ''}`}</title>
            </circle>
            <text x={x(g.batches) + 6} y={y(g.share) - 6} fontSize={11} fill={g.above ? ALERT : MUTED}>{g.group}</text>
          </g>
        ))}
        <text x={PAD.left} y={H - 8} fontSize={11} fill={MUTED}>batches in the group →</text>
      </svg>
      <figcaption>{title}{children}</figcaption>
    </figure>
  );
}
