/**
 * The controlled unit catalogue: which UCUM atoms the product accepts and the named units per
 * quantity kind (tablets spec C.0, outline 6.3/6.4). Edit this list, then regenerate the table:
 *   npx tsx packages/expr/src/units/generator/cli.ts
 * The unit-table test fails until the committed table matches a fresh generation.
 *
 * Deliberate rules (documented in the README):
 * - Absolute temperatures are written in Cel or [degF]. "K" denotes a temperature DIFFERENCE
 *   (1 K = a 1 degree Celsius difference); there is no absolute-kelvin quantity. Temperature units
 *   take no prefix.
 * - The mole is its own axis (UCUM treats it as the number 6.0221367e23); counts never mix with moles.
 * - [iU] and [CFU] are UCUM arbitrary units: each is its own axis and converts only to itself.
 * - Calendar-variable units (mo, a, wk) are not accepted: months and years differ in length.
 * - Endotoxin units have no UCUM code ([EU] is the Ehrlich unit) and are not in the catalogue.
 */

/** UCUM atoms accepted in unit codes (prefixes allowed only where UCUM marks the atom metric). */
export const CATALOGUE_ATOMS: readonly string[] = [
  // base units
  'm',
  's',
  'g',
  'K',
  'mol',
  // volume, time
  'L',
  'min',
  'h',
  'd',
  // absolute temperature scales
  'Cel',
  '[degF]',
  // dimensionless fractions
  '%',
  '[ppm]',
  '[ppb]',
  // force and pressure
  'N',
  'gf',
  'Pa',
  'bar',
  'm[Hg]',
  'm[H2O]',
  "[in_i'H2O]",
  '[psi]',
  // viscosity, conductivity
  'P',
  'S',
  'Ohm',
  // absorbed dose of ionising radiation (radiation sterilisation; Revised Schedule M Part II 6.11.1.10)
  'Gy',
  // arbitrary units
  '[CFU]',
  '[iU]',
];

/** Atoms whose prefixes we close although UCUM allows them (temperature scales). */
export const NO_PREFIX_ATOMS: readonly string[] = ['K', 'Cel', '[degF]'];

/** UCUM prefixes (exact powers of ten; the binary prefixes Ki, Mi, Gi, Ti are not accepted). */
export const PREFIXES: Readonly<Record<string, number>> = {
  Y: 24,
  Z: 21,
  E: 18,
  P: 15,
  T: 12,
  G: 9,
  M: 6,
  k: 3,
  h: 2,
  da: 1,
  d: -1,
  c: -2,
  m: -3,
  u: -6,
  n: -9,
  p: -12,
  f: -15,
  a: -18,
  z: -21,
  y: -24,
};

/**
 * Exact definitions of the special (non-ratio) temperature scales: kelvin = (value + offset) x factor.
 * UCUM defines them by functions; ucum-lhc's float conversions are cross-checked in the tests.
 */
export const TEMPERATURE_SCALES: Readonly<Record<string, { factor: string; offset: string; definition: string }>> = {
  Cel: { factor: '1', offset: '273.15', definition: 'K = Cel + 273.15' },
  '[degF]': { factor: '5/9', offset: '459.67', definition: 'K = ([degF] + 459.67) x 5/9' },
};

/** Named units per quantity kind: what the designer offers and parameter units are checked against. */
export const QUANTITY_KINDS: Readonly<Record<string, { scale: 'LINEAR' | 'ABSOLUTE'; units: readonly string[] }>> = {
  mass: { scale: 'LINEAR', units: ['kg', 'g', 'mg', 'ug', 'ng'] },
  volume: { scale: 'LINEAR', units: ['L', 'mL', 'uL', 'm3', 'cm3'] },
  length: { scale: 'LINEAR', units: ['m', 'cm', 'mm', 'um', 'nm'] },
  area: { scale: 'LINEAR', units: ['m2', 'cm2', 'mm2'] },
  time: { scale: 'LINEAR', units: ['s', 'min', 'h', 'd', 'ms'] },
  temperature: { scale: 'ABSOLUTE', units: ['Cel', '[degF]'] },
  temperature_difference: { scale: 'LINEAR', units: ['K'] },
  pressure: { scale: 'LINEAR', units: ['Pa', 'kPa', 'MPa', 'hPa', 'bar', 'mbar', 'mm[Hg]', 'mm[H2O]', "[in_i'H2O]", '[psi]', 'kgf/cm2'] },
  force: { scale: 'LINEAR', units: ['N', 'kN', 'kgf'] },
  absorbed_dose: { scale: 'LINEAR', units: ['Gy', 'kGy'] },
  volumetric_flow: { scale: 'LINEAR', units: ['L/min', 'mL/min', 'L/h', 'mL/h', 'm3/h'] },
  mass_flow: { scale: 'LINEAR', units: ['kg/h', 'kg/min', 'g/min', 'g/h'] },
  mass_concentration: { scale: 'LINEAR', units: ['mg/mL', 'g/L', 'ug/mL', 'mg/L', 'g/mL', 'kg/L', 'g/cm3', 'g/dL'] },
  density: { scale: 'LINEAR', units: ['g/mL', 'kg/L', 'g/cm3', 'kg/m3'] },
  molar_mass: { scale: 'LINEAR', units: ['g/mol', 'kg/mol'] },
  amount: { scale: 'LINEAR', units: ['mol', 'mmol'] },
  fraction: { scale: 'LINEAR', units: ['%', '[ppm]', '[ppb]', '1'] },
  velocity: { scale: 'LINEAR', units: ['m/s', 'cm/s', 'mm/s'] },
  rotational_frequency: { scale: 'LINEAR', units: ['/min', '/s'] },
  dynamic_viscosity: { scale: 'LINEAR', units: ['mPa.s', 'Pa.s', 'cP', 'P'] },
  conductivity: { scale: 'LINEAR', units: ['uS/cm', 'mS/cm', 'S/m'] },
  particle_concentration: { scale: 'LINEAR', units: ['/m3', '/L'] },
  microbial_count: { scale: 'LINEAR', units: ['[CFU]'] },
  microbial_concentration: { scale: 'LINEAR', units: ['[CFU]/m3', '[CFU]/L', '[CFU]/mL'] },
  microbial_content: { scale: 'LINEAR', units: ['[CFU]/g'] },
  potency_amount: { scale: 'LINEAR', units: ['[iU]'] },
  potency_content: { scale: 'LINEAR', units: ['[iU]/mg', '[iU]/g'] },
  potency_concentration: { scale: 'LINEAR', units: ['[iU]/mL'] },
};
