-- Tablets server: a G-07 weighing names the consumption it paired (Phase 3 exit review HIGH-4; controls INV-13, INV-14).
--
-- recipe-core 0700 refuses at commit a GMP consumption that no entry of its command names (EBMR-RCP-433). A TB-01 entry
-- names its consumption in its data; a G-07@1 weighing has no member for it (a block version's schema never changes,
-- ADR 0010), and tablets 1093 pairs it with a consumption of its transaction of exactly its net instead.
--
--   * tab.g07_consumption_pairs(batch, content, old, new): the pairing of 1093 (the new CONTAINER_WEIGHING entries of a
--     lot at a G-07 step, in recorded order, each with the first unused consumption of this transaction of that lot into
--     this batch of exactly its net, none a TB-01 entry of the row names), as (entry key, consumption id or NULL).
--   * tab.g07_consumption_check (CREATE OR REPLACE from 1093): 1093's check unchanged and first, then each pair is
--     recorded through recipe.claim_consumption (recipe-core 0700), so the deferred check finds the entry that names it.
--
-- New functions are owned by ebmr_owner; every function pins its search_path with pg_temp last (ADR 0016).

set local role ebmr_owner;

create function tab.g07_consumption_pairs(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb)
returns table (entry_key text, consumption_id uuid)
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, site, pg_temp as $$
declare
  e0      jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1      jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  k       text;
  e       jsonb;
  d       jsonb;
  v_lot   uuid;
  v_used  uuid[] := '{}';
  v_named uuid[];
  v_found uuid;
begin
  if kernel.installation_kind() = 'SANDBOX' then
    return;
  end if;
  select coalesce(array_agg((y.value -> 'data' ->> 'consumption')::uuid), '{}') into v_named
    from jsonb_each(e1) y where not (e0 ? y.key) and jsonb_typeof(y.value -> 'data' -> 'consumption') = 'string';
  for k, e in select y.key, y.value from jsonb_each(e1) y where not (e0 ? y.key) and y.value ->> 'kind' = 'CONTAINER_WEIGHING'
               order by (y.value ->> 'recordedSeq')::numeric, y.key loop
    continue when (recipe.step_node(p_content, split_part(coalesce(e ->> 'stepKey', ''), '@', 1)) -> 'block' ->> 'type') is distinct from 'G-07';
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    continue when jsonb_typeof(d -> 'lot' -> 'id') is distinct from 'string';
    select m.id into v_lot from site.material_lot m join recipe.stub_batch b on b.site = m.site_code where b.id = p_batch and m.lot_code = d -> 'lot' ->> 'id';
    v_found := null;
    select x.id into v_found
      from site.lot_consumption x
     where x.batch_id = p_batch and x.lot_id = v_lot and x.xact_id = txid_current()
       and x.quantity = tab.tb01_mass_in((d ->> 'net')::numeric, d ->> 'unit', x.unit)
       and not (x.id = any (v_used)) and not (x.id = any (v_named))
     order by x.consumed_at, x.id
     limit 1;
    entry_key := k;
    consumption_id := v_found;
    return next;
    if v_found is not null then
      v_used := v_used || v_found;
    end if;
  end loop;
end
$$;

create or replace function tab.g07_consumption_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
  v_content jsonb;
  p         record;
begin
  if not exists (select 1
                   from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
                  where not coalesce((old.state -> 'entries') ? x.key, false) and x.value ->> 'kind' = 'CONTAINER_WEIGHING') then
    return null;
  end if;
  v_content := recipe.batch_mbr_content(new.batch_id);
  v_problem := tab.g07_consumption_problem(new.batch_id, v_content, old.state, new.state);
  if v_problem is not null then
    select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
    raise exception using errcode = 'P0001',
      message = format('This %s row is refused: %s. [EBMR-TAB-391]', coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  for p in select * from tab.g07_consumption_pairs(new.batch_id, v_content, old.state, new.state) x where x.consumption_id is not null loop
    perform recipe.claim_consumption(new.batch_id, p.consumption_id, p.entry_key);
  end loop;
  return null;
end
$$;

revoke all on function tab.g07_consumption_pairs(uuid, jsonb, jsonb, jsonb) from public;

reset role;
