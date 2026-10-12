-- The India gates of the GMP batch issue: the manufacturing or loan licence (IN-30, D-6-1), the export permission of
-- every export market (D-6-2) and the hazard dedication of the line (IN-27) (Phase 4 slice 6a; ADR 0012).
--
--   recipe.india_issue_problem(batch)  NULL when planned GMP batch p_batch may be issued now on these grounds, else why not:
--       a current licence of the batch's site endorsing the family's product and strength (site.licence_basis), a current
--       export permission of that product and strength for each market of the batch's set other than IN, and, for a
--       hazardous product, a line dedicated to its hazard class (plant.hazard_area_problem).
--   recipe.gmp_issue_problem: CREATE OR REPLACE from its latest definition (0501) with that check added last; both
--       recipe.begin_gmp_issue and recipe.issue_gmp_execution call it, so the person is told before the engine runs.
--   recipe.batch_licence_basis: the licence basis of each GMP batch written in the transaction of its issue by a
--       trigger on recipe.batch_execution (every writer): the host licence number and, for a loan-licence batch, the loan
--       licence number and technical agreement (the record header carries both, IN-30). The trigger checks the gates
--       again and refuses the issue when they no longer hold (EBMR-IND-040 to 042). Insert-only.
-- A licence that lapses or is suspended later blocks the next issue, never a batch already issued (D-6-1).
-- Messages: EBMR-IND-040 to EBMR-IND-044.

set local role ebmr_owner;

create table recipe.batch_licence_basis (
  batch_id             uuid primary key references recipe.batch_execution (id),
  licence_id           uuid not null,
  licence_number       text not null,
  loan_licence_id      uuid,
  loan_licence_number  text,
  basis                jsonb not null check (jsonb_typeof(basis) = 'object'),
  recorded_at          timestamptz not null default clock_timestamp(),
  check ((loan_licence_id is null) = (loan_licence_number is null))
);
revoke all on recipe.batch_licence_basis from public;
select platform.enforce_db_time('recipe.batch_licence_basis', array['recorded_at']);
select kernel.register_audited_table('recipe.batch_licence_basis', 'batch_licence_basis', 'batch_id', true);

-- IN-30, D-6-1, D-6-2, IN-27 (header).
create function recipe.india_issue_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, plant, pg_temp as $$
declare
  b      recipe.stub_batch;
  f      recipe.mbr_family;
  v_at   timestamptz := clock_timestamp();
  v_prob text;
  m      text;
begin
  select * into b from recipe.stub_batch where id = p_batch;
  select * into f from recipe.mbr_family where id = b.family_id;
  if b.id is null or f.id is null then
    return format('There is no GMP batch planned with id %s (IN-30). [EBMR-IND-040]', coalesce(p_batch::text, 'NULL'));
  end if;
  v_prob := site.licence_problem(b.site, f.product_code, f.strength, v_at);
  if v_prob is not null then
    return format('Batch %s is not issued: %s. [EBMR-IND-040]', b.batch_number, v_prob);
  end if;
  foreach m in array b.markets loop
    continue when m = 'IN';
    v_prob := site.export_permission_problem(b.site, f.product_code, f.strength, m, v_at);
    if v_prob is not null then
      return format('Batch %s is not issued for market %s: %s. [EBMR-IND-041]', b.batch_number, m, v_prob);
    end if;
  end loop;
  v_prob := plant.hazard_area_problem(f.product_code, b.line);
  if v_prob is not null then
    return format('Batch %s is not issued: %s. [EBMR-IND-042]', b.batch_number, v_prob);
  end if;
  return null;
end
$$;

-- As 0501, with the India gates last (header).
create or replace function recipe.gmp_issue_problem(b recipe.stub_batch, p recipe.batch_mbr_pin, l recipe.batch_allocation_link) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_sel  jsonb;
  v_ver  jsonb;
  v_prob text;
begin
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

-- The issue of a GMP batch records its licence basis, after checking the gates again (header).
create function recipe.record_batch_licence_basis() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b      recipe.stub_batch;
  f      recipe.mbr_family;
  v_prob text;
  v      jsonb;
begin
  if new.installation is distinct from 'GMP' then
    return null;
  end if;
  v_prob := recipe.india_issue_problem(new.id);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = v_prob;
  end if;
  select * into b from recipe.stub_batch where id = new.id;
  select * into f from recipe.mbr_family where id = b.family_id;
  v := site.licence_basis(b.site, f.product_code, f.strength, clock_timestamp());
  insert into recipe.batch_licence_basis (batch_id, licence_id, licence_number, loan_licence_id, loan_licence_number, basis)
  values (new.id, (v ->> 'licenceId')::uuid, v ->> 'licenceNumber', (v ->> 'loanLicenceId')::uuid, v ->> 'loanLicenceNumber', v);
  return null;
end
$$;
create trigger zz_india_licence_basis after insert on recipe.batch_execution for each row execute function recipe.record_batch_licence_basis();

revoke all on function recipe.india_issue_problem(uuid), recipe.record_batch_licence_basis() from public;
revoke all on recipe.batch_licence_basis from ebmr_app;
grant select on recipe.batch_licence_basis to ebmr_app;
grant execute on function recipe.india_issue_problem(uuid) to ebmr_app;

reset role;
