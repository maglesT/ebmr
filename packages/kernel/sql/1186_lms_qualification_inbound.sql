-- Phase 6 slice 6a (builder B): the LMS adapter's receiving command (DI-31, DI-14, DI-20; INV-26; D-P6a-3, D-P6a-5).
--
-- Handbook: modules/integrations.md
--
--   iam.receive_lms_qualification(envelope jsonb) returns jsonb   the LMS adapter's command for one lms.qualification
--       message (@ebmr/integration-sdk/adapter, systems/lms.ts). It calls platform.accept_inbound_detail (kernel 1180:
--       envelope, identity, de-duplication, sequence alarms) and, when the outcome is ACCEPTED, applies the payload to
--       the qualification register in the same transaction, so a message lands whole or not at all:
--         QUALIFIED          a person_qualification row with source LMS (valid from and to as the LMS sent them); a live
--                            LMS row of the same person and qualification with other dates is withdrawn first; the same
--                            dates again change nothing;
--         REVOKED, EXPIRED   every live LMS row of the person and qualification is withdrawn with the LMS's reason.
--       The rows are recorded by the adapter's SYSTEM person (never the person qualified) and carry the message id as
--       their source reference, so each one traces to the received envelope (source system, record id, timestamp).
--       Returns {messageId, outcome, sequenceStatus, alarmId, applied}.
--   Refusals (the adapter records each with platform.record_inbound_refusal in its own command; the contract lists them):
--       EBMR-LMS-001 WRONG_IDENTITY  the site holds qualifications in the built-in register (LMS_QUALIFICATION is
--                                    STAND_IN): the modes never mix for one data class (D-P6a-5)
--       EBMR-LMS-002 MALFORMED       the payload does not have the lms.qualification shape
--       EBMR-LMS-003 WRONG_IDENTITY  no natural person with that employee number, or no such qualification type
--       EBMR-LMS-004 STALE           an older state than the one already applied for that person and qualification (by
--                                    the LMS's own timestamp; a late message never overwrites a newer one)
--
-- Freshness at signing: the LMS_QUALIFICATION mirror (kernel 1180) is synchronised by the adapter's heartbeat
-- (platform.record_mirror_sync); the qualification check at signing reads it (builder A's kernel range moves
-- iam.qualification_source_fresh onto platform.mirror_freshness).

set local role ebmr_owner;

-- The latest applied LMS message per person and qualification is read from the messages themselves (every accepted
-- message is applied; a refused one rolled back), by this index.
create index inbound_message_lms_qualification on platform.inbound_message
  ((payload ->> 'personNumber'), (payload ->> 'qualificationCode'), source_timestamp)
  where message_type = 'lms.qualification';

create function iam.lms_qualification_payload_problem(p jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 'the payload is not an object';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('personNumber', 'qualificationCode', 'status', 'validFrom', 'validTo') then
      return format('unknown field %s', k);
    end if;
  end loop;
  if jsonb_typeof(p -> 'personNumber') is distinct from 'string' or (p ->> 'personNumber') !~ '^[\x21-\x7E]{1,64}$' then
    return 'personNumber is a code of 1 to 64 printable characters';
  end if;
  if jsonb_typeof(p -> 'qualificationCode') is distinct from 'string' or (p ->> 'qualificationCode') !~ '^[\x21-\x7E]{1,64}$' then
    return 'qualificationCode is a code of 1 to 64 printable characters';
  end if;
  if coalesce(p ->> 'status', '') not in ('QUALIFIED', 'REVOKED', 'EXPIRED') then
    return 'status is QUALIFIED, REVOKED or EXPIRED';
  end if;
  if jsonb_typeof(p -> 'validFrom') is distinct from 'string' or (p ->> 'validFrom') !~ '^(0|[1-9][0-9]{0,17})$'
     or (p ->> 'validFrom')::numeric > 253402300799999999 then
    return 'validFrom is UTC epoch microseconds as text';
  end if;
  if not (p ? 'validTo') then
    return 'validTo is required (null when open-ended)';
  end if;
  if jsonb_typeof(p -> 'validTo') <> 'null' and (jsonb_typeof(p -> 'validTo') <> 'string' or (p ->> 'validTo') !~ '^(0|[1-9][0-9]{0,17})$'
     or (p ->> 'validTo')::numeric > 253402300799999999) then
    return 'validTo is UTC epoch microseconds as text, or null';
  end if;
  if jsonb_typeof(p -> 'validTo') = 'string' and (p ->> 'validTo')::numeric <= (p ->> 'validFrom')::numeric then
    return 'validTo is after validFrom';
  end if;
  return null;
end
$$;

create function iam.receive_lms_qualification(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, platform, kernel, pg_temp as $$
declare
  v_ctx     jsonb := platform.require_actor();
  v_out     jsonb;
  v_msg     platform.inbound_message;
  p         jsonb;
  v_prob    text;
  v_person  uuid;
  v_from    timestamptz;
  v_to      timestamptz;
  v_newer   timestamptz;
  v_same    boolean;
  v_applied text;
begin
  -- Never an administrator; the inbound permission of the adapter's service role (the adapter's identity is checked by
  -- platform.accept_inbound_detail: DI-14, DI-20).
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p_envelope ->> 'messageType' is distinct from 'lms.qualification' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LMS-002 this command receives lms.qualification messages, not %s', coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return v_out || jsonb_build_object('applied', 'NOTHING (duplicate)');
  end if;
  if platform.setting_text('integration.mode.lms_qualification') <> 'MIRROR' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-LMS-001 this site holds qualifications in the built-in register (LMS_QUALIFICATION is STAND_IN); an LMS message is not applied (D-P6a-5)';
  end if;
  select * into v_msg from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  p := v_msg.payload;
  v_prob := iam.lms_qualification_payload_problem(p);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-LMS-002 malformed lms.qualification payload: %s', v_prob);
  end if;
  select id into v_person from iam.person where employee_ref = p ->> 'personNumber' and kind = 'NATURAL';
  if v_person is null then
    raise exception using errcode = 'P0001', message = format('EBMR-LMS-003 no person with employee number %s is known to this installation', p ->> 'personNumber');
  end if;
  if not exists (select 1 from iam.qualification_type where code = p ->> 'qualificationCode') then
    raise exception using errcode = 'P0001', message = format('EBMR-LMS-003 qualification %s is not defined in this installation', p ->> 'qualificationCode');
  end if;
  -- One person and qualification at a time, so the newest-wins check sees every committed predecessor.
  perform pg_advisory_xact_lock(hashtextextended('lms:' || v_person::text || '/' || (p ->> 'qualificationCode'), 0));
  select max(m.source_timestamp) into v_newer from platform.inbound_message m
  where m.message_type = 'lms.qualification' and m.source_system = 'LMS' and m.id <> v_msg.id
    and m.payload ->> 'personNumber' = p ->> 'personNumber' and m.payload ->> 'qualificationCode' = p ->> 'qualificationCode';
  if v_newer is not null and v_newer >= v_msg.source_timestamp then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LMS-004 the LMS state of %s for %s at %s is older than the one already applied (%s); it is not applied',
                       p ->> 'personNumber', p ->> 'qualificationCode', v_msg.source_timestamp, v_newer);
  end if;
  v_from := platform.epoch_us_to_timestamptz(p ->> 'validFrom');
  v_to := case when jsonb_typeof(p -> 'validTo') = 'string' then platform.epoch_us_to_timestamptz(p ->> 'validTo') end;
  if p ->> 'status' = 'QUALIFIED' then
    select exists (select 1 from iam.person_qualification q
                   where q.person_id = v_person and q.qualification_code = p ->> 'qualificationCode' and q.source_code = 'LMS'
                     and q.withdrawn_at is null and q.valid_from = v_from and q.valid_to is not distinct from v_to) into v_same;
    if v_same then
      v_applied := 'UNCHANGED';
    else
      update iam.person_qualification set withdrawn_at = clock_timestamp(), withdrawn_by_person = (v_ctx ->> 'person_id')::uuid,
             withdrawal_reason = format('superseded by LMS message %s', v_msg.id)
       where person_id = v_person and qualification_code = p ->> 'qualificationCode' and source_code = 'LMS' and withdrawn_at is null;
      insert into iam.person_qualification (person_id, qualification_code, source_code, source_ref, valid_from, valid_to, recorded_by_person, recorded_by_account)
      values (v_person, p ->> 'qualificationCode', 'LMS', 'inbound_message:' || v_msg.id::text, v_from, v_to,
              (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
      v_applied := 'RECORDED';
    end if;
  else
    update iam.person_qualification set withdrawn_at = clock_timestamp(), withdrawn_by_person = (v_ctx ->> 'person_id')::uuid,
           withdrawal_reason = format('%s in the LMS (message %s)', p ->> 'status', v_msg.id)
     where person_id = v_person and qualification_code = p ->> 'qualificationCode' and source_code = 'LMS' and withdrawn_at is null;
    v_applied := case when found then 'WITHDRAWN' else 'NOTHING_LIVE' end;
  end if;
  return v_out || jsonb_build_object('applied', v_applied);
end
$$;

revoke all on function iam.lms_qualification_payload_problem(jsonb), iam.receive_lms_qualification(jsonb) from public;
grant execute on function iam.lms_qualification_payload_problem(jsonb), iam.receive_lms_qualification(jsonb) to ebmr_app;

reset role;
