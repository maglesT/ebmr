-- Recipe core: a new draft in a family whose drafts were all discarded (demo finding D-3; D-0 sweep top row 7, lead
-- audit of 7 November 2026; docs/build-plan/demo-gaps/d3-discard.md).
--
-- Handbook: modules/recipe-core.md
--
--   * recipe.reopen_family(def): the family of def's code, when it has def's identity (edition, record kind, product,
--     strength, dosage form, batch-size set and, for packaging, pack type; mbr_family_identity, INV-17) and every one of
--     its versions is WITHDRAWN and was never approved; NULL otherwise. The designer starts the new draft in that family
--     (recipe.create_version, its next version number) instead of defining a twin, which the identity index refuses. The
--     family row is not changed and nothing is deleted: the discarded drafts stay, WITHDRAWN, in the audit trail (DI-24).
--     A family that ever had an approved version is never reopened (a change is a version derived from it, PR-06).
--     The family row is locked (FOR UPDATE) until the command ends, so two restarts at once give one draft.
--
-- Messages: none (a NULL answer leaves recipe.define_family to refuse a twin as before).

set local role ebmr_owner;

create function recipe.reopen_family(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  f      recipe.mbr_family;
  v_pack text := coalesce(nullif(btrim(coalesce(p_def ->> 'packType', '')), ''), 'STANDARD');
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.AUTHOR', jsonb_build_object('product', p_def -> 'product' ->> 'code'));
  -- The family row is locked for the rest of the command (lead audit of #161): a second restart at the same time waits,
  -- then sees the first one's new DRAFT and answers NULL, so define_family refuses the twin; two parallel drafts, the
  -- second never compared with the first (PR-06), cannot start.
  select * into f from recipe.mbr_family where code = p_def ->> 'code' for update;
  if f.id is null
     or f.edition is distinct from p_def ->> 'edition' or f.record_kind is distinct from p_def ->> 'recordKind'
     or f.product_code is distinct from p_def -> 'product' ->> 'code' or f.strength is distinct from p_def -> 'product' ->> 'strength'
     or f.dosage_form is distinct from p_def -> 'product' ->> 'dosageForm'
     or f.batch_sizes is distinct from recipe.canonical_batch_sizes(coalesce(p_def -> 'batchSizes', '[]'::jsonb))
     or (f.record_kind = 'PACKAGING' and not exists (select 1 from recipe.mbr_family_pack k where k.family_id = f.id and k.pack_type = v_pack)) then
    return null;
  end if;
  if not exists (select 1 from recipe.mbr_version v where v.family_id = f.id)
     or exists (select 1 from recipe.mbr_version v where v.family_id = f.id
                 and (recipe.version_state(v.id) is distinct from 'WITHDRAWN' or recipe.version_was_approved(v.id))) then
    return null;
  end if;
  return f.id;
end
$$;

revoke all on function recipe.reopen_family(jsonb) from public;
grant execute on function recipe.reopen_family(jsonb) to ebmr_app;

reset role;
