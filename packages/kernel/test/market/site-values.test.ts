/**
 * Site values may only tighten (build outline 3.3.2; ADR 0008 decision 8): looser than HARD is
 * refused; looser than a DESIGN value is refused; loosening GUIDANCE or an adopted EXAMPLE needs a
 * justification (CCS) reference and a QA approval record, which is the QA approver's e-signature of
 * exactly that loosening, and is flagged on every affected batch.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { batchFlags, evaluateStubScope, setSiteValue, siteValuePreview, type SiteValueRequest } from '../../src/market/repository.ts';
import { seedActor } from '../identity/seed.ts';
import { inSecondRole } from '../records/helpers.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  approvalIntegrity,
  approverActor,
  approveSiteLoosening,
  asApp,
  createTestTable,
  MARKET_ROLES,
  publishDocument,
  publishSeedTables,
  seedStubWorld,
  signApproval,
  type StubWorld,
} from './helpers.ts';

let db: TestDatabase;
let world: StubWorld;
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  await publishSeedTables(db);
  world = await seedStubWorld(db);
});
afterAll(async () => {
  await db.drop();
});

const set = (request: Omit<SiteValueRequest, 'siteId' | 'effectiveFrom'> & { effectiveFrom?: string }) =>
  asApp(db, (c) => setSiteValue(c, { siteId: world.siteId, effectiveFrom: '2026-01-01', ...request }), { roleCode: MARKET_ROLES.siteValues });

/** The QA approval of the loosening `request` describes at the stub site: a real e-signature. */
const approve = (request: Omit<SiteValueRequest, 'siteId' | 'effectiveFrom' | 'qaApprovalId'> & { effectiveFrom?: string }) =>
  approveSiteLoosening(db, { siteId: world.siteId, effectiveFrom: '2026-01-01', ...request });

const evaluateBatch = (key: string, batch: string, asOf = '2026-03-01') =>
  asApp(db, (c) => evaluateStubScope(c, { key, scope: { kind: 'PRODUCT', id: batch }, resolutionPoint: 'EXECUTION', asOf }));

describe('tighten only', () => {
  it('[IN-52] a stricter site value is accepted and applied to the site\'s batches', async () => {
    const sv = await set({ key: 'tablets.compression.ipcSampleMaxInterval', value: '20' });
    expect(sv.outcome).toBe('TIGHTER');
    const e = await evaluateBatch('tablets.compression.ipcSampleMaxInterval', world.batch.tabletIn);
    expect([e.resolvedValue, e.effectiveValue, e.siteOutcome, e.siteValueId]).toEqual(['30', '20', 'SITE_TIGHTER', sv.id]);
  });

  it('[IN-52] a site value looser than a HARD value is refused, with or without approvals', async () => {
    await expect(set({ key: 'kernel.selfInspection.maxIntervalMonths', value: '18' })).rejects.toThrow('EBMR-MKT-060');
    await expect(
      set({ key: 'kernel.selfInspection.maxIntervalMonths', value: '18', justificationRef: 'CCS-12', qaApprovalId: randomUUID() }),
    ).rejects.toThrow('EBMR-MKT-060');
    await expect(set({ key: 'sterile.particles.gradeB.inOperation.max5_0um', value: '2930' })).rejects.toThrow('EBMR-MKT-060');
  });

  /**
   * The Grade B viable action limits (ST-01, ST-20) per market: Annex 1 Table 6 binds EU-market batches and Schedule M
   * Part II Table 3 binds every batch (India always applies); both give the same numbers, as HARD values. India is in
   * every site's market set (INV-28), so the EU's own row is shown by its contribution to the resolution.
   */
  const GRADE_B_VIABLE: readonly [key: string, row: string, limit: string, over: string][] = [
    ['sterile.viable.gradeB.airMax', 'air', '10', '11'],
    ['sterile.viable.gradeB.settlePlateMax', 'settle', '5', '6'],
    ['sterile.viable.gradeB.contactPlateMax', 'contact', '5', '6'],
    ['sterile.viable.gradeB.glovePrintMax', 'glove', '5', '6'],
  ];
  /** A new site serving `markets` (no product qualified there), and site-value setting and preview at it. */
  const siteServing = async (markets: string[]) => {
    const siteId = await asApp(
      db,
      async (c) => (await c.query<{ id: string }>('insert into market.stub_site (code, markets) values ($1, $2) returning id', [`SITE-${markets.join('')}-${randomUUID().slice(0, 8)}`, markets])).rows[0]?.id ?? '',
      { roleCode: MARKET_ROLES.stubs },
    );
    const at = { siteId, effectiveFrom: '2026-01-01' };
    return {
      set: (request: Omit<SiteValueRequest, 'siteId' | 'effectiveFrom'>) => asApp(db, (c) => setSiteValue(c, { ...at, ...request }), { roleCode: MARKET_ROLES.siteValues }),
      preview: (key: string, value: string) => asApp(db, (c) => siteValuePreview(c, { ...at, key, value }), { roleCode: MARKET_ROLES.siteValues }),
    };
  };
  /** Each market's row behind a resolution: its reference, value and floor. */
  const rowsOf = (contributions: readonly { market: string; rowRef: string; value: unknown; floorType: string }[]) =>
    contributions.map((x) => [x.market, x.rowRef, x.value, x.floorType]).sort();

  it('[ST-01][ST-20] EU: Annex 1 Table 6 binds a Grade B active-air action limit of 10 CFU/m3 (settle, contact and glove 5) as HARD for a site and a batch serving the EU; 15 is refused with or without a CCS reference and QA approval, one above each limit is refused, and exactly the limit is accepted', async () => {
    const e = await evaluateBatch('sterile.viable.gradeB.airMax', world.batch.injectableAll);
    expect([e.resolvedValue, e.governingMarkets, e.floorType]).toEqual(['10', ['EU', 'IN'], 'HARD']);
    const site = await siteServing(['IN', 'EU']);
    await expect(site.set({ key: 'sterile.viable.gradeB.airMax', value: '15' })).rejects.toThrow('EBMR-MKT-060');
    await expect(site.set({ key: 'sterile.viable.gradeB.airMax', value: '15', justificationRef: 'CCS-15', qaApprovalId: randomUUID() })).rejects.toThrow('EBMR-MKT-060');
    for (const [key, row, limit, over] of GRADE_B_VIABLE) {
      const p = await site.preview(key, limit);
      // The EU row is the Annex 1 Table 6 value, HARD; the India row (Schedule M Table 3) gives the same number.
      expect(rowsOf(p.resolution.contributions), key).toEqual([['EU', `ST-20.EU.B.${row}`, limit, 'HARD'], ['IN', `ST-20.IN.B.${row}`, limit, 'HARD']]);
      expect([p.outcome, p.resolution.governingMarkets], key).toEqual(['EQUAL', ['EU', 'IN']]);
      await expect(site.set({ key, value: over }), key).rejects.toThrow('EBMR-MKT-060');
      expect((await site.set({ key, value: limit })).outcome, key).toBe('EQUAL');
    }
  });

  it('[ST-01][ST-20] India: Schedule M Part II Table 3 binds a Grade B active-air action limit of 10 CFU/m3 (settle, contact and glove 5) as HARD for an India-only site and batch; 15 is refused with or without a CCS reference and QA approval, one above each limit is refused, and exactly the limit is accepted', async () => {
    const india = await evaluateBatch('sterile.viable.gradeB.airMax', world.batch.injectableIn);
    expect([india.resolvedValue, india.governingMarkets, india.floorType]).toEqual(['10', ['IN'], 'HARD']);
    const site = await siteServing(['IN']);
    await expect(site.set({ key: 'sterile.viable.gradeB.airMax', value: '15' })).rejects.toThrow('EBMR-MKT-060');
    await expect(site.set({ key: 'sterile.viable.gradeB.airMax', value: '15', justificationRef: 'CCS-15', qaApprovalId: randomUUID() })).rejects.toThrow('EBMR-MKT-060');
    for (const [key, row, limit, over] of GRADE_B_VIABLE) {
      const p = await site.preview(key, limit);
      // Only the India row binds this site: Schedule M Table 3's value, HARD (not the EU's).
      expect(rowsOf(p.resolution.contributions), key).toEqual([['IN', `ST-20.IN.B.${row}`, limit, 'HARD']]);
      expect([p.outcome, p.resolution.governingMarkets], key).toEqual(['EQUAL', ['IN']]);
      await expect(site.set({ key, value: over }), key).rejects.toThrow('EBMR-MKT-060');
      expect((await site.set({ key, value: limit })).outcome, key).toBe('EQUAL');
    }
  });

  it('[IN-52] a site value looser than a DESIGN value is refused (APS tiers are out of v1; HEPA A/B is six months by design)', async () => {
    await expect(set({ key: 'sterile.aps.acceptance', value: 'TIERED_BY_RUN_SIZE', justificationRef: 'CCS-1', qaApprovalId: randomUUID() })).rejects.toThrow(
      /EBMR-MKT-06[01]/,
    );
    await expect(set({ key: 'kernel.excipient.identityTestEachLot', value: false, justificationRef: 'VH-STAT-1', qaApprovalId: randomUUID() })).rejects.toThrow(
      /EBMR-MKT-06[01]/,
    );
  });

  it('[IN-52] loosening a GUIDANCE value needs a justification reference and a QA approval record', async () => {
    await expect(set({ key: 'kernel.managementReview.maxIntervalMonths', value: '15' })).rejects.toThrow('EBMR-MKT-065');
    await expect(set({ key: 'kernel.managementReview.maxIntervalMonths', value: '15', justificationRef: 'MR-JUST-7' })).rejects.toThrow('EBMR-MKT-065');
    const approval = await approve({ key: 'kernel.managementReview.maxIntervalMonths', value: '15', justificationRef: 'MR-JUST-7' });
    const sv = await set({ key: 'kernel.managementReview.maxIntervalMonths', value: '15', justificationRef: 'MR-JUST-7', qaApprovalId: approval });
    expect([sv.outcome, sv.justificationRef, sv.qaApprovalId]).toEqual(['LOOSENED', 'MR-JUST-7', approval]);
    const { rows } = await db.admin.query<{ signer_person: string }>('select signer_person from esig.signature where id = $1', [approval]);
    expect(sv.qaApproverId).toBe(rows[0]?.signer_person);
    // The approval stays valid once the loosening is recorded (its signed content never changes).
    expect(await approvalIntegrity(db, [approval])).toEqual([{ status: 'VALID', problems: [] }]);
  });

  it('[IN-52] a loosened GUIDANCE value is shown on every affected batch evaluation', async () => {
    const e = await evaluateBatch('kernel.managementReview.maxIntervalMonths', world.batch.injectableAll);
    expect([e.resolvedValue, e.effectiveValue, e.siteOutcome]).toEqual(['12', '15', 'SITE_LOOSENED']);
    expect(await batchFlags(db.app, world.batch.injectableAll)).toEqual([
      expect.objectContaining({ key: 'kernel.managementReview.maxIntervalMonths', siteOutcome: 'SITE_LOOSENED', effectiveValue: '15' }),
    ]);
  });

  it('[IN-52] a set-valued rule accepts added elements but never removed ones; a NOT_COMPARABLE rule takes no site value', async () => {
    const added = await set({ key: 'kernel.release.requiredAuthorities', value: ['AUTHORISED_PERSON_RELEASE', 'EU_QP_CERTIFICATION', 'HEAD_OF_QC_APPROVAL', 'QUALITY_UNIT_RECORD_REVIEW', 'SITE_HEAD_SIGN_OFF'] });
    expect(added.outcome).toBe('TIGHTER');
    await expect(set({ key: 'kernel.release.requiredAuthorities', value: ['AUTHORISED_PERSON_RELEASE'] })).rejects.toThrow('EBMR-MKT-064');
    await expect(set({ key: 'kernel.label.manufacturingDate', value: 'NOT_REQUIRED' })).rejects.toThrow('EBMR-MKT-063');
    await expect(set({ key: 'tablets.compression.ipcSampleMaxInterval', value: 20 as unknown as string })).rejects.toThrow('EBMR-MKT-062');
  });

  it('[IN-52] site values are insert-only and written only through the function', async () => {
    await expect(asApp(db, (c) => c.query(`update market.site_value set value = '"90"'`), { reasonCode: 'X' })).rejects.toThrow(/permission denied/);
    await expect(
      asApp(db, (c) =>
        c.query(
          `insert into market.site_value (site_id, key, value, unit, effective_from, table_version_id, market_set, predicates, resolution, outcome, recorded_by)
           select $1, 'kernel.selfInspection.maxIntervalMonths', '"24"', 'mo', '2026-01-01', id, '{IN}', '{}', '{}', 'TIGHTER', $1 from market.rule_table_version limit 1`,
          [world.siteId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('adopted EXAMPLE values and later table versions', () => {
  it('[IN-52] loosening an adopted EXAMPLE value needs the same justification and approval; a site value that a later table makes too loose is not applied but flagged', async () => {
    const table = `sv${randomUUID().slice(0, 6)}`;
    await createTestTable(db, table);
    const doc = {
      table,
      version: 1,
      change: { kind: 'INITIAL', description: 'EXAMPLE test table' },
      keys: [{ key: `${table}.pressureStep`, title: 'Pressure step', method: 'LARGER_STRICTER', valueType: 'DECIMAL', unit: 'Pa', indiaGoverns: true }],
      rows: [
        { ref: 'IN', key: `${table}.pressureStep`, market: 'IN', value: '10', unit: 'Pa', floor: 'GUIDANCE', hardFloor: '5', source: 'test', verification: 'P', effectiveFrom: '2024-01-01' },
        { ref: 'US', key: `${table}.pressureStep`, market: 'US', value: '12.5', unit: 'Pa', floor: 'EXAMPLE', source: 'test', verification: 'CHK', effectiveFrom: '2024-01-01' },
      ],
    };
    await publishDocument(db, doc);
    const key = `${table}.pressureStep`;
    await expect(set({ key, value: '11' })).rejects.toThrow('EBMR-MKT-065');
    await expect(set({ key, value: '4', justificationRef: 'CCS-4', qaApprovalId: randomUUID() })).rejects.toThrow('EBMR-MKT-060');
    const loosened = await set({ key, value: '11', justificationRef: 'CCS-4.2', qaApprovalId: await approve({ key, value: '11', justificationRef: 'CCS-4.2' }) });
    expect(loosened.outcome).toBe('LOOSENED');

    // A later version makes 12.5 HARD from 2099-01-01: from then on the approved loosening is no longer admissible.
    const v2 = {
      ...doc,
      version: 2,
      change: { kind: 'UPDATE', description: 'US value becomes binding from 2099' },
      rows: [
        doc.rows[0],
        { ...doc.rows[1], effectiveTo: '2099-01-01' },
        { ...doc.rows[1], ref: 'US.2099', floor: 'HARD', effectiveFrom: '2099-01-01' },
      ],
    };
    const published = await publishDocument(db, v2);
    const { rows: impact } = await db.app.query<{ ref_type: string; due_by: string }>(
      "select ref_type, to_char(due_by, 'YYYY-MM-DD') as due_by from market.change_impact where version_id = $1",
      [published.versionId],
    );
    expect(impact).toEqual([{ ref_type: 'SITE_VALUE', due_by: '2099-01-01' }]);
    const before = await evaluateBatch(key, world.batch.tabletAll, '2098-12-01');
    expect([before.effectiveValue, before.siteOutcome]).toEqual(['11', 'SITE_LOOSENED']);
    const after = await evaluateBatch(key, world.batch.tabletAll, '2099-02-01');
    expect([after.resolvedValue, after.effectiveValue, after.siteOutcome]).toEqual(['12.5', '12.5', 'SITE_VALUE_INADMISSIBLE']);
    const flags = await batchFlags(db.app, world.batch.tabletAll);
    expect(flags.map((f) => f.siteOutcome)).toEqual(expect.arrayContaining(['SITE_LOOSENED', 'SITE_VALUE_INADMISSIBLE']));
  });
});

describe('QA approval of a loosening (F24, F76) and what it covers (F25)', () => {
  /** A one-key test table: India GUIDANCE 12 months (SMALLER_STRICTER), in force since 2024. */
  async function guidanceTable(): Promise<{ table: string; key: string; doc: Record<string, unknown> }> {
    const table = `sa${randomUUID().slice(0, 6)}`;
    await createTestTable(db, table);
    const key = `${table}.reviewIntervalMonths`;
    const doc = {
      table,
      version: 1,
      change: { kind: 'INITIAL', description: 'approval test table' },
      keys: [{ key, title: 'Review interval', method: 'SMALLER_STRICTER', valueType: 'DECIMAL', unit: 'mo', indiaGoverns: true }],
      rows: [{ ref: 'R.IN', key, market: 'IN', value: '12', unit: 'mo', floor: 'GUIDANCE', source: 'test source', verification: 'P', effectiveFrom: '2024-01-01' }],
    };
    await publishDocument(db, doc);
    return { table, key, doc };
  }

  it('[IN-52][ST-01][DI-35] the QA approval is a real e-signature of exactly that loosening: an unknown id, or the signature of another value, date or justification is refused', async () => {
    const { key } = await guidanceTable();
    const request = { key, value: '15', justificationRef: 'CCS-15' };
    const preview = await siteValuePreview(db.app, { siteId: world.siteId, effectiveFrom: '2026-01-01', ...request });
    expect(preview.outcome).toBe('LOOSENING');
    expect(preview.approval).toEqual({
      meaning: 'SITE_VALUE_LOOSENING_APPROVED',
      aggregateType: 'market_site_loosening',
      aggregateId: `${world.siteId}@${key}@2026-01-01@"12"@"15"@CCS-15`,
    });
    // No signature at all.
    await expect(set({ ...request, qaApprovalId: randomUUID() })).rejects.toThrow('EBMR-ESIG-070');
    // A real approval of another loosening: another value, another date, another justification.
    const of16 = await approve({ key, value: '16', justificationRef: 'CCS-15' });
    await expect(set({ ...request, qaApprovalId: of16 })).rejects.toThrow('EBMR-ESIG-070');
    const later = await approve({ key, value: '15', justificationRef: 'CCS-15', effectiveFrom: '2026-02-01' });
    await expect(set({ ...request, qaApprovalId: later })).rejects.toThrow('EBMR-ESIG-070');
    const otherReason = await approve({ key, value: '15', justificationRef: 'CCS-OTHER' });
    await expect(set({ ...request, qaApprovalId: otherReason })).rejects.toThrow('EBMR-ESIG-070');
    // A signature of the same loosening with another meaning is not a QA approval of it.
    const otherMeaning = await signApproval(db, await approverActor(db), { ...(preview.approval ?? { aggregateType: '', aggregateId: '' }), meaning: 'POLICY_LOOSENING_APPROVED' });
    await expect(set({ ...request, qaApprovalId: otherMeaning })).rejects.toThrow(/EBMR-ESIG-070 .*means POLICY_LOOSENING_APPROVED/);
    const { rows } = await db.admin.query<{ n: string }>('select count(*)::text as n from market.site_value where key = $1', [key]);
    expect(rows[0]?.n).toBe('0');
    // The right approval is accepted.
    const ok = await approve(request);
    expect((await set({ ...request, qaApprovalId: ok })).outcome).toBe('LOOSENED');
  });

  it('[IN-52][ST-01][DI-09] the person who sets the loosening cannot approve it, even holding a QA role', async () => {
    const { key } = await guidanceTable();
    const request = { key, value: '15', justificationRef: 'CCS-SELF' };
    const qa = await approverActor(db, 'QA_REVIEWER');
    const own = await approveSiteLoosening(db, { siteId: world.siteId, effectiveFrom: '2026-01-01', ...request }, qa);
    const asSteward = await inSecondRole(db, qa, MARKET_ROLES.siteValues);
    await expect(withCommand(db.app, underChange(asSteward), (c) => setSiteValue(c, { siteId: world.siteId, effectiveFrom: '2026-01-01', ...request, qaApprovalId: own }))).rejects.toThrow(
      'EBMR-MKT-066',
    );
  });

  it('[IN-52][ST-01] an operator cannot sign a site-value loosening approval: only the quality unit can', async () => {
    const { key } = await guidanceTable();
    const preview = await siteValuePreview(db.app, { siteId: world.siteId, key, value: '15', effectiveFrom: '2026-01-01', justificationRef: 'CCS-OP' });
    const operator = await seedActor(db, { roleCode: 'OPERATOR' });
    await expect(signApproval(db, operator, preview.approval ?? { meaning: '', aggregateType: '', aggregateId: '' })).rejects.toThrow('EBMR-ESIG-040');
  });

  it('[IN-52][ST-01] an approved loosening applies only while the resolution departs from the approved value; after a tightened table it is flagged, not applied, and listed on the impact list', async () => {
    const { key, doc } = await guidanceTable();
    const request = { key, value: '18', justificationRef: 'CCS-18' };
    const sv = await set({ ...request, qaApprovalId: await approve(request) });
    expect(sv.outcome).toBe('LOOSENED');
    const before = await evaluateBatch(key, world.batch.tabletIn);
    expect([before.resolvedValue, before.effectiveValue, before.siteOutcome]).toEqual(['12', '18', 'SITE_LOOSENED']);
    // v2 tightens India to 6 from 2027-01-01 (prospective, so an UPDATE).
    const rows = doc['rows'] as Record<string, unknown>[];
    const v2 = {
      ...doc,
      version: 2,
      change: { kind: 'UPDATE', description: 'India guidance tightened to 6 months from 2027' },
      rows: [{ ...rows[0], effectiveTo: '2027-01-01' }, { ...rows[0], ref: 'R.IN.2027', value: '6', effectiveFrom: '2027-01-01' }],
    };
    const published = await publishDocument(db, v2);
    const { rows: impact } = await db.admin.query<{ ref_id: string; due_by: string; problem: string }>(
      "select ref_id, to_char(due_by, 'YYYY-MM-DD') as due_by, problem from market.change_impact where version_id = $1",
      [published.versionId],
    );
    expect(impact).toEqual([{ ref_id: sv.id, due_by: '2027-01-01', problem: expect.stringContaining('needs a new approval') as unknown }]);
    // Until 2027 the approval still covers the departure from 12; from 2027 the departure from 6 is not approved.
    const still = await evaluateBatch(key, world.batch.tabletIn, '2026-06-01');
    expect([still.resolvedValue, still.effectiveValue, still.siteOutcome]).toEqual(['12', '18', 'SITE_LOOSENED']);
    const after = await evaluateBatch(key, world.batch.tabletIn, '2027-02-01');
    expect([after.resolvedValue, after.effectiveValue, after.siteOutcome]).toEqual(['6', '6', 'SITE_VALUE_INADMISSIBLE']);
    expect((await batchFlags(db.app, world.batch.tabletIn)).map((f) => f.evaluationId)).toContain(after.id);
  });
});
