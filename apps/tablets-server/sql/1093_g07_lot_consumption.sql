-- Tablets server, Phase 3 slice 6d (GB-T-01 residual, coordinator): on GMP every dispensed container of a lot is consumed
-- from the batch's reservation in its own command, so the lot's stock and the batch's genealogy follow the record
-- (INV-13, INV-14, PR-57). TB-01 names its consumption in the entry (tablets 0843); a G-07@1 weighing has no member for
-- it (a block version's schema never changes, ADR 0010), and nothing consumed its lot: a GMP batch dispensed through
-- G-07 had no lot consumption and no genealogy for that material.
--
--   * The server consumes the net of a GMP G-07 weighing of a lot through recipe.consume_lot in the same command, as for
--     TB-01 (features/execution/intents.ts; consume_lot asks for DISPENSE.EXECUTE: dispensing is the dispenser's act).
--   * A row trigger on recipe.execution_state (ac_tab_g07_consumption, after update) refuses a GMP row that records a new
--     CONTAINER_WEIGHING entry of a lot at a G-07 step unless this transaction consumed exactly its net (in the lot's
--     unit) of that lot into this batch, one consumption per entry, none of them one a TB-01 entry of the row names
--     (EBMR-TAB-391, rule G07-CONSUMPTION). A test run's lots have no stock: nothing is required there.
--
-- New functions are owned by ebmr_owner; the trigger function is SECURITY DEFINER; every function pins its search_path
-- with pg_temp last (ADR 0016).

set local role ebmr_owner;

create function tab.g07_consumption_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
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
    return null;
  end if;
  -- The consumptions TB-01 entries of this row name are theirs.
  select coalesce(array_agg((y.value -> 'data' ->> 'consumption')::uuid), '{}') into v_named
    from jsonb_each(e1) y where not (e0 ? y.key) and jsonb_typeof(y.value -> 'data' -> 'consumption') = 'string';
  for k, e in select y.key, y.value from jsonb_each(e1) y where not (e0 ? y.key) and y.value ->> 'kind' = 'CONTAINER_WEIGHING'
               order by (y.value ->> 'recordedSeq')::numeric, y.key loop
    continue when (recipe.step_node(p_content, split_part(coalesce(e ->> 'stepKey', ''), '@', 1)) -> 'block' ->> 'type') is distinct from 'G-07';
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    continue when jsonb_typeof(d -> 'lot' -> 'id') is distinct from 'string';
    select m.id into v_lot from site.material_lot m join recipe.stub_batch b on b.site = m.site_code where b.id = p_batch and m.lot_code = d -> 'lot' ->> 'id';
    select x.id into v_found
      from site.lot_consumption x
     where x.batch_id = p_batch and x.lot_id = v_lot and x.xact_id = txid_current()
       and x.quantity = tab.tb01_mass_in((d ->> 'net')::numeric, d ->> 'unit', x.unit)
       and not (x.id = any (v_used)) and not (x.id = any (v_named))
     order by x.consumed_at, x.id
     limit 1;
    if v_found is null then
      return format('entry %s (CONTAINER_WEIGHING) of G-07 step %s dispenses %s %s of lot %s, and this command consumed no such quantity of that lot into the batch: on GMP every dispensed container is consumed from the batch''s reservation in its own command (G07-CONSUMPTION; INV-13, INV-14, PR-57)',
                    k, e ->> 'stepKey', d ->> 'net', d ->> 'unit', left(d -> 'lot' ->> 'id', 64));
    end if;
    v_used := v_used || v_found;
  end loop;
  return null;
end
$$;

create function tab.g07_consumption_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
                  where not coalesce((old.state -> 'entries') ? x.key, false) and x.value ->> 'kind' = 'CONTAINER_WEIGHING') then
    return null;
  end if;
  v_problem := tab.g07_consumption_problem(new.batch_id, recipe.batch_mbr_content(new.batch_id), old.state, new.state);
  if v_problem is not null then
    select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
    raise exception using errcode = 'P0001',
      message = format('This %s row is refused: %s. [EBMR-TAB-391]', coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger ac_tab_g07_consumption after update on recipe.execution_state
  for each row execute function tab.g07_consumption_check();

revoke all on function tab.g07_consumption_problem(uuid, jsonb, jsonb, jsonb), tab.g07_consumption_check() from public;

reset role;
