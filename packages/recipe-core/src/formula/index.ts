/**
 * The company formulation library (Phase 3 slice 6a; decision 0006 part 1; D-S6-3, D-S6-4): thin, typed callers of the
 * database functions of sql/0640. Every writer runs inside a command the caller started (kernel withCommand); the
 * database decides and refuses with a code (EBMR-FRM-0NN, or the kernel's), raised here as KernelError. Quantities travel
 * as decimal text and are computed by the database (INV-25); the composition is served only to an actor holding
 * FORMULA.READ (DI-13).
 */
import type pg from 'pg';
import { commands } from '@ebmr/kernel';

type Db = pg.Pool | pg.PoolClient;

export type FormulaLineRole = 'ACTIVE' | 'EXCIPIENT' | 'COATING' | 'PROCESSING_AID';

export interface FormulaLineInput {
  lineId: string;
  materialCode: string;
  role: FormulaLineRole;
  basis: 'PER_UNIT' | 'PER_BATCH';
  /** mg per unit (PER_UNIT) or kg per batch (PER_BATCH), decimal text. */
  quantity: string;
  /** Overage over the label claim in percent, or as a quantity in the line's unit; never both; with its reason (recipe-core 1660). */
  overagePercent?: string;
  overageQuantity?: string;
  overageReason?: string;
  saltFactor?: string;
  potencyAdjusted: boolean;
  compensating: boolean;
}

export interface FormulaLine extends Omit<FormulaLineInput, 'overagePercent' | 'overageQuantity' | 'overageReason' | 'saltFactor'> {
  materialName: string;
  quantityUnit: 'mg' | 'kg';
  overagePercent: string | null;
  /** Present only on a line written with an overage quantity or reason (recipe-core 1660). */
  overageQuantity?: string | null;
  overageReason?: string | null;
  saltFactor: string | null;
  /** Computed by the database (INV-25), in kg. */
  batchQuantity: string;
  batchUnit: 'kg';
}

export interface FormulaVersionRead {
  versionId: string;
  versionNumber: number;
  state: 'DRAFT' | 'APPROVED' | 'SUPERSEDED';
  changeReason: string;
  authoredBy: string;
  authoredByAccount: string;
  authoredUs: string;
  approvedBy: string | null;
  approvedByAccount: string | null;
  approvedUs: string | null;
  /** Null for a reader without FORMULA.READ. */
  lines: FormulaLine[] | null;
}

export interface FormulaRead {
  formulaId: string;
  productCode: string;
  strength: string;
  batchSizeUnits: string;
  compositionReadable: boolean;
  versions: FormulaVersionRead[];
}

export interface FormulaChoice {
  formulaId: string;
  versionId: string;
  versionNumber: number;
  productCode: string;
  strength: string;
  batchSizeUnits: string;
  /** The theoretical batch mass in kg: the per-unit lines other than processing aids. */
  batchMassKg: string;
  lines: FormulaLine[];
}

async function one<T>(db: Db, sql: string, params: unknown[]): Promise<T> {
  try {
    const { rows } = await db.query<{ r: T }>(sql, params);
    if (rows.length === 0) throw new Error(`no result from ${sql}`);
    return (rows[0] as { r: T }).r;
  } catch (error) {
    throw commands.asKernelError(error);
  }
}

export const createFormula = (db: Db, def: { productCode: string; strength: string; batchSizeUnits: string }): Promise<string> =>
  one(db, 'select recipe.formula_create($1::jsonb)::text as r', [JSON.stringify(def)]);

export const addFormulaVersion = (db: Db, formulaId: string, v: { changeReason: string; lines: readonly FormulaLineInput[] }): Promise<string> =>
  one(db, 'select recipe.formula_add_version($1, $2::jsonb)::text as r', [formulaId, JSON.stringify(v)]);

/** A formula version's target unit mass and further batch sizes (recipe-core 1535, slice 7j). */
export interface FormulaTarget {
  targetUnitMassMg: string;
  /** Units per batch, the formula's reference size first. */
  batchSizesUnits: string[];
}

/** Writes a DRAFT version's target once, before its approval (FORMULA.MANAGE; recipe-core 1535). */
export const setFormulaTarget = async (db: Db, versionId: string, t: { targetUnitMassMg: string; otherBatchSizesUnits: readonly string[] }): Promise<void> => {
  await one(db, 'select recipe.formula_set_target($1, $2::jsonb)::text as r', [versionId, JSON.stringify(t)]);
};

/** The version's target, or null when none was written. */
export const formulaTargetOf = (db: Db, versionId: string): Promise<FormulaTarget | null> => one(db, 'select recipe.formula_target_of($1) as r', [versionId]);

/** The approver's FORMULA_APPROVED signature on aggregate formula_version, made in their own session first. */
export const approveFormulaVersion = async (db: Db, versionId: string, signatureId: string): Promise<void> => {
  await one(db, 'select recipe.formula_approve($1, $2)::text as r', [versionId, signatureId]);
};


export const formulaChoice = (db: Db, product: string, strength: string, units: string): Promise<FormulaChoice> =>
  one(db, 'select recipe.formula_choice($1, $2, $3::numeric) as r', [product, strength, units]);

/** An APPROVED formula version for an MBR author's "Choose a product" (FORMULA.READ). */
export const formulaVersionForMbr = (db: Db, versionId: string): Promise<FormulaChoice> => one(db, 'select recipe.formula_version_for_mbr($1) as r', [versionId]);

/** Pins the formula version a DRAFT MBR version's composition was taken from; the database checks the content carries it. */
export const pinFormula = async (db: Db, mbrVersionId: string, formulaVersionId: string): Promise<void> => {
  await one(db, 'select recipe.formula_pin_mbr($1, $2)::text as r', [mbrVersionId, formulaVersionId]);
};

export const mbrFormulaOf = (db: Db, mbrVersionId: string): Promise<string | null> => one(db, 'select recipe.mbr_formula_of($1)::text as r', [mbrVersionId]);
