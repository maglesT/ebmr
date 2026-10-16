-- Recipe core: a batch with a controlled API account ends only with that account closed (Phase 6 slice 6e quick review,
-- core medium; draft control IN-53; D-P6e-4).
--
-- Handbook: modules/recipe-core.md
--
-- The stage sign-off guard of 1033 closes the account at every stage, but a batch could still reach EXECUTION_COMPLETE
-- after a last movement (a return or a destruction confirmed after the last sign-off) with nothing accounting for it.
--   recipe.controlled_batch_end_problem(batch)  NULL when every controlled material that moved into the batch has a
--       signed checkpoint, at any stage, that is still current (the account has not moved since); else why not.
--   trigger a1_controlled_batch_end (after update on recipe.execution_state): the move to EXECUTION_COMPLETE is refused
--       while that problem is not NULL (EBMR-CSM-043). An aborted or cancelled batch is not held (its account is still
--       recorded and signed afterwards, which recipe.record_controlled_checkpoint allows in any state); a batch with no
--       controlled movement is unaffected.

set local role ebmr_owner;

create function recipe.controlled_batch_end_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  m text;
begin
  foreach m in array recipe.controlled_moved_materials(p_batch) loop
    if not exists (select 1 from recipe.controlled_checkpoint k
                    where k.batch_id = p_batch and k.material_code = m and recipe.controlled_checkpoint_state(k.id) = 'SIGNED'
                      and recipe.controlled_checkpoint_current(k.id)) then
      return format('the account of controlled API %s has no signed checkpoint that is current (record and sign it at the last stage)', m);
    end if;
  end loop;
  return null;
end
$$;

create function recipe.controlled_batch_end_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_prob text;
begin
  if new.status is distinct from 'EXECUTION_COMPLETE' or new.status is not distinct from old.status then
    return null;
  end if;
  v_prob := recipe.controlled_batch_end_problem(new.batch_id);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-043 the batch cannot complete: %s (IN-53)', v_prob);
  end if;
  return null;
end
$$;
create trigger a1_controlled_batch_end after update on recipe.execution_state for each row execute function recipe.controlled_batch_end_guard();

revoke all on function recipe.controlled_batch_end_problem(uuid), recipe.controlled_batch_end_guard() from public;
grant execute on function recipe.controlled_batch_end_problem(uuid) to ebmr_app;

reset role;
