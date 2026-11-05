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

describe('a capsule\'s empty shells (C2; lead, 5 November 2026)', () => {
  it('[PR-03] the per-unit COATING line of a capsule is its shells, named "Empty capsule shells"; a per-batch coat and every tablet line keep their role', async () => {
    const { bomShellsLabel, formulaRoleLabel, isShellLine, SHELLS_LABEL } = await import('../../src/flow/dosage-form.ts');
    expect(SHELLS_LABEL).toBe('Empty capsule shells');
    expect(isShellLine('COATING', 'PER_UNIT', 'Hard gelatin capsule')).toBe(true);
    expect(formulaRoleLabel('COATING', 'PER_UNIT', 'Hard gelatin capsule')).toBe('Empty capsule shells');
    expect(isShellLine('COATING', 'PER_BATCH', 'Enteric-coated capsule')).toBe(false);
    expect(formulaRoleLabel('COATING', 'PER_BATCH', 'Enteric-coated capsule')).toBe('COATING');
    expect(isShellLine('COATING', 'PER_UNIT', 'Film-coated tablet')).toBe(false);
    expect(formulaRoleLabel('EXCIPIENT', 'PER_UNIT', 'Hard gelatin capsule')).toBe('EXCIPIENT');
    expect(bomShellsLabel('OTHER', 'Hard gelatin capsule')).toBe('Empty capsule shells');
    expect(bomShellsLabel('OTHER', 'Tablet')).toBeNull();
    expect(bomShellsLabel('EXCIPIENT', 'Hard gelatin capsule')).toBeNull();
  });
});
