-- Tablets server, Phase 3 slice 3d (builder A): the rules of the coating and finishing blocks TB-18, TB-19 and TB-20 held
-- by the database (tablets spec B.2 TB-18 to TB-20, K-16, K-22, K-23, C-16; controls IN-37, PR-08, PR-29, PR-45, PR-46,
-- PR-47, PR-50, IN-35 (f), DI-10, DI-29, DI-34, INV-25, INV-41; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
-- recipe.entry_block_problem (recipe-core 0520) checks the generic kinds (TB-18's G-06 entries included: their data
-- there, their claimed reading of the step's coater in tablets 0820 through tab.process_block_type); recipe-core 0332 holds
-- each entry to its block's data schema (tablets 0910). This migration adds a row trigger on recipe.execution_state
-- (zt_tab_coating, after update; every row) that refuses a row unless:
--
--   1. every new entry of a TB-18, TB-19 or TB-20 step holds exactly what its block builds (src/blocks/tb-18.ts to
--      tb-20.ts) from what was entered, the batch's MBR and state, the person and the row's database time, with the
--      exception the block raises in the same row as the engine raises it (EBMR-EXE-270). In particular:
--        TB-18  cores: the room judged against the MBR's limits with filtered pan air, the load against its range, the core
--               sample of the MBR's count with its total and mean (tab.coat_sample); coating: spraying after the core mean
--               exists, the spraying time measured and every collected tag logged at the interval or PARAMETER_LOG_GAP;
--               a suspension use only of a coating suspension (film coat, enteric, sugar syrup) prepared at a TB-03 step of
--               this batch, refused once its use-by has passed at the row's database time (TB18-SUSPENSION-EXPIRED,
--               IN-37) or when what was sprayed, added and discarded would exceed what was prepared; the weight-gain check
--               after spraying, once per iteration, against the core mean the batch recorded (the core item's valid
--               point), the gain computed by the database (tab.coat_gain) and its maximum judged exactly; a TB-03 discard
--               counting what coating sprayed too;
--        TB-19  the printer a PROCESS unit of the plant (TB19-PRINTER), edible ink, the segregation record with
--               simultaneous printing; a check of the MBR's sample after the set-up with the result the database computes
--               and the MBR's content;
--        TB-20  the sort after the inspection, reconciled exactly, reject containers of this batch (TB20-CONTAINER-BATCH)
--               named by no other sort; the AQL result after the sort, once (INV-41), at the severity the switching rule
--               gives for the product (tab.aql_severity: TB20-SEVERITY) and evaluated from the scheme's tables;
--   2. a value of an item TB-18 computes (the core mean, the weight gain) is the block's own, from the entry it comes
--      from, never typed (INV-25; it is then judged against the item's limit tiers, at the loop's exit for the end point:
--      PR-08) (EBMR-EXE-271);
--   3. a step closes (IN_PROGRESS to AWAITING_VERIFICATION or COMPLETED) only complete: TB-18 cores with the room, load
--      and sample, a coating iteration sprayed, its suspension, its check (and its application for sugar coating); TB-19
--      set up with a last check that passed; TB-20 sorted, reconciled and AQL-judged; the witnessed G-23 step a TB-20
--      step names for its rejects only when every container for destruction of the batch's sorts is destroyed there,
--      quantity for quantity (TB20-NOT-DESTROYED; PR-46, IN-35 (f)) (EBMR-EXE-272);
--   4. a TB-18 coating step instance never runs beyond the maximum iterations of the loop it sits in (and never beyond
--      20, the block's bound): continued coating is bounded, never rework (DI-34) (EBMR-EXE-273);
--   5. the batch's MBR places, after every printing step, a QA hold point of the step's gate role that can reject (the QC
--      approval of printed tablets, IN-37, Sched M VIII 6.2), and every inspection step names a witnessed G-23 step for
--      its rejects (EBMR-EXE-274).
-- With an accepted row the trigger then records (the slice 1 container commands, never a copy): for a print check, PASS
-- or FAIL of the printer through plant.record_ipc_check (a FAIL holds every printed container since the printer's last
-- passing check, PR-29); for an AQL result, the lot's original inspection result in tab.aql_lot_result.
--
-- Containers (EBMR-TAB-310): a container opened on the printer of a printing step cannot be charged, packed or merged
-- until the QC hold point after that step is released (IN-37 catalogue test); a reject container named by a sort is never
-- charged, packed or merged (reusable residue only through a recovery step, which does not exist yet; PR-46, PR-47).
-- A PASS check of a printer of the batch's printing steps is the record of a passing print check of that printer, once
-- (trigger aa_tab_coat_pass on plant.ipc_check, beside tablets 0893's for TB-11, EBMR-TAB-311).
-- recipe.granulation_block_item (CREATE OR REPLACE from tablets 0852, the latest): TB-18's computed items beside TB-04's
-- and TB-07's, so the weighing rule of recipe-core 0322 leaves them to item 2; nothing else of it changes.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- Whether row p_new raised (newly against p_old) an exception of type p_type at step instance p_key, of severity
-- p_severity, with a deviation required, blocking the steps after it until p_until (and QA only when until DISPOSITION).
create function tab.coat_raised(p_old jsonb, p_new jsonb, p_key text, p_type text, p_severity text, p_until text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
     where not coalesce((p_old -> 'exceptions') ? x.key, false) and x.value ->> 'type' = p_type and x.value -> 'source' ->> 'stepKey' = p_key
       and x.value ->> 'severity' = p_severity and (x.value -> 'deviationRequired') = 'true'::jsonb
       and x.value -> 'block' ->> 'until' = p_until and jsonb_typeof(x.value -> 'block' -> 'downstream') = 'object'
       and (p_until <> 'DISPOSITION' or (x.value -> 'qaOnly') = 'true'::jsonb))
$$;

-- The configuration of a phase node.
create function tab.coat_cfg(p_node jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p_node -> 'config') = 'object' then p_node -> 'config' else '{}'::jsonb end
$$;

-- The valid recorded value of item p_item the batch holds (the latest valid VALUE point), or NULL.
create function tab.coat_point(p_state jsonb, p_item text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select x.value from jsonb_each(case when jsonb_typeof(p_state -> 'points') = 'object' then p_state -> 'points' else '{}'::jsonb end) x
   where x.value ->> 'item' = p_item and x.value ->> 'status' = 'VALID' and x.value ->> 'kind' = 'VALUE'
   order by (substring(x.key from '[0-9]+$'))::numeric desc limit 1
$$;

-- The collected tags of a coating step (p_cfg) whose usable values (entries p_prior) leave a gap longer than the log
-- interval between p_from and p_to (tb-18.ts logGaps), in the MBR's order.
create function tab.coat_log_gaps(p_cfg jsonb, p_prior jsonb, p_from numeric, p_to numeric) returns jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_agg(a.v ->> 'tag' order by a.i), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'actuals') = 'array' then p_cfg -> 'actuals' else '[]'::jsonb end) with ordinality a (v, i)
   where exists (
     select 1 from (
       select t, lag(t) over (order by t, o) as prev
         from (select p_from as t, 0 as o
               union all
               select recipe.micros_of(e -> 'recordedAt'), 1 from jsonb_array_elements(p_prior) e
                where e ->> 'kind' = 'ACTUAL' and e -> 'data' ->> 'tag' = a.v ->> 'tag' and (e -> 'data' -> 'usable') = 'true'::jsonb
                  and recipe.micros_of(e -> 'recordedAt') between p_from and p_to
               union all
               select p_to, 2) z) g
      where g.prev is not null and g.t - g.prev > coalesce(recipe.duration_us(p_cfg -> 'logInterval'), 900000000))
$$;

-- The quantity of preparation p_prep (a TB-03 PREPARED entry id) used so far in state p_state, besides entry p_except:
-- the TB-18 sprays, the TB-04 binder additions and the TB-03 discards of its step, in unit p_unit (NULL when a unit
-- differs).
create function tab.coat_used(p_content jsonb, p_state jsonb, p_prep jsonb, p_except text, p_unit text) returns numeric
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select tab.gran_sum((select coalesce(jsonb_agg(b), '[]'::jsonb)
                         from (select b from jsonb_array_elements(tab.gran_batch_entries(p_content, p_state, 'SUSPENSION_USED', 'TB-18')) b
                                where b -> 'data' ->> 'preparation' = p_prep ->> 'id'
                               union all
                               select b from jsonb_array_elements(tab.gran_batch_entries(p_content, p_state, 'BINDER_ADDITION', 'TB-04')) b
                                where b -> 'data' ->> 'preparation' = p_prep ->> 'id'
                               union all
                               select b from jsonb_array_elements(tab.gran_batch_entries(p_content, p_state, 'DISCARD', 'TB-03')) b
                                where b ->> 'stepKey' = p_prep ->> 'stepKey') u (b)
                        where b ->> 'id' is distinct from p_except), 'quantity', p_unit)
$$;

-- The rejects of every TB-20 sort result of state p_state: [{container, category, mass, step}].
create function tab.coat_rejects(p_content jsonb, p_state jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(jsonb_agg(r || jsonb_build_object('entry', s ->> 'id', 'stepKey', s ->> 'stepKey', 'step', p_state -> 'steps' -> (s ->> 'stepKey') ->> 'step')), '[]'::jsonb)
    from jsonb_array_elements(tab.gran_batch_entries(p_content, p_state, 'SORT_RESULT', 'TB-20')) s,
         jsonb_array_elements(case when jsonb_typeof(s -> 'data' -> 'rejects') = 'array' then s -> 'data' -> 'rejects' else '[]'::jsonb end) r
$$;

-- IN-37, PR-29, PR-46, IN-35, DI-10, DI-29, INV-41: why a new entry of a coating step in row p_new (after p_old, command
-- p_command, MBR p_content, batch p_batch) is not what its block builds or accepts (header, item 1); NULL when every one is.
create function tab.coating_entry_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  k         text;
  e         jsonb;
  d         jsonb;
  c         jsonb;
  v_kind    text;
  v_key     text;
  v_node    jsonb;
  v_type    text;
  v_cfg     jsonb;
  v_by      jsonb;
  v_now     numeric;
  v_seq     numeric;
  v_what    text;
  v_want    jsonb;
  v_verify  boolean;
  v_raise   text;
  v_sev     text;
  v_until   text;
  v_member  text;
  v_x       jsonb;
  v_y       jsonb;
  v_n       numeric;
  v_m       numeric;
  v_ok      boolean;
  v_text    text;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_kind := e ->> 'kind';
    v_key := e ->> 'stepKey';
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> v_key ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-03', 'TB-18', 'TB-19', 'TB-20')
       or v_kind in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'START_DATA') then
      continue;
    end if;
    v_what := format('entry %s (%s) of step %s', k, coalesce(v_kind, 'unnamed'), coalesce(v_key, '(none)'));
    v_cfg := tab.coat_cfg(v_node);
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    c := case when jsonb_typeof(p_command -> 'entry') = 'object' then p_command -> 'entry' else '{}'::jsonb end;
    v_by := e -> 'enteredBy';
    v_now := recipe.micros_of(e -> 'recordedAt');
    v_seq := (e ->> 'recordedSeq')::numeric;
    v_want := null;
    v_verify := false;
    v_raise := null;
    v_sev := 'ACTION';
    v_until := 'DEVIATION';
    case v_type || ' ' || v_kind
      -- ------------------------------------------------------------------------------------------- TB-03 (coating use)
      when 'TB-03 DISCARD' then
        -- The rest of the discard is tablets 0851's; here what coating sprayed counts too.
        v_x := tab.gran_prior(p_new, v_key, v_seq, 'PREPARED') -> 0;
        v_n := tab.coat_used(p_content, p_new, v_x, k, v_x -> 'data' -> 'quantity' ->> 'unit');
        if v_x is not null and (v_n is null or v_n + (c -> 'quantity' ->> 'value')::numeric > (v_x -> 'data' -> 'quantity' ->> 'value')::numeric) then
          return format('stores %s, which with what was sprayed, added and discarded before comes to more than the %s %s prepared (TB18-SUSPENSION-OVERUSE)', v_what,
                        v_x -> 'data' -> 'quantity' ->> 'value', v_x -> 'data' -> 'quantity' ->> 'unit');
        end if;
        continue;
      when 'TB-03 PREPARED' then
        continue;
      -- ------------------------------------------------------------------------------------------- TB-18 cores
      when 'TB-18 ROOM_CHECK' then
        if v_cfg ->> 'part' is distinct from 'CORES' then
          return format('stores %s at a coating iteration (TB18-PART)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'ROOM_CHECK')) > 0 then
          return format('stores %s a second time (TB18-ROOM-TWICE)', v_what);
        end if;
        if (c -> 'filteredAir') is distinct from 'true'::jsonb then
          return format('stores %s without filtered pan air (TB18-AIR)', v_what);
        end if;
        v_ok := (v_cfg -> 'room' ->> 'temperatureMin' is null or (c ->> 'temperature')::numeric >= (v_cfg -> 'room' ->> 'temperatureMin')::numeric)
            and (v_cfg -> 'room' ->> 'temperatureMax' is null or (c ->> 'temperature')::numeric <= (v_cfg -> 'room' ->> 'temperatureMax')::numeric)
            and (v_cfg -> 'room' ->> 'humidityMax' is null or (c ->> 'humidity')::numeric <= (v_cfg -> 'room' ->> 'humidityMax')::numeric);
        v_want := jsonb_build_object('filteredAir', true, 'temperature', c -> 'temperature', 'humidity', c -> 'humidity', 'withinLimits', v_ok, 'checkedBy', v_by);
        if not v_ok then
          v_raise := 'ROOM_CONDITIONS_OUT_OF_LIMITS';
        end if;
      when 'TB-18 PAN_LOAD' then
        if v_cfg ->> 'part' is distinct from 'CORES' then
          return format('stores %s at a coating iteration (TB18-PART)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'PAN_LOAD')) > 0 then
          return format('stores %s a second time (TB18-LOAD-TWICE)', v_what);
        end if;
        if jsonb_typeof(v_cfg -> 'loadRange') = 'object' and (c -> 'quantity' ->> 'unit') is distinct from (v_cfg -> 'loadRange' ->> 'unit') then
          return format('stores %s in %s; the load range is in %s (TB18-LOAD-UNIT)', v_what, c -> 'quantity' ->> 'unit', v_cfg -> 'loadRange' ->> 'unit');
        end if;
        v_ok := jsonb_typeof(v_cfg -> 'loadRange') is distinct from 'object'
                or ((c -> 'quantity' ->> 'value')::numeric >= (v_cfg -> 'loadRange' ->> 'min')::numeric
                    and (c -> 'quantity' ->> 'value')::numeric <= (v_cfg -> 'loadRange' ->> 'max')::numeric);
        v_want := jsonb_build_object('quantity', tab.gran_qty(c -> 'quantity'), 'withinRange', v_ok, 'recordedBy', v_by);
        if not v_ok then
          v_raise := 'LOAD_OUT_OF_RANGE';
        end if;
      when 'TB-18 CORE_SAMPLE' then
        if v_cfg ->> 'part' is distinct from 'CORES' then
          return format('stores %s at a coating iteration (TB18-PART)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'CORE_SAMPLE')) > 0 then
          return format('stores %s a second time (TB18-SAMPLE-TWICE)', v_what);
        end if;
        v_x := tab.coat_sample(c, coalesce(v_cfg ->> 'sampleSize', '100'));
        if v_x ? 'problem' then
          return format('stores %s: %s', v_what, v_x ->> 'problem');
        end if;
        v_want := (v_x -> 'data') || jsonb_build_object('recordedBy', v_by);
        v_verify := true;
      -- ------------------------------------------------------------------------------------------- TB-18 coating
      when 'TB-18 SPRAY_START' then
        if v_cfg ->> 'part' is distinct from 'COATING' then
          return format('stores %s at a cores step (TB18-PART)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'SPRAY_START')) > 0 then
          return format('stores %s a second time (TB18-SPRAY-TWICE)', v_what);
        end if;
        v_y := tab.coat_point(p_new, v_cfg ->> 'coreItem');
        if v_y is null or v_y -> 'value' ->> 'unit' is distinct from 'mg' then
          return format('stores %s before the batch has a core mean weight to coat against (TB18-NO-CORES)', v_what);
        end if;
        v_want := jsonb_build_object('startedBy', v_by);
      when 'TB-18 SPRAY_END' then
        v_x := tab.gran_prior(p_new, v_key, v_seq, 'SPRAY_START') -> 0;
        if v_x is null then
          return format('stores %s before spraying started (TB18-NOT-SPRAYING)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'SPRAY_END')) > 0 then
          return format('stores %s a second time (TB18-SPRAY-TWICE)', v_what);
        end if;
        v_y := tab.coat_log_gaps(v_cfg, tab.gran_prior(p_new, v_key, v_seq, 'ACTUAL'), recipe.micros_of(v_x -> 'recordedAt'), v_now);
        v_want := jsonb_build_object('sprayingSeconds', tab.gran_seconds(v_now - recipe.micros_of(v_x -> 'recordedAt')), 'logGaps', v_y, 'endedBy', v_by);
        if jsonb_array_length(v_y) > 0 then
          v_raise := 'PARAMETER_LOG_GAP';
        end if;
      when 'TB-18 SUSPENSION_USED' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'SPRAY_START')) = 0 then
          return format('stores %s before spraying started (TB18-NOT-SPRAYING)', v_what);
        end if;
        select p.v into v_x from jsonb_array_elements(tab.gran_batch_entries(p_content, p_new, 'PREPARED', 'TB-03')) p (v) where p.v ->> 'id' = c ->> 'preparation';
        if v_x is null then
          return format('stores %s naming %s, which is no suspension prepared at a solution step (TB-03) of this batch (TB18-SUSPENSION-PREPARATION)', v_what, coalesce(c ->> 'preparation', '(none)'));
        end if;
        if coalesce(tab.coat_cfg(tab.gran_node(p_content, p_new, v_x ->> 'stepKey')) ->> 'solutionType', '') not in ('FILM_COAT', 'ENTERIC', 'SUGAR_SYRUP') then
          return format('stores %s naming %s, which is not a coating suspension or syrup (TB18-SUSPENSION-TYPE)', v_what, v_x ->> 'id');
        end if;
        if v_now > (v_x -> 'data' ->> 'useByUs')::numeric then
          return format('stores %s of suspension %s at %s, after its use-by %s (database time; TB18-SUSPENSION-EXPIRED)', v_what, v_x ->> 'id', v_now, v_x -> 'data' ->> 'useByUs');
        end if;
        if (c -> 'quantity' ->> 'unit') is distinct from (v_x -> 'data' -> 'quantity' ->> 'unit') then
          return format('stores %s in %s; the suspension was prepared in %s (TB18-SUSPENSION-UNIT)', v_what, c -> 'quantity' ->> 'unit', v_x -> 'data' -> 'quantity' ->> 'unit');
        end if;
        v_n := tab.coat_used(p_content, p_new, v_x, k, v_x -> 'data' -> 'quantity' ->> 'unit');
        if v_n is null or v_n + (c -> 'quantity' ->> 'value')::numeric > (v_x -> 'data' -> 'quantity' ->> 'value')::numeric then
          return format('stores %s, which with what was used and discarded before comes to more than the %s %s of suspension %s prepared (TB18-SUSPENSION-OVERUSE)', v_what,
                        v_x -> 'data' -> 'quantity' ->> 'value', v_x -> 'data' -> 'quantity' ->> 'unit', v_x ->> 'id');
        end if;
        v_want := jsonb_build_object('preparation', c -> 'preparation', 'quantity', tab.gran_qty(c -> 'quantity'), 'usedBy', v_by);
      when 'TB-18 APPLICATION' then
        if v_cfg ->> 'coatingType' is distinct from 'SC' then
          return format('stores %s at a step that is not sugar coating (TB18-NOT-SUGAR)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'SPRAY_START')) = 0 then
          return format('stores %s before the application started (TB18-NOT-SPRAYING)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'APPLICATION')) > 0 then
          return format('stores %s a second time (TB18-APPLICATION-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('phase', c -> 'phase', 'appliedBy', v_by);
      when 'TB-18 WEIGHT_CHECK' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'SPRAY_END')) = 0 then
          return format('stores %s before spraying ended (TB18-CHECK-EARLY)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'WEIGHT_CHECK')) > 0 then
          return format('stores %s a second time: continued coating is the loop''s next iteration (TB18-CHECK-TWICE)', v_what);
        end if;
        v_y := tab.coat_point(p_new, v_cfg ->> 'coreItem');
        if v_y is null or v_y -> 'value' ->> 'unit' is distinct from 'mg' then
          return format('stores %s, but the batch has no core mean weight (TB18-NO-CORES)', v_what);
        end if;
        v_x := tab.coat_sample(c, coalesce(v_cfg ->> 'sampleSize', '100'));
        if v_x ? 'problem' then
          return format('stores %s: %s', v_what, v_x ->> 'problem');
        end if;
        v_n := (v_x -> 'data' ->> 'totalMg')::numeric;
        v_m := (v_y -> 'value' ->> 'value')::numeric;
        v_ok := v_cfg ->> 'maxGain' is not null and tab.coat_gain_cmp(v_n, (c ->> 'count')::numeric, v_m, (v_cfg ->> 'maxGain')::numeric) > 0;
        v_want := (v_x -> 'data') || jsonb_build_object(
          'coreMeanMg', v_y -> 'value' -> 'value', 'weightGain', tab.coat_gain(v_n, (c ->> 'count')::numeric, v_m),
          'belowMinimum', v_cfg ->> 'minGain' is not null and tab.coat_gain_cmp(v_n, (c ->> 'count')::numeric, v_m, (v_cfg ->> 'minGain')::numeric) < 0,
          'aboveMaximum', v_ok, 'recordedBy', v_by);
        v_verify := true;
        if v_ok then
          v_raise := 'WEIGHT_GAIN_ABOVE_MAXIMUM';
          v_until := 'DISPOSITION';
        end if;
      -- ------------------------------------------------------------------------------------------- TB-19
      when 'TB-19 PRINT_SETUP' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'PRINT_SETUP')) > 0 then
          return format('stores %s a second time (TB19-SETUP-TWICE)', v_what);
        end if;
        if (c -> 'inkEdibleGrade') is distinct from 'true'::jsonb then
          return format('stores %s with an ink that is not of edible grade (TB19-INK)', v_what);
        end if;
        if ((c -> 'otherProductsPrinting') = 'true'::jsonb and coalesce(btrim(c ->> 'segregationRecord'), '') = '')
           or ((c -> 'otherProductsPrinting') is distinct from 'true'::jsonb and c ? 'segregationRecord') then
          return format('stores %s: a segregation record exactly when other products or batches are printed at the same time (TB19-SEGREGATION)', v_what);
        end if;
        v_text := plant.press_unit_problem(c ->> 'printer');
        if v_text is not null then
          return format('stores %s: the printer is a process unit of the plant: %s (TB19-PRINTER)', v_what, v_text);
        end if;
        v_want := jsonb_build_object('printer', c -> 'printer', 'inkLot', c -> 'inkLot', 'inkEdibleGrade', true, 'otherProductsPrinting', c -> 'otherProductsPrinting', 'setUpBy', v_by)
                  || recipe.json_pick(c, array['segregationRecord']);
      when 'TB-19 PRINT_CHECK' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'PRINT_SETUP')) = 0 then
          return format('stores %s before the printing set-up (TB19-NO-SETUP)', v_what);
        end if;
        if c ->> 'examined' is distinct from v_cfg ->> 'sampleSize' then
          return format('stores %s of %s tablets; the MBR sets %s (TB19-SAMPLE)', v_what, coalesce(c ->> 'examined', '(none)'), coalesce(v_cfg ->> 'sampleSize', '(none)'));
        end if;
        select coalesce(sum(coalesce((c -> 'defects' ->> x)::numeric, 0)), 0) into v_n from unnest(array['SMUDGED', 'MISSING', 'MISREGISTERED']) x;
        if v_n > (c ->> 'examined')::numeric then
          return format('stores %s with more defects than tablets examined (TB19-DEFECTS)', v_what);
        end if;
        v_ok := (c -> 'legible') = 'true'::jsonb and (c -> 'contentMatches') = 'true'::jsonb and v_n <= coalesce((v_cfg ->> 'maxDefects')::numeric, 0);
        v_want := jsonb_build_object('examined', c -> 'examined', 'legible', (c -> 'legible') = 'true'::jsonb, 'contentMatches', (c -> 'contentMatches') = 'true'::jsonb,
                                     'content', v_cfg -> 'content', 'defectTotal', v_n::text, 'result', case when v_ok then 'PASS' else 'FAIL' end, 'checkedBy', v_by,
                                     'defects', c -> 'defects',
                                     'defectCounts', (select jsonb_object_agg(x, coalesce((c -> 'defects' ->> x)::numeric, 0)::text) from unnest(array['SMUDGED', 'MISSING', 'MISREGISTERED']) x));
        if not v_ok then
          v_raise := 'PRINT_CHECK_FAILED';
        end if;
      -- ------------------------------------------------------------------------------------------- TB-20
      when 'TB-20 INSPECTION_START' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'INSPECTION_START')) > 0 then
          return format('stores %s a second time (TB20-INSPECTION-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('inspector', v_by);
      when 'TB-20 INSPECTION_END' then
        v_x := tab.gran_prior(p_new, v_key, v_seq, 'INSPECTION_START') -> 0;
        if v_x is null then
          return format('stores %s before the inspection started (TB20-NOT-STARTED)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'INSPECTION_END')) > 0 then
          return format('stores %s a second time (TB20-INSPECTION-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('inspectionSeconds', tab.gran_seconds(v_now - recipe.micros_of(v_x -> 'recordedAt')), 'inspector', v_by);
      when 'TB-20 SORT_RESULT' then
        v_text := tab.coat_sort_problem(p_batch, p_content, p_new, v_key, v_seq, v_cfg, c, k);
        if v_text is not null then
          return format('stores %s: %s', v_what, v_text);
        end if;
        v_want := tab.coat_sort_data(v_cfg, c) || jsonb_build_object('recordedBy', v_by);
        v_verify := true;
        if exists (select 1 from jsonb_array_elements(c -> 'defects') x, jsonb_array_elements(v_cfg -> 'defects') y
                    where y ->> 'code' = x ->> 'code' and (y -> 'foreign') = 'true'::jsonb and (x ->> 'count')::numeric > 0) then
          v_raise := 'FOREIGN_TABLET_FOUND';
          v_sev := 'CRITICAL';
          v_until := 'DISPOSITION';
        end if;
      when 'TB-20 AQL_RESULT' then
        v_x := tab.gran_prior(p_new, v_key, v_seq, 'SORT_RESULT') -> 0;
        if v_x is null then
          return format('stores %s before the sort result (TB20-AQL-EARLY)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'AQL_RESULT')) > 0 then
          return format('stores %s a second time: a rejected lot is re-inspected only through an approved reprocessing (TB20-AQL-TWICE; INV-41)', v_what);
        end if;
        v_text := tab.aql_severity(recipe.batch_product(p_batch) ->> 'code', (select b.installation from recipe.batch_execution b where b.id = p_batch));
        if c ->> 'severity' is distinct from v_text then
          return format('stores %s at %s inspection; the switching rule gives %s for the product''s next lot (TB20-SEVERITY)', v_what, coalesce(c ->> 'severity', '(none)'), v_text);
        end if;
        v_y := tab.aql_evaluate(v_cfg, v_text, (v_x -> 'data' -> 'accepted' ->> 'count')::numeric,
                                jsonb_build_object('CRITICAL', coalesce(c -> 'found' ->> 'CRITICAL', '0'), 'MAJOR', coalesce(c -> 'found' ->> 'MAJOR', '0'), 'MINOR', coalesce(c -> 'found' ->> 'MINOR', '0')));
        if v_y is null then
          return format('stores %s for a lot the sampling scheme has no plan for (TB20-NO-PLAN)', v_what);
        end if;
        if exists (select 1 from unnest(array['CRITICAL', 'MAJOR', 'MINOR']) x where coalesce((c -> 'found' ->> x)::numeric, 0) > (v_y ->> 'sampleSize')::numeric) then
          return format('stores %s with more defects in a class than the sample (TB20-FOUND)', v_what);
        end if;
        v_want := v_y || jsonb_build_object('recordedBy', v_by);
        if v_y ->> 'result' = 'REJECTED' then
          v_raise := 'AQL_REJECTED';
          v_until := 'DISPOSITION';
        end if;
      else
        -- recipe-core 0332 refuses a kind the step's block does not record.
        null;
    end case;
    if v_want is not null and d is distinct from v_want then
      select m into v_member
        from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u
       where (d -> m) is distinct from (v_want -> m)
       order by m limit 1;
      return format('stores %s with %s %s, where its block writes %s', v_what, v_member,
                    coalesce((d -> v_member)::text, '(no such member)'), coalesce((v_want -> v_member)::text, '(no such member)'));
    end if;
    if v_verify and (p_new -> 'steps' -> v_key -> 'verificationRequired') is distinct from 'true'::jsonb then
      return format('stores %s, which needs a second person''s check of its step, and the step does not require it (PR-14)', v_what);
    end if;
    if v_raise is not null and not tab.coat_raised(p_old, p_new, v_key, v_raise, v_sev, v_until) then
      return format('stores %s without the %s exception its block raises with it', v_what, v_raise);
    end if;
  end loop;
  return null;
end
$$;

-- PR-46, IN-35 (f): why sort result p_c of TB-20 step instance p_key (configuration p_cfg; recorded at sequence p_seq of
-- state p_state, batch p_batch) is not one the block accepts (tb-20.ts sortResult), or NULL.
create function tab.coat_sort_problem(p_batch uuid, p_content jsonb, p_state jsonb, p_key text, p_seq numeric, p_cfg jsonb, p_c jsonb, p_entry text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  v_defects jsonb := case when jsonb_typeof(p_c -> 'defects') = 'array' then p_c -> 'defects' else '[]'::jsonb end;
  v_rejects jsonb := case when jsonb_typeof(p_c -> 'rejects') = 'array' then p_c -> 'rejects' else '[]'::jsonb end;
  v_unit    text := p_c -> 'inspected' -> 'mass' ->> 'unit';
  v_rej     numeric;
  v_def     numeric;
  v_label   text;
begin
  if jsonb_array_length(tab.gran_prior(p_state, p_key, p_seq, 'INSPECTION_END')) = 0 then
    return 'the sort result is recorded after the sort ends (TB20-NOT-SORTED)';
  end if;
  if jsonb_array_length(tab.gran_prior(p_state, p_key, p_seq, 'SORT_RESULT')) > 0 then
    return 'a second sort result of its step (TB20-SORT-TWICE)';
  end if;
  if exists (select 1 from jsonb_array_elements(v_defects) x
              where not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'defects') = 'array' then p_cfg -> 'defects' else '[]'::jsonb end) y
                                 where y ->> 'code' = x ->> 'code'))
     or (select count(distinct x ->> 'code') from jsonb_array_elements(v_defects) x) <> jsonb_array_length(v_defects) then
    return 'a defect not in the MBR''s catalogue, or one counted twice (TB20-DEFECT)';
  end if;
  if (p_cfg -> 'reusableResidue') is distinct from 'true'::jsonb and exists (select 1 from jsonb_array_elements(v_rejects) r where r ->> 'category' = 'REUSABLE_RESIDUE') then
    return 'reusable residue without a recovery step in the MBR (TB20-RESIDUE)';
  end if;
  if (select count(distinct r ->> 'container') from jsonb_array_elements(v_rejects) r) <> jsonb_array_length(v_rejects) then
    return 'a reject container named twice (TB20-CONTAINER)';
  end if;
  if p_c -> 'accepted' -> 'mass' ->> 'unit' is distinct from v_unit or exists (select 1 from jsonb_array_elements(v_rejects) r where r -> 'mass' ->> 'unit' is distinct from v_unit) then
    return 'the masses of a sort result are in one unit (TB20-UNIT)';
  end if;
  select coalesce(sum((r ->> 'count')::numeric), 0) into v_rej from jsonb_array_elements(v_rejects) r;
  select coalesce(sum((x ->> 'count')::numeric), 0) into v_def from jsonb_array_elements(v_defects) x;
  if (p_c -> 'inspected' ->> 'count')::numeric <> (p_c -> 'accepted' ->> 'count')::numeric + v_rej or v_def <> v_rej then
    return format('inspected %s is not accepted %s and rejected %s, or the %s defects are not the rejects (TB20-RECONCILE)', p_c -> 'inspected' ->> 'count',
                  p_c -> 'accepted' ->> 'count', v_rej, v_def);
  end if;
  if (p_c -> 'inspected' -> 'mass' ->> 'value')::numeric < (p_c -> 'accepted' -> 'mass' ->> 'value')::numeric
                                                           + coalesce((select sum((r -> 'mass' ->> 'value')::numeric) from jsonb_array_elements(v_rejects) r), 0) then
    return 'the accepted and rejected masses come to more than the mass inspected (TB20-RECONCILE)';
  end if;
  for v_label in select r ->> 'container' from jsonb_array_elements(v_rejects) r loop
    if not exists (select 1 from plant.output_container o where o.id::text = v_label and o.batch_id = p_batch) then
      return format('reject container %s is not an output container of this batch (TB20-CONTAINER-BATCH)', v_label);
    end if;
    if exists (select 1 from jsonb_array_elements(tab.coat_rejects(p_content, p_state)) x where x ->> 'container' = v_label and x ->> 'entry' is distinct from p_entry) then
      return format('reject container %s is named by another sort result (TB20-CONTAINER)', v_label);
    end if;
  end loop;
  return null;
end
$$;

-- The data of sort result p_c (tb-20.ts sortResult) before the person.
create function tab.coat_sort_data(p_cfg jsonb, p_c jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  with d as (select x, i from jsonb_array_elements(case when jsonb_typeof(p_c -> 'defects') = 'array' then p_c -> 'defects' else '[]'::jsonb end) with ordinality t (x, i)),
       r as (select x, i from jsonb_array_elements(case when jsonb_typeof(p_c -> 'rejects') = 'array' then p_c -> 'rejects' else '[]'::jsonb end) with ordinality t (x, i))
  select jsonb_build_object(
    'inspected', jsonb_build_object('count', p_c -> 'inspected' -> 'count', 'mass', tab.gran_qty(p_c -> 'inspected' -> 'mass')),
    'accepted', jsonb_build_object('count', p_c -> 'accepted' -> 'count', 'mass', tab.gran_qty(p_c -> 'accepted' -> 'mass')),
    'defects', coalesce((select jsonb_agg(jsonb_build_object('code', x -> 'code', 'count', x -> 'count') order by i) from d), '[]'::jsonb),
    'rejects', coalesce((select jsonb_agg(jsonb_build_object('category', x -> 'category', 'container', x -> 'container', 'count', x -> 'count', 'mass', tab.gran_qty(x -> 'mass')) order by i) from r), '[]'::jsonb),
    'rejectCount', (select coalesce(sum((x ->> 'count')::numeric), 0)::text from r),
    'defectsByClass', (select jsonb_object_agg(k, (select coalesce(sum((x ->> 'count')::numeric), 0)::text
                                                     from d join jsonb_array_elements(p_cfg -> 'defects') y on y ->> 'code' = x ->> 'code'
                                                    where coalesce(y ->> 'class', 'CRITICAL') = k))
                         from unnest(array['CRITICAL', 'MAJOR', 'MINOR']) k),
    'unaccountedMass', jsonb_build_object('value', tab.coat_plain((p_c -> 'inspected' -> 'mass' ->> 'value')::numeric - (p_c -> 'accepted' -> 'mass' ->> 'value')::numeric
                                                                  - coalesce((select sum((x -> 'mass' ->> 'value')::numeric) from r), 0)),
                                          'unit', p_c -> 'inspected' -> 'mass' -> 'unit'))
$$;

-- INV-25, PR-08: why a new value in row p_new of an item TB-18 computes is not the block's own (header, item 2); NULL when
-- every one is.
create function tab.coating_computed_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k       text;
  p       jsonb;
  v_node  jsonb;
  v_cfg   jsonb;
  v_kind  text;
  v_entry jsonb;
  v_want  jsonb;
begin
  for k, p in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'points') = 'object' then p_new -> 'points' else '{}'::jsonb end) x
               where not coalesce((p_old -> 'points') ? x.key, false) order by x.key loop
    v_node := tab.gran_node(p_content, p_new, p ->> 'stepKey');
    if v_node -> 'block' ->> 'type' is distinct from 'TB-18' then
      continue;
    end if;
    v_cfg := tab.coat_cfg(v_node);
    v_kind := case
      when v_cfg ->> 'part' = 'CORES' and v_cfg ->> 'coreItem' = p ->> 'item' then 'CORE_SAMPLE'
      when v_cfg ->> 'part' = 'COATING' and v_cfg ->> 'gainItem' = p ->> 'item' then 'WEIGHT_CHECK'
    end;
    if v_kind is null then
      continue;
    end if;
    v_entry := tab.gran_prior(p_new, p ->> 'stepKey', 'Infinity'::numeric, v_kind) -> 0;
    v_want := case when v_entry is null then null
                   else jsonb_build_object('kind', 'DECIMAL', 'value', v_entry -> 'data' -> case when v_kind = 'CORE_SAMPLE' then 'meanMg' else 'weightGain' end,
                                           'unit', case when v_kind = 'CORE_SAMPLE' then 'mg' else '%' end) end;
    if p ->> 'kind' is distinct from 'VALUE' or (p -> 'source') is distinct from jsonb_build_object('mode', 'BLOCK', 'entries', jsonb_build_array(v_entry -> 'id'))
       or v_want is null or (p -> 'value') is distinct from v_want then
      return format('stores value %s of %s at step %s that is not the one its block computes from its %s entry (%s; TB18-COMPUTED)', k, p ->> 'item', p ->> 'stepKey', v_kind,
                    coalesce(v_want::text, 'none yet'));
    end if;
  end loop;
  return null;
end
$$;

-- IN-37, PR-29, PR-46, IN-35: why a coating, printing, inspection or destruction step that row p_new closes is not
-- complete (header, item 3); NULL when every one is.
create function tab.coating_close_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  k       text;
  s       jsonb;
  v_node  jsonb;
  v_type  text;
  v_cfg   jsonb;
  v_all   jsonb;
  v_text  text;
  r       jsonb;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(p_content, s ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-18', 'TB-19', 'TB-20', 'G-23') then
      continue;
    end if;
    v_cfg := tab.coat_cfg(v_node);
    v_all := tab.gran_prior(p_new, k, 'Infinity'::numeric, null);
    v_text := null;
    case v_type
      when 'TB-18' then
        if v_cfg ->> 'part' = 'COATING' then
          v_text := case
            when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'SPRAY_END') then 'spraying has not ended (TB18-NOT-SPRAYED)'
            when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'SUSPENSION_USED') then 'it records no suspension used (TB18-NO-SUSPENSION)'
            when v_cfg ->> 'coatingType' = 'SC' and not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'APPLICATION') then 'it records no application (TB18-NO-APPLICATION)'
            when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'WEIGHT_CHECK') then 'it has no weight-gain check (TB18-NO-CHECK)'
          end;
        else
          v_text := case
            when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'ROOM_CHECK') then 'the coating room is not checked (TB18-NO-ROOM-CHECK)'
            when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'PAN_LOAD') then 'it has no pan load (TB18-NO-LOAD)'
            when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'CORE_SAMPLE') then 'it has no core sample (TB18-NO-SAMPLE)'
          end;
        end if;
      when 'TB-19' then
        v_text := case
          when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'PRINT_SETUP') then 'it has no printing set-up (TB19-NO-SETUP)'
          when coalesce((select e -> 'data' ->> 'result' from jsonb_array_elements(v_all) with ordinality x (e, i) where e ->> 'kind' = 'PRINT_CHECK' order by i desc limit 1), '') <> 'PASS'
            then 'its last print check did not pass (TB19-LAST-CHECK)'
        end;
      when 'TB-20' then
        v_text := case
          when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'INSPECTION_END') then 'the inspection has not ended (TB20-NOT-SORTED)'
          when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'SORT_RESULT') then 'it has no sort result (TB20-NO-SORT)'
          when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'AQL_RESULT') then 'it has no AQL result (TB20-NO-AQL)'
        end;
      when 'G-23' then
        -- The destruction step of an inspection step: every container for destruction of the batch's sorts is destroyed
        -- here, named by its label, quantity for quantity (PR-46, IN-35 (f)).
        for r in select x from jsonb_array_elements(tab.coat_rejects(p_content, p_new)) x
                  where x ->> 'category' = 'DESTRUCTION' and tab.coat_cfg(recipe.step_node(p_content, x ->> 'step')) ->> 'destructionStep' = s ->> 'step' loop
          if not exists (select 1 from jsonb_array_elements(v_all) e
                          where e ->> 'kind' = 'DISPOSAL' and e -> 'data' ->> 'category' = 'DESTRUCTION'
                            and e -> 'data' ->> 'container' = (select o.label_code from plant.output_container o where o.id::text = r ->> 'container')
                            and e -> 'data' -> 'quantity' ->> 'unit' = r -> 'mass' ->> 'unit'
                            and (e -> 'data' -> 'quantity' ->> 'value')::numeric = (r -> 'mass' ->> 'value')::numeric) then
            v_text := format('reject container %s of %s is not destroyed here with its %s %s (TB20-NOT-DESTROYED)', r ->> 'container', r ->> 'stepKey',
                             r -> 'mass' ->> 'value', r -> 'mass' ->> 'unit');
            exit;
          end if;
        end loop;
    end case;
    if v_text is not null then
      return format('closes step %s, but %s', k, v_text);
    end if;
  end loop;
  return null;
end
$$;

-- DI-34, IN-37: why a TB-18 coating step instance of row p_new runs beyond the maximum iterations of a loop it sits in (or
-- 20, the block's bound; header, item 4); NULL when none does.
create function tab.coating_loop_problem(p_content jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k      text;
  s      jsonb;
  f      jsonb;
  v_loop jsonb;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x order by x.key loop
    if recipe.step_node(p_content, s ->> 'step') -> 'block' ->> 'type' is distinct from 'TB-18' then
      continue;
    end if;
    for f in select x from jsonb_array_elements(case when jsonb_typeof(s -> 'frames') = 'array' then s -> 'frames' else '[]'::jsonb end) x loop
      select l into v_loop from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "loop" && @.id == $id)',
                                                 jsonb_build_object('id', f -> 'construct')) l limit 1;
      if v_loop is not null and ((f ->> 'index')::numeric > (v_loop ->> 'maxIterations')::numeric or (f ->> 'index')::numeric > 20) then
        return format('runs coating step %s in iteration %s of loop %s, beyond its maximum of %s iterations (TB18-LOOP-BOUND)', k, f ->> 'index', f ->> 'construct',
                      least((v_loop ->> 'maxIterations')::numeric, 20));
      end if;
      v_loop := null;
    end loop;
  end loop;
  return null;
end
$$;

-- The node right after phase p_id in its enclosing sequence of MBR content p_content (NULL when last or not in one).
create function tab.coat_next_node(p_content jsonb, p_id text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select n.c -> (n.i::integer)
    from (select q.v -> 'children' as c, i
            from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "sequence")') q (v),
                 jsonb_array_elements(q.v -> 'children') with ordinality ch (x, i)
           where ch.x ->> 'id' = p_id) n
   limit 1
$$;

-- IN-37, PR-46: why the batch's MBR p_content lacks the QC gate after a printing step or the witnessed destruction step of
-- an inspection step (header, item 5); NULL when it has both everywhere.
create function tab.coating_mbr_problem(p_content jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  p      jsonb;
  v_next jsonb;
  v_g    jsonb;
begin
  for p in select x from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') x
            where x -> 'block' ->> 'type' in ('TB-19', 'TB-20') loop
    if p -> 'block' ->> 'type' = 'TB-19' then
      v_next := tab.coat_next_node(p_content, p ->> 'id');
      if v_next ->> 'kind' is distinct from 'holdPoint' or v_next ->> 'role' is distinct from coalesce(tab.coat_cfg(p) ->> 'gateRole', 'QA')
         or not exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(v_next -> 'dispositions') = 'array' then v_next -> 'dispositions' else '[]'::jsonb end) d
                         where d not in ('APPROVED', 'APPROVED_WITH_CONDITIONS', 'CONTINUE', 'RELEASED', 'ACCEPTED')) then
        return format('printing step %s is not followed by a QA hold point of its gate role that can reject the printed tablets (TB19-NO-GATE)', p ->> 'id');
      end if;
    else
      select x into v_g from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase" && @.id == $id)',
                                              jsonb_build_object('id', tab.coat_cfg(p) ->> 'destructionStep')) x limit 1;
      if v_g -> 'block' ->> 'type' is distinct from 'G-23' or (tab.coat_cfg(v_g) -> 'witness') = 'false'::jsonb
         or v_g -> 'signatures' -> 'check' ->> 'meaning' is distinct from 'WITNESSED' then
        return format('inspection step %s names no witnessed G-23 step for its rejects (TB20-DESTRUCTION)', p ->> 'id');
      end if;
    end if;
  end loop;
  return null;
end
$$;

-- The records an accepted row makes (header): the printer's PASS or FAIL for each new print check; each new AQL result's
-- lot in the switching history.
create function tab.coating_record(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k         text;
  e         jsonb;
  v_type    text;
  v_printer text;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) and x.value ->> 'kind' in ('PRINT_CHECK', 'AQL_RESULT') order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_type := tab.gran_node(p_content, p_new, e ->> 'stepKey') -> 'block' ->> 'type';
    if v_type = 'TB-19' and e ->> 'kind' = 'PRINT_CHECK' then
      v_printer := tab.gran_prior(p_new, e ->> 'stepKey', 'Infinity'::numeric, 'PRINT_SETUP') -> 0 -> 'data' ->> 'printer';
      perform plant.record_ipc_check(p_batch, v_printer, null, case when e -> 'data' ->> 'result' = 'PASS' then 'PASS' else 'FAIL' end,
                                     format('TB19:%s:%s', e ->> 'stepKey', k));
    elsif v_type = 'TB-20' and e ->> 'kind' = 'AQL_RESULT' then
      insert into tab.aql_lot_result (batch_id, installation, product_code, step_key, entry_id, severity, accepted)
      values (p_batch, (select b.installation from recipe.batch_execution b where b.id = p_batch), recipe.batch_product(p_batch) ->> 'code', e ->> 'stepKey', k,
              e -> 'data' ->> 'severity', e -> 'data' ->> 'result' = 'ACCEPTED');
    end if;
  end loop;
end
$$;

-- Whether batch p_batch's MBR has a coating, printing or inspection step.
create function tab.coat_batch_has(p_content jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                  where p -> 'block' ->> 'type' in ('TB-18', 'TB-19', 'TB-20'))
$$;

-- The row trigger (header).
create function tab.coating_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not tab.coat_batch_has(v_content) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := tab.coating_mbr_problem(v_content);
  v_code := 'EBMR-EXE-274';
  if v_problem is null then
    v_problem := tab.coating_entry_problem(new.batch_id, v_content, old.state, new.state, r.command);
    v_code := 'EBMR-EXE-270';
  end if;
  if v_problem is null then
    v_problem := tab.coating_computed_problem(v_content, old.state, new.state);
    v_code := 'EBMR-EXE-271';
  end if;
  if v_problem is null then
    v_problem := tab.coating_close_problem(v_content, old.state, new.state);
    v_code := 'EBMR-EXE-272';
  end if;
  if v_problem is null then
    v_problem := tab.coating_loop_problem(v_content, new.state);
    v_code := 'EBMR-EXE-273';
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a coating, printing or inspection step records what its block builds, closes only complete, its loop stays bounded and its gates are in the MBR (IN-37, PR-08, PR-29, PR-46, IN-35, INV-25, INV-41, DI-34). [%s]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem, v_code);
  end if;
  perform tab.coating_record(new.batch_id, v_content, old.state, new.state);
  return null;
end
$$;

create trigger zt_tab_coating after update on recipe.execution_state
  for each row execute function tab.coating_state_check();

-- ---------------------------------------------------------------------------------------------
-- Containers (header)

-- IN-37, PR-46, PR-47: why container p_container cannot be charged, packed or merged now (printed tablets before the QC
-- gate, a reject container), or NULL.
create function tab.coat_container_problem(p_container uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  o         plant.output_container;
  v_content jsonb;
  v_state   jsonb;
  k         text;
  s         jsonb;
  v_next    jsonb;
begin
  select * into o from plant.output_container where id = p_container;
  if not found then
    return null;
  end if;
  v_content := recipe.batch_mbr_content(o.batch_id);
  if not tab.coat_batch_has(v_content) then
    return null;
  end if;
  select st.state into v_state from recipe.execution_state st where st.batch_id = o.batch_id;
  if exists (select 1 from jsonb_array_elements(tab.coat_rejects(v_content, v_state)) x where x ->> 'container' = o.id::text) then
    return format('container %s holds rejects of an inspection step: rejects are destroyed, never charged, packed or merged (TB20-REJECT-CHARGED; PR-46)', o.label_code);
  end if;
  if o.press_code is null then
    return null;
  end if;
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(v_state -> 'steps') = 'object' then v_state -> 'steps' else '{}'::jsonb end) x order by x.key loop
    if recipe.step_node(v_content, s ->> 'step') -> 'block' ->> 'type' is distinct from 'TB-19'
       or (tab.gran_prior(v_state, k, 'Infinity'::numeric, 'PRINT_SETUP') -> 0 -> 'data' ->> 'printer') is distinct from o.press_code then
      continue;
    end if;
    v_next := tab.coat_next_node(v_content, s ->> 'step');
    if not exists (select 1 from jsonb_each(v_state -> 'steps') h
                    where h.value ->> 'step' = v_next ->> 'id' and h.value ->> 'status' = 'COMPLETED' and (h.value -> 'disposition' -> 'positive') = 'true'::jsonb
                      and (h.value -> 'frames') = (s -> 'frames')) then
      return format('container %s holds tablets printed at %s, which wait for the QC approval at hold point %s (TB19-GATE-OPEN; IN-37)', o.label_code, k,
                    coalesce(v_next ->> 'id', '(none)'));
    end if;
  end loop;
  return null;
end
$$;

create function tab.coat_charge_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_problem text := tab.coat_container_problem((to_jsonb(new) ->> case when tg_table_name = 'container_merge' then 'source_id' else 'container_id' end)::uuid);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This container cannot be %s: %s. [EBMR-TAB-310]',
                                                              case when tg_table_name = 'container_merge' then 'merged' else 'charged or packed' end, v_problem);
  end if;
  return new;
end
$$;

create trigger aa_tab_coat_charge before insert on plant.container_charge for each row execute function tab.coat_charge_check();
create trigger aa_tab_coat_merge before insert on plant.container_merge for each row execute function tab.coat_charge_check();

-- PR-29, IN-37: whether a PASS check of batch p_batch for press p_press (stream p_stream, reference p_reference) is a
-- check of a printer of the batch's printing steps (TB-19) and, if it is, why it is not the record of a passing print
-- check of that printer, once: {printer: boolean, problem: text or null}. Also read by tab.ipc_pass_check (tablets 0932)
-- for a reference TB19:<step>:<entry>, so a batch that runs a TB-11, TB-06 or TB-16 step records its print checks too.
create function tab.coat_print_pass(p_batch uuid, p_press text, p_stream text, p_reference text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  v_content jsonb := recipe.batch_mbr_content(p_batch);
  v_state   jsonb;
  v_m       text[];
  e         jsonb;
begin
  if not tab.coat_batch_has(v_content) then
    return jsonb_build_object('printer', false);
  end if;
  select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch;
  if not exists (select 1 from jsonb_each(case when jsonb_typeof(v_state -> 'entries') = 'object' then v_state -> 'entries' else '{}'::jsonb end) x
                  where x.value ->> 'kind' = 'PRINT_SETUP' and x.value -> 'data' ->> 'printer' = p_press
                    and recipe.step_node(v_content, v_state -> 'steps' -> (x.value ->> 'stepKey') ->> 'step') -> 'block' ->> 'type' = 'TB-19') then
    return jsonb_build_object('printer', false);
  end if;
  v_m := regexp_match(p_reference, '^TB19:(.+):(EN-[1-9][0-9]{0,8})$');
  e := v_state -> 'entries' -> v_m[2];
  if v_m is null or e is null or e ->> 'stepKey' is distinct from v_m[1] or e ->> 'kind' is distinct from 'PRINT_CHECK'
     or recipe.step_node(v_content, v_state -> 'steps' -> v_m[1] ->> 'step') -> 'block' ->> 'type' is distinct from 'TB-19'
     or e -> 'data' ->> 'result' is distinct from 'PASS' or p_stream is not null
     or (tab.gran_prior(v_state, v_m[1], 'Infinity'::numeric, 'PRINT_SETUP') -> 0 -> 'data' ->> 'printer') is distinct from p_press
     or exists (select 1 from plant.ipc_check k where k.batch_id = p_batch and k.reference = p_reference) then
    return jsonb_build_object('printer', true, 'problem', 'not the record of a passing print check of this printer, once');
  end if;
  return jsonb_build_object('printer', true, 'problem', null);
end
$$;

-- The trigger of tab.coat_print_pass (header).
create function tab.coat_pass_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  v jsonb;
begin
  if new.result is distinct from 'PASS' then
    return new;
  end if;
  v := tab.coat_print_pass(new.batch_id, new.press_code, new.stream, new.reference);
  if (v -> 'printer') = 'true'::jsonb and v ->> 'problem' is not null then
    raise exception using errcode = 'P0001',
      message = 'A passing check of a printer of the batch''s printing steps is recorded only from a passing print check of that printer, once: printed tablets are vouched for only by a recorded passing result (PR-29, IN-37). [EBMR-TAB-311]';
  end if;
  return new;
end
$$;

create trigger aa_tab_coat_pass before insert on plant.ipc_check
  for each row execute function tab.coat_pass_check();

-- As tablets 0852 (INV-25): the block values TB-18 computes (the core mean of a cores step, the weight gain of a coating
-- step) are held by tab.coating_computed_problem (EBMR-EXE-271), not by the weighing rule of recipe-core 0322, which no
-- weighing of their step could satisfy; TB-04's and TB-07's as before.
create or replace function recipe.granulation_block_item(p_content jsonb, p_state jsonb, p_point jsonb) returns boolean
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(n -> 'block' ->> 'type' = 'TB-04' and n -> 'config' -> 'endPoint' ->> 'item' = p_point ->> 'item'
                  or n -> 'block' ->> 'type' = 'TB-07' and (n -> 'config' -> 'blendTime' ->> 'item' = p_point ->> 'item'
                                                            or n -> 'config' -> 'lubrication' ->> 'item' = p_point ->> 'item')
                  or n -> 'block' ->> 'type' = 'TB-18' and (n -> 'config' ->> 'part' = 'CORES' and n -> 'config' ->> 'coreItem' = p_point ->> 'item'
                                                            or n -> 'config' ->> 'part' = 'COATING' and n -> 'config' ->> 'gainItem' = p_point ->> 'item'), false)
    from (select recipe.step_node(p_content, p_state -> 'steps' -> (p_point ->> 'stepKey') ->> 'step') as n) s
$$;

revoke all on function tab.coat_raised(jsonb, jsonb, text, text, text, text), tab.coat_cfg(jsonb), tab.coat_point(jsonb, text), tab.coat_log_gaps(jsonb, jsonb, numeric, numeric),
  tab.coat_used(jsonb, jsonb, jsonb, text, text), tab.coat_rejects(jsonb, jsonb), tab.coating_entry_problem(uuid, jsonb, jsonb, jsonb, jsonb),
  tab.coat_sort_problem(uuid, jsonb, jsonb, text, numeric, jsonb, jsonb, text), tab.coat_sort_data(jsonb, jsonb), tab.coating_computed_problem(jsonb, jsonb, jsonb),
  tab.coating_close_problem(jsonb, jsonb, jsonb), tab.coating_loop_problem(jsonb, jsonb), tab.coat_next_node(jsonb, text), tab.coating_mbr_problem(jsonb),
  tab.coating_record(uuid, jsonb, jsonb, jsonb), tab.coat_batch_has(jsonb), tab.coating_state_check(), tab.coat_container_problem(uuid),
  tab.coat_charge_check(), tab.coat_pass_check(), tab.coat_print_pass(uuid, text, text, text) from public;

reset role;
