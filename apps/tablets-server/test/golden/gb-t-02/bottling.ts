/**
 * The GB-T-02 bottle order (Phase 4 slice 7b; D-P4-15): the bottle line on the packaging line PL-1 of the plant (bottle
 * filler, cartoner, the line's balance and torque tester), and one bottle order run on the GB-T-02 bulk.
 */
import { createHash, randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import { passwordActor, personaOf } from '@ebmr/test-kit';
import {
  BOTTLE_ARTWORK_SET, BOTTLE_CARTON, BOTTLE_CARTONER, BOTTLE_CARTON_ARTWORK, BOTTLE_LINE, BOTTLE_SIZE_ID, BOTTLE_UNIT, BOTTLES, BOTTLES_KG, LABEL, LABEL_ARTWORK, TORQUE_TESTER,
} from '../../../src/cli/golden-gb-t-02.ts';
import { PACK_BALANCE } from '../../../src/cli/golden-packaging.ts';
import { tapFor } from '../../esig/support.ts';
import type { TestBrowser } from '../../support/harness.ts';
import { dbAs, entry, GoldenBatch, ok, signAct, tapAdvance } from '../gb-t-01/driver.ts';
import { pause, type PackMaster } from '../gb-t-01/packing.ts';
import { clean } from '../gb-t-01/plant.ts';
import { asPersona, LINE, SITE, type GoldenWorld } from '../gb-t-01/world.ts';

type Json = Record<string, unknown>;

/** The bottle line PL-1: its units, balance and torque tester, qualified, calibrated, cleaned and verified. */
export async function setUpBottleLine(w: GoldenWorld): Promise<void> {
  for (const k of ['technician1', 'technician2', 'steward']) w.b[k] = await w.server.asPersona(k);
  const st = w.b['steward'] as TestBrowser;
  const p = routes.plant;
  ok(await st.call(p.defineArea, { body: { code: BOTTLE_LINE, kind: 'LINE', name: 'Bottle packaging line PL-1' } }), 'line PL-1');
  for (const [code, description] of [['EQC-BOTTLE', 'Bottle filling, capping and labelling line'], ['EQC-CARTONER', 'Cartoner with checkweigher']] as const) {
    ok(await st.call(p.defineEquipmentClass, { body: { code, kind: 'PROCESS', description, cleanHold: '72 hours', dirtyHold: '48 hours' } }), `class ${code}`);
  }
  ok(await st.call(p.defineEquipmentClass, { body: { code: 'EQC-TQ', kind: 'INSTRUMENT', description: 'Closure torque tester, calibrated', calibrationRequired: true, checkRegime: 'PER_USE' } }), 'class EQC-TQ');
  ok(await st.call(p.defineEquipment, { body: { code: PACK_BALANCE, name: 'Balance of PL-1', classCode: 'EQC-BAL', areaCode: BOTTLE_LINE } }), PACK_BALANCE);
  ok(await st.call(p.defineEquipment, { body: { code: TORQUE_TESTER, name: 'Closure torque tester', classCode: 'EQC-TQ', areaCode: BOTTLE_LINE } }), TORQUE_TESTER);
  ok(await st.call(p.defineEquipment, { body: { code: BOTTLE_UNIT, name: 'Bottle filling, capping and labelling line', classCode: 'EQC-BOTTLE', areaCode: BOTTLE_LINE } }), BOTTLE_UNIT);
  ok(await st.call(p.defineEquipment, { body: { code: BOTTLE_CARTONER, name: 'Cartoner with checkweigher', classCode: 'EQC-CARTONER', areaCode: BOTTLE_LINE } }), BOTTLE_CARTONER);
  for (const code of [PACK_BALANCE, TORQUE_TESTER, BOTTLE_UNIT, BOTTLE_CARTONER]) {
    ok(await st.call(p.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${code}` } }), `the qualification of ${code}`);
  }
  const tech = w.b['technician1'] as TestBrowser;
  for (const code of [PACK_BALANCE, TORQUE_TESTER]) {
    await asPersona(w.server, tech, 'technician1', (c) => c.query("select plant.record_calibration($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', $2)", [code, `CAL-${code}`]));
  }
  const boot = w.seed.bootstrap;
  const admin = await passwordActor(w.server.db, boot.admin, boot.admin.fingerprint, { reasonCode: 'DEVICE_REGISTRATION', reasonText: 'Instruments of the bottle line', correlationId: randomUUID() });
  for (const code of [PACK_BALANCE, TORQUE_TESTER]) {
    await identity.withGuardedCommand(w.server.db.app, { ...admin, correlationId: randomUUID() }, (c) =>
      c.query("select iam.register_device($1, 'INSTRUMENT', 'SITE-1', $2, null, $3, $4)", [code, BOTTLE_LINE, createHash('sha256').update(`${code}:${randomUUID()}`).digest('hex'), `${code} of PL-1 (not interfaced)`]),
    );
  }
  for (const code of [BOTTLE_UNIT, BOTTLE_CARTONER]) await clean(w, 'EQUIPMENT', code);
  await clean(w, 'AREA', BOTTLE_LINE);
}

export interface BottleRun {
  labels: string[];
  label: { issued: string; used: string; codedDestroyed: string; uncodedReturned: string; specimens: string };
  carton: { issued: string; used: string; codedDestroyed: string; uncodedReturned: string; specimens: string };
  bottles: { good: string; rejects: string };
  packs: string;
  perShipper: string;
  tabletsIssued: string;
  tabletsPacked: string;
}

/** One bottle order planned on the bulk of `parent`, issued, and run to its end. */
export async function bottleOrder(w: GoldenWorld, m: PackMaster, parent: GoldenBatch, orderNo: string, plan: BottleRun, markets: string[] = ['IN']): Promise<GoldenBatch> {
  const issuer = await w.server.asPersona('issuer');
  const p = ok(
    await issuer.call(routes.planning.planPackagingOrder, { body: { familyId: m.familyId, markets, site: SITE, line: LINE, batchSize: BOTTLE_SIZE_ID, erpOrder: orderNo, parentBatchId: parent.batchId } }),
    `the plan of ${orderNo}`,
  );
  const g = GoldenBatch.of(w, p.batchId, p.batchNumber);
  ok(
    await signAct(w, issuer, 'issuer', { kind: 'GMP_BATCH_ISSUE', batchId: g.batchId, reason: { code: 'PACKING_PLAN', text: `Packaging order of batch ${parent.batchNumber}` }, variants: {}, inputs: {} }),
    `the issue of ${g.batchNumber}`,
  );
  const stores = await w.server.asPersona('stores');
  const lot = (await w.server.db.app.query<{ id: string }>("select id from site.material_lot where lot_code = 'GBT2-HDP-001'")).rows[0]?.id;
  await dbAs(w, stores, 'stores', "select site.reserve_lot($1, $2, $3, 'TABLETS', $4::numeric, 'kg', clock_timestamp() + interval '30 days') as r", [lot, g.batchId, g.batchNumber, BOTTLES_KG]);

  await g.floor('PL-1');
  const bulkBody = { labels: plan.labels };
  tapAdvance();
  const op = g.b('operator2');
  ok(await op.call(routes.batches.issueBulk, { params: { batchId: g.batchId }, body: bulkBody, attribution: await tapFor(op, personaOf(w.seed, 'operator2'), 'POST', `/api/batches/${g.batchId}/bulk`, bulkBody) }), 'the bulk issue');
  const occ = await g.clearAndOccupy('PL-1', 'S-PACK', 'operator2', 'PACKAGING_ORDER', BOTTLE_ARTWORK_SET);
  const bal = await g.balanceUse('PL-1', 'operator2');
  await dbAs(w, g.b('operator2'), 'operator2', "select plant.record_instrument_check($1, 'PASS', $2, $3::uuid) as r", [TORQUE_TESTER, `${TORQUE_TESTER} per-use check`, g.batchId]);
  await dbAs(w, g.b('operator2'), 'operator2', 'select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + make_interval(hours => 12)) as r', [TORQUE_TESTER, g.batchId]);
  const filler = await dbAs<string>(w, g.b('operator2'), 'operator2', 'select plant.start_equipment_use($1, $2, clock_timestamp() + make_interval(hours => 12)) as r', [BOTTLE_UNIT, g.batchId]);
  const cartoner = await dbAs<string>(w, g.b('operator2'), 'operator2', 'select plant.start_equipment_use($1, $2, clock_timestamp() + make_interval(hours => 12)) as r', [BOTTLE_CARTONER, g.batchId]);
  g.uses.set(BOTTLE_UNIT, filler);
  g.uses.set(BOTTLE_CARTONER, cartoner);
  await g.step('p-pk-clear@', { performer: 'operator2', entries: [entry('p-pk-clear@', 'AREA_OCCUPANCY', { areaCode: BOTTLE_LINE, occupancyId: occ })] });
  await g.step('p-pk-status@', {
    performer: 'operator2',
    checker: null,
    entries: [
      entry('p-pk-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: PACK_BALANCE, useId: bal }),
      entry('p-pk-status@', 'EQUIPMENT_USE', { equipmentRef: 'BOTTLER', equipmentCode: BOTTLE_UNIT, useId: filler }),
      entry('p-pk-status@', 'EQUIPMENT_USE', { equipmentRef: 'CARTONER', equipmentCode: BOTTLE_CARTONER, useId: cartoner }),
    ],
  });
  await g.step('p-pk-bottles@', {
    entries: [{ type: 'RECORD_ENTRY', stepKey: 'p-pk-bottles@', entry: { kind: 'CONTAINER_WEIGHING', item: 'pkBottles', bomLine: 'BOM-BTL', lotCode: 'GBT2-HDP-001', manual: { gross: '41.000', tare: '1.000', unit: 'kg', deviceCode: PACK_BALANCE } } }],
  });
  await pause(g);
  const e = (stepKey: string, entryKind: string, d: Json) => g.d.ok('operator2', entry(stepKey, entryKind, d));
  for (const s of ['p-g21@', 'p-tb23@', 'p-tb24@', 'p-pk-destroy@']) await g.d.ok('operator2', { type: 'START_STEP', stepKey: s });
  const lotFacts = async (code: string): Promise<Json> => (await w.server.db.app.query<{ r: Json }>('select tab.printed_lot_facts($1, $2) as r', [code, g.batchId])).rows[0]?.r ?? {};
  await e('p-g21@', 'ISSUE', { item: 'LABEL', lot: await lotFacts('GBT2-LBL-001'), scannedArtwork: LABEL_ARTWORK, quantity: { value: plan.label.issued, unit: '1' } });
  await e('p-g21@', 'ISSUE', { item: 'CARTON', lot: await lotFacts('GBT2-CTN-001'), scannedArtwork: BOTTLE_CARTON_ARTWORK, quantity: { value: plan.carton.issued, unit: '1' } });
  await e('p-tb23@', 'CHALLENGE', { device: 'SEALDET', trigger: 'START', result: 'PASS' });
  await e('p-tb23@', 'COUNT_CHECK', { counts: ['30', '30', '30'] });
  await e('p-tb23@', 'DESICCANT_CHECK', { examined: '20', missing: '0' });
  await e('p-tb23@', 'TORQUE_CHECK', { tester: TORQUE_TESTER, application: ['2.0', '2.1'], removal: ['1.6', '1.7'] });
  await e('p-tb23@', 'SEAL_CHECK', { examined: '20', defective: '0' });
  await e('p-tb24@', 'CHALLENGE', { device: 'CW', trigger: 'START', result: 'PASS' });
  await e('p-tb24@', 'ATD_CHECK', { examined: '10', defective: '0' });
  await e('p-tb24@', 'EXAMINATION', { timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true });
  await g.wait(20);
  await e('p-tb23@', 'COUNT_CHECK', { counts: ['30', '30', '30'] });
  await e('p-tb23@', 'DESICCANT_CHECK', { examined: '20', missing: '0' });
  await e('p-tb23@', 'TORQUE_CHECK', { tester: TORQUE_TESTER, application: ['2.1', '2.0'], removal: ['1.7', '1.6'] });
  await e('p-tb23@', 'SEAL_CHECK', { examined: '20', defective: '0' });
  await e('p-tb23@', 'REJECTS', { reason: 'SEAL', bottles: plan.bottles.rejects });
  await e('p-tb23@', 'GOOD_OUTPUT', { bottles: plan.bottles.good });
  await e('p-tb23@', 'CHALLENGE', { device: 'SEALDET', trigger: 'END', result: 'PASS' });
  await e('p-tb24@', 'ATD_CHECK', { examined: '10', defective: '0' });
  await e('p-tb24@', 'EXAMINATION', { timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true });
  await e('p-tb24@', 'PACKS_MADE', { packs: plan.packs });
  const shippers = Number(plan.packs) / Number(plan.perShipper);
  for (let i = 0; i < shippers; i += 1) {
    if (i % 10 === 0) await pause(g);
    tapAdvance();
    const body = {};
    const path = `/api/batches/${g.batchId}/steps/${encodeURIComponent('p-tb24@')}/sscc`;
    const o = g.b('operator2');
    const sscc = ok(await o.call(routes.batches.issueSscc, { params: { batchId: g.batchId, stepKey: 'p-tb24@' }, body, attribution: await tapFor(o, personaOf(w.seed, 'operator2'), 'POST', path, body) }), 'an SSCC');
    await e('p-tb24@', 'SHIPPER', { sscc: (sscc as { sscc: string }).sscc, packs: plan.perShipper, part: false });
  }
  await e('p-tb24@', 'EXAMINATION', { timing: 'END', examined: '20', defective: '0', labelCorrect: true });
  await e('p-tb24@', 'CHALLENGE', { device: 'CW', trigger: 'END', result: 'PASS' });
  await e('p-tb24@', 'RECONCILIATION', {});
  for (const [item, r] of [['LABEL', plan.label], ['CARTON', plan.carton]] as const) {
    await e('p-g21@', 'RECONCILIATION', { item, used: r.used, setupWaste: '0', damaged: '0', codedDestroyed: r.codedDestroyed, uncodedReturned: r.uncodedReturned, specimens: r.specimens });
  }
  await e('p-pk-destroy@', 'DISPOSAL', { category: 'DESTRUCTION', material: LABEL, batchCoded: true, quantity: { value: plan.label.codedDestroyed, unit: '1' }, method: 'Shredding' });
  await e('p-pk-destroy@', 'DISPOSAL', { category: 'DESTRUCTION', material: BOTTLE_CARTON, batchCoded: true, quantity: { value: plan.carton.codedDestroyed, unit: '1' }, method: 'Shredding' });
  for (const s of ['p-g21@', 'p-tb23@', 'p-tb24@']) {
    await g.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: s });
    await g.signed('verifier1', { type: 'VERIFY', stepKey: s, meaning: 'VERIFIED' });
  }
  await g.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-pk-destroy@' });
  await g.signed('verifier1', { type: 'VERIFY', stepKey: 'p-pk-destroy@', meaning: 'WITNESSED' });
  await g.step('p-pk-count@', {
    performer: 'operator2',
    meaning: 'WITNESSED',
    entries: [
      { type: 'RECORD_DATA', stepKey: 'p-pk-count@', item: 'tabletsIssued', value: { kind: 'DECIMAL', value: plan.tabletsIssued, unit: '{tbl}' }, source: { mode: 'MANUAL' } },
      { type: 'RECORD_DATA', stepKey: 'p-pk-count@', item: 'tabletsPacked', value: { kind: 'DECIMAL', value: plan.tabletsPacked, unit: '{tbl}' }, source: { mode: 'MANUAL' } },
    ],
  });
  await g.step('p-pk-yield@', { performer: 'operator2' });
  await g.closeStage('S-PACK@');
  await g.release([BOTTLE_UNIT, BOTTLE_CARTONER, BOTTLE_LINE], 'operator2');
  return g;
}

