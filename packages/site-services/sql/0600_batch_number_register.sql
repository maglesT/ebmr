-- Batch-number allocation register (site services; build outline 4.2 "Site services", 5.2.2 issue guard;
-- ADR 0001; control IN-18 (target phase 4) for context; invariant INV-27).
--
-- One register per site, shared by both editions: a batch number is unique across Tablets and
-- Injectables and is never reissued, including after a void, a rework or a restore. Numbers come from
-- a numbering rule (per site, product and batch kind, with a format) whose serial is a protected,
-- write-ahead continuity counter, or are registered from an external system (ERP). Every allocation is
-- written immediately with the allocation time, product identity and batch size. Voided numbers stay in
-- the register with their reason. All writes go through SECURITY DEFINER functions; the application
-- role can only read. The register is one tamper-evident audit chain per site
-- (batch_number_register:<site>).
--
-- Format tokens: {SITE} {PRODUCT} {YYYY} {YY} {MM} (site-local calendar at allocation) {SEQ:n} (serial,
-- zero-padded to n digits, exactly once) {PARENT} (packaging rules only: the processing batch number).
-- Literal characters: A-Z 0-9 / . -
--
-- Error codes: EBMR-SITE-0xx.

create schema if not exists site authorization ebmr_owner;
revoke all on schema site from public;
grant usage on schema site to ebmr_app;

set local role ebmr_owner;

create table site.batch_number_rule (
  id              uuid primary key default gen_random_uuid(),
  rule_code       text not null unique check (rule_code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  site_code       text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  product_code    text check (product_code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),   -- null: site-wide rule
  batch_kind      text not null check (batch_kind in ('PROCESSING', 'PACKAGING')),
  format          text not null check (format ~ '^([A-Z0-9/.-]|\{(SITE|PRODUCT|YYYY|YY|MM|PARENT|SEQ:[1-9])\})+$'),
  site_zone       text not null,
  counter_key     text not null unique,
  effective_from  timestamptz not null,
  reason          text not null check (length(trim(reason)) > 0),
  created_by_person_id  uuid not null,
  created_by_account_id uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null
);
create unique index batch_number_rule_scope on site.batch_number_rule (site_code, coalesce(product_code, ''), batch_kind, effective_from);

create table site.batch_number_allocation (
  id                   uuid primary key default gen_random_uuid(),
  batch_number         text not null check (batch_number ~ '^[A-Z0-9][A-Z0-9/.-]{0,31}$'),
  site_code            text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  site_zone            text not null,
  product_code         text not null check (product_code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  product_name         text not null check (length(trim(product_name)) > 0),
  edition              text not null check (edition in ('TABLETS', 'INJECTABLES')),
  batch_kind           text not null check (batch_kind in ('PROCESSING', 'PACKAGING')),
  parent_allocation_id uuid references site.batch_number_allocation (id),
  batch_size           numeric not null check (batch_size > 0),
  batch_size_unit      text not null check (batch_size_unit ~ '^[!-~]{1,32}$'),   -- UCUM code
  source               text not null check (source in ('GENERATED', 'EXTERNAL', 'RECOVERED_AFTER_RESTORE')),
  rule_id              uuid references site.batch_number_rule (id),
  serial               bigint check (serial >= 1),
  external_reference   text,
  restore_event_id     uuid,   -- continuity restore event (recovered allocations)
  allocated_by_person_id  uuid not null,
  allocated_by_account_id uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null,
  check ((batch_kind = 'PACKAGING') = (parent_allocation_id is not null)),
  check (source = 'EXTERNAL' or (rule_id is not null and serial is not null)),
  check (source <> 'EXTERNAL' or (rule_id is null and serial is null)),
  check ((source = 'RECOVERED_AFTER_RESTORE') = (restore_event_id is not null)),
  check (source <> 'RECOVERED_AFTER_RESTORE' or length(trim(coalesce(external_reference, ''))) > 0)
);
-- Site-wide, both editions, voided numbers included: a number is allocated once, ever.
create unique index batch_number_allocation_number on site.batch_number_allocation (batch_number);
create unique index batch_number_allocation_serial on site.batch_number_allocation (rule_id, serial) where serial is not null;

create table site.batch_number_void (
  allocation_id        uuid primary key references site.batch_number_allocation (id),
  site_code            text not null,
  reason_code          text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  reason_text          text not null check (length(trim(reason_text)) > 0),
  voided_by_person_id  uuid not null,
  voided_by_account_id uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null
);

-- A serial drawn from a rule's counter whose rendered number was already taken (for example by an
-- external registration). The serial stays accounted for.
create table site.batch_number_serial_skip (
  id                        uuid primary key default gen_random_uuid(),
  rule_id                   uuid not null references site.batch_number_rule (id),
  site_code                 text not null,
  serial                    bigint not null,
  rendered_number           text not null,
  colliding_allocation_id   uuid not null references site.batch_number_allocation (id),
  recorded_at               timestamptz not null default clock_timestamp(),
  correlation_id            uuid not null,
  unique (rule_id, serial)
);

select kernel.register_audited_table('site.batch_number_rule', 'batch_number_register', 'site_code', true);
select kernel.register_audited_table('site.batch_number_allocation', 'batch_number_register', 'site_code', true);
select kernel.register_audited_table('site.batch_number_void', 'batch_number_register', 'site_code', true);
select kernel.register_audited_table('site.batch_number_serial_skip', 'batch_number_register', 'site_code', true);

-- ---------------------------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------------------------

create function site.require_actor() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-001 no actor context: call kernel.begin_command first';
  end if;
  return v_ctx;
end
$$;

create function site.render_batch_number(p_format text, p_site text, p_product text, p_at timestamptz, p_zone text,
                                         p_serial bigint, p_parent text)
returns text
language plpgsql stable set search_path = pg_catalog, site, pg_temp as $$
declare
  v_local timestamp := p_at at time zone p_zone;
  v_width integer := (regexp_match(p_format, '\{SEQ:([1-9])\}'))[1]::integer;
  v_out   text := p_format;
begin
  if v_width is null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-010 a batch-number format needs exactly one {SEQ:n} token';
  end if;
  if p_serial is null or p_serial < 1 or p_serial > power(10::numeric, v_width) - 1 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-012 serial %s does not fit the %s digits of format %s; define a new numbering rule', p_serial, v_width, p_format);
  end if;
  if position('{PARENT}' in p_format) > 0 and coalesce(p_parent, '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-014 this format needs the processing (parent) batch number';
  end if;
  v_out := replace(v_out, '{SITE}', p_site);
  v_out := replace(v_out, '{PRODUCT}', coalesce(p_product, ''));
  v_out := replace(v_out, '{YYYY}', to_char(v_local, 'YYYY'));
  v_out := replace(v_out, '{YY}', to_char(v_local, 'YY'));
  v_out := replace(v_out, '{MM}', to_char(v_local, 'MM'));
  v_out := replace(v_out, '{PARENT}', coalesce(p_parent, ''));
  v_out := regexp_replace(v_out, '\{SEQ:[1-9]\}', lpad(p_serial::text, v_width, '0'));
  if v_out !~ '^[A-Z0-9][A-Z0-9/.-]{0,31}$' then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-010 format %s renders %s, which is not a valid batch number', p_format, v_out);
  end if;
  return v_out;
end
$$;

-- p: {rule_code, site_code, product_code?, batch_kind, format, site_zone, effective_from?, reason, block_size?}
create function site.define_batch_number_rule(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_id    uuid := gen_random_uuid();
  v_from  timestamptz;
  v_key   text;
  v_block bigint;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-002 numbering rule details are required';
  end if;
  if coalesce(p ->> 'format', '') !~ '^([A-Z0-9/.-]|\{(SITE|PRODUCT|YYYY|YY|MM|PARENT|SEQ:[1-9])\})+$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-010 the format may contain only A-Z 0-9 / . - and the tokens {SITE} {PRODUCT} {YYYY} {YY} {MM} {SEQ:n} {PARENT}';
  end if;
  if (select count(*) from regexp_matches(p ->> 'format', '\{SEQ:[1-9]\}', 'g')) <> 1 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-010 a batch-number format needs exactly one {SEQ:n} token';
  end if;
  if position('{PARENT}' in p ->> 'format') > 0 and p ->> 'batch_kind' <> 'PACKAGING' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-010 only packaging rules may use {PARENT}';
  end if;
  if position('{PRODUCT}' in p ->> 'format') > 0 and p ->> 'product_code' is null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-010 a site-wide rule cannot use {PRODUCT}';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p ->> 'site_zone') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-002 unknown site time zone %s', p ->> 'site_zone');
  end if;
  begin
    v_from := coalesce((p ->> 'effective_from')::timestamptz, clock_timestamp());
    v_block := coalesce((p ->> 'block_size')::bigint, 50);
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-002 effective_from must be a timestamp and block_size a whole number';
  end;
  if v_from < clock_timestamp() - interval '1 minute' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-010 a numbering rule cannot take effect in the past';
  end if;
  v_key := 'site.batch_number:' || coalesce(p ->> 'rule_code', '');
  begin
    insert into site.batch_number_rule (id, rule_code, site_code, product_code, batch_kind, format, site_zone, counter_key, effective_from,
                                        reason, created_by_person_id, created_by_account_id, correlation_id)
    values (v_id, p ->> 'rule_code', p ->> 'site_code', p ->> 'product_code', p ->> 'batch_kind', p ->> 'format', p ->> 'site_zone', v_key,
            v_from, p ->> 'reason', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  exception
    when check_violation or not_null_violation or unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-010 invalid numbering rule: %s', sqlerrm);
  end;
  perform continuity.register_protected_counter(v_key, 'BATCH_NUMBER', 'site-services',
    format('Batch-number serial of rule %s (site %s)', p ->> 'rule_code', p ->> 'site_code'), v_block);
  return v_id;
end
$$;

create function site.rule_in_force(p_site text, p_product text, p_kind text, p_at timestamptz) returns site.batch_number_rule
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select r.* from site.batch_number_rule r
  where r.site_code = p_site and r.batch_kind = p_kind and r.effective_from <= p_at
    and (r.product_code = p_product or r.product_code is null)
  order by (r.product_code is null), r.effective_from desc
  limit 1
$$;

-- p: {site_code, product_code, product_name, edition, batch_kind? (default PROCESSING), batch_size (decimal text),
--     batch_size_unit, parent_batch_number? (packaging), external_reference?}
create function site.allocate_batch_number(p jsonb)
returns table (allocation_id uuid, batch_number text, serial bigint)
language plpgsql volatile security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v_ctx     jsonb := site.require_actor();
  v_now     timestamptz := clock_timestamp();
  v_kind    text := coalesce(p ->> 'batch_kind', 'PROCESSING');
  v_rule    site.batch_number_rule%rowtype;
  v_parent  site.batch_number_allocation%rowtype;
  v_serial  bigint;
  v_number  text;
  v_existing uuid;
  v_id      uuid := gen_random_uuid();
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-002 allocation details are required';
  end if;
  select * into v_rule from site.rule_in_force(p ->> 'site_code', p ->> 'product_code', v_kind, v_now);
  if v_rule.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-011 no %s numbering rule is in force for product %s at site %s', v_kind, p ->> 'product_code', p ->> 'site_code');
  end if;
  if v_kind = 'PACKAGING' then
    select * into v_parent from site.batch_number_allocation a where a.batch_number = p ->> 'parent_batch_number';
    if v_parent.id is null or v_parent.batch_kind <> 'PROCESSING' or v_parent.site_code <> v_rule.site_code
       or exists (select 1 from site.batch_number_void v where v.allocation_id = v_parent.id) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-014 packaging numbers link to an allocated, not voided processing batch number of the same site (%s)', p ->> 'parent_batch_number');
    end if;
  end if;
  for i in 1..100 loop
    v_serial := continuity.next_counter_value(v_rule.counter_key);
    -- A serial this rule already drew means the counter was moved back: refuse, never skip silently.
    if exists (select 1 from site.batch_number_allocation a where a.rule_id = v_rule.id and a.serial = v_serial)
       or exists (select 1 from site.batch_number_serial_skip s where s.rule_id = v_rule.id and s.serial = v_serial) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-017 serial %s of rule %s was already drawn: its counter has been moved back; open a data-integrity incident', v_serial, v_rule.rule_code);
    end if;
    v_number := site.render_batch_number(v_rule.format, v_rule.site_code, p ->> 'product_code', v_now, v_rule.site_zone, v_serial, v_parent.batch_number);
    select a.id into v_existing from site.batch_number_allocation a where a.batch_number = v_number;
    exit when v_existing is null;
    insert into site.batch_number_serial_skip (rule_id, site_code, serial, rendered_number, colliding_allocation_id, correlation_id)
    values (v_rule.id, v_rule.site_code, v_serial, v_number, v_existing, (v_ctx ->> 'correlation_id')::uuid);
    v_number := null;
  end loop;
  if v_number is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-013 rule %s produced 100 numbers in a row that are already allocated', v_rule.rule_code);
  end if;
  begin
    insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
      parent_allocation_id, batch_size, batch_size_unit, source, rule_id, serial, external_reference, allocated_by_person_id,
      allocated_by_account_id, recorded_at, correlation_id)
    values (v_id, v_number, v_rule.site_code, v_rule.site_zone, p ->> 'product_code', p ->> 'product_name', p ->> 'edition', v_kind,
      v_parent.id, (p ->> 'batch_size')::numeric, p ->> 'batch_size_unit', 'GENERATED', v_rule.id, v_serial, p ->> 'external_reference',
      (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, v_now, (v_ctx ->> 'correlation_id')::uuid);
  exception
    when check_violation or not_null_violation or invalid_text_representation then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-002 invalid allocation: %s', sqlerrm);
  end;
  allocation_id := v_id; batch_number := v_number; serial := v_serial;
  return next;
end
$$;

-- Register a number issued by an external system (ERP) or entered manually. An existing number,
-- voided or not, is refused: numbers are never reused. Input is not normalised: it must already be
-- upper case.
-- p: {batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind?, parent_batch_number?,
--     batch_size, batch_size_unit, external_reference?}
create function site.register_external_batch_number(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  v_kind   text := coalesce(p ->> 'batch_kind', 'PROCESSING');
  v_parent site.batch_number_allocation%rowtype;
  v_id     uuid := gen_random_uuid();
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-002 registration details are required';
  end if;
  if coalesce(p ->> 'batch_number', '') !~ '^[A-Z0-9][A-Z0-9/.-]{0,31}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-002 a batch number is 1-32 characters: upper-case letters, digits, / . - (it is not changed for you)';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p ->> 'site_zone') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-002 unknown site time zone %s', p ->> 'site_zone');
  end if;
  if exists (select 1 from site.batch_number_allocation a where a.batch_number = p ->> 'batch_number') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-013 batch number %s is already in the allocation register (voided numbers included); numbers are never reused', p ->> 'batch_number');
  end if;
  if v_kind = 'PACKAGING' then
    select * into v_parent from site.batch_number_allocation a where a.batch_number = p ->> 'parent_batch_number';
    if v_parent.id is null or v_parent.batch_kind <> 'PROCESSING' or v_parent.site_code <> p ->> 'site_code'
       or exists (select 1 from site.batch_number_void v where v.allocation_id = v_parent.id) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-014 packaging numbers link to an allocated, not voided processing batch number of the same site (%s)', p ->> 'parent_batch_number');
    end if;
  end if;
  begin
    insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
      parent_allocation_id, batch_size, batch_size_unit, source, external_reference, allocated_by_person_id, allocated_by_account_id, correlation_id)
    values (v_id, p ->> 'batch_number', p ->> 'site_code', p ->> 'site_zone', p ->> 'product_code', p ->> 'product_name', p ->> 'edition', v_kind,
      v_parent.id, (p ->> 'batch_size')::numeric, p ->> 'batch_size_unit', 'EXTERNAL', p ->> 'external_reference',
      (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  exception
    when unique_violation then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-013 batch number %s is already in the allocation register; numbers are never reused', p ->> 'batch_number');
    when check_violation or not_null_violation or invalid_text_representation then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-002 invalid registration: %s', sqlerrm);
  end;
  return v_id;
end
$$;

-- A void keeps the number in the register with its reason; the number can never be issued again.
create function site.void_batch_number(p_allocation_id uuid, p_reason_code text, p_reason_text text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  a     site.batch_number_allocation%rowtype;
begin
  select * into a from site.batch_number_allocation x where x.id = p_allocation_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-015 allocation %s does not exist', p_allocation_id);
  end if;
  if exists (select 1 from site.batch_number_void v where v.allocation_id = p_allocation_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-015 batch number %s is already voided', a.batch_number);
  end if;
  if coalesce(p_reason_code, '') !~ '^[A-Z][A-Z0-9_]{1,39}$' or coalesce(trim(p_reason_text), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-015 a void needs a reason code and a reason text';
  end if;
  insert into site.batch_number_void (allocation_id, site_code, reason_code, reason_text, voided_by_person_id, voided_by_account_id, correlation_id)
  values (p_allocation_id, a.site_code, p_reason_code, p_reason_text, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
          (v_ctx ->> 'correlation_id')::uuid);
end
$$;

-- After a completed restore, re-enter a number that was issued in the lost window (known from paper,
-- ERP or labels). Only serials inside the range the restore skipped for that rule are accepted, and a
-- number or serial already in the register is refused.
-- p: {restore_event_id, rule_code, serial, batch_number, product_code, product_name, edition, batch_size,
--     batch_size_unit, parent_batch_number?, evidence_reference}
create function site.recover_batch_number(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  v_rule   site.batch_number_rule%rowtype;
  v_parent site.batch_number_allocation%rowtype;
  v_event  uuid;
  v_serial bigint;
  v_id     uuid := gen_random_uuid();
begin
  begin
    v_event := (p ->> 'restore_event_id')::uuid;
    v_serial := (p ->> 'serial')::bigint;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-016 restore_event_id must be a UUID and serial a whole number';
  end;
  select * into v_rule from site.batch_number_rule r where r.rule_code = p ->> 'rule_code';
  if v_rule.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-016 unknown numbering rule %s', p ->> 'rule_code');
  end if;
  if not exists (select 1 from continuity.restore_event_status s where s.id = v_event and s.status = 'COMPLETED') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-016 recovery needs a completed restore event';
  end if;
  if not exists (select 1 from continuity.sequence_bump b
                 where b.restore_event_id = v_event and b.sequence_key = v_rule.counter_key
                   and v_serial > b.value_before and v_serial <= b.value_after) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-016 serial %s of rule %s is not in the range that restore event %s skipped', v_serial, v_rule.rule_code, v_event);
  end if;
  if coalesce(trim(p ->> 'evidence_reference'), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-016 recovery needs the evidence (paper record, ERP document or label) that the number was issued';
  end if;
  if coalesce(p ->> 'batch_number', '') !~ '^[A-Z0-9][A-Z0-9/.-]{0,31}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-016 invalid batch number';
  end if;
  if exists (select 1 from site.batch_number_allocation a where a.batch_number = p ->> 'batch_number')
     or exists (select 1 from site.batch_number_allocation a where a.rule_id = v_rule.id and a.serial = v_serial) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-013 that batch number or serial is already in the allocation register';
  end if;
  if v_rule.batch_kind = 'PACKAGING' then
    select * into v_parent from site.batch_number_allocation a where a.batch_number = p ->> 'parent_batch_number';
    if v_parent.id is null or v_parent.batch_kind <> 'PROCESSING' then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-014 a recovered packaging number needs its processing batch number';
    end if;
  end if;
  begin
    insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
      parent_allocation_id, batch_size, batch_size_unit, source, rule_id, serial, external_reference, restore_event_id,
      allocated_by_person_id, allocated_by_account_id, correlation_id)
    values (v_id, p ->> 'batch_number', v_rule.site_code, v_rule.site_zone, p ->> 'product_code', p ->> 'product_name', p ->> 'edition',
      v_rule.batch_kind, v_parent.id, (p ->> 'batch_size')::numeric, p ->> 'batch_size_unit', 'RECOVERED_AFTER_RESTORE', v_rule.id, v_serial,
      p ->> 'evidence_reference', v_event, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-013 that batch number or serial is already in the allocation register';
    when check_violation or not_null_violation or invalid_text_representation then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-016 invalid recovery: %s', sqlerrm);
  end;
  return v_id;
end
$$;

-- The register as exported (IN-18: allocation date, product identity and batch size at least).
create view site.batch_number_register as
  select a.id as allocation_id, a.batch_number, a.site_code, a.edition, a.batch_kind, parent.batch_number as parent_batch_number,
         a.product_code, a.product_name, a.batch_size, a.batch_size_unit,
         a.recorded_at as allocated_at, (a.recorded_at at time zone a.site_zone)::date as allocation_date,
         a.source, r.rule_code, a.serial, a.external_reference, a.restore_event_id,
         case when v.allocation_id is null then 'ALLOCATED' else 'VOIDED' end as status,
         v.reason_code as void_reason_code, v.reason_text as void_reason_text, v.recorded_at as voided_at,
         a.allocated_by_person_id, a.allocated_by_account_id
  from site.batch_number_allocation a
  left join site.batch_number_allocation parent on parent.id = a.parent_allocation_id
  left join site.batch_number_rule r on r.id = a.rule_id
  left join site.batch_number_void v on v.allocation_id = a.id;

-- Invariant query (INV-27, IN-18): must return zero rows.
create function site.batch_number_invariant_violations() returns table (problem text)
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select format('rule %s: counter %s is behind serial %s already used', r.rule_code, c.last_value, u.max_serial)
  from site.batch_number_rule r
  join continuity.counter c on c.sequence_key = r.counter_key
  join lateral (select greatest(coalesce((select max(a.serial) from site.batch_number_allocation a where a.rule_id = r.id), 0),
                                coalesce((select max(s.serial) from site.batch_number_serial_skip s where s.rule_id = r.id), 0)) as max_serial) u on true
  where c.last_value < u.max_serial
  union all
  select format('rule %s has no protected counter', r.rule_code)
  from site.batch_number_rule r
  where not exists (select 1 from continuity.counter c where c.sequence_key = r.counter_key)
  union all
  select format('packaging number %s is linked to %s, which is not a processing number', a.batch_number, parent.batch_number)
  from site.batch_number_allocation a join site.batch_number_allocation parent on parent.id = a.parent_allocation_id
  where parent.batch_kind <> 'PROCESSING'
$$;

revoke all on all tables in schema site from ebmr_app;
grant select on site.batch_number_rule, site.batch_number_allocation, site.batch_number_void, site.batch_number_serial_skip,
                site.batch_number_register to ebmr_app;
grant execute on function site.render_batch_number(text, text, text, timestamptz, text, bigint, text),
                          site.define_batch_number_rule(jsonb), site.rule_in_force(text, text, text, timestamptz),
                          site.allocate_batch_number(jsonb), site.register_external_batch_number(jsonb),
                          site.void_batch_number(uuid, text, text), site.recover_batch_number(jsonb),
                          site.batch_number_invariant_violations() to ebmr_app;

reset role;
