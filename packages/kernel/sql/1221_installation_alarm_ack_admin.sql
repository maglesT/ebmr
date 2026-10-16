-- Kernel: an administrator never acknowledges an installation alarm (Phase 6 slice 6i; CI meta test "[DI-18] every function
-- that writes GMP data refuses administrators before it checks the permission" of packages/kernel/test/integration/
-- authorization.test.ts; DI-18, DI-31).
--
-- Handbook: modules/kernel.md
--
--   * platform.acknowledge_installation_alarm (kernel 1220) re-created: it refuses administrators (EBMR-IAM-042) before it
--     checks ALARM.ACKNOWLEDGE (a GMP permission). Nothing else changes.

set local role ebmr_owner;

create or replace function platform.acknowledge_installation_alarm(p_alarm uuid, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, pg_temp as $$
declare
  v_actor jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('ALARM.ACKNOWLEDGE', '{}'::jsonb);
  if not exists (select 1 from platform.installation_alarm a where a.id = p_alarm) then
    raise exception using errcode = 'P0001', message = format('EBMR-FED-009 there is no installation alarm %s', coalesce(p_alarm::text, 'NULL'));
  end if;
  if btrim(coalesce(p_note, '')) = '' or length(p_note) > 1000 then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-009 an acknowledgment carries a note (at most 1000 characters)';
  end if;
  perform 1 from platform.installation_alarm where id = p_alarm for update;
  if exists (select 1 from platform.installation_alarm_ack k where k.alarm_id = p_alarm) then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-009 this alarm is acknowledged already';
  end if;
  insert into platform.installation_alarm_ack (alarm_id, note, acknowledged_by, acknowledged_role)
  values (p_alarm, btrim(p_note), (v_actor ->> 'person_id')::uuid, v_actor ->> 'role_code');
end
$$;

reset role;
