/**
 * Phase 3 slice 4a (builder B): G-21 on the server, held by the database (recipe-core 0580 to 0582, tablets 0950 to
 * 0952), proven as the application role past the server: an honest entry the engine builds is stored; the same act through
 * a tampered block handler (a forged engine) or with facts the register does not hold is refused by the database alone.
 * The gateway speaks the integration-sdk printer wire over the listener; the L3 system is a fake of the serialisation
 * contract (the stub itself is apps/simulators').
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { PRINT_EVENTS_PATH, PRINT_JOBS_PATH, printJobAckPath } from '@ebmr/integration-sdk/printer';
import type { PoolReport, PoolRequest } from '@ebmr/integration-sdk/serialisation';
import { actorOfBrowser } from '../../esig/support.ts';
import { codeOf } from '../../execution/db-guards-support.ts';
import { importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { adminActor, enrol, fakeGateway, type FakeGateway } from '../../devices/support.ts';
import { fetchSerialReport, requestSerialPool, sendSerialEvents, type L3Client, type SerialChange } from '../../../src/features/execution/serialisation.ts';
import { fakeTimers, lastEntry, laxEntry, recorder, stateOf, type Entry } from '../granulation/db-support.ts';
import { ARTWORK, ARTWORK_SET, CARTON_MATERIAL, GTIN, LINE_UNIT, lineUnit, occupyLine, packagingMbr, PRINTER_SERIAL, VISION_SERIAL } from './db-support.ts';

type Json = Record<string, unknown>;
let sbx: ExecServer;
let d: RunDriver;
let gw: FakeGateway;
let rec: ReturnType<typeof recorder>;
let batchNumber: string;
let chainId: string;
const RUN_SESSION = randomUUID();
const seqOf: Record<string, number> = {};

const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const as = async (persona: string): Promise<ActorContext> => {
  advance();
  return actorOfBrowser(sbx, d.browser(persona), persona);
};
async function asP<T = Json>(persona: string, text: string, params: unknown[]): Promise<T> {
  return withCommand(sbx.db.app, await as(persona), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}
async function sql<T>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await sbx.db.admin.query<{ r: T | null }>(text, params)).rows[0]?.r ?? null;
}
/** The database's answer for an entry at p-g21 (or `step`): 'ok', or the EBMR code with the rule it names. */
async function verdict(entry: Entry, opts: Parameters<typeof rec.message>[2] & { step?: string } = {}): Promise<string> {
  const m = await rec.message(opts.step ?? 'p-g21', entry, opts);
  if (m === 'ok') return m;
  const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '?';
  const rule = /\b(G21-[A-Z-]+[A-Z])\b/.exec(m)?.[1];
  return rule ? `${code} ${rule}` : `${code} ${m.slice(0, 300)}`;
}
const dataOf = async (kind: string, key = 'p-g21@'): Promise<Json> => (await stateOf(sbx, d.runId)).entries[await lastEntry(sbx, d.runId, key, kind)]?.['data'] as Json;
const me = (): string => personaIn(sbx, 'operator1').personId;
const content = (): Promise<Json | null> => sql<Json>('select recipe.batch_mbr_content($1) as r', [d.runId]);

const lot = (id: string, over: Json = {}): Json => ({ id, material: CARTON_MATERIAL, status: 'RELEASED', artwork: ARTWORK, ...over });
const issue = (l: Json, quantity = '1020'): Entry => ({ kind: 'ISSUE', item: 'CARTON', lot: l, scannedArtwork: l['artwork'], quantity: { value: quantity, unit: '1' } });

async function event(serial: string, kind: string, value: string, jobId: string | null): Promise<{ status: number; body: Json }> {
  seqOf[serial] = (seqOf[serial] ?? 0) + 1;
  const r = await gw.post(PRINT_EVENTS_PATH, { sessionId: RUN_SESSION, events: [{ deviceSerial: serial, jobId, kind, value, sourceTime: '1790584618000000', sequence: String(seqOf[serial]) }] });
  return r as { status: number; body: Json };
}
async function jobs(): Promise<Json[]> {
  const res = await fetch(`${gw.base}${PRINT_JOBS_PATH}`, { headers: { authorization: `Bearer ${gw.token}` } });
  return ((await res.json()) as { jobs: Json[] }).jobs;
}

/** A fake L3 system of the serialisation contract: pools of `issued` serials and the report it is told to give. */
function fakeL3(): L3Client & { requests: PoolRequest[]; next: PoolReport | null } {
  const self = {
    requests: [] as PoolRequest[],
    next: null as PoolReport | null,
    requestPool: (r: PoolRequest) => {
      self.requests.push(r);
      return Promise.resolve({ poolId: `TEST-POOL-${randomUUID().slice(0, 8).toUpperCase()}`, serials: Array.from({ length: Number(r.quantity) }, (_, i) => `S${i + 1}`), issuedAt: '1790584618000000' });
    },
    sendEvents: () => Promise.resolve(),
    report: () => (self.next ? Promise.resolve(self.next) : Promise.reject(new Error('no report'))),
  };
  return self;
}
const l3 = fakeL3();
const report = (poolId: string, c: [string, string, string, string, string], unexplained: string): PoolReport => ({
  poolId, counts: { issued: '10', COMMISSIONED: c[0], DECOMMISSIONED: c[1], DESTROYED: c[2], SAMPLE: c[3], UNUSED_RETURNED: c[4] }, unexplained, reportHash: createHash('sha256').update(`${poolId}:${c.join(',')}:${unexplained}`).digest('hex'),
});

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  chainId = await enrol(sbx);
  const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
  await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
    for (const [code, serial, kind] of [['TEST-PRN-01', PRINTER_SERIAL, 'PRINTER'], ['TEST-PRN-02', 'PRN-T2', 'PRINTER']] as const) {
      await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', [code, 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`${code}:${randomUUID()}`).digest('hex'), `${kind} (simulated)`]);
      await c.query('select tab.bind_print_device($1, $2, $3, $4)', [chainId, code, serial, kind]);
    }
  });
  gw = await fakeGateway(sbx);
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, packagingMbr()), undefined, {}, ['IN', 'US']);
  d = new RunDriver(sbx, runId, {
    issuer,
    steward: await sbx.asPersona('steward'),
    operator1: await sbx.asPersona('operator1'),
    operator2: await sbx.asPersona('operator2', 'TEST-KIOSK-DISP-1'),
    verifier1: await sbx.asPersona('verifier1'),
  });
  d.beforeTap = advance;
  rec = recorder(sbx, d, advance);
  batchNumber = (await sql<string>('select batch_number as r from recipe.batch_execution where id = $1', [runId])) ?? '';
  await lineUnit(sbx, runId);
  // Printed packaging lots: one with the master's artwork, one with an obsolete one, one in quarantine, one without.
  await withCommand(sbx.db.app, await as('steward'), async (c) => {
    for (const [code, status] of [['TEST-CTN-1', 'RELEASED'], ['TEST-CTN-2', 'RELEASED'], ['TEST-CTN-Q', 'QUARANTINE'], ['TEST-CTN-N', 'RELEASED']] as const) {
      await c.query('select tab.register_sandbox_lot($1::jsonb)', [JSON.stringify({ lotCode: code, materialCode: CARTON_MATERIAL, materialName: 'Printed carton', status, identityTested: true })]);
    }
    await c.query('select tab.record_lot_artwork($1, null, $2)', ['TEST-CTN-1', ARTWORK]);
    await c.query('select tab.record_lot_artwork($1, null, $2)', ['TEST-CTN-2', 'ART-6']);
    await c.query('select tab.record_lot_artwork($1, null, $2)', ['TEST-CTN-Q', ARTWORK]);
  });
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-destroy@' });
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('G-21 in the database (recipe-core 0580 to 0582, tablets 0950 to 0952)', () => {
  it('[PR-32][PR-33] printed material is issued only from a printed lot of the register with its recorded artwork, released and of the master\'s artwork version for the market; the artwork of a lot is recorded once by its holder of the right; a forged engine is refused', async () => {
    expect(await codeOf(asP('steward', 'select tab.record_lot_artwork($1, null, $2) as r', ['TEST-CTN-1', 'ART-8']))).toBe('EBMR-EXE-295');
    expect(await codeOf(asP('operator1', 'select tab.record_lot_artwork($1, null, $2) as r', ['TEST-CTN-N', ARTWORK]))).toMatch(/^EBMR-IAM|permission/i);
    expect({
      noArtwork: await verdict(issue(lot('TEST-CTN-N'))),
      forgedStatus: await verdict(issue(lot('TEST-CTN-Q'))),
      quarantine: await verdict(issue(lot('TEST-CTN-Q', { status: 'QUARANTINE' })), { tamper: laxEntry('p-g21', {}) }),
      obsolete: await verdict(issue(lot('TEST-CTN-2', { artwork: 'ART-6' })), { tamper: laxEntry('p-g21', { item: 'CARTON', lot: lot('TEST-CTN-2', { artwork: 'ART-6' }), artwork: 'ART-6', quantity: { value: '1020', unit: '1' }, counting: 'ROLL_COUNTER', issuedBy: 'x' }) }),
      wrongScan: await verdict({ ...issue(lot('TEST-CTN-1')), scannedArtwork: 'ART-6' }, { tamper: laxEntry('p-g21', {}) }),
      overRule: await verdict(issue(lot('TEST-CTN-1'), '1021'), { tamper: laxEntry('p-g21', {}) }),
    }).toEqual({
      noArtwork: (expect.stringMatching(/^EBMR-EXE-295 /) as string),
      forgedStatus: (expect.stringMatching(/^EBMR-EXE-295 /) as string),
      quarantine: (expect.stringMatching(/G21-LOT-STATUS$/) as string),
      obsolete: (expect.stringMatching(/G21-ARTWORK$/) as string),
      wrongScan: (expect.stringMatching(/G21-SCAN$/) as string),
      overRule: (expect.stringMatching(/G21-OVER-ISSUE$/) as string),
    });
    expect(await verdict(issue(lot('TEST-CTN-1')))).toBe('ok');
    expect(await dataOf('ISSUE')).toMatchObject({ item: 'CARTON', artwork: ARTWORK, counting: 'ROLL_COUNTER' });
    await expect(sbx.db.app.query("insert into tab.printed_lot_artwork (sandbox_lot_code, artwork_version, recorded_by_person, recorded_by_account, correlation_id) values ('TEST-CTN-N', 'X', $1, $1, $1)", [randomUUID()])).rejects.toThrow(/permission denied/);
  });

  it('[PR-36][IN-31][PR-35][IN-16][PR-42] a print job carries only the record\'s data, bound to the packaging order and artwork set the line runs; the gateway\'s echo must equal it or the load is refused; the first print is approved by another person than the one who released the job; a batch-data change voids the job and holds the output since the last good check (L-29)', async () => {
    expect(await codeOf(asP('operator1', 'select tab.record_packaging_batch_data($1, $2, $3) as r', [d.runId, 'p-g21@', '45.50']))).toBe('EBMR-EXE-296'); // no MRP on a US pack
    const data = await asP<Json>('operator1', 'select tab.record_packaging_batch_data($1, $2, null) as r', [d.runId, 'p-g21@']);
    expect(data['fields']).toMatchObject({ batch: batchNumber, mfgDate: (expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string), expiryDate: (expect.stringMatching(/^\d{4}-\d{2}$/) as string) });
    // A job needs the line running this order and, for a serialised market, the pool.
    expect(await codeOf(asP('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1']))).toBe('EBMR-EXE-296');
    await occupyLine(sbx, d.runId, batchNumber);
    expect(await codeOf(asP('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1']))).toBe('EBMR-EXE-296');
    const pool = await withCommand(sbx.db.app, await as('operator1'), (c) => requestSerialPool(c, l3, { batchId: d.runId, stepKey: 'p-g21@', market: 'US', quantity: '10' }));
    expect(l3.requests.at(-1)).toEqual({ packagingOrder: batchNumber, market: 'US_DSCSA', gtin: GTIN, quantity: '10' });
    const job = await asP<Json>('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1']);
    expect(job).toMatchObject({ artworkSet: ARTWORK_SET, packagingOrder: batchNumber, fields: { ...(data['fields'] as Json), gtin: GTIN, serialPoolId: pool.poolId } });
    expect((await jobs()).map((j) => j['id'])).toEqual([job['id']]);
    // An echo with another expiry: the load is refused, the job is not offered again.
    const echo = { ...(job['fields'] as Json), expiryDate: '2099-01' };
    const bad = await gw.post(printJobAckPath(String(job['id'])), { sessionId: RUN_SESSION, outcome: 'LOADED', echoedFields: echo, sourceTime: '1790584618000000', message: null });
    expect([bad.status, (bad.body as Json)['state']]).toEqual([200, 'REFUSED']);
    expect(await jobs()).toEqual([]);
    const job2 = await asP<Json>('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1']);
    const ack = { sessionId: RUN_SESSION, outcome: 'LOADED', echoedFields: job2['fields'], sourceTime: '1790584618000001', message: null };
    expect((await gw.post(printJobAckPath(String(job2['id'])), ack)).body).toMatchObject({ state: 'LOADED', duplicate: false });
    expect((await gw.post(printJobAckPath(String(job2['id'])), ack)).body).toMatchObject({ state: 'LOADED', duplicate: true });
    expect((await gw.post(printJobAckPath(String(job2['id'])), { ...ack, sourceTime: '1790584618000002' })).status).toBeGreaterThanOrEqual(400);
    // First print: not by the person who released the job; not on the refused job.
    const fp = (jobId: unknown): Entry => ({ kind: 'FIRST_PRINT', device: 'CODER', job: jobId, approved: true });
    expect(await verdict(fp(job2['id']))).toMatch(/^EBMR-EXE-296 /);
    expect(await verdict(fp(job['id']), { persona: 'operator2' })).toMatch(/^EBMR-EXE-296 .*REFUSED/);
    expect(await verdict(fp(job2['id']), { persona: 'operator2' })).toBe('ok');
    expect(await sql<string>("select result as r from plant.ipc_check where batch_id = $1 and press_code = $2 order by recorded_at desc limit 1", [d.runId, LINE_UNIT])).toBe('PASS');
    // L-29: a change of the batch data after set-up voids the loaded job and holds what the line made since.
    const box = await asP<Json>('operator1', 'select plant.open_container($1, $2, $3, $4) as r', [d.runId, 'PACKAGING', 'kg', LINE_UNIT]);
    expect(await codeOf(asP('operator1', 'select tab.record_packaging_batch_data($1, $2, null) as r', [d.runId, 'p-g21@']))).toBe('EBMR-EXE-296'); // a change needs a reason
    const changed = await asP<Json>('operator1', 'select tab.record_packaging_batch_data($1, $2, null, $3) as r', [d.runId, 'p-g21@', 'Mfg date corrected on the parent record']);
    expect(changed['voided']).toEqual([{ jobId: job2['id'], held: true }]);
    expect(await sql<string>('select plant.container_state($1) as r', [box['container_id']])).toMatch(/^(OPEN|HELD)$/);
    expect(await sql<boolean>('select exists (select 1 from plant.container_hold where container_id = $1) as r', [box['container_id']])).toBe(true);
    expect(await sql<string>('select tab.print_job_state($1) as r', [job2['id']])).toBe('VOIDED');
    // Review 4a MEDIUM 4: a job voided before the printer acknowledged it, then loaded late, holds the line's output too;
    // the answer tells the gateway the job is VOIDED.
    const job3 = await asP<Json>('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1']);
    const box2 = await asP<Json>('operator1', 'select plant.open_container($1, $2, $3, $4) as r', [d.runId, 'PACKAGING', 'kg', LINE_UNIT]);
    expect((await asP<Json>('operator1', 'select tab.record_packaging_batch_data($1, $2, null, $3) as r', [d.runId, 'p-g21@', 'Expiry rule corrected']))['voided']).toEqual([{ jobId: job3['id'], held: false }]);
    expect(await sql<boolean>('select exists (select 1 from plant.container_hold where container_id = $1) as r', [box2['container_id']])).toBe(false);
    const late = await gw.post(printJobAckPath(String(job3['id'])), { sessionId: RUN_SESSION, outcome: 'LOADED', echoedFields: job3['fields'], sourceTime: '1790584618000003', message: null });
    expect((late.body as Json)['state']).toBe('VOIDED');
    expect(await sql<boolean>('select exists (select 1 from plant.container_hold where container_id = $1) as r', [box2['container_id']])).toBe(true);
    // The voided job is not offered again, and the gateway's FAULT JOB_VOIDED (it cleared the printer) is recorded as a
    // fault of that job: never a print and never a challenge.
    expect((await jobs()).map((j) => j['id'])).not.toContain(job3['id']);
    const printedBefore = await sql<string>("select tab.g21_printed($1, 'p-g21')::text as r", [d.runId]);
    expect((await event(PRINTER_SERIAL, 'FAULT', 'JOB_VOIDED', String(job3['id']))).status).toBe(200);
    expect(await sql<Json>("select jsonb_build_object('kind', kind, 'value', value) as r from tab.print_event where job_id = $1 order by seq desc limit 1", [job3['id']])).toEqual({ kind: 'FAULT', value: 'JOB_VOIDED' });
    expect(await sql<string>("select tab.g21_printed($1, 'p-g21')::text as r", [d.runId])).toBe(printedBefore);
    // Review 4a LOW 7: a device's first event is sequence 1; an event names a job of its own device.
    const other = (jobId: string | null, sequence: string) => gw.post(PRINT_EVENTS_PATH, { sessionId: RUN_SESSION, events: [{ deviceSerial: 'PRN-T2', jobId, kind: jobId ? 'PRINTED_COUNT' : 'FAULT', value: jobId ? '0' : 'OFFLINE', sourceTime: '1790584618000000', sequence }] });
    expect((await other(null, '5')).status).toBeGreaterThanOrEqual(400);
    expect((await other(String(job3['id']), '1')).status).toBeGreaterThanOrEqual(400);
    expect((await other(null, '1')).status).toBe(200);
    await expect(sbx.db.app.query('insert into tab.print_job_void (job_id, data_version, held, voided_by) values ($1, 9, false, $2)', [job['id'], randomUUID()])).rejects.toThrow(/permission denied/);
  });

  it('[IN-22][PR-37][DI-31] a gateway device\'s challenge stands on its result from the gateway, once and as received; a failed challenge is stored only with the exception that stops the step, and holds the output since the last good check', async () => {
    const job = await asP<Json>('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1']);
    const fail = await event(VISION_SERIAL, 'CHALLENGE_RESULT', 'FAIL', String(job['id']));
    expect(fail.status).toBe(200);
    const failId = String(((fail.body['events'] as Json[])[0] as Json)['eventId']);
    expect((await event('NOPE-1', 'CHALLENGE_RESULT', 'PASS', String(job['id']))).status).toBeGreaterThanOrEqual(400);
    const ch = (result: string, ev: string, at = '1790584618000000'): Entry => ({ kind: 'CHALLENGE', device: 'CAM', trigger: 'START', result, event: ev, at });
    expect(await verdict(ch('PASS', failId))).toMatch(/^EBMR-EXE-296 /);
    const box = await asP<Json>('operator1', 'select plant.open_container($1, $2, $3, $4) as r', [d.runId, 'PACKAGING', 'kg', LINE_UNIT]);
    // A forged engine that drops the exception is refused.
    expect(await verdict(ch('FAIL', failId), { tamper: laxEntry('p-g21', { device: 'CAM', trigger: 'START', result: 'FAIL', event: failId, at: '1790584618000000', missed: false, challengedBy: me() }) })).toMatch(/^EBMR-EXE-291 /);
    // Review 4a HIGH 1: the result is timed by the device, and a later PASS is not recorded over the earlier FAIL.
    const pass = await event(VISION_SERIAL, 'CHALLENGE_RESULT', 'PASS', String(job['id']));
    const passId = String(((pass.body['events'] as Json[])[0] as Json)['eventId']);
    expect(await verdict(ch('PASS', passId))).toMatch(/^EBMR-EXE-296 .*device's order/);
    expect(await verdict(ch('FAIL', failId, '1790584618000001'))).toMatch(/^EBMR-EXE-296 .*states the time/);
    expect(await verdict(ch('FAIL', failId))).toBe('ok');
    const s = await stateOf(sbx, d.runId);
    expect(Object.values(s.exceptions).map((x) => x['type'])).toContain('CHALLENGE_FAILED');
    expect(await sql<boolean>('select exists (select 1 from plant.container_hold where container_id = $1) as r', [box['container_id']])).toBe(true);
    expect(await verdict(ch('FAIL', failId))).toMatch(/^EBMR-EXE-296 .*recorded already/);
  });

  it('[PR-42][INV-32][IN-17][PR-39][PR-40][IN-22] serial pools and reports are the L3 system\'s as recorded; the release gate and the step close fail closed until the pool closes with zero unexplained; the reconciliation always runs, outside its limits only with its exception; coded surplus is destroyed, never returned', async () => {
    const pool = (await sql<string>('select pool_id as r from tab.serial_pool where batch_id = $1', [d.runId])) ?? '';
    expect(await verdict({ kind: 'SERIAL_POOL', poolId: pool, market: 'US', gtin: GTIN, quantity: '11' }, { tamper: laxEntry('p-g21', { poolId: pool, market: 'US', gtin: GTIN, quantity: '11', recordedBy: 'x' }) })).toMatch(/^EBMR-EXE-297 /);
    expect(await verdict({ kind: 'SERIAL_POOL', poolId: pool, market: 'US', gtin: GTIN, quantity: '10' })).toBe('ok');
    const change = (n: number, from: SerialChange['from'], state: SerialChange['state']): SerialChange[] => Array.from({ length: n }, (_, i) => ({ serial: `S${i}`, from, state, at: '1790584618000000' }));
    const send = async (events: SerialChange[]): Promise<void> => withCommand(sbx.db.app, await as('operator1'), (c) => sendSerialEvents(c, l3, pool, events));
    await send([...change(9, null, 'COMMISSIONED')]);
    await send(change(1, 'COMMISSIONED', 'SAMPLE'));
    expect(await codeOf(send(change(2, 'DECOMMISSIONED', 'DESTROYED')))).toBe('EBMR-EXE-297');
    // Review 4a MEDIUM 3: a report other than the server's events leave is refused.
    l3.next = report(pool, ['9', '0', '0', '1', '0'], '0');
    expect(await codeOf(withCommand(sbx.db.app, await as('operator1'), (c) => fetchSerialReport(c, l3, pool)))).toBe('EBMR-EXE-297');
    l3.next = report(pool, ['8', '0', '0', '1', '0'], '1');
    const open = await withCommand(sbx.db.app, await as('operator1'), (c) => fetchSerialReport(c, l3, pool));
    expect(await verdict(open as Entry)).toBe('ok');
    expect(await sql<string>('select tab.serialisation_release_problem($1) as r', [d.runId])).toMatch(/zero unexplained/);
    const c = await content();
    const st = await stateOf(sbx, d.runId);
    const closing = structuredClone(st);
    (closing.steps['p-g21@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql<string>('select recipe.g21_close_problem($1, $2, $3) as r', [c, st, closing])).toMatch(/G21-NOT-RECONCILED/);
    // The reconciliation: computed, judged, with its exception (a forged engine without it is refused).
    const recon: Entry = { kind: 'RECONCILIATION', item: 'CARTON', used: '990', setupWaste: '6', damaged: '2', codedDestroyed: '5', uncodedReturned: '0', specimens: '5' };
        const honest = { item: 'CARTON', used: '990', setupWaste: '6', damaged: '2', codedDestroyed: '5', uncodedReturned: '0', specimens: '5', unit: '1', issued: '1020', unexplained: '12', withinLimits: false, counted: 'DEVICE', reconciledBy: me() };
    // Review 4a MEDIUM 5: the coded counts are the printer's: 1001 printed is required before the honest entry stands.
    expect(await verdict(recon)).toMatch(/^EBMR-EXE-296 .*printers printed 0/);
    const lastJob = (await sql<string>("select id as r from tab.print_job where batch_id = $1 and tab.print_job_state(id) = 'RELEASED' order by released_at desc limit 1", [d.runId])) ?? '';
    expect((await event(PRINTER_SERIAL, 'PRINTED_COUNT', '1001', lastJob)).status).toBe(200);
    expect(await verdict(recon, { tamper: laxEntry('p-g21', { ...honest, unexplained: '0', withinLimits: true }) })).toMatch(/^EBMR-[A-Z]+-\d{3} .*unexplained/s);
    expect(await verdict(recon, { tamper: laxEntry('p-g21', honest) })).toMatch(/^EBMR-EXE-291 /);
    expect(await verdict(recon)).toBe('ok');
    expect(await dataOf('RECONCILIATION')).toMatchObject({ issued: '1020', unexplained: '12', withinLimits: false, counted: 'DEVICE' });
    // Serials close: the gate then passes once the record holds the closed reconciliation of that report.
    await send(change(1, null, 'DESTROYED'));
    l3.next = report(pool, ['8', '0', '1', '1', '0'], '0');
    const closed = await withCommand(sbx.db.app, await as('operator1'), (c2) => fetchSerialReport(c2, l3, pool));
    expect(await sql<string>('select tab.serialisation_release_problem($1) as r', [d.runId])).toMatch(/holds no closed reconciliation/);
    expect(await verdict(closed as Entry)).toBe('ok');
    expect(await sql<string>('select tab.serialisation_release_problem($1) as r', [d.runId])).toBeNull();
    // An event after the report makes it stale: the gate fails closed until a newer report is fetched.
    await send(change(1, 'COMMISSIONED', 'DECOMMISSIONED'));
    expect(await sql<string>('select tab.serialisation_release_problem($1) as r', [d.runId])).toMatch(/zero unexplained/);
    // Coded surplus: a return to stores of the coded carton beyond the uncoded returned is refused; the destruction
    // step closes only on the coded quantity destroyed; neither step is ever skipped.
    const ret: Entry = { kind: 'DISPOSAL', category: 'RETURN_TO_STORES', material: CARTON_MATERIAL, batchCoded: false, quantity: { value: '5', unit: '1' } };
    expect(await verdict(ret, { step: 'p-destroy' })).toMatch(/^EBMR-EXE-294 /);
    const st2 = await stateOf(sbx, d.runId);
    const closeDestroy = structuredClone(st2);
    (closeDestroy.steps['p-destroy@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    (closeDestroy.steps['p-g21@'] as Json)['status'] = 'COMPLETED';
    expect(await sql<string>('select recipe.g21_close_problem($1, $2, $3) as r', [c, st2, closeDestroy])).toMatch(/G21-NOT-DESTROYED/);
    const skip = structuredClone(st2);
    (skip.steps['p-g21@'] as Json)['status'] = 'SKIPPED';
    expect(await sql<string>('select recipe.g21_skip_problem($1, $2, $3) as r', [c, st2, skip])).toMatch(/skips step p-g21@/);
    await expect(sbx.db.app.query("insert into tab.serial_report (pool_id, counts, unexplained, report_hash, fetched_by) values ($1, '{}', 0, $2, $3)", [pool, 'a'.repeat(64), randomUUID()])).rejects.toThrow(/permission denied/);
  });
});

describe('one expiry rule for the printed data (tablets 1201; PR-43, D-6-3)', () => {
  it('[PR-43] the G-21 batch data shows the manufacture date and the expiry month and year of recipe.batch_expiry; batch data with another expiry is refused for every writer; a step naming another shelf life than the product master in effect at issue is refused', async () => {
    const be = await sql<{ manufactureDate: string; expiryDate: string; shelfLifeMonths: number }>('select recipe.batch_expiry($1) as r', [d.runId]);
    expect(be?.shelfLifeMonths).toBe(24);
    expect(be?.expiryDate).toBe(await sql<string>('select recipe.expiry_month_end($1::date, 24)::text as r', [be?.manufactureDate]));
    const fields = await sql<Json>("select fields as r from tab.packaging_batch_data where batch_id = $1 and step_key = 'p-g21@' order by version desc limit 1", [d.runId]);
    expect(fields).toMatchObject({ mfgDate: be?.manufactureDate, expiryDate: be?.expiryDate.slice(0, 7) });
    // A writer around the function (the owner, in a command) with another expiry month: refused by the table's check.
    const typed = withCommand(sbx.db.admin, await as('operator1'), (c) =>
      c.query(`insert into tab.packaging_batch_data (batch_id, step_key, version, fields, reason, recorded_by_person, recorded_by_account, correlation_id)
               select batch_id, step_key, version + 1, jsonb_set(fields, '{expiryDate}', '"2099-12"'), 'typed expiry', recorded_by_person, recorded_by_account, gen_random_uuid()
                 from tab.packaging_batch_data where batch_id = $1 and step_key = 'p-g21@' order by version desc limit 1`, [d.runId]));
    await expect(typed).rejects.toThrow(/computed by the database, never typed \(PR-43\)/);
    // The product master in effect when the batch was made gives 36 months (arranged before the issue): the step's 24 is refused.
    const p = (await sbx.db.admin.query<{ code: string; strength: string }>("select recipe.batch_product($1) ->> 'code' as code, recipe.batch_product($1) ->> 'strength' as strength", [d.runId])).rows[0];
    const id = randomUUID();
    const conn = await sbx.db.admin.connect();
    try {
      await conn.query('begin');
      await conn.query("set local session_replication_role = 'replica'");
      await conn.query(`insert into site.erp_product (id, product_code, strength, product_name, reprocessing_permitted, beta_lactam, shelf_life_months, erp_reference, received_by_person, received_by_account, received_at, correlation_id)
                        values ($1, $2, $3, $2, false, false, 36, 'ERP-TEST-36', $1, $1, '2001-01-01', $1)`, [id, p?.code, p?.strength]);
      await conn.query("insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id, effective_at) values ('PRODUCT', site.erp_product_key($2, $3), $1, 'RELEASE_BASELINE', $1, $1, '2001-01-01')", [id, p?.code, p?.strength]);
      await conn.query('commit');
    } finally {
      conn.release();
    }
    expect(await sql<Json>('select recipe.batch_expiry($1) as r', [d.runId])).toMatchObject({ shelfLifeMonths: 36 });
    await expect(asP('operator1', 'select tab.record_packaging_batch_data($1, $2, null, $3) as r', [d.runId, 'p-g21@', 'Shelf life checked'])).rejects.toThrow(/names a shelf life of 24 months; the product master in effect when the batch was made gives 36/);
  });
});
