/**
 * "Choose a product" in the designer (Phase 3 slice 6a; decision 0006 part 1; D-S6-3; DI-13, INV-25): a new MBR's BOM
 * quantities written from an approved formula version, and the gate that opens an MBR taken from the library only for a
 * reader holding FORMULA.READ. The database decides both: recipe.formula_version_for_mbr (APPROVED, FORMULA.READ),
 * recipe.formula_pin_mbr (the content carries exactly the formula's composition) and recipe.mbr_composition.
 */
import type pg from 'pg';
import type { formula } from '@ebmr/recipe-core';
import type { flow } from '@ebmr/recipe-core/pure';
import { refusal } from '../../platform/http/refusal.ts';

const COMPOSITION_ROLES: ReadonlySet<string> = new Set(['ACTIVE', 'EXCIPIENT', 'PROCESSING_AID']);

function mismatch(why: string): Error {
  return refusal(422, {
    code: 'DESIGNER_FORMULA_TEMPLATE',
    kind: 'INVALID_INPUT',
    whatHappened: 'The family was not created: the template does not take this formula.',
    why,
    controls: ['INV-25', 'PR-01'],
    whatYouCanDo: ['Choose a template whose materials are the formula\'s, or the formula of this template\'s product.'],
  });
}

/**
 * The content with each BOM line of an active, excipient or processing aid carrying the formula's computed batch
 * quantity (kg) of the line of the same material (the template names the materials, the formula gives the quantities).
 * Every formula line must find its BOM line and every such BOM line its formula line.
 */
export function withFormulaBom(content: flow.MbrContent, chosen: formula.FormulaChoice): flow.MbrContent {
  const out = structuredClone(content);
  if (out.header.product.code !== chosen.productCode || out.header.product.strength !== chosen.strength) {
    throw mismatch(`The family is for ${out.header.product.code} ${out.header.product.strength}; the formula is for ${chosen.productCode} ${chosen.strength}.`);
  }
  const used = new Set<string>();
  for (const line of out.bom) {
    if (!COMPOSITION_ROLES.has(line.role)) continue;
    const code = out.references.find((r) => r.id === line.material)?.code ?? line.material;
    const f = chosen.lines.find((l) => l.materialCode === code);
    if (!f) throw mismatch(`BOM line ${line.id} (${code}) is not a material of the formula.`);
    line.quantity = { value: f.batchQuantity, unit: 'kg' };
    used.add(f.lineId);
  }
  const missing = chosen.lines.filter((l) => !used.has(l.lineId));
  if (missing.length > 0) throw mismatch(`The template has no BOM line for ${missing.map((l) => l.materialCode).join(', ')}.`);
  return out;
}

/** DI-13: refuses a reader without FORMULA.READ an MBR version whose composition comes from the library (tablets 1041). */
export async function compositionGate(pool: pg.Pool, tokenHash: string, versionId: string): Promise<void> {
  await pool.query('select tab.mbr_composition_check($1, $2)', [tokenHash, versionId]);
}
