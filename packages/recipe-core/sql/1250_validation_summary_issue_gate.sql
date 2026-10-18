-- Recipe core: a GMP batch is issued only on a release with an approved validation summary (Phase 7 slice 7c; DI-03
-- clause 2; interfaces slice-7-0-interfaces.md section 4; kernel 1300 holds the approval).
--
-- Handbook: modules/recipe-core.md
--
-- Before: kernel 1300 recorded the quality unit's approval of the validation summary of a release
-- (platform.validation_summary) and reported a release without one (platform.validation_summary_problem, EBMR-VAL-001),
-- but no batch issue asked.
--
-- Now:
--   recipe.gmp_issue_problem   CREATE OR REPLACE from its latest definition (0891) with the summary check added first;
--                              recipe.begin_gmp_issue and recipe.issue_gmp_execution (1218) both call it, so the issuer
--                              is told before the engine runs and the issue itself is refused (EBMR-VAL-001).
--   recipe.batch_execution     a BEFORE INSERT trigger (a0_, the first of its triggers) refuses a GMP batch row
--                              (installation GMP) on such a release whatever writes it, so no other path to a GMP
--                              batch skips the check.
-- platform.validation_summary_problem() is NULL on a sandbox (kernel 1300): a sandbox and the test runs of training
-- (recipe.begin_issue, recipe.issue_execution: installation SANDBOX rows) are not gated. A batch issued before is never
-- touched: the check is at issue only.

set local role ebmr_owner;

create or replace function recipe.gmp_issue_problem(b recipe.stub_batch, p recipe.batch_mbr_pin, l recipe.batch_allocation_link) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_sel  jsonb;
  v_ver  jsonb;
  v_prob text;
begin
  -- Phase 7 slice 7c (DI-03 clause 2): no GMP batch on a release without an approved validation summary.
  v_prob := platform.validation_summary_problem();
  if v_prob is not null then
    return v_prob;
  end if;
  if b.status <> 'PLANNED' or exists (select 1 from recipe.batch_execution x where x.id = b.id) then
    return format('Batch %s is %s; a GMP batch is issued once (DI-34). [EBMR-EXE-197]', b.batch_number, b.status);
  end if;
  v_sel := recipe.select_version_for_issue(b.family_id, b.markets, p.scope, clock_timestamp());
  if not coalesce((v_sel ->> 'ok')::boolean, false) or (v_sel ->> 'version_id')::uuid is distinct from p.version_id then
    return format('Batch %s was planned on version %s, which is no longer the version its markets and scope may use now (%s): plan it again (PR-05, INV-01). [EBMR-EXE-196]',
                  b.batch_number, p.version_number, coalesce('version ' || (v_sel ->> 'version_number'), v_sel ->> 'explanation'));
  end if;
  v_ver := recipe.verify_control_recipe(b.id);
  if not (v_ver ->> 'ok')::boolean then
    return format('The control recipe of batch %s does not verify: %s (INV-02). [EBMR-EXE-192]', b.batch_number, v_ver ->> 'problems');
  end if;
  v_prob := recipe.allocation_problem(b.id, l.allocation_id);
  if v_prob is not null then
    return format('The batch number of batch %s is not the register''s: %s (INV-27, IN-18). [EBMR-EXE-191]', b.batch_number, v_prob);
  end if;
  -- Phase 4 slice 6a (0891): licence, export permission and hazard dedication.
  return recipe.india_issue_problem(b.id);
end
$$;

-- Every writer of a GMP batch row (header).
create function recipe.batch_execution_validation_gate() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
declare
  v_prob text;
begin
  if new.installation is distinct from 'GMP' then
    return new;
  end if;
  v_prob := platform.validation_summary_problem();
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = v_prob;
  end if;
  return new;
end
$$;
create trigger a0_validation_summary_gate before insert on recipe.batch_execution
  for each row execute function recipe.batch_execution_validation_gate();

revoke all on function recipe.batch_execution_validation_gate() from public;

reset role;
