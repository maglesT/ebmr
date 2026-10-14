-- Site services: the QMS status at release relies on a fresh QMS mirror (Phase 6 slice 6a, review fix; DI-31, INV-26;
-- D-P6a-3; defect P6a-R2).
--
-- Handbook: modules/site-services.md
--
--   site.record_qms_release_fetch (0925) took the server's answer of the live QMS fetch and compared it only with the
--   local mirror; neither it nor site.qms_release_problem asked whether that mirror was fresh, so a mirror whose
--   adapter had stopped could stand in for the QMS. Now, in MIRROR:
--     - site.record_qms_release_fetch refuses with EBMR-INT-010 when the QMS_STATUS mirror is stale
--       (platform.mirror_fresh_or_raise, kernel 1180; a sync needs the adapter caught up, kernel 1182);
--     - site.qms_release_problem returns EBMR-INT-010 when the mirror is stale at the release, even with a matching
--       fetch recorded earlier in the transaction; the fetch is still required in the same transaction (EBMR-QMS-013).
--   The release guard (recipe-core 0951) calls site.qms_release_problem, so a direct insert meets the same check.
--   The live HTTP fetch itself (that the server asked the QMS rather than copying the mirror) is outside what the
--   database can see: an accepted residual of slice 6a (phase-6-plan.md, slice 6a residuals). Bodies otherwise as 0925.

set local role ebmr_owner;

create or replace function site.record_qms_release_fetch(p_lot uuid, p_deviations jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  l        site.material_lot;
  v_norm   jsonb;
  v_mirror jsonb;
  v_ok     boolean := false;
  v_perm   text;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  select * into l from site.material_lot where id = p_lot;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-QMS-010 unknown lot %s', p_lot);
  end if;
  foreach v_perm in array array['RELEASE.MANUFACTURER', 'RELEASE.US_DISPOSITION', 'RELEASE.EU_QP_CERTIFY'] loop
    begin
      perform iam.require_permission(v_perm, jsonb_build_object('site', l.site_code));
      v_ok := true;
      exit;
    exception when others then
      null;
    end;
  end loop;
  if not v_ok then
    raise exception using errcode = 'P0001', message = 'EBMR-QMS-010 the QMS status at release is fetched by the person releasing the lot';
  end if;
  if site.qms_mode() <> 'MIRROR' then
    raise exception using errcode = 'P0001', message = 'EBMR-QMS-010 this site runs no QMS (QMS_STATUS is STAND_IN); nothing is fetched at release';
  end if;
  -- The mirror the answer is compared with must itself be fresh (a stale QMS_STATUS mirror refuses, EBMR-INT-010).
  perform platform.mirror_fresh_or_raise('QMS_STATUS');
  if p_deviations is null or jsonb_typeof(p_deviations) <> 'array'
     or exists (select 1 from jsonb_array_elements(p_deviations) e
                where jsonb_typeof(e) <> 'object' or (select count(*) from jsonb_object_keys(e)) <> 3
                   or coalesce(e ->> 'deviationRef', '') !~ '^[\x21-\x7E]{1,64}$' or coalesce(e ->> 'versionToken', '') !~ '^[\x21-\x7E]{1,64}$'
                   or coalesce(e ->> 'status', '') not in ('OPEN', 'UNDER_INVESTIGATION', 'CLOSED', 'CANCELLED')) then
    raise exception using errcode = 'P0001', message = 'EBMR-QMS-012 the QMS answer is not a list of {deviationRef, status, versionToken}; the release is refused';
  end if;
  v_norm := (select coalesce(jsonb_agg(jsonb_build_object('deviationRef', e ->> 'deviationRef', 'status', e ->> 'status', 'versionToken', e ->> 'versionToken')
                                       order by e ->> 'deviationRef' collate "C"), '[]'::jsonb)
             from jsonb_array_elements(p_deviations) e);
  v_mirror := site.qms_lot_deviations(l.id);
  if v_norm <> v_mirror then
    raise exception using errcode = 'P0001',
      message = format('EBMR-QMS-011 the QMS status of lot %s changed since it was shown (version tokens differ: shown %s, QMS now %s); evaluate the release again when the QMS mirror has caught up',
                       l.lot_code, v_mirror::text, v_norm::text);
  end if;
  insert into site.qms_release_fetch (lot_id, deviations, open_count, person_id, account_id)
  values (l.id, v_norm, (select count(*) from jsonb_array_elements(v_norm) e where e ->> 'status' in ('OPEN', 'UNDER_INVESTIGATION')),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function site.qms_release_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  f       site.qms_release_fetch;
  v_bound bigint;
  v_code  text;
  v_fresh jsonb;
begin
  if site.qms_mode() = 'STAND_IN' then
    return null;
  end if;
  select lot_code into v_code from site.material_lot where id = p_lot;
  -- The fetch was compared with the mirror; a mirror that went stale since (or before) says nothing about the QMS now.
  v_fresh := platform.mirror_freshness('QMS_STATUS');
  if (v_fresh ->> 'stale')::boolean then
    return format('EBMR-INT-010 the QMS mirror QMS_STATUS is stale: %s, more than its bound of %s s; lot %s is not released until the QMS adapter synchronises again (call the QMS system owner)',
                  case when v_fresh ->> 'asOfUs' is null then 'it has never synchronised' else format('last synchronised %s s ago', v_fresh ->> 'ageSeconds') end,
                  v_fresh ->> 'boundSeconds', coalesce(v_code, p_lot::text));
  end if;
  select * into f from site.qms_release_fetch where lot_id = p_lot and xact_id = pg_current_xact_id() order by fetched_at desc limit 1;
  if f.id is null then
    return format('EBMR-QMS-013 the QMS status of lot %s was not fetched from the QMS in this release; the release is refused (call the QMS system owner if the QMS cannot be reached) (D-P6a-3)', coalesce(v_code, p_lot::text));
  end if;
  v_bound := platform.setting_numeric('integration.mirror_max_age_s.qms_status')::bigint;
  if clock_timestamp() - f.fetched_at > make_interval(secs => v_bound) then
    return format('EBMR-QMS-014 the QMS status of lot %s was fetched %s s ago, more than the QMS_STATUS bound of %s s; sign again (D-P6a-0-11)',
                  v_code, floor(extract(epoch from clock_timestamp() - f.fetched_at))::bigint, v_bound);
  end if;
  if f.open_count > 0 then
    return format('EBMR-QMS-015 the QMS holds %s open deviation(s) naming lot %s (%s); the lot is not released while they are open',
                  f.open_count, v_code,
                  (select string_agg(e ->> 'deviationRef' || ' ' || (e ->> 'status'), ', ') from jsonb_array_elements(f.deviations) e
                   where e ->> 'status' in ('OPEN', 'UNDER_INVESTIGATION')));
  end if;
  return null;
end
$$;

reset role;
