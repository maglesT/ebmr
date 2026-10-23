/**
 * Namespace `masterData` (Phase 3 slice 6, GMP): the company formulation library (decision 0006 part 1, D-S6-3,
 * D-S6-4). A formula is recorded once per product, strength and batch size (in units); its versions are insert-only and
 * written by a person holding FORMULA.MANAGE as DRAFT; a second person approves a version with FORMULA_APPROVED
 * (signable action MASTER_DATA_APPROVE). The composition is per unit; every batch quantity is computed by the database
 * from it and the batch size, never typed (INV-25). Reading a composition needs FORMULA.READ (DI-13), checked by the
 * database's read functions; a person without it sees the formula's identity only.
 *
 * "Choose a product" (`designer.formulaChoice`) gives the approved version's bill of materials with its quantities for
 * a new MBR; an MBR pins the formula version, and its approval is refused while that version is not APPROVED.
 */
import { z } from 'zod';
import { DecimalString, Instant, IntegerString, PersonRef, SignableRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const MaterialCode = z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/);
const formulaParams = z.strictObject({ formulaId: Uuid });

export const FormulaLineRole = z.enum(['ACTIVE', 'EXCIPIENT', 'COATING', 'PROCESSING_AID']);

/** One line of a formula version as its author writes it (per unit, or per batch for a processing aid). */
export const FormulaLineInput = z.strictObject({
  lineId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
  materialCode: MaterialCode,
  role: FormulaLineRole,
  /** PER_UNIT: `quantity` mg in one unit (tablet); PER_BATCH: `quantity` kg for the formula's batch size (e.g. a granulating solvent). */
  basis: z.enum(['PER_UNIT', 'PER_BATCH']),
  quantity: DecimalString,
  /** Overage in percent of the label claim (PER_UNIT ACTIVE lines only), e.g. '2.0'. */
  overagePercent: DecimalString.optional(),
  /** Salt-to-base factor: the unit quantity names the base, the material is the salt (ACTIVE lines only), e.g. '1.0812'. */
  saltFactor: DecimalString.optional(),
  /** The active's quantity is adjusted at dispensing from the lot's assay and LOD (TB-01). */
  potencyAdjusted: z.boolean(),
  /** The excipient that compensates the active's adjustment (one per formula at most). */
  compensating: z.boolean(),
});
export type FormulaLineInput = z.infer<typeof FormulaLineInput>;

/** A line as stored, with the batch quantity the database computed (kg, exact decimal). */
export const FormulaLineView = z.strictObject({
  lineId: z.string(),
  materialCode: z.string(),
  materialName: z.string().nullable(),
  role: FormulaLineRole,
  basis: z.enum(['PER_UNIT', 'PER_BATCH']),
  quantity: DecimalString,
  quantityUnit: z.enum(['mg', 'kg']),
  overagePercent: DecimalString.nullable(),
  saltFactor: DecimalString.nullable(),
  potencyAdjusted: z.boolean(),
  compensating: z.boolean(),
  /** Computed, never typed (INV-25): the quantity for the formula's batch size, in kg. */
  batchQuantity: DecimalString,
  batchUnit: z.literal('kg'),
});
export type FormulaLineView = z.infer<typeof FormulaLineView>;

/** A version's target unit mass (mg) and its batch sizes in units, the formula's reference size first (recipe-core 1535). */
export const FormulaTargetView = z.strictObject({ targetUnitMassMg: DecimalString, batchSizesUnits: z.array(IntegerString).min(1) });
export type FormulaTargetView = z.infer<typeof FormulaTargetView>;

export const FormulaVersionView = z.strictObject({
  versionId: Uuid,
  formulaId: Uuid,
  versionNumber: z.number().int().positive(),
  state: z.enum(['DRAFT', 'APPROVED', 'SUPERSEDED']),
  changeReason: z.string(),
  /** Null when the reader lacks FORMULA.READ (DI-13): the identity is shown, the composition is not. */
  lines: z.array(FormulaLineView).nullable(),
  /** Slice 7j: the target unit mass and the batch sizes, when the author wrote them (signed with the composition). */
  target: FormulaTargetView.nullable(),
  authoredBy: PersonRef,
  authoredAt: Instant,
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
  /** The aggregate the approver signs (formula_version). */
  signable: SignableRef,
});
export type FormulaVersionView = z.infer<typeof FormulaVersionView>;

export const FormulaSummaryView = z.strictObject({
  formulaId: Uuid,
  productCode: z.string(),
  strength: z.string(),
  productName: z.string().nullable(),
  /** Units (tablets) per batch, as text. */
  batchSizeUnits: IntegerString,
  latestVersion: z.number().int().nonnegative(),
  approvedVersion: z.number().int().positive().nullable(),
});
export type FormulaSummaryView = z.infer<typeof FormulaSummaryView>;

export const FormulaView = z.strictObject({
  formula: FormulaSummaryView,
  versions: z.array(FormulaVersionView),
  /** The reader holds FORMULA.READ. */
  compositionReadable: z.boolean(),
});
export type FormulaView = z.infer<typeof FormulaView>;

/** "Choose a product": the approved formula version's bill of materials for a new MBR, quantities computed. */
export const FormulaChoiceView = z.strictObject({
  formulaId: Uuid,
  versionId: Uuid,
  versionNumber: z.number().int().positive(),
  productCode: z.string(),
  strength: z.string(),
  batchSizeUnits: IntegerString,
  bom: z.array(FormulaLineView),
  /** Slice 7j: the version's target and batch sizes, null when none was written. */
  target: FormulaTargetView.nullable(),
});
export type FormulaChoiceView = z.infer<typeof FormulaChoiceView>;

/** Phase 7 slice 7j (R4, D-7j-1): a material master version entered on screen (site-services 1530); QA confirms it. */
export const MaterialEntryInput = {
  materialCode: MaterialCode,
  materialName: z.string().trim().min(1).max(200),
  materialKind: z.enum(['API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING', 'INTERMEDIATE', 'FINISHED']),
  unit: z.string().regex(/^[!-~]{1,32}$/),
  maxRetestMonths: z.number().int().min(1).max(120).optional(),
  grade: z.string().trim().min(1).max(64).optional(),
  pharmacopoeia: z.enum(['IP', 'BP', 'PH_EUR', 'USP', 'JP', 'IN_HOUSE', 'NONE']).optional(),
  changeReason: z.string().trim().min(1).max(2000),
};

/** Phase 7 slice 7j (R4, D-7j-1): a product master version entered on screen (site-services 1530); QA confirms it. */
export const ProductEntryInput = {
  productCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,31}$/),
  strength: z.string().trim().min(1).max(64),
  productName: z.string().trim().min(1).max(200),
  dosageForm: z.string().trim().min(1).max(120),
  betaLactam: z.boolean(),
  reprocessingPermitted: z.boolean().optional(),
  shelfLifeMonths: z.number().int().min(1).max(120),
  changeReason: z.string().trim().min(1).max(2000),
};

/** The version entered: it waits for QA's confirmation (ERP_MASTER_CONFIRMED, signable action MASTER_DATA_APPROVE). */
export const MasterEntryView = z.strictObject({ masterKind: z.enum(['PRODUCT', 'MATERIAL']), key: z.string(), versionId: Uuid, state: z.literal('PENDING') });
export type MasterEntryView = z.infer<typeof MasterEntryView>;

export const masterData = {
  formulas: defineRoute({
    id: 'masterData.formulas',
    method: 'GET',
    path: '/api/master-data/formulas',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Formulas of the library (identity and version states; no composition)',
    response: z.strictObject({ formulas: z.array(FormulaSummaryView) }),
  }),
  createFormula: defineRoute({
    id: 'masterData.createFormula',
    method: 'POST',
    path: '/api/master-data/formulas',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record a formula for a product and strength of the product master and a batch size in units (FORMULA.MANAGE)',
    body: withAttribution({
      productCode: z.string().min(1).max(64),
      strength: z.string().min(1).max(64),
      batchSizeUnits: IntegerString,
    }),
    response: FormulaSummaryView,
  }),
  formula: defineRoute({
    id: 'masterData.formula',
    method: 'GET',
    path: '/api/master-data/formulas/:formulaId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'A formula with its versions; the composition only with FORMULA.READ (DI-13)',
    params: formulaParams,
    response: FormulaView,
  }),
  addFormulaVersion: defineRoute({
    id: 'masterData.addFormulaVersion',
    method: 'POST',
    path: '/api/master-data/formulas/:formulaId/versions',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Write a new DRAFT version of the formula (per-unit composition; batch quantities computed by the database)',
    params: formulaParams,
    body: withAttribution({
      changeReason: z.string().trim().min(1).max(2000),
      lines: z.array(FormulaLineInput).min(1).max(60),
      /** Slice 7j (recipe-core 1535): the tablet's target weight in mg and the batch sizes besides the formula's (units). */
      target: z.strictObject({ targetUnitMassMg: DecimalString, otherBatchSizesUnits: z.array(IntegerString).max(9) }).optional(),
    }),
    response: FormulaVersionView,
  }),
  enterMaterial: defineRoute({
    id: 'masterData.enterMaterial',
    method: 'POST',
    path: '/api/master-data/materials',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Enter a material master version on screen (MASTER_DATA.ENTER); it takes effect once QA confirms it',
    body: withAttribution(MaterialEntryInput),
    response: MasterEntryView,
  }),
  enterProduct: defineRoute({
    id: 'masterData.enterProduct',
    method: 'POST',
    path: '/api/master-data/products',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Enter a product master version on screen (MASTER_DATA.ENTER); it takes effect once QA confirms it',
    body: withAttribution(ProductEntryInput),
    response: MasterEntryView,
  }),
} as const;
