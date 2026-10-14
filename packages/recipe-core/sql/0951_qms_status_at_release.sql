-- Phase 6 slice 6a (builder B): the QMS status at release (DI-31; INV-05, INV-26; D-P6a-3, D-P6a-0-11; outline 4.6
-- "Stale mirrors fail closed": the QMS status at release).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.grel_qms_item(lot, market)  G-REL item G2.QMS_STATUS. With the built-in deviation register (QMS_STATUS
--       STAND_IN) it is NA and grel_evaluate leaves it out, so every checklist and golden output of a stand-in site stays
--       exactly as before (G2.DEVIATIONS covers the deviations; D-P6a-B-5). With a QMS (MIRROR) it is RED while the mirror holds an
--       OPEN or UNDER_INVESTIGATION QMS deviation naming the lot; its evidence lists every QMS deviation naming the lot
--       with its status and version token, so the G-REL epoch moves whenever a token moves (INV-05: the signer signs the
--       evaluation he saw).
--   recipe.grel_evaluate (CREATE OR REPLACE from its latest definition, 0892; same signature, owner, definer, search_path
--       and grants): in MIRROR the item is added after the core items; nothing else changes.
--   recipe.qms_release_guard() (trigger, BEFORE INSERT) on recipe.manufacturer_release_decision (RELEASED),
--       recipe.us_disposition_decision (RELEASED), recipe.qp_certification (IN_SYSTEM CERTIFIED) and
--       recipe.after_release_decision (RECONFIRM): in MIRROR the decision is refused unless the server fetched the lot's
--       QMS status live inside this very transaction (site.record_qms_release_fetch, site services 0925), that fetch is
--       within the QMS_STATUS bound (60 s, a backstop only) and it shows no open QMS deviation naming the lot
--       (site.qms_release_problem). A fetch that differs from the mirror the signer evaluated was already refused by
--       site.record_qms_release_fetch (EBMR-QMS-011). Rejections never need the QMS. The guard is a trigger so a direct
--       insert, by any role, meets it too.

set local role ebmr_owner;

create function recipe.grel_qms_item(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_devs jsonb;
  v_open text;
  v_ev   jsonb;
begin
  if site.qms_mode() = 'STAND_IN' then
    return recipe.grel_item('G2.QMS_STATUS', '2', 'QMS status of the lot (fetched live at signing)', null, '[]'::jsonb, false, 'NA');
  end if;
  v_devs := site.qms_lot_deviations(p_lot);
  select string_agg(d ->> 'deviationRef' || ' ' || (d ->> 'status'), ', ' order by d ->> 'deviationRef' collate "C") into v_open
  from jsonb_array_elements(v_devs) d where d ->> 'status' in ('OPEN', 'UNDER_INVESTIGATION');
  select coalesce(jsonb_agg(jsonb_build_object('kind', 'QMS_DEVIATION', 'ref', d ->> 'deviationRef',
                                               'label', format('%s %s (QMS version %s)', d ->> 'deviationRef', d ->> 'status', d ->> 'versionToken'))
                            order by d ->> 'deviationRef' collate "C"), '[]'::jsonb) into v_ev
  from jsonb_array_elements(v_devs) d;
  return recipe.grel_item('G2.QMS_STATUS', '2', 'QMS status of the lot (fetched live at signing)',
                          case when v_open is not null then format('the QMS holds open deviations naming the lot: %s', v_open) end, v_ev, false);
end
$$;

create or replace function recipe.grel_evaluate(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_items   jsonb;
  v_edition jsonb;
  v_grp     text;
begin
  if p_market is null or p_market not in ('IN', 'US', 'EU') then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-002 G-REL is evaluated for IN, US or EU, not %s', coalesce(p_market, 'NULL'));
  end if;
  v_items := recipe.grel_core_items(p_lot, p_market);
  -- Slice 6a: the licence and export permission item (0892).
  v_items := (select coalesce(jsonb_agg(case when i ->> 'id' = 'G6.LICENCE' then recipe.grel_licence_item(p_lot, p_market) else i end order by n), '[]'::jsonb)
                from jsonb_array_elements(v_items) with ordinality t(i, n));
  -- Phase 6 slice 6a: the QMS status of the lot (0951).
  if site.qms_mode() = 'MIRROR' and exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    v_items := v_items || jsonb_build_array(recipe.grel_qms_item(p_lot, p_market));
  end if;
  -- Slice 4a: for US and EU the market-add item and the market items (IN's checklist is unchanged).
  if p_market in ('US', 'EU') and exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    v_items := (select coalesce(jsonb_agg(i order by n), '[]'::jsonb) from jsonb_array_elements(v_items) with ordinality t(i, n) where i ->> 'id' <> 'G8.MARKET_ADD')
               || recipe.grel_market_items(p_lot, p_market);
  end if;
  v_edition := recipe.grel_edition_items(p_lot, p_market);
  -- Groups 4 and 9 are the edition's blocks: RED until the edition answers for them (fails closed).
  foreach v_grp in array array['4', '9'] loop
    if not exists (select 1 from jsonb_array_elements(v_edition) e where e ->> 'group' = v_grp) then
      v_items := v_items || jsonb_build_array(recipe.grel_item(
        case v_grp when '4' then 'G4.RECONCILIATION' else 'G9.PACK_EXAMINATION' end, v_grp,
        case v_grp when '4' then 'Yield, printed-material and serial reconciliation' else 'Finished-pack examination recorded' end,
        format('the edition reports no %s item for the lot yet', case v_grp when '4' then 'reconciliation' else 'finished-pack examination' end)));
    end if;
  end loop;
  v_items := v_items || v_edition;
  return jsonb_build_object(
    'lot', p_lot, 'market', p_market,
    'epoch', encode(sha256(convert_to(jsonb_build_object('versions', recipe.grel_versions(p_lot), 'items', v_items)::text, 'UTF8')), 'hex'),
    'ready', not exists (select 1 from jsonb_array_elements(v_items) i where i ->> 'status' = 'RED'),
    'items', v_items);
end
$$;

create function recipe.qms_release_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_prob text;
begin
  if (tg_table_name in ('manufacturer_release_decision', 'us_disposition_decision') and new.decision = 'RELEASED')
     or (tg_table_name = 'qp_certification' and new.source = 'IN_SYSTEM' and new.outcome = 'CERTIFIED')
     or (tg_table_name = 'after_release_decision' and new.act = 'RECONFIRM') then
    v_prob := site.qms_release_problem(new.lot_id);
    if v_prob is not null then
      raise exception using errcode = 'P0001', message = v_prob;
    end if;
  end if;
  return new;
end
$$;
revoke all on function recipe.qms_release_guard() from public;

create trigger aaa_qms_release_guard before insert on recipe.manufacturer_release_decision for each row execute function recipe.qms_release_guard();
create trigger aaa_qms_release_guard before insert on recipe.us_disposition_decision for each row execute function recipe.qms_release_guard();
create trigger aaa_qms_release_guard before insert on recipe.qp_certification for each row execute function recipe.qms_release_guard();
create trigger aaa_qms_release_guard before insert on recipe.after_release_decision for each row execute function recipe.qms_release_guard();

revoke all on function recipe.grel_qms_item(uuid, text) from public;
grant execute on function recipe.grel_qms_item(uuid, text) to ebmr_app;

reset role;
