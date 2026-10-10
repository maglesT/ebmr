-- Tablets server, Phase 3 slice 3c (builder A): the rules of the compression blocks TB-09, TB-10 and TB-17 held by the
-- database, the close of a step on a process device after an interface loss, and the Tablets steps that are never
-- skipped (tablets spec B.2; controls INV-24, IN-26 (c), IN-35, IN-36, PR-22, PR-23, PR-27, DI-31, DI-49; ADR 0012: the
-- rules hold when the application's own database credentials are used directly).
--
-- recipe.entry_block_problem (recipe-core 0520) checks the generic kinds (TB-10's and TB-17's G-06 entries included);
-- recipe-core 0332 holds each entry to its block's data schema (tablets 0873). This migration adds a row trigger on
-- recipe.execution_state (zt_tab_compression, after update; every row) that refuses a row unless:
--
--   1. every new entry of a TB-09, TB-10 or TB-17 step stands on the register row its command wrote and holds exactly
--      what its block (src/blocks/tb-09.ts, tb-10.ts, tb-17.ts) builds from it, with the exception the block raises:
--        TB-09  an inspection is the register's (set, BEFORE = PRE_USE / AFTER = POST_USE, result, by the person
--               recording it), named by no other entry; an after-use one of the use the step returned; an issue is the
--               register's for this batch and press, on the passing BEFORE inspection of the step, of a set whose master
--               data match the MBR's approved tooling specification (TB09-SPEC, PR-27); a return is the register's for
--               an issue of this batch, with its strokes, their source, the punch and die count and the usage limit as the
--               register derived them; a failed after-use inspection, a count mismatch and a passed limit come with the
--               exception that waits for a deviation (IN-36 (b), INV-24);
--        TB-10  the set-up names the batch's open use of the press (of the step's equipment, fit: PR-23), the press the
--               step's device is the unit of (DI-31), and a tooling issue of a TB-09 step of this batch for that press
--               that may compress now: not returned or retired, inspected before use, its strokes with this use below its
--               limit (tab.tooling_use_problem; INV-24); a hopper charge is a scan of this batch by the person
--               (plant.container_charge: IN-26 (c)); the checklist, the first-off and setting changes as the block;
--        TB-17  a challenge is the register's (device and code of the MBR, timing, result, person), the metal detector
--               challenged with a piece of every kind and size the MBR names, START first and nothing after END, a
--               late one with CHALLENGE_OVERDUE (interval measured at database time) and a failed one with
--               DETECTOR_CHALLENGE_FAILED (IN-36 (e)); reject counts and the de-duster as the block;
--   2. such a step closes (IN_PROGRESS to AWAITING_VERIFICATION or COMPLETED) only complete: TB-09 with a set issued, or
--      every returned set inspected after use (IN-36: the after-use check is mandatory); TB-10 set up with tooling that
--      may still compress at that moment, on a press still in use by the batch and fit, a checklist in order, a charge
--      and a passing first-off; TB-17 with a passing END challenge of every device, its rejects and the de-duster;
--   3. a step on a process device (tab.process_block_type) closes only when every interface loss recorded for it
--      (tab.interface_loss, the server job) is answered by an INTERFACE_LOSS entry of the step made after it (DI-31, PR-14).
-- EBMR-EXE-260 (entries), EBMR-EXE-261 (closing a step), EBMR-EXE-262 (interface loss).
--
-- recipe.skip_problem (CREATE OR REPLACE from tablets 0845, the latest) refuses a skip of any Tablets edition step
-- (TB-xx): every TB block moves or processes material or checks it (stricter default than the list of 0845, so that a
-- later Tablets block is never skippable by omission). Nothing else of it changes.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- Whether row p_new raised (newly against p_old) an exception of type p_type at step instance p_key, of any severity.
create function tab.comp_raised_new(p_old jsonb, p_new jsonb, p_key text, p_type text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
     where not coalesce((p_old -> 'exceptions') ? x.key, false) and x.value ->> 'type' = p_type and x.value -> 'source' ->> 'stepKey' = p_key)
$$;

-- The entries of state p_state (the whole batch) of kind p_kind whose data member p_member is p_value.
create function tab.comp_named(p_state jsonb, p_kind text, p_member text, p_value text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) x
                  where x.value ->> 'kind' = p_kind and x.value -> 'data' ->> p_member = p_value)
$$;

create function tab.comp_uuid(p text) returns uuid
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$$;

-- The pre-use checklist a TB-10 step of configuration p_cfg records: the three required checks, then the MBR's own.
create function tab.comp_checklist(p_cfg jsonb) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['DUST_EXTRACTION', 'NOZZLES_CLEAN_NO_LEAK', 'CALIBRATED_BALANCE']
         || coalesce(array(select x from jsonb_array_elements_text(case when jsonb_typeof(p_cfg -> 'checklist') = 'array' then p_cfg -> 'checklist' else '[]'::jsonb end)
                                  with ordinality t (x, i)
                            where x not in ('DUST_EXTRACTION', 'NOZZLES_CLEAN_NO_LEAK', 'CALIBRATED_BALANCE') order by i), '{}')
$$;

-- The configuration of device p_device ('METAL_DETECTOR', 'REJECT_GATE') of a TB-17 step (NULL when not configured).
create function tab.comp_device(p_cfg jsonb, p_device text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p_cfg -> v.k) = 'object' then p_cfg -> v.k end
    from (select case p_device when 'METAL_DETECTOR' then 'metalDetector' when 'REJECT_GATE' then 'rejectGate' end as k) v
$$;

-- INV-24, IN-26, IN-35, IN-36, PR-22, PR-23, PR-27, DI-31, DI-49: why a new entry of a compression step of batch p_batch
-- in row p_new (after p_old, command p_command, MBR p_content) is not what its block builds from its register row
-- (header, item 1); NULL when every one is.
create function tab.compression_entry_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
language plpgsql stable set search_path = pg_catalog, tab, plant, recipe, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1       jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  d        jsonb;
  c        jsonb;
  v_kind   text;
  v_key    text;
  v_step   text;
  v_node   jsonb;
  v_type   text;
  v_cfg    jsonb;
  v_by     jsonb;
  v_now    numeric;
  v_seq    numeric;
  v_what   text;
  v_want   jsonb;
  v_verify boolean;
  v_held   text[];
  v_raise  text[];
  v_t      text;
  v_x      jsonb;
  v_list   text[];
  v_text   text;
  v_ok     boolean;
  v_n      numeric;
  ins      tab.tooling_inspection;
  ts       tab.tooling_set;
  u        tab.tooling_issue;
  r        tab.tooling_return;
  eq       plant.equipment;
  us       plant.equipment_use_status;
  g        plant.container_charge;
  ch       tab.detector_challenge;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_kind := e ->> 'kind';
    v_key := e ->> 'stepKey';
    v_step := p_new -> 'steps' -> v_key ->> 'step';
    v_node := recipe.step_node(p_content, v_step);
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-09', 'TB-10', 'TB-17')
       or v_kind in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'START_DATA') then
      continue;
    end if;
    v_what := format('entry %s (%s) of step %s', k, coalesce(v_kind, 'unnamed'), coalesce(v_key, '(none)'));
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    c := case when jsonb_typeof(p_command -> 'entry') = 'object' then p_command -> 'entry' else '{}'::jsonb end;
    v_by := e -> 'enteredBy';
    v_now := recipe.micros_of(e -> 'recordedAt');
    v_seq := (e ->> 'recordedSeq')::numeric;
    v_want := null;
    v_verify := false;
    v_held := '{}';
    v_raise := '{}';
    ins := null; ts := null; u := null; r := null; eq := null; us := null; g := null; ch := null;
    case v_type || ' ' || v_kind
      -- ------------------------------------------------------------------------------------------- TB-09
      when 'TB-09 TOOLING_INSPECTED' then
        if (coalesce(v_cfg ->> 'part', 'ISSUE') = 'ISSUE') <> (c ->> 'when' = 'BEFORE') then
          return format('stores %s, an inspection %s use in a step of the %s part (TB09-PART)', v_what, lower(coalesce(c ->> 'when', '?')), coalesce(v_cfg ->> 'part', 'ISSUE'));
        end if;
        select * into ins from tab.tooling_inspection where id = tab.comp_uuid(c ->> 'inspectionId');
        select * into ts from tab.tooling_set where id = ins.set_id;
        if ins.id is null or ts.code is distinct from c ->> 'set' or ins.kind <> (case when c ->> 'when' = 'BEFORE' then 'PRE_USE' else 'POST_USE' end)
           or ins.result is distinct from c ->> 'result' or ins.person_id::text is distinct from v_by #>> '{}' then
          return format('stores %s, which is not an inspection of set %s %s use with result %s that this person recorded in the tooling register (TB09-REGISTER)', v_what,
                        coalesce(c ->> 'set', '(none)'), lower(coalesce(c ->> 'when', '?')), coalesce(c ->> 'result', '(none)'));
        end if;
        if tab.comp_named(p_old, 'TOOLING_INSPECTED', 'inspectionId', ins.id::text) then
          return format('stores %s for inspection %s, which another entry of the batch names (TB09-REGISTER)', v_what, ins.id);
        end if;
        if c ->> 'when' = 'BEFORE' and exists (select 1 from tab.tooling_issue x where x.pre_use_inspection_id = ins.id and x.batch_id <> p_batch) then
          return format('stores %s for inspection %s, which backs the issue of another batch (TB09-REGISTER)', v_what, ins.id);
        end if;
        if c ->> 'when' = 'AFTER' then
          if not exists (select 1 from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'TOOLING_RETURNED')) x
                          where x -> 'data' ->> 'set' = ts.code and x -> 'data' ->> 'issueId' = ins.issue_id::text) then
            return format('stores %s, an after-use inspection of a use of set %s that the step did not return (TB09-NOT-RETURNED)', v_what, ts.code);
          end if;
          if exists (select 1 from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'TOOLING_INSPECTED')) x where x -> 'data' ->> 'set' = ts.code) then
            return format('stores %s, a second after-use inspection of set %s (TB09-INSPECTED-TWICE)', v_what, ts.code);
          end if;
        end if;
        v_want := jsonb_build_object('set', c -> 'set', 'inspectionId', c -> 'inspectionId', 'when', c -> 'when', 'result', c -> 'result', 'inspectedBy', v_by);
        if ins.result = 'FAIL' and c ->> 'when' = 'AFTER' then
          v_held := v_held || 'TOOLING_FAILED_AFTER_USE'::text;
        end if;
        if ins.result = 'FAIL' and c ->> 'when' = 'BEFORE' then
          v_raise := v_raise || 'TOOLING_FAILED_BEFORE_USE'::text;
        end if;
      when 'TB-09 TOOLING_ISSUED' then
        if coalesce(v_cfg ->> 'part', 'ISSUE') <> 'ISSUE' then
          return format('stores %s in a step of the RETURN part (TB09-PART)', v_what);
        end if;
        select * into u from tab.tooling_issue where id = tab.comp_uuid(c ->> 'issueId');
        select * into ts from tab.tooling_set where id = u.set_id;
        select * into eq from plant.equipment where id = u.press_equipment_id;
        if u.id is null or u.batch_id <> p_batch or ts.code is distinct from c ->> 'set' or eq.code is distinct from c ->> 'press'
           or u.person_id::text is distinct from v_by #>> '{}' then
          return format('stores %s, which is not an issue of set %s to this batch for press %s that this person recorded in the tooling register (TB09-REGISTER)', v_what,
                        coalesce(c ->> 'set', '(none)'), coalesce(c ->> 'press', '(none)'));
        end if;
        if tab.comp_named(p_old, 'TOOLING_ISSUED', 'issueId', u.id::text) then
          return format('stores %s for issue %s, which another entry of the batch names (TB09-REGISTER)', v_what, u.id);
        end if;
        if exists (select 1 from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'TOOLING_ISSUED')) x where x -> 'data' ->> 'set' = ts.code) then
          return format('stores %s, a second issue of set %s in the step (TB09-ISSUED-TWICE)', v_what, ts.code);
        end if;
        select x into v_x from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'TOOLING_INSPECTED')) x where x -> 'data' ->> 'set' = ts.code
         order by (x ->> 'recordedSeq')::numeric desc limit 1;
        if v_x is null or v_x -> 'data' ->> 'result' <> 'PASS' or v_x -> 'data' ->> 'inspectionId' <> u.pre_use_inspection_id::text then
          return format('stores %s, an issue of set %s not on the passing inspection before use the step recorded (TB09-NOT-INSPECTED)', v_what, ts.code);
        end if;
        if jsonb_typeof(v_cfg -> 'specification') <> 'object'
           or (ts.tooling_type, ts.shape, ts.upper_embossing, ts.lower_embossing, ts.score)
              is distinct from (v_cfg -> 'specification' ->> 'type', v_cfg -> 'specification' ->> 'shape', v_cfg -> 'specification' ->> 'upperEmbossing',
                                v_cfg -> 'specification' ->> 'lowerEmbossing', v_cfg -> 'specification' ->> 'score') then
          return format('stores %s, an issue of set %s (%s, %s, %s / %s, score %s), which is not the tooling the MBR approves for the product (TB09-SPEC; PR-27)', v_what, ts.code,
                        ts.tooling_type, ts.shape, ts.upper_embossing, ts.lower_embossing, ts.score);
        end if;
        v_want := jsonb_build_object('set', c -> 'set', 'issueId', c -> 'issueId', 'press', c -> 'press', 'inspection', v_x -> 'id', 'issuedBy', v_by);
      when 'TB-09 TOOLING_RETURNED' then
        if coalesce(v_cfg ->> 'part', 'ISSUE') <> 'RETURN' then
          return format('stores %s in a step of the ISSUE part (TB09-PART)', v_what);
        end if;
        select * into r from tab.tooling_return where issue_id = tab.comp_uuid(c ->> 'issueId');
        select * into u from tab.tooling_issue where id = r.issue_id;
        select * into ts from tab.tooling_set where id = u.set_id;
        if r.issue_id is null or u.batch_id <> p_batch or ts.code is distinct from c ->> 'set' or r.person_id::text is distinct from v_by #>> '{}'
           or r.strokes::text is distinct from c ->> 'strokes' or r.stroke_source is distinct from c ->> 'strokeSource'
           or to_jsonb(r.count_mismatch) is distinct from c -> 'countMismatch' or to_jsonb(r.limit_exceeded) is distinct from c -> 'limitExceeded' then
          return format('stores %s, which is not the return of set %s by this batch, with its strokes, count and limit, that this person recorded in the tooling register (TB09-REGISTER)',
                        v_what, coalesce(c ->> 'set', '(none)'));
        end if;
        if not tab.comp_named(p_old, 'TOOLING_ISSUED', 'issueId', u.id::text) or tab.comp_named(p_old, 'TOOLING_RETURNED', 'issueId', u.id::text) then
          return format('stores %s for issue %s, which no issue entry of the batch names or another return entry names (TB09-REGISTER)', v_what, u.id);
        end if;
        if exists (select 1 from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'TOOLING_RETURNED')) x where x -> 'data' ->> 'set' = ts.code) then
          return format('stores %s, a second return of set %s in the step (TB09-RETURNED-TWICE)', v_what, ts.code);
        end if;
        v_want := jsonb_build_object('set', c -> 'set', 'issueId', c -> 'issueId', 'strokes', c -> 'strokes', 'strokeSource', c -> 'strokeSource',
                                     'countMismatch', c -> 'countMismatch', 'limitExceeded', c -> 'limitExceeded', 'returnedBy', v_by);
        if r.count_mismatch then
          v_held := v_held || 'TOOLING_COUNT_MISMATCH'::text;
        end if;
        if r.limit_exceeded then
          v_held := v_held || 'TOOLING_LIMIT_EXCEEDED'::text;
        end if;
      -- ------------------------------------------------------------------------------------------- TB-10
      when 'TB-10 PRESS_SETUP' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'PRESS_SETUP')) > 0 then
          return format('stores %s, a second set-up of the press (TB10-SETUP-TWICE)', v_what);
        end if;
        select * into us from plant.equipment_use_status where id = tab.comp_uuid(c ->> 'useId');
        select * into eq from plant.equipment where id = us.equipment_id;
        if us.id is null or us.batch_id <> p_batch or us.ended_at is not null or eq.code is distinct from c ->> 'press' then
          return format('stores %s, which names no open use of press %s by this batch (TB10-PRESS; PR-23)', v_what, coalesce(c ->> 'press', '(none)'));
        end if;
        v_text := coalesce(tab.step_unit_problem(p_batch, v_step, eq.id),
                           case when plant.equipment_fitness(eq.id) not in ('QUALIFIED', 'CALIBRATION_DUE_SOON') then format('press %s is %s', eq.code, plant.equipment_fitness(eq.id)) end);
        if v_text is not null then
          return format('stores %s: %s (TB10-PRESS; PR-23)', v_what, v_text);
        end if;
        if exists (select 1 from tab.step_device s join tab.process_device_unit x on x.process_device_id = s.process_device_id
                    where s.batch_id = p_batch and s.step = v_step and x.equipment_id <> eq.id)
           or exists (select 1 from tab.step_device s where s.batch_id = p_batch and s.step = v_step
                       and not exists (select 1 from tab.process_device_unit x where x.process_device_id = s.process_device_id)) then
          return format('stores %s for press %s, which is not the unit of the process device the step is bound to (TB10-DEVICE; DI-31)', v_what, eq.code);
        end if;
        select * into u from tab.tooling_issue where id = tab.comp_uuid(c ->> 'issueId');
        if u.id is null or u.batch_id <> p_batch or u.press_equipment_id <> eq.id or not tab.comp_named(p_old, 'TOOLING_ISSUED', 'issueId', u.id::text)
           or tab.comp_named(p_old, 'PRESS_SETUP', 'issueId', u.id::text) then
          return format('stores %s, which names no tooling issued to this batch for press %s by a tooling step of the batch, or one another set-up names (TB10-TOOLING)', v_what, eq.code);
        end if;
        v_text := tab.tooling_use_problem(u.id);
        if v_text is not null then
          return format('stores %s: the tooling may not compress: %s (TB10-TOOLING; INV-24)', v_what, v_text);
        end if;
        v_want := jsonb_build_object('press', c -> 'press', 'useId', c -> 'useId', 'issueId', c -> 'issueId', 'setUpBy', v_by);
      when 'TB-10 PRE_USE_CHECKLIST' then
        v_list := tab.comp_checklist(v_cfg);
        if jsonb_typeof(c -> 'items') <> 'array'
           or (select count(*) from jsonb_array_elements(c -> 'items') i) <> cardinality(v_list)
           or (select count(distinct i ->> 'item') from jsonb_array_elements(c -> 'items') i) <> cardinality(v_list)
           or exists (select 1 from unnest(v_list) w where not exists (select 1 from jsonb_array_elements(c -> 'items') i where i ->> 'item' = w)) then
          return format('stores %s, which does not record each of %s once (TB10-CHECKLIST)', v_what, array_to_string(v_list, ', '));
        end if;
        select jsonb_agg(jsonb_build_object('item', w, 'ok', coalesce((select (i -> 'ok') = 'true'::jsonb from jsonb_array_elements(c -> 'items') i where i ->> 'item' = w limit 1), false))
                         order by n)
          into v_x from unnest(v_list) with ordinality t (w, n);
        v_want := jsonb_build_object('items', v_x, 'allOk', not exists (select 1 from jsonb_array_elements(v_x) i where (i -> 'ok') <> 'true'::jsonb), 'checkedBy', v_by);
      when 'TB-10 HOPPER_CHARGE' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'PRESS_SETUP')) = 0 then
          return format('stores %s before the press was set up (TB10-NO-SETUP)', v_what);
        end if;
        select * into g from plant.container_charge where id = tab.comp_uuid(c ->> 'chargeId');
        if g.id is null or g.batch_id <> p_batch or g.purpose <> 'CHARGE' or g.person_id::text is distinct from v_by #>> '{}'
           or tab.comp_named(p_old, 'HOPPER_CHARGE', 'chargeId', g.id::text) then
          return format('stores %s, which names no charge scan of this batch by this person that no other entry names (TB10-CHARGE; IN-26 (c))', v_what);
        end if;
        v_want := jsonb_build_object('chargeId', c -> 'chargeId', 'chargedBy', v_by);
      when 'TB-10 FIRST_OFF' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'PRESS_SETUP')) = 0 then
          return format('stores %s before the press was set up (TB10-NO-SETUP)', v_what);
        end if;
        select x into v_x from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'PRE_USE_CHECKLIST')) x order by (x ->> 'recordedSeq')::numeric desc limit 1;
        if (v_x -> 'data' -> 'allOk') is distinct from 'true'::jsonb then
          return format('stores %s before a pre-use checklist all in order (TB10-CHECKLIST-OPEN)', v_what);
        end if;
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'HOPPER_CHARGE')) = 0 then
          return format('stores %s before the hopper was charged by scan (TB10-NOT-CHARGED)', v_what);
        end if;
        v_want := jsonb_build_object('result', c -> 'result') || case when jsonb_typeof(c -> 'observations') = 'string' then jsonb_build_object('observations', c -> 'observations') else '{}'::jsonb end
                  || jsonb_build_object('recordedBy', v_by);
        v_verify := true;
        if c ->> 'result' = 'FAIL' then
          v_raise := v_raise || 'FIRST_OFF_FAILED'::text;
        end if;
      when 'TB-10 SETTING_CHANGE' then
        if jsonb_array_length(tab.gran_prior(p_new, v_key, v_seq, 'PRESS_SETUP')) = 0 then
          return format('stores %s before the press was set up (TB10-NO-SETUP)', v_what);
        end if;
        select s into v_x from jsonb_array_elements(case when jsonb_typeof(v_cfg -> 'settingRanges') = 'array' then v_cfg -> 'settingRanges' else '[]'::jsonb end) s
         where s ->> 'tag' = c ->> 'tag' limit 1;
        if v_x is null then
          return format('stores %s for %s, which has no approved range in the MBR (TB10-SETTING-TAG)', v_what, coalesce(c ->> 'tag', '(none)'));
        end if;
        if (v_x ->> 'unit') is distinct from c ->> 'unit' then
          return format('stores %s in %s; the MBR approves %s in %s (TB10-SETTING-UNIT)', v_what, coalesce(c ->> 'unit', '(none)'), v_x ->> 'tag', v_x ->> 'unit');
        end if;
        v_ok := (c ->> 'value')::numeric between (v_x ->> 'min')::numeric and (v_x ->> 'max')::numeric;
        v_want := jsonb_build_object('tag', c -> 'tag', 'value', c -> 'value', 'unit', c -> 'unit', 'reason', c -> 'reason', 'withinRange', v_ok, 'changedBy', v_by);
        if not v_ok then
          v_held := v_held || 'SETTING_OUT_OF_RANGE'::text;
        end if;
      -- ------------------------------------------------------------------------------------------- TB-17
      when 'TB-17 CHALLENGE' then
        v_x := tab.comp_device(v_cfg, c ->> 'device');
        if v_x is null then
          return format('stores %s for a %s the MBR does not configure (TB17-DEVICE)', v_what, coalesce(c ->> 'device', '(none)'));
        end if;
        select * into ch from tab.detector_challenge where id = tab.comp_uuid(c ->> 'challengeId');
        if ch.id is null or ch.batch_id <> p_batch or ch.device is distinct from c ->> 'device' or ch.timing is distinct from c ->> 'timing'
           or to_jsonb(ch.passed) is distinct from c -> 'passed' or ch.device_code is distinct from v_x ->> 'device' or ch.person_id::text is distinct from v_by #>> '{}'
           or tab.comp_named(p_old, 'CHALLENGE', 'challengeId', ch.id::text) then
          return format('stores %s, which is not a %s challenge of %s for this batch that this person recorded in the challenge register and no other entry names (TB17-REGISTER)',
                        v_what, coalesce(c ->> 'device', '?'), coalesce(v_x ->> 'device', '?'));
        end if;
        if ch.device = 'METAL_DETECTOR'
           and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_x -> 'pieces') = 'array' then v_x -> 'pieces' else '[]'::jsonb end) want
                        where not exists (select 1 from jsonb_array_elements(ch.pieces) got
                                           where got ->> 'kind' = want ->> 'kind' and got -> 'size' ->> 'unit' = want -> 'size' ->> 'unit'
                                             and (got -> 'size' ->> 'value')::numeric = (want -> 'size' ->> 'value')::numeric)) then
          return format('stores %s, a metal-detector challenge without a test piece of every kind and size the MBR names (TB17-PIECES; IN-36 (e))', v_what);
        end if;
        select x into v_x from jsonb_array_elements(tab.gran_prior(p_new, v_key, v_seq, 'CHALLENGE')) x where x -> 'data' ->> 'device' = ch.device
         order by (x ->> 'recordedSeq')::numeric desc limit 1;
        if (v_x is null) <> (ch.timing = 'START') then
          return format('stores %s, a %s challenge, but the first challenge of a device is its START challenge and comes once (TB17-START-FIRST)', v_what, ch.timing);
        end if;
        if v_x -> 'data' ->> 'timing' = 'END' then
          return format('stores %s after the END challenge of the %s (TB17-AFTER-END)', v_what, ch.device);
        end if;
        v_n := case when jsonb_typeof(tab.comp_device(v_cfg, ch.device) -> 'intervalMinutes') = 'number'
                    then (tab.comp_device(v_cfg, ch.device) ->> 'intervalMinutes')::numeric else 120 end * 60000000;
        if v_x is not null and v_now - recipe.micros_of(v_x -> 'recordedAt') > v_n then
          v_held := v_held || 'CHALLENGE_OVERDUE'::text;
        end if;
        if not ch.passed then
          v_held := v_held || 'DETECTOR_CHALLENGE_FAILED'::text;
        end if;
        v_want := jsonb_build_object('challengeId', c -> 'challengeId', 'device', c -> 'device', 'timing', c -> 'timing', 'passed', c -> 'passed', 'recordedBy', v_by);
      when 'TB-17 REJECT_COUNT' then
        if not (c ->> 'device' = 'SETUP' or (c ->> 'device' = 'DEDUSTER' and jsonb_typeof(v_cfg -> 'deDuster') = 'string')
                or tab.comp_device(v_cfg, c ->> 'device') is not null) then
          return format('stores %s for a %s the MBR does not configure (TB17-DEVICE)', v_what, coalesce(c ->> 'device', '(none)'));
        end if;
        v_want := jsonb_build_object('device', c -> 'device', 'count', c -> 'count', 'disposition', c -> 'disposition', 'recordedBy', v_by);
      when 'TB-17 DEDUSTING' then
        if (c -> 'deDuster') is distinct from (v_cfg -> 'deDuster') then
          return format('stores %s for %s, which is not the de-duster the MBR names (TB17-DEDUSTER)', v_what, coalesce(c ->> 'deDuster', '(none)'));
        end if;
        v_want := jsonb_build_object('deDuster', c -> 'deDuster', 'inUse', c -> 'inUse', 'recordedBy', v_by);
      else
        return format('stores %s, which is not an entry of a %s step (%s-ENTRY)', v_what, v_type, replace(v_type, '-', ''));
    end case;
    if d <> v_want then
      return format('stores %s with data the block does not build from what was entered (%s, not %s)', v_what, d::text, v_want::text);
    end if;
    foreach v_t in array v_held loop
      if not tab.gran_held(p_old, p_new, v_key, v_t) then
        return format('stores %s without %s waiting for a deviation (as its block raises it)', v_what, v_t);
      end if;
    end loop;
    foreach v_t in array v_raise loop
      if not tab.comp_raised_new(p_old, p_new, v_key, v_t) then
        return format('stores %s without %s (as its block raises it)', v_what, v_t);
      end if;
    end loop;
    if v_verify and (p_new -> 'steps' -> v_key -> 'verificationRequired') is distinct from 'true'::jsonb then
      return format('stores %s without making the step need its check (the first-off approval)', v_what);
    end if;
  end loop;
  return null;
end
$$;

-- IN-36, INV-24, IN-35, PR-23: why a compression step of batch p_batch closes incomplete in row p_new (header, item 2).
create function tab.compression_close_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable set search_path = pg_catalog, tab, plant, recipe, pg_temp as $$
declare
  k       text;
  s       jsonb;
  v_node  jsonb;
  v_type  text;
  v_cfg   jsonb;
  v_all   jsonb;
  v_text  text;
  v_x     jsonb;
  v_dev   text;
  us      plant.equipment_use_status;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(p_content, s ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-09', 'TB-10', 'TB-17') then
      continue;
    end if;
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_all := tab.gran_prior(p_new, k, 'Infinity'::numeric, null);
    v_text := null;
    case v_type
      when 'TB-09' then
        if coalesce(v_cfg ->> 'part', 'ISSUE') = 'ISSUE' then
          if not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'TOOLING_ISSUED') then
            v_text := 'it issued no tooling set (TB09-NOT-ISSUED)';
          end if;
        else
          select string_agg(e -> 'data' ->> 'set', ', ') into v_text from jsonb_array_elements(v_all) e
           where e ->> 'kind' = 'TOOLING_RETURNED'
             and not exists (select 1 from jsonb_array_elements(v_all) i where i ->> 'kind' = 'TOOLING_INSPECTED' and i -> 'data' ->> 'set' = e -> 'data' ->> 'set');
          v_text := case when v_text is not null then format('set %s has no inspection after use (TB09-AFTER-CHECK-MISSING; IN-36 (b))', v_text)
                         when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'TOOLING_RETURNED') then 'it returned no tooling set (TB09-NOT-RETURNED)' end;
        end if;
      when 'TB-10' then
        select e into v_x from jsonb_array_elements(v_all) e where e ->> 'kind' = 'PRESS_SETUP' limit 1;
        if v_x is null then
          v_text := 'the press is not set up (TB10-NO-SETUP)';
        else
          select * into us from plant.equipment_use_status where id = tab.comp_uuid(v_x -> 'data' ->> 'useId');
          v_text := coalesce(
            case when us.ended_at is not null then format('the use of press %s has ended (TB10-PRESS)', v_x -> 'data' ->> 'press') end,
            case when plant.equipment_fitness(us.equipment_id) not in ('QUALIFIED', 'CALIBRATION_DUE_SOON')
                 then format('press %s is %s (TB10-PRESS; PR-23)', v_x -> 'data' ->> 'press', plant.equipment_fitness(us.equipment_id)) end,
            (select format('the tooling may not compress: %s (TB10-TOOLING; INV-24)', p) from tab.tooling_use_problem(tab.comp_uuid(v_x -> 'data' ->> 'issueId')) p where p is not null));
        end if;
        if v_text is null then
          select e into v_x from jsonb_array_elements(v_all) e where e ->> 'kind' = 'PRE_USE_CHECKLIST' order by (e ->> 'recordedSeq')::numeric desc limit 1;
          v_text := case
            when (v_x -> 'data' -> 'allOk') is distinct from 'true'::jsonb then 'the pre-use checklist is not all in order (TB10-CHECKLIST-OPEN)'
            when not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'HOPPER_CHARGE') then 'the hopper was not charged by scan (TB10-NOT-CHARGED)'
            when (select e -> 'data' ->> 'result' from jsonb_array_elements(v_all) e where e ->> 'kind' = 'FIRST_OFF' order by (e ->> 'recordedSeq')::numeric desc limit 1)
                 is distinct from 'PASS' then 'its last first-off check did not pass (TB10-FIRST-OFF)'
          end;
        end if;
      when 'TB-17' then
        foreach v_dev in array array['METAL_DETECTOR', 'REJECT_GATE'] loop
          continue when tab.comp_device(v_cfg, v_dev) is null or v_text is not null;
          select e into v_x from jsonb_array_elements(v_all) e where e ->> 'kind' = 'CHALLENGE' and e -> 'data' ->> 'device' = v_dev
           order by (e ->> 'recordedSeq')::numeric desc limit 1;
          if v_x -> 'data' ->> 'timing' is distinct from 'END' or (v_x -> 'data' -> 'passed') is distinct from 'true'::jsonb then
            v_text := format('the %s has no passing END challenge (TB17-END-CHALLENGE; IN-36 (e))', v_dev);
          elsif not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'REJECT_COUNT' and e -> 'data' ->> 'device' = v_dev) then
            v_text := format('the rejects of the %s are not counted (TB17-NO-REJECT-COUNT; IN-35 (f))', v_dev);
          end if;
        end loop;
        if v_text is null and jsonb_typeof(v_cfg -> 'deDuster') = 'string'
           and not exists (select 1 from jsonb_array_elements(v_all) e where e ->> 'kind' = 'DEDUSTING' and (e -> 'data' -> 'inUse') = 'true'::jsonb) then
          v_text := 'the de-duster is not recorded in use (TB17-NO-DEDUSTING; IN-35 (e))';
        end if;
    end case;
    if v_text is not null then
      return format('closes step %s, but %s', k, v_text);
    end if;
  end loop;
  return null;
end
$$;

-- DI-31, PR-14: why a step on a process device of batch p_batch closes in row p_new with an interface loss the job
-- recorded and no INTERFACE_LOSS entry of the step made after it (header, item 3).
create function tab.interface_loss_close_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k  text;
  s  jsonb;
  l  tab.interface_loss;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    if not exists (select 1 from tab.process_block_type t where t.block_type = recipe.step_node(p_content, s ->> 'step') -> 'block' ->> 'type') then
      continue;
    end if;
    for l in select * from tab.interface_loss x where x.batch_id = p_batch and x.step = s ->> 'step' order by x.detected_at loop
      if not exists (select 1 from jsonb_array_elements(tab.gran_prior(p_new, k, 'Infinity'::numeric, 'INTERFACE_LOSS')) e
                      where recipe.micros_of(e -> 'recordedAt') >= l.detected_us) then
        return format('closes step %s, but the link to its device was lost (no reading since %s, found at %s) and no INTERFACE_LOSS entry of the step answers it',
                      k, coalesce(l.last_received_us::text, 'its binding'), l.detected_us);
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- Review 3c finding 1 (INV-24): why the tooling press p_press was set up with in state p_state (the latest PRESS_SETUP of a
-- TB-10 step of the batch on that press) may not compress now: returned, retired, failed, or its strokes with this use at
-- or past its limit (tab.tooling_use_problem); NULL when it may, or when no TB-10 step set the press up. TB-11's RUN_START
-- (tablets 0893) and every other start of compression call it, so a run never starts on tooling past its limit or
-- already returned.
create function tab.press_tooling_problem(p_content jsonb, p_state jsonb, p_press text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_issue uuid;
  v_text  text;
begin
  select tab.comp_uuid(e.value -> 'data' ->> 'issueId') into v_issue
    from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) e
   where e.value ->> 'kind' = 'PRESS_SETUP' and e.value -> 'data' ->> 'press' = p_press
     and recipe.step_node(p_content, p_state -> 'steps' -> (e.value ->> 'stepKey') ->> 'step') -> 'block' ->> 'type' = 'TB-10'
   order by (e.value ->> 'recordedSeq')::numeric desc limit 1;
  if v_issue is null then
    return null;
  end if;
  v_text := tab.tooling_use_problem(v_issue);
  return case when v_text is not null then format('the tooling press %s was set up with may not compress: %s (TB10-TOOLING; INV-24)', p_press, v_text) end;
end
$$;
revoke all on function tab.press_tooling_problem(jsonb, jsonb, text) from public;

-- The row trigger (header).
create function tab.compression_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_mine    boolean;
  v_problem text;
  v_code    text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  v_mine := exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                     where p -> 'block' ->> 'type' in ('TB-09', 'TB-10', 'TB-17'));
  if not v_mine and not exists (select 1 from tab.interface_loss x where x.batch_id = new.batch_id) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if v_mine then
    v_problem := tab.compression_entry_problem(new.batch_id, v_content, old.state, new.state, r.command);
    v_code := 'EBMR-EXE-260';
    if v_problem is null then
      v_problem := tab.compression_close_problem(new.batch_id, v_content, old.state, new.state);
      v_code := 'EBMR-EXE-261';
    end if;
  end if;
  if v_problem is null then
    v_problem := tab.interface_loss_close_problem(new.batch_id, v_content, old.state, new.state);
    v_code := 'EBMR-EXE-262';
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a compression step records what its registers hold, closes only complete and with its tooling fit, and a lost device link is answered (INV-24, IN-26, IN-35, IN-36, PR-23, DI-31). [%s]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem, v_code);
  end if;
  return null;
end
$$;

create trigger zt_tab_compression after update on recipe.execution_state
  for each row execute function tab.compression_state_check();

-- As tablets 0845, with every Tablets edition block (TB-xx) never skipped.
create or replace function recipe.skip_problem(p_content jsonb, p_node jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_items text[];
  v_item  text;
begin
  if p_node is null then
    return 'the step is not a step of the batch''s MBR';
  end if;
  if p_node ->> 'kind' is distinct from 'phase' then
    return 'it is a QA hold point: release signatures are never skipped';
  end if;
  if (p_node -> 'config' -> 'skippable') is distinct from 'true'::jsonb then
    return 'the MBR does not declare it skippable';
  end if;
  if p_node -> 'block' ->> 'type' in ('G-07', 'G-08', 'G-10', 'G-20', 'G-24', 'G-25') or p_node -> 'block' ->> 'type' ~ '^TB-[0-9]{2}$' then
    return format('it is a step of block %s: line clearance, dispensing, charge-in, reconciliation, reprocessing, sign-off and the tablet material-processing steps are never skipped', p_node -> 'block' ->> 'type');
  end if;
  if exists (select 1 from unnest(array['consumes', 'produces', 'uses']) k
              where jsonb_typeof(p_node -> k) is distinct from 'array' or jsonb_array_length(p_node -> k) > 0)
     or (p_node ? 'yieldCheckpoint' and (p_node -> 'yieldCheckpoint') <> 'null'::jsonb)
     or (p_node ? 'acceptanceScheme' and (p_node -> 'acceptanceScheme') <> 'null'::jsonb) then
    return 'it moves material or carries a yield or acceptance check';
  end if;
  v_items := array(select jsonb_array_elements_text(case when jsonb_typeof(p_node -> 'records') = 'array' then p_node -> 'records' else '[]' end));
  foreach v_item in array v_items loop
    if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_content -> 'parameters') = 'array' then p_content -> 'parameters' else '[]' end) p
                    where p ->> 'id' = v_item and p ->> 'criticality' = 'NON_CRITICAL') then
      return format('it records %s, which is not declared NON_CRITICAL: CPP and CQA inputs are never skipped', v_item);
    end if;
  end loop;
  v_items := v_items || array(select jsonb_array_elements_text(case when jsonb_typeof(p_node -> 'computes') = 'array' then p_node -> 'computes' else '[]' end));
  foreach v_item in array v_items loop
    if jsonb_path_exists(p_content -> 'procedure', 'strict $.** ? (@.reads.type() == "array" && exists (@.reads[*] ? (@ == $item)))', jsonb_build_object('item', v_item)) then
      return format('it writes %s, which another step reads', v_item);
    end if;
  end loop;
  return null;
end
$$;

revoke all on function tab.comp_raised_new(jsonb, jsonb, text, text), tab.comp_named(jsonb, text, text, text), tab.comp_uuid(text), tab.comp_checklist(jsonb),
  tab.comp_device(jsonb, text), tab.compression_entry_problem(uuid, jsonb, jsonb, jsonb, jsonb), tab.compression_close_problem(uuid, jsonb, jsonb, jsonb),
  tab.interface_loss_close_problem(uuid, jsonb, jsonb, jsonb), tab.compression_state_check() from public;

reset role;
