-- Tablets server, Phase 3 slice 3b (builder A; TB-01): the approved assay result of a lot, which a potency-adjusted
-- dispensing reads at the moment of use instead of a typed value (controls PR-19, DI-33, DI-05; tablets spec TB-01
-- "lot values are pulled from approved result fields; typed values are impossible; a missing value blocks"; ADR 0012:
-- the rules hold when the application's own database credentials are used directly).
--
--   tab.lot_assay_result  insert-only, audited: one approved result of one lot: the basis it is reported on (as-is,
--                         anhydrous with water, dried with loss on drying, anhydrous and solvent-free), the assay and
--                         the water, loss-on-drying and residual-solvent results that basis needs, each % w/w as the
--                         certificate states it (decimal, its written scale kept), and the certificate or LIMS
--                         reference. A lot of this installation's register only: a material lot of the site register
--                         on GMP (site.material_lot), a TEST- lot in the sandbox (tab.sandbox_lot), never both. A
--                         later result supersedes the current one with the person's own reason; nothing is updated,
--                         so the earlier result stays visible (DI-33).
--   tab.record_lot_assay  the one writer: on GMP a QC.RESULT_RECORD holder at the lot's site (the quality unit's
--                         approved result; LIMS-lite and its own approval arrive with slice 5), in the sandbox a
--                         MASTERDATA.CHANGE holder (test data, as tab.register_sandbox_lot). Never an administrator.
--                         The results its basis needs are present and no other (a missing value blocks here already).
--   tab.lot_assay_of      the current result of lot p_code as batch p_batch reads it (the batch's site on GMP), as the
--                         block takes it: {resultId, basis, assay, water?, lod?, solvents?} with decimals as text.
--
-- Messages: EBMR-EXE-242. Privileges: the application role SELECTs the table and EXECUTEs the two functions.

set local role ebmr_owner;

create table tab.lot_assay_result (
  id                  uuid primary key default gen_random_uuid(),
  material_lot_id     uuid references site.material_lot (id),
  sandbox_lot_code    text references tab.sandbox_lot (lot_code),
  basis               text not null check (basis in ('AS_IS', 'ANHYDROUS_WATER', 'DRIED_LOD', 'ANHYDROUS_SOLVENT_FREE')),
  assay               numeric not null check (assay > 0 and assay <= 200),
  water               numeric check (water >= 0 and water < 100),
  lod                 numeric check (lod >= 0 and lod < 100),
  solvents            numeric check (solvents >= 0 and solvents < 100),
  certificate_ref     text not null check (btrim(certificate_ref) <> '' and length(certificate_ref) <= 128),
  supersedes          uuid unique references tab.lot_assay_result (id),
  reason              text check (reason is null or (btrim(reason) <> '' and length(reason) <= 2000)),
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  check (num_nonnulls(material_lot_id, sandbox_lot_code) = 1),
  check ((supersedes is null) = (reason is null)),
  check ((water is not null) = (basis in ('ANHYDROUS_WATER', 'ANHYDROUS_SOLVENT_FREE'))),
  check ((lod is not null) = (basis = 'DRIED_LOD')),
  check ((solvents is not null) = (basis = 'ANHYDROUS_SOLVENT_FREE'))
);
create index lot_assay_result_material_lot on tab.lot_assay_result (material_lot_id);
create index lot_assay_result_sandbox_lot on tab.lot_assay_result (sandbox_lot_code);
revoke all on tab.lot_assay_result from public;
select platform.enforce_db_time('tab.lot_assay_result', array['recorded_at']);
select kernel.register_audited_table('tab.lot_assay_result', 'lot_assay_result', 'id', true);

-- PR-19, DI-33 (header): records the approved assay result of lot p_lot_code (at site p_site on GMP; null in the
-- sandbox): p_result {basis, assay, water?, lod?, solvents?, certificateRef} with decimals as text; p_reason when it
-- supersedes the lot's current result (and only then). Returns the result's id.
create function tab.record_lot_assay(p_lot_code text, p_site text, p_result jsonb, p_reason text default null) returns uuid
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
  return v_id;
end
$$;

-- PR-19 (header): the current approved result of lot p_code as batch p_batch reads it, or null.
create function tab.lot_assay_of(p_code text, p_batch uuid) returns jsonb
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
  return jsonb_strip_nulls(jsonb_build_object('resultId', r.id::text, 'basis', r.basis, 'assay', r.assay::text, 'water', r.water::text,
                                              'lod', r.lod::text, 'solvents', r.solvents::text));
end
$$;

revoke all on function tab.record_lot_assay(text, text, jsonb, text), tab.lot_assay_of(text, uuid) from public;
grant execute on function tab.record_lot_assay(text, text, jsonb, text), tab.lot_assay_of(text, uuid) to ebmr_app;
grant select on tab.lot_assay_result to ebmr_app;

reset role;
