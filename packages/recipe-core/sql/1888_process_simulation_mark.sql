-- Recipe core: the process-simulation mark (injectables slice I-2, feature B; lead design of 11 November 2026; controls
-- IN-30, ST-29, IN-45).
-- Handbook: modules/recipe-core.md
--
-- A master may carry header.nonProduct = PROCESS_SIMULATION (flow model MbrHeader.nonProduct): an aseptic process
-- simulation (media fill) run with growth medium in place of the product to qualify the aseptic process. US rules ask that
-- the validation of aseptic processes is done and recorded (21 CFR 211.113(b)); Schedule M Part II 5.3-5.7 asks for
-- media fills at set intervals that represent the routine process; EU Annex 1 9.32 asks that the simulation follows the
-- routine process as closely as possible. The units of such a batch are incubated, read and destroyed: no product is made,
-- so no product licence or export permission is needed to run it, and nothing of it may reach a pack, a lot or a
-- consignee. QA's review of the record is its end. The mark is part of the approved content and its hash (content
-- revisions change only in DRAFT, 0110), so it changes only with a new master version.
--
--   recipe.process_simulation_batch(batch)  true when the master version batch p_batch is pinned to (recipe.batch_mbr_pin,
--       the content of the pinned hash) carries the mark.
--   recipe.batch_licence_basis  licence_id and licence_number become nullable, with a new column process_simulation:
--       the licence columns are NULL exactly when it is set, and a process-simulation row names no loan licence either
--       (check batch_licence_basis_process_simulation). Every earlier row keeps its licence (default false).
--   recipe.india_issue_problem  CREATE OR REPLACE from 0891 (the only definition): for a process-simulation batch the
--       licence check (site.licence_problem) and the export permission of every market are skipped, one rule for every
--       market; the hazard dedication of the line (IN-27) still applies.
--   recipe.record_batch_licence_basis  CREATE OR REPLACE from 0891: a process-simulation batch records "no licence:
--       process simulation" (process_simulation true, no licence numbers) instead of a licence row.
--   recipe.india_label_particulars  CREATE OR REPLACE from 0894 (the only definition): a process-simulation batch has no
--       label particulars (EBMR-IND-050), so no H2 payload is issued for it.
--   recipe.packaging_parent_problem  CREATE OR REPLACE from 0582 (the only definition): a process-simulation batch is
--       never packed; prepare_gmp_issue and the link guard a2_packaging_parent both ask it, so a packaging order of it is
--       refused whoever writes it (EBMR-EXE-198).
--   site.finished_lot  trigger a0_process_simulation (before insert, every writer, tab.post_finished_lot included): no
--       finished lot of a process-simulation batch, nor of a packaging order of one (EBMR-IND-045).
--   site.erp_shipment  trigger a00_process_simulation (before insert, before 0961's a0_ and 0870's a1_): no shipment of
--       a lot of a process-simulation batch (EBMR-IND-046).
-- Readers of recipe.batch_licence_basis with a NULL licence: the G-REL licence item (0892) and the contract giver's reads
-- (1060) are never reached by such a batch (it has no lot; it has no loan licence); the allocation register (0895, 0913)
-- shows it as issued with no licence number; the archive's licence form (tablets server) reads none.
-- Messages: EBMR-IND-045, EBMR-IND-046; EBMR-IND-050 and EBMR-EXE-198 reused.

set local role ebmr_owner;

-- Header: the mark of the pinned master version.
create function recipe.process_simulation_batch(p_batch uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select c.content -> 'header' ->> 'nonProduct' = 'PROCESS_SIMULATION'
                     from recipe.batch_mbr_pin p
                     join recipe.mbr_content c on c.version_id = p.version_id and c.content_hash = p.content_hash
                    where p.batch_id = p_batch
                    limit 1), false)
$$;

alter table recipe.batch_licence_basis
  alter column licence_id drop not null,
  alter column licence_number drop not null,
  add column process_simulation boolean not null default false;
alter table recipe.batch_licence_basis add constraint batch_licence_basis_process_simulation
  check ((licence_id is null) = process_simulation and (licence_number is null) = process_simulation
         and (not process_simulation or loan_licence_id is null));

-- IN-30, D-6-1, D-6-2, IN-27; ST-29, IN-45: a process simulation needs no product licence or export permission (header).
create or replace function recipe.india_issue_problem(p_batch uuid) returns text
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
  -- A media fill makes no product (211.113(b); Schedule M Part II 5.3-5.7; Annex 1 9.32): one rule, every market.
  if not recipe.process_simulation_batch(b.id) then
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
  end if;
  v_prob := plant.hazard_area_problem(f.product_code, b.line);
  if v_prob is not null then
    return format('Batch %s is not issued: %s. [EBMR-IND-042]', b.batch_number, v_prob);
  end if;
  return null;
end
$$;

-- As 0891; a process simulation records no licence (header).
create or replace function recipe.record_batch_licence_basis() returns trigger
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
  if recipe.process_simulation_batch(new.id) then
    insert into recipe.batch_licence_basis (batch_id, licence_id, licence_number, loan_licence_id, loan_licence_number, basis, process_simulation)
    values (new.id, null, null, null, null, jsonb_build_object('processSimulation', true, 'note', 'no licence: process simulation'), true);
    return null;
  end if;
  select * into b from recipe.stub_batch where id = new.id;
  select * into f from recipe.mbr_family where id = b.family_id;
  v := site.licence_basis(b.site, f.product_code, f.strength, clock_timestamp());
  insert into recipe.batch_licence_basis (batch_id, licence_id, licence_number, loan_licence_id, loan_licence_number, basis)
  values (new.id, (v ->> 'licenceId')::uuid, v ->> 'licenceNumber', (v ->> 'loanLicenceId')::uuid, v ->> 'loanLicenceNumber', v);
  return null;
end
$$;

-- As 0894; a process simulation has no label (header).
create or replace function recipe.india_label_particulars(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b      recipe.batch_execution;
  sb     recipe.stub_batch;
  f      recipe.mbr_family;
  lb     recipe.batch_licence_basis;
  v_exp  jsonb;
  v_mfg  date;
  v_end  date;
begin
  select * into b from recipe.batch_execution where id = p_batch;
  select * into sb from recipe.stub_batch where id = p_batch;
  select * into f from recipe.mbr_family where id = sb.family_id;
  if b.id is null or f.id is null or b.installation <> 'GMP' then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-050 %s is no issued GMP batch, so it has no label particulars (IN-31)', coalesce(p_batch::text, 'NULL'));
  end if;
  select * into lb from recipe.batch_licence_basis where batch_id = p_batch;
  if lb.batch_id is null then
    select * into lb from recipe.batch_licence_basis where batch_id = recipe.packaging_parent_of(p_batch);
  end if;
  if lb.process_simulation then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-050 batch %s is a process simulation: it makes no product, so it has no label particulars (IN-31, IN-45)', b.batch_number);
  end if;
  if lb.batch_id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-050 batch %s carries no licence recorded at its issue: the manufacturer and licence number of its label cannot be given (IN-31, IN-30)', b.batch_number);
  end if;
  v_exp := recipe.batch_expiry(p_batch);
  if v_exp is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-050 the expiry of batch %s cannot be computed: the product master''s shelf life is needed (PR-43, IN-31)', b.batch_number);
  end if;
  v_mfg := (v_exp ->> 'manufactureDate')::date;
  v_end := (v_exp ->> 'expiryDate')::date;
  return jsonb_build_object(
    'batchId', p_batch, 'batchNumber', b.batch_number, 'productCode', f.product_code, 'drugName', f.product_name, 'strength', f.strength,
    'dosageForm', f.dosage_form,
    'manufactureDate', to_char(v_mfg, 'YYYY-MM-DD'), 'manufactureLabel', upper(to_char(v_mfg, 'MM/YYYY')),
    'expiryDate', to_char(v_end, 'YYYY-MM-DD'), 'expiryLabel', upper(to_char(v_end, 'MM/YYYY')),
    'shelfLifeMonths', (v_exp ->> 'shelfLifeMonths')::integer, 'tentativeShelfLife', (v_exp ->> 'tentative')::boolean,
    'manufacturer', jsonb_build_object('name', lb.basis ->> 'holderName', 'address', lb.basis ->> 'holderAddress',
                                       'licenceNumber', lb.licence_number, 'form', lb.basis ->> 'form'),
    'loanLicensee', case when lb.loan_licence_id is null then null
                         else jsonb_build_object('name', lb.basis ->> 'loanHolderName', 'address', lb.basis ->> 'loanHolderAddress',
                                                 'licenceNumber', lb.loan_licence_number, 'form', lb.basis ->> 'loanForm') end);
end
$$;

-- As 0582; a process simulation is never packed (header).
create or replace function recipe.packaging_parent_problem(p_product text, p_site text, p_parent uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  x  recipe.batch_execution;
  sb recipe.stub_batch;
  f  recipe.mbr_family;
begin
  select * into x from recipe.batch_execution where id = p_parent;
  if x.id is null or x.purpose <> 'GMP_BATCH' then
    return format('batch %s is no issued GMP batch', coalesce(p_parent::text, '(none)'));
  end if;
  select * into sb from recipe.stub_batch where id = p_parent;
  -- Review 4a LOW 8: an aborted or cancelled processing batch is never packed (rejection of a batch arrives in Phase 4
  -- with release; the release gate holds it there).
  if sb.status = 'CANCELLED' or (select st.state ->> 'status' from recipe.execution_state st where st.batch_id = p_parent) in ('ABORTED', 'CANCELLED') then
    return format('batch %s is aborted or cancelled', x.batch_number);
  end if;
  select * into f from recipe.mbr_family where id = sb.family_id;
  if f.record_kind is distinct from 'PROCESSING' then
    return format('batch %s is no processing batch', x.batch_number);
  end if;
  -- ST-29, IN-45: the units of a media fill are destroyed; QA's review of its record is its end.
  if recipe.process_simulation_batch(p_parent) then
    return format('batch %s is a process simulation (media fill): its units are destroyed, never packed (IN-45)', x.batch_number);
  end if;
  if f.product_code is distinct from p_product or sb.site is distinct from p_site then
    return format('batch %s is of product %s at site %s, not of %s at %s', x.batch_number, f.product_code, sb.site, coalesce(p_product, '(none)'), coalesce(p_site, '(none)'));
  end if;
  if not exists (select 1 from recipe.batch_allocation_link l where l.batch_id = p_parent) then
    return format('batch %s has no register number', x.batch_number);
  end if;
  return null;
end
$$;

-- No finished lot of a process simulation, whoever writes it (header).
create function recipe.finished_lot_process_simulation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if recipe.process_simulation_batch(new.batch_id) or recipe.process_simulation_batch(recipe.packaging_parent_of(new.batch_id)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-045 batch %s is a process simulation (media fill) or packs one: it makes no product, so no finished lot is posted from it (IN-45, ST-29)', new.batch_number);
  end if;
  return new;
end
$$;
create trigger a0_process_simulation before insert on site.finished_lot for each row execute function recipe.finished_lot_process_simulation_guard();

-- No shipment of a lot of a process simulation, whoever writes it (header).
create function recipe.shipment_process_simulation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  fl site.finished_lot;
begin
  select * into fl from site.finished_lot where lot_id = new.lot_id;
  if fl.lot_id is not null
     and (recipe.process_simulation_batch(fl.batch_id) or recipe.process_simulation_batch(recipe.packaging_parent_of(fl.batch_id))) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-046 lot %s comes from a process simulation (media fill): it makes no product, so it is never shipped (IN-45, ST-29)', fl.batch_number);
  end if;
  return new;
end
$$;
create trigger a00_process_simulation before insert on site.erp_shipment for each row execute function recipe.shipment_process_simulation_guard();

revoke all on function recipe.process_simulation_batch(uuid), recipe.finished_lot_process_simulation_guard(),
                       recipe.shipment_process_simulation_guard() from public;
grant execute on function recipe.process_simulation_batch(uuid) to ebmr_app;

reset role;
