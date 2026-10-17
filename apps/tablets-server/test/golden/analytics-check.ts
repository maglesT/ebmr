/**
 * Phase 6A slice 6A-1 (draft control DI-51; D-6A-17): what the golden batches show about the analytics runner that ran
 * beside them. The exact outputs themselves (quantities, states, exceptions, signatures and the true-copy hashes) are
 * the golden tests' own assertions on the same run; this adds that the runner did run over these batches, read their
 * facts and critical values, and wrote only advisory rows in the analytics schema.
 */
import { expect } from 'vitest';
import type { RunReport } from '../../src/analytics/runner.ts';
import type { GoldenWorld } from './gb-t-01/world.ts';

export async function expectRunnerBeside(w: GoldenWorld, reports: readonly RunReport[] | undefined, batchIds: readonly string[]): Promise<void> {
  expect(reports?.filter((r) => r.method === 'SPC.IMR').map((r) => r.status)).toEqual(['DONE']);
  const db = w.server.db.admin;
  // The input views list the golden batches with their critical values as decimal text.
  const { rows: facts } = await db.query<{ batch_id: string }>('select batch_id::text from report.batch_fact_v1 where batch_id = any($1::uuid[])', [batchIds]);
  expect(facts.map((f) => f.batch_id).sort()).toEqual([...batchIds].sort());
  const { rows: values } = await db.query<{ n: number; bad: number }>(
    "select count(*)::int as n, count(*) filter (where value_text !~ '^-?[0-9]+(\\.[0-9]+)?$')::int as bad from report.cpp_value_v1 where batch_id = any($1::uuid[])", [batchIds]);
  expect(values[0]!.n).toBeGreaterThan(0);
  expect(values[0]!.bad).toBe(0);
  // The last run counted them, and finished.
  const run = reports!.find((r) => r.method === 'SPC.IMR')!;
  const { rows: out } = await db.query<{ batches: number; values: number }>(
    `select ("values" ->> 'batches')::int as batches, ("values" ->> 'values')::int as values from analytics.output_v1 where run_id = $1`, [run.runId]);
  expect(out[0]!.batches).toBeGreaterThanOrEqual(batchIds.length);
  expect(out[0]!.values).toBeGreaterThanOrEqual(values[0]!.n);
  // Everything the runner's identity wrote is in the analytics schema.
  const { rows: written } = await db.query<{ t: string }>(
    "select distinct table_name as t from kernel.audit_event where payload -> 'actor' ->> 'role_code' = 'ANALYTICS_RUNNER' order by 1");
  expect(written.length).toBeGreaterThan(0);
  expect(written.filter((x) => !x.t.startsWith('analytics.'))).toEqual([]);
}
