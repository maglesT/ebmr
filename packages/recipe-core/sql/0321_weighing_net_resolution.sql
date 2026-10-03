-- Recipe core, execution store (module C3): the net weight a weighing entry records is gross minus tare, exactly, at the
-- resolution of the weighings (lead TODO T2 of the Phase 2 exit; INV-25, PR-19, DI-30; ADR 0012: the rules hold when
-- the application's own database credentials are used directly).
--
-- What was wrong: the blocks compute a container's net (G-07 CONTAINER_WEIGHING, G-22 OUTPUT_CONTAINER: engine
-- blocks/generic common.ts netOf) and wrote it without the trailing zeros of the weighings ("50" for 51.250 - 1.250), so
-- the record, the container label and the register lost the resolution the balance weighed at. And the database never
-- checked the net at all: 0300 binds a new weighing entry's source, balance, gross, tare and unit to its command, 0313
-- every member the command sent, 0317 the container register's net to the entry's; the net itself, a member the block
-- adds, was the writer's word. A row written with the application's role could record any net beside honest weighings.
--
-- Engine 1.2.0 writes the net with the decimals of the finer of the two weighings, exactly, as PostgreSQL's numeric
-- subtraction writes it. This migration adds recipe.weighing_net_problem(entry), NULL when the entry is no weighing or
-- its net is (gross::numeric - tare::numeric)::text, and a row trigger on recipe.execution_state (zl_execution_weighing_net,
-- after update; every row) that refuses a row whose state brings in a weighing entry with another net, or with a gross,
-- tare or net that is not decimal text (EBMR-EXE-136). Entries stored before this migration are left as they were
-- (a batch issued under engine 1.1.0 is neither run nor replayed by engine 1.2.0: EBMR-EXE-061).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- INV-25 (T2): why weighing entry p_entry ({kind, data}) does not record gross minus tare at the weighings' resolution;
-- NULL when it does or when it is no weighing. The text completes "This <row> stores entry <id> ...".
create function recipe.weighing_net_problem(p_entry jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_data  jsonb := p_entry -> 'data';
  v_plain text := '^-?[0-9]+(\.[0-9]+)?$';
  v_want  text;
begin
  if (p_entry ->> 'kind') is null or (p_entry ->> 'kind') not in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER') then
    return null;
  end if;
  if jsonb_typeof(v_data) is distinct from 'object'
     or jsonb_typeof(v_data -> 'gross') is distinct from 'string' or (v_data ->> 'gross') !~ v_plain
     or jsonb_typeof(v_data -> 'tare') is distinct from 'string' or (v_data ->> 'tare') !~ v_plain then
    return format('(%s) with no gross and tare as decimal text', p_entry ->> 'kind');
  end if;
  v_want := ((v_data ->> 'gross')::numeric - (v_data ->> 'tare')::numeric)::text;
  if jsonb_typeof(v_data -> 'net') is distinct from 'string' or (v_data ->> 'net') is distinct from v_want then
    return format('(%s) with net %s, where gross %s minus tare %s is %s at the resolution of the weighings',
                  p_entry ->> 'kind', coalesce(v_data -> 'net', 'null'::jsonb)::text, v_data ->> 'gross', v_data ->> 'tare', v_want);
  end if;
  return null;
end
$$;

-- INV-25, PR-19 (T2): a weighing entry a row brings in records gross minus tare, exactly, at the weighings' resolution
-- (header). EBMR-EXE-136. Raises; returns nothing.
create function recipe.execution_weighing_net_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  k         text;
  x         jsonb;
  v_problem text;
begin
  for k, x in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) e
               where not coalesce((old.state -> 'entries') ? e.key, false)
               order by e.key
  loop
    v_problem := recipe.weighing_net_problem(x);
    if v_problem is not null then
      select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
      raise exception using errcode = 'P0001',
        message = format('This %s %s row stores entry %s %s: a net weight is gross minus tare, exactly, at the resolution of the weighings (INV-25, PR-19). [EBMR-EXE-136]',
                         case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                         coalesce(r.command_type, r.kind, 'unknown'), k, v_problem);
    end if;
  end loop;
  return null;
end
$$;

create trigger zl_execution_weighing_net after update on recipe.execution_state
  for each row execute function recipe.execution_weighing_net_check();

revoke all on function recipe.weighing_net_problem(jsonb), recipe.execution_weighing_net_check() from public;

reset role;
