-- LIMS-lite: lot test results, their approval, revision and OOS link, and the lot release rule on them (Phase 3 slice
-- 5a step 3; slice 5 plan D-S5-3; outline 4.6 "LIMS supplies results", 5.2.9; controls PR-19, DI-33, DI-37, IN-24 (a)).
--
--   lot_test_result        one result of one test of one lot (insert-only): test code, method, value as an exact
--                          decimal with its unit, the decimal limits it is judged against, the purpose (RELEASE or
--                          RETEST), and the verdict, which the database computes from the value and the limits (a
--                          generated column: never typed). A revision is a new row naming the row it revises, with the
--                          person's own reason; the revised row stops being current and its approval goes with it.
--   lot_test_approval      the approval of a current result by a QC person other than its recorder, under the kernel
--                          meaning QC_RESULT_APPROVED (QC.RESULT_APPROVE; it excludes the recorder).
--   lot_test_oos           the OOS record (deviation-lite, kind OOS, linked to the lot) of an approved FAIL.
--   site.lot_lims_release_problem(lot)  NULL when no current release result of the lot is unapproved and no approved
--                          failure is unresolved; resolved = its OOS record was concluded by QA with an assignable cause
--                          (the result is then not the lot's true value). The release guards call it: a lot is neither
--                          released nor released for further processing over an open result.
-- The release guards material_lot.release_route_satisfied (latest 0720) and material_lot.intermediate_only (latest
-- 0710) are replaced from their latest definitions with that one check added at the end.
-- Messages: EBMR-SITE-200 to 214.

set local role ebmr_owner;

create table site.lot_test_result (
  id                   uuid primary key default gen_random_uuid(),
  lot_id               uuid not null references site.material_lot (id),
  test_code            text not null check (test_code ~ '^[A-Z0-9][A-Z0-9_.-]{0,39}$'),
  method_reference     text not null check (btrim(method_reference) <> '' and length(method_reference) <= 128),
  purpose              text not null check (purpose in ('RELEASE', 'RETEST')),
  result_value         numeric not null,
  unit                 text not null check (unit ~ '^[!-~]{1,32}$'),
  lower_limit          numeric,
  upper_limit          numeric,
  verdict              text not null generated always as (
                         case when (lower_limit is null or result_value >= lower_limit) and (upper_limit is null or result_value <= upper_limit)
                              then 'PASS' else 'FAIL' end) stored,
  revises              uuid unique references site.lot_test_result (id),
  revision_reason      text,
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null,
  check (lower_limit is not null or upper_limit is not null),
  check (lower_limit is null or upper_limit is null or lower_limit <= upper_limit),
  check ((revises is null) = (revision_reason is null)),
  check (revision_reason is null or btrim(revision_reason) <> '')
);
create index lot_test_result_lot on site.lot_test_result (lot_id, test_code);
revoke all on site.lot_test_result from public;

create table site.lot_test_approval (
  result_id            uuid primary key references site.lot_test_result (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
revoke all on site.lot_test_approval from public;

create table site.lot_test_oos (
  result_id            uuid primary key references site.lot_test_result (id),
  deviation_id         uuid not null references site.deviation (id),
  linked_by_person     uuid not null,
  linked_by_account    uuid not null,
  linked_at            timestamptz not null default clock_timestamp()
);
revoke all on site.lot_test_oos from public;

select platform.enforce_db_time('site.lot_test_result', array['recorded_at']);
select platform.enforce_db_time('site.lot_test_approval', array['approved_at']);
select platform.enforce_db_time('site.lot_test_oos', array['linked_at']);
select kernel.register_audited_table('site.lot_test_result', 'lot_test_result', 'id', true);
select kernel.register_audited_table('site.lot_test_approval', 'lot_test_result', 'result_id', true);
select kernel.register_audited_table('site.lot_test_oos', 'lot_test_result', 'result_id', true);

-- ---------------------------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------------------------

create function site.lot_test_is_current(p_result uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (select 1 from site.lot_test_result r where r.id = p_result)
     and not exists (select 1 from site.lot_test_result n where n.revises = p_result)
$$;

-- RECORDED, APPROVED or REVISED.
create function site.lot_test_state(p_result uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when exists (select 1 from site.lot_test_result n where n.revises = r.id) then 'REVISED'
              when exists (select 1 from site.lot_test_approval a where a.result_id = r.id) then 'APPROVED'
              else 'RECORDED' end
  from site.lot_test_result r where r.id = p_result
$$;

-- An approved failure is resolved when its OOS record was concluded by QA with an assignable cause.
create function site.lot_test_failure_resolved(p_result uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (select 1 from site.lot_test_oos o join site.deviation_conclusion c on c.deviation_id = o.deviation_id
                 where o.result_id = p_result and c.assignable_cause and site.deviation_state(o.deviation_id) in ('CONCLUDED', 'CLOSED'))
$$;

create function site.lot_lims_release_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  r site.lot_test_result;
begin
  for r in select x.* from site.lot_test_result x
            where x.lot_id = p_lot and x.purpose = 'RELEASE' and site.lot_test_is_current(x.id) order by x.recorded_at, x.id loop
    if not exists (select 1 from site.lot_test_approval a where a.result_id = r.id) then
      return format('the %s result %s %s of the lot is not approved by QC (PR-19, DI-33)', r.test_code, r.result_value, r.unit);
    end if;
    if r.verdict = 'FAIL' and not site.lot_test_failure_resolved(r.id) then
      return format('the approved %s result %s %s of the lot failed its limits and has no OOS record concluded with an assignable cause (PR-19, IN-20)',
                    r.test_code, r.result_value, r.unit);
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed content: what QC_RESULT_APPROVED covers
-- ---------------------------------------------------------------------------------------------

create function site.lot_test_result_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  r site.lot_test_result;
  l site.material_lot;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into r from site.lot_test_result where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  select * into l from site.material_lot where id = r.lot_id;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('lot_code', l.lot_code, 'material_code', l.material_code, 'test_code', r.test_code,
                                  'method_reference', r.method_reference, 'purpose', r.purpose, 'value', r.result_value::text, 'unit', r.unit,
                                  'lower_limit', r.lower_limit::text, 'upper_limit', r.upper_limit::text, 'verdict', r.verdict,
                                  'revises', r.revises, 'revision_reason', r.revision_reason, 'recorded_by', r.recorded_by_person,
                                  'recorded_at', site.utc_text(r.recorded_at)),
    'state', site.lot_test_state(r.id),
    'scope', jsonb_build_object('site', l.site_code),
    'entered_by', jsonb_build_array(r.recorded_by_person));
end
$$;

select esig.register_content_provider('lot_test_result', 'site.lot_test_result_content(text)',
  'LIMS-lite lot test result: lot, test, method, value, unit, limits, the computed verdict and what it revises');

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- p: {testCode, methodReference, purpose (RELEASE | RETEST), value, unit, lowerLimit?, upperLimit? (decimals as text),
--     revises?, revisionReason?}. Returns {resultId, verdict}.
create function site.record_lot_test_result(p_lot uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  l      site.material_lot;
  o      site.lot_test_result;
  v_id   uuid;
  v_ver  text;
  m      text;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('QC.RESULT_RECORD', jsonb_build_object('site', l.site_code));
  if site.lot_state(l.id) in ('CONSUMED', 'DESTROYED') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-200 lot %s is %s; no result is recorded for it', l.lot_code, site.lot_state(l.id));
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 the result details are required';
  end if;
  foreach m in array array['value', 'lowerLimit', 'upperLimit'] loop
    if p ? m and (jsonb_typeof(p -> m) is distinct from 'string' or (p ->> m) !~ '^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$') then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-201 the %s of a result is an exact decimal written as text, e.g. "99.2" (DI-33)', m);
    end if;
  end loop;
  if not (p ? 'value') or not (p ? 'lowerLimit' or p ? 'upperLimit') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 a result states its value and at least one limit; the verdict is computed from them (D-S5-3)';
  end if;
  if p ? 'verdict' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 the verdict is computed by the database from the value and the limits; it is never typed (D-S5-3)';
  end if;
  if p ? 'revises' then
    select * into o from site.lot_test_result r where r.id = (p ->> 'revises')::uuid for update;
    if o.id is null or o.lot_id <> l.id or o.test_code is distinct from p ->> 'testCode' or o.purpose is distinct from p ->> 'purpose'
       or not site.lot_test_is_current(o.id) then
      raise exception using errcode = 'P0001',
        message = 'EBMR-SITE-202 a revision names the current result of the same lot, test and purpose (DI-33)';
    end if;
    if btrim(coalesce(p ->> 'revisionReason', '')) = '' then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-202 a revision states the person''s own reason; the revised result stays visible (DI-22, DI-33)';
    end if;
  elsif p ? 'revisionReason' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-202 only a revision states a revision reason';
  end if;
  insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, revises, revision_reason,
                                    recorded_by_person, recorded_by_account, correlation_id)
  values (l.id, p ->> 'testCode', p ->> 'methodReference', p ->> 'purpose', (p ->> 'value')::numeric, p ->> 'unit',
          (p ->> 'lowerLimit')::numeric, (p ->> 'upperLimit')::numeric, o.id, case when o.id is not null then btrim(p ->> 'revisionReason') end,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id, verdict into v_id, v_ver;
  return jsonb_build_object('resultId', v_id, 'verdict', v_ver);
end
$$;

create function site.approve_lot_test_result(p_result uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  r      site.lot_test_result;
  l      site.material_lot;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  select * into r from site.lot_test_result where id = p_result;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-203 unknown lot test result %s', p_result);
  end if;
  l := site.lock_lot(r.lot_id);
  perform iam.require_permission('QC.RESULT_APPROVE', jsonb_build_object('site', l.site_code));
  if site.lot_test_state(r.id) <> 'RECORDED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-203 the %s result is %s; only a current result not yet approved is approved (DI-33)', r.test_code, site.lot_test_state(r.id));
  end if;
  if r.recorded_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-204 a result is approved by a QC person other than its recorder (D-S5-3; outline 7.2 S21)';
  end if;
  perform esig.assert_signature(p_signature, 'QC_RESULT_APPROVED', 'lot_test_result', r.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-204 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-204 the approval is recorded by the QC person who signed it';
  end if;
  insert into site.lot_test_approval (result_id, signature_id, approved_by_person, approved_by_account)
  values (r.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- The OOS record of an approved failure: a deviation-lite record of kind OOS, not cancelled, linked to the lot.
create function site.link_lot_test_oos(p_result uuid, p_deviation uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  r     site.lot_test_result;
  l     site.material_lot;
  d     site.deviation;
begin
  perform iam.assert_not_administrator();
  select * into r from site.lot_test_result where id = p_result;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-203 unknown lot test result %s', p_result);
  end if;
  l := site.lock_lot(r.lot_id);
  perform iam.require_permission('QC.RESULT_RECORD', jsonb_build_object('site', l.site_code));
  if r.verdict <> 'FAIL' or site.lot_test_state(r.id) <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-205 only a current approved failing result is linked to an OOS record; this %s result is %s, %s', r.test_code, r.verdict, site.lot_test_state(r.id));
  end if;
  select * into d from site.deviation where id = p_deviation;
  if d.id is null or d.kind <> 'OOS' or site.deviation_state(d.id) = 'CANCELLED' or d.site_code <> l.site_code
     or not exists (select 1 from site.deviation_link x where x.deviation_id = d.id and x.subject_kind = 'LOT' and x.subject_id = l.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-205 the OOS record of a result is a deviation-lite record of kind OOS at site %s, not cancelled, linked to lot %s (IN-20)', l.site_code, l.lot_code);
  end if;
  if exists (select 1 from site.lot_test_oos o where o.result_id = r.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-205 the result is already linked to its OOS record';
  end if;
  insert into site.lot_test_oos (result_id, deviation_id, linked_by_person, linked_by_account)
  values (r.id, d.id, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The release guards (header)
-- ---------------------------------------------------------------------------------------------

-- As 0720_lot_release_signed_route.sql; the LIMS-lite release rule added at the end.
create or replace function site.guard_release_route_satisfied(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l        site.material_lot;
  v_route  text;
  v_signed text;
begin
  select * into l from site.material_lot where id = p_id;
  if not found then
    return 'the lot does not exist';
  end if;
  select c.release_route into v_route from site.lot_status_command c
   where c.lot_id = p_id and c.xact_id = txid_current() and c.event = 'RELEASE' order by c.recorded_at desc limit 1;
  if v_route is null then
    return 'a release records its route: IDENTITY_TESTED or VENDOR_HISTORY (IN-24 (c))';
  end if;
  if exists (select 1 from site.lot_identity_result r where r.lot_id = p_id and r.result = 'FAIL') then
    return format('a failing identity result is recorded for lot %s; it cannot be released (IN-24 (c))', l.lot_code);
  end if;
  if v_route = 'IDENTITY_TESTED' then
    if not exists (select 1 from site.lot_identity_result r where r.lot_id = p_id and r.result = 'PASS') then
      return format('lot %s has no passing identity result: the identity-tested route needs one (IN-24 (c))', l.lot_code);
    end if;
  else
    if l.material_kind <> 'EXCIPIENT' then
      return format('lot %s is %s: the vendor-history route is only for excipients (IN-24 (c))', l.lot_code, l.material_kind);
    end if;
    if not site.vendor_route_enabled(l.site_code, l.material_code) then
      return format('QA has not enabled the vendor-history route for material %s at site %s with a signed statistical justification (IN-24 (c))',
                    l.material_code, l.site_code);
    end if;
  end if;
  v_signed := site.lot_signed_release_route(p_id);
  if v_signed is distinct from v_route then
    return format('the release signature covers lot %s with release route %s in its signed content; a release on route %s is refused (IN-24 (c); EBMR-SITE-112)',
                  l.lot_code, coalesce(v_signed, 'none'), v_route);
  end if;
  return site.lot_lims_release_problem(p_id);
end
$$;

-- As 0710_material_lots.sql; the LIMS-lite release rule added for the release for further processing.
create or replace function site.guard_intermediate_only(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when l.id is null then 'the lot does not exist'
              when l.material_kind <> 'INTERMEDIATE'
                then format('lot %s is %s, not an intermediate: only intermediates are released for further processing', l.lot_code, l.material_kind)
              else site.lot_lims_release_problem(l.id)
         end
  from (select 1) d left join site.material_lot l on l.id = p_id
$$;

revoke all on site.lot_test_result, site.lot_test_approval, site.lot_test_oos from ebmr_app;
grant select on site.lot_test_result, site.lot_test_approval, site.lot_test_oos to ebmr_app;
grant execute on function site.record_lot_test_result(uuid, jsonb), site.approve_lot_test_result(uuid, uuid), site.link_lot_test_oos(uuid, uuid),
                          site.lot_test_state(uuid), site.lot_test_is_current(uuid), site.lot_lims_release_problem(uuid) to ebmr_app;

reset role;
