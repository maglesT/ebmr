-- Recipe core, execution store (module C3): the person who dispositions an exception is outside the involvement set of
-- the step that raised it, in the database as in the engine (Phase 2 exit review F11; INV-03, PR-13, PR-49, DI-17,
-- DI-35; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- The engine refuses a disposition by anyone who started, entered data in, corrected or signed performed the step an
-- exception was raised at (engine batch.ts dispositionException, ENG-SEGREGATION). The database did not:
--   (a) the batch_exception content provider (recipe.execution_content_of, last in 0302) named only the exception's
--       raiser and the person who linked its deviation as having entered the record, so the kernel's INV-03 rule
--       (EBMR-ESIG-044, which excludes those persons for EXCEPTION_DISPOSITIONED) let a person who worked in the step
--       sign the disposition;
--   (b) no guard of DISPOSITION_EXCEPTION (0270, 0295, 0301) looked at the step; a writer holding the application
--       role stored the disposition with an engine result computed as if that person were not involved, and the
--       step's lists put back;
--   (c) recipe.execution_violations() did not look either; only the on-demand replay disagreed.
--
-- This migration:
--   1. recipe.step_involvement(instance): the performers, data enterers, correctors and PERFORMED signers of a stored
--      step instance (engine guards.ts involvedIn), as one JSON array; anything but an array counts as empty.
--   2. recipe.execution_content_of: the batch_exception branch also names the involvement set of the step the
--      exception was raised at (its source.stepKey, read from the stored state as the batch_step branch reads its own
--      step) as having entered the record, so the kernel refuses the signature itself (EBMR-ESIG-044). The content,
--      its hash and every other branch are exactly as 0302 defined them.
--   3. recipe.check_disposition_state: an accepted DISPOSITION_EXCEPTION whose person is in the involvement set of the
--      raising step in the stored state before the row is refused (EBMR-EXE-087), after the open check of 0270 and
--      before the others, the order of the engine. The rest is exactly as 0301 defined it.
--   4. recipe.execution_violations() also reports (recipe.execution_rule_violations, new) an accepted
--      DISPOSITION_EXCEPTION whose person was involved in the raising step before it: an INVOLVEMENT event of a kind
--      that puts the person in one of the four lists (STARTED, ENTERED_DATA, PERFORMED, CORRECTED, VOIDED,
--      SIGNED_HOLD_POINT), for that person and step, in an accepted command row before the disposition. Involvement
--      that comes after the disposition is not a violation (the engine allows it). The checks of 0210 are carried
--      forward unchanged; later rules are added to recipe.execution_rule_violations, which a later migration replaces
--      whole, carrying this body forward.
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the volatility, the search_path and the
-- privileges of the replaced functions: execution_content_of and check_disposition_state private to the owner,
-- execution_violations executable by ebmr_app (0210). The new functions are private to the owner, every function pins
-- its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The involvement set of a step instance
-- ---------------------------------------------------------------------------------------------

-- INV-03: the persons who started, entered data in, corrected or signed performed step instance p_inst, as a JSON array
-- of engine ids (performers, dataEnterers, correctors, performedSigners; engine guards.ts involvedIn). A member that is
-- not an array, or a missing instance, contributes nothing.
create function recipe.step_involvement(p_inst jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(p.v order by m.n, p.i), '[]'::jsonb)
    from unnest(array['performers', 'dataEnterers', 'correctors', 'performedSigners']) with ordinality m (k, n)
   cross join lateral jsonb_array_elements(case when jsonb_typeof(p_inst -> m.k) = 'array' then p_inst -> m.k else '[]'::jsonb end) with ordinality p (v, i)
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The content provider: an exception raised at a step names the step's involvement set
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
      -- The raiser and the person who linked the deviation, and (F11; INV-03, PR-13, PR-49) everyone involved in the
      -- step the exception was raised at: the kernel never lets them sign its disposition (EBMR-ESIG-044).
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'raisedBy', x -> 'deviation' ->> 'linkedBy')
                                || recipe.step_involvement(case when jsonb_typeof(x -> 'source' -> 'stepKey') = 'string'
                                                                then st -> 'steps' -> (x -> 'source' ->> 'stepKey') end));
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
-- 3. The disposition row: never by a person involved in the raising step
-- ---------------------------------------------------------------------------------------------

-- PR-49, DI-37: as 0301; and (F11; INV-03, PR-13) the disposer is not in the involvement set of the step the exception
-- was raised at, in the stored state before the row (EBMR-EXE-087).
create or replace function recipe.check_disposition_state(p_prior jsonb, p_state jsonb, p_cmd jsonb, p_person uuid, p_signatures uuid[]) returns void
language plpgsql immutable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ex text := coalesce(p_cmd ->> 'exception', 'null');
  x0   jsonb := p_prior -> 'exceptions' -> (p_cmd ->> 'exception');
  x    jsonb := p_state -> 'exceptions' -> (p_cmd ->> 'exception');
  d    jsonb := x -> 'disposition';
  v_step text;
begin
  if jsonb_typeof(x0) is distinct from 'object' or x0 ->> 'status' is distinct from 'OPEN' then
    raise exception using errcode = 'P0001',
      message = format('Exception %s is not open in the stored state, so it cannot be dispositioned (DI-26, PR-49). [EBMR-EXE-086]', v_ex);
  end if;
  if jsonb_typeof(x0 -> 'source' -> 'stepKey') = 'string' then
    v_step := x0 -> 'source' ->> 'stepKey';
    -- (A row always names its person: append_execution takes it from the session. The last check below refuses a
    -- disposition the state records for another person than the signer.)
    if recipe.step_involvement(p_prior -> 'steps' -> v_step) ? p_person::text then
      raise exception using errcode = 'P0001',
        message = format('%s started, entered data in, corrected or signed performed step %s, which raised exception %s, so the disposition is refused: an exception is decided by a person outside the work that raised it (INV-03, PR-13, PR-49). [EBMR-EXE-087]',
                         p_person, v_step, v_ex);
    end if;
  end if;
  if jsonb_typeof(p_cmd -> 'justification') is distinct from 'string' or recipe.reason_is_blank(p_cmd ->> 'justification') then
    raise exception using errcode = 'P0001',
      message = format('The disposition of exception %s has a blank justification; a disposition states why, in words (PR-49, DI-37). [EBMR-EXE-086]', v_ex);
  end if;
  if coalesce(p_cmd ->> 'outcome', '') not in ('NO_IMPACT', 'DEVIATION_RAISED') then
    raise exception using errcode = 'P0001',
      message = format('The disposition of exception %s is %s; it is NO_IMPACT or DEVIATION_RAISED (PR-49). [EBMR-EXE-086]', v_ex, coalesce(p_cmd ->> 'outcome', 'absent'));
  end if;
  if p_cmd ->> 'outcome' = 'NO_IMPACT' and (x0 -> 'deviationRequired') is distinct from 'false'::jsonb then
    raise exception using errcode = 'P0001',
      message = format('Exception %s needs a deviation; "no impact" is not a disposition it allows (PR-08, PR-49). [EBMR-EXE-086]', v_ex);
  end if;
  if p_cmd ->> 'outcome' = 'DEVIATION_RAISED' and jsonb_typeof(x0 -> 'deviation' -> 'ref') is distinct from 'string' then
    raise exception using errcode = 'P0001',
      message = format('Exception %s is dispositioned as a raised deviation, but no deviation is linked to it (PR-49). [EBMR-EXE-086]', v_ex);
  end if;
  if x ->> 'status' is distinct from 'DISPOSITIONED' or cardinality(p_signatures) is distinct from 1
     or d ->> 'outcome' is distinct from p_cmd ->> 'outcome' or d ->> 'justification' is distinct from recipe.js_trim(p_cmd ->> 'justification')
     or d ->> 'signature' is distinct from p_signatures[1]::text or d ->> 'by' is distinct from p_person::text then
    raise exception using errcode = 'P0001',
      message = format('The state records another disposition of exception %s than the signed one (PR-49, DI-37). [EBMR-EXE-086]', v_ex);
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. The invariant query
-- ---------------------------------------------------------------------------------------------

-- The rules of the engine the invariant query checks over the stored rows (no rows in a correct database). Called by
-- recipe.execution_violations; a later migration that adds a rule replaces this function whole, carrying its body.
create function recipe.execution_rule_violations() returns table (batch_id uuid, problem text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
#variable_conflict use_column
declare
  r record;
begin
  -- INV-03, PR-13, PR-49 (F11): an accepted disposition of an exception raised at a step, by a person whose involvement
  -- in that step an accepted command recorded before it.
  for r in
    select d.batch_id as bid, d.seq, d.command ->> 'exception' as exc, d.actor_person, x.step_key
      from recipe.execution_command d
      join recipe.execution_state s on s.batch_id = d.batch_id
     cross join lateral (select s.state -> 'exceptions' -> (d.command ->> 'exception') -> 'source' ->> 'stepKey' as step_key) x
     where d.kind = 'COMMAND' and d.accepted and d.command_type = 'DISPOSITION_EXCEPTION' and x.step_key is not null
       and exists (select 1
                     from recipe.execution_command c
                     join recipe.execution_event e on e.batch_id = c.batch_id and e.row_seq = c.seq
                    where c.batch_id = d.batch_id and c.seq < d.seq and c.kind = 'COMMAND' and c.accepted
                      and e.event_type = 'INVOLVEMENT' and e.event ->> 'stepKey' = x.step_key and e.event ->> 'person' = d.actor_person::text
                      and e.event ->> 'involvement' in ('STARTED', 'ENTERED_DATA', 'PERFORMED', 'CORRECTED', 'VOIDED', 'SIGNED_HOLD_POINT'))
     order by d.batch_id, d.seq
  loop
    batch_id := r.bid;
    problem := format('row %s: exception %s was dispositioned by %s, who was involved in step %s, which raised it (INV-03, PR-13, PR-49)',
                      r.seq, r.exc, r.actor_person, r.step_key);
    return next;
  end loop;
end
$$;

-- As 0210, and the rules of recipe.execution_rule_violations at the end.
create or replace function recipe.execution_violations() returns table (batch_id uuid, problem text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
#variable_conflict use_column
declare
  v_kind text := kernel.installation_kind();
  r      record;
  rw     recipe.execution_command;
  v_prev text;
  v_bat  uuid;
  v_seq  bigint;
begin
  -- DI-05, INV-18: in Phase 2 nothing of this store exists in a GMP database; SANDBOX_ONLY blocks never do.
  if v_kind = 'GMP' then
    for r in select id from recipe.batch_execution loop
      batch_id := r.id; problem := 'a test batch exists in a GMP database (DI-05, INV-18)'; return next;
    end loop;
    for r in select package_hash from recipe.test_package loop
      batch_id := null; problem := format('test package %s exists in a GMP database (DI-05, INV-18)', r.package_hash); return next;
    end loop;
  end if;
  for r in
    select distinct t.package_hash, s.block_type, s.block_version
    from recipe.test_package t
    cross join lateral jsonb_path_query(t.content, 'strict $.**.block') blk
    join recipe.sandbox_only_block s on s.block_type = blk ->> 'type' and s.block_version = blk ->> 'version'
    where v_kind = 'GMP'
  loop
    batch_id := null; problem := format('SANDBOX_ONLY block %s@%s in package %s held by a GMP database (DI-05, INV-18)', r.block_type, r.block_version, r.package_hash);
    return next;
  end loop;
  for r in select id, batch_number from recipe.batch_execution where sandbox.identifier_problem('BATCH_NUMBER', batch_number) is not null loop
    batch_id := r.id; problem := format('batch number %s is not allowed in this installation (DI-05)', r.batch_number); return next;
  end loop;

  -- Sequence, kinds and the hash chain.
  for r in select b.id, count(k.seq) as n, min(k.seq) as lo, max(k.seq) as hi from recipe.batch_execution b left join recipe.execution_command k on k.batch_id = b.id group by b.id loop
    if r.n = 0 or r.lo <> 1 or r.hi <> r.n then
      batch_id := r.id; problem := format('rows are not numbered 1..n without gaps (%s rows, %s..%s) (DI-34)', r.n, r.lo, r.hi); return next;
    end if;
  end loop;
  v_bat := null;
  for rw in select * from recipe.execution_command x order by x.batch_id, x.seq loop
    if v_bat is distinct from rw.batch_id then
      v_bat := rw.batch_id;
      v_prev := recipe.execution_genesis_hash(rw.batch_id);
    end if;
    if rw.prev_row_hash is distinct from v_prev then
      batch_id := rw.batch_id; problem := format('row %s does not link to the previous row hash (DI-34)', rw.seq); return next;
    end if;
    if rw.row_hash is distinct from recipe.execution_row_hash(rw.prev_row_hash, rw) then
      batch_id := rw.batch_id; problem := format('row %s does not match its row hash (changed after it was written) (DI-34)', rw.seq); return next;
    end if;
    if rw.command_hash is distinct from recipe.canonical_hash(rw.command) then
      batch_id := rw.batch_id; problem := format('row %s: the command does not match its hash (DI-34)', rw.seq); return next;
    end if;
    if rw.events_hash is distinct from (select recipe.canonical_hash(coalesce(jsonb_agg(e.event order by e.idx), '[]'::jsonb)) from recipe.execution_event e where e.batch_id = rw.batch_id and e.row_seq = rw.seq) then
      batch_id := rw.batch_id; problem := format('row %s: the stored events do not match the events hash (DI-34)', rw.seq); return next;
    end if;
    if rw.device_class in ('SHARED', 'GRADE_A_B') and rw.auth_event_id is null then
      batch_id := rw.batch_id; problem := format('row %s was written on a shared terminal without a badge-tap event (INV-40)', rw.seq); return next;
    end if;
    v_prev := rw.row_hash;
  end loop;

  -- The projection is the state of the last row.
  for r in
    select p.batch_id as id, p.state_hash, p.state_version, p.last_seq, p.last_row_hash, recipe.canonical_hash(p.state) as computed,
           k.state_hash as row_state, k.state_version as row_version, k.row_hash as row_hash, (select max(x.seq) from recipe.execution_command x where x.batch_id = p.batch_id) as hi
    from recipe.execution_state p left join recipe.execution_command k on k.batch_id = p.batch_id and k.seq = p.last_seq
  loop
    if r.computed is distinct from r.state_hash or r.row_state is distinct from r.state_hash or r.row_version is distinct from r.state_version
       or r.last_seq is distinct from r.hi or r.last_row_hash is distinct from r.row_hash then
      batch_id := r.id; problem := 'the stored state is not the state of the last row (DI-34)'; return next;
    end if;
  end loop;
  for r in select b.id from recipe.batch_execution b where not exists (select 1 from recipe.execution_state p where p.batch_id = b.id) loop
    batch_id := r.id; problem := 'a test batch has no state (DI-34)'; return next;
  end loop;

  -- Content versions: numbered 1..n per aggregate and matching their hash.
  for r in
    select x.aggregate_id, x.batch_id as bid, count(*) as n, max(x.content_version) as hi,
           bool_and(x.content_hash = recipe.canonical_hash(x.content)) as hashes
    from (select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_step_content
          union all select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_stage_content
          union all select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_exception_content
          union all select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_point_content) x
    group by x.aggregate_id, x.batch_id
  loop
    if r.n <> r.hi or not r.hashes then
      batch_id := r.bid; problem := format('signable content of %s is not versioned 1..n or does not match its hash (DI-37)', r.aggregate_id); return next;
    end if;
  end loop;

  -- The engine's rules over the stored rows (F11 and later).
  for r in select v.batch_id as bid, v.problem as msg from recipe.execution_rule_violations() v loop
    batch_id := r.bid; problem := r.msg; return next;
  end loop;
end
$$;

revoke all on function recipe.step_involvement(jsonb), recipe.execution_rule_violations() from public;

-- Privileges: CREATE OR REPLACE kept those of 0210, 0301 and 0302 (execution_content_of and check_disposition_state
-- private to the owner; execution_violations executable by ebmr_app).

reset role;
