/**
 * The simulated balance's load model (module C5): what is on the pan, zero and tare, settling after every change,
 * noise at the resolution while settling, capacity (overload) and the underload range, plus injectable faults.
 *
 * Every mass is an integer count of 10^-scale of the unit (bigint), so no binary floating point touches a weight;
 * values leave the model as decimal text. Randomness comes from a seeded generator and time from an injectable
 * clock, so the same seed, clock and sequence of actions give the same readings (determinism test).
 */
import { fromCounts, scaleOf, toCounts } from '@ebmr/integration-sdk/scale';

export const FAULTS = ['OFFLINE', 'UNSTABLE', 'OVERLOAD', 'SLOW', 'GARBLED', 'SERIAL_MISMATCH', 'DRIFT'] as const;
export type Fault = (typeof FAULTS)[number];

/** Milliseconds from any fixed origin; only differences are used. */
export interface SimClock {
  nowMs(): number;
}

export const realClock: SimClock = { nowMs: () => performance.now() };

/** A clock the tests move by hand. */
export class ManualClock implements SimClock {
  constructor(private t = 0) {}
  nowMs(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** mulberry32: a small seeded generator (uniform in [0, 1)). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScaleModelOptions {
  serial: string;
  /** Readability d as decimal text, e.g. "0.001". */
  resolution: string;
  unit: string;
  /** Maximum capacity as decimal text, e.g. "60.000". */
  capacity: string;
  seed: number;
  clock?: SimClock;
  /** Time to settle after a load change (default 1200 ms). */
  settleMs?: number;
  /** Noise amplitude while settling, in counts of d (default 4). */
  noiseSteps?: number;
  /** The serial reported under the SERIAL_MISMATCH fault. */
  wrongSerial?: string;
}

export type WeightState =
  | { kind: 'WEIGHT'; stable: boolean; value: string }
  | { kind: 'OVERLOAD' }
  | { kind: 'UNDERLOAD' };

export interface ModelState {
  serial: string;
  unit: string;
  resolution: string;
  capacity: string;
  load: string;
  zeroOffset: string;
  tare: string;
  display: WeightState;
  faults: Fault[];
}

export class ScaleModel {
  readonly scale: number;
  readonly step: bigint;
  readonly capacityCounts: bigint;
  private readonly clock: SimClock;
  private readonly settleMs: number;
  private readonly noiseSteps: number;
  private random: () => number;
  private readonly seed: number;
  /** Mass on the pan (counts), the value it is settling from, and when it changed. */
  private load = 0n;
  private from = 0n;
  private changedAt: number;
  private zeroOffset = 0n;
  private tare = 0n;
  readonly faults = new Set<Fault>();

  constructor(readonly options: ScaleModelOptions) {
    this.scale = scaleOf(options.resolution);
    this.step = toCounts(options.resolution, this.scale);
    if (this.step <= 0n) throw new RangeError('the resolution must be positive');
    this.capacityCounts = toCounts(options.capacity, this.scale);
    this.clock = options.clock ?? realClock;
    this.settleMs = options.settleMs ?? 1200;
    this.noiseSteps = options.noiseSteps ?? 4;
    this.seed = options.seed;
    this.random = seededRandom(options.seed);
    this.changedAt = this.clock.nowMs() - this.settleMs;
  }

  /** Back to an empty pan, zero and tare cleared, no faults, the generator re-seeded. */
  reset(): void {
    this.load = 0n;
    this.from = 0n;
    this.zeroOffset = 0n;
    this.tare = 0n;
    this.faults.clear();
    this.random = seededRandom(this.seed);
    this.changedAt = this.clock.nowMs() - this.settleMs;
  }

  get serial(): string {
    return this.faults.has('SERIAL_MISMATCH') ? (this.options.wrongSerial ?? 'SIM-9999') : this.options.serial;
  }

  counts(mass: string): bigint {
    return toCounts(mass, this.scale);
  }

  text(counts: bigint): string {
    return fromCounts(counts, this.scale);
  }

  private change(to: bigint): void {
    this.from = this.settlingLoad();
    this.load = to;
    this.changedAt = this.clock.nowMs();
  }

  /** Puts a mass on the pan (decimal text in the unit). */
  add(mass: string): void {
    this.change(this.load + this.counts(mass));
  }

  /** Sets the mass on the pan. */
  set(mass: string): void {
    this.change(this.counts(mass));
  }

  /** Takes everything off the pan. */
  removeAll(): void {
    this.change(0n);
  }

  setFault(fault: Fault, on: boolean): void {
    if (on) this.faults.add(fault);
    else this.faults.delete(fault);
  }

  private settled(): boolean {
    return this.clock.nowMs() - this.changedAt >= this.settleMs;
  }

  /** The load the pan shows now, following a linear settle from the previous load. */
  private settlingLoad(): bigint {
    const t = this.clock.nowMs() - this.changedAt;
    if (t >= this.settleMs) return this.load;
    const remaining = BigInt(Math.max(0, Math.min(1000, Math.round(((this.settleMs - t) / this.settleMs) * 1000))));
    return this.load + ((this.from - this.load) * remaining) / 1000n;
  }

  /** Rounds to the nearest multiple of d (half away from zero). */
  private quantize(c: bigint): bigint {
    const negative = c < 0n;
    const a = negative ? -c : c;
    const r = a % this.step;
    const q = r * 2n >= this.step ? a - r + this.step : a - r;
    return negative ? -q : q;
  }

  private noise(): bigint {
    const k = Math.floor(this.random() * (2 * this.noiseSteps + 1)) - this.noiseSteps;
    return BigInt(k) * this.step;
  }

  /** Stable when settled and no UNSTABLE fault. */
  isStable(): boolean {
    return this.settled() && !this.faults.has('UNSTABLE');
  }

  /** Gross (from the zero point) without tare, as the pan shows it now, before noise. */
  private gross(): bigint {
    return this.settlingLoad() - this.zeroOffset;
  }

  /** What the display shows now (net of tare), as S/SI would report it; `noisy` false for a noise-free look. */
  read(noisy = true): WeightState {
    const gross = this.gross();
    if (this.faults.has('OVERLOAD') || gross > this.capacityCounts + 9n * this.step) return { kind: 'OVERLOAD' };
    if (gross < -(this.capacityCounts / 50n)) return { kind: 'UNDERLOAD' };
    const stable = this.isStable();
    let shown = gross - this.tare;
    if (!stable && noisy) shown += this.noise();
    if (stable && this.faults.has('DRIFT')) {
      const since = this.clock.nowMs() - this.changedAt - this.settleMs;
      shown += BigInt(Math.floor(since / 1000)) * this.step;
    }
    return { kind: 'WEIGHT', stable, value: this.text(this.quantize(shown)) };
  }

  /** T: takes the current gross as tare when stable. */
  tareNow(): { status: 'S'; value: string } | { status: 'I' | '+' | '-' } {
    const r = this.read(false);
    if (r.kind === 'OVERLOAD') return { status: '+' };
    if (r.kind === 'UNDERLOAD') return { status: '-' };
    if (!r.stable) return { status: 'I' };
    this.tare = this.quantize(this.gross());
    return { status: 'S', value: this.text(this.tare) };
  }

  /** Z: sets the zero point to the current load when stable (tare cleared). */
  zeroNow(): 'A' | 'I' | '+' | '-' {
    const r = this.read(false);
    if (r.kind === 'OVERLOAD') return '+';
    if (r.kind === 'UNDERLOAD') return '-';
    if (!r.stable) return 'I';
    this.zeroOffset = this.settlingLoad();
    this.tare = 0n;
    return 'A';
  }

  /** A deterministic garbled line (GARBLED fault): the right shape, with bytes a balance never sends. */
  garble(line: string): string {
    const chars = [...line];
    const i = Math.floor(this.random() * Math.max(1, chars.length));
    const junk = ['\u0007', '#', 'ÿ', '?', '\u0000'];
    chars[i] = junk[Math.floor(this.random() * junk.length)] ?? '#';
    const out = chars.join('');
    return out === line ? `${line}\u0007` : out;
  }

  state(): ModelState {
    return {
      serial: this.serial,
      unit: this.options.unit,
      resolution: this.options.resolution,
      capacity: this.options.capacity,
      load: this.text(this.load),
      zeroOffset: this.text(this.zeroOffset),
      tare: this.text(this.tare),
      display: this.read(false),
      faults: [...this.faults].sort(),
    };
  }
}
