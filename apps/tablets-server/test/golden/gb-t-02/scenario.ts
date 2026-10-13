/**
 * The GB-T-02 scenario (Phase 4 slice 7b; D-P4-15): the GB-T-02 masters approved (direct compression and HDPE bottle,
 * each authorised for India, the US and the EU), one batch planned for India that dispenses the cellulose lot released
 * on the India-only vendor-history route, compressed into its bulk containers and released for packing; one bottle order
 * packing that bulk; the records reviewed, the finished lot tested, sampled and released by the AP for India; then QA's
 * addition of the US to the lot, signed with its market-add evaluation, which is UNMET_FINAL on the recorded evidence
 * (the identity test had to precede the use: INELIGIBLE), and the US disposition refused.
 */
import { routes } from '@ebmr/api-contract';
import { GBT02_BOM, GBT02_BATCH_KG, GBT02_LOTS, GBT02_PRODUCT, GBT02_VENDOR_LOT } from '../../../src/features/execution/seed-gb-t-02.ts';
import { BOTTLE_SIZE_ID, BOTTLES, BOTTLES_KG, bottleMasterContent, dcMasterContent, GBT02_SIZE_ID } from '../../../src/cli/golden-gb-t-02.ts';
import { refusalOf } from '../../esig/support.ts';
import { GoldenBatch, ok, signAct } from '../gb-t-01/driver.ts';
import { approveMaster, postOrder, type PackMaster } from '../gb-t-01/packing.ts';
import { clean, UNITS } from '../gb-t-01/plant.ts';
import { finishedLot, manufacturerRelease, productSpecification, reviewRecord } from '../gb-t-01/release.ts';
import { asPersona, SITE, type GoldenWorld } from '../gb-t-01/world.ts';
import { bottleOrder, setUpBottleLine, type BottleRun } from './bottling.ts';
import { blending, compression, dispensing, TOOLING_SET } from './stages.ts';

type Json = Record<string, unknown>;

/** The bottle order's worksheet (README.md). */
export const BOTTLE_PLAN: Omit<BottleRun, 'labels'> = {
  label: { issued: '3250', used: '3200', codedDestroyed: '20', uncodedReturned: '26', specimens: '4' },
  carton: { issued: '3250', used: '3200', codedDestroyed: '10', uncodedReturned: '36', specimens: '4' },
  bottles: { good: '3200', rejects: '4' },
  packs: '3200',
  perShipper: '100',
  tabletsIssued: '97500',
  tabletsPacked: '96000',
};
export const COMPRESSION = {
  checks: { L: ['4002.0', '3998.0', '4001.0'], R: ['4001.0', '3999.0', '4003.0'] },
  containers: { L: ['3.250', '3.250', '3.250'], R: ['3.250', '3.250', '3.250'] },
  good: '19.500',
  residue: '0.150',
  rejects: '0.200',
};
export const BLEND = '19.880';

export interface Gbt02Masters {
  dc: PackMaster;
  bottle: PackMaster;
}

/** The plant items of GB-T-02 (the product, its tooling) and its bottle line; the two masters approved and authorised. */
export async function setUpGbt02(w: GoldenWorld): Promise<Gbt02Masters> {
  const st = (w.b['steward'] = await w.server.asPersona('steward'));
  await asPersona(w.server, st, 'steward', (c) => c.query('select plant.define_product($1::jsonb)', [JSON.stringify({ code: GBT02_PRODUCT.productCode, name: GBT02_PRODUCT.productName, highlyPotent: false })]), {
    reasonCode: 'NEW_PRODUCT', reasonText: 'GB-T-02 in the plant product list',
  });
  ok(
    await st.call(routes.plant.defineToolingSet, {
      body: { code: TOOLING_SET, product: GBT02_PRODUCT.productCode, type: 'B', shape: 'Round 8 mm flat bevelled', upperEmbossing: 'F100', lowerEmbossing: 'PLAIN', score: 'NONE', tips: 1, upperPunches: 45, lowerPunches: 45, dies: 45, strokeLimit: '5000000' },
    }),
    'the GB-T-02 tooling set',
  );
  await setUpBottleLine(w);
  const dc = await approveMaster(w, dcMasterContent('GBT02-100-DC'), {
    changeRecord: 'CC-GBT02-001', title: 'New product GB-T-02 direct compression (invented)', riskAssessment: 'RA-GBT02-001', rationaleRef: 'QRM-GBT02-IPC',
    validationRef: 'VR-GBT02', sandboxRun: 'SBX-GBT02-001', sizeId: GBT02_SIZE_ID, markets: ['IN', 'US', 'EU'],
    numbering: { ruleCode: 'GBT02-PROC', productCode: GBT02_PRODUCT.productCode, kind: 'PROCESSING', format: 'GBS{YY}{SEQ:4}' },
  });
  const bottle = await approveMaster(w, bottleMasterContent('GBT02-100-BT30'), {
    changeRecord: 'CC-GBT02-002', title: 'New pack GB-T-02 HDPE bottle of 30 (invented)', riskAssessment: 'RA-GBT02-002', rationaleRef: 'QRM-GBT02-IPC',
    validationRef: 'VR-GBT02-PK', sandboxRun: 'SBX-GBT02-BT-001', sizeId: BOTTLE_SIZE_ID, markets: ['IN', 'US', 'EU'],
    numbering: { ruleCode: 'GBT02-PACK', productCode: GBT02_PRODUCT.productCode, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' },
  });
  await postOrder(w, {
    orderNo: 'PO-GBT02-0001', siteCode: SITE, productCode: GBT02_PRODUCT.productCode, strength: GBT02_PRODUCT.strength, batchSize: GBT02_BATCH_KG, batchSizeUnit: 'kg',
    bom: GBT02_BOM.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' })), erpReference: 'SAP-PP-PO-GBT02-0001',
  });
  await postOrder(w, {
    orderNo: 'PO-GBT02-PK-0001', siteCode: SITE, productCode: GBT02_PRODUCT.productCode, strength: GBT02_PRODUCT.strength, batchSize: '96000', batchSizeUnit: '{tbl}',
    bom: [{ materialCode: BOTTLES, quantity: BOTTLES_KG, unit: 'kg' }], erpReference: 'SAP-PP-PO-GBT02-PK-0001',
  });
  return { dc, bottle };
}

/** The lots the batch reserves: the identity-tested ones but the cellulose, which is the vendor-history lot. */
const LOTS = [...GBT02_LOTS.filter((l) => l.materialCode !== 'MAT-MCC-102'), GBT02_VENDOR_LOT];
const RESERVE = { 'MAT-EXF': '10.000', 'MAT-MCC-102': '8.400', 'MAT-CCS': '1.000', 'MAT-SIO2': '0.200', 'MAT-MGST': '0.400' };

/** The GB-T-02 batch for India from dispensing to the release for packing. Returns the batch and its bulk containers. */
export async function runBatch(w: GoldenWorld, m: Gbt02Masters): Promise<{ batch: GoldenBatch; bulk: { id: string; label: string }[] }> {
  w.b['technician1'] = await w.server.asPersona('technician1');
  w.b['technician2'] = await w.server.asPersona('technician2');
  for (const u of [UNITS.BLENDER, UNITS.PRESS]) await clean(w, 'EQUIPMENT', u.code);
  for (const room of ['DISP-1', 'BLEND-1', 'COMP-1']) await clean(w, 'AREA', room);
  const g = await GoldenBatch.plan(w, { familyId: m.dc.familyId, markets: ['IN'], batchSize: GBT02_SIZE_ID });
  await g.issue('100000');
  await g.reserveLots(RESERVE, LOTS);
  await dispensing(g);
  const { blendLabel } = await blending(g, BLEND);
  const bulk = await compression(g, { blendLabel, ...COMPRESSION });
  return { batch: g, bulk };
}

export interface Gbt02Release {
  order: GoldenBatch;
  lot: { lotId: string; lotCode: string };
  grel: Json;
  decision: string;
  usAdd: Json;
  usDisposition: string;
  usDispose: string;
}

/** The bottle order, the reviews, the finished lot and its release for India; then the US addition (INELIGIBLE). */
export async function packAndRelease(w: GoldenWorld, m: Gbt02Masters, batch: GoldenBatch, bulk: { id: string; label: string }[]): Promise<Gbt02Release> {
  const order = await bottleOrder(w, m.bottle, batch, 'PO-GBT02-PK-0001', { ...BOTTLE_PLAN, labels: bulk.map((c) => c.label) });
  // QC tests the lot and pulls its reserve samples before QA reviews the records (nothing changes after the review).
  await productSpecification(w, GBT02_PRODUCT.productCode);
  const lot = await finishedLot(w, order, BOTTLE_PLAN.packs);
  for (const b of [batch, order]) await reviewRecord(w, b.batchId);
  const released = await manufacturerRelease(w, lot.lotId);
  // The US added to the released lot under a change record: QA signs the addition with its market-add evaluation.
  const qa = await w.server.asPersona('qaApprover2');
  const cr = (await w.server.db.app.query<{ id: string }>("select id from recipe.change_record where number = 'CC-GBT02-001'")).rows[0]?.id ?? '';
  ok(await signAct(w, qa, 'qaApprover2', { kind: 'RELEASE_ACT', act: 'MARKET_ADD', lotId: lot.lotId, input: { market: 'US', changeRecordId: cr } }), 'the US addition');
  const added = (await w.server.db.app.query<{ e: Json }>("select evaluation as e from recipe.market_change where subject_kind = 'LOT' and subject_id = $1 and market = 'US'", [lot.lotId])).rows[0]?.e ?? {};
  const items = ((added['items'] as Json[] | undefined) ?? []).map((i) => `${String(i['id'])} ${String(i['outcome'])}`);
  const state = (await w.server.db.app.query<{ s: string }>("select recipe.disposition_state($1, 'US') as s", [lot.lotId])).rows[0]?.s ?? '';
  // The US quality-control unit's disposition is refused on that evidence.
  const qcu = await w.server.asPersona('usQcu');
  const usGrel = ok(await qcu.call(routes.release.grel, { params: { lotId: lot.lotId }, query: { market: 'US' } }), 'G-REL for the US');
  const us = await signAct(w, qcu, 'usQcu', { kind: 'RELEASE_ACT', act: 'US_DISPOSE', lotId: lot.lotId, input: { usDecision: 'RELEASE', expectedEpoch: usGrel.epoch } });
  const usDispose = us.ok ? 'ok' : ((refusalOf(us as never) as { code?: string } | null)?.code ?? 'refused');
  return { order, lot, grel: released.grel, decision: released.decision, usAdd: { outcome: added['outcome'], items }, usDisposition: state, usDispose };
}
