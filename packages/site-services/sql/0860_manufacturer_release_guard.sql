-- Site services: the guard of a finished lot's exit from quarantine through the manufacturer release (Phase 4 slice 3a;
-- outline 5.2.6, 5.2.9; IN-05 (a); plan D-P4-3). The machine version that uses it is 0861 (material_lot v2, generated).
--
--   material_lot.manufacturer_decision   site.guard_manufacturer_decision: the lot is a FINISHED lot, and the manufacturer
--       release recorded, in this transaction, the decision the event names (MANUFACTURER_RELEASE: RELEASED;
--       MANUFACTURER_REJECT: REJECTED). The decision is recipe-core's (recipe.manufacturer_decision_in_xact, recipe-core
--       0781), found when the guard runs: site services apply before recipe-core and never name it at creation (the
--       pattern of site.deviation_epoch_hook, 0820). Without the release model installed the guard refuses (fails closed).
-- Every other exit of a FINISHED lot from quarantine stays refused by material_lot.not_finished (0842), so the lot leaves
-- quarantine only through the release model's signed act.

set local role ebmr_owner;

create function site.guard_manufacturer_decision(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l          site.material_lot;
  v_decision text;
  v_want     text := case p_transition ->> 'event' when 'MANUFACTURER_RELEASE' then 'RELEASED' when 'MANUFACTURER_REJECT' then 'REJECTED' end;
begin
  select * into l from site.material_lot where id = p_id;
  if not found then
    return 'the lot does not exist';
  end if;
  if l.material_kind <> 'FINISHED' then
    return format('lot %s is %s: only a finished lot leaves quarantine through the manufacturer release', l.lot_code, l.material_kind);
  end if;
  if v_want is null then
    return format('%s is no decision of the manufacturer release', coalesce(p_transition ->> 'event', 'NULL'));
  end if;
  if to_regprocedure('recipe.manufacturer_decision_in_xact(uuid)') is null then
    return 'the release model is not installed: a finished lot stays in quarantine';
  end if;
  execute 'select recipe.manufacturer_decision_in_xact($1)' into v_decision using p_id;
  if v_decision is distinct from v_want then
    return format('finished lot %s leaves quarantine only through the signed manufacturer release; no %s decision was recorded for it in this transaction (IN-05 (a))',
                  l.lot_code, v_want);
  end if;
  return null;
end
$$;
revoke all on function site.guard_manufacturer_decision(text, uuid, jsonb, jsonb, jsonb) from public;

select platform.register_guard('material_lot.manufacturer_decision', 'site.guard_manufacturer_decision(text, uuid, jsonb, jsonb, jsonb)',
                               'A finished lot leaves quarantine only by the manufacturer release recorded in the same transaction (IN-05 (a))');

reset role;
