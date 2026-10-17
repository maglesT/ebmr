-- Phase 6A slice 6A-3: a reference set carries its model candidate's own model and batches (ADR 0020 point 6; draft
-- control DI-52; DI-09; lead item of slice 6A-3, D-6A-3-8).
--
-- Handbook: modules/analytics.md
--
-- Kernel 1241 (EBMR-ANA-010) checks that a reference set's model SHA-256 equals the hash its model candidate recorded.
-- A writer could still pair the candidate's hash with another model, or with other batches. A rule on the table, for
-- every writer (the release included), closes that:
--   EBMR-ANA-030  when the candidate output records its model ("values".model), the set's model is that model; when it
--                 records its reference batches ("values".batchIds), the set's batches are those batches (as a set).
-- The analytics methods of slices 6A-3 (MSPC.PCA, the SPC charts) and 6A-6 (GBP.DTW_BAND) record both; the runner
-- checks the model against its hash again before it scores a set. Nothing outside the analytics schema reads this
-- (DI-51).

set local role ebmr_owner;

create function analytics.reference_candidate_check() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v jsonb;
begin
  select o."values" into v from analytics.output o where o.id = new.candidate_output;
  if v is null then
    return new; -- kernel 1241 (a10_reference_model) refuses a set without its candidate first.
  end if;
  if (v ? 'model' and v -> 'model' is distinct from new.model)
     or (pg_catalog.jsonb_typeof(v -> 'batchIds') = 'array'
         and (exists (select 1 from pg_catalog.jsonb_array_elements(v -> 'batchIds') b
                       where pg_catalog.jsonb_typeof(b) <> 'string' or not pg_catalog.pg_input_is_valid(b #>> '{}', 'uuid'))
              or (select coalesce(array_agg(distinct (b #>> '{}')::uuid order by (b #>> '{}')::uuid), '{}')
                    from pg_catalog.jsonb_array_elements(v -> 'batchIds') b)
                 is distinct from (select coalesce(array_agg(distinct x order by x), '{}') from unnest(new.batch_ids) x))) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-030 reference set %s: its model and its reference batches must be those of its model candidate %s (DI-52)',
      new.id, new.candidate_output);
  end if;
  return new;
end
$$;
revoke all on function analytics.reference_candidate_check() from public;
create trigger a11_reference_candidate before insert on analytics.reference_set for each row execute function analytics.reference_candidate_check();

reset role;
