-- Recipe core: the genealogy across sites, and the two sides of a federated genealogy query (Phase 6 slice 6i; outline
-- L-41; controls PR-57, DI-31; defaults D-P6i-0-7 and D-P6i-0-9 in docs/build-plan/phase-6/slice-6i-0-interfaces.md;
-- kernel 1220, site services 0980, 0981).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.genealogy_step, recipe.genealogy_node_exists, recipe.genealogy: CREATE OR REPLACE from 1010 with the node kind
--       TRANSFER (a lot-transfer package; its id is the same node at both sites) and two edges:
--         LOT      -> TRANSFER  TRANSFERRED        site.transfer_package with its seal (sealed_at): the lot left in it
--         TRANSFER -> LOT       TRANSFER_RECEIVED  site.transfer_receipt (received_at): the local QUARANTINE lot it became
--       Nothing else changes.
--   recipe.genealogy_node_views: CREATE OR REPLACE from 1013 with TRANSFER: label the package number, code the origin
--       installation, name the destination installation, sub-kind OUTBOUND or INBOUND, state SEALED (outbound) or the
--       receipt's RECEIVED, ACCEPTED or REFUSED (inbound).
--   The answering side: recipe.answer_federated_genealogy(request, seal) jsonb, granted to the application role without a
--       session (the request's seal under a trusted peer's key is the authentication; platform.accept_federation_request,
--       kernel 1220). Only from a TRANSFER node exchanged with the requesting installation (D-P6i-0-7), as of the instant
--       asked (never in the future here). Answers {ok: true, payload} (format ebmr.genealogy-excerpt.v1: the request's
--       nonce, from, to, the query, asOfUs, rows and node views; the server seals it) or {ok: false, reason}.
--   The asking side: recipe.issue_federated_request(peer, transfer, direction, as_of) jsonb {nonce, request} (the server
--       seals the request); recipe.record_federated_excerpt(nonce, payload, seal) jsonb keeps an answer only when its seal
--       verifies under the peer's key and it answers exactly the request issued; anything else is WRONG_ANSWER with an
--       alarm; recipe.record_federation_failure(nonce, status, detail) logs UNREACHABLE or REFUSED with an alarm.
--       recipe.last_federated_excerpt(peer, transfer, direction) is the last excerpt received, whatever its as-of.
--       The logs are insert-only (transport facts; the person asking is recorded when there is one).
--
-- Messages: EBMR-FED-010 to EBMR-FED-019.

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

create or replace function recipe.genealogy_node_exists(p_kind text, p_id uuid, p_as_of timestamptz) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, site, plant, pg_temp as $$
  select case p_kind
    when 'LOT' then exists (select 1 from site.material_lot l where l.id = p_id and l.received_at <= p_as_of)
    when 'BATCH' then exists (select 1 from recipe.batch_execution b where b.id = p_id and to_timestamp(b.issued_at_us::numeric / 1000000) <= p_as_of)
                      or exists (select 1 from recipe.batch_allocation_link l where l.batch_id = p_id and l.recorded_at <= p_as_of)
    when 'CONTAINER' then exists (select 1 from plant.output_container o where o.id = p_id and o.opened_at <= p_as_of)
    when 'SHIPMENT' then exists (select 1 from site.erp_shipment s where s.id = p_id and s.recorded_at <= p_as_of)
    when 'TRANSFER' then exists (select 1 from site.transfer_package p join site.transfer_package_seal ps on ps.package_id = p.id where p.id = p_id and ps.sealed_at <= p_as_of)
                         or exists (select 1 from site.transfer_receipt r where r.package_id = p_id and r.received_at <= p_as_of)
    else false
  end
$$;

create or replace function recipe.genealogy(p_kind text, p_id uuid, p_direction text, p_as_of timestamptz)
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
  if p_kind is null or p_kind not in ('LOT', 'BATCH', 'CONTAINER', 'SHIPMENT', 'TRANSFER') then
    raise exception using errcode = 'P0001', message = format('EBMR-GEN-002 %s is no genealogy node kind (LOT, BATCH, CONTAINER, SHIPMENT or TRANSFER)', coalesce(p_kind, 'NULL'));
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
    if v_level > c_max_depth and cardinality(s_edge) > 0 then
      raise exception using errcode = 'P0001',
        message = format('EBMR-GEN-004 the genealogy of %s %s goes deeper than %s levels; the trace is refused rather than cut short (PR-57)', lower(p_kind), p_id, c_max_depth);
    end if;
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

create or replace function recipe.genealogy_node_views(p_kinds text[], p_ids uuid[]) returns jsonb
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
      from unnest(p_kinds, p_ids) n(k, i) join site.erp_shipment s on n.k = 'SHIPMENT' and s.id = n.i join site.material_lot l on l.id = s.lot_id
    union all
    -- TRANSFER (1090): the package number, the origin and destination installations, OUTBOUND (sealed here) or INBOUND
    -- (received here), and its state here.
    select jsonb_build_object('kind', 'TRANSFER', 'id', p.id, 'label', p.package_no, 'code', p.origin_installation, 'name', p.destination_installation,
                              'sub_kind', 'OUTBOUND', 'state', case when exists (select 1 from site.transfer_package_seal ps where ps.package_id = p.id) then 'SEALED' else 'PREPARED' end)
      from unnest(p_kinds, p_ids) n(k, i) join site.transfer_package p on n.k = 'TRANSFER' and p.id = n.i
    union all
    select jsonb_build_object('kind', 'TRANSFER', 'id', r.package_id, 'label', r.package_no, 'code', r.origin_installation,
                              'name', (platform.current_installation()).installation_code, 'sub_kind', 'INBOUND', 'state', site.transfer_receipt_state(r.id))
      from unnest(p_kinds, p_ids) n(k, i) join site.transfer_receipt r on n.k = 'TRANSFER' and r.package_id = n.i) x
$$;

-- ---------------------------------------------------------------------------------------------
-- The answering side
-- ---------------------------------------------------------------------------------------------

create function recipe.answer_federated_genealogy(p_request text, p_seal text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, platform, pg_temp as $$
declare
  v       jsonb := platform.accept_federation_request(p_request, p_seal);
  m       jsonb;
  q       jsonb;
  v_rid   uuid;
  v_from  text;
  v_tr    uuid;
  v_as_of timestamptz;
  v_rows  jsonb;
  v_nodes jsonb;
begin
  if not coalesce((v ->> 'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', v ->> 'reason');
  end if;
  m := v -> 'request'; q := m -> 'query'; v_rid := (v ->> 'requestId')::uuid; v_from := m ->> 'from';
  if coalesce(q ->> 'transferId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(q ->> 'direction', '') not in ('FORWARD', 'BACKWARD') or coalesce(q ->> 'asOfUs', '') !~ '^(0|[1-9][0-9]{0,15})$' then
    return platform.refuse_federation_query(v_rid, 'EBMR-FED-010 a genealogy query names the transfer, the direction (FORWARD or BACKWARD) and the as-of point (epoch microseconds)');
  end if;
  v_tr := (q ->> 'transferId')::uuid;
  if not exists (select 1 from site.transfer_package p join site.transfer_package_seal ps on ps.package_id = p.id where p.id = v_tr and p.destination_installation = v_from)
     and not exists (select 1 from site.transfer_receipt r where r.package_id = v_tr and r.origin_installation = v_from) then
    return platform.refuse_federation_query(v_rid,
      format('EBMR-FED-011 transfer %s was not exchanged with installation %s; a site answers only about the transfers it shared with the asking site (D-P6i-0-7)', v_tr, v_from));
  end if;
  v_as_of := site.us_instant(q ->> 'asOfUs');
  if v_as_of > clock_timestamp() then
    return platform.refuse_federation_query(v_rid, 'EBMR-FED-012 the as-of point is in the future at the answering site (D-P6i-0-9)');
  end if;
  begin
    select coalesce(jsonb_agg(jsonb_build_object('nodeKind', g.node_kind, 'nodeId', g.node_id, 'parentKind', g.parent_kind, 'parentId', g.parent_id,
                                                 'edgeKind', g.edge_kind, 'depth', g.depth)
                              order by g.depth, g.node_kind, g.node_id, g.parent_kind, g.parent_id, g.edge_kind), '[]')
      into v_rows from recipe.genealogy('TRANSFER', v_tr, q ->> 'direction', v_as_of) g;
    select recipe.genealogy_node_views(array_agg(g.node_kind), array_agg(g.node_id)) into v_nodes
      from (select distinct g.node_kind, g.node_id from recipe.genealogy('TRANSFER', v_tr, q ->> 'direction', v_as_of) g) g;
  exception when others then
    return platform.refuse_federation_query(v_rid, 'EBMR-FED-013 ' || sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'payload', jsonb_build_object(
    'format', 'ebmr.genealogy-excerpt.v1', 'requestNonce', m ->> 'nonce', 'from', (platform.current_installation()).installation_code, 'to', v_from,
    'query', q, 'asOfUs', q ->> 'asOfUs', 'answeredAtUs', site.us_text(clock_timestamp()), 'rows', v_rows, 'nodes', coalesce(v_nodes, '[]'::jsonb))::text);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The asking side
-- ---------------------------------------------------------------------------------------------

create table recipe.federated_request_out (
  nonce        uuid primary key,
  peer_code    text not null,
  transfer_id  uuid not null,
  direction    text not null check (direction in ('FORWARD', 'BACKWARD')),
  as_of        timestamptz not null,
  request      text not null,
  person_id    uuid,
  issued_at    timestamptz not null default clock_timestamp()
);
create table recipe.federated_excerpt (
  id              uuid primary key default gen_random_uuid(),
  nonce           uuid not null unique references recipe.federated_request_out (nonce),
  peer_code       text not null,
  transfer_id     uuid not null,
  direction       text not null check (direction in ('FORWARD', 'BACKWARD')),
  as_of           timestamptz not null,
  payload         text not null,
  payload_sha256  text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  seal            text not null check (seal ~ '^[A-Za-z0-9+/]{85}[AQgw]==$'),
  received_at     timestamptz not null default clock_timestamp()
);
create index federated_excerpt_last on recipe.federated_excerpt (peer_code, transfer_id, direction, received_at desc);
create table recipe.federated_request_failure (
  id           uuid primary key default gen_random_uuid(),
  nonce        uuid not null references recipe.federated_request_out (nonce),
  status       text not null check (status in ('UNREACHABLE', 'REFUSED', 'WRONG_ANSWER')),
  detail       text not null check (btrim(detail) <> ''),
  alarm_id     uuid not null references platform.installation_alarm (id),
  recorded_at  timestamptz not null default clock_timestamp()
);
revoke all on recipe.federated_request_out, recipe.federated_excerpt, recipe.federated_request_failure from public;
grant select on recipe.federated_request_out, recipe.federated_excerpt, recipe.federated_request_failure to ebmr_app;
select platform.make_insert_only('recipe.federated_request_out');
select platform.make_insert_only('recipe.federated_excerpt');
select platform.make_insert_only('recipe.federated_request_failure');
select platform.enforce_db_time('recipe.federated_request_out', array['issued_at']);
select platform.enforce_db_time('recipe.federated_excerpt', array['received_at']);
select platform.enforce_db_time('recipe.federated_request_failure', array['recorded_at']);

create function recipe.issue_federated_request(p_peer text, p_transfer uuid, p_direction text, p_as_of timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, platform, kernel, pg_temp as $$
declare
  me      platform.installation_identity := platform.current_installation();
  v_nonce uuid := gen_random_uuid();
  v_as_of timestamptz := coalesce(p_as_of, clock_timestamp());
  v_req   text;
begin
  if me.version is null then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-014 this installation has no identity yet; it asks no other site (L-41)';
  end if;
  if (platform.trusted_peer(p_peer)).id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-FED-014 installation %s is not a trusted peer of this site', coalesce(p_peer, 'NULL'));
  end if;
  if p_direction is null or p_direction not in ('FORWARD', 'BACKWARD') then
    raise exception using errcode = 'P0001', message = format('EBMR-GEN-001 %s is no genealogy direction (FORWARD or BACKWARD)', coalesce(p_direction, 'NULL'));
  end if;
  if v_as_of > clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'EBMR-GEN-003 the as-of point of a trace is now or in the past, never in the future (D-P6d-0-3)';
  end if;
  if not exists (select 1 from site.transfer_package p where p.id = p_transfer and p.destination_installation = p_peer)
     and not exists (select 1 from site.transfer_receipt r where r.package_id = p_transfer and r.origin_installation = p_peer) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-FED-011 transfer %s was not exchanged with installation %s (D-P6i-0-7)', coalesce(p_transfer::text, 'NULL'), coalesce(p_peer, 'NULL'));
  end if;
  v_req := jsonb_build_object('format', 'ebmr.federation-request.v1', 'nonce', v_nonce, 'from', me.installation_code, 'to', p_peer,
                              'issuedAtUs', site.us_text(clock_timestamp()),
                              'query', jsonb_build_object('transferId', p_transfer, 'direction', p_direction, 'asOfUs', site.us_text(v_as_of)))::text;
  insert into recipe.federated_request_out (nonce, peer_code, transfer_id, direction, as_of, request, person_id)
  values (v_nonce, p_peer, p_transfer, p_direction, v_as_of, v_req, (kernel.current_actor() ->> 'person_id')::uuid);
  return jsonb_build_object('nonce', v_nonce, 'request', v_req, 'baseUrl', (platform.trusted_peer(p_peer)).base_url, 'asOfUs', site.us_text(v_as_of));
end
$$;

create function recipe.record_federation_failure(p_nonce uuid, p_status text, p_detail text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
declare
  o       recipe.federated_request_out;
  v_alarm uuid;
begin
  select * into o from recipe.federated_request_out where nonce = p_nonce;
  if o.nonce is null then
    raise exception using errcode = 'P0001', message = format('EBMR-FED-015 no federation request %s was issued here', coalesce(p_nonce::text, 'NULL'));
  end if;
  if p_status is null or p_status not in ('UNREACHABLE', 'REFUSED', 'WRONG_ANSWER') then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-015 a failed federation request is UNREACHABLE, REFUSED or WRONG_ANSWER';
  end if;
  v_alarm := platform.raise_installation_alarm(case p_status when 'UNREACHABLE' then 'UNREACHABLE' else 'WRONG_ANSWER' end,
                                               case p_status when 'WRONG_ANSWER' then 'MAJOR' else 'MINOR' end, 'FEDERATION_QUERY', o.peer_code,
                                               jsonb_build_object('nonce', o.nonce, 'transferId', o.transfer_id, 'status', p_status, 'detail', left(coalesce(p_detail, ''), 1000)));
  insert into recipe.federated_request_failure (nonce, status, detail, alarm_id)
  values (o.nonce, p_status, left(coalesce(nullif(btrim(p_detail), ''), p_status), 2000), v_alarm);
  return v_alarm;
end
$$;

-- {ok: true, excerptId} or {ok: false, reason, alarmId}: never raises for a bad answer, so the WRONG_ANSWER and its alarm commit.
create function recipe.record_federated_excerpt(p_nonce uuid, p_payload text, p_seal text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
declare
  o       recipe.federated_request_out;
  m       jsonb;
  v_why   text;
  v_id    uuid;
begin
  select * into o from recipe.federated_request_out where nonce = p_nonce for update;
  if o.nonce is null then
    raise exception using errcode = 'P0001', message = format('EBMR-FED-015 no federation request %s was issued here', coalesce(p_nonce::text, 'NULL'));
  end if;
  if exists (select 1 from recipe.federated_excerpt e where e.nonce = o.nonce) then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-016 this request was answered already';
  end if;
  begin
    m := p_payload::jsonb;
  exception when others then
    m := null;
  end;
  if not platform.peer_seal_valid(o.peer_code, 'federation-answer', p_payload, p_seal) then
    v_why := format('EBMR-FED-017 the answer''s seal does not verify under the key of installation %s', o.peer_code);
  elsif jsonb_typeof(m) is distinct from 'object' or m ->> 'format' is distinct from 'ebmr.genealogy-excerpt.v1'
        or jsonb_typeof(m -> 'rows') is distinct from 'array' or jsonb_typeof(m -> 'nodes') is distinct from 'array' then
    v_why := 'EBMR-FED-018 the answer is not a genealogy excerpt (format ebmr.genealogy-excerpt.v1 with rows and nodes)';
  elsif m ->> 'from' is distinct from o.peer_code or m ->> 'to' is distinct from (platform.current_installation()).installation_code
        or m ->> 'requestNonce' is distinct from o.nonce::text or m -> 'query' ->> 'transferId' is distinct from o.transfer_id::text
        or m -> 'query' ->> 'direction' is distinct from o.direction or m ->> 'asOfUs' is distinct from site.us_text(o.as_of) then
    v_why := 'EBMR-FED-019 the answer does not answer the request issued (installations, nonce, transfer, direction or as-of differ)';
  end if;
  if v_why is not null then
    return jsonb_build_object('ok', false, 'reason', v_why, 'alarmId', recipe.record_federation_failure(o.nonce, 'WRONG_ANSWER', v_why));
  end if;
  insert into recipe.federated_excerpt (nonce, peer_code, transfer_id, direction, as_of, payload, payload_sha256, seal)
  values (o.nonce, o.peer_code, o.transfer_id, o.direction, o.as_of, p_payload, encode(sha256(convert_to(p_payload, 'UTF8')), 'hex'), p_seal)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'excerptId', v_id);
end
$$;

create function recipe.last_federated_excerpt(p_peer text, p_transfer uuid, p_direction text) returns recipe.federated_excerpt
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select * from recipe.federated_excerpt e where e.peer_code = p_peer and e.transfer_id = p_transfer and e.direction = p_direction
   order by e.received_at desc, e.id desc limit 1
$$;

revoke all on function recipe.answer_federated_genealogy(text, text), recipe.issue_federated_request(text, uuid, text, timestamptz),
  recipe.record_federation_failure(uuid, text, text), recipe.record_federated_excerpt(uuid, text, text), recipe.last_federated_excerpt(text, uuid, text) from public;
grant execute on function recipe.answer_federated_genealogy(text, text), recipe.issue_federated_request(text, uuid, text, timestamptz),
  recipe.record_federation_failure(uuid, text, text), recipe.record_federated_excerpt(uuid, text, text), recipe.last_federated_excerpt(text, uuid, text) to ebmr_app;

reset role;
