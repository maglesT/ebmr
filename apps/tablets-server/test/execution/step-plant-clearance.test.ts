/**
 * The kiosk's read of a packaging line's clearance (step-plant.ts) follows the database's rule of recipe-core 1886: a
 * stage's clearance needs a second person's verification unless its G-10 steps name no checker (211.130(e), lead
 * ruling A5; the injectables packaging skeleton). The database refuses the start on any other clearance
 * (start_area_occupancy; packages/recipe-core/test/plant/status-blocks.test.ts); this proves the screen offers the same.
 */
import { describe, expect, it } from 'vitest';
import { stageClearanceChecked } from '../../src/features/execution/step-plant.ts';

const g10 = (stage: string, check: boolean) => ({ stage, block: { type: 'G-10' }, node: { kind: 'phase', signatures: { perform: {}, ...(check ? { check: {} } : {}) } } });
const other = (stage: string) => ({ stage, block: { type: 'G-21' }, node: { kind: 'phase', signatures: { perform: {}, check: {} } } });

describe('the clearance a line start may stand on, as the kiosk reads it (recipe-core 1886)', () => {
  it('[PR-34][IN-21][INV-15] a stage whose G-10 names no checker takes an unverified passed clearance; one with a checker, a stage with no G-10 and a step with no stage keep the verified rule', () => {
    const steps = [g10('S-PACK', false), other('S-PACK'), g10('S-TAB', true), other('S-TAB'), other('S-NONE')];
    expect(stageClearanceChecked(steps, 'S-PACK')).toBe(false);
    expect(stageClearanceChecked(steps, 'S-TAB')).toBe(true);
    expect(stageClearanceChecked(steps, 'S-NONE')).toBe(true);
    expect(stageClearanceChecked(steps, 'S-UNKNOWN')).toBe(true);
    expect(stageClearanceChecked(steps, undefined)).toBe(true);
    // A firm that adds a checker to one of two clearances of a stage gets the verified rule for the stage (as bool_or).
    expect(stageClearanceChecked([g10('S-PACK', false), g10('S-PACK', true)], 'S-PACK')).toBe(true);
  });
});
