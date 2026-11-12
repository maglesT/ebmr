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
--   The mark belongs to an injectables PROCESSING master only (lead audit of #230). Aseptic process simulation is a
--   sterile-processing concept (Annex 1 section 9; 211.113(b) aseptic processes; Schedule M Part II on sterile products),
--   and the licence skip must never reach product: a marked tablets or substance batch could post an intermediate lot a
--   real batch consumes, and a marked packaging order of a normal parent would issue with no licence.
--   recipe.mbr_content_non_product_guard (trigger a2_non_product on recipe.mbr_content, before insert): a content
--       revision whose header carries nonProduct is saved only when it is PROCESS_SIMULATION on an injectables PROCESSING
--       master (the header's edition and record kind are the family's, 0110); else EBMR-RCP-435. Every revision a version
--       is approved on passes through it, so no other master can be approved with the mark.
--   recipe.process_simulation_batch(batch)  true only for a batch of an injectables PROCESSING family whose pinned
--       master version (recipe.batch_mbr_pin, the content of the pinned hash) carries the mark: a mark found anywhere
--       else never skips a licence.
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
--   recipe.us_esig_issue_entity  CREATE OR REPLACE from 1260 (the latest definition; lead ruling, 11 November 2026): the
--       21 CFR 11.100(c) certification gate stays in force for a process simulation, whose record is still a GMP record
--       signed electronically. The certification covers the organisation, not the product, so for a process-simulation
--       batch the entity is the holder of the site's current manufacturing licence (the latest, any product), and ''
--       (refused, EBMR-IAM-170) when the site has none. Both callers (recipe.gmp_issue_problem and the trigger
--       a1_us_esig_certification_gate) take it from here.
--   recipe.allocation_register  CREATE OR REPLACE from 0913 (the latest definition): each entry also carries
--       processSimulation (recipe.batch_licence_basis.process_simulation), so the register says why an issued batch has
--       no licence number (ALCOA: attributable, complete).
--   site.finished_lot  trigger a0_process_simulation (before insert, every writer, tab.post_finished_lot included): no
--       finished lot of a process-simulation batch, nor of a packaging order of one (EBMR-IND-045).
--   site.erp_shipment  trigger a00_process_simulation (before insert, before 0961's a0_ and 0870's a1_): no shipment of
--       a lot of a process-simulation batch (EBMR-IND-046).
--   site.intermediate_lot  trigger a0_process_simulation (before insert, every writer): no intermediate lot of a
--       process-simulation batch, so nothing of it can be consumed by a real batch (EBMR-IND-047).
-- Readers of recipe.batch_licence_basis with a NULL licence: the G-REL licence item (0892) and the contract giver's reads
-- (1060) are never reached by such a batch (it has no lot; it has no loan licence); the allocation register (0895, 0913)
-- shows it as issued, with no licence number and processSimulation true (above); the archive's licence form (tablets server) reads none.
-- Messages: EBMR-RCP-435, EBMR-IND-045 to EBMR-IND-047; EBMR-IND-050 and EBMR-EXE-198 reused.

set local role ebmr_owner;

-- Header: the mark of the pinned master version.
create function recipe.process_simulation_batch(p_batch uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select c.content -> 'header' ->> 'nonProduct' = 'PROCESS_SIMULATION'
                     from recipe.batch_mbr_pin p
                     join recipe.mbr_family f on f.id = p.family_id and f.edition = 'injectables' and f.record_kind = 'PROCESSING'
                     join recipe.mbr_content c on c.version_id = p.version_id and c.content_hash = p.content_hash
                    where p.batch_id = p_batch
                    limit 1), false)
$$;

-- The mark only on an injectables processing master (header).
create function recipe.mbr_content_non_product_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  h jsonb := new.content -> 'header';
begin
  if h ? 'nonProduct' and (h ->> 'nonProduct' is distinct from 'PROCESS_SIMULATION' or h ->> 'edition' is distinct from 'injectables'
                           or h ->> 'recordKind' is distinct from 'PROCESSING') then
    raise exception using errcode = 'P0001',
      message = format('A master that makes no product is an aseptic process simulation (PROCESS_SIMULATION) of an injectables processing master, not %s on a %s %s master: nothing was saved (IN-45, ST-29; EBMR-RCP-435)',
                       coalesce(h ->> 'nonProduct', 'null'), coalesce(h ->> 'edition', '?'), coalesce(h ->> 'recordKind', '?'));
  end if;
  return new;
end
$$;
create trigger a2_non_product before insert on recipe.mbr_content for each row execute function recipe.mbr_content_non_product_guard();

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
  -- The label particulars (and the H2 payload built from them) name the manufacturer's licence; a media fill was issued
  -- under none (process_simulation, above), and its record ends with QA's review: its units are destroyed, never labelled.
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

-- No intermediate lot of a process simulation, whoever writes it (header).
create function recipe.intermediate_lot_process_simulation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if recipe.process_simulation_batch(new.batch_id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-047 batch %s is a process simulation (media fill): it makes no product, so no intermediate lot is posted from it (IN-45, ST-29)', new.batch_number);
  end if;
  return new;
end
$$;
create trigger a0_process_simulation before insert on site.intermediate_lot for each row execute function recipe.intermediate_lot_process_simulation_guard();

-- DI-15 (1260) for a process simulation: the site's licence holder (header).
create or replace function recipe.us_esig_issue_entity(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b recipe.stub_batch;
  f recipe.mbr_family;
begin
  select * into b from recipe.stub_batch where id = p_batch;
  if b.id is null or not ('US' = any(b.markets)) then
    return null;
  end if;
  if recipe.process_simulation_batch(b.id) then
    return coalesce((select btrim(l.holder_name) from site.manufacturing_licence l
                      where l.site_code = b.site and l.licence_kind = 'MANUFACTURING' and site.licence_current(l.id, clock_timestamp())
                      order by l.valid_from desc, l.recorded_at desc, l.id limit 1), '');
  end if;
  select * into f from recipe.mbr_family where id = b.family_id;
  -- '' (never NULL) for a US-market batch whose licence holder is not resolvable: the callers refuse it (P7G-3).
  return coalesce(btrim(site.licence_basis(b.site, f.product_code, f.strength, clock_timestamp()) ->> 'holderName'), '');
end
$$;

-- As 0913, with processSimulation (header).
create or replace function recipe.allocation_register(p_site text, p_from timestamptz default null, p_to timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, iam, pg_temp as $$
begin
  perform iam.require_permission('RECORD.READ', jsonb_build_object('site', p_site));
  return (
  select coalesce(jsonb_agg(jsonb_build_object(
           'allocationId', a.id, 'batchNumber', a.batch_number, 'siteCode', a.site_code,
           'allocatedAt', site.utc_text(a.recorded_at),
           'allocationDate', to_char(a.recorded_at at time zone a.site_zone, 'YYYY-MM-DD'),
           'productCode', a.product_code, 'productName', a.product_name, 'strength', f.strength,
           'batchSize', a.batch_size::text, 'batchSizeUnit', a.batch_size_unit, 'edition', a.edition, 'kind', a.batch_kind,
           'parentBatchNumber', pa.batch_number, 'source', a.source,
           'use', case when v.allocation_id is not null then 'VOIDED'
                       when sb.status = 'CANCELLED' then 'CANCELLED'
                       when x.id is not null then 'ISSUED'
                       when sb.id is not null then 'PLANNED'
                       else 'UNUSED' end,
           'voidReason', case when v.allocation_id is not null then v.reason_code || ': ' || v.reason_text end,
           'batchId', l.batch_id, 'issuedAt', site.utc_text(x.issued_at),
           'licenceNumber', lb.licence_number, 'loanLicenceNumber', lb.loan_licence_number,
           'processSimulation', coalesce(lb.process_simulation, false))
         order by a.recorded_at, a.batch_number), '[]'::jsonb)
    from site.batch_number_allocation a
    left join site.batch_number_allocation pa on pa.id = a.parent_allocation_id
    left join site.batch_number_void v on v.allocation_id = a.id
    left join recipe.batch_allocation_link l on l.allocation_id = a.id
    left join recipe.stub_batch sb on sb.id = l.batch_id
    left join recipe.mbr_family f on f.id = sb.family_id
    left join recipe.batch_execution x on x.id = l.batch_id
    left join recipe.batch_licence_basis lb on lb.batch_id = l.batch_id
   where a.site_code = p_site and (p_from is null or a.recorded_at >= p_from) and (p_to is null or a.recorded_at < p_to));
end
$$;

revoke all on function recipe.process_simulation_batch(uuid), recipe.finished_lot_process_simulation_guard(),
                       recipe.shipment_process_simulation_guard(), recipe.intermediate_lot_process_simulation_guard(),
                       recipe.mbr_content_non_product_guard() from public;
grant execute on function recipe.process_simulation_batch(uuid) to ebmr_app;

reset role;
