/**
 * Capsules edition plan (docs/build-plan/capsules/plan.md, slice C2; lead, 4 November 2026): whether a product is a
 * tablet or a capsule, read from its free-text dosage form (core's report.product_v1 `dosage_form` on the platform
 * build, the product master's dosage form otherwise). A product is a capsule only when its dosage form contains
 * "capsule" (any case): hard capsules and soft gels alike ("Hard gelatin capsule", "Soft gelatin capsule"). No dosage
 * form means a tablet (the ERP feed carries none). A bare soft-gel name ("Softgel", "Soft gel") is refused with a hint,
 * so a soft gel is never made under tablet wording; so is any other stated form that is neither a tablet nor a capsule
 * (this build makes oral solid units only). Display and wording only: no GMP value depends on it.
 */
export type UnitForm = 'TABLET' | 'CAPSULE';

export type DosageFormReading =
  | { readonly ok: true; readonly form: UnitForm; readonly unit: 'tablet' | 'capsule' }
  | { readonly ok: false; readonly hint: string };

const SOFT_GEL = /soft[\s-]*gel/i;

export function readDosageForm(dosageForm: string | null | undefined): DosageFormReading {
  const text = (dosageForm ?? '').trim();
  if (/capsule/i.test(text)) return { ok: true, form: 'CAPSULE', unit: 'capsule' };
  if (SOFT_GEL.test(text)) {
    return { ok: false, hint: `Name a soft gel as a capsule form, for example "Soft gelatin capsule"; "${text}" alone does not say it is a capsule.` };
  }
  if (text === '' || /tablet/i.test(text)) return { ok: true, form: 'TABLET', unit: 'tablet' };
  return { ok: false, hint: `"${text}" is neither a tablet nor a capsule form; this build makes tablets and capsules (a soft gel is named as a capsule form, for example "Soft gelatin capsule").` };
}

/** True when the dosage form makes the product a capsule (the header then reads "Batchwright Capsules"). */
export function isCapsuleForm(dosageForm: string | null | undefined): boolean {
  const r = readDosageForm(dosageForm);
  return r.ok && r.form === 'CAPSULE';
}

/**
 * C2 (lead, 5 November 2026): a capsule's empty shells are its formula's COATING line given per unit (the unit's outer
 * part); in a capsule master from a formula that line is a bill-of-materials line of role OTHER, not dispensed into the
 * blend. Every screen names it "Empty capsule shells", never a coating. A real coat on a capsule (C3, enteric) is given
 * per batch, so it never takes this place; a capsule formula with two per-unit COATING lines is refused.
 */
export const SHELLS_LABEL = 'Empty capsule shells';

/** Whether a formula line is a capsule's empty shells. */
export function isShellLine(role: string, basis: string, dosageForm: string | null | undefined): boolean {
  return role === 'COATING' && basis === 'PER_UNIT' && isCapsuleForm(dosageForm);
}

/** A formula line's role as the screens show it: the shells by their name, every other role as its code. */
export function formulaRoleLabel(role: string, basis: string, dosageForm: string | null | undefined): string {
  return isShellLine(role, basis, dosageForm) ? SHELLS_LABEL : role;
}

/** A master's bill-of-materials role as the screens show it on a capsule master (OTHER is the shells), else null. */
export function bomShellsLabel(role: string, dosageForm: string | null | undefined): string | null {
  return role === 'OTHER' && isCapsuleForm(dosageForm) ? SHELLS_LABEL : null;
}
