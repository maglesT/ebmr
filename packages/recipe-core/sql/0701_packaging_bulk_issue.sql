-- Recipe core: a packaging order packs only bulk its processing batch released for packing (Phase 3 exit review
-- HIGH-3; default D-S4-2; outline 5.2.8, 5.2.9; controls INV-27, IN-18, IN-26 (c), L-30; ADR 0012).
--
-- A packaging order (0582) named its issued processing batch, and nothing more tied them: its blister or bottle line
-- could run while the processing batch was still running, before QA signed its "release for packing" hold point (H-PACK)
-- or with its compression containers HELD.
--
--   * recipe.packaging_parent_of(order): the processing batch the order packs (its register number's parent, 0582).
--   * recipe.release_for_packing_problem(batch): why the processing batch is not released for packing, or NULL: its
--     record holds the hold point H-PACK ("bulk released for packing", the gate of GB-T-01's master) and every instance
--     of it is COMPLETED with a positive disposition under a valid hold-point signature (engine DISPOSITION_HOLD_POINT).
--   * recipe.packaging_bulk_issue: insert-only, audited: each output container of the processing batch issued to the
--     packaging order, with its net quantity and unit, and the charge that records it (plant.container_charge, purpose
--     PACK, stage PACKAGING), so a container is issued once and never charged elsewhere afterwards.
--   * recipe.issue_packaging_bulk(order, labels): STEP.EXECUTE in the order's scope; the order is an issued or running
--     GMP batch of a PACKAGING master; its processing batch passes 0582's parent rule and is released for packing; each
--     label names a container of that processing batch that is usable now (plant.container_usable_problem: closed and
--     bracketed or released by QA, never HELD, SORTED or REJECTED, never charged or merged; residue stays the
--     reprocessing register's, 0625) and has a net quantity. All or nothing.
--   * recipe.packaging_bulk_charged(batch): whether bulk was issued to the batch (read by the edition's packing blocks,
--     tablets 1102: TB-21 RUN_START, TB-23 and TB-24 are refused on GMP until it is).
--
-- Messages: EBMR-PKG-001 to EBMR-PKG-005.

set local role ebmr_owner;

create table recipe.packaging_bulk_issue (
  id               uuid primary key default gen_random_uuid(),
  order_batch_id   uuid not null references recipe.batch_execution (id),
  parent_batch_id  uuid not null references recipe.batch_execution (id),
  container_id     uuid not null unique references plant.output_container (id),
  charge_id        uuid not null unique references plant.container_charge (id),
  quantity         numeric not null check (quantity > 0),
  unit             text not null check (unit in ('kg', 'g', 'units')),
  person_id        uuid not null,
  account_id       uuid not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  check (order_batch_id <> parent_batch_id)
);
create index packaging_bulk_issue_order on recipe.packaging_bulk_issue (order_batch_id);
revoke all on recipe.packaging_bulk_issue from public;

select platform.enforce_db_time('recipe.packaging_bulk_issue', array['recorded_at']);
select kernel.register_audited_table('recipe.packaging_bulk_issue', 'batch', 'order_batch_id', true);

create function recipe.packaging_parent_of(p_order uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select pl.batch_id
    from recipe.batch_allocation_link l
    join site.batch_number_allocation a on a.id = l.allocation_id
    join recipe.batch_allocation_link pl on pl.allocation_id = a.parent_allocation_id
   where l.batch_id = p_order
$$;

create function recipe.release_for_packing_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  st jsonb;
begin
  select s.state into st from recipe.execution_state s where s.batch_id = p_batch;
  if st is null then
    return 'it has no stored execution state';
  end if;
  if not exists (select 1 from jsonb_each(case when jsonb_typeof(st -> 'steps') = 'object' then st -> 'steps' else '{}'::jsonb end) x
                  where x.value ->> 'step' = 'H-PACK') then
    return 'its record holds no "release for packing" hold point H-PACK';
  end if;
  if exists (select 1 from jsonb_each(st -> 'steps') x
              where x.value ->> 'step' = 'H-PACK'
                and not (x.value ->> 'status' = 'COMPLETED'
                         and x.value -> 'disposition' ->> 'positive' = 'true'
                         and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(x.value -> 'signatures') = 'array' then x.value -> 'signatures' else '[]'::jsonb end) g
                                      where g ->> 'role' = 'HOLD_POINT' and g ->> 'valid' = 'true'))) then
    return 'QA has not signed its release for packing (H-PACK) APPROVED';
  end if;
  return null;
end
$$;

create function recipe.packaging_bulk_charged(p_batch uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select exists (select 1 from recipe.packaging_bulk_issue i where i.order_batch_id = p_batch)
$$;

create function recipe.issue_packaging_bulk(p_order uuid, p_labels text[]) returns jsonb
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

revoke all on recipe.packaging_bulk_issue from ebmr_app;
grant select on recipe.packaging_bulk_issue to ebmr_app;
revoke all on function recipe.packaging_parent_of(uuid), recipe.release_for_packing_problem(uuid), recipe.packaging_bulk_charged(uuid),
                       recipe.issue_packaging_bulk(uuid, text[]) from public;
grant execute on function recipe.issue_packaging_bulk(uuid, text[]), recipe.packaging_bulk_charged(uuid), recipe.release_for_packing_problem(uuid) to ebmr_app;

reset role;
