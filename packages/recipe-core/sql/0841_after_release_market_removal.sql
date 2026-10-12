-- Recipe core: a market recalled or rejected after release is never removed from the lot's set (Phase 4 slice 5a self
-- review; outline 3.3.3 "nothing already evaluated is relabelled"; L-19). recipe.record_market_change (0821) refuses the
-- removal of a market RELEASED, CERTIFIED or RELEASE_SUSPENDED; after 0840 a market can also read RECALLED or
-- REJECTED_AFTER_RELEASE, which a removal would relabel REMOVED. A BEFORE INSERT trigger on recipe.market_change refuses
-- a REMOVE of a market with an after-release decision on the lot, or on a lot of the batch (EBMR-ARL-050).

set local role ebmr_owner;

create function recipe.market_removal_after_release_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  x uuid;
begin
  if new.change <> 'REMOVE' then
    return new;
  end if;
  foreach x in array case new.subject_kind when 'LOT' then array[new.subject_id] else recipe.lots_of_batch(new.subject_id) end loop
    if exists (select 1 from recipe.after_release_decision d where d.lot_id = x and d.market = new.market) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ARL-050 lot %s has an after-release decision for %s: a decided market is not removed (3.3.3, L-19)',
                         (select l.lot_code from site.material_lot l where l.id = x), new.market);
    end if;
  end loop;
  return new;
end
$$;
revoke all on function recipe.market_removal_after_release_check() from public;
create trigger a_market_removal_after_release before insert on recipe.market_change for each row execute function recipe.market_removal_after_release_check();

reset role;
