/**
 * The EU QP batch package and the QP access in the database (Phase 4 slice 4b; kernel 1160; DI-41, DI-14, DI-35).
 * Every act runs as the application role through the records definers with real signatures; each rule is also tried
 * around (a wrong hash, an altered section, an unregistered copy, direct writes, another person's signature, a write
 * permission on the QP account, an expired or revoked access, a second lot).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import {
  assembleQpPackage,
  grantQpAccess,
  issueQpPackage,
  qpReaderPackages,
  readQpPackage,
  registerQpPackage,
  revokeQpAccess,
  trueCopyBundleFromSnapshot,
  serializeQpPackage,
  verifyQpPackageText,
  type QpDocumentInput,
  type QpPackage,
} from '../../src/records/qp-package.ts';
import { buildTrueCopyBundle, registerTrueCopy, verifyRecordsPart, verifyTrueCopyBundleText, serializeBundle, type AuditChainPart, type RecordsPart, type TrueCopyBundle } from '../../src/records/true-copy.ts';
import { expectPermissionDenied, expectRefused } from '../identity/helpers.ts';
import { seedActor, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, inSecondRole, signFor } from './helpers.ts';

let db: TestDatabase;
let operator: SeededActor;
let qa: SeededActor;
let qa2: SeededActor;
let qp: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.admin.query(`
    create schema stub_qp authorization ebmr_owner;
    set role ebmr_owner;
    grant usage on schema stub_qp to ebmr_app;
    create table stub_qp.entry (id uuid primary key default gen_random_uuid(), batch_id uuid not null, step_ref text not null, value numeric not null);
    grant select, insert on stub_qp.entry to ebmr_app;
    select kernel.register_audited_table('stub_qp.entry', 'qp_stub_batch', 'batch_id', true);
    -- An insert-only table without an id column (as recipe.execution_event): its events are keyed by the batch.
    create table stub_qp.event (batch_id uuid not null, seq integer not null, value text not null, primary key (batch_id, seq));
    grant select, insert on stub_qp.event to ebmr_app;
    select kernel.register_audited_table('stub_qp.event', 'qp_stub_events', 'batch_id', true);
    -- The QP subject provider of this file's test lots (kernel 1162): the chains a lot's package may copy, and whether
    -- its package is served (the edition's provider is site services 0871).
    create table stub_qp.subject (subject_id text primary key, open boolean not null default true, problem text);
    create table stub_qp.subject_chain (subject_id text not null, chain_key text not null, primary key (subject_id, chain_key));
    create function stub_qp.subject_of(p_id text) returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $f$
      select case when s.subject_id is null then '{"exists": false}'::jsonb
                  else jsonb_build_object('exists', true, 'open', s.open, 'problem', s.problem,
                                          'chains', coalesce((select jsonb_agg(c.chain_key) from stub_qp.subject_chain c where c.subject_id = p_id), '[]'::jsonb)) end
        from (select p_id as k) x left join stub_qp.subject s on s.subject_id = x.k
    $f$;
    select kernel.set_actor_context(jsonb_build_object('person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
      'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM', 'site_zone', 'UTC',
      'correlation_id', gen_random_uuid(), 'legal_name', 'test module', 'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test QP subject provider'));
    select records.register_qp_subject_provider('qp_test_lot', 'stub_qp.subject_of(text)');
    select kernel.set_actor_context(null);
    reset role;
  `);
  operator = await seedActor(db, { roleCode: 'OPERATOR' });
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  qa2 = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  qp = await seedActor(db, { roleCode: 'EU_QP_READER', legalName: 'Dr. Importer QP', acknowledgeEsig: false });
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const run = <T>(actor: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> => withCommand(db.app, again(actor), work);

async function recordedBatch(): Promise<string> {
  const batch = randomUUID();
  await run(operator, async (c) => {
    await c.query('insert into stub_qp.entry (batch_id, step_ref, value) values ($1, $2, $3)', [batch, 'S1', '12.50']);
    await c.query('insert into stub_qp.entry (batch_id, step_ref, value) values ($1, $2, $3)', [batch, 'S2', '3.000']);
  });
  return batch;
}

async function copyOf(batch: string, register = true): Promise<TrueCopyBundle> {
  const bundle = await buildTrueCopyBundle(db.app, { chainKey: `qp_stub_batch:${batch}` });
  if (register) await run(qa, (c) => registerTrueCopy(c, bundle, 'EU QP batch package'));
  return bundle;
}

const docs = (over: Partial<Record<string, string>> = {}): QpDocumentInput[] =>
  (
    [
      ['audit-trail-review', 'AUDIT_TRAIL_REVIEW', 'Audit-trail review'],
      ['post-entry-changes', 'POST_ENTRY_CHANGES', 'Post-entry changes to critical data'],
      ['deviations', 'DEVIATIONS', 'Deviations and their per-market assessments'],
      ['release', 'RELEASE', 'Manufacturer release and checklist'],
      ['coa', 'COA', 'Certificate of analysis'],
    ] as const
  ).map(([name, role, title]) => ({ name, role, title, mediaType: 'application/json' as const, text: over[name] ?? JSON.stringify({ section: name, lot: 'L-1' }) }));

async function dbNow(): Promise<string> {
  const { rows } = await db.app.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`);
  return rows[0]?.t ?? '';
}

/** The provider lets `lot`'s package copy these batches' chains. */
async function allow(lot: string, ...batches: string[]): Promise<void> {
  await db.admin.query("insert into stub_qp.subject (subject_id) values ($1) on conflict do nothing", [lot]);
  for (const b of batches) await db.admin.query('insert into stub_qp.subject_chain (subject_id, chain_key) values ($1, $2) on conflict do nothing', [lot, `qp_stub_batch:${b}`]);
}

async function assembled(lot: string = randomUUID()): Promise<{ lot: string; pkg: QpPackage }> {
  const [processing, packaging] = await Promise.all([recordedBatch(), recordedBatch()]);
  await allow(lot, processing, packaging);
  const pkg = assembleQpPackage({
    subject: { type: 'qp_test_lot', id: lot, label: `Lot ${lot.slice(0, 8)}` },
    generatedAt: await dbNow(),
    bundles: [
      { name: 'processing-record', role: 'PROCESSING_RECORD', title: 'Processing record', bundle: await copyOf(processing) },
      { name: 'packaging-record', role: 'PACKAGING_RECORD', title: 'Packaging record', bundle: await copyOf(packaging) },
    ],
    documents: docs(),
  });
  return { lot, pkg };
}

async function issued(lot?: string): Promise<{ lot: string; pkg: QpPackage; id: string }> {
  const a = await assembled(lot);
  const id = await run(qa, (c) => registerQpPackage(c, a.pkg));
  const sig = await signFor(db, qa, { type: 'qp_package', id }, 'TRUE_COPY_VERIFIED', 'ASSEMBLED');
  await run(qa, (c) => issueQpPackage(c, id, sig));
  return { ...a, id };
}

async function validTo(interval: string): Promise<string> {
  const { rows } = await db.app.query<{ t: string }>(`select (clock_timestamp() + $1::interval)::text as t`, [interval]);
  return rows[0]?.t ?? '';
}

/** Registers a hand-made package through the definer (the server's word for the hash and the parts). */
const registerRaw = (actor: ActorContext, lot: string, manifest: string, sha: string, content: string) =>
  run(actor, (c) => c.query('select records.register_qp_package($1, $2, $3, $4, $5)', ['qp_test_lot', lot, manifest, sha, content]));

describe('the EU QP batch package (DI-41)', () => {
  it('[DI-41] the database computes the package hash again, checks every section and every true copy, and stores the package; the copy verifies offline', async () => {
    const { lot, pkg } = await assembled();
    const id = await run(qa, (c) => registerQpPackage(c, pkg));
    const { rows } = await db.app.query<{ package_sha256: string; content_sha256: string; n: number; state: string }>(
      'select package_sha256, content_sha256, cardinality(true_copy_ids) as n, records.qp_package_state(id) as state from records.qp_package where id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ package_sha256: pkg.packageSha256, n: 2, state: 'ASSEMBLED' });
    const text = serializeQpPackage(pkg);
    const report = verifyQpPackageText(text, { packageSha256: rows[0]?.package_sha256 ?? '' });
    expect(report).toMatchObject({ ok: true, reference: 'MATCHED', sections: 7 });
    expect(JSON.parse(text)).toMatchObject({ packageSha256: pkg.packageSha256 });
    expect(lot).toBeTruthy();
  });

  it('[DI-41] a package whose hash, sections or copies do not match is refused, and an altered byte fails the offline check', async () => {
    const { lot, pkg } = await assembled();
    const content = serializeQpPackage(pkg);
    // The server's hash is not the manifest's.
    await expectRefused(registerRaw(qa, lot, pkg.manifest, '0'.repeat(64), content), 'EBMR-REC-080');
    // Another subject than the manifest names.
    await expectRefused(registerRaw(qa, randomUUID(), pkg.manifest, pkg.packageSha256, content), 'EBMR-REC-080');
    // A document altered after the manifest was written.
    const altered = { ...pkg, documents: { ...pkg.documents, coa: JSON.stringify({ section: 'coa', assay: '101.0' }) } };
    await expectRefused(registerRaw(qa, lot, pkg.manifest, pkg.packageSha256, serializeQpPackage(altered)), 'EBMR-REC-081');
    // A part the manifest does not list.
    const extra = { ...pkg, documents: { ...pkg.documents, smuggled: '{}' } };
    await expectRefused(registerRaw(qa, lot, pkg.manifest, pkg.packageSha256, serializeQpPackage(extra)), 'EBMR-REC-081');
    // The content does not carry this manifest.
    await expectRefused(registerRaw(qa, lot, pkg.manifest, pkg.packageSha256, serializeQpPackage({ ...pkg, packageSha256: '1'.repeat(64) })), 'EBMR-REC-081');
    // A true copy never registered.
    const [b1, b2] = [await recordedBatch(), await recordedBatch()];
    await allow(lot, b1, b2);
    const unregistered = assembleQpPackage({
      subject: { type: 'qp_test_lot', id: lot, label: 'Lot' },
      generatedAt: await dbNow(),
      bundles: [
        { name: 'processing-record', role: 'PROCESSING_RECORD', title: 'Processing record', bundle: await copyOf(b1, false) },
        { name: 'packaging-record', role: 'PACKAGING_RECORD', title: 'Packaging record', bundle: await copyOf(b2) },
      ],
      documents: docs(),
    });
    await expectRefused(run(qa, (c) => registerQpPackage(c, unregistered)), 'EBMR-REC-082');
    // A required section missing, or a processing record that is no true copy (assembled by hand around the TS checks).
    const manifest = JSON.parse(pkg.manifest) as { sections: { name: string; role: string; kind: string }[] };
    const noCoa = { ...manifest, sections: manifest.sections.filter((s) => s.role !== 'COA') };
    const noCoaText = JSON.stringify(noCoa, null, 2);
    const { createHash } = await import('node:crypto');
    const h = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    const { coa: _coa, ...noCoaDocs } = pkg.documents;
    void _coa;
    await expectRefused(
      registerRaw(qa, lot, noCoaText, h(noCoaText), serializeQpPackage({ ...pkg, manifest: noCoaText, packageSha256: h(noCoaText), documents: noCoaDocs })),
      'EBMR-REC-083',
    );
    expect(() => assembleQpPackage({ subject: { type: 'qp_test_lot', id: lot, label: 'Lot' }, generatedAt: 'x', bundles: [], documents: [...docs(), { name: 'p', role: 'PROCESSING_RECORD', title: 'p', mediaType: 'text/plain', text: 'scan' }] })).toThrow(/EBMR-REC-083/);
    // Offline: one byte changed in a bundle fails, and so does a package that is not the registered one.
    const text = serializeQpPackage(pkg);
    const tampered = text.replace('12.50', '12.60');
    expect(tampered).not.toBe(text);
    expect(verifyQpPackageText(tampered).ok).toBe(false);
    expect(verifyQpPackageText(text, { packageSha256: '2'.repeat(64) })).toMatchObject({ ok: false, reference: 'MISMATCHED' });
  });

  it('[DI-41] a true copy read through the definer is the copy the direct builder makes, and only a person who registers true copies reads it', async () => {
    const batch = await recordedBatch();
    const key = `qp_stub_batch:${batch}`;
    const direct = await buildTrueCopyBundle(db.app, { chainKey: key });
    const viaDefiner = await run(qa, (c) => trueCopyBundleFromSnapshot(c, key));
    for (const part of ['records.json', 'audit-chain.json']) expect(viaDefiner.parts[part], part).toBe(direct.parts[part]);
    const report = verifyTrueCopyBundleText(serializeBundle(viaDefiner), { manifestSha256: viaDefiner.manifestSha256 });
    expect([report.ok, report.summary.reference]).toEqual([true, 'MATCHED']);
    await run(qa, (c) => registerTrueCopy(c, viaDefiner, 'QP package test'));
    await expectRefused(run(operator, (c) => trueCopyBundleFromSnapshot(c, key)), 'EBMR-IAM-040');
    await expectRefused(run(qp, (c) => trueCopyBundleFromSnapshot(c, key)), 'EBMR-IAM-040');
    await expectPermissionDenied(db.app.query("select records.true_copy_parts($1, null)", [key]));
  });

  it('[DI-41] a true copy of an insert-only table without an id column verifies row by row, and a row left out or altered is reported', async () => {
    const batch = randomUUID();
    await run(operator, async (c) => {
      for (const [seq, value] of [[1, 'started'], [2, 'weighed'], [3, 'closed']] as const) await c.query('insert into stub_qp.event (batch_id, seq, value) values ($1, $2, $3)', [batch, seq, value]);
    });
    const bundle = await run(qa, (c) => trueCopyBundleFromSnapshot(c, `qp_stub_events:${batch}`));
    const text = serializeBundle(bundle);
    const ok = verifyTrueCopyBundleText(text, { manifestSha256: bundle.manifestSha256 });
    expect([ok.ok, ok.problems, ok.summary.rows]).toEqual([true, [], 3]);
    const records = JSON.parse(bundle.parts['records.json'] ?? '{}') as RecordsPart;
    records.tables[0]?.rows.splice(1, 1);
    const short = verifyRecordsPart(records, JSON.parse(bundle.parts['audit-chain.json'] ?? '{}') as AuditChainPart);
    expect(short.join(' ')).toMatch(/1 inserted row\(s\) of this key missing from the bundle/);
    const altered = verifyTrueCopyBundleText(text.replace('weighed', 'weighted'));
    expect(altered.ok).toBe(false);
  });

  it('[DI-41] the register is written only by the definers: the application role and a person without the permission are refused', async () => {
    const { lot, pkg } = await assembled();
    await expectPermissionDenied(
      db.app.query("insert into records.qp_package (kind, subject_type, subject_id, subject_label, manifest, package_sha256, content, content_sha256, content_bytes, sections, true_copy_ids, assembled_by_person, assembled_by_account, correlation_id) values ('EU_QP_BATCH_PACKAGE', 'qp_test_lot', $1, 'x', '{}', $2, '{}', $2, 2, '[]', '{}', $3, $3, $3)", [lot, '0'.repeat(64), randomUUID()]),
    );
    await expectRefused(run(operator, (c) => registerQpPackage(c, pkg)), 'EBMR-IAM-040');
    await expectRefused(run(qp, (c) => registerQpPackage(c, pkg)), 'EBMR-IAM-040');
    const id = await run(qa, (c) => registerQpPackage(c, pkg));
    await expectPermissionDenied(db.app.query("update records.qp_package set subject_label = 'changed' where id = $1", [id]));
  });

  it('[DI-41][DI-35] QA issues the package with a TRUE_COPY_VERIFIED signature of this package, made by the person who records it, once', async () => {
    const { pkg } = await assembled();
    const id = await run(qa, (c) => registerQpPackage(c, pkg));
    const otherPkg = (await assembled()).pkg;
    const other = await run(qa, (c) => registerQpPackage(c, otherPkg));
    const sigOther = await signFor(db, qa, { type: 'qp_package', id: other }, 'TRUE_COPY_VERIFIED', 'ASSEMBLED');
    await expectRefused(run(qa, (c) => issueQpPackage(c, id, sigOther)), 'EBMR-REC-085');
    await expectRefused(run(qa, (c) => issueQpPackage(c, id, randomUUID())), 'EBMR-REC-085');
    const sig2 = await signFor(db, qa2, { type: 'qp_package', id }, 'TRUE_COPY_VERIFIED', 'ASSEMBLED');
    await expectRefused(run(qa, (c) => issueQpPackage(c, id, sig2)), 'EBMR-REC-085');
    await expectRefused(run(operator, (c) => issueQpPackage(c, id, sig2)), 'EBMR-IAM-040');
    await run(qa2, (c) => issueQpPackage(c, id, sig2));
    const { rows } = await db.app.query<{ s: string }>('select records.qp_package_state($1) as s', [id]);
    expect(rows[0]?.s).toBe('ISSUED');
    const sig3 = randomUUID();
    await expectRefused(run(qa, (c) => issueQpPackage(c, id, sig3)), 'EBMR-REC-084');
  });
});

describe('the QP account: read-only, time-boxed, one lot (DI-14, DI-17)', () => {
  it('[DI-14] QA grants a QP account read access to the issued packages of one lot until a time; the QP reads the package and each read is logged', async () => {
    const { lot, pkg, id } = await issued();
    const access = await validTo('7 days').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: id, accountId: qp.accountId, validTo: v, reason: 'TA-001: lot for import' })));
    const list = await run(qp, (c) => qpReaderPackages(c));
    expect(list.map((x) => x.packageId)).toContain(id);
    expect(list.find((x) => x.packageId === id)).toMatchObject({ subjectId: lot, accessId: access, packageSha256: pkg.packageSha256 });
    const read = await run(qp, (c) => readQpPackage(c, id));
    expect(read.packageSha256).toBe(pkg.packageSha256);
    expect(verifyQpPackageText(read.content, { packageSha256: pkg.packageSha256 })).toMatchObject({ ok: true, reference: 'MATCHED' });
    const { rows } = await db.app.query<{ n: number }>('select count(*)::int as n from records.qp_access_read where access_id = $1 and package_id = $2', [access, id]);
    expect(rows[0]?.n).toBe(1);
    await expectRefused(run(qp, (c) => revokeQpAccess(c, access, 'the QP ends it')), 'EBMR-IAM-040');
    await run(qa, (c) => revokeQpAccess(c, access, 'lot certified; access no longer needed'));
    await expectRefused(run(qp, (c) => readQpPackage(c, id)), 'EBMR-REC-090');
  });

  it('[DI-14] the access is granted only to a read-only personal account holding the QP role, for an issued package, by someone else, and for at most the maximum window', async () => {
    const { id } = await issued();
    const onlyPkg = (await assembled()).pkg;
    const assembledOnly = await run(qa, (c) => registerQpPackage(c, onlyPkg));
    await expectRefused(validTo('1 day').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: assembledOnly, accountId: qp.accountId, validTo: v, reason: 'r' }))), 'EBMR-REC-086');
    await expectRefused(validTo('1 day').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: id, accountId: operator.accountId, validTo: v, reason: 'r' }))), 'EBMR-REC-087');
    await expectRefused(validTo('1 day').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: id, accountId: qa.accountId, validTo: v, reason: 'r' }))), 'EBMR-REC-087');
    await expectRefused(validTo('31 days').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: id, accountId: qp.accountId, validTo: v, reason: 'r' }))), 'EBMR-REC-088');
    await expectRefused(validTo('-1 minute').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: id, accountId: qp.accountId, validTo: v, reason: 'r' }))), 'EBMR-REC-088');
    await expectRefused(validTo('1 day').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: id, accountId: qp.accountId, validTo: v, reason: ' ' }))), 'EBMR-REC-086');
    await expectRefused(validTo('1 day').then((v) => run(operator, (c) => grantQpAccess(c, { packageId: id, accountId: qp.accountId, validTo: v, reason: 'r' }))), 'EBMR-IAM-040');
    await expectRefused(validTo('1 day').then((v) => run(qp, (c) => grantQpAccess(c, { packageId: id, accountId: qp.accountId, validTo: v, reason: 'r' }))), 'EBMR-IAM-040');
    await expectPermissionDenied(
      db.app.query("insert into records.qp_access (subject_type, subject_id, account_id, person_id, valid_from, valid_to, reason, granted_by_person, granted_by_account, correlation_id) values ('qp_test_lot', 'x', $1, $2, now(), now() + interval '1 day', 'r', $3, $3, $3)", [qp.accountId, qp.personId, randomUUID()]),
    );
  });

  it('[DI-14] a QP account is scoped to one lot: a second lot is refused while the first access is live, and another lot\'s package is never readable', async () => {
    const qpB = await seedActor(db, { roleCode: 'EU_QP_READER', acknowledgeEsig: false });
    const first = await issued();
    const second = await issued();
    const access = await validTo('2 days').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: first.id, accountId: qpB.accountId, validTo: v, reason: 'TA-002' })));
    await expectRefused(validTo('2 days').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: second.id, accountId: qpB.accountId, validTo: v, reason: 'TA-002' }))), 'EBMR-REC-089');
    await expectRefused(run(qpB, (c) => readQpPackage(c, second.id)), 'EBMR-REC-090');
    // A later package of the same lot is covered by the same access.
    const again2 = await issued(first.lot);
    expect((await run(qpB, (c) => readQpPackage(c, again2.id))).packageSha256).toBe(again2.pkg.packageSha256);
    // Only the latest issued package of the lot is served (review 4b-3).
    await expectRefused(run(qpB, (c) => readQpPackage(c, first.id)), 'EBMR-REC-090', /replaced by a later issued package/);
    expect((await run(qpB, (c) => qpReaderPackages(c))).map((x) => x.packageId)).toEqual([again2.id]);
    await run(qa, (c) => revokeQpAccess(c, access, 'switch to the next lot'));
    await validTo('2 days').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: second.id, accountId: qpB.accountId, validTo: v, reason: 'TA-002' })));
    await expectRefused(run(qpB, (c) => readQpPackage(c, again2.id)), 'EBMR-REC-090');
    expect((await run(qpB, (c) => readQpPackage(c, second.id))).packageId).toBe(second.id);
  });

  it('[DI-14] the access ends at its time, and no other role is granted to a QP account while its access is live', async () => {
    const qpC = await seedActor(db, { roleCode: 'EU_QP_READER', acknowledgeEsig: false });
    const p = await issued();
    await validTo('1.5 seconds').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: p.id, accountId: qpC.accountId, validTo: v, reason: 'short window' })));
    expect((await run(qpC, (c) => readQpPackage(c, p.id))).packageId).toBe(p.id);
    await new Promise((r) => setTimeout(r, 2_000));
    await expectRefused(run(qpC, (c) => readQpPackage(c, p.id)), 'EBMR-REC-090');
    expect(await run(qpC, (c) => qpReaderPackages(c))).toEqual([]);

    const qpD = await seedActor(db, { roleCode: 'EU_QP_READER', acknowledgeEsig: false });
    await validTo('1 day').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: p.id, accountId: qpD.accountId, validTo: v, reason: 'TA-003' })));
    // While the access is live, no other role is requested for the account (review 4b-1).
    await expectRefused(inSecondRole(db, qpD, 'AUDITOR_READONLY'), 'EBMR-REC-092');
    await expectRefused(inSecondRole(db, qpD, 'OPERATOR'), 'EBMR-REC-092');
    expect((await run(qpD, (c) => readQpPackage(c, p.id))).packageId).toBe(p.id);
  });

  it('[DI-14] a QP account holds EU_QP_READER as its only role: an account that also holds another role, even a read-only one, gets no access', async () => {
    const qpE = await seedActor(db, { roleCode: 'EU_QP_READER', acknowledgeEsig: false });
    await inSecondRole(db, qpE, 'AUDITOR_READONLY');
    const p = await issued();
    await expectRefused(validTo('1 day').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: p.id, accountId: qpE.accountId, validTo: v, reason: 'TA-004' }))), 'EBMR-REC-087', /only role/);
  });

  it('[DI-14][DI-41] no package of a lot is served or opened to a QP while its release is suspended or its EU market removed', async () => {
    const qpF = await seedActor(db, { roleCode: 'EU_QP_READER', acknowledgeEsig: false });
    const p = await issued();
    await validTo('1 day').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: p.id, accountId: qpF.accountId, validTo: v, reason: 'TA-005' })));
    expect((await run(qpF, (c) => readQpPackage(c, p.id))).packageId).toBe(p.id);
    await db.admin.query("update stub_qp.subject set open = false, problem = 'the manufacturer release of the lot is RELEASE_SUSPENDED' where subject_id = $1", [p.lot]);
    await expectRefused(run(qpF, (c) => readQpPackage(c, p.id)), 'EBMR-REC-091', /RELEASE_SUSPENDED/);
    expect(await run(qpF, (c) => qpReaderPackages(c))).toEqual([]);
    const qpG = await seedActor(db, { roleCode: 'EU_QP_READER', acknowledgeEsig: false });
    await expectRefused(validTo('1 day').then((v) => run(qa, (c) => grantQpAccess(c, { packageId: p.id, accountId: qpG.accountId, validTo: v, reason: 'TA-006' }))), 'EBMR-REC-091');
  });
});

describe('package sections belong to the lot (review 4b-2)', () => {
  it('[DI-41] a true copy of another lot\'s record, or of a subject no module answers for, is refused', async () => {
    const mine = await assembled();
    const other = await assembled();
    const foreign = assembleQpPackage({
      subject: { type: 'qp_test_lot', id: mine.lot, label: 'Lot mine' },
      generatedAt: await dbNow(),
      bundles: [
        { name: 'processing-record', role: 'PROCESSING_RECORD', title: 'Processing record', bundle: JSON.parse(other.pkg.bundles['processing-record'] ?? '{}') as TrueCopyBundle },
        { name: 'packaging-record', role: 'PACKAGING_RECORD', title: 'Packaging record', bundle: JSON.parse(mine.pkg.bundles['packaging-record'] ?? '{}') as TrueCopyBundle },
      ],
      documents: docs(),
    });
    await expectRefused(run(qa, (c) => registerQpPackage(c, foreign)), 'EBMR-REC-093', /no record of Lot mine/);
    const stray = assembleQpPackage({ subject: { type: 'unknown_kind', id: mine.lot, label: 'Lot' }, generatedAt: await dbNow(),
      bundles: [
        { name: 'processing-record', role: 'PROCESSING_RECORD', title: 'p', bundle: JSON.parse(mine.pkg.bundles['processing-record'] ?? '{}') as TrueCopyBundle },
        { name: 'packaging-record', role: 'PACKAGING_RECORD', title: 'p', bundle: JSON.parse(mine.pkg.bundles['packaging-record'] ?? '{}') as TrueCopyBundle },
      ], documents: docs() });
    await expectRefused(run(qa, (c) => registerQpPackage(c, stray)), 'EBMR-REC-093');
    await run(qa, (c) => registerQpPackage(c, mine.pkg));
  });
});
