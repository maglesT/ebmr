-- Identity and access (B1), part 5: device registry (DI-20; ADR 0006 item 8; outline 4.7).
--
-- Every terminal and data source has a registered identity: the SHA-256 fingerprint of its
-- enrolled public key or client certificate, presented through mTLS or a device-key handshake.
-- The server looks the device up by that fingerprint and takes its class, site, room and line
-- from this registry; nothing the browser reports about itself is trusted. GRADE_A_B terminals are
-- bound to their room; INSTRUMENT data sources (balances, scanners, PLC connectors, printers) to a
-- room or line. Blocked and decommissioned devices are refused, and an unknown device raises an
-- alert.

set local role ebmr_owner;

create table iam.device (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$'),
  device_class          text not null check (device_class in ('PERSONAL', 'SHARED', 'GRADE_A_B', 'SERVER', 'INSTRUMENT')),
  site_code             text not null check (btrim(site_code) <> ''),
  room_code             text check (room_code is null or btrim(room_code) <> ''),
  line_code             text check (line_code is null or btrim(line_code) <> ''),
  key_fingerprint       text not null unique check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  status                text not null default 'ACTIVE' check (status in ('ACTIVE', 'BLOCKED', 'DECOMMISSIONED')),
  description           text not null check (btrim(description) <> ''),
  registered_by_person  uuid not null,
  registered_at         timestamptz not null default clock_timestamp(),
  status_changed_at     timestamptz not null default clock_timestamp(),
  status_reason         text,
  check (device_class <> 'GRADE_A_B' or room_code is not null),
  check (device_class <> 'INSTRUMENT' or room_code is not null or line_code is not null)
);

create function iam.device_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'ACTIVE' then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-071 a device is registered ACTIVE';
    end if;
    new.registered_at := clock_timestamp();
    new.status_changed_at := new.registered_at;
    return new;
  end if;
  if new.id <> old.id or new.code <> old.code or new.device_class <> old.device_class or new.key_fingerprint <> old.key_fingerprint
     or new.site_code <> old.site_code or new.registered_by_person <> old.registered_by_person or new.registered_at <> old.registered_at then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-007 a device''s code, class, site and enrolled key never change; register a new device instead';
  end if;
  if old.status = 'DECOMMISSIONED' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-071 a decommissioned device never changes again';
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := clock_timestamp();
  else
    new.status_changed_at := old.status_changed_at;
  end if;
  return new;
end
$$;
create trigger aa_device_guard before insert or update on iam.device for each row execute function iam.device_guard();

create function iam.normalize_fingerprint(p_fingerprint text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select lower(regexp_replace(coalesce(p_fingerprint, ''), '[:\s]', '', 'g'))
$$;

create function iam.register_device(p_code text, p_class text, p_site text, p_room text, p_line text, p_fingerprint text,
                                    p_description text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_id    uuid;
begin
  insert into iam.device (code, device_class, site_code, room_code, line_code, key_fingerprint, description, registered_by_person)
  values (p_code, p_class, p_site, p_room, p_line, iam.normalize_fingerprint(p_fingerprint), p_description, (v_actor ->> 'person_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function iam.set_device_status(p_device uuid, p_status text, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-004 a reason is required';
  end if;
  update iam.device set status = p_status, status_reason = p_reason where id = p_device;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-070 unknown device';
  end if;
  if p_status <> 'ACTIVE' then
    perform iam.end_device_sessions(p_device, 'DEVICE_BLOCKED');
  end if;
end
$$;

create function iam.relocate_device(p_device uuid, p_room text, p_line text, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  update iam.device set room_code = p_room, line_code = p_line, status_reason = p_reason where id = p_device;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-070 unknown device';
  end if;
  perform iam.end_device_sessions(p_device, 'DEVICE_RELOCATED');
end
$$;

-- Server-side device resolution from the enrolled-key fingerprint the TLS layer presents. Never
-- raises: a refusal is returned (and alerted) so the alert survives the refused request.
create function iam.resolve_device(p_fingerprint text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_fp  text := iam.normalize_fingerprint(p_fingerprint);
  v_dev iam.device%rowtype;
begin
  select * into v_dev from iam.device where key_fingerprint = v_fp;
  if not found then
    perform iam.raise_alert('UNREGISTERED_DEVICE', 'HIGH', null, null, null, null, null, jsonb_build_object('fingerprint', v_fp));
    return jsonb_build_object('accepted', false, 'code', 'EBMR-IAM-070', 'reason', 'UNREGISTERED_DEVICE');
  end if;
  if v_dev.status <> 'ACTIVE' then
    perform iam.raise_alert('BLOCKED_DEVICE_USE', 'HIGH', null, null, v_dev.id, null, null,
                            jsonb_build_object('status', v_dev.status, 'code', v_dev.code));
    return jsonb_build_object('accepted', false, 'code', 'EBMR-IAM-071', 'reason', 'DEVICE_' || v_dev.status, 'device_id', v_dev.id);
  end if;
  return jsonb_build_object('accepted', true, 'device_id', v_dev.id, 'code', v_dev.code, 'device_class', v_dev.device_class,
                            'site_code', v_dev.site_code, 'room_code', v_dev.room_code, 'line_code', v_dev.line_code);
end
$$;

-- DI-20 location binding: a data source (or Grade A/B terminal) may deliver data only for the
-- room or line it is registered to. A mismatch (for example a relocated balance) is refused with
-- an alert. Never raises, for the same reason as resolve_device.
create function iam.check_device_location(p_device uuid, p_room text, p_line text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_dev iam.device%rowtype;
begin
  select * into v_dev from iam.device where id = p_device;
  if not found then
    perform iam.raise_alert('UNREGISTERED_DEVICE', 'HIGH', null, null, null, null, null, jsonb_build_object('device_id', p_device));
    return jsonb_build_object('accepted', false, 'code', 'EBMR-IAM-070', 'reason', 'UNREGISTERED_DEVICE');
  end if;
  if v_dev.status <> 'ACTIVE' then
    perform iam.raise_alert('BLOCKED_DEVICE_USE', 'HIGH', null, null, v_dev.id, null, null, jsonb_build_object('status', v_dev.status));
    return jsonb_build_object('accepted', false, 'code', 'EBMR-IAM-071', 'reason', 'DEVICE_' || v_dev.status, 'device_id', v_dev.id);
  end if;
  if (p_room is not null and v_dev.room_code is distinct from p_room) or (p_line is not null and v_dev.line_code is distinct from p_line)
     or (p_room is null and p_line is null) then
    perform iam.raise_alert('DEVICE_LOCATION_MISMATCH', 'HIGH', null, null, v_dev.id, null, null,
                            jsonb_build_object('registered_room', v_dev.room_code, 'registered_line', v_dev.line_code,
                                               'requested_room', p_room, 'requested_line', p_line));
    return jsonb_build_object('accepted', false, 'code', 'EBMR-IAM-073', 'reason', 'DEVICE_LOCATION_MISMATCH', 'device_id', v_dev.id,
                              'registered_room', v_dev.room_code, 'registered_line', v_dev.line_code);
  end if;
  return jsonb_build_object('accepted', true, 'device_id', v_dev.id, 'device_class', v_dev.device_class, 'room_code', v_dev.room_code,
                            'line_code', v_dev.line_code);
end
$$;

select kernel.register_audited_table('iam.device', 'device', 'id', false);
select iam.protect_rows('iam.device');

grant select on iam.device to ebmr_app;
grant execute on function iam.normalize_fingerprint(text), iam.register_device(text, text, text, text, text, text, text),
                          iam.set_device_status(uuid, text, text), iam.relocate_device(uuid, text, text, text),
                          iam.resolve_device(text), iam.check_device_location(uuid, text, text) to ebmr_app;
grant execute on function iam.resolve_device(text) to ebmr_authn;

reset role;
