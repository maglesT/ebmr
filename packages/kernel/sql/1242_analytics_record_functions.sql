-- Phase 6A slice 6A-0: the analytics record functions and the analytics role's segregation check (ADR 0020 points 3,
-- 4 and 6; draft controls DI-51, DI-52, DI-53; interfaces slice-6A-0-interfaces.md section 2; D-6A-0-2, D-6A-0-3).
--
-- Handbook: modules/analytics.md
--
-- Runner functions (SECURITY DEFINER, EXECUTE to ebmr_analytics only). The runner holds no person and runs no command:
-- each writer installs the runner's system identity for its own insert (role ANALYTICS_RUNNER, source SYSTEM, the nil
-- person, account and session as the software release has, the run id as correlation id), so the audit trail names
-- every row it writes, and puts back whatever context was there before. The identity module never validates that
-- identity, so nothing that needs a validated actor (a permission, a command, a signature) can run under it.
--   effective_methods()       the method versions EFFECTIVE at statement time, read from the configuration history
--                             (platform.config_as_of).
--   begin_run(...)            refused unless the version (EBMR-ANA-001) and the reference set (-002) are EFFECTIVE now,
--                             or when the trigger, the inputs (each a catalogued input with its version, filter,
--                             data_as_of, row count and SHA-256) or the runtime miss a field (-003).
--   record_output(...)        refused for an unknown or ended run (-005) or a malformed output (-011).
--   record_flag(...)          refused without reasons (each with a code and a text: -004), for an unknown or ended
--                             run (-005), or for an output of another run (-011).
--   finish_run, fail_run      once per run (-006). A run's outputs count only after finish_run (D-6A-0-3).
-- Application functions (SECURITY DEFINER, EXECUTE to ebmr_app; inside kernel.begin_command, ADR 0016). Both refuse
-- administrators first (iam.assert_not_administrator, DI-18), then check the permission (DI-17):
--   record_disposition(...)   ANALYTICS.DISPOSITION, and ANALYTICS.DI_REVIEW for a restricted flag (-007). A flag has
--                             one current disposition: a later one supersedes it, with a reason, on the same flag
--                             (-008); an unknown flag, a flag of a run that is not DONE or a malformed verdict or cause
--                             is refused (-009).
--   person_flags(from, to)    the restricted flags (about a PERSON or an ACCOUNT) of DONE runs raised in [from, to),
--                             only for a person holding ANALYTICS.DI_REVIEW (-007; DI-53).
-- Owner only (migrations): register_input(...) puts a report view or a parameterised report row function on the
-- analytics role's allow-list and grants it exactly that (-012 otherwise).
-- analytics.role_problems() is what sandbox.segregation_problems() reports about ebmr_analytics in a GMP database.
-- Messages: EBMR-ANA-001 to EBMR-ANA-012.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- The runner's identity
-- ---------------------------------------------------------------------------------------------

-- The identity the database records the runner's rows under (as recipe.system_actor, recipe-core 0280).
create function analytics.runner_actor(p_run uuid) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.jsonb_build_object(
    'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
    'role_code', 'ANALYTICS_RUNNER', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
    'site_zone', coalesce(kernel.site_zone(), 'UTC'), 'correlation_id', p_run,
    'legal_name', 'SYSTEM (analytics runner, advisory only)')
$$;
revoke all on function analytics.runner_actor(uuid) from public;

-- Installs the runner's identity for run p_run and returns the context it replaced (NULL when there was none).
create function analytics.enter_runner(p_run uuid) returns jsonb
language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
declare
  v_prev jsonb := kernel.current_actor();
begin
  perform kernel.set_actor_context(analytics.runner_actor(p_run));
  return v_prev;
end
$$;
revoke all on function analytics.enter_runner(uuid) from public;

-- The run p_run, locked (FOR SHARE by the writers, FOR UPDATE by the end), refused when unknown; with its end status.
create function analytics.open_run(p_run uuid, p_for_end boolean) returns text
language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
declare
  v_found boolean;
  v_status text;
begin
  if p_for_end then
    perform 1 from analytics.run r where r.id = p_run for update;
  else
    perform 1 from analytics.run r where r.id = p_run for share;
  end if;
  v_found := found;
  if not v_found then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-005 run %s does not exist (DI-52)', coalesce(p_run::text, 'NULL'));
  end if;
  select e.status into v_status from analytics.run_end e where e.run = p_run;
  return v_status;
end
$$;
revoke all on function analytics.open_run(uuid, boolean) from public;

-- Reasons: an array of objects, each with a non-blank code and text (a weight and evidence are optional).
create function analytics.reasons_ok(p_reasons jsonb, p_min integer) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(pg_catalog.jsonb_typeof(p_reasons) = 'array' and pg_catalog.jsonb_array_length(p_reasons) >= p_min
    and not exists (select 1 from pg_catalog.jsonb_array_elements(p_reasons) x
                     where pg_catalog.jsonb_typeof(x) <> 'object'
                        or pg_catalog.jsonb_typeof(x -> 'code') is distinct from 'string' or pg_catalog.btrim(x ->> 'code') = ''
                        or pg_catalog.jsonb_typeof(x -> 'text') is distinct from 'string' or pg_catalog.btrim(x ->> 'text') = ''), false)
$$;
revoke all on function analytics.reasons_ok(jsonb, integer) from public;

-- ---------------------------------------------------------------------------------------------
-- Configuration in force
-- ---------------------------------------------------------------------------------------------

create function analytics.effective_methods() returns setof analytics.method_version
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select (pg_catalog.jsonb_populate_record(null::analytics.method_version, v.source_row)).*
    from platform.config_as_of(pg_catalog.statement_timestamp()) c
    join platform.config_version v on v.id = c.version_id
   where c.area = 'ANALYTICS_METHOD' and v.source_row ->> 'status' = 'EFFECTIVE'
   order by v.source_row ->> 'method', (v.source_row ->> 'version')::integer
$$;
revoke all on function analytics.effective_methods() from public;
grant execute on function analytics.effective_methods() to ebmr_analytics;

-- The reference sets EFFECTIVE at statement time (owner only; begin_run reads it).
create function analytics.effective_reference_sets() returns setof analytics.reference_set
language sql stable set search_path = pg_catalog, pg_temp as $$
  select (pg_catalog.jsonb_populate_record(null::analytics.reference_set, v.source_row)).*
    from platform.config_as_of(pg_catalog.statement_timestamp()) c
    join platform.config_version v on v.id = c.version_id
   where c.area = 'ANALYTICS_REFERENCE' and v.source_row ->> 'status' = 'EFFECTIVE'
$$;
revoke all on function analytics.effective_reference_sets() from public;

-- ---------------------------------------------------------------------------------------------
-- Runner writers
-- ---------------------------------------------------------------------------------------------

create function analytics.begin_run(p_method text, p_version integer, p_reference_set uuid, p_trigger text, p_inputs jsonb, p_runtime jsonb)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id   uuid := pg_catalog.gen_random_uuid();
  v_prev jsonb;
  x      jsonb;
  v_reg  analytics.input_registry;
begin
  if not exists (select 1 from analytics.effective_methods() m where m.method = p_method and m.version = p_version) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-001 method %s version %s is not EFFECTIVE now: a run needs a method version in force under an approved change record (DI-52)',
      coalesce(p_method, 'NULL'), coalesce(p_version::text, 'NULL'));
  end if;
  if p_reference_set is not null
     and not exists (select 1 from analytics.effective_reference_sets() s where s.id = p_reference_set and s.method = p_method) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-002 reference set %s is not an EFFECTIVE reference set of %s now (DI-52)', p_reference_set, p_method);
  end if;
  if p_trigger is null or p_trigger not in ('SCHEDULED', 'BATCH_COMPLETE', 'ON_DEMAND') then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-003 a run is triggered SCHEDULED, BATCH_COMPLETE or ON_DEMAND, not %s (DI-52)', coalesce(p_trigger, 'NULL'));
  end if;
  if pg_catalog.jsonb_typeof(p_inputs) is distinct from 'array' or pg_catalog.jsonb_array_length(p_inputs) = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-ANA-003 a run names its inputs: a non-empty list of view, version, filter, data_as_of, rows and sha256 (DI-52)';
  end if;
  for x in select value from pg_catalog.jsonb_array_elements(p_inputs) loop
    v_reg := null;
    if pg_catalog.jsonb_typeof(x) = 'object' and pg_catalog.jsonb_typeof(x -> 'view') = 'string' then
      select * into v_reg from analytics.input_registry i where i.name = x ->> 'view';
    end if;
    if v_reg.name is null
       or not (x ?& array['view', 'version', 'filter', 'data_as_of', 'rows', 'sha256'])
       or pg_catalog.jsonb_typeof(x -> 'version') is distinct from 'number' or (x ->> 'version') is distinct from v_reg.version::text
       or pg_catalog.jsonb_typeof(x -> 'filter') not in ('object', 'null')
       or pg_catalog.jsonb_typeof(x -> 'data_as_of') is distinct from 'string' or not pg_catalog.pg_input_is_valid(x ->> 'data_as_of', 'timestamptz')
       or pg_catalog.jsonb_typeof(x -> 'rows') is distinct from 'number' or (x ->> 'rows') !~ '^[0-9]{1,18}$'
       or pg_catalog.jsonb_typeof(x -> 'sha256') is distinct from 'string' or (x ->> 'sha256') !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-ANA-003 input %s: each input is a catalogued input (analytics.input_catalog_v1) at its version, with filter, data_as_of, rows and sha256 (DI-52)',
        coalesce(x::text, 'NULL'));
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(p_runtime) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_runtime -> 'package') is distinct from 'string' or pg_catalog.btrim(p_runtime ->> 'package') = ''
     or pg_catalog.jsonb_typeof(p_runtime -> 'commit') is distinct from 'string' or pg_catalog.btrim(p_runtime ->> 'commit') = ''
     or pg_catalog.jsonb_typeof(p_runtime -> 'node') is distinct from 'string' or pg_catalog.btrim(p_runtime ->> 'node') = ''
     or pg_catalog.jsonb_typeof(p_runtime -> 'libraries') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-ANA-003 a run records its runtime: package, commit, node and libraries (DI-52)';
  end if;
  v_prev := analytics.enter_runner(v_id);
  insert into analytics.run (id, method, version, reference_set, trigger, inputs, runtime)
  values (v_id, p_method, p_version, p_reference_set, p_trigger, p_inputs, p_runtime);
  perform kernel.set_actor_context(v_prev);
  return v_id;
end
$$;

create function analytics.record_output(p_run uuid, p_subject_kind text, p_subject_ref text, p_kind text, p_values jsonb, p_reasons jsonb)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id   uuid;
  v_prev jsonb;
begin
  if analytics.open_run(p_run, false) is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-005 run %s has ended: it records no more outputs (DI-52)', p_run);
  end if;
  if pg_catalog.jsonb_typeof(p_values) is distinct from 'object' or not analytics.reasons_ok(coalesce(p_reasons, '[]'::jsonb), 0)
     or coalesce(p_subject_kind, '') not in ('BATCH', 'PRODUCT_ITEM', 'GROUP', 'EQUIPMENT_STEP_TAG', 'PERSON', 'ACCOUNT', 'METHOD')
     or coalesce(pg_catalog.btrim(p_subject_ref), '') = '' or p_kind is null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-011 an output names its subject (kind and reference), its kind, its values (an object) and its reasons (each a code and a text), not %s %s %s (DI-52)',
      coalesce(p_subject_kind, 'NULL'), coalesce(p_subject_ref, 'NULL'), coalesce(p_kind, 'NULL'));
  end if;
  v_prev := analytics.enter_runner(p_run);
  insert into analytics.output (run, subject_kind, subject_ref, kind, "values", reasons)
  values (p_run, p_subject_kind, p_subject_ref, p_kind, p_values, coalesce(p_reasons, '[]'::jsonb))
  returning id into v_id;
  perform kernel.set_actor_context(v_prev);
  return v_id;
end
$$;

create function analytics.record_flag(p_run uuid, p_output uuid, p_subject_kind text, p_subject_ref text, p_rule text, p_severity text, p_reasons jsonb)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id   uuid;
  v_prev jsonb;
begin
  if not analytics.reasons_ok(p_reasons, 1) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-004 a flag shows why it was raised: at least one reason, each with a code and a text (rule %s; DI-52, DI-53)', coalesce(p_rule, 'NULL'));
  end if;
  if analytics.open_run(p_run, false) is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-005 run %s has ended: it raises no more flags (DI-52)', p_run);
  end if;
  if p_output is not null and not exists (select 1 from analytics.output o where o.id = p_output and o.run = p_run) then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-011 output %s is not an output of run %s (DI-52)', p_output, p_run);
  end if;
  if coalesce(p_subject_kind, '') not in ('BATCH', 'PRODUCT_ITEM', 'GROUP', 'EQUIPMENT_STEP_TAG', 'PERSON', 'ACCOUNT', 'METHOD')
     or coalesce(pg_catalog.btrim(p_subject_ref), '') = '' or coalesce(p_rule, '') !~ '^[A-Z][A-Z0-9_]*$'
     or coalesce(p_severity, '') not in ('INFO', 'ATTENTION', 'HIGH') then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-011 a flag names its subject (kind and reference), its rule and its severity (INFO, ATTENTION or HIGH), not %s %s %s %s (DI-52)',
      coalesce(p_subject_kind, 'NULL'), coalesce(p_subject_ref, 'NULL'), coalesce(p_rule, 'NULL'), coalesce(p_severity, 'NULL'));
  end if;
  v_prev := analytics.enter_runner(p_run);
  insert into analytics.flag (run, output, subject_kind, subject_ref, rule, severity, reasons, restricted)
  values (p_run, p_output, p_subject_kind, p_subject_ref, p_rule, p_severity, p_reasons, p_subject_kind in ('PERSON', 'ACCOUNT'))
  returning id into v_id;
  perform kernel.set_actor_context(v_prev);
  return v_id;
end
$$;

create function analytics.finish_run(p_run uuid, p_output_sha256 text, p_counts jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_prev jsonb;
begin
  if analytics.open_run(p_run, true) is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-006 run %s has already ended: a run ends once (DI-52)', p_run);
  end if;
  if coalesce(p_output_sha256, '') !~ '^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(coalesce(p_counts, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-ANA-011 a finished run records the SHA-256 of its canonical outputs and its counts (an object) (DI-52)';
  end if;
  v_prev := analytics.enter_runner(p_run);
  insert into analytics.run_end (run, status, output_sha256, counts) values (p_run, 'DONE', p_output_sha256, coalesce(p_counts, '{}'::jsonb));
  perform kernel.set_actor_context(v_prev);
end
$$;

create function analytics.fail_run(p_run uuid, p_error text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_prev jsonb;
begin
  if analytics.open_run(p_run, true) is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-006 run %s has already ended: a run ends once (DI-52)', p_run);
  end if;
  if coalesce(pg_catalog.btrim(p_error), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ANA-011 a failed run records its error (DI-52)';
  end if;
  v_prev := analytics.enter_runner(p_run);
  insert into analytics.run_end (run, status, error) values (p_run, 'FAILED', p_error);
  perform kernel.set_actor_context(v_prev);
end
$$;

revoke all on function analytics.begin_run(text, integer, uuid, text, jsonb, jsonb) from public;
revoke all on function analytics.record_output(uuid, text, text, text, jsonb, jsonb) from public;
revoke all on function analytics.record_flag(uuid, uuid, text, text, text, text, jsonb) from public;
revoke all on function analytics.finish_run(uuid, text, jsonb) from public;
revoke all on function analytics.fail_run(uuid, text) from public;
grant execute on function analytics.begin_run(text, integer, uuid, text, jsonb, jsonb) to ebmr_analytics;
grant execute on function analytics.record_output(uuid, text, text, text, jsonb, jsonb) to ebmr_analytics;
grant execute on function analytics.record_flag(uuid, uuid, text, text, text, text, jsonb) to ebmr_analytics;
grant execute on function analytics.finish_run(uuid, text, jsonb) to ebmr_analytics;
grant execute on function analytics.fail_run(uuid, text) to ebmr_analytics;

-- ---------------------------------------------------------------------------------------------
-- Application functions (inside a command)
-- ---------------------------------------------------------------------------------------------

create function analytics.record_disposition(p_flag uuid, p_verdict text, p_cause text, p_deviation_ref text, p_supersedes uuid, p_reason text)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor   jsonb;
  f         analytics.flag;
  v_current uuid;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('ANALYTICS.DISPOSITION', '{}'::jsonb);
  select * into f from analytics.flag g where g.id = p_flag for update;
  if f.id is null or not exists (select 1 from analytics.run_end e where e.run = f.run and e.status = 'DONE') then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-009 flag %s is not a flag of a completed run (DI-52)', coalesce(p_flag::text, 'NULL'));
  end if;
  if f.restricted then
    -- ANALYTICS.DI_REVIEW, refused as EBMR-ANA-007 (the guard's own refusal is EBMR-IAM-040).
    begin
      perform iam.require_permission('ANALYTICS.DI_REVIEW', '{}'::jsonb);
    exception when raise_exception then
      if sqlerrm like 'EBMR-IAM-040%' then
        raise exception using errcode = 'P0001', message = format(
          'EBMR-ANA-007 flag %s is about a %s: it is restricted to data-integrity review and needs ANALYTICS.DI_REVIEW (DI-53)', f.id, lower(f.subject_kind));
      end if;
      raise;
    end;
  end if;
  if coalesce(p_verdict, '') not in ('TRUE_SIGNAL', 'FALSE_ALARM', 'NOT_ASSESSABLE') or char_length(pg_catalog.btrim(coalesce(p_cause, ''))) < 10
     or (p_deviation_ref is not null and pg_catalog.btrim(p_deviation_ref) = '') then
    raise exception using errcode = 'P0001', message =
      'EBMR-ANA-009 a disposition is TRUE_SIGNAL, FALSE_ALARM or NOT_ASSESSABLE, with a cause of at least 10 characters and an optional deviation reference (DI-52)';
  end if;
  select d.id into v_current from analytics.flag_disposition d
   where d.flag = f.id and not exists (select 1 from analytics.flag_disposition s where s.supersedes = d.id);
  if v_current is null and p_supersedes is not null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-008 flag %s has no disposition yet: disposition %s cannot be superseded here (a disposition supersedes only the current one of the same flag; DI-52)', f.id, p_supersedes);
  end if;
  if v_current is not null and p_supersedes is distinct from v_current then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-008 flag %s is dispositioned (%s): a later disposition supersedes that current one of the same flag, with a reason (DI-52)', f.id, v_current);
  end if;
  if p_supersedes is not null and coalesce(pg_catalog.btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-008 superseding disposition %s needs a reason (DI-52)', p_supersedes);
  end if;
  insert into analytics.flag_disposition (flag, verdict, cause, deviation_ref, supersedes, reason, person_id, account_id)
  values (f.id, p_verdict, p_cause, p_deviation_ref, p_supersedes, case when p_supersedes is not null then p_reason end,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function analytics.record_disposition(uuid, text, text, text, uuid, text) from public;
grant execute on function analytics.record_disposition(uuid, text, text, text, uuid, text) to ebmr_app;

create function analytics.person_flags(p_from timestamptz, p_to timestamptz) returns setof analytics.flag
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
  if p_from is null or p_to is null or p_from > p_to then
    raise exception using errcode = 'P0001', message = 'EBMR-ANA-011 a period is two instants, the first not after the second (DI-53)';
  end if;
  return query
    select f.* from analytics.flag f
      join analytics.run_end e on e.run = f.run and e.status = 'DONE'
     where f.restricted and f.raised_at >= p_from and f.raised_at < p_to
     order by f.raised_at, f.id;
end
$$;
revoke all on function analytics.person_flags(timestamptz, timestamptz) from public;
grant execute on function analytics.person_flags(timestamptz, timestamptz) to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- The allow-list of inputs (owner only)
-- ---------------------------------------------------------------------------------------------

-- Registers a report view (p_kind VIEW, p_name 'report.<name>_v<n>') or a parameterised report row function (FUNCTION,
-- p_name its signature) as an input of the analytics role and grants exactly that: SELECT on the view and EXECUTE on
-- the non-volatile report row functions it reads (PostgreSQL checks a function inside a view with the reader's own
-- right), or EXECUTE on the function. Runs under the caller's actor context (migrations: the software release).
create function analytics.register_input(p_kind text, p_name text, p_version integer, p_owner_slice text, p_grain text, p_description text)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_rel  oid;
  v_fn   oid;
  v_name text;
  g      record;
begin
  if p_kind = 'VIEW' then
    v_rel := pg_catalog.to_regclass(p_name);
    if v_rel is null or not exists (select 1 from pg_catalog.pg_class c where c.oid = v_rel and c.relkind = 'v' and c.relnamespace = 'report'::regnamespace) then
      raise exception using errcode = 'P0001', message = format('EBMR-ANA-012 %s is not a view of the report schema', coalesce(p_name, 'NULL'));
    end if;
    v_name := v_rel::regclass::text;
    if v_name !~ ('_v' || p_version || '$') then
      raise exception using errcode = 'P0001', message = format('EBMR-ANA-012 view %s is not version %s of its name', v_name, p_version);
    end if;
    execute format('grant select on %s to ebmr_analytics', v_name);
    for g in select distinct d.refobjid::regprocedure::text as fn, p.provolatile
               from pg_catalog.pg_rewrite rw
               join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::regclass and d.objid = rw.oid
                                          and d.refclassid = 'pg_catalog.pg_proc'::regclass
               join pg_catalog.pg_proc p on p.oid = d.refobjid
              where rw.ev_class = v_rel and p.pronamespace = 'report'::regnamespace loop
      if g.provolatile = 'v' then
        raise exception using errcode = 'P0001', message = format('EBMR-ANA-012 view %s reads the volatile function %s', v_name, g.fn);
      end if;
      execute format('grant execute on function %s to ebmr_analytics', g.fn);
    end loop;
  elsif p_kind = 'FUNCTION' then
    v_fn := pg_catalog.to_regprocedure(p_name);
    if v_fn is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.pronamespace = 'report'::regnamespace and p.provolatile <> 'v') then
      raise exception using errcode = 'P0001', message = format('EBMR-ANA-012 %s is not a non-volatile row function of the report schema', coalesce(p_name, 'NULL'));
    end if;
    v_name := v_fn::regprocedure::text;
    execute format('grant execute on function %s to ebmr_analytics', v_name);
  else
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-012 an input is a VIEW or a FUNCTION, not %s', coalesce(p_kind, 'NULL'));
  end if;
  insert into analytics.input_registry (name, kind, version, owner_slice, grain, description)
  values (v_name, p_kind, p_version, p_owner_slice, p_grain, p_description);
end
$$;
revoke all on function analytics.register_input(text, text, integer, text, text, text) from public;

-- ---------------------------------------------------------------------------------------------
-- The segregation check of the analytics role
-- ---------------------------------------------------------------------------------------------

-- What the analytics role may hold beyond USAGE on report and analytics, as the segregation check reads it: SELECT on
-- a catalogued input view or on the catalogue itself; EXECUTE on a catalogued input function, on a non-volatile report
-- row function a catalogued view reads, or on one of the six runner functions.
create function analytics.role_problems() returns setof text
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  r record;
  v_runner text[] := array[
    'analytics.begin_run(text,integer,uuid,text,jsonb,jsonb)', 'analytics.record_output(uuid,text,text,text,jsonb,jsonb)',
    'analytics.record_flag(uuid,uuid,text,text,text,text,jsonb)', 'analytics.finish_run(uuid,text,jsonb)',
    'analytics.fail_run(uuid,text)', 'analytics.effective_methods()'];
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_analytics') then
    return next 'the analytics role ebmr_analytics does not exist';
    return;
  end if;
  for r in select rolname from pg_catalog.pg_roles
            where rolname = 'ebmr_analytics' and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) loop
    return next 'ebmr_analytics has an elevated role attribute (superuser, createdb, createrole, replication, bypassrls or inherit)';
  end loop;
  for r in select s.rolname as member, g.rolname as of_role from pg_catalog.pg_auth_members m
             join pg_catalog.pg_roles g on g.oid = m.roleid
             join pg_catalog.pg_roles s on s.oid = m.member
            where s.rolname = 'ebmr_analytics' or g.rolname = 'ebmr_analytics'
            order by 1, 2 loop
    return next format('%s is a member of role %s', r.member, r.of_role);
  end loop;
  for r in select * from sandbox.direct_privileges('ebmr_analytics') d
            where not (d.object_kind = 'SCHEMA' and d.object_name in ('report', 'analytics') and d.privilege = 'USAGE')
              and not (d.object_kind = 'TABLE' and d.column_name is null and d.privilege = 'SELECT'
                       and (d.object_name = 'analytics.input_catalog_v1'
                            or exists (select 1 from analytics.input_catalog_v1 i where i.kind = 'VIEW' and i.name = d.object_name)))
              and not (d.object_kind = 'ROUTINE' and d.privilege = 'EXECUTE'
                       and (d.object_name = any (v_runner)
                            or exists (select 1 from analytics.input_catalog_v1 i where i.kind = 'FUNCTION' and i.name = d.object_name)
                            or exists (select 1 from analytics.input_catalog_v1 i
                                         join pg_catalog.pg_rewrite rw on rw.ev_class = pg_catalog.to_regclass(i.name)
                                         join pg_catalog.pg_depend dp on dp.classid = 'pg_catalog.pg_rewrite'::regclass and dp.objid = rw.oid
                                                                     and dp.refclassid = 'pg_catalog.pg_proc'::regclass
                                         join pg_catalog.pg_proc p on p.oid = dp.refobjid
                                        where i.kind = 'VIEW' and p.oid::regprocedure::text = d.object_name
                                          and p.pronamespace = 'report'::regnamespace and p.provolatile <> 'v')))
            order by 1, 2, 3, 4 loop
    return next format('ebmr_analytics holds %s on %s %s%s, beyond reading its catalogued inputs and recording advisory outputs', r.privilege,
                       lower(r.object_kind), r.object_name, coalesce(' (' || r.column_name || ')', ''));
  end loop;
  for r in select d.defaclnamespace::regnamespace::text as ns from pg_catalog.pg_default_acl d
             cross join lateral pg_catalog.aclexplode(d.defaclacl) a
            where a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'ebmr_analytics') loop
    return next format('a default privilege grants to ebmr_analytics (schema %s)', r.ns);
  end loop;
  for r in select p.oid::regprocedure::text as fn from pg_catalog.pg_proc p
            where p.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
              and p.provolatile = 'v'
              and has_function_privilege('ebmr_analytics', p.oid, 'EXECUTE')
              and has_schema_privilege('ebmr_analytics', p.pronamespace, 'USAGE')
              and not (p.oid::regprocedure::text = any (v_runner))
            order by 1 loop
    return next format('ebmr_analytics may execute the volatile function %s', r.fn);
  end loop;
end
$$;
revoke all on function analytics.role_problems() from public;
grant execute on function analytics.role_problems() to ebmr_app;

create or replace function sandbox.segregation_problems() returns setof text
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  v_kind text;
  v_db text := pg_catalog.current_database();
  r record;
begin
  begin
    v_kind := kernel.installation_kind();
  exception when raise_exception then
    return next format('installation marker: %s', sqlerrm);
    return;
  end;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_sandbox') then
    return next 'the sandbox role ebmr_sandbox does not exist';
    return;
  end if;
  for r in select rolname from pg_catalog.pg_roles
            where rolname = 'ebmr_sandbox' and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) loop
    return next 'ebmr_sandbox has an elevated role attribute (superuser, createdb, createrole, replication, bypassrls or inherit)';
  end loop;
  for r in select g.rolname from pg_catalog.pg_auth_members m
             join pg_catalog.pg_roles g on g.oid = m.roleid
             join pg_catalog.pg_roles s on s.oid = m.member
            where s.rolname = 'ebmr_sandbox' order by 1 loop
    return next format('ebmr_sandbox is a member of role %s', r.rolname);
  end loop;

  -- 0980: the listener roles.
  for r in select x.rolname from unnest(array['ebmr_listener', 'ebmr_sandbox_listener']) x(rolname)
            where not exists (select 1 from pg_catalog.pg_roles p where p.rolname = x.rolname) order by 1 loop
    return next format('the listener role %s does not exist', r.rolname);
  end loop;
  for r in select rolname from pg_catalog.pg_roles
            where rolname in ('ebmr_listener', 'ebmr_sandbox_listener')
              and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) order by 1 loop
    return next format('%s has an elevated role attribute (superuser, createdb, createrole, replication, bypassrls or inherit)', r.rolname);
  end loop;
  for r in select s.rolname as member, g.rolname as of_role from pg_catalog.pg_auth_members m
             join pg_catalog.pg_roles g on g.oid = m.roleid
             join pg_catalog.pg_roles s on s.oid = m.member
            where (s.rolname in ('ebmr_listener', 'ebmr_sandbox_listener') and g.rolname <> 'pg_use_reserved_connections')
               or g.rolname in ('ebmr_listener', 'ebmr_sandbox_listener')
            order by 1, 2 loop
    return next format('%s is a member of role %s', r.member, r.of_role);
  end loop;

  if v_kind = 'GMP' then
    if has_database_privilege('ebmr_sandbox', v_db, 'CONNECT') then
      return next format('ebmr_sandbox can connect to the GMP database %s', v_db);
    end if;
    for r in select * from sandbox.direct_privileges('ebmr_sandbox') order by 1, 2, 3, 4 loop
      return next format('ebmr_sandbox holds %s on %s %s%s in a GMP database', r.privilege, lower(r.object_kind), r.object_name,
                         coalesce(' (' || r.column_name || ')', ''));
    end loop;
    for r in select d.defaclnamespace::regnamespace::text as ns from pg_catalog.pg_default_acl d
               cross join lateral pg_catalog.aclexplode(d.defaclacl) a
              where a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'ebmr_sandbox') loop
      return next format('a default privilege grants to ebmr_sandbox (schema %s) in a GMP database', r.ns);
    end loop;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_sandbox_listener') then
      if has_database_privilege('ebmr_sandbox_listener', v_db, 'CONNECT') then
        return next format('ebmr_sandbox_listener can connect to the GMP database %s', v_db);
      end if;
      for r in select * from sandbox.direct_privileges('ebmr_sandbox_listener') order by 1, 2, 3, 4 loop
        return next format('ebmr_sandbox_listener holds %s on %s %s%s in a GMP database', r.privilege, lower(r.object_kind), r.object_name,
                           coalesce(' (' || r.column_name || ')', ''));
      end loop;
      for r in select d.defaclnamespace::regnamespace::text as ns from pg_catalog.pg_default_acl d
                 cross join lateral pg_catalog.aclexplode(d.defaclacl) a
                where a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'ebmr_sandbox_listener') loop
        return next format('a default privilege grants to ebmr_sandbox_listener (schema %s) in a GMP database', r.ns);
      end loop;
    end if;
    -- 1210: the reporting role reads the report views and nothing else (D-P6g-0-1 to 3; decisions 0015, 0016).
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_report') then
      return next 'the reporting role ebmr_report does not exist';
    else
      for r in select rolname from pg_catalog.pg_roles
                where rolname = 'ebmr_report' and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) loop
        return next 'ebmr_report has an elevated role attribute (superuser, createdb, createrole, replication, bypassrls or inherit)';
      end loop;
      for r in select s.rolname as member, g.rolname as of_role from pg_catalog.pg_auth_members m
                 join pg_catalog.pg_roles g on g.oid = m.roleid
                 join pg_catalog.pg_roles s on s.oid = m.member
                where s.rolname = 'ebmr_report' or g.rolname = 'ebmr_report'
                order by 1, 2 loop
        return next format('%s is a member of role %s', r.member, r.of_role);
      end loop;
      for r in select * from sandbox.direct_privileges('ebmr_report') d
                where not (d.object_kind = 'SCHEMA' and d.object_name = 'report' and d.privilege = 'USAGE')
                  and not (d.object_kind = 'TABLE' and d.column_name is null and d.privilege = 'SELECT'
                           and exists (select 1 from pg_catalog.pg_class c
                                        where c.oid = d.object_name::regclass and c.relnamespace = 'report'::regnamespace and c.relkind = 'v'))
                  and not (d.object_kind = 'ROUTINE' and d.privilege = 'EXECUTE'
                           and exists (select 1 from pg_catalog.pg_proc p
                                        where p.oid = d.object_name::regprocedure and p.pronamespace = 'report'::regnamespace and p.provolatile <> 'v'))
                order by 1, 2, 3, 4 loop
        return next format('ebmr_report holds %s on %s %s%s, beyond reading the report views', r.privilege, lower(r.object_kind), r.object_name,
                           coalesce(' (' || r.column_name || ')', ''));
      end loop;
      for r in select d.defaclnamespace::regnamespace::text as ns from pg_catalog.pg_default_acl d
                 cross join lateral pg_catalog.aclexplode(d.defaclacl) a
                where a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'ebmr_report') loop
        return next format('a default privilege grants to ebmr_report (schema %s)', r.ns);
      end loop;
      for r in select p.oid::regprocedure::text as fn from pg_catalog.pg_proc p
                where p.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
                  and p.provolatile = 'v'
                  and has_function_privilege('ebmr_report', p.oid, 'EXECUTE')
                  and has_schema_privilege('ebmr_report', p.pronamespace, 'USAGE')
                order by 1 loop
        return next format('ebmr_report may execute the volatile function %s', r.fn);
      end loop;
    end if;
    -- 1240: the analytics role reads its catalogued inputs and records advisory outputs, and nothing else (ADR 0020).
    return query select * from analytics.role_problems();
  else
    -- 1100: only roles the cluster has, asked about by oid (has_database_privilege by name fails for a missing role).
    for r in select p.rolname from pg_catalog.pg_roles p
              where p.rolname in ('ebmr_app', 'ebmr_authn', 'ebmr_listener')
                and has_database_privilege(p.oid, v_db, 'CONNECT')
              order by 1 loop
      return next format('the GMP role %s can connect to the sandbox database %s', r.rolname, v_db);
    end loop;
    -- 1210: the reporting role never opens a sandbox.
    if exists (select 1 from pg_catalog.pg_roles p where p.rolname = 'ebmr_report' and has_database_privilege(p.oid, v_db, 'CONNECT')) then
      return next format('the reporting role ebmr_report can connect to the sandbox database %s', v_db);
    end if;
    -- 1240: nor does the analytics role (the sandbox runs no analytics; D-6A-6).
    if exists (select 1 from pg_catalog.pg_roles p where p.rolname = 'ebmr_analytics' and has_database_privilege(p.oid, v_db, 'CONNECT')) then
      return next format('the analytics role ebmr_analytics can connect to the sandbox database %s', v_db);
    end if;
    if exists (select 1 from pg_catalog.pg_database d cross join lateral pg_catalog.aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
                where d.datname = v_db and a.grantee = 0 and a.privilege_type = 'CONNECT') then
      return next format('PUBLIC can connect to the sandbox database %s', v_db);
    end if;
    for r in select * from sandbox.mirror_differences() order by 1, 2, 3, 4, 5 loop
      return next format('ebmr_sandbox %s %s on %s %s%s', case r.direction when 'GRANT' then 'lacks' else 'holds beyond the application roles' end,
                         r.privilege, lower(r.object_kind), r.object_name, coalesce(' (' || r.column_name || ')', ''));
    end loop;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_sandbox_listener')
       and exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_listener') then
      for r in select * from sandbox.role_mirror_differences('ebmr_sandbox_listener', array['ebmr_listener']::name[]) order by 1, 2, 3, 4, 5 loop
        return next format('ebmr_sandbox_listener %s %s on %s %s%s', case r.direction when 'GRANT' then 'lacks' else 'holds beyond the listener role' end,
                           r.privilege, lower(r.object_kind), r.object_name, coalesce(' (' || r.column_name || ')', ''));
      end loop;
    end if;
  end if;
end
$$;

reset role;
