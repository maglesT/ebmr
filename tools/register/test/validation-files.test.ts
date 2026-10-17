/**
 * The files under compliance/validation/ (Phase 7 slice 7-0, interfaces note section 1c): `register:validate` refuses
 * a file that breaks its schema, an entry out of order, a control the register does not have and a test no control
 * lists; a control not listed in control-class.yaml is core (D-P7-0-4).
 */
import { describe, expect, it } from 'vitest';
import { loadControls } from '../src/register.ts';
import { controlClass, loadValidationFiles, naturalCompare, validationFileErrors, type ValidationFiles } from '../src/validation-files.ts';

const controls = loadControls();
const listed = controls.find((c) => c.tests.length > 0)?.tests[0] ?? '';

/** A valid set of the four files, small enough to change one field at a time. */
const files = (change: Partial<ValidationFiles> = {}): ValidationFiles => ({
  'control-class.yaml': { classes: [{ id: 'IN-12', class: 'other', basis: 'a documentation-type control' }] },
  'critical-limits.yaml': { limits: [{ key: 'a-limit', description: 'a limit at its boundary', controls: ['PR-19'], boundaryTests: [listed] }] },
  'reviews.yaml': {
    reviews: [
      {
        id: '6j-c',
        date: '2026-10-16',
        scope: ['packages/kernel/sql/**'],
        findings: { critical: { open: 0, fixed: 0 }, high: { open: 0, fixed: 3 }, medium: { open: 4, fixed: 0 }, low: { open: 10, fixed: 0 } },
      },
    ],
  },
  'open-findings.yaml': {
    findings: [{ id: '6jc-R2', severity: 'medium', controls: ['IN-53'], summary: 'reads need only a session', source: 'docs/build-plan/phase-6/review-backlog.md' }],
  },
  ...change,
});

describe('the compliance/validation files (slice 7-0)', () => {
  it('[meta] the files in the repository are valid: schema, order, known controls and listed tests', () => {
    expect(validationFileErrors()).toEqual([]);
  });

  it('[meta] a valid set has no problem', () => {
    expect(listed).not.toBe('');
    expect(validationFileErrors(files(), controls)).toEqual([]);
  });

  it('[meta] a critical limit naming a test no control lists is refused', () => {
    const unknown = 'packages/kernel/test/nowhere.test.ts > a test nobody wrote';
    const errors = validationFileErrors(
      files({ 'critical-limits.yaml': { limits: [{ key: 'a-limit', description: 'a limit at its boundary', controls: ['PR-19'], boundaryTests: [listed, unknown] }] } }),
      controls,
    );
    expect(errors).toEqual([`compliance/validation/critical-limits.yaml: limit a-limit names a test no control lists: "${unknown}"`]);
  });

  it('[meta] an unknown control is refused in each file that names controls', () => {
    const errors = validationFileErrors(
      files({
        'control-class.yaml': { classes: [{ id: 'DI-99', class: 'other', basis: 'not a control of the register' }] },
        'critical-limits.yaml': { limits: [{ key: 'a-limit', description: 'a limit at its boundary', controls: ['PR-98'], boundaryTests: [listed] }] },
        'open-findings.yaml': { findings: [{ id: 'X-1', severity: 'low', controls: ['ST-97'], summary: 'names no real control', source: 'docs/build-plan/phase-6/review-backlog.md' }] },
      }),
      controls,
    );
    expect(errors).toEqual([
      'compliance/validation/control-class.yaml: class entry DI-99 names an unknown control DI-99',
      'compliance/validation/critical-limits.yaml: limit a-limit names an unknown control PR-98',
      'compliance/validation/open-findings.yaml: finding X-1 names an unknown control ST-97',
    ]);
  });

  it('[meta] a class other than core or other, a severity outside the four and a missing field break the schema', () => {
    const errors = validationFileErrors(
      files({
        'control-class.yaml': { classes: [{ id: 'IN-12', class: 'minor', basis: 'a documentation-type control' }] },
        'open-findings.yaml': { findings: [{ id: 'X-1', severity: 'trivial', controls: [], summary: 'a finding of no known severity', source: 'docs/x.md' }] },
        'reviews.yaml': { reviews: [{ id: '6j-c', date: '2026-10-16', scope: ['x/**'] }] },
      }),
      controls,
    );
    expect(errors).toContain('compliance/validation/control-class.yaml: /classes/0/class must be equal to one of the allowed values');
    expect(errors).toContain('compliance/validation/open-findings.yaml: /findings/0/severity must be equal to one of the allowed values');
    expect(errors).toContain("compliance/validation/reviews.yaml: /reviews/0 must have required property 'findings'");
    expect(validationFileErrors(files({ 'reviews.yaml': null }), controls)).toEqual(['compliance/validation/reviews.yaml: / must be object']);
  });

  it('[meta] entries out of order or repeated are refused; numbers in ids compare as numbers', () => {
    const finding = (id: string): object => ({ id, severity: 'low', controls: [], summary: 'a residual of a review', source: 'docs/build-plan/phase-6/review-backlog.md' });
    expect(validationFileErrors(files({ 'open-findings.yaml': { findings: [finding('6jc-R2'), finding('6jc-R10'), finding('P6A7-4')] } }), controls)).toEqual([]);
    expect(validationFileErrors(files({ 'open-findings.yaml': { findings: [finding('6jc-R10'), finding('6jc-R2'), finding('6jc-R2')] } }), controls)).toEqual([
      'compliance/validation/open-findings.yaml: id 6jc-R2 is out of order (it sorts before 6jc-R10)',
      'compliance/validation/open-findings.yaml: duplicate id 6jc-R2',
    ]);
    expect(naturalCompare('DI-03', 'DI-10')).toBeLessThan(0);
    expect(naturalCompare('6A-7', '6j-c')).toBeLessThan(0);
    expect(naturalCompare('a-limit', 'a-limit')).toBe(0);
  });

  it('[meta] a finding citing a backlog that does not exist is refused', () => {
    const errors = validationFileErrors(
      files({ 'open-findings.yaml': { findings: [{ id: 'X-1', severity: 'low', controls: [], summary: 'cites no real backlog', source: 'docs/no-such-backlog.md' }] } }),
      controls,
    );
    expect(errors).toEqual(['compliance/validation/open-findings.yaml: finding X-1 cites a source that does not exist: docs/no-such-backlog.md']);
  });

  it('[meta] D-P7-0-4: a control not listed in control-class.yaml is core; a listed one has its class', () => {
    const doc = loadValidationFiles()['control-class.yaml'] as { classes: { id: string; class: 'core' | 'other'; basis: string }[] };
    expect(controlClass('IN-12', doc.classes)).toBe('other');
    expect(controlClass('DI-03', doc.classes)).toBe('core');
    expect(controlClass('DI-22', doc.classes)).toBe('core');
    expect(doc.classes.some((e) => e.id === 'DI-22')).toBe(false);
  });
});
