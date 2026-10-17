/**
 * Feature `archive` (Phase 4 slice 6b, GMP): retention of batch records, contingency packs, the PDF/A-3 true copy, the
 * certified evidence export and the read-only inspection workspace (contract ns/archive.ts; kernel 1170 to 1172; DI-40,
 * DI-41, DI-43, DI-46, DI-47, IN-08, IN-11, PR-16, PR-59). The rules are the database's: retention is computed by the
 * kernel engine from the inputs read here from the batch's record (facts.ts); forms, exports and reads go through the
 * records definers; certifying an export and signing a forms reconciliation are the signable action ARCHIVE_ACT.
 */
import {
  routes,
  type ArchiveBatchSummary,
  type ContingencyFormView,
  type ExportView,
  type FormsView,
  type RetentionView,
  type SignableAction,
} from '@ebmr/api-contract';
import { commands, records, toDbContext, type ActorContext } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { dbActHandler } from '../esig/db-acts.ts';
import { batchFacts, type BatchFacts } from './facts.ts';

type Db = Pick<pg.Pool, 'query'> | pg.PoolClient;
type ArchiveAct = Extract<SignableAction, { kind: 'ARCHIVE_ACT' }>;

const noBatch = (batchId: string) =>
  refusal(404, { code: 'EBMR-API-NO-BATCH', kind: 'INVALID_INPUT', whatHappened: 'This batch was not found.', why: `${batchId} is no batch.`, whatYouCanDo: ['Reload the batch list.'] });

/** ARCHIVE_ACT: QA certifies an evidence export (EVIDENCE_EXPORT_CERTIFIED) or signs a forms reconciliation (FORMS_RECONCILED). */
export function archiveActHandler(app: AppContext): SignableActionHandler<ArchiveAct> {
  return dbActHandler<ArchiveAct>(app, {
    kind: 'ARCHIVE_ACT',
    aggregateTypes: ['evidence_export', 'form_reconciliation'],
    target: (a) =>
      a.act === 'CERTIFY_EXPORT'
        ? { aggregateType: 'evidence_export', aggregateId: a.subjectId, meaning: 'EVIDENCE_EXPORT_CERTIFIED', expectedState: 'ASSEMBLED' }
        : { aggregateType: 'form_reconciliation', aggregateId: a.subjectId, meaning: 'FORMS_RECONCILED', expectedState: 'RECONCILED' },
    async apply(client, _ctx, a, signatureId) {
      if (a.act === 'CERTIFY_EXPORT') await records.certifyEvidenceExport(client, a.subjectId, signatureId);
      else await records.signFormReconciliation(client, a.subjectId, signatureId);
      return { act: a.act, subjectId: a.subjectId };
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------------

async function facts(db: Db, batchId: string): Promise<BatchFacts> {
  const f = await batchFacts(db, batchId);
  if (!f) throw noBatch(batchId);
  return f;
}

function euOf(f: BatchFacts): Pick<RetentionView['inputs'], 'eu' | 'euDate'> {
  const eu = f.retention.eu;
  if (!eu) return { eu: 'NOT_IN_SET', euDate: null };
  return eu.state === 'PENDING' ? { eu: 'PENDING', euDate: null } : { eu: eu.state, euDate: eu.date };
}

interface OwnJson {
  status: 'DATED' | 'OPEN' | 'NONE';
  retainUntil: string | null;
  governingRules: string[];
  openReasons: string[];
}
interface EffectiveJson {
  status: 'DATED' | 'OPEN';
  retainUntil: string | null;
  governedBy: string[];
  openBecause: { recordKey: string; reasons: string[] }[];
}

export async function retentionView(app: AppContext, db: Db, f: BatchFacts): Promise<RetentionView> {
  const inputs = records.batchRetentionInputs(f.retention);
  const key = `batch:${f.batchId}`;
  const scheduled = (await db.query<{ s: boolean }>('select exists (select 1 from records.retention_schedule where record_key = $1) as s', [key])).rows[0]?.s ?? false;
  let status: 'DATED' | 'OPEN';
  let retainUntil: string | null;
  let governingRules: string[];
  let governedBy: string[];
  let openBecause: string[];
  const drift: string[] = [];
  if (scheduled) {
    // Not records.retention_of: tablets 0460 (F34; DI-17, DI-50) keeps it from the application role, since its refusals
    // name a blocking data-integrity investigation. The same own, effective and stored inputs, from what the role may read.
    const r = (
      await db.query<{ own: OwnJson; effective: EffectiveJson; inputs: Record<string, unknown> }>(
        `select records.evaluate_retention(i.inputs || jsonb_build_object('retentionKey', s.retention_key)) as own, records.compute_effective_retention(s.id) as effective,
                i.inputs
           from records.retention_schedule s
           join lateral (select x.inputs from records.retention_input x where x.schedule_id = s.id order by x.input_version desc limit 1) i on true
          where s.record_key = $1`,
        [key],
      )
    ).rows[0];
    if (!r) throw new Error('retention was not read');
    status = r.effective.status;
    retainUntil = r.effective.retainUntil;
    governingRules = r.own.governingRules;
    governedBy = r.effective.governedBy;
    openBecause = r.effective.openBecause.flatMap((o) => o.reasons.map((x) => `${o.recordKey}: ${x}`));
    const now = (await db.query<{ n: Record<string, unknown> }>('select records.normalize_retention_inputs($1::jsonb) as n', [JSON.stringify(inputs)])).rows[0]?.n ?? {};
    for (const k of Object.keys(now).sort()) {
      if (JSON.stringify(now[k]) !== JSON.stringify(r.inputs[k])) drift.push(`${k}: stored ${JSON.stringify(r.inputs[k] ?? null)}, the record now gives ${JSON.stringify(now[k])}`);
    }
  } else {
    // The engine evaluates the rules of the record's retention key (a batch record's), as it does for a stored schedule.
    const own = (await db.query<{ o: OwnJson }>('select records.evaluate_retention($1::jsonb) as o', [JSON.stringify({ ...inputs, retentionKey: 'BATCH_RECORD' })])).rows[0]?.o;
    if (!own) throw new Error('retention was not evaluated');
    status = own.status === 'DATED' ? 'DATED' : 'OPEN';
    retainUntil = own.status === 'DATED' ? own.retainUntil : null;
    governingRules = own.governingRules;
    governedBy = own.status === 'DATED' ? [key] : [];
    openBecause = own.status === 'NONE' ? ['no retention rule applies yet'] : own.openReasons;
  }
  const reqs = (
    await db.query<{ outcome: 'REFUSED' | 'ELIGIBLE'; reason: string; person_id: string; at_us: string }>(
      `select outcome, reason, person_id, ${usOf('recorded_at')} as at_us from records.disposal_request where record_key = $1 order by recorded_at desc, id desc limit 20`,
      [key],
    )
  ).rows;
  const people = await peopleOf(db, reqs.map((x) => x.person_id));
  return {
    batchId: f.batchId,
    inputs: {
      markets: [...inputs.markets],
      licenceForm: f.retention.licenceForm,
      manufactureDate: f.retention.manufactureDate,
      expiryDate: f.retention.expiryDate,
      outcome: f.retention.outcome,
      abortCancelDate: f.retention.abortCancelDate,
      ...euOf(f),
    },
    status,
    retainUntil,
    governingRules,
    governedBy,
    openBecause,
    scheduled,
    drift,
    disposalRequests: reqs.map((x) => ({ outcome: x.outcome, reason: x.reason, by: personRef(people, x.person_id, 'QA_REVIEWER'), at: app.formatInstant(x.at_us) })),
  };
}

export async function formsView(app: AppContext, db: Db, batchId: string): Promise<FormsView> {
  const forms = (
    await db.query<{ id: string; serial: string; moment: 'ISSUE' | 'STAGE_START'; stage_ref: string | null; template_ref: string; destination: string; page_no: number; page_count: number; state: ContingencyFormView['state']; person_id: string; at_us: string }>(
      `select f.id, f.serial, f.moment, f.stage_ref, f.template_ref, f.destination, f.page_no, f.page_count, records.contingency_form_state(f.id) as state, f.person_id,
              ${usOf('f.recorded_at')} as at_us
         from records.contingency_form f where f.batch_id = $1 order by f.serial`,
      [batchId],
    )
  ).rows;
  const events = (
    await db.query<{ form_id: string; event: string; reason: string | null; reference: string | null; person_id: string; at_us: string }>(
      `select e.form_id, e.event, e.reason, e.reference, e.person_id, ${usOf('e.recorded_at')} as at_us from records.contingency_form_event e where e.batch_id = $1 order by e.recorded_at, e.id`,
      [batchId],
    )
  ).rows;
  const head = (
    await db.query<{ state: FormsView['state']; problem: string | null; signer: string | null; signed_us: string | null }>(
      `select records.form_reconciliation_state($1) as state, records.form_reconciliation_problem($1) as problem,
              (select r.person_id from records.form_reconciliation r where r.batch_id = $1) as signer,
              (select ${usOf('r.recorded_at')} from records.form_reconciliation r where r.batch_id = $1) as signed_us`,
      [batchId],
    )
  ).rows[0];
  const people = await peopleOf(db, [...forms.map((f) => f.person_id), ...events.map((e) => e.person_id), head?.signer]);
  return {
    batchId,
    state: head?.state ?? 'NONE',
    completionProblem: head?.problem ?? null,
    forms: forms.map((f) => ({
      formId: f.id,
      serial: f.serial,
      moment: f.moment,
      stageRef: f.stage_ref,
      templateRef: f.template_ref,
      destination: f.destination,
      page: `${f.page_no} of ${f.page_count}`,
      state: f.state,
      issuedBy: personRef(people, f.person_id, 'SHIFT_SUPERVISOR'),
      issuedAt: app.formatInstant(f.at_us),
      events: events.filter((e) => e.form_id === f.id).map((e) => ({ event: e.event, reason: e.reason, reference: e.reference, by: personRef(people, e.person_id, 'OPERATOR'), at: app.formatInstant(e.at_us) })),
    })),
    signedBy: head?.signer ? personRef(people, head.signer, 'QA_SHOP_FLOOR') : null,
    signedAt: head?.signed_us ? app.formatInstant(head.signed_us) : null,
  };
}

interface ExportRow {
  id: string;
  subject_id: string;
  subject_label: string;
  export_sha256: string;
  pdf_content_sha256: string;
  content_bytes: string;
  sections: records.EvidenceSection[];
  assembled_by_person: string;
  assembled_us: string;
  certified_by: string | null;
  certified_us: string | null;
  reads: number;
}

async function exportsWhere(app: AppContext, db: Db, where: string, params: unknown[]): Promise<ExportView[]> {
  const { rows } = await db.query<ExportRow>(
    `select e.id, e.subject_id, e.subject_label, e.export_sha256, e.pdf_content_sha256, e.content_bytes::text as content_bytes, e.sections,
            e.assembled_by_person, ${usOf('e.recorded_at')} as assembled_us, c.person_id as certified_by,
            case when c.export_id is null then null else ${usOf('c.recorded_at')} end as certified_us,
            (select count(*)::int from records.evidence_export_read x where x.export_id = e.id) as reads
       from records.evidence_export e left join records.evidence_export_certification c on c.export_id = e.id
      where e.subject_type = 'batch' and ${where} order by e.recorded_at desc, e.id`,
    params,
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.assembled_by_person, r.certified_by]));
  return rows.map((r) => ({
    exportId: r.id,
    batchId: r.subject_id,
    label: r.subject_label,
    state: r.certified_by ? 'CERTIFIED' : 'ASSEMBLED',
    exportSha256: r.export_sha256,
    pdfContentSha256: r.pdf_content_sha256,
    contentBytes: Number(r.content_bytes),
    sections: r.sections.map((s) => ({ name: s.name, kind: s.kind, title: s.title, chainKey: s.chainKey, sha256: s.sha256, bytes: s.bytes })),
    assembledBy: personRef(people, r.assembled_by_person, 'QA_REVIEWER'),
    assembledAt: app.formatInstant(r.assembled_us),
    certifiedBy: r.certified_by ? personRef(people, r.certified_by, 'QA_REVIEWER') : null,
    certifiedAt: r.certified_us ? app.formatInstant(r.certified_us) : null,
    reads: r.reads,
  }));
}

async function batchList(db: Db): Promise<ArchiveBatchSummary[]> {
  const { rows } = await db.query<{ id: string; batch_number: string; status: string | null; forms: ArchiveBatchSummary['formsState']; exports: number; certified: number }>(
    `select b.id, b.batch_number, s.state ->> 'status' as status, records.form_reconciliation_state(b.id) as forms,
            (select count(*)::int from records.evidence_export e where e.subject_type = 'batch' and e.subject_id = b.id::text) as exports,
            (select count(*)::int from records.evidence_export e join records.evidence_export_certification c on c.export_id = e.id
              where e.subject_type = 'batch' and e.subject_id = b.id::text) as certified
       from recipe.batch_execution b left join recipe.execution_state s on s.batch_id = b.id
      order by b.issued_at desc, b.id limit 200`,
  );
  return rows.map((r) => ({ batchId: r.id, batchNumber: r.batch_number, status: r.status ?? 'ISSUED', formsState: r.forms, exports: r.exports, certifiedExports: r.certified }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------------------------------------------------

/** One read-only REPEATABLE READ command of the actor: every query sees one snapshot (as the QP package assembly). */
async function inSnapshot<T>(pool: pg.Pool, who: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(who))]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    if (error instanceof HttpRefusal) throw error;
    throw commands.asKernelError(error);
  } finally {
    client.release();
  }
}

const noRecord = (f: BatchFacts) =>
  refusal(409, { code: 'EBMR-API-ARCHIVE', kind: 'NOT_ALLOWED', whatHappened: 'There is no record of this batch to copy yet. Nothing was recorded.', why: `Batch ${f.batchNumber} has no audit trail.`, controls: ['DI-41'], whatYouCanDo: ['Copy the batch once it has been issued.'] });

async function batchBundle(c: pg.PoolClient, f: BatchFacts): Promise<records.TrueCopyBundle> {
  const bundle = await records.trueCopyBundleFromSnapshot(c, `batch:${f.batchId}`);
  if ((JSON.parse(bundle.manifest) as records.Manifest).head === null) throw noRecord(f);
  return bundle;
}

const pdfTitle = (f: BatchFacts) => `Batch record ${f.batchNumber} (true copy)`;

interface BuiltExport {
  bundles: { name: string; title: string; bundle: records.TrueCopyBundle }[];
  exp: records.EvidenceExport;
}

async function buildExport(c: pg.PoolClient, app: AppContext, f: BatchFacts): Promise<BuiltExport> {
  const bundles: BuiltExport['bundles'] = [{ name: 'batch-record', title: `Batch record ${f.batchNumber}`, bundle: await batchBundle(c, f) }];
  for (const [prefix, name, title] of [
    ['batch_review', 'batch-review', `Review and audit-trail review of ${f.batchNumber}`],
    ['form_reconciliation', 'contingency-forms', `Contingency forms of ${f.batchNumber}`],
  ] as const) {
    const b = await records.trueCopyBundleFromSnapshot(c, `${prefix}:${f.batchId}`);
    if ((JSON.parse(b.manifest) as records.Manifest).head !== null) bundles.push({ name, title, bundle: b });
  }
  const pdf = await records.renderTrueCopyPdf((bundles[0] as BuiltExport['bundles'][number]).bundle, { title: pdfTitle(f), label: `Batch ${f.batchNumber}` });
  const generatedAt = (await c.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0]?.t ?? '';
  const summary = {
    batchId: f.batchId,
    batchNumber: f.batchNumber,
    status: f.status,
    retention: await retentionView(app, c, f),
    forms: await formsView(app, c, f.batchId),
  };
  const exp = records.assembleEvidenceExport({
    subject: { type: 'batch', id: f.batchId, label: `Batch ${f.batchNumber}` },
    generatedAt,
    bundles,
    pdfs: [{ name: 'batch-record-pdf', title: `Batch record ${f.batchNumber} (PDF/A-3)`, chainKey: `batch:${f.batchId}`, pdf: pdf.pdf, contentSha256: pdf.contentSha256 }],
    documents: [{ name: 'summary', title: 'Batch summary: status, retention and paper forms', mediaType: 'application/json', text: JSON.stringify(summary, null, 2) }],
  });
  return { bundles, exp };
}

async function one<T>(list: Promise<T[]>, what: string): Promise<T> {
  const x = (await list)[0];
  if (!x) throw new Error(`${what} was not found after it was recorded`);
  return x;
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(archiveActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.archive, {
    batches: async ({ requireSession }) => {
      requireSession();
      return { batches: await batchList(pool) };
    },
    batch: async ({ params, requireSession }) => {
      requireSession();
      const f = await facts(pool, params.batchId);
      return {
        batchId: f.batchId,
        batchNumber: f.batchNumber,
        status: f.status,
        retention: await retentionView(app, pool, f),
        forms: await formsView(app, pool, f.batchId),
        exports: await exportsWhere(app, pool, 'e.subject_id = $1', [f.batchId]),
      };
    },
    syncRetention: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const f = await facts(pool, params.batchId);
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const inputs = records.batchRetentionInputs(f.retention);
        const key = `batch:${f.batchId}`;
        const exists = (await c.query<{ s: boolean }>('select exists (select 1 from records.retention_schedule where record_key = $1) as s', [key])).rows[0]?.s;
        if (exists) {
          await records.updateRetentionInputs(c, key, inputs, body.reason);
        } else {
          const type = (await c.query<{ code: string }>("select code from records.record_register where retention_key = 'BATCH_RECORD' order by code limit 1")).rows[0]?.code;
          if (!type) {
            throw refusal(409, {
              code: 'EBMR-API-ARCHIVE', kind: 'NOT_ALLOWED', whatHappened: 'The retention of this batch was not stored. Nothing was recorded.',
              why: 'The record register has no approved record type with the batch-record retention key (DI-01).', controls: ['DI-47', 'DI-01'],
              whatYouCanDo: ['Ask QA to approve the batch record type in the record register first.'],
            });
          }
          await records.createRetentionSchedule(c, 'batch', f.batchId, type, inputs);
        }
        // A processing record follows the packaging records packed from it (dependency inheritance, DI-47).
        for (const [sup, dep] of [...f.supports.map((d) => [f.batchId, d]), ...f.dependsOn.map((s) => [s, f.batchId])] as [string, string][]) {
          const both = (await c.query<{ n: number }>('select count(*)::int as n from records.retention_schedule where record_key in ($1, $2)', [`batch:${sup}`, `batch:${dep}`])).rows[0]?.n;
          if (both === 2) await records.linkRetentionDependency(c, `batch:${sup}`, `batch:${dep}`, 'BULK_PACKED_INTO');
        }
        return null;
      });
      return retentionView(app, pool, f);
    },
    requestDisposal: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await facts(pool, params.batchId);
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const a = await records.requestDisposal(c, 'batch', params.batchId, body.reason);
        return { outcome: a.outcome, retainUntil: a.retainUntil, refusals: a.refusals };
      });
      return out.result;
    },
    issuePack: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const f = await facts(pool, params.batchId);
      if (['EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED'].includes(f.status)) {
        throw refusal(409, {
          code: 'EBMR-API-ARCHIVE', kind: 'NOT_ALLOWED', whatHappened: 'No contingency pack was issued.', why: `Batch ${f.batchNumber} is ${f.status}: packs are issued at its issue or at a stage start.`,
          controls: ['DI-43'], whatYouCanDo: ['Issue packs for a batch that is issued or in progress.'],
        });
      }
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await records.issueContingencyPack(c, {
          batchId: f.batchId, batchLabel: f.batchNumber, moment: body.moment, stageRef: body.stageRef ?? null, templateRef: body.templateRef,
          destination: body.destination, pages: body.pages, reason: body.reason,
        });
        return null;
      });
      return formsView(app, pool, f.batchId);
    },
    formEvent: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const batchId = (await pool.query<{ b: string }>('select batch_id as b from records.contingency_form where id = $1', [params.formId])).rows[0]?.b;
      if (!batchId) {
        throw refusal(404, { code: 'EBMR-API-NO-FORM', kind: 'INVALID_INPUT', whatHappened: 'This contingency form was not found.', why: `${params.formId} is no issued form.`, whatYouCanDo: ['Reload the batch.'] });
      }
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await records.recordContingencyFormEvent(c, params.formId, body.event, body.reason ?? null, body.reference ?? null);
        return null;
      });
      return formsView(app, pool, batchId);
    },
    pdf: async ({ params, actor }) => {
      const f = await facts(pool, params.batchId);
      const bundle = await inSnapshot(pool, actor(), (c) => batchBundle(c, f));
      const out = await records.renderTrueCopyPdf(bundle, { title: pdfTitle(f), label: `Batch ${f.batchNumber}` });
      return { fileName: `${f.batchNumber}-true-copy.pdf`, pdfBase64: Buffer.from(out.pdf).toString('base64'), pdfSha256: out.pdfSha256, contentSha256: out.contentSha256, recordDate: out.recordDate };
    },
    assembleExport: async ({ params, actor, idempotencyKey, requestHash }) => {
      const f = await facts(pool, params.batchId);
      // The bundles and the PDF from one snapshot; the registration that follows is checked again by the database.
      const built = await inSnapshot(pool, actor(), (c) => buildExport(c, app, f));
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        for (const b of built.bundles) await records.registerTrueCopy(c, b.bundle, `Evidence export of batch ${f.batchNumber}`);
        return records.registerEvidenceExport(c, built.exp);
      });
      return one(exportsWhere(app, pool, 'e.id = $1::uuid', [out.result]), 'the export');
    },
    inspection: async ({ actor }) => {
      await withActorCommand(pool, actor(), (c) => c.query("select iam.require_permission('ARCHIVE.INSPECT', '{}'::jsonb)")).catch((e: unknown) => {
        throw commands.asKernelError(e);
      });
      return { exports: await exportsWhere(app, pool, 'exists (select 1 from records.evidence_export_certification c2 where c2.export_id = e.id)', []) };
    },
    exportFile: async ({ params, actor }) => {
      const r = await withActorCommand(pool, actor(), (c) => records.readEvidenceExport(c, params.exportId)).catch((e: unknown) => {
        throw commands.asKernelError(e);
      });
      const label = (await pool.query<{ l: string }>('select subject_label as l from records.evidence_export where id = $1', [params.exportId])).rows[0]?.l ?? 'export';
      return { exportId: r.exportId, fileName: `${label.replace(/[^A-Za-z0-9-]+/g, '-')}-evidence-export.json`, exportSha256: r.exportSha256, text: r.text };
    },
    verify: async ({ body, requireSession }) => {
      requireSession();
      const parsed = (() => {
        try {
          return JSON.parse(body.text) as { exportSha256?: unknown };
        } catch {
          return null;
        }
      })();
      const claimed = typeof parsed?.exportSha256 === 'string' ? parsed.exportSha256 : null;
      const reg = claimed
        ? (await pool.query<{ id: string; label: string; certified: boolean }>(
            `select e.id, e.subject_label as label, exists (select 1 from records.evidence_export_certification c where c.export_id = e.id) as certified
               from records.evidence_export e where e.export_sha256 = $1`,
            [claimed],
          )).rows[0]
        : undefined;
      const report = await records.verifyEvidenceExportText(body.text, reg ? { exportSha256: claimed ?? '' } : undefined);
      const problems = reg ? report.problems : [...report.problems, 'no registered export has this SHA-256: the file is not one this system issued'];
      return {
        ok: problems.length === 0,
        exportSha256: report.exportSha256,
        reference: report.reference,
        registered: reg ? { exportId: reg.id, label: reg.label, certified: reg.certified } : null,
        sections: report.sections,
        problems,
      };
    },
  });
  return Promise.resolve();
}
