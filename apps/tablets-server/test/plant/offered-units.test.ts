/**
 * The choice of units a status step offers (retest of 13 November 2026, bug 5), as a pure rule: the stage's rooms first,
 * other rooms' usable units when none there can be used, every unit with why when none can anywhere, and always a unit
 * with an open use of the batch. The database-backed path is unit-choice.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { offeredUnits } from '../../src/features/execution/step-plant.ts';

const u = (code: string, area: string | null, problems: string[] = [], class_code = 'PRS') => ({ code, area, problems, class_code });

describe('offeredUnits (retest 13 November 2026, bug 5)', () => {
  it('[PR-23][IN-25] the rule over each case: a usable stage-room unit alone; else the usable units of other rooms with a note; no unit in the stage rooms; none usable anywhere; an open use always kept; other classes never', () => {
    const here = u('P-A', 'R1', ['it is DIRTY: to be cleaned']);
    const there = u('P-B', 'R2');
    const far = u('P-C', 'R3', ['it is in use by batch X (INV-12)']);
    const other = u('B-1', 'R1', [], 'BAL');
    expect(offeredUnits('PRS', ['R1'], [u('P-A', 'R1'), there, other], new Set())).toEqual({ offered: [u('P-A', 'R1')], note: null });
    const fallback = offeredUnits('PRS', ['R1'], [here, there, far, other], new Set());
    expect(fallback.offered.map((x) => x.code)).toEqual(['P-A', 'P-B']);
    expect(fallback.note).toMatch(/^P-A \(R1: it is DIRTY: to be cleaned\): cannot be used now\. .* offered: P-B \(R2\)\./);
    const noneHere = offeredUnits('PRS', ['R9'], [here, there], new Set());
    expect(noneHere.offered.map((x) => x.code)).toEqual(['P-A', 'P-B']);
    expect(noneHere.note).toMatch(/No unit of class PRS is installed in the stage's rooms \(R9\)/);
    const none = offeredUnits('PRS', ['R1'], [far, here], new Set());
    expect(none.offered.map((x) => x.code)).toEqual(['P-A', 'P-C']);
    expect(none.note).toMatch(/^No unit of class PRS can be used now: P-A \(R1: it is DIRTY: to be cleaned\); P-C \(R3: it is in use by batch X \(INV-12\)\)\. Have a unit cleaned/);
    expect(offeredUnits('PRS', ['R1'], [u('P-A', 'R1'), there, far], new Set(['P-C'])).offered.map((x) => x.code)).toEqual(['P-A', 'P-C']);
    expect(offeredUnits('PRS', ['R1'], [other], new Set())).toEqual({ offered: [], note: null });
  });
});
