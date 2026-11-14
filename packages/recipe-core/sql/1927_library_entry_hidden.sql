-- Recipe core, injectables review pass, follow-up to item 3 (lead's ruling of 14 November 2026; PR-03, PR-29; decision
-- 0008 section 2): the database refuses a library entry that stores a value in a field its condition hides, as the
-- generic handler does (library/block-version.ts accept, LIB-ENTRY-HIDDEN).
--
-- Handbook: modules/recipe-core.md
--
-- A field of a library block may carry a condition (showWhen: another field of the section holds a given answer). The
-- engine refuses an entry that gives a value to a field its condition hides ("leave it empty"), and so never stores one.
-- 1924 judges answers only in fields the entry shows, and 1862 refuses a calculated value the condition hides, but
-- nothing in the database refused a recorded value in a hidden field. A write through the application role could
-- therefore store, for example, a rework quantity with rework answered "no", and the record would show a value that the
-- master says does not apply. Now the trigger zzh_library_entry_hidden refuses it (EBMR-LIB-025, naming LIB-ENTRY-HIDDEN).
--
-- What is judged: every entry the row adds or changes, of a step whose block is a library block (LIB-), in the section the
-- entry names; each field of that section other than a calculated field (1862 judges those through `computed`) and a
-- timer (recorded as separate start and stop entries). The field is shown when it has no condition, or the condition's
-- field holds the given answer in the stored data (block-version.ts shown); a key absent from the data is no answer.
-- The stored data is the engine's `data` (the shown fields it accepted, plus `computed`), so the condition is read from the
-- same values the engine read.
--
--   recipe.library_hidden_problem, recipe.library_hidden_check: new. The trigger zzh_library_entry_hidden: new, after
--   update on recipe.execution_state, as zzg_library_limits (1810). No function of an earlier migration is replaced. Rows
--   written before this migration are not judged again (only entries the row adds or changes).

set local role ebmr_owner;

-- The first hidden field that entry data of the row p_new stores, as the reason it is refused; NULL when there is none.
create function recipe.library_hidden_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0     jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1     jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  k      text;
  e      jsonb;
  v_step text;
  v_node jsonb;
  d      jsonb;
  s      jsonb;
  f      jsonb;
begin
  for k, e in select y.key, y.value from jsonb_each(e1) y where (e0 -> y.key) is distinct from y.value order by y.key loop
    if jsonb_typeof(e -> 'data') is distinct from 'object' then
      continue;
    end if;
    v_step := p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step';
    v_node := recipe.step_node(p_content, v_step);
    if coalesce(v_node -> 'block' ->> 'type', '') not like 'LIB-%' then
      continue;
    end if;
    d := recipe.library_definition(p_content, v_node -> 'block');
    if d is null then
      continue;  -- recipe.library_limits_problem (zzg_library_limits) refuses an entry whose block is not in the snapshots.
    end if;
    select y into s from jsonb_array_elements(d -> 'sections') y where y ->> 'id' = e ->> 'kind' limit 1;
    if s is null then
      continue;
    end if;
    for f in select y from jsonb_array_elements(case when jsonb_typeof(s -> 'fields') = 'array' then s -> 'fields' else '[]'::jsonb end) with ordinality q (y, n)
              where y ->> 'type' not in ('CALC', 'TIMER') and y ? 'showWhen' order by n loop
      if (e -> 'data') ? (f ->> 'id') and (e -> 'data' -> (f -> 'showWhen' ->> 'field')) is distinct from (f -> 'showWhen' -> 'equals') then
        return format('stores %s = %s in entry %s at step %s, a field that applies only when %s is %s (LIB-ENTRY-HIDDEN)',
                      f ->> 'id', e -> 'data' -> (f ->> 'id'), k, v_step, f -> 'showWhen' ->> 'field', f -> 'showWhen' -> 'equals');
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- The trigger runs for a row that adds or changes an entry.
create function recipe.library_hidden_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) y
                  where (old.state -> 'entries' -> y.key) is distinct from y.value) then
    return null;
  end if;
  v_problem := recipe.library_hidden_problem(recipe.batch_mbr_content(new.batch_id), old.state, new.state);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This row %s: a library entry leaves empty every field its condition hides (PR-03, PR-29; decision 0026). [EBMR-LIB-025]', v_problem);
  end if;
  return null;
end
$$;

create trigger zzh_library_entry_hidden after update on recipe.execution_state for each row execute function recipe.library_hidden_check();

revoke all on function recipe.library_hidden_problem(jsonb, jsonb, jsonb), recipe.library_hidden_check() from public;

reset role;
