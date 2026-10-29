/**
 * Feature `labels` (Phase 6 slice 6c, GMP): packaging line completion (contract ns/labels.ts; recipe-core 0990, site
 * services 0950, tablets 1230; IN-16, IN-31, PR-16, PR-32, PR-34, PR-36, PR-39). Every rule is the database's: each write
 * is the person's own command through a definer (LABEL.DESIGN, LABEL.APPROVE, MBR.AUTHOR, LABEL_STORE.TRANSACT,
 * STEP.EXECUTE, STEP.VERIFY, QA.FLOOR_APPROVE), and the views come from the database (tab.packaging_completion_view,
 * recipe.master_labelling) or plain reads of its tables. Template approval and the post-use verification are attributed
 * acts of a second person, not signature ceremonies (D-P6c-10).
 */
import { routes, type LabelStoreView, type LabelTemplateView, type MasterLabellingView, type PackagingCompletionView } from '@ebmr/api-contract';
import type { commands } from '@ebmr/kernel';
import type { engine } from '@ebmr/recipe-core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { GuidanceEntry } from '../../platform/http/guidance.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { compact, peopleOf } from '../common/people.ts';
import { peopleText } from '../execution/people-text.ts';
import { runContext } from '../execution/runs.ts';

type JsonValue = commands.JsonValue;
type Db = Pick<pg.Pool, 'query'>;

export const guidance: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-LBL-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The packaging record refused this.',
    whatYouCanDo: ['Read the reason below; the packaging completion page names what is still missing.'],
    whoCanHelp: ['The line supervisor', 'QA (shop floor)'],
    controls: ['IN-16', 'IN-31', 'PR-16', 'PR-32', 'PR-34', 'PR-36', 'PR-39'],
  },
  'EBMR-LBL-003': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The label template cannot be approved as it stands.',
    whatYouCanDo: ['Save a new version of the template that binds every field named below, then ask for its approval.'],
    whoCanHelp: ['The MBR author or master-data steward (designer)', 'QA (MBR approver)'],
    controls: ['IN-31'],
  },
  'EBMR-LBL-011': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The packaging master cannot be approved: its labelling declaration is incomplete.',
    whatYouCanDo: ['Declare the 211.122(g) option of every cut-label item, or name an approved template, on a new draft version.'],
    whoCanHelp: ['The MBR author', 'QA (MBR approver)'],
    controls: ['PR-36', 'IN-31'],
  },
  'EBMR-LBL-033': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The coding on the specimen is not the record\'s. Nothing was recorded.',
    whatYouCanDo: ['Stop the line, check the coder against the batch data, correct it and take the specimen again.'],
    whoCanHelp: ['The line supervisor', 'QA (shop floor)'],
    controls: ['IN-16', 'IN-31'],
  },
  'EBMR-LBL-060': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The printed-materials step cannot close yet.',
    whatYouCanDo: ['Record the specimen named below, or ask QA to resolve the open line stop, then sign again.'],
    whoCanHelp: ['The line supervisor', 'QA (shop floor)'],
    controls: ['IN-16', 'PR-16', 'PR-36'],
  },
  'EBMR-LBL-061': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The packaging order cannot complete yet.',
    whatYouCanDo: ['Close the gap named below (a checker signature, a specimen, a line stop or the post-use inspection), then sign off again.'],
    whoCanHelp: ['The line supervisor', 'QA (shop floor)'],
    controls: ['PR-16', 'PR-34', 'PR-36'],
  },
  'EBMR-LBL-062': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The line is stopped: no print job is released until QA resolves the stop.',
    whatYouCanDo: ['Ask QA to investigate the vision rejection and resolve the line stop with a reason.'],
    whoCanHelp: ['QA (shop floor)'],
    controls: ['PR-36'],
  },
};

interface TemplateRow {
  id: string; code: string; version: number; scope: LabelTemplateView['scope']; markets: string[]; layout: LabelTemplateView['layout'];
  fields: LabelTemplateView['fields']; status: LabelTemplateView['status']; created_by_person: string; approved_by: string | null; problem: string | null;
}

async function templates(db: Db, where: string, params: unknown[]): Promise<LabelTemplateView[]> {
  const { rows } = await db.query<TemplateRow>(
    `select t.id, t.code, t.version, t.scope, t.markets, t.layout, t.fields, recipe.label_template_status(t.id) as status, t.created_by_person,
            (select e.by_person from recipe.label_template_event e where e.template_id = t.id and e.event = 'APPROVED') as approved_by,
            recipe.label_template_approval_problem(t.id) as problem
       from recipe.label_template t ${where} order by t.code, t.version desc limit 500`,
    params,
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.created_by_person, r.approved_by]));
  const name = (id: string | null): string | null => (id ? (people.get(id)?.legalName ?? 'unknown person') : null);
  return rows.map((r) => ({
    templateId: r.id, code: r.code, version: r.version, ref: `${r.code}-v${String(r.version)}`, scope: r.scope, markets: r.markets, layout: r.layout,
    fields: r.fields, status: r.status, createdBy: name(r.created_by_person) ?? 'unknown person', approvedBy: name(r.approved_by),
    approvalProblem: r.status === 'DRAFT' ? r.problem : null,
  }));
}

async function template(db: Db, id: string): Promise<LabelTemplateView> {
  const [t] = await templates(db, 'where t.id = $1', [id]);
  if (!t) throw refusal(404, { code: 'EBMR-LBL-004', kind: 'INVALID_INPUT', whatHappened: 'There is no label template with this id.', why: `Template ${id} does not exist.`, whatYouCanDo: ['Open the template from the list.'] });
  return t;
}

async function store(db: Db, lotId: string): Promise<LabelStoreView> {
  const lot = (await db.query<{ lot_code: string; material_name: string; material_kind: string; status: string | null; balance: string }>(
    `select l.lot_code, l.material_name, l.material_kind, (select s.state from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = l.id) as status,
            site.label_store_balance(l.id)::text as balance from site.material_lot l where l.id = $1`,
    [lotId],
  )).rows[0];
  if (!lot || lot.material_kind !== 'PRINTED_PACKAGING') {
    throw refusal(404, { code: 'EBMR-LBL-021', kind: 'INVALID_INPUT', whatHappened: 'The label store holds printed-packaging lots only.', why: `Lot ${lotId} is no printed-packaging lot.`, whatYouCanDo: ['Choose a printed-packaging lot.'] });
  }
  const { rows } = await db.query<{ id: string; kind: LabelStoreView['transactions'][number]['kind']; quantity: string; batch_ref: string | null; reason: string | null; performed_by_person: string; at: string }>(
    'select t.id, t.kind, t.quantity::text as quantity, t.batch_ref, t.reason, t.performed_by_person, t.performed_at::text as at from site.label_store_transaction t where t.lot_id = $1 order by t.performed_at, t.id',
    [lotId],
  );
  const people = await peopleOf(db, rows.map((r) => r.performed_by_person));
  return {
    lotId, lotCode: lot.lot_code, material: lot.material_name, status: lot.status ?? 'UNKNOWN', balance: lot.balance,
    transactions: rows.map((r) => ({ transactionId: r.id, kind: r.kind, lotId, lotCode: lot.lot_code, quantity: r.quantity, batchRef: r.batch_ref, reason: r.reason, by: people.get(r.performed_by_person)?.legalName ?? 'unknown person', at: r.at })),
  };
}

async function packaging(db: pg.Pool, batchId: string): Promise<PackagingCompletionView> {
  const v = (await db.query<{ v: PackagingCompletionView | null }>('select tab.packaging_completion_view($1) as v', [batchId])).rows[0]?.v;
  if (!v) throw refusal(404, { code: 'EBMR-LBL-030', kind: 'INVALID_INPUT', whatHappened: 'There is no batch with this id.', why: `Batch ${batchId} does not exist.`, whatYouCanDo: ['Open the packaging order from its batch.'] });
  return withPeopleText(db, batchId, v);
}

/**
 * Slice 7u (R10 #14): the database's words name steps by key ("step p-g21@ is not performed"); the screen names them by
 * number and MBR name, as the step screens do (peopleText). Display only; without the batch's definition the words stay.
 */
async function withPeopleText(db: pg.Pool, batchId: string, v: PackagingCompletionView): Promise<PackagingCompletionView> {
  try {
    return packagingViewText((await runContext(db, batchId)).def, v);
  } catch {
    return v;
  }
}

/** The packaging view with its steps and problems as people read them (withPeopleText). */
export function packagingViewText(def: engine.BatchDefinition, v: PackagingCompletionView): PackagingCompletionView {
  const say = (t: string | null): string | null => (t === null ? null : peopleText({ def }, t));
  const stepText = (key: string): string => peopleText({ def }, `step ${key}`).replace(/^step /, '');
  return { ...v, completionProblem: say(v.completionProblem), steps: v.steps.map((s) => ({ ...s, stepText: stepText(s.stepKey), problem: say(s.problem) })) };
}

async function master(db: Db, versionId: string): Promise<MasterLabellingView> {
  if ((await db.query('select 1 from recipe.mbr_version where id = $1', [versionId])).rowCount === 0) {
    throw refusal(404, { code: 'EBMR-LBL-010', kind: 'INVALID_INPUT', whatHappened: 'There is no MBR version with this id.', why: `Version ${versionId} does not exist.`, whatYouCanDo: ['Open the packaging master from the designer.'] });
  }
  return (await db.query<{ v: MasterLabellingView }>('select recipe.master_labelling($1) as v', [versionId])).rows[0]?.v as MasterLabellingView;
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  type Ctx = { actor: () => Parameters<typeof withIdempotentActorCommand>[1]; idempotencyKey: string | null | undefined; requestHash: string };
  /** One write as the person's own command (idempotent by the request's key); returns the definer's result. */
  const write = async (ctx: Ctx, sql: string, params: unknown[]): Promise<unknown> =>
    (await withIdempotentActorCommand(pool, ctx.actor(), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => (await c.query<{ r: JsonValue }>(sql, params)).rows[0]?.r ?? null)).result;
  /** The batch a specimen, inspection or line stop belongs to (for the view after the write). */
  const batchOf = async (table: 'tab.packaging_specimen' | 'tab.post_use_inspection' | 'tab.line_stop', id: string): Promise<string> => {
    const r = (await pool.query<{ b: string }>(`select batch_id as b from ${table} where id = $1`, [id])).rows[0]?.b;
    if (!r) throw refusal(404, { code: 'EBMR-LBL-037', kind: 'INVALID_INPUT', whatHappened: 'There is no such record.', why: `${id} is not found.`, whatYouCanDo: ['Reload the packaging completion page.'] });
    return r;
  };
  bindRoutes(scope, app, routes.labels, {
    bindings: async ({ requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ code: LabelTemplateView['fields'][number]; description: string; india_required: boolean; print_field: string | null }>('select code, description, india_required, print_field from recipe.label_field_binding order by code');
      return { bindings: rows.map((r) => ({ code: r.code, description: r.description, indiaRequired: r.india_required, printField: r.print_field })) };
    },
    templates: async ({ query, requireSession }) => {
      requireSession();
      const all = await templates(pool, '', []);
      return { templates: query.status ? all.filter((t) => t.status === query.status) : all };
    },
    template: async ({ params, requireSession }) => {
      requireSession();
      return template(pool, params.templateId);
    },
    createTemplate: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { attribution: _a, ...p } = body;
      void _a;
      const id = (await write({ actor, idempotencyKey, requestHash }, 'select recipe.create_label_template($1::jsonb) as r', [JSON.stringify(compact(p))])) as string;
      return template(pool, id);
    },
    approveTemplate: async ({ params, actor, idempotencyKey, requestHash }) => {
      await write({ actor, idempotencyKey, requestHash }, 'select recipe.approve_label_template($1) as r', [params.templateId]);
      return template(pool, params.templateId);
    },
    masterLabelling: async ({ params, requireSession }) => {
      requireSession();
      return master(pool, params.versionId);
    },
    declareLabelling: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await write({ actor, idempotencyKey, requestHash }, 'select recipe.declare_packaging_labelling($1, $2, $3, $4, $5, $6) as r',
        [params.versionId, body.step, body.item, body.form, body.templateId ?? null, body.option211122g ?? null]);
      return master(pool, params.versionId);
    },
    store: async ({ params, requireSession }) => {
      requireSession();
      return store(pool, params.lotId);
    },
    openStoreTransaction: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { attribution: _a, ...p } = body;
      void _a;
      await write({ actor, idempotencyKey, requestHash }, 'select site.open_label_store_transaction($1::jsonb) as r', [JSON.stringify(compact(p))]);
      return store(pool, body.lotId);
    },
    packaging: async ({ params, requireSession }) => {
      requireSession();
      return packaging(pool, params.batchId);
    },
    recordCodingSpecimen: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await write({ actor, idempotencyKey, requestHash }, 'select tab.record_coding_specimen($1, $2, $3, $4::jsonb) as r', [params.batchId, params.stepKey, body.position, JSON.stringify(compact(body.coded))]);
      return packaging(pool, params.batchId);
    },
    recordLabelSpecimen: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await write({ actor, idempotencyKey, requestHash }, 'select tab.record_label_specimen($1, $2, $3, $4) as r', [params.batchId, params.stepKey, body.item, body.note ?? null]);
      return packaging(pool, params.batchId);
    },
    voidSpecimen: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const batch = await batchOf('tab.packaging_specimen', params.specimenId);
      await write({ actor, idempotencyKey, requestHash }, 'select tab.void_packaging_specimen($1, $2) as r', [params.specimenId, body.reason]);
      return packaging(pool, batch);
    },
    recordPostUseInspection: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await write({ actor, idempotencyKey, requestHash }, 'select tab.record_post_use_inspection($1, $2::jsonb, $3) as r', [params.batchId, JSON.stringify(body.checks), body.note ?? null]);
      return packaging(pool, params.batchId);
    },
    verifyPostUseInspection: async ({ params, actor, idempotencyKey, requestHash }) => {
      const batch = await batchOf('tab.post_use_inspection', params.inspectionId);
      await write({ actor, idempotencyKey, requestHash }, 'select tab.verify_post_use_inspection($1) as r', [params.inspectionId]);
      return packaging(pool, batch);
    },
    resolveLineStop: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const batch = await batchOf('tab.line_stop', params.stopId);
      await write({ actor, idempotencyKey, requestHash }, 'select tab.resolve_line_stop($1, $2) as r', [params.stopId, body.reason]);
      return packaging(pool, batch);
    },
    enableWaiver: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await write({ actor, idempotencyKey, requestHash }, 'select tab.enable_reconciliation_waiver($1, $2, $3, $4) as r', [params.batchId, params.stepKey, body.item, body.device]);
      return packaging(pool, params.batchId);
    },
  });
  return Promise.resolve();
}
