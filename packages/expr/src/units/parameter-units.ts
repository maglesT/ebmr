/**
 * Units of MBR parameters, checked against a quantity kind (outline 6.3 "Units", L-39).
 *
 * Tablet hardness (breaking force) is a FORCE. Indian dossiers often register it in "kg/cm²",
 * which is a pressure (or, read literally in UCUM, a mass per area). It is accepted only through the
 * controlled legacy alias "kg/cm² (as kgf/kp)": the value is recorded in kgf with the exact
 * conversion 1 kgf = 9.80665 N, and a WARNING that needs a recorded justification is raised (the
 * tester must be confirmed to read kgf). A genuine pressure unit on a force parameter without the
 * alias is refused. "kp" (kilopond) is accepted as a plain synonym of kgf with an INFO note.
 */
import { diagnostic, type Diagnostic } from '../diagnostics.ts';
import { UNIT_TABLE } from './unit-table.generated.ts';
import { describeDimension, factorText, linearFactor, parseUnit, UnitError, type Unit } from './unit.ts';

export const LEGACY_HARDNESS_ALIAS = 'kg/cm² (as kgf/kp)';
const LEGACY_HARDNESS_ALIAS_ASCII = 'kg/cm2 (as kgf/kp)';

export interface UnitAlias {
  /** The alias exactly as written in the MBR. */
  readonly text: string;
  /** The UCUM unit values are recorded in. */
  readonly mapsTo: string;
  /** The recorded, exact conversion of the mapped unit to newton. */
  readonly factorToNewton: string;
  readonly note: string;
}

export interface ParameterUnit {
  /** Unit text as written in the MBR. */
  readonly text: string;
  readonly kind: string;
  /** The UCUM unit values are held in. */
  readonly unit: Unit;
  readonly alias?: UnitAlias;
}

export type ParameterUnitResult = { ok: true; unit: ParameterUnit; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] };

/** Names of the quantity kinds of the catalogue (mass, volume, force, pressure, ...). */
export function quantityKindNames(): string[] {
  return Object.keys(UNIT_TABLE.quantityKinds);
}

/** The named units offered for a quantity kind, in catalogue order. */
export function unitsOfKind(kind: string): string[] {
  return UNIT_TABLE.quantityKinds[kind]?.units.map((u) => u.code) ?? [];
}

function kindMatches(unit: Unit, kind: string): boolean {
  const k = UNIT_TABLE.quantityKinds[kind];
  if (k === undefined) return false;
  const first = k.units[0];
  if (first === undefined) return false;
  const ref = parseUnit(first.code);
  return ref.dimensionKey === unit.dimensionKey && ref.scale === unit.scale;
}

function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Resolves the unit of a parameter of the given quantity kind. Returns the UCUM unit to hold values
 * in, plus diagnostics (errors block; the legacy alias raises a WARNING needing justification).
 */
export function resolveParameterUnit(text: string, kind: string): ParameterUnitResult {
  const k = UNIT_TABLE.quantityKinds[kind];
  if (k === undefined) {
    return { ok: false, diagnostics: [diagnostic('EXPR-UNIT-020', 'ERROR', `"${kind}" is not a quantity kind of the unit catalogue`)] };
  }
  const written = normalise(text);
  const kgf = parseUnit('kgf');
  const newtonFactor = factorText(linearFactor(kgf, parseUnit('N')));
  if (written === LEGACY_HARDNESS_ALIAS || written === LEGACY_HARDNESS_ALIAS_ASCII) {
    if (kind !== 'force') {
      return {
        ok: false,
        diagnostics: [diagnostic('EXPR-UNIT-022', 'ERROR', `The legacy alias "${LEGACY_HARDNESS_ALIAS}" is only for force parameters such as tablet hardness, not for ${kind.replace(/_/g, ' ')}`)],
      };
    }
    return {
      ok: true,
      unit: {
        text: written,
        kind,
        unit: kgf,
        alias: {
          text: written,
          mapsTo: 'kgf',
          factorToNewton: newtonFactor,
          note: `recorded in kgf (kilogram-force); 1 kgf = ${newtonFactor} N exactly`,
        },
      },
      diagnostics: [
        diagnostic(
          'EXPR-UNIT-030',
          'WARNING',
          `The registered unit "kg/cm²" is a pressure, but hardness is a force: values are recorded in kgf (1 kgf = ${newtonFactor} N). Record why the dossier unit is kept and that the tester reads kgf, as outline 6.3 (L-39) requires`,
        ),
      ],
    };
  }
  if (written === 'kp') {
    if (kind !== 'force') {
      return { ok: false, diagnostics: [diagnostic('EXPR-UNIT-022', 'ERROR', `"kp" (kilopond) is a force unit and cannot be used for ${kind.replace(/_/g, ' ')}`)] };
    }
    return {
      ok: true,
      unit: { text: written, kind, unit: kgf, alias: { text: written, mapsTo: 'kgf', factorToNewton: newtonFactor, note: `kilopond, the same as kgf; 1 kp = ${newtonFactor} N exactly` } },
      diagnostics: [diagnostic('EXPR-UNIT-031', 'INFO', `"kp" is not a UCUM code; values are recorded in kgf, the same unit (1 kp = ${newtonFactor} N)`)],
    };
  }
  let unit: Unit;
  try {
    unit = parseUnit(written);
  } catch (e) {
    if (e instanceof UnitError) {
      const hint = written.includes('²') ? ` If the dossier registers hardness as "kg/cm²", use the controlled alias "${LEGACY_HARDNESS_ALIAS}".` : '';
      return { ok: false, diagnostics: [diagnostic('EXPR-UNIT-001', 'ERROR', `${e.message}.${hint}`)] };
    }
    throw e;
  }
  if (!kindMatches(unit, kind)) {
    if (kind === 'force' && (kindMatches(unit, 'pressure') || unit.dimensionKey === 'm-2.g1')) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'EXPR-UNIT-021',
            'ERROR',
            `"${written}" is a pressure (or a mass per area), not a force: breaking force is recorded in N or kgf. If the dossier registers "kg/cm²" for a tester that reads kgf, use the controlled alias "${LEGACY_HARDNESS_ALIAS}" with a justification, as outline 6.3 (L-39) allows`,
          ),
        ],
      };
    }
    return {
      ok: false,
      diagnostics: [diagnostic('EXPR-UNIT-002', 'ERROR', `"${written}" measures ${describeDimension(unit)}, but this parameter is a ${kind.replace(/_/g, ' ')}; use one of: ${unitsOfKind(kind).join(', ')}`)],
    };
  }
  return { ok: true, unit: { text: written, kind, unit }, diagnostics: [] };
}
