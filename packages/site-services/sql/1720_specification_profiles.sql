-- Site services: a multi-point profile (e.g. a dissolution profile) as one test of a specification (Phase 7 slice 7p,
-- requirement R4 "Third check"; decisions D-7p-1 to D-7p-4; controls IN-33, PR-45, IN-20, DI-31).
--
-- Handbook: modules/site-services.md
--
-- A sustained-release product is released on several time points of one dissolution test (e.g. 1 h, 4 h, 8 h), each
-- with its own limits. Until now a specification test had one pair of limits, so a profile could only be typed as
-- several tests. Now:
--   * site.specification_test.profile: a profile test carries no limits of its own; its ordered points do
--     (site.specification_test_point: point number 1..n, a label such as "1 h", the time as a decimal with its unit,
--     min or h, and the point's lower and/or upper limit). Points are written with their specification in the one
--     draft command and never change (insert-only, like the tests); a point is only added to a profile test of a draft
--     specification, numbered next, and later in time than the point before it; a profile has 2 to 24 points (checked
--     at commit). A two-stage test (a delayed-release tablet's acid stage, where release stays at or below a limit,
--     then its buffer stage, where it reaches at least a limit; R8 C4, D-7p-5) is the same profile with a stage named on
--     each point (e.g. "Acid 0.1 M HCl", "Buffer pH 6.8"): every point names its stage or none does, a stage's points
--     follow one another and the time starts again in each stage. The approval signs the points (site.specification_content adds them to a profile test only, so the
--     content of every specification without a profile is unchanged).
--   * site.draft_specification (CREATE OR REPLACE from 0840): a test may carry points instead of limits.
--   * site.lot_test_result.point_id: a result of a profile test is one point's result; its limits are the point's
--     (the row trigger site.lot_test_result_spec_check, replaced from 0841, holds them to it) and the verdict is the
--     generated column as before. site.record_lot_test_result (CREATE OR REPLACE from 0844) takes the point's label;
--     an unknown point, a point for a single test or no point for a profile is refused (EBMR-SITE-972). A revision
--     revises the current result of the same point.
--   * site.lot_test_failure_resolved (CREATE OR REPLACE from 0821): the passing replacement is of the same point.
--   * site.lot_lims_release_problem (CREATE OR REPLACE from 0841): a required profile needs a current RELEASE result of
--     every point (a missing point keeps the lot unreleased); messages name the point.
--   * site.lot_profile_status(lot): each profile test of the specification in effect for the lot, required or with a
--     result, with its points, their current RELEASE results and latest LIMS values, and one status: PASS (every point
--     has an approved current result within its limits), FAIL (a point's current result is outside its limits and the
--     failure is not resolved) or OPEN (a point has no current result, or one not approved yet). The release checklist
--     (recipe-core 1725) shows each profile as one item from it.
--   * LIMS (site services 0926): a lims.sample_result may name the point (payload field "point"); for a profile test of
--     the lot's specification in effect the point is required and must be one of its points, and a point for a single
--     test is refused (EBMR-SITE-973). The row records the specification test, the point and its limits when the LIMS
--     unit is the specification's, and the database computes the verdict from the raw value (a generated column; the
--     LIMS's own conformance is kept beside it). As before (D-P6a-B-6) the LIMS row does not release a lot: QC records
--     the release result (the QC screen offers the LIMS value of each point).
-- Default D-7p-1 (owner rule, least strict): one result per point (the mean of the units tested, as the LIMS reports
-- it); the pharmacopoeial staged acceptance of dissolution (stages 1 to 3) is not built (review-backlog P7P-1).
-- Messages: EBMR-SITE-970 to 979 (976: two profile codes that would name the same release item).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

alter table site.specification_test add column profile boolean not null default false;
do $$
begin
  -- The 0840 check "at least one limit" (PostgreSQL's name for it): a profile test carries its limits on its points.
  if (select pg_get_constraintdef(c.oid) from pg_constraint c
       where c.conrelid = 'site.specification_test'::regclass and c.conname = 'specification_test_check')
     is distinct from 'CHECK (((lower_limit IS NOT NULL) OR (upper_limit IS NOT NULL)))' then
    raise exception 'site.specification_test_check is not the 0840 limit check';
  end if;
end
$$;
alter table site.specification_test drop constraint specification_test_check;
alter table site.specification_test add constraint specification_test_limits check (profile or lower_limit is not null or upper_limit is not null);
alter table site.specification_test add constraint specification_test_profile_no_limits check (not profile or (lower_limit is null and upper_limit is null));

create table site.specification_test_point (
  id                   uuid primary key default gen_random_uuid(),
  specification_id     uuid not null references site.specification (id),
  spec_test_id         uuid not null references site.specification_test (id),
  point_no             integer not null check (point_no between 1 and 24),
  label                text not null check (label ~ '^[!-~]( ?[!-~]){0,31}$'),
  stage                text check (stage is null or stage ~ '^[!-~]( ?[!-~]){0,47}$'),
  time_value           numeric not null check (time_value > 0),
  time_unit            text not null check (time_unit in ('min', 'h')),
  lower_limit          numeric,
  upper_limit          numeric,
  unique (spec_test_id, point_no),
  unique (spec_test_id, label),
  check (lower_limit is not null or upper_limit is not null),
  check (lower_limit is null or upper_limit is null or lower_limit <= upper_limit)
);
revoke all on site.specification_test_point from public;
select kernel.register_audited_table('site.specification_test_point', 'specification', 'specification_id', true);

-- The time of a point in minutes, for its order.
create function site.point_minutes(p_value numeric, p_unit text) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_unit when 'h' then p_value * 60 else p_value end
$$;

-- A point belongs to a profile test of a draft specification, is numbered next and is later than the point before it.
create function site.specification_point_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  t      site.specification_test;
  v_prev site.specification_test_point;
begin
  select * into t from site.specification_test where id = new.spec_test_id;
  if t.id is null or not t.profile or t.specification_id <> new.specification_id then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-974 a time point belongs to a profile test of its own specification (IN-33)';
  end if;
  if exists (select 1 from site.specification_approval a where a.specification_id = new.specification_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-974 an approved specification never changes; a new version carries the new points (IN-33)';
  end if;
  select * into v_prev from site.specification_test_point p where p.spec_test_id = new.spec_test_id order by p.point_no desc limit 1;
  if new.point_no <> coalesce(v_prev.point_no, 0) + 1 then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-971 the points of profile %s are numbered 1, 2, 3 ... in order', t.test_code);
  end if;
  if v_prev.id is not null and (new.stage is null) <> (v_prev.stage is null) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-971 either every point of profile %s names its stage or none does', t.test_code);
  end if;
  if v_prev.id is not null and new.stage is distinct from v_prev.stage then
    -- A new stage (e.g. the buffer stage after the acid stage): its time starts again; a stage never comes back.
    if exists (select 1 from site.specification_test_point x where x.spec_test_id = new.spec_test_id and x.stage = new.stage) then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-971 the points of stage %s of profile %s follow one another', new.stage, t.test_code);
    end if;
  elsif v_prev.id is not null and site.point_minutes(new.time_value, new.time_unit) <= site.point_minutes(v_prev.time_value, v_prev.time_unit) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-971 point %s of profile %s is not later than point %s; the points of a profile (of each stage) are in time order', new.label, t.test_code, v_prev.label);
  end if;
  return new;
end
$$;
create trigger a1_point_guard before insert on site.specification_test_point for each row execute function site.specification_point_guard();

-- At commit: a profile test has 2 to 24 points.
create function site.specification_profile_points_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_n integer;
begin
  if new.profile then
    select count(*) into v_n from site.specification_test_point p where p.spec_test_id = new.id;
    if v_n < 2 then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-975 profile %s has %s time points; a profile has 2 to 24 (IN-33)', new.test_code, v_n);
    end if;
  end if;
  return null;
end
$$;
create constraint trigger zz_profile_points after insert on site.specification_test deferrable initially deferred
  for each row execute function site.specification_profile_points_check();

alter table site.lot_test_result add column point_id uuid references site.specification_test_point (id);
create index lot_test_result_point on site.lot_test_result (point_id) where point_id is not null;

alter table site.lims_sample_result add column point_label text check (point_label is null or point_label ~ '^[!-~]( ?[!-~]){0,31}$');
alter table site.lims_sample_result add column spec_test_id uuid references site.specification_test (id);
alter table site.lims_sample_result add column point_id uuid references site.specification_test_point (id);
alter table site.lims_sample_result add column lower_limit numeric;
alter table site.lims_sample_result add column upper_limit numeric;
alter table site.lims_sample_result add column verdict text generated always as (
  case when raw_value is null or (lower_limit is null and upper_limit is null) then null
       when (lower_limit is null or raw_value::numeric >= lower_limit) and (upper_limit is null or raw_value::numeric <= upper_limit) then 'PASS'
       else 'FAIL' end) stored;

-- ---------------------------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------------------------

-- The label a message uses for a result: the test code, and the point of a profile.
create function site.lot_test_label(p_result uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select r.test_code || coalesce(' at ' || p.label, '') from site.lot_test_result r left join site.specification_test_point p on p.id = r.point_id where r.id = p_result
$$;

-- The points of a profile test as JSON, in order.
create function site.profile_points_json(p_spec_test uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('pointNo', p.point_no, 'label', p.label, 'stage', p.stage, 'timeValue', p.time_value::text, 'timeUnit', p.time_unit,
                                               'lowerLimit', p.lower_limit::text, 'upperLimit', p.upper_limit::text) order by p.point_no), '[]'::jsonb)
    from site.specification_test_point p where p.spec_test_id = p_spec_test
$$;

-- Each profile test of the specification in effect for the lot (required, or with a current RELEASE result) with its
-- points and one status (header): [{testCode, specTestId, unit, required, status, problem, points: [{pointNo, label,
-- timeValue, timeUnit, lowerLimit, upperLimit, result: {resultId, value, verdict, state} | null, lims: {sampleId,
-- value, unit, verdict, conformance, state} | null}]}].
create function site.lot_profile_status(p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l       site.material_lot;
  v_spec  uuid;
  t       site.specification_test;
  p       site.specification_test_point;
  r       site.lot_test_result;
  v_out   jsonb := '[]'::jsonb;
  v_pts   jsonb;
  v_lims  jsonb;
  v_fail  text;
  v_open  text;
begin
  select * into l from site.material_lot where id = p_lot;
  if not found then
    return '[]'::jsonb;
  end if;
  v_spec := site.specification_in_effect(l.site_code, l.material_code);
  for t in select x.* from site.specification_test x where x.specification_id = v_spec and x.profile order by x.test_code collate "C" loop
    if not t.required and not exists (select 1 from site.lot_test_result y where y.lot_id = p_lot and y.spec_test_id = t.id and y.purpose = 'RELEASE') then
      continue;
    end if;
    v_pts := '[]'::jsonb;
    v_fail := null;
    v_open := null;
    for p in select x.* from site.specification_test_point x where x.spec_test_id = t.id order by x.point_no loop
      -- The current RELEASE result of the point: an unresolved failure first, else the latest.
      select y.* into r from site.lot_test_result y
       where y.lot_id = p_lot and y.point_id = p.id and y.purpose = 'RELEASE' and site.lot_test_is_current(y.id)
       order by (y.verdict = 'FAIL' and not site.lot_test_failure_resolved(y.id)) desc, y.recorded_at desc, y.id desc limit 1;
      if r.id is null then
        v_open := coalesce(v_open, format('time point %s of profile %s has no current RELEASE result', p.label, t.test_code));
      elsif r.verdict = 'FAIL' and not site.lot_test_failure_resolved(r.id) then
        v_fail := coalesce(v_fail, format('time point %s of profile %s: %s %s is outside its limits (%s to %s)', p.label, t.test_code, r.result_value, r.unit,
                                          coalesce(p.lower_limit::text, '-'), coalesce(p.upper_limit::text, '-')));
      elsif site.lot_test_state(r.id) <> 'APPROVED' then
        v_open := coalesce(v_open, format('the result of time point %s of profile %s is not approved by QC yet', p.label, t.test_code));
      end if;
      select jsonb_build_object('sampleId', s.sample_id, 'value', s.raw_value, 'unit', s.raw_unit, 'verdict', s.verdict, 'conformance', s.conformance, 'state', s.state)
        into v_lims
        from site.lims_sample_result s where s.lot_id = p_lot and s.point_id = p.id
       order by s.source_timestamp desc, s.received_at desc limit 1;
      v_pts := v_pts || jsonb_build_array(jsonb_build_object(
        'pointNo', p.point_no, 'label', p.label, 'stage', p.stage, 'timeValue', p.time_value::text, 'timeUnit', p.time_unit,
        'lowerLimit', p.lower_limit::text, 'upperLimit', p.upper_limit::text,
        'result', case when r.id is null then null
                       else jsonb_build_object('resultId', r.id, 'value', r.result_value::text, 'verdict', r.verdict, 'state', site.lot_test_state(r.id)) end,
        'lims', v_lims));
      r := null;
      v_lims := null;
    end loop;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'testCode', t.test_code, 'specTestId', t.id, 'unit', t.unit, 'required', t.required,
      'status', case when v_fail is not null then 'FAIL' when v_open is not null then 'OPEN' else 'PASS' end,
      'problem', coalesce(v_fail, v_open),
      'points', v_pts));
  end loop;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed content: a profile test signs its points (header)
-- ---------------------------------------------------------------------------------------------

-- As 0840_specifications.sql; a profile test adds "profile" and its "points" (header).
create or replace function site.specification_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  s site.specification;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into s from site.specification where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object(
      'site_code', s.site_code, 'material_code', s.material_code, 'version', s.version, 'title', s.title,
      'monograph_reference', s.monograph_reference, 'drafted_by', s.drafted_by_person, 'drafted_at', site.utc_text(s.drafted_at),
      'tests', (select coalesce(jsonb_agg(jsonb_build_object('test_code', t.test_code, 'method_reference', t.method_reference, 'unit', t.unit,
                                                              'lower_limit', t.lower_limit::text, 'upper_limit', t.upper_limit::text,
                                                              'required', t.required, 'pharmacopoeia', t.pharmacopoeia, 'edition', t.edition,
                                                              'sample_quantity', t.sample_quantity::text, 'sample_unit', t.sample_unit)
                                           || case when t.profile then jsonb_build_object('profile', true, 'points', site.profile_points_json(t.id)) else '{}'::jsonb end
                                           order by t.test_code collate "C"), '[]'::jsonb)
                from site.specification_test t where t.specification_id = s.id)),
    'state', site.specification_state(s.id),
    'scope', jsonb_build_object('site', s.site_code),
    'entered_by', jsonb_build_array(s.drafted_by_person));
end
$$;

-- As 0740_lims_lite.sql; a point's result adds its "point" (header: the content of every other result is unchanged).
create or replace function site.lot_test_result_content(p_id text) returns jsonb
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
                                  'recorded_at', site.utc_text(r.recorded_at))
               || case when r.point_id is null then '{}'::jsonb
                       else (select jsonb_build_object('point', p.label) from site.specification_test_point p where p.id = r.point_id) end,
    'state', site.lot_test_state(r.id),
    'scope', jsonb_build_object('site', l.site_code),
    'entered_by', jsonb_build_array(r.recorded_by_person));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- A result is judged against its specification test, and a profile's result against its point (header)
-- ---------------------------------------------------------------------------------------------

-- As 0841_lims_from_specification.sql; a profile test's result names one of its points and carries the point's limits.
create or replace function site.lot_test_result_spec_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  t site.specification_test;
  p site.specification_test_point;
begin
  if new.spec_test_id is null then
    if new.point_id is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-972 a time point''s result names its specification test (IN-33)';
    end if;
    return new;
  end if;
  select * into t from site.specification_test where id = new.spec_test_id;
  if t.profile then
    select * into p from site.specification_test_point where id = new.point_id;
    if p.id is null or p.spec_test_id <> t.id then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-972 a result of profile %s names one of its time points (IN-33)', t.test_code);
    end if;
    if t.test_code is distinct from new.test_code or t.unit is distinct from new.unit
       or p.lower_limit is distinct from new.lower_limit or p.upper_limit is distinct from new.upper_limit then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-414 a %s result at %s carries the code, unit and limits of the time point it is judged against (IN-33)', new.test_code, p.label);
    end if;
    return new;
  end if;
  if new.point_id is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-972 %s is a single test, not a profile; its result names no time point (IN-33)', t.test_code);
  end if;
  if t.test_code is distinct from new.test_code or t.unit is distinct from new.unit
     or t.lower_limit is distinct from new.lower_limit or t.upper_limit is distinct from new.upper_limit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-414 a %s result carries the code, unit and limits of the specification test it is judged against (IN-33)', new.test_code);
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- As 0840_specifications.sql; a test may carry points instead of limits (header). A test with points:
-- {..., points: [{label, timeValue (decimal text), timeUnit (min | h), lowerLimit?, upperLimit?}]}, no limits of its own.
create or replace function site.draft_specification(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_site text;
  v_mat  text;
  v_id   uuid;
  v_ver  integer;
  v_tid  uuid;
  t      jsonb;
  q      jsonb;
  m      text;
  v_n    integer;
begin
  perform iam.assert_not_administrator();
  v_site := site.actor_site();
  perform iam.require_permission('SPECIFICATION.DRAFT', jsonb_build_object('site', v_site));
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'tests') is distinct from 'array' or jsonb_array_length(p -> 'tests') = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-400 a specification names its material, title, monograph reference and at least one test (IN-33)';
  end if;
  v_mat := p ->> 'materialCode';
  if site.erp_material_current(v_mat) is null and not exists (select 1 from site.erp_product e where e.product_code = v_mat) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-400 %s is neither a material of the ERP material master nor a product of the product master (PR-17)', coalesce(v_mat, 'NULL'));
  end if;
  for t in select x from jsonb_array_elements(p -> 'tests') x loop
    if jsonb_typeof(t) <> 'object' then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-401 each test of a specification is an object';
    end if;
    foreach m in array array['lowerLimit', 'upperLimit', 'sampleQuantity'] loop
      if t ? m and (jsonb_typeof(t -> m) is distinct from 'string' or (t ->> m) !~ '^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$') then
        raise exception using errcode = 'P0001', message = format('EBMR-SITE-401 the %s of a test is an exact decimal written as text, e.g. "98.0"', m);
      end if;
    end loop;
    if t ? 'points' then
      -- A profile: 2 to 24 points, each with its label, time and at least one limit; no limit on the test itself.
      if t ? 'lowerLimit' or t ? 'upperLimit' then
        raise exception using errcode = 'P0001',
          message = format('EBMR-SITE-970 profile %s carries its limits on its time points, not on the test (IN-33)', coalesce(t ->> 'testCode', 'NULL'));
      end if;
      if jsonb_typeof(t -> 'points') is distinct from 'array' or jsonb_array_length(t -> 'points') not between 2 and 24 then
        raise exception using errcode = 'P0001',
          message = format('EBMR-SITE-970 profile %s has 2 to 24 time points (IN-33)', coalesce(t ->> 'testCode', 'NULL'));
      end if;
      for q in select x from jsonb_array_elements(t -> 'points') x loop
        if jsonb_typeof(q) <> 'object' or jsonb_typeof(q -> 'label') is distinct from 'string' or coalesce(q ->> 'label', '') !~ '^[!-~]( ?[!-~]){0,31}$'
           or jsonb_typeof(q -> 'timeValue') is distinct from 'string' or coalesce(q ->> 'timeValue', '') !~ '^(0|[1-9][0-9]{0,5})(\.[0-9]{1,3})?$'
           or coalesce(q ->> 'timeValue', '') ~ '^0(\.0*)?$'
           or coalesce(q ->> 'timeUnit', '') not in ('min', 'h') or not (q ? 'lowerLimit' or q ? 'upperLimit')
           or (q ? 'stage' and (jsonb_typeof(q -> 'stage') is distinct from 'string' or (q ->> 'stage') !~ '^[!-~]( ?[!-~]){0,47}$')) then
          raise exception using errcode = 'P0001',
            message = format('EBMR-SITE-970 each time point of profile %s states its label (e.g. "1 h"), its time as decimal text above zero with its unit (min or h) and at least one limit (IN-33)',
                             coalesce(t ->> 'testCode', 'NULL'));
        end if;
        foreach m in array array['lowerLimit', 'upperLimit'] loop
          if q ? m and (jsonb_typeof(q -> m) is distinct from 'string' or (q ->> m) !~ '^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$') then
            raise exception using errcode = 'P0001', message = format('EBMR-SITE-970 the %s of a time point is an exact decimal written as text, e.g. "80"', m);
          end if;
        end loop;
        if q ? 'lowerLimit' and q ? 'upperLimit' and (q ->> 'lowerLimit')::numeric > (q ->> 'upperLimit')::numeric then
          raise exception using errcode = 'P0001',
            message = format('EBMR-SITE-971 the lower limit of time point %s of profile %s is above its upper limit', q ->> 'label', coalesce(t ->> 'testCode', 'NULL'));
        end if;
      end loop;
    elsif not (t ? 'lowerLimit' or t ? 'upperLimit') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-401 test %s states at least one limit, whether it is required for release and the sample quantity one run needs', coalesce(t ->> 'testCode', 'NULL'));
    end if;
    if not (t ? 'sampleQuantity') or jsonb_typeof(t -> 'required') is distinct from 'boolean' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-401 test %s states at least one limit, whether it is required for release and the sample quantity one run needs', coalesce(t ->> 'testCode', 'NULL'));
    end if;
    if coalesce(t ->> 'pharmacopoeia', '') = '' or coalesce(btrim(t ->> 'edition'), '') = '' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-402 test %s cites the source of its limit (IP, BP, PH_EUR, USP or IN_HOUSE) and its edition (IN-33)', coalesce(t ->> 'testCode', 'NULL'));
    end if;
  end loop;
  -- Each profile is its own release checklist item, named from its test code with every character other than A-Z, 0-9
  -- and _ read as _ (recipe-core 1725): two profiles whose codes read the same there (DISS.1 and DISS-1) are refused.
  if exists (select 1 from jsonb_array_elements(p -> 'tests') x where x ? 'points'
              group by left(regexp_replace(x ->> 'testCode', '[^A-Z0-9_]', '_', 'g'), 56) having count(*) > 1) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-976 two profile tests of a specification differ only in characters other than letters, digits and _ (e.g. DISS.1 and DISS-1); each profile is its own release item named from its code (IN-33)';
  end if;
  perform pg_advisory_xact_lock(hashtext('site.specification'), hashtext(v_site || '/' || v_mat));
  select coalesce(max(s.version), 0) + 1 into v_ver from site.specification s where s.site_code = v_site and s.material_code = v_mat;
  insert into site.specification (site_code, material_code, version, title, monograph_reference, drafted_by_person, drafted_by_account, correlation_id)
  values (v_site, v_mat, v_ver, p ->> 'title', p ->> 'monographReference', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
          (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  for t in select x from jsonb_array_elements(p -> 'tests') x loop
    insert into site.specification_test (specification_id, test_code, method_reference, unit, lower_limit, upper_limit, required, pharmacopoeia, edition,
                                         sample_quantity, sample_unit, profile)
    values (v_id, t ->> 'testCode', t ->> 'methodReference', t ->> 'unit', (t ->> 'lowerLimit')::numeric, (t ->> 'upperLimit')::numeric,
            (t ->> 'required')::boolean, t ->> 'pharmacopoeia', btrim(t ->> 'edition'), (t ->> 'sampleQuantity')::numeric, t ->> 'sampleUnit', t ? 'points')
    returning id into v_tid;
    if t ? 'points' then
      v_n := 0;
      for q in select x from jsonb_array_elements(t -> 'points') x loop
        v_n := v_n + 1;
        insert into site.specification_test_point (specification_id, spec_test_id, point_no, label, stage, time_value, time_unit, lower_limit, upper_limit)
        values (v_id, v_tid, v_n, q ->> 'label', q ->> 'stage', (q ->> 'timeValue')::numeric, q ->> 'timeUnit', (q ->> 'lowerLimit')::numeric, (q ->> 'upperLimit')::numeric);
      end loop;
    end if;
  end loop;
  return jsonb_build_object('specificationId', v_id, 'version', v_ver);
end
$$;

-- As 0844_revision_oos_same_test.sql; a profile's result names its point (header).
create or replace function site.record_lot_test_result(p_lot uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  l      site.material_lot;
  o      site.lot_test_result;
  t      site.specification_test;
  pt     site.specification_test_point;
  d      site.deviation;
  v_id   uuid;
  v_ver  text;
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
  if p ? 'lowerLimit' or p ? 'upperLimit' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-410 the limits of a result are the approved specification''s; they are never typed (IN-33)';
  end if;
  if p ? 'value' and (jsonb_typeof(p -> 'value') is distinct from 'string' or (p ->> 'value') !~ '^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 the value of a result is an exact decimal written as text, e.g. "99.2" (DI-33)';
  end if;
  if not (p ? 'value') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 a result states its value; the verdict is computed from it and the specification''s limits (D-S5-3)';
  end if;
  if p ? 'verdict' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 the verdict is computed by the database from the value and the limits; it is never typed (D-S5-3)';
  end if;
  if coalesce(p ->> 'purpose', '') not in ('RELEASE', 'RETEST') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-201 the purpose of a result is RELEASE or RETEST';
  end if;
  t := site.lot_spec_test(l.id, p ->> 'testCode');
  if t.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-411 %s is no test of an approved specification in effect for material %s at site %s; QC adds it to the specification first (IN-33, PR-45)',
                       coalesce(p ->> 'testCode', 'NULL'), l.material_code, l.site_code);
  end if;
  if (p ? 'unit' and p ->> 'unit' is distinct from t.unit) or (p ? 'methodReference' and p ->> 'methodReference' is distinct from t.method_reference) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-412 the specification measures %s in %s by method %s; a result takes them from it (IN-33)', t.test_code, t.unit, t.method_reference);
  end if;
  -- A profile's result is one point's (header).
  if t.profile then
    select * into pt from site.specification_test_point x where x.spec_test_id = t.id and x.label = p ->> 'point';
    if pt.id is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-972 %s is a profile of the time points %s; a result names one of them, not %s (IN-33)', t.test_code,
                         (select string_agg(x.label, ', ' order by x.point_no) from site.specification_test_point x where x.spec_test_id = t.id), coalesce(p ->> 'point', 'none'));
    end if;
  elsif p ? 'point' then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-972 %s is a single test, not a profile; its result names no time point (IN-33)', t.test_code);
  end if;
  if p ? 'revises' then
    select * into o from site.lot_test_result r where r.id = (p ->> 'revises')::uuid for update;
    if o.id is null or o.lot_id <> l.id or o.test_code is distinct from p ->> 'testCode' or o.purpose is distinct from p ->> 'purpose'
       or o.point_id is distinct from pt.id or not site.lot_test_is_current(o.id) then
      raise exception using errcode = 'P0001',
        message = 'EBMR-SITE-202 a revision names the current result of the same lot, test, time point and purpose (DI-33)';
    end if;
    if btrim(coalesce(p ->> 'revisionReason', '')) = '' then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-202 a revision states the person''s own reason; the revised result stays visible (DI-22, DI-33)';
    end if;
    if o.purpose = 'RELEASE' then
      if coalesce(p ->> 'oosDeviationId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        d := null;
      else
        select * into d from site.deviation x where x.id = (p ->> 'oosDeviationId')::uuid;
      end if;
      if d.id is null or d.kind <> 'OOS' or d.site_code <> l.site_code or site.deviation_state(d.id) = 'CANCELLED'
         or not exists (select 1 from site.deviation_link x where x.deviation_id = d.id and x.subject_kind = 'LOT' and x.subject_id = l.id) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-SITE-413 a revision of a RELEASE result cites the OOS record of lot %s: a deviation-lite record of kind OOS at site %s, not cancelled, linked to the lot (IN-20, DI-33)',
                           l.lot_code, l.site_code);
      end if;
      if exists (select 1 from site.lot_test_oos x join site.lot_test_result y on y.id = x.result_id
                  where x.deviation_id = d.id and y.test_code <> o.test_code)
         or exists (select 1 from site.lot_test_result y where y.revision_oos = d.id and y.test_code <> o.test_code) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-SITE-416 OOS record %s is about another test than %s; a revision of a RELEASE result cites the OOS record of its own result or test (IN-20, DI-33)',
                           d.ref, o.test_code);
      end if;
    elsif p ? 'oosDeviationId' then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-413 only a revision of a RELEASE result cites an OOS record';
    end if;
  elsif p ? 'revisionReason' or p ? 'oosDeviationId' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-202 only a revision states a revision reason or an OOS record';
  end if;
  insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, revises, revision_reason,
                                    revision_oos, spec_test_id, point_id, recorded_by_person, recorded_by_account, correlation_id)
  values (l.id, t.test_code, t.method_reference, p ->> 'purpose', (p ->> 'value')::numeric, t.unit,
          case when t.profile then pt.lower_limit else t.lower_limit end, case when t.profile then pt.upper_limit else t.upper_limit end,
          o.id, case when o.id is not null then btrim(p ->> 'revisionReason') end, d.id, t.id, pt.id,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id, verdict into v_id, v_ver;
  return jsonb_build_object('resultId', v_id, 'verdict', v_ver);
end
$$;

-- As 0821_deviation_full_commands.sql; the passing replacement is of the same time point (header).
create or replace function site.lot_test_failure_resolved(p_result uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (select 1 from site.lot_test_oos o join site.deviation_conclusion c on c.deviation_id = o.deviation_id
                  where o.result_id = r.id and c.assignable_cause and c.root_cause_category = 'LABORATORY_ERROR'
                    and site.deviation_state(o.deviation_id) in ('PENDING_CLOSURE', 'CLOSED'))
     and exists (select 1 from site.lot_test_result n
                  where n.lot_id = r.lot_id and n.test_code = r.test_code and n.purpose = r.purpose and n.id <> r.id
                    and n.point_id is not distinct from r.point_id
                    and n.recorded_at > r.recorded_at and n.verdict = 'PASS' and site.lot_test_state(n.id) = 'APPROVED')
  from site.lot_test_result r where r.id = p_result
$$;

-- As 0841_lims_from_specification.sql; every point of a required profile has a current RELEASE result, messages name the point (header).
create or replace function site.lot_lims_release_problem(p_lot uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l      site.material_lot;
  v_spec uuid;
  t      site.specification_test;
  pt     site.specification_test_point;
  r      site.lot_test_result;
begin
  select * into l from site.material_lot where id = p_lot;
  if not found then
    return 'the lot does not exist';
  end if;
  v_spec := site.specification_in_effect(l.site_code, l.material_code);
  if v_spec is null then
    return format('no approved specification is in effect for material %s at site %s; a lot is released only against one (IN-33, PR-45)', l.material_code, l.site_code);
  end if;
  for t in select x.* from site.specification_test x where x.specification_id = v_spec and x.required order by x.test_code collate "C" loop
    if t.profile then
      for pt in select x.* from site.specification_test_point x where x.spec_test_id = t.id order by x.point_no loop
        if not exists (select 1 from site.lot_test_result y
                        where y.lot_id = p_lot and y.purpose = 'RELEASE' and y.point_id = pt.id and site.lot_test_is_current(y.id)) then
          return format('time point %s of the required profile %s of the specification in effect (version %s) has no current RELEASE result for the lot (PR-45, IN-33)',
                        pt.label, t.test_code, (select s.version from site.specification s where s.id = v_spec));
        end if;
      end loop;
    elsif not exists (select 1 from site.lot_test_result y
                       where y.lot_id = p_lot and y.purpose = 'RELEASE' and y.spec_test_id = t.id and site.lot_test_is_current(y.id)) then
      return format('the required test %s of the specification in effect (version %s) has no current RELEASE result for the lot (PR-45, IN-33)',
                    t.test_code, (select s.version from site.specification s where s.id = v_spec));
    end if;
  end loop;
  for r in select x.* from site.lot_test_result x
            where x.lot_id = p_lot and x.purpose = 'RELEASE' and site.lot_test_is_current(x.id) order by x.recorded_at, x.id loop
    if not exists (select 1 from site.lot_test_approval a where a.result_id = r.id) then
      return format('the %s result %s %s of the lot is not approved by QC (PR-19, DI-33)', site.lot_test_label(r.id), r.result_value, r.unit);
    end if;
    if r.verdict = 'FAIL' and not site.lot_test_failure_resolved(r.id) then
      return format('the approved %s result %s %s of the lot failed its limits; it stands unless its OOS record concluded a confirmed laboratory error (assignable cause, category LABORATORY_ERROR) and an approved passing replacement result of the test exists; otherwise the lot is rejected and goes the deviation route (PR-19, IN-20)',
                    site.lot_test_label(r.id), r.result_value, r.unit);
    end if;
  end loop;
  for r in select x.* from site.lot_test_result x
            where x.lot_id = p_lot and x.purpose = 'RELEASE' and x.verdict = 'FAIL' and not site.lot_test_is_current(x.id) order by x.recorded_at, x.id loop
    if not exists (select 1 from site.lot_test_result n where n.revises = r.id and n.revision_oos is not null and site.oos_confirmed_lab_error(n.revision_oos)) then
      return format('the %s result %s %s of the lot failed its limits and was revised; the failure stands until the OOS record its revision cites is concluded as a confirmed laboratory error (IN-20, DI-33)',
                    site.lot_test_label(r.id), r.result_value, r.unit);
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- LIMS: the point of a profile's result, checked, and the verdict computed (header)
-- ---------------------------------------------------------------------------------------------

-- As 0926_lims_results_inbound.sql; the payload may name the point; the specification test, point and limits are recorded (header).
create or replace function site.receive_lims_sample_result(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_out   jsonb;
  m       platform.inbound_message;
  p       jsonb;
  r       jsonb;
  k       text;
  v_lot   uuid;
  v_newer timestamptz;
  t       site.specification_test;
  pt      site.specification_test_point;
  v_lo    numeric;
  v_hi    numeric;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p_envelope ->> 'messageType' is distinct from 'lims.sample_result' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LIMS-101 this command receives lims.sample_result messages, not %s', coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return v_out || jsonb_build_object('applied', 'NOTHING (duplicate)');
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  p := m.payload;
  if jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-LIMS-101 malformed lims.sample_result payload: not an object';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('sampleId', 'lotNumber', 'testCode', 'specificationRef', 'result', 'conformance', 'state', 'recordedAt', 'point') then
      raise exception using errcode = 'P0001', message = format('EBMR-LIMS-101 malformed lims.sample_result payload: unknown field %s', k);
    end if;
  end loop;
  foreach k in array array['sampleId', 'lotNumber', 'testCode', 'specificationRef'] loop
    if jsonb_typeof(p -> k) is distinct from 'string' or (p ->> k) !~ '^[\x21-\x7E]{1,64}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-LIMS-101 malformed lims.sample_result payload: %s is a code of 1 to 64 printable characters', k);
    end if;
  end loop;
  if p ? 'point' and (jsonb_typeof(p -> 'point') is distinct from 'string' or (p ->> 'point') !~ '^[!-~]( ?[!-~]){0,31}$') then
    raise exception using errcode = 'P0001', message = 'EBMR-LIMS-101 malformed lims.sample_result payload: point is the label of a time point, e.g. "1 h"';
  end if;
  if coalesce(p ->> 'conformance', '') not in ('CONFORMS', 'DOES_NOT_CONFORM', 'NOT_APPLICABLE')
     or coalesce(p ->> 'state', '') not in ('ENTERED', 'REVIEWED', 'APPROVED', 'INVALIDATED')
     or coalesce(p ->> 'recordedAt', '') !~ '^(0|[1-9][0-9]{0,15})$' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-LIMS-101 malformed lims.sample_result payload: conformance, state and recordedAt (epoch microseconds) are required';
  end if;
  r := p -> 'result';
  if jsonb_typeof(r) is distinct from 'object'
     or not ((r ?& array['value', 'unit'] and (select count(*) from jsonb_object_keys(r)) = 2
              and jsonb_typeof(r -> 'value') = 'string' and (r ->> 'value') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
              and jsonb_typeof(r -> 'unit') = 'string' and (r ->> 'unit') ~ '^[\x21-\x7E]{1,16}$')
             or (r ? 'text' and (select count(*) from jsonb_object_keys(r)) = 1 and jsonb_typeof(r -> 'text') = 'string'
                 and length(r ->> 'text') between 1 and 500)) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-LIMS-101 malformed lims.sample_result payload: result is {value as decimal text, unit} or {text} (DI-31: the value as the LIMS recorded it)';
  end if;
  select l.id into v_lot from site.material_lot l where l.lot_code = p ->> 'lotNumber';
  if v_lot is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LIMS-103 LIMS sample %s names lot %s, which this installation does not hold (wrong batch)', p ->> 'sampleId', p ->> 'lotNumber');
  end if;
  -- The specification test of the lot in effect, and the point of a profile (header).
  t := site.lot_spec_test(v_lot, p ->> 'testCode');
  if t.id is not null and t.profile then
    select * into pt from site.specification_test_point x where x.spec_test_id = t.id and x.label = p ->> 'point';
    if pt.id is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-973 LIMS sample %s: %s is a profile of the time points %s of the specification in effect; the result names one of them, not %s (IN-33, DI-31)',
                         p ->> 'sampleId', t.test_code, (select string_agg(x.label, ', ' order by x.point_no) from site.specification_test_point x where x.spec_test_id = t.id),
                         coalesce(p ->> 'point', 'none'));
    end if;
    v_lo := pt.lower_limit;
    v_hi := pt.upper_limit;
  elsif p ? 'point' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-973 LIMS sample %s names time point %s, but %s is no profile of the specification in effect for lot %s (IN-33, DI-31)',
                       p ->> 'sampleId', p ->> 'point', p ->> 'testCode', p ->> 'lotNumber');
  elsif t.id is not null then
    v_lo := t.lower_limit;
    v_hi := t.upper_limit;
  end if;
  if t.id is not null and r ->> 'unit' is distinct from t.unit then
    v_lo := null;
    v_hi := null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lims:' || (p ->> 'sampleId') || '/' || (p ->> 'testCode') || coalesce('/' || (p ->> 'point'), ''), 0));
  select max(x.source_timestamp) into v_newer from site.lims_sample_result x
   where x.sample_id = p ->> 'sampleId' and x.test_code = p ->> 'testCode' and x.point_label is not distinct from p ->> 'point';
  if v_newer is not null and v_newer >= m.source_timestamp then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LIMS-104 the LIMS state of sample %s test %s at %s is older than the one already applied (%s); it is not applied',
                       p ->> 'sampleId', p ->> 'testCode', m.source_timestamp, v_newer);
  end if;
  insert into site.lims_sample_result (lot_id, sample_id, test_code, specification_ref, raw_value, raw_unit, result_text, conformance, state,
                                       lims_recorded_at, message_id, source_timestamp, point_label, spec_test_id, point_id, lower_limit, upper_limit)
  values (v_lot, p ->> 'sampleId', p ->> 'testCode', p ->> 'specificationRef', r ->> 'value', r ->> 'unit', r ->> 'text', p ->> 'conformance',
          p ->> 'state', platform.epoch_us_to_timestamptz(p ->> 'recordedAt'), m.id, m.source_timestamp, p ->> 'point', t.id, pt.id,
          case when r ? 'value' then v_lo end, case when r ? 'value' then v_hi end);
  return v_out || jsonb_build_object('applied', 'RECORDED');
end
$$;

-- As 0926; each result adds its point and the verdict the database computed (header).
create or replace function site.lims_lot_results(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('sampleId', s.sample_id, 'testCode', s.test_code, 'specificationRef', s.specification_ref,
                                               'value', s.raw_value, 'unit', s.raw_unit, 'text', s.result_text, 'conformance', s.conformance,
                                               'state', s.state, 'messageId', s.message_id, 'sourceTimestamp', site.utc_text(s.source_timestamp),
                                               'point', s.point_label, 'verdict', s.verdict)
                            order by s.sample_id, s.test_code, s.point_label nulls first), '[]'::jsonb)
  from (select distinct on (x.sample_id, x.test_code, x.point_label) x.* from site.lims_sample_result x where x.lot_id = p_lot
        order by x.sample_id, x.test_code, x.point_label, x.source_timestamp desc, x.received_at desc) s
$$;

revoke all on function site.point_minutes(numeric, text), site.specification_point_guard(), site.specification_profile_points_check(),
                       site.lot_test_label(uuid), site.profile_points_json(uuid), site.lot_profile_status(uuid) from public;
grant select on site.specification_test_point to ebmr_app;
grant execute on function site.lot_profile_status(uuid), site.profile_points_json(uuid) to ebmr_app;

reset role;
