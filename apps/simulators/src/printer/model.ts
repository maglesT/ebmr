/**
 * The simulated line printer (Phase 3 slice 4a, G-21, K-20): a coder that holds one print job (the record's variable
 * data and a layout), prints units at a set rate while the line runs, inspects each with a code reader and a vision
 * system, answers challenges with known-bad test units, and keeps its own numbered event log per power cycle (boot).
 *
 * Counts are bigint; randomness comes from a seeded generator and time from an injectable clock, so the same seed,
 * clock and actions give the same output.
 *
 * Faults:
 *  - OFFLINE: the printer does not answer (the server drops and refuses connections); the line keeps printing and the
 *    printer keeps its events until it is read again;
 *  - MISPRINT: a unit printed while it is on is misprinted with probability MISPRINT_PERCENT (seeded): its vision
 *    result is FAIL;
 *  - READER_FAIL: the code reader fails: every reader result is FAIL, a reader challenge FAILs, and the printer logs
 *    the fault (FAULT READER_FAIL, then READER_FAIL_CLEARED);
 *  - JOB_MISMATCH: a job loaded while it is on is held with the expiry one year later than sent, so its echo differs;
 *  - STALE: the controller freezes: no scan, no print, no event, the status as it was.
 *
 * Challenge EXPIRY (Phase 6 slice 6c, PR-36, D-P6c-7): a test unit printed with the expiry one month off the job's is
 * put on the line; the vision system rejects it, the printer logs FAULT EXPIRY_REJECTED and FAULT LINE_STOPPED and the
 * line stops (its reject interlock). The gateway carries both faults to the eBMR, which opens a line stop.
 */
import type { PrintFields, SimPrinterEvent, SimPrinterEventKind, SimPrinterJob } from '@ebmr/integration-sdk/printer';
import { SIM_EVENTS_MAX } from '@ebmr/integration-sdk/printer';
import { realClock, seededRandom, type SimClock } from '../scale/model.ts';

export { ManualClock, realClock, seededRandom, type SimClock } from '../scale/model.ts';

export const PRINTER_FAULTS = ['OFFLINE', 'MISPRINT', 'READER_FAIL', 'JOB_MISMATCH', 'STALE'] as const;
export type PrinterFault = (typeof PRINTER_FAULTS)[number];

/** Milliseconds per controller scan. */
export const PRINTER_SCAN_MS = 100;
/** Units printed per minute while running (default). */
export const DEFAULT_RATE_PER_MIN = 60n;
/** Chance (percent) that a unit printed under MISPRINT is misprinted. */
export const MISPRINT_PERCENT = 50;

export interface PrinterModelOptions {
  serial: string;
  seed: number;
  clock?: SimClock;
  ratePerMin?: bigint;
  /** Running at power-on (default false). */
  running?: boolean;
}

export interface PrinterStatus {
  scan: string;
  running: boolean;
  jobId: string | null;
  printed: string;
}

export interface PrinterModelState extends PrinterStatus {
  serial: string;
  boot: string;
  faults: PrinterFault[];
  job: SimPrinterJob | null;
  /** The last events, newest last (for the console). */
  recent: SimPrinterEvent[];
}

export type PrinterActionResult<T> = { ok: true; value: T } | { ok: false; error: 'NO_JOB' | 'STALE' | 'BAD_TARGET'; message: string };

/** The same record date one year later (a month-precision date stays one; 29 February becomes 28 February). */
function yearLater(date: string): string {
  const y = (BigInt(date.slice(0, 4)) + 1n).toString().padStart(4, '0');
  const rest = date.slice(4);
  return rest === '-02-29' ? `${y}-02-28` : `${y}${rest}`;
}

export class PrinterModel {
  readonly faults = new Set<PrinterFault>();
  private readonly clock: SimClock;
  private readonly seed: number;
  private readonly rate: bigint;
  private random: () => number;
  private startedAt: number;
  private integratedTo: number;
  /** Units x 60000 not yet printed (the remainder of the rate integration). */
  private acc = 0n;
  private running: boolean;
  private job: SimPrinterJob | null = null;
  private printed = 0n;
  private bootNo = 1n;
  private log: SimPrinterEvent[] = [];
  private frozen: PrinterStatus | null = null;

  constructor(readonly options: PrinterModelOptions) {
    this.clock = options.clock ?? realClock;
    this.seed = options.seed;
    this.rate = options.ratePerMin ?? DEFAULT_RATE_PER_MIN;
    this.random = seededRandom(options.seed);
    this.startedAt = this.clock.nowMs();
    this.integratedTo = this.startedAt;
    this.running = options.running ?? false;
  }

  get serial(): string {
    return this.options.serial;
  }

  /** The power cycle: event numbers restart at 1 with each boot. */
  get boot(): string {
    return this.bootNo.toString();
  }

  /** A power cycle: no job, nothing printed, no events, no faults, the generator re-seeded, the next boot. */
  reset(): void {
    this.bootNo += 1n;
    this.job = null;
    this.printed = 0n;
    this.acc = 0n;
    this.log = [];
    this.faults.clear();
    this.frozen = null;
    this.random = seededRandom(this.seed);
    this.running = this.options.running ?? false;
    this.startedAt = this.clock.nowMs();
    this.integratedTo = this.startedAt;
  }

  start(): void {
    this.integrate();
    this.running = true;
  }

  stop(): void {
    this.integrate();
    this.running = false;
  }

  setFault(fault: PrinterFault, on: boolean): void {
    if (on === this.faults.has(fault)) return;
    // Print up to now first, so a fault never changes what was printed before it.
    this.integrate();
    if (fault === 'STALE') {
      this.frozen = on ? this.liveStatus() : null;
      // A frozen controller printed nothing: the line resumes from now.
      if (!on) this.integratedTo = this.clock.nowMs();
    }
    if (on) this.faults.add(fault);
    else this.faults.delete(fault);
    if (fault === 'READER_FAIL') this.record(this.job?.jobId ?? null, 'FAULT', on ? 'READER_FAIL' : 'READER_FAIL_CLEARED');
  }

  private record(jobId: string | null, kind: SimPrinterEventKind, value: string): void {
    const last = this.log.at(-1);
    const no = last ? BigInt(last.no) + 1n : 1n;
    this.log.push({ no: no.toString(), jobId, kind, value });
  }

  /** Prints the units due from the last integration to now (each inspected by the reader and the vision system). */
  private integrate(): void {
    const now = this.clock.nowMs();
    if (this.faults.has('STALE')) return;
    const elapsed = BigInt(Math.max(0, Math.round(now - this.integratedTo)));
    this.integratedTo = now;
    if (!this.running || !this.job) return;
    this.acc += elapsed * this.rate;
    const units = this.acc / 60_000n;
    this.acc -= units * 60_000n;
    for (let i = 0n; i < units; i += 1n) {
      this.printed += 1n;
      const misprint = this.faults.has('MISPRINT') && Math.floor(this.random() * 100) < MISPRINT_PERCENT;
      this.record(this.job.jobId, 'READER_RESULT', this.faults.has('READER_FAIL') ? 'FAIL' : 'PASS');
      this.record(this.job.jobId, 'VISION_RESULT', misprint ? 'FAIL' : 'PASS');
    }
  }

  /** Loads a job; the echo is what the printer now holds (under JOB_MISMATCH, not what was sent). */
  load(job: SimPrinterJob): SimPrinterJob {
    this.integrate();
    const fields: PrintFields = this.faults.has('JOB_MISMATCH') ? { ...job.fields, expiryDate: yearLater(job.fields.expiryDate) } : { ...job.fields };
    this.job = { jobId: job.jobId, layoutRef: job.layoutRef, fields };
    this.printed = 0n;
    this.acc = 0n;
    return structuredClone(this.job);
  }

  /** Clears the job: the printer holds none and prints nothing. */
  clear(): void {
    this.integrate();
    this.job = null;
    this.printed = 0n;
    this.acc = 0n;
  }

  /** A challenge of the code reader or the vision system with a known-bad test unit: PASS when it is rejected as it must be. */
  challenge(target: string): PrinterActionResult<'PASS' | 'FAIL'> {
    if (target !== 'READER' && target !== 'VISION' && target !== 'EXPIRY') return { ok: false, error: 'BAD_TARGET', message: `${target} is not READER, VISION or EXPIRY` };
    if (this.faults.has('STALE')) return { ok: false, error: 'STALE', message: 'the controller does not respond' };
    this.integrate();
    if (!this.job) return { ok: false, error: 'NO_JOB', message: 'a challenge runs on a loaded job' };
    if (target === 'EXPIRY') {
      // The vision system reads another expiry than the job's on the test unit: rejected, and the line stops.
      this.record(this.job.jobId, 'FAULT', 'EXPIRY_REJECTED');
      this.record(this.job.jobId, 'FAULT', 'LINE_STOPPED');
      this.running = false;
      return { ok: true, value: 'PASS' };
    }
    const result = target === 'READER' && this.faults.has('READER_FAIL') ? 'FAIL' : 'PASS';
    this.record(this.job.jobId, 'CHALLENGE_RESULT', result);
    return { ok: true, value: result };
  }

  private liveStatus(): PrinterStatus {
    const scan = BigInt(Math.max(0, Math.floor((this.clock.nowMs() - this.startedAt) / PRINTER_SCAN_MS)));
    return { scan: scan.toString(), running: this.running, jobId: this.job?.jobId ?? null, printed: this.printed.toString() };
  }

  /** What a read of the controller returns now (frozen while STALE). */
  status(): PrinterStatus {
    this.integrate();
    return this.frozen ?? this.liveStatus();
  }

  /** The events numbered after `after` in this boot, at most SIM_EVENTS_MAX, and whether more follow. */
  events(after: bigint): { events: SimPrinterEvent[]; more: boolean } {
    this.integrate();
    // Event numbers run 1, 2, 3, ... in this boot: event n sits at index n - 1.
    const from = after > BigInt(this.log.length) ? this.log.length : Number(after);
    return { events: this.log.slice(from, from + SIM_EVENTS_MAX), more: this.log.length - from > SIM_EVENTS_MAX };
  }

  state(): PrinterModelState {
    return { serial: this.serial, boot: this.boot, faults: [...this.faults].sort(), job: this.job ? structuredClone(this.job) : null, recent: this.log.slice(-12), ...this.status() };
  }
}
