-- Phase 6 slice 6a (builder A): corrections of interface-captured values and the LMS mirror on the generic freshness
-- (DI-31, DI-26, DI-14; INV-26, INV-38; D-P6a-5, D-P6a-A-1, D-P6a-A-2).
--
-- Handbook: modules/kernel.md
--
--  * platform.inbound_override: the register of manual overrides of interface-captured values. A value that arrived
--    through an adapter (it keeps its message: source system, record id, source time, raw value and unit) changes
--    only through a domain correction command, which calls platform.record_inbound_override in its own transaction:
--    a person (never a SERVICE or INTEGRATION account, DI-14) with a reason (DI-22) gives the corrected value and
--    unit; the original value and unit stay beside it. Insert-only and audited on the adapter's chain
--    (integration_adapter:<code>), so every override shows on the integration health page as the interface part of
--    the exception report (DI-26 "manual entry where automatic capture was configured", "interface fallbacks").
--    The function is owner-only: domain functions (site services and later slices) call it; the application cannot.
--  * iam.qualification_source_fresh (CREATE OR REPLACE from 0130): when the site runs LMS_QUALIFICATION as a MIRROR
--    (setting integration.mode.lms_qualification, kernel 1180), an LMS qualification is fresh only while the LMS
--    adapter's last synchronisation (platform.mirror_sync, written by platform.record_mirror_sync) lies within the
--    data class's bound (integration.mirror_max_age_s.lms_qualification) of the instant evaluated. In STAND_IN (the
--    default) nothing changes: the 0130 heartbeat and its policy still apply to LMS rows, and INTERNAL rows are
--    always fresh. The authority check at signing already refuses a stale source (STALE_QUALIFICATION_SOURCE).
--  * iam.lms_mirror_problem(): the plain-language refusal naming the LMS mirror, its age and its bound, or NULL;
--    screens and the signing path show it next to STALE_QUALIFICATION_SOURCE.
--
-- Messages: EBMR-INT-020 to EBMR-INT-023.

set local role ebmr_owner;

create table platform.inbound_override (
  id                    uuid primary key default gen_random_uuid(),
  adapter_id            uuid not null references iam.integration_adapter (id),
  adapter_code          text not null,
  message_id            uuid not null references platform.inbound_message (id),
  record_kind           text not null check (record_kind ~ '^[a-z][a-z0-9_]{1,62}$'),
  record_id             uuid not null,
  field                 text not null check (field ~ '^[a-zA-Z][a-zA-Z0-9_.]{0,62}$'),
  original_value        text,
  original_unit         text,
  corrected_value       text not null,
  corrected_unit        text,
  reason                text not null check (btrim(reason) <> ''),
  corrected_by_person   uuid not null,
  corrected_by_account  uuid not null,
  corrected_by_role     text,
  correlation_id        uuid not null,
  corrected_at          timestamptz not null default clock_timestamp(),
  check (original_value is distinct from corrected_value or original_unit is distinct from corrected_unit)
);
revoke all on platform.inbound_override from public;
create index inbound_override_record on platform.inbound_override (record_kind, record_id, corrected_at);
create index inbound_override_adapter on platform.inbound_override (adapter_id, corrected_at);
comment on table platform.inbound_override is 'Manual overrides of interface-captured values (DI-31, DI-26): original and corrected value with the person''s reason. Insert-only.';

select platform.enforce_db_time('platform.inbound_override', array['corrected_at']);
select kernel.register_audited_table('platform.inbound_override', 'integration_adapter', 'adapter_code', true);

-- Records one override of an interface-captured value (header). Owner only: called by the domain's correction command,
-- which has already checked its own permission and applies the corrected value in the same transaction.
create function platform.record_inbound_override(p_message uuid, p_record_kind text, p_record_id uuid, p_field text,
                                                 p_original_value text, p_original_unit text, p_corrected_value text,
                                                 p_corrected_unit text, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_ctx  jsonb := platform.require_actor();
  v_msg  platform.inbound_message%rowtype;
  v_kind text;
  v_id   uuid;
begin
  select a.kind into v_kind from iam.account a where a.id = (v_ctx ->> 'account_id')::uuid;
  if v_kind is distinct from 'HUMAN' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-020 an interface-captured value is corrected by a person, not by a %s account (DI-14, DI-31)', coalesce(v_kind, 'unknown'));
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-INT-021 correcting an interface-captured value states the person''s reason (DI-31, DI-22)';
  end if;
  select * into v_msg from platform.inbound_message where id = p_message;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-022 no inbound message %s: only an interface-captured value is corrected here', p_message);
  end if;
  if p_corrected_value is null or (p_original_value is not distinct from p_corrected_value and p_original_unit is not distinct from p_corrected_unit) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-023 the correction of %s gives a new value (it is %s %s)', p_field, coalesce(p_original_value, 'empty'), coalesce(p_original_unit, ''));
  end if;
  insert into platform.inbound_override (adapter_id, adapter_code, message_id, record_kind, record_id, field, original_value, original_unit,
                                         corrected_value, corrected_unit, reason, corrected_by_person, corrected_by_account, corrected_by_role,
                                         correlation_id)
  values (v_msg.adapter_id, v_msg.adapter_code, v_msg.id, p_record_kind, p_record_id, p_field, p_original_value, p_original_unit,
          p_corrected_value, p_corrected_unit, p_reason, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, v_ctx ->> 'role_code',
          (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function platform.record_inbound_override(uuid, text, uuid, text, text, text, text, text, text) from public;

-- 0130's function, with the LMS mirror on platform.mirror_sync when the site runs LMS_QUALIFICATION as a MIRROR (header).
create or replace function iam.qualification_source_fresh(p_source text, p_at timestamptz) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select case
           when s.kind = 'INTERNAL' then true
           when s.code = 'LMS' and platform.setting_text('integration.mode.lms_qualification') = 'MIRROR' then
             coalesce((select m.last_synced_at >= p_at - make_interval(secs => platform.setting_numeric('integration.mirror_max_age_s.lms_qualification')::bigint)
                         from platform.mirror_sync m where m.data_class = 'LMS_QUALIFICATION'), false)
           else coalesce((select h.last_synced_at >= p_at - make_interval(secs => iam.policy_int('qualification.mirror_max_staleness_seconds'))
                            from iam.mirror_heartbeat h where h.source_code = s.code), false)
         end
  from iam.qualification_source s where s.code = p_source
$$;

-- The refusal text naming the LMS mirror when it is a stale MIRROR (the EBMR-INT-010 text of kernel 1180), else NULL.
create function iam.lms_mirror_problem() returns text
language plpgsql stable security definer set search_path = pg_catalog, iam, platform, pg_temp as $$
begin
  perform platform.mirror_fresh_or_raise('LMS_QUALIFICATION');
  return null;
exception when raise_exception then
  if sqlerrm like 'EBMR-INT-010 %' then
    return sqlerrm;
  end if;
  raise;
end
$$;

grant select on platform.inbound_override to ebmr_app;
grant execute on function iam.lms_mirror_problem() to ebmr_app;

reset role;
