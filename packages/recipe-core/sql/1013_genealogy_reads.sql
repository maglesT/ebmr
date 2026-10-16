-- Recipe core: the reads behind the genealogy explorer, the complaint lookup and the API supply-chain report (Phase 6
-- slice 6d; controls PR-57, IN-07; contract ns/genealogy.ts).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.genealogy_node_views(kinds, ids) jsonb   what the explorer shows of each node: LOT the lot number, material code
--       and name, material kind and lot state; BATCH the batch number, product code and name, PROCESSING or PACKAGING and
--       the record's state; CONTAINER the label, product, stage and state; SHIPMENT the shipment number, the product
--       name, market and consignee code.
--   recipe.genealogy_lookup(code) uuid   the lot a complaint names: a lot number, the batch number of a finished lot, or a
--       shipment number; NULL when nothing matches.
--   recipe.genealogy_lot_deviations(lot) jsonb   the deviations of the lot's records (recipe.release_deviations), with state.
--   recipe.genealogy_supply_chain(lot, as_of) jsonb   every purchased lot (API first) and every recovered lot upstream of a
--       lot, with supplier, supplier batch and manufacturer from its receipt record and the batches that consumed it.
-- Reads only; granted to the application role (D-P6d-0-8).

set local role ebmr_owner;

create function recipe.genealogy_node_views(p_kinds text[], p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, plant, platform, pg_temp as $$
  select coalesce(jsonb_agg(v order by v ->> 'kind', v ->> 'label', v ->> 'id'), '[]') from (
    select jsonb_build_object('kind', 'LOT', 'id', l.id, 'label', l.lot_code, 'code', l.material_code, 'name', l.material_name, 'sub_kind', l.material_kind,
                              'state', (select s.state from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = l.id)) as v
      from unnest(p_kinds, p_ids) n(k, i) join site.material_lot l on n.k = 'LOT' and l.id = n.i
    union all
    select jsonb_build_object('kind', 'BATCH', 'id', n.i, 'label', coalesce(recipe.genealogy_batch_number(n.i), n.i::text),
                              'code', recipe.batch_product(n.i) ->> 'code', 'name', recipe.batch_product(n.i) ->> 'name',
                              'sub_kind', (select a.batch_kind from recipe.batch_allocation_link bl join site.batch_number_allocation a on a.id = bl.allocation_id where bl.batch_id = n.i),
                              'state', (select s.state from platform.aggregate_state s where s.aggregate_type = 'batch' and s.aggregate_id = n.i))
      from unnest(p_kinds, p_ids) n(k, i) where n.k = 'BATCH'
    union all
    select jsonb_build_object('kind', 'CONTAINER', 'id', o.id, 'label', o.label_code, 'code', o.product_code, 'name', null, 'sub_kind', o.stage,
                              'state', (select s.state from platform.aggregate_state s where s.aggregate_type = 'output_container' and s.aggregate_id = o.id))
      from unnest(p_kinds, p_ids) n(k, i) join plant.output_container o on n.k = 'CONTAINER' and o.id = n.i
    union all
    select jsonb_build_object('kind', 'SHIPMENT', 'id', s.id, 'label', s.shipment_no, 'code', l.material_code, 'name', coalesce(s.product_name, l.material_name),
                              'sub_kind', s.market, 'state', s.consignee_code)
      from unnest(p_kinds, p_ids) n(k, i) join site.erp_shipment s on n.k = 'SHIPMENT' and s.id = n.i join site.material_lot l on l.id = s.lot_id) x
$$;

create function recipe.genealogy_lookup(p_code text) returns uuid
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(
    (select l.id from site.material_lot l where l.lot_code = upper(btrim(p_code)) order by l.received_at limit 1),
    (select f.lot_id from site.finished_lot f where f.batch_number = upper(btrim(p_code)) order by f.posted_at limit 1),
    (select s.lot_id from site.erp_shipment s where s.shipment_no = upper(btrim(p_code))))
$$;

create function recipe.genealogy_lot_deviations(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('deviation_id', d.id, 'ref', d.ref, 'kind', d.kind, 'title', d.title, 'classification', d.classification,
                                               'state', site.deviation_state(d.id)) order by d.ref), '[]')
    from site.deviation d where d.id = any (recipe.release_deviations(p_lot))
$$;

create function recipe.genealogy_supply_chain(p_lot uuid, p_as_of timestamptz) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with g as materialized (select * from recipe.genealogy('LOT', p_lot, 'BACKWARD', p_as_of)),
  lots as (
    select g.node_id as lot_id, min(g.depth) as depth from g join site.material_lot l on l.id = g.node_id
     where g.node_kind = 'LOT' and g.depth > 0
       and (site.lot_is_purchased(l.material_kind) or exists (select 1 from site.chemical_recovery x where x.recovered_lot_id = l.id))
     group by g.node_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'lot_id', l.id, 'depth', x.depth, 'supplier', coalesce(r ->> 'supplierCode', l.supplier), 'supplier_lot', coalesce(r ->> 'supplierLot', l.supplier_lot),
           'manufacturer_code', r ->> 'manufacturerCode',
           'consumed_by', coalesce((select jsonb_agg(distinct recipe.genealogy_batch_number(g.parent_id)) from g
                                     where g.node_id = l.id and g.edge_kind = 'CONSUMED' and g.parent_kind = 'BATCH'), '[]'))
         order by (l.material_kind <> 'API'), l.lot_code), '[]')
    from lots x join site.material_lot l on l.id = x.lot_id left join lateral (select site.lot_receipt_effective(l.id) as r) rr on true
$$;

revoke all on function recipe.genealogy_node_views(text[], uuid[]), recipe.genealogy_lookup(text), recipe.genealogy_lot_deviations(uuid),
  recipe.genealogy_supply_chain(uuid, timestamptz) from public;
grant execute on function recipe.genealogy_node_views(text[], uuid[]), recipe.genealogy_lookup(text), recipe.genealogy_lot_deviations(uuid),
  recipe.genealogy_supply_chain(uuid, timestamptz) to ebmr_app;

reset role;
