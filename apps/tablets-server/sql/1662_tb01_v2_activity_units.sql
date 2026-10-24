-- Tablets server, Phase 7 slice 7q (requirement R8, capability C2; decision D-7q-4): TB-01@2, potency adjustment in
-- enzyme activity units (U/mg) beside the percent assays of TB-01@1 (controls PR-19, PR-04, DI-33; ADR 0010: a released
-- block version never changes, so the new basis is a new version; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
-- Handbook: modules/tablets-server.md
--
-- An enzyme (fungal diastase, papain) is labelled by its activity, not by a percent assay. The lot's approved result is
-- its activity in U/mg (from LIMS on GMP, the ACTIVITY test in U/mg; in the sandbox a test lot's typed value), the MBR
-- states the activity its standard quantity is at (config active.declaredActivity, with the standard on the material,
-- standardIs FORM), and a lot of activity A takes standard x declared / A; the compensating excipient, the roundings
-- and the totals are TB-01@1's. Every value is computed exactly in numeric, as src/blocks/dispensing/potency.ts does.
--
--   * recipe.block_data_schema: TB-01@2's entries, TB-01@1's with ACTIVITY among the assay bases of POTENCY_CALCULATION;
--     recipe.block_signature_meaning: TB-01@2 is checked with CONTAINER_CHECKED, as TB-01@1; recipe.engine_name: the rule
--     code TB01-ACTIVITY.
--   * tab.lot_assay_result: the basis ACTIVITY, its assay (the activity) above 0 with no upper bound; a percent assay
--     stays above 0 and at most 200.
--   * tab.record_lot_assay (CREATE OR REPLACE from 1001): the basis ACTIVITY; on GMP its assay is a current, QC-approved,
--     passing ACTIVITY result of the lot in U/mg.
--   * tab.tb01_calculation (CREATE OR REPLACE from 0842): an ACTIVITY lot: Q = b x f x declared / A (UP to the
--     readability), its asIsAssay its activity relative to the declared one (percent, six decimals) and its activity
--     (exact); the active carries the declared activity and the label claim of the batch in units (the standard with its
--     overage x mg per BOM unit x the declared activity, exact); the formula TB-01@2. A configuration on the ACTIVITY
--     basis without a positive declared activity, a FORM standard and a mass unit is refused (TB01-ACTIVITY). The entry
--     guard (0843) compares the stored data with it member for member, for TB-01@1 and TB-01@2 steps alike.
--
-- Messages: EBMR-EXE-242 and EBMR-EXE-606 (as 1001). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1662_tb01_v2_activity_units)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block version TB-01@2 (potency adjustment in enzyme activity units) in the registers every entry is checked against (PR-19, DI-30)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema)
select 'TB-01', '2', part, entry_kind,
       case entry_kind
         when 'POTENCY_CALCULATION'
           then jsonb_set(schema, '{fields,lots,items,fields,assay,fields,basis,enum}', '["AS_IS", "ANHYDROUS_WATER", "DRIED_LOD", "ANHYDROUS_SOLVENT_FREE", "ACTIVITY"]'::jsonb)
         else schema end
  from recipe.block_data_schema where block_type = 'TB-01' and block_version = '1';

insert into recipe.block_signature_meaning (block_type, block_version, part, meaning_code) values ('TB-01', '2', 'check', 'CONTAINER_CHECKED');

insert into recipe.engine_name (name, kind) values ('TB01-ACTIVITY', 'RULE_CODE');

select kernel.set_actor_context(null);

alter table tab.lot_assay_result drop constraint lot_assay_result_basis_check;
alter table tab.lot_assay_result add constraint lot_assay_result_basis_check check (basis in ('AS_IS', 'ANHYDROUS_WATER', 'DRIED_LOD', 'ANHYDROUS_SOLVENT_FREE', 'ACTIVITY'));
alter table tab.lot_assay_result drop constraint lot_assay_result_assay_check;
alter table tab.lot_assay_result add constraint lot_assay_result_assay_check check (assay > 0 and (basis = 'ACTIVITY' or assay <= 200));

-- As 1001, with the ACTIVITY basis: the assay is the lot's enzyme activity in U/mg, on GMP from an approved ACTIVITY result in
-- U/mg (header).
create or replace function tab.record_lot_assay(p_lot_code text, p_site text, p_result jsonb, p_reason text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, site, iam, kernel, sandbox, pg_temp as $$
declare
  v_sandbox boolean := kernel.installation_kind() = 'SANDBOX';
  v_actor   jsonb;
  v_lot     uuid;
  v_code    text;
  v_current uuid;
  v_basis   text := p_result ->> 'basis';
  v_id      uuid;
  m         text;
  v_src     jsonb := '{}'::jsonb;
  v_vals    jsonb;
  lr        site.lot_test_result;
begin
  perform iam.assert_not_administrator();
  if jsonb_typeof(p_result) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'An assay result states its basis, its values and its certificate reference (PR-19). [EBMR-EXE-242]';
  end if;
  if v_sandbox then
    v_actor := iam.require_permission('MASTERDATA.CHANGE', iam.actor_location_scope());
    select l.lot_code into v_code from tab.sandbox_lot l where l.lot_code = p_lot_code;
    if v_code is null then
      raise exception using errcode = 'P0001', message = format('Lot %s is not a registered test lot (PR-19). [EBMR-EXE-242]', left(coalesce(p_lot_code, '(none)'), 64));
    end if;
    select r.id into v_current from tab.lot_assay_result r
     where r.sandbox_lot_code = v_code and not exists (select 1 from tab.lot_assay_result n where n.supersedes = r.id);
  else
    select l.id into v_lot from site.material_lot l where l.site_code = p_site and l.lot_code = p_lot_code;
    if v_lot is null then
      raise exception using errcode = 'P0001', message = format('Lot %s is not a material lot of site %s (PR-19). [EBMR-EXE-242]', left(coalesce(p_lot_code, '(none)'), 64), left(coalesce(p_site, '(none)'), 16));
    end if;
    v_actor := iam.require_permission('QC.RESULT_RECORD', jsonb_build_object('site', p_site));
    select r.id into v_current from tab.lot_assay_result r
     where r.material_lot_id = v_lot and not exists (select 1 from tab.lot_assay_result n where n.supersedes = r.id);
  end if;
  if v_basis is null or v_basis not in ('AS_IS', 'ANHYDROUS_WATER', 'DRIED_LOD', 'ANHYDROUS_SOLVENT_FREE', 'ACTIVITY') then
    raise exception using errcode = 'P0001', message = 'An assay result states the basis it is reported on: AS_IS, ANHYDROUS_WATER, DRIED_LOD, ANHYDROUS_SOLVENT_FREE or ACTIVITY (an enzyme activity in U/mg) (PR-19). [EBMR-EXE-242]';
  end if;
  -- GMP (slice 5a, PR-19, DI-33): the values come from approved LIMS-lite results of this lot, named by id; a typed value
  -- is refused. Each named result is current, approved by QC, passing, of this lot, of the test the value is (ASSAY,
  -- WATER, LOD, RESIDUAL_SOLVENTS) and in % w/w; its value is copied.
  if not v_sandbox then
    if p_result ?| array['assay', 'water', 'lod', 'solvents'] then
      raise exception using errcode = 'P0001',
        message = 'On a GMP installation the assay, water, loss-on-drying and solvent values come from approved LIMS results of the lot, named by id; a typed value is refused (PR-19, DI-33). [EBMR-EXE-606]';
    end if;
    v_vals := '{}'::jsonb;
    foreach m in array array['assay', 'water', 'lod', 'solvents'] loop
      if p_result ? (m || 'ResultId') then
        lr := null;
        if coalesce(p_result ->> (m || 'ResultId'), '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          select x.* into lr from site.lot_test_result x where x.id = (p_result ->> (m || 'ResultId'))::uuid;
        end if;
        -- Slice 7q (C2): the ACTIVITY basis takes the lot's ACTIVITY result in U/mg as its assay.
        if lr.id is null or lr.lot_id <> v_lot or lr.verdict <> 'PASS' or site.lot_test_state(lr.id) <> 'APPROVED'
           or lr.unit <> (case when m = 'assay' and v_basis = 'ACTIVITY' then 'U/mg' else '%' end)
           or lr.test_code <> (case m when 'assay' then case when v_basis = 'ACTIVITY' then 'ACTIVITY' else 'ASSAY' end when 'water' then 'WATER' when 'lod' then 'LOD' else 'RESIDUAL_SOLVENTS' end) then
          raise exception using errcode = 'P0001',
            message = format('The %s of an assay result on GMP is a current, QC-approved, passing %s result of lot %s in %s (PR-19, DI-33, DI-37). [EBMR-EXE-606]',
                             m, case m when 'assay' then case when v_basis = 'ACTIVITY' then 'ACTIVITY' else 'ASSAY' end when 'water' then 'WATER' when 'lod' then 'LOD' else 'RESIDUAL_SOLVENTS' end, left(p_lot_code, 64),
                             case when m = 'assay' and v_basis = 'ACTIVITY' then 'U/mg' else '%' end);
        end if;
        v_vals := v_vals || jsonb_build_object(m, trim_scale(lr.result_value)::text);
        v_src := v_src || jsonb_build_object(m, lr.id);
      end if;
    end loop;
    p_result := (p_result - array['assayResultId', 'waterResultId', 'lodResultId', 'solventsResultId']) || v_vals;
  end if;
  foreach m in array array['assay', 'water', 'lod', 'solvents'] loop
    if p_result ? m and (jsonb_typeof(p_result -> m) is distinct from 'string' or (p_result ->> m) !~ '^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$') then
      raise exception using errcode = 'P0001', message = format('The %s of an assay result is a decimal written as text, e.g. "99.2" (PR-19, DI-33). [EBMR-EXE-242]', m);
    end if;
  end loop;
  if (p_result ? 'water') <> (v_basis in ('ANHYDROUS_WATER', 'ANHYDROUS_SOLVENT_FREE')) or (p_result ? 'lod') <> (v_basis = 'DRIED_LOD')
     or (p_result ? 'solvents') <> (v_basis = 'ANHYDROUS_SOLVENT_FREE') or not (p_result ? 'assay') then
    raise exception using errcode = 'P0001',
      message = format('An assay result on the %s basis states exactly the values that basis needs (assay%s) (PR-19, C-01). [EBMR-EXE-242]', v_basis,
                       case v_basis when 'ANHYDROUS_WATER' then ', water' when 'DRIED_LOD' then ', loss on drying' when 'ANHYDROUS_SOLVENT_FREE' then ', water, residual solvents' else '' end);
  end if;
  if (v_current is null) <> (p_reason is null) then
    raise exception using errcode = 'P0001', message = case when v_current is null
      then 'The lot has no result yet: a first result is recorded without a superseding reason (DI-33). [EBMR-EXE-242]'
      else 'The lot has a current result: a new one supersedes it with your own reason, and the earlier result stays visible (DI-22, DI-33). [EBMR-EXE-242]' end;
  end if;
  insert into tab.lot_assay_result (material_lot_id, sandbox_lot_code, basis, assay, water, lod, solvents, certificate_ref, supersedes, reason,
                                    recorded_by_person, recorded_by_account, correlation_id)
  values (v_lot, v_code, v_basis, (p_result ->> 'assay')::numeric, (p_result ->> 'water')::numeric, (p_result ->> 'lod')::numeric,
          (p_result ->> 'solvents')::numeric, p_result ->> 'certificateRef', v_current, p_reason,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  insert into tab.lot_assay_source (assay_result_id, value_kind, lims_result_id)
  select v_id, k, (v_src ->> k)::uuid from jsonb_object_keys(v_src) k;
  return v_id;
end
$$;


-- As 0842, with the ACTIVITY basis of TB-01@2 (header).
create or replace function tab.tb01_calculation(p_cfg jsonb, p_content jsonb, p_lots jsonb) returns jsonb
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
  v_activity boolean := (v_active ->> 'basis') = 'ACTIVITY';
  v_decl     numeric;
  v_mgper    numeric;
  v_act      numeric;
  v_actdata  jsonb := '{}'::jsonb;
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
  -- Slice 7q (TB-01@2): an active judged by its activity states the activity its standard is at, on the material itself.
  if v_activity then
    v_mgper := case v_line -> 'quantity' ->> 'unit' when 'kg' then 1000000 when 'g' then 1000 when 'mg' then 1 end;
    if jsonb_typeof(v_active -> 'declaredActivity') is distinct from 'string' or (v_active ->> 'standardIs') <> 'FORM' or v_mgper is null
       or (v_active ->> 'declaredActivity') !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' or (v_active ->> 'declaredActivity')::numeric <= 0 then
      return jsonb_build_object('problem', 'is made on the ACTIVITY basis without a positive declared activity, a standard on the material (FORM) and a mass unit kg, g or mg (TB01-ACTIVITY)');
    end if;
    v_decl := (v_active ->> 'declaredActivity')::numeric;
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
    if (l -> 'assay' ->> 'basis') = 'ACTIVITY' then
      -- TB-01@2: Q_act,i = b_i x f x declared / A_i = (b_i x fn x declared) / (fd x A_i).
      if not v_activity then
        return jsonb_build_object('problem', format('cannot be made for lot %s: it reports an activity, but the step declares no activity its standard is stated at (TB01-ACTIVITY)', i + 1));
      end if;
      v_act := (l -> 'assay' ->> 'assay')::numeric;
      if v_act is null or v_act <= 0 then
        return jsonb_build_object('problem', format('cannot be made for lot %s: the activity %s U/mg is not a usable activity (above 0) (TB01-ASSAY)', i + 1, coalesce(l -> 'assay' ->> 'assay', '(none)')));
      end if;
      v_an := v_shares[i + 1] * v_fn * v_decl;
      v_ad := v_fd * v_act;
      v_actdata := jsonb_build_object('activity', trim_scale(v_act)::text);
      v_asis := null;
    else
      select x.p_value, x.p_problem into v_asis, v_problem from tab.tb01_as_is(l -> 'assay') x;
      if v_problem is not null then
        return jsonb_build_object('problem', format('cannot be made for lot %s: %s (TB01-ASSAY)', i + 1, v_problem));
      end if;
      v_an := v_shares[i + 1] * v_fn * 100;
      v_ad := v_fd * v_asis;
      v_actdata := '{}'::jsonb;
    end if;
    v_target := tab.tb01_round(v_an, v_ad, v_step, 'UP');
    v_targets := v_targets + v_target;
    v_sn := v_sn * v_ad + v_an * v_sd;
    v_sd := v_sd * v_ad;
    v_lots := v_lots || jsonb_build_array(jsonb_build_object(
      'lot', l -> 'lot' -> 'id',
      'asIsAssay', case when v_asis is null then tab.tb01_show(v_act * 100, v_decl) else trim_scale(v_asis)::text end,
      'baseEquivalent', trim_scale(v_shares[i + 1])::text,
      'calculated', tab.tb01_show(v_an, v_ad), 'target', v_target::text) || v_actdata);
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
                                 'factor', tab.tb01_show(v_fn, v_fd), 'standard', tab.tb01_show(v_tn, v_td))
              || case when v_activity then jsonb_build_object('activity', jsonb_build_object('declared', v_active ->> 'declaredActivity', 'unit', 'U/mg',
                                                                                     'labelClaimUnits', trim_scale(v_need * v_mgper * v_decl)::text))
                      else '{}'::jsonb end,
    'excipient', v_excdata,
    'total', jsonb_build_object(
               'standard', case when v_excdata = 'null'::jsonb then tab.tb01_show(v_tn, v_td)
                                else tab.tb01_show(v_tn + (v_exc -> 'quantity' ->> 'value')::numeric * v_td, v_td) end,
               'target', tab.tb01_round(v_targets, 1, v_step, 'HALF_UP')::text),
    -- |sum Q_act - Q_std| / Q_std x 100 = |sn x td - tn x sd| x 100 / (sd x tn)
    'adjustmentPercent', tab.tb01_show(abs(v_sn * v_td - v_tn * v_sd) * 100, v_sd * v_tn),
    'readability', p_cfg -> 'readability',
    'formula', case when v_activity then 'TB-01@2' else 'TB-01@1' end));
end
$$;

reset role;
