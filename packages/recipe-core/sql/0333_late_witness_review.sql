-- Recipe core, execution store (module C3): once a witness is no longer possible, a step whose check is a witness is
-- completed by its later review, which records an exception for QA (Phase 2 exit follow-up T12.LATE, critic defect;
-- DI-30, DI-35, PR-14; engine 1.5.0; default T12.2; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- What was wrong. Since recipe-core 0325 (engine 1.4.0, lead TODO T12) a step holding a critical value typed by hand
-- without the photo or printout its MBR names is checked by a witness, as a step the MBR declares WITNESSED is, and
-- recipe.step_check_meanings accepted only WITNESSED there. The kernel refuses a witness signature made more than the
-- witness window after the act (esig.check_witness, EBMR-ESIG-052; esig.witness_window_seconds, 300 s by default) or once
-- the run moved on after it (EBMR-ESIG-051, recipe.next_step_started), and no Phase 2 command completes a step awaiting
-- its check otherwise (skip, correction, void, abort and cancel are later releases). So a witness more than five minutes
-- late (a slow demonstration, a night shift) left the test run stuck at that step for good: dc-mini's blend step 2.1.4
-- among others. The engine's own late-witness path (a late WITNESSED accepted with WITNESS_LATE) could never be reached,
-- and it would have let a late signature stand as a witness. Correction of 0325's header and of decision T12.1, stated
-- here because applied migrations are never edited: T12.1 said that taking the witness "still lets such an MBR run";
-- that held only while the witness came within its window.
--
-- Now, as engine 1.5.0 (guards.ts witnessPossible, checkMeanings; steps.ts verify):
--   * recipe.witness_possible(policy, state, instance, now): a witness can still watch the act of a step instance when
--     it has not ended, or when the act ended no more than the pinned engine policy's witnessWindowUs before `now` and
--     the run has not moved on since (recipe.next_step_started, 0210). An unknown time or window answers that a witness
--     is still possible: the check stays the witness (fail closed);
--   * recipe.step_check_meanings (0325, replaced): where the check is due as a witness (the MBR's WITNESSED, or a critical
--     hand entry without its declared evidence) it asks for WITNESSED only while a witness is possible at the trusted time
--     of the command's transaction (its marker in recipe.execution_clock, never earlier than the time the state last
--     recorded, as the engine's transaction time); once none is, the step's later review: its block's own check meanings,
--     else VERIFIED. recipe.check_signatures (0297) and recipe.step_signature_meanings (0296) read it, so a WITNESSED
--     signature then is refused (EBMR-EXE-051) and so is a later review while a witness is possible, whoever writes the row;
--   * recipe.late_check_record(content, policy, prior state, command, now): the exception the engine raises for an
--     accepted VERIFY that checks a step by its later review because its witness is no longer possible, without its id
--     and time of raising: type WITNESS_LATE, category DEVIATION_OR_OVERRIDE, severity ALERT, controls DI-35 and DI-30,
--     QA only, no deviation required, not registration relevant, blocking neither the stage sign-off nor the release
--     beyond what an open exception does, no block, raised by the verifier at the step instance, and its title, which
--     names the items typed by hand without their declared evidence (or the MBR's witness), why no witness was possible
--     (the window had passed, else the run had moved on), the verifier and the meaning signed. NULL when it raises none;
--   * trigger zzf_execution_late_check (after insert or update of recipe.execution_state, every row; EBMR-EXE-141): an
--     accepted VERIFY for which recipe.late_check_record names an exception adds exactly that exception; no other row
--     adds an exception of type WITNESS_LATE.
-- The kernel's witness rules are unchanged: its window is not widened, and a late signature never counts as a witness.
-- The trusted time is the engine's: the command's database clock, or the last time the state recorded when the clock went
-- back (engine openTx). The engine's window is its pinned policy's (recipe.batch_execution.policy, 300 s); the kernel's is
-- the site policy's (60 to 1800 s). Where the kernel's is shorter, a witness between the two is refused by the kernel
-- (EBMR-ESIG-052) and the later review by the engine and this migration until the engine's has passed too; where it is
-- longer, the engine asks for the later review from its own window on. Neither leaves the step without a way to finish.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function and step_check_meanings are
-- SECURITY DEFINER; every function pins its search_path with pg_temp last. CREATE OR REPLACE keeps step_check_meanings'
-- owner, volatility, SECURITY DEFINER and privileges (none for PUBLIC). Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-35, PR-14 (T12.LATE): whether a witness can still watch the act of step instance p_inst of state p_state at time
-- p_now (epoch microseconds), under engine policy p_policy (header). The TypeScript twin is engine guards.ts
-- witnessPossible.
create function recipe.witness_possible(p_policy jsonb, p_state jsonb, p_inst jsonb, p_now bigint) returns boolean
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ended  bigint := recipe.micros_of(p_inst -> 'endedAt');
  v_window bigint := recipe.micros_of(p_policy -> 'witnessWindowUs');
begin
  if v_ended is null or p_now is null or v_window is null then
    return true;
  end if;
  if p_now - v_ended > v_window then
    return false;
  end if;
  return not coalesce(recipe.next_step_started(p_state, p_inst ->> 'key', v_ended), true);
end
$$;

-- DI-35, PR-14, PR-20 (P37), DI-30 (T12, T12.LATE): the meaning a VERIFY must be signed with on the step it names, as the
-- engine asks for it (actions.ts checkMeaning): RE_VERIFIED_AFTER_CORRECTION while the stored step instance awaits
-- re-verification; WITNESSED where the MBR asks for a witness or the instance holds a critical hand entry without the
-- photo or printout its MBR names, while a witness is still possible at the command's trusted time; else the step block's
-- own check meanings (recipe.block_signature_meaning) or VERIFIED. Empty when the step is not a phase of the batch's MBR
-- content (fail closed).
create or replace function recipe.step_check_meanings(p_batch uuid, p_prior jsonb, p_cmd jsonb) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_content jsonb;
  v_policy  jsonb;
  v_node    jsonb;
  v_inst    jsonb;
  v_own     text[];
  v_marker  bigint;
  v_now     bigint;
begin
  select pk.content, b.policy into v_content, v_policy
    from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = p_batch;
  v_node := recipe.step_node(v_content, p_cmd ->> 'step');
  if v_node ->> 'kind' is distinct from 'phase' then
    return '{}';
  end if;
  v_inst := recipe.step_instance_of(p_prior, p_cmd);
  if (v_inst -> 'reverification') = 'true'::jsonb then
    return array['RE_VERIFIED_AFTER_CORRECTION'];
  end if;
  if v_node -> 'signatures' -> 'check' ->> 'meaning' = 'WITNESSED'
     or cardinality(recipe.hand_entries_without_declared_evidence(v_content, p_prior, v_inst ->> 'key')) > 0 then
    -- The trusted time of this command (recipe.execution_marker, 0210), never earlier than the state's last recorded
    -- time (engine openTx). Without a marker in this transaction the time is unknown: the witness stays due.
    select c.now_us into v_marker from recipe.execution_clock c
     where c.xact_id = pg_current_xact_id_if_assigned() and c.backend_pid = pg_backend_pid() and c.batch_id = p_batch;
    v_now := case when v_marker is not null then greatest(v_marker, coalesce(recipe.micros_of(p_prior -> 'lastRecordedUs'), v_marker)) end;
    if recipe.witness_possible(v_policy, p_prior, v_inst, v_now) then
      return array['WITNESSED'];
    end if;
  end if;
  v_own := array(select m.meaning_code from recipe.block_signature_meaning m
                  where m.block_type = v_node -> 'block' ->> 'type' and m.block_version = v_node -> 'block' ->> 'version' and m.part = 'check'
                  order by 1);
  return case when cardinality(v_own) > 0 then v_own else array['VERIFIED'] end;
end
$$;

-- DI-35, DI-30, PR-14 (T12.LATE): the exception (header) the engine raises for the accepted VERIFY p_cmd on prior state
-- p_prior of a batch of MBR content p_content and engine policy p_policy at trusted time p_now, without its id, raisedAt
-- and raisedSeq, as the state encodes it; NULL when it raises none (the step's witness is not due, it awaits
-- re-verification, or a witness is still possible). The TypeScript twin is engine steps.ts verify.
create function recipe.late_check_record(p_content jsonb, p_policy jsonb, p_prior jsonb, p_cmd jsonb, p_now bigint) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_node   jsonb := recipe.step_node(p_content, p_cmd ->> 'step');
  v_inst   jsonb := recipe.step_instance_of(p_prior, p_cmd);
  v_key    text;
  v_items  text[];
  v_why    text;
  v_what   text;
begin
  if v_node ->> 'kind' is distinct from 'phase' or jsonb_typeof(v_inst) is distinct from 'object' or (v_inst -> 'reverification') = 'true'::jsonb then
    return null;
  end if;
  v_key := v_inst ->> 'key';
  -- The items in the engine's order (JavaScript's sort of the ids: code point order for these ids).
  v_items := array(select x from unnest(recipe.hand_entries_without_declared_evidence(p_content, p_prior, v_key)) x order by x collate "C");
  if not (coalesce(v_node -> 'signatures' -> 'check' ->> 'meaning' = 'WITNESSED', false) or cardinality(v_items) > 0) then
    return null;
  end if;
  if recipe.witness_possible(p_policy, p_prior, v_inst, p_now) then
    return null;
  end if;
  v_why := case when p_now - recipe.micros_of(v_inst -> 'endedAt') > recipe.micros_of(p_policy -> 'witnessWindowUs')
                then 'the witness window after the act had passed'
                else 'the run moved on after the act (another step started or recorded data)' end;
  v_what := case when cardinality(v_items) > 0
                 then format('%s at %s %s typed by hand with neither the photo or printout the MBR names nor a witness',
                             array_to_string(v_items, ', '), v_key, case when cardinality(v_items) = 1 then 'was' else 'were' end)
                 else format('The witness the MBR requires at %s was not given', v_key) end;
  return jsonb_build_object(
    'type', 'WITNESS_LATE', 'category', 'DEVIATION_OR_OVERRIDE',
    'title', format('%s: %s, so %s checked the step later (%s); QA must disposition this exception', v_what, v_why,
                    p_cmd -> 'actor' ->> 'id', p_cmd -> 'signature' ->> 'meaning'),
    'controls', '["DI-35", "DI-30"]'::jsonb, 'severity', 'ALERT',
    'source', jsonb_build_object('stepKey', v_key, 'step', v_inst -> 'step', 'frames', coalesce(v_inst -> 'frames', '[]'::jsonb)),
    'raisedBy', p_cmd -> 'actor' -> 'id',
    'deviationRequired', false, 'registrationRelevant', false, 'qaOnly', true, 'stageSignOffBlocked', false, 'releaseBlocking', false,
    'status', 'OPEN');
end
$$;

-- DI-35, DI-30, PR-14 (T12.LATE): an accepted VERIFY that checks a step by its later review because its witness is no
-- longer possible adds exactly the exception the engine raises for it (recipe.late_check_record); no other row adds an
-- exception of type WITNESS_LATE (EBMR-EXE-141). Raises; returns nothing.
create function recipe.execution_late_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_old     jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  v_content jsonb;
  v_policy  jsonb;
  v_want    jsonb;
  v_row     text;
  v_n       integer := 0;
  k         text;
  x         jsonb;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.kind = 'COMMAND' and r.accepted is true and r.command_type = 'VERIFY' then
    select pk.content, b.policy into v_content, v_policy
      from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
    v_want := recipe.late_check_record(v_content, v_policy, v_old, r.command,
                                       greatest(r.now_us, coalesce(recipe.micros_of(v_old -> 'lastRecordedUs'), r.now_us)));
  end if;
  v_row := format('%s %s', case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                  coalesce(r.command_type, r.kind, 'unknown'));
  for k, x in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(new.state -> 'exceptions') = 'object' then new.state -> 'exceptions' else '{}'::jsonb end) e
               where not coalesce((v_old -> 'exceptions') ? e.key, false) and e.value ->> 'type' = 'WITNESS_LATE'
               order by e.key
  loop
    v_n := v_n + 1;
    if v_want is null or v_n > 1 then
      raise exception using errcode = 'P0001',
        message = format('This %s row adds exception %s of type WITNESS_LATE, which only the later review of a step whose witness is no longer possible raises, once: a witness window that has passed or a run that moved on is the record''s to say, not the writer''s (DI-35, DI-30, PR-14). [EBMR-EXE-141]',
                         v_row, k);
    end if;
    if jsonb_typeof(x) is distinct from 'object' or (x - 'raisedAt' - 'raisedSeq') is distinct from (v_want || jsonb_build_object('id', k)) then
      raise exception using errcode = 'P0001',
        message = format('This %s row records exception %s otherwise than the later review of step %s raises it: its type, title, QA-only and other flags, source and raiser follow from the step, the time and the review (DI-35, DI-30, PR-14). [EBMR-EXE-141]',
                         v_row, k, v_want -> 'source' ->> 'stepKey');
    end if;
  end loop;
  if v_want is not null and v_n = 0 then
    raise exception using errcode = 'P0001',
      message = format('This %s row checks step %s by a later review (%s) where a witness was due and is no longer possible, and records no exception for it: the review records WITNESS_LATE, which QA dispositions (DI-35, DI-30, PR-14). [EBMR-EXE-141]',
                       v_row, v_want -> 'source' ->> 'stepKey', r.command -> 'signature' ->> 'meaning');
  end if;
  return null;
end
$$;

create trigger zzf_execution_late_check after insert or update on recipe.execution_state
  for each row execute function recipe.execution_late_check();

revoke all on function recipe.witness_possible(jsonb, jsonb, jsonb, bigint), recipe.late_check_record(jsonb, jsonb, jsonb, jsonb, bigint),
  recipe.execution_late_check() from public;

reset role;
