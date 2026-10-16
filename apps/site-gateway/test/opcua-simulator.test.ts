/**
 * The OPC UA client driver on node-opcua against the OPC UA equipment simulator (slice 6b, builder A; DI-20, DI-31,
 * DI-32): SignAndEncrypt sessions reported with the certificate presented, native series of every unit, each fault of
 * the simulator alarmed, and a soak with the faults switched in turn proving that nothing is lost silently at the
 * gateway (every chunk numbered without a hole and valid; each interruption of a series alarmed; the feed reconciles
 * with itself).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpcuaEndpointSessionV1, SeriesChunkV1, shownValueProblem } from '@ebmr/integration-sdk/adapter';
import { liveDriver, SIM_UNITS, startOpcuaSimulator, type LiveRig, type OpcuaSimProcess } from './opcua-support.ts';
import { until } from './support.ts';

let sim: OpcuaSimProcess;
beforeAll(async () => {
  sim = await startOpcuaSimulator();
}, 90_000);
afterAll(async () => {
  await sim?.stop();
});

const chunksOf = (r: LiveRig) => r.feed.published().filter((m) => m.messageType === 'opcua.series_chunk').map((m) => SeriesChunkV1.parse(m.payload));

describe('the OPC UA driver against the simulator', () => {
  it('[DI-20][DI-32] a SignAndEncrypt session with the enrolled certificate, reported first; native series of every unit; the process view shows each raw value exactly', async () => {
    const r = liveDriver(sim);
    try {
      await until(() => r.driver.state === 'ONLINE', 30_000, 'online');
      const first = r.feed.published()[0];
      expect(OpcuaEndpointSessionV1.parse(first?.payload)).toMatchObject({ certificateThumbprint: sim.thumbprint, reportedLocation: 'RM-COMP-1', securityMode: 'SignAndEncrypt' });
      await until(() => new Set(chunksOf(r).map((c) => c.subjectCode)).size === Object.keys(SIM_UNITS).length, 20_000, 'a chunk of every unit');
      for (const unit of Object.keys(SIM_UNITS)) {
        const v = await r.driver.unit(unit).read();
        if (!v.ok) throw new Error(`${unit} not readable`);
        expect(v.sample.values.length, unit).toBeGreaterThan(0);
        for (const x of v.sample.values) {
          const n = v.native.values[x.tag];
          expect(n, `${unit}/${x.tag}`).toBeDefined();
          expect(shownValueProblem(n?.raw ?? '', x.value), `${unit}/${x.tag}`).toBeNull();
        }
      }
      // A setpoint download is written and read back from the device.
      expect(await r.driver.unit('PRESS-01').write('force.main_kN', '13.50')).toEqual({ ok: true });
      const after = await r.driver.unit('PRESS-01').read();
      if (!after.ok) throw new Error('not readable');
      expect(after.sample.setpoints.find((s) => s.tag === 'force.main_kN')?.value).toBe('13.5');
    } finally {
      await r.stop();
    }
  }, 90_000);

  it('[DI-31] OPC UA feed gap, stale value and recipe mismatch each alarm; a cut link, an older sample, a unit not served and a reject burst too', async () => {
    const r = liveDriver(sim, { gapAfterMs: 1500 });
    const kinds = () => new Set(r.alarms.map((a) => a.kind));
    try {
      await until(() => r.driver.state === 'ONLINE', 30_000, 'online');
      await sim.fault('FEED_GAP', true);
      await until(() => kinds().has('FEED_GAP'), 10_000, 'feed gap alarm');
      await sim.fault('FEED_GAP', false);
      await sim.fault('STALE_VALUE', true);
      await until(() => kinds().has('STALE_VALUE'), 10_000, 'stale alarm');
      await sim.fault('STALE_VALUE', false);
      const v = await r.driver.unit('PRESS-01').read();
      if (!v.ok) throw new Error('not readable');
      r.driver.expectRecipe('PRESS-01', 'RCP-1');
      await sim.fault('RECIPE_MISMATCH', true);
      await until(() => kinds().has('RECIPE_MISMATCH'), 10_000, 'recipe mismatch alarm');
      expect(r.feed.published().some((m) => m.messageType === 'opcua.equipment_event' && (m.payload as { kind: string }).kind === 'RECIPE_MISMATCH')).toBe(true);
      await sim.fault('RECIPE_MISMATCH', false);
      // OUT_OF_ORDER is one sample per unit, once. The server samples each variable at its sampling interval, so under
      // load the next regular sample can replace the older one before it is sampled (OPC UA sampling, not a loss in the
      // driver): the fault is fired again, at most once a second, until the driver has seen one.
      let fired = 0;
      await until(async () => {
        if (kinds().has('OUT_OF_ORDER')) return true;
        if (performance.now() - fired > 1000) {
          fired = performance.now();
          await sim.fault('OUT_OF_ORDER', true);
        }
        return false;
      }, 15_000, 'out-of-order alarm');
      await sim.fault('WRONG_BATCH', true);
      await until(() => kinds().has('WRONG_UNIT'), 10_000, `wrong unit alarm ${JSON.stringify([...kinds()])} ${JSON.stringify(r.alarms.slice(-3))}`);
      await sim.fault('REJECT_BURST', true);
      await until(() => r.feed.published().some((m) => m.messageType === 'opcua.alarm'), 10_000, 'reject burst in the feed');
      await sim.fault('REJECT_BURST', false);
      const sessions = () => r.feed.published().filter((m) => m.messageType === 'opcua.endpoint_session').length;
      await sim.fault('LINK_CUT', true);
      await until(() => kinds().has('DISCONNECTED') && r.driver.state === 'ONLINE' && sessions() === 2, 30_000, 'reconnected after the cut');
    } finally {
      await r.stop();
    }
  }, 180_000);

  it('[DI-31] soak: faults in turn; every chunk numbered without a hole and valid, each interruption alarmed, the feed reconciles; no silent loss', async () => {
    const r = liveDriver(sim, { gapAfterMs: 1500, chunkMaxSpanUs: 1_000_000n });
    try {
      await until(() => r.driver.state === 'ONLINE', 30_000, 'online');
      const startUs = BigInt(Date.now()) * 1000n;
      for (const f of ['FEED_GAP', 'STALE_VALUE', 'OUT_OF_ORDER', 'LINK_CUT', 'WRONG_BATCH', 'DRIFT', 'EXCURSION']) {
        await sim.fault(f, true);
        await new Promise((res) => setTimeout(res, 2500));
        await sim.fault(f, false);
        await until(() => r.driver.state === 'ONLINE', 30_000, `online after ${f}`);
        await new Promise((res) => setTimeout(res, 800));
      }
      await r.driver.stop();
      const chunks = chunksOf(r);
      const byTag = new Map<string, SeriesChunkV1[]>();
      for (const c of chunks) byTag.set(`${c.subjectCode}|${c.tag}`, [...(byTag.get(`${c.subjectCode}|${c.tag}`) ?? []), c]);
      expect(byTag.size).toBeGreaterThan(20);
      // Each fault that interrupts or spoils a series was alarmed.
      expect(new Set(r.alarms.map((a) => a.kind))).toEqual(expect.objectContaining({}));
      for (const k of ['FEED_GAP', 'DISCONNECTED', 'STALE_VALUE', 'OUT_OF_ORDER', 'WRONG_UNIT']) expect(r.alarms.some((a) => a.kind === k), k).toBe(true);
      for (const [key, list] of byTag) {
        // Chunk numbers 1..n without a hole; source times strictly increasing across chunks.
        expect(list.map((c) => c.chunkNo), key).toEqual(list.map((_, i) => String(i + 1)));
        const times = list.flatMap((c) => c.samples.map((s) => BigInt(s.sourceTime)));
        for (let i = 1; i < times.length; i++) expect(times[i]! > times[i - 1]!, key).toBe(true);
      }
      // The feed: every message once, in sequence; its reconciliation over the whole period counts every message.
      const all = r.feed.published();
      expect(all.map((m) => m.sequenceNo)).toEqual(all.map((_, i) => String(i + 1)));
      expect(new Set(all.map((m) => m.idempotencyKey)).size).toBe(all.length);
      const rec = r.feed.reconciliation(0n, startUs + 3_600_000_000_000n);
      expect(rec.sourceCount).toBe(String(all.length));
    } finally {
      await r.stop();
    }
  }, 240_000);

  it('[DI-20] a certificate change: the session is reported with the new certificate, the driver refuses it and reads nothing', async () => {
    const r = liveDriver(sim);
    try {
      await until(() => r.driver.state === 'ONLINE', 30_000, 'online');
      const { certificateThumbprint } = await sim.fault('CERTIFICATE_CHANGE', true);
      expect(certificateThumbprint).not.toBe(sim.thumbprint);
      await until(() => r.driver.state === 'CERTIFICATE_MISMATCH', 30_000, 'certificate mismatch');
      expect(r.alarms.some((a) => a.kind === 'CERTIFICATE_MISMATCH')).toBe(true);
      const sessions = r.feed.published().filter((m) => m.messageType === 'opcua.endpoint_session').map((m) => (m.payload as { certificateThumbprint: string }).certificateThumbprint);
      expect(sessions).toEqual([sim.thumbprint, certificateThumbprint]);
      expect(await r.driver.unit('PRESS-01').read()).toMatchObject({ ok: false });
      sim.thumbprint = certificateThumbprint;
    } finally {
      await r.stop();
    }
  }, 120_000);
});
