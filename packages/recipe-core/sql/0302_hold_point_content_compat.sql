-- Recipe core, execution store (module C3): a hold point's signed content carries a decision only once one is
-- proposed, so the hold-point signatures made before 0295 keep the content they signed (INV-09, DI-37, PR-45;
-- round-1 verification of review findings P26 and P38).
--
-- 0295 made the decision a QA reviewer signs part of the hold point's signed content: the batch_step content
-- provider added the latest proposal of the content version as `proposedDecision`, and JSON null when there was
-- none. The null changed the content of every hold point, decided or not, including those whose decision was
-- signed before 0295 (whose content held no such member). esig.signature_state recomputes the hash of the content
-- the provider gives now, so in an upgraded sandbox each of those signatures read as CONTENT_MISMATCH, the status
-- the kernel keeps for a content changed outside the invalidation mechanism (an integrity problem), not as
-- SUPERSEDED_BY_CHANGE, and none of them had changed.
--
-- Now the provider adds `proposedDecision` only when a decision is proposed on the content version (the proposal
-- is always a JSON object: recipe.execution_decision_proposal checks it). A hold point nobody has proposed a
-- decision for has the content it had before 0295, the stored content as 0210 gives it, so its earlier signatures
-- stay VALID. The binding is unchanged: recipe.check_hold_point_decision (0295, carried by 0297) refuses a
-- DISPOSITION_HOLD_POINT whose signed content version holds no proposal, so every decision recorded from 0295 on is
-- still signed with its disposition and comment in the content; and a proposal made after a signature changes the
-- content that signature covers, as before. A stored content that already names a `proposedDecision` member gets
-- the database's own value in it (null when none), as under 0295: nothing but a recorded proposal ever stands there.
--
-- Apart from that condition, the function is exactly as 0295 defined it (0210 with the hold-point decision): same
-- members, order and cases. A later migration that replaces recipe.execution_content_of carries this body forward,
-- as one that replaces recipe.check_signatures or recipe.append_execution carries those of 0297 and 0295. CREATE OR
-- REPLACE keeps the owner, the privileges (none for PUBLIC; called only by the batch_*_content providers, which run
-- as the owner), SECURITY DEFINER, the volatility and the search_path of 0210. Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

create or replace function recipe.execution_content_of(p_type text, p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_table regclass := recipe.content_table(p_type);
  v_row   record;
  v_batch uuid;
  v_key   text;
  b       recipe.batch_execution;
  st      jsonb;
  x       jsonb;
  v_state text;
  v_by    uuid[] := '{}';
  v_act   jsonb;
  v_ended bigint;
  v_dev   uuid;
  v_dec   jsonb;
begin
  if v_table is null or p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.+$' then
    return jsonb_build_object('exists', false);
  end if;
  v_batch := split_part(p_id, ':', 1)::uuid;
  v_key := substr(p_id, 38);
  execute format('select content_version, content from %s where aggregate_id = $1 order by content_version desc limit 1', v_table) into v_row using p_id;
  if v_row.content_version is null then
    return jsonb_build_object('exists', false);
  end if;
  select * into b from recipe.batch_execution where id = v_batch;
  select state into st from recipe.execution_state where batch_id = v_batch;
  case p_type
    when 'batch_step' then
      x := st -> 'steps' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(coalesce(x -> 'performers', '[]') || coalesce(x -> 'dataEnterers', '[]') || coalesce(x -> 'correctors', '[]')
                                || coalesce(x -> 'performedSigners', '[]'));
      v_ended := recipe.micros_of(x -> 'endedAt');
      if v_ended is not null then
        select c.device_id into v_dev from recipe.execution_command c
         where c.batch_id = v_batch and c.accepted and c.command_type = 'SIGN_PERFORMED'
           and recipe.instance_aggregate(v_batch, c.command ->> 'step', c.command -> 'context') = p_id
         order by c.seq desc limit 1;
        if v_dev is not null then
          v_act := jsonb_build_object('device_id', v_dev, 'at', timestamptz 'epoch' + make_interval(secs => 0) + (v_ended::text || ' microseconds')::interval,
                                      'next_step_started', recipe.next_step_started(st, v_key, v_ended));
        end if;
      end if;
      -- The hold-point decision being signed is part of the signed content once it is proposed
      -- (recipe.propose_hold_point_decision; P26, P38). Without a proposal the content is the one signed before 0295.
      if v_row.content -> 'step' ->> 'kind' = 'HOLD' then
        v_dec := recipe.current_decision(p_id, v_row.content_version);
        if jsonb_typeof(v_dec) = 'object' or v_row.content ? 'proposedDecision' then
          v_row.content := v_row.content || jsonb_build_object('proposedDecision', v_dec);
        end if;
      end if;
    when 'batch_stage' then
      x := st -> 'stages' -> v_key;
      v_state := case when (x -> 'signOff' ->> 'valid')::boolean is true then 'SIGNED_OFF'
                      when (x ->> 'awaitingSignOff')::boolean is true or x ? 'endedAt' then 'AWAITING_SIGN_OFF'
                      else 'IN_PROGRESS' end;
    when 'batch_exception' then
      x := st -> 'exceptions' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'raisedBy', x -> 'deviation' ->> 'linkedBy'));
      -- The disposition being signed is part of the signed content (recipe.propose_disposition).
      v_row.content := v_row.content || jsonb_build_object('proposedDisposition', recipe.current_proposal(p_id, v_row.content_version));
    when 'batch_point' then
      x := st -> 'points' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'enteredBy'));
  end case;
  -- The content is returned exactly as stored (its null members are part of the signed text); only an
  -- absent act is left out.
  return jsonb_build_object(
    'exists', true, 'content_version', v_row.content_version, 'content', v_row.content, 'state', v_state,
    'entered_by', to_jsonb(v_by), 'scope', jsonb_build_object('site', b.site_code))
    || case when v_act is null then '{}'::jsonb else jsonb_build_object('act', v_act) end;
end
$$;

-- Privileges: CREATE OR REPLACE kept those of 0210 (recipe.execution_content_of private to the owner).

reset role;
