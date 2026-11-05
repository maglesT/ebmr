import { describe, expect, it } from 'vitest';
import { isCapsuleForm, readDosageForm } from '../../src/flow/dosage-form.ts';

describe('the unit form from the dosage form (Capsules edition, C2)', () => {
  it('[PR-01] a dosage form containing "capsule" in any case is a capsule; hard and soft alike', () => {
    for (const f of ['Hard gelatin capsule', 'Soft gelatin capsule', 'CAPSULE', 'Delayed-release capsules, HPMC', 'Softgel capsule']) {
      expect(readDosageForm(f)).toEqual({ ok: true, form: 'CAPSULE', unit: 'capsule' });
      expect(isCapsuleForm(f)).toBe(true);
    }
  });

  it('[PR-01] no dosage form, or a tablet form, is a tablet', () => {
    for (const f of [null, undefined, '', '   ', 'Film-coated tablet', 'TABLETS', 'Mini-tablets in sachet']) {
      expect(readDosageForm(f)).toEqual({ ok: true, form: 'TABLET', unit: 'tablet' });
      expect(isCapsuleForm(f)).toBe(false);
    }
  });

  it('[PR-01] a bare soft-gel name is refused with the hint to name it as a capsule form', () => {
    for (const f of ['Softgel', 'soft gel', 'Soft-gel', 'SOFTGELS']) {
      const r = readDosageForm(f);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.hint).toContain('Soft gelatin capsule');
      expect(isCapsuleForm(f)).toBe(false);
    }
  });

  it('[PR-01] any other stated form is refused', () => {
    const r = readDosageForm('Solution for injection');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.hint).toContain('neither a tablet nor a capsule');
  });
});
