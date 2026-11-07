-- API edition plan A2, change C1 follow-up (lead approval of 7 November 2026; controls AS-03, IN-05, PR-45, INV-27): a
-- processing batch of the API edition may post more than one intermediate lot (a second crop, a split isolation). The
-- owner rule is as much flexibility as compliance allows: no refusal without a binding clause or a real record-integrity
-- need, and each refusal below names which.
--
-- Handbook: modules/site-services.md
--
--   site.intermediate_lot   no longer one per batch: the unique rule on batch_id (1732) is dropped; a plain index keeps the
--                           batch's lots found fast.
--   site.create_intermediate_lot(p)  as 1732 without the "already posted" refusal (EBMR-SITE-996 is no longer raised).
--                           The lot code is the batch number for the batch's first intermediate lot, then
--                           <batch number>-2, -3, ... in posting order: the count of the batch's intermediate lots plus
--                           one, taken under the per-batch advisory transaction lock, so two posts never draw the same
--                           number; lots are never deleted, so a number is never reused (INV-27). A code already held at
--                           the site by any lot (for example a received lot that happens to carry it) is still refused:
--                           by name (EBMR-SITE-997), backed by the material-lot uniqueness of (site, lot code) (0710).
--   site.intermediate_lot_of(p_batch)  the batch's latest intermediate lot, or NULL (its one caller reads a single lot).
--   site.intermediate_lots_of(p_batch)  every intermediate lot of the batch, in posting order.
-- Messages: EBMR-SITE-993 to EBMR-SITE-995 (unchanged), EBMR-SITE-997.

set local role ebmr_owner;

do $$
declare
  v_name text;
begin
  select c.conname into v_name
    from pg_catalog.pg_constraint c join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.conrelid = 'site.intermediate_lot'::regclass and c.contype = 'u' and array_length(c.conkey, 1) = 1 and a.attname = 'batch_id';
  if v_name is null then
    raise exception 'site.intermediate_lot has no unique rule on batch_id to drop';
  end if;
  execute format('alter table site.intermediate_lot drop constraint %I', v_name);
end
$$;
create index intermediate_lot_batch on site.intermediate_lot (batch_id, posted_at);

-- Internal (no grant to the application role): the API edition's definer posts its processing batch's output.
-- p: {batchId, productName, quantity (decimal text), unit, expiresAt, retestAt?}.
create or replace function site.create_intermediate_lot(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_id    uuid := gen_random_uuid();
  v_batch uuid;
  v_b     jsonb;
  v_f     jsonb;
  v_exp   timestamptz;
  v_rt    timestamptz;
  v_n     bigint;
  v_code  text;
begin
  -- Basis: segregation of duties (an administrator never makes a GMP entry; the act is a person's, 0990).
  perform iam.assert_not_administrator();
  v_batch := case when coalesce(p ->> 'batchId', '') ~ '^[0-9a-fA-F-]{36}$' then (p ->> 'batchId')::uuid end;
  v_b := site.subject_identity('BATCH', v_batch);
  -- Basis: record integrity (AS-03): an intermediate lot traces to a GMP batch of the register, never to a stray id.
  if v_b is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-993 batch %s is not a GMP batch of this installation: an intermediate lot is posted only from its batch (AS-03)', coalesce(p ->> 'batchId', 'NULL'));
  end if;
  -- Basis: 21 CFR 11.10(d) and Annex 11 clause 12 paraphrased (only authorised persons act): MATERIAL.HANDLE at the batch's site.
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', v_b ->> 'siteCode'));
  if v_b ->> 'siteCode' is distinct from site.actor_site() then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-993 an intermediate lot is posted at its batch''s site';
  end if;
  v_f := site.intermediate_batch_facts(v_batch);
  -- Basis: AS-03, AS-16 (an intermediate comes from a processing step whose record is complete) and engine integrity
  -- (a tablets or injectables batch posts a finished lot, never an intermediate).
  if v_b ->> 'edition' is distinct from 'SUBSTANCE' or v_f ->> 'familyEdition' is distinct from 'substance'
     or v_f ->> 'recordKind' is distinct from 'PROCESSING' or v_f ->> 'status' is distinct from 'EXECUTION_COMPLETE' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-994 batch %s is a %s %s batch of edition %s: an intermediate lot is posted only from a processing batch of the API edition whose execution is complete (AS-03, AS-16)',
                       v_b ->> 'batchNumber', coalesce(v_f ->> 'recordKind', 'unknown'), coalesce(v_f ->> 'status', 'not started'), coalesce(v_b ->> 'edition', 'none'));
  end if;
  -- Basis: record integrity (INV-13): a posted quantity is a positive decimal, never a float or zero.
  if coalesce(p ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]+)?$' or (p ->> 'quantity')::numeric <= 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-995 the posted quantity of an intermediate lot is a positive decimal (INV-13)';
  end if;
  v_exp := (p ->> 'expiresAt')::timestamptz;
  v_rt := (p ->> 'retestAt')::timestamptz;
  -- Basis: ICH Q7 section 11.6 paraphrased (a held intermediate carries an expiry or retest date; AS-09).
  if v_exp is null or (v_rt is not null and v_rt > v_exp) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-995 an intermediate lot carries its expiry date from the product master''s shelf life, and a retest date only on or before it (AS-09)';
  end if;
  -- The batch's next lot number (INV-27): drawn under the per-batch lock, so concurrent posts are serialised.
  perform pg_advisory_xact_lock(hashtext('site.intermediate_lot'), hashtext(v_batch::text));
  select count(*) + 1 into v_n from site.intermediate_lot i where i.batch_id = v_batch;
  v_code := case when v_n = 1 then v_b ->> 'batchNumber' else (v_b ->> 'batchNumber') || '-' || v_n::text end;
  -- Basis: record integrity (one code names one lot at a site): a code another lot holds is refused by name here, and by
  -- the unique (site, lot code) of site.material_lot (0710) for any path that reaches the insert.
  if exists (select 1 from site.material_lot l where l.site_code = v_b ->> 'siteCode' and l.lot_code = v_code) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-997 lot code %s, the next intermediate lot of batch %s, is already held by another lot at site %s: one code names one lot (INV-27)',
                       v_code, v_b ->> 'batchNumber', v_b ->> 'siteCode');
  end if;
  insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, retest_at, expires_at,
                                 received_by_person, received_by_account, correlation_id)
  values (v_id, v_b ->> 'siteCode', v_code, v_b ->> 'productCode', coalesce(nullif(btrim(p ->> 'productName'), ''), v_b ->> 'productCode'),
          'INTERMEDIATE', (p ->> 'quantity')::numeric, p ->> 'unit', v_rt, v_exp,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  insert into site.intermediate_lot (lot_id, batch_id, batch_number, edition, product_code, strength, posted_by_person, posted_by_account)
  values (v_id, v_batch, v_b ->> 'batchNumber', v_b ->> 'edition', v_b ->> 'productCode', v_b ->> 'strength',
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  perform platform.create_aggregate_state('material_lot', 'material_lot', v_id);
  return v_id;
end
$$;

-- The latest intermediate lot of batch p_batch, or NULL.
create or replace function site.intermediate_lot_of(p_batch uuid) returns uuid
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  return (select i.lot_id from site.intermediate_lot i where i.batch_id = p_batch order by i.posted_at desc, i.lot_id desc limit 1);
end
$$;

-- Every intermediate lot of batch p_batch, in posting order.
create function site.intermediate_lots_of(p_batch uuid) returns setof uuid
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  return query select i.lot_id from site.intermediate_lot i where i.batch_id = p_batch order by i.posted_at, i.lot_id;
end
$$;

revoke all on function site.intermediate_lots_of(uuid) from public;
grant execute on function site.intermediate_lots_of(uuid) to ebmr_app;

reset role;
