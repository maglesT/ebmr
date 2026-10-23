-- Recipe core: a manual weighing records whether its balance was inferred (Phase 7 slice 7m, review finding P7L-1;
-- DI-20, DI-30).
--
-- Handbook: modules/recipe-core.md
--
-- With no scale of the room behind the gateway and no balance named, the server takes the room's one instrument booked
-- for the batch as the balance of a weighing keyed by hand (slice 7l). The stored evidence now says so:
-- evidence.manual.balanceInferred (optional, true only when the entry declared no balance). recipe.row_evidence_problem
-- is replaced from its latest definition (0717) with that member and that rule; nothing else changes.

set local role ebmr_owner;

create or replace function recipe.row_evidence_problem(p_kind text, p_command jsonb, p_accepted boolean, p_evidence jsonb, p_room text, p_package_hash text,
                                            p_installation text) returns text
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  uuid      constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  reading   constant jsonb := '{"t": "list", "items": {"t": "object", "fields": {"purpose": {"t": "text", "enum": ["TARE", "GROSS"]},
                                "readingId": {"t": "text", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}, "deviceCode": {"t": "text"},
                                "value": {"t": "text"}, "unit": {"t": "text"}, "raw": {"t": "text", "null": true},
                                "sourceTimeUs": {"t": "text", "pattern": "^[0-9]{1,20}$", "null": true}, "trust": {"t": "text", "null": true}}}}';
  manual    constant jsonb := '{"t": "object", "fields": {"room": {"t": "text"}, "balance": {"t": "text"}, "declaredBalance": {"t": "text", "null": true}, "balanceInferred": {"t": "bool", "opt": true},
                                "scales": {"t": "list", "items": {"t": "object", "fields": {"deviceCode": {"t": "text"},
                                "status": {"t": "text", "enum": ["ONLINE", "OFFLINE", "UNKNOWN"]}, "lastHeartbeatUs": {"t": "text", "pattern": "^[0-9]{1,20}$", "null": true}}}}}}';
  scan      constant jsonb := '{"t": "object", "fields": {"code": {"t": "text"}, "recordedAs": {"t": "text", "enum": ["MANUAL"]}}}';
  v_type    text := case when jsonb_typeof(p_command) = 'object' then p_command ->> 'type' end;
  v_entry   jsonb := case when p_kind = 'COMMAND' and v_type = 'RECORD_ENTRY' and jsonb_typeof(p_command -> 'entry') = 'object' then p_command -> 'entry' end;
  v_ekind   text := v_entry ->> 'kind';
  v_signed  boolean := p_kind = 'COMMAND' and v_type in ('SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT', 'SIGN_OFF_STAGE', 'DISPOSITION_EXCEPTION', 'CORRECT_ENTRY');
  v_allowed text[];
  v_what    text;
  v_problem text;
  k         text;
  e         jsonb;
  n         bigint;
begin
  if jsonb_typeof(p_evidence) is distinct from 'object' then
    return 'evidence must be an object';
  end if;
  -- An entry of a kind no block version records is 0332's to refuse (whatever the row's verdict), with its own words.
  if v_entry is not null and not exists (select 1 from recipe.block_data_schema s where s.part = 'ENTRY' and s.entry_kind = v_ekind) then
    return null;
  end if;
  v_what := case when p_kind = 'PREPARE' then 'a preparation for a signature' when p_kind = 'SWEEP' then 'a sweep' when p_kind = 'ISSUE' then 'an issue'
                 when v_entry is not null then format('a RECORD_ENTRY command of a %s entry', coalesce(v_ekind, 'nameless'))
                 else format('a %s command', coalesce(v_type, 'nameless')) end;
  v_allowed := case
    when p_kind in ('PREPARE', 'SWEEP') then '{}'::text[]
    when p_kind = 'ISSUE' then array['packageHash']
    when p_kind is distinct from 'COMMAND' then '{}'::text[]
    when v_type = 'RECORD_DATA' then array['idempotencyKey', 'unattestedScan']
    when v_ekind = 'CONTAINER_WEIGHING' then array['idempotencyKey', 'readings', 'namedReadings', 'manual', 'lot']
    when v_ekind = 'OUTPUT_CONTAINER' then array['idempotencyKey', 'readings', 'namedReadings', 'manual']
    when v_ekind = 'CHARGE_CONTAINER' then array['idempotencyKey', 'scanned']
    when v_signed and p_accepted is true then array['idempotencyKey', 'signatureId']
    when v_signed then array['idempotencyKey', 'signing', 'meaning']
    else array['idempotencyKey'] end;
  select min(x collate "C") into k from jsonb_object_keys(p_evidence) x where not (x = any (v_allowed));
  if k is not null then
    return format('evidence.%s is a member the server does not record with %s', k, v_what);
  end if;
  if p_evidence ? 'idempotencyKey' and (jsonb_typeof(p_evidence -> 'idempotencyKey') is distinct from 'string' or (p_evidence ->> 'idempotencyKey') !~ uuid) then
    return 'evidence.idempotencyKey must be the idempotency key of the request (a UUID)';
  end if;
  if p_evidence ? 'packageHash' and (p_evidence -> 'packageHash') is distinct from to_jsonb(p_package_hash) then
    return 'evidence.packageHash must be the package the batch is issued from';
  end if;
  if p_evidence ? 'unattestedScan' then
    if p_command -> 'source' ->> 'mode' is distinct from 'MANUAL' then
      return 'evidence.unattestedScan is recorded only with a value keyed by hand';
    end if;
    v_problem := recipe.command_member_problem(scan, p_evidence -> 'unattestedScan', 'evidence.unattestedScan', false);
    if v_problem is not null then
      return v_problem;
    end if;
  end if;
  if p_evidence ? 'readings' and p_evidence ? 'namedReadings' then
    return 'evidence names its readings both as used (readings) and as not used (namedReadings)';
  end if;
  foreach k in array array['readings', 'namedReadings'] loop
    if p_evidence ? k then
      if v_entry ->> 'source' is distinct from 'DEVICE' then
        return format('evidence.%s is recorded only with an entry captured from a device', k);
      end if;
      v_problem := recipe.command_member_problem(reading, p_evidence -> k, 'evidence.' || k, false);
      if v_problem is not null then
        return v_problem;
      end if;
      for e, n in select a.v, a.i from jsonb_array_elements(p_evidence -> k) with ordinality a (v, i) order by a.i loop
        v_problem := sandbox.identifier_problem_for(p_installation, 'DEVICE_LABEL', e ->> 'deviceCode');
        if v_problem is not null then
          return format('evidence.%s[%s].deviceCode %s', k, n - 1, regexp_replace(v_problem, '\.? \[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
        end if;
      end loop;
    end if;
  end loop;
  if p_evidence ? 'manual' then
    if v_entry ->> 'source' is distinct from 'MANUAL' then
      return 'evidence.manual is recorded only with an entry keyed by hand';
    end if;
    v_problem := recipe.command_member_problem(manual, p_evidence -> 'manual', 'evidence.manual', false);
    if v_problem is not null then
      return v_problem;
    end if;
    if (p_evidence -> 'manual' -> 'room') is distinct from to_jsonb(p_room) then
      return format('evidence.manual.room must be the room of the row (%s)', coalesce(p_room, 'none'));
    end if;
    if (p_evidence -> 'manual' -> 'balance') is distinct from (v_entry -> 'balance') then
      return 'evidence.manual.balance must be the balance its entry names';
    end if;
    if jsonb_typeof(p_evidence -> 'manual' -> 'declaredBalance') = 'string' and (p_evidence -> 'manual' -> 'declaredBalance') is distinct from (v_entry -> 'balance') then
      return 'evidence.manual.declaredBalance must be the balance its entry names, or null';
    end if;
    -- P7L-1 (slice 7m): a balance the server inferred (the room's one instrument booked for the batch) is one the
    -- operator did not name.
    if (p_evidence -> 'manual' -> 'balanceInferred') = 'true'::jsonb and jsonb_typeof(p_evidence -> 'manual' -> 'declaredBalance') = 'string' then
      return 'evidence.manual.balanceInferred is true only when the entry declared no balance';
    end if;
    for e, n in select a.v, a.i from jsonb_array_elements(p_evidence -> 'manual' -> 'scales') with ordinality a (v, i) order by a.i loop
      v_problem := sandbox.identifier_problem_for(p_installation, 'DEVICE_LABEL', e ->> 'deviceCode');
      if v_problem is not null then
        return format('evidence.manual.scales[%s].deviceCode %s', n - 1, regexp_replace(v_problem, '\.? \[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
      end if;
    end loop;
  end if;
  if p_evidence ? 'lot'
     and (p_evidence -> 'lot') is distinct from jsonb_build_object('code', v_entry -> 'lot' -> 'id', 'material', v_entry -> 'lot' -> 'material', 'status', v_entry -> 'lot' -> 'status') then
    return 'evidence.lot must be the code, material and status of the lot its entry names';
  end if;
  if p_evidence ? 'scanned' and (jsonb_typeof(p_evidence -> 'scanned') is distinct from 'string' or (p_evidence -> 'scanned') is distinct from (v_entry -> 'container')) then
    return 'evidence.scanned must be the container label its entry charges';
  end if;
  if p_evidence ? 'signatureId' and (jsonb_typeof(p_evidence -> 'signatureId') is distinct from 'string' or (p_evidence -> 'signatureId') is distinct from (p_command -> 'signature' -> 'id')) then
    return 'evidence.signatureId must be the signature its command applies';
  end if;
  if (p_evidence ? 'signing') is distinct from (p_evidence ? 'meaning') then
    return 'evidence.signing and evidence.meaning are recorded together';
  end if;
  if p_evidence ? 'signing' and ((p_evidence -> 'signing') is distinct from '"refused before signing"'::jsonb
                                 or jsonb_typeof(p_evidence -> 'meaning') is distinct from 'string'
                                 or (p_evidence -> 'meaning') is distinct from (p_command -> 'signature' -> 'meaning')) then
    return 'evidence of a signed command refused before signing is {signing: "refused before signing", meaning: the meaning of its signature}';
  end if;
  return null;
end
$$;

reset role;
