/**
 * Phase 2 exit follow-up F12, round 12: a number in a compound is recorded in a test run only in the shapes the engine
 * builds (DI-05, DI-30, INV-18; recipe-core 0348; ADR 0012).
 *
 * recipe-core 0346 and 0347 allowed a compound joined by '/' when each part was a word of the run or any number. A run of
 * dc-mini holds ordinary words of its MBR (BATCH, D, H, QA, TABLET, MG, BAL, SOP, DISP-1), its site SITE-1 and the ids
 * of its records (EX-1), so the lane's round-12 verification recorded, over HTTP, BATCH/2409/0017, D/2409/0017,
 * QA/2409/0017, SITE-1/2409/0017, EX-1/2409/0017 and others in operator1's exception descriptions and supervisor1's hold
 * reason, and BATCH/2409/0017 in a business entry the application role appended on the run's chain, three levels down
 * in its details too; the kernel's rule reads each as a real batch or lot number. Now (recipe-core 0348) a compound
 * passes by its parts only when every part holds a letter and is a word of the run; a number in it only where the run
 * has the whole word from a bound source (a context-key fragment <n>/<loop or replicate section> within the enclosing
 * section's maximum, a compound the MBR, its expanded ids or a held container or sample holds).
 * packages/recipe-core/test/execution/engine-names-sql.test.ts reads every compound of the golden runs of both fixtures
 * (replicate sections, a loop, output containers, samples) and the context fragments.
 *
 * The writer is the application role, through the honest server (HTTP) or with the application's own credentials (a
 * business entry of the audit trail), as in the other db-guards files. Own file and server: the kiosk's device nonces
 * are rate-limited per terminal and minute.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import type { flow } from '@ebmr/recipe-core';
import { actorOf, messageOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, unknown>;
const CLEAR = 'p-disp-clear@';
const REFUSED = '422:EBMR-EXE-147';

/** A run of `content` issued by the issuer, with the kiosks of operator1 and supervisor1. */
async function issued(content: flow.MbrContent): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** A business entry the application role appends itself, as operator1 at its kiosk (room DISP-1). */
async function businessEntry(d: RunDriver, chainKey: string, message: string, details: Json = {}): Promise<string> {
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) => c.query('select kernel.audit_business_event($1, $2, $3::jsonb)', [chainKey, message, JSON.stringify(details)])),
  );
}

/** Where the record of run `runId` holds `text`: rows, events, state, content versions and its audit chains. */
async function recordHolding(runId: string, text: string): Promise<Record<string, number>> {
  const like = `%${text}%`;
  const count = async (sql: string) => Number((await sbx.db.admin.query<{ n: string }>(sql, [runId, like])).rows[0]?.n ?? '0');
  return {
    rows: await count(`select count(*)::text as n from recipe.execution_command where batch_id = $1 and (command::text like $2 or evidence::text like $2 or coalesce(refusal::text, '') like $2)`),
    events: await count('select count(*)::text as n from recipe.execution_event where batch_id = $1 and event::text like $2'),
    state: await count('select count(*)::text as n from recipe.execution_state where batch_id = $1 and state::text like $2'),
    contents: await count(`select count(*)::text as n from (
       select content from recipe.execution_step_content where batch_id = $1 union all select content from recipe.execution_stage_content where batch_id = $1
       union all select content from recipe.execution_exception_content where batch_id = $1 union all select content from recipe.execution_point_content where batch_id = $1) x
      where x.content::text like $2`),
    audit: await count(`select count(*)::text as n from kernel.audit_event e
      where (e.chain_key = 'batch:' || $1 or e.chain_key ~ ('^(esig_challenge:|esig_signature:)?batch_(step|stage|exception|point):' || $1 || ':')) and (e.payload::text like $2 or e.chain_key like $2)`),
  };
}

const NOTHING = { rows: 0, events: 0, state: 0, contents: 0, audit: 0 };

/** The round-12 verification's compounds: a word of the run (or its site, or a record id it holds) and numbers. */
const PROBES = ['BATCH/2409/0017', 'D/2409/0017', 'H/24/0017', 'QA/2409/0017', 'TABLET/2409/0017', 'SITE-1/2409/0017', 'MG/24/017', 'BAL/2409/0017', 'DISP-1/2409/0017', 'SOP/2409/0017', 'EX-1/2409/0017'];

describe('F12 round 12: a number in a compound is recorded only in the shapes the engine builds (DI-05, DI-30)', () => {
  it('[DI-05][DI-30] round 12 (recipe-core 0348): over HTTP BATCH/2409/0017, D/2409/0017, H/24/0017, QA/2409/0017, TABLET/2409/0017, SITE-1/2409/0017, MG/24/017, BAL/2409/0017, DISP-1/2409/0017, SOP/2409/0017 and EX-1/2409/0017 (EX-1 an exception the run holds) in an exception\'s description and in a hold reason are refused (EBMR-EXE-147) and nothing holds them; compounds of the run\'s words, a ratio, a date, prose and TEST- identifiers are recorded', async () => {
    const d = await issued(dcMini());
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    // EX-1 is a record of the run from here on.
    expect(outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found open', severity: 'ALERT' }))).toBe('ok');
    const raised: Record<string, string> = {};
    const held: Record<string, string> = {};
    for (const word of PROBES) {
      raised[word] = outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Drum of ${word} set aside`, severity: 'ALERT' }));
      held[word] = outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold: drum of ${word} found in the booth` }));
    }
    expect({ raised, held }).toEqual({ raised: Object.fromEntries(PROBES.map((w) => [w, REFUSED])), held: Object.fromEntries(PROBES.map((w) => [w, REFUSED])) });
    const honest = {
      words: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Drum moved DISP-1/BLEND-1 per SOP-DISP-001/SOP-BLEND-002, follow-up of EX-1/SITE-1', severity: 'ALERT' })),
      prose: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: '1/2 of drum TEST-L26-0101 spilled on 04/10/2026 at 10:15, 12.5 g at 100% load', severity: 'ALERT' })),
      hold: outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: 'Hold: drum TEST-L26-0101 moved DISP-1/BLEND-1, 1/2 spilled' })),
    };
    expect(honest).toEqual({ words: 'ok', prose: 'ok', hold: 'ok' });
    for (const word of PROBES) expect(await recordHolding(d.runId, word), word).toEqual(NOTHING);
    expect(await recordHolding(d.runId, 'DISP-1/BLEND-1')).toMatchObject({ rows: 2 });
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[DI-05][DI-30] round 12 (recipe-core 0348): a business entry the application role appends on the run\'s chain holding BATCH/2409/0017 in its message, or three levels down in its details, is refused (EBMR-EXE-147) without the word in the refusal, and nothing holds it; an entry holding compounds of the run\'s words is recorded', async () => {
    const d = await issued(dcMini());
    const chain = `batch:${d.runId}`;
    const outcomes = {
      message: await businessEntry(d, chain, 'Drum of BATCH/2409/0017 moved to the booth'),
      details: await businessEntry(d, chain, 'Drum moved to the booth', { drum: { of: { batch: 'BATCH/2409/0017' } } }),
      site: await businessEntry(d, chain, 'Drum moved to the booth', { drum: { of: { batch: 'SITE-1/2409/0017' } } }),
      honest: await businessEntry(d, chain, 'Drum TEST-L26-0101 moved DISP-1/BLEND-1', { drum: { route: { rooms: 'DISP-1/BLEND-1' } } }),
    };
    const AUDIT = String.raw`, a word of the form of a batch or lot number that is not a test one\. .*\[EBMR-EXE-147\]$`;
    expect(outcomes.message).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.message` + AUDIT));
    expect(outcomes.details).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.details\.drum\.of\.batch` + AUDIT));
    expect(outcomes.site).toMatch(new RegExp(String.raw`at \$\.body\.details\.drum\.of\.batch` + AUDIT));
    expect(outcomes.honest).toBe('ok');
    for (const m of [outcomes.message, outcomes.details, outcomes.site]) expect(m).not.toMatch(/2409\/0017/);
    for (const word of ['BATCH/2409/0017', 'SITE-1/2409/0017']) expect(await recordHolding(d.runId, word), word).toEqual(NOTHING);
    expect(await recordHolding(d.runId, 'DISP-1/BLEND-1')).toMatchObject({ audit: 1 });
  }, 300_000);
});
