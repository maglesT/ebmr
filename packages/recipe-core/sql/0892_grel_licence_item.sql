-- G-REL item 6, licence and export permission (Phase 4 slice 6a; plan "Slice 6", D-6-1, D-6-2; controls IN-30, INV-05;
-- outline 5.2.7 item 6; ADR 0012).
--
--   recipe.grel_licence_item(lot, market)  the item G6.LICENCE that 0781 and 0783 left NA for this slice:
--       every batch of the lot's evidence set (recipe.release_batches) was issued under a licence basis recorded at its
--       issue (recipe.batch_licence_basis, recipe-core 0891), shown with the host and loan licence numbers (IN-30); for US
--       and EU, the export permission of the lot's product and strength for that market is in force now (D-6-2). A
--       licence suspended after the issue does not block the release of batches issued under it (D-6-1).
--   recipe.grel_evaluate: CREATE OR REPLACE from its latest definition (0822); nothing changes but that the G6.LICENCE
--       item of recipe.grel_core_items is replaced by recipe.grel_licence_item, in place. The epoch covers the item as
--       before (its evidence is part of the evaluated items).

set local role ebmr_owner;

-- The licence and export-permission item (header). The product and strength are those of the lot's own batch.
create function recipe.grel_licence_item(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  f      site.finished_lot;
  v_site text;
  v_set  uuid[];
  b      uuid;
  v_bn   text;
  lb     recipe.batch_licence_basis;
  v_prob text;
  v_ev   jsonb := '[]'::jsonb;
  v_perm uuid;
  e      site.export_permission;
  v_prod text;
  v_str  text;
begin
  select * into f from site.finished_lot where lot_id = p_lot;
  select l.site_code into v_site from site.material_lot l where l.id = p_lot;
  if f.lot_id is null then
    return recipe.grel_item('G6.LICENCE', '6', 'Manufacturing licence at issue and export permission (IN-30, D-6-2)', 'the lot is no finished lot of a packaging batch');
  end if;
  -- The product and strength of the lot's own (packaging) batch, as its master names them; the lot's own as a fallback.
  select fm.product_code, fm.strength into v_prod, v_str from recipe.stub_batch sb join recipe.mbr_family fm on fm.id = sb.family_id where sb.id = f.batch_id;
  v_prod := coalesce(v_prod, f.product_code);
  v_str := coalesce(v_str, f.strength);
  v_set := recipe.release_batches(p_lot);
  foreach b in array v_set loop
    select x.batch_number into v_bn from recipe.batch_execution x where x.id = b;
    select * into lb from recipe.batch_licence_basis where batch_id = b;
    if lb.batch_id is null then
      v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'BATCH', 'ref', b, 'label', format('%s: no licence basis recorded at issue', v_bn)));
      if v_prob is null then
        v_prob := format('batch %s carries no manufacturing or loan licence recorded at its issue (IN-30, D-6-1)', v_bn);
      end if;
    else
      v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'LICENCE', 'ref', lb.licence_id,
                'label', format('%s: licence %s (Form %s)%s', v_bn, lb.licence_number, lb.basis ->> 'form',
                                case when lb.loan_licence_number is not null
                                     then format(', loan licence %s (Form %s, technical agreement %s)', lb.loan_licence_number, lb.basis ->> 'loanForm', lb.basis ->> 'technicalAgreement')
                                     else '' end)));
    end if;
    lb := null;
  end loop;
  if p_market <> 'IN' then
    v_perm := site.export_permission_current(v_site, v_prod, v_str, p_market, clock_timestamp());
    if v_perm is null then
      v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'EXPORT_PERMISSION', 'ref', p_market, 'label', format('no export permission in force for %s', p_market)));
      v_prob := coalesce(v_prob, site.export_permission_problem(v_site, v_prod, v_str, p_market, clock_timestamp()));
    else
      select * into e from site.export_permission where id = v_perm;
      v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'EXPORT_PERMISSION', 'ref', e.id,
                'label', format('export permission %s for %s %s to %s, valid until %s', e.permission_number, e.product_code, e.strength, e.destination, site.utc_text(e.valid_until))));
    end if;
  end if;
  return recipe.grel_item('G6.LICENCE', '6', 'Manufacturing licence at issue and export permission (IN-30, D-6-2)', v_prob, v_ev, false);
end
$$;

-- As 0822, with G6.LICENCE from recipe.grel_licence_item (header).
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

revoke all on function recipe.grel_licence_item(uuid, text) from public;
grant execute on function recipe.grel_licence_item(uuid, text) to ebmr_app;

reset role;
