-- Recipe core, execution store (module C3): change-path guards after the slice 2 quick review (findings 2 and 5;
-- outline 5.2.3; DI-24, DI-29, INV-41, PR-12; ADR 0012).
--
-- recipe.change_path_problem, from its latest definition (0452), with two rules added:
--   * VOID_ATTEMPT (finding 2): a void is refused once the item holds a valid result in the step instance, whether or
--     not the command names that result (EBMR-EXE-173). The engine refuses the same (corrections.ts voidAttempt).
--   * CORRECT_ENTRY from fail to pass (finding 5): the QA approver, whose approval is the invalidation record, did not
--     take part in the original entry: neither its enterer nor a performer, data enterer, corrector or PERFORMED signer
--     of its step in the state before the row (EBMR-EXE-175).
-- CREATE OR REPLACE keeps the owner and privileges (none for PUBLIC). Applied as a new migration because applied
-- migrations are never edited.

set local role ebmr_owner;

create or replace function recipe.change_path_problem(p_old jsonb, p_new jsonb, p_kind text, p_cmd jsonb, p_accepted boolean, p_person text, p_content jsonb)
returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_type   text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_from   text := p_old ->> 'status';
  v_to     text := p_new ->> 'status';
  v_key    text;
  v_node   jsonb;
  v_prob   text;
  x        jsonb;
  y        jsonb;
  n        jsonb;
  v_new    text[];
  v_result text;
  m        text;
begin
  -- The batch status (every row).
  if v_from in ('ABORTED', 'CANCELLED') and v_to is distinct from v_from then
    return format('takes a batch that is %s to %s; an aborted or cancelled batch stays so', v_from, coalesce(v_to, 'no status'));
  end if;
  if v_to = 'ABORTED' and v_from is distinct from 'ABORTED' and v_type is distinct from 'ABORT_BATCH' then
    return 'aborts the batch; only an accepted ABORT_BATCH with its two approvals does';
  end if;
  if v_to = 'CANCELLED' and v_from is distinct from 'CANCELLED' and v_type is distinct from 'CANCEL_BATCH' then
    return 'cancels the batch; only an accepted CANCEL_BATCH does';
  end if;
  if v_type is null or v_type not in ('REQUEST_SKIP', 'VOID_ATTEMPT', 'INVALIDATE_RESULT', 'CORRECT_ENTRY', 'ABORT_BATCH', 'CANCEL_BATCH') then
    return null;
  end if;

  if v_type in ('ABORT_BATCH', 'CANCEL_BATCH') then
    if v_type = 'ABORT_BATCH' and (v_from is null or v_from not in ('ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE')) then
      return format('[176] aborts a batch that is %s; a batch is aborted while issued, in progress, on hold or complete', coalesce(v_from, 'without a status'));
    end if;
    if v_type = 'CANCEL_BATCH' then
      if v_from is distinct from 'ISSUED' then
        return format('[177] cancels a batch that is %s; only an issued batch where nothing has started is cancelled, any other is aborted', coalesce(v_from, 'without a status'));
      end if;
      select i.key into v_key from jsonb_each(case when jsonb_typeof(p_old -> 'steps') = 'object' then p_old -> 'steps' else '{}' end) i
       where coalesce(i.value ->> 'status', '') not in ('PENDING', 'ENABLED', 'NOT_APPLICABLE') order by i.key limit 1;
      if v_key is not null then
        return format('[177] cancels a batch whose step %s has started; only a batch where nothing has started is cancelled, any other is aborted', v_key);
      end if;
    end if;
    if recipe.member_blank(p_cmd -> 'reason') then
      return format('[%s] has a blank reason', case v_type when 'ABORT_BATCH' then '176' else '177' end);
    end if;
    if v_to is distinct from (case v_type when 'ABORT_BATCH' then 'ABORTED' else 'CANCELLED' end) then
      return format('[%s] leaves the batch %s', case v_type when 'ABORT_BATCH' then '176' else '177' end, coalesce(v_to, 'without a status'));
    end if;
    foreach m in array array['steps', 'points', 'entries', 'containers', 'derived', 'decisions', 'stages', 'holds', 'subLots'] loop
      if (p_new -> m) is distinct from (p_old -> m) then
        return format('[%s] changes the %s of the record; an abort or a cancellation changes only the batch status', case v_type when 'ABORT_BATCH' then '176' else '177' end, m);
      end if;
    end loop;
    if v_type = 'ABORT_BATCH' then
      if exists (select 1 from unnest(array['outputsHeld', 'equipmentSetDirty', 'materialsSecured']) k where (p_cmd -> 'checklist' -> k) is distinct from 'true'::jsonb) then
        return '[176] does not confirm every item of the abort checklist (outputs held for QA, equipment set dirty, materials secured)';
      end if;
      x := p_new -> 'abort';
      if jsonb_typeof(x) is distinct from 'object' or (x -> 'reason') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'reason'))
         or (x -> 'checklist') is distinct from (p_cmd -> 'checklist')
         or jsonb_typeof(x -> 'approvals') is distinct from 'array'
         or (select coalesce(array_agg(a order by a), '{}') from jsonb_array_elements_text(x -> 'approvals') a)
            is distinct from (select coalesce(array_agg(a -> 'approver' ->> 'id' order by a -> 'approver' ->> 'id'), '{}') from jsonb_array_elements(p_cmd -> 'approvals') a) then
        return '[176] stores an abort record that is not the command''s reason, checklist and approvers';
      end if;
    end if;
    return null;
  end if;

  if v_type = 'REQUEST_SKIP' then
    v_node := recipe.step_node(p_content, p_cmd ->> 'step');
    v_prob := recipe.skip_problem(p_content, v_node);
    if v_prob is not null then
      return format('[172] skips step %s, which cannot be skipped: %s', coalesce(p_cmd ->> 'step', 'null'), v_prob);
    end if;
    if recipe.member_blank(p_cmd -> 'reason') then
      return '[172] has a blank reason';
    end if;
    v_key := (p_cmd ->> 'step') || '@' || recipe.ctx_key(p_cmd -> 'context');
    y := p_new -> 'steps' -> v_key;
    x := y -> 'skip';
    if y ->> 'status' is distinct from 'SKIPPED' or jsonb_typeof(x) is distinct from 'object'
       or x ->> 'requestedBy' is distinct from p_person or x ->> 'approvedBy' is distinct from p_cmd -> 'approval' -> 'approver' ->> 'id'
       or x ->> 'signature' is distinct from p_cmd -> 'approval' -> 'signature' ->> 'id'
       or (x -> 'reason') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'reason')) then
      return format('[172] leaves step %s without the skip the command records (SKIPPED, requested by its person, approved and signed by its approver, with its reason)', v_key);
    end if;
    return null;
  end if;

  if v_type = 'VOID_ATTEMPT' then
    if p_cmd ? 'point' then
      x := p_old -> 'points' -> (p_cmd ->> 'point');
      if x is null or x ->> 'kind' is distinct from 'ABORTED' then
        return format('[173] voids %s, which %s; once a result exists it is never voided: correct an entry error or invalidate it with an investigation',
                      coalesce(p_cmd ->> 'point', 'null'), case when x is null then 'is not a data point of the record' else 'holds a result' end);
      end if;
    end if;
    v_key := (p_cmd ->> 'step') || '@' || recipe.ctx_key(p_cmd -> 'context');
    -- Only before a result exists, whether or not the command names it (review finding 2).
    select e.key into v_result from jsonb_each(case when jsonb_typeof(p_old -> 'points') = 'object' then p_old -> 'points' else '{}' end) e
     where e.value ->> 'stepKey' = v_key and e.value ->> 'item' = p_cmd ->> 'item' and e.value ->> 'kind' = 'VALUE' and e.value ->> 'status' = 'VALID'
     order by e.key limit 1;
    if v_result is not null then
      return format('[173] voids an attempt of %s in %s, which already holds the result %s; once a result exists it is never voided: correct an entry error or invalidate it with an investigation',
                    p_cmd ->> 'item', v_key, v_result);
    end if;
    if recipe.member_blank(p_cmd -> 'reason') then
      return '[173] has a blank reason';
    end if;
    v_new := array(select k from jsonb_object_keys(case when jsonb_typeof(p_new -> 'points') = 'object' then p_new -> 'points' else '{}' end) k
                    where not ((p_old -> 'points') ? k) order by k);
    n := p_new -> 'points' -> v_new[1];
    if cardinality(v_new) <> 1 or n ->> 'kind' is distinct from 'ABORTED' or n ? 'value' or n ->> 'status' is distinct from 'VALID'
       or n ->> 'item' is distinct from p_cmd ->> 'item' or n ->> 'stepKey' is distinct from v_key
       or n ->> 'enteredBy' is distinct from p_person or (n -> 'voidReason') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'reason')) then
      return format('[173] adds %s data point(s) where a void adds exactly one: the voided attempt of %s in %s (kind ABORTED, no value), entered by its person with the reason given',
                    cardinality(v_new), coalesce(p_cmd ->> 'item', 'null'), v_key);
    end if;
    return null;
  end if;

  if v_type = 'INVALIDATE_RESULT' then
    if recipe.member_blank(p_cmd -> 'investigationRef') or recipe.member_blank(p_cmd -> 'assignableCause') then
      return '[174] names no investigation or no assignable cause; a result is invalidated only with a linked OOS or deviation investigation that concluded an assignable cause';
    end if;
    if recipe.member_blank(p_cmd -> 'reason') then
      return '[174] has a blank reason';
    end if;
    x := p_old -> 'points' -> (p_cmd ->> 'point');
    y := p_new -> 'points' -> (p_cmd ->> 'point');
    if x ->> 'kind' is distinct from 'VALUE' or x ->> 'status' is distinct from 'VALID' then
      return format('[174] invalidates %s, which is not a valid result', coalesce(p_cmd ->> 'point', 'null'));
    end if;
    if y ->> 'status' is distinct from 'INVALIDATED'
       or (y -> 'invalidation' -> 'investigationRef') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'investigationRef'))
       or (y -> 'invalidation' -> 'assignableCause') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'assignableCause')) then
      return format('[174] does not keep %s in the record as invalidated with the investigation and the assignable cause the command gives', p_cmd ->> 'point');
    end if;
    return null;
  end if;

  -- CORRECT_ENTRY: INV-41.
  x := p_old -> 'points' -> (p_cmd ->> 'point');
  n := p_new -> 'points' -> (p_new -> 'points' -> (p_cmd ->> 'point') ->> 'supersededBy');
  if (x -> 'failed') = 'true'::jsonb and (n -> 'failed') is distinct from 'true'::jsonb then
    if jsonb_typeof(p_cmd -> 'evidence') is distinct from 'object' then
      return format('[175] makes %s, which failed its limits, pass without objective evidence of the true value; without it only an invalidation with an investigation applies', p_cmd ->> 'point');
    end if;
    if jsonb_typeof(p_cmd -> 'approval') is distinct from 'object'
       or not ('QA' = any (recipe.signer_engine_roles(nullif(p_cmd -> 'approval' -> 'signature' ->> 'id', '')::uuid))) then
      return format('[175] makes %s, which failed its limits, pass without the approval of QA, which is its invalidation record', p_cmd ->> 'point');
    end if;
    -- The QA approver is independent of the original entry (review finding 5): not its enterer, nor a performer, data
    -- enterer, corrector or PERFORMED signer of its step.
    y := p_old -> 'steps' -> (x ->> 'stepKey');
    if p_cmd -> 'approval' -> 'approver' ->> 'id' = x ->> 'enteredBy'
       or exists (select 1 from jsonb_array_elements_text(coalesce(y -> 'performers', '[]') || coalesce(y -> 'dataEnterers', '[]')
                                                          || coalesce(y -> 'correctors', '[]') || coalesce(y -> 'performedSigners', '[]')) p
                   where p = p_cmd -> 'approval' -> 'approver' ->> 'id') then
      return format('[175] makes %s, which failed its limits, pass with the approval of %s, who took part in the original entry of step %s; the approval that is its invalidation record is independent',
                    p_cmd ->> 'point', p_cmd -> 'approval' -> 'approver' ->> 'id', x ->> 'stepKey');
    end if;
  end if;
  return null;
exception when invalid_text_representation then
  return 'names an approval signature that is not an e-signature of this system';
end
$$;

reset role;
