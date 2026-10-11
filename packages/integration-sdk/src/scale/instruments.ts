/**
 * Instruments on the scale protocol (Phase 3 slice 6c, D-S6-8): besides the balance, the IPC and packaging instruments
 * of the Tablets edition report one value each the way a balance reports a weight (MT-SICS behind the gateway, a
 * stable reading taken on request). Each kind has the engineering unit it reports in, its readability and its range,
 * the defaults a simulator starts with and the unit the gateway's configuration must name for it.
 *
 * Units are spelt as the MT-SICS line carries them (letters only: the moisture analyser's per cent is pct).
 * Values are decimal text, never JavaScript numbers.
 */
export const INSTRUMENT_KINDS = [
  'BALANCE',
  'MOISTURE_ANALYSER',
  'HARDNESS_TESTER',
  'FRIABILATOR',
  'DISINTEGRATION_TESTER',
  'LEAK_TESTER',
  'CHECKWEIGHER',
] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

export interface InstrumentProfile {
  readonly kind: InstrumentKind;
  /** What the instrument reports, in plain words. */
  readonly reports: string;
  /** The units it may report in (the first is the simulator's default). */
  readonly units: readonly [string, ...string[]];
  /** Default readability and range of the simulator (decimal text in the default unit). */
  readonly resolution: string;
  readonly capacity: string;
}

export const INSTRUMENT_PROFILES: Readonly<Record<InstrumentKind, InstrumentProfile>> = {
  BALANCE: { kind: 'BALANCE', reports: 'mass on the pan', units: ['kg', 'g', 'mg'], resolution: '0.001', capacity: '60.000' },
  MOISTURE_ANALYSER: { kind: 'MOISTURE_ANALYSER', reports: 'loss on drying of the sample', units: ['pct'], resolution: '0.01', capacity: '100.00' },
  HARDNESS_TESTER: { kind: 'HARDNESS_TESTER', reports: 'breaking force of one tablet', units: ['N', 'kp'], resolution: '0.1', capacity: '500.0' },
  FRIABILATOR: { kind: 'FRIABILATOR', reports: 'mass of the tablet sample before or after the drum', units: ['g'], resolution: '0.001', capacity: '100.000' },
  DISINTEGRATION_TESTER: { kind: 'DISINTEGRATION_TESTER', reports: 'time a unit took to disintegrate', units: ['min'], resolution: '0.1', capacity: '120.0' },
  LEAK_TESTER: { kind: 'LEAK_TESTER', reports: 'vacuum held on the sample', units: ['kPa'], resolution: '0.1', capacity: '100.0' },
  CHECKWEIGHER: { kind: 'CHECKWEIGHER', reports: 'gross mass of one pack', units: ['g'], resolution: '0.01', capacity: '2000.00' },
};

/** Why `unit` is not a unit instrument kind `kind` reports in, or null. */
export function instrumentUnitProblem(kind: InstrumentKind, unit: string): string | null {
  const p = INSTRUMENT_PROFILES[kind];
  return p.units.includes(unit) ? null : `a ${kind.toLowerCase().replace(/_/g, ' ')} reports ${p.reports} in ${p.units.join(' or ')}, not in ${unit}`;
}
