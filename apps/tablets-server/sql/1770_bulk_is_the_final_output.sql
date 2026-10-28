-- Tablets server: the bulk a packaging order takes from its processing batch is that batch's final output only (owner demo
-- report R10 #4; PR-38, PR-46, PR-57).
--
-- Found. A packaging order's bulk read (recipe.packaging_order_bulk, recipe-core 0762) listed every closed container of
-- the processing batch, and the bulk issue (recipe.issue_packaging_bulk, recipe-core 0871) accepted any usable one: the
-- granules, the cores and the coated tablets as well as the inspection's reject containers, the one a disposal destroyed
-- included. Packaging takes the batch's final intermediate, the output of its last processing stage, and never rejects.
--
-- What holds now.
--   * recipe.packaging_reject_problem(container): why a container of a batch holds rejects, or NULL: it is REJECTED, or
--     the batch's own record names it as a reject container (a rejects row of a sort result, TB-20) or as the container of
--     a disposal entry (G-23: destruction, waste, a reject container or a return).
--   * recipe.packaging_bulk_problem(container): why a container is not the bulk of its batch, or NULL. The rejects above;
--     otherwise the container's stage must be the batch's last stage: the stage whose first non-reject container was
--     opened last (the processing record runs its stages in order, and the plant's containers name their stage, not the
--     master's intermediate, so the order of the record is what tells the final output from the earlier ones).
--   * recipe.packaging_order_bulk (re-created from 0762) offers only the bulk; recipe.issue_packaging_bulk (re-created
--     from 0871) refuses any other container (EBMR-PKG-007) before its other checks on the container.
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, and pin their search_path with pg_temp last. A new migration,
-- because applied migrations are checksummed and never edited.
--
-- Messages: EBMR-PKG-007.

set local role ebmr_owner;

create function recipe.packaging_reject_problem(p_container uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  c      plant.output_container;
  v_kind text;
begin
  select * into c from plant.output_container where id = p_container;
  if not found then
    return null;
  end if;
  if plant.container_state(c.id) = 'REJECTED' then
    return format('container %s is REJECTED', c.label_code);
  end if;
  select e.value ->> 'kind' into v_kind
    from recipe.execution_state s,
         jsonb_each(case when jsonb_typeof(s.state -> 'entries') = 'object' then s.state -> 'entries' else '{}'::jsonb end) e
   where s.batch_id = c.batch_id
     and ((e.value ->> 'kind' = 'DISPOSAL' and e.value -> 'data' ->> 'container' in (c.label_code, c.id::text))
          or (jsonb_typeof(e.value -> 'data' -> 'rejects') = 'array'
              and exists (select 1 from jsonb_array_elements(e.value -> 'data' -> 'rejects') r where r ->> 'container' in (c.label_code, c.id::text))))
   order by (e.value ->> 'recordedSeq')::numeric nulls last
   limit 1;
  if v_kind is not null then
    return format('container %s holds rejects of batch %s (its record names it in a %s entry): rejects are never packed', c.label_code, c.batch_number, v_kind);
  end if;
  return null;
end
$$;

create function recipe.packaging_bulk_problem(p_container uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  c       plant.output_container;
  v_prob  text;
  v_final text;
begin
  select * into c from plant.output_container where id = p_container;
  if not found then
    return 'the container does not exist';
  end if;
  v_prob := recipe.packaging_reject_problem(c.id);
  if v_prob is not null then
    return v_prob;
  end if;
  select o.stage into v_final
    from plant.output_container o
   where o.batch_id = c.batch_id and recipe.packaging_reject_problem(o.id) is null
   group by o.stage
   order by min(o.opened_at) desc, o.stage
   limit 1;
  if c.stage is distinct from v_final then
    return format('container %s holds %s output, not the bulk of batch %s: packaging takes the output of the batch''s last stage (%s)', c.label_code, c.stage, c.batch_number, coalesce(v_final, '(none)'));
  end if;
  return null;
end
$$;

-- 0762's bulk read, with the containers limited to the processing batch's bulk.
create or replace function recipe.packaging_order_bulk(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  sb       recipe.stub_batch;
  f        recipe.mbr_family;
  v_parent uuid;
  v_status text;
begin
  select * into sb from recipe.stub_batch where id = p_order;
  select * into f from recipe.mbr_family where id = sb.family_id;
  if sb.id is null or f.record_kind is distinct from 'PACKAGING' then
    return null;
  end if;
  v_parent := recipe.packaging_parent_of(p_order);
  v_status := coalesce((select s.status from recipe.execution_state s where s.batch_id = p_order), sb.status);
  return jsonb_build_object(
    'batchId', sb.id, 'batchNumber', sb.batch_number, 'status', v_status,
    'familyCode', f.code, 'packType', recipe.family_pack_type(f.id), 'productCode', f.product_code, 'strength', f.strength, 'line', sb.line,
    -- Bulk is issued only to an order that is issued or running (0701, EBMR-PKG-001).
    'orderProblem', case when not exists (select 1 from recipe.batch_execution x where x.id = p_order and x.purpose = 'GMP_BATCH') or v_status not in ('ISSUED', 'IN_PROGRESS')
                         then format('packaging order %s is %s: bulk is issued only to a packaging order that is issued or running', sb.batch_number, v_status) end,
    'parent', case when v_parent is not null then jsonb_build_object(
                'batchId', v_parent,
                'batchNumber', (select x.batch_number from recipe.batch_execution x where x.id = v_parent),
                'releaseForPackingProblem', coalesce(recipe.packaging_parent_problem(f.product_code, sb.site, v_parent), recipe.release_for_packing_problem(v_parent))) end,
    'issued', coalesce((select jsonb_agg(jsonb_build_object(
                 'label', c.label_code, 'containerId', c.id, 'quantity', trim_scale(i.quantity)::text, 'unit', i.unit,
                 'personId', i.person_id, 'issuedUs', (extract(epoch from i.recorded_at) * 1000000)::numeric(20, 0)::text)
               order by i.recorded_at, c.label_code)
          from recipe.packaging_bulk_issue i join plant.output_container c on c.id = i.container_id where i.order_batch_id = p_order), '[]'::jsonb),
    -- R10 #4: only the bulk (the batch's final output, never rejects) is offered.
    'containers', coalesce((select jsonb_agg(jsonb_build_object(
                 'label', c.label_code, 'containerId', c.id, 'stage', c.stage, 'state', plant.container_state(c.id),
                 'netQuantity', (select trim_scale(x.net_quantity)::text from plant.container_close x where x.container_id = c.id), 'unit', c.quantity_unit,
                 'issueProblem', coalesce(
                    (select format('issued to packaging order %s', o.batch_number) from recipe.packaging_bulk_issue i join recipe.batch_execution o on o.id = i.order_batch_id where i.container_id = c.id),
                    plant.container_usable_problem(c.id),
                    case when not exists (select 1 from plant.container_close x where x.container_id = c.id) then format('container %s has no net quantity', c.label_code) end))
               order by c.opened_at, c.label_code)
          from plant.output_container c where c.batch_id = v_parent and recipe.packaging_bulk_problem(c.id) is null), '[]'::jsonb));
end
$$;

-- 0871's bulk issue, with a container that is not the processing batch's bulk refused (EBMR-PKG-007).
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
    -- R10 #4: packaging takes the batch's final output, never an earlier stage's container or a reject container.
    v_prob := recipe.packaging_bulk_problem(c.id);
    if v_prob is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-PKG-007 %s (PR-38, PR-46)', v_prob);
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

revoke all on function recipe.packaging_reject_problem(uuid), recipe.packaging_bulk_problem(uuid) from public;

reset role;
