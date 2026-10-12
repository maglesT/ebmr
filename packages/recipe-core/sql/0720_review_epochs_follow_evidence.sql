-- Recipe core: the batch evidence epoch follows the lots and containers a batch relied on, and the audit-event bump uses
-- the review's own scope and window (Phase 4 slice 1 quick review, findings 2 and 3; INV-30, INV-48, DI-25).
--
--   * recipe.bump_lot_batches(lot): the LOT epoch and the BATCH epoch of every batch that consumed the lot
--     (site.lot_consumption). recipe.epoch_on_lot (CREATE OR REPLACE from 0714) calls it on a lot state change, a LIMS
--     result and its approval: a new OOS result on a consumed lot refuses a QA review evaluated before it.
--   * recipe.bump_container_batches(container): the CONTAINER epoch and the BATCH epoch of the container's batch, of the
--     batches it was charged into and of the packaging orders it was issued to. Trigger zzze_epoch_container_state on
--     platform.aggregate_state (an output container's state row written: close, hold, release, rejection, reservation).
--   * recipe.epoch_on_audit_event (CREATE OR REPLACE from 0714): a covered chain's event bumps the batch only when it falls
--     in the scope and window of that batch's audit-trail review (recipe.audit_review_scope_chains, as
--     recipe.audit_review_events and recipe.audit_review_covered read it), so an event a delta review cannot cover (a
--     shared object's change after the record was completed) no longer blocks the QA review.

set local role ebmr_owner;

create function recipe.bump_lot_batches(p_lot uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b uuid;
begin
  if p_lot is null then
    return;
  end if;
  perform recipe.bump_epoch('LOT', p_lot);
  for b in select distinct lc.batch_id from site.lot_consumption lc where lc.lot_id = p_lot order by 1 loop
    perform recipe.bump_epoch('BATCH', b);
  end loop;
end
$$;

create function recipe.bump_container_batches(p_container uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  b uuid;
begin
  if p_container is null then
    return;
  end if;
  perform recipe.bump_epoch('CONTAINER', p_container);
  for b in select x from (
             select c.batch_id as x from plant.output_container c where c.id = p_container
             union select ch.batch_id from plant.container_charge ch where ch.container_id = p_container
             union select i.order_batch_id from recipe.packaging_bulk_issue i where i.container_id = p_container) y
           where x is not null order by 1 loop
    perform recipe.bump_epoch('BATCH', b);
  end loop;
end
$$;

create or replace function recipe.epoch_on_lot() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
begin
  if tg_table_name = 'lot_test_approval' then
    perform recipe.bump_lot_batches((select r.lot_id from site.lot_test_result r where r.id = (to_jsonb(new) ->> 'result_id')::uuid));
  else
    perform recipe.bump_lot_batches((to_jsonb(new) ->> 'lot_id')::uuid);
  end if;
  return null;
end
$$;

create function recipe.epoch_on_container_state() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  perform recipe.bump_container_batches(new.aggregate_id);
  return null;
end
$$;

create trigger zzze_epoch_container_state after insert or update on platform.aggregate_state
  for each row when (new.aggregate_type = 'output_container') execute function recipe.epoch_on_container_state();

create or replace function recipe.epoch_on_audit_event() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b uuid;
begin
  if new.table_name = 'recipe.exception_register_act'
     and exists (select 1 from recipe.exception_register_act a where a.id::text = new.record_id and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED')) then
    return null;
  end if;
  for b in select s.batch_id from recipe.audit_review_scope s where s.chain_key = new.chain_key order by 1 loop
    if exists (select 1 from recipe.audit_review_scope_chains(b) x
                where x.chain_key = new.chain_key
                  and (x.window_from is null or (new.recorded_at >= x.window_from and new.recorded_at <= x.window_to))) then
      perform recipe.bump_epoch('BATCH', b);
    end if;
  end loop;
  return null;
end
$$;

revoke all on function recipe.bump_lot_batches(uuid), recipe.bump_container_batches(uuid), recipe.epoch_on_container_state() from public;

reset role;
