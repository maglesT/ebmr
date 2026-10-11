-- Tablets: on GMP the approved assay result of a lot comes from LIMS-lite (Phase 3 slice 5a step 3; site services 0740;
-- backlog slice 3b open item; controls PR-19, DI-33, DI-37).
--
--   tab.lot_assay_source   insert-only: for each value of a GMP assay result (assay, water, lod, solvents), the
--                          LIMS-lite result it was copied from.
--   tab.record_lot_assay   replaced from its latest definition (0841): on GMP the values are named by LIMS result id
--                          ({assayResultId, waterResultId?, lodResultId?, solventsResultId?}); a typed value is refused;
--                          each result is current, QC-approved, passing, of the lot and of its test, in %; the value is
--                          copied and its source recorded (EBMR-EXE-606). The sandbox branch is unchanged.
--   tab.lot_assay_of       replaced from its latest definition (0841): on GMP a result is read only while it has an
--                          assay source and every source result is still approved (a revision drops the approval).
-- Nothing else changes. CREATE OR REPLACE keeps the owner and grants.

set local role ebmr_owner;

create table tab.lot_assay_source (
  assay_result_id  uuid not null references tab.lot_assay_result (id),
  value_kind       text not null check (value_kind in ('assay', 'water', 'lod', 'solvents')),
  lims_result_id   uuid not null references site.lot_test_result (id),
  recorded_at      timestamptz not null default clock_timestamp(),
  primary key (assay_result_id, value_kind)
);
revoke all on tab.lot_assay_source from public;
select platform.enforce_db_time('tab.lot_assay_source', array['recorded_at']);
select kernel.register_audited_table('tab.lot_assay_source', 'lot_assay_result', 'assay_result_id', true);
grant select on tab.lot_assay_source to ebmr_app;

-- As 0841_lot_assay_results.sql; on GMP the values from approved LIMS-lite results (header).
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
  if v_basis is null or v_basis not in ('AS_IS', 'ANHYDROUS_WATER', 'DRIED_LOD', 'ANHYDROUS_SOLVENT_FREE') then
    raise exception using errcode = 'P0001', message = 'An assay result states the basis it is reported on: AS_IS, ANHYDROUS_WATER, DRIED_LOD or ANHYDROUS_SOLVENT_FREE (PR-19). [EBMR-EXE-242]';
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
        if lr.id is null or lr.lot_id <> v_lot or lr.verdict <> 'PASS' or site.lot_test_state(lr.id) <> 'APPROVED' or lr.unit <> '%'
           or lr.test_code <> (case m when 'assay' then 'ASSAY' when 'water' then 'WATER' when 'lod' then 'LOD' else 'RESIDUAL_SOLVENTS' end) then
          raise exception using errcode = 'P0001',
            message = format('The %s of an assay result on GMP is a current, QC-approved, passing %s result of lot %s in %% (PR-19, DI-33, DI-37). [EBMR-EXE-606]',
                             m, case m when 'assay' then 'ASSAY' when 'water' then 'WATER' when 'lod' then 'LOD' else 'RESIDUAL_SOLVENTS' end, left(p_lot_code, 64));
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

-- As 0841_lot_assay_results.sql; on GMP only while the LIMS sources stay approved (header).
create or replace function tab.lot_assay_of(p_code text, p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, site, recipe, kernel, pg_temp as $$
declare
  v_site text;
  r      tab.lot_assay_result;
begin
  if kernel.installation_kind() = 'SANDBOX' then
    select x.* into r from tab.lot_assay_result x
     where x.sandbox_lot_code = p_code and not exists (select 1 from tab.lot_assay_result n where n.supersedes = x.id);
  else
    select b.site into v_site from recipe.stub_batch b where b.id = p_batch;
    select x.* into r from tab.lot_assay_result x join site.material_lot l on l.id = x.material_lot_id
     where l.site_code = v_site and l.lot_code = p_code and not exists (select 1 from tab.lot_assay_result n where n.supersedes = x.id);
  end if;
  if r.id is null then
    return null;
  end if;
  -- GMP (slice 5a): only a result whose values came from LIMS-lite results that are still current and approved (a
  -- revision drops the approval, so the result stops being usable until QC records the assay again; DI-37).
  if kernel.installation_kind() <> 'SANDBOX'
     and (not exists (select 1 from tab.lot_assay_source s where s.assay_result_id = r.id and s.value_kind = 'assay')
          or exists (select 1 from tab.lot_assay_source s where s.assay_result_id = r.id and site.lot_test_state(s.lims_result_id) is distinct from 'APPROVED')) then
    return null;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('resultId', r.id::text, 'basis', r.basis, 'assay', r.assay::text, 'water', r.water::text,
                                              'lod', r.lod::text, 'solvents', r.solvents::text));
end
$$;

reset role;
