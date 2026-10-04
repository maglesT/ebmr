-- Recipe core, execution store (module C3): a new entry holds exactly the data its block builds from the command, the
-- batch's MBR, the batch, its step, its person and the row's time, and only what the block accepts (Phase 2 exit review
-- F12, the round-4 verification; DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47; ADR 0012: the
-- rules hold when the application's own database credentials are used directly).
--
-- Correction of 0328's header, stated here because applied migrations are never edited. 0328 said it listed "the
-- members that name the MBR and that the database did not compare"; it listed the BOM lines, intermediates, containers
-- and equipment of five entry kinds only. The round-4 verification stored, through the application role, the G-03
-- acknowledgement of p-disp-sop@ with the engine's own result except that its data named sop 'B24-0001' and sopVersion
-- 'L2409-0017' (the real-format batch and lot numbers of the earlier rounds) where the MBR pins SOP-DISP-001 version 1:
-- the database answered 'ok' and the invariant query reported nothing, while the engine writes only the MBR's own SOP
-- reference there and refuses any other version (G03-SOP-VERSION). 0313 compares only the members the command sent,
-- 0328 had no case for the acknowledgement, and tablets 0370 and 0380 read a fixed list of members. The same hole, read
-- for this migration in every entry kind the blocks of this release record (blocks/generic, engine steps.ts):
--   * members a block builds and the command does not send, which nothing compared: an acknowledgement's sop, sopVersion
--     and sopHash (G-03, the SOP reference its step's configuration names) and its mode (the configuration's); a
--     sample's id and label (G-12: built from the batch number, the MBR's product, the step, its sub-lot, the person and
--     the time); a source addition's case (G-24, the step's reprocessing case); an output's status (G-22); the passed
--     flag of an equipment status and of a clearance checklist (G-09, G-10); an attachment's paperOriginal (G-05); and
--     the person every block writes into its data (acknowledgedBy, attestedBy, checkedBy, recordedBy, sampler, by,
--     attachedBy), which 0300 bound only on the entry's enteredBy;
--   * members a block takes over but 0313 does not require (it compares only the members the data still holds): a
--     DISPOSAL, a transfer and a source addition keep the whole command, so a member dropped from their data (a
--     batch-coded flag, a method) went unseen; and any member added to the data under a name of its own (0313 and the
--     identifier rule of tablets 0380 read only known names);
--   * the entry record itself: its id, its time (the row's, 0299's lastRecordedUs) and its sequence in the row;
--   * what an entry makes the step need: a weighing keyed by hand, a scanned paper original and a line clearance leave
--     the step needing its second person (verificationRequired), as 0300 already requires for a value keyed by hand;
--   * the accept rules of these blocks that read only the MBR, the batch and the entry: a checklist answers exactly the
--     checks its configuration lists, once each, NOT_APPLICABLE only where allowed (G09-ANSWERS, G10-ANSWERS,
--     G10-NOT-APPLICABLE); a sample is of the step's sampling plan (G12-NOT-PLANNED); a weighed or charged lot is
--     released, of the line's material, not past expiry or retest, and identity-tested for a US or EU batch
--     (G07-LOT-*, G07-WRONG-MATERIAL, PR-18 lot usability); a disposal of batch-coded material is never a return to
--     stores, a destruction names its method and is witnessed where the configuration asks, a reject is in an identified
--     container (G23-*); a source addition is made only at a recovery or reprocessing-addition step (G24-NO-ADDITION),
--     of the batch's own product (G24-OTHER-PRODUCT), never of material that itself contains recovered material
--     (G24-CHAINED), from at most the MBR's number of source batches (G24-TOO-MANY-SOURCES), and not older than the MBR's
--     maximum age (G24-TOO-OLD); a reprocessing step other than a validated re-treatment starts only with the quality
--     unit's authorisation (G24-NOT-AUTHORISED), never given by the person who starts it (G24-SELF-AUTHORISED).
--
-- recipe.entry_block_problem (a pure function compared with the engine's own runs: packages/recipe-core/test/execution
-- entry-data-sql.test.ts) builds, for every entry a row adds, the data its block builds and compares it with the stored
-- data member for member, and applies those accept rules; the trigger zzd_execution_entry_block (after update of
-- recipe.execution_state; every row that adds an entry or starts a step) refuses a row that breaks one (EBMR-EXE-126,
-- the code of 0300, 0313, 0317 and 0328 for what a row's state records). Members already bound elsewhere are taken from
-- the stored data and left to their own checks: a weighing's net (0321) and label (0322), a container's id (0317), the
-- quantity a weighing counts into (0323), what a container charge's container holds (0328).
--
-- Not decided here, stated so it is not over-read: whether a block raises the exception an entry calls for (a weighing
-- keyed by hand, an equipment or clearance check answered NO, a sampling shortfall) and the words of that exception;
-- a source addition's share of the batch size (G24-TOO-MUCH, a conversion between the batch size's and the addition's
-- units that the engine skips when it has none); a transfer's two persons (checked when the step is signed); and which
-- block an entry kind belongs to (lead TODO T2). They stay with the replay (decision REPLAY-GATE.1).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- The members p_keys of object p_obj that it holds (a sub-object); an empty object for anything that is no object.
create function recipe.json_pick(p_obj jsonb, p_keys text[]) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_object_agg(x.key, x.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_obj) = 'object' then p_obj else '{}'::jsonb end) x
   where x.key = any (p_keys)
$$;

-- PR-23 (F12, round-4 verification): the ids of the checks a G-09@1 step asks for (blocks/generic status.ts
-- statusChecks): its configuration's checks, else the block's default list.
create function recipe.status_check_ids(p_config jsonb) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
           when jsonb_typeof(p_config -> 'checks') = 'array' and jsonb_array_length(p_config -> 'checks') > 0 then
             array(select coalesce(c.v ->> 'id', 'undefined') from jsonb_array_elements(p_config -> 'checks') with ordinality c (v, i)
                    where jsonb_typeof(c.v) = 'object' order by c.i)
           else array['CALIBRATED', 'DAILY_CHECK', 'CLEAN']
         end
$$;

-- PR-34 (F12, round-4 verification): the items of a G-10@1 step's clearance checklist, {id, expected} in order
-- (blocks/generic status.ts clearanceChecklist): its configuration's checklist, else the block's default list.
create function recipe.clearance_items(p_config jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
           when jsonb_typeof(p_config -> 'checklist') = 'array' and jsonb_array_length(p_config -> 'checklist') > 0 then
             coalesce((select jsonb_agg(jsonb_build_object('id', coalesce(c.v ->> 'id', 'undefined'),
                                                           'expected', case when c.v ->> 'expected' = 'CONFIRMED_OR_NOT_APPLICABLE'
                                                                            then 'CONFIRMED_OR_NOT_APPLICABLE' else 'CONFIRMED' end) order by c.i)
                         from jsonb_array_elements(p_config -> 'checklist') with ordinality c (v, i)
                        where jsonb_typeof(c.v) = 'object'), '[]'::jsonb)
           else '[{"id": "NO_PREVIOUS_MATERIAL", "expected": "CONFIRMED"}, {"id": "NO_PREVIOUS_DOCUMENTS", "expected": "CONFIRMED"},
                  {"id": "EQUIPMENT_CLEAN_LABEL", "expected": "CONFIRMED"}]'::jsonb
         end
$$;

-- The answers of a checklist entry as the blocks keep them (status.ts answersOf): {id, answer} of every object.
create function recipe.checklist_answers(p_answers jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.v -> 'id', 'answer', a.v -> 'answer') order by a.i), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_answers) = 'array' then p_answers else '[]'::jsonb end) with ordinality a (v, i)
   where jsonb_typeof(a.v) = 'object'
$$;

-- PR-23, PR-34 (F12, round-4 verification): why answers p_answers ({id, answer}) do not name every id of p_ids exactly
-- once and nothing else (status.ts answerProblems); NULL when they do.
create function recipe.checklist_answer_problem(p_answers jsonb, p_ids text[]) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_ids text[] := array(select coalesce(a.v ->> 'id', 'undefined') from jsonb_array_elements(p_answers) with ordinality a (v, i) order by a.i);
  v_bad text[];
begin
  v_bad := array(select distinct x from unnest(v_ids) x where (select count(*) from unnest(v_ids) y where y = x) > 1 order by 1);
  if cardinality(v_bad) > 0 then
    return format('answers %s more than once', array_to_string(v_bad, ', '));
  end if;
  v_bad := array(select x from unnest(v_ids) x where not (x = any (p_ids)));
  if cardinality(v_bad) > 0 then
    return format('answers %s, which is not on the list of its step (%s)', array_to_string(v_bad, ', '), array_to_string(p_ids, ', '));
  end if;
  v_bad := array(select x from unnest(p_ids) x where not (x = any (v_ids)));
  if cardinality(v_bad) > 0 then
    return format('does not answer %s; every item of its step''s list is answered', array_to_string(v_bad, ', '));
  end if;
  return null;
end
$$;

-- PR-18 (F12, round-4 verification): why lot p_lot of a weighing or charge of BOM line p_bom_line, at the trusted time
-- p_now_us of a batch for markets p_markets, is not one the blocks accept (material.ts lotProblems): of the line's
-- material (its MBR material, or that reference's code), released, before its expiry and retest dates, identity-tested
-- for a batch for a market other than India; NULL when it is.
create function recipe.lot_usability_problem(p_content jsonb, p_bom_line jsonb, p_lot jsonb, p_now_us numeric, p_markets jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_material jsonb;
  v_code     jsonb;
  v_lot      jsonb := case when jsonb_typeof(p_lot) = 'object' then p_lot else '{}'::jsonb end;
  v_id       text := coalesce(v_lot ->> 'id', '(no id)');
begin
  select b.v -> 'material' into v_material
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'bom') = 'array' then p_content -> 'bom' else '[]'::jsonb end) with ordinality b (v, i)
   where b.v -> 'id' = p_bom_line order by b.i limit 1;
  if v_material is not null and jsonb_typeof(v_material) <> 'null' then
    select r.v -> 'code' into v_code
      from jsonb_array_elements(case when jsonb_typeof(p_content -> 'references') = 'array' then p_content -> 'references' else '[]'::jsonb end) with ordinality r (v, i)
     where r.v -> 'id' = v_material order by r.i limit 1;
    if (v_lot -> 'material') is distinct from v_material and (v_code is null or (v_lot -> 'material') is distinct from v_code) then
      return format('lot %s is of material %s, not the item the MBR names (%s) (G07-WRONG-MATERIAL)', v_id, coalesce(v_lot ->> 'material', '(none)'), coalesce(v_code, v_material) #>> '{}');
    end if;
  end if;
  if (v_lot -> 'status') is distinct from '"RELEASED"'::jsonb then
    return format('lot %s is %s; only a released lot is used (G07-LOT-STATUS)', v_id, coalesce(v_lot ->> 'status', '(no status)'));
  end if;
  if jsonb_typeof(v_lot -> 'expiresAtUs') = 'string' and (v_lot ->> 'expiresAtUs') ~ '^[0-9]{1,20}$' and (v_lot ->> 'expiresAtUs')::numeric <= p_now_us then
    return format('lot %s is past its expiry date (G07-LOT-EXPIRED)', v_id);
  end if;
  if jsonb_typeof(v_lot -> 'retestAtUs') = 'string' and (v_lot ->> 'retestAtUs') ~ '^[0-9]{1,20}$' and (v_lot ->> 'retestAtUs')::numeric <= p_now_us then
    return format('lot %s is past its retest date (G07-LOT-RETEST)', v_id);
  end if;
  if (v_lot -> 'identityTested') = 'false'::jsonb
     and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_markets) = 'array' then p_markets else '[]'::jsonb end) m where m <> '"IN"'::jsonb) then
    return format('lot %s has no identity-test result, and the batch is for %s (G07-LOT-IDENTITY)', v_id,
                  (select string_agg(m #>> '{}', ', ') from jsonb_array_elements(p_markets) m));
  end if;
  return null;
end
$$;

-- DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47 (F12, round-4 verification): why an entry that
-- state p_new adds (not in p_old), stored by a row with command p_command of a batch of MBR content p_content, is not
-- the entry its block builds, or is one the block does not accept, or why a reprocessing step that p_command starts has
-- no authorisation (header); NULL when none. The text completes "This <row> ...".
create function recipe.entry_block_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
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
      else
        -- An entry kind no block of this release records: which block takes which kind is lead TODO T2's.
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
    if v_verify and (v_inst -> 'verificationRequired') is distinct from 'true'::jsonb then
      return format('stores %s, which needs a second person''s check of its step, and the step does not require it (PR-14)', v_what);
    end if;
  end loop;
  -- G-24: a reprocessing step other than a validated re-treatment starts only with its prior authorisation.
  if p_command ->> 'type' = 'START_STEP' then
    v_inst := recipe.step_instance_of(p_new, p_command);
    v_node := recipe.step_node(p_content, p_command ->> 'step');
    if v_inst ->> 'status' = 'IN_PROGRESS' and (recipe.step_instance_of(p_old, p_command) ->> 'status') is distinct from 'IN_PROGRESS'
       and v_node -> 'block' ->> 'type' = 'G-24' and (v_node -> 'reprocessing' ->> 'case') is distinct from 'VALIDATED_RETREATMENT'
       and not exists (select 1 from jsonb_each(e1) x where not (e0 ? x.key) and x.value ->> 'kind' = 'START_DATA' and x.value ->> 'stepKey' = v_inst ->> 'key') then
      return format('starts reprocessing step %s without the quality unit''s prior authorisation (G24-NOT-AUTHORISED)', v_inst ->> 'key');
    end if;
  end if;
  return null;
end
$$;

-- DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47 (F12, round-4 verification): an entry a row adds
-- is the one its block builds and accepts (header). EBMR-EXE-126. Raises; returns nothing.
create function recipe.execution_entry_block_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false))
     and (r.command ->> 'type') is distinct from 'START_STEP' then
    return null;
  end if;
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_problem := recipe.entry_block_problem(v_content, old.state, new.state, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an entry holds exactly what its block builds from what was entered, the batch''s MBR, the batch, its step, its person and the time, and only what the block accepts (DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zzd_execution_entry_block after update on recipe.execution_state
  for each row execute function recipe.execution_entry_block_check();

revoke all on function recipe.json_pick(jsonb, text[]), recipe.status_check_ids(jsonb), recipe.clearance_items(jsonb),
                       recipe.checklist_answers(jsonb), recipe.checklist_answer_problem(jsonb, text[]),
                       recipe.lot_usability_problem(jsonb, jsonb, jsonb, numeric, jsonb),
                       recipe.entry_block_problem(jsonb, jsonb, jsonb, jsonb), recipe.execution_entry_block_check() from public;

reset role;
