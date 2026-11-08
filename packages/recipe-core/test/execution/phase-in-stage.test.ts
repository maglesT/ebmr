/**
 * R-flow item 1 (D-0 row 3; ADR 0004 decision 1, amended 7 November 2026): the operation level is optional. A master
 * whose stages hold their phases and hold points directly, with no operation, passes the validator, is numbered
 * `stage.step` the same way by the engine and by the database (recipe.flow_numbering, sql/0304), and runs to the end.
 * The edition is not part of the rule: the tablets granulation fixture, with header.edition changed, is checked as an
 * injectables and an API master too (no real fixture of those editions exists). The database's checks of a run of
 * this master (step order, step acts, stage summary) are in step-order-sql, step-acts-sql and stage-summary-sql.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { childrenOf, type FlowNode, type MbrContent } from '../../src/flow/model.ts';
import { numberMbr } from '../../src/flow/numbering.ts';
import { clone, errors, loadFixture, validate, withoutOperations } from '../flow/support.ts';
import { autopilot, define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS, GRANULATION_SCENARIO, Run } from '../engine/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

function operations(n: FlowNode): number {
  return (n.kind === 'operation' ? 1 : 0) + childrenOf(n).reduce((s, c) => s + operations(c), 0);
}

describe('a phase directly in a stage (R-flow item 1, ADR 0004 decision 1 amended)', () => {
  const base = loadFixture('tablet-granulation-compression');
  const flat = withoutOperations(base);

  it('[DI-34][INV-19] a master with no operation passes the validator in every edition, with the findings of the original', () => {
    expect(operations(base.procedure.body)).toBeGreaterThan(0);
    expect(operations(flat.procedure.body)).toBe(0);
    const keys = (m: MbrContent): string[] => errors(validate(m)).map((f) => f.key).sort();
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const before = clone(base);
      before.header.edition = edition;
      const after = clone(flat);
      after.header.edition = edition;
      expect(keys(after)).toEqual(keys(before));
      expect(errors(validate(after)).filter((f) => f.rule === 'FLOW-LEVELS')).toEqual([]);
    }
  });

  it('[DI-34][DI-14] the engine and the database number a step directly in a stage stage.step (e.g. 2.3), and agree', async () => {
    const numbering = numberMbr(flat);
    // A hold point between stages sits at the procedure level and keeps its single number.
    const steps = numbering.steps.filter((s) => !s.id.includes('/') && s.stage !== undefined);
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s.number).toMatch(/^\d+\.\d+$/);
    expect(steps.map((s) => s.number)).toContain('2.3');
    const { rows } = await db.admin.query<{ id: string; number: string }>(`select key as id, value ->> 'number' as number from jsonb_each(recipe.flow_numbering($1::jsonb) -> 'ids')`, [
      JSON.stringify(flat),
    ]);
    const sql = new Map(rows.map((r) => [r.id, r.number]));
    for (const s of numbering.steps) expect([s.id, sql.get(s.id)]).toEqual([s.id, s.number]);
  });

  it('[DI-34][INV-19] the batch of a master with no operation runs to the end', () => {
    const run = Run.issue(define(flat, { justifications: FIXTURE_JUSTIFICATIONS }), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    expect(autopilot(run, GRANULATION_SCENARIO)).toBe('COMPLETE');
  });
});
