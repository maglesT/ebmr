-- Recipe core: the genealogy service (Phase 6 slice 6d-0; controls PR-57, IN-07, IN-29; plan
-- docs/build-plan/phase-6/phase-6-plan.md "Slice 6d", defaults D-P6d-1 and D-P6d-0-1 to D-P6d-0-8 in
-- docs/build-plan/phase-6/slice-6d-0-interfaces.md).
--
-- Handbook: modules/recipe-core.md
--
-- No genealogy table (D-P6d-1): every edge is read from the insert-only row its business event wrote, in that event's
-- transaction (PR-57 integrity). The edges, upstream -> downstream, each with the database time of its row:
--
--   LOT       -> BATCH      CONSUMED               site.lot_consumption (consumed_at)
--   LOT       -> LOT        RETURNED               site.returned_goods: a finished lot -> its returned goods (received_at)
--   LOT       -> LOT        RECOVERED              site.chemical_recovery: returned goods -> the recovered material (recorded_at)
--   LOT       -> SHIPMENT   SHIPPED                site.erp_shipment, the distribution record (recorded_at)
--   BATCH     -> CONTAINER  OUTPUT                 plant.output_container (opened_at)
--   CONTAINER -> CONTAINER  MERGED                 plant.container_merge: source -> target (recorded_at)
--   CONTAINER -> BATCH      BULK_ISSUE             recipe.packaging_bulk_issue: a bulk container -> the packaging order (recorded_at)
--   CONTAINER -> BATCH      CHARGED                plant.container_charge CHARGE into another batch (recorded_at)
--   BATCH     -> BATCH      REPROCESSED            recipe.batch_parent_link: whole-batch reprocessing parent -> child (recorded_at)
--   BATCH     -> BATCH      REPROCESSING_ADDITION  recipe.source_addition, case REPROCESSING_ADDITION (recorded_at)
--   BATCH     -> BATCH      RECOVERY_ADDITION      recipe.source_addition, case RECOVERY (recorded_at)
--   BATCH     -> BATCH      PACKAGING_ORDER        the batch number register: processing batch -> its packaging orders
--                                                  (the order's recipe.batch_allocation_link.recorded_at)
--   BATCH     -> LOT        FINISHED               site.finished_lot (posted_at)
--
-- recipe.genealogy(kind, id, direction, as_of) returns setof (node_kind, node_id, parent_kind, parent_id, edge_kind,
-- depth): a breadth-first traversal FORWARD (downstream: where the material went) or BACKWARD (upstream: where it came
-- from), at any depth. Set semantics: the start node once (depth 0, no parent), then every distinct edge between the
-- nodes reached, once, as (node reached, the node it was reached from, the edge's kind, the node's depth = its fewest
-- steps from the start). "Parent" is the traversal's previous node (in BACKWARD the downstream end of the edge,
-- D-P6d-0-2). A node reached a second time (two parents, or a cycle back to a node already reached) adds its edge but
-- is never expanded again, so a cycle ends (cycle detection); more than 64 levels or 200 000 edges is refused
-- (EBMR-GEN-004, -005, the depth guard). The as-of point: only rows recorded at or before as_of (database time,
-- platform.enforce_db_time) are read, so a trace repeated later as of the same instant gives the same set (D-P6d-0-3);
-- NULL means now; a future instant is refused (EBMR-GEN-003).
--
-- Messages: EBMR-GEN-001 to EBMR-GEN-009.

set local role ebmr_owner;

-- The indexes the backward and forward steps need where the source tables have none yet.
create index if not exists container_charge_batch on plant.container_charge (batch_id);
create index if not exists batch_number_allocation_parent on site.batch_number_allocation (parent_allocation_id);
create index if not exists source_addition_batch on recipe.source_addition (batch_id);

-- One step: the edges from the frontier nodes (p_kinds[i], p_ids[i]) in the direction, recorded at or before p_as_of.
-- from_* is the frontier node, to_* the node reached.
create function recipe.genealogy_step(p_kinds text[], p_ids uuid[], p_direction text, p_as_of timestamptz)
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

-- Whether the node existed at p_as_of (a batch: issued or planned by then).
create function recipe.genealogy_node_exists(p_kind text, p_id uuid, p_as_of timestamptz) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, site, plant, pg_temp as $$
  select case p_kind
    when 'LOT' then exists (select 1 from site.material_lot l where l.id = p_id and l.received_at <= p_as_of)
    when 'BATCH' then exists (select 1 from recipe.batch_execution b where b.id = p_id and to_timestamp(b.issued_at_us::numeric / 1000000) <= p_as_of)
                      or exists (select 1 from recipe.batch_allocation_link l where l.batch_id = p_id and l.recorded_at <= p_as_of)
    when 'CONTAINER' then exists (select 1 from plant.output_container o where o.id = p_id and o.opened_at <= p_as_of)
    when 'SHIPMENT' then exists (select 1 from site.erp_shipment s where s.id = p_id and s.recorded_at <= p_as_of)
    else false
  end
$$;

create function recipe.genealogy(p_kind text, p_id uuid, p_direction text, p_as_of timestamptz)
returns table (node_kind text, node_id uuid, parent_kind text, parent_id uuid, edge_kind text, depth integer)
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, plant, pg_temp as $$
declare
  c_max_depth constant integer := 64;
  c_max_edges constant integer := 200000;
  v_as_of  timestamptz := coalesce(p_as_of, clock_timestamp());
  vk       text[];     -- visited nodes: kind, id, depth
  vi       uuid[];
  vd       integer[];
  fk       text[];     -- the frontier
  fi       uuid[];
  sk_from  text[];     -- the edges of one level
  si_from  uuid[];
  sk_to    text[];
  si_to    uuid[];
  s_edge   text[];
  s_depth  integer[];
  v_level  integer := 0;
  v_edges  integer := 0;
begin
  if p_kind is null or p_kind not in ('LOT', 'BATCH', 'CONTAINER', 'SHIPMENT') then
    raise exception using errcode = 'P0001', message = format('EBMR-GEN-002 %s is no genealogy node kind (LOT, BATCH, CONTAINER or SHIPMENT)', coalesce(p_kind, 'NULL'));
  end if;
  if p_direction is null or p_direction not in ('FORWARD', 'BACKWARD') then
    raise exception using errcode = 'P0001', message = format('EBMR-GEN-001 %s is no genealogy direction (FORWARD or BACKWARD)', coalesce(p_direction, 'NULL'));
  end if;
  if v_as_of > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'EBMR-GEN-003 the as-of point of a trace is now or in the past, never in the future (D-P6d-0-3)';
  end if;
  if p_id is null or not recipe.genealogy_node_exists(p_kind, p_id, v_as_of) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-GEN-002 there is no %s %s as of %s', lower(p_kind), coalesce(p_id::text, 'NULL'), to_char(v_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  end if;
  vk := array[p_kind]; vi := array[p_id]; vd := array[0];
  fk := vk; fi := vi;
  node_kind := p_kind; node_id := p_id; parent_kind := null; parent_id := null; edge_kind := null; depth := 0;
  return next;
  loop
    exit when cardinality(fk) = 0;
    if v_level >= c_max_depth then
      raise exception using errcode = 'P0001',
        message = format('EBMR-GEN-004 the genealogy of %s %s goes deeper than %s levels; the trace is refused rather than cut short (PR-57)', lower(p_kind), p_id, c_max_depth);
    end if;
    v_level := v_level + 1;
    -- The level's distinct edges, each with the depth of the node it reaches (its earlier depth when reached before).
    select coalesce(array_agg(s.from_kind order by s.to_kind, s.to_id, s.from_kind, s.from_id, s.edge_kind), '{}'),
           coalesce(array_agg(s.from_id order by s.to_kind, s.to_id, s.from_kind, s.from_id, s.edge_kind), '{}'),
           coalesce(array_agg(s.to_kind order by s.to_kind, s.to_id, s.from_kind, s.from_id, s.edge_kind), '{}'),
           coalesce(array_agg(s.to_id order by s.to_kind, s.to_id, s.from_kind, s.from_id, s.edge_kind), '{}'),
           coalesce(array_agg(s.edge_kind order by s.to_kind, s.to_id, s.from_kind, s.from_id, s.edge_kind), '{}'),
           coalesce(array_agg(coalesce(v.d, v_level) order by s.to_kind, s.to_id, s.from_kind, s.from_id, s.edge_kind), '{}')
      into sk_from, si_from, sk_to, si_to, s_edge, s_depth
      from (select distinct * from recipe.genealogy_step(fk, fi, p_direction, v_as_of)) s
      left join unnest(vk, vi, vd) v(k, i, d) on v.k = s.to_kind and v.i = s.to_id;
    v_edges := v_edges + cardinality(s_edge);
    if v_edges > c_max_edges then
      raise exception using errcode = 'P0001',
        message = format('EBMR-GEN-005 the genealogy of %s %s has more than %s edges; the trace is refused rather than cut short (PR-57)', lower(p_kind), p_id, c_max_edges);
    end if;
    return query select x.tk, x.ti, x.fk2, x.fi2, x.e, x.d from unnest(sk_to, si_to, sk_from, si_from, s_edge, s_depth) x(tk, ti, fk2, fi2, e, d);
    -- The next frontier: the nodes reached for the first time.
    select coalesce(array_agg(n.k order by n.k, n.i), '{}'), coalesce(array_agg(n.i order by n.k, n.i), '{}')
      into fk, fi
      from (select distinct x.k, x.i from unnest(sk_to, si_to) x(k, i)
             where not exists (select 1 from unnest(vk, vi) v(k, i) where v.k = x.k and v.i = x.i)) n;
    vk := vk || fk; vi := vi || fi; vd := vd || array_fill(v_level, array[cardinality(fk)]);
  end loop;
end
$$;

revoke all on function recipe.genealogy_step(text[], uuid[], text, timestamptz), recipe.genealogy_node_exists(text, uuid, timestamptz),
  recipe.genealogy(text, uuid, text, timestamptz) from public;
grant execute on function recipe.genealogy(text, uuid, text, timestamptz), recipe.genealogy_node_exists(text, uuid, timestamptz) to ebmr_app;

reset role;
