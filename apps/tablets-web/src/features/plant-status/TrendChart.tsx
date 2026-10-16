/**
 * The trend chart (Phase 6 slice 6b; DI-32): native samples of one tag drawn straight from the series chunks the server
 * holds (contract ns/equipment-data.ts SeriesChunkView), with interactive zoom and pan over source time. Nothing is
 * pre-rendered, down-sampled or cached as an image: every redraw reads the chunks again, so a batch whose chunks come
 * from a restored archive (a database restored from its backup, or the archive copy of the record) re-renders and zooms
 * the same way as live data (D-P6b-L-2).
 *
 * Times stay epoch microseconds as bigint; a pixel position is the only number made from them (BigInt arithmetic, then
 * a whole pixel). A shown value is drawn at a pixel height computed from its decimal text; that is presentation only:
 * the table under the chart shows every sample of the window as received (raw text, shown decimal, status code and
 * quality), never a recomputed value. A BAD sample has no value and is drawn as a gap.
 */
import { useMemo, useRef, useState, type PointerEvent } from 'react';
import type { NativeSampleView, SeriesChunkView } from '@ebmr/api-contract';
import { Button } from '@ebmr/ui-kit';

const W = 1000n;
const H = 240;
const PAD = 8;

export interface TrendSample extends NativeSampleView {
  t: bigint;
  chunkNo: string;
}

/** Every sample of the chunks, oldest first (chunks may arrive in any order; a sample's place is its source time). */
export function samplesOf(chunks: readonly SeriesChunkView[]): TrendSample[] {
  const out: TrendSample[] = [];
  for (const c of chunks) for (const s of c.samples) out.push({ ...s, t: BigInt(s.sourceTime), chunkNo: c.chunkNo });
  return out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

/** Source time in microseconds as UTC text with all six fraction digits (display only). */
export function utcText(us: bigint): string {
  const ms = us / 1000n;
  const micro = (us % 1_000_000n).toString().padStart(6, '0');
  const iso = new Date(Number(ms)).toISOString();
  return `${iso.slice(0, 19)}.${micro}Z`;
}

interface Window {
  from: bigint;
  to: bigint;
}

function clamp(w: Window, full: Window): Window {
  const span = w.to - w.from;
  const fullSpan = full.to - full.from;
  if (span >= fullSpan) return full;
  if (w.from < full.from) return { from: full.from, to: full.from + span };
  if (w.to > full.to) return { from: full.to - span, to: full.to };
  return w;
}

export function TrendChart({ chunks, unit: tagUnit, tag }: { chunks: readonly SeriesChunkView[]; unit: string; tag: string }) {
  // The unit each chunk was stored with (the tag's unit while the tag list loads or for a chunk-less window).
  const unit = chunks[0]?.unit ?? tagUnit;
  const all = useMemo(() => samplesOf(chunks), [chunks]);
  const full: Window | null = all.length > 0 ? { from: all[0]!.t, to: all[all.length - 1]!.t === all[0]!.t ? all[0]!.t + 1n : all[all.length - 1]!.t } : null;
  const [zoom, setZoom] = useState<Window | null>(null);
  const drag = useRef<{ x0: number } | null>(null);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  if (!full) return <p data-testid="trend-empty">No sample of {tag} in this window.</p>;
  const win = zoom ? clamp(zoom, full) : full;
  const span = win.to - win.from > 0n ? win.to - win.from : 1n;
  const inWin = all.filter((s) => s.t >= win.from && s.t <= win.to);
  const valued = inWin.filter((s) => s.value !== null);
  // Presentation only: the vertical scale of the drawn line (the values themselves are shown as text below).
  const nums = valued.map((s) => Number(s.value));
  const lo = nums.length ? Math.min(...nums) : 0;
  const hi = nums.length ? Math.max(...nums) : 1;
  const yOf = (v: number): number => (hi === lo ? H / 2 : PAD + ((hi - v) * (H - 2 * PAD)) / (hi - lo));
  const xOf = (t: bigint): number => Number(((t - win.from) * W) / span);
  // A BAD sample (no value) breaks the line: one polyline per run of valued samples.
  const runs: TrendSample[][] = [];
  let run: TrendSample[] = [];
  for (const s of inWin) {
    if (s.value === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(s);
  }
  if (run.length) runs.push(run);

  const zoomBy = (num: bigint, den: bigint) => {
    const mid = win.from + span / 2n;
    const half = (span * num) / den / 2n > 0n ? (span * num) / den / 2n : 1n;
    setZoom(clamp({ from: mid - half, to: mid + half }, full));
  };
  const pan = (dir: 1n | -1n) => setZoom(clamp({ from: win.from + (dir * span) / 2n, to: win.to + (dir * span) / 2n }, full));
  const isFull = win.from === full.from && win.to === full.to;

  // Drag across the chart to zoom to the dragged span (pointer position as a fraction of the drawn width).
  const frac = (e: PointerEvent<SVGSVGElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { x0: frac(e) };
    setSel({ a: drag.current.x0, b: drag.current.x0 });
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current) setSel({ a: drag.current.x0, b: frac(e) });
  };
  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    setSel(null);
    if (!d) return;
    const a = Math.min(d.x0, frac(e));
    const b = Math.max(d.x0, frac(e));
    if (b - a < 0.01) return;
    const at = (f: number): bigint => win.from + (span * BigInt(Math.round(f * 10_000))) / 10_000n;
    setZoom(clamp({ from: at(a), to: at(b) }, full));
  };

  return (
    <div data-testid="trend-chart" data-from-us={win.from.toString()} data-to-us={win.to.toString()}>
      <p data-testid="trend-window">
        {tag} ({unit}): {inWin.length} of {all.length} samples, {utcText(win.from)} to {utcText(win.to)}
        {isFull ? ' (all)' : ' (zoomed)'}
      </p>
      <div role="group" aria-label="Zoom">
        <Button onPress={() => zoomBy(1n, 2n)}>Zoom in</Button>
        <Button onPress={() => zoomBy(2n, 1n)} isDisabled={isFull}>
          Zoom out
        </Button>
        <Button onPress={() => pan(-1n)} isDisabled={win.from === full.from}>
          Earlier
        </Button>
        <Button onPress={() => pan(1n)} isDisabled={win.to === full.to}>
          Later
        </Button>
        <Button onPress={() => setZoom(null)} isDisabled={isFull}>
          Show all
        </Button>
      </div>
      <svg
        role="img"
        aria-label={`Trend of ${tag}`}
        viewBox={`0 0 ${W.toString()} ${H.toString()}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: `${H.toString()}px`, border: '1px solid currentColor', touchAction: 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {runs.map((r, i) => (
          <polyline key={i} data-testid="trend-run" fill="none" stroke="currentColor" strokeWidth={2} points={r.map((s) => `${xOf(s.t).toString()},${yOf(Number(s.value)).toFixed(1)}`).join(' ')} />
        ))}
        {valued.map((s) => (
          <circle key={`${s.chunkNo}-${s.sourceTime}`} data-testid="trend-point" data-source-time={s.sourceTime} cx={xOf(s.t)} cy={yOf(Number(s.value))} r={3} fill="currentColor">
            <title>{`${utcText(s.t)}: ${s.value ?? ''} ${unit} (raw ${s.raw}, ${s.quality})`}</title>
          </circle>
        ))}
        {sel ? <rect x={Math.min(sel.a, sel.b) * 1000} y={0} width={Math.abs(sel.b - sel.a) * 1000} height={H} fill="currentColor" opacity={0.15} /> : null}
      </svg>
      <table data-testid="trend-samples">
        <caption>Samples in the window, as received</caption>
        <thead>
          <tr>
            <th scope="col">Source time (UTC)</th>
            <th scope="col">Raw</th>
            <th scope="col">Shown ({unit})</th>
            <th scope="col">Status</th>
            <th scope="col">Quality</th>
            <th scope="col">Chunk</th>
          </tr>
        </thead>
        <tbody>
          {inWin.map((s) => (
            <tr key={`${s.chunkNo}-${s.sourceTime}`} data-testid={`trend-sample-${s.sourceTime}`}>
              <td>{utcText(s.t)}</td>
              <td>{s.raw}</td>
              <td>{s.value ?? 'No value'}</td>
              <td>{s.status}</td>
              <td>{s.quality}</td>
              <td>{s.chunkNo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
