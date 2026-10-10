-- Tablets server, Phase 3 slice 4b (builder B): the rules of the packaging-line blocks TB-23 (bottle line) and TB-24
-- (secondary and tertiary packaging, finished-pack examination) held by the database, and their holds on the slice 1
-- output containers (tablets spec B.2 TB-23, TB-24; controls PR-37, PR-38, PR-41, PR-42, IN-17, IN-22, INV-32, DI-31; ADR
-- 0012: the rules hold when the application's own database credentials are used directly).
--
-- A row trigger on recipe.execution_state (zzi_tab_packline, after update; every row of a batch whose MBR has a TB-23 or a
-- TB-24 step) refuses a row unless:
--   0. the MBR is one the blocks accept (EBMR-TAB-380): each TB-23 names a G-21 step that issues and reconciles its roll
--      label item (that step always reconciles and is never skipped: IN-17, INV-32), each TB-24 names a G-21 step for its
--      cartons; the plant units of the G-21, TB-23 and TB-24 steps are all different (a passing check of one never
--      vouches for another's output); an EU pack's TB-24 checks the anti-tampering device, and an MBR for US OTC retail
--      packs (header predicate usOtcRetail) checks the tamper-evident feature at a TB-23 seal check or a TB-24 ATD check
--      (PR-41);
--   1. every new entry of a TB-23 or TB-24 step holds exactly what its block builds (0986, the twins of tb-23.ts and
--      tb-24.ts; a CHALLENGE through G-21@1's own recipe.g21_entry_data) from what was entered, the MBR's product, the
--      batch number and markets, the step's earlier entries, the person and the row's database time, and only what the
--      block accepts (EBMR-TAB-380); with it the exceptions its block raises in the same row (LINE_CHECK_FAILED and
--      LINE_CHECK_MISSED holding the steps after it until a deviation is linked; CHALLENGE_FAILED, CHALLENGE_MISSED and
--      UNUSUAL_EVENT waiting for QA's disposition before the step completes; PACK_RECONCILIATION blocking release) and the
--      second person a manual challenge and a re-entry need; and:
--        * a torque check is made on a tester with an instrument use for this batch open now (TB23-TESTER: calibrated, its
--          per-use check passed);
--        * a shipper names an SSCC the register issued for this batch and step (tab.issue_sscc) that no other entry names
--          (TB24-SSCC-ISSUE; PR-42);
--        * packs of an unusual event re-enter only once the event's UNUSUAL_EVENT exception carries the deviation the
--          entry names as its investigation and QA's disposition (TB24-NOT-APPROVED; PR-37, IN-22 (e));
--   2. a TB-23 or TB-24 step closes (IN_PROGRESS to AWAITING_VERIFICATION or COMPLETED) only complete (EBMR-TAB-381):
--      each scheduled stream checked with its last check passing and none due at the close; each device's START and END
--      challenge passing and none due; TB-23 with its good output and no bright stock left; TB-24 with an in-run and a
--      passing end-of-run examination (211.134), its reconciliation, and, where its G-21 step serialises a market of the
--      batch, the packs in its shippers equal to the serials commissioned in that step's pools (TB24-AGGREGATION; PR-42);
-- and then records, for every new check and challenge, the container hold through the slice 1 container command
-- (plant.record_ipc_check, never a copy) on the step's unit: the check's stream (COUNT, DESICCANT, TORQUE, SEAL; ATD,
-- EXAM) or the device's challenge stream D.<device>; MISSED first, then PASS or FAIL.
--
-- A second trigger (aa_tab_packline_pass, before insert on plant.ipc_check) refuses a PASS for the unit of a TB-23 or TB-24
-- step of the batch that is not the record of a passing check or challenge entry of that step, for its stream, once
-- (EBMR-TAB-382): a container is vouched for only by a recorded passing result.
--
-- New functions are owned by ebmr_owner; the trigger functions and the hold writer are SECURITY DEFINER; every function
-- pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- The TB-23 and TB-24 phase nodes of MBR p_content.
create function tab.packline_nodes(p_content jsonb) returns setof jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
   where p -> 'block' ->> 'type' in ('TB-23', 'TB-24')
$$;

-- The G-21 phase node p_id of MBR p_content, or NULL.
create function tab.packline_g21(p_content jsonb, p_id text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
   where p -> 'block' ->> 'type' = 'G-21' and p ->> 'id' = p_id limit 1
$$;

-- 0 (header): why MBR p_content is not one the packaging-line blocks accept; NULL when it is.
create function tab.packline_mbr_problem(p_content jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  n      jsonb;
  g      jsonb;
  v_unit text;
begin
  for n in select x from tab.packline_nodes(p_content) x loop
    if n -> 'block' ->> 'type' = 'TB-23' then
      g := tab.packline_g21(p_content, n -> 'config' ->> 'labelStep');
      if g is null or not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(g -> 'config' -> 'items') = 'array' then g -> 'config' -> 'items' else '[]'::jsonb end) i
                                   where i -> 'id' = n -> 'config' -> 'labelItem') then
        return format('bottle line step %s names no G-21 step that issues and reconciles its roll labels (TB23-LABEL-STEP; IN-17, INV-32)', n ->> 'id');
      end if;
    else
      if tab.packline_g21(p_content, n -> 'config' ->> 'printedStep') is null then
        return format('secondary packaging step %s names no G-21 step for its cartons (TB24-PRINTED-STEP; IN-17, PR-42)', n ->> 'id');
      end if;
      if (p_content -> 'header' -> 'marketSet') ? 'EU' and jsonb_typeof(n -> 'config' -> 'atd') is distinct from 'object' then
        return format('secondary packaging step %s packs for the EU and checks no anti-tampering device (TB24-ATD-REQUIRED; PR-42)', n ->> 'id');
      end if;
    end if;
  end loop;
  select u into v_unit from (
    select p -> 'config' ->> 'unit' u from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
     where p -> 'block' ->> 'type' in ('G-21', 'TB-23', 'TB-24') and jsonb_typeof(p -> 'config' -> 'unit') = 'string') x
   group by u having count(*) > 1 limit 1;
  if v_unit is not null and exists (select 1 from tab.packline_nodes(p_content)) then
    return format('two packaging steps name the plant unit %s: a passing check of one would vouch for the other''s output (TB23-UNIT; IN-22, PR-37)', v_unit);
  end if;
  if (p_content -> 'header' -> 'predicates' -> 'usOtcRetail') = 'true'::jsonb
     and not exists (select 1 from tab.packline_nodes(p_content) x
                      where (x -> 'block' ->> 'type' = 'TB-23' and (x -> 'config' -> 'tamperEvident') = 'true'::jsonb)
                         or (x -> 'block' ->> 'type' = 'TB-24' and jsonb_typeof(x -> 'config' -> 'atd') = 'object')) then
    return 'the MBR is for US OTC retail packs and no packaging step checks the tamper-evident feature (TB23-TAMPER-EVIDENT; PR-41)';
  end if;
  return null;
end
$$;

-- Whether row p_new raised (newly against p_old) exception p_type at step instance p_key for item p_item as mode p_mode
-- says (0986 header; QA with a deviation required as p_deviation says).
create function tab.packline_raised(p_old jsonb, p_new jsonb, p_key text, p_type text, p_item text, p_mode text, p_deviation boolean) returns boolean
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case p_mode
    when 'QA' then recipe.g21_raised(p_old, p_new, p_key, p_type, p_item, coalesce(p_deviation, false), false, true)
    else exists (
      select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
       where not coalesce((p_old -> 'exceptions') ? x.key, false) and x.value ->> 'type' = p_type and x.value -> 'source' ->> 'stepKey' = p_key
         and x.value -> 'source' ->> 'item' = p_item and x.value ->> 'severity' = 'ACTION' and (x.value -> 'deviationRequired') = 'true'::jsonb
         and x.value -> 'block' ->> 'until' = 'DEVIATION' and jsonb_typeof(x.value -> 'block' -> 'downstream') = 'object'
         and coalesce((x.value -> 'releaseBlocking') = 'true'::jsonb, false) = (p_mode = 'RELEASE'))
  end
$$;

-- 1 (header): why a new entry of a TB-23 or TB-24 step in row p_new is not what its block builds or accepts; NULL when
-- every one is.
create function tab.packline_entry_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb, r recipe.execution_command) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  k         text;
  e         jsonb;
  d         jsonb;
  c         jsonb;
  x         jsonb;
  v_kind    text;
  v_key     text;
  v_type    text;
  v_node    jsonb;
  v_cfg     jsonb;
  v_prior   jsonb;
  v_res     jsonb;
  v_want    jsonb;
  v_member  text;
  v_what    text;
begin
  for k, e in select y.key, y.value from jsonb_each(e1) y where not (e0 ? y.key) order by (y.value ->> 'recordedSeq')::numeric, y.key loop
    v_kind := e ->> 'kind';
    v_key := e ->> 'stepKey';
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> v_key ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    continue when v_type is null or v_type not in ('TB-23', 'TB-24');
    v_what := format('entry %s (%s) of step %s', k, coalesce(v_kind, 'unnamed'), v_key);
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    c := case when jsonb_typeof(r.command -> 'entry') = 'object' then r.command -> 'entry' else '{}'::jsonb end;
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    v_prior := tab.gran_prior(p_new, v_key, (e ->> 'recordedSeq')::numeric, null);
    v_res := case when v_type = 'TB-23'
                  then tab.bottle_entry(v_kind, v_cfg, v_prior, c, p_content -> 'header' -> 'product', p_new -> 'header' ->> 'batchNumber', p_new -> 'header' -> 'marketSet', recipe.micros_of(e -> 'recordedAt'), e -> 'enteredBy')
                  else tab.pack_entry(v_kind, v_cfg, v_prior, c, p_content -> 'header' -> 'product', p_new -> 'header' ->> 'batchNumber', p_new -> 'header' -> 'marketSet', recipe.micros_of(e -> 'recordedAt'), e -> 'enteredBy') end;
    if v_res ? 'problem' then
      return format('stores %s, which its block refuses: %s', v_what, v_res ->> 'problem');
    end if;
    v_want := v_res -> 'data';
    if d is distinct from v_want then
      select m into v_member from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u where (d -> m) is distinct from (v_want -> m) order by m limit 1;
      return format('stores %s with %s %s, where its block writes %s', v_what, v_member, left(coalesce((d -> v_member)::text, '(no such member)'), 300),
                    left(coalesce((v_want -> v_member)::text, '(no such member)'), 300));
    end if;
    for x in select jsonb_array_elements(coalesce(v_res -> 'raise', '[]'::jsonb)) loop
      if not tab.packline_raised(p_old, p_new, v_key, x ->> 'type', x ->> 'item', x ->> 'mode', (x -> 'deviation') = 'true'::jsonb) then
        return format('stores %s without the %s exception its block raises with it (%s)', v_what, x ->> 'type',
                      case x ->> 'mode' when 'QA' then 'the step waits for QA''s disposition' when 'RELEASE' then 'an investigation, release blocked' else 'the steps after it wait for a deviation' end);
      end if;
    end loop;
    if (v_res -> 'verify') = 'true'::jsonb and (p_new -> 'steps' -> v_key -> 'verificationRequired') is distinct from 'true'::jsonb then
      return format('stores %s, which needs a second person''s check of its step, and the step does not require it (PR-14)', v_what);
    end if;
    if v_kind = 'TORQUE_CHECK'
       and not exists (select 1 from plant.instrument_use u join plant.equipment q on q.id = u.equipment_id
                        where q.code = d ->> 'tester' and u.batch_id = p_batch and u.planned_end > clock_timestamp()) then
      return format('stores %s on tester %s, which has no instrument use for this batch open now: a torque tester is used only calibrated with its check passed (TB23-TESTER; PR-37)',
                    v_what, left(coalesce(d ->> 'tester', '(none)'), 64));
    end if;
    if v_kind = 'SHIPPER'
       and (not exists (select 1 from tab.sscc_issue s where s.sscc = d ->> 'sscc' and s.batch_id = p_batch and s.step_key = v_key)
            or exists (select 1 from jsonb_each(e0) o where o.value ->> 'kind' = 'SHIPPER' and o.value -> 'data' -> 'sscc' = d -> 'sscc')) then
      return format('stores %s with an SSCC the register did not issue for this batch and step, or one another shipper carries (TB24-SSCC-ISSUE; PR-42)', v_what);
    end if;
    if v_kind = 'RE_ENTRY'
       and not exists (select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) y
                        where y.value ->> 'type' = 'UNUSUAL_EVENT' and y.value -> 'source' ->> 'stepKey' = v_key and y.value -> 'source' -> 'item' = d -> 'event'
                          and y.value ->> 'status' = 'DISPOSITIONED' and y.value -> 'deviation' ->> 'ref' = d ->> 'investigation') then
      return format('stores %s before QA''s disposition of the unusual event with the investigation it names: units of an unusual event re-enter only after inspection, investigation and authorised approval (TB24-NOT-APPROVED; PR-37, IN-22)', v_what);
    end if;
  end loop;
  return null;
end
$$;

-- 2 (header): why a TB-23 or TB-24 step that row p_new closes is not complete; NULL when every one is.
create function tab.packline_close_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k       text;
  s       jsonb;
  v_node  jsonb;
  v_type  text;
  v_cfg   jsonb;
  v_all   jsonb;
  v_now   numeric;
  v_last  jsonb;
  v_dev   jsonb;
  v_every numeric;
  v_t     text;
  v_text  text;
  v_g21   jsonb;
  v_pools numeric;
  v_ship  numeric;
  v_s     record;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(p_content, s ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    continue when v_type is null or v_type not in ('TB-23', 'TB-24');
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_all := tab.gran_prior(p_new, k, 'Infinity'::numeric, null);
    v_now := coalesce(recipe.micros_of(s -> 'endedAt'), recipe.micros_of(s -> 'completedAt'));
    v_text := null;
    -- The scheduled streams.
    for v_s in select * from (values ('COUNT', recipe.duration_us(v_cfg -> 'checkEvery'), v_type = 'TB-23'),
                                     ('DESICCANT', recipe.duration_us(v_cfg -> 'checkEvery'), v_type = 'TB-23' and jsonb_typeof(v_cfg -> 'desiccant') = 'object'),
                                     ('TORQUE', recipe.duration_us(v_cfg -> 'checkEvery'), v_type = 'TB-23'),
                                     ('SEAL', recipe.duration_us(v_cfg -> 'checkEvery'), v_type = 'TB-23'),
                                     ('ATD', recipe.duration_us(v_cfg -> 'atd' -> 'every'), v_type = 'TB-24' and jsonb_typeof(v_cfg -> 'atd') = 'object')) t (stream, every, wanted)
                   where wanted loop
      v_last := tab.packline_last_check(v_all, v_s.stream);
      v_text := case when v_last is null then format('its %s stream has no check (%s-NO-CHECK)', v_s.stream, replace(v_type, '-', ''))
                     when v_last -> 'data' ->> 'result' <> 'PASS' then format('the last check of its %s stream failed (%s-LAST-CHECK)', v_s.stream, replace(v_type, '-', ''))
                     when v_s.every is not null and v_now - recipe.micros_of(v_last -> 'recordedAt') > v_s.every then format('its %s stream is due for a check (%s-CHECK-DUE)', v_s.stream, replace(v_type, '-', '')) end;
      exit when v_text is not null;
    end loop;
    -- The devices (G-21's rule: a passing START and END challenge, none due).
    if v_text is null then
      for v_dev in select jsonb_array_elements(case when jsonb_typeof(v_cfg -> 'devices') = 'array' then v_cfg -> 'devices' else '[]'::jsonb end) loop
        for v_t in select t from jsonb_array_elements_text(case when jsonb_typeof(v_dev -> 'triggers') = 'array' then v_dev -> 'triggers' else '["START", "END"]'::jsonb end) t where t in ('START', 'END') loop
          if not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'CHALLENGE' and x -> 'data' -> 'device' = v_dev -> 'id' and x -> 'data' ->> 'trigger' = v_t and x -> 'data' ->> 'result' = 'PASS') then
            v_text := format('device %s has no passing %s challenge (G21-CHALLENGE-DUE; IN-22)', v_dev ->> 'id', lower(v_t));
          end if;
        end loop;
        v_every := recipe.duration_us(v_dev -> 'every');
        if v_text is null and v_every is not null
           and v_now - (select max(recipe.g21_challenge_time(x)) from jsonb_array_elements(v_all) x
                         where x ->> 'kind' = 'CHALLENGE' and x -> 'data' -> 'device' = v_dev -> 'id' and x -> 'data' ->> 'result' = 'PASS') > v_every then
          v_text := format('device %s is due for a challenge (G21-CHALLENGE-DUE; IN-22)', v_dev ->> 'id');
        end if;
        exit when v_text is not null;
      end loop;
    end if;
    if v_text is null and v_type = 'TB-23' then
      v_text := case
        when not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'GOOD_OUTPUT') then 'it has no good output (TB23-NO-OUTPUT)'
        when exists (select 1 from jsonb_array_elements(v_all) b where b ->> 'kind' = 'BRIGHT_STOCK'
                      and tab.packline_sum(v_all, 'BRIGHT_STOCK', 'bottles', 'tag', b -> 'data' -> 'tag') > tab.packline_sum(v_all, 'BRIGHT_STOCK_USE', 'bottles', 'tag', b -> 'data' -> 'tag'))
          then 'bright stock is left unlabelled (TB23-BRIGHT-STOCK-OPEN; PR-38)' end;
    elsif v_text is null then
      v_text := case
        when not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'EXAMINATION' and x -> 'data' ->> 'timing' = 'IN_RUN')
          then 'its packs were not examined during finishing (TB24-NO-IN-RUN; PR-37)'
        when not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'EXAMINATION' and x -> 'data' ->> 'timing' = 'END')
          then 'it has no end-of-run examination (TB24-NO-END-EXAM; PR-37)'
        when exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'EXAMINATION' and x -> 'data' ->> 'timing' = 'END' and x -> 'data' ->> 'result' <> 'PASS')
          then 'its end-of-run examination failed (TB24-END-EXAM-FAILED; PR-37)'
        when not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'RECONCILIATION') then 'its packs are not reconciled (TB24-NOT-RECONCILED; PR-37)' end;
      -- PR-42: where the G-21 step serialises a market of the batch, the shippers aggregate exactly the serials it
      -- commissioned (the latest reconciliation of each of its pools).
      v_g21 := tab.packline_g21(p_content, v_cfg ->> 'printedStep');
      if v_text is null and exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(v_g21 -> 'config' -> 'serialisation' -> 'markets') = 'array' then v_g21 -> 'config' -> 'serialisation' -> 'markets' else '[]'::jsonb end) m
                                     where (p_new -> 'header' -> 'marketSet') ? m) then
        select coalesce(sum(tab.packline_n(z.x -> 'data' -> 'commissioned')), -1) into v_pools
          from (select distinct on (x -> 'data' ->> 'poolId') x from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) y (key, x)
                 where x ->> 'kind' = 'SERIAL_RECONCILIATION' and p_new -> 'steps' -> (x ->> 'stepKey') ->> 'step' = v_g21 ->> 'id'
                 order by x -> 'data' ->> 'poolId', (x ->> 'recordedSeq')::numeric desc) z;
        v_ship := tab.packline_sum(v_all, 'SHIPPER', 'packs', null, null);
        if v_pools is distinct from v_ship then
          v_text := format('its shippers hold %s packs, but the serial pools of %s commissioned %s (TB24-AGGREGATION; PR-42)', v_ship, v_g21 ->> 'id',
                           case when v_pools < 0 then 'none reconciled' else v_pools::text end);
        end if;
      end if;
    end if;
    if v_text is not null then
      return format('closes step %s, but %s', k, v_text);
    end if;
  end loop;
  return null;
end
$$;

-- The container holds of the new entries of row p_new (header): the check's stream or the device's challenge stream of
-- the step's unit; MISSED first, then PASS or FAIL.
create function tab.packline_apply_holds(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  d        jsonb;
  v_node   jsonb;
  v_unit   text;
  v_stream text;
  v_ref    text;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    continue when v_node -> 'block' ->> 'type' is null or v_node -> 'block' ->> 'type' not in ('TB-23', 'TB-24');
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    v_stream := case when e ->> 'kind' = 'CHALLENGE' then 'D.' || (d ->> 'device') else d ->> 'stream' end;
    v_unit := v_node -> 'config' ->> 'unit';
    continue when v_stream is null or v_unit is null or d ->> 'result' not in ('PASS', 'FAIL');
    v_ref := format('%s:%s:%s', replace(v_node -> 'block' ->> 'type', '-', ''), e ->> 'stepKey', k);
    if (d -> 'missed') = 'true'::jsonb then
      perform plant.record_ipc_check(p_batch, v_unit, v_stream, 'MISSED', v_ref || ':MISSED');
    end if;
    perform plant.record_ipc_check(p_batch, v_unit, v_stream, d ->> 'result', v_ref);
  end loop;
end
$$;

-- The row trigger (header).
create function tab.packline_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from tab.packline_nodes(v_content)) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := tab.packline_mbr_problem(v_content);
  v_code := 'EBMR-TAB-380';
  if v_problem is null then
    v_problem := tab.packline_entry_problem(new.batch_id, v_content, old.state, new.state, r);
  end if;
  if v_problem is null then
    v_problem := tab.packline_close_problem(v_content, old.state, new.state);
    v_code := 'EBMR-TAB-381';
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a bottle line or secondary packaging step records what its block builds, holds the output of a failed check, examines the finished packs and closes only complete (PR-37, PR-38, PR-41, PR-42, IN-17, IN-22). [%s]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem, v_code);
  end if;
  perform tab.packline_apply_holds(new.batch_id, v_content, old.state, new.state);
  return null;
end
$$;

create trigger zzi_tab_packline after update on recipe.execution_state
  for each row execute function tab.packline_state_check();

-- PR-37, IN-22: a PASS for the unit of a TB-23 or TB-24 step of the batch is the record of a passing check or challenge
-- entry of that step for its stream, once (header).
create function tab.packline_pass_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  v_content jsonb;
  v_state   jsonb;
  v_m       text[];
  e         jsonb;
  v_node    jsonb;
  v_stream  text;
begin
  if new.result is distinct from 'PASS' then
    return new;
  end if;
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from tab.packline_nodes(v_content) x where x -> 'config' ->> 'unit' = new.press_code) then
    return new;
  end if;
  v_m := regexp_match(new.reference, '^(TB23|TB24):(.+):(EN-[1-9][0-9]{0,8})$');
  select s.state into v_state from recipe.execution_state s where s.batch_id = new.batch_id;
  e := v_state -> 'entries' -> v_m[3];
  v_node := recipe.step_node(v_content, v_state -> 'steps' -> v_m[2] ->> 'step');
  v_stream := case when e ->> 'kind' = 'CHALLENGE' then 'D.' || (e -> 'data' ->> 'device') else e -> 'data' ->> 'stream' end;
  if v_m is null or e is null or e ->> 'stepKey' is distinct from v_m[2] or v_node -> 'block' ->> 'type' is distinct from 'TB-' || substr(v_m[1], 3)
     or v_node -> 'config' ->> 'unit' is distinct from new.press_code or e -> 'data' ->> 'result' is distinct from 'PASS'
     or new.stream is distinct from v_stream
     or exists (select 1 from plant.ipc_check k where k.batch_id = new.batch_id and k.reference = new.reference) then
    raise exception using errcode = 'P0001',
      message = 'A passing check of the unit of a bottle line or secondary packaging step is recorded only from a passing check or challenge entry of that step, for its stream, once: packs are vouched for only by a recorded passing result (PR-37, IN-22). [EBMR-TAB-382]';
  end if;
  return new;
end
$$;

create trigger aa_tab_packline_pass before insert on plant.ipc_check
  for each row execute function tab.packline_pass_check();

revoke all on function tab.packline_nodes(jsonb), tab.packline_g21(jsonb, text), tab.packline_mbr_problem(jsonb), tab.packline_raised(jsonb, jsonb, text, text, text, text, boolean),
  tab.packline_entry_problem(uuid, jsonb, jsonb, jsonb, recipe.execution_command), tab.packline_close_problem(jsonb, jsonb, jsonb), tab.packline_apply_holds(uuid, jsonb, jsonb, jsonb),
  tab.packline_state_check(), tab.packline_pass_check() from public;

reset role;
