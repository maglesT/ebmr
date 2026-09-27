-- Identity and access (B1), part 10: the real actor-context check behind kernel.begin_command
-- (replaces the shape-only hook of 0010; DI-14, DI-16, DI-20, INV-40; ADR 0006 item 8).
--
-- A command is refused unless:
--   * the account exists, belongs to person_id, is ACTIVE and not locked, and its person is ACTIVE;
--   * the account is personal: generic (shared) and READONLY_DISPLAY accounts can never start a
--     command, so they are technically unable to create, change, sign, verify or acknowledge;
--   * source SYSTEM or INTEGRATION is used only by SERVICE/INTEGRATION accounts, and UI/API only by
--     people; a break-glass account acts only inside an approved window;
--   * the account holds role_code right now (in some scope; per-object scope is checked by the
--     module through iam.require_permission / iam.evaluate_authority);
--   * the session exists, belongs to the account, has not ended, expired or locked (idle or
--     explicit), runs on an ACTIVE device, and the context names that same device;
--   * legal_name, when given, is the person's current legal name;
--   * on SHARED and GRADE_A_B devices, auth_event_id names an authentication event of this same
--     person and account, made on this device for a command or signature, within the device class's
--     freshness window (default 60 s), not used by any other command; the command consumes it.
-- On success the session's last activity is touched and the context is logged in iam.command_log,
-- so iam.assert_validated_actor() can tell a validated context from one set by other means.

set local role ebmr_owner;

create or replace function kernel.validate_actor_context(p_ctx jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_person  uuid;
  v_account uuid;
  v_session uuid;
  v_device  uuid;
  v_event   uuid;
  v_corr    uuid;
  v_role    text := p_ctx ->> 'role_code';
  v_source  text := p_ctx ->> 'source';
  v_acc     iam.account%rowtype;
  v_per     iam.person%rowtype;
  v_s       iam.session%rowtype;
  v_state   text;
  v_window  interval;
begin
  begin
    v_person := (p_ctx ->> 'person_id')::uuid;
    v_account := (p_ctx ->> 'account_id')::uuid;
    v_session := (p_ctx ->> 'session_id')::uuid;
    v_device := nullif(p_ctx ->> 'device_id', '')::uuid;
    v_event := nullif(p_ctx ->> 'auth_event_id', '')::uuid;
    v_corr := (p_ctx ->> 'correlation_id')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-100 the actor context holds a malformed identifier';
  end;

  -- Account and person (locked in share mode so a concurrent deactivation waits for this command).
  select * into v_acc from iam.account where id = v_account for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-101 unknown account in the actor context';
  end if;
  if v_acc.person_id <> v_person then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-102 the account does not belong to the person in the actor context';
  end if;
  select * into v_per from iam.person where id = v_person;
  if v_acc.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-103 the account is %s', v_acc.status);
  end if;
  if v_per.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-104 the person has left';
  end if;
  if iam.account_locked(v_account) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-105 the account is locked';
  end if;
  if v_acc.is_generic or v_acc.kind = 'READONLY_DISPLAY' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-106 DI-14: a generic or read-only display account cannot create, change, sign, verify or acknowledge anything';
  end if;
  if (v_source in ('SYSTEM', 'INTEGRATION')) <> (v_acc.kind in ('SERVICE', 'INTEGRATION')) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-107 source %s cannot be used by a %s account', v_source, v_acc.kind);
  end if;
  if v_acc.is_break_glass and iam.break_glass_open(v_account, clock_timestamp()) is null then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-130 the break-glass window is closed';
  end if;
  if not exists (select 1 from iam.role_grant g
                 where g.account_id = v_account and g.role_code = v_role
                   and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-108 the account does not hold role %s now', v_role);
  end if;
  if p_ctx ? 'legal_name' and (p_ctx ->> 'legal_name') is distinct from v_per.legal_name then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-117 legal_name in the actor context is not the person''s legal name';
  end if;

  -- Session and device (DI-20: the device comes from the session, which the server bound to the
  -- enrolled device key at login).
  select * into v_s from iam.session where id = v_session for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-110 unknown session in the actor context';
  end if;
  if v_s.account_id <> v_account then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-111 the session belongs to another account';
  end if;
  v_state := iam.session_state(v_session);
  if v_state = 'ENDED' then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-112 the session has ended (%s)', v_s.end_reason);
  elsif v_state = 'EXPIRED' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-114 the session reached its absolute timeout; log in again';
  elsif v_state in ('LOCKED', 'IDLE_LOCKED') then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-113 the session is locked; unlock it by authenticating again';
  end if;
  if (select status from iam.device where id = v_s.device_id) <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-115 the session''s device is blocked or decommissioned';
  end if;
  if v_device is distinct from v_s.device_id then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-116 DI-20: the actor context must name the session''s own device (the server derives it; the client cannot choose it)';
  end if;

  -- INV-40: per-command attribution on shared devices.
  if v_s.device_class in ('SHARED', 'GRADE_A_B') then
    if v_event is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-IAM-120 INV-40: every command on a %s device needs a fresh authentication event of the person', v_s.device_class);
    end if;
    v_window := make_interval(secs => iam.policy_int('attribution.freshness_seconds.' || v_s.device_class));
    perform iam.use_auth_event_for_command(v_event, v_person, v_account, v_s.device_id, v_window, v_corr, v_session);
  elsif v_event is not null then
    perform iam.use_auth_event_for_command(v_event, v_person, v_account, v_s.device_id,
                                           make_interval(secs => iam.policy_int('authn.event_max_age_seconds')), v_corr, v_session);
  end if;

  update iam.session_activity set last_activity_at = clock_timestamp() where session_id = v_session;
  insert into iam.command_log (xact_id, ctx_hash, backend_pid, correlation_id, account_id, session_id, auth_event_id)
  values (pg_current_xact_id(), iam.context_hash(p_ctx), pg_backend_pid(), v_corr, v_account, v_session, v_event)
  on conflict do nothing;
end
$$;

reset role;
