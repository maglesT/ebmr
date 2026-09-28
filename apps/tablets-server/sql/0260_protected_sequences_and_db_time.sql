-- Tablets server: identifiers that leave the database are protected against reuse after a restore (INV-27), and the
-- recorded_at of every audited tablets table is the database clock, forced (INV-16, DI-27).
--
-- 1. Protected sequences (kernel 0900 pattern). The tablets schema is applied after the kernel, so kernel 0900's
--    sweep never saw its id sequences; with these the scheduled INV-27 query (continuity.unprotected_sequences)
--    returns no rows on a tablets installation, and continuity's restore procedure moves both sequences past every
--    value that may already have been handed out:
--      tab.attribution_method.id  audited with the full row, so the id is in the audit trail and its exports; the
--                                 method in force is the row with the highest id, so a reused id after a restore
--                                 could also change which setting applies
--      tab.device_alarm.id        returned to the server by the alarm writers and sent out with every device alarm
--                                 (notification ebmr_device_alarm), so a listener may already hold it
-- 2. Database time. Until now these tables relied on their clock_timestamp() default, the insert guards and the
--    application role having no write privilege; platform.enforce_db_time registers the columns with the time model
--    and installs the forcing trigger (a0_db_time_*), which sets the time on insert and keeps it on update even
--    against owner-level code, as the kernel's and recipe-core's own tables do.
-- 3. tab.device_reading keeps the recorded time twice: recorded_at and recorded_us (microseconds since the epoch,
--    for exact ages without JavaScript numbers). recorded_us is now derived by a trigger that runs after the forcing
--    trigger (a1 after a0, PostgreSQL fires same-kind triggers in name order), so it can never differ from the
--    stored recorded_at; tab.ingest_reading no longer supplies either and answers with the stored value.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. Protected sequences (INV-27)

select continuity.register_protected_sequence('tab.attribution_method.id',
  pg_get_serial_sequence('tab.attribution_method', 'id')::regclass,
  'OTHER', 'tablets-server', 'Ids of tab.attribution_method (in the full-row audit trail; the latest id is the method in force)', 100000);
select continuity.register_protected_sequence('tab.device_alarm.id',
  pg_get_serial_sequence('tab.device_alarm', 'id')::regclass,
  'OTHER', 'tablets-server', 'Device alarm ids (returned to the server and sent with the ebmr_device_alarm notification)', 100000);

-- ---------------------------------------------------------------------------------------------
-- 2. recorded_at of the audited tablets tables is the database clock (INV-16, DI-27)

select platform.enforce_db_time('tab.reference_document', array['recorded_at']);
select platform.enforce_db_time('tab.reference_document_retirement', array['recorded_at']);
select platform.enforce_db_time('tab.designer_justification', array['recorded_at']);
select platform.enforce_db_time('tab.device_reading', array['recorded_at']);

-- ---------------------------------------------------------------------------------------------
-- 3. tab.device_reading.recorded_us follows the forced recorded_at

create function tab.device_reading_recorded_us() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, pg_temp as $$
begin
  new.recorded_us := platform.epoch_micros(new.recorded_at);
  return new;
end
$$;
revoke all on function tab.device_reading_recorded_us() from public;
-- Named a1_ so it runs after a0_db_time_tab_device_reading, which has already set recorded_at.
create trigger a1_recorded_us before insert or update on tab.device_reading
  for each row execute function tab.device_reading_recorded_us();

-- Ingestion as in 0250, except that the row's recorded_at and recorded_us come from the triggers above and the
-- answer carries the stored recorded_us (before, both were taken from a clock reading of its own, which the forcing
-- trigger would now replace). Privileges are kept (CREATE OR REPLACE by the same owner).
create or replace function tab.ingest_reading(p_reading jsonb, p_delay_us bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor    jsonb := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key      tab.gateway_key%rowtype;
  v_bind     tab.gateway_instrument%rowtype;
  v_dev      iam.device%rowtype;
  v_existing tab.device_reading%rowtype;
  v_id       uuid;
  v_seq      bigint;
  v_head     jsonb;
  v_hash     text;
  v_recorded_us bigint;
begin
  perform iam.assert_not_administrator();
  v_key := tab.actor_gateway_key();
  begin
    v_id := (p_reading ->> 'readingId')::uuid;
    v_seq := (p_reading ->> 'seq')::bigint;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-040 DI-31: the reading id or sequence number is malformed';
  end;
  if v_id is null or v_seq is null or v_seq < 1 then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-040 DI-31: the reading id or sequence number is missing';
  end if;
  if p_reading ->> 'format' is distinct from 'ebmr.scale-reading.v1' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-040 DI-31: unknown reading format';
  end if;

  -- Serialise ingestion per chain; the head is read under this lock.
  perform 1 from tab.gateway_key where id = v_key.id for update;

  -- Idempotent by reading id: the same reading again is a duplicate; different content under the same id is refused.
  select * into v_existing from tab.device_reading where id = v_id;
  if found then
    if v_existing.hash = p_reading ->> 'hash' and v_existing.chain_id = v_key.id then
      return jsonb_build_object('outcome', 'DUPLICATE', 'readingId', v_id, 'seq', v_existing.seq::text, 'head', tab.chain_head(v_key.id));
    end if;
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-041 DI-31: reading %s was already received with different content', v_id);
  end if;

  if (p_reading ->> 'chainId') is distinct from v_key.id::text or (p_reading ->> 'gatewayCode') is distinct from v_key.gateway_code then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-042 DI-31: the reading belongs to chain %s of %s, not to this gateway''s enrolment', p_reading ->> 'chainId', p_reading ->> 'gatewayCode');
  end if;
  if (p_reading ->> 'installation') is distinct from kernel.installation_kind() then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-043 DI-20: a %s reading cannot enter a %s installation', p_reading ->> 'installation', kernel.installation_kind());
  end if;

  v_head := tab.chain_head(v_key.id);
  if v_seq <> (v_head ->> 'seq')::bigint + 1 or (p_reading ->> 'prevHash') is distinct from (v_head ->> 'hash') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-044 DI-31: sequence break: the server holds up to %s, the reading is %s', v_head ->> 'seq', v_seq);
  end if;
  v_hash := encode(sha256(convert_to(tab.reading_canonical_text(p_reading), 'UTF8')), 'hex');
  if v_hash is distinct from p_reading ->> 'hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-045 DI-31: the reading hash does not match its content';
  end if;

  select * into v_bind from tab.gateway_instrument
   where gateway_key_id = v_key.id and device_code = p_reading ->> 'deviceCode' and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-046 DI-20: %s is not an instrument of gateway %s', p_reading ->> 'deviceCode', v_key.gateway_code);
  end if;
  select * into v_dev from iam.device where id = v_bind.instrument_device_id;
  if v_dev.status <> 'ACTIVE' or v_dev.device_class <> 'INSTRUMENT' then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-047 DI-20: instrument %s is %s', v_dev.code, v_dev.status);
  end if;
  if (p_reading ->> 'serial') is distinct from v_bind.expected_serial then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-048 DI-20: serial %s is not the registered serial of %s', p_reading ->> 'serial', v_dev.code);
  end if;
  if (p_reading ->> 'unit') is not null and (p_reading ->> 'unit') <> v_bind.unit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-049 DI-31: unit %s is not the configured unit %s of %s', p_reading ->> 'unit', v_bind.unit, v_dev.code);
  end if;
  if (p_reading ->> 'value') is not null
     and (not tab.is_decimal_text(p_reading ->> 'value') or mod((p_reading ->> 'value')::numeric, v_bind.resolution::numeric) <> 0) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-050 DI-31: value %s is not a multiple of the resolution %s', p_reading ->> 'value', v_bind.resolution);
  end if;

  insert into tab.device_reading (id, chain_id, seq, gateway_device_id, gateway_code, instrument_device_id, device_code, serial, value, unit,
                                  stable, status, raw, source_time_us, trust, installation, purpose, prev_hash, hash, signature,
                                  uplink_delay_us, ingest_session_id, correlation_id)
  values (v_id, v_key.id, v_seq, v_key.gateway_device_id, v_key.gateway_code, v_dev.id, v_dev.code, p_reading ->> 'serial',
          p_reading ->> 'value', p_reading ->> 'unit', (p_reading ->> 'stable')::boolean, p_reading ->> 'status', p_reading ->> 'raw',
          (p_reading ->> 'sourceTimeUs')::bigint, p_reading ->> 'trust', p_reading ->> 'installation', p_reading ->> 'purpose',
          p_reading ->> 'prevHash', v_hash, p_reading ->> 'signature', p_delay_us,
          (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning recorded_us into v_recorded_us;
  perform kernel.audit_business_event('device_reading:' || v_id,
    format('Scale reading %s from %s via gateway %s: %s (%s), raw "%s"', v_seq, v_dev.code, v_key.gateway_code,
           coalesce((p_reading ->> 'value') || ' ' || (p_reading ->> 'unit'), 'no value'), p_reading ->> 'status', p_reading ->> 'raw'),
    jsonb_build_object('chain_id', v_key.id, 'seq', v_seq, 'hash', v_hash, 'purpose', p_reading ->> 'purpose'));
  return jsonb_build_object('outcome', 'INGESTED', 'readingId', v_id, 'seq', v_seq::text, 'head', tab.chain_head(v_key.id),
                            'recordedUs', v_recorded_us::text);
end
$$;

reset role;
