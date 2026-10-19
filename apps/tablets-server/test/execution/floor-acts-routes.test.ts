/**
 * Floor acts beside the engine's entries over HTTP (Phase 7 slice 7g, WP4; contract ns/execution.ts; decision 0025):
 *  - the batch data of a G-21 packaging step, the second person's check of an MRP and the print job (tablets 0951,
 *    1201; IN-31, PR-36): the giver of an MRP, though holding the rights to check and release, neither checks nor
 *    releases; a change after set-up carries the person's reason and voids the jobs released on the earlier data;
 *  - a metal-detector challenge of a press in use by the batch with certified test pieces of the register (tablets 0872;
 *    IN-36): a failure holds the press output.
 * Every rule and right is the database's; the person's calls carry a fresh badge tap on the kiosk.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { routes, type AnyRoute, type Result, type RouteResponse } from '@ebmr/api-contract';
import { openPersonaSession } from '@ebmr/test-kit';
import { actorOfBrowser, personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { asPersonaInRole, importAndIssue, RunDriver, startExecServer, writePackage, type ExecServer } from './support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { adminActor, enrol } from '../devices/support.ts';
import { GTIN, LINE_UNIT, lineUnit, minimalMbr, occupyLine, packPhase } from '../blocks/packaging/db-support.ts';
import { pressInUse } from '../blocks/compression/plant-support.ts';

const E = routes.execution;
const SERIAL = 'PRN-T77';
let sbx: ExecServer;
const browsers: Record<string, TestBrowser> = {};

/** The database's refusal as the server answers it: its code, then why. */
const refused = (r: Result<unknown>): string => `${refusalOf(r)?.code ?? ''} ${refusalOf(r)?.why ?? ''}`;

/** A POST of `key` on its kiosk browser `b`, with the fresh badge tap the route asks for. */
async function post<R extends AnyRoute>(b: TestBrowser, key: string, route: R, body: Record<string, unknown>): Promise<Result<RouteResponse<R>>> {
  vi.advanceTimersByTime(7_000);
  const attribution = await tapFor(b, personaIn(sbx, key), 'POST', route.path, body);
  return (await b.call(route as never, { body, attribution } as never));
}

async function issue(phases: Record<string, unknown>[]): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, minimalMbr(phases)), undefined, {}, ['IN', 'US']);
  const d = new RunDriver(sbx, runId, { issuer, operator1: browsers['operator1'] as TestBrowser });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
  const chain = await enrol(sbx);
  const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
  await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
    await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', ['TEST-PRN-77', 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`PRN77:${randomUUID()}`).digest('hex'), 'Line printer (simulated)']);
    await c.query('select tab.bind_print_device($1, $2, $3, $4)', [chain, 'TEST-PRN-77', SERIAL, 'PRINTER']);
  });
  for (const key of ['operator1', 'operator2', 'verifier1']) browsers[key] = await sbx.asPersona(key, 'TEST-KIOSK-DISP-1');
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

describe('the batch data of a packaging step and its print job (IN-31, PR-36)', () => {
  it('[IN-31][PR-36][DI-22] the giver of an MRP neither checks nor releases; a second person checks it; the job then carries the record\'s data; a change after set-up needs the person\'s reason and voids the job', async () => {
    const d = await issue([packPhase('p-g21', 'G-21', { devices: [{ id: 'CODER', kind: 'PRINTER', serial: SERIAL }], unit: LINE_UNIT, shelfLifeMonths: 24, markets: { IN: { gtin: GTIN, mrp: true } } })]);
    await lineUnit(sbx, d.runId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    await occupyLine(sbx, d.runId, (await sbx.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [d.runId])).rows[0]?.n ?? '');
    const step = { batchId: d.runId, stepKey: 'p-g21@' };
    expect(valueOf(await (browsers['operator1'] as TestBrowser).call(E.packagingBatchData, { query: step }))).toEqual({ ...step, current: null, jobs: [] });
    // The giver holds STEP.EXECUTE and STEP.VERIFY (operator and verifier), so each refusal below is the person rule.
    const giver = await asPersonaInRole(sbx, 'operatorVerifier1', 'OPERATOR', 'TEST-KIOSK-DISP-1');
    expect(refused(await post(giver, 'operatorVerifier1', E.recordPackagingBatchData, step))).toMatch(/An MRP is given exactly for a pack that shows it/);
    const v1 = valueOf(await post(giver, 'operatorVerifier1', E.recordPackagingBatchData, { ...step, mrp: '45.50' }));
    expect(v1.current).toMatchObject({ version: 1, fields: { mrp: '45.50' }, reason: null, checkedBy: null, recordedBy: { personId: personaIn(sbx, 'operatorVerifier1').personId } });
    const release = { ...step, device: 'CODER', layout: 'LAYOUT-IN-1' };
    expect(refused(await post(browsers['operator2'] as TestBrowser, 'operator2', E.releasePrintJob, release))).toMatch(/The MRP of batch data version 1 is not checked by a second person yet \(IN-31\)/);
    const giverAsVerifier = await asPersonaInRole(sbx, 'operatorVerifier1', 'VERIFIER', 'TEST-KIOSK-DISP-1');
    expect(refused(await post(giverAsVerifier, 'operatorVerifier1', E.checkPackagingBatchData, { ...step, version: 1 }))).toMatch(/The MRP is checked by a second person, not the one who gave it \(IN-31\)/);
    // An operator holds no STEP.VERIFY.
    expect(refusalOf(await post(browsers['operator2'] as TestBrowser, 'operator2', E.checkPackagingBatchData, { ...step, version: 1 }))?.code).toBe('EBMR-IAM-040');
    expect(valueOf(await post(browsers['verifier1'] as TestBrowser, 'verifier1', E.checkPackagingBatchData, { ...step, version: 1 })).current?.checkedBy?.personId).toBe(personaIn(sbx, 'verifier1').personId);
    const giverAgain = await asPersonaInRole(sbx, 'operatorVerifier1', 'OPERATOR', 'TEST-KIOSK-DISP-1');
    expect(refused(await post(giverAgain, 'operatorVerifier1', E.releasePrintJob, release))).toMatch(/The person who gave the MRP does not release the print job that carries it \(IN-31\)/);
    const released = valueOf(await post(browsers['operator2'] as TestBrowser, 'operator2', E.releasePrintJob, release));
    expect(released.jobs).toEqual([expect.objectContaining({ device: 'CODER', layout: 'LAYOUT-IN-1', dataVersion: 1, state: 'RELEASED' })]);
    // A change after set-up: without the person's reason refused; with it a new version, and the job on version 1 is void.
    expect(refused(await post(browsers['operator2'] as TestBrowser, 'operator2', E.recordPackagingBatchData, { ...step, mrp: '46.00' }))).toMatch(/recorded with your own reason/);
    const v2 = valueOf(await post(browsers['operator2'] as TestBrowser, 'operator2', E.recordPackagingBatchData, { ...step, mrp: '46.00', reason: 'MRP revised by the price notification of 18 October' }));
    expect(v2.current).toMatchObject({ version: 2, fields: { mrp: '46.00' }, reason: 'MRP revised by the price notification of 18 October', checkedBy: null });
    expect(v2.jobs[0]?.state).not.toBe('RELEASED');
  }, 240_000);
});

describe('a detector challenge (IN-36)', () => {
  it('[IN-36] a challenge of a press in use with certified test pieces is recorded; a failure holds the press output; an uncertified piece, a press not in use and a person without STEP.EXECUTE are refused', async () => {
    const d = await issue([packPhase('p-g21', 'G-21', { devices: [{ id: 'CODER', kind: 'PRINTER', serial: SERIAL }], unit: LINE_UNIT, shelfLifeMonths: 24, markets: { IN: { gtin: GTIN } } })]);
    const operator = browsers['operator1'] as TestBrowser;
    const actor = async (): Promise<ActorContext> => {
      vi.advanceTimersByTime(7_000);
      return actorOfBrowser(sbx, operator, 'operator1');
    };
    const press = await pressInUse(sbx, actor, d.runId);
    const steward = await openPersonaSession(sbx.db, sbx.seed, 'steward');
    const until = (await sbx.db.admin.query<{ t: string }>("select (clock_timestamp() + interval '365 days')::text as t")).rows[0]?.t ?? '';
    const tp = `TP-FE-${randomUUID().slice(0, 4).toUpperCase()}`;
    await withCommand(sbx.db.app, { ...steward, correlationId: randomUUID() }, (c) =>
      c.query('select tab.define_test_piece($1)', [{ code: tp, kind: 'FERROUS', size: { value: '0.8', unit: 'mm' }, certificateRef: `CERT-${tp}`, certifiedUntil: until }]),
    );
    const body = { batchId: d.runId, press: press.code, device: 'METAL_DETECTOR', deviceCode: 'MD-01', timing: 'START', pieces: [{ piece: tp, detected: true, rejected: true }] };
    expect(refusalOf(await post(browsers['verifier1'] as TestBrowser, 'verifier1', E.recordDetectorChallenge, body))?.code).toBe('EBMR-IAM-040');
    expect(refused(await post(operator, 'operator1', E.recordDetectorChallenge, { ...body, press: 'TEST-PRESS-NONE' }))).toMatch(/EBMR-DET-011/);
    expect(refused(await post(operator, 'operator1', E.recordDetectorChallenge, { ...body, pieces: [{ piece: 'TP-UNKNOWN', detected: true, rejected: true }] }))).toMatch(/EBMR-DET-010/);
    expect(valueOf(await post(operator, 'operator1', E.recordDetectorChallenge, body))).toMatchObject({ passed: true, held: [] });
    const failed = valueOf(await post(operator, 'operator1', E.recordDetectorChallenge, { ...body, timing: 'INTERVAL', pieces: [{ piece: tp, detected: false, rejected: false }] }));
    expect(failed.passed).toBe(false);
    const { rows } = await sbx.db.admin.query<{ passed: boolean; hold: unknown }>('select passed, hold from tab.detector_challenge where id = $1', [failed.challengeId]);
    expect(rows[0]).toMatchObject({ passed: false, hold: expect.any(Object) as unknown });
  }, 240_000);
});
