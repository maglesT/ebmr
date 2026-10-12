-- Hazardous products (sex hormones, steroids, cytotoxics) and the areas dedicated to them (Phase 4 slice 6a; control
-- IN-27; default D-6a-5; ADR 0012).
--
--   plant.product_hazard      the hazard class of a product set from a documented risk assessment (NONE, SEX_HORMONE,
--                             STEROID, CYTOTOXIC); insert-only, the latest record of the product is the one in effect. A
--                             product with no record is not hazardous (class NONE).
--   plant.area_dedication     a room or line (plant.area) dedicated and contained for a hazard class, with how breathing
--                             air is supplied there (NOT_USED, or BACKED_UP: the 100 % back-up with automatic changeover
--                             is in place); a later record with dedicated = false withdraws it. Insert-only.
--   plant.hazard_area_problem(product, area)  NULL when the product is not hazardous, or the area is dedicated to its
--                             class now; else why not. The GMP issue (recipe-core 0891) refuses a hazardous product's
--                             batch on a line that is not dedicated to its class. The step-start check of rooms and
--                             equipment and the inserted PPE, containment-check and de-gowning steps of the MBR designer
--                             stay for the designer's hazard rules (residual, D-6a-5).
-- Both recorded by QA (HAZARD.RECORD), never an administrator. Messages: EBMR-IND-035 to EBMR-IND-039.

set local role ebmr_owner;

create table plant.product_hazard (
  id                     uuid primary key default gen_random_uuid(),
  product_code           text not null check (product_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  hazard_class           text not null check (hazard_class in ('NONE', 'SEX_HORMONE', 'STEROID', 'CYTOTOXIC')),
  risk_assessment_ref    text not null check (btrim(risk_assessment_ref) <> '' and length(risk_assessment_ref) <= 200),
  recorded_by_person     uuid not null,
  recorded_by_account    uuid not null,
  recorded_at            timestamptz not null default clock_timestamp(),
  correlation_id         uuid not null
);
create index product_hazard_key on plant.product_hazard (product_code, recorded_at desc);
revoke all on plant.product_hazard from public;

create table plant.area_dedication (
  id                     uuid primary key default gen_random_uuid(),
  area_code              text not null references plant.area (code),
  hazard_class           text not null check (hazard_class in ('SEX_HORMONE', 'STEROID', 'CYTOTOXIC')),
  dedicated              boolean not null,
  breathing_air          text not null check (breathing_air in ('NOT_USED', 'BACKED_UP')),
  justification          text not null check (btrim(justification) <> '' and length(justification) <= 2000),
  recorded_by_person     uuid not null,
  recorded_by_account    uuid not null,
  recorded_at            timestamptz not null default clock_timestamp(),
  correlation_id         uuid not null
);
create index area_dedication_key on plant.area_dedication (area_code, hazard_class, recorded_at desc);
revoke all on plant.area_dedication from public;

select platform.enforce_db_time('plant.product_hazard', array['recorded_at']);
select platform.enforce_db_time('plant.area_dedication', array['recorded_at']);
select kernel.register_audited_table('plant.product_hazard', 'product_hazard', 'id', true);
select kernel.register_audited_table('plant.area_dedication', 'area_dedication', 'id', true);
create trigger zz_immutable before update or delete on plant.product_hazard for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on plant.area_dedication for each row execute function site.india_record_immutable();

-- The hazard class in effect for product p_product (NONE without a record).
create function plant.product_hazard_class(p_product text) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select coalesce((select h.hazard_class from plant.product_hazard h where h.product_code = p_product order by h.recorded_at desc, h.id desc limit 1), 'NONE')
$$;

-- IN-27 (header).
create function plant.hazard_area_problem(p_product text, p_area text) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_class text := plant.product_hazard_class(p_product);
  d       plant.area_dedication;
begin
  if v_class = 'NONE' then
    return null;
  end if;
  select * into d from plant.area_dedication x where x.area_code = p_area and x.hazard_class = v_class order by x.recorded_at desc, x.id desc limit 1;
  if d.id is null or not d.dedicated then
    return format('%s is classed %s (risk assessment %s) and %s is not a room or line dedicated and contained for that class (IN-27)', p_product, v_class,
                  (select h.risk_assessment_ref from plant.product_hazard h where h.product_code = p_product order by h.recorded_at desc, h.id desc limit 1), p_area);
  end if;
  return null;
end
$$;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0890_hazard_dedication)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'hazard classes of products and the areas dedicated to them (IN-27)'));
insert into iam.permission (code, domain, effect, description) values
  ('HAZARD.RECORD', 'GMP', 'WRITE', 'Record a product''s hazard class from its risk assessment and the rooms and lines dedicated to a hazard class (QA)');
insert into iam.role_permission (role_code, permission_code) values ('QA_MBR_APPROVER', 'HAZARD.RECORD');
select kernel.set_actor_context(null);

-- p: {productCode, hazardClass, riskAssessmentRef}. Returns the record id.
create function plant.record_product_hazard(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('HAZARD.RECORD', jsonb_build_object('product', p ->> 'productCode'));
  begin
    insert into plant.product_hazard (product_code, hazard_class, risk_assessment_ref, recorded_by_person, recorded_by_account, correlation_id)
    values (p ->> 'productCode', p ->> 'hazardClass', btrim(p ->> 'riskAssessmentRef'), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
            (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception
    when check_violation or not_null_violation then
      raise exception using errcode = 'P0001',
        message = 'EBMR-IND-035 a hazard classification names the product, its class (NONE, SEX_HORMONE, STEROID or CYTOTOXIC) and the risk assessment it is set from (IN-27)';
  end;
  return v_id;
end
$$;

-- p: {areaCode, hazardClass, dedicated (boolean), breathingAir NOT_USED|BACKED_UP, justification}. Returns the record id.
create function plant.record_area_dedication(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('HAZARD.RECORD', '{}'::jsonb);
  if p is null or jsonb_typeof(p -> 'dedicated') is distinct from 'boolean' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-036 a dedication names the room or line, the hazard class, whether it is dedicated, the breathing-air supply and the justification (IN-27)';
  end if;
  if not exists (select 1 from plant.area a where a.code = p ->> 'areaCode') then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-036 %s is no room or line of the plant', coalesce(p ->> 'areaCode', 'NULL'));
  end if;
  begin
    insert into plant.area_dedication (area_code, hazard_class, dedicated, breathing_air, justification, recorded_by_person, recorded_by_account, correlation_id)
    values (p ->> 'areaCode', p ->> 'hazardClass', (p ->> 'dedicated')::boolean, p ->> 'breathingAir', btrim(p ->> 'justification'),
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception
    when check_violation or not_null_violation then
      raise exception using errcode = 'P0001',
        message = 'EBMR-IND-036 a dedication names a hazard class (SEX_HORMONE, STEROID or CYTOTOXIC), the breathing-air supply (NOT_USED or BACKED_UP) and its justification (IN-27)';
  end;
  return v_id;
end
$$;

revoke all on function plant.product_hazard_class(text), plant.hazard_area_problem(text, text), plant.record_product_hazard(jsonb),
                       plant.record_area_dedication(jsonb) from public;
revoke all on plant.product_hazard, plant.area_dedication from ebmr_app;
grant select on plant.product_hazard, plant.area_dedication to ebmr_app;
grant execute on function plant.product_hazard_class(text), plant.hazard_area_problem(text, text), plant.record_product_hazard(jsonb),
                          plant.record_area_dedication(jsonb) to ebmr_app;

reset role;
