/**
 * Phase 7 slice 7o (D-7o-1, tablets 1700; found by the R4 browser run of a company's own product): a test run's
 * disposal or sample may name the batch's own output container, whose label the database builds from the test batch's
 * own number (OC-TEST-B26-0001-0006); any other container that is not a test lot number stays refused (DI-05).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { personaIn, tapFor, valueOf } from '../esig/support.ts';
import { dcMini, importAndIssue, startExecServer, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

async function runWithContainer(): Promise<{ runId: string; batchNumber: string; label: string }> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const { rows } = await sbx.db.admin.query<{ batch_number: string }>('select batch_number from recipe.batch_execution where id = $1', [runId]);
  const batchNumber = rows[0]?.batch_number ?? '';
  // The run's own output container, opened on the containers route by the operator (D-7o-1).
  const operator = await sbx.asPersona('operator1');
  const body = { batchId: runId, stage: 'INSPECTION', unit: 'kg' as const };
  vi.advanceTimersByTime(7_000);
  const attribution = await tapFor(operator, personaIn(sbx, 'operator1'), 'POST', '/api/containers', body);
  const opened = valueOf(await operator.call(routes.containers.open, { body, attribution }));
  const label = opened.label;
  return { runId, batchNumber, label };
}

const entryProblem = async (runId: string, entry: Record<string, unknown>): Promise<string | null> =>
  (await sbx.db.admin.query<{ p: string | null }>('select tab.entry_identifier_problem($1::uuid, $2::jsonb) as p', [runId, JSON.stringify(entry)])).rows[0]?.p ?? null;
const stateProblem = async (batchNumber: string, entry: Record<string, unknown>): Promise<string | null> =>
  (await sbx.db.admin.query<{ p: string | null }>("select tab.state_entry_identifier_problem($1::jsonb, '{}'::jsonb, $2) as p", [JSON.stringify(entry), batchNumber])).rows[0]?.p ?? null;

describe('a test run names its own output containers (slice 7o)', () => {
  it('[DI-05][DI-30] a disposal or sample of a test run names the batch\'s own output container, a bound word of its record; another batch\'s container or a label no container of the run carries is refused', async () => {
    const a = await runWithContainer();
    const b = await runWithContainer();
    for (const kind of ['DISPOSAL', 'SAMPLE']) {
      expect(await entryProblem(a.runId, { kind, container: a.label })).toBeNull();
      expect(await stateProblem(a.batchNumber, { kind, data: { container: a.label } })).toBeNull();
      // Another run's container, and a label of this run's form that no container carries: refused as before.
      expect(await entryProblem(a.runId, { kind, container: b.label })).toMatch(/^container /);
      expect(await entryProblem(a.runId, { kind, container: `OC-${a.batchNumber}-0099` })).toMatch(/^container /);
      expect(await stateProblem(a.batchNumber, { kind, data: { container: b.label } })).toMatch(/^container /);
    }
    // The record's free-text rule (recipe-core 1701): the run's own container label is a bound word, another run's is not.
    const unbound = async (runId: string, batchNumber: string, word: string): Promise<string | null> =>
      (await sbx.db.admin.query<{ w: string | null }>('select recipe.unbound_real_identifier(to_jsonb($3::text), recipe.run_bound_words($1::uuid, to_jsonb($3::text)), $2) as w', [runId, batchNumber, word])).rows[0]?.w ?? null;
    expect(await unbound(a.runId, a.batchNumber, a.label)).toBeNull();
    expect(await unbound(a.runId, a.batchNumber, b.label)).not.toBeNull();
    // Every other member keeps the rule: a weighing's container is a test lot number only.
    expect(await entryProblem(a.runId, { kind: 'CONTAINER_WEIGHING', container: a.label, lot: { id: 'TEST-L26-0001' } })).toMatch(/^container /);
  });
});
