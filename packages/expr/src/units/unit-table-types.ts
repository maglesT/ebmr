/**
 * Shape of the generated unit table (unit-table.generated.ts). Factors are exact rationals written
 * as text ("num/den" or an integer), never JavaScript numbers.
 */

/** Base axes: UCUM's base units, plus the mole and the arbitrary units kept as their own axes. */
export type BaseAxis = 'm' | 's' | 'g' | 'rad' | 'K' | 'C' | 'cd' | 'mol' | '[iU]' | '[CFU]';

export type AtomKind =
  /** An ordinary unit: value_in_base = value x factor. */
  | 'LINEAR'
  /** An absolute temperature scale: kelvin = (value + offset) x factor. Never multiplied or added. */
  | 'ABSOLUTE_TEMPERATURE'
  /** A UCUM arbitrary unit ([iU], [CFU]): its own axis, convertible only to itself. */
  | 'ARBITRARY';

export interface UnitAtomRecord {
  readonly name: string;
  readonly printSymbol: string;
  /** UCUM property, e.g. "mass", "pressure". */
  readonly property: string;
  /** May take a prefix (UCUM metric flag; temperature units are closed to prefixes by our rule). */
  readonly metric: boolean;
  readonly kind: AtomKind;
  readonly dimension: Readonly<Partial<Record<BaseAxis, number>>>;
  /** Exact factor to the base axes, as rational text. */
  readonly factor: string;
  /** The same factor as a terminating decimal, or null when it does not terminate (e.g. psi). */
  readonly factorDecimal: string | null;
  /** ABSOLUTE_TEMPERATURE only: offset added before multiplying by the factor, as rational text. */
  readonly offset?: string;
  /** The UCUM definition the factor was derived from (traceability). */
  readonly definition: string;
}

export interface NamedUnitRecord {
  readonly code: string;
  readonly factor: string;
  readonly factorDecimal: string | null;
}

export interface QuantityKindRecord {
  readonly dimension: Readonly<Partial<Record<BaseAxis, number>>>;
  /** ABSOLUTE for absolute temperatures; LINEAR otherwise. */
  readonly scale: 'LINEAR' | 'ABSOLUTE';
  readonly units: readonly NamedUnitRecord[];
}

export interface UnitTable {
  readonly tableVersion: string;
  readonly ucumLhcVersion: string;
  readonly baseAxes: readonly BaseAxis[];
  readonly prefixes: Readonly<Record<string, number>>;
  readonly atoms: Readonly<Record<string, UnitAtomRecord>>;
  /** Every UCUM atom code (atom-first rule), and which of them are metric. */
  readonly ucumAtoms: readonly string[];
  readonly ucumMetricAtoms: readonly string[];
  readonly quantityKinds: Readonly<Record<string, QuantityKindRecord>>;
}
