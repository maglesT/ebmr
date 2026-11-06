-- Recipe core, API edition plan A2: the genealogy crosses intermediate lots (API plan section 2.3; controls PR-57, IN-07,
-- AS-04; site services 1732).
--
-- Handbook: modules/recipe-core.md
--
-- What was wrong. recipe.genealogy_step (1090) linked a batch to the lot it produced only through site.finished_lot. A
-- processing batch of the API edition posts its output as an intermediate lot (site.intermediate_lot, site services
-- 1732), so a backward trace from the API lot reached the intermediate lot consumed by the last step and stopped there,
-- and a forward trace from the first intermediate lot stopped at the batch that consumed it. The batch record must name
-- the intermediates used and the API lot must trace back through every one of them (Revised Schedule M Part XII; ICH Q7
-- section 6.5).
--
-- What changed: recipe.genealogy_step (CREATE OR REPLACE, the body of 1090 otherwise unchanged) adds the same BATCH-LOT
-- edge for an intermediate lot as for a finished lot, both ways, with the edge kind OUTPUT (the batch's output, not a finished lot; the
-- API contract's edge kinds are unchanged), as of the lot's posted_at. A tablets or injectables trace is unchanged: those
-- editions post no intermediate lot (site.intermediate_lot.edition is SUBSTANCE only). recipe.genealogy_node_exists,
-- recipe.genealogy and the node views are unchanged.

set local role ebmr_owner;

create or replace function recipe.genealogy_step(p_kinds text[], p_ids uuid[], p_direction text, p_as_of timestamptz)
returns table (from_kind text, from_id uuid, to_kind text, to_id uuid, edge_kind text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, plant, pg_temp as $$
begin
  if p_direction = 'FORWARD' then
    return query
    with f as (select x.k, x.i from unnest(p_kinds, p_ids) x(k, i))
    select 'LOT'::text, c.lot_id, 'BATCH'::text, c.batch_id, 'CONSUMED'::text
      from f join site.lot_consumption c on f.k = 'LOT' and c.lot_id = f.i where c.consumed_at <= p_as_of
    union all
    select 'LOT', r.original_lot_id, 'LOT', r.lot_id, 'RETURNED'
      from f join site.returned_goods r on f.k = 'LOT' and r.original_lot_id = f.i where r.received_at <= p_as_of
    union all
    select 'LOT', x.returned_lot_id, 'LOT', x.recovered_lot_id, 'RECOVERED'
      from f join site.chemical_recovery x on f.k = 'LOT' and x.returned_lot_id = f.i where x.recorded_at <= p_as_of
    union all
    select 'LOT', s.lot_id, 'SHIPMENT', s.id, 'SHIPPED'
      from f join site.erp_shipment s on f.k = 'LOT' and s.lot_id = f.i where s.recorded_at <= p_as_of
    union all
    select 'LOT', p.lot_id, 'TRANSFER', p.id, 'TRANSFERRED'
      from f join site.transfer_package p on f.k = 'LOT' and p.lot_id = f.i join site.transfer_package_seal ps on ps.package_id = p.id where ps.sealed_at <= p_as_of
    union all
    select 'TRANSFER', r.package_id, 'LOT', r.lot_id, 'TRANSFER_RECEIVED'
      from f join site.transfer_receipt r on f.k = 'TRANSFER' and r.package_id = f.i where r.received_at <= p_as_of
    union all
    select 'BATCH', o.batch_id, 'CONTAINER', o.id, 'OUTPUT'
      from f join plant.output_container o on f.k = 'BATCH' and o.batch_id = f.i where o.opened_at <= p_as_of
    union all
    select 'BATCH', p.parent_batch_id, 'BATCH', p.child_batch_id, 'REPROCESSED'
      from f join recipe.batch_parent_link p on f.k = 'BATCH' and p.parent_batch_id = f.i where p.recorded_at <= p_as_of
    union all
    select 'BATCH', a.source_batch_id, 'BATCH', a.batch_id, case a.case_code when 'RECOVERY' then 'RECOVERY_ADDITION' else 'REPROCESSING_ADDITION' end
      from f join recipe.source_addition a on f.k = 'BATCH' and a.source_batch_id = f.i where a.recorded_at <= p_as_of
    union all
    select 'BATCH', pl.batch_id, 'BATCH', l.batch_id, 'PACKAGING_ORDER'
      from f join recipe.batch_allocation_link pl on f.k = 'BATCH' and pl.batch_id = f.i
      join site.batch_number_allocation na on na.parent_allocation_id = pl.allocation_id
      join recipe.batch_allocation_link l on l.allocation_id = na.id
     where l.recorded_at <= p_as_of
    union all
    select 'BATCH', fl.batch_id, 'LOT', fl.lot_id, 'FINISHED'
      from f join site.finished_lot fl on f.k = 'BATCH' and fl.batch_id = f.i where fl.posted_at <= p_as_of
    union all
    select 'BATCH', il.batch_id, 'LOT', il.lot_id, 'OUTPUT'
      from f join site.intermediate_lot il on f.k = 'BATCH' and il.batch_id = f.i where il.posted_at <= p_as_of
    union all
    select 'CONTAINER', m.source_id, 'CONTAINER', m.target_id, 'MERGED'
      from f join plant.container_merge m on f.k = 'CONTAINER' and m.source_id = f.i where m.recorded_at <= p_as_of
    union all
    select 'CONTAINER', b.container_id, 'BATCH', b.order_batch_id, 'BULK_ISSUE'
      from f join recipe.packaging_bulk_issue b on f.k = 'CONTAINER' and b.container_id = f.i where b.recorded_at <= p_as_of
    union all
    select 'CONTAINER', ch.container_id, 'BATCH', ch.batch_id, 'CHARGED'
      from f join plant.container_charge ch on f.k = 'CONTAINER' and ch.container_id = f.i
      join plant.output_container o on o.id = ch.container_id
     where ch.purpose = 'CHARGE' and ch.batch_id <> o.batch_id and ch.recorded_at <= p_as_of;
  elsif p_direction = 'BACKWARD' then
    return query
    with f as (select x.k, x.i from unnest(p_kinds, p_ids) x(k, i))
    select 'BATCH'::text, c.batch_id, 'LOT'::text, c.lot_id, 'CONSUMED'::text
      from f join site.lot_consumption c on f.k = 'BATCH' and c.batch_id = f.i where c.consumed_at <= p_as_of
    union all
    select 'LOT', r.lot_id, 'LOT', r.original_lot_id, 'RETURNED'
      from f join site.returned_goods r on f.k = 'LOT' and r.lot_id = f.i where r.received_at <= p_as_of
    union all
    select 'LOT', x.recovered_lot_id, 'LOT', x.returned_lot_id, 'RECOVERED'
      from f join site.chemical_recovery x on f.k = 'LOT' and x.recovered_lot_id = f.i where x.recorded_at <= p_as_of
    union all
    select 'SHIPMENT', s.id, 'LOT', s.lot_id, 'SHIPPED'
      from f join site.erp_shipment s on f.k = 'SHIPMENT' and s.id = f.i where s.recorded_at <= p_as_of
    union all
    select 'TRANSFER', p.id, 'LOT', p.lot_id, 'TRANSFERRED'
      from f join site.transfer_package p on f.k = 'TRANSFER' and p.id = f.i join site.transfer_package_seal ps on ps.package_id = p.id where ps.sealed_at <= p_as_of
    union all
    select 'LOT', r.lot_id, 'TRANSFER', r.package_id, 'TRANSFER_RECEIVED'
      from f join site.transfer_receipt r on f.k = 'LOT' and r.lot_id = f.i where r.received_at <= p_as_of
    union all
    select 'CONTAINER', o.id, 'BATCH', o.batch_id, 'OUTPUT'
      from f join plant.output_container o on f.k = 'CONTAINER' and o.id = f.i where o.opened_at <= p_as_of
    union all
    select 'BATCH', p.child_batch_id, 'BATCH', p.parent_batch_id, 'REPROCESSED'
      from f join recipe.batch_parent_link p on f.k = 'BATCH' and p.child_batch_id = f.i where p.recorded_at <= p_as_of
    union all
    select 'BATCH', a.batch_id, 'BATCH', a.source_batch_id, case a.case_code when 'RECOVERY' then 'RECOVERY_ADDITION' else 'REPROCESSING_ADDITION' end
      from f join recipe.source_addition a on f.k = 'BATCH' and a.batch_id = f.i where a.recorded_at <= p_as_of
    union all
    select 'BATCH', l.batch_id, 'BATCH', pl.batch_id, 'PACKAGING_ORDER'
      from f join recipe.batch_allocation_link l on f.k = 'BATCH' and l.batch_id = f.i
      join site.batch_number_allocation na on na.id = l.allocation_id
      join recipe.batch_allocation_link pl on pl.allocation_id = na.parent_allocation_id
     where l.recorded_at <= p_as_of
    union all
    select 'LOT', fl.lot_id, 'BATCH', fl.batch_id, 'FINISHED'
      from f join site.finished_lot fl on f.k = 'LOT' and fl.lot_id = f.i where fl.posted_at <= p_as_of
    union all
    select 'LOT', il.lot_id, 'BATCH', il.batch_id, 'OUTPUT'
      from f join site.intermediate_lot il on f.k = 'LOT' and il.lot_id = f.i where il.posted_at <= p_as_of
    union all
    select 'CONTAINER', m.target_id, 'CONTAINER', m.source_id, 'MERGED'
      from f join plant.container_merge m on f.k = 'CONTAINER' and m.target_id = f.i where m.recorded_at <= p_as_of
    union all
    select 'BATCH', b.order_batch_id, 'CONTAINER', b.container_id, 'BULK_ISSUE'
      from f join recipe.packaging_bulk_issue b on f.k = 'BATCH' and b.order_batch_id = f.i where b.recorded_at <= p_as_of
    union all
    select 'BATCH', ch.batch_id, 'CONTAINER', ch.container_id, 'CHARGED'
      from f join plant.container_charge ch on f.k = 'BATCH' and ch.batch_id = f.i
      join plant.output_container o on o.id = ch.container_id
     where ch.purpose = 'CHARGE' and ch.batch_id <> o.batch_id and ch.recorded_at <= p_as_of;
  else
    raise exception using errcode = 'P0001', message = format('EBMR-GEN-001 %s is no genealogy direction (FORWARD or BACKWARD)', coalesce(p_direction, 'NULL'));
  end if;
end
$$;

reset role;
