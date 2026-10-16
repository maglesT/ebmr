-- Phase 6 slice 6f (builder A): review-by-exception rules as versioned configuration under change control (DI-26, DI-09)
-- and review by exception on a step only with a validation reference (PR-52 clause 2). Defaults D-P6f-A-5, D-P6f-A-6.
--
-- Handbook: modules/recipe-core.md
--
--   recipe.rbe_rule_version  insert-only: one version of the review-by-exception rule of one review category: whether
--                            the category is listed (a mandatory category always is; EBMR-RBE-002) and the severity the
--                            review shows at least (a rule raises severity, it never lowers what the engine raised), with
--                            its rationale. It is configuration area RBE_RULE (kernel 1195): every row needs an approved,
--                            open change record covering RBE_RULE in the command (EBMR-CFG-001 to -004), so a rule is
--                            edited only under QA-approved change control, and every version is kept with its validity,
--                            so the rule set of any past date can be read (platform.config_as_of).
--   recipe.set_rbe_rule      the one writer (REVIEW.RBE_RULE_CHANGE, quality unit, never an administrator).
--   recipe.rbe_rules_as_of   the rule of each category in force at an instant (no version: listed, severity as raised).
--   recipe.exception_register_rbe
--                            the register's review view with the severity each item shows under the rules in force now.
--
-- PR-52 clause 2: the MBR's REVIEW_BY_EXCEPTION reduction (riskReductions, kind REVIEW_BY_EXCEPTION, on steps) needs a
-- risk class, a rationale and a validation reference, and the validation reference is one of the validations recorded on
-- the version's change record (recipe.change_record_validation, PR-06), so review by exception on a step is enabled only
-- under change control with a validation reference. The SUBMIT guard mbr_version.critical_elements_risk_assessed (0130)
-- is replaced here (same name and signature; the machine is unchanged) to check this as well as PR-07.
--
-- Messages: EBMR-RBE-001 to EBMR-RBE-009.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1050_rbe_rules)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'review-by-exception rules under change control (DI-26, DI-09, PR-52)'));

insert into iam.permission (code, domain, effect, description) values
  ('REVIEW.RBE_RULE_CHANGE', 'GMP', 'WRITE', 'Change a review-by-exception rule under an approved change record (DI-26, DI-09)');
insert into iam.role_permission (role_code, permission_code) values
  ('QA_MBR_APPROVER', 'REVIEW.RBE_RULE_CHANGE'),
  ('QA_REVIEWER', 'REVIEW.RBE_RULE_CHANGE');

create table recipe.rbe_rule_version (
  id                  uuid primary key default gen_random_uuid(),
  category            text not null references recipe.exception_review_category (category),
  version             integer not null check (version >= 1),
  included            boolean not null,
  min_severity        text not null check (min_severity in ('ALERT', 'ACTION', 'CRITICAL')),
  rationale           text not null check (btrim(rationale) <> ''),
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  unique (category, version)
);
revoke all on recipe.rbe_rule_version from public;
grant select on recipe.rbe_rule_version to ebmr_app;
select platform.enforce_db_time('recipe.rbe_rule_version', array['recorded_at']);
select kernel.register_audited_table('recipe.rbe_rule_version', 'rbe_rule', 'category', true);

-- A mandatory category is always listed (DI-26: customers may raise severity, never switch a mandatory type off).
create function recipe.rbe_rule_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if not new.included and (select k.mandatory from recipe.exception_review_category k where k.category = new.category) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-RBE-002 review category %s is mandatory: a rule may raise its severity but never take it off the review (DI-26)', new.category);
  end if;
  if new.version <> 1 + coalesce((select max(v.version) from recipe.rbe_rule_version v where v.category = new.category), 0) then
    raise exception using errcode = 'P0001', message = format('EBMR-RBE-003 rule %s: version %s is not the next version', new.category, new.version);
  end if;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.rbe_rule_version for each row execute function recipe.rbe_rule_guard();

select platform.register_config_area('RBE_RULE', 'recipe.rbe_rule_version',
  'Review-by-exception rules: per review category, listed or not and the least severity shown (DI-26)',
  array['category'], array['version', 'included', 'min_severity', 'rationale'], 'recorded_at', 'recorded_at');

select kernel.set_actor_context(null);

create function recipe.severity_rank(p text) returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p when 'ALERT' then 1 when 'ACTION' then 2 when 'CRITICAL' then 3 end
$$;

-- Set the rule of a category: a new version, under the change record of the command (kernel 1195 guard).
create function recipe.set_rbe_rule(p_category text, p_included boolean, p_min_severity text, p_rationale text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('REVIEW.RBE_RULE_CHANGE', '{}'::jsonb);
  if not exists (select 1 from recipe.exception_review_category k where k.category = p_category) then
    raise exception using errcode = 'P0001', message = format('EBMR-RBE-001 unknown review category %s', coalesce(p_category, 'none'));
  end if;
  if p_included is null or recipe.severity_rank(p_min_severity) is null then
    raise exception using errcode = 'P0001', message = 'EBMR-RBE-001 a rule says whether the category is listed and its least severity (ALERT, ACTION or CRITICAL)';
  end if;
  if kernel.is_blank(p_rationale) then
    raise exception using errcode = 'P0001', message = format('EBMR-RBE-004 rule %s: a rule change needs its rationale', p_category);
  end if;
  perform 1 from recipe.exception_review_category k where k.category = p_category for update;
  insert into recipe.rbe_rule_version (category, version, included, min_severity, rationale, recorded_by_person, recorded_by_account)
  values (p_category, 1 + coalesce((select max(v.version) from recipe.rbe_rule_version v where v.category = p_category), 0),
          p_included, p_min_severity, btrim(p_rationale), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- The rule of every category in force at p_at. A category without a version is listed with the severity as raised.
create function recipe.rbe_rules_as_of(p_at timestamptz)
returns table (category text, mandatory boolean, included boolean, min_severity text, version integer, rationale text, valid_from timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select k.category, k.mandatory, coalesce(v.included, true), coalesce(v.min_severity, 'ALERT'), v.version, v.rationale, v.recorded_at
  from recipe.exception_review_category k
  left join lateral (select * from recipe.rbe_rule_version x where x.category = k.category and x.recorded_at <= p_at
                     order by x.version desc limit 1) v on true
  order by k.category
$$;

-- The register's review view with the severity each item shows under the rules in force now.
create view recipe.exception_register_rbe as
  select r.*, case when recipe.severity_rank(q.min_severity) > recipe.severity_rank(r.severity) then q.min_severity else r.severity end as review_severity,
         q.version as rule_version, q.included as listed
  from recipe.exception_register_review r join recipe.rbe_rules_as_of(clock_timestamp()) q on q.category = r.category;
revoke all on recipe.exception_register_rbe from public;
grant select on recipe.exception_register_rbe to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- PR-52 clause 2: review by exception on a step needs a validation reference under change control
-- ---------------------------------------------------------------------------------------------

-- Problems of the MBR's REVIEW_BY_EXCEPTION reductions of version p_id: each needs a risk class, a rationale and a
-- validation reference that is one of the validations of the version's change record.
create function recipe.rbe_reduction_problems(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  with content as (select (recipe.current_content(p_id)).content as c),
  red as (select x from content, jsonb_array_elements(coalesce(c -> 'riskReductions', '[]')) x where x ->> 'kind' = 'REVIEW_BY_EXCEPTION'),
  vals as (select cv.validation_ref from recipe.mbr_version v join recipe.change_record_validation cv on cv.change_record_id = v.change_record_id
           where v.id = p_id),
  bad as (
    select x ->> 'id' as id,
           case when coalesce(btrim(x ->> 'riskClass'), '') = '' or coalesce(btrim(x ->> 'rationale'), '') = ''
                  then 'needs a risk class and a rationale'
                when coalesce(btrim(x ->> 'validationRef'), '') = ''
                  then 'needs a validation reference'
                when not exists (select 1 from vals where vals.validation_ref = btrim(x ->> 'validationRef'))
                  then format('cites validation %s, which is not a validation of the version''s change record', btrim(x ->> 'validationRef'))
           end as problem
    from red)
  select string_agg(format('review by exception %s %s', id, problem), '; ' order by id) from bad where problem is not null
$$;

-- The SUBMIT guard of 0130 (PR-07), now also checking review-by-exception reductions (PR-52).
create or replace function recipe.guard_critical_elements_risk_assessed(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  with content as (select (recipe.current_content(p_id)).content as c),
  critical as (
    select x ->> 'id' as id from content, jsonb_array_elements(coalesce(c -> 'parameters', '[]') || coalesce(c -> 'calculations', '[]')) x
    where x ->> 'criticality' = 'CRITICAL'),
  links as (select subjects from recipe.current_risk_links(p_id)),
  uncovered as (select k.id from critical k
                where not exists (select 1 from links l where cardinality(l.subjects) = 0 or k.id = any (l.subjects))),
  rbe as (select recipe.rbe_reduction_problems(p_id) as p)
  select case when exists (select 1 from uncovered)
    then format('critical elements %s have no linked risk assessment: link an approved, versioned assessment before submitting (PR-07)',
                (select string_agg(id, ', ' order by id) from uncovered))
    when (select p from rbe) is not null
    then format('%s: review by exception on a step is enabled only under change control with a validation reference (PR-52) [EBMR-RBE-005]',
                (select p from rbe)) end
$$;

revoke all on function recipe.rbe_rule_guard(), recipe.severity_rank(text), recipe.set_rbe_rule(text, boolean, text, text),
                       recipe.rbe_rules_as_of(timestamptz), recipe.rbe_reduction_problems(uuid) from public;
grant execute on function recipe.severity_rank(text), recipe.set_rbe_rule(text, boolean, text, text), recipe.rbe_rules_as_of(timestamptz),
                          recipe.rbe_reduction_problems(uuid) to ebmr_app;

reset role;
