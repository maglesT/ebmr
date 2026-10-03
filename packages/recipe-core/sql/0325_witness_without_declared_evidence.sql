-- Recipe core, execution store: a step holding a critical value typed by hand without the photo or printout its MBR
-- names as the value's evidence is checked by a witness (WITNESSED), not reviewed later (VERIFIED) (Phase 2 exit, lead
-- TODO T12; DI-30, PR-14, DI-35; engine 1.4.0; ADR 0012: the rule holds when the application's own database
-- credentials are used directly).
--
-- What was wrong. The validator lets the second person of a step that records a critical value typed by hand review it
-- later (VERIFIED) only where the MBR names a photo or printout as the value's evidence (GMP-WITNESS): the reviewer then
-- compares the value with the attachment. Otherwise a witness must watch the act. In this release no hand entry carries
-- an attachment: the server and the database refuse an attachment hash until an attachment store exists (EBMR-EXE-122,
-- recipe-core 0285 and 0300). So a value the MBR backs with a printout (dc-mini's blend time and blender speed) was
-- typed by hand with nothing behind it, and the step was completed by a later review of that value alone: the check the
-- MBR relies on had nothing to check against, and nobody watched the entry.
--
-- Now, as engine 1.4.0 (guards.ts handEntriesWithoutDeclaredEvidence, checkMeanings), recipe.step_check_meanings asks
-- for WITNESSED where the step instance holds a current (VALID) value typed by hand (source MANUAL) of a parameter the
-- MBR content declares CRITICAL with evidence PHOTO or PRINTOUT, and the value carries no attachment of that kind
-- (recipe.hand_entries_without_declared_evidence). Re-verification after a correction keeps precedence, as before; the
-- MBR's own WITNESSED, the block's own check and VERIFIED follow as in 0295. recipe.check_signatures (0295, 0297) and
-- recipe.step_signature_meanings (0296) read the check from this function, so a VERIFY signed VERIFIED on such a step is
-- refused (EBMR-EXE-051) whoever writes the row. The parameters are read from the batch's own MBR content
-- (content.parameters), as 0300 reads them for the hand-entry rules.
--
-- The functions keep their owner (ebmr_owner), SECURITY DEFINER where they had it, pinned search_path with pg_temp
-- last, and privileges (none for PUBLIC). Applied as a new migration because applied migrations are checksummed and
-- never edited.

set local role ebmr_owner;

-- DI-30 (T12): the items of step instance p_key in state p_state that hold a critical value typed by hand whose
-- parameter in MBR content p_content names a photo or a printout as its evidence, without an attachment of that kind;
-- sorted, empty when none. The TypeScript twin is engine guards.ts handEntriesWithoutDeclaredEvidence.
create function recipe.hand_entries_without_declared_evidence(p_content jsonb, p_state jsonb, p_key text) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(distinct pt.value ->> 'item' order by pt.value ->> 'item'), '{}'::text[])
    from jsonb_each(case when jsonb_typeof(p_state -> 'points') = 'object' then p_state -> 'points' else '{}'::jsonb end) pt
    join lateral (select p from jsonb_array_elements(case when jsonb_typeof(p_content -> 'parameters') = 'array' then p_content -> 'parameters' else '[]'::jsonb end) p
                   where p ->> 'id' = pt.value ->> 'item') par on true
   where pt.value ->> 'stepKey' = p_key
     and pt.value ->> 'kind' = 'VALUE'
     and pt.value ->> 'status' = 'VALID'
     and pt.value -> 'source' ->> 'mode' = 'MANUAL'
     and par.p ->> 'criticality' = 'CRITICAL'
     and par.p ->> 'evidence' in ('PHOTO', 'PRINTOUT')
     and (pt.value -> 'source' -> 'evidence' ->> 'kind') is distinct from (par.p ->> 'evidence')
$$;

-- DI-35, PR-14, PR-20 (P37), DI-30 (T12): the meaning a VERIFY must be signed with on the step it names, as the engine
-- asks for it (actions.ts checkMeaning): RE_VERIFIED_AFTER_CORRECTION while the stored step instance awaits
-- re-verification; WITNESSED where the MBR asks for a witness or the instance holds a critical hand entry without the
-- photo or printout its MBR names; else the step block's own check meanings (recipe.block_signature_meaning) or
-- VERIFIED. Empty when the step is not a phase of the batch's MBR content (fail closed).
create or replace function recipe.step_check_meanings(p_batch uuid, p_prior jsonb, p_cmd jsonb) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_content jsonb;
  v_node    jsonb;
  v_inst    jsonb;
  v_own     text[];
begin
  select pk.content into v_content
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
    return array['WITNESSED'];
  end if;
  v_own := array(select m.meaning_code from recipe.block_signature_meaning m
                  where m.block_type = v_node -> 'block' ->> 'type' and m.block_version = v_node -> 'block' ->> 'version' and m.part = 'check'
                  order by 1);
  return case when cardinality(v_own) > 0 then v_own else array['VERIFIED'] end;
end
$$;

reset role;
