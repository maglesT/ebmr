-- Recipe core, batch side of material consumption: no orphan consumption (Phase 3 exit review HIGH-4; outline 5.2.9;
-- controls INV-13, INV-14 input side; ADR 0012: the rules hold when the application's own credentials are used directly).
--
-- recipe.consume_lot (0430) checked the actor, DISPENSE.EXECUTE and that the batch exists. The application role could
-- call it against a batch that had completed, been aborted or cancelled, and without recording anything in the batch
-- record, so stock left the lot with no entry of the record naming it (a genealogy the record does not show).
--
--   * recipe.consume_lot (CREATE OR REPLACE from 0430): also refuses unless the batch's stored status is ISSUED or
--     IN_PROGRESS (EBMR-RCP-432), read under a share lock on the state row so a concurrent status change waits.
--   * recipe.consumption_entry: which entry of the batch record names a consumption (one entry per consumption), with
--     the transaction that wrote it. Owner only; written by
--       - the row trigger zzs_execution_consumption_entries (after update on recipe.execution_state): a new entry whose
--         data names a consumption of this batch made in this transaction (TB-01, tablets 0843);
--       - recipe.claim_consumption(batch, consumption, entry key), owner only, for an edition whose entry pairs its
--         consumption without naming it (G-07@1 on tablets, tablets 1100).
--   * the constraint trigger zz_consumption_named_by_entry (after insert on site.lot_consumption, deferred to commit):
--     a consumption into a GMP batch is refused unless an entry written in the same transaction names it
--     (EBMR-RCP-433). A test run's lots have no stock: a sandbox batch is not checked.
--   * the row trigger zzt_execution_batch_end (after update on recipe.execution_state): when the stored status becomes
--     EXECUTION_COMPLETE, ABORTED or CANCELLED, the batch's open reservations are revoked (site.revoke_batch_reservations,
--     site-services 0801, kind BATCH_ENDED).
--
-- Messages: EBMR-RCP-432, EBMR-RCP-433. CREATE OR REPLACE keeps the owner and grants.

set local role ebmr_owner;

create or replace function recipe.consume_lot(p_batch uuid, p_reservation uuid, p_material_code text, p_quantity numeric, p_unit text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, iam, pg_temp as $$
declare
  b        recipe.batch_execution;
  v_status text;
begin
  if kernel.current_actor() is null then
    raise exception using errcode = 'P0001',
      message = 'No validated command: material is consumed inside a command started with kernel.begin_command (INV-07; EBMR-RCP-430)';
  end if;
  perform iam.assert_not_administrator();
  -- Dispensing against a batch (DI-17), at the actor's location like the execution writers; the site checks it again
  -- in the lot's site.
  perform iam.require_permission('DISPENSE.EXECUTE', iam.actor_location_scope());
  select * into b from recipe.batch_execution where id = p_batch for share;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s: material is consumed only into an issued batch (INV-14; EBMR-RCP-431)', p_batch);
  end if;
  select s.status into v_status from recipe.execution_state s where s.batch_id = b.id for share;
  if v_status is null or v_status not in ('ISSUED', 'IN_PROGRESS') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-RCP-432 batch %s is %s: material is consumed only into a running batch (ISSUED or IN_PROGRESS), never into one completed, on hold, aborted or cancelled (INV-13, INV-14)',
                       b.batch_number, coalesce(v_status, 'without a stored state'));
  end if;
  return site.consume_reservation(p_reservation, b.id, b.batch_number, b.market_set, p_material_code, p_quantity, p_unit)
         || jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'market_set', to_jsonb(b.market_set));
end
$$;

create table recipe.consumption_entry (
  consumption_id  uuid primary key,
  batch_id        uuid not null,
  entry_key       text not null check (btrim(entry_key) <> ''),
  xact_id         bigint not null default txid_current(),
  recorded_at     timestamptz not null default clock_timestamp()
);
revoke all on recipe.consumption_entry from public;
create trigger aa_insert_only before update or delete on recipe.consumption_entry for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.consumption_entry for each statement execute function kernel.reject_mutation();

-- Names consumption p_consumption by entry p_entry_key of batch p_batch, when it is a consumption into that batch made
-- in this transaction (otherwise nothing is recorded, and the deferred check refuses the consumption it leaves). Owner
-- only (header).
create function recipe.claim_consumption(p_batch uuid, p_consumption uuid, p_entry_key text) returns void
language sql volatile security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  insert into recipe.consumption_entry (consumption_id, batch_id, entry_key)
  select c.id, c.batch_id, p_entry_key
    from site.lot_consumption c
   where c.id = p_consumption and c.batch_id = p_batch and c.xact_id = txid_current()
  on conflict (consumption_id) do nothing
$$;

create function recipe.consumption_entries_record() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  e0 jsonb := case when jsonb_typeof(old.state -> 'entries') = 'object' then old.state -> 'entries' else '{}'::jsonb end;
  e1 jsonb := case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end;
  y  record;
begin
  for y in select x.key, x.value -> 'data' ->> 'consumption' as c
             from jsonb_each(e1) x
            where not (e0 ? x.key) and jsonb_typeof(x.value -> 'data' -> 'consumption') = 'string'
              and (x.value -> 'data' ->> 'consumption') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            order by x.key loop
    perform recipe.claim_consumption(new.batch_id, y.c::uuid, y.key);
  end loop;
  return null;
end
$$;

create trigger zzs_execution_consumption_entries after update on recipe.execution_state
  for each row execute function recipe.consumption_entries_record();

create function recipe.consumption_named_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
begin
  if not exists (select 1 from recipe.batch_execution b where b.id = new.batch_id and b.purpose = 'GMP_BATCH') then
    return null;
  end if;
  if not exists (select 1 from recipe.consumption_entry e where e.consumption_id = new.id and e.batch_id = new.batch_id and e.xact_id = new.xact_id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-RCP-433 the consumption of %s %s of material %s into batch %s is named by no entry this command recorded in the batch record: on GMP every consumption is the record''s own entry, written in the same command (INV-13, INV-14)',
                       new.quantity, new.unit, new.material_code, new.batch_number);
  end if;
  return null;
end
$$;

create constraint trigger zz_consumption_named_by_entry after insert on site.lot_consumption deferrable initially deferred
  for each row execute function recipe.consumption_named_check();

create function recipe.batch_end_reservations() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
begin
  if new.status in ('EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED') and new.status is distinct from old.status then
    perform site.revoke_batch_reservations(new.batch_id,
      format('batch %s: %s -> %s', (select b.batch_number from recipe.batch_execution b where b.id = new.batch_id), old.status, new.status));
  end if;
  return null;
end
$$;

create trigger zzt_execution_batch_end after update on recipe.execution_state
  for each row execute function recipe.batch_end_reservations();

revoke all on function recipe.claim_consumption(uuid, uuid, text), recipe.consumption_entries_record(), recipe.consumption_named_check(),
                       recipe.batch_end_reservations() from public;

reset role;
