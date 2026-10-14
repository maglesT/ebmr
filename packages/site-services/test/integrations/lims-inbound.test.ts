/**
 * LIMS sample results through the LIMS adapter (site services 0926; Phase 6 slice 6a, builder B; DI-31; D-P6a-4:
 * LIMS-lite stays the stand-in). As the application role through a registered LIMS adapter identity.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPermissionDenied, expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { count, envelopeFor, nowUs, receive, recordRefusal, registerAdapter, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { QualityWorld, seedQualityCast, unique } from '../quality/support.ts';

let db: TestDatabase;
let w: QualityWorld;
let lims: TestAdapter;
let lot: { lotId: string; lotCode: string };

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
  lims = await registerAdapter(db, 'LIMS');
  lot = await w.lot();
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const result = (over: Record<string, unknown> = {}) => ({
  sampleId: 'S-1', lotNumber: lot.lotCode, testCode: 'ASSAY', specificationRef: 'SPEC-PARA-01', result: { value: '99.20', unit: '%' },
  conformance: 'CONFORMS', state: 'APPROVED', recordedAt: nowUs(), ...over,
});
const send = (payload: unknown, o = {}) => receive(db, lims, 'site.receive_lims_sample_result', envelopeFor(lims, 'lims.sample_result', payload, o));
const rows = () => count(db, 'select count(*) as n from site.lims_sample_result where lot_id = $1', [lot.lotId]);

describe('LIMS results through the adapter (DI-31)', () => {
  it('[DI-31] every accepted value keeps source system, record id, timestamp, raw value and unit', async () => {
    const env = envelopeFor(lims, 'lims.sample_result', result({ sampleId: unique('S-') }), { sourceRecordId: 'LIMS-RES-0001' });
    const r = await receive(db, lims, 'site.receive_lims_sample_result', env);
    expect(r).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });
    const { rows: got } = await db.app.query(
      `select r.raw_value, r.raw_unit, m.source_system, m.source_record_id, (extract(epoch from m.source_timestamp) * 1000000)::bigint::text as ts
         from site.lims_sample_result r join platform.inbound_message m on m.id = r.message_id where r.message_id = $1`, [r['messageId']]);
    expect(got).toEqual([{ raw_value: '99.20', raw_unit: '%', source_system: 'LIMS', source_record_id: 'LIMS-RES-0001', ts: env['sourceTimestamp'] }]);
    // The trailing zero is kept: the value is the LIMS's text, never a converted number.
    expect((await db.app.query<{ v: unknown }>('select site.lims_lot_results($1) as v', [lot.lotId])).rows[0]!.v).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: '99.20', unit: '%', state: 'APPROVED' })]));
    await expectPermissionDenied(w.run(w.cast.analyst, (c) => c.query("update site.lims_sample_result set raw_value = '100' where message_id = $1", [r['messageId']])));
  });

  it('[DI-31] a malformed result, a wrong-batch result and a late older state are refused, recorded with an alarm, and nothing lands', async () => {
    const before = await rows();
    const alarms = (kind: string) => count(db, 'select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = $2', [lims.code, kind]);
    for (const [payload, code, cls] of [
      [result({ result: { value: '99,2', unit: '%' } }), 'EBMR-LIMS-101', 'MALFORMED'],
      [result({ result: { value: '99.2' } }), 'EBMR-LIMS-101', 'MALFORMED'],
      [result({ analyst: 'X' }), 'EBMR-LIMS-101', 'MALFORMED'],
      [result({ lotNumber: 'NOT-A-LOT' }), 'EBMR-LIMS-103', 'WRONG_IDENTITY'],
    ] as const) {
      const env = envelopeFor(lims, 'lims.sample_result', payload);
      const n = await alarms(cls);
      await expectRefused(receive(db, lims, 'site.receive_lims_sample_result', env), code);
      await recordRefusal(db, lims, env, cls, code);
      expect(await alarms(cls)).toBe(n + 1);
    }
    expect(await rows()).toBe(before);
    const sample = unique('S-');
    const older = nowUs();
    await send(result({ sampleId: sample, state: 'REVIEWED' }));
    await expectRefused(send(result({ sampleId: sample, state: 'ENTERED' }), { sourceTimestamp: older }), 'EBMR-LIMS-104');
    expect(await rows()).toBe(before + 1);
  });
});
