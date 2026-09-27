-- Shop-floor device hardening attestation (control DI-13: shop-floor clients are hardened, with kiosk
-- mode and removable storage disabled; build outline 4.1 device classes, 4.7).
--
-- A SHARED or GRADE_A_B device may be enrolled only while a passing hardening attestation is in force
-- for it: USB mass storage blocked, kiosk mode enforced, malware protection active and the operating
-- system patched within the patch SLA. The attestation comes from the device-management compliance
-- report or a documented manual inspection, and expires (re-attestation interval 30-365 days, default
-- 180). The identity module owns the device registry; this table is keyed by the device uuid only, and
-- the lead wires continuity.assert_device_hardened into enrolment.
--
-- Error codes: EBMR-CONT-04x.

set local role ebmr_owner;

create table continuity.device_hardening_attestation (
  id                        uuid primary key default gen_random_uuid(),
  device_id                 uuid not null,
  device_class              text not null check (device_class in ('PERSONAL', 'SHARED', 'GRADE_A_B', 'SERVER')),
  usb_mass_storage_blocked  boolean not null,
  kiosk_mode_enforced       boolean not null,
  malware_protection_active boolean not null,
  os_patch_within_sla       boolean not null,
  os_build                  text,
  method                    text not null check (method in ('MDM_COMPLIANCE_REPORT', 'MANUAL_INSPECTION')),
  evidence_ref              text not null check (length(trim(evidence_ref)) > 0),
  evidence_sha256           text check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  result                    text not null check (result in ('PASS', 'FAIL')),
  valid_until               timestamptz not null,
  attested_by_person_id     uuid not null,
  attested_by_account_id    uuid not null,
  recorded_at               timestamptz not null default clock_timestamp(),
  correlation_id            uuid not null,
  check (result = 'FAIL' or (usb_mass_storage_blocked and malware_protection_active and os_patch_within_sla
                             and (kiosk_mode_enforced or device_class in ('PERSONAL', 'SERVER')))),
  check (valid_until > recorded_at)
);
create index device_hardening_attestation_device on continuity.device_hardening_attestation (device_id, recorded_at desc);

create table continuity.device_hardening_revocation (
  attestation_id          uuid primary key references continuity.device_hardening_attestation (id),
  device_id               uuid not null,
  reason                  text not null check (length(trim(reason)) > 0),
  revoked_by_person_id    uuid not null,
  revoked_by_account_id   uuid not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  correlation_id          uuid not null
);

select kernel.register_audited_table('continuity.device_hardening_attestation', 'device', 'device_id', true);
select kernel.register_audited_table('continuity.device_hardening_revocation', 'device', 'device_id', true);

-- p: {device_id, device_class, usb_mass_storage_blocked, kiosk_mode_enforced, malware_protection_active,
--     os_patch_within_sla, os_build?, method, evidence_ref, evidence_sha256?, validity_days? (30-365, default 180)}
-- A failing attestation is recorded too (result FAIL): it documents the finding and never allows enrolment.
create function continuity.record_hardening_attestation(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx   jsonb := continuity.require_actor();
  v_days  integer;
  v_pass  boolean;
  v_id    uuid;
  v_now   timestamptz := clock_timestamp();
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-040 attestation details are required';
  end if;
  begin
    v_days := coalesce((p ->> 'validity_days')::integer, 180);
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-040 validity_days must be a whole number of days';
  end;
  if v_days < 30 or v_days > 365 then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-040 the re-attestation interval must be 30 to 365 days';
  end if;
  if jsonb_typeof(p -> 'usb_mass_storage_blocked') is distinct from 'boolean' or jsonb_typeof(p -> 'kiosk_mode_enforced') is distinct from 'boolean'
     or jsonb_typeof(p -> 'malware_protection_active') is distinct from 'boolean' or jsonb_typeof(p -> 'os_patch_within_sla') is distinct from 'boolean' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-040 every hardening check must be stated as true or false';
  end if;
  v_pass := (p ->> 'usb_mass_storage_blocked')::boolean and (p ->> 'malware_protection_active')::boolean
            and (p ->> 'os_patch_within_sla')::boolean
            and ((p ->> 'kiosk_mode_enforced')::boolean or p ->> 'device_class' in ('PERSONAL', 'SERVER'));
  begin
    insert into continuity.device_hardening_attestation (device_id, device_class, usb_mass_storage_blocked, kiosk_mode_enforced,
      malware_protection_active, os_patch_within_sla, os_build, method, evidence_ref, evidence_sha256, result, valid_until,
      attested_by_person_id, attested_by_account_id, recorded_at, correlation_id)
    values ((p ->> 'device_id')::uuid, p ->> 'device_class', (p ->> 'usb_mass_storage_blocked')::boolean, (p ->> 'kiosk_mode_enforced')::boolean,
      (p ->> 'malware_protection_active')::boolean, (p ->> 'os_patch_within_sla')::boolean, p ->> 'os_build', p ->> 'method',
      p ->> 'evidence_ref', p ->> 'evidence_sha256', case when v_pass then 'PASS' else 'FAIL' end, v_now + make_interval(days => v_days),
      (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, v_now, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception
    when check_violation or not_null_violation or invalid_text_representation then
      raise exception using errcode = 'P0001', message = format('EBMR-CONT-040 invalid hardening attestation: %s', sqlerrm);
  end;
  return v_id;
end
$$;

create function continuity.revoke_hardening_attestation(p_attestation_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx jsonb := continuity.require_actor();
  a     continuity.device_hardening_attestation%rowtype;
begin
  select * into a from continuity.device_hardening_attestation x where x.id = p_attestation_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-042 attestation %s does not exist', p_attestation_id);
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-042 a revocation needs a reason';
  end if;
  if exists (select 1 from continuity.device_hardening_revocation r where r.attestation_id = p_attestation_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-042 the attestation is already revoked';
  end if;
  insert into continuity.device_hardening_revocation (attestation_id, device_id, reason, revoked_by_person_id, revoked_by_account_id, correlation_id)
  values (p_attestation_id, a.device_id, p_reason, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
end
$$;

-- Status for enrolment at an instant (default now): the most recent attestation recorded by then for
-- this device and class decides. A newer FAIL supersedes an older PASS.
create function continuity.device_hardening_status(p_device_id uuid, p_device_class text, p_at timestamptz default clock_timestamp())
returns table (required boolean, satisfied boolean, attestation_id uuid, valid_until timestamptz, problem text)
language plpgsql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
declare
  a continuity.device_hardening_attestation%rowtype;
begin
  if p_device_class not in ('PERSONAL', 'SHARED', 'GRADE_A_B', 'SERVER', 'INSTRUMENT') or p_device_class is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-040 unknown device class %s', p_device_class);
  end if;
  required := p_device_class in ('SHARED', 'GRADE_A_B');
  select * into a from continuity.device_hardening_attestation x
   where x.device_id = p_device_id and x.device_class = p_device_class and x.recorded_at <= p_at
   order by x.recorded_at desc, x.id desc limit 1;
  attestation_id := a.id;
  valid_until := a.valid_until;
  if not required then
    satisfied := true; problem := null;
  elsif a.id is null then
    satisfied := false; problem := 'no hardening attestation recorded for this device';
  elsif a.result <> 'PASS' then
    satisfied := false; problem := 'the latest hardening attestation failed';
  elsif exists (select 1 from continuity.device_hardening_revocation r where r.attestation_id = a.id and r.recorded_at <= p_at) then
    satisfied := false; problem := 'the latest hardening attestation was revoked';
  elsif a.valid_until <= p_at then
    satisfied := false; problem := 'the latest hardening attestation has expired';
  else
    satisfied := true; problem := null;
  end if;
  return next;
end
$$;

-- Enrolment guard: raises unless the device class needs no attestation or a valid passing one exists.
create function continuity.assert_device_hardened(p_device_id uuid, p_device_class text) returns void
language plpgsql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
declare
  s record;
begin
  select * into s from continuity.device_hardening_status(p_device_id, p_device_class, clock_timestamp());
  if not s.satisfied then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CONT-041 %s device %s cannot be enrolled: %s', p_device_class, p_device_id, s.problem);
  end if;
end
$$;

revoke all on continuity.device_hardening_attestation, continuity.device_hardening_revocation from ebmr_app;
grant select on continuity.device_hardening_attestation, continuity.device_hardening_revocation to ebmr_app;
grant execute on function continuity.record_hardening_attestation(jsonb), continuity.revoke_hardening_attestation(uuid, text),
                          continuity.device_hardening_status(uuid, text, timestamptz), continuity.assert_device_hardened(uuid, text) to ebmr_app;

reset role;
