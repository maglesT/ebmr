-- Tablets server, module C1 (kiosk access), part 1: the per-entry attribution method per shop-floor device class
-- (INV-40; decision D8: TAP by default, TAP_PIN as a per-class option; plan section 5).
--
-- Every command on a SHARED or GRADE_A_B terminal is attributed by a fresh authentication event of the
-- signed-in person (kernel.validate_actor_context). The server makes that event from a badge tap (BADGE_TAP,
-- purpose COMMAND) or, on a TAP_PIN class, from badge and PIN (BADGE_PIN, purpose COMMAND). TAP_PIN only adds a
-- component; the kernel's own checks (same person, same terminal, freshness, single use) apply either way.
--
-- The setting is a history (insert-only, audited on chain attribution_method:<class>); the current value is the
-- latest row, and a class without a row uses TAP. Only a person holding IAM.POLICY_MANAGE (the identity policy
-- permission, as for the attribution freshness window) sets it, with a reason, inside a validated command.
--
-- Privileges: the application role holds no privilege on the table; it may EXECUTE the functions only.

set local role ebmr_owner;

create table tab.attribution_method (
  id             bigint generated always as identity primary key,
  device_class   text not null check (device_class in ('SHARED', 'GRADE_A_B')),
  method         text not null check (method in ('TAP', 'TAP_PIN')),
  reason         text not null check (btrim(reason) <> ''),
  set_by_person  uuid not null,
  set_by_account uuid not null,
  set_at         timestamptz not null default clock_timestamp()
);
create index attribution_method_class on tab.attribution_method (device_class, id desc);
revoke all on tab.attribution_method from public;

-- Rows are never changed or removed (the history is the evidence of who set what, when and why).
create trigger aa_attribution_method_no_change before update or delete on tab.attribution_method
  for each row execute function kernel.reject_mutation();
create trigger aa_attribution_method_no_truncate before truncate on tab.attribution_method
  for each statement execute function kernel.reject_mutation();

-- Audited with the full row (not insert-only mode, which would store only a hash), so the viewer shows the
-- value, the reason and the person; the triggers above keep the table append-only.
select kernel.register_audited_table('tab.attribution_method', 'attribution_method', 'device_class', false);

-- The attribution method of a device class now: TAP_PIN or TAP (the default). Any other class needs none.
create function tab.attribution_method_for(p_device_class text) returns text
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select case
           when p_device_class not in ('SHARED', 'GRADE_A_B') then 'NONE'
           else coalesce((select m.method from tab.attribution_method m where m.device_class = p_device_class order by m.id desc limit 1), 'TAP')
         end
$$;

-- Sets the method of a class (a validated command of a person holding IAM.POLICY_MANAGE; a reason is required).
create function tab.set_attribution_method(p_device_class text, p_method text, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.POLICY_MANAGE', '{}'::jsonb);
begin
  if p_device_class is null or p_device_class not in ('SHARED', 'GRADE_A_B') then
    raise exception using errcode = 'P0001', message = format('EBMR-TAB-101 per-entry attribution applies to SHARED and GRADE_A_B terminals, not %s', coalesce(p_device_class, '(none)'));
  end if;
  if p_method is null or p_method not in ('TAP', 'TAP_PIN') then
    raise exception using errcode = 'P0001', message = format('EBMR-TAB-102 the attribution method is TAP or TAP_PIN, not %s', coalesce(p_method, '(none)'));
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-TAB-103 a reason is required to change the attribution method';
  end if;
  insert into tab.attribution_method (device_class, method, reason, set_by_person, set_by_account)
  values (p_device_class, p_method, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  perform kernel.audit_business_event('attribution_method:' || p_device_class,
    format('per-entry attribution on %s terminals set to %s', p_device_class, p_method),
    jsonb_build_object('method', p_method, 'reason', btrim(p_reason)));
end
$$;

revoke all on function tab.attribution_method_for(text), tab.set_attribution_method(text, text, text) from public;
grant execute on function tab.attribution_method_for(text), tab.set_attribution_method(text, text, text) to ebmr_app;

reset role;
