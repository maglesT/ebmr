-- Tablets edition, module C3: the register's refusal of an incomplete test lot names what the register checks (Phase 2
-- exit, SQL mutation kill work, defect D4, wording; PR-18, DI-05; message only: what is refused is unchanged).
--
-- tab.register_sandbox_lot (tablets 0200, 0701) refuses with EBMR-EXE-070 a lot without a lot code or without a yes or
-- no for its identity test, and its message said a test lot needs "a lot code, a material, a status and whether it is
-- identity-tested". The function checks neither the material nor the status: a lot without them is refused by the
-- table (tab.sandbox_lot's NOT NULL and CHECK constraints, tablets 0200), with nothing stored, not by EBMR-EXE-070.
-- 0701's header left this open ("Not decided here").
--
-- What changed: tab.register_sandbox_lot (CREATE OR REPLACE) is 0701's function with that one message reworded to name
-- what it checks: a lot code and whether the lot is identity-tested, yes or no. Every check, its order, every other
-- message, the row, the owner, the privileges (EXECUTE for the application role only), SECURITY DEFINER and the
-- search_path are as in 0701. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- PR-18, DI-05: registers a TEST- lot (sandbox only; MASTERDATA.CHANGE at the actor's location; never an administrator).
-- p_lot: {lotCode, materialCode, materialName, status, expiresAtUs?, retestAtUs?, identityTested}.
create or replace function tab.register_sandbox_lot(p_lot jsonb) returns text
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, sandbox, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('MASTERDATA.CHANGE', iam.actor_location_scope());
  v_code  text := p_lot ->> 'lotCode';
begin
  perform iam.assert_not_administrator();
  perform sandbox.assert_sandbox_installation('Registering a test lot');
  if jsonb_typeof(p_lot) <> 'object' or coalesce(btrim(v_code), '') = '' or jsonb_typeof(p_lot -> 'identityTested') is distinct from 'boolean' then
    raise exception using errcode = 'P0001', message = 'A test lot needs a lot code and whether it is identity-tested, yes or no (PR-18). [EBMR-EXE-070]';
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

reset role;
