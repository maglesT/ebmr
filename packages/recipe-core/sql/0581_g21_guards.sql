-- Recipe core, Phase 3 slice 4a (builder B): the rules of a G-21 step (printed materials, coding, challenges and
-- serialisation) that read the whole row, held by the database (tablets spec K-19 to K-21; outline 5.2.8 L-29; controls
-- PR-37, PR-39, PR-40, PR-42, IN-17, IN-22, INV-32; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- recipe.entry_block_problem (0580) holds each G-21 entry to what the block builds. This migration adds a row trigger on
-- recipe.execution_state (zr_g21, after update; every row of a batch whose MBR has a G-21 step) that refuses a row
-- unless:
--   1. the batch's MBR names, for every G-21 step with an item coded on the line, a G-23 step whose check is witnessed
--      as the step that destroys the coded surplus (EBMR-EXE-290);
--   2. every new G-21 entry carries the exception the block raises with it, in the same row and at its step: a
--      reconciliation outside its limits raises PRINTED_RECONCILIATION (a deviation is required, release is blocked; INV-32,
--      IN-17, PR-39); a failed challenge CHALLENGE_FAILED, a challenge taken after its interval ran out CHALLENGE_MISSED
--      (the step may not complete until QA decides; IN-22 (b), PR-37); a serial pool that does not close
--      SERIAL_RECONCILIATION_OPEN (release blocked; PR-42) (EBMR-EXE-291);
--   3. a G-21 step closes (IN_PROGRESS to AWAITING_VERIFICATION or COMPLETED) only complete: every configured item
--      reconciled (the reconciliation always runs, never waived: INV-32, IN-17), every printer's first print approved,
--      every inspection device challenged with a pass at the start and end triggers it has and not due for a challenge,
--      every serialised market of the batch with its pool and every pool's latest reconciliation closed with zero
--      unexplained (PR-42: the packaging order does not complete without it); a G-23 step a G-21 step names for its
--      coded surplus closes only after that G-21 step and destroys, as batch-coded material, exactly the coded quantity
--      its reconciliations count, item unit for item unit (PR-40, IN-22) (EBMR-EXE-292);
--   4. a G-21 step, and a G-23 step one names for its coded surplus, is never skipped (INV-32) (EBMR-EXE-293);
--   5. a G-23 return to stores of the material of an item a G-21 step codes never exceeds what its reconciliations count
--      as uncoded returned: coded surplus is destroyed, never returned (PR-40) (EBMR-EXE-294).
-- With an accepted row the trigger then records, for a G-21 step whose configuration names the line's plant unit, the
-- check its holds follow (plant.record_ipc_check, the slice 1 hold window): an approved first print a PASS; a challenge
-- taken late a MISSED, then its result, PASS or FAIL. A MISSED or FAIL check holds every container opened on the unit
-- since its last PASS (IN-22 (b)).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- The configuration of a phase node.
create function recipe.g21_cfg(p_node jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p_node -> 'config') = 'object' then p_node -> 'config' else '{}'::jsonb end
$$;

-- The phase nodes of block p_type in MBR content p_content.
create function recipe.g21_nodes(p_content jsonb, p_type text) returns setof jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
   where p -> 'block' ->> 'type' = p_type
$$;

-- The entries of step instance p_key in state p_state, in recording order.
create function recipe.g21_step_entries(p_state jsonb, p_key text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(x.value order by (x.value ->> 'recordedSeq')::numeric, x.key), '[]'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) x
   where x.value ->> 'stepKey' = p_key and jsonb_typeof(x.value -> 'recordedSeq') = 'number'
$$;

-- Whether row p_new raised (newly against p_old) an exception of type p_type at step instance p_key for item p_item, with
-- a deviation required as p_deviation says and blocking release as p_release says; with p_qa, waiting for QA's disposition
-- with step p_key unable to complete.
create function recipe.g21_raised(p_old jsonb, p_new jsonb, p_key text, p_type text, p_item text, p_deviation boolean, p_release boolean, p_qa boolean)
returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
     where not coalesce((p_old -> 'exceptions') ? x.key, false) and x.value ->> 'type' = p_type and x.value -> 'source' ->> 'stepKey' = p_key
       and x.value -> 'source' ->> 'item' = p_item and x.value ->> 'severity' = 'ACTION'
       and coalesce((x.value -> 'deviationRequired') = 'true'::jsonb, false) = p_deviation
       and coalesce((x.value -> 'releaseBlocking') = 'true'::jsonb, false) = p_release
       and (not p_qa or ((x.value -> 'qaOnly') = 'true'::jsonb and x.value -> 'block' ->> 'until' = 'DISPOSITION'
                         and coalesce((x.value -> 'block' -> 'steps') ? p_key, false))))
$$;

-- 1 (header): why MBR p_content lacks the witnessed G-23 step a G-21 step with coded items destroys its surplus at.
create function recipe.g21_mbr_problem(p_content jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  n     jsonb;
  v_dst jsonb;
begin
  for n in select x from recipe.g21_nodes(p_content, 'G-21') x loop
    if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(recipe.g21_cfg(n) -> 'items') = 'array' then recipe.g21_cfg(n) -> 'items' else '[]'::jsonb end) i
                    where (i -> 'coded') = 'true'::jsonb) then
      continue;
    end if;
    select d into v_dst from recipe.g21_nodes(p_content, 'G-23') d where d ->> 'id' = recipe.g21_cfg(n) ->> 'destructionStep' limit 1;
    if v_dst is null or v_dst -> 'signatures' -> 'check' ->> 'meaning' is distinct from 'WITNESSED' then
      return format('printed-materials step %s codes items on the line but its destruction step %s is no G-23 step with a witnessed check (G21-DESTRUCTION-STEP)',
                    n ->> 'id', coalesce(recipe.g21_cfg(n) ->> 'destructionStep', '(none)'));
    end if;
  end loop;
  return null;
end
$$;

-- 2 (header): why a new G-21 entry of row p_new lacks the exception its block raises with it; NULL when none does.
create function recipe.g21_exception_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0 jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k  text;
  e  jsonb;
  d  jsonb;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by x.key loop
    if recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step') -> 'block' ->> 'type' is distinct from 'G-21' then
      continue;
    end if;
    d := e -> 'data';
    if e ->> 'kind' = 'RECONCILIATION' and (d -> 'withinLimits') = 'false'::jsonb
       and not recipe.g21_raised(p_old, p_new, e ->> 'stepKey', 'PRINTED_RECONCILIATION', d ->> 'item', true, true, false) then
      return format('reconciles %s at %s outside its limits without the exception that requires an investigation and blocks release (INV-32, IN-17, PR-39)', d ->> 'item', e ->> 'stepKey');
    end if;
    if e ->> 'kind' = 'CHALLENGE' and (d -> 'missed') = 'true'::jsonb
       and not recipe.g21_raised(p_old, p_new, e ->> 'stepKey', 'CHALLENGE_MISSED', d ->> 'device', false, false, true) then
      return format('records a late challenge of %s at %s without the exception that stops the step until QA decides (IN-22, PR-37)', d ->> 'device', e ->> 'stepKey');
    end if;
    if e ->> 'kind' = 'CHALLENGE' and d ->> 'result' = 'FAIL'
       and not recipe.g21_raised(p_old, p_new, e ->> 'stepKey', 'CHALLENGE_FAILED', d ->> 'device', false, false, true) then
      return format('records a failed challenge of %s at %s without the exception that stops the step until QA decides (IN-22, PR-37)', d ->> 'device', e ->> 'stepKey');
    end if;
    if e ->> 'kind' = 'SERIAL_RECONCILIATION' and (d -> 'closed') = 'false'::jsonb
       and not recipe.g21_raised(p_old, p_new, e ->> 'stepKey', 'SERIAL_RECONCILIATION_OPEN', d ->> 'poolId', true, true, false) then
      return format('reconciles serial pool %s at %s open without the exception that blocks release (PR-42)', d ->> 'poolId', e ->> 'stepKey');
    end if;
  end loop;
  return null;
end
$$;

-- The quantity of material p_material in unit p_unit that G-21 reconciliations of state p_state count as p_part, over the
-- G-21 steps of MBR p_content that code it (and, with p_dest, name G-23 step p_dest for their surplus).
create function recipe.g21_counted(p_content jsonb, p_state jsonb, p_material text, p_unit text, p_part text, p_dest text) returns numeric
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(sum(recipe.g21_dec(e.value -> 'data' -> p_part)), 0)
    from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) e
    join lateral (select recipe.step_node(p_content, p_state -> 'steps' -> (e.value ->> 'stepKey') ->> 'step') n) s on true
   where e.value ->> 'kind' = 'RECONCILIATION' and s.n -> 'block' ->> 'type' = 'G-21'
     and (p_dest is null or recipe.g21_cfg(s.n) ->> 'destructionStep' = p_dest)
     and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(recipe.g21_cfg(s.n) -> 'items') = 'array' then recipe.g21_cfg(s.n) -> 'items' else '[]'::jsonb end) i
                  where i -> 'id' = e.value -> 'data' -> 'item' and i ->> 'material' = p_material and i ->> 'unit' = p_unit and (i -> 'coded') = 'true'::jsonb)
$$;

-- 3 (header): why a G-21 step (or the G-23 step one names for its coded surplus) that row p_new closes is not complete.
create function recipe.g21_close_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  k       text;
  s       jsonb;
  v_node  jsonb;
  v_cfg   jsonb;
  v_all   jsonb;
  v_now   numeric := recipe.micros_of(p_new -> 'lastRecordedUs');
  i       jsonb;
  d       jsonb;
  t       text;
  v_last  numeric;
  m       text;
  p       jsonb;
  n       jsonb;
  v_need  numeric;
  v_done  numeric;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(p_content, s ->> 'step');
    v_cfg := recipe.g21_cfg(v_node);
    v_all := recipe.g21_step_entries(p_new, k);
    if v_node -> 'block' ->> 'type' = 'G-21' then
      for i in select x from jsonb_array_elements(case when jsonb_typeof(v_cfg -> 'items') = 'array' then v_cfg -> 'items' else '[]'::jsonb end) x loop
        if not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'RECONCILIATION' and e -> 'data' -> 'item' = i -> 'id') then
          return format('closes step %s, but printed item %s is not reconciled: the reconciliation always runs (G21-NOT-RECONCILED; INV-32, IN-17)', k, i ->> 'id');
        end if;
      end loop;
      for d in select x from jsonb_array_elements(case when jsonb_typeof(v_cfg -> 'devices') = 'array' then v_cfg -> 'devices' else '[]'::jsonb end) x loop
        if d ->> 'kind' = 'PRINTER' then
          if not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'FIRST_PRINT' and e -> 'data' -> 'device' = d -> 'id' and (e -> 'data' -> 'approved') = 'true'::jsonb) then
            return format('closes step %s, but the first print of %s is not approved (G21-NO-FIRST-PRINT; PR-36)', k, d ->> 'id');
          end if;
          continue;
        end if;
        for t in select x from jsonb_array_elements_text(case when jsonb_typeof(d -> 'triggers') = 'array' then d -> 'triggers' else '["START", "END"]'::jsonb end) x
                  where x in ('START', 'END') loop
          if not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'CHALLENGE' and e -> 'data' -> 'device' = d -> 'id'
                                                                          and e -> 'data' ->> 'trigger' = t and e -> 'data' ->> 'result' = 'PASS') then
            return format('closes step %s, but %s has no passing %s challenge (G21-CHALLENGE-DUE; IN-22)', k, d ->> 'id', lower(t));
          end if;
        end loop;
        select max(recipe.micros_of(e -> 'recordedAt')) into v_last from jsonb_array_elements(v_all) e
         where e ->> 'kind' = 'CHALLENGE' and e -> 'data' -> 'device' = d -> 'id' and e -> 'data' ->> 'result' = 'PASS';
        if v_last is not null and recipe.duration_us(d -> 'every') is not null and v_now - v_last > recipe.duration_us(d -> 'every') then
          return format('closes step %s, but %s is due for a challenge (G21-CHALLENGE-DUE; IN-22)', k, d ->> 'id');
        end if;
      end loop;
      for m in select x from jsonb_array_elements_text(case when jsonb_typeof(v_cfg -> 'serialisation' -> 'markets') = 'array' then v_cfg -> 'serialisation' -> 'markets' else '[]'::jsonb end) x
                where (p_new -> 'header' -> 'marketSet') ? x loop
        if not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'SERIAL_POOL' and e -> 'data' ->> 'market' = m) then
          return format('closes step %s, but %s has no serial pool (G21-NO-POOL; PR-42)', k, m);
        end if;
      end loop;
      for p in select x from jsonb_array_elements(v_all) x where x ->> 'kind' = 'SERIAL_POOL' loop
        if coalesce((select (e -> 'data' -> 'closed') = 'true'::jsonb from jsonb_array_elements(v_all) with ordinality r (e, o)
                      where e ->> 'kind' = 'SERIAL_RECONCILIATION' and e -> 'data' -> 'poolId' = p -> 'data' -> 'poolId' order by o desc limit 1), false) is false then
          return format('closes step %s, but serial pool %s is not reconciled with zero unexplained: the packaging order does not complete without it (G21-SERIALS-OPEN; PR-42)',
                        k, p -> 'data' ->> 'poolId');
        end if;
      end loop;
    elsif v_node -> 'block' ->> 'type' = 'G-23' then
      for n in select x from recipe.g21_nodes(p_content, 'G-21') x where recipe.g21_cfg(x) ->> 'destructionStep' = s ->> 'step' loop
        if exists (select 1 from jsonb_each(p_new -> 'steps') g where g.value ->> 'step' = n ->> 'id'
                                                                 and g.value ->> 'status' not in ('AWAITING_VERIFICATION', 'COMPLETED')) then
          return format('closes destruction step %s before printed-materials step %s, whose coded surplus it destroys, is closed (G21-DESTRUCTION-EARLY; PR-40, IN-22)', k, n ->> 'id');
        end if;
        for i in select x from jsonb_array_elements(case when jsonb_typeof(recipe.g21_cfg(n) -> 'items') = 'array' then recipe.g21_cfg(n) -> 'items' else '[]'::jsonb end) x
                  where (x -> 'coded') = 'true'::jsonb loop
          v_need := recipe.g21_counted(p_content, p_new, i ->> 'material', i ->> 'unit', 'codedDestroyed', s ->> 'step');
          select coalesce(sum(recipe.g21_dec(e -> 'data' -> 'quantity' -> 'value')), 0) into v_done from jsonb_array_elements(v_all) e
           where e ->> 'kind' = 'DISPOSAL' and e -> 'data' ->> 'category' = 'DESTRUCTION' and (e -> 'data' -> 'batchCoded') = 'true'::jsonb
             and e -> 'data' ->> 'material' = i ->> 'material' and e -> 'data' -> 'quantity' ->> 'unit' = i ->> 'unit';
          if v_need <> v_done then
            return format('closes destruction step %s destroying %s %s of coded %s, where the reconciliations count %s coded and destroyed (G21-NOT-DESTROYED; PR-40, IN-22)',
                          k, v_done, i ->> 'unit', i ->> 'material', v_need);
          end if;
        end loop;
      end loop;
    end if;
  end loop;
  return null;
end
$$;

-- 4 (header): why row p_new skips a G-21 step or the G-23 step one names for its coded surplus.
create function recipe.g21_skip_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select format('skips step %s of block %s: printed materials are always reconciled and coded surplus always destroyed (INV-32, IN-17, PR-40)', x.key, n -> 'block' ->> 'type')
    from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
    cross join lateral (select recipe.step_node(p_content, x.value ->> 'step') n) s
   where x.value ->> 'status' = 'SKIPPED' and (p_old -> 'steps' -> x.key ->> 'status') is distinct from 'SKIPPED'
     and (n -> 'block' ->> 'type' = 'G-21'
          or (n -> 'block' ->> 'type' = 'G-23' and exists (select 1 from recipe.g21_nodes(p_content, 'G-21') g where recipe.g21_cfg(g) ->> 'destructionStep' = n ->> 'id')))
   order by x.key limit 1
$$;

-- 5 (header): why a new G-23 return to stores of row p_new returns coded material of a G-21 step.
create function recipe.g21_return_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0      jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e       jsonb;
  i       jsonb;
  v_back  numeric;
  v_ok    numeric;
begin
  for e in select x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
            where not (e0 ? x.key) and x.value ->> 'kind' = 'DISPOSAL' and x.value -> 'data' ->> 'category' = 'RETURN_TO_STORES' order by x.key loop
    for i in select x from recipe.g21_nodes(p_content, 'G-21') n,
                    jsonb_array_elements(case when jsonb_typeof(recipe.g21_cfg(n) -> 'items') = 'array' then recipe.g21_cfg(n) -> 'items' else '[]'::jsonb end) x
              where (x -> 'coded') = 'true'::jsonb and x ->> 'material' = e -> 'data' ->> 'material' loop
      if e -> 'data' -> 'quantity' ->> 'unit' is distinct from i ->> 'unit' then
        return format('returns %s to stores in %s; it is counted in %s, so the return cannot be held to its uncoded quantity (G21-CODED-RETURN; PR-40)',
                      i ->> 'material', coalesce(e -> 'data' -> 'quantity' ->> 'unit', '(none)'), i ->> 'unit');
      end if;
      select coalesce(sum(recipe.g21_dec(x.value -> 'data' -> 'quantity' -> 'value')), 0) into v_back
        from jsonb_each(p_new -> 'entries') x
       where x.value ->> 'kind' = 'DISPOSAL' and x.value -> 'data' ->> 'category' = 'RETURN_TO_STORES' and x.value -> 'data' ->> 'material' = i ->> 'material'
         and x.value -> 'data' -> 'quantity' ->> 'unit' = i ->> 'unit';
      v_ok := recipe.g21_counted(p_content, p_new, i ->> 'material', i ->> 'unit', 'uncodedReturned', null);
      if v_back > v_ok then
        return format('returns %s %s of %s to stores, where the reconciliations count only %s uncoded returned: coded surplus is destroyed, never returned (G21-CODED-RETURN; PR-40)',
                      v_back, i ->> 'unit', i ->> 'material', v_ok);
      end if;
      exit;
    end loop;
  end loop;
  return null;
end
$$;

-- The checks an accepted row records for the line's plant unit (header).
create function recipe.g21_record(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  e0     jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k      text;
  e      jsonb;
  v_unit text;
  v_ref  text;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) and x.value ->> 'kind' in ('FIRST_PRINT', 'CHALLENGE') order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_unit := recipe.g21_cfg(recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step')) ->> 'unit';
    continue when v_unit is null
               or recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step') -> 'block' ->> 'type' is distinct from 'G-21';
    v_ref := format('G21:%s:%s:%s', e ->> 'stepKey', k, e -> 'data' ->> 'device');
    if e ->> 'kind' = 'FIRST_PRINT' then
      if (e -> 'data' -> 'approved') = 'true'::jsonb then
        perform plant.record_ipc_check(p_batch, v_unit, null, 'PASS', v_ref);
      end if;
      continue;
    end if;
    if (e -> 'data' -> 'missed') = 'true'::jsonb then
      perform plant.record_ipc_check(p_batch, v_unit, null, 'MISSED', v_ref || ':MISSED');
    end if;
    perform plant.record_ipc_check(p_batch, v_unit, null, case when e -> 'data' ->> 'result' = 'PASS' then 'PASS' else 'FAIL' end, v_ref);
  end loop;
end
$$;

-- The row trigger (header).
create function recipe.g21_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from recipe.g21_nodes(v_content, 'G-21')) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := recipe.g21_mbr_problem(v_content);
  v_code := 'EBMR-EXE-290';
  if v_problem is null then
    v_problem := recipe.g21_exception_problem(v_content, old.state, new.state);
    v_code := 'EBMR-EXE-291';
  end if;
  if v_problem is null then
    v_problem := recipe.g21_close_problem(v_content, old.state, new.state);
    v_code := 'EBMR-EXE-292';
  end if;
  if v_problem is null then
    v_problem := recipe.g21_skip_problem(v_content, old.state, new.state);
    v_code := 'EBMR-EXE-293';
  end if;
  if v_problem is null then
    v_problem := recipe.g21_return_problem(v_content, old.state, new.state);
    v_code := 'EBMR-EXE-294';
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: printed materials are reconciled always and within limits, challenges hold the output, serials close with zero unexplained and coded surplus is destroyed (INV-32, IN-17, IN-22, PR-37, PR-39, PR-40, PR-42). [%s]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem, v_code);
  end if;
  perform recipe.g21_record(new.batch_id, v_content, old.state, new.state);
  return null;
end
$$;

create trigger zr_g21 after update on recipe.execution_state
  for each row execute function recipe.g21_state_check();

revoke all on function recipe.g21_cfg(jsonb), recipe.g21_nodes(jsonb, text), recipe.g21_step_entries(jsonb, text),
  recipe.g21_raised(jsonb, jsonb, text, text, text, boolean, boolean, boolean), recipe.g21_mbr_problem(jsonb),
  recipe.g21_exception_problem(jsonb, jsonb, jsonb), recipe.g21_counted(jsonb, jsonb, text, text, text, text),
  recipe.g21_close_problem(jsonb, jsonb, jsonb), recipe.g21_skip_problem(jsonb, jsonb, jsonb), recipe.g21_return_problem(jsonb, jsonb, jsonb),
  recipe.g21_record(uuid, jsonb, jsonb, jsonb), recipe.g21_state_check() from public;

reset role;
