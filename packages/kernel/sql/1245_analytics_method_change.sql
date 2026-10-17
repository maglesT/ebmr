-- Phase 6A slice 6A-1: method versions and reference sets under configuration change control, and the read views of
-- the methods and flags screens (ADR 0020 point 6; draft controls DI-52, DI-53; DI-09; interfaces
-- slice-6A-0-interfaces.md section 2; D-6A-1-6 to D-6A-1-9).
--
-- Handbook: modules/analytics.md
--
-- Writers (SECURITY DEFINER, EXECUTE to ebmr_app; inside kernel.begin_command, ADR 0016). Both refuse administrators
-- first (iam.assert_not_administrator, DI-18), then need ANALYTICS.METHOD (DI-17). The row is then written into the
-- configuration table, whose guard (kernel 1195, a00_config_change) refuses it unless the command carries an APPROVED,
-- open change record naming the area (EBMR-CFG-001 to -004; DI-09), and whose version log makes it a configuration
-- version naming that record, so platform.config_as_of gives the methods in force at any past instant.
--   analytics.set_method_version(def)  a version of a method (area ANALYTICS_METHOD): EFFECTIVE, or RETIRED later.
--   analytics.set_reference_set(def)   a reference set (area ANALYTICS_REFERENCE): EFFECTIVE, or RETIRED later (its
--                                      model must be its candidate's: kernel 1241 EBMR-ANA-010).
-- Rules on the tables themselves (BEFORE INSERT, every writer, the release included; D-6A-1-6):
--   EBMR-ANA-013  a method version never changes: a later row of the same method and version keeps its parameters,
--                 their SHA-256, its intended use and its code identity (retuning or new code is a new version); it
--                 may only retire it, and a retired version stays retired; a version is retired only once it exists.
--   EBMR-ANA-014  a reference set never changes: a later row of the same id keeps its method, scope, batches, candidate
--                 and model; it may only retire it, once.
--   EBMR-ANA-015  a malformed definition (the writers' own checks).
-- Read views (SELECT to ebmr_app; the screens read only views and the restricted definer functions):
--   analytics.method_version_v1        every method-version row with the instant the next row of the same version
--                                      took effect (valid_to), the change record it was written under and its basis.
--   analytics.reference_set_v1         every reference-set row likewise (the model itself is not shown).
--   analytics.flag_v1                  every unrestricted flag of a DONE run, with its current disposition (if any).
--   analytics.flag_disposition_v1      every disposition of an unrestricted flag, marked current when nothing
--                                      supersedes it.
--   analytics.run_v1                   every run with its method version, reference set, trigger, inputs (view, version,
--                                      filter, data_as_of, rows, SHA-256), runtime, start, end, status, output SHA-256,
--                                      counts and error (a run unended an hour after it started is shown FAILED with no
--                                      end, as the monitor counts it; D-6A-0-3).
-- Restricted read (SECURITY DEFINER, EXECUTE to ebmr_app; DI-53):
--   analytics.person_flag_dispositions(flag)  the dispositions of a restricted flag, only for a person holding
--                                      ANALYTICS.DI_REVIEW (EBMR-ANA-007).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Table rules
-- ---------------------------------------------------------------------------------------------

create function analytics.method_version_rules() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  p analytics.method_version;
begin
  select * into p from analytics.method_version m
   where m.method = new.method and m.version = new.version
   order by m.valid_from desc, m.recorded_at desc limit 1;
  if p.id is null then
    if new.status <> 'EFFECTIVE' then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-ANA-013 %s version %s does not exist: a version is made EFFECTIVE before it can be retired (DI-52)', new.method, new.version);
    end if;
    return new;
  end if;
  if p.status = 'RETIRED' then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-013 %s version %s is retired and stays retired: a method changed or brought back is a new version (DI-52)', new.method, new.version);
  end if;
  if new.status <> 'RETIRED' or new.parameters is distinct from p.parameters or new.parameters_sha256 is distinct from p.parameters_sha256
     or new.intended_use is distinct from p.intended_use or new.code_identity is distinct from p.code_identity then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-013 %s version %s is in force and never changes: a later row only retires it with the same parameters, intended use and code; retuning or new code is a new version (DI-52)',
      new.method, new.version);
  end if;
  return new;
end
$$;
revoke all on function analytics.method_version_rules() from public;
create trigger a20_method_version_rules before insert on analytics.method_version for each row execute function analytics.method_version_rules();

create function analytics.reference_set_rules() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  p analytics.reference_set;
begin
  select * into p from analytics.reference_set s where s.id = new.id order by s.valid_from desc, s.recorded_at desc limit 1;
  if p.id is null then
    if new.status <> 'EFFECTIVE' then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-ANA-014 reference set %s does not exist: a set is made EFFECTIVE before it can be retired (DI-52)', new.id);
    end if;
    return new;
  end if;
  if p.status = 'RETIRED' or new.status <> 'RETIRED' or new.method is distinct from p.method or new.scope is distinct from p.scope
     or new.batch_ids is distinct from p.batch_ids or new.candidate_output is distinct from p.candidate_output
     or new.model is distinct from p.model or new.model_sha256 is distinct from p.model_sha256 then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-014 reference set %s never changes: a later row only retires it, once, with the same method, scope, batches, candidate and model; a new reference set is a new id (DI-52)',
      new.id);
  end if;
  return new;
end
$$;
revoke all on function analytics.reference_set_rules() from public;
create trigger a20_reference_set_rules before insert on analytics.reference_set for each row execute function analytics.reference_set_rules();

-- ---------------------------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------------------------

-- p_def: {method, version, status, title, intendedUse, acceptance (object), parameters (object), parametersSha256,
-- codeIdentity, validationRef}. The server computes the SHA-256 of the canonical parameters and the code identity from
-- the analytics package; the runner checks the hash again before every run (D-6A-1-7).
create function analytics.set_method_version(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('ANALYTICS.METHOD', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(p_def) is distinct from 'object'
     or coalesce(p_def ->> 'method', '') !~ '^[A-Z]+(\.[A-Z0-9_]+)+$'
     or pg_catalog.jsonb_typeof(p_def -> 'version') is distinct from 'number' or (p_def ->> 'version') !~ '^[1-9][0-9]{0,8}$'
     or coalesce(p_def ->> 'status', '') not in ('EFFECTIVE', 'RETIRED')
     or coalesce(pg_catalog.btrim(p_def ->> 'title'), '') = '' or coalesce(pg_catalog.btrim(p_def ->> 'intendedUse'), '') = ''
     or pg_catalog.jsonb_typeof(p_def -> 'acceptance') is distinct from 'object' or pg_catalog.jsonb_typeof(p_def -> 'parameters') is distinct from 'object'
     or coalesce(p_def ->> 'parametersSha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(pg_catalog.btrim(p_def ->> 'codeIdentity'), '') = '' or coalesce(pg_catalog.btrim(p_def ->> 'validationRef'), '') = '' then
    raise exception using errcode = 'P0001', message =
      'EBMR-ANA-015 a method version names its method, version, status (EFFECTIVE or RETIRED), title, intended use, acceptance criteria, parameters and their SHA-256, code identity and validation reference (DI-52)';
  end if;
  insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
  values (p_def ->> 'method', (p_def ->> 'version')::integer, p_def ->> 'status', pg_catalog.btrim(p_def ->> 'title'), pg_catalog.btrim(p_def ->> 'intendedUse'),
          p_def -> 'acceptance', p_def -> 'parameters', p_def ->> 'parametersSha256', pg_catalog.btrim(p_def ->> 'codeIdentity'), pg_catalog.btrim(p_def ->> 'validationRef'))
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function analytics.set_method_version(jsonb) from public;
grant execute on function analytics.set_method_version(jsonb) to ebmr_app;

-- p_def: {id (null: a new set), method, scope (object), batchIds (uuid list), candidateOutput, model (object),
-- modelSha256, status}. Returns the set's id.
create function analytics.set_reference_set(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id    uuid;
  v_batch uuid[];
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('ANALYTICS.METHOD', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(p_def) is distinct from 'object'
     or (p_def ? 'id' and pg_catalog.jsonb_typeof(p_def -> 'id') not in ('string', 'null'))
     or (pg_catalog.jsonb_typeof(p_def -> 'id') = 'string' and not pg_catalog.pg_input_is_valid(p_def ->> 'id', 'uuid'))
     or coalesce(p_def ->> 'method', '') !~ '^[A-Z]+(\.[A-Z0-9_]+)+$'
     or pg_catalog.jsonb_typeof(p_def -> 'scope') is distinct from 'object' or pg_catalog.jsonb_typeof(p_def -> 'model') is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_def -> 'batchIds') is distinct from 'array' or pg_catalog.jsonb_array_length(p_def -> 'batchIds') = 0
     or exists (select 1 from pg_catalog.jsonb_array_elements(p_def -> 'batchIds') b
                 where pg_catalog.jsonb_typeof(b) <> 'string' or not pg_catalog.pg_input_is_valid(b #>> '{}', 'uuid'))
     or not pg_catalog.pg_input_is_valid(coalesce(p_def ->> 'candidateOutput', ''), 'uuid')
     or coalesce(p_def ->> 'modelSha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_def ->> 'status', '') not in ('EFFECTIVE', 'RETIRED') then
    raise exception using errcode = 'P0001', message =
      'EBMR-ANA-015 a reference set names its method, scope, reference batches, model candidate, model and its SHA-256, and its status (EFFECTIVE or RETIRED) (DI-52)';
  end if;
  v_id := coalesce((p_def ->> 'id')::uuid, pg_catalog.gen_random_uuid());
  select array_agg(b::uuid order by o) into v_batch from pg_catalog.jsonb_array_elements_text(p_def -> 'batchIds') with ordinality x(b, o);
  insert into analytics.reference_set (id, method, scope, batch_ids, candidate_output, model, model_sha256, status)
  values (v_id, p_def ->> 'method', p_def -> 'scope', v_batch, (p_def ->> 'candidateOutput')::uuid, p_def -> 'model', p_def ->> 'modelSha256', p_def ->> 'status');
  return v_id;
end
$$;
revoke all on function analytics.set_reference_set(jsonb) from public;
grant execute on function analytics.set_reference_set(jsonb) to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- Read views
-- ---------------------------------------------------------------------------------------------

create view analytics.method_version_v1 as
  select m.id as row_id, m.method, m.version, m.status, m.title, m.intended_use, m.acceptance, m.parameters, m.parameters_sha256, m.code_identity,
         m.validation_ref, m.valid_from,
         lead(m.valid_from) over (partition by m.method, m.version order by m.valid_from, m.recorded_at, m.id) as valid_to,
         c.number as change_record, v.basis, m.recorded_at
    from analytics.method_version m
    left join platform.config_version v on v.area = 'ANALYTICS_METHOD' and v.source_row ->> 'id' = m.id::text
    left join platform.change_record c on c.id = v.change_record_id;

create view analytics.reference_set_v1 as
  select s.id as reference_set_id, s.method, s.scope, s.batch_ids, s.candidate_output, s.model_sha256, s.status, s.valid_from,
         lead(s.valid_from) over (partition by s.id order by s.valid_from, s.recorded_at) as valid_to,
         c.number as change_record, v.basis, s.recorded_at
    from analytics.reference_set s
    left join platform.config_version v on v.area = 'ANALYTICS_REFERENCE' and v.source_row ->> 'id' = s.id::text
                                       and (v.source_row ->> 'valid_from')::timestamptz = s.valid_from
    left join platform.change_record c on c.id = v.change_record_id;

create view analytics.flag_disposition_v1 as
  select d.id as disposition_id, d.flag as flag_id, d.verdict, d.cause, d.deviation_ref, d.supersedes, d.reason, d.person_id, d.account_id,
         d.recorded_at, not exists (select 1 from analytics.flag_disposition s where s.supersedes = d.id) as current
    from analytics.flag_disposition d
    join analytics.flag f on f.id = d.flag and not f.restricted;

create view analytics.flag_v1 as
  select f.id as flag_id, f.run as run_id, f.output as output_id, r.method, r.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons,
         f.raised_at,
         (select min((x ->> 'data_as_of')::timestamptz) from jsonb_array_elements(r.inputs) x) as data_as_of,
         e.ended_at as finished_at,
         (select d.id from analytics.flag_disposition d
           where d.flag = f.id and not exists (select 1 from analytics.flag_disposition s where s.supersedes = d.id)) as current_disposition,
         true as advisory
    from analytics.flag f
    join analytics.run r on r.id = f.run
    join analytics.run_end e on e.run = r.id and e.status = 'DONE'
   where not f.restricted;

create view analytics.run_v1 as
  select r.id as run_id, r.method, r.version, r.reference_set, r.trigger, r.inputs, r.runtime, r.started_at,
         (select min((x ->> 'data_as_of')::timestamptz) from jsonb_array_elements(r.inputs) x) as data_as_of,
         case when e.status is not null then e.status
              when r.started_at < statement_timestamp() - interval '1 hour' then 'FAILED'
              else 'RUNNING' end as status,
         e.ended_at, e.output_sha256, e.counts, e.error
    from analytics.run r
    left join analytics.run_end e on e.run = r.id;

revoke all on analytics.method_version_v1, analytics.reference_set_v1, analytics.flag_disposition_v1, analytics.flag_v1, analytics.run_v1 from public;
grant select on analytics.method_version_v1, analytics.reference_set_v1, analytics.flag_disposition_v1, analytics.flag_v1, analytics.run_v1 to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- Restricted read
-- ---------------------------------------------------------------------------------------------

create function analytics.person_flag_dispositions(p_flag uuid) returns setof analytics.flag_disposition
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  begin
    perform iam.require_permission('ANALYTICS.DI_REVIEW', '{}'::jsonb);
  exception when raise_exception then
    if sqlerrm like 'EBMR-IAM-040%' then
      raise exception using errcode = 'P0001', message =
        'EBMR-ANA-007 flags about a person or an account are restricted to data-integrity review: they need ANALYTICS.DI_REVIEW (DI-53)';
    end if;
    raise;
  end;
  return query
    select d.* from analytics.flag_disposition d
      join analytics.flag f on f.id = d.flag and f.restricted
      join analytics.run_end e on e.run = f.run and e.status = 'DONE'
     where d.flag = p_flag
     order by d.recorded_at, d.id;
end
$$;
revoke all on function analytics.person_flag_dispositions(uuid) from public;
grant execute on function analytics.person_flag_dispositions(uuid) to ebmr_app;

reset role;
