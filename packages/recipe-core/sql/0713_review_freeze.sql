-- Recipe core: the record in review is frozen, and QA's acceptance of a GMP item is the signed review disposition only
-- (Phase 4 slice 1a; outline 5.2.2 "after PRODUCTION_APPROVED corrections go only through a QA reopen"; L-09, INV-30,
-- PR-52, DI-34).
--
--   * Trigger zzzr_execution_review_freeze (after update on recipe.execution_state, only when the state hash changes):
--     while the current review cycle holds a production approval (the record is PRODUCTION_APPROVED or QA_REVIEWED), no
--     execution row may change the record: a correction, a disposition, a deviation link or any other command waits for a
--     QA reopen (recipe.reopen_review), which starts a new cycle. EBMR-REV-040.
--   * recipe.review_exception is replaced from its latest definition (0601) with one addition: on a GMP batch the unsigned
--     ACCEPTED_BY_QA is refused (EBMR-REV-059); QA accepts items through recipe.dispose_review_items.

set local role ebmr_owner;

create function recipe.execution_review_freeze_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if exists (select 1 from recipe.batch_review_act a
              where a.batch_id = new.batch_id and a.cycle = recipe.batch_review_cycle(new.batch_id)
                and a.act in ('PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED')) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-040 the record of batch %s is %s: nothing in it changes until QA reopens its review with a reason; corrections after the production approval go only through a reopen (L-09)',
                       new.batch_id, recipe.batch_review_state(new.batch_id));
  end if;
  return null;
end
$$;

create trigger zzzr_execution_review_freeze after update on recipe.execution_state
  for each row when (old.state_hash is distinct from new.state_hash) execute function recipe.execution_review_freeze_check();

-- As 0601_gmp_deviation_references.sql, with the GMP acceptance refused (header).
create or replace function recipe.review_exception(p_batch uuid, p_exception text, p_act text, p_note text, p_deviation_ref text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := recipe.execution_actor('Reviewing an exception of a test run');
  v_perms  text[];
  v_held   text[];
  v_perm   text;
  v_person uuid := (v_actor ->> 'person_id')::uuid;
  reg      recipe.exception_register;
  v_disp   recipe.exception_register_act;
  v_last   recipe.exception_register_act;
  v_query  recipe.exception_register_act;
  v_state  jsonb;
  v_id     bigint;
  v_prob   text;
begin
  select permissions into v_perms from recipe.exception_review_permission where act = p_act;
  if v_perms is null then
    raise exception using errcode = 'P0001',
      message = format('%s is not a review act; an exception is QUERIED, RESPONDED, ACCEPTED_BY_QA or ESCALATED in review (DI-26). [EBMR-EXE-164]', coalesce(p_act, 'null'));
  end if;
  v_held := iam.role_permissions_at(v_actor ->> 'role_code', clock_timestamp());
  select p into v_perm from unnest(v_perms) with ordinality as x (p, i) where p = any (v_held) order by i limit 1;
  perform iam.require_permission(coalesce(v_perm, v_perms[1]), iam.actor_location_scope());

  select * into reg from recipe.exception_register r where r.batch_id = p_batch and r.exception_id = p_exception for update;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('Test batch %s has no registered exception %s (DI-26). [EBMR-EXE-164]', p_batch, coalesce(p_exception, 'null'));
  end if;
  select * into v_disp from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = p_exception and a.act = 'DISPOSITIONED';
  select * into v_last from recipe.exception_register_act a
   where a.batch_id = p_batch and a.exception_id = p_exception and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED') order by a.id desc limit 1;
  if v_last.act in ('ACCEPTED_BY_QA', 'ESCALATED') then
    raise exception using errcode = 'P0001',
      message = format('Exception %s was already %s in review; its review is concluded (DI-26). [EBMR-EXE-164]', p_exception, lower(replace(v_last.act, '_', ' ')));
  end if;
  -- Phase 4 slice 1a (PR-52, INV-30, DI-34): on a GMP batch QA accepts an item only in the QA review of the record,
  -- signed (recipe.dispose_review_items); the unsigned act stays for test runs. Queries, answers and escalations stay.
  if p_act = 'ACCEPTED_BY_QA' and exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-059 on a GMP batch QA accepts exception %s only in the QA review of the record, with its signed disposition (PR-52, INV-30, DI-34)', p_exception);
  end if;
  if p_act <> 'ACCEPTED_BY_QA' and (p_note is null or recipe.reason_is_blank(p_note)) then
    raise exception using errcode = 'P0001',
      message = format('A %s review act on exception %s states its text in words (DI-26, PR-49). [EBMR-EXE-164]', p_act, p_exception);
  end if;

  case p_act
    when 'QUERIED' then
      if v_last.act = 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has an open query; it is answered before another is asked (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
    when 'RESPONDED' then
      if v_last.act is distinct from 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has no open query to respond to (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
      if v_last.by_person = v_person then
        raise exception using errcode = 'P0001',
          message = format('%s asked the query on exception %s and cannot answer it too (INV-03, DI-26). [EBMR-EXE-165]', v_person, p_exception);
      end if;
    when 'ACCEPTED_BY_QA', 'ESCALATED' then
      if p_act = 'ACCEPTED_BY_QA' and v_disp.id is null then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is still open; QA accepts an exception in review only after its disposition, and a review never closes it (DI-26, INV-41). [EBMR-EXE-164]', p_exception);
      end if;
      if p_act = 'ACCEPTED_BY_QA' and v_last.act = 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has an open query; it is answered before QA accepts the exception (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
      if p_act = 'ESCALATED' and (p_deviation_ref is null or recipe.reason_is_blank(p_deviation_ref)) then
        raise exception using errcode = 'P0001',
          message = format('An escalation of exception %s names the deviation it is escalated to (DI-26, PR-49). [EBMR-EXE-164]', p_exception);
      end if;
      -- On a GMP batch the escalation names a deviation-lite record linked to it (slice 5a, D-S5-2).
      if p_act = 'ESCALATED' and exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.installation = 'GMP') then
        v_prob := site.deviation_ref_problem(btrim(p_deviation_ref), 'LINK', p_batch);
        if v_prob is not null then
          raise exception using errcode = 'P0001',
            message = format('Exception %s cannot be escalated to %s: %s (PR-49, PR-13). [EBMR-EXE-604]', p_exception, btrim(p_deviation_ref), v_prob);
        end if;
      end if;
      select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch;
      if recipe.exception_step_involvement(p_batch, v_state, p_exception, null) ? v_person::text or reg.raised_by = v_person::text
         or v_disp.by_person = v_person then
        raise exception using errcode = 'P0001',
          message = format('%s raised, worked in the step of, or dispositioned exception %s, so they cannot conclude its review (INV-03, DI-26). [EBMR-EXE-165]', v_person, p_exception);
      end if;
  end case;

  insert into recipe.exception_register_act (batch_id, exception_id, act, by_person, by_account, role_code, deviation_ref, note, correlation_id)
  values (p_batch, p_exception, p_act, v_person, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code',
          case when p_act = 'ESCALATED' then btrim(p_deviation_ref) end, case when p_note is null or recipe.reason_is_blank(p_note) then null else p_note end,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function recipe.execution_review_freeze_check() from public;

reset role;
