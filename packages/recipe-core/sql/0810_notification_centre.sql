-- Recipe core: the notification centre (Phase 4 slice 3c; control IN-39 clause 2 "both departments are notified";
-- outline 7.3 notification centre; plan docs/build-plan/phase-4/phase-4-plan.md, slice 3).
--
--   recipe.notification_department       the departments a notification goes to (PRODUCTION, QA); owner-managed.
--   recipe.notification_department_role  the roles that make up a department (site configuration, owner-managed); a
--                                         person working in such a role sees and acknowledges that department's
--                                         notifications.
--   recipe.notification                  one notification to one department: the event, the subject (a finished lot),
--                                         the message, the signature that caused it and its signer. Insert-only and
--                                         audited; written only by the definers below, never by the application role.
--   recipe.notification_acknowledgement  a person's acknowledgement of a notification (one per person), with the role
--                                         they worked in. Insert-only and audited.
--
-- Database rules:
--   * the manufacturer release and the manufacturer rejection notify both departments in the signing transaction: an
--     AFTER INSERT trigger on the recorded decision (recipe.manufacturer_release_decision, slice 3a; attached by
--     recipe-core 0811) calls recipe.notify_departments_of_release, which inserts one notification for PRODUCTION and
--     one for QA; a decision it cannot read refuses the decision (fails closed, EBMR-NTF-001), so no decision is
--     recorded unnotified. A signature without a recorded decision notifies nobody;
--   * recipe.acknowledge_notification(id): the validated actor, never an administrator (DI-18), in a role of the
--     notification's department; once per person (EBMR-NTF-002 to EBMR-NTF-004).
-- Messages: EBMR-NTF-001 to EBMR-NTF-009.

set local role ebmr_owner;

create table recipe.notification_department (
  code  text primary key check (code ~ '^[A-Z][A-Z_]*$'),
  name  text not null check (btrim(name) <> '')
);

create table recipe.notification_department_role (
  department  text not null references recipe.notification_department (code),
  role_code   text not null references iam.role (code),
  primary key (department, role_code)
);

create table recipe.notification (
  id                  uuid primary key default gen_random_uuid(),
  department          text not null references recipe.notification_department (code),
  event               text not null check (event in ('MANUFACTURER_RELEASED', 'MANUFACTURER_REJECTED')),
  subject_kind        text not null check (subject_kind in ('FINISHED_LOT')),
  subject_id          uuid not null,
  subject_label       text not null check (btrim(subject_label) <> ''),
  message             text not null check (btrim(message) <> ''),
  cause_signature_id  uuid not null references esig.signature (id),
  caused_by_person    uuid not null,
  caused_by_role      text not null,
  created_at          timestamptz not null default clock_timestamp(),
  unique (cause_signature_id, department)
);
create index notification_department_at on recipe.notification (department, created_at);
create index notification_subject on recipe.notification (subject_id, created_at);

create table recipe.notification_acknowledgement (
  notification_id  uuid not null references recipe.notification (id),
  person_id        uuid not null,
  account_id       uuid not null,
  role_code        text not null,
  acknowledged_at  timestamptz not null default clock_timestamp(),
  primary key (notification_id, person_id)
);

insert into recipe.notification_department (code, name) values ('PRODUCTION', 'Production'), ('QA', 'Quality assurance');
insert into recipe.notification_department_role (department, role_code)
select d.department, r.code
from (values ('PRODUCTION', 'HEAD_OF_PRODUCTION'), ('PRODUCTION', 'SHIFT_SUPERVISOR'), ('PRODUCTION', 'PRODUCTION_SUPERVISOR'),
             ('QA', 'AUTHORISED_PERSON'), ('QA', 'QA_REVIEWER'), ('QA', 'QA_SHOP_FLOOR'), ('QA', 'QA_MBR_APPROVER')) d (department, role_code)
join iam.role r on r.code = d.role_code;

revoke all on recipe.notification_department, recipe.notification_department_role, recipe.notification,
              recipe.notification_acknowledgement from public;
select platform.enforce_db_time('recipe.notification', array['created_at']);
select platform.enforce_db_time('recipe.notification_acknowledgement', array['acknowledged_at']);
select kernel.register_audited_table('recipe.notification_department', 'notification_department', 'code', true);
select kernel.register_audited_table('recipe.notification_department_role', 'notification_department', 'department', true);
select kernel.register_audited_table('recipe.notification', 'notification', 'id', true);
select kernel.register_audited_table('recipe.notification_acknowledgement', 'notification', 'notification_id', true);

-- Notifies both departments (PRODUCTION and QA) of a recorded manufacturer decision on a finished lot, naming the
-- signature that carries it and its signer. Called only by the trigger on the decision (owner-only).
create function recipe.notify_departments_of_release(p_lot uuid, p_decision text, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, pg_temp as $$
declare
  s        esig.signature;
  v_label  text;
  v_event  text;
begin
  if p_decision is null or p_decision not in ('RELEASE', 'REJECT') then
    raise exception using errcode = 'P0001', message = format('EBMR-NTF-001 decision %s is neither RELEASE nor REJECT: both departments could not be notified (IN-39)', coalesce(p_decision, 'NULL'));
  end if;
  select * into s from esig.signature where id = p_signature;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-NTF-001 the decision names no signature %s: both departments could not be notified (IN-39)', coalesce(p_signature::text, 'NULL'));
  end if;
  select format('%s %s, batch %s (lot %s)', f.product_code, f.strength, f.batch_number, l.lot_code) into v_label
  from site.finished_lot f join site.material_lot l on l.id = f.lot_id where f.lot_id = p_lot;
  if v_label is null then
    raise exception using errcode = 'P0001', message = format('EBMR-NTF-001 %s is no finished lot: both departments could not be notified (IN-39)', coalesce(p_lot::text, 'NULL'));
  end if;
  v_event := case p_decision when 'RELEASE' then 'MANUFACTURER_RELEASED' else 'MANUFACTURER_REJECTED' end;
  insert into recipe.notification (department, event, subject_kind, subject_id, subject_label, message, cause_signature_id, caused_by_person, caused_by_role)
  select d.code, v_event, 'FINISHED_LOT', p_lot, v_label,
         format('%s was %s by %s (%s).', v_label, case p_decision when 'RELEASE' then 'released' else 'rejected' end, s.signer_legal_name, s.signer_role_name),
         s.id, s.signer_person, s.signer_role_code
  from recipe.notification_department d where d.code in ('PRODUCTION', 'QA');
end
$$;


-- Whether a role belongs to the department of the notification.
create function recipe.notification_role_in(p_role text, p_department text) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select exists (select 1 from recipe.notification_department_role r where r.department = p_department and r.role_code = p_role)
$$;

create function recipe.acknowledge_notification(p_notification uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb := iam.assert_not_administrator();
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

revoke all on recipe.notification_department, recipe.notification_department_role, recipe.notification,
              recipe.notification_acknowledgement from ebmr_app;
grant select on recipe.notification_department, recipe.notification_department_role, recipe.notification,
              recipe.notification_acknowledgement to ebmr_app;
revoke all on function recipe.notify_departments_of_release(uuid, text, uuid), recipe.notification_role_in(text, text), recipe.acknowledge_notification(uuid) from public;
grant execute on function recipe.notification_role_in(text, text), recipe.acknowledge_notification(uuid) to ebmr_app;

reset role;
