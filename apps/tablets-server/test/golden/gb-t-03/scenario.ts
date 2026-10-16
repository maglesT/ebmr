/**
 * The GB-T-03 scenario, "connected" (Phase 6 slice 6j-b; D-P6-7): GB-T-02's direct-compression product made and packed at
 * a site whose external systems feed the eBMR through its adapters (connected.ts):
 *  - the ERP sends the production and packaging orders (erp.production_order) and, after the release, the distribution
 *    records of the finished lot (erp.shipment); the WMS sends the status of every lot the batch uses (wms.lot_status);
 *  - the LMS sends the product training the performers' signatures require (a requirement on STEP.SIGN_PERFORMED for the
 *    product, recorded by the training coordinator): a signature on the product counts it only while the LMS mirror is
 *    fresh;
 *  - the CMMS sends the calibrations of the instruments and the press's preventive maintenance;
 *  - the bottle order is serialised for the US: its pool comes from the L3/L4 system, the cartons' serials are
 *    commissioned there, the packs are aggregated to the order's shippers there (l3.aggregation on the L3 feed), and the
 *    L3's report closes the printed-materials step; release for the US reads the L3 mirror and fails closed while it is
 *    stale;
 *  - the OPC UA press (opcua.ts) reports its endpoint session and native series through the site gateway;
 *  - after the release, QA runs a mock recall from the API lot (the forward genealogy to the consignees of the ERP's
 *    shipments) and the AP signs it off.
 * Every act is a persona's, over HTTP where a route exists; the residuals of GB-T-01 and GB-T-02 apply (README.md).
 */
import { randomUUID } from 'node:crypto';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { flow } from '@ebmr/recipe-core';
import { GBT02_BATCH_KG, GBT02_BOM, GBT02_LOTS, GBT02_PRODUCT } from '../../../src/features/execution/seed-gb-t-02.ts';
import { BOTTLE_SIZE_ID, BOTTLES, BOTTLES_KG, bottleMasterContent, dcMasterContent, GBT02_SIZE_ID, TORQUE_TESTER } from '../../../src/cli/golden-gb-t-02.ts';
import { PACK_BALANCE } from '../../../src/cli/golden-packaging.ts';
import { configuredL3Client, fetchSerialReport, requestSerialPool, sendSerialEvents, type L3Client, type SerialChange } from '../../../src/features/execution/serialisation.ts';
import { actorOfBrowser, refusalOf, valueOf } from '../../esig/support.ts';
import { grantedPerson } from '../../support/granted-person.ts';
import { passwordActor, personaOf, terminalOf } from '@ebmr/test-kit';
import { advanceMinutes } from '../clock.ts';
import { entry, GoldenBatch, ok, signAct, tick } from '../gb-t-01/driver.ts';
import { approveMaster, type PackMaster } from '../gb-t-01/packing.ts';
import { BALANCE, clean, UNITS } from '../gb-t-01/plant.ts';
import { finishedLot, manufacturerRelease, productSpecification, reviewRecord } from '../gb-t-01/release.ts';
import { asPersona, type GoldenWorld } from '../gb-t-01/world.ts';
import { bottleOrder, setUpBottleLine, type BottleRun } from '../gb-t-02/bottling.ts';
import { BLEND, COMPRESSION } from '../gb-t-02/scenario.ts';
import { blending, compression, DISPENSE, dispensing, TOOLING_SET } from '../gb-t-02/stages.ts';
import type { Connected } from './connected.ts';
import type { PressRig } from './opcua.ts';

type Json = Record<string, unknown>;

export const ORDER = 'PO-GBT03-0001';
export const PACK_ORDER = 'PO-GBT03-PK-0001';
/** The GTIN of the US pack (invented; GS1 check digit valid). */
export const US_GTIN = '00312345678906';
/** The product training the performers' signatures on the product require, held in the LMS. */
export const LMS_TRAINING = 'SOP-GBT03-PROD';
/** The performers of the batch and the order, with the employee numbers the LMS knows them by. */
export const PERFORMERS: Readonly<Record<string, string>> = { operator1: 'EMP-1001', operator2: 'EMP-1002', supervisor1: 'EMP-1003' };
/** The instruments the CMMS calibrates and the process units it maintains. */
export const CALIBRATED = [BALANCE['DISP-1'], BALANCE['BLEND-1'], BALANCE['COMP-1'], PACK_BALANCE, TORQUE_TESTER] as const;
export const MAINTAINED = [UNITS.BLENDER.code, UNITS.PRESS.code] as const;

/** The bottle order's worksheet (README.md): GB-T-02's, the cartons serialised for the US. */
export const BOTTLE_PLAN: Omit<BottleRun, 'labels'> = {
  label: { issued: '3250', used: '3200', codedDestroyed: '20', uncodedReturned: '26', specimens: '4' },
  carton: { issued: '3250', used: '3200', codedDestroyed: '10', uncodedReturned: '36', specimens: '4' },
  bottles: { good: '3200', rejects: '4' },
  packs: '3200',
  perShipper: '100',
  tabletsIssued: '97500',
  tabletsPacked: '96000',
};
/** The serials of the order (README.md): one per coded carton: used, coded and destroyed, kept as specimens. */
export const SERIALS = { pool: '3214', commissioned: '3200', destroyed: '10', samples: '4', perShipper: '100', shippers: '32' };
/** The ERP's shipments of the finished lot (3,200 packs posted, 4 kept as reserve samples). */
export const SHIPMENTS = [
  { shipmentId: 'SHP-GBT03-IN-01', consigneeCode: 'CUST-IN-PUNE', consigneeName: 'Pune Pharma Distributors', consigneeAddress: '12 Station Road, Pune 411001', quantity: '1600', market: 'IN' },
  { shipmentId: 'SHP-GBT03-US-01', consigneeCode: 'CUST-US-NJ', consigneeName: 'Garden State Wholesale Drug', consigneeAddress: '400 Route 1, Edison, NJ 08817', quantity: '1596', market: 'US' },
] as const;

export interface Gbt03Masters {
  dc: PackMaster;
  bottle: PackMaster;
}

/** The epoch microseconds of the database clock now (the golden clock). */
async function dbNowUs(w: GoldenWorld): Promise<string> {
  return (await w.server.db.app.query<{ t: string }>('select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as t')).rows[0]?.t ?? '0';
}

/** GB-T-02's bottle master with its printed-materials step serialised for the US (the US carton's GTIN). */
export function serialisedBottleMaster(familyCode: string): flow.MbrContent {
  // Authorised for the EU too, as GB-T-02's (its cartoning step then carries the anti-tampering check the order records).
  const content = JSON.parse(JSON.stringify(bottleMasterContent(familyCode, ['IN', 'US', 'EU']))) as Json;
  let found = 0;
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (n === null || typeof n !== 'object') return;
    const o = n as Json;
    if (o['kind'] === 'phase' && o['id'] === 'p-g21') {
      o['config'] = { ...(o['config'] as Json), markets: { US: { gtin: US_GTIN } }, serialisation: { markets: ['US'] } };
      found += 1;
    }
    Object.values(o).forEach(visit);
  };
  visit(content['procedure']);
  if (found !== 1) throw new Error(`the bottle master has ${String(found)} printed-materials steps, not one`);
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`the serialised bottle master does not parse: ${parsed.problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return parsed.mbr;
}

/**
 * The site's records the connected systems feed (the orders, the lot statuses, the training, the calibrations and the
 * maintenance), the plant items of the product and its bottle line, and the two masters approved for India and the US.
 */
export async function setUpGbt03(w: GoldenWorld, cx: Connected): Promise<Gbt03Masters> {
  const st = (w.b['steward'] = await w.server.asPersona('steward'));
  await asPersona(w.server, st, 'steward', (c) => c.query('select plant.define_product($1::jsonb)', [JSON.stringify({ code: GBT02_PRODUCT.productCode, name: GBT02_PRODUCT.productName, highlyPotent: false })]), {
    reasonCode: 'NEW_PRODUCT', reasonText: 'GB-T-03 (the GB-T-02 product) in the plant product list',
  });
  ok(
    await st.call(routes.plant.defineToolingSet, {
      body: { code: TOOLING_SET, product: GBT02_PRODUCT.productCode, type: 'B', shape: 'Round 8 mm flat bevelled', upperEmbossing: 'F100', lowerEmbossing: 'PLAIN', score: 'NONE', tips: 1, upperPunches: 45, lowerPunches: 45, dies: 45, strokeLimit: '5000000' },
    }),
    'the tooling set',
  );
  await setUpBottleLine(w, { calibrate: false });
  const dc = await approveMaster(w, dcMasterContent('GBT03-100-DC', ['IN', 'US']), {
    changeRecord: 'CC-GBT03-001', title: 'GB-T-03 direct compression, connected site (invented)', riskAssessment: 'RA-GBT03-001', rationaleRef: 'QRM-GBT03-IPC',
    validationRef: 'VR-GBT03', sandboxRun: 'SBX-GBT03-001', sizeId: GBT02_SIZE_ID, markets: ['IN', 'US'],
    numbering: { ruleCode: 'GBT03-PROC', productCode: GBT02_PRODUCT.productCode, kind: 'PROCESSING', format: 'GBC{YY}{SEQ:4}' },
  });
  const bottle = await approveMaster(w, serialisedBottleMaster('GBT03-100-BT30'), {
    changeRecord: 'CC-GBT03-002', title: 'GB-T-03 HDPE bottle of 30, serialised for the US (invented)', riskAssessment: 'RA-GBT03-002', rationaleRef: 'QRM-GBT03-IPC',
    validationRef: 'VR-GBT03-PK', sandboxRun: 'SBX-GBT03-BT-001', sizeId: BOTTLE_SIZE_ID, markets: ['IN', 'US', 'EU'],
    numbering: { ruleCode: 'GBT03-PACK', productCode: GBT02_PRODUCT.productCode, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' },
  });

  // The ERP's production and packaging orders, on its feed.
  const start = await dbNowUs(w);
  const erp = cx.sim('ERP');
  const order = (orderNumber: string, quantity: { value: string; unit: string }, bom: readonly (readonly [string, string])[]) =>
    erp.call('POST', '/production-orders', {
      orderNumber, productCode: GBT02_PRODUCT.productCode, strength: GBT02_PRODUCT.strength, plannedQuantity: quantity,
      bom: bom.map(([materialCode, value]) => ({ materialCode, quantity: { value, unit: 'kg' } })), plannedStart: start,
    });
  for (const r of [await order(ORDER, { value: GBT02_BATCH_KG, unit: 'kg' }, GBT02_BOM), await order(PACK_ORDER, { value: '96000', unit: '{tbl}' }, [[BOTTLES, BOTTLES_KG]])]) {
    if (r.status !== 201) throw new Error(`the ERP simulator refused an order: ${JSON.stringify(r.body)}`);
  }
  // The WMS's status of every lot the batch and the order use.
  for (const l of GBT02_LOTS) {
    const r = await cx.sim('WMS').call('POST', '/lot-statuses', { lotNumber: l.lotCode, status: 'RELEASED' });
    if (r.status !== 201) throw new Error(`the WMS simulator refused a lot status: ${JSON.stringify(r.body)}`);
  }

  // The product training in the LMS: the type and the requirement (training coordinator), each performer's record.
  const coordinator = await grantedPerson(w.server, 'TRAINING_COORDINATOR', 'Tara Coordinator');
  const tc = await passwordActor(w.server.db, coordinator, terminalOf(w.seed, 'PC-QA-01').fingerprint);
  await withCommand(w.server.db.app, { ...tc, reasonCode: 'NEW_PRODUCT', reasonText: 'GB-T-03 product training', correlationId: randomUUID() }, async (c) => {
    await c.query("select iam.create_qualification_type($1, 'GB-T-03 product training', 'Product SOP of the GB-T-02 product, held in the LMS')", [LMS_TRAINING]);
    await c.query("select iam.add_qualification_requirement($1, null, 'STEP.SIGN_PERFORMED', $2::jsonb, 'Performers of the product are trained on its SOP (LMS)')", [LMS_TRAINING, JSON.stringify({ product: GBT02_PRODUCT.productCode })]);
  });
  // The seeded personas carry no employee number (the access workflow records one when it creates a person): the set-up
  // gives the performers theirs, as the superuser, with a reason.
  const boot = w.seed.bootstrap;
  const admin = await passwordActor(w.server.db, boot.admin, boot.admin.fingerprint);
  for (const [key, number] of Object.entries(PERFORMERS)) {
    await withCommand(w.server.db.admin, { ...admin, reasonCode: 'HR_RECORD', reasonText: 'Employee number from the HR record (LMS key)', correlationId: randomUUID() }, (c) =>
      c.query('update iam.person set employee_ref = $1 where id = $2', [number, personaOf(w.seed, key).personId]),
    );
    const r = await cx.sim('LMS').call('POST', '/qualifications', { personNumber: number, qualificationCode: LMS_TRAINING, status: 'QUALIFIED', validFrom: '1767225600000000', validTo: null });
    if (r.status !== 201) throw new Error(`the LMS simulator refused a qualification: ${JSON.stringify(r.body)}`);
  }

  // The CMMS's calibrations of the instruments and the preventive maintenance of the blender and the press.
  const performedAt = (BigInt(start) - 86_400_000_000n).toString();
  for (const code of CALIBRATED) {
    const r = await cx.sim('CMMS').call('POST', '/calibrations', { equipmentCode: code, calibrationRef: `CMMS-CAL-${code}`, performedAt, result: 'PASS', dueOn: '2099-12-31' });
    if (r.status !== 201) throw new Error(`the CMMS simulator refused a calibration: ${JSON.stringify(r.body)}`);
  }
  for (const code of MAINTAINED) {
    const r = await cx.sim('CMMS').call('POST', '/work-orders', { equipmentCode: code, workOrder: `CMMS-WO-${code}`, kind: 'PREVENTIVE', status: 'COMPLETED', dueOn: '2099-12-31' });
    if (r.status !== 201) throw new Error(`the CMMS simulator refused a work order: ${JSON.stringify(r.body)}`);
  }
  return { dc, bottle };
}

/** GB-T-02's dispensing, the cellulose weighed from its identity-tested lot (a batch for the US needs one; IN-24). */
const DISPENSE_GBT03 = DISPENSE.map(([item, bom, lot, net]) => [item, bom, lot === 'GBT2-MCC-V01' ? 'GBT2-MCC-001' : lot, net] as const);
const RESERVE = { 'MAT-EXF': '10.000', 'MAT-MCC-102': '8.400', 'MAT-CCS': '1.000', 'MAT-SIO2': '0.200', 'MAT-MGST': '0.400' };

/** The batch for India and the US from dispensing to the release for packing, the mirrors synchronised before each stage. */
export async function runBatch(w: GoldenWorld, cx: Connected, m: Gbt03Masters, press: PressRig): Promise<{ batch: GoldenBatch; bulk: { id: string; label: string }[] }> {
  w.b['technician1'] = await w.server.asPersona('technician1');
  w.b['technician2'] = await w.server.asPersona('technician2');
  for (const u of [UNITS.BLENDER, UNITS.PRESS]) await clean(w, 'EQUIPMENT', u.code);
  for (const room of ['DISP-1', 'BLEND-1', 'COMP-1']) await clean(w, 'AREA', room);
  await cx.sync();
  const g = await GoldenBatch.plan(w, { familyId: m.dc.familyId, markets: ['IN', 'US'], batchSize: GBT02_SIZE_ID });
  await g.issue('100000');
  await g.reserveLots(RESERVE, GBT02_LOTS);
  await dispensing(g, DISPENSE_GBT03);
  await cx.sync();
  const { blendLabel } = await blending(g, BLEND);
  await cx.sync();
  // The OPC UA press reports through the site gateway while the batch holds it (opcua.ts).
  const bulk = await compression(g, { blendLabel, ...COMPRESSION }, { duringRun: (x) => press.run(x) });
  return { batch: g, bulk };
}

export interface SerialFacts {
  pool: { quantity: string; market: string; l3Market: string; gtin: string };
  report: Json;
  aggregations: { shippers: number; packs: string };
  /** The L3 release problem with the mirror older than its bound, and after the next synchronisation. */
  staleMirror: { problem: string | null; grelSerial: string; after: string | null };
}

/** The most serial events one request to the L3 system carries (its protocol's limit). */
const L3_EVENTS_MAX = 1000;

/** The serialisation of the order through the L3/L4 system (the bottle order's hooks). */
function serialisation(w: GoldenWorld, cx: Connected): { hooks: Parameters<typeof bottleOrder>[6]; facts: () => Promise<Omit<SerialFacts, 'staleMirror'>> } {
  const real = configuredL3Client(cx.sim('L3').origin);
  let serials: string[] = [];
  const l3: L3Client = {
    ...real,
    requestPool: async (r) => {
      const a = await real.requestPool(r);
      serials = [...a.serials];
      return a;
    },
  };
  let poolId = '';
  const asOp = async (g: GoldenBatch) => {
    tick();
    return actorOfBrowser(w.server, g.b('operator2'), 'operator2');
  };
  const at = () => dbNowUs(w);
  return {
    hooks: {
      async afterIssue(g) {
        poolId = (await withCommand(w.server.db.app, await asOp(g), (c) => requestSerialPool(c, l3, { batchId: g.batchId, stepKey: 'p-g21@', market: 'US', quantity: SERIALS.pool }))).poolId;
        await g.d.ok('operator2', entry('p-g21@', 'SERIAL_POOL', { poolId, market: 'US', gtin: US_GTIN, quantity: SERIALS.pool }));
        const t = await at();
        const commission: SerialChange[] = serials.map((serial) => ({ serial, from: null, state: 'COMMISSIONED', at: t }));
        // The L3 protocol takes at most 1,000 events a request: the coder sends them in its own batches.
        for (let i = 0; i < commission.length; i += L3_EVENTS_MAX) {
          await withCommand(w.server.db.app, await asOp(g), (c) => sendSerialEvents(c, l3, poolId, commission.slice(i, i + L3_EVENTS_MAX)));
        }
      },
      async afterShippers(g, ssccs) {
        // The packs aggregated to their shippers in the L4 system; the L3 feed brings the aggregations to the eBMR.
        for (const sscc of ssccs) {
          const r = await cx.sim('L3').call('POST', '/aggregations', { poolId, parentId: sscc, childCount: SERIALS.perShipper });
          if (r.status !== 201) throw new Error(`the L3 simulator refused an aggregation: ${JSON.stringify(r.body)}`);
        }
        await cx.sync();
        void g;
      },
      async beforeReconciliation(g) {
        // The coded cartons destroyed and the specimens: their serials leave COMMISSIONED in the L3; then its report.
        const t = await at();
        const destroyed = serials.slice(0, Number(SERIALS.destroyed)).map((serial): SerialChange => ({ serial, from: 'COMMISSIONED', state: 'DESTROYED', at: t }));
        const samples = serials.slice(Number(SERIALS.destroyed), Number(SERIALS.destroyed) + Number(SERIALS.samples)).map((serial): SerialChange => ({ serial, from: 'COMMISSIONED', state: 'SAMPLE', at: t }));
        await withCommand(w.server.db.app, await asOp(g), (c) => sendSerialEvents(c, l3, poolId, [...destroyed, ...samples]));
        const closed = await withCommand(w.server.db.app, await asOp(g), (c) => fetchSerialReport(c, l3, poolId));
        // The report's SERIAL_RECONCILIATION entry, as the database gave it, closes the pool on the printed-materials step.
        const { kind, ...data } = closed;
        await g.d.ok('operator2', entry('p-g21@', String(kind), data));
      },
    },
    async facts() {
      const one = async <T,>(sql: string, p: unknown[]): Promise<T> => (await w.server.db.admin.query<{ r: T }>(sql, p)).rows[0]?.r as T;
      const pool = await one<Json>("select jsonb_build_object('quantity', quantity::text, 'market', market, 'l3Market', l3_market, 'gtin', gtin) as r from tab.serial_pool where pool_id = $1", [poolId]);
      const report = await one<Json>('select counts as r from tab.serial_report where pool_id = $1 order by recorded_at desc limit 1', [poolId]).catch(() => ({}));
      const agg = await one<Json>("select jsonb_build_object('shippers', count(*), 'packs', coalesce(sum(child_count), 0)::text) as r from tab.l3_aggregation where pool_id = $1", [poolId]);
      return { pool: pool as SerialFacts['pool'], report: report ?? {}, aggregations: { shippers: Number(agg['shippers']), packs: String(agg['packs']) } };
    },
  };
}

export interface Gbt03Release {
  order: GoldenBatch;
  lot: { lotId: string; lotCode: string };
  grel: Json;
  decision: string;
  us: { grel: string[]; disposition: string };
  serial: SerialFacts;
  shipments: Json[];
  recall: Json;
}

/** The serialised bottle order, the reviews, the finished lot released for India and the US, its shipments and the mock recall. */
export async function packReleaseAndRecall(w: GoldenWorld, cx: Connected, m: Gbt03Masters, batch: GoldenBatch, bulk: { id: string; label: string }[]): Promise<Gbt03Release> {
  await cx.sync();
  const s = serialisation(w, cx);
  const order = await bottleOrder(w, m.bottle, batch, PACK_ORDER, { ...BOTTLE_PLAN, labels: bulk.map((c) => c.label) }, ['IN', 'US'], s.hooks);
  const serial = await s.facts();
  await productSpecification(w, GBT02_PRODUCT.productCode);
  const lot = await finishedLot(w, order, BOTTLE_PLAN.packs);
  for (const b of [batch, order]) await reviewRecord(w, b.batchId);

  // The L3 mirror fails closed: an hour and a minute without a synchronisation (its bound is an hour), the US release item
  // of the serial reconciliation names the stale mirror; the next synchronisation clears it.
  advanceMinutes(61);
  const problem = (await w.server.db.app.query<{ p: string | null }>('select tab.l3_release_problem($1) as p', [order.batchId])).rows[0]?.p ?? null;
  const item = (await w.server.db.app.query<{ r: Json }>('select tab.grel_recon_serial($1) as r', [order.batchId])).rows[0]?.r ?? {};
  await cx.sync();
  const after = (await w.server.db.app.query<{ p: string | null }>('select tab.l3_release_problem($1) as p', [order.batchId])).rows[0]?.p ?? null;
  const staleMirror = { problem, grelSerial: String(item['status'] ?? JSON.stringify(item)), after };

  const released = await manufacturerRelease(w, lot.lotId);
  // The US quality-control unit's disposition on G-REL for the US (the serial reconciliation green on a fresh L3 mirror).
  const qcu = await w.server.asPersona('usQcu');
  const usGrel = ok(await qcu.call(routes.release.grel, { params: { lotId: lot.lotId }, query: { market: 'US' } }), 'G-REL for the US');
  const us = await signAct(w, qcu, 'usQcu', { kind: 'RELEASE_ACT', act: 'US_DISPOSE', lotId: lot.lotId, input: { usDecision: 'RELEASE', expectedEpoch: usGrel.epoch } });
  if (!us.ok) throw new Error(`the US disposition was refused: ${JSON.stringify(refusalOf(us))}`);
  const disposition = (await w.server.db.app.query<{ s: string }>("select recipe.disposition_state($1, 'US') as s", [lot.lotId])).rows[0]?.s ?? '';

  // The ERP's distribution records of the lot, on its feed.
  const shippedAt = await dbNowUs(w);
  for (const sh of SHIPMENTS) {
    const r = await cx.sim('ERP').call('POST', '/shipments', { ...sh, lotNumber: lot.lotCode, quantity: { value: sh.quantity, unit: 'packs' }, shippedAt, quarantine: false });
    if (r.status !== 201) throw new Error(`the ERP simulator refused a shipment: ${JSON.stringify(r.body)}`);
  }
  await cx.sync();
  const shipments = (await w.server.db.app.query<{ r: Json }>(
    "select jsonb_build_object('shipmentNo', shipment_no, 'market', market, 'consignee', consignee_code, 'quantity', quantity::text, 'unit', unit) as r from site.erp_shipment where lot_id = $1 order by shipment_no",
    [lot.lotId],
  )).rows.map((r) => r.r);

  // The mock recall from the API lot: QA runs it, the AP signs it off.
  advanceMinutes(5);
  const api = (await w.server.db.app.query<{ id: string }>("select id from site.material_lot where lot_code = 'GBT2-EXF-001'")).rows[0]?.id ?? '';
  const qa = await w.server.asPersona('qaInvestigator');
  const recall = valueOf(await qa.call(routes.recall.run, { body: { subjectKind: 'LOT', subjectId: api, authorityInformed: false } }));
  const ap = await w.server.asPersona('qcuAuthoriser');
  const signOff: SignableAction = { kind: 'MOCK_RECALL_SIGN_OFF', mockRecallId: recall.mockRecallId };
  ok(await signAct(w, ap, 'qcuAuthoriser', signOff), 'the mock recall sign-off');
  const signed = valueOf(await qa.call(routes.recall.mockRecall, { params: { mockRecallId: recall.mockRecallId } }));
  return {
    order, lot, grel: released.grel, decision: released.decision,
    us: { grel: usGrel.items.map((i) => `${i.id} ${i.status}`), disposition },
    serial: { ...serial, staleMirror }, shipments, recall: signed as unknown as Json,
  };
}

