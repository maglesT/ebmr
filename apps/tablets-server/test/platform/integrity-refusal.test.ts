/**
 * A row the database refuses by a table's own rule answers as a refusal of the input, never 500 INTERNAL (owner report
 * items 22 and 23, G5): a check constraint (23514) and a missing value (23502) as 422, a duplicate (23505) as 409, the
 * constraint named; the database's rule stays the guard.
 */
import { describe, expect, it } from 'vitest';
import { mapError } from '../../src/platform/http/errors.ts';
import type { AppContext } from '../../src/platform/context.ts';

const app = { guidance: { lookup: (code: string) => (code === 'INTERNAL' ? { status: 500, kind: 'INTERNAL', whatHappened: 'Unexpected.', whatYouCanDo: [], whoCanHelp: [], controls: [] } : undefined) } } as unknown as AppContext;
const pg = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('new row violates a rule'), { code, ...extra });

describe('database rule violations as refusals (G5)', () => {
  it('[DI-34] a check, a not-null and a unique violation, as the error or its cause, answer 422, 422 and 409 naming the rule; any other database error stays INTERNAL', () => {
    const check = mapError(app, pg('23514', { constraint: 'equipment_event_check' }), 'c1');
    expect([check.status, check.envelope.refusal.code, check.envelope.refusal.why]).toEqual([422, 'EBMR-API-CHECK', "The combination does not meet the record's rule equipment_event_check."]);
    const missing = mapError(app, pg('23502', { table: 'material_lot', column: 'supplier' }), 'c2');
    expect([missing.status, missing.envelope.refusal.code, missing.envelope.refusal.why]).toEqual([422, 'EBMR-API-CHECK', 'A required value is missing (material_lot.supplier).']);
    const duplicate = mapError(app, Object.assign(new Error('wrapped'), { cause: pg('23505', { constraint: 'material_lot_site_code_lot_code_key' }) }), 'c3');
    expect([duplicate.status, duplicate.envelope.refusal.code, duplicate.envelope.refusal.why]).toEqual([409, 'EBMR-API-DUPLICATE', 'A record with the same key already exists (material_lot_site_code_lot_code_key).']);
    expect(duplicate.envelope.refusal.whatHappened).toMatch(/Nothing was saved/);
    expect(mapError(app, pg('40001'), 'c4').status).toBe(500);
  });
});
