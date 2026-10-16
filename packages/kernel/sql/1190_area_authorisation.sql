-- Phase 6 slice 6b (builder B): area authorisation per person (PR-15; D-P6b-5, D-P6b-B-1). A controlled area (a
-- potent-product suite of the Tablets edition now, the filling suite with Injectables) is entered and worked in only by
-- persons authorised for it. The authorisation is a qualification of the register (iam.person_qualification) of the
-- type AREA.<area code>: recorded by a training coordinator (QUALIFICATION.RECORD; never by the person), valid from and
-- to, withdrawn with a reason, fed by the LMS mirror where the site has one, and read with the mirror's freshness
-- (INV-26: data recorded by the instant, a mirror fresh at it). Which areas are controlled is plant master data
-- (recipe-core 0973, plant.area_rule); the step signature in a controlled area reads iam.area_authorisation_problem.
--
-- Handbook: modules/kernel.md
--
--   iam.area_authorisation_code(area)                  'AREA.' || the area code: the qualification type of the area
--   iam.create_area_authorisation_type(area, name)     TRAINING.MANAGE (as iam.create_qualification_type): the type
--                                                      AREA.<area>; once per area (EBMR-IAM-200, EBMR-IAM-201)
--   iam.person_area_authorised(person, area, at)       whether a live, fresh record of AREA.<area> covers the instant
--   iam.area_authorisation_problem(person, area, at)   null, or why not (EBMR-IAM-202), naming the area and the person
--
-- Messages: EBMR-IAM-200 to EBMR-IAM-202.

set local role ebmr_owner;

create function iam.area_authorisation_code(p_area text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select 'AREA.' || upper(btrim(p_area))
$$;

create function iam.create_area_authorisation_type(p_area text, p_name text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_code text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('TRAINING.MANAGE', '{}'::jsonb);
  if coalesce(btrim(p_area), '') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' or coalesce(btrim(p_name), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-200 an area authorisation names the room or line code and a name (PR-15)';
  end if;
  v_code := iam.area_authorisation_code(p_area);
  if exists (select 1 from iam.qualification_type where code = v_code) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-201 the area authorisation %s exists already', v_code);
  end if;
  insert into iam.qualification_type (code, name, description)
  values (v_code, btrim(p_name), format('Authorisation to work in the controlled area %s (PR-15)', upper(btrim(p_area))));
  return v_code;
end
$$;

-- INV-26: a record counts when it was recorded by the instant, is valid at it, was not withdrawn by it, and comes from
-- a source fresh at it (a mirror's freshness bound; the internal register is always fresh).
create function iam.person_area_authorised(p_person uuid, p_area text, p_at timestamptz) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select exists (
    select 1 from iam.person_qualification q
     where q.person_id = p_person and q.qualification_code = iam.area_authorisation_code(p_area)
       and q.recorded_at <= p_at and q.valid_from <= p_at and (q.valid_to is null or q.valid_to > p_at)
       and (q.withdrawn_at is null or q.withdrawn_at > p_at)
       and iam.qualification_source_fresh(q.source_code, p_at))
$$;

create function iam.area_authorisation_problem(p_person uuid, p_area text, p_at timestamptz) returns text
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select case when iam.person_area_authorised(p_person, p_area, p_at) then null
         else format('EBMR-IAM-202 %s holds no current authorisation %s for the controlled area %s (PR-15)',
                     coalesce((select p.legal_name from iam.person p where p.id = p_person), coalesce(p_person::text, 'nobody')),
                     iam.area_authorisation_code(p_area), upper(btrim(p_area)))
         end
$$;

revoke all on function iam.area_authorisation_code(text), iam.create_area_authorisation_type(text, text),
                       iam.person_area_authorised(uuid, text, timestamptz), iam.area_authorisation_problem(uuid, text, timestamptz) from public;
grant execute on function iam.area_authorisation_code(text), iam.create_area_authorisation_type(text, text),
                          iam.person_area_authorised(uuid, text, timestamptz), iam.area_authorisation_problem(uuid, text, timestamptz) to ebmr_app;

reset role;
