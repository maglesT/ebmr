-- Recipe core: a multi-point profile of the finished product's specification as one item of the release checklist
-- (Phase 7 slice 7p, requirement R4 "Third check"; decisions D-7p-1 to D-7p-4; controls IN-05, PR-45, IN-33).
--
-- Handbook: modules/recipe-core.md
--
-- recipe.grel_evaluate (CREATE OR REPLACE from its latest definition, recipe-core 0951) adds, after the core items, one
-- item per profile test of the specification in effect for the lot (site.lot_profile_status, site services 1640):
-- G3.PROFILE_<test code>, "<test code> profile: every time point within its limits", GREEN only when every point has an
-- approved current RELEASE result within its own limits; RED with the first point out of its limits (the requirement
-- fails), else with the first point without an approved result (the requirement stays open). Its evidence is one entry
-- per point (kind PROFILE_POINT: the point, its limits, the value and verdict, or "no result"). The G3.LIMS item lists
-- the results of a profile's points as that one profile entry, not as separate results. A lot whose specification has
-- no profile reads exactly as before. G3.LIMS still covers every result (site.lot_lims_release_problem, 1640), so a
-- release decision is refused by the database while a profile is open or failed (the release guards read it).

set local role ebmr_owner;

-- The profile items of a lot (header).
create function recipe.grel_profile_items(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(jsonb_agg(recipe.grel_item(
           'G3.PROFILE_' || left(regexp_replace(s ->> 'testCode', '[^A-Z0-9_]', '_', 'g'), 56), '3',
           format('%s profile: every time point within its limits', s ->> 'testCode'),
           case when s ->> 'status' = 'PASS' then null
                when s ->> 'status' = 'FAIL' then format('the requirement fails: %s', s ->> 'problem')
                else format('the requirement is open: %s', s ->> 'problem') end,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'kind', 'PROFILE_POINT',
                     'ref', coalesce(pt -> 'result' ->> 'resultId', (s ->> 'specTestId') || '#' || (pt ->> 'pointNo')),
                     'label', format('%s (%s to %s %s): %s', pt ->> 'label', coalesce(pt ->> 'lowerLimit', '-'), coalesce(pt ->> 'upperLimit', '-'), s ->> 'unit',
                                     case when pt -> 'result' is null or jsonb_typeof(pt -> 'result') = 'null' then 'no result'
                                          else format('%s %s %s %s', pt -> 'result' ->> 'value', s ->> 'unit', pt -> 'result' ->> 'verdict', pt -> 'result' ->> 'state') end))
                   order by (pt ->> 'pointNo')::integer), '[]'::jsonb)
              from jsonb_array_elements(s -> 'points') pt),
           false) order by s ->> 'testCode' collate "C"), '[]'::jsonb)
    from jsonb_array_elements(site.lot_profile_status(p_lot)) s
$$;

-- The G3.LIMS item with the results of each profile's points listed as one entry of the profile (header).
create function recipe.grel_lims_profile_evidence(p_item jsonb, p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select case when not exists (select 1 from jsonb_array_elements(site.lot_profile_status(p_lot))) then p_item
         else jsonb_set(p_item, '{evidence}',
           coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(p_item -> 'evidence') with ordinality x(e, n)
                      where not exists (select 1 from site.lot_test_result r where r.id::text = e ->> 'ref' and r.point_id is not null)), '[]'::jsonb)
           || (select coalesce(jsonb_agg(jsonb_build_object('kind', 'LIMS_PROFILE', 'ref', s ->> 'specTestId',
                                                            'label', format('%s profile %s (%s time points; see its own line)', s ->> 'testCode', s ->> 'status',
                                                                            jsonb_array_length(s -> 'points')))
                                         order by s ->> 'testCode' collate "C"), '[]'::jsonb)
                 from jsonb_array_elements(site.lot_profile_status(p_lot)) s)) end
$$;

-- As recipe-core 0951; the profile items after the core items, G3.LIMS's profile results as one entry (header).
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
  -- Phase 7 slice 7p: each profile test of the specification as one item; G3.LIMS lists its points as one entry (1645).
  v_items := (select coalesce(jsonb_agg(case when i ->> 'id' = 'G3.LIMS' then recipe.grel_lims_profile_evidence(i, p_lot) else i end order by n), '[]'::jsonb)
                from jsonb_array_elements(v_items) with ordinality t(i, n))
             || recipe.grel_profile_items(p_lot);
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

revoke all on function recipe.grel_profile_items(uuid), recipe.grel_lims_profile_evidence(jsonb, uuid) from public;

reset role;
