-- Tablets server, Phase 4 slice 1b: TB-20@2, the inspection whose lot has no sampling plan leaves through a linked
-- deviation (D-P4-11; Phase 3 slice 3d #3, slice 5b and 6c backlog; controls PR-29, PR-46, PR-49, DI-10, INV-41; ADR 0012:
-- the rules hold when the application's own database credentials are used directly).
--
-- TB-20@1 refuses an AQL result for a lot the sampling scheme has no plan for (fewer than two accepted tablets,
-- TB20-NO-PLAN), so such a lot could never leave the inspection (it failed safe). A released block version never changes
-- (ADR 0010), so the path is a new version, TB-20@2 (src/blocks/tb-20.ts TB20_V2); TB-20@1 stays for batches issued on it.
-- TB-20@2 is TB-20@1 with one more AQL_RESULT outcome: NO_PLAN, with a deviation reference, which raises AQL_NO_PLAN
-- (ACTION, a deviation required, QA only, blocking the steps after it until dispositioned, release blocking).
--
--   * recipe.block_data_schema: the entries of TB-20@2 as the block declares them (AQL_RESULT gains the optional outcome
--     and deviationRef, and found becomes optional; the other three kinds as TB-20@1);
--   * recipe.engine_name: the rule codes TB-20@2 gives that TB-20@1 did not;
--   * tab.tb20_no_plan_ref_problem(batch, ref): on a GMP batch the reference names a deviation-lite record of the batch's
--     site, linked to the batch and not cancelled (site.deviation_ref_problem, use LINK, recipe-core 0601's rule); in a
--     test run a reference only (D-S5-2: sandbox runs keep reference-only links);
--   * tab.coating_entry_problem: CREATE OR REPLACE from its only definition (0912) with one change, in the TB-20
--     AQL_RESULT branch: an entry naming an outcome or a deviation reference is the NO_PLAN outcome (TB20-NO-PLAN-ONLY),
--     only for a lot without a plan at the switching rule's severity (TB20-PLAN-EXISTS), with no defects counted
--     (TB20-NO-PLAN-FOUND) and a reference the rule above accepts (TB20-NO-PLAN-DEVIATION); it holds exactly
--     {result NO_PLAN, severity, lotSize, deviationRef, recordedBy} and is stored only with its AQL_NO_PLAN exception. A
--     TB-20@1 entry cannot reach this branch: recipe-core 0332 refuses the members its schema does not hold;
--   * tab.coating_record: CREATE OR REPLACE from its only definition (0912): a NO_PLAN result is not written to the
--     switching history (tab.aql_lot_result), as no sample judged the lot.
-- Owned by ebmr_owner, pg_temp last (ADR 0016). Applied as a new migration because applied migrations are checksummed and
-- never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1113_tb20_v2_no_plan)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block version TB-20@2 (NO_PLAN through a linked deviation) in the registers every entry is checked against (D-P4-11)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema)
select 'TB-20', '2', part, entry_kind, schema from recipe.block_data_schema
 where block_type = 'TB-20' and block_version = '1' and entry_kind in ('INSPECTION_START', 'INSPECTION_END', 'SORT_RESULT');

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('TB-20', '2', 'ENTRY', 'AQL_RESULT', '{"type":"object","fields":{"severity":{"type":"string","enum":["NORMAL","TIGHTENED"]},"found":{"type":"object","fields":{"CRITICAL":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true},"MAJOR":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true},"MINOR":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true}},"optional":true},"outcome":{"type":"string","enum":["NO_PLAN"],"optional":true},"deviationRef":{"type":"string","optional":true}}}');

insert into recipe.engine_name (name, kind) values
  ('TB20-NO-PLAN-ONLY', 'RULE_CODE'), ('TB20-PLAN-EXISTS', 'RULE_CODE'), ('TB20-NO-PLAN-FOUND', 'RULE_CODE'), ('TB20-NO-PLAN-DEVIATION', 'RULE_CODE');

select kernel.set_actor_context(null);

-- PR-49, D-P4-11: why deviation reference p_ref does not carry a NO_PLAN lot of batch p_batch out of the inspection, or NULL.
create function tab.tb20_no_plan_ref_problem(p_batch uuid, p_ref text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, site, pg_temp as $$
begin
  if btrim(coalesce(p_ref, '')) = '' then
    return 'it names no deviation reference';
  end if;
  if (select b.installation from recipe.batch_execution b where b.id = p_batch) is distinct from 'GMP' then
    return null;
  end if;
  return site.deviation_ref_problem(p_ref, 'LINK', p_batch);
end
$$;
revoke all on function tab.tb20_no_plan_ref_problem(uuid, text) from public;

create or replace function tab.coating_entry_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
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
  v_problem text;
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
        -- Review 3d finding 3: the product's lots are judged one at a time, so the history the switching rule reads is
        -- every lot recorded before this one (tab.aql_severity_locked; the lock is held until the row commits).
        v_text := tab.aql_severity_locked(recipe.batch_product(p_batch) ->> 'code', (select b.installation from recipe.batch_execution b where b.id = p_batch));
        if c ->> 'severity' is distinct from v_text then
          return format('stores %s at %s inspection; the switching rule gives %s for the product''s next lot (TB20-SEVERITY)', v_what, coalesce(c ->> 'severity', '(none)'), v_text);
        end if;
        -- Phase 4 slice 1b (D-P4-11): TB-20@2's NO_PLAN outcome through a linked deviation (tb-20.ts aqlResultV2).
        if c ? 'outcome' or c ? 'deviationRef' then
          if c ->> 'outcome' is distinct from 'NO_PLAN' then
            return format('stores %s with a deviation reference but not the NO_PLAN outcome (TB20-NO-PLAN-ONLY)', v_what);
          end if;
          if tab.aql_evaluate(v_cfg, v_text, (v_x -> 'data' -> 'accepted' ->> 'count')::numeric, jsonb_build_object('CRITICAL', '0', 'MAJOR', '0', 'MINOR', '0')) is not null then
            return format('stores %s as NO_PLAN for a lot the sampling scheme has a plan for (TB20-PLAN-EXISTS)', v_what);
          end if;
          if jsonb_typeof(c -> 'found') = 'object' and c -> 'found' <> '{}'::jsonb then
            return format('stores %s as NO_PLAN with defects counted; such a lot draws no sample (TB20-NO-PLAN-FOUND)', v_what);
          end if;
          v_problem := tab.tb20_no_plan_ref_problem(p_batch, c ->> 'deviationRef');
          if v_problem is not null then
            return format('stores %s as NO_PLAN: %s (TB20-NO-PLAN-DEVIATION; PR-49)', v_what, v_problem);
          end if;
          v_want := jsonb_build_object('result', 'NO_PLAN', 'severity', v_text, 'lotSize', (v_x -> 'data' -> 'accepted' ->> 'count')::numeric::text,
                                       'deviationRef', btrim(c ->> 'deviationRef'), 'recordedBy', v_by);
          v_raise := 'AQL_NO_PLAN';
          v_until := 'DISPOSITION';
        else
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

create or replace function tab.coating_record(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns void
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
    -- Phase 4 slice 1b: a NO_PLAN lot (TB-20@2) was judged by no sample, so it is no part of the switching history.
    elsif v_type = 'TB-20' and e ->> 'kind' = 'AQL_RESULT' and e -> 'data' ->> 'result' is distinct from 'NO_PLAN' then
      insert into tab.aql_lot_result (batch_id, installation, product_code, step_key, entry_id, severity, accepted)
      values (p_batch, (select b.installation from recipe.batch_execution b where b.id = p_batch), recipe.batch_product(p_batch) ->> 'code', e ->> 'stepKey', k,
              e -> 'data' ->> 'severity', e -> 'data' ->> 'result' = 'ACCEPTED');
    end if;
  end loop;
end
$$;

reset role;
