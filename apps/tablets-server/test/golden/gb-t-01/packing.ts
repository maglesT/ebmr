/**
 * GB-T-01 continued to its packaging (Phase 4 slice 7b; D-P4-15): the packaging line of the plant, the approved blister
 * master, and two blister orders packing the happy variant's bulk with a full line clearance between them. Every act is
 * the persona's, over HTTP where a route exists, else the persona's own database command (the residuals of README.md).
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import { lifecycle } from '@ebmr/recipe-core';
import type { flow } from '@ebmr/recipe-core';
import { passwordActor, personaOf, terminalOf } from '@ebmr/test-kit';
import { GBT01_PRODUCT } from '../../../src/features/execution/seed-gb-t-01.ts';
import {
  BLISTER_ARTWORK_SET, BLISTER_SIZE_ID, BLISTER_UNIT, CARTONER_UNIT, FILM, FILM_KG, PACK_BALANCE, PACK_LINE, blisterMasterContent,
} from '../../../src/cli/golden-packaging.ts';
import type { TestBrowser } from '../../support/harness.ts';
import { dbAs, entry, GoldenBatch, ok, recordPostUseInspection, recordSpecimens, signAct, tick } from './driver.ts';
import { clean } from './plant.ts';
import { asPersona, LINE, signDirect, signOffice, SITE, type GoldenWorld } from './world.ts';

type Json = Record<string, unknown>;

/** The line, its units and its balance, as the steward defines them; qualified, calibrated, cleaned and verified. */
export async function setUpPackLine(w: GoldenWorld): Promise<void> {
  for (const k of ['technician1', 'technician2', 'steward']) w.b[k] = await w.server.asPersona(k); // fresh: earlier sessions may have lapsed
  const st = w.b['steward'] as TestBrowser;
  const p = routes.plant;
  ok(await st.call(p.defineArea, { body: { code: PACK_LINE, kind: 'LINE', name: 'Blister packaging line PL-1' } }), 'line PL-1');
  for (const [code, description] of [['EQC-BLISTER', 'Thermoform blister machine'], ['EQC-CARTONER', 'Cartoner with checkweigher']] as const) {
    ok(await st.call(p.defineEquipmentClass, { body: { code, kind: 'PROCESS', description, cleanHold: '72 hours', dirtyHold: '48 hours' } }), `class ${code}`);
  }
  ok(await st.call(p.defineEquipment, { body: { code: PACK_BALANCE, name: 'Balance of PL-1', classCode: 'EQC-BAL', areaCode: PACK_LINE } }), PACK_BALANCE);
  ok(await st.call(p.defineEquipment, { body: { code: BLISTER_UNIT, name: 'Thermoform blister machine', classCode: 'EQC-BLISTER', areaCode: PACK_LINE } }), BLISTER_UNIT);
  ok(await st.call(p.defineEquipment, { body: { code: CARTONER_UNIT, name: 'Cartoner with checkweigher', classCode: 'EQC-CARTONER', areaCode: PACK_LINE } }), CARTONER_UNIT);
  for (const code of [PACK_BALANCE, BLISTER_UNIT, CARTONER_UNIT]) {
    ok(await st.call(p.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${code}` } }), `the qualification of ${code}`);
  }
  const tech = w.b['technician1'] as TestBrowser;
  await asPersona(w.server, tech, 'technician1', (c) => c.query("select plant.record_calibration($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', $2)", [PACK_BALANCE, `CAL-${PACK_BALANCE}`]));
  const boot = w.seed.bootstrap;
  const admin = await passwordActor(w.server.db, boot.admin, boot.admin.fingerprint, { reasonCode: 'DEVICE_REGISTRATION', reasonText: 'Balance of the packaging line', correlationId: randomUUID() });
  await identity.withGuardedCommand(w.server.db.app, { ...admin, correlationId: randomUUID() }, (c) =>
    c.query("select iam.register_device($1, 'INSTRUMENT', 'SITE-1', $2, null, $3, $4)", [PACK_BALANCE, PACK_LINE, createHash('sha256').update(`${PACK_BALANCE}:${randomUUID()}`).digest('hex'), 'Balance of PL-1 (not interfaced)']),
  );
  await cleanLine(w);
}

/** The line's units and the line cleaned (MAJOR) and verified. */
export async function cleanLine(w: GoldenWorld, level: 'MINOR' | 'MAJOR' = 'MAJOR'): Promise<void> {
  // Fresh sessions: the earlier ones idle out while a packaging order runs.
  for (const k of ['technician1', 'technician2']) w.b[k] = await w.server.asPersona(k);
  for (const code of [BLISTER_UNIT, CARTONER_UNIT]) await clean(w, 'EQUIPMENT', code, level);
  await clean(w, 'AREA', PACK_LINE, level);
}

export interface PackMaster {
  familyId: string;
  versionId: string;
  content: flow.MbrContent;
}

export interface MasterSpec {
  /** Change record, risk assessment and sandbox run numbers, and the validation report the change cites. */
  changeRecord: string;
  title: string;
  riskAssessment: string;
  rationaleRef: string;
  validationRef: string;
  sandboxRun: string;
  /** The batch size the market authorisations name, and the markets (each authorised by QA and regulatory). */
  sizeId: string;
  markets: readonly string[];
  /** The numbering rule of the product and kind, when the master brings one. */
  numbering?: { ruleCode: string; productCode: string; kind: 'PROCESSING' | 'PACKAGING'; format: string };
}

/**
 * A master as the site approves it: the author defines it (no "choose a product" template for these masters: the
 * author's own database command), QA's change record and risk assessment, the draft attributes and the sandbox
 * evidence, the verification through the route, the four signatures (MBR_TRANSITION), a market authorisation per
 * market (QA and regulatory) and the numbering rule.
 */
export async function approveMaster(w: GoldenWorld, content: flow.MbrContent, spec: MasterSpec): Promise<PackMaster> {
  for (const k of ['author', 'approver', 'checker', 'regulatory', 'steward']) w.b[k] = await w.server.asPersona(k);
  const author = w.b['author'] as TestBrowser;
  const qa = w.b['approver'] as TestBrowser;
  const familyId = await asPersona(w.server, author, 'author', (c) => lifecycle.defineFamily(c, lifecycle.familyOf(content)));
  const versionId = (await asPersona(w.server, author, 'author', (c) => lifecycle.createVersion(c, familyId, content, spec.title))).versionId;
  const cr = await asPersona(w.server, qa, 'approver', (c) =>
    lifecycle.recordChangeRecord(c, { number: spec.changeRecord, title: spec.title, changeClass: 'MAJOR', processImpacting: true, validationRef: spec.validationRef }),
  );
  const ra = await asPersona(w.server, qa, 'approver', (c) =>
    lifecycle.recordRiskAssessment(c, { code: spec.riskAssessment, version: '1', title: `${spec.title}: risk assessment`, riskClass: 'MEDIUM', rationaleRef: spec.rationaleRef }),
  );
  await asPersona(
    w.server,
    author,
    'author',
    async (c) => {
      await lifecycle.setDraftAttributes(c, versionId, { changeRecordId: cr, effectiveFrom: '2026-01-01T00:00:00Z', reviewDue: '2028-12-31' });
      await lifecycle.linkRiskAssessment(c, versionId, ra);
    },
    { reasonCode: 'NEW_MASTER', reasonText: `${spec.title}: change record, review date and risk assessment` },
  );
  const stored = (await lifecycle.loadContent(w.server.db.app, versionId)).content;
  await asPersona(w.server, author, 'author', (c) =>
    lifecycle.recordEvidence(c, versionId, 'SANDBOX_RUN', lifecycle.sandboxRunEvidence(stored, { runId: spec.sandboxRun, sandbox: 'ebmr_sandbox_tablets', coverage: { steps: '100%' }, passed: true })),
  );
  const head = ok(await author.call(routes.designer.version, { params: { versionId } }), 'the version');
  const started = ok(await author.call(routes.designer.startVerification, { params: { versionId }, body: { baseRevision: head.revision } }), 'the start of the verification');
  // The start of the verification records the validator report, the sealed verification and the test vectors (D-P7R-16).
  const t = (transition: 'SUBMIT' | 'CHECK' | 'APPROVE' | 'REGULATORY_CONFIRM'): SignableAction => ({ kind: 'MBR_TRANSITION', versionId, transition, baseRevision: started.revision });
  for (const [key, tr] of [['author', 'SUBMIT'], ['checker', 'CHECK'], ['regulatory', 'REGULATORY_CONFIRM'], ['approver', 'APPROVE']] as const) {
    ok(await signOffice(w.seed, w.b[key] as TestBrowser, key, t(tr)), `${tr} of ${spec.title}`);
  }
  for (const market of spec.markets) {
    const def: lifecycle.MarketAuthorisationDefinition = { versionId, market, kind: 'CURRENT', cells: [{ site: SITE, line: LINE, batch_size: spec.sizeId }], regulatoryBasis: `${market}: registration on file (invented product)` };
    const maId = await asPersona(w.server, qa, 'approver', (c) => lifecycle.proposeMarketAuthorisation(c, def));
    const qaSig = await signDirect(w.server, w.seed, 'approver', lifecycle.MARKET_AUTHORISATION_AGGREGATE, maId, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
    const regSig = await signDirect(w.server, w.seed, 'regulatory', lifecycle.MARKET_AUTHORISATION_AGGREGATE, maId, 'REGULATORY_CONFIRMED', 'PROPOSED');
    await asPersona(w.server, qa, 'approver', (c) => lifecycle.activateMarketAuthorisation(c, maId, qaSig, regSig), { reasonCode: 'MARKET_AUTHORISED', reasonText: `${market}: ${spec.title} authorised at SITE-1 L1` });
  }
  const n = spec.numbering;
  if (n) {
    await asPersona(
      w.server,
      w.b['steward'] as TestBrowser,
      'steward',
      (c) =>
        c.query('select site.define_batch_number_rule($1::jsonb)', [
          JSON.stringify({ rule_code: n.ruleCode, site_code: SITE, product_code: n.productCode, batch_kind: n.kind, format: n.format, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
        ]),
      { reasonCode: 'NEW_PRODUCT', reasonText: `Numbering of ${n.productCode} (${n.kind.toLowerCase()})` },
    );
  }
  return { familyId, versionId, content };
}

/** The blister master of GB-T-01, approved and authorised for India, with the packaging numbering of the product. */
export async function approveBlisterMaster(w: GoldenWorld): Promise<PackMaster> {
  return approveMaster(w, blisterMasterContent('GBT01-250-BL10'), {
    changeRecord: 'CC-GBT01-002', title: 'New pack GB-T-01 Alu-PVC blister 10 x 10 (invented)', riskAssessment: 'RA-GBT01-002', rationaleRef: 'QRM-GBT01-LEAK',
    validationRef: 'VR-GBT01-PK', sandboxRun: 'SBX-GBT01-BL-001', sizeId: BLISTER_SIZE_ID, markets: ['IN'],
    numbering: { ruleCode: 'GBT01-PACK', productCode: GBT01_PRODUCT.productCode, kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}' },
  });
}

/** The ERP interface posts a production order (its own route and service identity). */
export async function postOrder(w: GoldenWorld, order: Record<string, unknown>): Promise<void> {
  const erp = w.seed.services.find((s) => s.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(w.seed, erp.terminal).fingerprint };
  ok(await w.server.browser().call(routes.quality.erpImport, { body: { ...creds, catalogue: { products: [], materials: [], orders: [order as never] } } }), `the order ${String(order['orderNo'])}`);
}

/** The ERP interface posts a packaging order of the blister master (its BOM: the forming film). */
export async function postPackOrder(w: GoldenWorld, orderNo: string): Promise<void> {
  await postOrder(w, {
    orderNo, siteCode: SITE, productCode: GBT01_PRODUCT.productCode, strength: GBT01_PRODUCT.strength, batchSize: '98000', batchSizeUnit: '{tbl}',
    bom: [{ materialCode: FILM, quantity: FILM_KG, unit: 'kg' }], erpReference: `SAP-PP-${orderNo}`,
  });
}

/** The accepted tablets of the bulk in drums of `counts` tablets (see README.md: post-hoc, a finding for the lead). */
export async function containerise(g: GoldenBatch, counts: string[]): Promise<{ id: string; label: string }[]> {
  await g.floor('INSP-1');
  const out: { id: string; label: string }[] = [];
  for (const n of counts) {
    const o = await dbAs<{ container_id: string; label_code: string }>(g.w, g.b('operator1'), 'operator1', 'select plant.open_container($1, $2, $3) as r', [g.batchId, 'INSPECTION', 'units']);
    const v = (await g.w.server.db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [o.container_id])).rows[0]?.v;
    await dbAs(g.w, g.b('operator1'), 'operator1', 'select plant.close_container($1, $2::numeric, $3::bigint) as r', [o.container_id, n, v]);
    tick();
    ok(await signAct(g.w, g.b('verifier1'), 'verifier1', { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: o.container_id }), `the verification of ${o.label_code}`);
    out.push({ id: o.container_id, label: o.label_code });
  }
  return out;
}

export interface BlisterRun {
  /** Drum labels issued to the order. */
  labels: string[];
  foil: { issued: string; used: string; setupWaste: string; uncodedReturned: string };
  carton: { issued: string; used: string; codedDestroyed: string; uncodedReturned: string; specimens: string };
  blisters: { formed: string; good: string; setupWaste: string; samples: string; rejects: { emptyPocket: string; brokenPocket: string; vision: string } };
  packs: string;
  tabletsIssued: string;
  tabletsPacked: string;
}

/**
 * A pause of the line's people (two minutes on the golden clock, fifteen seconds of the host's): the terminal's device
 * nonces are rate-limited per minute of the host's clock (DI-19), which the golden clock does not move.
 */
export async function pause(g: GoldenBatch): Promise<void> {
  await new Promise((r) => setTimeout(r, 15_000));
  await g.wait(2);
}

/** One blister order planned on the bulk of `parent`, issued, and run to its end. */
export async function blisterOrder(w: GoldenWorld, m: PackMaster, parent: GoldenBatch, orderNo: string, plan: BlisterRun): Promise<GoldenBatch> {
  const issuer = await w.server.asPersona('issuer');
  const p = ok(
    await issuer.call(routes.planning.planPackagingOrder, { body: { familyId: m.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BLISTER_SIZE_ID, erpOrder: orderNo, parentBatchId: parent.batchId } }),
    `the plan of ${orderNo}`,
  );
  const g = GoldenBatch.of(w, p.batchId, p.batchNumber);
  ok(
    await signAct(w, issuer, 'issuer', { kind: 'GMP_BATCH_ISSUE', batchId: g.batchId, reason: { code: 'PACKING_PLAN', text: `Packaging order of batch ${parent.batchNumber} for the India market` }, variants: {}, inputs: {} }),
    `the issue of ${g.batchNumber}`,
  );
  // Stores reserve the forming film for the order.
  const stores = await w.server.asPersona('stores');
  const film = (await w.server.db.app.query<{ id: string }>("select id from site.material_lot where lot_code = 'GBT-PVC-001'")).rows[0]?.id;
  await dbAs(w, stores, 'stores', "select site.reserve_lot($1, $2, $3, 'TABLETS', $4::numeric, 'kg', clock_timestamp() + interval '30 days') as r", [film, g.batchId, g.batchNumber, FILM_KG]);

  await g.floor('PL-1');
  // The bulk issued to the order (operator2 scans the drums).
  const op2 = g.b('operator2');
  const bulkBody = { labels: plan.labels };
  const { tapFor } = await import('../../esig/support.ts');
  const { tapAdvance } = await import('./driver.ts');
  tapAdvance();
  ok(await op2.call(routes.batches.issueBulk, { params: { batchId: g.batchId }, body: bulkBody, attribution: await tapFor(op2, personaOf(w.seed, 'operator2'), 'POST', `/api/batches/${g.batchId}/bulk`, bulkBody) }), 'the bulk issue');

  const occ = await g.clearAndOccupy('PL-1', 'S-PACK', 'operator2', 'PACKAGING_ORDER', BLISTER_ARTWORK_SET);
  const bal = await g.balanceUse('PL-1', 'operator2');
  const blister = await dbAs<string>(w, g.b('operator2'), 'operator2', `select plant.start_equipment_use($1, $2, clock_timestamp() + make_interval(hours => 12)) as r`, [BLISTER_UNIT, g.batchId]);
  const cartoner = await dbAs<string>(w, g.b('operator2'), 'operator2', `select plant.start_equipment_use($1, $2, clock_timestamp() + make_interval(hours => 12)) as r`, [CARTONER_UNIT, g.batchId]);
  g.uses.set(BLISTER_UNIT, blister);
  g.uses.set(CARTONER_UNIT, cartoner);
  await g.step('p-pk-clear@', { performer: 'operator2', entries: [entry('p-pk-clear@', 'AREA_OCCUPANCY', { areaCode: PACK_LINE, occupancyId: occ })] });
  await g.step('p-pk-status@', {
    performer: 'operator2',
    checker: null,
    entries: [
      entry('p-pk-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: PACK_BALANCE, useId: bal }),
      entry('p-pk-status@', 'EQUIPMENT_USE', { equipmentRef: 'BLISTER', equipmentCode: BLISTER_UNIT, useId: blister }),
      entry('p-pk-status@', 'EQUIPMENT_USE', { equipmentRef: 'CARTONER', equipmentCode: CARTONER_UNIT, useId: cartoner }),
    ],
  });
  const gross = (net: string): string => (Number(net) + 1).toFixed(3);
  await g.step('p-pk-film@', {
    entries: [{ type: 'RECORD_ENTRY', stepKey: 'p-pk-film@', entry: { kind: 'CONTAINER_WEIGHING', item: 'pkFilm', bomLine: 'BOM-PVC', lotCode: 'GBT-PVC-001', manual: { gross: gross(FILM_KG), tare: '1.000', unit: 'kg', deviceCode: PACK_BALANCE } } }],
  });

  await pause(g);
  // The parallel blocks: printed materials issued first, then the line check and the run, leak tests, cartoning.
  const e = (stepKey: string, entryKind: string, data: Json) => g.d.ok('operator2', entry(stepKey, entryKind, data));
  for (const s of ['p-g21@', 'p-tb21c@', 'p-tb22@', 'p-tb24@', 'p-pk-destroy@']) await g.d.ok('operator2', { type: 'START_STEP', stepKey: s });
  const lotFacts = async (code: string): Promise<Json> => (await w.server.db.app.query<{ r: Json }>('select tab.printed_lot_facts($1, $2) as r', [code, g.batchId])).rows[0]?.r ?? {};
  await e('p-g21@', 'ISSUE', { item: 'FOIL', lot: await lotFacts('GBT-ALU-001'), scannedArtwork: 'ART-GBT01-FOIL-1', quantity: { value: plan.foil.issued, unit: '1' } });
  await e('p-g21@', 'ISSUE', { item: 'CARTON', lot: await lotFacts('GBT-CTN-001'), scannedArtwork: 'ART-GBT01-CTN-1', quantity: { value: plan.carton.issued, unit: '1' } });
  // Phase 6 slice 6c (IN-16, PR-16): the coding and label specimens of the printed-materials step.
  await recordSpecimens(g, 'p-g21@', ['FOIL', 'CARTON']);
  await e('p-tb21c@', 'LINE_SETUP', {
    machine: BLISTER_UNIT, artworkSet: BLISTER_ARTWORK_SET, changeParts: ['FORM-TOOL-GBT01', 'SEAL-PLATE-GBT01'],
    materials: [{ role: 'FORMING_FILM', material: FILM, lot: 'GBT-PVC-001' }, { role: 'LIDDING_FOIL', material: 'MAT-ALU-GBT01', lot: 'GBT-ALU-001' }],
  });
  await e('p-tb21c@', 'EQUIPMENT_CHECK', { rogueRemoved: true, changePartsFitted: true, emptyPocketDetector: 'PASS' });
  await g.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-tb21c@' });
  await g.signed('verifier1', { type: 'VERIFY', stepKey: 'p-tb21c@', meaning: 'VERIFIED' });
  await g.d.ok('operator2', { type: 'START_STEP', stepKey: 'p-tb21@' });
  await e('p-tb21@', 'RUN_START', { machine: BLISTER_UNIT });
  await e('p-tb22@', 'RUN_START', { machine: BLISTER_UNIT });
  await e('p-tb21@', 'RECIPE_CHECK', { recipe: 'RCP-BL-GBT01', recipeVersion: '1' });
  for (const [tag, value, unit] of [['blister.form_temp_C', '130.0', 'degC'], ['blister.seal_temp_C', '175.0', 'degC'], ['blister.seal_pressure_bar', '4.00', 'bar'], ['blister.seal_dwell_s', '1.00', 's']] as const) {
    await e('p-tb21@', 'ACTUAL', { tag, value, unit, source: 'MANUAL' });
  }
  await e('p-tb22@', 'LEAK_TEST', { track: 'T1', tested: '10', vacuum: '70', holdSeconds: '45', leaking: '0' });
  await e('p-tb21@', 'DEFECT_CHECK', { examined: '20', defects: {} });
  await e('p-tb24@', 'CHALLENGE', { device: 'CW', trigger: 'START', result: 'PASS' });
  await e('p-tb24@', 'EXAMINATION', { timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true });
  await g.wait(50);
  await e('p-tb21@', 'DEFECT_CHECK', { examined: '20', defects: {} });
  await e('p-tb24@', 'EXAMINATION', { timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true });
  await e('p-tb24@', 'PACKS_MADE', { packs: plan.packs });
  await e('p-tb21@', 'REJECTS', plan.blisters.rejects);
  await e('p-tb21@', 'RUN_END', {});
  await e('p-tb22@', 'RUN_END', {});
  await e('p-tb22@', 'LEAK_TEST', { track: 'T1', tested: '10', vacuum: '70', holdSeconds: '45', leaking: '0' });
  await e('p-tb21@', 'COUNT', { formed: plan.blisters.formed, good: plan.blisters.good, setupWaste: plan.blisters.setupWaste, samples: plan.blisters.samples });
  // Shippers of 20 cartons, each under an SSCC the database issues for the step.
  const shippers = Number(plan.packs) / 70;
  for (let i = 0; i < shippers; i += 1) {
    // The device nonces of one terminal are rate-limited per minute (DI-19): the packer seals shippers at a human pace.
    if (i % 10 === 0) await pause(g);
    tapAdvance();
    const body = {};
    const path = `/api/batches/${g.batchId}/steps/${encodeURIComponent('p-tb24@')}/sscc`;
    const op = g.b('operator2');
    const sscc = ok(await op.call(routes.batches.issueSscc, { params: { batchId: g.batchId, stepKey: 'p-tb24@' }, body, attribution: await tapFor(op, personaOf(w.seed, 'operator2'), 'POST', path, body) }), 'an SSCC');
    await e('p-tb24@', 'SHIPPER', { sscc: (sscc as { sscc: string }).sscc, packs: '70', part: false });
  }
  await e('p-tb24@', 'EXAMINATION', { timing: 'END', examined: '20', defective: '0', labelCorrect: true });
  await e('p-tb24@', 'CHALLENGE', { device: 'CW', trigger: 'END', result: 'PASS' });
  await e('p-tb24@', 'RECONCILIATION', {});
  await e('p-g21@', 'RECONCILIATION', { item: 'FOIL', used: plan.foil.used, setupWaste: plan.foil.setupWaste, damaged: '0', codedDestroyed: '0', uncodedReturned: plan.foil.uncodedReturned, specimens: '0' });
  await e('p-g21@', 'RECONCILIATION', { item: 'CARTON', used: plan.carton.used, setupWaste: '0', damaged: '0', codedDestroyed: plan.carton.codedDestroyed, uncodedReturned: plan.carton.uncodedReturned, specimens: plan.carton.specimens });
  await e('p-pk-destroy@', 'DISPOSAL', { category: 'DESTRUCTION', material: 'MAT-CTN-GBT01', batchCoded: true, quantity: { value: plan.carton.codedDestroyed, unit: '1' }, method: 'Shredding' });
  for (const s of ['p-g21@', 'p-tb21@', 'p-tb22@', 'p-tb24@']) {
    await g.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: s });
    await g.signed('verifier1', { type: 'VERIFY', stepKey: s, meaning: 'VERIFIED' });
  }
  await g.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-pk-destroy@' });
  await g.signed('verifier1', { type: 'VERIFY', stepKey: 'p-pk-destroy@', meaning: 'WITNESSED' });
  // Phase 6 slice 6c (PR-34): printing has ended; the line is inspected after use and a second person verifies it.
  await recordPostUseInspection(g);
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
  await g.release([BLISTER_UNIT, CARTONER_UNIT, PACK_LINE], 'operator2');
  return g;
}
