/**
 * Types for the parts of @lhncbc/ucum-lhc 7.1.9 the generator and the tests use (the package ships
 * no type declarations). Only build-time code and tests import ucum-lhc; the runtime reads the
 * generated table.
 */
declare module '@lhncbc/ucum-lhc' {
  export interface UcumUnit {
    csCode_: string;
    name_: string;
    printSymbol_: string | null;
    property_: string;
    magnitude_: number;
    dim_: { dimVec_: number[] } | null;
    isBase_: boolean;
    isMetric_: boolean;
    isSpecial_: boolean;
    isArbitrary_: boolean;
    source_: string | null;
    csUnitString_: string | null;
    baseFactorStr_: string | null;
    moleExp_: number;
    cnv_: string | null;
  }
  export interface UcumValidation {
    status: 'valid' | 'invalid' | 'error';
    ucumCode: string | null;
    msg: string[];
  }
  export interface UcumConversion {
    status: 'succeeded' | 'failed' | 'error';
    toVal: number | null;
    msg: string[];
  }
  export interface UcumLhcUtilsInstance {
    validateUnitString(code: string, suggest?: boolean): UcumValidation;
    convertUnitTo(fromCode: string, value: number, toCode: string): UcumConversion;
  }
  export interface UnitTablesInstance {
    unitCodes_: Record<string, UcumUnit>;
    getUnitByCode(code: string): UcumUnit | undefined;
  }
  const ucum: {
    UcumLhcUtils: { getInstance(): UcumLhcUtilsInstance };
    UnitTables: { getInstance(): UnitTablesInstance };
  };
  export default ucum;
}

declare module '@lhncbc/ucum-lhc/source-cjs/prefixTables.js' {
  export interface UcumPrefix {
    code_: string;
    exp_: number | null;
    value_: number;
  }
  const prefixTables: {
    PrefixTables: { getInstance(): { allPrefixesByCode(): UcumPrefix[] } };
  };
  export default prefixTables;
}
