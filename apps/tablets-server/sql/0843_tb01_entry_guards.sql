-- Tablets server, Phase 3 slice 3b (builder A; TB-01): what a TB-01 step's entries stand on in the database (controls
-- PR-18, PR-19, PR-20, IN-23, IN-24, DI-30, DI-33; invariants INV-13, INV-14; ADR 0012: the rules hold when the
-- application's own database credentials are used directly). EBMR-EXE-240 and EBMR-EXE-241.
--
-- A TB-01 step records a POTENCY_CALCULATION and dispensed containers (CONTAINER_WEIGHING, as G-07: net, label, total,
-- the scale readings or the manual two-person path, the register's lot facts are already the database's, recipe-core
-- 0321 to 0323, 0330, 0520 and tablets 0300, 0310, 0801, which this migration lets take a TB-01 weighing as a G-07 one:
-- recipe.weighing_item_problem, replaced from its definition in recipe-core 0323 with TB-01 beside G-07). The trigger
-- ab_tb01_entry_guard (after update of recipe.execution_state; SECURITY DEFINER) refuses a row that adds an entry at a
-- TB-01 step unless:
--   * the command's actor holds the dispenser designation (engine role DISPENSER, which recipe.append_execution accepts
--     only with an authority evaluation of DISPENSE.EXECUTE made in the same command, INV-26; PR-19 "a non-designated
--     user is refused");
--   * a POTENCY_CALCULATION: nothing is dispensed at the step yet; each lot states exactly the facts the lot register
--     holds for it now (tablets 0801 tab.lot_facts) and is usable at the row's time (released, before retest and
--     expiry, identity-tested for a batch beyond India, the active's material: recipe.lot_usability_problem); each
--     assay is exactly the lot's current approved result (tab.lot_assay_of, 0841) on the basis the MBR calculates on;
--     and the stored data is exactly what tab.tb01_calculation (0842) computes from those inputs: a recorded target
--     that differs is refused (DI-33);
--   * a CONTAINER_WEIGHING: a calculation was recorded before it at the step; its line is the active or the
--     compensating excipient; the active only from a lot of the governing (latest) calculation; the lot is the
--     first-expiring usable lot of its material at the row's time (tab.tb01_first_expiring), or one already dispensed
--     for the line at the step, or the entry carries the dispenser's reason, and a reason only then (PR-18); the
--     balance it names is an instrument with a use for this batch whose planned end is after the row's time
--     (plant.record_instrument_use, recipe-core 0403: calibrated, its per-use or daily check passed; IN-25 (b)); on GMP
--     it names the consumption of the lot made in this transaction for this batch, of exactly its net in the lot's
--     unit, which no other entry names (recipe.consume_lot, recipe-core 0430: genealogy INV-13, INV-14), and in the
--     sandbox it names none (test lots have no stock); each lot of the governing calculation still has the approved
--     result the calculation used (a result QC superseded since stops the step's dispensing, TB01-RESULT-SUPERSEDED);
--     a lot out of rotation raises FEFO_OVERRIDE in the same row;
--   * a calculation beyond the MBR's adjustment cap raises POTENCY_ADJUSTMENT_CAP in the same row, holding the steps
--     after it until a deviation; and the step closes with a line outside its tolerance only with
--     DISPENSE_OUT_OF_TOLERANCE raised at the step, holding the steps after it (tab.tb01_close_problem).
--
-- New functions are owned by ebmr_owner; the trigger function is SECURITY DEFINER; every function pins its search_path
-- with pg_temp last. tab.tb01_first_expiring is granted to the application (the server proposes the lot from it).
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- As recipe-core 0323, with TB-01 beside G-07 for a dispensed container (header).
create or replace function recipe.weighing_item_problem(p_entry jsonb, p_content jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind    text := p_entry ->> 'kind';
  v_data    jsonb := p_entry -> 'data';
  v_what    text;
  v_step    text;
  v_records text[];
  v_params  jsonb := case when jsonb_typeof(p_content -> 'parameters') = 'array' then p_content -> 'parameters' else '[]'::jsonb end;
  v_mass    text[] := '{}';
  v_unread  text;
  v_want    jsonb;
  v_unit    text;
  v_block   text;
  r         text;
  p         jsonb;
begin
  if v_kind is null or v_kind not in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER') then
    return null;
  end if;
  v_what := format('(%s) at %s', v_kind, coalesce(p_entry ->> 'stepKey', '(no step)'));
  if jsonb_typeof(v_data) is distinct from 'object' then
    return format('%s with no data, so no quantity it counts into', v_what);
  end if;
  v_step := split_part(coalesce(p_entry ->> 'stepKey', ''), '@', 1);
  v_records := recipe.phase_records(p_content, v_step);
  if v_records is null then
    return format('%s, whose step is no phase of the batch''s MBR the database can read', v_what);
  end if;
  -- Only the block that records such a weighing takes it: G-07 or TB-01 (tablets 0843) a dispensed container, G-22 an
  -- output container.
  v_block := recipe.step_node(p_content, v_step) -> 'block' ->> 'type';
  if not coalesce(v_block = any (case v_kind when 'CONTAINER_WEIGHING' then array['G-07', 'TB-01'] else array['G-22'] end), false) then
    return format('%s, whose phase %s is a %s step, which records no such weighing', v_what, v_step, coalesce(v_block, '(no block)'));
  end if;
  -- The mass quantities the phase records, in order (blocks/generic common.ts massItems; the first parameter of an id
  -- is the MBR's), and the first quantity before any of them whose unit the database does not read.
  foreach r in array v_records loop
    select q into p from jsonb_array_elements(v_params) with ordinality t(q, o) where q ->> 'id' = r order by o limit 1;
    if p is null or (p ->> 'valueType') is distinct from 'DECIMAL'
       or coalesce(nullif(p -> 'readings', 'null'::jsonb), '1'::jsonb) <> '1'::jsonb then
      continue;
    end if;
    case recipe.mass_unit_class(p -> 'unit')
      when 'MASS' then
        v_mass := v_mass || r;
      when 'UNKNOWN' then
        if cardinality(v_mass) = 0 and v_unread is null then
          v_unread := format('%s in %s', r, p ->> 'unit');
        end if;
      else
        null;
    end case;
  end loop;
  if v_kind = 'CONTAINER_WEIGHING' then
    -- G-07 and TB-01: one of the phase's mass quantities, the one the entry names.
    if jsonb_typeof(v_data -> 'item') is distinct from 'string' or not ((v_data ->> 'item') = any (v_mass)) then
      return format('%s counted into %s, where its phase %s records the mass quantities %s', v_what,
                    coalesce((v_data -> 'item')::text, '(no item)'), v_step, to_jsonb(v_mass)::text);
    end if;
  else
    -- G-22: the first mass quantity; none only when the phase records none. A quantity before it whose unit the
    -- database does not read could be the first: fail closed.
    if v_unread is not null then
      return format('%s, whose phase %s records %s, a unit the database cannot tell is a mass or not, so not which quantity the container counts into',
                    v_what, v_step, v_unread);
    end if;
    v_want := coalesce(to_jsonb(v_mass[1]), 'null'::jsonb);
    if (v_data -> 'item') is distinct from v_want then
      return format('%s counted into %s, where its phase %s counts it into %s', v_what,
                    coalesce((v_data -> 'item')::text, '(no item)'), v_step, v_want::text);
    end if;
  end if;
  -- The weight is counted into its quantity's unit: the same unit, or both metric mass units (0322).
  if jsonb_typeof(v_data -> 'item') = 'string' then
    select q ->> 'unit' into v_unit from jsonb_array_elements(v_params) with ordinality t(q, o) where q ->> 'id' = v_data ->> 'item' order by o limit 1;
    if jsonb_typeof(v_data -> 'unit') is distinct from 'string'
       or ((v_data ->> 'unit') is distinct from v_unit
           and (recipe.metric_mass_exponent(v_data ->> 'unit') is null or recipe.metric_mass_exponent(v_unit) is null)) then
      return format('%s weighed in %s, which is not counted into %s in %s (the same unit, or both metric mass units)', v_what,
                    coalesce(v_data ->> 'unit', '(no unit)'), v_data ->> 'item', v_unit);
    end if;
  end if;
  return null;
end
$$;

-- PR-18 (header): the first-expiring usable lot of material p_material for batch p_batch at instant p_now, leaving out
-- the lots p_exclude; NULL when there is none. Usable: of this installation's register (the batch's site on GMP),
-- released (a usable lot state on GMP), before its retest and expiry, meeting the identity rule of the batch's markets,
-- with stock to give (on GMP an open reservation for this batch with quantity left, or quantity not reserved).
create function tab.tb01_first_expiring(p_batch uuid, p_material text, p_exclude text[], p_now timestamptz) returns text
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
     and site.lot_state(l.id) = any (site.usable_lot_states())
     and l.expires_at > p_now and (l.retest_at is null or l.retest_at > p_now)
     and (select x.p_problem is null from site.identity_rule_problem(l, coalesce(v_markets, array['IN'])) x)
     and (site.lot_available(l.id) > 0
          or exists (select 1 from site.lot_reservation r where r.lot_id = l.id and r.batch_id = p_batch and site.reservation_is_open(r)
                                                             and site.reservation_remaining(r.id) > 0))
   order by l.expires_at, l.retest_at nulls last, l.received_at, l.lot_code limit 1;
  return v_code;
end
$$;

-- p_value (decimal text in metric mass unit p_from) in metric mass unit p_to, exactly; NULL when either is not one.
create function tab.tb01_mass_in(p_value numeric, p_from text, p_to text) returns numeric
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select p_value * power(10::numeric, recipe.metric_mass_exponent(p_from) - recipe.metric_mass_exponent(p_to))
$$;

-- PR-18, PR-19, DI-26: whether row p_new raised (newly against p_old) an exception of type p_type at step instance p_key
-- of severity p_severity; with p_held, one that holds the steps after it until a deviation is linked (as tb-01.ts raises
-- POTENCY_ADJUSTMENT_CAP and DISPENSE_OUT_OF_TOLERANCE). With p_old NULL, raised at any time.
create function tab.tb01_raised(p_old jsonb, p_new jsonb, p_key text, p_type text, p_severity text, p_held boolean) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
     where (p_old is null or not coalesce((p_old -> 'exceptions') ? x.key, false))
       and x.value ->> 'type' = p_type and x.value -> 'source' ->> 'stepKey' = p_key and x.value ->> 'severity' = p_severity
       and (not p_held or ((x.value -> 'deviationRequired') = 'true'::jsonb and x.value -> 'block' ->> 'until' = 'DEVIATION'
                           and jsonb_typeof(x.value -> 'block' -> 'downstream') = 'object')))
$$;

-- PR-19 (header, review item 1): why a TB-01 step instance row p_new closes (IN_PROGRESS to AWAITING_VERIFICATION or
-- COMPLETED) does not stand: a line whose dispensed total is outside the MBR's tolerance of its governing target closes
-- only with DISPENSE_OUT_OF_TOLERANCE raised at the step, holding the steps after it until a deviation is linked.
create function tab.tb01_close_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k       text;
  s       jsonb;
  v_node  jsonb;
  v_cfg   jsonb;
  v_calc  jsonb;
  v_unit  text;
  v_line  text;
  v_tgt   numeric;
  v_tol   numeric;
  v_total numeric;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(p_content, s ->> 'step');
    continue when (v_node -> 'block' ->> 'type') is distinct from 'TB-01';
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    select y.value -> 'data' into v_calc from jsonb_each(p_new -> 'entries') y
     where y.value ->> 'stepKey' = k and y.value ->> 'kind' = 'POTENCY_CALCULATION' order by (y.value ->> 'recordedSeq')::numeric desc limit 1;
    if v_calc is null then
      return format('closes TB-01 step %s without a potency calculation (TB01-NO-CALCULATION; PR-19)', k);
    end if;
    v_unit := v_calc -> 'active' ->> 'unit';
    for v_line, v_tgt, v_tol in
      select v_calc -> 'active' ->> 'bomLine', (select sum((r ->> 'target')::numeric) from jsonb_array_elements(v_calc -> 'results') r), (v_cfg -> 'tolerancePercent' ->> 'active')::numeric
      union all
      select v_calc -> 'excipient' ->> 'bomLine', (v_calc -> 'excipient' ->> 'target')::numeric, (v_cfg -> 'tolerancePercent' ->> 'excipient')::numeric
       where jsonb_typeof(v_calc -> 'excipient') = 'object'
    loop
      select sum(tab.tb01_mass_in((y.value -> 'data' ->> 'net')::numeric, y.value -> 'data' ->> 'unit', v_unit)) into v_total
        from jsonb_each(p_new -> 'entries') y
       where y.value ->> 'stepKey' = k and y.value ->> 'kind' = 'CONTAINER_WEIGHING' and y.value -> 'data' ->> 'bomLine' = v_line;
      if v_total is null or v_tgt is null or v_tol is null or abs(v_total - v_tgt) > abs(v_tgt) * v_tol / 100 then
        if not tab.tb01_raised(null, p_new, k, 'DISPENSE_OUT_OF_TOLERANCE', 'ACTION', true) then
          return format('closes TB-01 step %s with %s %s of %s dispensed against its target %s (tolerance %s %%) and no DISPENSE_OUT_OF_TOLERANCE raised (PR-19)',
                        k, coalesce(trim_scale(v_total)::text, '(nothing)'), v_unit, v_line, coalesce(v_tgt::text, '(none)'), coalesce(v_tol::text, '(none)'));
        end if;
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- PR-18, PR-19, PR-20, IN-23, IN-24, IN-25, DI-33, INV-13, INV-14 (header): why the entries a row adds at TB-01 steps of
-- batch p_batch (MBR content p_content; state p_old -> p_new; command p_command) do not stand; NULL when they do.
create function tab.tb01_entry_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, site, plant, kernel, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_now_us  numeric := recipe.micros_of(p_new -> 'lastRecordedUs');
  v_now     timestamptz;
  v_markets jsonb := p_new -> 'header' -> 'marketSet';
  v_gmp     boolean := kernel.installation_kind() <> 'SANDBOX';
  k         text;
  e         jsonb;
  c         jsonb;
  d         jsonb;
  v_node    jsonb;
  v_cfg     jsonb;
  v_what    text;
  v_problem text;
  v_calc    jsonb;
  v_want    jsonb;
  v_member  text;
  l         jsonb;
  v_reg     jsonb;
  v_facts   jsonb;
  v_line    text;
  v_used    text[];
  v_first   text;
  v_need    boolean;
  x         site.lot_consumption;
  v_lot     uuid;
begin
  v_now := timestamptz 'epoch' + (v_now_us::text || ' microseconds')::interval;
  for k, e in select y.key, y.value from jsonb_each(e1) y where not (e0 ? y.key) order by y.key loop
    v_node := recipe.step_node(p_content, split_part(coalesce(e ->> 'stepKey', ''), '@', 1));
    continue when (v_node -> 'block' ->> 'type') is distinct from 'TB-01' or (e ->> 'kind') not in ('POTENCY_CALCULATION', 'CONTAINER_WEIGHING');
    v_what := format('entry %s (%s) of TB-01 step %s', k, e ->> 'kind', e ->> 'stepKey');
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    c := case when jsonb_typeof(p_command -> 'entry') = 'object' then p_command -> 'entry' else '{}'::jsonb end;
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    if not coalesce((p_command -> 'actor' -> 'roles') @> '["DISPENSER"]'::jsonb, false) then
      return format('%s is recorded by a person acting without the dispenser designation (TB01-DESIGNATION; PR-19)', v_what);
    end if;
    if e ->> 'kind' = 'POTENCY_CALCULATION' then
      if exists (select 1 from jsonb_each(e0) y where y.value ->> 'stepKey' = e ->> 'stepKey' and y.value ->> 'kind' = 'CONTAINER_WEIGHING') then
        return format('%s comes after material was dispensed against the calculation (TB01-CALC-AFTER-DISPENSE; PR-19, DI-33)', v_what);
      end if;
      for l in select z from jsonb_array_elements(case when jsonb_typeof(c -> 'lots') = 'array' then c -> 'lots' else '[]'::jsonb end) z loop
        v_facts := tab.lot_facts(l -> 'lot' ->> 'id', p_batch);
        v_reg := jsonb_strip_nulls(jsonb_build_object(
                   'id', v_facts -> 'lotCode', 'material', v_facts -> 'materialCode', 'status', v_facts -> 'status',
                   'expiresAtUs', v_facts -> 'expiresAtUs', 'retestAtUs', v_facts -> 'retestAtUs', 'identityTested', v_facts -> 'identityTested'));
        if v_facts is null or (l -> 'lot') is distinct from v_reg then
          return format('%s states lot %s with other facts than the lot register holds now (TB01-REGISTER; PR-18)', v_what, left(coalesce(l -> 'lot' ->> 'id', '(none)'), 64));
        end if;
        v_problem := recipe.lot_usability_problem(p_content, v_cfg -> 'active' -> 'bomLine', l -> 'lot', v_now_us, v_markets);
        if v_problem is null and (l -> 'lot' -> 'identityTested') is distinct from 'true'::jsonb
           and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_markets) = 'array' then v_markets else '[]'::jsonb end) m where m <> '"IN"'::jsonb) then
          v_problem := format('lot %s has no identity-test result', l -> 'lot' ->> 'id');
        end if;
        if v_problem is not null then
          return format('%s whose %s (PR-18, IN-23, IN-24)', v_what, v_problem);
        end if;
        if (l -> 'assay') is distinct from tab.lot_assay_of(l -> 'lot' ->> 'id', p_batch) then
          return format('%s states for lot %s another assay than its current approved result (TB01-REGISTER; PR-19)', v_what, l -> 'lot' ->> 'id');
        end if;
        if (l -> 'assay' -> 'basis') is distinct from (v_cfg -> 'active' -> 'basis') then
          return format('%s uses a result of lot %s on the %s basis, where the MBR calculates on %s (TB01-BASIS; PR-19)', v_what, l -> 'lot' ->> 'id',
                        l -> 'assay' ->> 'basis', v_cfg -> 'active' ->> 'basis');
        end if;
      end loop;
      v_calc := tab.tb01_calculation(v_cfg, p_content, c -> 'lots');
      if v_calc ? 'problem' then
        return format('%s, a calculation that %s (PR-19, DI-33)', v_what, v_calc ->> 'problem');
      end if;
      v_want := v_calc -> 'data';
      if d is distinct from v_want then
        select m into v_member from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u where (d -> m) is distinct from (v_want -> m) order by m limit 1;
        return format('%s stores %s %s, where the calculation from its inputs gives %s (TB01-RECOMPUTE; PR-19, DI-33)', v_what, v_member,
                      left(coalesce((d -> v_member)::text, '(no such member)'), 400), left(coalesce((v_want -> v_member)::text, '(no such member)'), 400));
      end if;
      -- Beyond the MBR's adjustment cap the row raises POTENCY_ADJUSTMENT_CAP, holding the steps after it (review item 1).
      if jsonb_typeof(v_cfg -> 'adjustmentCapPercent') = 'string' and (d ->> 'adjustmentPercent')::numeric > (v_cfg ->> 'adjustmentCapPercent')::numeric
         and not tab.tb01_raised(p_old, p_new, e ->> 'stepKey', 'POTENCY_ADJUSTMENT_CAP', 'ACTION', true) then
        return format('%s adjusts the active by %s %%, beyond the MBR''s cap of %s %%, and the row raises no POTENCY_ADJUSTMENT_CAP holding the steps after it (PR-19, PR-04)',
                      v_what, d ->> 'adjustmentPercent', v_cfg ->> 'adjustmentCapPercent');
      end if;
      continue;
    end if;
    -- CONTAINER_WEIGHING
    select y.value -> 'data' into v_calc from jsonb_each(e0) y
     where y.value ->> 'stepKey' = e ->> 'stepKey' and y.value ->> 'kind' = 'POTENCY_CALCULATION'
     order by (y.value ->> 'recordedSeq')::numeric desc limit 1;
    if v_calc is null then
      return format('%s is dispensed before the step''s potency calculation (TB01-NO-CALCULATION; PR-19)', v_what);
    end if;
    v_line := c ->> 'bomLine';
    if v_line is distinct from (v_cfg -> 'active' ->> 'bomLine')
       and ((v_cfg -> 'compensation' ->> 'mode') is distinct from 'EXCIPIENT' or v_line is distinct from (v_cfg -> 'compensation' ->> 'bomLine')) then
      return format('%s dispenses %s, neither the active nor the compensating excipient of the step (TB01-BOM-LINE; PR-19)', v_what, coalesce(v_line, '(none)'));
    end if;
    if v_line = (v_cfg -> 'active' ->> 'bomLine')
           and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_calc -> 'lots') = 'array' then v_calc -> 'lots' else '[]'::jsonb end) z
                        where z -> 'lot' -> 'id' = c -> 'lot' -> 'id') then
      return format('%s dispenses the active from lot %s, which is not a lot of the governing calculation (TB01-LOT-NOT-CALCULATED; PR-19)', v_what, c -> 'lot' ->> 'id');
    end if;
    -- Each lot's approved result is still the one the calculation used (review item 2): a result QC superseded since
    -- stops the dispensing of the step.
    select z -> 'lot' ->> 'id' into v_member
      from jsonb_array_elements(case when jsonb_typeof(v_calc -> 'lots') = 'array' then v_calc -> 'lots' else '[]'::jsonb end) z
     where (z -> 'assay') is distinct from tab.lot_assay_of(z -> 'lot' ->> 'id', p_batch) limit 1;
    if v_member is not null then
      return format('%s is dispensed against a calculation whose approved result of lot %s has been superseded since; the targets no longer stand on the current result (TB01-RESULT-SUPERSEDED; PR-19, DI-33)',
                    v_what, v_member);
    end if;
    -- FEFO (PR-18).
    select coalesce(array_agg(distinct y.value -> 'data' -> 'lot' ->> 'id'), '{}') into v_used from jsonb_each(e0) y
     where y.value ->> 'stepKey' = e ->> 'stepKey' and y.value ->> 'kind' = 'CONTAINER_WEIGHING' and y.value -> 'data' ->> 'bomLine' = v_line;
    v_first := tab.tb01_first_expiring(p_batch, c -> 'lot' ->> 'material', v_used, v_now);
    v_need := not ((c -> 'lot' ->> 'id') = v_first or (c -> 'lot' ->> 'id') = any (v_used));
    if v_need and (jsonb_typeof(c -> 'fefoReason') is distinct from 'string' or btrim(c ->> 'fefoReason') = '') then
      return format('%s dispenses lot %s while lot %s of the same material expires first; another lot than the first-expiring one needs the dispenser''s reason (TB01-FEFO; PR-18)',
                    v_what, c -> 'lot' ->> 'id', coalesce(v_first, '(none usable)'));
    end if;
    if not v_need and c ? 'fefoReason' then
      return format('%s gives a reason for lot %s, which is the first-expiring usable lot or one already dispensed here: a reason is recorded only for another lot (TB01-FEFO; PR-18)',
                    v_what, c -> 'lot' ->> 'id');
    end if;
    if v_need and not tab.tb01_raised(p_old, p_new, e ->> 'stepKey', 'FEFO_OVERRIDE', 'ALERT', false) then
      return format('%s dispenses lot %s out of stock rotation and the row raises no FEFO_OVERRIDE for the rotation report (TB01-FEFO; PR-18)', v_what, c -> 'lot' ->> 'id');
    end if;
    -- The balance (IN-25 (b)).
    if not exists (select 1 from plant.instrument_use u join plant.equipment q on q.id = u.equipment_id
                    where q.code = c ->> 'balance' and u.batch_id = p_batch and u.planned_end > v_now) then
      return format('%s names balance %s, which has no instrument use for this batch open at this time: a balance is used only once calibrated with its check passed (TB01-INSTRUMENT; IN-25, PR-19)',
                    v_what, left(coalesce(c ->> 'balance', '(none)'), 64));
    end if;
    -- The consumption (INV-13, INV-14).
    if not v_gmp then
      if c ? 'consumption' then
        return format('%s names a lot consumption in a test run; test lots have no stock (TB01-CONSUMPTION; DI-05)', v_what);
      end if;
      continue;
    end if;
    if jsonb_typeof(c -> 'consumption') is distinct from 'string' then
      return format('%s names no consumption of lot %s: on GMP every dispensed container is consumed from the batch''s reservation in its own command (TB01-CONSUMPTION; INV-13, INV-14)',
                    v_what, c -> 'lot' ->> 'id');
    end if;
    select m.id into v_lot from site.material_lot m join recipe.stub_batch b on b.site = m.site_code where b.id = p_batch and m.lot_code = c -> 'lot' ->> 'id';
    select * into x from site.lot_consumption s where s.id = (c ->> 'consumption')::uuid;
    v_problem := case
      when x.id is null then 'names a consumption that does not exist'
      when x.batch_id is distinct from p_batch then 'names a consumption into another batch'
      when x.lot_id is distinct from v_lot then format('names a consumption of another lot than %s', c -> 'lot' ->> 'id')
      when x.xact_id is distinct from txid_current() then 'names a consumption made in another command'
      when tab.tb01_mass_in((d ->> 'net')::numeric, c ->> 'unit', x.unit) is distinct from x.quantity
        then format('names a consumption of %s %s, not of its net %s %s', x.quantity, x.unit, d ->> 'net', c ->> 'unit')
      when exists (select 1 from jsonb_each(e0) y where y.value -> 'data' ->> 'consumption' = c ->> 'consumption')
        or (select count(*) from jsonb_each(e1) y where y.value -> 'data' ->> 'consumption' = c ->> 'consumption') > 1
        then 'names a consumption another entry of the batch names'
    end;
    if v_problem is not null then
      return format('%s %s (TB01-CONSUMPTION; INV-13, INV-14)', v_what, v_problem);
    end if;
  end loop;
  return null;
end
$$;

-- INV-13, INV-14: the open reservation of lot p_lot_code for batch p_batch (at the batch's site) with at least p_value
-- p_unit left, converted to the lot's unit: {reservationId, quantity, unit, materialCode}; NULL when there is none. The
-- server reads it inside the command and consumes through recipe.consume_lot (recipe-core 0430), which checks it all again.
create function tab.tb01_reservation_for(p_batch uuid, p_lot_code text, p_value numeric, p_unit text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, site, recipe, pg_temp as $$
declare
  m     site.material_lot;
  v_qty numeric;
  v_id  uuid;
begin
  select l.* into m from site.material_lot l join recipe.stub_batch b on b.site = l.site_code where b.id = p_batch and l.lot_code = p_lot_code;
  if m.id is null then
    return null;
  end if;
  v_qty := case when p_unit = m.unit then p_value else tab.tb01_mass_in(p_value, p_unit, m.unit) end;
  if v_qty is null or v_qty <= 0 then
    return null;
  end if;
  select r.id into v_id from site.lot_reservation r
   where r.lot_id = m.id and r.batch_id = p_batch and site.reservation_is_open(r) and site.reservation_remaining(r.id) >= v_qty
   order by r.expires_at, r.reserved_at limit 1;
  if v_id is null then
    return null;
  end if;
  return jsonb_build_object('reservationId', v_id, 'quantity', v_qty::text, 'unit', m.unit, 'materialCode', m.material_code);
end
$$;

-- The row trigger (header). EBMR-EXE-240.
create function tab.tb01_entry_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
  v_content jsonb;
begin
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false))
     and not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'steps') = 'object' then new.state -> 'steps' else '{}'::jsonb end) x
                      where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and old.state -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS') then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_content := recipe.batch_mbr_content(new.batch_id);
  v_problem := coalesce(tab.tb01_entry_problem(new.batch_id, v_content, old.state, new.state, case when r.kind = 'COMMAND' then r.command else '{}'::jsonb end),
                        tab.tb01_close_problem(v_content, old.state, new.state));
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s row is refused: %s. [EBMR-EXE-240]', coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger ab_tb01_entry_guard after update on recipe.execution_state
  for each row execute function tab.tb01_entry_check();

revoke all on function tab.tb01_raised(jsonb, jsonb, text, text, text, boolean), tab.tb01_close_problem(jsonb, jsonb, jsonb) from public;
revoke all on function tab.tb01_first_expiring(uuid, text, text[], timestamptz), tab.tb01_mass_in(numeric, text, text),
                       tab.tb01_entry_problem(uuid, jsonb, jsonb, jsonb, jsonb), tab.tb01_entry_check() from public;
revoke all on function tab.tb01_reservation_for(uuid, text, numeric, text) from public;
grant execute on function tab.tb01_first_expiring(uuid, text, text[], timestamptz), tab.tb01_reservation_for(uuid, text, numeric, text) to ebmr_app;

reset role;
