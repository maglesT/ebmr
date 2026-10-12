-- Expiry dating: the stability basis of a product's shelf life and the product master in effect at an instant (Phase 4
-- slice 6a; plan defaults D-6-3, D-6a-4; control PR-43; ADR 0012).
--
--   site.shelf_life_stability   the stability basis of a shelf life of a product and strength: the shelf life in months, the
--                               approved stability study or report it rests on, and whether it rests on accelerated data
--                               (a TENTATIVE shelf life, so the batches made under it can be found). Insert-only; recorded
--                               by the head of QC or QA (SHELF_LIFE.RECORD), never an administrator.
--   A product master version that CHANGES the shelf life in effect takes effect (QA's ERP_MASTER_CONFIRMED confirmation,
--   site-services 0802) only when a stability basis for the new shelf life of that product and strength is recorded:
--   a trigger on site.erp_master_effect refuses the effect otherwise (EBMR-IND-031), for every writer. The first shelf
--   life of a new product comes with its registration and is not checked here (default D-6a-4, for the owner).
--   site.erp_product_effective_at(product, strength, at)  the version in effect at an instant, so that a new shelf life
--   applies only to batches made after it took effect (recipe-core 0892 reads it).
--   site.shelf_life_basis_of(product, strength, months)  the latest stability basis recorded for that shelf life.
-- Messages: EBMR-IND-030 to EBMR-IND-034.

set local role ebmr_owner;

create table site.shelf_life_stability (
  id                   uuid primary key default gen_random_uuid(),
  product_code         text not null check (product_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  strength             text not null check (btrim(strength) <> '' and length(strength) <= 64),
  shelf_life_months    integer not null check (shelf_life_months between 1 and 120),
  stability_reference  text not null check (btrim(stability_reference) <> '' and length(stability_reference) <= 200),
  tentative            boolean not null,
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null
);
create index shelf_life_stability_key on site.shelf_life_stability (product_code, strength, shelf_life_months, recorded_at desc);
revoke all on site.shelf_life_stability from public;

select platform.enforce_db_time('site.shelf_life_stability', array['recorded_at']);
select kernel.register_audited_table('site.shelf_life_stability', 'shelf_life_stability', 'id', true);
create trigger zz_immutable before update or delete on site.shelf_life_stability for each row execute function site.india_record_immutable();

-- The version of product p_product, strength p_strength in effect at instant p_at, or NULL (header).
create function site.erp_product_effective_at(p_product text, p_strength text, p_at timestamptz) returns site.erp_product
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select p.* from site.erp_master_effect x join site.erp_product p on p.id = x.version_id
   where x.master_kind = 'PRODUCT' and x.master_key = site.erp_product_key(p_product, p_strength) and x.effective_at <= p_at
   order by x.effective_at desc, x.id desc limit 1
$$;

-- The latest stability basis recorded for shelf life p_months of p_product, p_strength, or NULL.
create function site.shelf_life_basis_of(p_product text, p_strength text, p_months integer) returns site.shelf_life_stability
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select s.* from site.shelf_life_stability s
   where s.product_code = p_product and s.strength = p_strength and s.shelf_life_months = p_months
   order by s.recorded_at desc, s.id desc limit 1
$$;

-- PR-43 (header): a product master version that changes the shelf life in effect takes effect only on a stability basis.
create function site.shelf_life_change_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v   site.erp_product;
  cur site.erp_product;
begin
  if new.master_kind <> 'PRODUCT' then
    return new;
  end if;
  select * into v from site.erp_product where id = new.version_id;
  cur := site.erp_product_effective(v.product_code, v.strength);
  if cur.id is not null and cur.shelf_life_months <> v.shelf_life_months
     and site.shelf_life_basis_of(v.product_code, v.strength, v.shelf_life_months) is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-031 the shelf life of %s %s changes from %s to %s months without a recorded stability basis for %s months; record the stability study first (PR-43)',
                       v.product_code, v.strength, cur.shelf_life_months, v.shelf_life_months, v.shelf_life_months);
  end if;
  return new;
end
$$;
create trigger shelf_life_change_check before insert on site.erp_master_effect for each row execute function site.shelf_life_change_check();

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0886_shelf_life_basis)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the stability basis of a shelf life (PR-43)'));

insert into iam.permission (code, domain, effect, description) values
  ('SHELF_LIFE.RECORD', 'GMP', 'WRITE', 'Record the stability basis of a product''s shelf life (head of QC, QA)');
insert into iam.role_permission (role_code, permission_code) values
  ('HEAD_OF_QC', 'SHELF_LIFE.RECORD'),
  ('QA_MBR_APPROVER', 'SHELF_LIFE.RECORD');

select kernel.set_actor_context(null);

-- p: {productCode, strength, shelfLifeMonths (integer), stabilityReference, tentative (boolean)}. Returns the id.
create function site.record_shelf_life_basis(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('SHELF_LIFE.RECORD', jsonb_build_object('site', site.actor_site()));
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'shelfLifeMonths') is distinct from 'number'
     or (p ->> 'shelfLifeMonths') !~ '^[0-9]{1,3}$' or jsonb_typeof(p -> 'tentative') is distinct from 'boolean'
     or coalesce(btrim(p ->> 'stabilityReference'), '') = '' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IND-030 a stability basis names the product, strength, the shelf life in whole months, the stability study it rests on and whether that is accelerated data (PR-43)';
  end if;
  begin
    insert into site.shelf_life_stability (product_code, strength, shelf_life_months, stability_reference, tentative, recorded_by_person,
                                           recorded_by_account, correlation_id)
    values (p ->> 'productCode', btrim(p ->> 'strength'), (p ->> 'shelfLifeMonths')::integer, btrim(p ->> 'stabilityReference'), (p ->> 'tentative')::boolean,
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception
    when check_violation or not_null_violation then
      raise exception using errcode = 'P0001', message = 'EBMR-IND-030 the stability basis is incomplete: product code, strength and a shelf life of 1 to 120 months (PR-43)';
  end;
  return v_id;
end
$$;

revoke all on function site.erp_product_effective_at(text, text, timestamptz), site.shelf_life_basis_of(text, text, integer),
                       site.shelf_life_change_check(), site.record_shelf_life_basis(jsonb) from public;
revoke all on site.shelf_life_stability from ebmr_app;
grant select on site.shelf_life_stability to ebmr_app;
grant execute on function site.erp_product_effective_at(text, text, timestamptz), site.shelf_life_basis_of(text, text, integer),
                          site.record_shelf_life_basis(jsonb) to ebmr_app;

reset role;
