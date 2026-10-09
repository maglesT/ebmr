-- Material lots, part 1: tables, signature meanings, permissions, signed content and the guards of the
-- material_lot machine (build outline 5.2.9 "Material lot", 4.2 "Site services"; ADR 0001: lots and
-- reservations live at the site; Phase 3 slice 1 plan, defaults D-S1-1 and D-S1-2). Controls INV-13,
-- INV-14 (input side), IN-24 (a)(c), PR-18.
--
--   material_lot          one received lot: material, kind, quantity (numeric, never negative), unit, retest and
--                         expiry instants, the recorded release route. Its usage status is the state of the
--                         material_lot machine (generated seed 0711); RETEST_DUE and EXPIRED are computed from the
--                         dates at database time (view site.material_lot_usage, 0712), never stored.
--   lot_status_command    every status change, written by the command functions in the transaction of the
--                         transition (the guard material_lot.command_recorded refuses a transition without it, so a
--                         direct platform.transition by the application is refused). A RELEASE row records the route.
--   lot_identity_result   identity test results recorded by QC (PASS / FAIL).
--   vendor_route          QA's enablement of the vendor-history release route for one excipient (India Revised
--                         Schedule M allows release on supplier history under conditions): a stored statistical
--                         justification, effective only once QA signed it (VENDOR_ROUTE_ENABLED). Default: no
--                         material is enabled (IN-24 (c), gap F-2).
--   lot_destruction       the destruction record (performer, method, quantity); a witness other than the performer
--                         signs MATERIAL_DESTRUCTION_WITNESSED before DESTROY.
--   lot_reservation       a quantity of a lot reserved for one batch (id, number, edition) until an expiry instant.
--                         Open while not revoked, not expired and not used up; revoked when the lot leaves a usable
--                         status; valid only while the lot's state version is the one it was granted at.
--   lot_consumption       each consumption against a reservation: the genealogy link lot -> batch (INV-14), with the
--                         lot quantity before and after, the batch's market set and the identity rule applied.
--
-- Privileges: ebmr_app reads; every write is a SECURITY DEFINER function of 0712 (DI-17, DI-18; ADR 0012, 0016).
-- Messages: plain language, rule or control, code EBMR-SITE-1NN.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- The audit trigger needs a reason code and text for every UPDATE of an audited row. Updates made by the lot
-- functions carry the command's own reason, completed with a fixed one naming the act. Returns the original
-- context for site.restore_actor.
create function site.push_reason(p_code text, p_text text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v   jsonb := site.require_actor();
  v_n jsonb := v;
begin
  if kernel.is_blank(v ->> 'reason_code') then
    v_n := v_n || jsonb_build_object('reason_code', p_code);
  end if;
  if kernel.is_blank(v ->> 'reason_text') then
    v_n := v_n || jsonb_build_object('reason_text', p_text);
  end if;
  if v_n is distinct from v then
    perform kernel.set_actor_context(v_n);
  end if;
  return v;
end
$$;

create function site.restore_actor(p_ctx jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
begin
  if p_ctx is distinct from kernel.current_actor() then
    perform kernel.set_actor_context(p_ctx);
  end if;
end
$$;

create function site.utc_text(p timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p is null then null else to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end
$$;

-- The site of the command's session (the server took it from the enrolled device, never from the client).
create function site.actor_site() returns text
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v text := iam.actor_location_scope() ->> 'site';
begin
  if coalesce(v, '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-101 the command''s session has no site: material lots are handled at a site terminal';
  end if;
  return v;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table site.material_lot (
  id                   uuid primary key,
  site_code            text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  lot_code             text not null check (lot_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  material_code        text not null check (material_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  material_name        text not null check (btrim(material_name) <> ''),
  material_kind        text not null check (material_kind in ('API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING', 'INTERMEDIATE', 'FINISHED')),
  supplier             text check (supplier is null or btrim(supplier) <> ''),
  supplier_lot         text check (supplier_lot is null or btrim(supplier_lot) <> ''),
  received_quantity    numeric not null check (received_quantity > 0),
  quantity             numeric not null check (quantity >= 0),
  unit                 text not null check (unit ~ '^[!-~]{1,32}$'),   -- UCUM code
  retest_at            timestamptz,
  expires_at           timestamptz not null,
  release_route        text check (release_route in ('IDENTITY_TESTED', 'VENDOR_HISTORY')),
  released_at          timestamptz,
  received_by_person   uuid not null,
  received_by_account  uuid not null,
  received_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null,
  unique (site_code, lot_code),
  check (quantity <= received_quantity),
  check (retest_at is null or retest_at <= expires_at),
  check ((release_route is null) = (released_at is null)),
  check (release_route is distinct from 'VENDOR_HISTORY' or material_kind = 'EXCIPIENT')
);
create index material_lot_material on site.material_lot (site_code, material_code);
revoke all on site.material_lot from public;

create trigger ab_sandbox_identifier_guard before insert or update on site.material_lot
  for each row execute function sandbox.guard_identifier('LOT_NUMBER', 'lot_code');

create table site.lot_status_command (
  id              uuid primary key default gen_random_uuid(),
  lot_id          uuid not null references site.material_lot (id),
  event           text not null check (event ~ '^[A-Z][A-Z_]*$'),
  from_state      text not null,
  release_route   text check (release_route in ('IDENTITY_TESTED', 'VENDOR_HISTORY')),
  signature_id    uuid,
  reason_code     text,
  reason_text     text,
  person_id       uuid not null,
  account_id      uuid not null,
  xact_id         bigint not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  check ((event = 'RELEASE') = (release_route is not null))
);
create index lot_status_command_lot on site.lot_status_command (lot_id, xact_id);
revoke all on site.lot_status_command from public;

-- Every state the lot entered through a command, written after the transition. A registered signed table: each
-- status change supersedes the signatures given before it, which authorised the previous step only (DI-37), so a
-- QA person can decide on the same lot again later (hold, release from hold, hold again).
create table site.lot_state_entry (
  id              uuid primary key default gen_random_uuid(),
  lot_id          uuid not null references site.material_lot (id),
  state           text not null,
  state_version   bigint not null check (state_version >= 2),
  history_id      bigint not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  unique (lot_id, state_version)
);
revoke all on site.lot_state_entry from public;

create table site.lot_identity_result (
  id                 uuid primary key default gen_random_uuid(),
  lot_id             uuid not null references site.material_lot (id),
  result             text not null check (result in ('PASS', 'FAIL')),
  method_reference   text not null check (btrim(method_reference) <> ''),
  test_reference     text not null check (btrim(test_reference) <> ''),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at        timestamptz not null default clock_timestamp()
);
create index lot_identity_result_lot on site.lot_identity_result (lot_id);
revoke all on site.lot_identity_result from public;

create table site.vendor_route (
  id                     uuid primary key default gen_random_uuid(),
  site_code              text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  material_code          text not null check (material_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  material_kind          text not null check (material_kind = 'EXCIPIENT'),
  justification          text not null check (length(btrim(justification)) >= 20),
  statistical_reference  text not null check (btrim(statistical_reference) <> ''),
  proposed_by_person     uuid not null,
  proposed_by_account    uuid not null,
  proposed_at            timestamptz not null default clock_timestamp(),
  signature_id           uuid unique,
  enabled_by_person      uuid,
  enabled_at             timestamptz,
  disabled_by_person     uuid,
  disabled_at            timestamptz,
  disabled_reason        text,
  check ((signature_id is null) = (enabled_at is null) and (enabled_at is null) = (enabled_by_person is null)),
  check ((disabled_at is null) = (disabled_by_person is null) and (disabled_at is null) = (disabled_reason is null)),
  check (disabled_reason is null or btrim(disabled_reason) <> '')
);
-- One enabled route per material and site at a time.
create unique index vendor_route_enabled on site.vendor_route (site_code, material_code) where enabled_at is not null and disabled_at is null;
revoke all on site.vendor_route from public;

create table site.lot_destruction (
  id                   uuid primary key default gen_random_uuid(),
  lot_id               uuid not null unique references site.material_lot (id),
  method               text not null check (btrim(method) <> ''),
  reason               text not null check (btrim(reason) <> ''),
  quantity             numeric not null check (quantity >= 0),
  unit                 text not null,
  performed_by_person  uuid not null,
  performed_by_account uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);
revoke all on site.lot_destruction from public;

create table site.lot_reservation (
  id                  uuid primary key default gen_random_uuid(),
  lot_id              uuid not null references site.material_lot (id),
  batch_id            uuid not null,
  batch_number        text not null check (batch_number ~ '^[A-Z0-9][A-Z0-9/.-]{0,31}$'),
  edition             text not null check (edition in ('TABLETS', 'INJECTABLES')),
  quantity            numeric not null check (quantity > 0),
  unit                text not null,
  expires_at          timestamptz not null,
  lot_state_version   bigint not null check (lot_state_version >= 1),
  reserved_by_person  uuid not null,
  reserved_by_account uuid not null,
  reserved_at         timestamptz not null default clock_timestamp(),
  revoked_at          timestamptz,
  revoked_by_person   uuid,
  revoked_reason      text,
  check ((revoked_at is null) = (revoked_reason is null)),
  check (revoked_reason is null or btrim(revoked_reason) <> '')
);
create index lot_reservation_lot on site.lot_reservation (lot_id) where revoked_at is null;
revoke all on site.lot_reservation from public;

create table site.lot_consumption (
  id                  uuid primary key default gen_random_uuid(),
  lot_id              uuid not null references site.material_lot (id),
  reservation_id      uuid not null references site.lot_reservation (id),
  batch_id            uuid not null,
  batch_number        text not null,
  edition             text not null,
  material_code       text not null,
  quantity            numeric not null check (quantity > 0),
  unit                text not null,
  quantity_before     numeric not null,
  quantity_after      numeric not null check (quantity_after >= 0),
  market_set          text[] not null check (cardinality(market_set) >= 1),
  release_route       text,
  identity_basis      text not null check (identity_basis in ('IDENTITY_RESULT', 'VENDOR_HISTORY_INDIA_ONLY', 'INTERMEDIATE')),
  consumed_by_person  uuid not null,
  consumed_by_account uuid not null,
  xact_id             bigint not null,
  consumed_at         timestamptz not null default clock_timestamp(),
  check (quantity_after = quantity_before - quantity)
);
create index lot_consumption_lot on site.lot_consumption (lot_id, xact_id);
create index lot_consumption_reservation on site.lot_consumption (reservation_id);
create index lot_consumption_batch on site.lot_consumption (batch_id);
revoke all on site.lot_consumption from public;

-- ---------------------------------------------------------------------------------------------
-- Row rules (they hold even against owner-level code)
-- ---------------------------------------------------------------------------------------------

-- A lot's identity, material, dates and received quantity never change. Its quantity only goes down, and only
-- with the consumption row of this transaction that records exactly that change (INV-13, INV-14). Its release
-- route is written once, with the RELEASE command of this transaction that recorded it.
create function site.material_lot_update_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-120 material lots are never deleted';
  end if;
  if (new.id, new.site_code, new.lot_code, new.material_code, new.material_name, new.material_kind, new.supplier, new.supplier_lot,
      new.received_quantity, new.unit, new.retest_at, new.expires_at, new.received_by_person, new.received_by_account, new.received_at,
      new.correlation_id)
     is distinct from
     (old.id, old.site_code, old.lot_code, old.material_code, old.material_name, old.material_kind, old.supplier, old.supplier_lot,
      old.received_quantity, old.unit, old.retest_at, old.expires_at, old.received_by_person, old.received_by_account, old.received_at,
      old.correlation_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-120 lot %s: only its quantity and release route change after receipt', old.lot_code);
  end if;
  if new.quantity is distinct from old.quantity then
    if new.quantity > old.quantity then
      raise exception using errcode = 'P0001', message = format('EBMR-SITE-121 lot %s: the quantity of a lot never increases after receipt (INV-13)', old.lot_code);
    end if;
    if not exists (select 1 from site.lot_consumption c
                   where c.lot_id = old.id and c.xact_id = txid_current() and c.quantity_before = old.quantity and c.quantity_after = new.quantity) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-121 lot %s: the quantity changes only with its consumption record in the same transaction (INV-13, INV-14)', old.lot_code);
    end if;
  end if;
  if (new.release_route, new.released_at) is distinct from (old.release_route, old.released_at) then
    if old.release_route is not null or new.release_route is null
       or not exists (select 1 from site.lot_status_command c
                      where c.lot_id = old.id and c.xact_id = txid_current() and c.event = 'RELEASE' and c.release_route = new.release_route) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-122 lot %s: the release route is recorded once, by the RELEASE of this transaction', old.lot_code);
    end if;
  end if;
  return new;
end
$$;
create trigger a1_update_guard before update or delete on site.material_lot
  for each row execute function site.material_lot_update_guard();
create trigger aa_no_truncate before truncate on site.material_lot
  for each statement execute function platform.reject_change();

-- A command row is stamped with the person, account and transaction of the command; nothing else may be given.
create function site.lot_status_command_stamp() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v jsonb := site.require_actor();
begin
  new.person_id := (v ->> 'person_id')::uuid;
  new.account_id := (v ->> 'account_id')::uuid;
  new.reason_code := nullif(btrim(coalesce(v ->> 'reason_code', '')), '');
  new.reason_text := nullif(btrim(coalesce(v ->> 'reason_text', '')), '');
  new.xact_id := txid_current();
  return new;
end
$$;
create trigger a1_stamp before insert on site.lot_status_command
  for each row execute function site.lot_status_command_stamp();

create function site.lot_consumption_stamp() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, kernel, pg_temp as $$
declare
  v jsonb := site.require_actor();
begin
  new.consumed_by_person := (v ->> 'person_id')::uuid;
  new.consumed_by_account := (v ->> 'account_id')::uuid;
  new.xact_id := txid_current();
  return new;
end
$$;
create trigger a1_stamp before insert on site.lot_consumption
  for each row execute function site.lot_consumption_stamp();

-- A reservation's terms never change; it can only be revoked, once.
create function site.lot_reservation_update_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-140 reservations are never deleted; revoke them';
  end if;
  if (new.id, new.lot_id, new.batch_id, new.batch_number, new.edition, new.quantity, new.unit, new.expires_at, new.lot_state_version,
      new.reserved_by_person, new.reserved_by_account, new.reserved_at)
     is distinct from
     (old.id, old.lot_id, old.batch_id, old.batch_number, old.edition, old.quantity, old.unit, old.expires_at, old.lot_state_version,
      old.reserved_by_person, old.reserved_by_account, old.reserved_at)
     or old.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-140 a reservation''s terms never change; it can only be revoked, once';
  end if;
  return new;
end
$$;
create trigger a1_update_guard before update or delete on site.lot_reservation
  for each row execute function site.lot_reservation_update_guard();
create trigger aa_no_truncate before truncate on site.lot_reservation
  for each statement execute function platform.reject_change();

-- A vendor-history route's content never changes; it is enabled once (signed) and disabled once.
create function site.vendor_route_update_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-130 vendor-history routes are never deleted; disable them';
  end if;
  if (new.id, new.site_code, new.material_code, new.material_kind, new.justification, new.statistical_reference, new.proposed_by_person,
      new.proposed_by_account, new.proposed_at)
     is distinct from
     (old.id, old.site_code, old.material_code, old.material_kind, old.justification, old.statistical_reference, old.proposed_by_person,
      old.proposed_by_account, old.proposed_at)
     or (old.enabled_at is not null and (new.signature_id, new.enabled_at, new.enabled_by_person) is distinct from (old.signature_id, old.enabled_at, old.enabled_by_person))
     or old.disabled_at is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-130 a vendor-history route''s justification never changes; it is enabled once and disabled once';
  end if;
  return new;
end
$$;
create trigger a1_update_guard before update or delete on site.vendor_route
  for each row execute function site.vendor_route_update_guard();
create trigger aa_no_truncate before truncate on site.vendor_route
  for each statement execute function platform.reject_change();

select platform.enforce_db_time('site.material_lot', array['received_at']);
select platform.enforce_db_time('site.lot_status_command', array['recorded_at']);
select platform.enforce_db_time('site.lot_identity_result', array['recorded_at']);
select platform.enforce_db_time('site.lot_state_entry', array['recorded_at']);
select platform.enforce_db_time('site.vendor_route', array['proposed_at']);
select platform.enforce_db_time('site.lot_destruction', array['recorded_at']);
select platform.enforce_db_time('site.lot_reservation', array['reserved_at']);
select platform.enforce_db_time('site.lot_consumption', array['consumed_at']);

select kernel.register_audited_table('site.material_lot', 'material_lot', 'id', false);
select kernel.register_audited_table('site.lot_status_command', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.lot_identity_result', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.lot_state_entry', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.lot_destruction', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.lot_reservation', 'material_lot', 'lot_id', false);
select kernel.register_audited_table('site.lot_consumption', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.vendor_route', 'vendor_route', 'id', false);

-- ---------------------------------------------------------------------------------------------
-- Reading the lot
-- ---------------------------------------------------------------------------------------------

create function site.lot_state(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
  select s.state from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = p_lot
$$;

-- What remains of a reservation: reserved minus consumed against it.
create function site.reservation_remaining(p_reservation uuid) returns numeric
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select r.quantity - coalesce((select sum(c.quantity) from site.lot_consumption c where c.reservation_id = r.id), 0)
  from site.lot_reservation r where r.id = p_reservation
$$;

-- A reservation is open while not revoked, not expired at database time and not used up. (Stable: it writes
-- nothing; the clock is read per call, and every guarded command re-checks expiry itself.)
create function site.reservation_is_open(r site.lot_reservation) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select r.revoked_at is null and clock_timestamp() < r.expires_at and site.reservation_remaining(r.id) > 0
$$;

-- The lot's quantity not covered by open reservations.
create function site.lot_available(p_lot uuid) returns numeric
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select l.quantity - coalesce((select sum(site.reservation_remaining(r.id)) from site.lot_reservation r
                                where r.lot_id = l.id and site.reservation_is_open(r)), 0)
  from site.material_lot l where l.id = p_lot
$$;

-- Whether QA's vendor-history route is enabled (signed, not disabled) for the material at the site now.
create function site.vendor_route_enabled(p_site text, p_material text) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (select 1 from site.vendor_route v
                 where v.site_code = p_site and v.material_code = p_material and v.enabled_at is not null and v.disabled_at is null)
$$;

-- NULL when the lot is within its retest and expiry instants at database time, else why not (PR-18).
create function site.lot_dates_problem(l site.material_lot) returns text
language sql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
    when clock_timestamp() >= l.expires_at
      then format('lot %s expired at %s (PR-18)', l.lot_code, site.utc_text(l.expires_at))
    when l.retest_at is not null and clock_timestamp() >= l.retest_at
      then format('lot %s was due for retest at %s and must be retested before use (PR-18)', l.lot_code, site.utc_text(l.retest_at))
  end
$$;

-- The identity-test rule of the consuming batch (IN-24 (c), D-S1-2). NULL when the lot satisfies it, else why
-- not. Every lot needs a passing identity result (and none failing), unless the batch's markets are India only
-- and the lot was released on the vendor-history route that QA still has enabled for its material. Intermediates
-- come from the site's own executed batches and are released by QA for further processing; the rule does not
-- apply to them. The basis used is returned through p_basis.
create function site.identity_rule_problem(l site.material_lot, p_markets text[], out p_problem text, out p_basis text)
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  if l.material_kind = 'INTERMEDIATE' then
    p_basis := 'INTERMEDIATE';
    return;
  end if;
  if exists (select 1 from site.lot_identity_result r where r.lot_id = l.id and r.result = 'FAIL') then
    p_problem := format('a failing identity result is recorded for lot %s (IN-24 (c))', l.lot_code);
    return;
  end if;
  if exists (select 1 from site.lot_identity_result r where r.lot_id = l.id and r.result = 'PASS') then
    p_basis := 'IDENTITY_RESULT';
    return;
  end if;
  if l.release_route = 'VENDOR_HISTORY' and cardinality(p_markets) >= 1 and p_markets <@ array['IN']::text[] then
    if site.vendor_route_enabled(l.site_code, l.material_code) then
      p_basis := 'VENDOR_HISTORY_INDIA_ONLY';
      return;
    end if;
    p_problem := format('lot %s was released on the vendor-history route, which QA no longer has enabled for material %s, and has no identity result (IN-24 (c))',
                        l.lot_code, l.material_code);
    return;
  end if;
  p_problem := format('lot %s has no identity result: a batch for markets {%s} needs an identity test of every lot%s (IN-24 (c); D-S1-2)',
                      l.lot_code, array_to_string(p_markets, ', '),
                      case when l.release_route = 'VENDOR_HISTORY' then '; the vendor-history route serves India-only batches' else '' end);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed content (content-provider contract: esig 0200)
-- ---------------------------------------------------------------------------------------------

-- A lot's signatures cover its receipt data, its identity results, its destruction record and the states it entered.
-- Those three are registered signed tables: a new row supersedes earlier signatures (INV-09).
create function site.material_lot_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  l site.material_lot;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into l from site.material_lot where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from site.lot_identity_result r where r.lot_id = l.id)
                         + (select count(*) from site.lot_destruction d where d.lot_id = l.id)
                         + (select count(*) from site.lot_state_entry e where e.lot_id = l.id),
    'content', jsonb_build_object(
      'lot_code', l.lot_code, 'site_code', l.site_code, 'material_code', l.material_code, 'material_name', l.material_name,
      'material_kind', l.material_kind, 'supplier', l.supplier, 'supplier_lot', l.supplier_lot,
      'received_quantity', l.received_quantity::text, 'unit', l.unit, 'retest_at', site.utc_text(l.retest_at),
      'expires_at', site.utc_text(l.expires_at), 'received_by', l.received_by_person,
      'identity_results', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'result', r.result, 'method_reference', r.method_reference,
                                                                        'test_reference', r.test_reference, 'recorded_by', r.recorded_by_person,
                                                                        'recorded_at', site.utc_text(r.recorded_at))
                                                     order by r.recorded_at, r.id), '[]'::jsonb)
                           from site.lot_identity_result r where r.lot_id = l.id),
      'destruction', (select jsonb_build_object('id', d.id, 'method', d.method, 'reason', d.reason, 'quantity', d.quantity::text, 'unit', d.unit,
                                                'performed_by', d.performed_by_person, 'recorded_at', site.utc_text(d.recorded_at))
                      from site.lot_destruction d where d.lot_id = l.id),
      'state_entries', (select coalesce(jsonb_agg(jsonb_build_object('state', e.state, 'state_version', e.state_version::text)
                                                  order by e.state_version), '[]'::jsonb)
                        from site.lot_state_entry e where e.lot_id = l.id)),
    'state', site.lot_state(l.id),
    'scope', jsonb_build_object('site', l.site_code),
    'entered_by', (select to_jsonb(array_agg(distinct p)) from (
                     select l.received_by_person as p
                     union all select r.recorded_by_person from site.lot_identity_result r where r.lot_id = l.id
                     union all select d.performed_by_person from site.lot_destruction d where d.lot_id = l.id) x));
end
$$;

select esig.register_content_provider('material_lot', 'site.material_lot_content(text)',
  'Material lot: receipt data (material, kind, quantity received, unit, retest and expiry), identity results and destruction record');
select esig.register_signed_table('site.lot_identity_result', 'material_lot', 'lot_id');
select esig.register_signed_table('site.lot_destruction', 'material_lot', 'lot_id');
select esig.register_signed_table('site.lot_state_entry', 'material_lot', 'lot_id');

-- A vendor-history route's signature covers the material and QA's stored statistical justification.
create function site.vendor_route_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v site.vendor_route;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into v from site.vendor_route where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('site_code', v.site_code, 'material_code', v.material_code, 'material_kind', v.material_kind,
                                  'justification', v.justification, 'statistical_reference', v.statistical_reference,
                                  'proposed_by', v.proposed_by_person, 'proposed_at', site.utc_text(v.proposed_at)),
    'state', case when v.disabled_at is not null then 'DISABLED' when v.enabled_at is not null then 'ENABLED' else 'PROPOSED' end,
    'scope', jsonb_build_object('site', v.site_code));
end
$$;

select esig.register_content_provider('vendor_route', 'site.vendor_route_content(text)',
  'Vendor-history release route of one excipient: material and QA''s statistical justification');

-- ---------------------------------------------------------------------------------------------
-- Guards of the material_lot machine (registered with platform.register_guard; they never write)
-- ---------------------------------------------------------------------------------------------

create function site.guard_command_recorded(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when not exists (select 1 from site.lot_status_command c
                               where c.lot_id = p_id and c.xact_id = txid_current()
                                 and c.event = p_transition ->> 'event' and c.from_state = p_transition ->> 'from')
    then 'a lot''s status changes only through the site lot commands, which record the change and revoke reservations; a direct transition is refused (INV-13)' end
$$;

create function site.guard_not_finished(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when l.id is null then 'the lot does not exist'
              when l.material_kind = 'FINISHED'
                then format('lot %s is finished product: it leaves quarantine only through the batch release model (outline 5.2.6), not as a material lot', l.lot_code)
         end
  from (select 1) d left join site.material_lot l on l.id = p_id
$$;

create function site.guard_not_intermediate(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when l.id is null then 'the lot does not exist'
              when l.material_kind = 'INTERMEDIATE'
                then format('lot %s is an intermediate: QA releases it for further processing (RELEASE_FOR_FURTHER_PROCESSING)', l.lot_code)
         end
  from (select 1) d left join site.material_lot l on l.id = p_id
$$;

create function site.guard_intermediate_only(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when l.id is null then 'the lot does not exist'
              when l.material_kind <> 'INTERMEDIATE'
                then format('lot %s is %s, not an intermediate: only intermediates are released for further processing', l.lot_code, l.material_kind)
         end
  from (select 1) d left join site.material_lot l on l.id = p_id
$$;

create function site.guard_within_dates(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when l.id is null then 'the lot does not exist' else site.lot_dates_problem(l) end
  from (select 1) d left join site.material_lot l on l.id = p_id
$$;

-- The route recorded by this RELEASE is satisfied: IDENTITY_TESTED needs a passing identity result (and none
-- failing); VENDOR_HISTORY needs an excipient whose material QA has enabled the route for, signed, with no failing
-- identity result.
create function site.guard_release_route_satisfied(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l       site.material_lot;
  v_route text;
begin
  select * into l from site.material_lot where id = p_id;
  if not found then
    return 'the lot does not exist';
  end if;
  select c.release_route into v_route from site.lot_status_command c
   where c.lot_id = p_id and c.xact_id = txid_current() and c.event = 'RELEASE' order by c.recorded_at desc limit 1;
  if v_route is null then
    return 'a release records its route: IDENTITY_TESTED or VENDOR_HISTORY (IN-24 (c))';
  end if;
  if exists (select 1 from site.lot_identity_result r where r.lot_id = p_id and r.result = 'FAIL') then
    return format('a failing identity result is recorded for lot %s; it cannot be released (IN-24 (c))', l.lot_code);
  end if;
  if v_route = 'IDENTITY_TESTED' then
    if not exists (select 1 from site.lot_identity_result r where r.lot_id = p_id and r.result = 'PASS') then
      return format('lot %s has no passing identity result: the identity-tested route needs one (IN-24 (c))', l.lot_code);
    end if;
    return null;
  end if;
  if l.material_kind <> 'EXCIPIENT' then
    return format('lot %s is %s: the vendor-history route is only for excipients (IN-24 (c))', l.lot_code, l.material_kind);
  end if;
  if not site.vendor_route_enabled(l.site_code, l.material_code) then
    return format('QA has not enabled the vendor-history route for material %s at site %s with a signed statistical justification (IN-24 (c))',
                  l.material_code, l.site_code);
  end if;
  return null;
end
$$;

-- The person who fires the transition is the one who signed it (the release decision and its route are one act).
create function site.guard_signer_is_actor(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, esig, pg_temp as $$
  select case when s.id is null then 'the transition carries no signature'
              when s.signer_person::text is distinct from p_actor ->> 'person_id'
                then 'the release is recorded by the person who signed it: the signer and the person recording the route differ'
         end
  from (select 1) d left join esig.signature s on s.id::text = p_payload ->> 'signature_id'
$$;

create function site.guard_quantity_zero(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when l.id is null then 'the lot does not exist'
              when l.quantity <> 0 then format('lot %s still holds %s %s; it is CONSUMED only at zero', l.lot_code, l.quantity, l.unit)
         end
  from (select 1) d left join site.material_lot l on l.id = p_id
$$;

-- DESTROYED only with a destruction record and a witness signature by another person than its performer.
create function site.guard_destruction_witnessed(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql stable security definer set search_path = pg_catalog, site, esig, pg_temp as $$
  select case when d.id is null then 'no destruction record exists for the lot: record the destruction first'
              when s.id is null then 'the destruction carries no witness signature'
              when s.signer_person = d.performed_by_person then 'the witness of a destruction is another person than its performer'
         end
  from (select 1) x
  left join site.lot_destruction d on d.lot_id = p_id
  left join esig.signature s on s.id::text = p_payload ->> 'signature_id'
$$;

select platform.register_guard('material_lot.command_recorded', 'site.guard_command_recorded(text, uuid, jsonb, jsonb, jsonb)',
  'The status change was recorded by a site lot command in this transaction (no direct transition; INV-13)');
select platform.register_guard('material_lot.not_finished', 'site.guard_not_finished(text, uuid, jsonb, jsonb, jsonb)',
  'A finished-product lot never leaves quarantine as a material lot (outline 5.2.6, 5.2.9)');
select platform.register_guard('material_lot.not_intermediate', 'site.guard_not_intermediate(text, uuid, jsonb, jsonb, jsonb)',
  'An intermediate is released for further processing by QA, not released as a starting material');
select platform.register_guard('material_lot.intermediate_only', 'site.guard_intermediate_only(text, uuid, jsonb, jsonb, jsonb)',
  'Only intermediates are released for further processing');
select platform.register_guard('material_lot.within_dates', 'site.guard_within_dates(text, uuid, jsonb, jsonb, jsonb)',
  'The lot is before its retest and expiry instants at database time (PR-18)');
select platform.register_guard('material_lot.release_route_satisfied', 'site.guard_release_route_satisfied(text, uuid, jsonb, jsonb, jsonb)',
  'The recorded release route is satisfied: identity result, or QA-enabled vendor history for an excipient (IN-24 (c))');
select platform.register_guard('material_lot.signer_is_actor', 'site.guard_signer_is_actor(text, uuid, jsonb, jsonb, jsonb)',
  'The release is recorded by the person who signed it');
select platform.register_guard('material_lot.quantity_zero', 'site.guard_quantity_zero(text, uuid, jsonb, jsonb, jsonb)',
  'The lot quantity is zero');
select platform.register_guard('material_lot.destruction_witnessed', 'site.guard_destruction_witnessed(text, uuid, jsonb, jsonb, jsonb)',
  'A destruction record exists and its witness signature is by another person than the performer');

-- ---------------------------------------------------------------------------------------------
-- Permissions and signature meanings (vendor minimum types; DI-17, DI-35)
-- ---------------------------------------------------------------------------------------------
-- MATERIAL_LOT_RELEASED excludes everyone who entered data in the lot (receipt, identity results): the receiver and
-- the analyst never release it. The QA decisions (REJECTED, STATUS_DECIDED) do not exclude performers: every status
-- change is written in the deciding person's command (site.lot_state_entry), so QA who put a lot on hold must be able
-- to release it from hold or reject it later. The destruction witness excludes every performer, including the
-- person who recorded the destruction.

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0710_material_lots)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'material lot release, QA status decisions and their signature meanings (IN-24, INV-13, DI-17, DI-35)'));

insert into iam.permission (code, domain, effect, description) values
  ('MATERIAL.RELEASE', 'GMP', 'SIGN', 'Release or reject a quarantined material lot for use, with its release route (QC or QA)'),
  ('MATERIAL.QA_DISPOSITION', 'GMP', 'SIGN',
   'QA decisions on material lots: release of intermediates for further processing, hold, return, recall, rejection, and the vendor-history route of an excipient');

insert into iam.role_permission (role_code, permission_code) values
  ('HEAD_OF_QC', 'MATERIAL.RELEASE'),
  ('QA_REVIEWER', 'MATERIAL.RELEASE'),
  ('QA_REVIEWER', 'MATERIAL.QA_DISPOSITION'),
  ('AUTHORISED_PERSON', 'MATERIAL.QA_DISPOSITION');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('MATERIAL_LOT_RELEASED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'APPROVER', 'Material lot released',
   'I release this material lot for use: its tests and certificate were reviewed, and the release route I record applies.',
   array['MATERIAL.RELEASE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.9 (QC/QA signature); IN-24 (a)(c); US 211.84; EU Ch.5'),
  ('MATERIAL_LOT_REJECTED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'APPROVER', 'Material lot rejected',
   'I reject this material lot; it must not be used.',
   array['MATERIAL.RELEASE', 'MATERIAL.QA_DISPOSITION'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.9; IN-24 (a); US 211.84(e)'),
  ('MATERIAL_LOT_STATUS_DECIDED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'APPROVER', 'Material lot status decided by QA',
   'Quality-unit decision on the usage status of this material lot, with the reason recorded.',
   array['MATERIAL.QA_DISPOSITION'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.9 (QA hold, return, recall, release for further processing)'),
  ('MATERIAL_DESTRUCTION_WITNESSED', 1, 'VENDOR', true, 'ACTIVE', 'VERIFICATION', 'VERIFIER', 'Destruction witnessed',
   'As second person, I watched this material being destroyed as recorded.',
   array['STEP.WITNESS'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.9 (DESTROYED only with a witnessed record)'),
  ('VENDOR_ROUTE_ENABLED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'APPROVER', 'Vendor-history release route enabled',
   'Quality-unit decision: lots of this excipient may be released on supplier history, on the statistical justification recorded.',
   array['MATERIAL.QA_DISPOSITION'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'IN-24 (c); outline 5.2.9 (India Revised Schedule M vendor-history route)');

select kernel.set_actor_context(null);

reset role;
