-- Tablets server, Phase 3 slice 3b (builder A; TB-01): the potency calculation of a TB-01 step in the database, so that
-- a recorded target is recomputed from its inputs and refused when it differs (controls PR-19, DI-33, PR-04; tablets
-- spec C-01 as-is assay, C-02 salt-to-base factor, C-03 potency-adjusted quantity, C-04 compensating excipient; ADR 0012).
--
-- The arithmetic is src/blocks/dispensing/potency.ts in numeric, exactly: every intermediate is a quotient of two exact
-- numerics (products, sums and differences of the decimals written in the MBR and the lot results; never a division
-- result carried on), and a value is written only by an integer quotient (div(), which truncates exactly):
--   * a target of an active: UP to a multiple of the readability the MBR declares (never below the calculated quantity:
--     the active is never formulated below 100 % of its label claim, 211.101(a));
--   * the compensating excipient and the totals: to the nearest multiple, half away from zero;
--   * a calculated value shown: at six decimals, half away from zero (display only);
--   * the as-is assay and a base-equivalent: exact, without trailing zeros (trim_scale).
-- tab.tb01_calculation(config, content, lots, marketSet, now) returns {"data": <the data the block stores>} or
-- {"problem": <why the block refuses it>}; the entry guard (0843) compares the stored data with it member for member.
--
-- New functions are owned by ebmr_owner and private to the owner; every function pins its search_path with pg_temp
-- last. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- n / d (d > 0) rounded to a multiple of p_step (> 0): UP (ceiling; n >= 0) or HALF_UP (half away from zero), written
-- at the scale of p_step (k x step, as numeric multiplication writes it).
create function tab.tb01_round(p_n numeric, p_d numeric, p_step numeric, p_mode text) returns numeric
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_den numeric := p_d * p_step;
  v_a   numeric := abs(p_n);
  v_k   numeric;
begin
  if p_d <= 0 or p_step <= 0 then
    raise exception using errcode = 'P0001', message = 'tab.tb01_round: a positive denominator and step';
  end if;
  if p_mode = 'UP' then
    v_k := div(v_a, v_den);
    if v_a - v_k * v_den > 0 then
      v_k := v_k + 1;
    end if;
  else
    v_k := div(2 * v_a + v_den, 2 * v_den);
  end if;
  return (case when p_n < 0 then -v_k else v_k end) * p_step;
end
$$;

-- Six decimals, half away from zero (display only).
create function tab.tb01_show(p_n numeric, p_d numeric) returns text
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select tab.tb01_round(p_n, p_d, 0.000001, 'HALF_UP')::text
$$;

-- C-01: the as-is assay of result p_assay ({basis, assay, water?, lod?, solvents?}), or NULL with p_problem set.
create function tab.tb01_as_is(p_assay jsonb, out p_value numeric, out p_problem text)
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  a numeric := (p_assay ->> 'assay')::numeric;
  b text := p_assay ->> 'basis';
begin
  if b in ('ANHYDROUS_WATER', 'ANHYDROUS_SOLVENT_FREE') and not (p_assay ? 'water') then
    p_problem := 'the water result its basis needs is missing';
  elsif b = 'DRIED_LOD' and not (p_assay ? 'lod') then
    p_problem := 'the loss on drying result its basis needs is missing';
  elsif b = 'ANHYDROUS_SOLVENT_FREE' and not (p_assay ? 'solvents') then
    p_problem := 'the solvents result its basis needs is missing';
  end if;
  if p_problem is not null then
    return;
  end if;
  p_value := case b
    when 'AS_IS' then a
    when 'ANHYDROUS_WATER' then a * (100 - (p_assay ->> 'water')::numeric) / 100
    when 'DRIED_LOD' then a * (100 - (p_assay ->> 'lod')::numeric) / 100
    when 'ANHYDROUS_SOLVENT_FREE' then a * (100 - (p_assay ->> 'water')::numeric - (p_assay ->> 'solvents')::numeric) / 100
  end;
  if p_value is null or p_value <= 0 or p_value > 200 then
    p_problem := format('the as-is assay %s %% is not a usable assay (above 0 and at most 200 %%)', coalesce(trim_scale(p_value)::text, '(none)'));
    p_value := null;
  end if;
end
$$;

-- PR-19, DI-33, PR-04 (header): the data a POTENCY_CALCULATION entry of a TB-01 step configured with p_cfg stores,
-- from the lots p_lots sent ([{lot, assay, baseEquivalent?}]) and the BOM of MBR content p_content; or why the block
-- refuses it: the lots exactly as sent, each lot's results beside them by lot, the standard, the compensating excipient
-- and the totals. src/blocks/tb-01.ts acceptCalculation and calculationData; potency.ts potencyTargets.
create function tab.tb01_calculation(p_cfg jsonb, p_content jsonb, p_lots jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_active   jsonb := case when jsonb_typeof(p_cfg -> 'active') = 'object' then p_cfg -> 'active' else '{}'::jsonb end;
  v_comp     jsonb := case when jsonb_typeof(p_cfg -> 'compensation') = 'object' then p_cfg -> 'compensation' else '{}'::jsonb end;
  v_bom      jsonb := case when jsonb_typeof(p_content -> 'bom') = 'array' then p_content -> 'bom' else '[]'::jsonb end;
  v_line     jsonb;
  v_exc      jsonb;
  v_step     numeric := (p_cfg ->> 'readability')::numeric;
  v_over     text := coalesce(v_active ->> 'overagePercent', '0');
  v_form     boolean := (v_active ->> 'standardIs') = 'BASE' and jsonb_typeof(v_active -> 'form') = 'object';
  v_fn       numeric;            -- salt-to-base factor f = v_fn / v_fd
  v_fd       numeric;
  v_need     numeric;            -- base-equivalent the batch needs (exact)
  v_n        integer := case when jsonb_typeof(p_lots) = 'array' then jsonb_array_length(p_lots) else 0 end;
  v_max      numeric := case when jsonb_typeof(v_active -> 'maxLots') = 'number' then (v_active ->> 'maxLots')::numeric else 3 end;
  v_shares   numeric[] := '{}';
  v_sum      numeric := 0;
  l          jsonb;
  i          integer;
  v_asis     numeric;
  v_problem  text;
  v_sn       numeric := 0;       -- sum of the adjusted quantities: v_sn / v_sd
  v_sd       numeric := 1;
  v_an       numeric;
  v_ad       numeric;
  v_target   numeric;
  v_targets  numeric := 0;
  v_lots     jsonb := '[]'::jsonb;
  v_dn       numeric;
  v_dd       numeric;
  v_dtarget  numeric;
  v_excdata  jsonb := 'null'::jsonb;
  v_tn       numeric;
  v_td       numeric;
begin
  -- Fail closed on a configuration the block's schema and checks refuse (review item 5).
  if (v_active ->> 'standardIs') is null or (v_active ->> 'standardIs') not in ('BASE', 'FORM') or (v_active ->> 'basis') is null then
    return jsonb_build_object('problem', 'is made at a step whose configuration states no standard basis (BASE or FORM) or assay basis');
  end if;
  if (v_comp ->> 'mode') is distinct from 'NONE' and ((v_comp ->> 'mode') is distinct from 'EXCIPIENT' or jsonb_typeof(v_comp -> 'min') is distinct from 'string'
     or jsonb_typeof(v_comp -> 'max') is distinct from 'string' or jsonb_typeof(v_comp -> 'bomLine') is distinct from 'string') then
    return jsonb_build_object('problem', 'is made at a step whose compensation states no mode NONE, or no excipient line with its approved range (TB01-EXCIPIENT-RANGE)');
  end if;
  if (v_active ->> 'standardIs') = 'BASE' and jsonb_typeof(v_active -> 'form') is distinct from 'object' then
    return jsonb_build_object('problem', 'is made on a base standard without the declared form (TB01-FORM)');
  end if;
  if (select count(distinct z -> 'lot' ->> 'id') from jsonb_array_elements(case when jsonb_typeof(p_lots) = 'array' then p_lots else '[]'::jsonb end) z)
     is distinct from v_n::bigint then
    return jsonb_build_object('problem', 'names a lot twice, or a lot without an id (TB01-LOTS)');
  end if;
  select b into v_line from jsonb_array_elements(v_bom) b where b ->> 'id' = v_active ->> 'bomLine' limit 1;
  if v_line is null then
    return jsonb_build_object('problem', format('names the active %s, which is no BOM line of the MBR', coalesce(v_active ->> 'bomLine', '(none)')));
  end if;
  if v_n < 1 or v_n > 3 or v_n > v_max then
    return jsonb_build_object('problem', format('allocates the active across %s lots, where the MBR allows 1 to %s (TB01-LOTS)', v_n, least(v_max, 3)));
  end if;
  if v_step is null or v_step <= 0 then
    return jsonb_build_object('problem', 'has no positive readability (TB01-READABILITY)');
  end if;
  if v_form then
    v_fn := (v_active -> 'form' ->> 'molarMassForm')::numeric;
    v_fd := (v_active -> 'form' ->> 'baseMoieties')::numeric * (v_active -> 'form' ->> 'molarMassBase')::numeric;
  else
    v_fn := 1;
    v_fd := 1;
  end if;
  v_need := (v_line -> 'quantity' ->> 'value')::numeric * (100 + v_over::numeric) / 100;
  -- Allocation: one lot carries the whole need; with more lots, each states a positive share and the shares add up.
  for i in 0 .. v_n - 1 loop
    l := p_lots -> i;
    if v_n = 1 then
      if l ? 'baseEquivalent' and (l ->> 'baseEquivalent')::numeric <> v_need then
        return jsonb_build_object('problem', format('gives the one lot a base-equivalent of %s, not the whole %s (TB01-ALLOCATION)', l ->> 'baseEquivalent', trim_scale(v_need)));
      end if;
      v_shares := v_shares || v_need;
    else
      if not (l ? 'baseEquivalent') or (l ->> 'baseEquivalent')::numeric <= 0 then
        return jsonb_build_object('problem', format('gives lot %s no positive base-equivalent share (TB01-ALLOCATION)', i + 1));
      end if;
      v_shares := v_shares || (l ->> 'baseEquivalent')::numeric;
      v_sum := v_sum + (l ->> 'baseEquivalent')::numeric;
    end if;
  end loop;
  if v_n > 1 and v_sum <> v_need then
    return jsonb_build_object('problem', format('gives the lots base-equivalent shares that add up to %s, not to the %s the batch needs (TB01-ALLOCATION)', trim_scale(v_sum), trim_scale(v_need)));
  end if;
  -- C-03 per lot: Q_act,i = b_i x f x 100 / A_asis,i = (b_i x fn x 100) / (fd x A_asis,i).
  for i in 0 .. v_n - 1 loop
    l := p_lots -> i;
    select x.p_value, x.p_problem into v_asis, v_problem from tab.tb01_as_is(l -> 'assay') x;
    if v_problem is not null then
      return jsonb_build_object('problem', format('cannot be made for lot %s: %s (TB01-ASSAY)', i + 1, v_problem));
    end if;
    v_an := v_shares[i + 1] * v_fn * 100;
    v_ad := v_fd * v_asis;
    v_target := tab.tb01_round(v_an, v_ad, v_step, 'UP');
    v_targets := v_targets + v_target;
    v_sn := v_sn * v_ad + v_an * v_sd;
    v_sd := v_sd * v_ad;
    v_lots := v_lots || jsonb_build_array(jsonb_build_object(
      'lot', l -> 'lot' -> 'id', 'asIsAssay', trim_scale(v_asis)::text, 'baseEquivalent', trim_scale(v_shares[i + 1])::text,
      'calculated', tab.tb01_show(v_an, v_ad), 'target', v_target::text));
  end loop;
  -- Q_std = need x f = (need x fn) / fd.
  v_tn := v_need * v_fn;
  v_td := v_fd;
  if (v_comp ->> 'mode') = 'EXCIPIENT' then
    select b into v_exc from jsonb_array_elements(v_bom) b where b ->> 'id' = v_comp ->> 'bomLine' limit 1;
    if v_exc is null then
      return jsonb_build_object('problem', format('names the compensating excipient %s, which is no BOM line of the MBR', coalesce(v_comp ->> 'bomLine', '(none)')));
    end if;
    -- C-04: Q_dil = Q_dil,std - (sum Q_act - Q_std) = (dstd x sd x fd - sn x fd + tn x sd) / (sd x fd).
    v_dn := (v_exc -> 'quantity' ->> 'value')::numeric * v_sd * v_td - v_sn * v_td + v_tn * v_sd;
    v_dd := v_sd * v_td;
    v_dtarget := tab.tb01_round(v_dn, v_dd, v_step, 'HALF_UP');
    if v_dtarget < 0 then
      return jsonb_build_object('problem', format('would bring the compensating excipient to %s, below zero (TB01-EXCIPIENT-NEGATIVE)', v_dtarget));
    end if;
    if v_dtarget < (v_comp ->> 'min')::numeric or v_dtarget > (v_comp ->> 'max')::numeric then
      return jsonb_build_object('problem', format('would bring the compensating excipient to %s, outside its approved range %s to %s (TB01-EXCIPIENT-RANGE)',
                                                  v_dtarget, v_comp ->> 'min', v_comp ->> 'max'));
    end if;
    v_excdata := jsonb_build_object('bomLine', v_comp -> 'bomLine', 'standard', v_exc -> 'quantity' -> 'value', 'calculated', tab.tb01_show(v_dn, v_dd),
                                    'target', v_dtarget::text);
    v_targets := v_targets + v_dtarget;
  end if;
  return jsonb_build_object('data', jsonb_build_object(
    'lots', p_lots,
    'results', v_lots,
    'active', jsonb_build_object('bomLine', v_active -> 'bomLine', 'standardQuantity', v_line -> 'quantity' -> 'value', 'unit', v_line -> 'quantity' -> 'unit',
                                 'standardIs', case when (v_active ->> 'standardIs') = 'FORM' then 'FORM' else 'BASE' end, 'overagePercent', v_over,
                                 'factor', tab.tb01_show(v_fn, v_fd), 'standard', tab.tb01_show(v_tn, v_td)),
    'excipient', v_excdata,
    'total', jsonb_build_object(
               'standard', case when v_excdata = 'null'::jsonb then tab.tb01_show(v_tn, v_td)
                                else tab.tb01_show(v_tn + (v_exc -> 'quantity' ->> 'value')::numeric * v_td, v_td) end,
               'target', tab.tb01_round(v_targets, 1, v_step, 'HALF_UP')::text),
    -- |sum Q_act - Q_std| / Q_std x 100 = |sn x td - tn x sd| x 100 / (sd x tn)
    'adjustmentPercent', tab.tb01_show(abs(v_sn * v_td - v_tn * v_sd) * 100, v_sd * v_tn),
    'readability', p_cfg -> 'readability',
    'formula', 'TB-01@1'));
end
$$;

revoke all on function tab.tb01_round(numeric, numeric, numeric, text), tab.tb01_show(numeric, numeric), tab.tb01_as_is(jsonb),
                       tab.tb01_calculation(jsonb, jsonb, jsonb) from public;

reset role;
