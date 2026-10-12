-- Recipe core: a correction's evidence is a document stored with its bytes (Phase 4 slice 2 quick review, HIGH 1; DI-24).
--
-- recipe.gmp_reference_problem (0716, from 0601) matched the evidence's SHA-256 against site.evidence_document alone, so a
-- row registered before site services 0823 without stored bytes (the self-attested form) still counted as evidence of a
-- fail-to-pass correction and of a loop-reading correction. Re-created from 0716: the matching document must also be
-- verified by site.evidence_document_verified (its stored bytes hash to the recorded SHA-256). Nothing else changes;
-- CREATE OR REPLACE keeps the owner and the grants.

set local role ebmr_owner;

create or replace function recipe.gmp_reference_problem(p_batch uuid, p_old jsonb, p_new jsonb, p_kind text, p_cmd jsonb, p_accepted boolean) returns text
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
  -- Phase 4 slice 1a (plan open question 1, default taken): a loop reading that did not meet the loop's endpoint (the
  -- iteration it ended CONTINUEd or was EXHAUSTED) counts as failing. Its correction, whatever the new value, carries a
  -- stored evidence document and the approval of a person in one of the batch policy's QA roles.
  if exists (select 1 from jsonb_each(coalesce(p_old -> 'decisions', '{}'::jsonb)) d
              where d.value ->> 'kind' = 'LOOP' and d.value ->> 'outcome' in ('CONTINUE', 'EXHAUSTED')
                and coalesce(d.value -> 'inputs' -> 'points', '[]'::jsonb) ? (p_cmd ->> 'point')) then
    if p_cmd -> 'approval' is null
       or not exists (select 1 from recipe.batch_execution b
                       where b.id = p_batch and jsonb_typeof(b.policy -> 'qaRoles') = 'array'
                         and (b.policy -> 'qaRoles') ?| recipe.person_engine_roles(nullif(p_cmd -> 'approval' -> 'approver' ->> 'id', '')::uuid)) then
      return format('[603] corrects %s, a loop reading that did not meet the loop''s endpoint, without the approval of QA; such a reading counts as failing (INV-41, DI-24)', p_cmd ->> 'point');
    end if;
    v_doc := p_cmd -> 'evidence' ->> 'sha256';
    if coalesce(v_doc, '') !~ '^[0-9a-f]{64}$' or not exists (select 1 from site.evidence_document e where e.sha256 = v_doc and e.site_code = v_site and site.evidence_document_verified(e.id)) then
      return format('[603] corrects %s, a loop reading that did not meet the loop''s endpoint, without a stored evidence document of the true value at site %s; such a reading counts as failing (INV-41, DI-24)', p_cmd ->> 'point', v_site);
    end if;
    return null;
  end if;
  if not ((x -> 'failed') = 'true'::jsonb and (n -> 'failed') is distinct from 'true'::jsonb) then
    return null;
  end if;
  -- The evidence's SHA-256 names a document stored at the batch's site (the command shape stays as the engine has it).
  v_doc := p_cmd -> 'evidence' ->> 'sha256';
  if coalesce(v_doc, '') !~ '^[0-9a-f]{64}$' then
    return format('[603] makes %s, which failed its limits, pass with evidence that names no stored evidence document; on a GMP batch the evidence is a stored document (DI-24)', p_cmd ->> 'point');
  end if;
  if not exists (select 1 from site.evidence_document e where e.sha256 = v_doc and e.site_code = v_site and site.evidence_document_verified(e.id)) then
    v_prob := format('no evidence document with SHA-256 %s is stored at site %s; store the evidence first (DI-24)', v_doc, v_site);
  end if;
  return case when v_prob is not null then format('[603] makes %s, which failed its limits, pass: %s', p_cmd ->> 'point', v_prob) end;
end
$$;

reset role;
