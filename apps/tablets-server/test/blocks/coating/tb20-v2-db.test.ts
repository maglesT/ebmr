/**
 * TB-20@2 in the database (tablets 1113; D-P4-11): the NO_PLAN outcome is stored only as its block builds it, with its
 * AQL_NO_PLAN exception, for a lot without a plan, and only with a deviation reference: on a GMP batch a deviation-lite
 * record of the batch's site linked to the batch and not cancelled; in a test run a reference. A NO_PLAN lot is no part of
 * the switching history. Entries are written as the application role past the server, honestly or through a tampered
 * definition (the bypass attempts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { actorOfBrowser } from '../../esig/support.ts';
import { verifyTypedNet } from '../../execution/db-guards-support.ts';
import { importAndIssue, personaIn, RunDriver, startExecServer, valueOf, writePackage, type ExecServer } from '../../execution/support.ts';
import { startGmpBatchWorld, type GmpBatchWorld } from '../../support/gmp-world.ts';
import { fakeTimers, lastEntry, laxEntry, recorder, stateOf, type Entry } from '../granulation/db-support.ts';
import { tb20V2DbMbr } from './db-support.ts';



let sbx: ExecServer;
let w: GmpBatchWorld;
let d: RunDriver;
let rec: ReturnType<typeof recorder>;
let me: string;

const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};

beforeAll(async () => {
  [sbx, w] = await Promise.all([startExecServer(), startGmpBatchWorld()]);
  fakeTimers();
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, tb20V2DbMbr()));
  d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
  d.beforeTap = advance;
  rec = recorder(sbx, d, advance);
  me = personaIn(sbx, 'operator1').personId;
}, 600_000);
afterAll(async () => {
  vi.useRealTimers();
  await Promise.all([sbx?.close(), w?.close()]);
});

async function verdict(step: string, entry: Entry, opts: Parameters<typeof rec.message>[2] = {}): Promise<string> {
  const m = await rec.message(step, entry, opts);
  if (m === 'ok') return m;
  const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '?';
  const rule = /(TB20-[A-Z0-9-]+)/.exec(m)?.[1];
  return rule ? `${code} ${rule}` : `${code} ${m.slice(0, 300)}`;
}
const op = async (): Promise<ActorContext> => {
  advance();
  return actorOfBrowser(sbx, d.browser('operator1'), 'operator1');
};
async function rejectsContainer(): Promise<string> {
  const o = await withCommand(sbx.db.app, await op(), async (c) => (await c.query<{ r: { container_id: string; version: number } }>("select plant.open_container($1, 'INSPECTION', 'kg') as r", [d.runId])).rows[0]?.r);
  if (!o) throw new Error('no container');
  await withCommand(sbx.db.app, await op(), (c) => c.query('select plant.close_container($1, $2, $3)', [o.container_id, '0.002', o.version]));
  await verifyTypedNet(sbx, d.browser('verifier1'), o.container_id);
  return o.container_id;
}
/** Starts step `key`, inspects and sorts `inspected` tablets of which `accepted` are accepted (the rest chipped, for destruction). */
async function sorted(step: string, accepted: string, inspected: string): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey: `${step}@` });
  expect(await verdict(step, { kind: 'INSPECTION_START' })).toBe('ok');
  expect(await verdict(step, { kind: 'INSPECTION_END' })).toBe('ok');
  const rejects = (BigInt(inspected) - BigInt(accepted)).toString();
  const sort: Entry = {
    kind: 'SORT_RESULT',
    inspected: { count: inspected, mass: { value: '0.003', unit: 'kg' } },
    accepted: { count: accepted, mass: { value: '0.001', unit: 'kg' } },
    defects: [{ code: 'CHIPPED', count: rejects }],
    rejects: [{ category: 'DESTRUCTION', container: await rejectsContainer(), count: rejects, mass: { value: '0.002', unit: 'kg' } }],
  };
  expect(await verdict(step, sort)).toBe('ok');
}

describe('TB-20@2 NO_PLAN in the database (tablets 1113)', () => {
  it('[PR-29][PR-49][INV-41][DI-10] a lot without a plan is stored NO_PLAN only as its block builds it and only with AQL_NO_PLAN; it is no part of the switching history', async () => {
    await sorted('p-tb20a', '1', '3');
    const noPlan = { kind: 'AQL_RESULT', severity: 'NORMAL', outcome: 'NO_PLAN', deviationRef: 'TEST-DEV-0001' };
    const want = { result: 'NO_PLAN', severity: 'NORMAL', lotSize: '1', deviationRef: 'TEST-DEV-0001', recordedBy: me };
    // Bypass attempts through a tampered definition: no exception, other data, defects counted, a reference without NO_PLAN
    // (an empty reference never reaches the guard: the entry schema refuses empty text, recipe-core 0332).
    expect(await verdict('p-tb20a', noPlan, { tamper: laxEntry('p-tb20a', want) })).toMatch(/^EBMR-EXE-270 .*without the AQL_NO_PLAN exception/s);
    expect(await verdict('p-tb20a', noPlan, { tamper: laxEntry('p-tb20a', { ...want, lotSize: '2' }) })).toMatch(/^EBMR-EXE-270 .*lotSize/s);
    expect(await verdict('p-tb20a', { ...noPlan, found: { MAJOR: '1' } }, { tamper: laxEntry('p-tb20a', want) })).toBe('EBMR-EXE-270 TB20-NO-PLAN-FOUND');
    expect(await verdict('p-tb20a', { kind: 'AQL_RESULT', severity: 'NORMAL', found: {}, deviationRef: 'TEST-DEV-0001' }, { tamper: laxEntry('p-tb20a', want) })).toBe('EBMR-EXE-270 TB20-NO-PLAN-ONLY');
    // Honestly: stored with its exception.
    expect(await verdict('p-tb20a', noPlan)).toBe('ok');
    const s = await stateOf(sbx, d.runId);
    expect(s.entries[await lastEntry(sbx, d.runId, 'p-tb20a@', 'AQL_RESULT')]?.['data']).toEqual(want);
    expect(Object.values(s.exceptions).filter((x) => x['type'] === 'AQL_NO_PLAN').map((x) => [x['severity'], x['qaOnly'], x['releaseBlocking']])).toEqual([['ACTION', true, true]]);
    const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from tab.aql_lot_result where batch_id = $1 and step_key = 'p-tb20a@'", [d.runId]);
    expect(rows[0]?.n).toBe('0');
  }, 300_000);

  it('[PR-29][DI-10] NO_PLAN for a lot the scheme has a plan for is refused by the database, even from a tampered definition', async () => {
    await sorted('p-tb20b', '2', '3');
    const want = { result: 'NO_PLAN', severity: 'NORMAL', lotSize: '2', deviationRef: 'TEST-DEV-0002', recordedBy: me };
    expect(await verdict('p-tb20b', { kind: 'AQL_RESULT', severity: 'NORMAL', outcome: 'NO_PLAN', deviationRef: 'TEST-DEV-0002' }, { tamper: laxEntry('p-tb20b', want) })).toBe('EBMR-EXE-270 TB20-PLAN-EXISTS');
  }, 300_000);

  it('[PR-49][PR-29] on a GMP batch the reference names a deviation-lite record linked to the batch and not cancelled; a test run takes a reference', async () => {
    const issuer = await w.gmp.asPersona('issuer');
    const batchId = await w.issued(issuer);
    const qa = await w.gmp.asPersona('qaInvestigator');
    const raise = async () => valueOf(await qa.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: 'Inspection lot too small for a sampling plan', classification: 'MINOR', riskRationale: 'One tablet accepted after sorting; no plan applies' } }));
    const linked = await raise();
    valueOf(await qa.call(routes.quality.linkDeviation, { params: { deviationId: linked.deviationId }, body: { subjectKind: 'BATCH', subjectId: batchId } }));
    const unlinked = await raise();
    const problem = async (batch: string, ref: string) => (await w.gmp.db.admin.query<{ p: string | null }>('select tab.tb20_no_plan_ref_problem($1, $2) as p', [batch, ref])).rows[0]?.p ?? null;
    expect(await problem(batchId, linked.ref)).toBeNull();
    expect(await problem(batchId, unlinked.ref)).toMatch(/not linked to batch/);
    expect(await problem(batchId, 'DEV-NOWHERE-2026-00001')).toMatch(/not a deviation-lite record/);
    expect(await problem(batchId, '')).toMatch(/names no deviation reference/);
    const qa2 = await w.gmp.asPersona('qaApprover2');
    valueOf(await qa2.call(routes.quality.cancelDeviation, { params: { deviationId: linked.deviationId }, body: { reason: 'Raised against the wrong step' } }));
    expect(await problem(batchId, linked.ref)).toMatch(/cancelled/);
    expect(await (async () => (await sbx.db.admin.query<{ p: string | null }>('select tab.tb20_no_plan_ref_problem($1, $2) as p', [d.runId, 'TEST-DEV-0003'])).rows[0]?.p ?? null)()).toBeNull();
  }, 300_000);
});
