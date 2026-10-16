-- Phase 6 slice 6g: the change-impact explorer's query (extra rank 9; D-P6g-0-8). For a proposed change of a material,
-- specification, equipment, MBR version, rule-table site value or supplier: the MBR versions, open batches, released
-- lots and markets it reaches, from the where-used links (formula pins, batch pins and control recipes), the genealogy
-- (recipe.genealogy_forward_set, 6d) and the configuration history (platform.config_version, 6f).
--
-- Handbook: modules/recipe-core.md
--
-- recipe.change_impact(kind text, ref text) returns setof (impact, id, label, detail, via); STABLE, SECURITY DEFINER,
-- EXECUTE to ebmr_app. It writes nothing; the explorer exports its rows with their hash for the change record.
--   MBR versions   MATERIAL / SPECIFICATION (its material): versions not RETIRED or WITHDRAWN whose pinned formula has
--                  the material; SUPPLIER: the same for each material the manufacturer is approved for (not withdrawn);
--                  EQUIPMENT: the versions of the batches that used it; MBR_VERSION: itself; SITE_VALUE: APPROVED
--                  versions with a CURRENT or BRIDGING authorisation cell in a market of the value's market set.
--   open batches   batches of those versions, the batches that consumed a lot of the material (of the manufacturer, for
--                  SUPPLIER) or used the equipment, and every batch forward of them in the genealogy; open = not
--                  QA_REVIEWED, ABORTED or CANCELLED.
--   released lots  lots in state RELEASED forward of those batches and lots, or finished lots of those batches.
--   markets        of the released lots and of the versions' CURRENT or BRIDGING cells.
--   config history SITE_VALUE: the platform.config_version rows of area SITE_VALUE for that key.
-- Error codes: EBMR-CIM-001 unknown kind, EBMR-CIM-002 unknown subject.

set local role ebmr_owner;

create function recipe.change_impact(p_kind text, p_ref text)
returns table (impact text, id uuid, label text, detail text, via text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, plant, formulary, platform, market, pg_temp as $$
#variable_conflict use_column
declare
  v_materials text[] := '{}';
  v_versions  uuid[] := '{}';
  v_batches   uuid[] := '{}';
  v_lots      uuid[] := '{}';
  v_markets   text[] := '{}';
  v_uuid      uuid;
  v_via       text;
begin
  if p_kind is null or p_kind not in ('MATERIAL', 'SPECIFICATION', 'EQUIPMENT', 'MBR_VERSION', 'SITE_VALUE', 'SUPPLIER') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CIM-001 a change impact is asked for a MATERIAL, SPECIFICATION, EQUIPMENT, MBR_VERSION, SITE_VALUE or SUPPLIER, not %s', coalesce(p_kind, 'NULL'));
  end if;
  if p_kind in ('SPECIFICATION', 'MBR_VERSION') then
    if coalesce(p_ref, '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-CIM-002 there is no %s %s', lower(replace(p_kind, '_', ' ')), coalesce(p_ref, 'NULL'));
    end if;
    v_uuid := p_ref::uuid;
  end if;

  -- The subject and the materials, lots, batches and versions it names directly.
  case p_kind
    when 'MATERIAL' then
      if not exists (select 1 from formulary.formula_line l where l.material_code = p_ref)
         and not exists (select 1 from site.material_lot l where l.material_code = p_ref)
         and not exists (select 1 from site.specification s where s.material_code = p_ref) then
        raise exception using errcode = 'P0001', message = format('EBMR-CIM-002 there is no material %s', coalesce(p_ref, 'NULL'));
      end if;
      v_materials := array[p_ref];
    when 'SPECIFICATION' then
      select array[s.material_code] into v_materials from site.specification s where s.id = v_uuid;
      if v_materials is null then
        raise exception using errcode = 'P0001', message = format('EBMR-CIM-002 there is no specification %s', p_ref);
      end if;
    when 'SUPPLIER' then
      if not exists (select 1 from site.approved_manufacturer a where a.manufacturer_code = p_ref)
         and not exists (select 1 from site.lot_receipt r where r.manufacturer_code = p_ref) then
        raise exception using errcode = 'P0001', message = format('EBMR-CIM-002 there is no supplier (manufacturer) %s', coalesce(p_ref, 'NULL'));
      end if;
      select coalesce(array_agg(distinct a.material_code), '{}') into v_materials
        from site.approved_manufacturer a
       where a.manufacturer_code = p_ref
         and exists (select 1 from site.approved_manufacturer_approval x where x.approved_manufacturer_id = a.id)
         and not exists (select 1 from site.approved_manufacturer_withdrawal w where w.approved_manufacturer_id = a.id);
      select coalesce(array_agg(r.lot_id), '{}') into v_lots from site.lot_receipt r where r.manufacturer_code = p_ref;
    when 'EQUIPMENT' then
      if not exists (select 1 from plant.equipment q where q.code = p_ref) then
        raise exception using errcode = 'P0001', message = format('EBMR-CIM-002 there is no equipment %s', coalesce(p_ref, 'NULL'));
      end if;
      select coalesce(array_agg(distinct u.batch_id), '{}') into v_batches
        from plant.equipment_use u join plant.equipment q on q.id = u.equipment_id where q.code = p_ref;
      select coalesce(array_agg(distinct v), '{}') into v_versions
        from (select report.batch_version(b) as v from unnest(v_batches) b) x where v is not null;
    when 'MBR_VERSION' then
      if not exists (select 1 from recipe.mbr_version v where v.id = v_uuid) then
        raise exception using errcode = 'P0001', message = format('EBMR-CIM-002 there is no MBR version %s', p_ref);
      end if;
      v_versions := array[v_uuid];
    when 'SITE_VALUE' then
      select coalesce(array_agg(distinct m), '{}') into v_markets from market.site_value s cross join lateral unnest(s.market_set) m where s.key = p_ref;
      if not exists (select 1 from market.site_value s where s.key = p_ref) then
        raise exception using errcode = 'P0001', message = format('EBMR-CIM-002 there is no rule-table site value %s', coalesce(p_ref, 'NULL'));
      end if;
      select coalesce(array_agg(distinct c.version_id), '{}') into v_versions
        from recipe.authorisation_cell c
       where c.market = any (v_markets) and c.status in ('CURRENT', 'BRIDGING') and recipe.version_state(c.version_id) = 'APPROVED';
  end case;

  -- Materials reach the versions whose pinned formula has them, and the lots of them.
  if cardinality(v_materials) > 0 then
    select coalesce(array_agg(distinct v.id), '{}') into v_versions
      from recipe.mbr_version v
      join formulary.mbr_formula_pin p on p.mbr_version_id = v.id
      join formulary.formula_line l on l.version_id = p.formula_version_id
     where l.material_code = any (v_materials) and recipe.version_state(v.id) not in ('RETIRED', 'WITHDRAWN');
    if p_kind <> 'SUPPLIER' then
      select coalesce(array_agg(l.id), '{}') into v_lots from site.material_lot l where l.material_code = any (v_materials);
    end if;
  end if;
  -- Lots reach the batches that consumed them; versions reach their batches.
  select coalesce(array_agg(distinct b), '{}') into v_batches from (
    select unnest(v_batches) as b
    union select c.batch_id from site.lot_consumption c where c.lot_id = any (v_lots)
    union select x.id from recipe.batch_execution x where report.batch_version(x.id) = any (v_versions)) y;

  return query
  with fwd as materialized (
    select f.kind, f.id from recipe.genealogy_forward_set(
             array_cat(array_fill('BATCH'::text, array[cardinality(v_batches)]), array_fill('LOT'::text, array[cardinality(v_lots)])),
             array_cat(v_batches, v_lots), null) f
  ), all_batches as (
    select b as id, 'direct' as how from unnest(v_batches) b
    union select f.id, 'downstream' from fwd f where f.kind = 'BATCH' and not (f.id = any (v_batches))
  ), open_batches as (
    select x.id, x.batch_number, recipe.batch_review_state(x.id) as status, a.how
      from all_batches a join recipe.batch_execution x on x.id = a.id
     where coalesce(recipe.batch_review_state(x.id), 'NONE') not in ('QA_REVIEWED', 'ABORTED', 'CANCELLED')
  ), released as (
    select distinct l.id, l.lot_code, l.material_code, fl.markets
      from site.material_lot l left join site.finished_lot fl on fl.lot_id = l.id
     where site.lot_state(l.id) = 'RELEASED'
       and (l.id in (select f.id from fwd f where f.kind = 'LOT') or fl.batch_id in (select a.id from all_batches a))
  ), versions as (
    select v.id, 'MBR-' || f.code || '-v' || v.version_number as label, recipe.version_state(v.id) as state
      from recipe.mbr_version v join recipe.mbr_family f on f.id = v.family_id where v.id = any (v_versions)
  ), markets as (
    select m, 'released lot' as how from released r cross join lateral unnest(coalesce(r.markets, '{}')) m
    union select c.market, 'authorisation' from recipe.authorisation_cell c where c.version_id = any (v_versions) and c.status in ('CURRENT', 'BRIDGING')
    union select m, 'site value' from unnest(v_markets) m
  )
  select 'MBR_VERSION'::text, v.id, v.label, v.state, case p_kind when 'MBR_VERSION' then 'the version itself' when 'EQUIPMENT' then 'batches that used the equipment'
                                                          when 'SITE_VALUE' then 'authorised in the value''s markets' else 'formula line' end
    from versions v
  union all
  select 'OPEN_BATCH', o.id, o.batch_number, o.status, o.how from open_batches o
  union all
  select 'RELEASED_LOT', r.id, r.lot_code, r.material_code, 'genealogy' from released r
  union all
  select 'MARKET', null::uuid, mk.m, null::text, string_agg(mk.how, ', ' order by mk.how) from markets mk group by mk.m
  union all
  select 'CONFIG_HISTORY', null::uuid, 'config version ' || cv.id, cv.basis || ' from ' || recipe.utc_text(cv.valid_from), cv.source_row ->> 'outcome'
    from platform.config_version cv where p_kind = 'SITE_VALUE' and cv.area = 'SITE_VALUE' and cv.source_row ->> 'key' = p_ref
  order by 1, 3;
end
$$;
revoke all on function recipe.change_impact(text, text) from public;
grant execute on function recipe.change_impact(text, text) to ebmr_app;

reset role;
