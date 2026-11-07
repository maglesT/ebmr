-- Tablets, defect found in the API A2 work: on GMP a dispensing weighing that uses up a whole lot is refused
-- (EBMR-EXE-078).
--
-- Handbook: modules/tablets-server.md
--
-- What was wrong. On GMP the server consumes the net of a TB-01 or G-07 weighing of a lot from the batch's reservation
-- in the same command (tablets 0843, 1093; recipe.consume_lot), before it writes the command row. When that net is all
-- that is left of the lot, site.consume_reservation moves the lot to CONSUMED. The entry guard on the command row
-- (tab.entry_identifier_problem, 1700, called by the BEFORE INSERT trigger of 0370/0801) then compared the entry's lot
-- with the register as it stands after that consumption: tab.lot_facts reads a consumed lot as REJECTED, so the entry
-- (which carries the RELEASED status the block was handed) was refused as stating other facts than the register holds.
-- A batch could never dispense the last of a lot (DI-05, PR-18; INV-13, INV-14).
--
-- The TB-01 stock-rotation guard had the same fault: tab.tb01_first_expiring (1000), read by tab.tb01_entry_problem
-- (0843, TB01-FEFO) after the consumption, no longer counted the lot the entry had just used up as usable, named the
-- next lot as the first-expiring one and refused the entry for want of a rotation reason.
--
-- What changed:
--   * tab.lot_used_up_by_this_command(p_code, p_batch, p_consumption) (new): whether a consumption made in this transaction into
--     batch p_batch emptied lot p_code of the batch's site (quantity after it 0, xact_id of this transaction) and the
--     lot is now CONSUMED; when the entry names its consumption (a TB-01 weighing does), that consumption itself (lead audit
--     of #153). A G-07 entry names none (tablets 1093 pairs it with its consumption), so it is held to the transaction,
--     the batch and the emptied lot. site.consume_reservation consumes only a lot in a usable state, so such a lot stood usable,
--     and read as RELEASED, before this command.
--   * tab.entry_identifier_problem(p_batch, p_entry) (CREATE OR REPLACE, the body of 1700 otherwise unchanged): on GMP,
--     for such a lot only, the status compared with the entry is the RELEASED it had before the command. Every other
--     fact (material, expiry, retest, identity) is still the register's now, and a lot consumed, rejected, quarantined
--     or otherwise unusable before the command is refused exactly as before (EBMR-EXE-078). The sandbox is unchanged.
--   * tab.tb01_first_expiring(p_batch, p_material, p_exclude, p_now) (CREATE OR REPLACE, the body of 1000 otherwise
--     unchanged): on GMP a lot this command used up counts as it stood before the command (usable, with stock and an open
--     reservation for the batch: what site.consume_reservation required); its dates and identity rule are checked as
--     for any lot. Every other lot is judged as before.
--
-- The new function is SECURITY DEFINER, owned by ebmr_owner, private to the owner, and pins its search_path with
-- pg_temp last. CREATE OR REPLACE keeps owners, grants and triggers. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- INV-13, PR-18: whether this transaction used up lot p_code (of batch p_batch's site) by a consumption into p_batch.
create function tab.lot_used_up_by_this_command(p_code text, p_batch uuid, p_consumption uuid default null) returns boolean
language sql stable security definer set search_path = pg_catalog, site, recipe, pg_temp as $$
  select p_code is not null and p_batch is not null
     and exists (select 1
                   from site.lot_consumption c
                   join site.material_lot m on m.id = c.lot_id
                   join recipe.stub_batch b on b.id = p_batch and b.site = m.site_code
                  where m.lot_code = p_code and c.batch_id = p_batch and c.xact_id = txid_current() and c.quantity_after = 0
                    and (p_consumption is null or c.id = p_consumption)
                    and site.lot_state(m.id) = 'CONSUMED')
$$;

create or replace function tab.entry_identifier_problem(p_batch uuid, p_entry jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, platform, sandbox, kernel, pg_temp as $$
declare
  v_kind  text := p_entry ->> 'kind';
  v_check record;
  v_p     text;
  v_lot   jsonb;
  v_reg   jsonb;
  v_facts jsonb;
begin
  for v_check in
    select c.member, c.idkind
      from (values ('PREVIOUS_BATCH', 'batchNumber', 'BATCH_NUMBER'), ('CHARGE_CONTAINER', 'scannedBatch', 'BATCH_NUMBER'),
                   ('SOURCE_ADDITION', 'sourceBatch', 'BATCH_NUMBER'),
                   ('CONTAINER_WEIGHING', 'container', 'LOT_NUMBER'), ('CHARGE_CONTAINER', 'container', 'LOT_NUMBER'),
                   ('CHARGE_LOT', 'container', 'LOT_NUMBER'), ('OUTPUT_CONTAINER', 'container', 'LOT_NUMBER'),
                   ('SAMPLE', 'container', 'LOT_NUMBER'), ('DISPOSAL', 'container', 'LOT_NUMBER')) c (kind, member, idkind)
     where c.kind = v_kind and p_entry ? c.member and jsonb_typeof(p_entry -> c.member) is distinct from 'null'
  loop
    continue when v_kind = 'PREVIOUS_BATCH' and p_entry -> v_check.member = '"NONE"'::jsonb;
    -- Slice 7o (1700): the batch's own output container (its label built from the batch's own number).
    continue when v_kind in ('DISPOSAL', 'SAMPLE') and v_check.member = 'container'
              and tab.own_output_container(p_batch, p_entry ->> 'container');
    v_p := sandbox.identifier_problem(v_check.idkind, p_entry ->> v_check.member);
    if v_p is not null then
      return format('%s %s', v_check.member, regexp_replace(v_p, '\s*\[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
    end if;
  end loop;
  if v_kind in ('CONTAINER_WEIGHING', 'CHARGE_LOT') then
    v_lot := p_entry -> 'lot';
    v_p := sandbox.identifier_problem('LOT_NUMBER', coalesce(v_lot ->> 'id', ''));
    if v_p is not null then
      return format('lot %s', regexp_replace(v_p, '\s*\[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
    end if;
    v_facts := tab.lot_facts(v_lot ->> 'id', p_batch);
    if v_facts is null then
      return format('lot %s is not a registered %slot of this installation', left(v_lot ->> 'id', 64),
                    case when kernel.installation_kind() = 'SANDBOX' then 'test ' else 'material ' end);
    end if;
    -- This migration: a lot this command used up is judged by the status it had before the command (RELEASED: only a
    -- usable lot is consumed). Nothing else of the register's facts changes, nor any lot unusable before the command.
    if kernel.installation_kind() <> 'SANDBOX' and v_facts ->> 'status' = 'REJECTED' and tab.lot_used_up_by_this_command(v_lot ->> 'id', p_batch,
         case when p_entry ->> 'consumption' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (p_entry ->> 'consumption')::uuid end) then
      v_facts := v_facts || jsonb_build_object('status', 'RELEASED');
    end if;
    v_reg := jsonb_strip_nulls(jsonb_build_object(
               'id', v_facts -> 'lotCode', 'material', v_facts -> 'materialCode', 'status', v_facts -> 'status',
               'expiresAtUs', v_facts -> 'expiresAtUs', 'retestAtUs', v_facts -> 'retestAtUs', 'identityTested', v_facts -> 'identityTested'));
    if v_lot is distinct from v_reg then
      return format('lot %s states other facts than the lot register holds (%s)', v_lot ->> 'id', v_reg::text);
    end if;
  end if;
  return null;
end
$$;

-- As 1000_lot_retest_reads.sql; a lot this command used up counts as it stood before the command (see above).
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
     and l.expires_at > p_now and (site.lot_retest_at(l.id) is null or site.lot_retest_at(l.id) > p_now)
     and (select x.p_problem is null from site.identity_rule_problem(l, coalesce(v_markets, array['IN'])) x)
     and ((site.lot_state(l.id) = any (site.usable_lot_states())
           and (site.lot_available(l.id) > 0
                or exists (select 1 from site.lot_reservation r where r.lot_id = l.id and r.batch_id = p_batch and site.reservation_is_open(r)
                                                                   and site.reservation_remaining(r.id) > 0)))
          -- This migration: the lot this command used up, as it stood before the command.
          or tab.lot_used_up_by_this_command(l.lot_code, p_batch))
   order by l.expires_at, site.lot_retest_at(l.id) nulls last, l.received_at, l.lot_code limit 1;
  return v_code;
end
$$;

revoke all on function tab.lot_used_up_by_this_command(text, uuid, uuid) from public;

reset role;
