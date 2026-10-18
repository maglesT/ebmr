-- Phase 7 slice 7b-1 (review residual 6jc-R11; DI-31): a sequence gap on the adapter of a blocking mirror is
-- acknowledged by the system owner or QA, not by whoever holds ALARM.ACKNOWLEDGE.
--
-- Handbook: modules/integrations.md
--
-- Why. platform.record_mirror_sync (kernel 1182) marks a mirror fresh over a hole in the adapter's sequence numbers once
-- a person has acknowledged the SEQUENCE_GAP alarm that covers it: the acknowledgment's note is then the only account of
-- the lost messages. An OPERATOR or SHIFT_SUPERVISOR (ALARM.ACKNOWLEDGE, a shop-floor permission) could give it, and so
-- let a blocking mirror (LMS qualifications, CMMS calibration and maintenance, QMS status, ERP lot status, L3 serial
-- status) be used again over messages nobody accounted for.
--
--   ALARM.ACKNOWLEDGE_GAP (GMP, ACKNOWLEDGE): acknowledge a sequence gap on the adapter of a blocking mirror. Held by
--       PROCESS_OWNER (the system owner) and QA_REVIEWER (the quality unit); no administration role holds it (DI-18).
--   platform.acknowledge_integration_alarm: CREATE OR REPLACE from its only definition (kernel 1180), same signature,
--       owner, SECURITY DEFINER, search_path and privileges. Every check of 1180 stays, in its order and with its
--       messages (unknown alarm EBMR-INT-007, the note EBMR-INT-008, once EBMR-INT-007). Added: an administrator is
--       refused first (iam.assert_not_administrator, DI-18); then a SEQUENCE_GAP alarm of an adapter whose source system
--       feeds a blocking mirror data class (platform.mirror_data_class.blocking, in any mode) needs
--       alarm.acknowledge_gap, every other alarm alarm.acknowledge as before. The refusal of the first is EBMR-PLAT-006
--       naming ALARM.ACKNOWLEDGE_GAP.
--   platform.gap_needs_owner_or_qa(alarm): whether that rule applies to an alarm (screens and tests read it).
-- platform.record_mirror_sync is not changed: it counts an acknowledgment whoever gave it; from this migration only the
-- system owner or QA gives one for such a gap. An acknowledgment recorded before this migration keeps counting (it is
-- part of the audited history; the integration health page names who gave it).
-- A later migration that re-creates platform.acknowledge_integration_alarm starts from this definition.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1320_sequence_gap_acknowledgment)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'a sequence gap on a blocking mirror''s adapter is acknowledged by the system owner or QA (DI-31, 6jc-R11)'));

insert into iam.permission (code, domain, effect, description) values
  ('ALARM.ACKNOWLEDGE_GAP', 'GMP', 'ACKNOWLEDGE',
   'Acknowledge a sequence gap on the adapter of a blocking mirror, accounting for the lost messages (DI-31)');
insert into iam.role_permission (role_code, permission_code) values
  ('PROCESS_OWNER', 'ALARM.ACKNOWLEDGE_GAP'),
  ('QA_REVIEWER', 'ALARM.ACKNOWLEDGE_GAP');

select kernel.set_actor_context(null);

create function platform.gap_needs_owner_or_qa(p_alarm uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, platform, iam, pg_temp as $$
  select coalesce((select a.kind = 'SEQUENCE_GAP'
                          and exists (select 1 from platform.mirror_data_class c
                                       where c.blocking and c.source_system = ad.source_system)
                     from platform.integration_alarm a join iam.integration_adapter ad on ad.id = a.adapter_id
                    where a.id = p_alarm), false)
$$;
revoke all on function platform.gap_needs_owner_or_qa(uuid) from public;
grant execute on function platform.gap_needs_owner_or_qa(uuid) to ebmr_app;

create or replace function platform.acknowledge_integration_alarm(p_alarm uuid, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx   jsonb := platform.require_actor();
  v_alarm platform.integration_alarm%rowtype;
begin
  -- Phase 7 slice 7b-1 (kernel 1320): administrators never acknowledge (DI-18).
  perform iam.assert_not_administrator();
  select * into v_alarm from platform.integration_alarm where id = p_alarm;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-007 unknown integration alarm %s', p_alarm);
  end if;
  -- Phase 7 slice 7b-1 (kernel 1320, 6jc-R11, DI-31): a gap on a blocking mirror's adapter is the system owner's or QA's.
  if platform.gap_needs_owner_or_qa(p_alarm) then
    perform platform.authorize('alarm.acknowledge_gap', 'integration_adapter', v_alarm.adapter_code);
  else
    perform platform.authorize('alarm.acknowledge', 'integration_adapter', v_alarm.adapter_code);
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-INT-008 acknowledging an integration alarm needs a note';
  end if;
  if exists (select 1 from platform.integration_alarm_ack where alarm_id = p_alarm) then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-007 integration alarm %s is already acknowledged', p_alarm);
  end if;
  insert into platform.integration_alarm_ack (alarm_id, adapter_code, note, acknowledged_by, acknowledged_role)
  values (p_alarm, v_alarm.adapter_code, p_note, (v_ctx ->> 'person_id')::uuid, v_ctx ->> 'role_code');
end
$$;

reset role;
