-- Note (decision record 0029, D-0029-3): the header of tablets 1907 grounds the release refusal for a lot or container with
-- an open linked deviation (EBMR-DV-001) in 21 CFR 211.192 alone, which stretches that clause. The basis of EBMR-DV-001
-- is owner decision 0029 (release stays strict), supported by 211.192, 211.100(b) and revised Schedule M 18.2.2 and
-- 18.5.12 as control IN-05 cites them. 1907 is applied and checksummed, so it is not edited; this note corrects it.
--
-- SITE-995 (lead ruling of 11 November 2026; site-services 1736): an in-house intermediate lot may carry no expiry date
-- (a retest date, or neither). FEFO must neither treat such a lot as expired nor put it before a lot that expires.
--
-- Handbook: modules/tablets-server.md
--
--   tab.tb01_first_expiring(batch, material, exclude, now)  CREATE OR REPLACE of tablets 1903, GMP branch only: a lot without
--                           an expiry is a candidate (it has not expired), ordered after every lot with an expiry date
--                           (nulls last), then by its retest date, as the sandbox branch already does. Before this a lot
--                           without an expiry was never the first-expiring lot, so dispensing it always asked for a FEFO
--                           override. Everything else unchanged.

set local role ebmr_owner;

create or replace function tab.tb01_first_expiring(p_batch uuid, p_material text, p_exclude text[], p_now timestamptz) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, site, recipe, kernel, pg_temp as $$
declare
  v_site    text;
  v_markets text[];
  v_code    text;
begin
  select b.site, b.markets into v_site, v_markets from recipe.stub_batch b where b.id = p_batch;
  if v_markets is null then
    select b.market_set into v_markets from recipe.batch_execution b where b.id = p_batch;
  end if;
  if kernel.installation_kind() = 'SANDBOX' then
    select l.lot_code into v_code from tab.sandbox_lot l
     where l.material_code = p_material and l.status = 'RELEASED' and not (l.lot_code = any (coalesce(p_exclude, '{}')))
       and (l.expires_at is null or l.expires_at > p_now) and (l.retest_at is null or l.retest_at > p_now)
       and (l.identity_tested or coalesce(v_markets <@ array['IN'], true))
     order by l.expires_at nulls last, l.retest_at nulls last, l.registered_at, l.lot_code limit 1;
    return v_code;
  end if;
  select l.lot_code into v_code from site.material_lot l
   where l.site_code = v_site and l.material_code = p_material and not (l.lot_code = any (coalesce(p_exclude, '{}')))
     and (l.expires_at is null or l.expires_at > p_now) and (site.lot_retest_at(l.id) is null or site.lot_retest_at(l.id) > p_now)
     and (select x.p_problem is null from site.identity_rule_problem(l, coalesce(v_markets, array['IN'])) x)
     and ((site.lot_state(l.id) = any (site.usable_lot_states())
           and (site.lot_available(l.id) > 0
                or exists (select 1 from site.lot_reservation r where r.lot_id = l.id and r.batch_id = p_batch and site.reservation_is_open(r)
                                                                   and site.reservation_remaining(r.id) > 0)))
          -- This migration: the lot this command used up, as it stood before the command.
          or tab.lot_used_up_by_this_command(l.lot_code, p_batch))
   order by l.expires_at nulls last, site.lot_retest_at(l.id) nulls last, l.received_at, l.lot_code limit 1;
  return v_code;
end
$$;

reset role;
