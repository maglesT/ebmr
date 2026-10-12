-- Tablets server: on GMP a packing line starts only on bulk issued to its packaging order (Phase 3 exit review HIGH-3;
-- default D-S4-2; recipe-core 0701; controls INV-27, IN-18, PR-37).
--
--   * tab.packaging_run_problem(batch, content, old, new): why a new entry of the row is refused, or NULL. On GMP, a new
--     RUN_START at a TB-21 step, or any new entry at a TB-23 or TB-24 step, needs bulk issued to the batch
--     (recipe.packaging_bulk_charged): bulk is issued only to a packaging order whose processing batch QA released for
--     packing (H-PACK), from its usable containers (recipe.issue_packaging_bulk). So a line never runs a packaging order
--     before its processing batch is released for packing, and a packing step never runs in a processing batch. A test
--     run (sandbox) has no packaging orders: nothing is required there.
--   * the row trigger ad_tab_packaging_run (after update on recipe.execution_state; early in name order, so this
--     refusal is the one reported): raises EBMR-TAB-395 with the command's type.
--
-- New functions are owned by ebmr_owner; the trigger function is SECURITY DEFINER; every function pins its search_path
-- with pg_temp last (ADR 0016).

set local role ebmr_owner;

create function tab.packaging_run_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  e0     jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1     jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  k      text;
  e      jsonb;
  v_type text;
begin
  if kernel.installation_kind() = 'SANDBOX' then
    return null;
  end if;
  for k, e in select y.key, y.value from jsonb_each(e1) y where not (e0 ? y.key) order by (y.value ->> 'recordedSeq')::numeric, y.key loop
    v_type := recipe.step_node(p_content, split_part(coalesce(e ->> 'stepKey', ''), '@', 1)) -> 'block' ->> 'type';
    continue when not ((v_type = 'TB-21' and e ->> 'kind' = 'RUN_START') or v_type in ('TB-23', 'TB-24'));
    if not recipe.packaging_bulk_charged(p_batch) then
      return format('entry %s (%s) of %s step %s starts packing, and no bulk was issued to this batch: a packing line runs only a packaging order whose processing batch QA released for packing (H-PACK), on bulk issued to it from that batch''s usable containers (recipe.issue_packaging_bulk; D-S4-2, INV-27)',
                    k, e ->> 'kind', v_type, e ->> 'stepKey');
    end if;
  end loop;
  return null;
end
$$;

create function tab.packaging_run_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
                  where not coalesce((old.state -> 'entries') ? x.key, false)) then
    return null;
  end if;
  v_problem := tab.packaging_run_problem(new.batch_id, recipe.batch_mbr_content(new.batch_id), old.state, new.state);
  if v_problem is not null then
    select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
    raise exception using errcode = 'P0001',
      message = format('This %s row is refused: %s. [EBMR-TAB-395]', coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger ad_tab_packaging_run after update on recipe.execution_state
  for each row execute function tab.packaging_run_check();

revoke all on function tab.packaging_run_problem(uuid, jsonb, jsonb, jsonb), tab.packaging_run_check() from public;

reset role;
