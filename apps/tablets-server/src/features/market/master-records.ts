/**
 * The master-record and compendial acts of slice 7g WP3 (decision 0025; contract ns/market-config.ts):
 *  - change records: their validation and per-market regulatory assessments (recipe.add_change_validation,
 *    recipe.add_change_regulatory; MBR.CHANGE_RECORD; PR-04);
 *  - a version's periodic reviews (recipe.record_periodic_review; MBR.APPROVE; PR-05) and its risk-assessment links
 *    (recipe.unlink_risk_assessment; MBR.AUTHOR; PR-07);
 *  - slice 7h (B1-B4): raising a change record and recording a risk assessment (recipe.record_change_record,
 *    recipe.record_risk_assessment; MBR.CHANGE_RECORD; PR-06, PR-07), linking an assessment to a draft and setting the
 *    draft's change record, effective-from and review due (recipe.link_risk_assessment, recipe.set_draft_attributes;
 *    MBR.AUTHOR), and importing a sandbox test-run result as the version's SANDBOX_RUN evidence (sandbox-run-results.ts;
 *    recipe.record_evidence; MBR.AUTHOR; decision D-P7R-16);
 *  - the EU qualified-person register (read; registering is the signable QP_REGISTER, signables.ts);
 *  - the compendial rule sets with QA's verification (tab.record_rule_set_verification; signing is RULE_SET_VERIFY) and
 *    the retirement of a reference document version (tab.retire_reference_document; MASTERDATA.CHANGE).
 * Each act runs the database's function in the person's command; the database checks the right and every rule.
 */
import type pg from 'pg';
import type { MbrChangeRecordView, MbrReviewView, QpRegisterView, RiskAssessmentView, Routes, RuleSetVerificationView } from '@ebmr/api-contract';
import { lifecycle } from '@ebmr/recipe-core';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { Handlers } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { recordSandboxRun, resultToImport, sandboxRunResults } from './sandbox-run-results.ts';

type Db = pg.Pool | pg.PoolClient;
const us = (col: string): string => `case when ${col} is null then null else ${usOf(col)} end`;

export async function changeRecordViews(app: AppContext, db: Db, id?: string): Promise<MbrChangeRecordView[]> {
  const { rows } = await db.query<{ id: string; number: string; title: string; change_class: string; process_impacting: boolean; at_us: string }>(
    `select c.id, c.number, c.title, c.change_class, c.process_impacting, ${usOf('c.recorded_at')} as at_us
       from recipe.change_record c where ($1::uuid is null or c.id = $1) order by c.recorded_at desc limit 200`,
    [id ?? null],
  );
  const ids = rows.map((r) => r.id);
  const { rows: val } = await db.query<{ id: string; cr: string; ref: string; description: string | null; by: string; at_us: string }>(
    `select v.id, v.change_record_id as cr, v.validation_ref as ref, v.description, v.recorded_by_person as by, ${usOf('v.recorded_at')} as at_us
       from recipe.change_record_validation v where v.change_record_id = any ($1::uuid[]) order by v.recorded_at`,
    [ids],
  );
  const { rows: reg } = await db.query<{ id: string; cr: string; market: string; category: string; ref: string | null; by: string; at_us: string }>(
    `select g.id, g.change_record_id as cr, g.market, g.reporting_category as category, g.regulatory_reference as ref, g.recorded_by_person as by, ${usOf('g.recorded_at')} as at_us
       from recipe.change_record_regulatory g where g.change_record_id = any ($1::uuid[]) order by g.market, g.recorded_at`,
    [ids],
  );
  const people = await peopleOf(db, [...val.map((v) => v.by), ...reg.map((g) => g.by)]);
  return rows.map((r) => ({
    changeRecordId: r.id,
    number: r.number,
    title: r.title,
    changeClass: r.change_class,
    processImpacting: r.process_impacting,
    recordedAt: app.formatInstant(r.at_us),
    validations: val.filter((v) => v.cr === r.id).map((v) => ({ id: v.id, validationRef: v.ref, description: v.description, recordedBy: personRef(people, v.by, 'QA_MBR_APPROVER'), recordedAt: app.formatInstant(v.at_us) })),
    regulatory: reg.filter((g) => g.cr === r.id).map((g) => ({ id: g.id, market: g.market, reportingCategory: g.category, reference: g.ref, recordedBy: personRef(people, g.by, 'REGULATORY_SIGNER'), recordedAt: app.formatInstant(g.at_us) })),
  }));
}

const changeRecordMissing = (id: string) =>
  refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'INVALID_INPUT', whatHappened: 'There is no change record with this id. Nothing was recorded.', why: `Change record ${id} does not exist.`, whatYouCanDo: ['Reload the list of change records.'], whoCanHelp: ['QA'], controls: ['PR-04'] });

/** An assessment of change record `id`: the database checks the right first; an id that names no change record (its foreign key) is answered as not found. */
async function onChangeRecord(id: string, insert: Promise<pg.QueryResult<{ id: string }>>): Promise<string> {
  try {
    return (await insert).rows[0]?.id ?? '';
  } catch (e) {
    if ((e as { code?: unknown }).code === '23503') throw changeRecordMissing(id);
    throw e;
  }
}

async function oneChangeRecord(app: AppContext, db: Db, id: string): Promise<MbrChangeRecordView> {
  const [v] = await changeRecordViews(app, db, id);
  if (!v) throw changeRecordMissing(id);
  return v;
}

export async function versionReviewView(app: AppContext, db: Db, versionId: string): Promise<MbrReviewView> {
  const { rows: v } = await db.query<{ state: string | null }>('select recipe.version_state(v.id) as state from recipe.mbr_version v where v.id = $1', [versionId]);
  if (!v[0]) throw refusal(404, { code: 'EBMR-RCP-020', kind: 'INVALID_INPUT', whatHappened: 'There is no MBR version with this id.', why: `MBR version ${versionId} does not exist.`, whatYouCanDo: ['Reload the master record.'], whoCanHelp: ['QA'], controls: ['PR-05'] });
  const { rows } = await db.query<{ id: string; outcome: MbrReviewView['reviews'][number]['outcome']; summary: string; next_due: string; by: string; at_us: string }>(
    `select r.id, r.outcome, r.summary, to_char(r.next_due, 'YYYY-MM-DD') as next_due, r.person_id as by, ${usOf('r.recorded_at')} as at_us
       from recipe.periodic_review r where r.version_id = $1 order by r.recorded_at desc`,
    [versionId],
  );
  const { rows: links } = await db.query<{ risk_assessment_id: string; code: string; version: string; risk_class: string; rationale_ref: string; subjects: string[] | null }>(
    'select risk_assessment_id, code, version, risk_class, rationale_ref, subjects from recipe.current_risk_links($1) order by code, version',
    [versionId],
  );
  const people = await peopleOf(db, rows.map((r) => r.by));
  const { rows: d } = await db.query<{ cr_id: string | null; cr_number: string | null; cr_title: string | null; eff_us: string | null; review_due: string | null }>(
    `select v.change_record_id as cr_id, c.number as cr_number, c.title as cr_title, ${us('v.effective_from')} as eff_us, to_char(v.review_due, 'YYYY-MM-DD') as review_due
       from recipe.mbr_version v left join recipe.change_record c on c.id = v.change_record_id where v.id = $1`,
    [versionId],
  );
  const draft = d[0];
  const evidence = await lifecycle.evidenceStatus(db, versionId);
  return {
    versionId,
    state: v[0].state ?? 'UNKNOWN',
    draft: {
      changeRecord: draft?.cr_id && draft.cr_number !== null && draft.cr_title !== null ? { changeRecordId: draft.cr_id, number: draft.cr_number, title: draft.cr_title } : null,
      effectiveFrom: draft?.eff_us ? app.formatInstant(draft.eff_us) : null,
      reviewDue: draft?.review_due ?? null,
    },
    evidence: {
      contentHash: evidence.contentHash,
      complete: evidence.complete,
      missing: evidence.missing,
      items: Object.entries(evidence.items as Record<string, { result: 'PASS' | 'FAIL'; problems: string[] | null }>)
        .map(([kind, i]) => ({ kind: kind as MbrReviewView['evidence']['items'][number]['kind'], result: i.result, problems: i.problems ?? [] }))
        .sort((a, b) => EVIDENCE_ORDER.indexOf(a.kind) - EVIDENCE_ORDER.indexOf(b.kind)),
    },
    reviews: rows.map((r) => ({ reviewId: r.id, outcome: r.outcome, summary: r.summary, nextDue: r.next_due, reviewedBy: personRef(people, r.by, 'QA_MBR_APPROVER'), recordedAt: app.formatInstant(r.at_us) })),
    riskAssessments: links.map((l) => ({ riskAssessmentId: l.risk_assessment_id, code: l.code, version: l.version, riskClass: l.risk_class, rationaleRef: l.rationale_ref, subjects: l.subjects ?? [] })),
  };
}

const EVIDENCE_ORDER = ['VALIDATOR', 'VERIFICATION', 'TEST_VECTORS', 'SANDBOX_RUN'];

export async function riskAssessmentViews(app: AppContext, db: Db, id?: string): Promise<RiskAssessmentView[]> {
  const { rows } = await db.query<{ id: string; code: string; version: string; title: string; risk_class: string; rationale_ref: string; by: string; at_us: string }>(
    `select r.id, r.code, r.version, r.title, r.risk_class, r.rationale_ref, r.recorded_by_person as by, ${usOf('r.recorded_at')} as at_us
       from recipe.risk_assessment r where ($1::uuid is null or r.id = $1) order by r.recorded_at desc limit 200`,
    [id ?? null],
  );
  const people = await peopleOf(db, rows.map((r) => r.by));
  return rows.map((r) => ({
    riskAssessmentId: r.id, code: r.code, version: r.version, title: r.title, riskClass: r.risk_class, rationaleRef: r.rationale_ref,
    recordedBy: personRef(people, r.by, 'QA_MBR_APPROVER'), recordedAt: app.formatInstant(r.at_us),
  }));
}

/** A second record with a unique key (change record number; risk assessment code and version) is answered as a conflict. */
async function uniqueAsConflict<T>(work: () => Promise<T>, what: string, controls: string[]): Promise<T> {
  try {
    return await work();
  } catch (e) {
    const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') {
      throw refusal(409, { code: 'EBMR-API-ALREADY-RECORDED', kind: 'NOT_ALLOWED', whatHappened: `${what} is already recorded. Nothing was recorded.`, why: `${what} is recorded once; a new one takes another number or version.`, whatYouCanDo: ['Use the one recorded, or give a new number or version.'], whoCanHelp: ['QA'], controls });
    }
    throw e;
  }
}

export async function qpRegisterView(app: AppContext, db: Db): Promise<QpRegisterView> {
  const { rows: importers } = await db.query<{ code: string; name: string; mia_number: string }>('select code, name, mia_number from recipe.eu_importer order by code');
  const { rows: candidates } = await db.query<{ person_id: string }>(
    `select distinct g.person_id from iam.role_grant g join iam.person p on p.id = g.person_id
      where g.role_code = 'EU_QP' and g.status = 'APPROVED' and g.valid_from <= clock_timestamp() and (g.valid_to is null or g.valid_to > clock_timestamp()) order by g.person_id`,
  );
  const { rows } = await db.query<{ id: string; person_id: string; action: 'REGISTER' | 'WITHDRAW'; code: string; mia_number: string; by_person: string; at_us: string }>(
    `select q.id, q.person_id, q.action, i.code, q.mia_number, q.by_person, ${usOf('q.recorded_at')} as at_us
       from recipe.qp_register q join recipe.eu_importer i on i.id = q.importer_id order by q.recorded_at desc`,
  );
  const people = await peopleOf(db, [...candidates.map((c) => c.person_id), ...rows.flatMap((r) => [r.person_id, r.by_person])]);
  return {
    importers: importers.map((i) => ({ code: i.code, name: i.name, miaNumber: i.mia_number })),
    candidates: candidates.map((c) => personRef(people, c.person_id, 'EU_QP')),
    entries: rows.map((r) => ({ entryId: r.id, person: personRef(people, r.person_id, 'EU_QP'), action: r.action, importerCode: r.code, miaNumber: r.mia_number, by: personRef(people, r.by_person, 'QA_REVIEWER'), recordedAt: app.formatInstant(r.at_us) })),
  };
}

export async function ruleSetViews(app: AppContext, db: Db, where: { code?: string; version?: number } = {}): Promise<RuleSetVerificationView[]> {
  const { rows } = await db.query<{
    code: string; version: number; test: string; pharmacopoeia: string; markets: string[]; confidence: string; source: string; problem: string | null;
    v_id: string | null; document_ref: string | null; note: string | null; v_by: string | null; v_us: string | null; s_by: string | null; s_us: string | null;
  }>(
    `select s.code, s.version, s.test, s.pharmacopoeia, s.markets, s.confidence, s.source, tab.rule_set_verification_problem(s.code, s.version) as problem,
            v.id as v_id, v.document_ref, v.note, v.recorded_by_person as v_by, ${us('v.recorded_at')} as v_us, g.signed_by_person as s_by, ${us('g.signed_at')} as s_us
       from tab.compendial_rule_set s
       left join lateral (select x.* from tab.rule_set_verification x where x.code = s.code and x.version = s.version order by x.recorded_at desc, x.id desc limit 1) v on true
       left join tab.rule_set_verification_signature g on g.verification_id = v.id
      where ($1::text is null or s.code = $1) and ($2::integer is null or s.version = $2)
      order by s.code, s.version`,
    [where.code ?? null, where.version ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.v_by, r.s_by]));
  return rows.map((r) => ({
    code: r.code, version: r.version, test: r.test, pharmacopoeia: r.pharmacopoeia, markets: r.markets, confidence: r.confidence, source: r.source, problem: r.problem,
    verification: r.v_id && r.document_ref !== null && r.note !== null && r.v_by && r.v_us
      ? {
          verificationId: r.v_id, documentRef: r.document_ref, note: r.note, recordedBy: personRef(people, r.v_by, 'QA_MBR_APPROVER'), recordedAt: app.formatInstant(r.v_us),
          signedBy: r.s_by ? personRef(people, r.s_by, 'QA_MBR_APPROVER') : null, signedAt: r.s_us ? app.formatInstant(r.s_us) : null,
        }
      : null,
  }));
}

type MasterRecordRoutes =
  | 'changeRecords' | 'addChangeRegulatory' | 'addChangeValidation' | 'versionReview' | 'recordPeriodicReview' | 'unlinkRiskAssessment' | 'qpRegister' | 'ruleSets'
  | 'recordRuleSetVerification' | 'retireReferenceDocument'
  | 'recordChangeRecord' | 'riskAssessments' | 'recordRiskAssessment' | 'linkRiskAssessment' | 'setDraftAttributes' | 'sandboxRunResults' | 'importSandboxRunResult';

export function masterRecordHandlers(app: AppContext): Pick<Handlers<Routes['marketConfig']>, MasterRecordRoutes> {
  const pool = app.pools.app;
  return {
    changeRecords: async ({ requireSession }) => {
      requireSession();
      return { changeRecords: await changeRecordViews(app, pool) };
    },
    addChangeRegulatory: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        onChangeRecord(params.changeRecordId, c.query<{ id: string }>('select recipe.add_change_regulatory($1, $2, $3, $4) as id', [params.changeRecordId, body.market, body.reportingCategory, body.reference ?? null])),
      );
      return oneChangeRecord(app, pool, params.changeRecordId);
    },
    addChangeValidation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        onChangeRecord(params.changeRecordId, c.query<{ id: string }>('select recipe.add_change_validation($1, $2, $3) as id', [params.changeRecordId, body.validationRef, body.description ?? null])),
      );
      return oneChangeRecord(app, pool, params.changeRecordId);
    },
    versionReview: async ({ params, requireSession }) => {
      requireSession();
      return versionReviewView(app, pool, params.versionId);
    },
    recordPeriodicReview: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) => lifecycle.recordPeriodicReview(c, params.versionId, body.outcome, body.summary, body.nextDue));
      return versionReviewView(app, pool, params.versionId);
    },
    unlinkRiskAssessment: async ({ params, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await lifecycle.unlinkRiskAssessment(c, params.versionId, params.riskAssessmentId);
        return params.riskAssessmentId;
      });
      return versionReviewView(app, pool, params.versionId);
    },
    // Slice 7h (B1-B4)
    recordChangeRecord: async ({ body, actor, idempotencyKey, requestHash }) => {
      const def: lifecycle.ChangeRecordDefinition = {
        number: body.number, title: body.title, changeClass: body.changeClass, processImpacting: body.processImpacting,
        ...(body.qmsReference !== undefined ? { qmsReference: body.qmsReference } : {}),
        ...(body.validationRef !== undefined ? { validationRef: body.validationRef } : {}),
        ...(body.validationDescription !== undefined ? { validationDescription: body.validationDescription } : {}),
      };
      const { result } = await uniqueAsConflict(() => withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) => lifecycle.recordChangeRecord(c, def)), `Change record ${body.number}`, ['PR-06']);
      return oneChangeRecord(app, pool, result);
    },
    riskAssessments: async ({ requireSession }) => {
      requireSession();
      return { riskAssessments: await riskAssessmentViews(app, pool) };
    },
    recordRiskAssessment: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result } = await uniqueAsConflict(
        () => withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
          lifecycle.recordRiskAssessment(c, { code: body.code, version: body.version, title: body.title, riskClass: body.riskClass, rationaleRef: body.rationaleRef }),
        ),
        `Risk assessment ${body.code} version ${body.version}`,
        ['PR-07'],
      );
      const [v] = await riskAssessmentViews(app, pool, result);
      if (!v) throw new Error(`risk assessment ${result} vanished after it was recorded`);
      return v;
    },
    linkRiskAssessment: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await lifecycle.linkRiskAssessment(c, params.versionId, body.riskAssessmentId, body.subjects ?? []);
        return body.riskAssessmentId;
      });
      return versionReviewView(app, pool, params.versionId);
    },
    setDraftAttributes: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      // A member left out keeps its value; null clears it (the database checks the right, the state and the change record).
      const attrs: lifecycle.DraftAttributes = {
        ...(body.changeRecordId !== undefined ? { changeRecordId: body.changeRecordId } : {}),
        ...(body.effectiveFrom !== undefined ? { effectiveFrom: body.effectiveFrom } : {}),
        ...(body.reviewDue !== undefined ? { reviewDue: body.reviewDue } : {}),
      };
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await lifecycle.setDraftAttributes(c, params.versionId, attrs);
        return params.versionId;
      });
      return versionReviewView(app, pool, params.versionId);
    },
    sandboxRunResults: async ({ params, requireSession }) => {
      requireSession();
      await versionReviewView(app, pool, params.versionId);
      return { results: await sandboxRunResults(app, pool, params.versionId) };
    },
    importSandboxRunResult: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const a = actor();
      await versionReviewView(app, pool, params.versionId);
      const result = await resultToImport(app, pool, params.versionId, { fileName: body.fileName, text: body.text });
      await withIdempotentActorCommand(pool, a, idempotencyKey ?? '', requestHash, async (c) => (await recordSandboxRun(c, params.versionId, result)).evidenceId);
      return versionReviewView(app, pool, params.versionId);
    },
    qpRegister: async ({ requireSession }) => {
      requireSession();
      return qpRegisterView(app, pool);
    },
    ruleSets: async ({ requireSession }) => {
      requireSession();
      return { ruleSets: await ruleSetViews(app, pool) };
    },
    recordRuleSetVerification: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const version = Number(params.version);
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select tab.record_rule_set_verification($1, $2, $3, $4) as id', [params.code, version, body.documentRef, body.note]);
        return rows[0]?.id ?? '';
      });
      const [v] = await ruleSetViews(app, pool, { code: params.code, version });
      if (!v) throw new Error(`rule set ${params.code} version ${params.version} vanished after its verification`);
      return v;
    },
    retireReferenceDocument: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      // DI-22: the person's own reason is the command's (the retirement row carries it too).
      const { result } = await withIdempotentActorCommand(pool, actor({ reasonCode: body.status, reasonText: body.reason }), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select tab.retire_reference_document($1, $2, $3::date, $4) as id', [params.documentId, body.status, body.effectiveFrom, body.reason]);
        return rows[0]?.id ?? '';
      });
      return { retirementId: result };
    },
  };
}
