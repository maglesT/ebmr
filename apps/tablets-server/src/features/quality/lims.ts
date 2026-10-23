/**
 * Feature `lims` (Phase 4 slice 2b, GMP): specifications with the pharmacopoeia and edition of every limit, editions and
 * their review list, the QA proposal of a lot status decision, the finished lot of a packaging order, reserve and
 * retention samples and returned goods (contract ns/specifications.ts and ns/samples.ts). Each route runs the person's
 * own command through the site-services and tablets definers (site services 0840 to 0843, tablets 1150); every rule is the
 * database's. The signed acts are LIMS_ACT (here) and LOT_DECISION (signables.ts).
 */
import {
  routes,
  type FinishedLotView,
  type MbrEditionReviewItem,
  type LotDecisionProposalView,
  type ReturnView,
  type SampleView,
  type SignableAction,
  type SpecificationView,
} from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { compact, peopleOf, personRef, usOf } from '../common/people.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type Db = Pick<pg.Pool, 'query'>;
type LimsAct = Extract<SignableAction, { kind: 'LIMS_ACT' }>;

const notFound = (what: string) =>
  refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `The ${what} was not found.`, why: `No such ${what}.`, whatYouCanDo: ['Reload the list.'] });

// ---------------------------------------------------------------------------------------------
// Reads

interface SpecRow {
  id: string;
  site_code: string;
  material_code: string;
  version: number;
  title: string;
  monograph_reference: string;
  state: SpecificationView['state'];
  tests: SpecificationView['tests'];
  drafted_by: string;
  drafted_us: string;
  approved_by: string | null;
  approved_us: string | null;
}

async function specifications(app: AppContext, db: Db, filter: { id?: string; materialCode?: string | undefined }): Promise<SpecificationView[]> {
  const { rows } = await db.query<SpecRow>(
    `select s.id, s.site_code, s.material_code, s.version, s.title, s.monograph_reference, site.specification_state(s.id) as state,
            (select coalesce(jsonb_agg(jsonb_build_object('testCode', t.test_code, 'methodReference', t.method_reference, 'unit', t.unit,
                                                          'lowerLimit', t.lower_limit::text, 'upperLimit', t.upper_limit::text, 'required', t.required,
                                                          'pharmacopoeia', t.pharmacopoeia, 'edition', t.edition, 'sampleQuantity', t.sample_quantity::text,
                                                          'sampleUnit', t.sample_unit)
                                       -- Slice 7p (site services 1720): a profile test with its time points.
                                       || case when t.profile then jsonb_build_object('points', site.profile_points_json(t.id)) else '{}'::jsonb end
                                       order by t.test_code collate "C"), '[]'::jsonb)
               from site.specification_test t where t.specification_id = s.id) as tests,
            s.drafted_by_person as drafted_by, ${usOf('s.drafted_at')} as drafted_us,
            a.approved_by_person as approved_by, case when a.approved_at is null then null else ${usOf('a.approved_at')} end as approved_us
       from site.specification s left join site.specification_approval a on a.specification_id = s.id
      where ($1::uuid is null or s.id = $1) and ($2::text is null or s.material_code = $2)
      order by s.material_code, s.version desc limit 500`,
    [filter.id ?? null, filter.materialCode ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.drafted_by, r.approved_by]));
  return rows.map((r) => ({
    specificationId: r.id,
    siteCode: r.site_code,
    materialCode: r.material_code,
    version: r.version,
    title: r.title,
    monographReference: r.monograph_reference,
    state: r.state,
    tests: r.tests,
    draftedBy: personRef(people, r.drafted_by, 'DRAFTER'),
    draftedAt: app.formatInstant(r.drafted_us),
    approvedBy: r.approved_by ? personRef(people, r.approved_by, 'APPROVER') : null,
    approvedAt: r.approved_us ? app.formatInstant(r.approved_us) : null,
  }));
}

async function samplesOf(app: AppContext, db: Db, filter: { lotId?: string; id?: string }): Promise<SampleView[]> {
  const { rows } = await db.query<{
    id: string; lot_id: string; kind: SampleView['kind']; quantity: string; unit: string; required: string; container: string; storage_location: string;
    retain_us: string; pulled_by: string; pulled_us: string; disposed_by: string | null; disposed_us: string | null; reason: string | null;
  }>(
    `select s.id, s.lot_id, s.kind, s.quantity::text as quantity, s.unit, s.required_quantity::text as required, s.container, s.storage_location,
            ${usOf('s.retain_until')} as retain_us, s.pulled_by_person as pulled_by, ${usOf('s.pulled_at')} as pulled_us,
            d.disposed_by_person as disposed_by, case when d.disposed_at is null then null else ${usOf('d.disposed_at')} end as disposed_us, d.reason
       from site.lot_sample s left join site.lot_sample_disposal d on d.sample_id = s.id
      where ($1::uuid is null or s.lot_id = $1) and ($2::uuid is null or s.id = $2)
      order by s.pulled_at, s.id`,
    [filter.lotId ?? null, filter.id ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.pulled_by, r.disposed_by]));
  return rows.map((r) => ({
    sampleId: r.id,
    lotId: r.lot_id,
    kind: r.kind,
    quantity: r.quantity,
    unit: r.unit,
    requiredQuantity: r.required,
    container: r.container,
    storageLocation: r.storage_location,
    retainUntil: app.formatInstant(r.retain_us),
    pulledBy: personRef(people, r.pulled_by, 'SAMPLER'),
    pulledAt: app.formatInstant(r.pulled_us),
    disposedBy: r.disposed_by ? personRef(people, r.disposed_by, 'DISPOSER') : null,
    disposedAt: r.disposed_us ? app.formatInstant(r.disposed_us) : null,
    disposalReason: r.reason,
  }));
}

interface ReturnRow {
  lot_id: string; lot_code: string; status: string; original_lot_id: string; original_lot_code: string; product_code: string; quantity: string; unit: string;
  reason: string; returned_from: string; received_by: string; received_us: string;
  a: { id: string; nature: string; storage: string; conditionHistory: string; timeSinceIssue: string; doubt: boolean; implicatesOtherBatches: boolean;
       investigationId: string | null; disposition: 'DESTROY' | 'CHEMICAL_RECOVERY' | 'RETURN_TO_STOCK'; by: string; us: string; signed: boolean } | null;
}

async function returnsOf(app: AppContext, db: Db, lotId?: string): Promise<ReturnView[]> {
  const { rows } = await db.query<ReturnRow>(
    `select g.lot_id, l.lot_code, (select s.state from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = l.id) as status, g.original_lot_id, o.lot_code as original_lot_code, o.material_code as product_code,
            g.quantity::text as quantity, g.unit, g.reason, g.returned_from, g.received_by_person as received_by, ${usOf('g.received_at')} as received_us,
            (select jsonb_build_object('id', a.id, 'nature', a.nature, 'storage', a.storage, 'conditionHistory', a.condition_history,
                                       'timeSinceIssue', a.time_since_issue, 'doubt', a.doubt, 'implicatesOtherBatches', a.implicates_other_batches,
                                       'investigationId', a.investigation_id, 'disposition', a.disposition, 'by', a.recorded_by_person,
                                       'us', ${usOf('a.recorded_at')},
                                       'signed', exists (select 1 from site.returned_goods_assessment_signature x where x.assessment_id = a.id))
               from site.returned_goods_assessment a where a.lot_id = g.lot_id order by a.recorded_at desc, a.id desc limit 1) as a
       from site.returned_goods g join site.material_lot l on l.id = g.lot_id join site.material_lot o on o.id = g.original_lot_id
      where ($1::uuid is null or g.lot_id = $1)
      order by g.received_at desc, g.lot_id limit 500`,
    [lotId ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.received_by, r.a?.by]));
  return rows.map((r) => ({
    lotId: r.lot_id,
    lotCode: r.lot_code,
    status: r.status,
    originalLotId: r.original_lot_id,
    originalLotCode: r.original_lot_code,
    productCode: r.product_code,
    quantity: r.quantity,
    unit: r.unit,
    reason: r.reason,
    returnedFrom: r.returned_from,
    receivedBy: personRef(people, r.received_by, 'RECEIVER'),
    receivedAt: app.formatInstant(r.received_us),
    assessment: r.a
      ? {
          assessmentId: r.a.id,
          nature: r.a.nature,
          storage: r.a.storage,
          conditionHistory: r.a.conditionHistory,
          timeSinceIssue: r.a.timeSinceIssue,
          doubt: r.a.doubt,
          implicatesOtherBatches: r.a.implicatesOtherBatches,
          investigationId: r.a.investigationId,
          disposition: r.a.disposition,
          recordedBy: personRef(people, r.a.by, 'QC_ASSESSOR'),
          recordedAt: app.formatInstant(r.a.us),
          signed: r.a.signed,
        }
      : null,
  }));
}

async function finishedLot(app: AppContext, db: Db, lotId: string): Promise<FinishedLotView> {
  const { rows } = await db.query<{ lot_code: string; batch_id: string; product_code: string; status: string; quantity: string; unit: string; markets: string[]; exp_us: string }>(
    `select l.lot_code, f.batch_id, f.product_code, (select s.state from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = l.id) as status, l.received_quantity::text as quantity, l.unit, f.markets,
            ${usOf('l.expires_at')} as exp_us
       from site.finished_lot f join site.material_lot l on l.id = f.lot_id where f.lot_id = $1`,
    [lotId],
  );
  const r = rows[0];
  if (!r) throw notFound('finished lot');
  return { lotId, lotCode: r.lot_code, batchId: r.batch_id, productCode: r.product_code, status: r.status, quantity: r.quantity, unit: r.unit, markets: r.markets, expiry: app.formatInstant(r.exp_us) };
}

// ---------------------------------------------------------------------------------------------
// LIMS_ACT

const LIMS: Readonly<Record<LimsAct['act'], { aggregateType: string; meaning: string; sql: string }>> = {
  SPECIFICATION_APPROVE: { aggregateType: 'specification', meaning: 'SPECIFICATION_APPROVED', sql: 'select site.approve_specification($1, $2)' },
  RETURN_ASSESSMENT_SIGN: { aggregateType: 'returned_goods', meaning: 'RETURNED_GOODS_ASSESSED', sql: 'select site.sign_returned_goods_assessment($1, $2)' },
};

export function limsActHandler(app: AppContext): SignableActionHandler<LimsAct> {
  return dbActHandler<LimsAct>(app, {
    kind: 'LIMS_ACT',
    aggregateTypes: ['specification', 'returned_goods'],
    target: (a) => ({ aggregateType: LIMS[a.act].aggregateType, aggregateId: a.subjectId, meaning: LIMS[a.act].meaning }),
    async apply(client, _ctx, a, signatureId) {
      await client.query(LIMS[a.act].sql, [a.subjectId, signatureId]);
      return { act: a.act, subjectId: a.subjectId };
    },
  });
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(limsActHandler(app));
}

// ---------------------------------------------------------------------------------------------
// Routes

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.specifications, {
    list: async ({ query, requireSession }) => {
      requireSession();
      return { specifications: await specifications(app, pool, { materialCode: query.materialCode }) };
    },
    draft: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ r: { specificationId: string } }>('select site.draft_specification($1::jsonb) as r', [
          JSON.stringify({ materialCode: body.materialCode, title: body.title, monographReference: body.monographReference, tests: body.tests.map((t) => compact(t)) }),
        ]);
        return rows[0]?.r.specificationId ?? '';
      });
      const [view] = await specifications(app, pool, { id: out.result });
      if (!view) throw notFound('specification');
      return view;
    },
    markEdition: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select site.mark_edition_effective($1, $2, $3::timestamptz) as id', [body.pharmacopoeia, body.edition, body.effectiveFrom]);
        return rows[0]?.id ?? '';
      });
      return { editionId: out.result };
    },
    editionReview: async ({ requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ r: { specificationId: string; siteCode: string; materialCode: string; version: number; testCode: string; pharmacopoeia: 'IP'; cited: string; effective: string }[] }>(
        'select site.specification_edition_review() as r',
      );
      // IN-33 (recipe-core 1061): the master records citing an older edition are on the same list.
      const mbrs = await pool.query<{ r: MbrEditionReviewItem[] }>('select recipe.mbr_edition_review() as r');
      return { items: rows[0]?.r ?? [], mbrs: mbrs.rows[0]?.r ?? [] };
    },
    lotReleaseCheck: async ({ params, requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ spec: string | null; lims: string | null; sample: string | null }>(
        `select site.specification_in_effect(l.site_code, l.material_code) as spec, site.lot_lims_release_problem(l.id) as lims, site.lot_sample_problem(l.id) as sample
           from site.material_lot l where l.id = $1`,
        [params.lotId],
      );
      const r = rows[0];
      if (!r) throw notFound('lot');
      return { lotId: params.lotId, specificationId: r.spec, limsProblem: r.lims, sampleProblem: r.sample };
    },
    proposeLotDecision: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select site.propose_lot_decision($1, $2) as id', [params.lotId, body.event]);
        return rows[0]?.id ?? '';
      });
      const { rows } = await pool.query<{ event: LotDecisionProposalView['event']; from_state: string; v: string }>(
        'select i.event, i.from_state, i.state_version::text as v from site.lot_decision_intent i where i.id = $1',
        [out.result],
      );
      const r = rows[0];
      if (!r) throw notFound('proposal');
      return { proposalId: out.result, lotId: params.lotId, event: r.event, fromState: r.from_state, version: r.v };
    },
    postFinishedLot: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select tab.post_finished_lot($1, $2, $3) as id', [body.batchId, body.quantity, body.unit]);
        return rows[0]?.id ?? '';
      });
      return finishedLot(app, pool, out.result);
    },
  });
  bindRoutes(scope, app, routes.samples, {
    list: async ({ params, requireSession }) => {
      requireSession();
      return { samples: await samplesOf(app, pool, { lotId: params.lotId }) };
    },
    pull: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select site.pull_lot_sample($1, $2::jsonb) as id', [
          params.lotId,
          JSON.stringify({ kind: body.kind, quantity: body.quantity, container: body.container, storageLocation: body.storageLocation }),
        ]);
        return rows[0]?.id ?? '';
      });
      const [view] = await samplesOf(app, pool, { id: out.result });
      if (!view) throw notFound('sample');
      return view;
    },
    dispose: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select site.dispose_lot_sample($1, $2)', [params.sampleId, body.reason]);
        return null;
      });
      const [view] = await samplesOf(app, pool, { id: params.sampleId });
      if (!view) throw notFound('sample');
      return view;
    },
    returns: async ({ requireSession }) => {
      requireSession();
      return { returns: await returnsOf(app, pool) };
    },
    receiveReturn: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ r: { lotId: string } }>('select site.receive_returned_goods($1::jsonb) as r', [
          JSON.stringify({ originalLotId: body.originalLotId, quantity: body.quantity, reason: body.reason, returnedFrom: body.returnedFrom }),
        ]);
        return rows[0]?.r.lotId ?? '';
      });
      const [view] = await returnsOf(app, pool, out.result);
      if (!view) throw notFound('return');
      return view;
    },
    assessReturn: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const assessment = compact({
        nature: body.nature, storage: body.storage, conditionHistory: body.conditionHistory, timeSinceIssue: body.timeSinceIssue, doubt: body.doubt,
        implicatesOtherBatches: body.implicatesOtherBatches, investigationId: body.investigationId, disposition: body.disposition,
      });
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select site.record_returned_goods_assessment($1, $2::jsonb)', [params.lotId, JSON.stringify(assessment)]);
        return null;
      });
      const [view] = await returnsOf(app, pool, params.lotId);
      if (!view) throw notFound('return');
      return view;
    },
    // Phase 6 slice 6d (site services 0960; IN-29, PR-48): the database checks QC's signed CHEMICAL_RECOVERY assessment,
    // MATERIAL.HANDLE, once per returned lot, and writes the recovered lot and its genealogy link in this transaction.
    recoverReturn: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const recovery = compact({
        materialCode: body.materialCode, materialName: body.materialName, quantity: body.quantity, unit: body.unit, processReference: body.processReference,
        expiresAt: body.expiresAt, retestAt: body.retestAt, returnedQuantity: body.returnedQuantity,
      });
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ r: { lotId: string; lotCode: string } }>('select site.record_chemical_recovery($1, $2::jsonb) as r', [params.lotId, JSON.stringify(recovery)]);
        return rows[0]?.r ?? null;
      });
      if (!out.result) throw notFound('return');
      return { returnedLotId: params.lotId, recoveredLotId: out.result.lotId, recoveredLotCode: out.result.lotCode };
    },
  });
  return Promise.resolve();
}
