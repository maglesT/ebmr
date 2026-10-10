-- Material lots: the release signature covers the route and the RECEIVED quantity; consumption no longer supersedes
-- the lot's signatures; a person who consumed from a lot does not witness its destruction (Phase 3 slice 2 quick review
-- of 0720; outline 5.2.9; controls IN-24 (a)(c), DI-37, INV-09).
--
-- 0720 put the lot's current quantity in its signed content and registered site.lot_consumption as a signed table, so
-- every ordinary consumption of a released lot superseded its release signature and every used lot showed a
-- superseded release signature in the integrity reports. Corrections (0720 is not edited):
--   * site.material_lot_content (CREATE OR REPLACE) is 0720's provider without 'current_quantity' and without the
--     consumption count in the content version. The release signature covers the route (0720's 'release_route') and
--     the received quantity ('received_quantity', unchanged since 0710 and immutable: material_lot is insert-only).
--   * site.lot_consumption is no longer a signed table. The esig registry has no unregister function, so this
--     migration removes the registration the way register_signed_table made it: the registry row
--     (esig.signed_table) and the change trigger it created. The truncate guard it created stays (genealogy rows are
--     never truncated). esig.change_triggers_ok and esig.verify_signatures read the registry, so they stay consistent.
--   * 0720's header said a consuming person thereby became a performer who could not witness the lot's destruction.
--     That held only through the content-change log (esig.performers_of reads esig.content_change), not through the
--     provider's 'entered_by', and it ends with the registration. The rule is now direct (default taken, the stricter
--     one): the guard material_lot.destruction_witnessed (CREATE OR REPLACE, 0710's checks unchanged and first) also
--     refuses a witness who consumed from the lot (EBMR-SITE-152).
--
-- Existing signatures: the content changes again (no current quantity), so, as in 0720, every lot with a signature
-- not yet superseded goes through esig.content_changed: those signatures are recorded SUPERSEDED_BY_CHANGE with their
-- previous hash (still verifiable) and must be given again.

set local role ebmr_owner;

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
                         + (select count(*) from site.lot_state_entry e where e.lot_id = l.id),
    'content', jsonb_build_object(
      'lot_code', l.lot_code, 'site_code', l.site_code, 'material_code', l.material_code, 'material_name', l.material_name,
      'material_kind', l.material_kind, 'supplier', l.supplier, 'supplier_lot', l.supplier_lot,
      'received_quantity', l.received_quantity::text, 'unit', l.unit, 'retest_at', site.utc_text(l.retest_at),
      'expires_at', site.utc_text(l.expires_at), 'received_by', l.received_by_person,
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

-- Remove 0720's registration of site.lot_consumption (registry row and change trigger; see the header).
drop trigger esig_signed_site_lot_consumption on site.lot_consumption;
delete from esig.signed_table where table_name = 'site.lot_consumption'::regclass;

-- 0710's checks, then: the witness did not consume from the lot.
create or replace function site.guard_destruction_witnessed(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, esig, pg_temp as $$
  select case when d.id is null then 'no destruction record exists for the lot: record the destruction first'
              when s.id is null then 'the destruction carries no witness signature'
              when s.signer_person = d.performed_by_person then 'the witness of a destruction is another person than its performer'
              when exists (select 1 from site.lot_consumption c where c.lot_id = p_id and c.consumed_by_person = s.signer_person)
                then 'the witness of a destruction did not consume from the lot (EBMR-SITE-152)'
         end
  from (select 1) x
  left join site.lot_destruction d on d.lot_id = p_id
  left join esig.signature s on s.id::text = p_payload ->> 'signature_id'
$$;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0721_lot_release_received_quantity)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the material lot signed content shows the received quantity, not the current one (IN-24, DI-37, INV-09)'));

select esig.content_changed('material_lot', l.id::text, 'site.material_lot_content', 'UPDATE')
from site.material_lot l
where exists (select 1 from esig.signature s
              where s.aggregate_ref = 'material_lot:' || l.id::text
                and not exists (select 1 from esig.signature_invalidation i where i.signature_id = s.id));

select kernel.set_actor_context(null);

reset role;
