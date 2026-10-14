-- Phase 6 slice 6a (builder B): the CAPA master-version resolver (PR-51; site services 0925).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.capa_master_version_facts(version uuid) returns jsonb {exists, effective, label, problem}: the MBR version a
--       CAPA that needs a master change waits for. Effective means APPROVED in the MBR life cycle and its effective date
--       reached (PR-02: approval does not make a master usable before its effective date). Registered once as the site
--       services resolver (site.register_capa_master_resolver), so site.close_capa refuses the closure while the version
--       is not effective; site services never reads recipe tables (ADR 0011).

set local role ebmr_owner;

create function recipe.capa_master_version_facts(p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v       recipe.mbr_version;
  v_code  text;
  v_state text;
  v_label text;
begin
  select * into v from recipe.mbr_version where id = p_version;
  if not found then
    return jsonb_build_object('exists', false, 'effective', false, 'label', null, 'problem', 'no MBR version with that id');
  end if;
  select f.code into v_code from recipe.mbr_family f where f.id = v.family_id;
  v_label := format('%s v%s', coalesce(v_code, v.family_id::text), v.version_number);
  v_state := recipe.version_state(v.id);
  if v_state is distinct from 'APPROVED' then
    return jsonb_build_object('exists', true, 'effective', false, 'label', v_label, 'problem', format('%s is %s, not APPROVED', v_label, coalesce(v_state, 'without a state')));
  end if;
  if v.effective_from is null or v.effective_from > clock_timestamp() then
    return jsonb_build_object('exists', true, 'effective', false, 'label', v_label,
                              'problem', format('%s is approved but effective only from %s', v_label, coalesce(recipe.utc_text(v.effective_from), 'no date')));
  end if;
  return jsonb_build_object('exists', true, 'effective', true, 'label', v_label, 'problem', null);
end
$$;
revoke all on function recipe.capa_master_version_facts(uuid) from public;
grant execute on function recipe.capa_master_version_facts(uuid) to ebmr_app;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0952_capa_master_resolver)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the CAPA master-version resolver (PR-51; Phase 6 slice 6a)'));
select site.register_capa_master_resolver('recipe.capa_master_version_facts(uuid)'::regprocedure);
select kernel.set_actor_context(null);

reset role;
