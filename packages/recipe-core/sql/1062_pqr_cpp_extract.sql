-- Phase 6 slice 6f: typed CPP values in the PQR extract, recomputable from the source records (PR-09, clause "CPP data
-- exported for N batches and recomputed from the source records match exactly"; a slice 6c residual).
--
-- Handbook: modules/recipe-core.md
--
-- EU GMP Chapter 1 (product quality review) and 21 CFR 211.180(e) (paraphrased): the periodic review looks at the
-- critical process parameters and in-process results of every batch of the period. The extract (recipe-core 0910) held
-- the batches, lots, deviations and change records, not the values.
--
-- Query version 2, recipe.pqr_extract_v2(product, from, to) (STABLE, no clock): version 1's result with one more member,
-- `cpp`: for every batch of version 1, the values its record holds now for
--   * each VALID data point (kind VALUE) of a CRITICAL parameter of the batch's own master whose role is
--     PROCESS_PARAMETER, IPC or PROCESS_ENDPOINT (kind PARAMETER), and
--   * each CURRENT derived value of a CRITICAL calculation of that master (kind CALCULATION: the yields, the mean weight),
-- as {batch_number, kind, ref (the point's or derived value's id in the record), id, step, attempt, value (the typed
-- DataValue as recorded: kind, value, unit), unit, failed}, ordered by batch number, kind, id, step, attempt and ref, so the same records give the same text and SHA-256 (D-P4-8). The
-- values come from the batch's record (recipe.execution_state, the projection checked against the command chain) and
-- the parameters from its issued master (recipe.batch_mbr_content), so anyone can recompute them from those rows. The
-- per-batch part is the pure function recipe.pqr_cpp_of(batch number, master content, state).
-- Installed as version 2 with the SHA-256 of its definition; recipe.pqr_run_query (replaced from 0910, its only
-- definition, same signature and privileges) runs versions 1 and 2. New extracts use the highest version; an extract
-- of version 1 still reproduces with version 1.

set local role ebmr_owner;

-- The typed CPP values of one batch record: its state (recipe.execution_state.state) read against its master content,
-- ordered by kind, id, step, attempt and ref. Pure (IMMUTABLE): the same record gives the same array.
create function recipe.pqr_cpp_of(p_batch_number text, p_content jsonb, p_state jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  with points as (
    select 'PARAMETER' as kind, e.k as ref, pt ->> 'item' as id, pt ->> 'stepKey' as step, (pt ->> 'attempt')::integer as attempt,
           pt -> 'value' as value, prm ->> 'unit' as unit, coalesce((pt ->> 'failed')::boolean, false) as failed
      from jsonb_each(coalesce(p_state -> 'points', '{}'::jsonb)) e(k, pt)
      join lateral jsonb_array_elements(coalesce(p_content -> 'parameters', '[]'::jsonb)) prm on prm ->> 'id' = pt ->> 'item'
     where pt ->> 'status' = 'VALID' and pt ->> 'kind' = 'VALUE'
       and prm ->> 'criticality' = 'CRITICAL' and prm ->> 'role' in ('PROCESS_PARAMETER', 'IPC', 'PROCESS_ENDPOINT')),
  derived as (
    select 'CALCULATION' as kind, e.k as ref, dv ->> 'calculation' as id, dv ->> 'stepKey' as step, 1 as attempt,
           dv -> 'value' as value, calc -> 'output' ->> 'unit' as unit, coalesce((dv ->> 'failed')::boolean, false) as failed
      from jsonb_each(coalesce(p_state -> 'derived', '{}'::jsonb)) e(k, dv)
      join lateral jsonb_array_elements(coalesce(p_content -> 'calculations', '[]'::jsonb)) calc on calc ->> 'id' = dv ->> 'calculation'
     where dv ->> 'status' = 'CURRENT' and calc ->> 'criticality' = 'CRITICAL'),
  cpp as (select * from points union all select * from derived)
  select coalesce(jsonb_agg(jsonb_build_object('batch_number', p_batch_number, 'kind', c.kind, 'ref', c.ref, 'id', c.id, 'step', c.step,
                                               'attempt', c.attempt, 'value', c.value, 'unit', c.unit, 'failed', c.failed)
                            order by c.kind collate "C", c.id collate "C", c.step collate "C", c.attempt, c.ref collate "C"), '[]'::jsonb)
    from cpp c
$$;

create function recipe.pqr_extract_v2(p_product text, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with bx as (
    select b.batch_number, recipe.pqr_cpp_of(b.batch_number, recipe.batch_mbr_content(b.id), s.state) as cpp
      from recipe.batch_execution b
      left join recipe.execution_state s on s.batch_id = b.id
     where b.installation = 'GMP' and b.purpose = 'GMP_BATCH'
       and recipe.batch_product(b.id) ->> 'code' = p_product
       and (b.issued_at at time zone b.site_zone)::date between p_from and p_to)
  select recipe.pqr_extract_v1(p_product, p_from, p_to)
         || jsonb_build_object('cpp', coalesce((select jsonb_agg(x.v order by bx.batch_number collate "C", x.n)
                                                  from bx cross join lateral jsonb_array_elements(bx.cpp) with ordinality x(v, n)), '[]'::jsonb),
                               -- The per-batch function is part of the query: a changed definition changes every result,
                               -- so an extract made with the old one no longer reproduces.
                               'cpp_query_sha256', encode(sha256(convert_to(pg_get_functiondef('recipe.pqr_cpp_of(text,jsonb,jsonb)'::regprocedure), 'UTF8')), 'hex'))
$$;

-- recipe.pqr_run_query: CREATE OR REPLACE from its only definition (0910); runs version 2 as well.
create or replace function recipe.pqr_run_query(p_version integer, p_product text, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_prob text := recipe.pqr_query_problem(p_version);
begin
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-PQR-004 %s', v_prob);
  end if;
  if p_version = 1 then
    return recipe.pqr_extract_v1(p_product, p_from, p_to);
  elsif p_version = 2 then
    return recipe.pqr_extract_v2(p_product, p_from, p_to);
  end if;
  raise exception using errcode = 'P0001', message = format('EBMR-PQR-004 PQR query version %s is not runnable here', p_version);
end
$$;

revoke all on function recipe.pqr_extract_v2(text, date, date), recipe.pqr_cpp_of(text, jsonb, jsonb) from public;
grant execute on function recipe.pqr_cpp_of(text, jsonb, jsonb) to ebmr_app;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1062_pqr_cpp_extract)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'PQR extract query version 2: typed CPP values (PR-09)'));
insert into recipe.pqr_query_version (version, query_function, definition_sha256, description)
values (2, 'recipe.pqr_extract_v2(text,date,date)',
        encode(sha256(convert_to(pg_get_functiondef('recipe.pqr_extract_v2(text,date,date)'::regprocedure), 'UTF8')), 'hex'),
        'Version 1 and the typed CPP values of every batch: valid values of critical process parameters, IPC results and endpoints, current critical calculations (yields)');
select kernel.set_actor_context(null);

reset role;
