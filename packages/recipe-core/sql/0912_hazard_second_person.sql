-- Recipe core: a hazard classification and an area dedication take effect only on a second person's e-signature (Phase 4
-- slice 6 quick review, MEDIUM; control IN-27; default D-6c-7). Until now one holder of HAZARD.RECORD could reclassify a
-- cytotoxic product to NONE, or mark a line dedicated, alone and unsigned, and the latest record won.
--
--   plant.product_hazard_approval    QA's HAZARD_CLASSIFICATION_APPROVED signature over one plant.product_hazard record,
--                                    never by its recorder (the meaning excludes performers; the command checks it too).
--   plant.area_dedication_approval   QA's AREA_DEDICATION_APPROVED signature over one plant.area_dedication record, likewise.
-- Only the latest record of its product (or of its area and class) is approved; an older one is superseded.
--
-- In effect (fail-safe: an unsigned record can only add restrictions, never lift one):
--   plant.product_hazard_classes(product) text[]  the class of the latest approved record when it is not NONE, plus the
--       class of every record after it that is not yet approved and not NONE (a pending upgrade counts at once; a pending
--       downgrade or a pending NONE counts only once approved).
--   plant.product_hazard_class(product)           re-created from 0890: the class of the latest approved record (NONE
--       without one); the classes still pending are read with product_hazard_classes.
--   plant.area_dedicated(area, class) boolean     the latest approved record of the area and class says dedicated, and no
--       later record withdraws it (a pending withdrawal counts at once; a pending dedication only once approved).
--   plant.hazard_area_problem(product, area)      re-created from 0890: NULL when every class in effect for the product
--       has the area dedicated to it; else why not (pending records named). The GMP issue gate (0891) calls it unchanged.
--
-- Commands (never an administrator, the permission first): plant.approve_product_hazard(record, signature) and
-- plant.approve_area_dedication(record, signature), HAZARD.APPROVE (QA MBR approver, QA reviewer). Signed aggregates:
-- hazard_classification <record id> and area_dedication <record id>, content state RECORDED (APPROVED or SUPERSEDED after).
-- Messages: EBMR-IND-060 to EBMR-IND-069.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0912_hazard_second_person)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'a hazard classification and an area dedication take effect only on a second person''s signature (IN-27)'));

insert into iam.permission (code, domain, effect, description) values
  ('HAZARD.APPROVE', 'GMP', 'SIGN', 'Approve a product''s hazard classification or an area''s dedication recorded by another person (IN-27)');
insert into iam.role_permission (role_code, permission_code) values ('QA_MBR_APPROVER', 'HAZARD.APPROVE'), ('QA_REVIEWER', 'HAZARD.APPROVE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('HAZARD_CLASSIFICATION_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Hazard classification approved',
   'I confirm this product''s hazard class as set from the risk assessment named.',
   array['HAZARD.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'IN-27; Schedule M dedicated facilities for hazardous products'),
  ('AREA_DEDICATION_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Area dedication approved',
   'I confirm this room or line is, or is no longer, dedicated and contained for the hazard class shown, with the breathing-air supply stated.',
   array['HAZARD.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'IN-27; Schedule M dedicated facilities for hazardous products');

select kernel.set_actor_context(null);

create table plant.product_hazard_approval (
  hazard_id            uuid primary key references plant.product_hazard (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
create table plant.area_dedication_approval (
  dedication_id        uuid primary key references plant.area_dedication (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
revoke all on plant.product_hazard_approval, plant.area_dedication_approval from public;
grant select on plant.product_hazard_approval, plant.area_dedication_approval to ebmr_app;
select platform.enforce_db_time('plant.product_hazard_approval', array['approved_at']);
select platform.enforce_db_time('plant.area_dedication_approval', array['approved_at']);
select kernel.register_audited_table('plant.product_hazard_approval', 'hazard_classification', 'hazard_id', true);
select kernel.register_audited_table('plant.area_dedication_approval', 'area_dedication', 'dedication_id', true);
create trigger zz_immutable before update or delete on plant.product_hazard_approval for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on plant.area_dedication_approval for each row execute function site.india_record_immutable();

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

-- The latest approved hazard record of a product, or NULL.
create function plant.product_hazard_approved(p_product text) returns plant.product_hazard
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select h.* from plant.product_hazard h join plant.product_hazard_approval a on a.hazard_id = h.id
   where h.product_code = p_product order by h.recorded_at desc, h.id desc limit 1
$$;

create or replace function plant.product_hazard_class(p_product text) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select coalesce((plant.product_hazard_approved(p_product)).hazard_class, 'NONE')
$$;

create function plant.product_hazard_classes(p_product text) returns text[]
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  with a as (select (plant.product_hazard_approved(p_product)).*)
  select coalesce(array_agg(distinct c order by c), '{}') from (
    select a.hazard_class as c from a where a.id is not null and a.hazard_class <> 'NONE'
    union all
    select h.hazard_class from plant.product_hazard h
     where h.product_code = p_product and h.hazard_class <> 'NONE'
       and not exists (select 1 from plant.product_hazard_approval x where x.hazard_id = h.id)
       and (not exists (select 1 from a where a.id is not null) or (h.recorded_at, h.id) > ((select a.recorded_at from a), (select a.id from a)))) y
$$;

create function plant.area_dedicated(p_area text, p_class text) returns boolean
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  with a as (select d.* from plant.area_dedication d join plant.area_dedication_approval x on x.dedication_id = d.id
              where d.area_code = p_area and d.hazard_class = p_class order by d.recorded_at desc, d.id desc limit 1)
  select coalesce((select a.dedicated from a), false)
     and not exists (select 1 from plant.area_dedication d, a
                      where d.area_code = p_area and d.hazard_class = p_class and not d.dedicated and (d.recorded_at, d.id) > (a.recorded_at, a.id))
$$;

create or replace function plant.hazard_area_problem(p_product text, p_area text) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_class text;
  v_ref   text;
begin
  foreach v_class in array plant.product_hazard_classes(p_product) loop
    if not plant.area_dedicated(p_area, v_class) then
      v_ref := (select h.risk_assessment_ref from plant.product_hazard h where h.product_code = p_product and h.hazard_class = v_class
                 order by h.recorded_at desc, h.id desc limit 1);
      return format('%s is classed %s (risk assessment %s%s) and %s is not a room or line dedicated and contained for that class, or its dedication is not approved by a second person (IN-27)',
                    p_product, v_class, v_ref, case when plant.product_hazard_class(p_product) = v_class then '' else ', pending approval' end, p_area);
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed content
-- ---------------------------------------------------------------------------------------------

create function plant.hazard_record_state(p_hazard uuid) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when exists (select 1 from plant.product_hazard_approval a where a.hazard_id = h.id) then 'APPROVED'
              when exists (select 1 from plant.product_hazard l where l.product_code = h.product_code and (l.recorded_at, l.id) > (h.recorded_at, h.id)) then 'SUPERSEDED'
              else 'RECORDED' end
    from plant.product_hazard h where h.id = p_hazard
$$;

create function plant.dedication_record_state(p_dedication uuid) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when exists (select 1 from plant.area_dedication_approval a where a.dedication_id = d.id) then 'APPROVED'
              when exists (select 1 from plant.area_dedication l where l.area_code = d.area_code and l.hazard_class = d.hazard_class
                                                                   and (l.recorded_at, l.id) > (d.recorded_at, d.id)) then 'SUPERSEDED'
              else 'RECORDED' end
    from plant.area_dedication d where d.id = p_dedication
$$;

create function plant.hazard_classification_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, site, pg_temp as $$
declare
  h plant.product_hazard;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into h from plant.product_hazard where id = p_id::uuid;
  if h.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('product_code', h.product_code, 'hazard_class', h.hazard_class, 'risk_assessment', h.risk_assessment_ref,
                                  'class_in_effect_before', plant.product_hazard_class(h.product_code),
                                  'recorded_by', h.recorded_by_person, 'recorded_at', site.utc_text(h.recorded_at)),
    'state', plant.hazard_record_state(h.id),
    'scope', jsonb_build_object('product', h.product_code),
    'entered_by', jsonb_build_array(h.recorded_by_person));
end
$$;

create function plant.area_dedication_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, site, pg_temp as $$
declare
  d plant.area_dedication;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into d from plant.area_dedication where id = p_id::uuid;
  if d.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('area_code', d.area_code, 'hazard_class', d.hazard_class, 'dedicated', d.dedicated, 'breathing_air', d.breathing_air,
                                  'justification', d.justification, 'recorded_by', d.recorded_by_person, 'recorded_at', site.utc_text(d.recorded_at)),
    'state', plant.dedication_record_state(d.id),
    'scope', '{}'::jsonb,
    'entered_by', jsonb_build_array(d.recorded_by_person));
end
$$;

select esig.register_content_provider('hazard_classification', 'plant.hazard_classification_content(text)',
  'A product''s hazard class as recorded from its risk assessment, approved by a second person (IN-27)');
select esig.register_content_provider('area_dedication', 'plant.area_dedication_content(text)',
  'A room or line dedicated (or no longer) to a hazard class, approved by a second person (IN-27)');

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- The approver's own valid signature with the meaning on the record; never the recorder.
create function plant.assert_hazard_approval(p_signature uuid, p_meaning text, p_type text, p_id uuid, p_recorder uuid, p_actor jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, esig, pg_temp as $$
declare
  v_prob text;
begin
  if p_recorder::text = p_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-062 a hazard classification or dedication is approved by another person than its recorder (IN-27, DI-35)';
  end if;
  perform esig.assert_signature(p_signature, p_meaning, p_type, p_id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-063 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from p_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-063 the approval is recorded by the person who signed it';
  end if;
end
$$;

create function plant.approve_product_hazard(p_hazard uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_ctx jsonb;
  h     plant.product_hazard;
begin
  perform iam.assert_not_administrator();
  select * into h from plant.product_hazard where id = p_hazard;
  if h.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-060 unknown hazard classification %s', coalesce(p_hazard::text, 'NULL'));
  end if;
  v_ctx := iam.require_permission('HAZARD.APPROVE', jsonb_build_object('product', h.product_code));
  perform pg_advisory_xact_lock(hashtext('plant.product_hazard'), hashtext(h.product_code));
  if plant.hazard_record_state(h.id) <> 'RECORDED' then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-061 this classification of %s is %s; only the latest record of a product is approved, once', h.product_code, plant.hazard_record_state(h.id));
  end if;
  perform plant.assert_hazard_approval(p_signature, 'HAZARD_CLASSIFICATION_APPROVED', 'hazard_classification', h.id, h.recorded_by_person, v_ctx);
  insert into plant.product_hazard_approval (hazard_id, signature_id, approved_by_person, approved_by_account)
  values (h.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

create function plant.approve_area_dedication(p_dedication uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_ctx jsonb;
  d     plant.area_dedication;
begin
  perform iam.assert_not_administrator();
  select * into d from plant.area_dedication where id = p_dedication;
  if d.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-060 unknown area dedication %s', coalesce(p_dedication::text, 'NULL'));
  end if;
  v_ctx := iam.require_permission('HAZARD.APPROVE', '{}'::jsonb);
  perform pg_advisory_xact_lock(hashtext('plant.area_dedication'), hashtext(d.area_code || '/' || d.hazard_class));
  if plant.dedication_record_state(d.id) <> 'RECORDED' then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-061 this dedication of %s is %s; only the latest record of an area and class is approved, once', d.area_code, plant.dedication_record_state(d.id));
  end if;
  perform plant.assert_hazard_approval(p_signature, 'AREA_DEDICATION_APPROVED', 'area_dedication', d.id, d.recorded_by_person, v_ctx);
  insert into plant.area_dedication_approval (dedication_id, signature_id, approved_by_person, approved_by_account)
  values (d.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

revoke all on function plant.product_hazard_approved(text), plant.product_hazard_classes(text), plant.area_dedicated(text, text),
  plant.hazard_record_state(uuid), plant.dedication_record_state(uuid), plant.hazard_classification_content(text), plant.area_dedication_content(text),
  plant.assert_hazard_approval(uuid, text, text, uuid, uuid, jsonb), plant.approve_product_hazard(uuid, uuid), plant.approve_area_dedication(uuid, uuid) from public;
grant execute on function plant.product_hazard_classes(text), plant.area_dedicated(text, text), plant.hazard_record_state(uuid),
  plant.dedication_record_state(uuid), plant.approve_product_hazard(uuid, uuid), plant.approve_area_dedication(uuid, uuid) to ebmr_app;

reset role;
