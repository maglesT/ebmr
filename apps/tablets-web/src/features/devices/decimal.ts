/**
 * Decimal text for the gauge (browser-safe; weights stay text, never JavaScript numbers). Comparisons and the
 * gauge geometry work on integer counts (bigint); only the marker's position on screen becomes a percentage.
 */
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export function isDecimal(text: string): boolean {
  return DECIMAL.test(text);
}

function scaleOf(text: string): number {
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function counts(text: string, scale: number): bigint {
  const negative = text.startsWith('-');
  const [int = '0', frac = ''] = (negative ? text.slice(1) : text).split('.');
  const c = BigInt(int + frac.padEnd(scale, '0'));
  return negative ? -c : c;
}

/** -1, 0 or 1. */
export function compareDecimal(a: string, b: string): number {
  const s = Math.max(scaleOf(a), scaleOf(b));
  const x = counts(a, s);
  const y = counts(b, s);
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface Band {
  low?: string;
  high?: string;
  target?: string;
  unit: string;
}

export interface GaugeGeometry {
  /** Percent positions (0-100) on the bar; null when not shown. */
  lowPct: number | null;
  highPct: number | null;
  targetPct: number | null;
  valuePct: number | null;
  /** Where the live value sits against the band (display only). */
  position: 'BELOW' | 'IN' | 'ABOVE' | null;
}

/**
 * The bar spans the band with a quarter of its width on each side (or 0 to twice the target without limits);
 * the value marker is clamped to the bar.
 */
export function gaugeGeometry(value: string | null, band: Band | undefined): GaugeGeometry | null {
  if (!band) return null;
  const texts = [band.low, band.high, band.target, value ?? undefined].filter((x): x is string => x !== undefined && isDecimal(x));
  if (texts.length === 0) return null;
  const s = Math.max(...texts.map(scaleOf));
  const c = (t: string | undefined): bigint | null => (t !== undefined && isDecimal(t) ? counts(t, s) : null);
  const low = c(band.low);
  const high = c(band.high);
  const target = c(band.target);
  let from: bigint;
  let to: bigint;
  if (low !== null && high !== null && high > low) {
    const margin = (high - low) / 4n || 1n;
    from = low - margin;
    to = high + margin;
  } else if (target !== null && target > 0n) {
    from = 0n;
    to = target * 2n;
  } else {
    return null;
  }
  const pct = (x: bigint | null): number | null => {
    if (x === null) return null;
    const clamped = x < from ? from : x > to ? to : x;
    return Number(((clamped - from) * 1000n) / (to - from)) / 10;
  };
  const v = value !== null && isDecimal(value) ? counts(value, s) : null;
  let position: GaugeGeometry['position'] = null;
  if (v !== null && (low !== null || high !== null)) position = low !== null && v < low ? 'BELOW' : high !== null && v > high ? 'ABOVE' : 'IN';
  return { lowPct: pct(low), highPct: pct(high), targetPct: pct(target), valuePct: pct(v), position };
}
