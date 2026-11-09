/**
 * The full deviation stand-in over HTTP (Phase 4 slice 2a; contract ns/deviation.ts; site services 0820 to 0823): the
 * detail of a record, QA's reclassification, the impact per linked subject and market, the closure basis and the release
 * checklist of a subject. Each write runs the person's own command through the site-services definer; every rule is the
 * database's. The signed acts (impact sign-off, conclusion, closure) are QUALITY_ACT (signables.ts).
 */
import type { DeviationDetailView, DeviationReleaseItem, LinkedDeviation, routes } from '@ebmr/api-contract';
import type { ActorContext } from '@ebmr/kernel';
import type pg from 'pg';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { Handlers } from '../../platform/http/bind.ts';
import { isResolved, type Deviations } from '../../platform/deviations.ts';
import { refusal } from '../../platform/http/refusal.ts';

type Db = Pick<pg.Pool, 'query'>;

interface DetailRow {
  d: {
    id: string;
    ref: string;
    kind: DeviationDetailView['kind'];
    title: string;
    state: DeviationDetailView['state'];
    classification: DeviationDetailView['raisedClassification'];
    raised_by: string;
    impact_current: boolean;
    cancel_reason: string | null;
  };
  k: { classification: DeviationDetailView['raisedClassification']; risk_rationale: string; owner_person: string; due_date: string; risk_document_id: string | null; classified_by_person: string } | null;
  f: { assignable_cause: boolean; cause: string; root_cause_category: string; recorded_by_person: string } | null;
  b: {
    root_cause_method: string | null;
    system_factors: { process: string; procedure: string; system: string } | null;
    capa_refs: string[];
    no_capa_reason: string | null;
    notification_required: boolean;
    notification_rationale: string;
    authority_reference: string | null;
    other_batches: { subjectKind: 'BATCH' | 'PRODUCT' | 'LOT'; ref: string; included: boolean; reason: string }[];
    recorded_by_person: string;
  } | null;
}

export async function deviationDetail(db: Db, deviationId: string): Promise<DeviationDetailView> {
  const { rows } = await db.query<DetailRow>(
    `select jsonb_build_object('id', d.id, 'ref', d.ref, 'kind', d.kind, 'title', d.title, 'state', site.deviation_state(d.id),
                               'classification', d.classification, 'raised_by', d.raised_by_person, 'impact_current', site.deviation_impact_current(d.id),
                               'cancel_reason', (select e.reason from site.deviation_event e where e.deviation_id = d.id and e.event = 'CANCELLED')) as d,
            (select to_jsonb(k) - 'seq' from site.deviation_classification k where k.deviation_id = d.id order by k.seq desc limit 1) as k,
            (select to_jsonb(f) from site.deviation_finding f where f.deviation_id = d.id order by f.recorded_at desc, f.id desc limit 1) as f,
            (select to_jsonb(b) from site.deviation_closure_basis b where b.deviation_id = d.id order by b.seq desc limit 1) as b
       from site.deviation d where d.id = $1`,
    [deviationId],
  );
  const r = rows[0];
  if (!r) throw Object.assign(new Error('EBMR-SITE-302 unknown deviation record'), { statusCode: 404 });
  const links = await db.query<{ id: string; subject_kind: 'BATCH' | 'LOT' | 'CONTAINER'; subject_id: string; subject_ref: string; batch_number: string | null; impacts: { market: 'IN' | 'US' | 'EU'; impact: 'NONE' | 'POTENTIAL' | 'CONFIRMED'; rationale: string; signed: boolean }[] }>(
    `select l.id, l.subject_kind, l.subject_id, l.subject_ref, l.batch_number,
            coalesce((select jsonb_agg(jsonb_build_object('market', i.market, 'impact', i.impact, 'rationale', i.rationale,
                                                          'signed', i.seq <= coalesce((select s.covers_seq from site.deviation_impact_signoff s where s.deviation_id = l.deviation_id order by s.seq desc limit 1), -1))
                                       order by i.market)
                        from (select distinct on (x.market) x.* from site.deviation_impact x where x.link_id = l.id order by x.market, x.seq desc) i), '[]'::jsonb) as impacts
       from site.deviation_link l where l.deviation_id = $1 order by l.linked_at, l.id`,
    [deviationId],
  );
  const { d, k, f, b } = r;
  return {
    deviationId: d.id,
    ref: d.ref,
    kind: d.kind,
    title: d.title,
    state: d.state,
    raisedClassification: d.classification,
    raisedBy: d.raised_by,
    qaClassification: k
      ? { classification: k.classification, riskRationale: k.risk_rationale, ownerPersonId: k.owner_person, dueDate: k.due_date, riskDocumentId: k.risk_document_id, classifiedBy: k.classified_by_person }
      : null,
    links: links.rows.map((l) => ({ linkId: l.id, subjectKind: l.subject_kind, subjectId: l.subject_id, subjectRef: l.subject_ref, batchNumber: l.batch_number, impacts: l.impacts })),
    impactCurrent: d.impact_current,
    finding: f ? { assignableCause: f.assignable_cause, cause: f.cause, rootCauseCategory: f.root_cause_category, recordedBy: f.recorded_by_person } : null,
    closureBasis: b
      ? {
          ...(b.root_cause_method !== null ? { rootCauseMethod: b.root_cause_method } : {}),
          ...(b.system_factors !== null ? { systemFactors: b.system_factors } : {}),
          capaRefs: b.capa_refs,
          ...(b.no_capa_reason !== null ? { noCapaReason: b.no_capa_reason } : {}),
          notificationRequired: b.notification_required,
          notificationRationale: b.notification_rationale,
          ...(b.authority_reference !== null ? { authorityReference: b.authority_reference } : {}),
          otherBatches: b.other_batches,
          recordedBy: b.recorded_by_person,
        }
      : null,
    cancelReason: d.cancel_reason,
  };
}

type DeviationRoutes = Pick<
  typeof routes.quality,
  'deviationDetail' | 'reclassifyDeviation' | 'recordDeviationImpact' | 'recordDeviationClosureBasis' | 'deviationRelease' | 'deviationNumbers' | 'linkDeviationNumber'
>;

/**
 * MEDHANTA slice 2: the Deviations numbers linked to the batches `batches`, each with its status read now from the
 * Deviations product (report.deviation_v1). An unreadable view throws DEVIATIONS_OFF: nothing is shown as resolved.
 */
export async function linkedDeviations(pool: Pick<pg.Pool, 'query'>, link: Deviations, batches: readonly string[]): Promise<LinkedDeviation[]> {
  const { rows } = await pool.query<{ number: string; batch_id: string; batch_number: string; linked_at: Date }>(
    'select number, batch_id::text as batch_id, batch_number, linked_at from dv.batch_number_link where batch_id = any ($1::uuid[]) order by linked_at, id',
    [batches],
  );
  const out: LinkedDeviation[] = [];
  for (const r of rows) {
    const read = await link.read(r.number);
    out.push({
      number: r.number,
      batchId: r.batch_id,
      batchNumber: r.batch_number,
      status: read.status,
      classification: read.classification,
      blocking: !isResolved(read.status),
      linkedAt: r.linked_at.toISOString(),
      dataAsOf: read.dataAsOf,
    });
  }
  return out;
}

/** The reason release waits for the linked numbers, in the database's words (dv.release_problem); null when none does. */
export function linkedProblem(linked: readonly LinkedDeviation[]): string | null {
  const b = linked.find((l) => l.blocking);
  if (!b) return null;
  return b.status === null
    ? `deviation ${b.number} linked to batch ${b.batchNumber} is not in the Deviations product`
    : `deviation ${b.number} linked to batch ${b.batchNumber} is ${b.status} in the Deviations product; release waits until it is closed or rejected`;
}

function unknownNumber(number: string): Error {
  return refusal(422, {
    code: 'EBMR-DV-002',
    kind: 'INVALID_INPUT',
    whatHappened: 'There is no such deviation in the Deviations product. Nothing was linked.',
    why: `Deviation ${number} is not in the Deviations product's published records.`,
    whatYouCanDo: ['Check the number in the Deviations product, or raise the deviation there first.'],
  });
}

async function subjectBatches(pool: Pick<pg.Pool, 'query'>, kind: string, id: string): Promise<string[]> {
  const { rows } = await pool.query<{ b: string[] }>('select dv.subject_batches($1, $2)::text[] as b', [kind, id]);
  return rows[0]?.b ?? [];
}

/** The handlers of the slice 2a routes, spread into the quality namespace's binding (index.ts). */
export function deviationHandlers(pool: pg.Pool, link: Deviations | null = null): Handlers<DeviationRoutes> {
  const command = async (actor: ActorContext, key: string | null | undefined, hash: string, sql: string, params: unknown[]) =>
    withIdempotentActorCommand(pool, actor, key ?? '', hash, async (c) => {
      await c.query(sql, params);
      return null;
    });
  return {
    deviationDetail: async ({ params, requireSession }) => {
      requireSession();
      return deviationDetail(pool, params.deviationId);
    },
    reclassifyDeviation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.reclassify_deviation($1, $2::jsonb)', [params.deviationId, JSON.stringify(body)]);
      return deviationDetail(pool, params.deviationId);
    },
    recordDeviationImpact: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.record_deviation_impact($1, $2::jsonb)', [params.deviationId, JSON.stringify(body)]);
      return deviationDetail(pool, params.deviationId);
    },
    recordDeviationClosureBasis: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.record_deviation_closure_basis($1, $2::jsonb)', [params.deviationId, JSON.stringify(body)]);
      return deviationDetail(pool, params.deviationId);
    },
    deviationRelease: async ({ query, requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ items: DeviationReleaseItem[]; problem: string | null }>(
        'select site.deviation_release_items($1, $2, $3) as items, site.deviation_release_problem($1, $2, $3, null) as problem',
        [query.subjectKind, query.subjectId, query.market ?? null],
      );
      const items = rows[0]?.items ?? [];
      const problem = rows[0]?.problem ?? null;
      if (!link) return { items, problem };
      const linked = await linkedDeviations(pool, link, await subjectBatches(pool, query.subjectKind, query.subjectId));
      return { items, problem: problem ?? linkedProblem(linked), linked };
    },
    // Served only with a Deviations link (bind.ts answers 410 without one).
    deviationNumbers: async ({ params, requireSession }) => {
      requireSession();
      return { deviations: link ? await linkedDeviations(pool, link, [params.batchId]) : [] };
    },
    linkDeviationNumber: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      // The number must be one Deviations publishes; the read is the view's (an unreadable view: DEVIATIONS_OFF, nothing saved).
      if (link && (await link.read(body.number)).status === null) throw unknownNumber(body.number);
      await command(actor(), idempotencyKey, requestHash, 'select dv.link_number($1, $2)', [params.batchId, body.number]);
      return { deviations: link ? await linkedDeviations(pool, link, [params.batchId]) : [] };
    },
  };
}
