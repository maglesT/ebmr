-- Authorization (B7), part 2: the actor's location scope and the platform AUTHORITY adapter
-- (DI-17; INV-26 through iam.evaluate_authority).
--
-- Scope rules used by every gated kernel function (see packages/kernel/src/identity/README.md,
-- section "Authority checks in the other modules"):
--   * an object with its own site (and product) is checked in that scope (site values, batch numbers);
--   * installation-wide objects (rule tables, policies, the record register, retention, incidents under
--     investigation, DI investigations, restores, attestations) are checked in the empty scope {}: only
--     a grant that is not limited to a site, area or product covers them;
--   * actions taken at the point of work (raising or linking an incident, recording a rule evaluation,
--     pinning policies at batch issue, reserving number ceilings) and every platform permission are
--     checked at the actor's location: the site and room of the command's session, which the server
--     took from the enrolled device when the session opened (never from the client).

set local role ebmr_owner;

-- The validated actor's location as a scope {site, area}: area is the session's room when its device
-- has one. Fails closed: without a session the empty scope is returned, which only an unrestricted
-- grant covers.
create function iam.actor_location_scope() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_scope jsonb;
begin
  select jsonb_strip_nulls(jsonb_build_object('site', s.site_code, 'area', s.room_code)) into v_scope
  from iam.session s
  where s.id = nullif(v_actor ->> 'session_id', '')::uuid and s.account_id = nullif(v_actor ->> 'account_id', '')::uuid;
  return coalesce(v_scope, '{}'::jsonb);
end
$$;

-- Platform permission names are lower-case dotted (platform.settings.change, sample_record.submit);
-- catalogue codes are upper case with one dot: the first segment is the domain and the remaining
-- segments are joined with underscores (PLATFORM.SETTINGS_CHANGE, SAMPLE_RECORD.SUBMIT). A name that
-- is already a catalogue code is kept. Anything else maps to NULL (refused).
create function iam.platform_permission_code(p_permission text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
           when p_permission ~ '^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)+$' then p_permission
           when p_permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
             then upper(split_part(p_permission, '.', 1)) || '.'
                  || upper(replace(substr(p_permission, strpos(p_permission, '.') + 1), '.', '_'))
         end
$$;

-- AUTHORITY hook of the platform (0500): fn(permission, actor, aggregate_type, aggregate_id) -> NULL
-- when allowed, otherwise the reason. The actor must be the validated actor of this command (the
-- platform passes kernel.current_actor(); anything else is refused). The permission is evaluated
-- with iam.evaluate_authority for the actor's person and account in the role declared in the context,
-- at the database clock, in the actor's location scope; every evaluation is stored (INV-26).
create function iam.platform_authority(p_permission text, p_actor jsonb, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  v_code  text := iam.platform_permission_code(p_permission);
  v_scope jsonb;
  v_eval  jsonb;
begin
  if not iam.actor_is_validated() then
    return 'EBMR-IAM-002 no validated actor: the command was not started with kernel.begin_command';
  end if;
  v_actor := kernel.current_actor();
  if p_actor is null
     or p_actor ->> 'person_id' is distinct from v_actor ->> 'person_id'
     or p_actor ->> 'account_id' is distinct from v_actor ->> 'account_id'
     or p_actor ->> 'role_code' is distinct from v_actor ->> 'role_code'
     or p_actor ->> 'session_id' is distinct from v_actor ->> 'session_id' then
    return 'EBMR-IAM-043 the actor given to the authority check is not the validated actor of this command';
  end if;
  if v_code is null then
    return format('EBMR-IAM-043 %L is not a permission name the catalogue can map', p_permission);
  end if;
  v_scope := iam.actor_location_scope();
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_code, v_scope,
                                   clock_timestamp(), v_actor ->> 'role_code');
  if (v_eval ->> 'allowed')::boolean then
    return null;
  end if;
  return format('%s acting as %s lacks %s in scope %s for %s:%s: %s (evaluation %s)', v_actor ->> 'account_id', v_actor ->> 'role_code',
                v_code, v_scope, coalesce(p_aggregate_type, '?'), coalesce(p_aggregate_id, '?'), v_eval -> 'reasons', v_eval ->> 'evaluation_id');
end
$$;

select platform.register_hook('AUTHORITY', 'iam.platform_authority(text, jsonb, text, text)');

-- No grants: module SECURITY DEFINER functions and the platform call these as the owner; the
-- application role cannot (functions are not executable by PUBLIC, 0001).

reset role;
