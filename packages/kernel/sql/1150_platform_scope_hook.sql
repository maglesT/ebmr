-- Platform services: a SCOPE hook, the extension point through which a domain module adds the scope of the record a
-- platform transition acts on (ADR-0018; Phase 3 slice 3a, review backlog #5; DI-17).
--
-- iam.platform_authority (0710), the AUTHORITY hook, evaluated a transition's permission in the session's location
-- scope only. A grant limited to a product therefore never matched a transition on a record of that product (the plant
-- equipment's START_USE and END_USE, the output container's events): the commands failed closed for a product-limited
-- operator. The kernel holds no process logic (ADR-0011) and cannot know which product a plant record belongs to, so:
--   * platform.hook takes a third hook, SCOPE: fn(permission text, aggregate_type text, aggregate_id text) returns jsonb,
--     the scope members the record adds (for example {"product": "P-1"}), or '{}' for none; platform.register_hook
--     knows its signature (it returns jsonb, the other two text);
--   * platform.scope_of calls it, and answers '{}' when no SCOPE hook is registered (a kernel-only installation, or
--     a module that adds nothing) or when the hook answers no object;
--   * iam.platform_authority is re-created from 0710 with one change: the scope it evaluates is the session's location
--     scope with platform.scope_of(...) merged in. The AUTHORITY hook still names it.
-- Nothing is relaxed: the added members only narrow which grant scopes match; a grant without such a limit matches as
-- before, and a grant limited to another value is refused as before.
--
-- CREATE OR REPLACE keeps the functions' owner, privileges, SECURITY DEFINER and search_path; the new function is owned
-- by ebmr_owner, private, with pg_temp last. Applied as a new migration because applied migrations are never edited.

set local role ebmr_owner;

alter table platform.hook drop constraint hook_name_check;
alter table platform.hook add constraint hook_name_check check (name in ('AUTHORITY', 'SIGNATURE', 'SCOPE'));

-- As 0500_platform_base.sql; the SCOPE hook added (header).
create or replace function platform.register_hook(p_name text, p_function regprocedure) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_expected text;
begin
  v_expected := case p_name
    when 'AUTHORITY' then 'text, jsonb, text, text'
    when 'SIGNATURE' then 'uuid, text, text, text, jsonb'
    when 'SCOPE' then 'text, text, text'
  end;
  if v_expected is null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-004 unknown hook %s', p_name);
  end if;
  if not exists (select 1 from pg_proc p where p.oid = p_function and oidvectortypes(p.proargtypes) = v_expected and p.prorettype = (case p_name when 'SCOPE' then 'jsonb' else 'text' end)::regtype) then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-004 %s does not have the %s hook signature', p_function, p_name);
  end if;
  insert into platform.hook (name, function_oid) values (p_name, p_function)
  on conflict (name) do update set function_oid = excluded.function_oid, registered_at = clock_timestamp();
end
$$;

-- The scope members the registered SCOPE hook adds for a check of p_permission on p_aggregate_type:p_aggregate_id;
-- '{}' when no SCOPE hook is registered or it answers no object.
create function platform.scope_of(p_permission text, p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_fn    regprocedure;
  v_scope jsonb;
begin
  select function_oid into v_fn from platform.hook where name = 'SCOPE';
  if v_fn is null then
    return '{}'::jsonb;
  end if;
  execute format('select %s($1, $2, $3)', platform.function_call_name(v_fn)) into v_scope using p_permission, p_aggregate_type, p_aggregate_id;
  return case when jsonb_typeof(v_scope) = 'object' then v_scope else '{}'::jsonb end;
end
$$;
revoke all on function platform.scope_of(text, text, text) from public;

-- As 0710_authorization_scope_and_platform.sql; the scope also carries what the SCOPE hook adds (header).
create or replace function iam.platform_authority(p_permission text, p_actor jsonb, p_aggregate_type text, p_aggregate_id text) returns text
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
  v_scope := iam.actor_location_scope() || platform.scope_of(p_permission, p_aggregate_type, p_aggregate_id);
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_code, v_scope,
                                   clock_timestamp(), v_actor ->> 'role_code');
  if (v_eval ->> 'allowed')::boolean then
    return null;
  end if;
  raise exception using errcode = 'P0001',
    message = format('EBMR-PLAT-006 permission %s denied: %s acting as %s lacks %s in scope %s for %s:%s: %s (evaluation %s)', p_permission,
                     v_actor ->> 'account_id', v_actor ->> 'role_code', v_code, v_scope, coalesce(p_aggregate_type, '?'),
                     coalesce(p_aggregate_id, '?'), v_eval -> 'reasons', v_eval ->> 'evaluation_id'),
    detail = jsonb_build_object('person_id', v_actor ->> 'person_id', 'account_id', v_actor ->> 'account_id',
                                'role_code', v_actor ->> 'role_code', 'permission', v_code, 'scope', v_scope,
                                'reasons', v_eval -> 'reasons', 'platform_permission', p_permission)::text;
end
$$;

reset role;
