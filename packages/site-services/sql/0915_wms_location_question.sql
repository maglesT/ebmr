-- Site services: the WMS's question before a move, answered for the ERP/WMS adapter (Phase 6 slice 6a, builder A; PR-46
-- clause 2; D-P6a-7).
--
-- Handbook: modules/site-services.md
--
--   site.wms_location_question(lot code, location kind) text   an ACTIVE ERP_WMS adapter only (INTERFACE.WRITE): NULL
--        when the lot of that code at the adapter's site may move to a location of that kind (site.location_move_problem,
--        0911), else why not: an unknown lot or location kind is answered "not allowed" with the reason, never by an
--        error, so the WMS always gets an answer. Reads only; the move itself arrives later as wms.stock_move.

set local role ebmr_owner;

create function site.wms_location_question(p_lot_code text, p_location_kind text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_site text;
  v_lot  uuid;
begin
  perform site.require_erp_wms_adapter();
  v_site := site.actor_site();
  select l.id into v_lot from site.material_lot l where l.site_code = v_site and l.lot_code = p_lot_code;
  if v_lot is null then
    return format('the eBMR holds no lot %s at site %s (PR-46)', coalesce(p_lot_code, 'NULL'), v_site);
  end if;
  if p_location_kind is null or p_location_kind not in ('QUARANTINE', 'RELEASED', 'REJECTED', 'PRODUCTION', 'RETURNS') then
    return format('%s is not a location kind the eBMR knows (QUARANTINE, RELEASED, REJECTED, PRODUCTION, RETURNS) (PR-46)', coalesce(p_location_kind, 'NULL'));
  end if;
  return site.location_move_problem(v_lot, p_location_kind);
end
$$;

grant execute on function site.wms_location_question(text, text) to ebmr_app;

reset role;
