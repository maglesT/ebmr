-- Recipe core: the bulk reconciliation of a processing record (it locks the record), bulk across several packaging
-- orders and the maximum hold of bright stock (Phase 4 slice 5b; outline 5.2.10; INV-21, PR-38; defaults D-5-7, D-5-8,
-- D-5b-1 to D-5b-4 in docs/build-plan/phase-4/phase-4-plan.md).
--
--   recipe.bulk_reconciliation (insert-only, audited): one per processing (or reprocessing) record: the totals per unit
--       produced (closed containers not merged into another), issued to its packaging orders and left, the containers
--       left (held by the closure: they are never packed afterwards, the record being locked) and the reason they are
--       held. Recorded by recipe.close_bulk_reconciliation(batch, reason), RECORD.PRODUCTION_APPROVE in the batch's
--       scope: the batch is a GMP processing or reprocessing record with its execution complete, every packaging order of
--       its bulk is closed (EXECUTION_COMPLETE, ABORTED or CANCELLED; a planned order is cancelled first), no container
--       is still open, the issued sum is not above the produced one; the record then locks (0870).
--   recipe.bulk_close_problems(batch): why it cannot close now (the read shows them; the act checks them again).
--   PR-38, bulk across orders: a container is issued to one order once (0701); a trigger on recipe.packaging_bulk_issue
--       checks, for every writer, that the quantity is the container's closed net in its unit, the container is the
--       processing batch's, and the batch's issued sum in that unit never exceeds what it produced.
--   PR-38, bright stock (filled, unlabelled bulk, D-5b-1: the processing batch's closed containers, held from their
--       close): recipe.bright_stock_max_hold (insert-only versions per product and strength, latest wins) set by
--       recipe.set_bright_stock_hold (MASTERDATA.CHANGE, with a reason). recipe.bright_stock_container_problem(container,
--       order) is the reason a container is past the hold, or NULL: no maximum set for the product (D-5b-2), within it,
--       or covered by a deviation linked to the order, its processing batch or the container and assessed by QA
--       (IMPACT_ASSESSED, PENDING_CLOSURE or CLOSED: D-5b-3). recipe.issue_packaging_bulk (re-created from 0701) refuses
--       such a container (EBMR-PKG-006); recipe.bright_stock_hold_problem(order) is read at packaging start (tablets 1190).
--
-- Messages: EBMR-LCK-010 to EBMR-LCK-029, EBMR-PKG-006.

set local role ebmr_owner;

create table recipe.bulk_reconciliation (
  id                     uuid primary key default gen_random_uuid(),
  batch_id               uuid not null unique references recipe.batch_execution (id),
  produced               jsonb not null check (jsonb_typeof(produced) = 'array'),
  issued                 jsonb not null check (jsonb_typeof(issued) = 'array'),
  remaining              jsonb not null check (jsonb_typeof(remaining) = 'array'),
  remaining_containers   uuid[] not null,
  remaining_held_reason  text check (remaining_held_reason is null or length(btrim(remaining_held_reason)) >= 10),
  person_id              uuid not null,
  account_id             uuid not null,
  recorded_at            timestamptz not null default clock_timestamp(),
  check (cardinality(remaining_containers) = 0 or remaining_held_reason is not null)
);
revoke all on recipe.bulk_reconciliation from public;
grant select on recipe.bulk_reconciliation to ebmr_app;
select platform.enforce_db_time('recipe.bulk_reconciliation', array['recorded_at']);
select kernel.register_audited_table('recipe.bulk_reconciliation', 'record_lock', 'batch_id', true);

create table recipe.bright_stock_max_hold (
  id              uuid primary key default gen_random_uuid(),
  product_code    text not null check (product_code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  strength        text not null check (btrim(strength) <> '' and length(strength) <= 64),
  max_hold_hours  integer not null check (max_hold_hours between 1 and 99999),
  reason          text not null check (length(btrim(reason)) >= 10),
  person_id       uuid not null,
  account_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);
create index bright_stock_max_hold_key on recipe.bright_stock_max_hold (product_code, strength, recorded_at desc);
revoke all on recipe.bright_stock_max_hold from public;
grant select on recipe.bright_stock_max_hold to ebmr_app;
select platform.enforce_db_time('recipe.bright_stock_max_hold', array['recorded_at']);
select kernel.register_audited_table('recipe.bright_stock_max_hold', 'bright_stock_hold', 'product_code', true);

-- The record kind of a batch (its family's), NULL for an unknown batch.
create function recipe.batch_family_kind(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select f.record_kind from recipe.stub_batch s join recipe.mbr_family f on f.id = s.family_id where s.id = p_batch
$$;

-- The status of a packaging order: its execution status once issued, else its planned stub's.
create function recipe.order_status(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select s.status from recipe.execution_state s where s.batch_id = p_batch), (select b.status from recipe.stub_batch b where b.id = p_batch))
$$;

-- Where each container of a batch went: ISSUED, CHARGED, MERGED, REJECTED, OPEN or LEFT (still the batch's).
create function recipe.bulk_container_disposition(p_container uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
  select case
           when exists (select 1 from recipe.packaging_bulk_issue i where i.container_id = p_container) then 'ISSUED'
           when exists (select 1 from plant.container_merge m where m.source_id = p_container) then 'MERGED'
           when exists (select 1 from plant.container_charge g where g.container_id = p_container) then 'CHARGED'
           when not exists (select 1 from plant.container_close x where x.container_id = p_container) then 'OPEN'
           when plant.container_state(p_container) = 'REJECTED' then 'REJECTED'
           else 'LEFT'
         end
$$;

-- Totals per unit: [{quantity, unit}] of the batch's containers with the given dispositions (closed nets).
create function recipe.bulk_totals(p_batch uuid, p_dispositions text[]) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('quantity', t.q::text, 'unit', t.u) order by t.u), '[]'::jsonb)
    from (select c.quantity_unit as u, sum(x.net_quantity) as q
            from plant.output_container c join plant.container_close x on x.container_id = c.id
           where c.batch_id = p_batch and recipe.bulk_container_disposition(c.id) = any (p_dispositions)
           group by c.quantity_unit) t
$$;

create function recipe.bulk_close_problems(p_batch uuid) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  v_out    text[] := '{}';
  v_kind   text := recipe.batch_family_kind(p_batch);
  v_status text := (select s.status from recipe.execution_state s where s.batch_id = p_batch);
  o        uuid;
  v_os     text;
  c        record;
begin
  if not exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH') then
    return array[format('%s is no GMP batch', coalesce(p_batch::text, 'NULL'))];
  end if;
  if v_kind is null or v_kind not in ('PROCESSING', 'REPROCESSING') then
    v_out := v_out || format('the record is a %s record: a packaging record locks at its lot''s first disposition, not by a bulk reconciliation', coalesce(lower(v_kind), 'unknown'));
  end if;
  if exists (select 1 from recipe.bulk_reconciliation r where r.batch_id = p_batch) then
    v_out := v_out || 'the bulk reconciliation is already closed'::text;
  elsif recipe.record_lock_state(p_batch) <> 'UNLOCKED' then
    v_out := v_out || format('the record is already %s', recipe.record_lock_state(p_batch));
  end if;
  if v_status is distinct from 'EXECUTION_COMPLETE' then
    v_out := v_out || format('the batch is %s: its bulk is reconciled once its execution is complete', coalesce(v_status, 'without a stored state'));
  end if;
  foreach o in array recipe.packaging_children_of(p_batch) loop
    v_os := recipe.order_status(o);
    if v_os is null or v_os not in ('EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED') then
      v_out := v_out || format('packaging order %s is %s: every packaging order of the bulk is closed (completed, aborted or cancelled) before the reconciliation closes',
                               (select b.batch_number from recipe.stub_batch b where b.id = o), coalesce(v_os, 'without a status'));
    end if;
  end loop;
  for c in select x.label_code from plant.output_container x where x.batch_id = p_batch and recipe.bulk_container_disposition(x.id) = 'OPEN' order by x.label_code loop
    v_out := v_out || format('container %s is still open: every container is closed with its net quantity before the bulk is reconciled', c.label_code);
  end loop;
  return v_out;
end
$$;

create function recipe.close_bulk_reconciliation(p_batch uuid, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, iam, pg_temp as $$
declare
  v_actor  jsonb;
  b        recipe.batch_execution;
  v_prob   text[];
  v_left   uuid[];
  v_id     uuid;
  v_prod   jsonb;
  v_iss    jsonb;
  u        record;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.batch_execution where id = p_batch for update;
  if not found or b.purpose <> 'GMP_BATCH' then
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-010 %s is no GMP batch: a bulk reconciliation is closed for a processing batch', coalesce(p_batch::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('RECORD.PRODUCTION_APPROVE', plant.batch_scope(p_batch));
  -- Serialise with the engine (its state row) and with every bulk issue from the batch (its containers).
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  perform 1 from plant.output_container c where c.batch_id = p_batch for update;
  v_prob := recipe.bulk_close_problems(p_batch);
  if cardinality(v_prob) > 0 then
    raise exception using errcode = 'P0001', message = format('EBMR-LCK-011 the bulk reconciliation of batch %s cannot be closed: %s (INV-21, D-5-7)', b.batch_number, array_to_string(v_prob, '; '));
  end if;
  v_left := array(select c.id from plant.output_container c where c.batch_id = p_batch and recipe.bulk_container_disposition(c.id) = 'LEFT' order by c.label_code);
  if cardinality(v_left) > 0 and (p_reason is null or length(btrim(p_reason)) < 10) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LCK-012 %s container(s) of bulk are left: the closure holds them, with the reason they are held (at least 10 characters)', cardinality(v_left));
  end if;
  v_prod := recipe.bulk_totals(p_batch, array['ISSUED', 'CHARGED', 'REJECTED', 'LEFT']);
  v_iss := recipe.bulk_totals(p_batch, array['ISSUED']);
  -- PR-38: never more issued than produced, per unit (the issue trigger holds it already; checked again at closure).
  for u in select i ->> 'unit' as unit, (i ->> 'quantity')::numeric as q from jsonb_array_elements(v_iss) i loop
    if u.q > coalesce((select (p ->> 'quantity')::numeric from jsonb_array_elements(v_prod) p where p ->> 'unit' = u.unit), 0) then
      raise exception using errcode = 'P0001', message = format('EBMR-LCK-013 more bulk was issued (%s %s) than batch %s produced (PR-38)', u.q, u.unit, b.batch_number);
    end if;
  end loop;
  insert into recipe.bulk_reconciliation (batch_id, produced, issued, remaining, remaining_containers, remaining_held_reason, person_id, account_id)
  values (p_batch, v_prod, v_iss, recipe.bulk_totals(p_batch, array['LEFT']), v_left, case when cardinality(v_left) > 0 then btrim(p_reason) end,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  perform recipe.record_lock_append(p_batch, 'LOCKED', 'BULK_RECONCILIATION_CLOSED', null, null, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return v_id;
end
$$;

-- PR-38 for every writer of the bulk issue: the container's own net, of the processing batch, never more than produced.
create function recipe.bulk_issue_within_produced() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  c       plant.output_container;
  v_net   numeric := (select x.net_quantity from plant.container_close x where x.container_id = new.container_id);
  v_iss   numeric;
  v_prod  numeric;
begin
  select * into c from plant.output_container where id = new.container_id;
  if c.id is null or c.batch_id <> new.parent_batch_id or v_net is null or new.quantity <> v_net or new.unit <> c.quantity_unit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LCK-014 a bulk issue records the closed net quantity of a container of the processing batch, in its unit (%s %s issued; container net %s %s) (PR-38)',
                       new.quantity, new.unit, coalesce(v_net::text, 'none'), coalesce(c.quantity_unit, '-'));
  end if;
  select coalesce(sum(i.quantity), 0) into v_iss from recipe.packaging_bulk_issue i where i.parent_batch_id = new.parent_batch_id and i.unit = new.unit;
  select coalesce(sum(x.net_quantity), 0) into v_prod
    from plant.output_container o join plant.container_close x on x.container_id = o.id
   where o.batch_id = new.parent_batch_id and o.quantity_unit = new.unit and not exists (select 1 from plant.container_merge m where m.source_id = o.id);
  if v_iss > v_prod then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LCK-015 the bulk issued from batch %s across its packaging orders (%s %s) would exceed what it produced (%s %s) (PR-38)',
                       c.batch_number, v_iss, new.unit, v_prod, new.unit);
  end if;
  return null;
end
$$;
create trigger zzzl_bulk_issue_within_produced after insert on recipe.packaging_bulk_issue for each row execute function recipe.bulk_issue_within_produced();

create function recipe.set_bright_stock_hold(p_product text, p_strength text, p_hours integer, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE');
  if p_product is null or p_product !~ '^[A-Z0-9][A-Z0-9-]{0,31}$' or p_strength is null or btrim(p_strength) = '' or length(p_strength) > 64
     or p_hours is null or p_hours not between 1 and 99999 or p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-LCK-020 a maximum hold for bright stock names the product code, the strength, a whole number of hours (1 to 99999) and the reason (at least 10 characters) (PR-38)';
  end if;
  insert into recipe.bright_stock_max_hold (product_code, strength, max_hold_hours, reason, person_id, account_id)
  values (p_product, btrim(p_strength), p_hours, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.bright_stock_max_hold_of(p_product text, p_strength text) returns integer
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select h.max_hold_hours from recipe.bright_stock_max_hold h where h.product_code = p_product and h.strength = p_strength
   order by h.recorded_at desc, h.id desc limit 1
$$;

-- D-5b-3: a deviation linked to the order, its processing batch or the container, assessed by QA.
create function recipe.bright_stock_deviation_covers(p_order uuid, p_parent uuid, p_container uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select exists (select 1 from site.deviation_link k
                  where (k.batch_id in (p_order, p_parent) or (k.subject_kind = 'CONTAINER' and k.subject_id = p_container))
                    and site.deviation_state(k.deviation_id) in ('IMPACT_ASSESSED', 'PENDING_CLOSURE', 'CLOSED'))
$$;

create function recipe.bright_stock_container_problem(p_container uuid, p_order uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  c        plant.output_container;
  v_closed timestamptz := plant.container_closed_at(p_container);
  v_max    integer;
begin
  select * into c from plant.output_container where id = p_container;
  if c.id is null or v_closed is null then
    return null;
  end if;
  v_max := recipe.bright_stock_max_hold_of(c.product_code, c.strength);
  if v_max is null or clock_timestamp() - v_closed <= make_interval(hours => v_max) then
    return null;
  end if;
  if recipe.bright_stock_deviation_covers(p_order, c.batch_id, c.id) then
    return null;
  end if;
  return format('container %s of %s %s was closed %s hours ago, past the maximum hold of %s hours for bright stock, and no deviation linked to the packaging order, its processing batch or the container has been assessed by QA (PR-38)',
                c.label_code, c.product_code, c.strength, floor(extract(epoch from clock_timestamp() - v_closed) / 3600)::bigint, v_max);
end
$$;

-- At packaging start (tablets 1190): the first container issued to the order past its hold, or NULL.
create function recipe.bright_stock_hold_problem(p_order uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select p from (select recipe.bright_stock_container_problem(i.container_id, i.order_batch_id) as p, i.recorded_at, i.container_id
                   from recipe.packaging_bulk_issue i where i.order_batch_id = p_order) x
   where p is not null order by x.recorded_at, x.container_id limit 1
$$;

-- 0701's bulk issue, with the record lock named first and the bright-stock hold checked per container (PR-38).
create or replace function recipe.issue_packaging_bulk(p_order uuid, p_labels text[]) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, site, iam, kernel, platform, pg_temp as $$
declare
  v_actor  jsonb;
  b        recipe.batch_execution;
  sb       recipe.stub_batch;
  f        recipe.mbr_family;
  v_status text;
  v_parent uuid;
  v_pnum   text;
  v_prob   text;
  v_label  text;
  c        plant.output_container;
  v_net    numeric;
  v_charge uuid;
  v_out    jsonb := '[]'::jsonb;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.batch_execution where id = p_order for share;
  if not found or b.purpose <> 'GMP_BATCH' then
    raise exception using errcode = 'P0001', message = format('EBMR-PKG-001 batch %s is no issued GMP batch: bulk is issued to a packaging order (D-S4-2)', coalesce(p_order::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_order));
  select * into sb from recipe.stub_batch where id = p_order;
  select * into f from recipe.mbr_family where id = sb.family_id;
  select s.status into v_status from recipe.execution_state s where s.batch_id = p_order for share;
  if f.record_kind is distinct from 'PACKAGING' or v_status is null or v_status not in ('ISSUED', 'IN_PROGRESS') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PKG-001 batch %s is %s: bulk is issued only to a packaging order that is issued or running (D-S4-2)',
                       b.batch_number, case when f.record_kind is distinct from 'PACKAGING' then 'no packaging order' else coalesce(v_status, 'without a stored state') end);
  end if;
  v_parent := recipe.packaging_parent_of(p_order);
  v_pnum := (select x.batch_number from recipe.batch_execution x where x.id = v_parent);
  -- INV-21: the bulk of a reconciled (locked) processing record is no longer issued.
  perform recipe.assert_record_writable(v_parent, 'its bulk reconciliation is closed: no bulk is issued from it');
  perform recipe.assert_record_writable(p_order, 'no bulk is issued to it');
  v_prob := coalesce(recipe.packaging_parent_problem(f.product_code, sb.site, v_parent), recipe.release_for_packing_problem(v_parent));
  if v_prob is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PKG-002 the bulk of batch %s is issued to packaging order %s only once the batch is released for packing: %s (D-S4-2, INV-27)',
                       coalesce(v_pnum, '(none)'), b.batch_number, v_prob);
  end if;
  if p_labels is null or cardinality(p_labels) = 0 or exists (select 1 from unnest(p_labels) x where x is null)
     or (select count(distinct x) from unnest(p_labels) x) <> cardinality(p_labels) then
    raise exception using errcode = 'P0001', message = 'EBMR-PKG-003 a bulk issue names one or more output containers by their labels, each once';
  end if;
  foreach v_label in array (select array_agg(x order by x) from unnest(p_labels) x) loop
    select * into c from plant.output_container where label_code = v_label for update;
    if not found or c.batch_id <> v_parent then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PKG-004 label %s names no output container of batch %s, the batch packaging order %s packs (IN-26 (c))', v_label, v_pnum, b.batch_number);
    end if;
    -- The state row is locked so a hold recorded concurrently is either seen here or waits for this issue.
    perform 1 from platform.aggregate_state s where s.aggregate_type = 'output_container' and s.aggregate_id = c.id for update;
    v_prob := plant.container_usable_problem(c.id);
    select x.net_quantity into v_net from plant.container_close x where x.container_id = c.id;
    if v_prob is null and v_net is null then
      v_prob := format('container %s has no net quantity', c.label_code);
    end if;
    if v_prob is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-PKG-005 container %s cannot be issued for packing: %s (L-30, TB-11)', c.label_code, v_prob);
    end if;
    v_prob := recipe.bright_stock_container_problem(c.id, p_order);
    if v_prob is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-PKG-006 %s', v_prob);
    end if;
    insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id)
    values (c.id, p_order, 'PACKAGING', 'PACK', v_label, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
    returning id into v_charge;
    insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id)
    values (p_order, v_parent, c.id, v_charge, v_net, c.quantity_unit, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
    v_out := v_out || jsonb_build_object('label', c.label_code, 'containerId', c.id, 'quantity', v_net::text, 'unit', c.quantity_unit);
  end loop;
  return jsonb_build_object('batchId', p_order, 'parentBatchId', v_parent, 'containers', v_out);
end
$$;

revoke all on function recipe.batch_family_kind(uuid), recipe.order_status(uuid), recipe.bulk_container_disposition(uuid), recipe.bulk_totals(uuid, text[]),
  recipe.bulk_close_problems(uuid), recipe.close_bulk_reconciliation(uuid, text), recipe.bulk_issue_within_produced(), recipe.set_bright_stock_hold(text, text, integer, text),
  recipe.bright_stock_max_hold_of(text, text), recipe.bright_stock_deviation_covers(uuid, uuid, uuid), recipe.bright_stock_container_problem(uuid, uuid),
  recipe.bright_stock_hold_problem(uuid) from public;
grant execute on function recipe.order_status(uuid), recipe.bulk_container_disposition(uuid), recipe.bulk_totals(uuid, text[]), recipe.bulk_close_problems(uuid),
  recipe.close_bulk_reconciliation(uuid, text), recipe.set_bright_stock_hold(text, text, integer, text), recipe.bright_stock_max_hold_of(text, text),
  recipe.bright_stock_container_problem(uuid, uuid), recipe.bright_stock_hold_problem(uuid) to ebmr_app;

reset role;
