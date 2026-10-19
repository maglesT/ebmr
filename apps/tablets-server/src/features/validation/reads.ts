/**
 * The reads of the validation and records screens (Phase 7 slice 7g-3): every value is the database's, read from its
 * tables and definers (kernel 1300, 1335, 1336, 1381, 0400 to 0440); nothing here decides anything.
 */
import type pg from 'pg';
import type { RouteResponse, routes } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';

type Db = pg.Pool | pg.PoolClient;
type R<K extends keyof typeof routes.validation> = RouteResponse<(typeof routes.validation)[K]>;

const us = (col: string): string => `(extract(epoch from ${col}) * 1000000)::bigint::text`;
const nameOf = (col: string): string => `coalesce((select pn.legal_name from iam.person pn where pn.id = ${col}), '(unknown)')`;

export async function runningRelease(db: Db): Promise<string> {
  return (await db.query<{ r: string }>('select platform.schema_release() as r')).rows[0]?.r ?? '';
}

export async function systemDescription(app: AppContext, db: Db): Promise<R<'systemDescription'>> {
  const { rows } = await db.query<{ adapter_code: string; source_system: string; endpoint_host: string; transport: string; signed_feed: boolean; status: string; us: string }>(
    `select adapter_code, source_system, endpoint_host, transport, signed_feed, status, ${us('valid_from')} as us
       from platform.system_description() order by adapter_code collate "C"`,
  );
  const { rows: undescribed } = await db.query<{ code: string }>(
    "select d.code from iam.integration_adapter d where d.status = 'ACTIVE' and not platform.interface_described(d.code) order by 1",
  );
  return {
    interfaces: rows.map((r) => ({
      adapterCode: r.adapter_code,
      sourceSystem: r.source_system as R<'systemDescription'>['interfaces'][number]['sourceSystem'],
      endpointHost: r.endpoint_host,
      transport: r.transport as 'LOOPBACK' | 'MTLS',
      signedFeed: r.signed_feed,
      status: r.status as 'DESCRIBED' | 'WITHDRAWN',
      validFrom: app.formatInstant(r.us),
    })),
    undescribed: undescribed.map((r) => r.code),
  };
}

export async function summaryState(app: AppContext, db: Db): Promise<Pick<R<'summary'>, 'runningRelease' | 'problem' | 'approvals'>> {
  const { rows: s } = await db.query<{ r: string; p: string | null }>('select platform.schema_release() as r, platform.validation_summary_problem() as p');
  const { rows } = await db.query<{ schema_release: string; summary_sha256: string; title: string; by: string; us: string; sig: string }>(
    `select s.schema_release, s.summary_sha256, s.title, ${nameOf('s.approved_by_person')} as by, ${us('s.approved_at')} as us, s.approved_signature::text as sig
       from platform.validation_summary s order by s.approved_at desc, s.id`,
  );
  return {
    runningRelease: s[0]?.r ?? '',
    problem: s[0]?.p ?? null,
    approvals: rows.map((r) => ({ schemaRelease: r.schema_release, summarySha256: r.summary_sha256, title: r.title, approvedBy: r.by, approvedAt: app.formatInstant(r.us), signatureId: r.sig })),
  };
}

interface IqRow { id: string; passed: boolean; summary: string; schema_release: string; bundle_sha256: string; record_sha256: string; record: string; by: string; us: string }

function iqView(app: AppContext, r: IqRow): R<'runIq'> {
  const checks = (JSON.parse(r.record) as { checks?: R<'runIq'>['checks'] }).checks ?? [];
  return {
    iqId: r.id, passed: r.passed, summary: r.summary, schemaRelease: r.schema_release, bundleSha256: r.bundle_sha256, recordSha256: r.record_sha256,
    checks: checks.map((c) => ({ id: c.id, name: c.name, expected: c.expected, actual: c.actual, passed: c.passed, problems: c.problems })),
    by: r.by, at: app.formatInstant(r.us),
  };
}

const IQ_SELECT = `select id::text, passed, summary, schema_release, bundle_sha256, record_sha256, record, ${nameOf('person_id')} as by, ${us('recorded_at')} as us from platform.iq_record`;

export async function iqRecords(app: AppContext, db: Db): Promise<R<'runIq'>[]> {
  const { rows } = await db.query<IqRow>(`${IQ_SELECT} order by recorded_at desc, id limit 50`);
  return rows.map((r) => iqView(app, r));
}

export async function iqRecord(app: AppContext, db: Db, id: string): Promise<{ view: R<'runIq'>; record: string } | null> {
  const { rows } = await db.query<IqRow>(`${IQ_SELECT} where id = $1`, [id]);
  const r = rows[0];
  return r ? { view: iqView(app, r), record: r.record } : null;
}

export async function fullExportViews(app: AppContext, db: Db): Promise<R<'fullExports'>['exports']> {
  const { rows } = await db.query<{ id: string; sha: string; records: string; files: string; by: string; us: string }>(
    `select id::text, manifest_sha256 as sha, record_count::text as records, file_count::text as files, ${nameOf('exported_by_person')} as by, ${us('recorded_at')} as us
       from records.full_export order by recorded_at desc, id`,
  );
  return rows.map((r) => ({ exportId: r.id, manifestSha256: r.sha, recordCount: r.records, fileCount: r.files, by: r.by, at: app.formatInstant(r.us) }));
}

export async function fullExportManifest(db: Db, id: string): Promise<R<'fullExportManifest'> | null> {
  const { rows } = await db.query<{ sha: string; manifest: string }>('select manifest_sha256 as sha, manifest from records.full_export where id = $1', [id]);
  const r = rows[0];
  return r ? { exportId: id, manifestSha256: r.sha, manifest: r.manifest } : null;
}

const PACK_SELECT = `select p.id::text, p.pack_sha256 as sha, ${us('p.period_from')} as from_us, ${us('p.period_to')} as to_us, p.entry_count::text as entries,
         p.sample_count::text as sampled, p.unreadable_count::text as unreadable, p.readability_seed as seed, p.sample_size::text as size,
         ${nameOf('p.generated_by_person')} as by, ${us('p.recorded_at')} as us,
         a.approved_signature::text as sig, case when a.pack_id is null then null else ${nameOf('a.approved_by_person')} end as approver, ${us('a.recorded_at')} as approved_us
    from records.evaluation_pack p left join records.evaluation_pack_approval a on a.pack_id = p.id`;

interface PackRow { id: string; sha: string; from_us: string; to_us: string; entries: string; sampled: string; unreadable: string; seed: string; size: string; by: string; us: string; sig: string | null; approver: string | null; approved_us: string | null }

function packView(app: AppContext, r: PackRow): R<'runEvaluationPack'> {
  return {
    packId: r.id, packSha256: r.sha, periodFrom: app.formatInstant(r.from_us), periodTo: app.formatInstant(r.to_us), entryCount: r.entries, sampleCount: r.sampled,
    unreadableCount: r.unreadable, readabilitySeed: r.seed, sampleSize: r.size, generatedBy: r.by, at: app.formatInstant(r.us),
    approval: r.sig && r.approver && r.approved_us ? { approvedBy: r.approver, at: app.formatInstant(r.approved_us), signatureId: r.sig } : null,
  };
}

export async function evaluationPacks(app: AppContext, db: Db): Promise<R<'runEvaluationPack'>[]> {
  const { rows } = await db.query<PackRow>(`${PACK_SELECT} order by p.recorded_at desc, p.id`);
  return rows.map((r) => packView(app, r));
}

export async function evaluationPackView(app: AppContext, db: Db, id: string): Promise<R<'runEvaluationPack'> | null> {
  const { rows } = await db.query<PackRow>(`${PACK_SELECT} where p.id = $1`, [id]);
  return rows[0] ? packView(app, rows[0]) : null;
}

interface TypeRow { code: string; version: string; title: string; description: string; data_class: string; gmp_criticality: string; official_medium: string; retention_key: string; feeds: boolean; by: string; us: string; approver: string | null }

export async function recordTypes(app: AppContext, db: Db, only?: { code: string; version: string }): Promise<R<'defineRecordType'>[]> {
  const { rows } = await db.query<TypeRow>(
    `select t.code, t.version::text, t.title, t.description, t.data_class, t.gmp_criticality, t.official_medium, t.retention_key, t.feeds_acceptance_limit as feeds,
            ${nameOf('t.defined_by_person')} as by, ${us('t.recorded_at')} as us,
            case when a.code is null then null else ${nameOf('a.approved_by_person')} end as approver
       from records.record_type t left join records.record_type_approval a on a.code = t.code and a.version = t.version
      where ($1::text is null or (t.code = $1 and t.version = $2::integer))
      order by t.code collate "C", t.version desc`,
    [only?.code ?? null, only?.version ?? null],
  );
  return rows.map((r) => ({
    code: r.code, version: r.version, title: r.title, description: r.description, dataClass: r.data_class, gmpCriticality: r.gmp_criticality, officialMedium: r.official_medium,
    retentionKey: r.retention_key, feedsAcceptanceLimit: r.feeds, state: r.approver === null ? 'DEFINED' : 'APPROVED', definedBy: r.by, definedAt: app.formatInstant(r.us), approvedBy: r.approver,
  }));
}

/** The legal holds in force (tab.legal_hold_overview, tablets 1491: read by the session under the records' read rule). */
export async function holdsInForce(app: AppContext, db: Db, tokenHash: string, holdId?: string): Promise<R<'placeLegalHold'>[]> {
  const { rows } = await db.query<{ r: { id: string; recordKey: string; kind: string; reason: string; reference: string | null; placedBy: string; us: string }[] }>(
    'select tab.legal_hold_overview($1) as r',
    [tokenHash],
  );
  return (rows[0]?.r ?? [])
    .filter((h) => holdId === undefined || h.id === holdId)
    .map((h) => ({ holdId: h.id, recordKey: h.recordKey, kind: h.kind, reason: h.reason, reference: h.reference, placedBy: h.placedBy, at: app.formatInstant(h.us) }));
}

/**
 * One record's retention, why it may not be disposed of and its open blockers (tab.record_retention, tablets 1491: the
 * kernel's readers run for the owner only; what an investigation about the reader withholds is left out, DI-50).
 */
export async function retentionLookup(db: Db, tokenHash: string, aggregateType: string, aggregateId: string): Promise<R<'retention'>> {
  const { rows } = await db.query<{ r: Omit<R<'retention'>, 'aggregateType' | 'aggregateId'> }>('select tab.record_retention($1, $2, $3) as r', [tokenHash, aggregateType, aggregateId]);
  const r = rows[0]?.r;
  if (!r) throw new Error('tab.record_retention answered nothing');
  return { ...r, aggregateType, aggregateId };
}

interface InvJson {
  id: string; reference: string; status: 'OPEN' | 'CLOSED'; subject: string; investigator: string; openedBy: string; fromUs: string; toUs: string; concern: string;
  qmsReference: string | null; conclusion: string | null; remediation: string | null; approvedBy: string | null;
  links: { recordKey: string; source: 'SCOPE' | 'MANUAL'; note: string | null }[];
}

/**
 * The investigations the session may read (tab.di_investigation_overview, tablets 1491: a governance reader, never one
 * about the session's own person; DI-50). The application role reads none of the investigation tables itself.
 */
export async function investigations(app: AppContext, db: Db, tokenHash: string, id?: string): Promise<R<'openDiInvestigation'>[]> {
  const { rows } = await db.query<{ r: InvJson[] }>('select tab.di_investigation_overview($1) as r', [tokenHash]);
  return (rows[0]?.r ?? [])
    .filter((r) => id === undefined || r.id === id)
    .map((r) => ({
      investigationId: r.id, reference: r.reference, status: r.status, subject: r.subject, investigator: r.investigator, openedBy: r.openedBy,
      windowFrom: app.formatInstant(r.fromUs), windowTo: app.formatInstant(r.toUs), concern: r.concern, qmsReference: r.qmsReference,
      conclusion: r.conclusion, remediation: r.remediation, approvedBy: r.approvedBy, links: r.links,
    }));
}
