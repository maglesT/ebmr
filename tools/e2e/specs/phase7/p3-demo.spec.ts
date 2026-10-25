/**
 * Phase 7 slice 7s (requirement R8, limited to P3 by the owner on 25 October 2026): the presenter's GMP batch of
 * "Rabeprazole sodium 20 mg gastro-resistant tablets" (invented data) from the state the demo set-up loads
 * (`pnpm demo:setup --with-gmp-samples`, set-up option --gmp-p3-demo, cli/demo-p3.ts): the product master, its licence
 * endorsement, the approved specifications (the product's with the two-stage dissolution as one profile test), the
 * released lots of the active and of the printed foil and carton, the approved processing master with its three coats
 * and the cold-form packaging master, both authorised for India, the numbering rules and the tooling set.
 *
 * Nothing is arranged in the database: the presenter starts at the ERP order and runs the batch on the screens, as the
 * own-p3 group's Rabeprazole 6 to 12 do on the product they build on screen, with the same helpers
 * (own-product-gmp-flow.ts, `processingRun` and `packagingRun` of own-product-floor.ts, the floor plan of
 * own-product-p3-plan.ts):
 *   1. the numbering rules listed; the ERP simulator sends the processing order; the batch planned and issued; stores
 *      reserve the lots;
 *   2. the processing on the GMP kiosks with the seal, enteric and top coats and the acid-then-buffer disintegration;
 *   3. the packaging order sent, planned from the batch released for packing, issued and run on KIOSK-PACK-2;
 *   4. the finished lot posted; QC's assay and both stages of the dissolution, the reserve sample; the head of QC approves;
 *   5. both records reviewed and the lot released on a checklist on which the two-stage dissolution is one green line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, signIn, test, type E2eWorld } from '../../fixtures/index.ts';
import { officeSign } from '../../fixtures/slice6.ts';
import { home, load, loadProduct, saveProduct, type ProductState } from './own-product-flow.ts';
import { closeFloor, packagingRun, processingRun, type Floor } from './own-product-floor.ts';
import {
  approveResults, openLot, planAndIssue, planPackaging, postFinishedLot, pullReserveSample, recordProfile, recordResults, releaseFinishedLot, reserveLots, sendOrder,
} from './own-product-gmp-flow.ts';
import { RESERVE, rabeprazolePlan } from './own-product-p3-plan.ts';
import { reviewRecord } from './kiosk-batch-support.ts';

test.describe.configure({ mode: 'serial' });

const KEY = 'p3-demo';
const PC_STEWARD = 'PC-QA-01';
const PC_QC = 'PC-QC-01';
const PC_PLAN = 'PC-PLAN-04';
const PC_QA2 = 'PC-QA-09';

/** What the demo set-up loaded (`<keys>/gmp-p3-demo.json`, cli/demo-p3.ts P3DemoSeed). */
interface P3Seed {
  product: { code: string; strength: string; name: string };
  active: string;
  printed: { foil: { material: string; artwork: string }; carton: { material: string; artwork: string } };
  lots: { api: string; foil: string; carton: string };
  sharedLots: Record<string, string>;
  tooling: string;
  batchUnits: string;
  processing: { familyCode: string };
  packaging: { familyCode: string };
  profile: { test: string; acid: string; buffer: string };
}

const seeded = (e2e: E2eWorld): P3Seed => {
  const s = JSON.parse(readFileSync(join(e2e.state.keysDir, 'gmp-p3-demo.json'), 'utf8')) as Partial<P3Seed>;
  if (!s.product || !s.lots || !s.processing) throw new Error('the set-up loaded no P3 demo (--gmp-p3-demo)');
  return s as P3Seed;
};
const lotOf = (seed: P3Seed, id: string): string => (id === 'api' ? seed.lots.api : seed.sharedLots[id] ?? '');

test('[INV-01][PR-04][PR-18][IN-18] P3 demo 1: the seeded numbering rules listed; the ERP simulator sends the processing order; the batch planned and issued from the seeded master; stores reserve the seeded lots @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(15 * 60_000);
  const seed = seeded(e2e);
  const s: ProductState = { tag: 'DEMO', product: seed.product, familyCode: seed.processing.familyCode, packFamilyCode: seed.packaging.familyCode, lots: { ...seed.lots } };
  saveProduct(e2e, KEY, s);
  const base = e2e.url('GMP');
  const st = await officePage('GMP', PC_STEWARD);
  await signIn.office(st, persona('GMP', 'steward'));
  await evidence.step('The presenter shows the product\'s numbering rules at SITE-1 (processing and packaging, IN-18), loaded by the demo set-up', 'Both rules listed on Batch numbers', async () => {
    await home(st, /^Batch numbers/);
    await expect(st.getByTestId('rule-RAB-PROC-DEMO')).toContainText('RAB{YY}{SEQ:3}');
    await expect(st.getByTestId('rule-RAB-PACK-DEMO')).toContainText('{PARENT}/P{SEQ:2}');
  }, st);
  await st.context().close();
  const op = await officePage('GMP', PC_PLAN);
  await signIn.office(op, e2e.seeds.GMP.bootstrap.admin as unknown as Parameters<typeof signIn.office>[1]);
  await evidence.step('The ERP simulator sends a processing order of the product', 'A new order number; it waits on the planning screen', async () => {
    s.processingOrder = await sendOrder(op, s.product.name, 'processing');
    saveProduct(e2e, KEY, s);
    return { order: s.processingOrder };
  }, op);
  await op.context().close();
  const issuer = persona('GMP', 'issuer');
  const ip = await officePage('GMP', PC_PLAN);
  await signIn.office(ip, issuer);
  await evidence.step('The batch issuer plans the batch on SITE-1 line L1 from the approved master with three coats and issues it', 'The batch takes its number from the register and is ISSUED', async () => {
    const b = await planAndIssue(ip, base, s.processingOrder ?? '', new RegExp(`MBR ${seed.processing.familyCode}`), seed.batchUnits, issuer);
    s.batchNumber = b.batchNumber;
    s.batchId = b.batchId;
    saveProduct(e2e, KEY, s);
    return b;
  }, ip);
  await ip.context().close();
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores reserve each lot for the batch: the active\'s own released lot, the shared excipients and the enteric coating system', 'Each lot lists the open reservation', async () => {
    await reserveLots(sp, s.batchNumber ?? '', Object.entries(RESERVE).map(([id, q]) => [lotOf(seed, id), q] as const));
  }, sp);
});

test('[DI-30][INV-40][PR-20][IN-13][IN-35][IN-37] P3 demo 2: the GMP batch processed on the kiosks: dispensing from the active\'s seeded lot, granulation, blending, compression with the seeded tooling, the seal, enteric and top coats, inspection; QA\'s hold points; the bulk for packing @office', async ({ e2e, persona, evidence, browser }) => {
  test.setTimeout(90 * 60_000);
  const seed = seeded(e2e);
  const s = loadProduct(e2e, KEY);
  const floor: Floor = {
    e2e, browser, inst: 'GMP', batchId: s.batchId ?? '', batchNumber: s.batchNumber ?? '',
    persona: (k) => persona('GMP', k), containers: (s.gmpContainers ??= {}), save: () => saveProduct(e2e, KEY, s),
  };
  await evidence.step('GMP floor: the whole processing with the three coats on the kiosks, each person by the Tap button of the demo reader', 'Every stage signed off; H-COAT and H-PACK approved by QA; a 1,000-tablet bulk container', async () => {
    try {
      await processingRun(floor, rabeprazolePlan((id) => lotOf(seed, id), seed.active, new RegExp(seed.tooling)));
    } finally {
      await closeFloor();
    }
    return { bulk: floor.containers['bulk'] ?? '' };
  });
});

test('[IN-38][PR-37][PR-33][PR-34][PR-36][INV-40][DI-30] P3 demo 3: the packaging order sent, planned from the batch released for packing and issued on the seeded cold-form master; the laminate reserved; the order run on KIOSK-PACK-2 with the seeded printed lots @office', async ({ e2e, officePage, persona, evidence, browser }) => {
  test.setTimeout(60 * 60_000);
  const seed = seeded(e2e);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const op = await officePage('GMP', PC_PLAN);
  await signIn.office(op, e2e.seeds.GMP.bootstrap.admin as unknown as Parameters<typeof signIn.office>[1]);
  await evidence.step('The ERP simulator sends a packaging order of the product', 'A new order number; it waits on the planning screen', async () => {
    s.packagingOrder = await sendOrder(op, s.product.name, 'packaging');
    saveProduct(e2e, KEY, s);
    return { order: s.packagingOrder };
  }, op);
  await op.context().close();
  const issuer = persona('GMP', 'issuer');
  const ip = await officePage('GMP', PC_PLAN);
  await signIn.office(ip, issuer);
  await evidence.step('The batch issuer plans the packaging order of the batch released for packing and issues it', 'The order takes the packaging number of the batch and is ISSUED', async () => {
    const o = await planPackaging(ip, base, s.packagingOrder ?? '', s.batchNumber ?? '', issuer);
    s.orderNumber = o.orderNumber;
    s.orderId = o.orderId;
    saveProduct(e2e, KEY, s);
    return o;
  }, ip);
  await ip.context().close();
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores reserve the cold-form laminate for the order', 'The lot lists the open reservation', async () => {
    await reserveLots(sp, s.orderNumber ?? '', [['RTW-ACF-001', '0.500']]);
  }, sp);
  const floor: Floor = {
    e2e, browser, inst: 'GMP', batchId: s.orderId ?? '', batchNumber: s.orderNumber ?? '',
    persona: (k) => persona('GMP', k), containers: (s.packContainers ??= {}), save: () => saveProduct(e2e, KEY, s),
  };
  await evidence.step('GMP floor: the cold-form packaging order on KIOSK-PACK-2', 'The packaging stage is signed off and the order is complete', async () => {
    try {
      await packagingRun(floor, {
        formingLot: 'RTW-ACF-001', bulk: s.gmpContainers?.['bulk'] ?? '',
        foil: { material: seed.printed.foil.material, lot: seed.lots.foil, artwork: seed.printed.foil.artwork },
        carton: { material: seed.printed.carton.material, lot: seed.lots.carton, artwork: seed.printed.carton.artwork },
      });
    } finally {
      await closeFloor();
    }
  });
});

test('[IN-05][PR-45][DI-35][IN-33] P3 demo 4: the finished lot posted in quarantine; QC records the assay and both stages of the dissolution against the seeded specification and pulls the reserve sample; the head of QC approves them @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(15 * 60_000);
  const seed = seeded(e2e);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const { test: profile, acid, buffer } = seed.profile;
  const sp = await officePage('GMP', PC_PLAN);
  await signIn.office(sp, persona('GMP', 'stores'));
  await evidence.step('Stores post the finished packs of the order as its lot, in quarantine', 'The lot of the order is listed', async () => {
    s.lotId = await postFinishedLot(sp, base, s.orderId ?? '', s.orderNumber ?? '', '10');
    s.lotCode = s.orderNumber ?? '';
    saveProduct(e2e, KEY, s);
    return { lot: s.lotCode };
  }, sp);
  const qc = await officePage('GMP', PC_QC);
  await signIn.office(qc, persona('GMP', 'qcAnalyst'));
  await evidence.step('QC records the assay, the acid stage (3 %, at most 10 %) and the buffer stage (86 %, at least 75 %) of the lot and pulls its reserve samples', 'Every result PASS; the profile waits for the approval; the reserve sample is listed', async () => {
    await openLot(qc, s.lotCode ?? '');
    await recordResults(qc, [['ASSAY', '99.1']]);
    await recordProfile(qc, profile, [[acid, '3'], [buffer, '86']]);
    await expect(qc.getByTestId(`profile-${profile}`)).toHaveAttribute('data-status', 'OPEN');
    await pullReserveSample(qc, s.lotCode ?? '');
  }, qc);
  const hq = await officePage('GMP', PC_QC);
  await signIn.office(hq, persona('GMP', 'qcApprover'));
  await evidence.step('The head of QC approves the assay and both stages', 'Every result APPROVED by a second person; the two-stage dissolution is PASS', async () => {
    await openLot(hq, s.lotCode ?? '');
    await approveResults(hq, ['ASSAY', [profile, acid], [profile, buffer]], persona('GMP', 'qcApprover'));
    await expect(hq.getByTestId(`profile-${profile}`)).toHaveAttribute('data-status', 'PASS');
  }, hq);
});

test('[INV-05][IN-05][DI-25][INV-48][PR-45] P3 demo 5: both records reviewed and the lot released by the authorised person on a checklist with no red item, the two-stage dissolution one green line @office', async ({ e2e, officePage, persona, evidence }) => {
  test.setTimeout(40 * 60_000);
  const s = loadProduct(e2e, KEY);
  const base = e2e.url('GMP');
  const head = persona('GMP', 'head1');
  const qa = persona('GMP', 'qaInvestigator');
  const qa2 = persona('GMP', 'qaApprover2');
  const production = await officePage('GMP', PC_PLAN);
  await signIn.office(production, head);
  const qaPage = await officePage('GMP', PC_QA2);
  await signIn.office(qaPage, qa);
  const qa2Page = await officePage('GMP', PC_QA2);
  await signIn.office(qa2Page, qa2);
  const pages = { production, qa: qaPage, qa2: qa2Page };
  const people = { head, qa, qa2 };
  await evidence.step('The processing record reviewed', 'The processing batch is QA reviewed', async () => ({ concluded: await reviewRecord(e2e, pages, people, s.batchId ?? '') }), qa2Page);
  await evidence.step('The packaging record reviewed', 'The packaging order is QA reviewed', async () => ({ concluded: await reviewRecord(e2e, pages, people, s.orderId ?? '') }), qa2Page);
  await evidence.step('QA signs the delta audit-trail review of the processing record if one became due', 'The processing record is covered by its last signed mark', async () => {
    await load(qaPage, `${base}/review/${s.batchId ?? ''}`);
    const panel = qaPage.getByTestId('audit-trail-review');
    await expect(panel.getByTestId('audit-trail-marks')).toBeVisible();
    const button = panel.getByRole('button', { name: 'Sign the delta review' });
    if ((await button.count()) > 0 && (await button.isEnabled())) {
      await button.click();
      await officeSign(qaPage, /^Delta review /, qa);
    }
    await expect(panel.getByText('Covered by the last signed mark')).toBeVisible();
  }, qaPage);
  const cockpit = await officePage('GMP', PC_QA2);
  await signIn.office(cockpit, persona('GMP', 'qcuAuthoriser'));
  await evidence.step('The authorised person releases the lot: ready, no red item, the two-stage dissolution one green line (G3.PROFILE_DISSOLUTION), the manufacturer release signed', 'The lot is RELEASED', async () => {
    await releaseFinishedLot(cockpit, s.lotCode ?? '', persona('GMP', 'qcuAuthoriser'), ['G3.PROFILE_DISSOLUTION']);
    return { lot: s.lotCode ?? '', state: 'RELEASED' };
  }, cockpit);
});
