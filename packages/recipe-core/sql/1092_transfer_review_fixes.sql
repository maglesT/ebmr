-- Recipe core: review fixes of slice 6i (Phase 6 slice 6i quick review; controls IN-29, PR-57; D-P6i-0-7, D-P6i-0-9).
--
-- Handbook: modules/recipe-core.md
--
--   6i-R1 recipe.mock_recall_federation (1091) called a run complete when every destination ANSWERED, even when a
--         destination's excerpt reached a further transfer (to a third site or back to this one) that nobody asked: a
--         silently partial result. Re-created: `beyond_one_hop` lists every TRANSFER node of a shown excerpt other than
--         the transfer asked, and the run is complete only when every destination ANSWERED and that list is empty.
--   6i-R2 recipe.answer_federated_genealogy (1090) refused any as-of point after this database's clock, so the asking
--         site's "now" was refused whenever its clock ran a little ahead. Re-created: up to 2 seconds ahead, the answer
--         waits until this clock has passed the instant (so it is still as of a past instant here); further ahead is
--         refused as before (EBMR-FED-012). Nothing else changes.

set local role ebmr_owner;

create or replace function recipe.mock_recall_federation(p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
  with m as (select * from recipe.mock_recall where id = p_id),
  t as (select (e ->> 'transfer_id')::uuid as transfer_id, e ->> 'package_no' as package_no, e ->> 'destination' as destination, (e ->> 'depth')::integer as depth
          from m, jsonb_array_elements(coalesce(m.result -> 'transfers', '[]'::jsonb)) e),
  best as (
    select t.*, x.status, x.excerpt_id, x.detail, x.recorded_at, fe.as_of as excerpt_as_of, fe.payload as excerpt_payload
      from t left join lateral (
        select r.* from recipe.mock_recall_remote r where r.mock_recall_id = p_id and r.transfer_id = t.transfer_id
         order by (r.status = 'ANSWERED') desc, r.recorded_at desc, r.id desc limit 1) x on true
      left join recipe.federated_excerpt fe on fe.id = x.excerpt_id),
  beyond as (
    select distinct (n ->> 'id')::uuid as transfer_id, n ->> 'label' as package_no,
           case n ->> 'sub_kind' when 'OUTBOUND' then n ->> 'name' else n ->> 'code' end as destination, b.transfer_id as via
      from best b, jsonb_array_elements(coalesce(b.excerpt_payload::jsonb -> 'nodes', '[]'::jsonb)) n
     where n ->> 'kind' = 'TRANSFER' and (n ->> 'id') is distinct from b.transfer_id::text
       and not exists (select 1 from t where t.transfer_id::text = n ->> 'id'))
  select jsonb_build_object(
    'complete', not exists (select 1 from best where best.status is distinct from 'ANSWERED') and not exists (select 1 from beyond),
    'beyond_one_hop', coalesce((select jsonb_agg(jsonb_build_object('transfer_id', y.transfer_id, 'package_no', y.package_no, 'destination', y.destination, 'via', y.via)
                                                order by y.package_no, y.transfer_id) from beyond y), '[]'),
    'transfers', coalesce((select jsonb_agg(jsonb_build_object('transfer_id', b.transfer_id, 'package_no', b.package_no, 'destination', b.destination,
                                                               'depth', b.depth, 'status', coalesce(b.status, 'NOT_ASKED'), 'excerpt_id', b.excerpt_id,
                                                               'excerpt_as_of_us', platform.timestamptz_to_epoch_us(b.excerpt_as_of), 'detail', b.detail)
                                            order by b.depth, b.package_no, b.transfer_id) from best b), '[]'))
$$;

create or replace function recipe.answer_federated_genealogy(p_request text, p_seal text) returns jsonb
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
  -- Two clocks are never equal: an as-of point up to 2 seconds ahead of this database's clock is answered once this
  -- clock has passed it (review 6i-R2), so the answer is still as of an instant in the past here; further ahead is refused.
  if v_as_of > clock_timestamp() + interval '2 seconds' then
    return platform.refuse_federation_query(v_rid, 'EBMR-FED-012 the as-of point is in the future at the answering site (D-P6i-0-9)');
  end if;
  if v_as_of > clock_timestamp() then
    perform pg_sleep(extract(epoch from (v_as_of - clock_timestamp())) + 0.001);
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

reset role;
