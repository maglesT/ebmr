-- Recipe core: acknowledging a notification is a write, so it checks a catalogued permission after refusing
-- administrators (DI-17, DI-18), like every app-callable writer. The permission goes to the roles that make up a
-- notification department (0810); the department check stays.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0812_notification_ack_permission)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'Acknowledging a notification checks a catalogued permission (DI-17, DI-18)'));

insert into iam.permission (code, domain, effect, description) values
  ('NOTIFICATION.ACKNOWLEDGE', 'GMP', 'WRITE',
   'Acknowledge a notification addressed to the department of the role one is working in (IN-39)');

insert into iam.role_permission (role_code, permission_code)
select distinct role_code, 'NOTIFICATION.ACKNOWLEDGE' from recipe.notification_department_role;

create or replace function recipe.acknowledge_notification(p_notification uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_admin jsonb := iam.assert_not_administrator();
  v_actor jsonb := iam.require_permission('NOTIFICATION.ACKNOWLEDGE');
  n       recipe.notification;
begin
  select * into n from recipe.notification where id = p_notification;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-NTF-002 there is no notification %s', coalesce(p_notification::text, 'NULL'));
  end if;
  if not recipe.notification_role_in(v_actor ->> 'role_code', n.department) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-NTF-003 the notification is for the %s department; you are working as %s, which is not part of it (IN-39)', n.department, v_actor ->> 'role_code');
  end if;
  insert into recipe.notification_acknowledgement (notification_id, person_id, account_id, role_code)
  values (n.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code');
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'EBMR-NTF-004 you acknowledged this notification already';
end
$$;

reset role;
