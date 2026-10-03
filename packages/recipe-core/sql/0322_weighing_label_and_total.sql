-- Recipe core, execution store (module C3): a weighing's label, and the quantity a step's weighings count into, are what
-- the weighings record, at the resolution they were weighed at (lead TODO T2 of the Phase 2 exit, round 2; INV-25,
-- PR-19, DI-30; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- What was wrong: 0321 checks the net of a new weighing entry and nothing else the blocks compute from it. The round-1
-- verification stored, through the application role, a G-07 weighing whose net was 50.000 but whose label said "50 kg";
-- the database answered ok. And the total a step records from its containers (the dispensed quantity of G-07, the
-- produced quantity of G-22: a block value computed when the step is signed performed) was the writer's word: 0300
-- binds it to that row and step only, so any figure, or a total leaving a container out, was stored.
--
-- Engine 1.3.0 counts each net into the quantity's unit at the resolution it was weighed at (blocks/generic common.ts
-- convertAtResolution: 8000.0 g counts as 8.0000 kg) and the total at the finest of them, and counts a weight only in the
-- quantity's own unit or when both are metric mass units (G07-UNIT, G22-UNIT). This migration adds:
--  - recipe.metric_mass_exponent(unit): the power of ten of a metric mass unit, g with a metric prefix (kg 3, g 0, mg -3);
--    NULL for any other unit;
--  - recipe.weighing_label_problem(entry, batch number, MBR content): NULL unless a CONTAINER_WEIGHING entry's label is not
--    exactly the one the weighing and the batch give: component (the BOM line's material, else the line), lot (the lot's
--    id), quantity ("<net> <unit>"), batch, product (the MBR's product code) and container;
--  - recipe.block_total_problem(state, point key, unit): NULL unless that block value is not the total of the step's
--    weighings for its item: it names exactly those weighing entries, and holds the sum of their nets in the quantity's
--    unit (the MBR parameter's), written at the finest resolution of the weighings carried through the conversion;
--  - recipe.weighing_totals_problem(old state, new state, MBR content): NULL unless the new state brings in a block value
--    that is not that total, or a step leaves IN_PROGRESS for AWAITING_VERIFICATION or COMPLETED while a quantity its
--    weighings count into has no single valid block value that is that total;
--  - a row trigger on recipe.execution_state (zm_execution_weighing_record, after update; every row) that refuses a row
--    whose state brings in a weighing entry with another label (EBMR-EXE-137) or a total other than the weighings' own
--    (EBMR-EXE-138).
-- Entries and values stored before this migration are left as they were (a batch issued under an earlier engine is
-- neither run nor replayed by engine 1.3.0: EBMR-EXE-061).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- INV-25 (T2 round 2): the power of ten of a metric mass unit (g with a metric prefix); NULL for any other unit code.
create function recipe.metric_mass_exponent(p_unit text) returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case m[1]
           when 'Y' then 24 when 'Z' then 21 when 'E' then 18 when 'P' then 15 when 'T' then 12 when 'G' then 9
           when 'M' then 6 when 'k' then 3 when 'h' then 2 when 'da' then 1 when '' then 0 when 'd' then -1
           when 'c' then -2 when 'm' then -3 when 'u' then -6 when 'n' then -9 when 'p' then -12 when 'f' then -15
           when 'a' then -18 when 'z' then -21 when 'y' then -24
         end
    from regexp_match(p_unit, '^(Y|Z|E|P|T|G|M|k|h|da|d|c|m|u|n|p|f|a|z|y|)g$') as m
$$;

-- PR-19, INV-25 (T2 round 2): why weighing entry p_entry ({kind, data}) does not carry the label its weighing and the
-- batch give (header); NULL when it does or when it is no CONTAINER_WEIGHING. The text completes
-- "This <row> stores entry <id> ...".
create function recipe.weighing_label_problem(p_entry jsonb, p_batch_number text, p_content jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_data jsonb := p_entry -> 'data';
  v_bom  jsonb;
  v_want jsonb;
begin
  if (p_entry ->> 'kind') is distinct from 'CONTAINER_WEIGHING' then
    return null;
  end if;
  if jsonb_typeof(v_data) is distinct from 'object' then
    return '(CONTAINER_WEIGHING) with no data, so no label it gives';
  end if;
  select b into v_bom
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'bom') = 'array' then p_content -> 'bom' else '[]'::jsonb end) b
   where b ->> 'id' = v_data ->> 'bomLine'
   limit 1;
  v_want := jsonb_strip_nulls(jsonb_build_object(
    'component', coalesce(nullif(v_bom -> 'material', 'null'::jsonb), v_data -> 'bomLine'),
    'lot', v_data -> 'lot' -> 'id',
    'quantity', case when jsonb_typeof(v_data -> 'net') = 'string' and jsonb_typeof(v_data -> 'unit') = 'string'
                     then to_jsonb((v_data ->> 'net') || ' ' || (v_data ->> 'unit')) end,
    'batch', to_jsonb(p_batch_number),
    'product', p_content -> 'header' -> 'product' -> 'code',
    'container', v_data -> 'container'));
  if (v_data -> 'label') is distinct from v_want then
    return format('(CONTAINER_WEIGHING) labelled %s, where its weighing and the batch give %s',
                  coalesce(v_data -> 'label', 'null'::jsonb)::text, v_want::text);
  end if;
  return null;
end
$$;

-- INV-25, PR-19 (T2 round 2): why block value p_key of state p_state is not the total of its step's weighings for its
-- item in unit p_unit (the MBR parameter's; NULL when the MBR has none): the weighing entries it names, its kind, unit
-- and figure (header). NULL when it is that total. The text completes "This <row> records ...".
create function recipe.block_total_problem(p_state jsonb, p_key text, p_unit text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  x        jsonb := p_state -> 'points' -> p_key;
  v_named  jsonb := x -> 'source' -> 'entries';
  v_plain  text := '^-?[0-9]+(\.[0-9]+)?$';
  v_what   text;
  v_ids    text[] := '{}';
  v_to     integer := recipe.metric_mass_exponent(p_unit);
  v_shift  integer;
  v_net    numeric;
  v_total  numeric := 0;
  v_places integer := 0;
  v_want   text;
  e        record;
begin
  if jsonb_typeof(x) is distinct from 'object' then
    return format('block value %s, which the state does not hold', p_key);
  end if;
  v_what := format('block value %s of %s at %s', p_key, coalesce(x ->> 'item', '(no item)'), coalesce(x ->> 'stepKey', '(no step)'));
  if p_unit is null then
    return format('%s, which is no quantity of the batch''s MBR', v_what);
  end if;
  for e in select k.key, k.value -> 'data' as d
             from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) k
            where k.value ->> 'stepKey' = x ->> 'stepKey'
              and k.value ->> 'kind' in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER')
              and k.value -> 'data' ->> 'item' = x ->> 'item'
            order by k.key
  loop
    v_ids := v_ids || e.key;
    if jsonb_typeof(e.d -> 'net') is distinct from 'string' or (e.d ->> 'net') !~ v_plain or jsonb_typeof(e.d -> 'unit') is distinct from 'string' then
      return format('%s, counted from weighing %s, which records no net and unit as text', v_what, e.key);
    end if;
    v_net := (e.d ->> 'net')::numeric;
    if e.d ->> 'unit' = p_unit then
      v_shift := 0;
    elsif recipe.metric_mass_exponent(e.d ->> 'unit') is null or v_to is null then
      return format('%s, counted from weighing %s in %s, which is not counted into a quantity in %s (the same unit, or both metric mass units)',
                    v_what, e.key, e.d ->> 'unit', p_unit);
    else
      v_shift := recipe.metric_mass_exponent(e.d ->> 'unit') - v_to;
    end if;
    -- The net in the quantity's unit, exactly (a power of ten), and the resolution it was weighed at carried along:
    -- a reading to 0.1 g is a reading to 0.0001 kg.
    v_total := v_total + v_net * ('1e' || v_shift)::numeric;
    v_places := greatest(v_places, scale(v_net) - v_shift);
  end loop;
  if cardinality(v_ids) = 0 then
    return format('%s, which no weighing of its step counts into', v_what);
  end if;
  if jsonb_typeof(v_named) is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(v_named) n where jsonb_typeof(n) is distinct from 'string' or not ((n #>> '{}') = any (v_ids)))
     or (select count(distinct n #>> '{}') from jsonb_array_elements(v_named) n) <> cardinality(v_ids)
     or jsonb_array_length(v_named) <> cardinality(v_ids) then
    return format('%s, computed from the weighings %s, where its step records the weighings %s',
                  v_what, coalesce(v_named, 'null'::jsonb)::text, to_jsonb(v_ids)::text);
  end if;
  v_want := round(v_total, greatest(v_places, scale(trim_scale(v_total))))::text;
  if (x ->> 'kind') is distinct from 'VALUE' or jsonb_typeof(x -> 'value') is distinct from 'object'
     or (x -> 'value' ->> 'kind') is distinct from 'DECIMAL' or jsonb_typeof(x -> 'value' -> 'value') is distinct from 'string'
     or (x -> 'value' ->> 'value') is distinct from v_want or (x -> 'value' ->> 'unit') is distinct from p_unit then
    return format('%s as %s, where the nets of its weighings %s come to %s %s at the resolution they were weighed at',
                  v_what, coalesce(x -> 'value', 'null'::jsonb)::text, to_jsonb(v_ids)::text, v_want, p_unit);
  end if;
  return null;
end
$$;

-- INV-25, PR-19 (T2 round 2): why state p_new (after p_old; the batch's MBR content p_content) records a total of
-- weighings other than theirs: a block value it brings in, or the valid block value of each quantity a step's weighings
-- count into when the step leaves IN_PROGRESS for AWAITING_VERIFICATION or COMPLETED (header). NULL when none. The text
-- completes "This <row> records ...".
create function recipe.weighing_totals_problem(p_old jsonb, p_new jsonb, p_content jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_points  jsonb := case when jsonb_typeof(p_new -> 'points') = 'object' then p_new -> 'points' else '{}'::jsonb end;
  v_entries jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_params  jsonb := case when jsonb_typeof(p_content -> 'parameters') = 'array' then p_content -> 'parameters' else '[]'::jsonb end;
  v_valid   text[];
  v_problem text;
  k         text;
  x         jsonb;
  v_item    text;
begin
  for k, x in select p.key, p.value
                from jsonb_each(v_points) p
               where not coalesce((p_old -> 'points') ? p.key, false)
                 and p.value -> 'source' ->> 'mode' = 'BLOCK'
               order by p.key
  loop
    v_problem := recipe.block_total_problem(p_new, k, (select q ->> 'unit' from jsonb_array_elements(v_params) q where q ->> 'id' = x ->> 'item' limit 1));
    if v_problem is not null then
      return v_problem;
    end if;
  end loop;
  for k in select s.key
             from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) s
            where s.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED')
              and (p_old -> 'steps' -> s.key ->> 'status') = 'IN_PROGRESS'
            order by s.key
  loop
    for v_item in select distinct e.value -> 'data' ->> 'item'
                    from jsonb_each(v_entries) e
                   where e.value ->> 'stepKey' = k
                     and e.value ->> 'kind' in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER')
                     and jsonb_typeof(e.value -> 'data' -> 'item') = 'string'
                   order by 1
    loop
      select coalesce(array_agg(p.key order by p.key), '{}') into v_valid
        from jsonb_each(v_points) p
       where p.value ->> 'stepKey' = k and p.value ->> 'item' = v_item
         and p.value ->> 'status' = 'VALID' and p.value -> 'source' ->> 'mode' = 'BLOCK';
      if cardinality(v_valid) <> 1 then
        return format('step %s as %s with %s valid block values of %s, where its weighings count into exactly one',
                      k, p_new -> 'steps' -> k ->> 'status', cardinality(v_valid), v_item);
      end if;
      v_problem := recipe.block_total_problem(p_new, v_valid[1], (select q ->> 'unit' from jsonb_array_elements(v_params) q where q ->> 'id' = v_item limit 1));
      if v_problem is not null then
        return format('step %s as %s with %s', k, p_new -> 'steps' -> k ->> 'status', v_problem);
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- PR-19, INV-25 (T2 round 2): a weighing entry a row brings in carries its own label (EBMR-EXE-137), and the total a
-- step records from its weighings is theirs (EBMR-EXE-138) (header). Raises; returns nothing.
create function recipe.execution_weighing_record_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_row     text;
  v_problem text;
  k         text;
  x         jsonb;
begin
  if not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) e
                  where not coalesce((old.state -> 'entries') ? e.key, false) and e.value ->> 'kind' = 'CONTAINER_WEIGHING')
     and not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'points') = 'object' then new.state -> 'points' else '{}'::jsonb end) p
                      where not coalesce((old.state -> 'points') ? p.key, false) and p.value -> 'source' ->> 'mode' = 'BLOCK')
     and not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'steps') = 'object' then new.state -> 'steps' else '{}'::jsonb end) s
                      where s.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and (old.state -> 'steps' -> s.key ->> 'status') = 'IN_PROGRESS') then
    return null;
  end if;
  select pk.content into v_content
    from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash
   where b.id = new.batch_id;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_row := format('%s %s', case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                  coalesce(r.command_type, r.kind, 'unknown'));
  for k, x in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) e
               where not coalesce((old.state -> 'entries') ? e.key, false)
               order by e.key
  loop
    v_problem := recipe.weighing_label_problem(x, new.state -> 'header' ->> 'batchNumber', v_content);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('This %s row stores entry %s %s: a container''s label carries its weighing''s own net, unit, lot and container and the batch''s identity (PR-19, INV-25). [EBMR-EXE-137]',
                         v_row, k, v_problem);
    end if;
  end loop;
  v_problem := recipe.weighing_totals_problem(old.state, new.state, v_content);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s row records %s: a quantity counted from weighings is the sum of their nets, every one, at the resolution they were weighed at (INV-25, PR-19). [EBMR-EXE-138]',
                       v_row, v_problem);
  end if;
  return null;
end
$$;

create trigger zm_execution_weighing_record after update on recipe.execution_state
  for each row execute function recipe.execution_weighing_record_check();

revoke all on function recipe.metric_mass_exponent(text), recipe.weighing_label_problem(jsonb, text, jsonb),
  recipe.block_total_problem(jsonb, text, text), recipe.weighing_totals_problem(jsonb, jsonb, jsonb),
  recipe.execution_weighing_record_check() from public;

reset role;
