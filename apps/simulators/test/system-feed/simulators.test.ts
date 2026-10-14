/**
 * The QMS, LIMS, LMS and CMMS simulators (Phase 6 slice 6a, builder B): every published message is a valid envelope of
 * its system contract, each fault behaves as the outline names it, and the reconciliation counts what was published.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CMMS, InboundEnvelope, LIMS, LMS, QMS, payloadSchema, reconciliationChecksum, type SystemContract } from '@ebmr/integration-sdk/adapter';
import { cmmsSimulator } from '../../src/cmms/model.ts';
import { limsSimulator } from '../../src/lims/model.ts';
import { lmsSimulator } from '../../src/lms/model.ts';
import { qmsSimulator } from '../../src/qms/model.ts';
import { SystemFeed, type FeedClock } from '../../src/system-feed/feed.ts';
import { startFeedSimulator, type RunningFeedSimulator } from '../../src/system-feed/server.ts';

const fixedClock = (): FeedClock => {
  let t = 1_790_000_000_000_000n;
  return { nowUs: () => (t += 1000n) };
};

function valid(contract: SystemContract, env: unknown): boolean {
  const e = InboundEnvelope.safeParse(env);
  if (!e.success) return false;
  return payloadSchema(contract, e.data)?.safeParse(e.data.payload).success === true;
}

describe('feed faults (DI-31 fault injection)', () => {
  const feed = () => new SystemFeed({ system: 'LMS', clock: fixedClock(), wrongIdentity: (_t, p) => ({ ...p, personNumber: 'NOBODY' }) });
  const q = (n: number) => ({ personNumber: `E${n.toString()}`, qualificationCode: 'SOP-1', status: 'QUALIFIED', validFrom: '0', validTo: null });

  it('publishes valid envelopes with increasing sequence numbers and source times; MALFORMED, WRONG_BATCH and STALE_VALUE change what is published', () => {
    const f = feed();
    const a = f.publish('lms.qualification', 'E1/SOP-1', q(1));
    const b = f.publish('lms.qualification', 'E1/SOP-1', q(1));
    expect([a.sequenceNo, b.sequenceNo]).toEqual(['1', '2']);
    expect(BigInt(b.sourceTimestamp) > BigInt(a.sourceTimestamp)).toBe(true);
    expect(valid(LMS, a)).toBe(true);
    f.faults.add('MALFORMED');
    expect(valid(LMS, f.publish('lms.qualification', 'E2/SOP-1', q(2)))).toBe(false);
    f.faults.delete('MALFORMED');
    f.faults.add('WRONG_BATCH');
    expect(f.publish('lms.qualification', 'E3/SOP-1', q(3)).payload['personNumber']).toBe('NOBODY');
    f.faults.delete('WRONG_BATCH');
    f.faults.add('STALE_VALUE');
    const stale = f.publish('lms.qualification', 'E1/SOP-1', q(1));
    expect(BigInt(stale.sourceTimestamp) < BigInt(b.sourceTimestamp)).toBe(true);
  });

  it('FEED_GAP withholds, OUT_OF_ORDER reverses, DUPLICATE re-delivers; STALE_MIRROR stops the heartbeat while the feed answers', () => {
    const f = feed();
    for (let i = 1; i <= 3; i++) f.publish('lms.qualification', `E${i.toString()}/SOP-1`, q(i));
    f.faults.add('FEED_GAP');
    expect(f.page(0n, 10)).toEqual({ messages: [], head: '3' });
    f.faults.delete('FEED_GAP');
    f.faults.add('OUT_OF_ORDER');
    expect(f.page(0n, 10).messages.map((m) => m.sequenceNo)).toEqual(['3', '2', '1']);
    f.faults.delete('OUT_OF_ORDER');
    f.faults.add('DUPLICATE');
    expect(f.page(2n, 10).messages.map((m) => m.sequenceNo)).toEqual(['2', '3']);
    f.faults.add('STALE_MIRROR');
    expect(f.heartbeatOk()).toBe(false);
    expect(f.page(0n, 10).messages).toHaveLength(3);
  });

  it('the reconciliation counts each key once over the period of source time', () => {
    const f = feed();
    const a = f.publish('lms.qualification', 'E1/SOP-1', q(1));
    const b = f.publish('lms.qualification', 'E2/SOP-1', q(2));
    const r = f.reconciliation(BigInt(a.sourceTimestamp), BigInt(b.sourceTimestamp) + 1n);
    expect(r).toMatchObject({ sourceCount: '2', ...{ sourceChecksum: reconciliationChecksum([a, b]).checksum } });
    expect(f.reconciliation(BigInt(b.sourceTimestamp) + 1n, BigInt(b.sourceTimestamp) + 2n).sourceCount).toBe('0');
  });
});

describe('the simulators over HTTP', () => {
  let qms: RunningFeedSimulator;
  let others: RunningFeedSimulator[];
  const url = (s: RunningFeedSimulator, path: string) => `http://127.0.0.1:${s.port.toString()}${path}`;
  const post = (s: RunningFeedSimulator, path: string, body: unknown) =>
    fetch(url(s, path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const q = qmsSimulator(fixedClock());
    qms = await startFeedSimulator(q.feed, q.plugin, { host: '127.0.0.1', port: 0 });
    others = await Promise.all([limsSimulator(fixedClock()), lmsSimulator(fixedClock()), cmmsSimulator(fixedClock())].map((s) => startFeedSimulator(s.feed, s.plugin, { host: '127.0.0.1', port: 0 })));
  });
  afterAll(async () => {
    await Promise.all([qms, ...others].map((s) => s.close()));
  });

  it('each system route checks the body against its contract and publishes a valid envelope', async () => {
    const [lims, lms, cmms] = others as [RunningFeedSimulator, RunningFeedSimulator, RunningFeedSimulator];
    const cases: [RunningFeedSimulator, SystemContract, string, unknown][] = [
      [qms, QMS, '/qms/v1/deviations', { deviationRef: 'QD-1', status: 'OPEN', lotNumbers: ['L-1'] }],
      [qms, QMS, '/qms/v1/capas', { capaRef: 'QC-1', title: 'Hardness', status: 'OPEN', needsMasterChange: true, effectivenessDueDate: '2027-01-31' }],
      [qms, QMS, '/qms/v1/change-controls', { changeRef: 'CC-1', status: 'APPROVED' }],
      [lims, LIMS, '/lims/v1/results', { sampleId: 'S-1', lotNumber: 'L-1', testCode: 'ASSAY', specificationRef: 'SP-1', result: { value: '99.20', unit: '%' }, conformance: 'CONFORMS', state: 'APPROVED', recordedAt: '1790000000000000' }],
      [lms, LMS, '/lms/v1/qualifications', { personNumber: 'E-1', qualificationCode: 'SOP-1', status: 'QUALIFIED', validFrom: '1790000000000000', validTo: null }],
      [cmms, CMMS, '/cmms/v1/calibrations', { equipmentCode: 'EQ-1', calibrationRef: 'CAL-1', performedAt: '1790000000000000', result: 'PASS', dueOn: '2027-01-31' }],
      [cmms, CMMS, '/cmms/v1/work-orders', { equipmentCode: 'EQ-1', workOrder: 'WO-1', kind: 'PREVENTIVE', status: 'OPEN', dueOn: '2027-01-31' }],
    ];
    for (const [sim, , path, body] of cases) {
      expect((await post(sim, path, body)).status, path).toBe(201);
      expect((await post(sim, path, { ...(body as object), extra: 1 })).status, path).toBe(400);
    }
    for (const [sim, contract, prefix] of [[qms, QMS, 'qms'], [lims, LIMS, 'lims'], [lms, LMS, 'lms'], [cmms, CMMS, 'cmms']] as const) {
      const page = (await (await fetch(url(sim, `/${prefix}/v1/feed?after=0&limit=50`))).json()) as { messages: unknown[]; head: string };
      expect(page.messages.length).toBe(Number(page.head));
      for (const m of page.messages) expect(valid(contract, m), prefix).toBe(true);
    }
  });

  it('the QMS answers the live release fetch with version tokens; SLOW answers late, LINK_CUT cuts the answer, STALE_MIRROR stops the heartbeat', async () => {
    await post(qms, '/qms/v1/deviations', { deviationRef: 'QD-2', status: 'CLOSED', lotNumbers: ['L-9'] });
    const live = (await (await fetch(url(qms, '/qms/v1/lots/L-9/deviations'))).json()) as { deviations: { versionToken: string }[] };
    expect(live).toMatchObject({ lotNumber: 'L-9', deviations: [{ deviationRef: 'QD-2', status: 'CLOSED' }] });
    await post(qms, '/qms/v1/deviations', { deviationRef: 'QD-2', status: 'OPEN', lotNumbers: ['L-9'] });
    const again = (await (await fetch(url(qms, '/qms/v1/lots/L-9/deviations'))).json()) as { deviations: { versionToken: string }[] };
    expect(again.deviations[0]?.versionToken).not.toBe(live.deviations[0]?.versionToken);
    await post(qms, '/api/fault', { fault: 'SLOW', on: true, slowMs: 400 });
    await expect(fetch(url(qms, '/qms/v1/lots/L-9/deviations'), { signal: AbortSignal.timeout(100) })).rejects.toThrow();
    await post(qms, '/api/fault', { fault: 'SLOW', on: false });
    await post(qms, '/api/fault', { fault: 'LINK_CUT', on: true });
    await expect(fetch(url(qms, '/qms/v1/feed?after=0&limit=10')).then((r) => r.json())).rejects.toThrow();
    await post(qms, '/api/fault', { fault: 'LINK_CUT', on: false });
    expect((await fetch(url(qms, '/qms/v1/heartbeat'))).status).toBe(200);
    await post(qms, '/api/fault', { fault: 'STALE_MIRROR', on: true });
    expect((await fetch(url(qms, '/qms/v1/heartbeat'))).status).toBe(503);
    expect((await fetch(url(qms, '/qms/v1/feed?after=0&limit=10'))).status).toBe(200);
    await post(qms, '/api/fault', { fault: 'STALE_MIRROR', on: false });
    expect((await post(qms, '/api/fault', { fault: 'NONSENSE', on: true })).status).toBe(400);
    expect(await (await fetch(url(qms, '/'))).text()).toMatch(/SIMULATOR \(DEMO-ONLY\)/);
  });
});
