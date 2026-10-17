-- Phase 6A slice 6A-4: the audit-trail flags as data-integrity review reads them (decision 0016 item 8; draft control
-- DI-53; ADR 0020 point 4; D-6A-4-5, D-6A-4-7).
--
-- Handbook: modules/analytics.md
--
-- Each run of the audit-trail methods (ATA.RULES, ATA.BASELINE) assesses the whole input window again, so a later run
-- that finds the same hit raises a flag about it again. A flag's key is its method, rule, subject and the first
-- evidence of its first reason (the entry, login, week or test it is about; the methods put it there):
--   analytics.flag_key(method, rule, subject_kind, subject_ref, reasons)   that key (pure).
--   analytics.audit_flags(from, to)   the restricted flags of the audit-trail methods (ATA.*) of DONE runs, one row
--                                     per key: the latest flag of the key (raised in [from, to)), how often and since
--                                     when it was raised, and the key's current disposition (the latest current disposition of any flag of the
--                                     key) with its verdict. A key without one is open: QA's disposition is what closes
--                                     it (DI-53), and a disposition on one flag of a key covers the same hit raised again.
--                                     SECURITY DEFINER, EXECUTE to ebmr_app; refuses administrators first
--                                     (iam.assert_not_administrator, DI-18), then needs ANALYTICS.DI_REVIEW (EBMR-ANA-007,
--                                     as analytics.person_flags; DI-53); a period is two instants, the first not after the
--                                     second (EBMR-ANA-011).
-- Nothing here writes; nothing outside the analytics schema reads these functions (DI-51).

set local role ebmr_owner;

create function analytics.flag_key(p_method text, p_rule text, p_subject_kind text, p_subject_ref text, p_reasons jsonb) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select p_method || '|' || p_rule || '|' || p_subject_kind || '|' || p_subject_ref || '|'
         || coalesce(p_reasons -> 0 -> 'evidence' -> 0 ->> 'kind', '') || ':' || coalesce(p_reasons -> 0 -> 'evidence' -> 0 ->> 'ref', '')
$$;
revoke all on function analytics.flag_key(text, text, text, text, jsonb) from public;

create function analytics.audit_flags(p_from timestamptz, p_to timestamptz)
returns table (flag_id uuid, run_id uuid, method text, version integer, subject_kind text, subject_ref text, rule text, severity text,
               reasons jsonb, raised_at timestamptz, flag_key text, raised_count integer, first_raised_at timestamptz,
               disposition_flag uuid, verdict text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  begin
    perform iam.require_permission('ANALYTICS.DI_REVIEW', '{}'::jsonb);
  exception when raise_exception then
    if sqlerrm like 'EBMR-IAM-040%' then
      raise exception using errcode = 'P0001', message =
        'EBMR-ANA-007 audit-trail flags are about persons and restricted to data-integrity review: they need ANALYTICS.DI_REVIEW (DI-53)';
    end if;
    raise;
  end;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception using errcode = 'P0001', message = 'EBMR-ANA-011 a period is two instants, the first not after the second (DI-53)';
  end if;
  return query
    with f as (
      select g.id, g.run, r.method, r.version, g.subject_kind, g.subject_ref, g.rule, g.severity, g.reasons, g.raised_at,
             analytics.flag_key(r.method, g.rule, g.subject_kind, g.subject_ref, g.reasons) as k
        from analytics.flag g
        join analytics.run r on r.id = g.run
        join analytics.run_end e on e.run = g.run and e.status = 'DONE'
       where g.restricted and r.method like 'ATA.%'),
    ranked as (
      select f.*, pg_catalog.row_number() over (partition by f.k order by f.raised_at desc, f.id desc) as n,
             (pg_catalog.count(*) over (partition by f.k))::integer as times,
             pg_catalog.min(f.raised_at) over (partition by f.k) as since
        from f),
    disposed as (
      select distinct on (f.k) f.k, d.flag, d.verdict
        from analytics.flag_disposition d
        join f on f.id = d.flag
       where not exists (select 1 from analytics.flag_disposition s where s.supersedes = d.id)
       order by f.k, d.recorded_at desc, d.id desc)
    select x.id, x.run, x.method, x.version, x.subject_kind, x.subject_ref, x.rule, x.severity, x.reasons, x.raised_at, x.k, x.times, x.since,
           d.flag, d.verdict
      from ranked x
      left join disposed d on d.k = x.k
     where x.n = 1 and x.raised_at >= p_from and x.raised_at < p_to
     order by x.raised_at desc, x.id;
end
$$;
revoke all on function analytics.audit_flags(timestamptz, timestamptz) from public;
grant execute on function analytics.audit_flags(timestamptz, timestamptz) to ebmr_app;

reset role;
