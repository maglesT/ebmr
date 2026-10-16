-- Recipe core, Phase 6 slice 6c: label templates and the packaging master's labelling declaration (IN-31, PR-36;
-- defaults D-P6c-2, D-P6c-8, D-P6c-10, D-P6c-17; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.label_field_binding   the record fields a template element may bind (D-P6c-2: layout and bindings only, every
--                                value from the record): code, description, whether an India-domestic label must bind it
--                                (D-P6c-17, as recipe.india_label_particulars gives them) and the print-job field that
--                                carries it (batch, mfgDate, expiryDate, mrp, gtin, ndc, serialPoolId), if any.
--   recipe.label_template        insert-only, audited: a version of a template (code, version, scope, markets, layout with
--                                its elements, the bound fields). A template for a market set with India is INDIA_DOMESTIC.
--   recipe.label_template_event  insert-only, audited: APPROVED (by LABEL.APPROVE, never the author; D-P6c-10: an
--                                attributed act by the second person, not a signature ceremony).
--   recipe.create_label_template(p)   LABEL.DESIGN: the next version of code p.code; refuses a value on a template
--                                (EBMR-LBL-002) and a binding that is not a record field (EBMR-LBL-001).
--   recipe.label_template_approval_problem(id)   IN-31: an India-domestic template that does not bind every India
--                                particular (the manufacturing date among them) cannot be approved; NULL when it can.
--   recipe.approve_label_template(id)   LABEL.APPROVE (EBMR-LBL-003 the problem, EBMR-LBL-004 the author).
--   recipe.packaging_labelling   insert-only, audited: the labelling declaration of a DRAFT packaging master version per
--                                G-21 step and item: its form, its template and, for cut labels, the 211.122(g) option
--                                (D-P6c-8; the latest per step and item stands).
--   recipe.declare_packaging_labelling(version, step, item, form, template, option)   MBR.AUTHOR, DRAFT only.
--   recipe.packaging_labelling_problem(version)   PR-36: a cut-label item without a 211.122(g) option, a template that is
--                                not APPROVED, or a declared item no longer in the procedure; NULL when none.
--   trigger a3_labelling_at_approval on platform.state_history (before insert): an mbr_version APPROVE is refused while
--                                the version's labelling problem stands (EBMR-LBL-011).
--   recipe.master_labelling(version), recipe.batch_labelling(batch)   the declarations in force.
-- Messages EBMR-LBL-001 to EBMR-LBL-019.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0990_label_templates)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'label template and labelling declaration permissions (IN-31, PR-36; Phase 6 slice 6c)'));

insert into iam.permission (code, domain, effect, description) values
  ('LABEL.DESIGN', 'GMP', 'WRITE', 'Save label template versions (layout and record-field bindings only)'),
  ('LABEL.APPROVE', 'GMP', 'WRITE', 'Approve a label template another person designed (IN-31)');
insert into iam.role_permission (role_code, permission_code) values
  ('MBR_AUTHOR', 'LABEL.DESIGN'), ('MASTER_DATA_STEWARD', 'LABEL.DESIGN'), ('QA_MBR_APPROVER', 'LABEL.APPROVE');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Bindings (D-P6c-2, D-P6c-17)

create table recipe.label_field_binding (
  code           text primary key check (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  description    text not null check (btrim(description) <> ''),
  india_required boolean not null,
  print_field    text check (print_field is null or print_field ~ '^[a-z][A-Za-z]{1,31}$')
);
revoke all on recipe.label_field_binding from public;
insert into recipe.label_field_binding (code, description, india_required, print_field) values
  ('DRUG_NAME', 'Name of the drug (product master)', true, null),
  ('STRENGTH', 'Strength (product master)', true, null),
  ('DOSAGE_FORM', 'Dosage form (product master)', false, null),
  ('BATCH_NUMBER', 'Batch number (the record)', true, 'batch'),
  ('MFG_DATE', 'Date of manufacture (recipe.batch_expiry)', true, 'mfgDate'),
  ('EXPIRY_DATE', 'Date of expiry (recipe.batch_expiry)', true, 'expiryDate'),
  ('MANUFACTURER_NAME_ADDRESS', 'Manufacturer name and address (the licence)', true, null),
  ('MFG_LICENCE_NO', 'Manufacturing licence number (the licence)', true, null),
  ('LOAN_LICENSEE', 'Loan licensee name, address and licence number (a loan-licence batch)', false, null),
  ('MRP', 'Maximum retail price (India-domestic packs; the batch data)', false, 'mrp'),
  ('GTIN', 'GTIN of the market (the master)', false, 'gtin'),
  ('NDC', 'US NDC (the master)', false, 'ndc'),
  ('SERIAL', 'Unit serial from the L3 pool', false, 'serialPoolId'),
  ('H2_QR', 'Schedule H2 QR payload (versioned stub, D-P4-14)', false, null);
create trigger aa_label_field_binding_insert_only before update or delete on recipe.label_field_binding for each row execute function kernel.reject_mutation();
create trigger aa_label_field_binding_no_truncate before truncate on recipe.label_field_binding for each statement execute function kernel.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Templates

create table recipe.label_template (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  version            integer not null check (version >= 1),
  scope              text not null check (scope in ('INDIA_DOMESTIC', 'EXPORT')),
  markets            text[] not null check (cardinality(markets) between 1 and 8),
  layout             jsonb not null check (jsonb_typeof(layout) = 'object'),
  fields             text[] not null check (cardinality(fields) >= 1),
  created_by_person  uuid not null,
  created_by_account uuid not null,
  created_at         timestamptz not null default clock_timestamp(),
  correlation_id     uuid not null,
  unique (code, version),
  -- IN-31: a template for a market set with India is India-domestic (it cannot leave the India particulars out by
  -- calling itself an export label).
  check (('IN' = any (markets)) = (scope = 'INDIA_DOMESTIC'))
);
revoke all on recipe.label_template from public;
create trigger aa_label_template_insert_only before update or delete on recipe.label_template for each row execute function kernel.reject_mutation();
create trigger aa_label_template_no_truncate before truncate on recipe.label_template for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('recipe.label_template', array['created_at']);
select kernel.register_audited_table('recipe.label_template', 'label_template', 'id', true);

create table recipe.label_template_event (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references recipe.label_template (id),
  event           text not null check (event in ('APPROVED', 'RETIRED')),
  reason          text check (reason is null or btrim(reason) <> ''),
  by_person       uuid not null,
  by_account      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null,
  unique (template_id, event)
);
revoke all on recipe.label_template_event from public;
create trigger aa_label_template_event_insert_only before update or delete on recipe.label_template_event for each row execute function kernel.reject_mutation();
create trigger aa_label_template_event_no_truncate before truncate on recipe.label_template_event for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('recipe.label_template_event', array['recorded_at']);
select kernel.register_audited_table('recipe.label_template_event', 'label_template', 'template_id', true);

-- DRAFT, APPROVED or RETIRED (NULL for an unknown id).
create function recipe.label_template_status(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case when exists (select 1 from recipe.label_template_event e where e.template_id = t.id and e.event = 'RETIRED') then 'RETIRED'
              when exists (select 1 from recipe.label_template_event e where e.template_id = t.id and e.event = 'APPROVED') then 'APPROVED'
              else 'DRAFT' end
    from recipe.label_template t where t.id = p_id
$$;

-- The layout reference a print job carries: <code>-v<version>.
create function recipe.label_template_ref(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select t.code || '-v' || t.version from recipe.label_template t where t.id = p_id
$$;

-- D-P6c-2 (header): the bound fields of layout p_layout in element order, or raises why it is no layout of a template.
create function recipe.label_layout_fields(p_layout jsonb) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e   jsonb;
  n   bigint;
  v_f text[] := '{}';
begin
  if jsonb_typeof(p_layout) is distinct from 'object' or exists (select 1 from jsonb_object_keys(p_layout) k where k not in ('width', 'height', 'elements'))
     or coalesce(p_layout ->> 'width', '') !~ '^[1-9][0-9]{0,3}$' or coalesce(p_layout ->> 'height', '') !~ '^[1-9][0-9]{0,3}$'
     or jsonb_typeof(p_layout -> 'elements') is distinct from 'array' or jsonb_array_length(p_layout -> 'elements') not between 1 and 40 then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-001 a label layout is {width, height, elements} in millimetres with 1 to 40 elements (D-P6c-2)';
  end if;
  for e, n in select x.v, x.i from jsonb_array_elements(p_layout -> 'elements') with ordinality x (v, i) loop
    if jsonb_typeof(e) = 'object' and (e ? 'value' or e ? 'text' or e ? 'default') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-LBL-002 element %s carries a value: a label template holds layout and field bindings only, every value comes from the record (D-P6c-2)', n);
    end if;
    if jsonb_typeof(e) is distinct from 'object' or exists (select 1 from jsonb_object_keys(e) k where k not in ('field', 'x', 'y', 'caption'))
       or coalesce(e ->> 'x', '') !~ '^(0|[1-9][0-9]{0,3})(\.[0-9])?$' or coalesce(e ->> 'y', '') !~ '^(0|[1-9][0-9]{0,3})(\.[0-9])?$'
       or (e ? 'caption' and (jsonb_typeof(e -> 'caption') <> 'string' or length(btrim(e ->> 'caption')) not between 1 and 80 or (e ->> 'caption') !~ '^[\x20-\x7E]+$')) then
      raise exception using errcode = 'P0001', message = format('EBMR-LBL-001 element %s is not {field, x, y, caption?} with positions in millimetres (D-P6c-2)', n);
    end if;
    if not exists (select 1 from recipe.label_field_binding b where b.code = e ->> 'field') then
      raise exception using errcode = 'P0001', message = format('EBMR-LBL-001 element %s binds %s, which is no record field a label may carry (D-P6c-2)', n, left(coalesce(e ->> 'field', 'nothing'), 40));
    end if;
    if not (e ->> 'field' = any (v_f)) then
      v_f := v_f || (e ->> 'field');
    end if;
  end loop;
  return v_f;
end
$$;

-- LABEL.DESIGN (header). p: {code, scope, markets, layout}.
create function recipe.create_label_template(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor   jsonb;
  v_markets text[];
  v_fields  text[];
  v_ver     integer;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('LABEL.DESIGN', '{}'::jsonb);
  if jsonb_typeof(p) is distinct from 'object' or exists (select 1 from jsonb_object_keys(p) k where k not in ('code', 'scope', 'markets', 'layout'))
     or coalesce(p ->> 'code', '') !~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' or (p ->> 'scope') is null or (p ->> 'scope') not in ('INDIA_DOMESTIC', 'EXPORT')
     or jsonb_typeof(p -> 'markets') is distinct from 'array' or jsonb_array_length(p -> 'markets') not between 1 and 8
     or exists (select 1 from jsonb_array_elements(p -> 'markets') m where jsonb_typeof(m) <> 'string' or (m #>> '{}') !~ '^[A-Z]{2}$') then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-001 a label template is {code, scope INDIA_DOMESTIC or EXPORT, markets (1 to 8 two-letter codes), layout}';
  end if;
  v_markets := array(select distinct m from jsonb_array_elements_text(p -> 'markets') m order by m);
  if ('IN' = any (v_markets)) <> (p ->> 'scope' = 'INDIA_DOMESTIC') then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-005 a label for India is INDIA_DOMESTIC and carries the India particulars; an EXPORT label names no India market (IN-31)';
  end if;
  v_fields := recipe.label_layout_fields(p -> 'layout');
  perform pg_advisory_xact_lock(hashtext('recipe.label_template:' || (p ->> 'code')));
  select coalesce(max(t.version), 0) + 1 into v_ver from recipe.label_template t where t.code = p ->> 'code';
  insert into recipe.label_template (code, version, scope, markets, layout, fields, created_by_person, created_by_account, correlation_id)
  values (p ->> 'code', v_ver, p ->> 'scope', v_markets, p -> 'layout', v_fields, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- IN-31 (header): why template p_id cannot be approved now; NULL when it can.
create function recipe.label_template_approval_problem(p_id uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  t         recipe.label_template;
  v_status  text := recipe.label_template_status(p_id);
  v_missing text;
begin
  select * into t from recipe.label_template where id = p_id;
  if t.id is null then
    return format('%s is no label template', coalesce(p_id::text, 'NULL'));
  end if;
  if v_status <> 'DRAFT' then
    return format('template %s-v%s is %s', t.code, t.version, v_status);
  end if;
  if t.scope = 'INDIA_DOMESTIC' then
    select string_agg(b.code, ', ' order by b.code) into v_missing from recipe.label_field_binding b where b.india_required and not (b.code = any (t.fields));
    if v_missing is not null then
      return format('an India-domestic label must bind %s (IN-31)', v_missing);
    end if;
  end if;
  return null;
end
$$;

-- LABEL.APPROVE (header): the second person's approval.
create function recipe.approve_label_template(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb;
  t       recipe.label_template;
  v_prob  text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('LABEL.APPROVE', '{}'::jsonb);
  select * into t from recipe.label_template where id = p_id for update;
  v_prob := recipe.label_template_approval_problem(p_id);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-003 the label template cannot be approved: %s', v_prob);
  end if;
  if t.created_by_person = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-004 a label template is approved by another person than the one who designed it (IN-31)';
  end if;
  insert into recipe.label_template_event (template_id, event, by_person, by_account, correlation_id)
  values (p_id, 'APPROVED', (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('templateId', p_id, 'ref', recipe.label_template_ref(p_id), 'status', 'APPROVED');
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The packaging master's labelling declaration (D-P6c-8)

create table recipe.packaging_labelling (
  id                  uuid primary key default gen_random_uuid(),
  version_id          uuid not null references recipe.mbr_version (id),
  step                text not null check (step ~ '^[!-~]{1,120}$'),
  item                text not null check (item ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  form                text not null check (form in ('CUT_LABEL', 'ROLL_LABEL', 'CARTON', 'LEAFLET', 'FOIL', 'OTHER')),
  template_id         uuid references recipe.label_template (id),
  option_211122g      text check (option_211122g in ('DEDICATED_LINES', 'ELECTRONIC_100', 'VISUAL_100_VERIFIED', 'PHYSICAL_PREVENTION')),
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  check (option_211122g is null or form = 'CUT_LABEL')
);
create index packaging_labelling_by_version on recipe.packaging_labelling (version_id, step, item, recorded_at);
revoke all on recipe.packaging_labelling from public;
create trigger aa_packaging_labelling_insert_only before update or delete on recipe.packaging_labelling for each row execute function kernel.reject_mutation();
create trigger aa_packaging_labelling_no_truncate before truncate on recipe.packaging_labelling for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('recipe.packaging_labelling', array['recorded_at']);
select kernel.register_audited_table('recipe.packaging_labelling', 'mbr_version', 'version_id', true);

-- The declarations in force of version p_version (the latest per step and item).
create function recipe.labelling_rows(p_version uuid) returns setof recipe.packaging_labelling
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select distinct on (l.step, l.item) l.* from recipe.packaging_labelling l where l.version_id = p_version
   order by l.step, l.item, l.recorded_at desc, l.id desc
$$;

-- PR-36 (header): why version p_version cannot be approved on its labelling; NULL when it can.
create function recipe.packaging_labelling_problem(p_version uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  l         recipe.packaging_labelling;
  v_content jsonb := (recipe.current_content(p_version)).content;
  v_node    jsonb;
  v_status  text;
begin
  for l in select * from recipe.labelling_rows(p_version) x order by x.step, x.item loop
    v_node := recipe.step_node(v_content, l.step);
    if v_node -> 'block' ->> 'type' is distinct from 'G-21' or recipe.g21_cfg_member(recipe.g21_cfg(v_node), 'items', to_jsonb(l.item)) is null then
      return format('step %s item %s is declared but is no printed item of a G-21 step of this version', l.step, l.item);
    end if;
    if l.form = 'CUT_LABEL' and l.option_211122g is null then
      return format('step %s item %s uses cut labels without a 211.122(g) option (PR-36)', l.step, l.item);
    end if;
    if l.template_id is not null then
      v_status := recipe.label_template_status(l.template_id);
      if v_status <> 'APPROVED' then
        return format('step %s item %s names label template %s, which is %s, not APPROVED (IN-31)', l.step, l.item, recipe.label_template_ref(l.template_id), v_status);
      end if;
    end if;
  end loop;
  return null;
end
$$;

-- {versionId, state, items: [{step, item, form, templateId, templateRef, option211122g}], approvalProblem}
create function recipe.master_labelling(p_version uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object(
    'versionId', p_version,
    'state', coalesce((select s.state from platform.aggregate_state s where s.aggregate_type = 'mbr_version' and s.aggregate_id = p_version), 'DRAFT'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('step', l.step, 'item', l.item, 'form', l.form, 'templateId', l.template_id,
                                                           'templateRef', recipe.label_template_ref(l.template_id), 'option211122g', l.option_211122g) order by l.step, l.item)
                         from recipe.labelling_rows(p_version) l), '[]'::jsonb),
    'approvalProblem', recipe.packaging_labelling_problem(p_version))
$$;

-- MBR.AUTHOR, DRAFT only (header).
create function recipe.declare_packaging_labelling(p_version uuid, p_step text, p_item text, p_form text, p_template uuid, p_option text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_node  jsonb;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_version v where v.id = p_version) then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-010 %s is no MBR version', coalesce(p_version::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  if recipe.version_state_locked(p_version) is distinct from 'DRAFT' then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-012 a labelling declaration is made on a DRAFT version: it is part of what is approved (D-P6c-8, PR-06)';
  end if;
  v_node := recipe.step_node((recipe.current_content(p_version)).content, p_step);
  if v_node -> 'block' ->> 'type' is distinct from 'G-21' or recipe.g21_cfg_member(recipe.g21_cfg(v_node), 'items', to_jsonb(p_item)) is null then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-010 %s item %s is no printed item of a G-21 step of this version', left(coalesce(p_step, 'NULL'), 120), left(coalesce(p_item, 'NULL'), 32));
  end if;
  if p_form is null or p_form not in ('CUT_LABEL', 'ROLL_LABEL', 'CARTON', 'LEAFLET', 'FOIL', 'OTHER')
     or (p_option is not null and p_option not in ('DEDICATED_LINES', 'ELECTRONIC_100', 'VISUAL_100_VERIFIED', 'PHYSICAL_PREVENTION')) then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-013 the form is CUT_LABEL, ROLL_LABEL, CARTON, LEAFLET, FOIL or OTHER, the option one of the 211.122(g) choices';
  end if;
  if p_option is not null and p_form <> 'CUT_LABEL' then
    raise exception using errcode = 'P0001', message = 'EBMR-LBL-013 a 211.122(g) option is the choice of an item with cut labels (PR-36)';
  end if;
  if p_template is not null and not exists (select 1 from recipe.label_template t where t.id = p_template) then
    raise exception using errcode = 'P0001', message = format('EBMR-LBL-014 %s is no label template', p_template);
  end if;
  insert into recipe.packaging_labelling (version_id, step, item, form, template_id, option_211122g, recorded_by_person, recorded_by_account, correlation_id)
  values (p_version, p_step, p_item, p_form, p_template, p_option, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return recipe.master_labelling(p_version);
end
$$;

-- The declarations of the master version batch p_batch runs (empty for a sandbox test batch).
create function recipe.batch_labelling(p_batch uuid) returns setof recipe.packaging_labelling
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select l.* from recipe.batch_mbr_pin p, lateral recipe.labelling_rows(p.version_id) l where p.batch_id = p_batch
$$;

-- PR-36 (header): the APPROVE of an MBR version waits for its labelling.
create function recipe.labelling_at_approval_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_prob text;
begin
  if new.aggregate_type = 'mbr_version' and new.event = 'APPROVE' then
    v_prob := recipe.packaging_labelling_problem(new.aggregate_id);
    if v_prob is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-LBL-011 this packaging master cannot be approved: %s', v_prob);
    end if;
  end if;
  return new;
end
$$;

create trigger a3_labelling_at_approval before insert on platform.state_history for each row execute function recipe.labelling_at_approval_check();

revoke all on function recipe.label_template_status(uuid), recipe.label_template_ref(uuid), recipe.label_layout_fields(jsonb), recipe.create_label_template(jsonb),
  recipe.label_template_approval_problem(uuid), recipe.approve_label_template(uuid), recipe.labelling_rows(uuid), recipe.packaging_labelling_problem(uuid),
  recipe.master_labelling(uuid), recipe.declare_packaging_labelling(uuid, text, text, text, uuid, text), recipe.batch_labelling(uuid), recipe.labelling_at_approval_check() from public;
grant execute on function recipe.label_template_status(uuid), recipe.label_template_ref(uuid), recipe.create_label_template(jsonb), recipe.label_template_approval_problem(uuid),
  recipe.approve_label_template(uuid), recipe.packaging_labelling_problem(uuid), recipe.master_labelling(uuid), recipe.declare_packaging_labelling(uuid, text, text, text, uuid, text),
  recipe.batch_labelling(uuid) to ebmr_app;
grant select on recipe.label_field_binding, recipe.label_template, recipe.label_template_event, recipe.packaging_labelling to ebmr_app;

reset role;
