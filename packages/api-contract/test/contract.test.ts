/**
 * The frozen API contract (Phase 2 apps plan section 4): example fixtures parse, the client intents refuse
 * every browser-supplied fact, decimals never travel as numbers, every engine command is classified, and the
 * route table is well formed.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  allRoutes,
  defineRoute,
  storableText,
  unstorableTextIssues,
  CLIENT_PLAIN_TYPES,
  CLIENT_SIGNED_TYPES,
  ClientEntry,
  ClientIntent,
  DataValueWire,
  DecimalString,
  ENGINE_COMMAND_CLASSES,
  ENGINE_ROLE_MAP,
  NAMESPACE_OWNERS,
  RefusalEnvelope,
  RUN_VERSION_MAX,
  routes,
  SignableAction,
  SignedIntent,
  StepScreenView,
  type ContractProofs,
} from '../src/index.ts';
import { ARCHIVE_ROUTE_IDS, CONTAINER_ROUTE_IDS, DEVIATION_ROUTE_IDS, EXAMPLES, GENEALOGY_ROUTE_IDS, LIMS_ROUTE_IDS, PQR_ROUTE_IDS, QP_SHIPPING_ROUTE_IDS, RECORDS_LOCK_ROUTE_IDS, RELEASE_ROUTE_IDS, REVIEW_ROUTE_IDS, SLICE_6_ROUTE_IDS, STEP_EXAMPLES_BY_BLOCK, example } from '../src/examples.ts';
import { TABLET_ENTRY_KINDS_BY_BLOCK, TabletEntryKind, TYPED_ENTRY_KINDS } from '../src/tablet-entries.ts';

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

describe('example fixtures', () => {
  it('every example parses with its schema, and route examples match their route response', () => {
    for (const [name, e] of Object.entries(EXAMPLES)) {
      const parsed = e.schema.safeParse(e.data);
      expect(parsed.success, `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
      if ('routeId' in e && e.routeId) {
        const route = allRoutes(routes).find((r) => r.id === e.routeId);
        expect(route, name).toBeDefined();
      }
    }
  });

  it('[DI-05] one step-screen example per block of the dc-mini template, each watermarked TEST, NOT GMP', () => {
    expect(Object.keys(STEP_EXAMPLES_BY_BLOCK).sort()).toEqual(['G-03@1', 'G-04@1', 'G-07@1', 'G-08@1', 'G-09@1', 'G-10@1', 'G-17@1', 'G-20@1', 'G-22@1']);
    for (const [block, name] of Object.entries(STEP_EXAMPLES_BY_BLOCK)) {
      const view = StepScreenView.parse(EXAMPLES[name].data);
      expect(view.run.watermark?.text, name).toBe('TEST, NOT GMP');
      expect(view.run.batchNumber, name).toMatch(/^TEST-/);
      if (block !== 'G-17@1') expect(view.step.block, name).toBe(block);
      expect(view.actions.filter((a) => a.primary).length, name).toBeLessThanOrEqual(1);
    }
    expect(example('run').header.watermark?.source).toBe('SANDBOX_TEST_RUN');
  });
});

describe('client intents refuse browser-supplied facts (J1-3, J2-8)', () => {
  const base = { type: 'RECORD_DATA', stepKey: 'p-blend@', item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' } };

  it('[DI-32] a value source is MANUAL or SCAN; DEVICE, AUTOMATION, LIMS and BLOCK are server-set', () => {
    expect(ok(ClientIntent, { ...base, source: { mode: 'MANUAL' } })).toBe(true);
    expect(ok(ClientIntent, { ...base, source: { mode: 'SCAN', code: 'X-1' } })).toBe(true);
    for (const source of [
      { mode: 'DEVICE', device: 'TEST-BAL-01', raw: 'S S 15 kg' },
      { mode: 'AUTOMATION', system: 'PLC-1' },
      { mode: 'LIMS', resultRef: 'LIMS-1' },
      { mode: 'BLOCK', entries: ['E-1'] },
      { mode: 'MANUAL', device: 'TEST-BAL-01' },
    ]) {
      expect(ok(ClientIntent, { ...base, source }), JSON.stringify(source)).toBe(false);
    }
  });

  it('[DI-32][INV-26] no actor, roles, signature, command id or occurredAt trust can be sent', () => {
    const intent = { ...base, source: { mode: 'MANUAL' } };
    for (const extra of [
      { actor: { id: 'x', kind: 'PERSON', roles: ['QA'] } },
      { roles: ['QA'] },
      { signature: { id: 's', meaning: 'PERFORMED', signer: 'x' } },
      { commandId: 'c-1' },
      { occurredAt: { us: '1', trust: 'DEVICE_SYNCED' } },
      { expectedVersion: 1 },
    ]) {
      expect(ok(ClientIntent, { ...intent, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    // Signature-bearing intents are not plain commands.
    expect(ok(ClientIntent, { type: 'SIGN_PERFORMED', stepKey: 'p-blend@' })).toBe(false);
    expect(ok(ClientIntent, { type: 'VERIFY', stepKey: 'p-blend@', meaning: 'VERIFIED' })).toBe(false);
    expect(ok(SignedIntent, { type: 'VERIFY', stepKey: 'p-blend@', meaning: 'VERIFIED', signature: { id: 's' } })).toBe(false);
  });

  it('[DI-32][PR-19] lots travel as codes and weights as reading ids: lot status, expiry, identity, balance and device values are refused', () => {
    const weighing = { kind: 'CONTAINER_WEIGHING', item: 'dispApi', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', tareReadingId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', grossReadingId: '7c2a8d2f-3a4b-4c5d-9e0f-1a2b3c4d5e6f' };
    expect(ok(ClientEntry, weighing)).toBe(true);
    expect(ok(ClientEntry, { ...weighing, tareReadingId: undefined, grossReadingId: undefined, manual: { tare: '1.250', gross: '13.753', unit: 'kg' } })).toBe(true);
    for (const extra of [
      { lot: { id: 'TEST-L26-0101', material: 'MAT-PCM', status: 'RELEASED', identityTested: true } },
      { lotStatus: 'RELEASED' },
      { expiry: '2027-01-01' },
      { identityTested: true },
      { balance: 'TEST-BAL-01' },
      { gross: '13.753' },
      { source: 'DEVICE' },
      { raw: 'S S 13.753 kg' },
    ]) {
      expect(ok(ClientEntry, { ...weighing, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(ok(ClientEntry, { ...weighing, tareReadingId: 'not-a-uuid' })).toBe(false);
    expect(ok(ClientEntry, { kind: 'CHARGE_CONTAINER', containerCode: 'TEST-B26-0001/C-1', scannedBatch: 'TEST-B26-0001' })).toBe(false);
    expect(ok(ClientEntry, { kind: 'CHARGE_LOT', bomLine: 'BOM-PCM', container: 'C', lot: { id: 'L' } })).toBe(false);
  });

  it('[DI-20][DI-30][PR-20] weights keyed by hand may name the balance read, and nothing else about it (review P50)', () => {
    // The server and the database check that the balance named is a scale of the step's room and that none of them is
    // online; its status, the source or the balance as the record states it are never taken from the browser.
    const manual = { tare: '1.250', gross: '13.753', unit: 'kg' };
    const handKeyed = { kind: 'CONTAINER_WEIGHING', item: 'dispApi', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101' };
    expect(ok(ClientEntry, { ...handKeyed, manual })).toBe(true);
    expect(ok(ClientEntry, { ...handKeyed, manual: { ...manual, deviceCode: 'TEST-BAL-00' } })).toBe(true);
    expect(ok(ClientEntry, { kind: 'OUTPUT_CONTAINER', intermediate: 'I-BLEND', manual: { ...manual, deviceCode: 'TEST-BAL-02' } })).toBe(true);
    for (const extra of [{ deviceCode: '' }, { deviceCode: 'X'.repeat(65) }, { status: 'OFFLINE' }, { balance: 'MANUAL' }, { source: 'MANUAL' }]) {
      expect(ok(ClientEntry, { ...handKeyed, manual: { ...manual, ...extra } }), JSON.stringify(extra)).toBe(false);
    }
  });

  it('the signable actions carry only the intent and the reviewed version', () => {
    const action = { kind: 'ENGINE_COMMAND', runId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', expectedVersion: 7, intent: { type: 'SIGN_PERFORMED', stepKey: 'p-blend@' } };
    expect(ok(SignableAction, action)).toBe(true);
    expect(ok(SignableAction, { ...action, actor: { id: 'x' } })).toBe(false);
    expect(ok(SignableAction, { ...action, intent: { type: 'START_STEP', stepKey: 'p-blend@' } })).toBe(false);
  });

  it('[DI-34] the run version a screen sends back is one a run can have: a whole number up to the largest PostgreSQL integer, the type a run\'s version is stored in; the run command and the signed engine command refuse one beyond it as malformed (Phase 2 exit follow-up F58.1)', () => {
    expect(RUN_VERSION_MAX).toBe(2 ** 31 - 1);
    const runId = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    const command = (expectedVersion: number) => ({ expectedVersion, intent: { type: 'START_STEP', stepKey: 'p-blend@' } });
    const signed = (expectedVersion: number) => ({ kind: 'ENGINE_COMMAND', runId, expectedVersion, intent: { type: 'SIGN_PERFORMED', stepKey: 'p-blend@' } });
    const body = routes.execution.command.body;
    if (!body) throw new Error('the run command has no body schema');
    for (const v of [0, 7, RUN_VERSION_MAX]) {
      expect(ok(body, command(v)), String(v)).toBe(true);
      expect(ok(SignableAction, signed(v)), String(v)).toBe(true);
    }
    for (const v of [RUN_VERSION_MAX + 1, Number.MAX_SAFE_INTEGER, -1, 1.5]) {
      expect(ok(body, command(v)), String(v)).toBe(false);
      expect(ok(SignableAction, signed(v)), String(v)).toBe(false);
    }
  });
});

describe('block entries (slice 6, D-S6-2)', () => {
  it('a BLOCK_ENTRY names a kind of the closed list and carries the block\'s own fields; no kind, actor or decimal number in its data', () => {
    const kinds = [...new Set(Object.values(TABLET_ENTRY_KINDS_BY_BLOCK).flat())].sort();
    expect([...TabletEntryKind.options].sort()).toEqual(kinds);
    for (const k of TYPED_ENTRY_KINDS) expect(kinds).toContain(k);
    const shipper = { kind: 'BLOCK_ENTRY', entryKind: 'SHIPPER', data: { sscc: '389012340000000012', packs: '48', part: false } };
    expect(ok(ClientEntry, shipper)).toBe(true);
    expect(ok(ClientEntry, { ...shipper, entryKind: 'NOT_A_KIND' })).toBe(false);
    expect(ok(ClientEntry, { ...shipper, data: { ...shipper.data, kind: 'RECONCILIATION' } })).toBe(false);
    expect(ok(ClientEntry, { ...shipper, data: { mass: 12.5 } })).toBe(false);
    expect(ok(ClientEntry, { ...shipper, actor: { id: 'x' } })).toBe(false);
    expect(ok(ClientEntry, { ...shipper, data: { pieces: [{ code: 'FE-08', detected: true }], count: 3 } })).toBe(true);
  });
});

describe('decimals travel as text (wire rules)', () => {
  it('DecimalString refuses JSON numbers, exponents and malformed text', () => {
    for (const good of ['0', '12.503', '-0.5', '100', '0.000', '-12']) expect(ok(DecimalString, good), good).toBe(true);
    for (const bad of [12.503, 12, '1e3', '1E-3', '1.2e+3', '.5', '5.', '01', '+1', '1,000', ' 1', 'NaN', 'Infinity', '', '0x1f']) {
      expect(ok(DecimalString, bad), String(bad)).toBe(false);
    }
    expect(ok(DataValueWire, { kind: 'DECIMAL', value: 12.5, unit: 'kg' })).toBe(false);
    expect(ok(DataValueWire, { kind: 'SERIES', values: ['1.0', 2], unit: 'mg' })).toBe(false);
    expect(ok(DataValueWire, { kind: 'COUNT', value: 3 })).toBe(false);
  });
});

describe('engine commands are classified exhaustively', () => {
  it('every engine command type is CLIENT_PLAIN, CLIENT_SIGNED, SERVER_ONLY or LATER, and the intents match their classes', () => {
    // The real proof is at compile time (ContractProofs, and `satisfies Record<engine.CommandType, ...>`).
    const proofs: ContractProofs = [true, true, true];
    expect(proofs).toEqual([true, true, true]);
    const plain = ClientIntent.options.map((o) => o.shape.type.value).sort();
    const signed = SignedIntent.options.map((o) => o.shape.type.value).sort();
    expect(plain).toEqual([...CLIENT_PLAIN_TYPES].sort());
    expect(signed).toEqual([...CLIENT_SIGNED_TYPES].sort());
    expect(Object.keys(ENGINE_COMMAND_CLASSES)).toHaveLength(23);
  });
});

describe('route table', () => {
  const all = allRoutes(routes);

  it('route ids are unique and prefixed with their namespace; method and path are unique', () => {
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    for (const [ns, table] of Object.entries(routes)) {
      for (const [name, route] of Object.entries(table) as [string, { id: string }][]) expect(route.id, `${ns}.${name}`).toBe(`${ns}.${name}`);
    }
    expect(new Set(all.map((r) => `${r.method} ${r.path}`)).size).toBe(all.length);
    expect(Object.keys(NAMESPACE_OWNERS).sort()).toEqual(Object.keys(routes).sort());
  });

  it('[INV-40] every FRESH_ON_SHARED route is a mutating SESSION route whose body carries the attribution member', () => {
    const fresh = all.filter((r) => r.attribution === 'FRESH_ON_SHARED');
    expect(fresh.map((r) => r.id).sort()).toEqual([
      'archive.formEvent', 'archive.issuePack', 'batches.command', 'batches.issueBulk', 'batches.issueSscc', 'batches.proposeAct',
      'capa.cancel', 'capa.implement', 'capa.linkDeviation', 'capa.linkMasterVersion', 'capa.raise', 'capa.recordEffectiveness', 'capa.scheduleCheck', 'containers.close', 'containers.open', 'containers.reject', 'containers.sort', 'esig.createChallenge', 'execution.command', 'execution.importPackage',
      'execution.issue', 'execution.planBatch', 'india.issueH2', 'integrations.acknowledgeAlarm', 'masterData.addFormulaVersion', 'masterData.createFormula', 'notifications.acknowledge', 'planning.planPackagingOrder', 'plant.completeCleaning',
      'plant.defineArea', 'plant.defineDetector', 'plant.defineEquipment', 'plant.defineEquipmentClass', 'plant.defineTestPiece',
      'plant.defineToolingSet', 'plant.defineUtility', 'plant.equipmentEvent', 'plant.recordClearance', 'plant.startCleaning', 'pqr.run', 'quality.correctLotReceipt',
      'quality.examineLotReceipt', 'quality.proposeApprovedManufacturer', 'quality.receiveDelivery', 'quality.receiveLot', 'quality.recordLotReceipt',
      'quality.registerEvidenceDocument', 'quality.withdrawManufacturerApproval', 'recall.run', 'records.appendAmendmentEntry', 'records.closeBulk', 'samples.assessReturn', 'samples.dispose', 'samples.pull', 'samples.receiveReturn',
      'specifications.draft', 'specifications.markEdition', 'specifications.postFinishedLot', 'specifications.proposeLotDecision',
    ]);
    for (const r of fresh) {
      expect(r.auth, r.id).toBe('SESSION');
      expect(r.mutating, r.id).toBe(true);
      expect(r.idempotency, r.id).toBe('REQUIRED');
    }
  });

  it('[DI-05][INV-18] designer routes and the GMP batch plan are GMP only, test packages and running test batches sandbox only (GMP batches run under batches, D-S6-1); work queue, lots, devices and the rest serve both', () => {
    for (const r of Object.values(routes.designer)) expect(r.installation, r.id).toBe('GMP');
    expect(routes.execution.planBatch.installation).toBe('GMP');
    for (const r of [routes.execution.testPackages, routes.execution.importPackage, routes.execution.issueForm, routes.execution.issue]) expect(r.installation, r.id).toBe('SANDBOX');
    const testRuns = [routes.execution.runs, routes.execution.run, routes.execution.step, routes.execution.timeline, routes.execution.verifyReplay, routes.execution.command];
    for (const r of testRuns) expect(r.installation, r.id).toBe('SANDBOX');
    for (const r of Object.values(routes.batches)) expect(r.installation, r.id).toBe('GMP');
    const installationBound: readonly string[] = ['execution.planBatch', 'execution.testPackages', 'execution.importPackage', 'execution.issueForm', 'execution.issue', ...testRuns.map((r) => r.id)];
    for (const r of Object.values(routes.execution).filter((x) => !installationBound.includes(x.id))) expect(r.installation, r.id).toBe('ANY');
    for (const r of [...Object.values(routes.devices), ...Object.values(routes.meta), ...Object.values(routes.session), ...Object.values(routes.access), ...Object.values(routes.esig), ...Object.values(routes.audit)]) {
      expect(r.installation, r.id).toBe('ANY');
    }
  });

  it('[DI-05] the slice 6 namespaces (GMP batches, planning, master data, plant) and the new quality routes are GMP only, each with an example', () => {
    const slice6 = allRoutes({ batches: routes.batches, planning: routes.planning, masterData: routes.masterData, plant: routes.plant });
    for (const r of slice6) expect(r.installation, r.id).toBe('GMP');
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of SLICE_6_ROUTE_IDS) {
      expect(exampled.has(id), `${id} has an example`).toBe(true);
      expect(allRoutes(routes).find((r) => r.id === id)?.installation, id).toBe('GMP');
    }
  });

  it('[IN-33] the specifications and samples namespaces (Phase 4 slice 2b) are GMP only, reads plain and commands FRESH_ON_SHARED, each route with an example; a result names no limits and a specification test cites its pharmacopoeia and edition', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of LIMS_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const r of [...Object.values(routes.specifications), ...Object.values(routes.samples)]) {
      expect(r.installation, r.id).toBe('GMP');
      expect(r.attribution === 'FRESH_ON_SHARED', r.id).toBe(r.mutating);
    }
    const result = routes.quality.recordLotResult.body;
    expect(result?.safeParse({ testCode: 'ASSAY', purpose: 'RELEASE', value: '99.1' }).success).toBe(true);
    expect(result?.safeParse({ testCode: 'ASSAY', purpose: 'RELEASE', value: '99.1', lowerLimit: '98.0' }).success).toBe(false);
    const test = { testCode: 'ASSAY', methodReference: 'STP-1', unit: '%', lowerLimit: '98.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '0.05', sampleUnit: 'kg' };
    const draft = routes.specifications.draft.body;
    expect(draft?.safeParse({ materialCode: 'MAT-1', title: 't', monographReference: 'm', tests: [test] }).success).toBe(true);
    expect(draft?.safeParse({ materialCode: 'MAT-1', title: 't', monographReference: 'm', tests: [{ ...test, edition: undefined }] }).success).toBe(false);
    expect(draft?.safeParse({ materialCode: 'MAT-1', title: 't', monographReference: 'm', tests: [{ ...test, pharmacopoeia: 'JP' }] }).success).toBe(false);
  });

  it('[DI-30][DI-31] the containers namespace (Phase 4 slice 1b) is GMP only, reads plain and commands FRESH_ON_SHARED, each route with an example; a close is weighed or typed, never both; CONTAINER_ACT signs a net check or a release', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of CONTAINER_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const r of Object.values(routes.containers)) {
      expect(r.installation, r.id).toBe('GMP');
      expect(r.attribution === 'FRESH_ON_SHARED', r.id).toBe(r.mutating);
    }
    expect(routes.devices.processReadings).toMatchObject({ installation: 'ANY', mutating: false });
    const close = routes.containers.close.body;
    const t = '0c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e401';
    expect(close?.safeParse({ expectedVersion: 1, typed: { net: '12.500' } }).success).toBe(true);
    expect(close?.safeParse({ expectedVersion: 1, weighing: { tareReadingId: t, grossReadingId: t } }).success).toBe(true);
    expect(close?.safeParse({ expectedVersion: 1, typed: { net: '12.500' }, weighing: { tareReadingId: t, grossReadingId: t } }).success).toBe(false);
    expect(close?.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(close?.safeParse({ expectedVersion: 1, typed: { net: 12.5 } }).success).toBe(false);
    expect(ok(SignableAction, { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: t })).toBe(true);
    expect(ok(SignableAction, { kind: 'CONTAINER_ACT', act: 'RELEASE', containerId: t, reason: { code: 'IPC_INVESTIGATED', text: 'Deviation concluded' } })).toBe(true);
    expect(ok(SignableAction, { kind: 'CONTAINER_ACT', act: 'REJECT', containerId: t })).toBe(false);
  });

  it('the full deviation routes (Phase 4 slice 2a) are GMP quality routes, each with an example; QA classifies with a rationale; QUALITY_ACT signs the impact assessment', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of DEVIATION_ROUTE_IDS) {
      expect(exampled.has(id), `${id} has an example`).toBe(true);
      expect(allRoutes(routes).find((r) => r.id === id)?.installation, id).toBe('GMP');
    }
    const start = routes.quality.startInvestigation.body;
    const owner = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e76';
    expect(start?.safeParse({ classification: 'MINOR', riskRationale: 'No product contact at all', ownerPersonId: owner, dueDate: '2026-11-12' }).success).toBe(true);
    expect(start?.safeParse({ classification: 'MINOR', riskRationale: '', ownerPersonId: owner, dueDate: '2026-11-12' }).success).toBe(false);
    expect(start?.safeParse({}).success).toBe(false);
    const basis = routes.quality.recordDeviationClosureBasis.body;
    const good = { capaRefs: ['CAPA-1'], notificationRequired: false, notificationRationale: 'No licence condition affected', otherBatches: [{ subjectKind: 'BATCH', ref: 'B1', included: false, reason: 'Made before' }] };
    expect(basis?.safeParse(good).success).toBe(true);
    expect(basis?.safeParse({ ...good, otherBatches: [] }).success).toBe(false);
    const d = '00000000-0000-4000-8000-000000000001';
    expect(ok(SignableAction, { kind: 'QUALITY_ACT', act: 'DEVIATION_IMPACT_ASSESS', subjectId: d, input: {} })).toBe(true);
  });

  it('the review namespace (Phase 4 slice 1) is GMP only, each route with an example; its signed acts are REVIEW_ACT and CORRECTION_APPROVAL', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of REVIEW_ROUTE_IDS) {
      expect(exampled.has(id), `${id} has an example`).toBe(true);
      expect(allRoutes(routes).find((r) => r.id === id)?.installation, id).toBe('GMP');
    }
    const batchId = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
    expect(ok(SignableAction, { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId, input: {} })).toBe(true);
    expect(ok(SignableAction, { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId, input: { expectedEpoch: '7' } })).toBe(true);
    expect(ok(SignableAction, { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId, input: { expectedEpoch: 7 } })).toBe(false);
    expect(ok(SignableAction, { kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId, input: { items: ['EX-1', 'EX-2'], disposition: 'ACCEPT', justification: 'Both share DEV-1; no impact.' } })).toBe(true);
    expect(ok(SignableAction, { kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId, input: { items: [], disposition: 'ACCEPT' } })).toBe(false);
    expect(ok(SignableAction, { kind: 'REVIEW_ACT', act: 'RELEASE', batchId, input: {} })).toBe(false);
    expect(ok(SignableAction, { kind: 'REVIEW_ACT', act: 'REOPEN', batchId, input: { reason: { code: 'CORRECTION', text: 'A keying error in the LOD' } } })).toBe(true);
    expect(ok(SignableAction, { kind: 'REVIEW_ACT', act: 'REOPEN', batchId, input: {}, signer: 'x' })).toBe(false);
    expect(ok(SignableAction, { kind: 'CORRECTION_APPROVAL', batchId, point: 'p1' })).toBe(true);
    const correct = { type: 'CORRECT_ENTRY', point: 'p1', value: { kind: 'DECIMAL', value: '3.0', unit: '%' }, reason: 'Keyed 4.1 for 3.1' };
    expect(ok(SignedIntent, correct)).toBe(true);
    expect(ok(SignedIntent, { ...correct, reason: ' ' })).toBe(false);
    expect(ok(SignedIntent, { ...correct, value: { kind: 'DECIMAL', value: 3, unit: '%' } })).toBe(false);
    expect(ok(SignedIntent, { ...correct, evidence: { kind: 'PRINTOUT', sha256: 'a'.repeat(64) }, approvalSignatureId: batchId })).toBe(true);
    expect(ok(ClientIntent, correct)).toBe(false);
  });

  it('the QP package and ERP shipping namespaces (Phase 4 slice 4b) are GMP only, each route with an example; QP_PACKAGE_ACT issues one package; a shipment names an exact decimal', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of QP_SHIPPING_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const r of [...Object.values(routes.qpPackage), ...Object.values(routes.erpShipping)]) expect(r.installation, r.id).toBe('GMP');
    const packageId = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
    expect(ok(SignableAction, { kind: 'QP_PACKAGE_ACT', act: 'ISSUE', packageId })).toBe(true);
    expect(ok(SignableAction, { kind: 'QP_PACKAGE_ACT', act: 'REVOKE', packageId })).toBe(false);
    const shipment = { lotId: packageId, market: 'EU', consigneeCode: 'IMP-DE-01', consigneeName: 'Importer', quantity: '120.5', unit: 'units', quarantine: true };
    const creds = { loginName: 'erp', serviceKey: 'k', fingerprint: 'f' };
    expect(routes.erpShipping.check.body?.safeParse({ ...creds, shipment }).success).toBe(true);
    expect(routes.erpShipping.check.body?.safeParse({ ...creds, shipment: { ...shipment, quantity: 120.5 } }).success).toBe(false);
    expect(routes.erpShipping.check.body?.safeParse({ ...creds, shipment: { ...shipment, market: 'UK' } }).success).toBe(false);
  });

  it('the records namespace (Phase 4 slice 5b) is GMP only, each route with an example; RECORD_LOCK_ACT opens or closes an amendment of a batch record', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of RECORDS_LOCK_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const r of Object.values(routes.records)) expect(r.installation, r.id).toBe('GMP');
    const batchId = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
    expect(ok(SignableAction, { kind: 'RECORD_LOCK_ACT', act: 'AMENDMENT_OPEN', batchId, input: { deviationId: batchId, reason: { code: 'LATE_ENTRY', text: 'Untranscribed check found' } } })).toBe(true);
    expect(ok(SignableAction, { kind: 'RECORD_LOCK_ACT', act: 'AMENDMENT_CLOSE', batchId, input: { statement: 'The late entry restores the check' } })).toBe(true);
    expect(ok(SignableAction, { kind: 'RECORD_LOCK_ACT', act: 'AMENDMENT_EDIT', batchId, input: {} })).toBe(false);
    expect(ok(SignableAction, { kind: 'RECORD_LOCK_ACT', act: 'AMENDMENT_OPEN', batchId, input: { lotId: batchId } })).toBe(false);
    expect(routes.records.setBrightStockHold.body?.safeParse({ productCode: 'GBT01', strength: '500 mg', maxHoldHours: 720, reason: 'Hold study HS-1' }).success).toBe(false);
    expect(routes.records.setBrightStockHold.body?.safeParse({ productCode: 'GBT01', strength: '500 mg', maxHoldHours: '720', reason: 'Hold study HS-1' }).success).toBe(true);
  });

  it('[IN-01][PR-58] the pqr namespace (Phase 4 slice 6c) is GMP only, each route with an example; a run names a product and a calendar period; PQR_SIGN_OFF names the extract only', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of PQR_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const r of Object.values(routes.pqr)) expect(r.installation, r.id).toBe('GMP');
    const extractId = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
    expect(ok(SignableAction, { kind: 'PQR_SIGN_OFF', extractId })).toBe(true);
    expect(ok(SignableAction, { kind: 'PQR_SIGN_OFF', extractId, resultSha256: 'a'.repeat(64) })).toBe(false);
    const body = (b: unknown) => routes.pqr.run.body?.safeParse(b).success;
    expect(body({ productCode: 'GBT01', periodFrom: '2025-10-01', periodTo: '2026-09-30' })).toBe(true);
    expect(body({ productCode: 'GBT01', periodFrom: '2025-10-01T00:00:00Z', periodTo: '2026-09-30' })).toBe(false);
    expect(body({ productCode: 'GBT 01', periodFrom: '2025-10-01', periodTo: '2026-09-30' })).toBe(false);
  });

  it('[PR-57][IN-29] the genealogy and recall namespaces (Phase 6 slice 6d) are GMP only, each route with an example; a trace names kind, id and direction; MOCK_RECALL_SIGN_OFF names the mock recall only', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of GENEALOGY_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const r of [...Object.values(routes.genealogy), ...Object.values(routes.recall)]) expect(r.installation, r.id).toBe('GMP');
    for (const r of Object.values(routes.genealogy)) expect(r.mutating, r.id).toBe(false);
    const id = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
    const trace = (q: unknown) => routes.genealogy.trace.query?.safeParse(q).success;
    expect(trace({ kind: 'LOT', id, direction: 'FORWARD' })).toBe(true);
    expect(trace({ kind: 'LOT', id, direction: 'FORWARD', asOfUs: '1791612000000000' })).toBe(true);
    expect(trace({ kind: 'LOT', id, direction: 'SIDEWAYS' })).toBe(false);
    expect(trace({ kind: 'LOT', id, direction: 'FORWARD', asOfUs: '2026-10-12' })).toBe(false);
    expect(ok(SignableAction, { kind: 'MOCK_RECALL_SIGN_OFF', mockRecallId: id })).toBe(true);
    expect(ok(SignableAction, { kind: 'MOCK_RECALL_SIGN_OFF', mockRecallId: id, resultSha256: 'a'.repeat(64) })).toBe(false);
    const run = (b: unknown) => routes.recall.run.body?.safeParse(b).success;
    expect(run({ subjectKind: 'LOT', subjectId: id, authorityInformed: false })).toBe(true);
    expect(run({ subjectKind: 'DEVIATION', subjectId: id, authorityInformed: true, authorityReference: 'CDSCO/2026/17' })).toBe(true);
    expect(run({ subjectKind: 'BATCH', subjectId: id, authorityInformed: false })).toBe(false);
    expect(run({ subjectKind: 'LOT', subjectId: id })).toBe(false);
  });

  it('the archive namespace (Phase 4 slice 6b) is GMP only, each route with an example; paper-form commands are FRESH_ON_SHARED; ARCHIVE_ACT certifies an export or signs a forms reconciliation', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of ARCHIVE_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const r of Object.values(routes.archive)) expect(r.installation, r.id).toBe('GMP');
    expect(routes.archive.issuePack.attribution).toBe('FRESH_ON_SHARED');
    expect(routes.archive.formEvent.attribution).toBe('FRESH_ON_SHARED');
    const subjectId = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
    expect(ok(SignableAction, { kind: 'ARCHIVE_ACT', act: 'CERTIFY_EXPORT', subjectId })).toBe(true);
    expect(ok(SignableAction, { kind: 'ARCHIVE_ACT', act: 'SIGN_FORMS', subjectId })).toBe(true);
    expect(ok(SignableAction, { kind: 'ARCHIVE_ACT', act: 'DELETE_RECORD', subjectId })).toBe(false);
    expect(routes.archive.issuePack.body?.safeParse({ moment: 'ISSUE', templateRef: 'DT-1', destination: 'Suite 1', pages: 0, reason: 'planned network outage' }).success).toBe(false);
    expect(routes.archive.issuePack.body?.safeParse({ moment: 'ISSUE', templateRef: 'DT-1', destination: 'Suite 1', pages: 3, reason: 'planned network outage' }).success).toBe(true);
  });

  it('the release namespace (Phase 4 slice 3) is GMP only (office routes), each route with an example; RELEASE_ACT names its act, lot and input', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of RELEASE_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const r of Object.values(routes.release)) expect(r.installation, r.id).toBe('GMP');
    const lotId = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
    const epoch = 'a'.repeat(64);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: epoch } })).toBe(true);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: '7' } })).toBe(false);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'MANUFACTURER_REJECT', lotId, input: { reason: { code: 'OOS', text: 'Assay failed' } } })).toBe(true);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'PPQ_OUTCOME', lotId, input: { batchId: lotId, outcome: 'PASSED', protocolRef: 'PV-1' } })).toBe(true);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'PPQ_OUTCOME', lotId, input: { batchId: lotId, outcome: 'MAYBE' } })).toBe(false);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'RELEASE', lotId, input: {} })).toBe(false);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { signer: 'x' } })).toBe(false);
    const ack = routes.release.acknowledge.body;
    expect(ack?.safeParse({ market: 'IN', itemId: 'G3.LIMS', epoch }).success).toBe(true);
    expect(ack?.safeParse({ market: 'UK', itemId: 'G3.LIMS', epoch }).success).toBe(false);
    expect(ack?.safeParse({ market: 'IN', itemId: 'lims', epoch }).success).toBe(false);
    expect(ack?.safeParse({ market: 'US', itemId: 'G11.US_RELEASE_RATE', epoch }).success).toBe(true);
    expect(ack?.safeParse({ market: 'US', itemId: 'G12.X', epoch }).success).toBe(false);
  });

  it('the slice 4 market acts (4-0): US disposition, two-row release, certification intake and market changes name what they sign', () => {
    const lotId = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
    const epoch = 'b'.repeat(64);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'US_DISPOSE', lotId, input: { usDecision: 'RELEASE', expectedEpoch: epoch } })).toBe(true);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'US_DISPOSE', lotId, input: { usDecision: 'CERTIFY', expectedEpoch: epoch } })).toBe(false);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: epoch, usExpectedEpoch: epoch } })).toBe(true);
    const certification = { certifier: 'Dr. Lena Vogel', miaNumber: 'DE-MIA-2024-118', certifiedAt: '2026-10-12T09:30:00+02:00', reference: 'QP-CERT-1' };
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'QP_INTAKE', lotId, input: { qpOutcome: 'CERTIFIED', certification } })).toBe(true);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'QP_INTAKE', lotId, input: { qpOutcome: 'CERTIFIED', certification: { ...certification, certifiedAt: '12.10.2026' } } })).toBe(false);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'QP_INTAKE_VERIFY', lotId, input: { intakeId: lotId } })).toBe(true);
    expect(ok(SignableAction, { kind: 'RELEASE_ACT', act: 'MARKET_ADD', lotId, input: { market: 'US', changeRecordId: lotId } })).toBe(true);
    expect(ok(SignableAction, { kind: 'BATCH_MARKET_ACT', act: 'MARKET_REMOVE', batchId: lotId, input: { market: 'EU', deviationId: lotId } })).toBe(true);
    expect(ok(SignableAction, { kind: 'BATCH_MARKET_ACT', act: 'MARKET_REMOVE', batchId: lotId, input: { market: 'UK', deviationId: lotId } })).toBe(false);
    const msg = routes.release.qpMessage.body;
    expect(msg?.safeParse({ message: '{"a":1}', signature: `${'A'.repeat(86)}==` }).success).toBe(true);
    expect(msg?.safeParse({ message: '{"a":1}', signature: 'not-base64' }).success).toBe(false);
  });

  it('[DI-24] no route of the contract deletes anything, and the void of an attempt carries the person\'s reason', () => {
    expect(all.filter((r) => r.method === 'DELETE').map((r) => r.id)).toEqual([]);
    const v = { type: 'VOID_ATTEMPT', stepKey: 'p-blend@', item: 'blendTime' };
    expect(ok(ClientIntent, { ...v, reason: 'The timer was stopped before the blend ended' })).toBe(true);
    expect(ok(ClientIntent, v)).toBe(false);
    expect(ok(ClientIntent, { ...v, reason: '   ' })).toBe(false);
  });

  it('[DI-22] the audit namespace is read-only (no edit, disable or purge route)', () => {
    for (const r of Object.values(routes.audit)) {
      expect(r.method, r.id).toBe('GET');
      expect(r.mutating, r.id).toBe(false);
    }
  });

  it('the refusal envelope has the plain-language parts', () => {
    const envelope = {
      refusal: { code: 'EBMR-IAM-140', kind: 'AUTH_FAILED', whatHappened: 'Sign-in failed.', why: 'The user ID or password is wrong.', controls: ['DI-19'], whatYouCanDo: ['Try again.'], whoCanHelp: ['Your supervisor'] },
      correlationId: 'c-1',
      retryable: true,
    };
    expect(ok(RefusalEnvelope, envelope)).toBe(true);
    expect(ok(RefusalEnvelope, { ...envelope, refusal: { ...envelope.refusal, kind: 'OOPS' } })).toBe(false);
  });

  it('[INV-26] the role map mirror names each shop-floor kernel role once', () => {
    expect(new Set(ENGINE_ROLE_MAP.map((m) => m.kernelRole)).size).toBe(ENGINE_ROLE_MAP.length);
    expect(ENGINE_ROLE_MAP.find((m) => m.kernelRole === 'QA_SHOP_FLOOR')).toMatchObject({ engineRole: 'QA', viaPermission: 'QA.FLOOR_APPROVE' });
  });
});

describe('text a record can hold (review F30-F33)', () => {
  const issues = (schema: z.ZodType, value: unknown) => {
    const r = schema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => ({ path: i.path, message: i.message }));
  };

  it('[DI-37] every string and member name holding U+0000 or a lone surrogate is found, with its path, at any depth; text a record can hold is not', () => {
    expect(unstorableTextIssues({ a: 'ok', b: ['x', { c: 'Booth\u0000' }], ['k\u0000']: 1, d: 'Line stop \uDBFF', e: '\uDC00', f: ['\uD83D\uDE00', 'e\u0301 \uFFFD \u0001'] })).toEqual([
      { path: [], message: 'has a member name holding U+0000, which no record can hold' },
      { path: ['b', 1, 'c'], message: 'holds U+0000, which no record can hold: enter the text again without it' },
      { path: ['d'], message: 'holds an unpaired surrogate U+DBFF, which no record can hold: enter the text again without it' },
      { path: ['e'], message: 'holds an unpaired surrogate U+DC00, which no record can hold: enter the text again without it' },
    ]);
    expect(unstorableTextIssues('\u0000')).toEqual([{ path: [], message: 'holds U+0000, which no record can hold: enter the text again without it' }]);
    expect(unstorableTextIssues({ n: 1, b: true, z: null, t: 'मिश्रण 😀 \u{10FFFF}' })).toEqual([]);
    // At most `limit` places are named; the walk has no recursion, so no nesting overflows the stack.
    expect(unstorableTextIssues(Array.from({ length: 50 }, () => '\u0000'))).toHaveLength(10);
    let deep: unknown = 'x\u0000';
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    const [far] = unstorableTextIssues(deep);
    expect(far?.path).toHaveLength(100_000);
  });

  it('[DI-37][DI-34] defineRoute refuses such text in the params, query and body of every route, naming the place; a route\'s own schema is unchanged otherwise', () => {
    const route = defineRoute({
      id: 'test.anything',
      method: 'POST',
      path: '/api/test/:key',
      installation: 'ANY',
      auth: 'SESSION',
      mutating: true,
      summary: 'a route that takes anything',
      params: z.strictObject({ key: z.string() }),
      query: z.looseObject({}),
      body: z.looseObject({}),
      response: z.unknown(),
    });
    expect(issues(route.params, { key: 'a\u0000' })).toEqual([{ path: ['key'], message: 'holds U+0000, which no record can hold: enter the text again without it' }]);
    expect(issues(route.query, { q: 'x\uD800' })).toEqual([{ path: ['q'], message: 'holds an unpaired surrogate U+D800, which no record can hold: enter the text again without it' }]);
    expect(issues(route.body ?? z.never(), { content: { steps: [{ name: 'Booth\u0000' }] } })).toEqual([{ path: ['content', 'steps', 0, 'name'], message: 'holds U+0000, which no record can hold: enter the text again without it' }]);
    expect(issues(route.body ?? z.never(), { content: { steps: [{ name: 'Booth 😀' }] } })).toEqual([]);
    // storableText keeps the schema's own type and rules.
    const s = storableText(z.strictObject({ a: z.string().min(2) }));
    expect(s).toBeInstanceOf(z.ZodObject);
    expect(issues(s, { a: 'x' })[0]?.path).toEqual(['a']);
  });

  it('[DI-37][DI-34][PR-49][DI-04] the real routes refuse it: a plain intent, a signed decision in a challenge, MBR content and a note, an audit chain key and prefix', () => {
    const intent = { type: 'RAISE_EXCEPTION', description: 'Booth door\u0000 found open', severity: 'ALERT' };
    expect(issues(routes.execution.command.body ?? z.never(), { expectedVersion: 1, intent })).toEqual([
      { path: ['intent', 'description'], message: 'holds U+0000, which no record can hold: enter the text again without it' },
    ]);
    const challenge = {
      aggregateType: 'batch_exception',
      aggregateId: 'x',
      contentVersion: '1',
      meaning: 'EXCEPTION_DISPOSITIONED',
      clientContentHash: 'a'.repeat(64),
      action: { kind: 'ENGINE_COMMAND', runId: '00000000-0000-4000-8000-000000000000', expectedVersion: 1, intent: { type: 'DISPOSITION_EXCEPTION', exception: 'E-1', outcome: 'NO_IMPACT', justification: 'Reprinted \udfff' } },
    };
    expect(issues(routes.esig.createChallenge.body ?? z.never(), challenge).map((i) => i.path.join('/'))).toContain('action/intent/justification');
    const save = { baseRevision: 1, content: { format: 'x', formatVersion: 1, procedure: { name: 'Booth\u0000' } }, note: 'Renamed\uD800' };
    expect(issues(routes.designer.saveContent.body ?? z.never(), save).map((i) => i.path.join('/'))).toEqual(['content/procedure/name', 'note']);
    expect(issues(routes.audit.verifyChain.params, { chainKey: 'mbr_version:\u0000' }).map((i) => i.path.join('/'))).toEqual(['chainKey']);
    expect(issues(routes.audit.chains.query, { prefix: '\u0000' }).map((i) => i.path.join('/'))).toEqual(['prefix']);
  });
});
