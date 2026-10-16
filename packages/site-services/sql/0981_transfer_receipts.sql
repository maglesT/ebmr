-- Site services: the inbound lot-transfer package, its QUARANTINE lot and local QA's acceptance (Phase 6 slice 6i;
-- outline L-41; controls DI-31, DI-39; defaults D-P6i-0-2 to -6 in docs/build-plan/phase-6/slice-6i-0-interfaces.md;
-- kernel 1220, site services 0980).
--
-- Handbook: modules/site-services.md
--
--   site.import_transfer_package(payload, seal) jsonb   MATERIAL.HANDLE at the actor's site, never an administrator. The
--       payload is the text exactly as received and the seal its Ed25519 seal. Checked here, in order: JSON of format
--       ebmr.lot-transfer.v1 (MALFORMED), the sender a trusted peer (UNKNOWN_PEER), the seal under the sender's key
--       (TAMPERED), the destination this installation at the actor's site (WRONG_DESTINATION), not received before
--       (DUPLICATE), then the content (an intermediate lot with a decimal quantity, its dates and a usable status at the
--       origin; MALFORMED). A refusal creates nothing but a site.transfer_refusal row and an installation alarm, in the
--       same transaction, and is answered {outcome: REFUSED, reason, refusalId, alarmId} (DI-31: never silent). A package
--       taken in becomes one local lot of kind INTERMEDIATE in QUARANTINE (the origin's lot number when free at the site,
--       else with /R<n>), the receipt with the carried content and its hold limit, and the rule resolutions re-resolved
--       here (D-P6i-0-6): {outcome: RECEIVED, receiptId, lotId, lotCode}.
--   site.decide_transfer_receipt(receipt, decision, signature, reason) uuid   MATERIAL.QA_DISPOSITION at the lot's site,
--       never an administrator: ACCEPTED (TRANSFER_RECEIPT_ACCEPTED) or REFUSED (TRANSFER_RECEIPT_REFUSED, with a reason)
--       on transfer_receipt <id>, state RECEIVED; once; the signer is the actor. ACCEPTED only while the lot is in
--       QUARANTINE, before its expiry and retest, before the hold limit, and when the origin's status was usable.
--   Guards for every writer: a received lot is released (the lot_status_command row of RELEASE or
--       RELEASE_FOR_FURTHER_PROCESSING) and reserved only once accepted and before the hold limit (EBMR-XFR-040, -041):
--       the hold time carried over keeps running (D-P6i-0-5).
--   site.transfer_hold_remaining(receipt) interval   the hold time left now (zero once passed); never stored.
--
-- Messages: EBMR-XFR-020 to EBMR-XFR-041.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0981_transfer_receipts)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'local QA''s acceptance of a received lot-transfer package (L-41, DI-39)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('TRANSFER_RECEIPT_ACCEPTED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'APPROVER', 'Transferred lot accepted',
   'Quality-unit decision at the receiving site: the lot received from the shipping installation, with its status, test results, hold limit and rule resolutions as stated, is accepted for local release.',
   array['MATERIAL.QA_DISPOSITION'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'L-41; DI-39; D-P6i-0-4'),
  ('TRANSFER_RECEIPT_REFUSED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'APPROVER', 'Transferred lot refused',
   'Quality-unit decision at the receiving site: the lot received from the shipping installation is not accepted; it stays in quarantine for rejection.',
   array['MATERIAL.QA_DISPOSITION'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'L-41; DI-39; D-P6i-0-4');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables (insert-only, audited)
-- ---------------------------------------------------------------------------------------------

create table site.transfer_receipt (
  id                   uuid primary key default gen_random_uuid(),
  package_id           uuid not null unique,
  package_no           text not null,
  origin_installation  text not null,
  origin_lot_id        uuid not null,
  origin_lot_code      text not null,
  origin_state         text not null,
  payload              text not null,
  payload_sha256       text not null unique check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  seal                 text not null check (seal ~ '^[A-Za-z0-9+/]{85}[AQgw]==$'),
  key_fingerprint      text not null check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  lot_id               uuid not null unique references site.material_lot (id),
  hold_until           timestamptz not null,
  markets              text[] not null,
  received_by_person   uuid not null,
  received_by_account  uuid not null,
  correlation_id       uuid not null,
  received_at          timestamptz not null default clock_timestamp(),
  check (payload_sha256 = encode(sha256(convert_to(payload, 'UTF8')), 'hex'))
);
revoke all on site.transfer_receipt from public;

create table site.transfer_refusal (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null check (kind in ('MALFORMED', 'UNKNOWN_PEER', 'TAMPERED', 'WRONG_DESTINATION', 'DUPLICATE')),
  reason               text not null check (btrim(reason) <> ''),
  claimed_origin       text,
  claimed_package_id   uuid,
  payload_sha256       text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_excerpt      text not null,
  alarm_id             uuid not null references platform.installation_alarm (id),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);
revoke all on site.transfer_refusal from public;

-- Per carried key: the origin's value, this site's own resolution and the one that applies here (D-P6i-0-6).
create table site.transfer_rule_resolution (
  receipt_id       uuid not null references site.transfer_receipt (id),
  key              text not null,
  table_code       text not null,
  method           text not null,
  carried_value    jsonb not null,
  carried_version  integer,
  local_value      jsonb,
  local_version    integer,
  resolved_value   jsonb,
  winner           text not null check (winner in ('EQUAL', 'CARRIED', 'LOCAL', 'MERGED', 'CARRIED_ONLY', 'NOT_COMPARABLE')),
  primary key (receipt_id, key),
  check ((winner = 'NOT_COMPARABLE') = (resolved_value is null))
);
revoke all on site.transfer_rule_resolution from public;

create table site.transfer_acceptance (
  receipt_id           uuid primary key references site.transfer_receipt (id),
  decision             text not null check (decision in ('ACCEPTED', 'REFUSED')),
  signature_id         uuid not null unique,
  reason               text check (reason is null or (btrim(reason) <> '' and length(reason) <= 1000)),
  decided_by_person    uuid not null,
  decided_by_account   uuid not null,
  decided_at           timestamptz not null default clock_timestamp(),
  check (decision = 'ACCEPTED' or reason is not null)
);
revoke all on site.transfer_acceptance from public;

grant select on site.transfer_receipt, site.transfer_refusal, site.transfer_rule_resolution, site.transfer_acceptance to ebmr_app;
select platform.enforce_db_time('site.transfer_receipt', array['received_at']);
select platform.enforce_db_time('site.transfer_refusal', array['recorded_at']);
select platform.enforce_db_time('site.transfer_acceptance', array['decided_at']);
select kernel.register_audited_table('site.transfer_receipt', 'transfer_receipt', 'id', true);
select kernel.register_audited_table('site.transfer_refusal', 'transfer_refusal', 'id', true);
select kernel.register_audited_table('site.transfer_rule_resolution', 'transfer_receipt', 'receipt_id', true);
select kernel.register_audited_table('site.transfer_acceptance', 'transfer_receipt', 'receipt_id', true);

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

create function site.us_instant(p text) returns timestamptz
language sql immutable set search_path = pg_catalog, pg_temp as $$
  -- Exact to the microsecond (an interval holds whole microseconds; to_timestamp would go through a double).
  select case when p ~ '^(0|[1-9][0-9]{0,15})$' then 'epoch'::timestamptz + (p || ' microseconds')::interval end
$$;

create function site.transfer_receipt_state(p_receipt uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce((select a.decision from site.transfer_acceptance a where a.receipt_id = p_receipt),
                  case when exists (select 1 from site.transfer_receipt r where r.id = p_receipt) then 'RECEIVED' end)
$$;

create function site.transfer_hold_remaining(p_receipt uuid) returns interval
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select greatest(r.hold_until - clock_timestamp(), interval '0') from site.transfer_receipt r where r.id = p_receipt
$$;

create function site.transfer_receipt_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  r site.transfer_receipt;
  l site.material_lot;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into r from site.transfer_receipt where id = p_id::uuid;
  if r.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into l from site.material_lot where id = r.lot_id;
  return jsonb_build_object(
    'exists', true, 'content_version', 1, 'state', site.transfer_receipt_state(r.id),
    'content', jsonb_build_object('package_no', r.package_no, 'origin_installation', r.origin_installation, 'origin_lot_code', r.origin_lot_code,
                                  'origin_state', r.origin_state, 'payload_sha256', r.payload_sha256, 'lot_code', l.lot_code,
                                  'material_code', l.material_code, 'material_name', l.material_name, 'quantity', l.received_quantity::text, 'unit', l.unit,
                                  'expires_at', site.utc_text(l.expires_at), 'retest_at', site.utc_text(l.retest_at), 'hold_until', site.utc_text(r.hold_until),
                                  'markets', to_jsonb(r.markets),
                                  'rules', coalesce((select jsonb_agg(jsonb_build_object('key', x.key, 'winner', x.winner, 'resolved', x.resolved_value) order by x.key collate "C")
                                                       from site.transfer_rule_resolution x where x.receipt_id = r.id), '[]')),
    'scope', jsonb_build_object('site', l.site_code));
end
$$;

select esig.register_content_provider('transfer_receipt', 'site.transfer_receipt_content(text)',
  'A lot received from another site installation in a sealed transfer package, for local QA''s acceptance (L-41, DI-39)');

-- ---------------------------------------------------------------------------------------------
-- Rule re-resolution at the receiving site (D-P6i-0-6)
-- ---------------------------------------------------------------------------------------------

create function site.resolve_carried_rules(p_receipt uuid, p_rules jsonb, p_markets text[]) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, market, pg_temp as $$
declare
  c        jsonb;
  v_ver    uuid;
  k        market.rule_key;
  v_local  jsonb;
  v_lver   integer;
  v_lval   jsonb;
  v_res    jsonb;
  v_win    text;
  v_ord    jsonb;
  v_a      boolean;
  v_b      boolean;
begin
  for c in select e from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) e loop
    continue when jsonb_typeof(c) <> 'object' or coalesce(c ->> 'key', '') = '' or c -> 'value' is null;
    v_ver := market.current_version(c ->> 'tableCode');
    k := null; v_local := null; v_lval := null; v_lver := null;
    if v_ver is not null then
      select * into k from market.rule_key where version_id = v_ver and key = c ->> 'key';
    end if;
    if k.key is not null then
      begin
        v_local := market.resolve(v_ver, k.key, p_markets, '{}'::jsonb, (clock_timestamp() at time zone 'UTC')::date);
      exception when others then
        v_local := null;
      end;
      if v_local is not null and coalesce((v_local ->> 'applicable')::boolean, false) then
        v_lval := v_local -> 'value';
        v_lver := (v_local ->> 'tableVersion')::integer;
      end if;
    end if;
    v_ord := coalesce(k.ordered_values, c -> 'orderedValues');
    if v_lval is null then
      v_res := c -> 'value'; v_win := 'CARRIED_ONLY';
    elsif v_lval = c -> 'value' then
      v_res := v_lval; v_win := 'EQUAL';
    elsif coalesce(k.method, c ->> 'method') in ('SET_UNION', 'ALL_APPLY') then
      v_res := market.set_merge(coalesce(k.method, c ->> 'method'), c -> 'value', v_lval); v_win := 'MERGED';
    else
      begin
        v_a := market.at_least_as_strict(coalesce(k.method, c ->> 'method'), v_ord, c -> 'value', v_lval);
        v_b := market.at_least_as_strict(coalesce(k.method, c ->> 'method'), v_ord, v_lval, c -> 'value');
      exception when others then
        v_a := null; v_b := null;
      end;
      if v_a is null or v_b is null then
        v_res := null; v_win := 'NOT_COMPARABLE';
      elsif v_a and v_b then
        v_res := v_lval; v_win := 'EQUAL';
      elsif v_a then
        v_res := c -> 'value'; v_win := 'CARRIED';
      else
        v_res := v_lval; v_win := 'LOCAL';
      end if;
    end if;
    insert into site.transfer_rule_resolution (receipt_id, key, table_code, method, carried_value, carried_version, local_value, local_version, resolved_value, winner)
    values (p_receipt, c ->> 'key', coalesce(c ->> 'tableCode', ''), coalesce(k.method, c ->> 'method', 'NOT_COMPARABLE'), c -> 'value',
            case when (c ->> 'tableVersion') ~ '^[0-9]{1,9}$' then (c ->> 'tableVersion')::integer end, v_lval, v_lver, v_res, v_win)
    on conflict (receipt_id, key) do nothing;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Import
-- ---------------------------------------------------------------------------------------------

create function site.refuse_transfer_package(p_kind text, p_reason text, p_origin text, p_package text, p_payload text, p_ctx jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_alarm uuid;
  v_id    uuid;
  v_pkg   uuid := case when p_package ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_package::uuid end;
begin
  v_alarm := platform.raise_installation_alarm(p_kind, case when p_kind in ('TAMPERED', 'WRONG_DESTINATION') then 'MAJOR' else 'MINOR' end,
                                               'TRANSFER_IMPORT', p_origin, jsonb_build_object('reason', p_reason, 'packageId', v_pkg));
  insert into site.transfer_refusal (kind, reason, claimed_origin, claimed_package_id, payload_sha256, payload_excerpt, alarm_id, recorded_by_person, recorded_by_account)
  values (p_kind, p_reason, left(p_origin, 64), v_pkg, encode(sha256(convert_to(coalesce(p_payload, ''), 'UTF8')), 'hex'), left(coalesce(p_payload, ''), 4000),
          v_alarm, (p_ctx ->> 'person_id')::uuid, (p_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('outcome', 'REFUSED', 'kind', p_kind, 'reason', p_reason, 'refusalId', v_id, 'alarmId', v_alarm);
end
$$;

create function site.import_transfer_package(p_payload text, p_seal text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx     jsonb := site.require_actor();
  v_site    text;
  me        platform.installation_identity := platform.current_installation();
  m         jsonb;
  v_origin  text;
  v_pkg     text;
  v_lot     jsonb;
  v_id      uuid := gen_random_uuid();
  v_rid     uuid := gen_random_uuid();
  v_code    text;
  v_n       integer := 1;
  v_hold    timestamptz;
  v_exp     timestamptz;
  v_retest  timestamptz;
  v_markets text[];
  dec       constant text := '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$';
begin
  perform iam.assert_not_administrator();
  v_site := site.actor_site();
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', v_site));
  begin
    m := p_payload::jsonb;
  exception when others then
    m := null;
  end;
  if jsonb_typeof(m) = 'object' then
    v_origin := case when jsonb_typeof(m -> 'origin') = 'object' then m -> 'origin' ->> 'installation' end;
    v_pkg := m ->> 'packageId';
  end if;
  if jsonb_typeof(m) is distinct from 'object' or m ->> 'format' is distinct from 'ebmr.lot-transfer.v1'
     or coalesce(v_origin, '') !~ '^[A-Z0-9][A-Z0-9-]{1,31}$' or coalesce(v_pkg, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return site.refuse_transfer_package('MALFORMED', 'EBMR-XFR-020 the file is not a lot-transfer package (format ebmr.lot-transfer.v1 with its origin and package id); nothing was taken in (DI-31)',
                                        v_origin, v_pkg, p_payload, v_ctx);
  end if;
  if (platform.trusted_peer(v_origin)).id is null then
    return site.refuse_transfer_package('UNKNOWN_PEER',
      format('EBMR-XFR-021 the package comes from installation %s, which is not a trusted peer of this site; nothing was taken in (DI-31)', v_origin),
      v_origin, v_pkg, p_payload, v_ctx);
  end if;
  if not platform.peer_seal_valid(v_origin, 'transfer-package', p_payload, p_seal) then
    return site.refuse_transfer_package('TAMPERED',
      format('EBMR-XFR-022 the seal does not verify under the key of installation %s: the package was changed or not sealed by it; nothing was taken in (DI-31)', v_origin),
      v_origin, v_pkg, p_payload, v_ctx);
  end if;
  if me.version is null or m -> 'destination' ->> 'installation' is distinct from me.installation_code
     or me.site_code is distinct from v_site or m -> 'destination' ->> 'site' is distinct from v_site then
    return site.refuse_transfer_package('WRONG_DESTINATION',
      format('EBMR-XFR-023 the package is addressed to installation %s at site %s, not to this installation %s at site %s; nothing was taken in (DI-31)',
             coalesce(m -> 'destination' ->> 'installation', 'none'), coalesce(m -> 'destination' ->> 'site', 'none'), coalesce(me.installation_code, 'without identity'), v_site),
      v_origin, v_pkg, p_payload, v_ctx);
  end if;
  if exists (select 1 from site.transfer_receipt r where r.package_id = v_pkg::uuid or r.payload_sha256 = encode(sha256(convert_to(p_payload, 'UTF8')), 'hex')) then
    return site.refuse_transfer_package('DUPLICATE',
      format('EBMR-XFR-024 package %s was taken in already; a package is received once (DI-31)', coalesce(m ->> 'packageNo', v_pkg)),
      v_origin, v_pkg, p_payload, v_ctx);
  end if;
  v_lot := m -> 'lot';
  if jsonb_typeof(v_lot) is distinct from 'object' or v_lot ->> 'materialKind' is distinct from 'INTERMEDIATE'
     or coalesce(v_lot ->> 'lotCode', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$' or coalesce(v_lot ->> 'materialCode', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'
     or btrim(coalesce(v_lot ->> 'materialName', '')) = '' or coalesce(v_lot ->> 'unit', '') !~ '^[!-~]{1,32}$'
     or coalesce(v_lot ->> 'quantity', '') !~ dec or (v_lot ->> 'quantity')::numeric <= 0
     or site.us_instant(v_lot ->> 'expiresAtUs') is null or (v_lot ->> 'retestAtUs' is not null and site.us_instant(v_lot ->> 'retestAtUs') is null)
     or coalesce(v_lot ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(m -> 'status') is distinct from 'object' or not ((m -> 'status' ->> 'state') = any (site.usable_lot_states()))
     or site.us_instant(m -> 'hold' ->> 'untilUs') is null or jsonb_typeof(m -> 'markets') is distinct from 'array'
     or coalesce(m ->> 'packageNo', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,47}$' then
    return site.refuse_transfer_package('MALFORMED',
      'EBMR-XFR-025 the package does not state an intermediate lot released at its origin with its number, material, quantity (decimal text), unit, expiry and hold limit; nothing was taken in (D-P6i-0-2)',
      v_origin, v_pkg, p_payload, v_ctx);
  end if;
  begin
    v_markets := market.checked_market_set(array(select jsonb_array_elements_text(m -> 'markets')));
  exception when others then
    return site.refuse_transfer_package('MALFORMED', 'EBMR-XFR-025 the package names a market this site does not know; nothing was taken in',
                                        v_origin, v_pkg, p_payload, v_ctx);
  end;
  v_exp := site.us_instant(v_lot ->> 'expiresAtUs');
  v_retest := site.us_instant(v_lot ->> 'retestAtUs');
  if v_retest is not null and v_retest > v_exp then
    v_retest := v_exp;
  end if;
  v_hold := least(site.us_instant(m -> 'hold' ->> 'untilUs'), v_exp, coalesce(v_retest, v_exp));
  -- The local lot number: the origin's when free at this site, else with /R<n>.
  v_code := v_lot ->> 'lotCode';
  while exists (select 1 from site.material_lot x where x.site_code = v_site and x.lot_code = v_code) loop
    v_n := v_n + 1;
    v_code := left(v_lot ->> 'lotCode', 36) || '/R' || v_n::text;
  end loop;
  insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, supplier, supplier_lot, received_quantity, unit,
                                 retest_at, expires_at, received_by_person, received_by_account, correlation_id)
  values (v_id, v_site, v_code, v_lot ->> 'materialCode', left(btrim(v_lot ->> 'materialName'), 200), 'INTERMEDIATE', v_origin, v_lot ->> 'lotCode',
          (v_lot ->> 'quantity')::numeric, v_lot ->> 'unit', v_retest, v_exp,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  perform platform.create_aggregate_state('material_lot', 'material_lot', v_id);
  insert into site.transfer_receipt (id, package_id, package_no, origin_installation, origin_lot_id, origin_lot_code, origin_state, payload, payload_sha256, seal,
                                     key_fingerprint, lot_id, hold_until, markets, received_by_person, received_by_account, correlation_id)
  values (v_rid, v_pkg::uuid, m ->> 'packageNo', v_origin, (v_lot ->> 'id')::uuid, v_lot ->> 'lotCode', m -> 'status' ->> 'state', p_payload,
          encode(sha256(convert_to(p_payload, 'UTF8')), 'hex'), p_seal, (platform.trusted_peer(v_origin)).key_fingerprint, v_id, v_hold, v_markets,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  perform site.resolve_carried_rules(v_rid, m -> 'ruleResolutions', v_markets);
  return jsonb_build_object('outcome', 'RECEIVED', 'receiptId', v_rid, 'lotId', v_id, 'lotCode', v_code);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Local QA's decision (D-P6i-0-4)
-- ---------------------------------------------------------------------------------------------

create function site.decide_transfer_receipt(p_receipt uuid, p_decision text, p_signature uuid, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  r        site.transfer_receipt;
  l        site.material_lot;
  v_prob   text;
  v_retest timestamptz;
begin
  perform iam.assert_not_administrator();
  select * into r from site.transfer_receipt where id = p_receipt;
  if r.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-XFR-030 there is no transfer receipt %s', coalesce(p_receipt::text, 'NULL'));
  end if;
  l := site.lock_lot(r.lot_id);
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', l.site_code));
  perform 1 from site.transfer_receipt where id = r.id for update;
  if exists (select 1 from site.transfer_acceptance a where a.receipt_id = r.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-XFR-031 the receipt of package %s is decided already', r.package_no);
  end if;
  if p_decision is null or p_decision not in ('ACCEPTED', 'REFUSED') then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-031 local QA ACCEPTS or REFUSES a received package';
  end if;
  if p_decision = 'REFUSED' and length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-031 a refusal states its reason (at least 10 characters)';
  end if;
  if p_decision = 'ACCEPTED' then
    if site.lot_state(l.id) <> 'QUARANTINE' then
      raise exception using errcode = 'P0001', message = format('EBMR-XFR-032 lot %s is %s; a received lot is accepted while in quarantine', l.lot_code, site.lot_state(l.id));
    end if;
    if r.hold_until <= clock_timestamp() then
      raise exception using errcode = 'P0001',
        message = format('EBMR-XFR-033 the hold limit of lot %s (%s, carried from installation %s) has passed; it cannot be accepted for use (D-P6i-0-5)',
                         l.lot_code, site.utc_text(r.hold_until), r.origin_installation);
    end if;
    v_retest := site.lot_retest_at(l.id);
    if l.expires_at <= clock_timestamp() or (v_retest is not null and v_retest <= clock_timestamp()) then
      raise exception using errcode = 'P0001', message = format('EBMR-XFR-033 lot %s is past its retest or expiry instant (PR-18)', l.lot_code);
    end if;
    if not (r.origin_state = any (site.usable_lot_states())) then
      raise exception using errcode = 'P0001', message = format('EBMR-XFR-034 the origin stated the lot %s; only a lot released at its origin is accepted (DI-39)', r.origin_state);
    end if;
  end if;
  perform esig.assert_signature(p_signature, case p_decision when 'ACCEPTED' then 'TRANSFER_RECEIPT_ACCEPTED' else 'TRANSFER_RECEIPT_REFUSED' end,
                                'transfer_receipt', r.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-035 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-036 the received lot is decided by the QA person who signed the decision';
  end if;
  insert into site.transfer_acceptance (receipt_id, decision, signature_id, reason, decided_by_person, decided_by_account)
  values (r.id, p_decision, p_signature, nullif(btrim(coalesce(p_reason, '')), ''), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  return r.id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards for every writer: a received lot is usable only once accepted and within its hold limit
-- ---------------------------------------------------------------------------------------------

create function site.transfer_use_problem(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
           when r.id is null then null
           when coalesce(site.transfer_receipt_state(r.id), 'RECEIVED') <> 'ACCEPTED' then
             format('EBMR-XFR-040 lot %s came from installation %s in package %s and is %s: it is used only after local QA accepted the receipt with a signature (DI-39, L-41)',
                    (select l.lot_code from site.material_lot l where l.id = p_lot), r.origin_installation, r.package_no,
                    case site.transfer_receipt_state(r.id) when 'REFUSED' then 'refused by local QA' else 'not yet accepted' end)
           when r.hold_until <= clock_timestamp() then
             format('EBMR-XFR-041 the hold limit of lot %s (%s, carried from installation %s) has passed; the hold time kept running since its origin (D-P6i-0-5)',
                    (select l.lot_code from site.material_lot l where l.id = p_lot), site.utc_text(r.hold_until), r.origin_installation)
         end
    from (select 1) one left join site.transfer_receipt r on r.lot_id = p_lot
$$;

create function site.transfer_release_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_prob text;
begin
  if new.event in ('RELEASE', 'RELEASE_FOR_FURTHER_PROCESSING', 'UNHOLD') then
    v_prob := site.transfer_use_problem(new.lot_id);
    if v_prob is not null then
      raise exception using errcode = 'P0001', message = v_prob;
    end if;
  end if;
  return new;
end
$$;
create trigger zz_transfer_accepted before insert on site.lot_status_command
  for each row execute function site.transfer_release_check();

create function site.transfer_reservation_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_prob text := site.transfer_use_problem(new.lot_id);
begin
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = v_prob;
  end if;
  return new;
end
$$;
create trigger zz_transfer_accepted before insert on site.lot_reservation
  for each row execute function site.transfer_reservation_check();

revoke all on function site.us_instant(text), site.transfer_receipt_state(uuid), site.transfer_hold_remaining(uuid), site.transfer_receipt_content(text),
  site.resolve_carried_rules(uuid, jsonb, text[]), site.refuse_transfer_package(text, text, text, text, text, jsonb), site.import_transfer_package(text, text),
  site.decide_transfer_receipt(uuid, text, uuid, text), site.transfer_use_problem(uuid), site.transfer_release_check(), site.transfer_reservation_check() from public;
grant execute on function site.us_instant(text), site.transfer_receipt_state(uuid), site.transfer_hold_remaining(uuid), site.import_transfer_package(text, text),
  site.decide_transfer_receipt(uuid, text, uuid, text), site.transfer_use_problem(uuid) to ebmr_app;

reset role;
