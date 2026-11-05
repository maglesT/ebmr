-- API edition plan A2, change C1 (lead design of 5 November 2026; controls AS-03, AS-09, AS-16): a processing batch of
-- the API edition posts its output as a lot of kind INTERMEDIATE, which the next step's batch consumes.
--
-- Handbook: modules/site-services.md
--
--   site.intermediate_lot   the intermediate lot of one processing batch of the API edition (one per batch): its material
--                           lot (kind INTERMEDIATE, lot code = batch number, material code = the intermediate product's
--                           code, created in QUARANTINE), the batch's number, edition (SUBSTANCE only), product and
--                           strength, and who posted it. A sibling of site.finished_lot (0842), not a row of it: the
--                           manufacturer release, G-REL and every finished-lot read (recipe.release_lots, EBMR-REL-010,
--                           distribution, ERP outbound, recall) stay those of finished lots, unchanged.
--   site.create_intermediate_lot(p)  written only by the edition's definer (substance 5001,
--                           substance.post_intermediate_lot); the application role cannot call it. MATERIAL.HANDLE at the
--                           batch's site, never an administrator, a person's act (site.material_act_by_person, 0990).
--                           The batch is named by its id only: its number, edition, site, product and strength are the
--                           register's (site.subject_identity, 0730), never the caller's. Refused unless the batch is of
--                           the SUBSTANCE edition in the register, its master family is of edition 'substance' and record
--                           kind PROCESSING, and its execution is EXECUTION_COMPLETE (read from the batch record when the
--                           guard runs: site services apply before recipe-core and never name it at creation, the pattern
--                           of 0860; without the batch record installed the post is refused, it fails closed). So a
--                           tablets or injectables batch never reaches it. The quantity is a positive decimal, the expiry
--                           (and the retest date, when given, not after it) are the caller's computation from the product
--                           master's shelf life (recipe.batch_expiry).
-- The lot leaves quarantine through the existing material-lot release only: QA's release for further processing
-- (RELEASE_FOR_FURTHER_PROCESSING, MATERIAL_LOT_STATUS_DECIDED; guards material_lot.intermediate_only with the LIMS
-- release rule, 0740), never through the manufacturer release (material_lot.manufacturer_decision refuses a lot that is
-- not FINISHED, 0860). The next batch reserves and consumes it as any lot (site.reserve_lot, site.consume_reservation:
-- identity basis INTERMEDIATE, genealogy through site.lot_consumption).
-- Messages: EBMR-SITE-993 to EBMR-SITE-996.

set local role ebmr_owner;

create table site.intermediate_lot (
  lot_id               uuid primary key references site.material_lot (id),
  batch_id             uuid not null unique,
  batch_number         text not null,
  edition              text not null check (edition = 'SUBSTANCE'),
  product_code         text not null,
  strength             text not null,
  posted_by_person     uuid not null,
  posted_by_account    uuid not null,
  posted_at            timestamptz not null default clock_timestamp()
);
revoke all on site.intermediate_lot from public;

select platform.enforce_db_time('site.intermediate_lot', array['posted_at']);
select kernel.register_audited_table('site.intermediate_lot', 'material_lot', 'lot_id', true);

create trigger zz_material_act_by_person before insert on site.intermediate_lot
  for each row execute function site.material_act_by_person('posted_by_account');

-- The batch-record facts of batch p_batch: {recordKind, familyEdition, status}, read when called (header); NULL without
-- the batch record installed or for a batch it does not hold.
create function site.intermediate_batch_facts(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v jsonb;
begin
  if to_regclass('recipe.stub_batch') is null or to_regclass('recipe.mbr_family') is null or to_regclass('recipe.execution_state') is null then
    return null;
  end if;
  execute 'select jsonb_build_object(''recordKind'', f.record_kind, ''familyEdition'', f.edition, ''status'', s.status)
             from recipe.stub_batch b join recipe.mbr_family f on f.id = b.family_id
             left join recipe.execution_state s on s.batch_id = b.id
            where b.id = $1'
    into v using p_batch;
  return v;
end
$$;

-- Internal (no grant to the application role): the API edition's definer posts its processing batch's output.
-- p: {batchId, productName, quantity (decimal text), unit, expiresAt, retestAt?}.
create function site.create_intermediate_lot(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_id    uuid := gen_random_uuid();
  v_batch uuid;
  v_b     jsonb;
  v_f     jsonb;
  v_exp   timestamptz;
  v_rt    timestamptz;
begin
  perform iam.assert_not_administrator();
  v_batch := case when coalesce(p ->> 'batchId', '') ~ '^[0-9a-fA-F-]{36}$' then (p ->> 'batchId')::uuid end;
  v_b := site.subject_identity('BATCH', v_batch);
  if v_b is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-993 batch %s is not a GMP batch of this installation: an intermediate lot is posted only from its batch (AS-03)', coalesce(p ->> 'batchId', 'NULL'));
  end if;
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', v_b ->> 'siteCode'));
  if v_b ->> 'siteCode' is distinct from site.actor_site() then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-993 an intermediate lot is posted at its batch''s site';
  end if;
  v_f := site.intermediate_batch_facts(v_batch);
  if v_b ->> 'edition' is distinct from 'SUBSTANCE' or v_f ->> 'familyEdition' is distinct from 'substance'
     or v_f ->> 'recordKind' is distinct from 'PROCESSING' or v_f ->> 'status' is distinct from 'EXECUTION_COMPLETE' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-994 batch %s is a %s %s batch of edition %s: an intermediate lot is posted only from a processing batch of the API edition whose execution is complete (AS-03, AS-16)',
                       v_b ->> 'batchNumber', coalesce(v_f ->> 'recordKind', 'unknown'), coalesce(v_f ->> 'status', 'not started'), coalesce(v_b ->> 'edition', 'none'));
  end if;
  if coalesce(p ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]+)?$' or (p ->> 'quantity')::numeric <= 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-995 the posted quantity of an intermediate lot is a positive decimal (INV-13)';
  end if;
  v_exp := (p ->> 'expiresAt')::timestamptz;
  v_rt := (p ->> 'retestAt')::timestamptz;
  if v_exp is null or (v_rt is not null and v_rt > v_exp) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-995 an intermediate lot carries its expiry date from the product master''s shelf life, and a retest date only on or before it (AS-09)';
  end if;
  perform pg_advisory_xact_lock(hashtext('site.intermediate_lot'), hashtext(v_batch::text));
  if exists (select 1 from site.intermediate_lot i where i.batch_id = v_batch) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-996 the intermediate lot of batch %s is already posted', v_b ->> 'batchNumber');
  end if;
  insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, retest_at, expires_at,
                                 received_by_person, received_by_account, correlation_id)
  values (v_id, v_b ->> 'siteCode', v_b ->> 'batchNumber', v_b ->> 'productCode', coalesce(nullif(btrim(p ->> 'productName'), ''), v_b ->> 'productCode'),
          'INTERMEDIATE', (p ->> 'quantity')::numeric, p ->> 'unit', v_rt, v_exp,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  insert into site.intermediate_lot (lot_id, batch_id, batch_number, edition, product_code, strength, posted_by_person, posted_by_account)
  values (v_id, v_batch, v_b ->> 'batchNumber', v_b ->> 'edition', v_b ->> 'productCode', v_b ->> 'strength',
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  perform platform.create_aggregate_state('material_lot', 'material_lot', v_id);
  return v_id;
end
$$;

-- The intermediate lot of batch p_batch, or NULL.
create function site.intermediate_lot_of(p_batch uuid) returns uuid
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  return (select i.lot_id from site.intermediate_lot i where i.batch_id = p_batch);
end
$$;

revoke all on function site.intermediate_batch_facts(uuid), site.create_intermediate_lot(jsonb), site.intermediate_lot_of(uuid) from public;
grant select on site.intermediate_lot to ebmr_app;
grant execute on function site.intermediate_lot_of(uuid) to ebmr_app;

reset role;
