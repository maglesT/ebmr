/**
 * The after-release reads (Phase 4 slice 5a; contract ns/release.ts `suspended`, `afterRelease`): the market states of a
 * released lot, the causes that suspended it, the AP's decisions, the recall-assessment and serial-decommissioning tasks,
 * the ERP stock-block messages, the forward trace and the disposal. Every value and every gate is the database's
 * (recipe-core 0840, site services 0880); the acts are RELEASE_ACT RECONFIRM, RECALL, REJECT_AFTER_RELEASE and DISPOSAL.
 */
import type pg from 'pg';
import type { LotAfterReleaseView, ManufacturerReleaseState, ReleaseMarket, SuspendedLotSummaryView, SuspensionCauseKind } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;
const MARKETS: readonly ReleaseMarket[] = ['IN', 'US', 'EU'];

/** Lots with a market RELEASE_SUSPENDED or an open recall-assessment task, oldest open cause first. */
export async function suspendedLots(app: AppContext, db: Db): Promise<SuspendedLotSummaryView[]> {
  const { rows } = await db.query<{
    lot_id: string; lot_code: string; product_code: string; batch_number: string; state: ManufacturerReleaseState; suspended: ReleaseMarket[]; open_task: boolean; us: string;
  }>(
    `with lots as (
       select s.lot_id, min(s.recorded_at) as since from recipe.release_suspension s where s.id = any (recipe.open_suspensions(s.lot_id, s.market)) group by s.lot_id
       union
       select t.lot_id, t.opened_at from recipe.release_task t
        where t.kind = 'RECALL_ASSESSMENT' and not exists (select 1 from recipe.release_task_closure c where c.task_id = t.id))
     select x.lot_id, l.lot_code, f.product_code, f.batch_number, recipe.manufacturer_release_state(x.lot_id) as state,
            array(select m from unnest(array['IN', 'US', 'EU']) m
                   where (m = 'IN' and recipe.manufacturer_release_state(x.lot_id) = 'RELEASE_SUSPENDED')
                      or (m <> 'IN' and recipe.disposition_state(x.lot_id, m) = 'RELEASE_SUSPENDED')) as suspended,
            exists (select 1 from recipe.release_task t where t.lot_id = x.lot_id and t.kind = 'RECALL_ASSESSMENT'
                     and not exists (select 1 from recipe.release_task_closure c where c.task_id = t.id)) as open_task,
            ${usOf('x.since')} as us
       from (select lot_id, min(since) as since from lots group by lot_id) x
       join site.material_lot l on l.id = x.lot_id join site.finished_lot f on f.lot_id = x.lot_id
      order by x.since, x.lot_id`,
  );
  return rows.map((r) => ({
    lotId: r.lot_id, lotCode: r.lot_code, productCode: r.product_code, batchNumber: r.batch_number, manufacturerState: r.state,
    suspendedMarkets: r.suspended, openTask: r.open_task, since: app.formatInstant(r.us),
  }));
}

interface Facts {
  lot_code: string;
  product_code: string;
  batch_number: string;
  state: ManufacturerReleaseState;
  markets: { market: ReleaseMarket; state: string; prior: string | null; reconfirm: string; recall: string; reject: string; p_reconfirm: string[]; p_recall: string[]; p_reject: string[] }[];
  causes: { id: string; market: ReleaseMarket; kind: SuspensionCauseKind; ref: string; label: string; via_kind: 'LOT' | 'BATCH' | 'EQUIPMENT'; via_id: string; prior: string; us: string; covered: boolean; problem: string | null }[];
  decisions: { id: string; market: ReleaseMarket; act: 'RECONFIRM' | 'RECALL' | 'REJECT_AFTER_RELEASE'; to_state: string; person_id: string; role_code: string; us: string; signature_id: string; text: string; epoch: string | null; ids: string[] }[];
  tasks: { id: string; kind: 'RECALL_ASSESSMENT' | 'SERIAL_DECOMMISSIONING'; owner_role: string; us: string; closed_us: string | null }[];
  blocks: { id: string; kind: 'BLOCK' | 'UNBLOCK'; cause_key: string; us: string; delivered_us: string | null }[];
  downstream: { lot_id: string; lot_code: string; state: string }[];
  disposal: {
    id: string; route: 'WITNESSED_DESTRUCTION' | 'REPROCESSING' | 'RETURN'; quantity: string; unit: string; return_to: 'SUPPLIER' | 'CUSTOMER' | null; reference: string | null;
    reprocessing_ref: string | null; text: string | null; aggregate_id: string; person_id: string; role_code: string; us: string; signature_id: string;
    witness_person: string | null; witness_us: string | null; witness_signature: string | null;
  } | null;
  disposal_problem: string | null;
}

export async function lotAfterRelease(app: AppContext, db: Db, lotId: string): Promise<LotAfterReleaseView> {
  const { rows } = await db.query<{ f: Facts | null }>(
    `select case when f.lot_id is null then null else jsonb_build_object(
       'lot_code', l.lot_code, 'product_code', f.product_code, 'batch_number', f.batch_number, 'state', recipe.manufacturer_release_state(f.lot_id),
       'markets', (select coalesce(jsonb_agg(jsonb_build_object(
           'market', m, 'state', case m when 'IN' then recipe.manufacturer_release_state(f.lot_id) else recipe.disposition_state(f.lot_id, m) end,
           'prior', (select s.prior_state from recipe.release_suspension s where s.id = any (recipe.open_suspensions(f.lot_id, m)) limit 1),
           'reconfirm', recipe.release_suspension_next_id(f.lot_id, m, 'RECONFIRM'), 'recall', recipe.release_suspension_next_id(f.lot_id, m, 'RECALL'),
           'reject', recipe.release_suspension_next_id(f.lot_id, m, 'REJECT_AFTER_RELEASE'),
           'p_reconfirm', to_jsonb(recipe.after_release_problems(f.lot_id, m, 'RECONFIRM')), 'p_recall', to_jsonb(recipe.after_release_problems(f.lot_id, m, 'RECALL')),
           'p_reject', to_jsonb(recipe.after_release_problems(f.lot_id, m, 'REJECT_AFTER_RELEASE'))) order by o), '[]'::jsonb)
         from unnest(array['IN', 'US', 'EU']) with ordinality u(m, o) where m = 'IN' or m = any (coalesce(recipe.market_set('LOT', f.lot_id), '{}'))),
       'causes', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'market', s.market, 'kind', s.cause_kind, 'ref', s.cause_ref, 'label', s.label,
           'via_kind', s.via_kind, 'via_id', s.via_id, 'prior', s.prior_state, 'us', ${usOf('s.recorded_at')},
           'covered', not (s.id = any (recipe.open_suspensions(s.lot_id, s.market))),
           'problem', case when s.id = any (recipe.open_suspensions(s.lot_id, s.market)) then recipe.suspension_cause_problem(s.id) end) order by s.recorded_at, s.market), '[]'::jsonb)
         from recipe.release_suspension s where s.lot_id = f.lot_id),
       'decisions', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'market', d.market, 'act', d.act, 'to_state', d.to_state, 'person_id', d.person_id,
           'role_code', d.role_code, 'us', ${usOf('d.recorded_at')}, 'signature_id', d.signature_id, 'text', d.text, 'epoch', d.epoch, 'ids', to_jsonb(d.suspension_ids))
           order by d.recorded_at), '[]'::jsonb) from recipe.after_release_decision d where d.lot_id = f.lot_id),
       'tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'owner_role', t.owner_role, 'us', ${usOf('t.opened_at')},
           'closed_us', (select ${usOf('c.closed_at')} from recipe.release_task_closure c where c.task_id = t.id)) order by t.opened_at), '[]'::jsonb)
         from recipe.release_task t where t.lot_id = f.lot_id),
       'blocks', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'cause_key', r.cause_key, 'us', ${usOf('r.requested_at')},
           'delivered_us', (select ${usOf('x.delivered_at')} from site.erp_stock_block_delivery x where x.request_id = r.id)) order by r.requested_at), '[]'::jsonb)
         from site.erp_stock_block_request r where r.lot_id = f.lot_id),
       'downstream', (select coalesce(jsonb_agg(jsonb_build_object('lot_id', d.id, 'lot_code', dl.lot_code, 'state', recipe.manufacturer_release_state(d.id)) order by dl.lot_code), '[]'::jsonb)
         from unnest(recipe.genealogy_downstream_lots('LOT', f.lot_id)) d(id) join site.material_lot dl on dl.id = d.id),
       'disposal', (select jsonb_build_object('id', x.id, 'route', x.route, 'quantity', x.quantity::text, 'unit', x.unit, 'return_to', x.return_to, 'reference', x.reference,
           'reprocessing_ref', x.reprocessing_ref, 'text', x.text, 'aggregate_id', x.aggregate_id, 'person_id', x.person_id, 'role_code', x.role_code,
           'us', ${usOf('x.recorded_at')}, 'signature_id', x.signature_id, 'witness_person', w.person_id, 'witness_us', case when w.disposal_id is not null then ${usOf('w.recorded_at')} end,
           'witness_signature', w.signature_id)
         from recipe.lot_disposal x left join recipe.lot_disposal_witness w on w.disposal_id = x.id where x.lot_id = f.lot_id),
       'disposal_problem', recipe.disposal_problem(f.lot_id)) end as f
       from (select 1) one left join site.finished_lot f on f.lot_id = $1 left join site.material_lot l on l.id = f.lot_id`,
    [lotId],
  );
  const f = rows[0]?.f;
  if (!f) {
    throw refusal(404, { code: 'EBMR-REL-010', kind: 'INVALID_INPUT', whatHappened: 'There is no finished lot with this id.', why: `Lot ${lotId} is no finished lot of a packaging batch.`, whatYouCanDo: ['Open the release queue.'] });
  }
  const people = await peopleOf(db, [...f.decisions.map((d) => d.person_id), f.disposal?.person_id, f.disposal?.witness_person]);
  const gate = (p: string[]) => ({ ready: p.length === 0, problems: p });
  const at = (us: string) => app.formatInstant(us);
  const d = f.disposal;
  return {
    lotId,
    lotCode: f.lot_code,
    productCode: f.product_code,
    batchNumber: f.batch_number,
    manufacturerState: f.state,
    markets: f.markets.filter((m) => MARKETS.includes(m.market)).map((m) => ({
      market: m.market,
      state: m.state,
      priorState: m.state === 'RELEASE_SUSPENDED' ? m.prior : null,
      signable: { reconfirm: m.reconfirm, recall: m.recall, rejectAfterRelease: m.reject },
      gates: { reconfirm: gate(m.p_reconfirm), recall: gate(m.p_recall), rejectAfterRelease: gate(m.p_reject) },
    })),
    causes: f.causes.map((c) => ({
      suspensionId: c.id, market: c.market, causeKind: c.kind, causeRef: c.ref, label: c.label, via: { kind: c.via_kind, id: c.via_id }, priorState: c.prior,
      suspendedAt: at(c.us), covered: c.covered, problem: c.problem,
    })),
    decisions: f.decisions.map((x) => ({
      decisionId: x.id, market: x.market, act: x.act, toState: x.to_state, by: personRef(people, x.person_id, x.role_code), at: at(x.us), signatureId: x.signature_id,
      text: x.text, epoch: x.epoch, suspensionIds: x.ids,
    })),
    tasks: f.tasks.map((t) => ({ taskId: t.id, kind: t.kind, ownerRole: t.owner_role, status: t.closed_us ? 'CLOSED' : 'OPEN', openedAt: at(t.us), closedAt: t.closed_us ? at(t.closed_us) : null })),
    stockBlocks: f.blocks.map((b) => ({ requestId: b.id, kind: b.kind, causeKey: b.cause_key, requestedAt: at(b.us), deliveredAt: b.delivered_us ? at(b.delivered_us) : null })),
    downstream: f.downstream.map((x) => ({ lotId: x.lot_id, lotCode: x.lot_code, state: x.state })),
    disposal: d
      ? {
          disposalId: d.id, route: d.route, state: d.route === 'WITNESSED_DESTRUCTION' && !d.witness_signature ? 'AWAITING_WITNESS' : 'RECORDED', quantity: d.quantity, unit: d.unit,
          returnTo: d.return_to, reference: d.reference, reprocessingRef: d.reprocessing_ref, text: d.text, aggregateId: d.aggregate_id,
          performedBy: personRef(people, d.person_id, d.role_code), performedAt: at(d.us), signatureId: d.signature_id,
          witnessedBy: d.witness_person ? personRef(people, d.witness_person, 'WITNESS') : null, witnessedAt: d.witness_us ? at(d.witness_us) : null,
          witnessSignatureId: d.witness_signature,
        }
      : null,
    disposalGate: gate(f.disposal_problem ? [f.disposal_problem] : []),
  };
}
