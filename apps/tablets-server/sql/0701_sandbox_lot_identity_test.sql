-- Tablets edition, module C3: a test lot registered without saying whether it is identity-tested is refused by the
-- register's own check (EBMR-EXE-070), not left to the table (SQL mutation group sandbox-and-import; PR-18, DI-05).
--
-- What was wrong. tab.register_sandbox_lot (tablets 0200) refuses a lot whose identity test is not a yes or no with
-- jsonb_typeof(p_lot -> 'identityTested') <> 'boolean'. When the member is missing, p_lot -> 'identityTested' is NULL,
-- jsonb_typeof gives NULL and the comparison gives NULL, so the whole condition is NULL whenever the lot code is given:
-- the check never fires for a lot that does not say whether it was identity-tested. The insert that follows writes NULL
-- into tab.sandbox_lot.identity_tested and the NOT NULL constraint refuses it, so nothing was ever stored, but the refusal
-- was a bare constraint violation (SQLSTATE 23502) instead of EBMR-EXE-070 with the reason the register gives every
-- other incomplete lot. Found by the SQL mutation run: the check's own branches could not be told apart for such a lot.
--
-- Now the identity test must be a JSON boolean (IS DISTINCT FROM: a missing member is not one), so such a lot gets
-- EBMR-EXE-070. Everything else is as in 0200: the same privileges (EXECUTE for the application role only; the sandbox
-- role follows through sandbox.mirror_application_privileges), owner, SECURITY DEFINER and search_path (pg_temp last),
-- the same checks, refusals and row. Not decided here: the register's message also names the material and the status,
-- which the function itself does not check; a lot without them is refused by the table's constraints (NOT NULL and
-- CHECK), with nothing stored. Applied as a new migration because applied migrations are checksummed and never edited.

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

reset role;
