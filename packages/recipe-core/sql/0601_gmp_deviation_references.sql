-- Recipe core: every deviation or investigation reference a GMP batch records is checked in the database (Phase 3
-- slice 5a; slice 5 plan D-S5-2; backlog slice 2 #1b and #6; controls IN-20, PR-49, DI-24, INV-41).
--
-- Until now a GMP batch recorded any non-blank text as the deviation linked to an exception (ATTACH_DEVIATION), as the
-- investigation behind an invalidation (INVALIDATE_RESULT) and as the deviation an exception is escalated to in review
-- (recipe.review_exception, ESCALATED); the objective evidence of a correction from fail to pass was only a SHA-256 the
-- client gave. On a GMP batch now (sandbox test runs keep reference-only links: D-S5-2, DI-05):
--   * ATTACH_DEVIATION: the reference names a deviation-lite record of the batch's site, not cancelled, linked to the
--     batch (site.deviation_ref_problem, use LINK);
--   * DISPOSITION_EXCEPTION with outcome DEVIATION_RAISED: the linked record is still valid (use DISPOSITION);
--   * INVALIDATE_RESULT: an OOS or investigation record linked to the batch, concluded by QA with an assignable cause
--     (use INVALIDATION);
--   * CORRECT_ENTRY from fail to pass: the evidence's SHA-256 is that of an evidence document stored at the batch's
--     site (site services 0731), so the evidence is a stored document, not a typed hash;
--   * ESCALATED in review: the reference names a valid record linked to the batch (use LINK).
-- Rows recorded before this migration are not rewritten (D-S5-2).
--
-- recipe.gmp_reference_problem is new; recipe.execution_change_path_check is replaced from its latest definition (0502)
-- with one addition: after recipe.change_path_problem, the GMP reference check of the row. recipe.change_path_problem and
-- recipe.check_exception_changes need no change: they read no batch, and every accepted command that records a
-- reference reaches this trigger with its batch. recipe.review_exception is replaced from its latest definition (0440)
-- with one addition: the ESCALATED reference check on a GMP batch.
-- Messages: EBMR-EXE-600 to 604.

set local role ebmr_owner;

-- NULL when the accepted command p_cmd (kind p_kind) of GMP batch p_batch records only references the deviation-lite
-- register and the evidence store accept, else '[60n] why not'. Sandbox batches and refused or non-command rows: NULL.
create function recipe.gmp_reference_problem(p_batch uuid, p_old jsonb, p_new jsonb, p_kind text, p_cmd jsonb, p_accepted boolean) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_type text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_site text;
  v_prob text;
  v_doc  text;
  x      jsonb;
  n      jsonb;
begin
  if v_type is null or v_type not in ('ATTACH_DEVIATION', 'DISPOSITION_EXCEPTION', 'INVALIDATE_RESULT', 'CORRECT_ENTRY') then
    return null;
  end if;
  select b.site_code into v_site from recipe.batch_execution b where b.id = p_batch and b.installation = 'GMP';
  if v_site is null then
    return null;
  end if;
  if v_type = 'ATTACH_DEVIATION' then
    v_prob := site.deviation_ref_problem(recipe.js_trim(p_cmd ->> 'deviationRef'), 'LINK', p_batch);
    return case when v_prob is not null then format('[600] links exception %s to %s: %s', p_cmd ->> 'exception', coalesce(recipe.js_trim(p_cmd ->> 'deviationRef'), 'no reference'), v_prob) end;
  end if;
  if v_type = 'DISPOSITION_EXCEPTION' then
    if p_cmd ->> 'outcome' is distinct from 'DEVIATION_RAISED' then
      return null;
    end if;
    v_prob := site.deviation_ref_problem(p_new -> 'exceptions' -> (p_cmd ->> 'exception') -> 'deviation' ->> 'ref', 'DISPOSITION', p_batch);
    return case when v_prob is not null then format('[601] dispositions exception %s as deviation raised: %s', p_cmd ->> 'exception', v_prob) end;
  end if;
  if v_type = 'INVALIDATE_RESULT' then
    v_prob := site.deviation_ref_problem(recipe.js_trim(p_cmd ->> 'investigationRef'), 'INVALIDATION', p_batch);
    return case when v_prob is not null then format('[602] invalidates %s citing %s: %s', p_cmd ->> 'point', coalesce(recipe.js_trim(p_cmd ->> 'investigationRef'), 'no investigation'), v_prob) end;
  end if;
  -- CORRECT_ENTRY: only a correction from fail to pass carries objective evidence (INV-41).
  x := p_old -> 'points' -> (p_cmd ->> 'point');
  n := p_new -> 'points' -> (p_new -> 'points' -> (p_cmd ->> 'point') ->> 'supersededBy');
  if not ((x -> 'failed') = 'true'::jsonb and (n -> 'failed') is distinct from 'true'::jsonb) then
    return null;
  end if;
  -- The evidence's SHA-256 names a document stored at the batch's site (the command shape stays as the engine has it).
  v_doc := p_cmd -> 'evidence' ->> 'sha256';
  if coalesce(v_doc, '') !~ '^[0-9a-f]{64}$' then
    return format('[603] makes %s, which failed its limits, pass with evidence that names no stored evidence document; on a GMP batch the evidence is a stored document (DI-24)', p_cmd ->> 'point');
  end if;
  if not exists (select 1 from site.evidence_document e where e.sha256 = v_doc and e.site_code = v_site) then
    v_prob := format('no evidence document with SHA-256 %s is stored at site %s; store the evidence first (DI-24)', v_doc, v_site);
  end if;
  return case when v_prob is not null then format('[603] makes %s, which failed its limits, pass: %s', p_cmd ->> 'point', v_prob) end;
end
$$;

-- As 0502_gmp_batch_content_readers.sql; the GMP reference check added after recipe.change_path_problem (header).
create or replace function recipe.execution_change_path_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text := '178';
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := recipe.change_path_problem(old.state, new.state, r.kind, r.command, r.accepted, r.actor_person::text, v_content);
  if v_problem is not null then
    if v_problem ~ '^\[1[0-9]{2}\] ' then
      v_code := substr(v_problem, 2, 3);
      v_problem := substr(v_problem, 7);
    end if;
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: it %s. A skip, a void, an invalidation, a correction from fail to pass, an abort and a cancellation are recorded only on the conditions the engine sets, and nothing else aborts, cancels or revives a batch',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem)
                || case v_code
                     when '172' then ' (PR-13, DI-07, DI-34). [EBMR-EXE-172]'
                     when '173' then ' (DI-24, DI-29). [EBMR-EXE-173]'
                     when '174' then ' (DI-29, INV-41). [EBMR-EXE-174]'
                     when '175' then ' (INV-41, PR-12, DI-24). [EBMR-EXE-175]'
                     when '176' then ' (DI-34, DI-35). [EBMR-EXE-176]'
                     when '177' then ' (PR-10, DI-34). [EBMR-EXE-177]'
                     else ' (DI-34, DI-24). [EBMR-EXE-178]'
                   end;
  end if;
  -- The GMP references of the row (slice 5a, D-S5-2).
  v_problem := recipe.gmp_reference_problem(new.batch_id, old.state, new.state, r.kind, r.command, r.accepted);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This accepted %s row of a GMP batch cannot be recorded: it %s. A GMP batch cites only deviation-lite records of its site that are linked to it, and a correction from fail to pass names a stored evidence document',
                       coalesce(r.command_type, r.kind, 'unknown'), substr(v_problem, 7))
                || case substr(v_problem, 2, 3)
                     when '600' then ' (PR-49, IN-20). [EBMR-EXE-600]'
                     when '601' then ' (PR-49, PR-50). [EBMR-EXE-601]'
                     when '602' then ' (IN-20, DI-24, INV-41). [EBMR-EXE-602]'
                     else ' (DI-24, INV-41). [EBMR-EXE-603]'
                   end;
  end if;
  return null;
end
$$;

-- As 0440_exception_register.sql; on a GMP batch an escalation names a valid deviation-lite record linked to the batch
-- (EBMR-EXE-604; header).
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

reset role;
