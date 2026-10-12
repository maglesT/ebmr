-- Recipe core: a cause linked again after a re-confirmation suspends the lot again (Phase 4 slice 5 quick review, MEDIUM;
-- L-19; recipe-core 0840).
--
-- 0840 kept one suspension row per lot, market, cause kind and ref (a unique key, ON CONFLICT DO NOTHING). Once the AP's
-- RECONFIRM covered that row, the same cause linked again (an incident linked to another batch upstream of the lot, a
-- deviation reopened and relinked, a new amendment of the record never shares its ref) found the old row and wrote
-- nothing: no suspension, no ERP block, no recall-assessment task; the lot stayed RELEASED.
--   * the unique key is dropped; recipe.suspend_lot (CREATE OR REPLACE from 0840) skips a market only while an UNCOVERED
--     row of the same cause exists (the lot is locked first, so concurrent links are serialised); a covered one does not
--     stop a new suspension.
--   * the ERP stock-block message's cause key names the first row inserted by the call
--     (<kind>/<ref>/<suspension id>), so the outbox stays idempotent per suspension episode and a new episode blocks again.
-- Nothing else changes.

set local role ebmr_owner;

do $$
declare
  v_name text;
begin
  select c.conname into v_name from pg_constraint c
   where c.conrelid = 'recipe.release_suspension'::regclass and c.contype = 'u'
     and (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey))
         = array['cause_kind', 'cause_ref', 'lot_id', 'market'];
  if v_name is null then
    raise exception 'the unique key of recipe.release_suspension (lot_id, market, cause_kind, cause_ref) was not found';
  end if;
  execute format('alter table recipe.release_suspension drop constraint %I', v_name);
end
$$;
create index release_suspension_cause on recipe.release_suspension (lot_id, market, cause_kind, cause_ref);

create or replace function recipe.suspend_lot(p_lot uuid, p_cause jsonb) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  m       text;
  v_n     integer := 0;
  v_one   integer;
  v_key   text;
  v_first uuid;
  v_id    uuid;
begin
  if not exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    return 0;
  end if;
  -- D-5-2: a lot never released only has the cause linked (its release gate blocks it already).
  if not recipe.market_decided_released(p_lot, 'IN') then
    return 0;
  end if;
  perform site.lock_lot(p_lot);
  foreach m in array array['IN', 'US', 'EU'] loop
    continue when m <> 'IN' and not (m = any (coalesce(recipe.market_set('LOT', p_lot), '{}')));
    continue when not recipe.market_decided_released(p_lot, m);
    continue when exists (select 1 from recipe.after_release_decision d where d.lot_id = p_lot and d.market = m and d.act <> 'RECONFIRM');
    -- L-19: idempotent while a row of the same cause is uncovered; once a re-confirmation covered it, the cause linked
    -- again (another genealogy path, a reopened record) suspends the market again (the lot is locked: serialised).
    continue when exists (select 1 from recipe.release_suspension s where s.lot_id = p_lot and s.market = m and s.cause_kind = p_cause ->> 'kind'
                             and s.cause_ref = p_cause ->> 'ref' and s.id = any (recipe.open_suspensions(p_lot, m)));
    insert into recipe.release_suspension (lot_id, market, cause_kind, cause_ref, via_kind, via_id, label, cause, prior_state)
    values (p_lot, m, p_cause ->> 'kind', p_cause ->> 'ref', p_cause ->> 'via_kind', (p_cause ->> 'via_id')::uuid, p_cause ->> 'label', p_cause,
            case m when 'EU' then 'CERTIFIED' else 'RELEASED' end)
    returning id into v_id;
    v_first := coalesce(v_first, v_id);
    v_one := 1;
    v_n := v_n + v_one;
  end loop;
  if v_n > 0 then
    -- In the same transaction (D-5-3): the export markets' states, the ERP stock block, the AP's recall-assessment task.
    perform recipe.cascade_market_dispositions(p_lot, jsonb_build_object('cause', 'RELEASE_SUSPENDED', 'suspension', p_cause));
    -- The outbox stays idempotent per suspension episode: the key names the first row this call inserted.
    v_key := (p_cause ->> 'kind') || '/' || (p_cause ->> 'ref') || '/' || v_first::text;
    perform site.request_erp_stock_block(p_lot, 'BLOCK', v_key, p_cause);
    if not exists (select 1 from recipe.release_task t where t.lot_id = p_lot and t.kind = 'RECALL_ASSESSMENT'
                    and not exists (select 1 from recipe.release_task_closure c where c.task_id = t.id)) then
      insert into recipe.release_task (lot_id, kind, owner_role, cause) values (p_lot, 'RECALL_ASSESSMENT', 'AUTHORISED_PERSON', p_cause);
    end if;
    perform recipe.bump_epoch('LOT', p_lot);
  end if;
  return v_n;
end
$$;


reset role;
