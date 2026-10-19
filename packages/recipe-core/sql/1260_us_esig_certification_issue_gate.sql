-- Recipe core: a US-market GMP batch is issued only when the licence holder's 21 CFR 11.100(c) certification letter is
-- on file (DI-15 proposed_modify; outline 5.5, R-20; finding 7g-5 of Phase 7).
--
-- Handbook: modules/recipe-core.md
--
-- Before: kernel 0170 kept the certification letters per legal entity and iam.assert_us_esig_certification refused a
-- missing one under the policy esig.us_certification_mode (BLOCK, the default; FLAG only reports it), but no batch
-- issue called it, so a US-market batch was issued with no letter on file.
--
-- Now:
--   recipe.us_esig_issue_entity    the legal entity whose letter a GMP batch needs: NULL when the batch has no US in its
--                                  market set; otherwise the holder of the manufacturing licence the batch is issued
--                                  under (site.licence_basis, the host licence for a loan-licence batch: its staff sign
--                                  the record). For a US-market batch whose holder cannot be resolved (no current
--                                  licence, or a licence without a holder name) it returns '' instead: the gate and
--                                  the trigger refuse that batch (fail closed, review P7G-3; EBMR-IAM-170), since no
--                                  letter can be on file for an unknown entity, whatever esig.us_certification_mode is.
--   recipe.gmp_issue_problem       CREATE OR REPLACE from its latest definition (1250) with the certification check
--                                  added after the India gate; recipe.begin_gmp_issue and recipe.issue_gmp_execution
--                                  (1218) both call it, so the issuer is told before the engine runs (EBMR-IAM-170).
--   recipe.batch_execution         a BEFORE INSERT trigger (a1_, after the validation-summary gate a0_) calls
--                                  iam.assert_us_esig_certification for a GMP batch row whatever writes it.
-- A sandbox batch (installation SANDBOX) is not gated. A batch issued before is never touched: the check is at issue only.

set local role ebmr_owner;

create function recipe.us_esig_issue_entity(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b recipe.stub_batch;
  f recipe.mbr_family;
begin
  select * into b from recipe.stub_batch where id = p_batch;
  if b.id is null or not ('US' = any(b.markets)) then
    return null;
  end if;
  select * into f from recipe.mbr_family where id = b.family_id;
  -- '' (never NULL) for a US-market batch whose licence holder is not resolvable: the callers refuse it (P7G-3).
  return coalesce(btrim(site.licence_basis(b.site, f.product_code, f.strength, clock_timestamp()) ->> 'holderName'), '');
end
$$;

create or replace function recipe.gmp_issue_problem(b recipe.stub_batch, p recipe.batch_mbr_pin, l recipe.batch_allocation_link) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_sel    jsonb;
  v_ver    jsonb;
  v_prob   text;
  v_entity text;
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
  v_prob := recipe.india_issue_problem(b.id);
  if v_prob is not null then
    return v_prob;
  end if;
  -- Phase 7 slice 7g-5 (DI-15): a US-market batch needs the licence holder's 11.100(c) letter on file (policy BLOCK).
  v_entity := recipe.us_esig_issue_entity(b.id);
  if v_entity = '' then
    return format('Batch %s is not issued for the US market: the licence holder whose 21 CFR 11.100(c) certification it needs cannot be determined (no current manufacturing licence with a holder covers it) (DI-15). [EBMR-IAM-170]',
                  b.batch_number);
  end if;
  if v_entity is not null and (iam.us_esig_certification_status(v_entity) ->> 'blocking')::boolean then
    return format('Batch %s is not issued for the US market: no 21 CFR 11.100(c) certification is on file for %s, the licence holder (DI-15). [EBMR-IAM-170]',
                  b.batch_number, v_entity);
  end if;
  return null;
end
$$;

-- Every writer of a GMP batch row (header).
create function recipe.batch_execution_us_esig_gate() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_entity text;
begin
  if new.installation is distinct from 'GMP' then
    return new;
  end if;
  v_entity := recipe.us_esig_issue_entity(new.id);
  if v_entity = '' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-170 the licence holder of this US-market batch cannot be determined, so no 21 CFR 11.100(c) certification can be on file for it; US-market batches cannot be issued (P7G-3)';
  end if;
  if v_entity is not null then
    perform iam.assert_us_esig_certification(v_entity);
  end if;
  return new;
end
$$;
create trigger a1_us_esig_certification_gate before insert on recipe.batch_execution
  for each row execute function recipe.batch_execution_us_esig_gate();

revoke all on function recipe.us_esig_issue_entity(uuid), recipe.batch_execution_us_esig_gate() from public;

reset role;
