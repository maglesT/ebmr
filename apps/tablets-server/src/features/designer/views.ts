/**
 * Read models of the designer (module C2): the family list, the VersionView (content, revision, hash, state,
 * evidence bound to the content hash, justifications in force, who saved it) and the reference documents. Reads
 * only, through the application role; every instant is formatted by the server ({us, text}).
 */
import type pg from 'pg';
import type { EvidenceView, FamilyView, Instant, JustificationView, PersonRef, ReferenceDocumentView, VersionView } from '@ebmr/api-contract';
import type { flow, validator } from '@ebmr/recipe-core/pure';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { loadReferenceRows, referenceStatus } from './adapters/references.ts';

type Db = pg.Pool | pg.PoolClient;

const US = (col: string): string => `(extract(epoch from ${col}) * 1000000)::bigint::text`;

export const auditChainOf = (versionId: string): string => `mbr_version:${versionId}`;

/** Version label on screens and in packages ("1", "2", ...): the version number of the family. */
export const versionLabel = (n: number): string => String(n);

/** A person by account, in the role they acted in. */
export async function personRef(db: Db, personId: string, accountId: string, role: string): Promise<PersonRef> {
  const { rows } = await db.query<{ legal_name: string; login_name: string }>(
    'select p.legal_name, a.login_name from iam.account a join iam.person p on p.id = a.person_id where a.id = $1 and p.id = $2',
    [accountId, personId],
  );
  const r = rows[0];
  return { personId, legalName: r?.legal_name ?? 'unknown person', loginName: r?.login_name ?? 'unknown', role: role || 'UNKNOWN' };
}

export interface VersionHead {
  versionId: string;
  familyId: string;
  familyCode: string;
  familyTitle: string;
  product: { code: string; name: string; strength: string };
  versionNumber: number;
  state: string;
}

export async function versionHead(db: Db, versionId: string): Promise<VersionHead | null> {
  const { rows } = await db.query<{
    id: string;
    family_id: string;
    code: string;
    title: string;
    product_code: string;
    product_name: string;
    strength: string;
    version_number: number;
    state: string | null;
  }>(
    `select v.id, v.family_id, f.code, f.title, f.product_code, f.product_name, f.strength, v.version_number, recipe.version_state(v.id) as state
       from recipe.mbr_version v join recipe.mbr_family f on f.id = v.family_id where v.id = $1`,
    [versionId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    versionId: r.id,
    familyId: r.family_id,
    familyCode: r.code,
    familyTitle: r.title,
    product: { code: r.product_code, name: r.product_name, strength: r.strength },
    versionNumber: r.version_number,
    state: r.state ?? 'DRAFT',
  };
}

export function versionNotFound(versionId: string): Error {
  return refusal(404, {
    code: 'DESIGNER_VERSION_UNKNOWN',
    kind: 'NOT_ENABLED',
    whatHappened: 'This MBR version does not exist.',
    why: `No MBR version ${versionId} is registered on this installation.`,
    whatYouCanDo: ['Open the master records library and choose the version again.'],
  });
}

export async function requireHead(db: Db, versionId: string): Promise<VersionHead> {
  const h = await versionHead(db, versionId);
  if (!h) throw versionNotFound(versionId);
  return h;
}

export interface SavedContent {
  contentId: string;
  revision: number;
  content: flow.MbrContent;
  contentHash: string;
  savedAtUs: string;
  personId: string;
  accountId: string;
  role: string;
  note: string | null;
}

/** The latest content revision of a version, with who saved it and in which role (from its audit entry). */
export async function latestContent(db: Db, versionId: string): Promise<SavedContent> {
  const { rows } = await db.query<{
    id: string;
    revision: number;
    content: flow.MbrContent;
    content_hash: string;
    at_us: string;
    edited_by_person: string;
    edited_by_account: string;
    reason: string | null;
    role: string | null;
  }>(
    `select c.id, c.revision, c.content, c.content_hash, ${US('c.recorded_at')} as at_us, c.edited_by_person, c.edited_by_account, c.reason,
            (select e.payload -> 'actor' ->> 'role_code' from kernel.audit_event e
              where e.chain_key = 'mbr_version:' || c.version_id and e.table_name = 'recipe.mbr_content' and e.record_id = c.id::text
              order by e.seq limit 1) as role
       from recipe.mbr_content c where c.version_id = $1 order by c.revision desc limit 1`,
    [versionId],
  );
  const r = rows[0];
  if (!r) throw versionNotFound(versionId);
  return {
    contentId: r.id,
    revision: r.revision,
    content: r.content,
    contentHash: r.content_hash,
    savedAtUs: r.at_us,
    personId: r.edited_by_person,
    accountId: r.edited_by_account,
    role: r.role ?? '',
    note: r.reason,
  };
}

export interface StoredJustification {
  key: string;
  text: string;
  personId: string;
  accountId: string;
  role: string;
  atUs: string;
  revision: number;
}

/** The justification in force for each finding key of a version (the latest recorded). */
export async function justificationsOf(db: Db, versionId: string): Promise<StoredJustification[]> {
  const { rows } = await db.query<{ finding_key: string; text: string; person_id: string; account_id: string; role_code: string; at_us: string; content_revision: number }>(
    `select distinct on (j.finding_key) j.finding_key, j.text, j.person_id, j.account_id, j.role_code, ${US('j.recorded_at')} as at_us, j.content_revision
       from tab.designer_justification j where j.version_id = $1
      order by j.finding_key, j.recorded_at desc, j.id desc`,
    [versionId],
  );
  return rows.map((r) => ({ key: r.finding_key, text: r.text, personId: r.person_id, accountId: r.account_id, role: r.role_code, atUs: r.at_us, revision: r.content_revision }));
}

/** The justifications as the validator's gate and the engine's definition take them. */
export const warningJustifications = (list: readonly StoredJustification[]): validator.WarningJustification[] => list.map((j) => ({ key: j.key, text: j.text, by: j.personId }));

export async function justificationViews(db: Db, app: AppContext, list: readonly StoredJustification[]): Promise<Map<string, JustificationView>> {
  const out = new Map<string, JustificationView>();
  for (const j of list) out.set(j.key, { findingKey: j.key, text: j.text, by: await personRef(db, j.personId, j.accountId, j.role), at: app.formatInstant(j.atUs) });
  return out;
}

/** Evidence of the version: valid only when not voided and bound to the current content hash (DI-04). */
export async function evidenceViews(db: Db, app: AppContext, versionId: string, currentHash: string): Promise<EvidenceView[]> {
  const { rows } = await db.query<{ kind: string; mode: string | null; result: string; content_hash: string; at_us: string; problems: string[]; voided: boolean; report: Record<string, unknown> }>(
    `select e.kind, e.mode, e.result, e.content_hash, ${US('e.recorded_at')} as at_us, e.problems, (v.evidence_id is not null) as voided, e.report
       from recipe.mbr_evidence e left join recipe.mbr_evidence_void v on v.evidence_id = e.id
      where e.version_id = $1 order by e.recorded_at, e.id`,
    [versionId],
  );
  return rows.map((r) => {
    const valid = !r.voided && r.content_hash === currentHash;
    let summary = r.result === 'PASS' ? 'passed' : `did not pass: ${r.problems.join('; ') || 'see the report'}`;
    const validation = r.report['validation'] as { errors?: number; warnings?: number } | undefined;
    if (r.kind === 'VALIDATOR' && validation) {
      const justified = Array.isArray(r.report['justifications']) ? (r.report['justifications'] as unknown[]).length : 0;
      summary = `${r.result === 'PASS' ? 'Passed' : 'Did not pass'}: ${validation.errors ?? 0} errors, ${validation.warnings ?? 0} warnings (${justified} justifications recorded)`;
    }
    if (r.voided) summary = `${summary}; voided by a later content revision`;
    else if (r.content_hash !== currentHash) summary = `${summary}; for other content`;
    return { kind: r.mode ? `${r.kind} (${r.mode})` : r.kind, contentHash: r.content_hash, at: app.formatInstant(r.at_us), valid, summary };
  });
}

/** The full VersionView (plan section 4). */
export async function versionView(db: Db, app: AppContext, versionId: string): Promise<VersionView> {
  const head = await requireHead(db, versionId);
  const saved = await latestContent(db, versionId);
  const justs = await justificationsOf(db, versionId);
  const jviews = await justificationViews(db, app, justs);
  return {
    versionId: head.versionId,
    familyId: head.familyId,
    familyCode: head.familyCode,
    product: head.product,
    number: versionLabel(head.versionNumber),
    revision: saved.revision,
    state: head.state,
    contentHash: saved.contentHash,
    content: saved.content as unknown as VersionView['content'],
    markets: [...saved.content.header.marketSet],
    evidence: await evidenceViews(db, app, versionId, saved.contentHash),
    justifications: [...jviews.values()],
    savedAt: app.formatInstant(saved.savedAtUs),
    savedBy: await personRef(db, saved.personId, saved.accountId, saved.role),
    auditChain: auditChainOf(versionId),
  };
}

/** Families with their versions (newest first) and the markets of their newest version. */
export async function familyViews(db: Db, app: AppContext): Promise<FamilyView[]> {
  const { rows } = await db.query<{
    family_id: string;
    code: string;
    product_code: string;
    product_name: string;
    strength: string;
    version_id: string | null;
    version_number: number | null;
    state: string | null;
    revision: number | null;
    content_hash: string | null;
    at_us: string | null;
    markets: string[] | null;
  }>(
    `select f.id as family_id, f.code, f.product_code, f.product_name, f.strength,
            v.id as version_id, v.version_number, recipe.version_state(v.id) as state,
            c.revision, c.content_hash, ${US('c.recorded_at')} as at_us,
            array(select jsonb_array_elements_text(c.content -> 'header' -> 'marketSet')) as markets
       from recipe.mbr_family f
       left join recipe.mbr_version v on v.family_id = f.id
       left join lateral (select * from recipe.mbr_content mc where mc.version_id = v.id order by mc.revision desc limit 1) c on true
      where f.edition = 'tablets'
      order by f.code, v.version_number desc`,
  );
  const out = new Map<string, FamilyView>();
  for (const r of rows) {
    let f = out.get(r.family_id);
    if (!f) {
      f = { familyId: r.family_id, familyCode: r.code, product: { code: r.product_code, name: r.product_name, strength: r.strength }, markets: r.markets ?? [], versions: [] };
      out.set(r.family_id, f);
    }
    if (r.version_id && r.version_number !== null && r.revision !== null && r.content_hash && r.at_us) {
      f.versions.push({ versionId: r.version_id, number: versionLabel(r.version_number), revision: r.revision, state: r.state ?? 'DRAFT', contentHash: r.content_hash, savedAt: app.formatInstant(r.at_us) });
    }
  }
  return [...out.values()];
}

/** Reference documents with their status today (a document is judged against its own registered hash). */
export async function referenceDocumentViews(db: Db, asOf: string): Promise<ReferenceDocumentView[]> {
  const rows = await loadReferenceRows(db);
  return rows.map((r) => ({
    refId: r.id,
    code: r.code,
    kind: r.kind,
    title: r.title,
    version: r.version,
    hash: r.contentHash,
    status: referenceStatus({ kind: r.kind as flow.ReferenceKind, code: r.code, version: r.version, hash: r.contentHash }, rows, asOf),
  }));
}

/** The database clock as an Instant. */
export async function nowInstant(db: Db, app: AppContext): Promise<Instant> {
  const { rows } = await db.query<{ us: string }>('select tab.now_micros() as us');
  return app.formatInstant(rows[0]?.us ?? '0');
}
