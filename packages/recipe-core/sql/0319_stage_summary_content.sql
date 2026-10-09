-- Recipe core, execution store (module C3): the summary a stage sign-off records is part of the content its signature
-- binds, in the database as in the server (Phase 2 exit review F01; DI-37, DI-36, IN-15, PR-16; ADR 0012: the rules
-- hold when the application's own database credentials are used directly).
--
-- The STAGE_SIGNED_OFF meaning (kernel 0930) has the supervisor confirm that the stage record and its summary are
-- complete and correct. The summary (G-02, engine stage-summary.ts) is derived: COMPLETED_PER_MBR or
-- COMPLETED_WITH_DEVIATIONS, the step counts, the exceptions of the stage, the deviations linked to them and the
-- yields. The batch_stage content (signing-content.ts stageSigningContent, stored by the writers) binds the stage and
-- each step's number, status and content hash only, and an exception raised about a step, a QA disposition or a
-- deviation link changes the summary without changing any step's content. The exit review signed off a stage whose
-- supervisor had previewed COMPLETED_PER_MBR with 3 exceptions, after an operator's alert raised in between: the
-- challenge and the signature were accepted on the previewed hash and the sign-off recorded COMPLETED_WITH_DEVIATIONS
-- with 4 exceptions under the signature; in the reverse case, a QA disposition after the preview had the signature
-- record COMPLETED_PER_MBR, a statement no screen had shown.
--
-- This migration:
--   1. recipe.canonical_stage_summary(summary): the `summary` member of the signed text from a summary as the engine
--      records it: {statement, steps {completed, notApplicable, skipped}, exceptions, deviations, yields}, the
--      exception ids ordered by length then code point, the deviations (distinct) and the yields ({calculation,
--      value, unit}) by code point (stage-summary.ts stageSummaryContent). NULL for a malformed summary;
--   2. recipe.stage_summary_of(mbr, state, key): the member a sign-off of stage frame `key` would record in `state`,
--      derived as the engine derives it (stage-summary.ts deriveStageSummary): the step instances of the frame's stage
--      (by the MBR's numbering, recipe.flow_numbering of 0304) in frames compatible with the frame's; the exceptions
--      raised at one of them, or naming one of the stage's steps by step and frames (a time-limit breach); the
--      statement COMPLETED_WITH_DEVIATIONS when one of them is open, linked to a deviation or dispositioned
--      DEVIATION_RAISED, or a step was skipped; the current DECIMAL yields of the MBR's yield checkpoints computed in
--      its steps. NULL when the frame or the numbering is missing;
--   3. recipe.stage_summary_content(mbr, state, key): the recorded summary of a valid sign-off (it never changes
--      afterwards, 0307), else the derived one;
--   4. recipe.execution_stage_summary_legacy: the stage sign-offs already recorded when this migration runs. They were
--      signed on the text without the member, so the provider leaves it out for exactly those sign-offs while they are
--      valid, and their signatures stay VALID (as 0302 did for hold points). Written only here (owner only);
--   5. recipe.execution_content_of: the batch_stage branch adds `summary` (item 3) to the stored content. The rest is
--      exactly as 0315 defined it. So the kernel refuses a challenge or a signature whose hash covers another summary
--      than the record's (EBMR-ESIG-013, EBMR-ESIG-012), and recipe.check_signatures refuses a SIGN_OFF_STAGE whose
--      signature no longer matches it (the signature reads CONTENT_MISMATCH);
--   6. trigger zk_execution_stage_summary (recipe.execution_stage_summary_check): an accepted SIGN_OFF_STAGE row
--      records exactly the summary its signature covers: the member derived from the state before the row, for the
--      frame's stage and start (EBMR-EXE-135).
--
-- The stored content is unchanged (the member is added when the content is read, like a decision's proposal), so no
-- content version is stored when a summary changes: the person who raises, links or dispositions an exception is not
-- counted as having changed the stage record (esig content_change), and the stored versions keep matching the replay.
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the volatility, the search_path and the
-- privileges of execution_content_of (owner only). The new functions and the table are private to the owner; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The canonical member
-- ---------------------------------------------------------------------------------------------

-- DI-37, IN-15 (F01): the `summary` member of a stage's signed text from summary p_summary as the engine records it
-- (header item 1); NULL when a member is missing or of another type.
create function recipe.canonical_stage_summary(p_summary jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  with m as (
    select case when jsonb_typeof(p_summary -> 'exceptions') = 'array' then p_summary -> 'exceptions' else '[]'::jsonb end as exceptions,
           case when jsonb_typeof(p_summary -> 'deviations') = 'array' then p_summary -> 'deviations' else '[]'::jsonb end as deviations,
           case when jsonb_typeof(p_summary -> 'yields') = 'array' then p_summary -> 'yields' else '[]'::jsonb end as yields
  )
  select case
    when jsonb_typeof(p_summary) is distinct from 'object'
      or jsonb_typeof(p_summary -> 'statement') is distinct from 'string'
      or jsonb_typeof(p_summary -> 'steps') is distinct from 'object'
      or jsonb_typeof(p_summary -> 'steps' -> 'completed') is distinct from 'number'
      or jsonb_typeof(p_summary -> 'steps' -> 'notApplicable') is distinct from 'number'
      or jsonb_typeof(p_summary -> 'steps' -> 'skipped') is distinct from 'number'
      or jsonb_typeof(p_summary -> 'exceptions') is distinct from 'array'
      or jsonb_typeof(p_summary -> 'deviations') is distinct from 'array'
      or jsonb_typeof(p_summary -> 'yields') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(m.exceptions) x where jsonb_typeof(x) is distinct from 'string')
      or exists (select 1 from jsonb_array_elements(m.deviations) x where jsonb_typeof(x) is distinct from 'string')
      or exists (select 1 from jsonb_array_elements(m.yields) y
                  where jsonb_typeof(y) is distinct from 'object' or jsonb_typeof(y -> 'calculation') is distinct from 'string'
                     or jsonb_typeof(y -> 'value') is distinct from 'string' or jsonb_typeof(y -> 'unit') is distinct from 'string')
      then null
    else jsonb_build_object(
      'statement', p_summary -> 'statement',
      'steps', jsonb_build_object('completed', p_summary -> 'steps' -> 'completed', 'notApplicable', p_summary -> 'steps' -> 'notApplicable',
                                  'skipped', p_summary -> 'steps' -> 'skipped'),
      'exceptions', (select coalesce(jsonb_agg(x order by length(x #>> '{}'), (x #>> '{}') collate "C"), '[]'::jsonb)
                       from jsonb_array_elements(m.exceptions) x),
      'deviations', (select coalesce(jsonb_agg(d.v order by (d.v #>> '{}') collate "C"), '[]'::jsonb)
                       from (select distinct x as v from jsonb_array_elements(m.deviations) x) d),
      'yields', (select coalesce(jsonb_agg(jsonb_build_object('calculation', y -> 'calculation', 'value', y -> 'value', 'unit', y -> 'unit')
                                           order by (y ->> 'calculation') collate "C", (y ->> 'value') collate "C", (y ->> 'unit') collate "C"), '[]'::jsonb)
                   from jsonb_array_elements(m.yields) y))
  end
  from m
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The derived summary
-- ---------------------------------------------------------------------------------------------

-- Whether every frame of p_outer is one of p_inner (same construct and index): a step instance or an exception in
-- frames p_inner lies in a stage frame in frames p_outer (engine stage-summary.ts `within`).
create function recipe.stage_frames_within(p_outer jsonb, p_inner jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_outer) = 'array' then p_outer else '[]'::jsonb end) x
                      where not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_inner) = 'array' then p_inner else '[]'::jsonb end) y
                                         where y -> 'construct' = x -> 'construct' and y -> 'index' = x -> 'index'))
$$;

-- DI-37, IN-15, PR-16, G-02 (F01): the `summary` member a sign-off of stage frame p_key would record in state p_state,
-- p_mbr being the batch's MBR content (header item 2); NULL when the state has no such frame or the MBR cannot be
-- numbered.
create function recipe.stage_summary_of(p_mbr jsonb, p_state jsonb, p_key text) returns jsonb
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  f        jsonb := p_state -> 'stages' -> p_key;
  v_num    jsonb;
  v_stage  text;
  v_frames jsonb;
  v_steps  jsonb;
  v_keys   text[];
  v_exc    jsonb;
  v_yields jsonb;
  v_dev    boolean;
begin
  if jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(f -> 'stage') is distinct from 'string' then
    return null;
  end if;
  v_num := recipe.flow_numbering(p_mbr);
  if v_num ? 'bad' then
    return null;
  end if;
  v_stage := f ->> 'stage';
  v_frames := f -> 'frames';
  -- The step instances of the stage (a phase or hold point of the MBR in that stage) in frames within the frame's.
  select coalesce(jsonb_agg(i.value), '[]'::jsonb), coalesce(array_agg(i.value ->> 'key'), '{}')
    into v_steps, v_keys
    from jsonb_each(case when jsonb_typeof(p_state -> 'steps') = 'object' then p_state -> 'steps' else '{}'::jsonb end) i
   where v_num -> 'ids' -> (i.value ->> 'step') ->> 'kind' in ('phase', 'holdPoint')
     and v_num -> 'ids' -> (i.value ->> 'step') ->> 'stage' = v_stage
     and recipe.stage_frames_within(v_frames, i.value -> 'frames');
  -- Its exceptions: raised at one of those instances, or naming a step of the stage in frames within the frame's.
  select coalesce(jsonb_agg(e.value), '[]'::jsonb)
    into v_exc
    from jsonb_each(case when jsonb_typeof(p_state -> 'exceptions') = 'object' then p_state -> 'exceptions' else '{}'::jsonb end) e
   where (jsonb_typeof(e.value -> 'source' -> 'stepKey') = 'string' and (e.value -> 'source' ->> 'stepKey') = any (v_keys))
      or (jsonb_typeof(e.value -> 'source' -> 'step') = 'string'
          and v_num -> 'ids' -> (e.value -> 'source' ->> 'step') ->> 'kind' in ('phase', 'holdPoint')
          and v_num -> 'ids' -> (e.value -> 'source' ->> 'step') ->> 'stage' = v_stage
          and recipe.stage_frames_within(v_frames, e.value -> 'source' -> 'frames'));
  v_dev := exists (select 1 from jsonb_array_elements(v_exc) x
                    where x ->> 'status' = 'OPEN' or x ? 'deviation' or x -> 'disposition' ->> 'outcome' = 'DEVIATION_RAISED')
           or exists (select 1 from jsonb_array_elements(v_steps) i where i ->> 'status' = 'SKIPPED');
  -- The current DECIMAL yields of the MBR's yield checkpoints computed in those instances.
  select coalesce(jsonb_agg(jsonb_build_object('calculation', d.value -> 'calculation', 'value', d.value -> 'value' -> 'value', 'unit', d.value -> 'value' -> 'unit')), '[]'::jsonb)
    into v_yields
    from jsonb_each(case when jsonb_typeof(p_state -> 'derived') = 'object' then p_state -> 'derived' else '{}'::jsonb end) d
   where d.value ->> 'status' = 'CURRENT' and (d.value ->> 'stepKey') = any (v_keys) and d.value -> 'value' ->> 'kind' = 'DECIMAL'
     and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_mbr -> 'yieldCheckpoints') = 'array' then p_mbr -> 'yieldCheckpoints' else '[]'::jsonb end) y
                  where y -> 'result' = d.value -> 'calculation');
  return recipe.canonical_stage_summary(jsonb_build_object(
    'statement', case when v_dev then 'COMPLETED_WITH_DEVIATIONS' else 'COMPLETED_PER_MBR' end,
    'steps', jsonb_build_object('completed', (select count(*) from jsonb_array_elements(v_steps) i where i ->> 'status' = 'COMPLETED'),
                                'notApplicable', (select count(*) from jsonb_array_elements(v_steps) i where i ->> 'status' = 'NOT_APPLICABLE'),
                                'skipped', (select count(*) from jsonb_array_elements(v_steps) i where i ->> 'status' = 'SKIPPED')),
    'exceptions', (select coalesce(jsonb_agg(x -> 'id'), '[]'::jsonb) from jsonb_array_elements(v_exc) x),
    'deviations', (select coalesce(jsonb_agg(x -> 'deviation' -> 'ref'), '[]'::jsonb) from jsonb_array_elements(v_exc) x where jsonb_typeof(x -> 'deviation') = 'object'),
    'yields', v_yields));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The member of the signed text
-- ---------------------------------------------------------------------------------------------

-- DI-37, IN-15 (F01): the `summary` member of stage frame p_key's signed text in state p_state (header item 3).
create function recipe.stage_summary_content(p_mbr jsonb, p_state jsonb, p_key text) returns jsonb
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when p_state -> 'stages' -> p_key -> 'signOff' -> 'valid' = 'true'::jsonb
              then recipe.canonical_stage_summary(p_state -> 'stages' -> p_key -> 'signOff' -> 'summary')
              else recipe.stage_summary_of(p_mbr, p_state, p_key) end
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Sign-offs recorded before this migration
-- ---------------------------------------------------------------------------------------------

create table recipe.execution_stage_summary_legacy (
  aggregate_id  text not null,
  signature_id  text not null,
  primary key (aggregate_id, signature_id)
);
revoke all on recipe.execution_stage_summary_legacy from public;

insert into recipe.execution_stage_summary_legacy (aggregate_id, signature_id)
select s.batch_id::text || ':' || g.key, g.value -> 'signOff' ->> 'signature'
  from recipe.execution_state s
 cross join lateral jsonb_each(case when jsonb_typeof(s.state -> 'stages') = 'object' then s.state -> 'stages' else '{}'::jsonb end) g
 where jsonb_typeof(g.value -> 'signOff' -> 'signature') = 'string'
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------
-- 5. The content provider
-- ---------------------------------------------------------------------------------------------

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
  v_mbr   jsonb;
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
      -- F01 (DI-37, IN-15, PR-16): the stage's summary, which the STAGE_SIGNED_OFF meaning confirms, is part of the
      -- signed text: the summary a sign-off would record now, derived here from the stored state and the batch's MBR,
      -- and once validly signed the one the sign-off recorded (header item 3). A sign-off made before this migration
      -- keeps the text it was signed on (header item 2). NULL when it cannot be derived: nothing then matches it.
      if not exists (select 1 from recipe.execution_stage_summary_legacy l
                      where l.aggregate_id = p_id and l.signature_id = x -> 'signOff' ->> 'signature'
                        and x -> 'signOff' -> 'valid' = 'true'::jsonb) then
        select pk.content into v_mbr from recipe.test_package pk where pk.package_hash = b.package_hash;
        v_row.content := v_row.content || jsonb_build_object('summary', recipe.stage_summary_content(v_mbr, st, v_key));
      end if;
    when 'batch_exception' then
      x := st -> 'exceptions' -> v_key;
      v_state := x ->> 'status';
      -- The raiser and the person who linked the deviation, and (F11; INV-03, PR-13, PR-49) everyone involved in the
      -- step the exception was raised at, as the stored step lists name them and (round 2) as the accepted commands
      -- recorded on that step name them: the kernel never lets them sign its disposition (EBMR-ESIG-044). Round 3: the
      -- raising step is also the step the command of the row that raised the exception acts on (header item 2).
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'raisedBy', x -> 'deviation' ->> 'linkedBy')
                                || recipe.exception_step_involvement(v_batch, st, v_key, null));
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


-- ---------------------------------------------------------------------------------------------
-- 6. The sign-off row
-- ---------------------------------------------------------------------------------------------

-- DI-37, IN-15, PR-16 (F01): an accepted SIGN_OFF_STAGE row records, for the frame it signs off, the summary derived
-- from the state before the row, the one its signature covers (header item 6). EBMR-EXE-135. Raises; returns nothing.
create function recipe.execution_stage_summary_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r        recipe.execution_command;
  v_key    text;
  v_mbr    jsonb;
  v_signed jsonb;
  v_rec    jsonb;
  v_frame  jsonb;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.kind is distinct from 'COMMAND' or r.accepted is not true or r.command_type is distinct from 'SIGN_OFF_STAGE' then
    return null;
  end if;
  v_key := (r.command ->> 'stage') || '@' || recipe.ctx_key(r.command -> 'context');
  select pk.content into v_mbr from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_signed := recipe.stage_summary_of(v_mbr, old.state, v_key);
  v_rec := new.state -> 'stages' -> v_key -> 'signOff' -> 'summary';
  v_frame := old.state -> 'stages' -> v_key;
  if v_signed is null or recipe.canonical_stage_summary(v_rec) is distinct from v_signed
     or v_rec -> 'stage' is distinct from v_frame -> 'stage' or v_rec -> 'startedAt' is distinct from v_frame -> 'startedAt' then
    raise exception using errcode = 'P0001',
      message = format('The sign-off of stage %s records the summary %s, but the summary of the stage as signed is %s: a stage sign-off records the summary its signature covers, derived from the record (DI-37, IN-15, PR-16). [EBMR-EXE-135]',
                       v_key, coalesce(recipe.canonical_stage_summary(v_rec)::text, coalesce(v_rec::text, 'none')), coalesce(v_signed::text, 'none (it cannot be derived)'));
  end if;
  return null;
end
$$;

create trigger zk_execution_stage_summary after update on recipe.execution_state
  for each row execute function recipe.execution_stage_summary_check();

revoke all on function recipe.canonical_stage_summary(jsonb), recipe.stage_frames_within(jsonb, jsonb), recipe.stage_summary_of(jsonb, jsonb, text),
                       recipe.stage_summary_content(jsonb, jsonb, text), recipe.execution_stage_summary_check() from public;

reset role;
