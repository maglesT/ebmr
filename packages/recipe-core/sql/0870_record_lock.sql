-- Recipe core: batch records lock, and a locked record refuses every write (Phase 4 slice 5b; outline 5.2.10 "Locking";
-- INV-21, R-04; default D-5-7; contract ns/records-lock.ts).
--
--   recipe.record_lock_event (insert-only, audited): the record's lock history, one row per event in its order (seq):
--       LOCKED             once per record: BULK_RECONCILIATION_CLOSED (a processing record, 0871) or FIRST_DISPOSITION
--                          (the record of a finished lot whose first manufacturer disposition is recorded, below);
--       AMENDMENT_OPENED   QA opened an amendment (0872): the record is UNDER_AMENDMENT;
--       AMENDMENT_CLOSED   QA closed it with a signature: the record is LOCKED again.
--   recipe.record_lock_state(batch): UNLOCKED, LOCKED or UNDER_AMENDMENT (derived from the events, never stored).
--   recipe.assert_record_writable(batch, what): refuses (EBMR-LCK-001) a write to a record that is LOCKED or UNDER_AMENDMENT;
--       an amendment appends to its own table (0872), never to the record.
--   recipe.refuse_locked_write(): the row trigger a0_record_lock, BEFORE INSERT, UPDATE or DELETE, on every table that
--       holds a batch record's content, for every writer (definers, the engine's append path, a superuser alike): the
--       engine's commands, rows and state (entries, corrections, voids, hand-overs, sweeps, act and disposition
--       proposals), consumption, the exception register, abort checklists, reprocessing additions and step starts, the
--       bulk issued to or from a packaging order, and the record's output containers, closes, charges and in-process
--       checks. Its arguments name the batch columns ('container:<col>' reads the container's batch). The edition's
--       tables get the same trigger in its own migration (tablets 1190). Not covered on purpose: QA's container holds and
--       releases (a disposition of the bulk, not record content), plant logbooks (equipment, instrument and room use;
--       they belong to the equipment), the review acts (a review is about the record and runs again after an amendment).
--   A new packaging order of a locked processing record is refused (trigger on recipe.batch_allocation_link).
--   The first manufacturer disposition of a finished lot (recipe.manufacturer_release_decision, one per lot) locks the
--   lot's batch record in the same transaction.
--
-- Messages: EBMR-LCK-001 to EBMR-LCK-009.

set local role ebmr_owner;

create table recipe.record_lock_event (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references recipe.batch_execution (id),
  seq           integer not null check (seq >= 1),
  event         text not null check (event in ('LOCKED', 'AMENDMENT_OPENED', 'AMENDMENT_CLOSED')),
  cause         text check (cause in ('BULK_RECONCILIATION_CLOSED', 'FIRST_DISPOSITION')),
  lot_id        uuid,
  amendment_id  uuid,
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  unique (batch_id, seq),
  check ((event = 'LOCKED') = (cause is not null)),
  check ((event = 'LOCKED') = (amendment_id is null)),
  check (cause is distinct from 'FIRST_DISPOSITION' or lot_id is not null)
);
create unique index record_lock_event_once on recipe.record_lock_event (batch_id) where event = 'LOCKED';
revoke all on recipe.record_lock_event from public;
grant select on recipe.record_lock_event to ebmr_app;
select platform.enforce_db_time('recipe.record_lock_event', array['recorded_at']);
select kernel.register_audited_table('recipe.record_lock_event', 'record_lock', 'batch_id', true);

create function recipe.record_lock_state(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case (select e.event from recipe.record_lock_event e where e.batch_id = p_batch order by e.seq desc limit 1)
           when 'AMENDMENT_OPENED' then 'UNDER_AMENDMENT'
           when 'LOCKED' then 'LOCKED'
           when 'AMENDMENT_CLOSED' then 'LOCKED'
           else 'UNLOCKED'
         end
$$;

-- Appends one lock event (owner only; the acts that lock or amend call it with the actor of their transaction).
create function recipe.record_lock_append(p_batch uuid, p_event text, p_cause text, p_lot uuid, p_amendment uuid, p_person uuid, p_account uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  insert into recipe.record_lock_event (batch_id, seq, event, cause, lot_id, amendment_id, person_id, account_id)
  values (p_batch, (select coalesce(max(e.seq), 0) + 1 from recipe.record_lock_event e where e.batch_id = p_batch), p_event, p_cause, p_lot, p_amendment,
          p_person, p_account);
  -- The record's evidence moved: an act evaluated before (review, G-REL) is evaluated again.
  perform recipe.bump_epoch('BATCH', p_batch);
end
$$;

create function recipe.assert_record_writable(p_batch uuid, p_what text) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_state text;
begin
  if p_batch is null then
    return;
  end if;
  v_state := recipe.record_lock_state(p_batch);
  if v_state <> 'UNLOCKED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LCK-001 batch record %s is %s: it is not written any more (%s); a locked record changes only through an amendment, which QA opens under a deviation or change record and which appends, never edits (INV-21)',
                       coalesce((select b.batch_number from recipe.batch_execution b where b.id = p_batch), p_batch::text), v_state, p_what);
  end if;
end
$$;

create function recipe.refuse_locked_write() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  r     jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  i     integer;
  v_arg text;
  v_b   text;
begin
  for i in 0 .. tg_nargs - 1 loop
    v_arg := tg_argv[i];
    if v_arg like 'container:%' then
      v_b := (select c.batch_id::text from plant.output_container c where c.id = (r ->> substr(v_arg, 11))::uuid);
    else
      v_b := r ->> v_arg;
    end if;
    if v_b is not null then
      perform recipe.assert_record_writable(v_b::uuid, format('%s of %s', lower(tg_op), tg_table_schema || '.' || tg_table_name));
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create trigger a0_record_lock before insert or update or delete on recipe.execution_command for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.execution_event for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.execution_state for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.execution_act_proposal for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.execution_decision_proposal for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.execution_disposition_proposal for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.consumption_entry for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.exception_register for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.abort_checklist for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.source_addition for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.reprocessing_step_start for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on recipe.packaging_bulk_issue for each row execute function recipe.refuse_locked_write('order_batch_id', 'parent_batch_id');
create trigger a0_record_lock before insert or update or delete on plant.output_container for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on plant.container_close for each row execute function recipe.refuse_locked_write('container:container_id');
create trigger a0_record_lock before insert or update or delete on plant.container_charge for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on plant.ipc_check for each row execute function recipe.refuse_locked_write('batch_id');

-- A locked processing record plans no new packaging order: its bulk reconciliation is closed.
create function recipe.refuse_order_of_locked_record() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  perform recipe.assert_record_writable(recipe.packaging_parent_of(new.batch_id), 'a new packaging order of its bulk');
  return null;
end
$$;
create trigger zzzl_packaging_order_of_locked_record after insert on recipe.batch_allocation_link for each row execute function recipe.refuse_order_of_locked_record();

-- D-5-7: the record of a finished lot locks at the lot's first manufacturer disposition (release or rejection).
create function recipe.lock_at_first_disposition() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_batch uuid := (select f.batch_id from site.finished_lot f where f.lot_id = new.lot_id);
begin
  if v_batch is not null and exists (select 1 from recipe.batch_execution b where b.id = v_batch)
     and not exists (select 1 from recipe.record_lock_event e where e.batch_id = v_batch and e.event = 'LOCKED') then
    perform recipe.record_lock_append(v_batch, 'LOCKED', 'FIRST_DISPOSITION', new.lot_id, null, new.person_id, new.account_id);
  end if;
  return null;
end
$$;
create trigger zzzl_lock_at_first_disposition after insert on recipe.manufacturer_release_decision for each row execute function recipe.lock_at_first_disposition();

revoke all on function recipe.record_lock_state(uuid), recipe.record_lock_append(uuid, text, text, uuid, uuid, uuid, uuid), recipe.assert_record_writable(uuid, text),
                       recipe.refuse_locked_write(), recipe.refuse_order_of_locked_record(), recipe.lock_at_first_disposition() from public;
grant execute on function recipe.record_lock_state(uuid) to ebmr_app;

reset role;
