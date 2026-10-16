-- Recipe core: the genealogy's recovered-material edge in the suspension cascade, and the dosage form of a lot (Phase 6
-- slice 6d; controls IN-29, L-19, PR-57; defaults D-P6d-0-5, D-P6d-0-6).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.genealogy_downstream_lots (re-created from 0840): also follows chemical recovery (site.chemical_recovery,
--       site services 0960), so a cause linked upstream of returned goods that were recovered suspends the released lots
--       made with the recovered material in the same transaction, as every other downstream lot (L-19, IN-29). Otherwise
--       as 0840.
--   recipe.lot_dosage_form(lot) text: the dosage form in the master of the finished lot's batch (the issued MBR's header
--       product, or the test package's product); NULL for other lots. site.lot_dosage_form (0961) calls it when it fills a
--       distribution record.

set local role ebmr_owner;

-- As 0840, with the RECOVERED edge (header).
create or replace function recipe.genealogy_downstream_lots(p_kind text, p_id uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with recursive g(kind, id) as (
    select p_kind, p_id where p_kind in ('LOT', 'BATCH') and p_id is not null
    union
    select e.kind, e.id from g cross join lateral (
      -- a lot consumed by a batch; returned goods of a finished lot
      select 'BATCH'::text as kind, c.batch_id as id from site.lot_consumption c where g.kind = 'LOT' and c.lot_id = g.id
      union all
      select 'LOT', r.lot_id from site.returned_goods r where g.kind = 'LOT' and r.original_lot_id = g.id
      -- chemical recovery of returned goods (slice 6d, site services 0960)
      union all
      select 'LOT', x.recovered_lot_id from site.chemical_recovery x where g.kind = 'LOT' and x.returned_lot_id = g.id
      -- a batch's bulk issued to a packaging order, its packaging orders, its reprocessing children and additions, its lots
      union all
      select 'BATCH', i.order_batch_id from recipe.packaging_bulk_issue i where g.kind = 'BATCH' and i.parent_batch_id = g.id
      union all
      select 'BATCH', k from unnest(case when g.kind = 'BATCH' then recipe.packaging_children_of(g.id) else '{}'::uuid[] end) k
      union all
      select 'BATCH', p.child_batch_id from recipe.batch_parent_link p where g.kind = 'BATCH' and p.parent_batch_id = g.id
      union all
      select 'BATCH', a.batch_id from recipe.source_addition a where g.kind = 'BATCH' and a.source_batch_id = g.id
      union all
      select 'LOT', f.lot_id from site.finished_lot f where g.kind = 'BATCH' and f.batch_id = g.id) e
    where e.id is not null)
  select coalesce(array_agg(distinct g.id order by g.id), '{}') from g
   where g.kind = 'LOT' and not (g.kind = p_kind and g.id = p_id) and exists (select 1 from site.finished_lot f where f.lot_id = g.id)
$$;


create function recipe.lot_dosage_form(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select recipe.batch_product(f.batch_id) ->> 'dosageForm' from site.finished_lot f where f.lot_id = p_lot
$$;

revoke all on function recipe.lot_dosage_form(uuid) from public;
grant execute on function recipe.lot_dosage_form(uuid) to ebmr_app;

reset role;
