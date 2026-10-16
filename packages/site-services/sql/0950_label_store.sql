-- Site services, Phase 6 slice 6c: the label store and its permission (PR-32; default D-P6c-11; ADR 0012: the rules hold
-- when the application's own database credentials are used directly).
--
-- Handbook: modules/site-services.md
--
--   permission LABEL_STORE.TRANSACT (WRITE), held by WAREHOUSE_LABELLING only: nobody else opens a transaction of the
--   label store (PR-32: printed material is kept under controlled access).
--   site.label_store_transaction  insert-only, audited: RECEIPT, ISSUE (to a packaging order, by its batch number),
--       RETURN (from that order) or DESTRUCTION (with a reason) of a printed-packaging lot (site.material_lot of kind
--       PRINTED_PACKAGING), in whole units.
--   site.open_label_store_transaction(p)   {kind, lotId, quantity, batchRef?, reason?}. Refusals: EBMR-LBL-020 the form;
--       -021 no printed-packaging lot; -022 an issue of a lot that is not RELEASED; -023 more than the store holds (or than
--       was issued to the order, for a return; or than the lot received, for receipts); -024 a destruction without a reason.
--   site.label_store_balance(lot)   receipts and returns less issues and destructions.
-- The G-21 ISSUE entry stays the batch record's issue (D-P6c-11); the store's transactions are the warehouse's.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0950_label_store)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the label store permission (PR-32; Phase 6 slice 6c)'));

insert into iam.permission (code, domain, effect, description) values
  ('LABEL_STORE.TRANSACT', 'GMP', 'WRITE', 'Open a label-store transaction: receipt, issue, return or destruction of printed material (PR-32)');
insert into iam.role_permission (role_code, permission_code) values ('WAREHOUSE_LABELLING', 'LABEL_STORE.TRANSACT');

select kernel.set_actor_context(null);

create table site.label_store_transaction (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('RECEIPT', 'ISSUE', 'RETURN', 'DESTRUCTION')),
  lot_id              uuid not null references site.material_lot (id),
  quantity            numeric not null check (quantity > 0 and scale(quantity) = 0),
  batch_ref           text check (batch_ref is null or batch_ref ~ '^[!-~]{1,64}$'),
  reason              text check (reason is null or btrim(reason) <> ''),
  performed_by_person uuid not null,
  performed_by_account uuid not null,
  performed_at        timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  check ((kind in ('ISSUE', 'RETURN')) = (batch_ref is not null)),
  check (kind <> 'DESTRUCTION' or reason is not null)
);
create index label_store_transaction_by_lot on site.label_store_transaction (lot_id, performed_at);
revoke all on site.label_store_transaction from public;
create trigger aa_label_store_transaction_insert_only before update or delete on site.label_store_transaction for each row execute function kernel.reject_mutation();
create trigger aa_label_store_transaction_no_truncate before truncate on site.label_store_transaction for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('site.label_store_transaction', array['performed_at']);
select kernel.register_audited_table('site.label_store_transaction', 'material_lot', 'lot_id', true);

-- The units of lot p_lot the store holds (header).
create function site.label_store_balance(p_lot uuid) returns numeric
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce(sum(case when t.kind in ('RECEIPT', 'RETURN') then t.quantity else -t.quantity end), 0)
    from site.label_store_transaction t where t.lot_id = p_lot
$$;

-- PR-32 (header).
create function site.open_label_store_transaction(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_actor jsonb;
  l       site.material_lot;
  v_qty   numeric;
  v_kind  text := p ->> 'kind';
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('LABEL_STORE.TRANSACT', '{}'::jsonb);
  if jsonb_typeof(p) is distinct from 'object' or exists (select 1 from jsonb_object_keys(p) k where k not in ('kind', 'lotId', 'quantity', 'batchRef', 'reason'))
     or v_kind is null or v_kind not in ('RECEIPT', 'ISSUE', 'RETURN', 'DESTRUCTION')
     or coalesce(p ->> 'lotId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p ->> 'quantity', '') !~ '^[1-9][0-9]{0,8}$'
     or (p ? 'batchRef' and coalesce(p ->> 'batchRef', '') !~ '^[!-~]{1,64}$')
     or (p ? 'reason' and btrim(coalesce(p ->> 'reason', '')) = '')
     or ((v_kind in ('ISSUE', 'RETURN')) <> (p ? 'batchRef')) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-LBL-020 a label-store transaction is {kind RECEIPT, ISSUE, RETURN or DESTRUCTION, lotId, quantity (whole units), batchRef for an issue or a return, reason}';
  end if;
  select * into l from site.material_lot where id = (p ->> 'lotId')::uuid for update;
  if l.id is null or l.material_kind <> 'PRINTED_PACKAGING' then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-021 the label store holds printed-packaging lots only';
  end if;
  v_qty := (p ->> 'quantity')::numeric;
  if v_kind = 'DESTRUCTION' and not (p ? 'reason') then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-024 a destruction of printed material is recorded with its reason';
  end if;
  if v_kind = 'ISSUE' and site.lot_state(l.id) is distinct from 'RELEASED' then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-022 lot %s is %s: only a released lot is issued (PR-32)', l.lot_code, coalesce(site.lot_state(l.id), 'unknown'));
  end if;
  if v_kind = 'RECEIPT' and coalesce((select sum(t.quantity) from site.label_store_transaction t where t.lot_id = l.id and t.kind = 'RECEIPT'), 0) + v_qty > l.received_quantity then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-023 lot %s received %s units; the store cannot take in more', l.lot_code, l.received_quantity);
  end if;
  if v_kind in ('ISSUE', 'DESTRUCTION') and site.label_store_balance(l.id) < v_qty then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-023 the store holds %s units of lot %s, fewer than %s', site.label_store_balance(l.id), l.lot_code, v_qty);
  end if;
  if v_kind = 'RETURN' and coalesce((select sum(case t.kind when 'ISSUE' then t.quantity else -t.quantity end) from site.label_store_transaction t
                                      where t.lot_id = l.id and t.batch_ref = p ->> 'batchRef' and t.kind in ('ISSUE', 'RETURN')), 0) < v_qty then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-023 order %s holds fewer than %s units of lot %s from the store', p ->> 'batchRef', v_qty, l.lot_code);
  end if;
  insert into site.label_store_transaction (kind, lot_id, quantity, batch_ref, reason, performed_by_person, performed_by_account, correlation_id)
  values (v_kind, l.id, v_qty, p ->> 'batchRef', nullif(btrim(p ->> 'reason'), ''), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function site.label_store_balance(uuid), site.open_label_store_transaction(jsonb) from public;
grant execute on function site.label_store_balance(uuid), site.open_label_store_transaction(jsonb) to ebmr_app;
grant select on site.label_store_transaction to ebmr_app;

reset role;
