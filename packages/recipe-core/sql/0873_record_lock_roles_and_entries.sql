-- Recipe core: the role each person acted in, kept with the bulk reconciliation, the amendments, their entries and closes
-- and the bright-stock maximum hold (Phase 4 slice 5b; the screens show a person with the role of the act, DI-22).
-- New nullable columns (0871 and 0872 are not edited); a BEFORE INSERT trigger fills each from the transaction's actor
-- context (kernel.current_actor) and refuses a value that is not that role, for every writer.
-- recipe.append_amendment_entry: CREATE OR REPLACE from its latest definition (0872): the entries of an amendment are
-- appended by production's responsible person (RECORD.PRODUCTION_APPROVE, D-5b-6) in the office, not by STEP.EXECUTE
-- at a shop-floor terminal; QA closes the amendment over them (0872).
-- The reads of the records screens call recipe.packaging_children_of and recipe.batch_product (stable reads of tables the
-- application role reads already): executable by ebmr_app.

set local role ebmr_owner;

alter table recipe.bulk_reconciliation add column role_code text;
alter table recipe.record_amendment add column role_code text;
alter table recipe.record_amendment_entry add column role_code text;
alter table recipe.record_amendment_close add column role_code text;
alter table recipe.bright_stock_max_hold add column role_code text;

create function recipe.record_lock_actor_role() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
declare
  v_role text := kernel.current_actor() ->> 'role_code';
begin
  if new.role_code is not null and new.role_code is distinct from v_role then
    raise exception using errcode = 'P0001', message = 'EBMR-LCK-060 the role of the act is the role the person is working in (the actor context), never another';
  end if;
  new.role_code := v_role;
  return new;
end
$$;
revoke all on function recipe.record_lock_actor_role() from public;

create trigger a1_actor_role before insert on recipe.bulk_reconciliation for each row execute function recipe.record_lock_actor_role();
create trigger a1_actor_role before insert on recipe.record_amendment for each row execute function recipe.record_lock_actor_role();
create trigger a1_actor_role before insert on recipe.record_amendment_entry for each row execute function recipe.record_lock_actor_role();
create trigger a1_actor_role before insert on recipe.record_amendment_close for each row execute function recipe.record_lock_actor_role();
create trigger a1_actor_role before insert on recipe.bright_stock_max_hold for each row execute function recipe.record_lock_actor_role();

create or replace function recipe.append_amendment_entry(p_batch uuid, p_number integer, p_kind text, p_target text, p_text text, p_value text, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  a       recipe.record_amendment;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH') then
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-030 %s is no GMP batch record', coalesce(p_batch::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('RECORD.PRODUCTION_APPROVE', plant.batch_scope(p_batch));
  perform 1 from recipe.batch_execution b where b.id = p_batch for update;
  select * into a from recipe.record_amendment r where r.batch_id = p_batch and r.number = p_number;
  if a.id is null or exists (select 1 from recipe.record_amendment_close c where c.amendment_id = a.id) or recipe.record_lock_state(p_batch) <> 'UNDER_AMENDMENT' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LCK-040 amendment %s of the record is not open: entries are appended to an open amendment only (INV-21)', coalesce(p_number::text, 'NULL'));
  end if;
  if p_kind is null or p_kind not in ('LATE_ENTRY', 'CORRECTION', 'NOTE') or p_target is null or btrim(p_target) = '' or length(p_target) > 200
     or p_text is null or btrim(p_text) = '' or length(p_text) > 4000 or (p_value is not null and (btrim(p_value) = '' or length(p_value) > 200))
     or p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-LCK-041 an amendment entry is a LATE_ENTRY, CORRECTION or NOTE naming what it amends, its text, its value if any and its reason (at least 10 characters)';
  end if;
  insert into recipe.record_amendment_entry (amendment_id, batch_id, seq, kind, target, body, value, reason, person_id, account_id)
  values (a.id, p_batch, (select count(*) + 1 from recipe.record_amendment_entry e where e.amendment_id = a.id), p_kind, btrim(p_target), btrim(p_text),
          nullif(btrim(p_value), ''), btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  perform recipe.bump_epoch('BATCH', p_batch);
  return v_id;
end
$$;

grant execute on function recipe.packaging_children_of(uuid), recipe.batch_product(uuid), recipe.batch_family_kind(uuid) to ebmr_app;

reset role;
