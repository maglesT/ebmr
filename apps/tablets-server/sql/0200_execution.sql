-- Tablets server, module C3 (Phase 2 apps plan section 7): the edition's engine-role map (decision D4) and the
-- sandbox's test lots. Controls DI-05, DI-17, PR-18 (lot status at the moment of use); invariants INV-18, INV-26.
--
--   tab.engine_role_map   the declared kernel role -> the engine role it carries, through one permission
--                         (recipe.engine_role_permission); insert-only, changed only by a software release
--   tab.engine_roles()    the engine roles of this command's actor: one stored authority evaluation per mapped
--                         permission, in the declared role, at the actor's location (INV-26); only allowed ones
--   tab.sandbox_lot       TEST- material lots of the sandbox (the material status a test run reads; site
--                         services own real lots in Phase 3); insert-only and audited
--   tab.register_sandbox_lot / tab.resolve_lot
--
-- Privileges: the application role may SELECT the map and the lots and EXECUTE the functions below; it can never
-- insert, update or delete a row here directly.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Engine-role map (plan section 7, decision D4)

create table tab.engine_role_map (
  kernel_role     text not null references iam.role (code),
  engine_role     text not null,
  via_permission  text not null,
  primary key (kernel_role, engine_role),
  foreign key (engine_role, via_permission) references recipe.engine_role_permission (engine_role, permission)
);
revoke all on tab.engine_role_map from public;

insert into tab.engine_role_map (kernel_role, engine_role, via_permission) values
  ('OPERATOR', 'PRODUCTION_OPERATOR', 'STEP.EXECUTE'),
  ('DISPENSER', 'DISPENSER', 'DISPENSE.EXECUTE'),
  ('VERIFIER', 'PRODUCTION_VERIFIER', 'STEP.VERIFY'),
  ('SHIFT_SUPERVISOR', 'PRODUCTION_SUPERVISOR', 'STEP.SUPERVISE'),
  ('STAGE_RESPONSIBLE', 'STAGE_RESPONSIBLE', 'RECORD.PRODUCTION_APPROVE'),
  ('HEAD_OF_PRODUCTION', 'HEAD_OF_PRODUCTION', 'RECORD.PRODUCTION_APPROVE'),
  ('QA_SHOP_FLOOR', 'QA', 'QA.FLOOR_APPROVE'),
  ('QA_REVIEWER', 'QA_REVIEWER', 'RECORD.QA_REVIEW');

create trigger aa_insert_only before update or delete on tab.engine_role_map for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on tab.engine_role_map for each statement execute function kernel.reject_mutation();

-- The engine roles of the validated actor of this command: for each map row of the DECLARED role, one stored
-- authority evaluation of its permission in that role at the actor's location (iam.evaluate_authority; INV-26).
-- Returns [{role, permission, evaluationId}] of the allowed ones; recipe.append_execution accepts an engine role
-- only with such an evaluation made in the same command. The client never names a role.
create function tab.engine_roles() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_scope jsonb := iam.actor_location_scope();
  m       tab.engine_role_map;
  v_eval  jsonb;
  v_out   jsonb := '[]'::jsonb;
begin
  for m in select * from tab.engine_role_map where kernel_role = v_actor ->> 'role_code' order by engine_role loop
    v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, m.via_permission, v_scope,
                                     clock_timestamp(), m.kernel_role);
    if (v_eval ->> 'allowed')::boolean then
      v_out := v_out || jsonb_build_array(jsonb_build_object('role', m.engine_role, 'permission', m.via_permission, 'evaluationId', v_eval ->> 'evaluation_id'));
    end if;
  end loop;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Sandbox lots (TEST- only; DI-05, INV-18)

create table tab.sandbox_lot (
  lot_code               text primary key,
  material_code          text not null check (material_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  material_name          text not null check (btrim(material_name) <> ''),
  status                 text not null check (status in ('RELEASED', 'QUARANTINE', 'ON_TEST', 'REJECTED', 'ON_HOLD', 'RECALLED', 'RETURNED', 'EXPIRED')),
  expires_at             timestamptz,
  retest_at              timestamptz,
  identity_tested        boolean not null,
  registered_at          timestamptz not null default clock_timestamp(),
  registered_by_person   uuid not null,
  registered_by_account  uuid not null,
  correlation_id         uuid not null
);
revoke all on tab.sandbox_lot from public;
create trigger aa_sandbox_lot_identifier before insert on tab.sandbox_lot
  for each row execute function sandbox.guard_identifier('LOT_NUMBER', 'lot_code');
select kernel.register_audited_table('tab.sandbox_lot', 'sandbox_lot', 'lot_code', true);

-- Registers a TEST- lot (sandbox only; MASTERDATA.CHANGE at the actor's location; never an administrator).
-- p_lot: {lotCode, materialCode, materialName, status, expiresAtUs?, retestAtUs?, identityTested}.
create function tab.register_sandbox_lot(p_lot jsonb) returns text
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, sandbox, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('MASTERDATA.CHANGE', iam.actor_location_scope());
  v_code  text := p_lot ->> 'lotCode';
begin
  perform iam.assert_not_administrator();
  perform sandbox.assert_sandbox_installation('Registering a test lot');
  if jsonb_typeof(p_lot) <> 'object' or coalesce(btrim(v_code), '') = '' or jsonb_typeof(p_lot -> 'identityTested') <> 'boolean' then
    raise exception using errcode = 'P0001', message = 'A test lot needs a lot code, a material, a status and whether it is identity-tested (PR-18). [EBMR-EXE-070]';
  end if;
  if (p_lot ? 'expiresAtUs' and (p_lot ->> 'expiresAtUs') !~ '^[0-9]{1,19}$') or (p_lot ? 'retestAtUs' and (p_lot ->> 'retestAtUs') !~ '^[0-9]{1,19}$') then
    raise exception using errcode = 'P0001', message = 'Expiry and retest dates are epoch microseconds (PR-18). [EBMR-EXE-070]';
  end if;
  if exists (select 1 from tab.sandbox_lot where lot_code = v_code) then
    raise exception using errcode = 'P0001', message = format('Test lot %s is registered already; a lot is never changed, register a new one (PR-18). [EBMR-EXE-071]', v_code);
  end if;
  insert into tab.sandbox_lot (lot_code, material_code, material_name, status, expires_at, retest_at, identity_tested,
                               registered_by_person, registered_by_account, correlation_id)
  values (v_code, p_lot ->> 'materialCode', p_lot ->> 'materialName', p_lot ->> 'status',
          case when p_lot ? 'expiresAtUs' then timestamptz 'epoch' + ((p_lot ->> 'expiresAtUs') || ' microseconds')::interval end,
          case when p_lot ? 'retestAtUs' then timestamptz 'epoch' + ((p_lot ->> 'retestAtUs') || ' microseconds')::interval end,
          (p_lot ->> 'identityTested')::boolean, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid);
  return v_code;
end
$$;

-- The lot as the server knows it now: {lotCode, materialCode, materialName, status, expiresAtUs, retestAtUs,
-- identityTested}, or null when there is no such lot. The command reads it inside its own transaction.
create function tab.resolve_lot(p_code text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, platform, pg_temp as $$
  select jsonb_build_object(
           'lotCode', l.lot_code, 'materialCode', l.material_code, 'materialName', l.material_name, 'status', l.status,
           'expiresAtUs', case when l.expires_at is null then null else platform.epoch_micros(l.expires_at)::text end,
           'retestAtUs', case when l.retest_at is null then null else platform.epoch_micros(l.retest_at)::text end,
           'identityTested', l.identity_tested)
    from tab.sandbox_lot l where l.lot_code = p_code
$$;

revoke all on function tab.engine_roles(), tab.register_sandbox_lot(jsonb), tab.resolve_lot(text) from public;
grant execute on function tab.engine_roles(), tab.register_sandbox_lot(jsonb), tab.resolve_lot(text) to ebmr_app;
grant select on tab.engine_role_map, tab.sandbox_lot to ebmr_app;

reset role;
