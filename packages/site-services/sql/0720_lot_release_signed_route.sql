-- Material lots: the release signature covers the release route and the lot's current quantity (Phase 3 slice 1 quick
-- review, backlog item 6; outline 5.2.9; controls IN-24 (a)(c), DI-37, INV-09).
--
-- 0710's signed content (site.material_lot_content) showed the receipt, identity results, destruction and states, but
-- neither the route a RELEASE records nor the quantity the lot holds now, so MATERIAL_LOT_RELEASED ("the release route I
-- record applies") was given over content that did not name the route. A signature is bound to the content hash only,
-- with no place for command arguments, so the route has to be in the content before the signing:
--
--   * site.lot_signed_release_route(lot): the route the lot's content shows. Before release it follows from the
--     record (default taken, the stricter one): IDENTITY_TESTED when a passing identity result is recorded, otherwise
--     VENDOR_HISTORY for an excipient, otherwise none. Once the lot was released it is the route its RELEASE recorded.
--     So a lot with a passing identity result is released on the identity-tested route only (it then serves every
--     market); the vendor-history route serves excipient lots without an identity test, as IN-24 (c) intends.
--   * the guard material_lot.release_route_satisfied (CREATE OR REPLACE, 0710's checks unchanged and first) also
--     refuses a RELEASE whose route is not the one the signed content shows (EBMR-SITE-112). The engine accepts the
--     signature only while its content hash is the lot's current one, so the route recorded is the route signed. An
--     identity result recorded after the signing changes the content (and the route shown) and supersedes the
--     signature (a registered signed table, INV-09).
--   * the content also shows the lot's current quantity (received minus consumed), and site.lot_consumption becomes a
--     registered signed table of the lot (each consumption supersedes the lot's earlier signatures and counts in the
--     content version), so no signature stays valid over a quantity the lot no longer has. The consuming person is
--     thereby a performer of the lot's content: they cannot witness its destruction (stricter; noted for the owner).
--
-- Existing signatures. Replacing the provider changes the canonical content (and hash) of every lot, so a signature
-- given over 0710's content would read CONTENT_MISMATCH and the integrity job would report INV-09. At the end of this
-- migration every lot that has a signature not yet superseded is passed through esig.content_changed, the path every
-- signed-table change takes: each such signature is recorded as SUPERSEDED_BY_CHANGE with its previous hash (so
-- esig.signature_problems still verifies it against the content it covered), audited, and must be given again over the
-- new content. Signatures already superseded are untouched (they are checked against their recorded previous hash).

set local role ebmr_owner;

create function site.lot_signed_release_route(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
           when exists (select 1 from site.lot_state_entry e where e.lot_id = l.id and e.state = 'RELEASED') then site.lot_release_route(l.id)
           when exists (select 1 from site.lot_identity_result r where r.lot_id = l.id and r.result = 'PASS') then 'IDENTITY_TESTED'
           when l.material_kind = 'EXCIPIENT' then 'VENDOR_HISTORY'
         end
  from site.material_lot l where l.id = p_lot
$$;

-- 0710's provider plus 'release_route' and 'current_quantity'; consumptions count in the content version.
create or replace function site.material_lot_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  l site.material_lot;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into l from site.material_lot where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from site.lot_identity_result r where r.lot_id = l.id)
                         + (select count(*) from site.lot_destruction d where d.lot_id = l.id)
                         + (select count(*) from site.lot_state_entry e where e.lot_id = l.id)
                         + (select count(*) from site.lot_consumption c where c.lot_id = l.id),
    'content', jsonb_build_object(
      'lot_code', l.lot_code, 'site_code', l.site_code, 'material_code', l.material_code, 'material_name', l.material_name,
      'material_kind', l.material_kind, 'supplier', l.supplier, 'supplier_lot', l.supplier_lot,
      'received_quantity', l.received_quantity::text, 'unit', l.unit, 'retest_at', site.utc_text(l.retest_at),
      'expires_at', site.utc_text(l.expires_at), 'received_by', l.received_by_person,
      'current_quantity', site.lot_quantity(l.id)::text,
      'release_route', site.lot_signed_release_route(l.id),
      'identity_results', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'result', r.result, 'method_reference', r.method_reference,
                                                                        'test_reference', r.test_reference, 'recorded_by', r.recorded_by_person,
                                                                        'recorded_at', site.utc_text(r.recorded_at))
                                                     order by r.recorded_at, r.id), '[]'::jsonb)
                           from site.lot_identity_result r where r.lot_id = l.id),
      'destruction', (select jsonb_build_object('id', d.id, 'method', d.method, 'reason', d.reason, 'quantity', d.quantity::text, 'unit', d.unit,
                                                'performed_by', d.performed_by_person, 'recorded_at', site.utc_text(d.recorded_at))
                      from site.lot_destruction d where d.lot_id = l.id),
      'state_entries', (select coalesce(jsonb_agg(jsonb_build_object('state', e.state, 'state_version', e.state_version::text)
                                                  order by e.state_version), '[]'::jsonb)
                        from site.lot_state_entry e where e.lot_id = l.id)),
    'state', site.lot_state(l.id),
    'scope', jsonb_build_object('site', l.site_code),
    'entered_by', (select to_jsonb(array_agg(distinct p)) from (
                     select l.received_by_person as p
                     union all select r.recorded_by_person from site.lot_identity_result r where r.lot_id = l.id
                     union all select d.performed_by_person from site.lot_destruction d where d.lot_id = l.id) x));
end
$$;

select esig.register_signed_table('site.lot_consumption', 'material_lot', 'lot_id');

-- 0710's checks, in the same order and with the same messages, then: the route recorded is the route the signed
-- content shows.
create or replace function site.guard_release_route_satisfied(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l        site.material_lot;
  v_route  text;
  v_signed text;
begin
  select * into l from site.material_lot where id = p_id;
  if not found then
    return 'the lot does not exist';
  end if;
  select c.release_route into v_route from site.lot_status_command c
   where c.lot_id = p_id and c.xact_id = txid_current() and c.event = 'RELEASE' order by c.recorded_at desc limit 1;
  if v_route is null then
    return 'a release records its route: IDENTITY_TESTED or VENDOR_HISTORY (IN-24 (c))';
  end if;
  if exists (select 1 from site.lot_identity_result r where r.lot_id = p_id and r.result = 'FAIL') then
    return format('a failing identity result is recorded for lot %s; it cannot be released (IN-24 (c))', l.lot_code);
  end if;
  if v_route = 'IDENTITY_TESTED' then
    if not exists (select 1 from site.lot_identity_result r where r.lot_id = p_id and r.result = 'PASS') then
      return format('lot %s has no passing identity result: the identity-tested route needs one (IN-24 (c))', l.lot_code);
    end if;
  else
    if l.material_kind <> 'EXCIPIENT' then
      return format('lot %s is %s: the vendor-history route is only for excipients (IN-24 (c))', l.lot_code, l.material_kind);
    end if;
    if not site.vendor_route_enabled(l.site_code, l.material_code) then
      return format('QA has not enabled the vendor-history route for material %s at site %s with a signed statistical justification (IN-24 (c))',
                    l.material_code, l.site_code);
    end if;
  end if;
  v_signed := site.lot_signed_release_route(p_id);
  if v_signed is distinct from v_route then
    return format('the release signature covers lot %s with release route %s in its signed content; a release on route %s is refused (IN-24 (c); EBMR-SITE-112)',
                  l.lot_code, coalesce(v_signed, 'none'), v_route);
  end if;
  return null;
end
$$;

revoke all on function site.lot_signed_release_route(uuid) from public;
grant execute on function site.lot_signed_release_route(uuid) to ebmr_app;

-- Supersede the signatures given over 0710's content (see the header).
select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0720_lot_release_signed_route)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the material lot signed content now shows the release route and the current quantity (IN-24, DI-37, INV-09)'));

select esig.content_changed('material_lot', l.id::text, 'site.material_lot_content', 'UPDATE')
from site.material_lot l
where exists (select 1 from esig.signature s
              where s.aggregate_ref = 'material_lot:' || l.id::text
                and not exists (select 1 from esig.signature_invalidation i where i.signature_id = s.id));

select kernel.set_actor_context(null);

reset role;
