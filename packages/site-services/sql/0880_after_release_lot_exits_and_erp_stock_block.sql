-- Site services: the after-release exits of a finished lot and the ERP stock-block outbox with its stub consumer (Phase 4
-- slice 5a; outline 5.2.6 "After release" and "Rejected lots", 4.6 ERP / WMS; L-19, PR-46, IN-05 (e); plan
-- docs/build-plan/phase-4/phase-4-plan.md slice 5, defaults D-5-3 and D-5-6). The machine version that uses the two
-- guards is 0881 (material_lot v3, generated from packages/site-services/src/lots/machine.ts).
--
--   material_lot.after_release_decision   site.guard_after_release_decision: the lot is a FINISHED lot and the AP's
--       after-release decision for IN recorded in this transaction is the one the event names (RELEASE_RECALL: RECALL;
--       RELEASE_REJECT: REJECT_AFTER_RELEASE). The decision is recipe-core's (recipe.after_release_lot_event_in_xact,
--       recipe-core 0840), found when the guard runs (site services apply before recipe-core: the pattern of 0860);
--       without the release model the guard refuses (fails closed).
--   material_lot.disposal_recorded        site.guard_disposal_recorded: the lot's disposal completed in this transaction
--       by the route the event names (DISPOSAL_DESTROY: a witnessed destruction whose witness signed now; DISPOSAL_RETURN:
--       a return recorded now) (recipe.disposal_lot_event_in_xact, recipe-core 0840).
--
-- The ERP stock-block outbox (D-5-3; the "Other" class of decision 0008: delivery to the stub):
--   site.erp_stock_block_request   insert-only, audited (aggregate erp_stock_block, keyed by the lot): one message per lot,
--                                  kind (BLOCK or UNBLOCK) and cause, written in the transaction that suspended the lot
--                                  (or decided every market of it again) by recipe-core's definers only
--                                  (site.request_erp_stock_block, owner only; idempotent by lot, kind and cause).
--   site.erp_stock_block_delivery  insert-only, audited: the ERP stub applied the message (at least once; a message is
--                                  applied once, a redelivery is answered "already applied").
--   site.erp_stub_apply_stock_block(request) boolean   INTERFACE.WRITE (the ERP interface): true the first time, false
--                                  for a redelivery.
--   site.erp_stub_deliver_stock_blocks(limit) integer  INTERFACE.WRITE: applies the pending messages, oldest first.
--   site.erp_stock_state(lot) text  BLOCKED or FREE as the ERP stub holds it (its last applied message), NULL when it
--                                  never received one.
-- Shipping does not wait for the stub: the shipping interlock (0870) reads the release model's states, which the
-- suspension changes in its own transaction.
-- Messages: EBMR-SITE-880 to EBMR-SITE-889.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- The guards of material_lot v3
-- ---------------------------------------------------------------------------------------------

create function site.guard_after_release_decision(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l       site.material_lot;
  v_event text;
begin
  select * into l from site.material_lot where id = p_id;
  if not found then
    return 'the lot does not exist';
  end if;
  if l.material_kind <> 'FINISHED' then
    return format('lot %s is %s: only a finished lot is recalled or rejected after release through the release model', l.lot_code, l.material_kind);
  end if;
  if to_regprocedure('recipe.after_release_lot_event_in_xact(uuid)') is null then
    return 'the release model is not installed: the after-release decision is refused';
  end if;
  execute 'select recipe.after_release_lot_event_in_xact($1)' into v_event using p_id;
  if v_event is distinct from p_transition ->> 'event' then
    return format('finished lot %s is recalled or rejected after release only through the AP''s signed decision for IN; no %s was recorded for it in this transaction (L-19)',
                  l.lot_code, coalesce(p_transition ->> 'event', 'NULL'));
  end if;
  return null;
end
$$;

create function site.guard_disposal_recorded(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l       site.material_lot;
  v_event text;
begin
  select * into l from site.material_lot where id = p_id;
  if not found then
    return 'the lot does not exist';
  end if;
  if l.material_kind <> 'FINISHED' then
    return format('lot %s is %s: the disposal of the release model is for finished lots', l.lot_code, l.material_kind);
  end if;
  if to_regprocedure('recipe.disposal_lot_event_in_xact(uuid)') is null then
    return 'the release model is not installed: the disposal is refused';
  end if;
  execute 'select recipe.disposal_lot_event_in_xact($1)' into v_event using p_id;
  if v_event is distinct from p_transition ->> 'event' then
    return format('finished lot %s leaves its rejected state only by its recorded disposal (PR-46); no %s was completed for it in this transaction',
                  l.lot_code, coalesce(p_transition ->> 'event', 'NULL'));
  end if;
  return null;
end
$$;

revoke all on function site.guard_after_release_decision(text, uuid, jsonb, jsonb, jsonb), site.guard_disposal_recorded(text, uuid, jsonb, jsonb, jsonb) from public;

select platform.register_guard('material_lot.after_release_decision', 'site.guard_after_release_decision(text, uuid, jsonb, jsonb, jsonb)',
                               'A released finished lot is recalled or rejected after release only by the AP''s decision for IN recorded in the same transaction (L-19)');
select platform.register_guard('material_lot.disposal_recorded', 'site.guard_disposal_recorded(text, uuid, jsonb, jsonb, jsonb)',
                               'A rejected or recalled finished lot is destroyed or returned only by its disposal completed in the same transaction (PR-46, IN-05 (e))');

-- ---------------------------------------------------------------------------------------------
-- The ERP stock-block outbox and the stub consumer
-- ---------------------------------------------------------------------------------------------

create table site.erp_stock_block_request (
  id            uuid primary key default gen_random_uuid(),
  lot_id        uuid not null references site.material_lot (id),
  kind          text not null check (kind in ('BLOCK', 'UNBLOCK')),
  cause_key     text not null check (cause_key ~ '^[A-Z][A-Z_]{1,39}/[!-~]{1,200}$'),
  cause         jsonb not null check (jsonb_typeof(cause) = 'object'),
  xact_id       xid8 not null default pg_current_xact_id(),
  requested_at  timestamptz not null default clock_timestamp(),
  unique (lot_id, kind, cause_key)
);
create index erp_stock_block_request_lot on site.erp_stock_block_request (lot_id, requested_at);

create table site.erp_stock_block_delivery (
  request_id           uuid primary key references site.erp_stock_block_request (id),
  lot_id               uuid not null,
  kind                 text not null,
  delivered_by_person  uuid not null,
  delivered_by_account uuid not null,
  delivered_at         timestamptz not null default clock_timestamp()
);
create index erp_stock_block_delivery_lot on site.erp_stock_block_delivery (lot_id, delivered_at);

revoke all on site.erp_stock_block_request, site.erp_stock_block_delivery from public;
grant select on site.erp_stock_block_request, site.erp_stock_block_delivery to ebmr_app;
select platform.enforce_db_time('site.erp_stock_block_request', array['requested_at']);
select platform.enforce_db_time('site.erp_stock_block_delivery', array['delivered_at']);
select kernel.register_audited_table('site.erp_stock_block_request', 'erp_stock_block', 'lot_id', true);
select kernel.register_audited_table('site.erp_stock_block_delivery', 'erp_stock_block', 'lot_id', true);

-- Owner only (recipe-core's suspension and after-release acts): the message, in the caller's transaction.
create function site.request_erp_stock_block(p_lot uuid, p_kind text, p_cause_key text, p_cause jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_id uuid;
begin
  insert into site.erp_stock_block_request (lot_id, kind, cause_key, cause)
  values (p_lot, p_kind, p_cause_key, coalesce(p_cause, '{}'::jsonb))
  on conflict (lot_id, kind, cause_key) do nothing
  returning id into v_id;
  return coalesce(v_id, (select r.id from site.erp_stock_block_request r where r.lot_id = p_lot and r.kind = p_kind and r.cause_key = p_cause_key));
end
$$;

-- The ERP stub applies one message: true the first time, false for a redelivery (idempotent by lot and cause).
create function site.erp_stub_apply_stock_block(p_request uuid) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_actor jsonb;
  r       site.erp_stock_block_request;
  v_done  integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('INTERFACE.WRITE');
  select * into r from site.erp_stock_block_request where id = p_request;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-880 there is no stock-block message %s', coalesce(p_request::text, 'NULL'));
  end if;
  perform 1 from site.material_lot where id = r.lot_id for update;
  insert into site.erp_stock_block_delivery (request_id, lot_id, kind, delivered_by_person, delivered_by_account)
  values (r.id, r.lot_id, r.kind, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  on conflict (request_id) do nothing;
  get diagnostics v_done = row_count;
  return v_done = 1;
end
$$;

create function site.erp_stub_deliver_stock_blocks(p_limit integer) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_n integer := 0;
  x   uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE');
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-881 the delivery limit is between 1 and 1000';
  end if;
  for x in select r.id from site.erp_stock_block_request r
            where not exists (select 1 from site.erp_stock_block_delivery d where d.request_id = r.id)
            order by r.requested_at, r.id limit p_limit loop
    if site.erp_stub_apply_stock_block(x) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end
$$;

create function site.erp_stock_state(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case d.kind when 'BLOCK' then 'BLOCKED' else 'FREE' end
    from site.erp_stock_block_delivery d join site.erp_stock_block_request r on r.id = d.request_id
   where d.lot_id = p_lot order by d.delivered_at desc, r.requested_at desc limit 1
$$;

revoke all on function site.request_erp_stock_block(uuid, text, text, jsonb), site.erp_stub_apply_stock_block(uuid),
                       site.erp_stub_deliver_stock_blocks(integer), site.erp_stock_state(uuid) from public;
grant execute on function site.erp_stub_apply_stock_block(uuid), site.erp_stub_deliver_stock_blocks(integer), site.erp_stock_state(uuid) to ebmr_app;

reset role;
