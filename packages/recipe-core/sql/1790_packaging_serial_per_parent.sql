-- Batch-number register: the {SEQ:n} of a packaging number counts per processing (parent) batch by default, so each
-- processing batch's first packaging order is <parent>/P01 (owner demo report #19, Phase 7 slice 7u; IN-18, INV-27).
--
-- Handbook: modules/site-services.md
--
-- Why. site.allocate_batch_number (site services 0600) rendered {SEQ:n} from the rule's protected counter, which
-- counts every number the rule gives. A packaging rule such as {PARENT}/P{SEQ:2} therefore numbered the first packing
-- order of the second processing batch RAB26002/P02, not /P01: the serial ran on across parent batches.
--
-- Now. A numbering rule states its serial scope (serial_scope): RULE, one serial across the rule (as before), or
-- PARENT, a serial per processing batch. Not stated, a packaging rule whose format holds {PARENT} counts per parent,
-- every other rule across the rule. PARENT needs {PARENT} in the format (otherwise two parents would give the same
-- number). Every allocation still draws the rule's protected, write-ahead serial (stored in serial, unique per rule),
-- so serial accounting, skips and restores work as before; a per-parent allocation also stores the number its
-- {SEQ:n} rendered (parent_serial, unique per rule and parent).
--
-- A number is never reissued (IN-18, INV-27), also across a restore, a server restart or a ledger that is ahead: the
-- rule's counter then skips (continuity.sequence_bump) because numbers may have been issued that this database does
-- not hold. Each skipped serial stands for at most one lost number of a parent, so the next per-parent serial of a
-- parent allocated before such a skip is above the parent's highest serial before the latest skip plus the widths
-- of all skips since the parent was allocated (site.next_parent_serial). A rendered number already in the register
-- moves on to the next per-parent serial (recorded as a serial skip, as before). A parent allocated before this
-- migration keeps the rule-wide serial, so its packaging numbers continue as they began.
--
-- A recovery after a restore (site.recover_batch_number) of a per-parent number names the parent serial its number
-- shows (parent_serial; not given, the rule's serial) besides the rule's serial in the skipped range. Applied as a new migration because applied
-- migrations are never edited; the functions are replaced with the same signatures (grants are kept).

set local role ebmr_owner;

alter table site.batch_number_rule add column serial_scope text check (serial_scope in ('RULE', 'PARENT'));
alter table site.batch_number_rule add constraint batch_number_rule_parent_scope
  check (serial_scope is distinct from 'PARENT' or (batch_kind = 'PACKAGING' and position('{PARENT}' in format) > 0));

alter table site.batch_number_allocation add column parent_serial bigint check (parent_serial >= 1);
alter table site.batch_number_allocation add constraint batch_number_allocation_parent_serial
  check (parent_serial is null or (batch_kind = 'PACKAGING' and rule_id is not null));
create unique index batch_number_allocation_parent_serial_unique
  on site.batch_number_allocation (rule_id, parent_allocation_id, parent_serial) where parent_serial is not null;

-- A serial skip of a per-parent number records the parent serial it rendered too.
alter table site.batch_number_serial_skip add column parent_allocation_id uuid references site.batch_number_allocation (id);
alter table site.batch_number_serial_skip add column parent_serial bigint check (parent_serial >= 1);
alter table site.batch_number_serial_skip add constraint batch_number_serial_skip_parent
  check ((parent_serial is null) = (parent_allocation_id is null));

-- When per-parent numbering came into force: parents allocated earlier keep the rule-wide serial.
create table site.batch_number_parent_serial_since (
  singleton boolean primary key default true check (singleton),
  since     timestamptz not null default clock_timestamp()
);
insert into site.batch_number_parent_serial_since default values;
revoke all on site.batch_number_parent_serial_since from public;
grant select on site.batch_number_parent_serial_since to ebmr_app;

-- Whether {SEQ:n} of a number of rule r for parent p counts per parent.
create function site.counts_per_parent(r site.batch_number_rule, p site.batch_number_allocation) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select p.id is not null and r.batch_kind = 'PACKAGING' and position('{PARENT}' in r.format) > 0
     and coalesce(r.serial_scope, 'PARENT') = 'PARENT'
     and p.recorded_at >= (select s.since from site.batch_number_parent_serial_since s)
$$;

-- The next per-parent serial of rule r for parent p (callers hold the rule's counter lock, which serialises them).
create function site.next_parent_serial(r site.batch_number_rule, p site.batch_number_allocation) returns bigint
language sql stable security definer set search_path = pg_catalog, site, continuity, pg_temp as $$
  with bump as (
    select b.recorded_at, b.value_after - b.value_before as width
    from continuity.sequence_bump b
    where b.sequence_key = r.counter_key and b.recorded_at > p.recorded_at and b.value_after > b.value_before
  ), used as (
    select a.parent_serial, a.recorded_at from site.batch_number_allocation a
    where a.rule_id = r.id and a.parent_allocation_id = p.id and a.parent_serial is not null
    union all
    select s.parent_serial, s.recorded_at from site.batch_number_serial_skip s
    where s.rule_id = r.id and s.parent_allocation_id = p.id and s.parent_serial is not null
  )
  select greatest(
    coalesce((select max(u.parent_serial) from used u), 0),
    case when exists (select 1 from bump)
         then coalesce((select max(u.parent_serial) from used u where u.recorded_at < (select max(b.recorded_at) from bump b)), 0)
              + (select sum(b.width) from bump b)
         else 0 end
  ) + 1
$$;

-- p: {rule_code, site_code, product_code?, batch_kind, format, site_zone, effective_from?, reason, block_size?,
--     serial_scope? (RULE or PARENT)}
create or replace function site.define_batch_number_rule(p jsonb) returns uuid
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
  -- DI-18, then DI-17 in the rule's site (and product) scope.
  perform iam.assert_not_administrator();
  perform iam.require_permission('BATCH_NUMBER.RULE_DEFINE', site.batch_number_scope(p ->> 'site_code', p ->> 'product_code'));
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
  if (p ->> 'serial_scope') is not null and (p ->> 'serial_scope') not in ('RULE', 'PARENT') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-010 the serial scope of a rule is RULE or PARENT';
  end if;
  if (p ->> 'serial_scope') = 'PARENT' and position('{PARENT}' in p ->> 'format') = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-010 a serial per parent batch needs {PARENT} in the format';
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
                                        reason, serial_scope, created_by_person_id, created_by_account_id, correlation_id)
    values (v_id, p ->> 'rule_code', p ->> 'site_code', p ->> 'product_code', p ->> 'batch_kind', p ->> 'format', p ->> 'site_zone', v_key,
            v_from, p ->> 'reason', p ->> 'serial_scope', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
            (v_ctx ->> 'correlation_id')::uuid);
  exception
    when check_violation or not_null_violation or unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-010 invalid numbering rule: %s', sqlerrm);
  end;
  perform continuity.register_protected_counter(v_key, 'BATCH_NUMBER', 'site-services',
    format('Batch-number serial of rule %s (site %s)', p ->> 'rule_code', p ->> 'site_code'), v_block,
    jsonb_build_object('site', p ->> 'site_code'));
  return v_id;
end
$$;

create or replace function site.allocate_batch_number(p jsonb)
returns table (allocation_id uuid, batch_number text, serial bigint)
language plpgsql volatile security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v_ctx     jsonb := site.require_actor();
  v_now     timestamptz := clock_timestamp();
  v_kind    text := coalesce(p ->> 'batch_kind', 'PROCESSING');
  v_rule    site.batch_number_rule%rowtype;
  v_parent  site.batch_number_allocation%rowtype;
  v_serial  bigint;
  v_per_parent boolean := false;
  v_pserial bigint;
  v_number  text;
  v_existing uuid;
  v_id      uuid := gen_random_uuid();
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-002 allocation details are required';
  end if;
  -- DI-18, then DI-17 in the site and product scope of the number.
  perform iam.assert_not_administrator();
  perform iam.require_permission('BATCH_NUMBER.ALLOCATE', site.batch_number_scope(p ->> 'site_code', p ->> 'product_code'));
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
    v_per_parent := site.counts_per_parent(v_rule, v_parent);
  end if;
  for i in 1..100 loop
    -- The rule's protected serial is drawn for every number (its counter lock also serialises the per-parent serial).
    v_serial := continuity.next_counter_value(v_rule.counter_key);
    -- A serial this rule already drew means the counter was moved back: refuse, never skip silently.
    if exists (select 1 from site.batch_number_allocation a where a.rule_id = v_rule.id and a.serial = v_serial)
       or exists (select 1 from site.batch_number_serial_skip s where s.rule_id = v_rule.id and s.serial = v_serial) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-017 serial %s of rule %s was already drawn: its counter has been moved back; open a data-integrity incident', v_serial, v_rule.rule_code);
    end if;
    v_pserial := case when v_per_parent then site.next_parent_serial(v_rule, v_parent) end;
    v_number := site.render_batch_number(v_rule.format, v_rule.site_code, p ->> 'product_code', v_now, v_rule.site_zone,
                                         coalesce(v_pserial, v_serial), v_parent.batch_number);
    select a.id into v_existing from site.batch_number_allocation a where a.batch_number = v_number;
    exit when v_existing is null;
    insert into site.batch_number_serial_skip (rule_id, site_code, serial, rendered_number, colliding_allocation_id, correlation_id,
                                               parent_allocation_id, parent_serial)
    values (v_rule.id, v_rule.site_code, v_serial, v_number, v_existing, (v_ctx ->> 'correlation_id')::uuid,
            case when v_per_parent then v_parent.id end, v_pserial);
    v_number := null;
  end loop;
  if v_number is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-013 rule %s produced 100 numbers in a row that are already allocated', v_rule.rule_code);
  end if;
  begin
    insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
      parent_allocation_id, batch_size, batch_size_unit, source, rule_id, serial, parent_serial, external_reference, allocated_by_person_id,
      allocated_by_account_id, recorded_at, correlation_id)
    values (v_id, v_number, v_rule.site_code, v_rule.site_zone, p ->> 'product_code', p ->> 'product_name', p ->> 'edition', v_kind,
      v_parent.id, (p ->> 'batch_size')::numeric, p ->> 'batch_size_unit', 'GENERATED', v_rule.id, v_serial, v_pserial, p ->> 'external_reference',
      (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, v_now, (v_ctx ->> 'correlation_id')::uuid);
  exception
    when check_violation or not_null_violation or invalid_text_representation then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-002 invalid allocation: %s', sqlerrm);
  end;
  allocation_id := v_id; batch_number := v_number; serial := v_serial;
  return next;
end
$$;

-- p: {restore_event_id, rule_code, serial, parent_serial? (a per-parent number), batch_number, product_code, product_name,
--     edition, batch_size, batch_size_unit, parent_batch_number?, evidence_reference}
create or replace function site.recover_batch_number(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  v_rule   site.batch_number_rule%rowtype;
  v_parent site.batch_number_allocation%rowtype;
  v_event  uuid;
  v_serial bigint;
  v_pserial bigint;
  v_id     uuid := gen_random_uuid();
begin
  begin
    v_event := (p ->> 'restore_event_id')::uuid;
    v_serial := (p ->> 'serial')::bigint;
    v_pserial := (p ->> 'parent_serial')::bigint;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-016 restore_event_id must be a UUID and serial a whole number';
  end;
  select * into v_rule from site.batch_number_rule r where r.rule_code = p ->> 'rule_code';
  if v_rule.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-016 unknown numbering rule %s', p ->> 'rule_code');
  end if;
  -- DI-18, then DI-17 in the rule's site and product scope (a site-wide rule: the product given).
  perform iam.assert_not_administrator();
  perform iam.require_permission('BATCH_NUMBER.RECOVER', site.batch_number_scope(v_rule.site_code, coalesce(v_rule.product_code, p ->> 'product_code')));
  if v_rule.product_code is not null and (p ->> 'product_code') is distinct from v_rule.product_code then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-016 rule %s numbers product %s only, not %s', v_rule.rule_code, v_rule.product_code, p ->> 'product_code');
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
    -- The parent may have been voided since; it must still be a processing number of the rule's site.
    select * into v_parent from site.batch_number_allocation a where a.batch_number = p ->> 'parent_batch_number';
    if v_parent.id is null or v_parent.batch_kind <> 'PROCESSING' or v_parent.site_code <> v_rule.site_code then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-014 a recovered packaging number needs its processing batch number of the same site (%s)', p ->> 'parent_batch_number');
    end if;
  end if;
  -- A per-parent number shows its parent serial (not given: the rule's serial); any other number shows the rule's serial.
  if site.counts_per_parent(v_rule, v_parent) then
    v_pserial := coalesce(v_pserial, v_serial);
  elsif v_pserial is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-016 rule %s does not number per parent batch: give no parent serial', v_rule.rule_code);
  end if;
  if (p ->> 'batch_number') !~ coalesce(site.batch_number_pattern(v_rule.format, v_rule.site_code, p ->> 'product_code', coalesce(v_pserial, v_serial), v_parent.batch_number), '^$.') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-016 %s is not what rule %s (format %s) gives for serial %s', p ->> 'batch_number', v_rule.rule_code, v_rule.format, coalesce(v_pserial, v_serial));
  end if;
  begin
    insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
      parent_allocation_id, batch_size, batch_size_unit, source, rule_id, serial, parent_serial, external_reference, restore_event_id,
      allocated_by_person_id, allocated_by_account_id, correlation_id)
    values (v_id, p ->> 'batch_number', v_rule.site_code, v_rule.site_zone, p ->> 'product_code', p ->> 'product_name', p ->> 'edition',
      v_rule.batch_kind, v_parent.id, (p ->> 'batch_size')::numeric, p ->> 'batch_size_unit', 'RECOVERED_AFTER_RESTORE', v_rule.id, v_serial,
      v_pserial, p ->> 'evidence_reference', v_event, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
      (v_ctx ->> 'correlation_id')::uuid);
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-013 that batch number or serial is already in the allocation register';
    when check_violation or not_null_violation or invalid_text_representation then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-016 invalid recovery: %s', sqlerrm);
  end;
  return v_id;
end
$$;

revoke all on function site.counts_per_parent(site.batch_number_rule, site.batch_number_allocation),
                       site.next_parent_serial(site.batch_number_rule, site.batch_number_allocation) from public;

reset role;
