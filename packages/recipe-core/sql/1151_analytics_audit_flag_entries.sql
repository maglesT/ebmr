-- Phase 6A slice 6A-4: the audit entries behind the audit-trail flags, for data-integrity review only (decision 0016
-- item 8; draft controls DI-53, DI-25; ADR 0020 point 4; D-6A-4-7, D-6A-4-9).
--
-- Handbook: modules/analytics.md
--
-- Two SECURITY DEFINER functions in the schema analytics (EXECUTE to ebmr_app). Both refuse administrators first
-- (iam.assert_not_administrator, DI-18), then need ANALYTICS.DI_REVIEW (EBMR-ANA-007, as analytics.person_flags; DI-53):
-- the application role reads neither a person flag nor the audit facts behind it any other way. They are in recipe-core
-- because the facts of a batch record's entries are (recipe-core 1150).
--   analytics.audit_flag_entries(flag)    the audit entries a restricted audit-trail flag names as evidence
--                                         (AUDIT_EVENT <chain>#<id>), as report.audit_facts gives them: when, the time
--                                         claimed, the action, table and field, whether it is a correction with its
--                                         reason code, and the terminal. No old or new value (DI-53).
--   analytics.audit_flagged_entries(batch) the entries of the batch's audit-trail review scope (the record and the
--                                         records linked to it, recipe.audit_review_scope_chains) that the open or
--                                         dispositioned keys of analytics.audit_flags name: the chain, the entry, the
--                                         flag of the key, its rule and severity, and the key's current verdict (null
--                                         while open). The audit-trail review panel orders these entries first and
--                                         highlights them; it still lists every entry, and the review is unchanged
--                                         (DI-25, D-6A-4-9). Nothing in the review reads this function (DI-51, PR-61).
-- Nothing here writes.

set local role ebmr_owner;

create function analytics.audit_flag_entries(p_flag uuid)
returns table (event_id text, chain_key text, recorded_at timestamptz, claimed_at timestamptz, action text, command_type text, table_name text,
               field text, is_correction boolean, reason_code text, terminal text, batch_id uuid)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_ids bigint[];
begin
  perform iam.assert_not_administrator();
  begin
    perform iam.require_permission('ANALYTICS.DI_REVIEW', '{}'::jsonb);
  exception when raise_exception then
    if sqlerrm like 'EBMR-IAM-040%' then
      raise exception using errcode = 'P0001', message =
        'EBMR-ANA-007 the audit entries behind a flag about a person are restricted to data-integrity review: they need ANALYTICS.DI_REVIEW (DI-53)';
    end if;
    raise;
  end;
  select pg_catalog.array_agg(distinct pg_catalog.split_part(x.e ->> 'ref', '#', 2)::bigint) into v_ids
    from analytics.flag f
    join analytics.run_end r on r.run = f.run and r.status = 'DONE'
    cross join lateral pg_catalog.jsonb_array_elements(f.reasons) rs(v)
    cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(rs.v -> 'evidence') = 'array' then rs.v -> 'evidence' else '[]'::jsonb end) x(e)
   where f.id = p_flag and f.restricted and x.e ->> 'kind' = 'AUDIT_EVENT' and (x.e ->> 'ref') ~ '#[0-9]{1,18}$';
  if v_ids is null then
    return;
  end if;
  return query
    select a.event_id, a.chain_key, a.recorded_at, a.claimed_at, a.action, a.command_type, a.table_name, a.field, a.is_correction, a.reason_code,
           a.terminal, a.batch_id
      from report.audit_facts('-infinity'::timestamptz, v_ids) a
     order by a.recorded_at, a.event_id::bigint;
end
$$;
revoke all on function analytics.audit_flag_entries(uuid) from public;
grant execute on function analytics.audit_flag_entries(uuid) to ebmr_app;

create function analytics.audit_flagged_entries(p_batch uuid)
returns table (chain_key text, event_id text, flag_id uuid, rule text, severity text, verdict text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  begin
    perform iam.require_permission('ANALYTICS.DI_REVIEW', '{}'::jsonb);
  exception when raise_exception then
    if sqlerrm like 'EBMR-IAM-040%' then
      raise exception using errcode = 'P0001', message =
        'EBMR-ANA-007 which audit entries are flagged is restricted to data-integrity review: it needs ANALYTICS.DI_REVIEW (DI-53)';
    end if;
    raise;
  end;
  return query
    with scope as (select s.chain_key from recipe.audit_review_scope_chains(p_batch) s),
    keys as (select * from analytics.audit_flags('-infinity'::timestamptz, 'infinity'::timestamptz))
    select distinct on (pg_catalog.split_part(x.e ->> 'ref', '#', 1), pg_catalog.split_part(x.e ->> 'ref', '#', 2), k.flag_id)
           pg_catalog.split_part(x.e ->> 'ref', '#', 1), pg_catalog.split_part(x.e ->> 'ref', '#', 2), k.flag_id, k.rule, k.severity, k.verdict
      from keys k
      cross join lateral pg_catalog.jsonb_array_elements(k.reasons) rs(v)
      cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(rs.v -> 'evidence') = 'array' then rs.v -> 'evidence' else '[]'::jsonb end) x(e)
     where x.e ->> 'kind' = 'AUDIT_EVENT'
       and pg_catalog.split_part(x.e ->> 'ref', '#', 1) in (select s.chain_key from scope s)
     order by pg_catalog.split_part(x.e ->> 'ref', '#', 1), pg_catalog.split_part(x.e ->> 'ref', '#', 2), k.flag_id;
end
$$;
revoke all on function analytics.audit_flagged_entries(uuid) from public;
grant execute on function analytics.audit_flagged_entries(uuid) to ebmr_app;

reset role;
