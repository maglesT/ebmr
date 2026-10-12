/**
 * Which step may be skipped, as the Tablets edition decides it (SQL mutation group "tablets-core-checks", tablets 0874,
 * recipe.skip_problem): only a phase the MBR declares skippable, of no material-moving or tablet block, that consumes,
 * produces and uses nothing, carries no yield checkpoint or acceptance scheme, records only NON_CRITICAL parameters and
 * writes nothing another step reads. Each case breaks exactly one of these. The function is immutable and is called
 * directly on the GMP template with the MBR content as data.
 *
 * Controls: PR-13, PR-16; invariant INV-25.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

type Json = Record<string, unknown>;
const NODE: Json = { kind: 'phase', id: 'P-OPT', block: { type: 'G-03', version: '1' }, config: { skippable: true }, consumes: [], produces: [], uses: [], records: ['NOTE'], computes: ['TALLY'] };
const CONTENT: Json = {
  parameters: [{ id: 'NOTE', criticality: 'NON_CRITICAL' }, { id: 'CPP-1', criticality: 'CRITICAL' }, { id: 'TALLY', criticality: 'NON_CRITICAL' }],
  procedure: { kind: 'sequence', id: 'root', children: [NODE, { kind: 'phase', id: 'P-NEXT', reads: ['OTHER'] }] },
};

const skip = async (node: Json | null, content: Json = CONTENT): Promise<string | null> =>
  (await gmp.db.admin.query<{ r: string | null }>('select recipe.skip_problem($1::jsonb, $2::jsonb) as r', [JSON.stringify(content), node === null ? null : JSON.stringify(node)])).rows[0]?.r ?? null;

describe('recipe.skip_problem (tablets 0874)', () => {
  it('[PR-13][PR-16] a skippable phase that moves nothing, checks nothing and writes nothing another step reads is skipped; each single reason refuses it', async () => {
    expect(await skip(NODE)).toBeNull();
    const moves = 'it moves material or carries a yield or acceptance check';
    for (const k of ['consumes', 'produces', 'uses']) {
      expect(await skip({ ...NODE, [k]: [{ item: 'X' }] })).toBe(moves);
      expect(await skip({ ...NODE, [k]: null })).toBe(moves);
    }
    expect(await skip({ ...NODE, yieldCheckpoint: { min: '95' } })).toBe(moves);
    expect(await skip({ ...NODE, yieldCheckpoint: null })).toBeNull();
    expect(await skip({ ...NODE, acceptanceScheme: { code: 'AQL' } })).toBe(moves);
    expect(await skip({ ...NODE, acceptanceScheme: null })).toBeNull();
    // A recorded parameter must be declared NON_CRITICAL, by its own id.
    expect(await skip({ ...NODE, records: ['NOTE', 'CPP-1'] })).toBe('it records CPP-1, which is not declared NON_CRITICAL: CPP and CQA inputs are never skipped');
    expect(await skip({ ...NODE, records: ['UNDECLARED'] })).toMatch(/it records UNDECLARED, which is not declared NON_CRITICAL/);
    expect(await skip({ ...NODE, records: 'NOTE' })).toBeNull();
    // What it records or computes is read by no other step.
    const reads = (item: string): Json => ({ ...CONTENT, procedure: { kind: 'sequence', id: 'root', children: [NODE, { kind: 'phase', id: 'P-NEXT', reads: [item] }] } });
    expect(await skip(NODE, reads('NOTE'))).toBe('it writes NOTE, which another step reads');
    expect(await skip(NODE, reads('TALLY'))).toBe('it writes TALLY, which another step reads');
    expect(await skip({ ...NODE, computes: 'TALLY' }, reads('TALLY'))).toBeNull();
  });

  it('[PR-13][PR-16] never a step outside the MBR, a hold point, a step not declared skippable, or a step of a material-moving or tablet block', async () => {
    expect(await skip(null)).toBe("the step is not a step of the batch's MBR");
    expect(await skip({ ...NODE, kind: 'holdPoint' })).toBe('it is a QA hold point: release signatures are never skipped');
    expect(await skip({ ...NODE, config: { skippable: 'true' } })).toBe('the MBR does not declare it skippable');
    for (const t of ['G-07', 'G-24', 'TB-01', 'TB-24']) expect(await skip({ ...NODE, block: { type: t, version: '1' } })).toMatch(new RegExp(`it is a step of block ${t}:`));
    expect(await skip({ ...NODE, block: { type: 'TB-1', version: '1' } })).toBeNull();
  });
});
