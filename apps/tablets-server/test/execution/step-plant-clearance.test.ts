/**
 * The kiosk's read of a packaging line's clearance (step-plant.ts) follows the database's rule of recipe-core 1886: a
 * stage's clearance needs a second person's verification unless its G-10 steps name no checker (211.130(e), lead
 * ruling A5; the injectables packaging skeleton). The database refuses the start on any other clearance
 * (start_area_occupancy; packages/recipe-core/test/plant/status-blocks.test.ts); this proves the screen offers the same.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';
import { defineForSandbox } from '../../src/features/execution/runs.ts';
import { stageClearanceChecked } from '../../src/features/execution/step-plant.ts';
import { dcMini } from './support.ts';

type Json = Record<string, unknown>;

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

describe('the kiosk\'s rule is the database\'s on the same master (no drift from recipe.clearance_checked, lead review)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer('SANDBOX');
  });
  afterAll(async () => {
    await server.close();
  });

  /** dc-mini with the checker of S-DISP's clearance step removed (S-BLEND keeps its own). */
  const withoutDispChecker = (): unknown => {
    const m = JSON.parse(JSON.stringify(dcMini())) as Json;
    const strip = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(strip);
      else if (n && typeof n === 'object') {
        const o = n as Json;
        if (o['kind'] === 'phase' && o['id'] === 'p-disp-clear') delete (o['signatures'] as Json)['check'];
        Object.values(o).forEach(strip);
      }
    };
    strip(m);
    return m;
  };

  it('[PR-34][IN-21] stageClearanceChecked equals recipe.clearance_checked for each stage of a master with checkers and of one without (S-DISP), and for an unknown stage', async () => {
    for (const content of [dcMini() as unknown, withoutDispChecker()]) {
      const def = defineForSandbox(randomUUID(), content, []);
      for (const stage of ['S-DISP', 'S-BLEND', 'S-UNKNOWN']) {
        const sql = (await server.db.admin.query<{ c: boolean }>('select recipe.clearance_checked($1::jsonb, $2, null) as c', [JSON.stringify(content), stage])).rows[0]?.c;
        expect({ stage, checked: stageClearanceChecked(def.steps.values(), stage) }).toEqual({ stage, checked: sql });
      }
    }
    // The pin is not vacuous: the stripped master's S-DISP is unchecked in both.
    expect(stageClearanceChecked(defineForSandbox(randomUUID(), withoutDispChecker(), []).steps.values(), 'S-DISP')).toBe(false);
  });
});
