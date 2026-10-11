/**
 * The simulated process equipment (Phase 3 slice 3a, G-06): a rotary tablet press and a film coater, each a small
 * controller with setpoints, actual values that follow them with seeded noise, counters (press), alarms with fixed
 * alarm limits, a scan counter, and injectable faults. Since slice 6c (D-S6-8) also the high-shear granulator, the
 * fluid-bed dryer, the blender, the roller compactor, the blister machine, the bottle line and the cartoner: the same
 * controller, with values that hold a nominal level while running, temperatures that follow an inlet setpoint, and
 * counters that integrate a speed setpoint (the press and the coater behave exactly as in slice 3a).
 *
 * Every value is an integer count of 10^-scale of its tag's unit (bigint), so no binary floating point touches a value;
 * values leave the model as decimal text with the tag's fraction digits. Randomness comes from a seeded generator and
 * time from an injectable clock, so the same seed, clock and sequence of actions give the same samples.
 *
 * Faults:
 *  - OFFLINE: the device does not answer (the server drops and refuses connections);
 *  - STALE: the controller output freezes (values, read-backs, alarms and the scan counter stop updating);
 *  - DRIFT: actual values that follow a setpoint drift away from it, DRIFT_STEPS_PER_S steps a second;
 *  - ALARM: an excursion past the alarm limit (press: main compression force overload; coater: inlet temperature);
 *  - SETPOINT_MISMATCH: a setpoint written while it is on lands MISMATCH_STEPS steps above the value sent, so the
 *    read-back differs from the download;
 *  - GARBLED: answers are corrupted on the line (server).
 */
import { fromCounts, toCounts } from '@ebmr/integration-sdk/scale';
import { tagsOf, type EquipmentKind, type SimAlarm, type SimSetpoint, type SimValue, type TagSpec } from '@ebmr/integration-sdk/process';
import { realClock, seededRandom, type SimClock } from '../scale/model.ts';

export { ManualClock, realClock, seededRandom, type SimClock } from '../scale/model.ts';

export const FAULTS = ['OFFLINE', 'STALE', 'DRIFT', 'ALARM', 'SETPOINT_MISMATCH', 'GARBLED'] as const;
export type Fault = (typeof FAULTS)[number];

/** How fast DRIFT moves an actual value away from its setpoint (steps of the tag's resolution per second). */
export const DRIFT_STEPS_PER_S = 5n;
/** How far above the value sent a setpoint written under SETPOINT_MISMATCH lands (steps of the tag's resolution). */
export const MISMATCH_STEPS = 10n;
/** Milliseconds per controller scan (the scan counter). */
export const SCAN_MS = 100;

interface AlarmRule {
  code: string;
  tag: string;
  /** The alarm is active while the actual value is above this. */
  high: string;
}

/** A counter that integrates a speed setpoint while running: `per` units of the counter per revolution or cycle. */
interface CounterRule {
  counter: string;
  rate: string;
  per: bigint;
  /** One in this many of the units counted on `counter` is also counted on this reject counter. */
  reject?: { counter: string; every: bigint };
}

interface Profile {
  equipment: EquipmentKind;
  /** Values that are not setpoints and hold this level while running (zero when stopped), before noise. */
  nominal?: Record<string, string>;
  /** Temperatures below an inlet setpoint (running, idle), in counts of the tag (slice 6c profiles). */
  follows?: Record<string, { from: string; running: bigint; idle: bigint }>;
  /** Setpoints that hold whether the equipment runs or not (a gap, a heater temperature). */
  mechanical?: readonly string[];
  /** Counters (slice 6c profiles). */
  counters?: readonly CounterRule[];
  /** Noise on its values while idle too (temperatures of a heated unit). */
  noiseWhenIdle?: boolean;
  /** Setpoints at power-on. */
  initial: Record<string, string>;
  /** The range the controller accepts for each setpoint (inclusive). */
  limits: Record<string, { min: string; max: string }>;
  /** Noise amplitude of each actual value while running, in steps of its resolution. */
  noise: Record<string, number>;
  alarms: AlarmRule[];
  /** The value the ALARM fault drives a tag to. */
  excursion: { tag: string; value: string };
}

const PRESS: Profile = {
  equipment: 'PRESS',
  initial: { 'turret.speed_rpm': '30.0', 'force.main_kN': '12.00', 'force.pre_kN': '2.00', 'fill.depth_mm': '8.00' },
  limits: {
    'turret.speed_rpm': { min: '0.0', max: '100.0' },
    'force.main_kN': { min: '0.00', max: '80.00' },
    'force.pre_kN': { min: '0.00', max: '20.00' },
    'fill.depth_mm': { min: '2.00', max: '20.00' },
  },
  noise: { 'turret.speed_rpm': 1, 'force.main_kN': 15, 'force.pre_kN': 5, 'fill.depth_mm': 0 },
  alarms: [
    { code: 'MAIN_FORCE_OVERLOAD', tag: 'force.main_kN', high: '80.00' },
    { code: 'PRE_FORCE_OVERLOAD', tag: 'force.pre_kN', high: '20.00' },
  ],
  excursion: { tag: 'force.main_kN', value: '86.40' },
};

const COATER: Profile = {
  equipment: 'COATER',
  initial: { 'pan.speed_rpm': '8.0', 'inlet.temp_C': '60.0', 'spray.rate_g_min': '120.0', 'atomisation.bar': '2.00', 'airflow.m3_h': '1200' },
  limits: {
    'pan.speed_rpm': { min: '0.0', max: '20.0' },
    'inlet.temp_C': { min: '20.0', max: '85.0' },
    'spray.rate_g_min': { min: '0.0', max: '500.0' },
    'atomisation.bar': { min: '0.00', max: '4.00' },
    'airflow.m3_h': { min: '0', max: '3000' },
  },
  noise: { 'pan.speed_rpm': 1, 'inlet.temp_C': 3, 'exhaust.temp_C': 3, 'bed.temp_C': 2, 'spray.rate_g_min': 10, 'atomisation.bar': 2, 'airflow.m3_h': 8 },
  alarms: [
    { code: 'INLET_TEMP_HIGH', tag: 'inlet.temp_C', high: '90.0' },
    { code: 'EXHAUST_TEMP_HIGH', tag: 'exhaust.temp_C', high: '75.0' },
  ],
  excursion: { tag: 'inlet.temp_C', value: '96.5' },
};

const GRANULATOR: Profile = {
  equipment: 'GRANULATOR',
  initial: { 'granulator.impeller_rpm': '150', 'granulator.chopper_rpm': '1500' },
  limits: { 'granulator.impeller_rpm': { min: '0', max: '400' }, 'granulator.chopper_rpm': { min: '0', max: '3000' } },
  nominal: { 'granulator.power_kW': '7.50', 'granulator.torque_Nm': '120.0', 'granulator.product_temp_C': '28.0', 'granulator.binder_kg': '0.000' },
  noise: { 'granulator.impeller_rpm': 1, 'granulator.chopper_rpm': 5, 'granulator.power_kW': 20, 'granulator.torque_Nm': 15, 'granulator.product_temp_C': 3 },
  alarms: [{ code: 'IMPELLER_POWER_HIGH', tag: 'granulator.power_kW', high: '30.00' }],
  excursion: { tag: 'granulator.power_kW', value: '34.20' },
};

const DRYER: Profile = {
  equipment: 'DRYER',
  initial: { 'dryer.inlet_temp_C': '60.0', 'dryer.airflow_m3_h': '1500' },
  limits: { 'dryer.inlet_temp_C': { min: '20.0', max: '90.0' }, 'dryer.airflow_m3_h': { min: '0', max: '4000' } },
  follows: { 'dryer.bed_temp_C': { from: 'dryer.inlet_temp_C', running: 220n, idle: 50n }, 'dryer.exhaust_temp_C': { from: 'dryer.inlet_temp_C', running: 260n, idle: 60n } },
  mechanical: ['dryer.inlet_temp_C'],
  noiseWhenIdle: true,
  noise: { 'dryer.inlet_temp_C': 3, 'dryer.bed_temp_C': 2, 'dryer.exhaust_temp_C': 3, 'dryer.airflow_m3_h': 10 },
  alarms: [{ code: 'INLET_TEMP_HIGH', tag: 'dryer.inlet_temp_C', high: '95.0' }],
  excursion: { tag: 'dryer.inlet_temp_C', value: '98.0' },
};

const BLENDER: Profile = {
  equipment: 'BLENDER',
  initial: { 'blender.speed_rpm': '12.0' },
  limits: { 'blender.speed_rpm': { min: '0.0', max: '30.0' } },
  counters: [{ counter: 'blender.revolutions', rate: 'blender.speed_rpm', per: 1n }],
  noise: { 'blender.speed_rpm': 1 },
  alarms: [{ code: 'SPEED_HIGH', tag: 'blender.speed_rpm', high: '30.0' }],
  excursion: { tag: 'blender.speed_rpm', value: '33.5' },
};

const ROLLER_COMPACTOR: Profile = {
  equipment: 'ROLLER_COMPACTOR',
  initial: { 'roller.force_kN': '40.00', 'roller.gap_mm': '2.50', 'roller.speed_rpm': '6.0', 'roller.feed_screw_rpm': '30.0', 'roller.vacuum_mbar': '200', 'roller.mill_rpm': '400' },
  limits: {
    'roller.force_kN': { min: '0.00', max: '120.00' },
    'roller.gap_mm': { min: '0.50', max: '6.00' },
    'roller.speed_rpm': { min: '0.0', max: '20.0' },
    'roller.feed_screw_rpm': { min: '0.0', max: '100.0' },
    'roller.vacuum_mbar': { min: '0', max: '900' },
    'roller.mill_rpm': { min: '0', max: '1500' },
  },
  mechanical: ['roller.gap_mm'],
  noise: { 'roller.force_kN': 20, 'roller.gap_mm': 2, 'roller.speed_rpm': 1, 'roller.feed_screw_rpm': 2, 'roller.vacuum_mbar': 5, 'roller.mill_rpm': 3 },
  alarms: [{ code: 'ROLL_FORCE_OVERLOAD', tag: 'roller.force_kN', high: '120.00' }],
  excursion: { tag: 'roller.force_kN', value: '126.40' },
};

const BLISTER_MACHINE: Profile = {
  equipment: 'BLISTER_MACHINE',
  initial: { 'blister.form_temp_C': '130.0', 'blister.seal_temp_C': '190.0', 'blister.seal_pressure_bar': '4.50', 'blister.seal_dwell_s': '0.80', 'blister.speed_cpm': '40' },
  limits: {
    'blister.form_temp_C': { min: '20.0', max: '160.0' },
    'blister.seal_temp_C': { min: '20.0', max: '240.0' },
    'blister.seal_pressure_bar': { min: '0.00', max: '8.00' },
    'blister.seal_dwell_s': { min: '0.10', max: '3.00' },
    'blister.speed_cpm': { min: '0', max: '80' },
  },
  mechanical: ['blister.form_temp_C', 'blister.seal_temp_C'],
  noiseWhenIdle: true,
  counters: [{ counter: 'blister.cycles', rate: 'blister.speed_cpm', per: 1n }],
  noise: { 'blister.form_temp_C': 3, 'blister.seal_temp_C': 3, 'blister.seal_pressure_bar': 2, 'blister.seal_dwell_s': 0, 'blister.speed_cpm': 0 },
  alarms: [{ code: 'SEAL_TEMP_HIGH', tag: 'blister.seal_temp_C', high: '230.0' }],
  excursion: { tag: 'blister.seal_temp_C', value: '236.0' },
};

const BOTTLE_LINE: Profile = {
  equipment: 'BOTTLE_LINE',
  initial: { 'bottle.speed_bpm': '60', 'bottle.induction_power_pct': '70.0' },
  limits: { 'bottle.speed_bpm': { min: '0', max: '200' }, 'bottle.induction_power_pct': { min: '0.0', max: '100.0' } },
  counters: [{ counter: 'bottle.count', rate: 'bottle.speed_bpm', per: 1n, reject: { counter: 'bottle.reject_count', every: 500n } }],
  noise: { 'bottle.speed_bpm': 0, 'bottle.induction_power_pct': 2 },
  alarms: [{ code: 'INDUCTION_POWER_HIGH', tag: 'bottle.induction_power_pct', high: '95.0' }],
  excursion: { tag: 'bottle.induction_power_pct', value: '99.0' },
};

const CARTONER: Profile = {
  equipment: 'CARTONER',
  initial: { 'cartoner.speed_cpm': '80' },
  limits: { 'cartoner.speed_cpm': { min: '0', max: '300' } },
  counters: [{ counter: 'cartoner.count', rate: 'cartoner.speed_cpm', per: 1n, reject: { counter: 'cartoner.reject_count', every: 400n } }],
  noise: { 'cartoner.speed_cpm': 0 },
  alarms: [{ code: 'SPEED_HIGH', tag: 'cartoner.speed_cpm', high: '300' }],
  excursion: { tag: 'cartoner.speed_cpm', value: '320' },
};

export const PROFILES: Record<EquipmentKind, Profile> = { PRESS, COATER, GRANULATOR, DRYER, BLENDER, ROLLER_COMPACTOR, BLISTER_MACHINE, BOTTLE_LINE, CARTONER };

/** Press: punch stations on the turret (strokes per revolution), and one tablet in this many is rejected. */
export const PRESS_STATIONS = 36n;
export const REJECT_EVERY = 400n;
/** Coater: exhaust and bed temperatures below the inlet temperature (running, idle), in tenths of a degree. */
const EXHAUST_DROP = { running: 180n, idle: 40n };
const BED_DROP = { running: 240n, idle: 60n };

export interface ProcessModelOptions {
  equipment: EquipmentKind;
  serial: string;
  seed: number;
  clock?: SimClock;
  /** Running at power-on (default false). */
  running?: boolean;
}

export interface ProcessSample {
  scan: string;
  running: boolean;
  values: SimValue[];
  setpoints: SimSetpoint[];
  alarms: SimAlarm[];
}

export interface ProcessModelState extends ProcessSample {
  serial: string;
  equipment: EquipmentKind;
  faults: Fault[];
}

export type WriteResult = { ok: true } | { ok: false; error: 'UNKNOWN_TAG' | 'NOT_A_SETPOINT' | 'TOO_MANY_DECIMALS' | 'OUT_OF_RANGE'; message: string };

export class ProcessModel {
  readonly profile: Profile;
  readonly tags: readonly TagSpec[];
  readonly faults = new Set<Fault>();
  private readonly clock: SimClock;
  private readonly seed: number;
  private random: () => number;
  private readonly startedAt: number;
  /** Setpoints the controller holds (counts at the tag's scale). */
  private setpoints = new Map<string, bigint>();
  private running: boolean;
  /** Time integrated into the counters up to here (ms) and the strokes integrated, x 60000 x 10 (rpm has one decimal). */
  private integratedTo: number;
  private strokeAcc = 0n;
  /** Slice 6c counters: per counter tag, milliseconds x rate counts integrated. */
  private counterAcc = new Map<string, bigint>();
  private driftSince: number | null = null;
  private frozen: ProcessSample | null = null;

  constructor(readonly options: ProcessModelOptions) {
    this.profile = PROFILES[options.equipment];
    this.tags = tagsOf(options.equipment);
    this.clock = options.clock ?? realClock;
    this.seed = options.seed;
    this.random = seededRandom(options.seed);
    this.startedAt = this.clock.nowMs();
    this.integratedTo = this.startedAt;
    this.running = options.running ?? false;
    this.loadInitialSetpoints();
  }

  get serial(): string {
    return this.options.serial;
  }

  get equipment(): EquipmentKind {
    return this.options.equipment;
  }

  private spec(tag: string): TagSpec | undefined {
    return this.tags.find((t) => t.tag === tag);
  }

  private loadInitialSetpoints(): void {
    this.setpoints = new Map(Object.entries(this.profile.initial).map(([tag, v]) => [tag, toCounts(v, this.spec(tag)?.scale ?? 0)]));
  }

  /** Power-on state: initial setpoints, counters zero, no faults, the generator re-seeded. */
  reset(): void {
    this.integrate();
    this.loadInitialSetpoints();
    this.strokeAcc = 0n;
    this.counterAcc.clear();
    this.faults.clear();
    this.driftSince = null;
    this.frozen = null;
    this.random = seededRandom(this.seed);
    this.running = this.options.running ?? false;
  }

  start(): void {
    this.integrate();
    this.running = true;
  }

  stop(): void {
    this.integrate();
    this.running = false;
  }

  setFault(fault: Fault, on: boolean): void {
    if (on === this.faults.has(fault)) return;
    // Integrate up to now first, so a fault never changes what was produced before it.
    this.integrate();
    if (fault === 'STALE') this.frozen = on ? this.live() : null;
    if (fault === 'DRIFT') this.driftSince = on ? this.clock.nowMs() : null;
    if (on) this.faults.add(fault);
    else this.faults.delete(fault);
  }

  /** A setpoint download: refused unless it is a setpoint of this equipment, within the tag's decimals and range. */
  write(tag: string, value: string): WriteResult {
    const spec = this.spec(tag);
    if (!spec) return { ok: false, error: 'UNKNOWN_TAG', message: `${tag} is not a tag of this ${this.equipment.toLowerCase()}` };
    const limits = this.profile.limits[tag];
    if (!spec.setpoint || !limits) return { ok: false, error: 'NOT_A_SETPOINT', message: `${tag} takes no setpoint` };
    let counts: bigint;
    try {
      counts = toCounts(value, spec.scale);
    } catch {
      return { ok: false, error: 'TOO_MANY_DECIMALS', message: `${tag} takes at most ${spec.scale} decimals` };
    }
    if (counts < toCounts(limits.min, spec.scale) || counts > toCounts(limits.max, spec.scale)) {
      return { ok: false, error: 'OUT_OF_RANGE', message: `${tag} takes ${limits.min} to ${limits.max} ${spec.unit}` };
    }
    this.integrate();
    this.setpoints.set(tag, this.faults.has('SETPOINT_MISMATCH') ? counts + MISMATCH_STEPS : counts);
    return { ok: true };
  }

  /** Integrates the press counters from the last integration to now at the turret speed of that interval. */
  private integrate(): void {
    const now = this.clock.nowMs();
    const elapsed = BigInt(Math.max(0, Math.round(now - this.integratedTo)));
    this.integratedTo = now;
    if (!this.running) return;
    for (const c of this.profile.counters ?? []) this.counterAcc.set(c.counter, (this.counterAcc.get(c.counter) ?? 0n) + elapsed * (this.setpoints.get(c.rate) ?? 0n));
    if (this.equipment !== 'PRESS') return;
    const rpm = this.setpoints.get('turret.speed_rpm') ?? 0n;
    this.strokeAcc += elapsed * rpm * PRESS_STATIONS;
  }

  /** A slice 6c counter (or its reject counter) now, or null when `tag` is none. */
  private counterCounts(tag: string): bigint | null {
    for (const c of this.profile.counters ?? []) {
      const rateScale = BigInt(this.spec(c.rate)?.scale ?? 0);
      const units = ((this.counterAcc.get(c.counter) ?? 0n) * c.per) / (60_000n * 10n ** rateScale);
      if (tag === c.counter) return units;
      if (c.reject && tag === c.reject.counter) return units / c.reject.every;
    }
    return null;
  }

  private noise(tag: string): bigint {
    const n = this.profile.noise[tag] ?? 0;
    if (n === 0) return 0n;
    return BigInt(Math.floor(this.random() * (2 * n + 1)) - n);
  }

  /** The actual value of a tag that follows its setpoint (or another tag), before noise, in counts. */
  private actualCounts(spec: TagSpec): bigint {
    if (this.equipment === 'PRESS') {
      const strokes = this.strokeAcc / 600_000n;
      const rejects = strokes / REJECT_EVERY;
      if (spec.tag === 'stroke.count') return strokes;
      if (spec.tag === 'reject.count') return rejects;
      if (spec.tag === 'tablet.count') return strokes - rejects;
      // Fill depth is mechanical: it holds whether the turret turns or not; speed and forces are zero when stopped.
      if (!this.running && spec.tag !== 'fill.depth_mm') return 0n;
      return this.setpoints.get(spec.tag) ?? 0n;
    }
    if (this.equipment !== 'COATER') {
      const counted = this.counterCounts(spec.tag);
      if (counted !== null) return counted;
      const follow = this.profile.follows?.[spec.tag];
      if (follow) return (this.setpoints.get(follow.from) ?? 0n) - (this.running ? follow.running : follow.idle);
      if (this.profile.mechanical?.includes(spec.tag)) return this.setpoints.get(spec.tag) ?? 0n;
      if (!this.running) return 0n;
      const nominal = this.profile.nominal?.[spec.tag];
      if (nominal !== undefined) return toCounts(nominal, spec.scale);
      return this.setpoints.get(spec.tag) ?? 0n;
    }
    const inlet = this.setpoints.get('inlet.temp_C') ?? 0n;
    if (spec.tag === 'inlet.temp_C') return inlet;
    if (spec.tag === 'exhaust.temp_C') return inlet - (this.running ? EXHAUST_DROP.running : EXHAUST_DROP.idle);
    if (spec.tag === 'bed.temp_C') return inlet - (this.running ? BED_DROP.running : BED_DROP.idle);
    if (!this.running) return 0n;
    return this.setpoints.get(spec.tag) ?? 0n;
  }

  /** The controller output now, ignoring STALE. */
  private live(): ProcessSample {
    this.integrate();
    const now = this.clock.nowMs();
    const driftSteps = this.driftSince === null ? 0n : (BigInt(Math.floor((now - this.driftSince) / 1000)) * DRIFT_STEPS_PER_S);
    const values: SimValue[] = this.tags.map((spec) => {
      let c: bigint;
      if (this.faults.has('ALARM') && spec.tag === this.profile.excursion.tag) {
        c = toCounts(this.profile.excursion.value, spec.scale);
      } else {
        c = this.actualCounts(spec);
        if (!spec.counter && (this.running || this.equipment === 'COATER' || this.profile.noiseWhenIdle === true) && c !== 0n) c += this.noise(spec.tag) + driftSteps;
        if (c < 0n) c = 0n;
      }
      return { tag: spec.tag, value: fromCounts(c, spec.scale), unit: spec.unit, quality: 'GOOD' };
    });
    const setpoints: SimSetpoint[] = this.tags
      .filter((t) => t.setpoint)
      .map((spec) => ({ tag: spec.tag, value: fromCounts(this.setpoints.get(spec.tag) ?? 0n, spec.scale), unit: spec.unit }));
    const alarms: SimAlarm[] = this.profile.alarms
      .filter((a) => {
        const spec = this.spec(a.tag);
        const v = values.find((x) => x.tag === a.tag);
        return spec !== undefined && v !== undefined && toCounts(v.value, spec.scale) > toCounts(a.high, spec.scale);
      })
      .map((a) => ({ code: a.code, tag: a.tag }));
    const scan = BigInt(Math.max(0, Math.floor((now - this.startedAt) / SCAN_MS)));
    return { scan: scan.toString(), running: this.running, values, setpoints, alarms };
  }

  /** What a read of the controller returns now (frozen while STALE). */
  sample(): ProcessSample {
    if (this.frozen) {
      this.integrate();
      return this.frozen;
    }
    return this.live();
  }

  /**
   * A deterministic garbled line (GARBLED fault): the right length, one character replaced by a byte outside printable
   * ASCII, as a transmission error gives (the protocol refuses such a line whole, never reading a value from it).
   */
  garble(line: string): string {
    const chars = [...line];
    const i = Math.floor(this.random() * Math.max(1, chars.length));
    const junk = ['\u0007', 'ÿ', '\u0000', '\u0015', '\u0080'];
    chars[i] = junk[Math.floor(this.random() * junk.length)] ?? '\u0007';
    const out = chars.join('');
    return out === line ? `${line}\u0007` : out;
  }

  state(): ProcessModelState {
    return { serial: this.serial, equipment: this.equipment, faults: [...this.faults].sort(), ...this.sample() };
  }
}
