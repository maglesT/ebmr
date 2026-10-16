-- Phase 6 slice 6f (builder A): an environmental excursion is delivered to both departments' notification centre
-- (IN-39 clause 2, deferred from Phase 3 and 4: "both departments are notified"). Default D-P6f-A-7.
--
-- Handbook: modules/recipe-core.md
--
-- Until now the run recorded the excursion's notification to production and QA with the exception (the engine's
-- NOTIFICATION effect of the G-11 environmental condition check, block generic/recording.ts) but only manufacturer
-- release decisions reached the notification centre (0810, 0811). Now:
--   * recipe.notification takes a second kind of cause: an exception of the register (batch, exception id) instead of a
--     signature, the event ENVIRONMENT_EXCURSION and the subject kind BATCH (the table is altered, never re-created;
--     every existing row keeps its signature cause);
--   * an AFTER INSERT trigger on recipe.exception_register (zzn_excursion_notifies) inserts one notification for
--     PRODUCTION and one for QA in the transaction that registers an ENVIRONMENT_EXCURSION exception, naming the batch,
--     the step and the person whose command raised it; if they cannot be written the exception is not registered
--     either, so no excursion is recorded unnotified (fails closed, EBMR-NTF-010). The acknowledgement is unchanged
--     (recipe.acknowledge_notification: a person of the department, once).
--
-- Messages: EBMR-NTF-010.

set local role ebmr_owner;

alter table recipe.notification drop constraint notification_event_check;
alter table recipe.notification add constraint notification_event_check
  check (event in ('MANUFACTURER_RELEASED', 'MANUFACTURER_REJECTED', 'ENVIRONMENT_EXCURSION'));
alter table recipe.notification drop constraint notification_subject_kind_check;
alter table recipe.notification add constraint notification_subject_kind_check check (subject_kind in ('FINISHED_LOT', 'BATCH'));
alter table recipe.notification alter column cause_signature_id drop not null;
alter table recipe.notification add column cause_batch_id uuid, add column cause_exception_id text;
alter table recipe.notification add constraint notification_cause_check check (
  (cause_signature_id is not null and cause_batch_id is null and cause_exception_id is null)
  or (cause_signature_id is null and cause_batch_id is not null and cause_exception_id is not null));
alter table recipe.notification add constraint notification_cause_exception_fk
  foreign key (cause_batch_id, cause_exception_id) references recipe.exception_register (batch_id, exception_id);
create unique index notification_exception_department on recipe.notification (cause_batch_id, cause_exception_id, department)
  where cause_exception_id is not null;

create function recipe.notify_departments_of_excursion() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
declare
  v_label text;
  v_role  text := kernel.current_actor() ->> 'role_code';
begin
  if new.exception_type <> 'ENVIRONMENT_EXCURSION' then
    return null;
  end if;
  select format('Batch %s', b.batch_number) into v_label from recipe.batch_execution b where b.id = new.batch_id;
  if v_label is null or v_role is null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-NTF-010 the excursion %s of batch %s cannot be delivered to production and QA: no batch or no command context (IN-39)', new.exception_id, new.batch_id);
  end if;
  insert into recipe.notification (department, event, subject_kind, subject_id, subject_label, message, cause_signature_id,
                                   cause_batch_id, cause_exception_id, caused_by_person, caused_by_role)
  select d.code, 'ENVIRONMENT_EXCURSION', 'BATCH', new.batch_id, v_label,
         format('%s: %s at step %s (%s); a deviation is required.', v_label, new.title, coalesce(new.raising_step, new.raising_step_key, '?'), new.severity),
         null, new.batch_id, new.exception_id, new.command_person, v_role
  from recipe.notification_department d where d.code in ('PRODUCTION', 'QA');
  return null;
end
$$;
create trigger zzn_excursion_notifies after insert on recipe.exception_register
  for each row execute function recipe.notify_departments_of_excursion();

revoke all on function recipe.notify_departments_of_excursion() from public;

reset role;
