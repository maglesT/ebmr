-- Recipe core, Phase 3 slice 5b (reprocessing and recovery; D-S5-8; controls PR-47, IN-19; ADR 0012). Part 4: G-24@2
-- starts on the quality unit's signed authorisation in the database, not on start data.
--
-- G-24@1 starts only with start data naming its authorisation (recipe-core 0330, G24-NOT-AUTHORISED), and an accepted
-- START_STEP never records start data (recipe-core 0345: the server sends none), so a G-24@1 reprocessing step other
-- than a validated re-treatment cannot be started at all; that stands. G-24@2 takes no start data: its start is held by
-- recipe-core 0622 (recipe.g24v2_check), which requires a signed STEP authorisation of the batch, the step and its case
-- (recipe.reprocessing_authorisation, 0621), given by someone other than the person who starts the step.
--
--   * recipe.entry_block_problem (CREATE OR REPLACE from recipe-core 0580, the latest): unchanged but for its last rule,
--     the start-data requirement of a G-24 step, which now applies to G-24 version 1 only.
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner) and the privileges (none for PUBLIC). Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- As recipe-core 0580, with the G-24 start-data rule for version 1 only (header).
create or replace function recipe.entry_block_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_now     jsonb := p_new -> 'lastRecordedUs';
  v_now_us  numeric := recipe.micros_of(p_new -> 'lastRecordedUs');
  v_seq0    numeric := case when jsonb_typeof(p_old -> 'seq') = 'number' then (p_old ->> 'seq')::numeric else 0 end;
  v_seq1    numeric := case when jsonb_typeof(p_new -> 'seq') = 'number' then (p_new ->> 'seq')::numeric end;
  v_product jsonb := p_content -> 'header' -> 'product' -> 'code';
  v_batch   jsonb := p_new -> 'header' -> 'batchNumber';
  k         text;
  e         jsonb;
  d         jsonb;
  c         jsonb;
  v_inst    jsonb;
  v_node    jsonb;
  v_cfg     jsonb;
  v_rp      jsonb;
  v_ref     jsonb;
  v_by      jsonb;
  v_want    jsonb;
  v_what    text;
  v_member  text;
  v_problem text;
  v_ids     text[];
  v_items   jsonb;
  v_sub     jsonb;
  v_n       bigint;
  v_cat     text;
  v_verify  boolean;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by x.key loop
    v_what := format('entry %s (%s) of step %s', k, coalesce(e ->> 'kind', 'unnamed'), coalesce(e ->> 'stepKey', '(none)'));
    -- The entry record the engine writes (steps.ts recordEntry, startStep): its own id, the row's time, its event.
    if jsonb_typeof(e) is distinct from 'object' then
      return format('stores %s, which is no entry record', v_what);
    end if;
    if (e - 'id' - 'stepKey' - 'kind' - 'data' - 'enteredBy' - 'recordedAt' - 'recordedSeq') <> '{}'::jsonb then
      return format('stores %s with members the engine does not write (%s)', v_what,
                    (select string_agg(m, ', ' order by m) from jsonb_object_keys(e - 'id' - 'stepKey' - 'kind' - 'data' - 'enteredBy' - 'recordedAt' - 'recordedSeq') m));
    end if;
    if (e -> 'id') is distinct from to_jsonb(k) then
      return format('stores %s under another id (%s)', v_what, coalesce(e ->> 'id', '(none)'));
    end if;
    if (e -> 'recordedAt') is distinct from v_now or v_now is null then
      return format('stores %s recorded at %s, not at the row''s trusted time %s', v_what, coalesce(recipe.micros_of(e -> 'recordedAt')::text, '(none)'), coalesce(v_now_us::text, '(none)'));
    end if;
    if jsonb_typeof(e -> 'recordedSeq') is distinct from 'number' or (e ->> 'recordedSeq')::numeric <= v_seq0 or v_seq1 is null or (e ->> 'recordedSeq')::numeric > v_seq1 then
      return format('stores %s with recordedSeq %s, which is not an event of this row (after %s, up to %s)', v_what, coalesce(e ->> 'recordedSeq', '(none)'), v_seq0, coalesce(v_seq1::text, '(none)'));
    end if;
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    c := case when e ->> 'kind' = 'START_DATA' then p_command -> 'blockData' else p_command -> 'entry' end;
    c := case when jsonb_typeof(c) = 'object' then c else '{}'::jsonb end;
    v_by := e -> 'enteredBy';
    v_inst := p_new -> 'steps' -> (e ->> 'stepKey');
    v_node := recipe.step_node(p_content, v_inst ->> 'step');
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_rp := v_node -> 'reprocessing';
    v_want := null;
    v_verify := false;
    if v_node -> 'block' ->> 'type' = 'G-21' and e ->> 'kind' <> 'START_DATA' then
      -- G-21 (0580): what blocks/generic/printed.ts builds from the entry, its step's configuration, the step instance's
      -- earlier entries, the batch's market set, the row's time and the person. Gated by the block, as TB-17 records a
      -- CHALLENGE of its own.
      v_ref := recipe.g21_entry_data(v_cfg, c, e ->> 'kind',
                                     (select coalesce(jsonb_agg(x.value order by x.key), '[]'::jsonb) from jsonb_each(e0) x where x.value ->> 'stepKey' = e ->> 'stepKey'),
                                     p_new -> 'header' -> 'marketSet', v_now_us, v_by);
      if v_ref ? 'problem' then
        return format('stores %s that %s', v_what, v_ref ->> 'problem');
      end if;
      v_want := v_ref -> 'data';
      v_verify := coalesce((v_ref -> 'verify') = 'true'::jsonb, false);
    else
    case e ->> 'kind'
      when 'START_DATA' then
        v_want := c;
        if v_node -> 'block' ->> 'type' = 'G-24' and (d -> 'authorisedBy') = v_by then
          return format('stores %s authorised by the person who starts the step; a reprocessing is authorised by the quality unit (G24-SELF-AUTHORISED)', v_what);
        end if;
      when 'ACKNOWLEDGE' then
        -- G-03: the configuration's mode; the SOP reference its configuration names, with its code, version and hash.
        if jsonb_typeof(v_cfg -> 'sop') = 'string' then
          select r.v into v_ref
            from jsonb_array_elements(case when jsonb_typeof(p_content -> 'references') = 'array' then p_content -> 'references' else '[]'::jsonb end) with ordinality r (v, i)
           where r.v -> 'id' = v_cfg -> 'sop' order by r.i limit 1;
        else
          v_ref := null;
        end if;
        v_want := jsonb_build_object('mode', case when coalesce(v_cfg -> 'acknowledgement', 'null'::jsonb) = 'null'::jsonb then '"READ"'::jsonb else v_cfg -> 'acknowledgement' end,
                                     'acknowledgedBy', v_by);
        if jsonb_typeof(v_ref) = 'object' then
          v_want := v_want || recipe.json_pick(v_ref, array['code']) || recipe.json_pick(v_ref, array['version'])
                    || jsonb_build_object('sopHash', coalesce(v_ref -> 'hash', 'null'::jsonb));
          if v_want ? 'code' then
            v_want := (v_want - 'code') || jsonb_build_object('sop', v_ref -> 'code');
          end if;
          if v_want ? 'version' then
            v_want := (v_want - 'version') || jsonb_build_object('sopVersion', v_ref -> 'version');
          end if;
        end if;
      when 'EQUIPMENT_STATUS' then
        v_ids := recipe.status_check_ids(v_cfg);
        v_problem := recipe.checklist_answer_problem(recipe.checklist_answers(c -> 'answers'), v_ids);
        if v_problem is not null then
          return format('stores %s that %s (G09-ANSWERS)', v_what, v_problem);
        end if;
        v_want := jsonb_build_object('equipmentRef', c -> 'equipmentRef', 'labelId', c -> 'labelId', 'answers', recipe.checklist_answers(c -> 'answers'),
                                     'passed', not exists (select 1 from jsonb_array_elements(recipe.checklist_answers(c -> 'answers')) a where a -> 'answer' = '"NO"'::jsonb),
                                     'attestedBy', v_by);
      when 'CLEARANCE_CHECK' then
        v_items := recipe.clearance_items(v_cfg);
        v_ids := array(select i ->> 'id' from jsonb_array_elements(v_items) i);
        v_problem := recipe.checklist_answer_problem(recipe.checklist_answers(c -> 'answers'), v_ids);
        if v_problem is not null then
          return format('stores %s that %s (G10-ANSWERS)', v_what, v_problem);
        end if;
        select string_agg(a ->> 'id', ', ') into v_problem
          from jsonb_array_elements(recipe.checklist_answers(c -> 'answers')) a
          join jsonb_array_elements(v_items) i on i -> 'id' = a -> 'id'
         where a -> 'answer' = '"NOT_APPLICABLE"'::jsonb and i ->> 'expected' <> 'CONFIRMED_OR_NOT_APPLICABLE';
        if v_problem is not null then
          return format('stores %s that answers %s not applicable, which its step''s list requires confirmed (G10-NOT-APPLICABLE)', v_what, v_problem);
        end if;
        v_want := jsonb_build_object('answers', recipe.checklist_answers(c -> 'answers'),
                                     'passed', not exists (select 1 from jsonb_array_elements(recipe.checklist_answers(c -> 'answers')) a where a -> 'answer' = '"NOT_CONFIRMED"'::jsonb),
                                     'checkedBy', v_by);
        v_verify := true;
      when 'PREVIOUS_BATCH' then
        v_want := jsonb_build_object('product', c -> 'product', 'batchNumber', c -> 'batchNumber', 'recordedBy', v_by);
      when 'CONTAINER_WEIGHING' then
        v_problem := recipe.lot_usability_problem(p_content, c -> 'bomLine', c -> 'lot', v_now_us, p_new -> 'header' -> 'marketSet');
        if v_problem is not null then
          return format('stores %s whose %s', v_what, v_problem);
        end if;
        v_want := (c - 'kind') || recipe.json_pick(d, array['net', 'label']);
        v_verify := coalesce((c -> 'source') = '"MANUAL"'::jsonb, false);
      when 'CHARGE_LOT' then
        v_problem := recipe.lot_usability_problem(p_content, c -> 'bomLine', c -> 'lot', v_now_us, p_new -> 'header' -> 'marketSet');
        if v_problem is not null then
          return format('stores %s whose %s', v_what, v_problem);
        end if;
        v_want := jsonb_build_object('bomLine', c -> 'bomLine', 'container', c -> 'container', 'lot', c -> 'lot')
                  || case when jsonb_typeof(c -> 'quantity') = 'object' then jsonb_build_object('quantity', c -> 'quantity') else '{}'::jsonb end;
      when 'CHARGE_CONTAINER' then
        v_want := jsonb_build_object('container', c -> 'container') || recipe.json_pick(d, array['holds']);
      when 'OUTPUT_CONTAINER' then
        v_want := (c - 'kind' - 'container') || jsonb_build_object('status', 'QUARANTINE') || recipe.json_pick(d, array['container', 'net', 'item']);
        v_verify := coalesce((c -> 'source') = '"MANUAL"'::jsonb, false);
      when 'DISPOSAL' then
        -- G-23 keeps the whole entry as sent, its kind included.
        v_cat := c ->> 'category';
        if (c -> 'batchCoded') = 'true'::jsonb and v_cat = 'RETURN_TO_STORES' then
          return format('stores %s returning batch-coded %s to stores; batch-coded leftovers are only destroyed (G23-BATCH-CODED)', v_what, coalesce(c ->> 'material', '(material)'));
        end if;
        if v_cat = 'DESTRUCTION' and jsonb_typeof(c -> 'method') is distinct from 'string' then
          return format('stores %s, a destruction that names no method (G23-METHOD)', v_what);
        end if;
        if v_cat = 'REJECT_CONTAINER' and jsonb_typeof(c -> 'container') is distinct from 'string' then
          return format('stores %s, a reject held in no identified container (G23-CONTAINER)', v_what);
        end if;
        if v_cat = 'DESTRUCTION' and (v_cfg -> 'witness') is distinct from 'false'::jsonb
           and (v_node -> 'signatures' -> 'check' ->> 'meaning') is distinct from 'WITNESSED' then
          return format('stores %s, a destruction at a step whose check is not a witness (G23-WITNESS)', v_what);
        end if;
        v_want := c;
      when 'SAMPLE' then
        -- G-12: of the step's sampling plan; the id and label the block builds.
        if jsonb_typeof(v_node -> 'sampling') = 'array' and jsonb_array_length(v_node -> 'sampling') > 0 then
          v_items := (select jsonb_agg(jsonb_build_object('point', s -> 'point', 'purpose', s -> 'purpose')) from jsonb_array_elements(v_node -> 'sampling') s);
        elsif jsonb_typeof(v_cfg -> 'locations') = 'number' then
          v_items := (select coalesce(jsonb_agg(jsonb_build_object('point', 'L' || g, 'purpose', case when jsonb_typeof(v_cfg -> 'purpose') = 'string' then v_cfg -> 'purpose' else '"SAMPLE"'::jsonb end) order by g), '[]'::jsonb)
                        from generate_series(1, greatest(floor((v_cfg ->> 'locations')::numeric), 0)::integer) g);
        else
          v_items := '[]'::jsonb;
        end if;
        if jsonb_array_length(v_items) > 0
           and not exists (select 1 from jsonb_array_elements(v_items) s where s -> 'point' = c -> 'point' and s -> 'purpose' = c -> 'purpose') then
          return format('stores %s taken at point %s for %s, which is not in the sampling plan of its step (G12-NOT-PLANNED)', v_what, coalesce(c ->> 'point', '(none)'), coalesce(c ->> 'purpose', '(none)'));
        end if;
        select count(*) into v_n from jsonb_each(e0) x where x.value ->> 'stepKey' = e ->> 'stepKey' and x.value ->> 'kind' = 'SAMPLE';
        -- The innermost sub-lot whose frames begin the step instance's (engine view.ts: the inner replicate frame's).
        select s.value -> 'id' into v_sub
          from jsonb_each(case when jsonb_typeof(p_new -> 'subLots') = 'object' then p_new -> 'subLots' else '{}'::jsonb end) s
         where jsonb_typeof(s.value -> 'frames') = 'array' and jsonb_array_length(s.value -> 'frames') > 0
           and (select coalesce(jsonb_agg(f.v order by f.i), '[]'::jsonb)
                  from jsonb_array_elements(case when jsonb_typeof(v_inst -> 'frames') = 'array' then v_inst -> 'frames' else '[]'::jsonb end) with ordinality f (v, i)
                 where f.i <= jsonb_array_length(s.value -> 'frames')) = s.value -> 'frames'
         order by jsonb_array_length(s.value -> 'frames') desc limit 1;
        v_member := (v_batch #>> '{}') || '/' || (v_inst ->> 'step') || coalesce('/' || (v_sub #>> '{}'), '') || '/S' || (v_n + 1);
        v_want := jsonb_build_object('sampleId', v_member, 'point', c -> 'point', 'purpose', c -> 'purpose', 'units', c -> 'units')
                  || case when jsonb_typeof(c -> 'container') = 'string' and c ->> 'container' <> '' then jsonb_build_object('container', c -> 'container') else '{}'::jsonb end
                  || jsonb_build_object('label', jsonb_build_object('product', v_product, 'batch', v_batch, 'sample', v_member, 'sampler', v_by, 'takenAtUs', to_jsonb(v_now_us::text)));
      when 'TRANSFER_ISSUED', 'TRANSFER_RECEIVED' then
        v_want := c || jsonb_build_object('by', v_by);
      when 'SOURCE_ADDITION' then
        -- G-24: only at a recovery or reprocessing-addition step, of the batch's product, within the MBR's limits.
        if (v_rp ->> 'case') is distinct from 'RECOVERY' and (v_rp ->> 'case') is distinct from 'REPROCESSING_ADDITION' then
          return format('stores %s at a step that is no recovery or reprocessing-addition step (G24-NO-ADDITION)', v_what);
        end if;
        if (c -> 'productCode') is distinct from v_product then
          return format('stores %s of material of product %s added to a batch of %s (G24-OTHER-PRODUCT)', v_what, coalesce(c ->> 'productCode', '(none)'), coalesce(v_product #>> '{}', '(none)'));
        end if;
        if (c -> 'containsRecovered') = 'true'::jsonb then
          return format('stores %s from batch %s, which itself contains recovered material (G24-CHAINED)', v_what, coalesce(c ->> 'sourceBatch', '(none)'));
        end if;
        if jsonb_typeof(c -> 'manufacturedAtUs') = 'string' and (c ->> 'manufacturedAtUs') ~ '^[0-9]{1,20}$' and recipe.duration_us(v_rp -> 'maxAge') is not null
           and v_now_us - (c ->> 'manufacturedAtUs')::numeric > recipe.duration_us(v_rp -> 'maxAge') then
          return format('stores %s from batch %s, which is older than the MBR''s maximum of %s %s (G24-TOO-OLD)', v_what, coalesce(c ->> 'sourceBatch', '(none)'), v_rp -> 'maxAge' ->> 'value', v_rp -> 'maxAge' ->> 'unit');
        end if;
        if jsonb_typeof(v_rp -> 'maxSourceBatches') = 'number'
           and (select count(distinct coalesce(x.value -> 'data' ->> 'sourceBatch', 'undefined'))
                  from jsonb_each(e1) x where x.value ->> 'stepKey' = e ->> 'stepKey' and x.value ->> 'kind' = 'SOURCE_ADDITION') > (v_rp ->> 'maxSourceBatches')::numeric then
          return format('stores %s, which brings the source batches of its step above the MBR''s %s (G24-TOO-MANY-SOURCES)', v_what, v_rp ->> 'maxSourceBatches');
        end if;
        v_want := c || jsonb_build_object('case', v_rp -> 'case');
      when 'ATTACHMENT' then
        v_want := jsonb_build_object('sha256', c -> 'sha256', 'mediaType', c -> 'mediaType', 'description', c -> 'description',
                                     'paperOriginal', coalesce((c -> 'paperOriginal') = 'true'::jsonb, false), 'attachedBy', v_by);
        v_verify := coalesce((c -> 'paperOriginal') = 'true'::jsonb, false);
      when 'SETPOINT_READBACK', 'ACTUAL', 'ALARM' then
        -- G-06 (0520): the value with its provenance, as blocks/generic/automated.ts builds it.
        v_ref := recipe.g06_value_data(v_cfg, c, e ->> 'kind', v_now_us);
        if v_ref ? 'problem' then
          return format('stores %s that %s', v_what, v_ref ->> 'problem');
        end if;
        v_want := (v_ref -> 'data') || jsonb_build_object('recordedBy', v_by);
        v_verify := (c ->> 'source') = 'MANUAL';
      when 'ALARM_ACK' then
        -- G-06 (0520): an alarm of the step, acknowledged once, a GMP-critical one with a comment (DI-49).
        select x.value into v_ref from jsonb_each(e0) x
         where x.key = c ->> 'alarm' and x.value ->> 'kind' = 'ALARM' and x.value ->> 'stepKey' = e ->> 'stepKey';
        if v_ref is null then
          return format('stores %s acknowledging %s, which is no alarm of its step (G06-ACK-UNKNOWN)', v_what, coalesce(c ->> 'alarm', '(none)'));
        end if;
        if exists (select 1 from jsonb_each(e0) x where x.value ->> 'kind' = 'ALARM_ACK' and x.value ->> 'stepKey' = e ->> 'stepKey'
                                                     and x.value -> 'data' ->> 'alarm' = c ->> 'alarm') then
          return format('stores %s acknowledging alarm %s a second time (G06-ACK-TWICE)', v_what, c ->> 'alarm');
        end if;
        if (v_ref -> 'data' -> 'critical') = 'true'::jsonb and (jsonb_typeof(c -> 'comment') is distinct from 'string' or (c ->> 'comment') ~ '^\s*$') then
          return format('stores %s acknowledging the GMP-critical alarm %s without a comment (G06-ACK-COMMENT)', v_what, c ->> 'alarm');
        end if;
        v_want := jsonb_build_object('alarm', c -> 'alarm')
                  || case when jsonb_typeof(c -> 'comment') = 'string' then jsonb_build_object('comment', c -> 'comment') else '{}'::jsonb end
                  || jsonb_build_object('acknowledgedBy', v_by);
      when 'INTERFACE_LOSS' then
        v_want := jsonb_build_object('reason', c -> 'reason', 'recordedBy', v_by);
        v_verify := true;
      when 'RECIPE_CHECK' then
        if jsonb_typeof(v_node -> 'system' -> 'recipe') is distinct from 'string' or (v_node -> 'system' ->> 'recipe') = '' then
          return format('stores %s at a step that names no equipment recipe (G06-NO-RECIPE)', v_what);
        end if;
        v_want := jsonb_build_object('recipe', c -> 'recipe', 'recipeVersion', c -> 'recipeVersion',
                                     'matches', coalesce((c -> 'recipe') = (v_node -> 'system' -> 'recipe') and (c -> 'recipeVersion') = (v_node -> 'system' -> 'recipeVersion'), false),
                                     'checkedBy', v_by);
      when 'EQUIPMENT_USE' then
        -- G-09@2 (0520): equipment of the step's status check; one unit per reference. Which use it names is 0521's.
        if exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_node -> 'equipment') = 'array' then v_node -> 'equipment' else '[]'::jsonb end) q where q ->> 'use' = 'STATUS_CHECK')
           and not exists (select 1 from jsonb_array_elements(v_node -> 'equipment') q where q ->> 'use' = 'STATUS_CHECK' and q -> 'ref' = c -> 'equipmentRef') then
          return format('stores %s for %s, which is not equipment its step checks (G09-EQUIPMENT)', v_what, coalesce(c ->> 'equipmentRef', '(none)'));
        end if;
        if exists (select 1 from jsonb_each(e0) x where x.value ->> 'kind' = 'EQUIPMENT_USE' and x.value ->> 'stepKey' = e ->> 'stepKey'
                                                     and x.value -> 'data' -> 'equipmentRef' = c -> 'equipmentRef') then
          return format('stores %s for %s a second time (G09-TWICE)', v_what, c ->> 'equipmentRef');
        end if;
        v_want := jsonb_build_object('equipmentRef', c -> 'equipmentRef', 'equipmentCode', c -> 'equipmentCode', 'useId', c -> 'useId', 'recordedBy', v_by);
      when 'AREA_OCCUPANCY' then
        -- G-10@2 (0520): one area per step. Which occupancy it names is 0521's.
        if exists (select 1 from jsonb_each(e0) x where x.value ->> 'kind' = 'AREA_OCCUPANCY' and x.value ->> 'stepKey' = e ->> 'stepKey') then
          return format('stores %s, a second area of its step (G10-TWICE)', v_what);
        end if;
        v_want := jsonb_build_object('areaCode', c -> 'areaCode', 'occupancyId', c -> 'occupancyId', 'recordedBy', v_by);
      else
        -- An entry kind no block of this release records: which block takes which kind is lead TODO T2's.
        null;
    end case;
    end if;
    if v_want is not null and d is distinct from v_want then
      select m into v_member
        from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u
       where (d -> m) is distinct from (v_want -> m)
       order by m limit 1;
      return format('stores %s with %s %s, where its block writes %s', v_what, v_member,
                    coalesce((d -> v_member)::text, '(no such member)'), coalesce((v_want -> v_member)::text, '(no such member)'));
    end if;
    if v_verify and (v_inst -> 'verificationRequired') is distinct from 'true'::jsonb then
      return format('stores %s, which needs a second person''s check of its step, and the step does not require it (PR-14)', v_what);
    end if;
  end loop;
  -- G-24: a reprocessing step other than a validated re-treatment starts only with its prior authorisation.
  if p_command ->> 'type' = 'START_STEP' then
    v_inst := recipe.step_instance_of(p_new, p_command);
    v_node := recipe.step_node(p_content, p_command ->> 'step');
    if v_inst ->> 'status' = 'IN_PROGRESS' and (recipe.step_instance_of(p_old, p_command) ->> 'status') is distinct from 'IN_PROGRESS'
       and v_node -> 'block' ->> 'type' = 'G-24' and v_node -> 'block' ->> 'version' = '1'
       and (v_node -> 'reprocessing' ->> 'case') is distinct from 'VALIDATED_RETREATMENT'
       and not exists (select 1 from jsonb_each(e1) x where not (e0 ? x.key) and x.value ->> 'kind' = 'START_DATA' and x.value ->> 'stepKey' = v_inst ->> 'key') then
      return format('starts reprocessing step %s without the quality unit''s prior authorisation (G24-NOT-AUTHORISED)', v_inst ->> 'key');
    end if;
  end if;
  return null;
end
$$;

reset role;
