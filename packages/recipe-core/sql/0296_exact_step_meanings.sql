-- Recipe core, execution store (module C3): the meaning a step signature may carry is exactly the one the step asks
-- for (DI-35, INV-10, PR-14, PR-20; review finding P37 and its follow-up; engine 1.1.0; ADR 0012: the rule holds when
-- the application's own database credentials are used directly).
--
-- recipe.step_signature_meanings (0270) still accepted:
--   * for SIGN_PERFORMED, the generic PERFORMED next to the block's own perform meaning, so a line clearance, a sample
--     taken or an IPC could be recorded under the generic meaning and lose the attestation the block's meaning
--     carries (LINE_CLEARANCE_PERFORMED, SAMPLE_TAKEN, IPC_PERFORMED);
--   * for VERIFY, every verification meaning and WITNESSED next to the block's own check, and the verification
--     meanings next to RE_VERIFIED_AFTER_CORRECTION, which is wider than the engine and than
--     recipe.step_check_meanings (0295).
-- Engine 1.1.0 accepts exactly one set per step (guards.ts performMeanings, checkMeanings), and so does the database
-- now:
--   * SIGN_PERFORMED: the block's own perform meanings (recipe.block_signature_meaning) when the block has any, else
--     PERFORMED;
--   * VERIFY: recipe.step_check_meanings (0295): RE_VERIFIED_AFTER_CORRECTION while the stored step instance awaits
--     re-verification, WITNESSED where the MBR asks for a witness, else the block's own check meanings, else VERIFIED;
--   * DISPOSITION_HOLD_POINT: unchanged (the meaning of the decision's class, for a disposition the hold point offers).
-- A step the database cannot find in the batch's own MBR content still accepts no meaning (fail closed).
-- recipe.check_signatures (0295) refuses any other meaning with EBMR-EXE-051, as before; its separate check of the
-- VERIFY meaning (P37) stays as a second guard.
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), the privileges (none for PUBLIC, 0270), SECURITY DEFINER and the
-- search_path of 0270. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-35, INV-10: the meanings the engine accepts for the signature of command p_cmd on the step it names, from the
-- batch's MBR content (the step's block and check meaning; a hold point's dispositions) and the stored step instance
-- (re-verification); NULL for a command type without a step signature. An empty array when the step is not a step of
-- that kind in the content, or the decision is not one the hold point offers.
create or replace function recipe.step_signature_meanings(p_batch uuid, p_prior jsonb, p_cmd jsonb) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_type text := p_cmd ->> 'type';
  v_node jsonb;
  v_own  text[];
begin
  if v_type is null or v_type not in ('SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT') then
    return null;
  end if;
  if v_type = 'VERIFY' then
    -- Exactly the check the step requires, as the engine asks for it (P37).
    return recipe.step_check_meanings(p_batch, p_prior, p_cmd);
  end if;
  select recipe.step_node(pk.content, p_cmd ->> 'step') into v_node
    from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = p_batch;
  if v_type = 'DISPOSITION_HOLD_POINT' then
    if v_node ->> 'kind' is distinct from 'holdPoint' or jsonb_typeof(p_cmd -> 'disposition') is distinct from 'string'
       or not coalesce(case when jsonb_typeof(v_node -> 'dispositions') = 'array' then (v_node -> 'dispositions') ? (p_cmd ->> 'disposition') end, false) then
      return '{}';
    end if;
    return array[recipe.hold_point_meaning(p_cmd ->> 'disposition')];
  end if;
  if v_node ->> 'kind' is distinct from 'phase' then
    return '{}';
  end if;
  v_own := array(select m.meaning_code from recipe.block_signature_meaning m
                  where m.block_type = v_node -> 'block' ->> 'type' and m.block_version = v_node -> 'block' ->> 'version' and m.part = 'perform'
                  order by 1);
  -- The generic PERFORMED only on a block without its own perform meaning.
  return case when cardinality(v_own) > 0 then v_own else array['PERFORMED'] end;
end
$$;

reset role;
