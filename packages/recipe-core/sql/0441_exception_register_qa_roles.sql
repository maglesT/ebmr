-- Recipe core, execution store (module C3): a QA-only exception is dispositioned only by the quality unit (Phase 3 slice 2
-- quick review, finding 3; PR-08, PR-13; ADR 0012).
--
-- What was wrong. recipe.exception_register_sync (0440) accepted the disposition of a QA-only exception (limit tier
-- REGISTERED or VALIDATED, DECISION_AFFECTING_CORRECTION, or flagged qaOnly) when the row's verified engine roles held
-- any role the batch policy lists in qaRoles. The application chooses that policy at issue (the database checks only
-- its shape and hash), so a batch pinned with qaRoles naming PRODUCTION_SUPERVISOR let a supervisor whose kernel role
-- holds a QA permission disposition a registered-tier breach.
--
-- What changed. The role must be one of the fixed quality-unit engine roles, QA and QA_REVIEWER (the list 0451 uses for
-- the quality unit), and also one the batch's policy counts as QA (the engine's own rule, so the database stays at
-- least as strict as the engine). EBMR-EXE-162 as before. The rest of the function is 0440's body unchanged.
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the search_path, the privileges (none for PUBLIC)
-- and the trigger zzr_exception_register. Applied as a new migration because applied migrations are never edited.

set local role ebmr_owner;

create or replace function recipe.exception_register_sync() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  c        recipe.execution_command;
  b        recipe.batch_execution;
  v_prior  jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  v_now    jsonb := case when jsonb_typeof(new.state -> 'exceptions') = 'object' then new.state -> 'exceptions' else '{}'::jsonb end;
  v_cmd    text;
  v_ex     text;
  k        text;
  x        jsonb;
  reg      recipe.exception_register;
  v_link   recipe.exception_register_act;
  v_disp   recipe.exception_register_act;
  v_own    boolean;
  v_extra  text;
begin
  select * into c from recipe.execution_command where batch_id = new.batch_id and seq = new.last_seq;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('The state of batch %s names row %s, which is not recorded, so its exceptions cannot be registered (DI-26, INV-41). [EBMR-EXE-160]', new.batch_id, new.last_seq);
  end if;
  v_cmd := case when c.kind = 'COMMAND' and c.accepted then c.command_type end;
  v_ex := recipe.json_text(c.command, 'exception');

  for k, x in select e.key, e.value from jsonb_each(v_now) e order by e.key loop
    select * into reg from recipe.exception_register r where r.batch_id = new.batch_id and r.exception_id = k;
    if not found then
      if jsonb_typeof(v_prior -> 'exceptions') = 'object' and (v_prior -> 'exceptions') ? k then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is in the state of the batch but not in the register; the state and the register are kept together (DI-26, INV-41). [EBMR-EXE-160]', k);
      end if;
      if x ->> 'status' is distinct from 'OPEN' or x ? 'disposition' or x ? 'deviation' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s arrives already linked or closed; an exception is raised open and closes only by its disposition (DI-26, INV-41). [EBMR-EXE-161]', k);
      end if;
      perform recipe.register_exception(c, k, x);
      continue;
    end if;
    if recipe.exception_as_raised(x) is distinct from reg.raised_record then
      raise exception using errcode = 'P0001',
        message = format('Exception %s no longer has the facts the register holds for it (type, tier, flags, source, block or title changed); an exception stays as it was raised (DI-26, INV-41). [EBMR-EXE-160]', k);
    end if;

    -- The deviation link: only by an accepted ATTACH_DEVIATION of this exception, by its linker; never changed after.
    select * into v_link from recipe.exception_register_act a where a.batch_id = new.batch_id and a.exception_id = k and a.act = 'DEVIATION_LINKED';
    if v_link.id is null and x ? 'deviation' then
      if v_cmd is distinct from 'ATTACH_DEVIATION' or v_ex is distinct from k or jsonb_typeof(x -> 'deviation') is distinct from 'object'
         or recipe.json_text(x -> 'deviation', 'linkedBy') is distinct from c.actor_person::text
         or coalesce(btrim(recipe.json_text(x -> 'deviation', 'ref')), '') = '' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is linked to a deviation by a %s row; a deviation is linked only by its own ATTACH_DEVIATION, by the person who links it (PR-08, INV-41). [EBMR-EXE-161]', k, c.command_type);
      end if;
      insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, deviation_ref, correlation_id)
      values (new.batch_id, k, 'DEVIATION_LINKED', c.seq, c.actor_person, c.actor_account, c.actor_role, x -> 'deviation' ->> 'ref', c.correlation_id);
    elsif v_link.id is not null and (recipe.json_text(x -> 'deviation', 'ref') is distinct from v_link.deviation_ref
                                     or recipe.json_text(x -> 'deviation', 'linkedBy') is distinct from v_link.by_person::text) then
      raise exception using errcode = 'P0001',
        message = format('The deviation link of exception %s was changed or taken away; a link is never changed (INV-41, PR-08). [EBMR-EXE-161]', k);
    end if;

    -- The disposition: an exception closes only by its own signed DISPOSITION_EXCEPTION (INV-41), never reopens.
    select * into v_disp from recipe.exception_register_act a where a.batch_id = new.batch_id and a.exception_id = k and a.act = 'DISPOSITIONED';
    if v_disp.id is null and (x ->> 'status' is distinct from 'OPEN' or x ? 'disposition') then
      v_own := v_cmd = 'DISPOSITION_EXCEPTION' and v_ex = k and x ->> 'status' = 'DISPOSITIONED' and jsonb_typeof(x -> 'disposition') = 'object'
               and recipe.json_text(x -> 'disposition', 'by') = c.actor_person::text
               and recipe.json_text(x -> 'disposition', 'signature') = any (c.signature_ids::text[])
               and recipe.json_text(x -> 'disposition', 'outcome') in ('NO_IMPACT', 'DEVIATION_RAISED')
               and coalesce(btrim(recipe.json_text(x -> 'disposition', 'justification')), '') <> '';
      if not coalesce(v_own, false) then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is closed by a %s row; an exception closes only by its own signed disposition, never by a correction or any other change (INV-41, DI-26). [EBMR-EXE-161]', k, c.command_type);
      end if;
      if reg.qa_only then
        select * into b from recipe.batch_execution where id = new.batch_id;
        if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(c.roles) = 'array' then c.roles else '[]'::jsonb end) r
                        where r ->> 'role' = any (array['QA', 'QA_REVIEWER'])
                          and jsonb_typeof(b.policy -> 'qaRoles') = 'array' and (b.policy -> 'qaRoles') ? (r ->> 'role')) then
          raise exception using errcode = 'P0001',
            message = format('Exception %s (%s%s) is dispositioned only by QA, and the row holds no quality-unit role (QA, QA_REVIEWER) that the batch counts as QA; the disposition is refused (PR-08, PR-13). [EBMR-EXE-162]',
                             k, reg.exception_type, coalesce(', tier ' || reg.tier, ''));
        end if;
      end if;
      v_extra := null;
      if recipe.exception_step_involvement(new.batch_id, v_prior, k, c.seq) ? c.actor_person::text then
        v_extra := 'was involved in the step that raised it';
      elsif reg.raised_by = c.actor_person::text then
        v_extra := 'raised it';
      end if;
      if v_extra is not null then
        raise exception using errcode = 'P0001',
          message = format('%s %s, so the disposition of exception %s is refused: an exception is decided by a person outside the work that raised it (INV-03, PR-13). [EBMR-EXE-163]',
                           c.actor_person, v_extra, k);
      end if;
      insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, outcome, signature_id, note, correlation_id)
      values (new.batch_id, k, 'DISPOSITIONED', c.seq, c.actor_person, c.actor_account, c.actor_role, x -> 'disposition' ->> 'outcome',
              (x -> 'disposition' ->> 'signature')::uuid, x -> 'disposition' ->> 'justification', c.correlation_id);
    elsif v_disp.id is not null and (x ->> 'status' is distinct from 'DISPOSITIONED'
                                     or recipe.json_text(x -> 'disposition', 'by') is distinct from v_disp.by_person::text
                                     or recipe.json_text(x -> 'disposition', 'outcome') is distinct from v_disp.outcome
                                     or recipe.json_text(x -> 'disposition', 'signature') is distinct from v_disp.signature_id::text
                                     or recipe.json_text(x -> 'disposition', 'justification') is distinct from v_disp.note) then
      raise exception using errcode = 'P0001',
        message = format('The disposition of exception %s was changed or taken away; a disposition is never changed and an exception never reopens (INV-41, DI-26). [EBMR-EXE-161]', k);
    end if;
  end loop;

  -- Never deleted: every registered exception of the batch is still in the state.
  select r.exception_id into k from recipe.exception_register r where r.batch_id = new.batch_id and not (v_now ? r.exception_id) order by r.exception_id limit 1;
  if k is not null then
    raise exception using errcode = 'P0001',
      message = format('Exception %s is in the register but no longer in the state of the batch; an exception is never removed (DI-26, INV-41). [EBMR-EXE-160]', k);
  end if;
  return null;
end
$$;

reset role;
