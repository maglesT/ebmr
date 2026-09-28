/**
 * Rule tables as data: loading, publishing, validation at the SQL gate, immutability, separate
 * versioning, content hashes, source corrections (build outline 3.3.1, 3.3.5, 3.6; ADR 0008; IN-52).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ruleCorrectionApprovalTarget, syncRuleTables } from '../../src/market/loader.ts';
import { currentRuleTableVersion, loadRuleTableVersion, resolveInDatabase, verifyRuleTableVersion } from '../../src/market/repository.ts';
import { resolve } from '../../src/market/resolve.ts';
import { validateRuleTableDocument } from '../../src/market/validate.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seedActor } from '../identity/seed.ts';
import { inSecondRole } from '../records/helpers.ts';
import {
  approvalIntegrity,
  approverActor,
  approveSourceCorrection,
  asApp,
  createTestTable,
  miniDocument,
  publishDocument,
  publishDocumentAs,
  publishSeedTables,
  RULE_TABLE_ROOT,
  seedDocument,
  signApproval,
  testActor,
} from './helpers.ts';

let db: TestDatabase;
let seed: Map<string, string>;
beforeAll(async () => {
  db = await createTestDatabase();
  seed = await publishSeedTables(db);
});
afterAll(async () => {
  await db.drop();
});

type Doc = ReturnType<typeof miniDocument>;
const rows = (d: Doc) => d['rows'] as Record<string, unknown>[];
const keys = (d: Doc) => d['keys'] as Record<string, unknown>[];

let counter = 0;
async function freshTable(): Promise<string> {
  counter += 1;
  const code = `rt${counter}x${randomUUID().slice(0, 4)}`;
  await createTestTable(db, code);
  return code;
}

/** Expect the SQL gate and the TypeScript validator to refuse a document with the same code. */
async function expectRefused(doc: Doc, code: string): Promise<void> {
  const tsCodes = validateRuleTableDocument(doc, { tables: { [doc['table'] as string]: `${doc['table'] as string}.` } }).map((p) => p.code);
  expect(tsCodes).toContain(code);
  await expect(publishDocument(db, doc)).rejects.toThrow(code);
}

describe('seed tables and the loader', () => {
  it('[IN-52] the seed kernel, tablets and sterile tables validate and publish as version 1 of three separate tables', async () => {
    expect([...seed.keys()].sort()).toEqual(['kernel', 'sterile', 'tablets']);
    for (const table of ['kernel', 'tablets', 'sterile'] as const) {
      expect(validateRuleTableDocument(seedDocument(table))).toEqual([]);
      const v = await currentRuleTableVersion(db.app, table);
      expect(v?.version).toBe(1);
      expect(v?.changeKind).toBe('INITIAL');
      expect(v?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await verifyRuleTableVersion(db.app, v?.id ?? '')).toEqual([]);
    }
  });

  it('[IN-52] every seed row cites a source and carries a verification status; unverified values are marked S, U or GK', async () => {
    const { rows: r } = await db.app.query<{ n: string; unverified: string }>(
      "select count(*) as n, count(*) filter (where verification in ('S', 'U', 'GK')) as unverified from market.rule_row where length(trim(source)) > 0",
    );
    const { rows: all } = await db.app.query<{ n: string }>('select count(*) as n from market.rule_row');
    expect(r[0]?.n).toBe(all[0]?.n);
    expect(Number(r[0]?.unverified)).toBeGreaterThan(0);
  });

  it('[IN-52] syncing again leaves published versions alone', async () => {
    const outcomes = await syncRuleTables(db.app, await testActor(db), RULE_TABLE_ROOT);
    expect(outcomes.map((o) => o.action)).toEqual(['ALREADY_PUBLISHED', 'ALREADY_PUBLISHED', 'ALREADY_PUBLISHED']);
  });

  it('[IN-52] a published version cannot be changed through its file: the loader refuses a file that differs from the published content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ruletables-'));
    mkdirSync(join(dir, 'tablets'));
    const doc = parseYaml(readFileSync(join(RULE_TABLE_ROOT, 'tablets/tablets.v1.yaml'), 'utf8')) as Doc;
    rows(doc)[0] = { ...rows(doc)[0], value: '25' };
    writeFileSync(join(dir, 'tablets', 'tablets.v1.json'), JSON.stringify(doc));
    await expect(syncRuleTables(db.app, await testActor(db), dir)).rejects.toThrow('EBMR-MKT-035');
  });

  it('[IN-52] the pure engine and the database resolve a seed key identically', async () => {
    const versionId = seed.get('tablets') ?? '';
    const snapshot = await loadRuleTableVersion(db.app, versionId);
    const request = { key: 'tablets.compression.ipcSampleMaxInterval', marketSet: ['IN', 'US', 'EU'], asOf: '2026-09-27' };
    const inDb = await resolveInDatabase(db.app, versionId, request);
    expect(resolve(snapshot, request)).toEqual(inDb);
    expect(inDb.value).toBe('30');
    expect(inDb.governingMarkets).toEqual(['IN']);
  });
});

describe('validation at the publish gate (SQL) and in the loader (TypeScript)', () => {
  it('[IN-52] an unknown comparison method is refused', async () => {
    const d = miniDocument(await freshTable());
    keys(d)[0] = { ...keys(d)[0], method: 'STRICTEST' };
    await expectRefused(d, 'EBMR-MKT-014');
  });

  it('[IN-52] a scalar method on a multi-component key is refused', async () => {
    const d = miniDocument(await freshTable());
    keys(d)[0] = { ...keys(d)[0], method: 'SMALLER_STRICTER', valueType: 'CRITERIA' };
    await expectRefused(d, 'EBMR-MKT-015');
  });

  it('[IN-52] a row whose unit differs from its key is refused', async () => {
    const d = miniDocument(await freshTable());
    rows(d)[1] = { ...rows(d)[1], unit: 'h' };
    await expectRefused(d, 'EBMR-MKT-019');
  });

  it('[IN-52] overlapping effective windows for the same key, market and predicate are refused', async () => {
    const d = miniDocument(await freshTable());
    rows(d).push({ ...rows(d)[0], ref: 'I.IN.2', value: '25', effectiveFrom: '2025-06-01' });
    await expectRefused(d, 'EBMR-MKT-024');
  });

  it('[IN-52][INV-28] a key India governs without an India row is refused', async () => {
    const d = miniDocument(await freshTable());
    d['rows'] = rows(d).filter((r) => r['ref'] !== 'R.IN');
    await expectRefused(d, 'EBMR-MKT-026');
  });

  it('[IN-52][INV-28] a gap in India coverage of a key India governs is refused', async () => {
    const d = miniDocument(await freshTable());
    rows(d)[0] = { ...rows(d)[0], effectiveTo: '2025-01-01' };
    rows(d).push({ ...rows(d)[0], ref: 'I.IN.2', effectiveFrom: '2025-03-01', effectiveTo: null });
    await expectRefused(d, 'EBMR-MKT-026');
  });

  it('[IN-52] a key in the wrong namespace is refused (tables are separate, L-57)', async () => {
    const d = miniDocument(await freshTable());
    keys(d)[0] = { ...keys(d)[0], key: 'sterile.interval' };
    await expectRefused(d, 'EBMR-MKT-013');
  });

  it('[IN-52] a GMP value written as a JSON number is refused (decimals are strings)', async () => {
    const d = miniDocument(await freshTable());
    rows(d)[0] = { ...rows(d)[0], value: 30 };
    await expectRefused(d, 'EBMR-MKT-020');
  });

  it('[IN-52] predicates that overlap without one refining the other are refused as ambiguous', async () => {
    const d = miniDocument(await freshTable());
    keys(d)[0] = { ...keys(d)[0], predicates: { a: ['X', 'Y'], b: [true, false] } };
    rows(d).push({ ...rows(d)[0], ref: 'I.IN.a', predicate: { a: 'X' }, value: '25' }, { ...rows(d)[0], ref: 'I.IN.b', predicate: { b: true }, value: '20' });
    await expectRefused(d, 'EBMR-MKT-025');
  });

  it('[IN-52] a NOT_COMPARABLE key without a stated method is refused', async () => {
    const d = miniDocument(await freshTable());
    keys(d)[0] = { ...keys(d)[0], method: 'NOT_COMPARABLE', valueType: 'ANY' };
    await expectRefused(d, 'EBMR-MKT-016');
  });

  it('[IN-52] a value looser than its own hard floor is refused', async () => {
    const d = miniDocument(await freshTable());
    rows(d)[0] = { ...rows(d)[0], floor: 'DESIGN', hardFloor: '20' };
    await expectRefused(d, 'EBMR-MKT-023');
  });

  it('[IN-52] a version number that is not the next one is refused', async () => {
    const table = await freshTable();
    await expect(publishDocument(db, miniDocument(table, 2))).rejects.toThrow('EBMR-MKT-012');
  });
});

describe('immutability and versioning', () => {
  it('[IN-52] the application role cannot write, change or delete versions, keys or rows directly', async () => {
    const version = seed.get('kernel') ?? '';
    await expect(asApp(db, (c) => c.query("update market.rule_row set value = '\"6\"' where version_id = $1", [version]), { reasonCode: 'X' })).rejects.toThrow(/permission denied/);
    await expect(asApp(db, (c) => c.query('delete from market.rule_row where version_id = $1', [version]), { reasonCode: 'X' })).rejects.toThrow(/permission denied/);
    await expect(asApp(db, (c) => c.query('update market.rule_table_version set change_kind = $1', ['UPDATE']), { reasonCode: 'X' })).rejects.toThrow(/permission denied/);
    await expect(
      asApp(db, (c) =>
        c.query(
          "insert into market.rule_row (version_id, row_ref, key, market, value, unit, floor_type, source, verification, effective_from, row_hash) values ($1, 'x', 'kernel.selfInspection.maxIntervalMonths', 'IN', '\"24\"', 'mo', 'HARD', 's', 'P', '2020-01-01', '')",
          [version],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('[IN-52] rows and versions are insert-only even for the table owner', async () => {
    await expect(db.admin.query("update market.rule_row set note = 'x' where row_ref = 'B-08.IN.selfInspection'")).rejects.toThrow('EBMR-AUDIT-004');
    await expect(db.admin.query('delete from market.rule_table_version where version = 1')).rejects.toThrow('EBMR-AUDIT-004');
  });

  it('[IN-52] a row altered behind the triggers is detected by the version content hash', async () => {
    const d = miniDocument(await freshTable());
    const { versionId } = await publishDocument(db, d);
    expect(await verifyRuleTableVersion(db.app, versionId)).toEqual([]);
    const client = await db.admin.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(`update market.rule_row set value = '"45"' where version_id = $1 and row_ref = 'I.IN'`, [versionId]);
      await client.query('set session_replication_role = origin');
    } finally {
      client.release();
    }
    const problems = await verifyRuleTableVersion(db.app, versionId);
    expect(problems.join('\n')).toMatch(/content hash does not match/);
    expect(problems.join('\n')).toMatch(/row I\.IN: hash does not match/);
  });

  it('[IN-52] a change is a new version with new rows; the old version is untouched and still resolves as before', async () => {
    const table = await freshTable();
    const v1 = miniDocument(table);
    const first = await publishDocument(db, v1);
    const v2 = miniDocument(table, 2);
    rows(v2)[0] = { ...rows(v2)[0], effectiveTo: '2027-01-01' };
    rows(v2).push({ ...rows(v2)[0], ref: 'I.IN.2027', value: '15', effectiveFrom: '2027-01-01', effectiveTo: null });
    const second = await publishDocument(db, v2);
    const req = { key: `${table}.interval`, marketSet: ['IN'], asOf: '2027-06-01' };
    expect((await resolveInDatabase(db.app, first.versionId, req)).value).toBe('30');
    expect((await resolveInDatabase(db.app, second.versionId, req)).value).toBe('15');
    expect((await resolveInDatabase(db.app, second.versionId, { ...req, asOf: '2026-12-31' })).value).toBe('30');
    const { rows: counts } = await db.app.query<{ version: number; n: string }>(
      'select v.version, count(r.*) as n from market.rule_table_version v join market.rule_row r on r.version_id = v.id where v.table_code = $1 group by 1 order by 1',
      [table],
    );
    expect(counts.map((c) => [c.version, Number(c.n)])).toEqual([
      [1, 4],
      [2, 5],
    ]);
  });

  it('[IN-52] tables are versioned separately: a new sterile version changes nothing in the kernel or tablets tables', async () => {
    const before = await Promise.all((['kernel', 'tablets'] as const).map((t) => currentRuleTableVersion(db.app, t)));
    const sterile = seedDocument('sterile');
    const next = { ...sterile, version: 2, change: { kind: 'UPDATE', description: 'add Grade D in-operation note' } };
    next.rows = sterile.rows.map((r) => (r.ref === 'B-13.IN.D.rest.5_0' ? { ...r, note: 'Grade D in operation: site sets limits (EU); India does not define them.' } : r));
    await publishDocument(db, next);
    expect((await currentRuleTableVersion(db.app, 'sterile'))?.version).toBe(2);
    const after = await Promise.all((['kernel', 'tablets'] as const).map((t) => currentRuleTableVersion(db.app, t)));
    expect(after).toEqual(before);
  });

  it('[IN-52] publishing identical content again is refused', async () => {
    const table = await freshTable();
    await publishDocument(db, miniDocument(table));
    await expect(publishDocument(db, miniDocument(table, 2))).rejects.toThrow('EBMR-MKT-030');
  });
});

describe('loosening, source corrections and prospective changes', () => {
  it('[IN-52] an UPDATE that loosens a value already in force is refused', async () => {
    const table = await freshTable();
    await publishDocument(db, miniDocument(table));
    const v2 = miniDocument(table, 2);
    rows(v2)[0] = { ...rows(v2)[0], value: '45' };
    await expect(publishDocument(db, v2)).rejects.toThrow('EBMR-MKT-031');
  });

  it('[IN-52] an UPDATE whose new, more specific predicate row is looser is caught too', async () => {
    const table = await freshTable();
    const v1 = miniDocument(table);
    keys(v1)[0] = { ...keys(v1)[0], predicates: { licenceForm: ['FORM_25', 'FORM_28'] } };
    await publishDocument(db, v1);
    const v2 = miniDocument(table, 2);
    keys(v2)[0] = { ...keys(v2)[0], predicates: { licenceForm: ['FORM_25', 'FORM_28'] } };
    rows(v2).push({ ...rows(v2)[0], ref: 'I.IN.f28', predicate: { licenceForm: 'FORM_28' }, value: '60' });
    await expect(publishDocument(db, v2)).rejects.toThrow('EBMR-MKT-031');
  });

  it('[IN-52] removing a row that is in force needs a source correction', async () => {
    const table = await freshTable();
    await publishDocument(db, miniDocument(table));
    const v2 = miniDocument(table, 2);
    v2['rows'] = rows(v2).filter((r) => r['ref'] !== 'I.EU');
    await expect(publishDocument(db, v2)).rejects.toThrow('EBMR-MKT-031');
  });

  it('[IN-52] a source correction (citation and two approvers other than the publisher) may correct a wrong value; it is not treated as loosening', async () => {
    const table = await freshTable();
    await publishDocument(db, miniDocument(table));
    const v2 = miniDocument(table, 2);
    rows(v2)[1] = { ...rows(v2)[1], value: '25' };
    const publisher = await testActor(db, { roleCode: 'REGULATORY_SIGNER' });
    const correction = { kind: 'SOURCE_CORRECTION', description: 'EU value mis-keyed', citation: 'EU GMP Annex 1 (2022) 9.17, re-read', vendorNoticeRef: 'VN-2026-007' };
    // The two approvals are QA e-signatures of exactly this document (0360).
    const qa = [await approverActor(db, 'QA_REVIEWER'), await approverActor(db, 'QA_MBR_APPROVER')] as const;
    const signatures = await approveSourceCorrection(db, v2, [qa[0], qa[1]]);
    await expect(publishDocumentAs(db, publisher, v2, { ...correction, approvalSignatureIds: [signatures[0]] })).rejects.toThrow('EBMR-MKT-032');
    await expect(publishDocumentAs(db, publisher, v2, { ...correction, approvalSignatureIds: [signatures[0], signatures[0]] })).rejects.toThrow('EBMR-MKT-032');
    await expect(publishDocumentAs(db, publisher, v2, { ...correction, citation: ' ', approvalSignatureIds: signatures })).rejects.toThrow('EBMR-MKT-032');
    await expect(publishDocumentAs(db, publisher, v2, { ...correction, vendorNoticeRef: ' ', approvalSignatureIds: signatures })).rejects.toThrow('EBMR-MKT-032');
    // Approver ids alone are no approval.
    await expect(publishDocumentAs(db, publisher, v2, { ...correction, approverIds: qa.map((a) => a.personId) })).rejects.toThrow('EBMR-MKT-032');
    const result = await publishDocumentAs(db, publisher, v2, { ...correction, approvalSignatureIds: signatures });
    const { rows: v } = await db.app.query<{ change_kind: string; approver_ids: string[]; approval_signatures: string[]; citation: string; loosening: { retroactive: boolean }[] }>(
      'select change_kind, approver_ids, approval_signatures, citation, loosening from market.rule_table_version where id = $1',
      [result.versionId],
    );
    expect(v[0]?.change_kind).toBe('SOURCE_CORRECTION');
    expect(v[0]?.approver_ids).toEqual(qa.map((a) => a.personId));
    expect(v[0]?.approval_signatures).toEqual(signatures);
    // The approvals stay valid once the correction is published (its signed content never changes).
    expect(await approvalIntegrity(db, signatures)).toEqual(signatures.map(() => ({ status: 'VALID', problems: [] })));
    expect(v[0]?.citation).toContain('9.17');
    expect(v[0]?.loosening.some((l) => l.retroactive)).toBe(true);
  });

  it('[IN-52][DI-35] a source correction\'s approvals are QA e-signatures of exactly that document, by two persons other than the publisher', async () => {
    const table = await freshTable();
    await publishDocument(db, miniDocument(table));
    const v2 = miniDocument(table, 2);
    rows(v2)[0] = { ...rows(v2)[0], value: '45' }; // a retroactive loosening of a HARD India value
    const publisher = await testActor(db, { roleCode: 'REGULATORY_SIGNER' });
    const correction = { kind: 'SOURCE_CORRECTION', description: 'India interval re-read', citation: 'source re-read', vendorNoticeRef: 'VN-2026-008' };
    // Signature ids of nothing.
    await expect(publishDocumentAs(db, publisher, v2, { ...correction, approvalSignatureIds: [randomUUID(), randomUUID()] })).rejects.toThrow('EBMR-ESIG-070');
    // Real approvals of another document (the same table and version with other content).
    const other = miniDocument(table, 2);
    rows(other)[0] = { ...rows(other)[0], value: '40' };
    await expect(publishDocumentAs(db, publisher, v2, { ...correction, approvalSignatureIds: await approveSourceCorrection(db, other) })).rejects.toThrow('EBMR-ESIG-070');
    // The publisher cannot be one of the approvers, even holding a QA role.
    const qaPublisher = await approverActor(db, 'QA_REVIEWER');
    const signatures = await approveSourceCorrection(db, v2, [qaPublisher, await approverActor(db, 'QA_MBR_APPROVER')]);
    await expect(publishDocumentAs(db, await inSecondRole(db, qaPublisher, 'REGULATORY_SIGNER'), v2, { ...correction, approvalSignatureIds: signatures })).rejects.toThrow(
      'EBMR-MKT-032',
    );
    // Nothing was published by any of these attempts.
    const { rows: versions } = await db.app.query<{ v: number }>('select max(version) as v from market.rule_table_version where table_code = $1', [table]);
    expect(versions[0]?.v).toBe(1);
    // An operator cannot sign such an approval at all.
    await expect(signApproval(db, await seedActor(db, { roleCode: 'OPERATOR' }), await ruleCorrectionApprovalTarget(db.app, v2))).rejects.toThrow('EBMR-ESIG-040');
  });

  it('[IN-52][INV-28] ALL_APPLY: an UPDATE that keeps a criterion id but changes its definition in force is a loosening (the HARD IP weight bands cannot be edited in place)', async () => {
    const tablets = seedDocument('tablets');
    const ip = tablets.rows.find((r) => r.ref === 'B-14.IN.ipBands');
    expect(ip?.floor).toBe('HARD');
    const criterion = (ip?.value as { id: string }[])[0] as Record<string, unknown>;
    const edited = (change: Record<string, unknown>) => ({
      ...tablets,
      version: 2,
      change: { kind: 'UPDATE', description: 'IP weight bands edited' },
      rows: tablets.rows.map((r) => (r.ref === 'B-14.IN.ipBands' ? { ...r, value: [{ ...criterion, ...change }] } : r)),
    });
    // Looser bands, and also bands that merely look tighter: criteria are not ranked, any change of definition is a change of criterion.
    await expect(publishDocument(db, edited({ bands: [{ deviationPercent: '50' }] }))).rejects.toThrow('EBMR-MKT-031');
    await expect(publishDocument(db, edited({ bands: [{ deviationPercent: '1' }] }))).rejects.toThrow('EBMR-MKT-031');
    expect((await currentRuleTableVersion(db.app, 'tablets'))?.version).toBe(1);
  });

  it('[IN-52] a loosening that starts in the future (a later legal effective date) is allowed as an UPDATE and recorded', async () => {
    const table = await freshTable();
    await publishDocument(db, miniDocument(table));
    const v2 = miniDocument(table, 2);
    rows(v2)[1] = { ...rows(v2)[1], effectiveTo: '2099-01-01' };
    rows(v2).push({ ...rows(v2)[1], ref: 'I.EU.2099', value: '25', effectiveFrom: '2099-01-01', effectiveTo: null });
    const result = await publishDocument(db, v2);
    expect(result.loosening).toEqual([
      expect.objectContaining({ kind: 'LOOSENED', key: `${table}.interval`, market: 'EU', from: '2099-01-01', to: null, retroactive: false, aspects: ['VALUE', 'HARD_FLOOR'] }),
    ]);
  });

  it('[IN-52] weakening a HARD value to GUIDANCE counts as loosening', async () => {
    const table = await freshTable();
    await publishDocument(db, miniDocument(table));
    const v2 = miniDocument(table, 2);
    rows(v2)[0] = { ...rows(v2)[0], floor: 'GUIDANCE' };
    await expect(publishDocument(db, v2)).rejects.toThrow('EBMR-MKT-031');
  });
});
