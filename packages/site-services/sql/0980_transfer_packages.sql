-- Site services: the outbound lot-transfer package (Phase 6 slice 6i; outline L-41; controls DI-31, DI-39, PR-57;
-- defaults D-P6i-0-2, -3, -5, -6 and -8 in docs/build-plan/phase-6/slice-6i-0-interfaces.md; kernel 1220).
--
-- Handbook: modules/site-services.md
--
--   site.transfer_package        insert-only, audited (aggregate material_lot of the shipped lot): one package of one lot
--                                for one trusted peer installation: the quantity, and the canonical payload the database
--                                assembled from its own records (never from the caller) with its SHA-256.
--   site.transfer_package_seal   insert-only, audited: the installation's Ed25519 seal of the payload, verified here under
--                                the installation's current key (platform.own_seal_valid, kernel 1220). The seal row is the
--                                genealogy edge TRANSFERRED (recipe-core 1090): only a sealed package left the site.
--   site.prepare_transfer_package(lot, p) jsonb   MATERIAL.HANDLE at the lot's site, never an administrator.
--                                p {destination, quantity (decimal text), markets? (IN always), holdUntil? (an earlier
--                                hold, UTC instant)}. The lot is INTERMEDIATE (D-P6i-0-2), in a usable status
--                                (RELEASED_FOR_FURTHER_PROCESSING or RELEASED), before its retest and expiry; the quantity
--                                is in the lot's unit and not above what is left after open reservations and earlier
--                                packages. The payload (format ebmr.lot-transfer.v1) carries: origin and destination,
--                                the lot, its status and its release decision, the CoA (every approved result not revised
--                                since; D-P6i-0-3), the hold limit as an instant (D-P6i-0-5), the market set and the rule
--                                resolutions (D-P6i-0-6), and the backward genealogy excerpt as of now with its node
--                                views. Returns {packageId, packageNo, payload}.
--   site.seal_transfer_package(package, seal) jsonb   the person who prepared it; once; the seal must verify.
--   site.lot_transferred_out(lot) numeric   the quantity of the lot in packages; site.lot_available (0710) is re-created
--                                to subtract it, so a reservation never takes material that left (INV-13).
--   site.transfer_rule_resolutions(markets) jsonb   the shipping side of D-P6i-0-6: every key of the current kernel and
--                                edition rule tables resolved for the market set without product predicates (a key that
--                                needs one is left out).
--
-- Messages: EBMR-XFR-010 to EBMR-XFR-019.

set local role ebmr_owner;

create table site.transfer_package (
  id                       uuid primary key,
  package_no               text not null unique check (package_no ~ '^[A-Z0-9][A-Z0-9/._-]{0,47}$'),
  lot_id                   uuid not null references site.material_lot (id),
  origin_installation      text not null,
  destination_installation text not null,
  quantity                 numeric not null check (quantity > 0),
  unit                     text not null,
  payload                  text not null,
  payload_sha256           text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  prepared_by_person       uuid not null,
  prepared_by_account      uuid not null,
  correlation_id           uuid not null,
  prepared_at              timestamptz not null default clock_timestamp(),
  check (payload_sha256 = encode(sha256(convert_to(payload, 'UTF8')), 'hex')),
  check (origin_installation <> destination_installation)
);
create index transfer_package_lot on site.transfer_package (lot_id);
revoke all on site.transfer_package from public;

create table site.transfer_package_seal (
  package_id        uuid primary key references site.transfer_package (id),
  seal              text not null check (seal ~ '^[A-Za-z0-9+/]{85}[AQgw]==$'),
  key_fingerprint   text not null check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  sealed_by_person  uuid not null,
  sealed_by_account uuid not null,
  sealed_at         timestamptz not null default clock_timestamp()
);
revoke all on site.transfer_package_seal from public;

grant select on site.transfer_package, site.transfer_package_seal to ebmr_app;
select platform.enforce_db_time('site.transfer_package', array['prepared_at']);
select platform.enforce_db_time('site.transfer_package_seal', array['sealed_at']);
-- Keyed by the shipped lot: the package belongs to the lot's history (material_lot <lot id>).
select kernel.register_audited_table('site.transfer_package', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('site.transfer_package_seal', 'transfer_package', 'package_id', true);

-- ---------------------------------------------------------------------------------------------
-- Quantities
-- ---------------------------------------------------------------------------------------------

create function site.lot_transferred_out(p_lot uuid) returns numeric
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce(sum(p.quantity), 0) from site.transfer_package p where p.lot_id = p_lot
$$;

-- 0710's definition minus the quantity in transfer packages (the material left the site).
create or replace function site.lot_available(p_lot uuid) returns numeric
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select site.lot_quantity(l.id) - site.lot_transferred_out(l.id)
         - coalesce((select sum(site.reservation_remaining(r.id)) from site.lot_reservation r
                      where r.lot_id = l.id and site.reservation_is_open(r)), 0)
  from site.material_lot l where l.id = p_lot
$$;

-- ---------------------------------------------------------------------------------------------
-- Rule resolutions that travel (D-P6i-0-6)
-- ---------------------------------------------------------------------------------------------

-- The rule tables of this installation: kernel and its edition's.
create function site.transfer_rule_tables() returns text[]
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select array['kernel', case (platform.current_installation()).edition when 'INJECTABLES' then 'sterile' else 'tablets' end]
$$;

create function site.transfer_rule_resolutions(p_markets text[]) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, market, pg_temp as $$
declare
  v_out  jsonb := '[]'::jsonb;
  v_ver  uuid;
  t      text;
  k      market.rule_key;
  r      jsonb;
begin
  foreach t in array site.transfer_rule_tables() loop
    v_ver := market.current_version(t);
    continue when v_ver is null;
    for k in select * from market.rule_key where version_id = v_ver order by key collate "C" loop
      begin
        r := market.resolve(v_ver, k.key, p_markets, '{}'::jsonb, (clock_timestamp() at time zone 'UTC')::date);
      exception when others then
        r := null;   -- needs a product predicate or a stated method: left out (D-P6i-0-6)
      end;
      continue when r is null or coalesce((r ->> 'applicable')::boolean, false) is not true;
      v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'key', k.key, 'tableCode', t, 'tableVersion', r -> 'tableVersion', 'method', k.method, 'valueType', k.value_type, 'unit', k.unit,
        'orderedValues', k.ordered_values, 'value', r -> 'value', 'governingMarkets', r -> 'governingMarkets', 'floorType', r -> 'floorType')));
    end loop;
  end loop;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The package
-- ---------------------------------------------------------------------------------------------

create function site.us_text(p timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p is null then null else floor(extract(epoch from p) * 1000000)::numeric::text end
$$;

create function site.prepare_transfer_package(p_lot uuid, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx      jsonb := site.require_actor();
  l          site.material_lot;
  me         platform.installation_identity := platform.current_installation();
  peer       platform.peer_installation;
  v_state    text;
  v_qty      numeric;
  v_avail    numeric;
  v_markets  text[];
  v_retest   timestamptz;
  v_hold     timestamptz;
  v_basis    text;
  v_stated   timestamptz;
  v_carried  timestamptz;
  v_id       uuid := gen_random_uuid();
  v_no       text;
  v_rel      site.lot_status_command;
  v_content  jsonb;
  v_rows     jsonb;
  v_nodes    jsonb;
  v_payload  text;
  dec        constant text := '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$';
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  if l.site_code is distinct from site.actor_site() then
    raise exception using errcode = 'P0001', message = format('EBMR-XFR-010 lot %s is packaged at its own site %s', l.lot_code, l.site_code);
  end if;
  if me.version is null or me.site_code is distinct from l.site_code then
    raise exception using errcode = 'P0001',
      message = 'EBMR-XFR-010 this installation has no identity for the lot''s site; set the installation identity and key first (L-41)';
  end if;
  if p is null or jsonb_typeof(p) <> 'object'
     or coalesce(p ->> 'destination', '') !~ '^[A-Z0-9][A-Z0-9-]{1,31}$'
     or jsonb_typeof(p -> 'quantity') is distinct from 'string' or (p ->> 'quantity') !~ dec or (p ->> 'quantity')::numeric <= 0
     or (p ? 'markets' and jsonb_typeof(p -> 'markets') is distinct from 'array')
     or (p ? 'holdUntil' and coalesce(p ->> 'holdUntil', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-XFR-011 a transfer package names the destination installation, the quantity (decimal text) and, optionally, the markets and an earlier hold limit (UTC instant)';
  end if;
  peer := platform.trusted_peer(p ->> 'destination');
  if peer.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-XFR-012 installation %s is not a trusted peer of this site; its key is registered and approved by QA first (DI-31)', p ->> 'destination');
  end if;
  if l.material_kind <> 'INTERMEDIATE' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-XFR-013 lot %s is %s; a transfer package carries an intermediate or bulk lot (D-P6i-0-2)', l.lot_code, l.material_kind);
  end if;
  v_state := site.lot_state(l.id);
  if not (v_state = any (site.usable_lot_states())) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-XFR-014 lot %s is %s; only a lot its own site released is packaged, and its status travels with it (DI-39, D-P6i-0-2)', l.lot_code, v_state);
  end if;
  v_retest := site.lot_retest_at(l.id);
  if l.expires_at <= clock_timestamp() or (v_retest is not null and v_retest <= clock_timestamp()) then
    raise exception using errcode = 'P0001', message = format('EBMR-XFR-014 lot %s is past its retest or expiry instant (PR-18)', l.lot_code);
  end if;
  v_qty := (p ->> 'quantity')::numeric;
  v_avail := site.lot_available(l.id);
  if v_qty > v_avail then
    raise exception using errcode = 'P0001',
      message = format('EBMR-XFR-015 lot %s has %s %s left after open reservations and earlier packages; %s %s cannot be packaged (INV-13)',
                       l.lot_code, v_avail, l.unit, v_qty, l.unit);
  end if;
  -- The market set: IN always, plus what the shipper names (checked by the market model).
  v_markets := market.checked_market_set(array(select distinct x from (select 'IN'::text as x union all
                                                 select jsonb_array_elements_text(coalesce(p -> 'markets', '[]'::jsonb))) m order by 1));
  -- The hold limit: the earliest of expiry, retest, a hold the lot carried from an earlier transfer, and the stated one.
  v_hold := l.expires_at; v_basis := 'EXPIRY';
  if v_retest is not null and v_retest < v_hold then
    v_hold := v_retest; v_basis := 'RETEST';
  end if;
  -- site.transfer_receipt is created by 0981 (PL/pgSQL binds it at the first call).
  select r.hold_until into v_carried from site.transfer_receipt r where r.lot_id = l.id;
  if v_carried is not null and v_carried < v_hold then
    v_hold := v_carried; v_basis := 'CARRIED';
  end if;
  if p ? 'holdUntil' then
    v_stated := (p ->> 'holdUntil')::timestamptz;
    if v_stated <= clock_timestamp() then
      raise exception using errcode = 'P0001', message = 'EBMR-XFR-016 a stated hold limit lies in the future';
    end if;
    if v_stated < v_hold then
      v_hold := v_stated; v_basis := 'STATED';
    end if;
  end if;
  select * into v_rel from site.lot_status_command c
   where c.lot_id = l.id and c.event in ('RELEASE', 'RELEASE_FOR_FURTHER_PROCESSING', 'UNHOLD')
   order by c.recorded_at desc, c.id desc limit 1;
  -- The genealogy excerpt: backward from the lot, as of now (recipe-core 1010, 1090).
  select coalesce(jsonb_agg(jsonb_build_object('nodeKind', g.node_kind, 'nodeId', g.node_id, 'parentKind', g.parent_kind, 'parentId', g.parent_id,
                                               'edgeKind', g.edge_kind, 'depth', g.depth) order by g.depth, g.node_kind, g.node_id, g.parent_kind, g.parent_id, g.edge_kind), '[]')
    into v_rows
    from recipe.genealogy('LOT', l.id, 'BACKWARD', clock_timestamp()) g;
  select recipe.genealogy_node_views(array_agg(g.node_kind), array_agg(g.node_id)) into v_nodes
    from (select distinct g.node_kind, g.node_id from recipe.genealogy('LOT', l.id, 'BACKWARD', clock_timestamp()) g) g;
  v_no := left(l.lot_code, 40) || '/T' || ((select count(*) from site.transfer_package x where x.lot_id = l.id) + 1)::text;
  v_content := jsonb_build_object(
    'format', 'ebmr.lot-transfer.v1',
    'packageId', v_id,
    'packageNo', v_no,
    'origin', jsonb_build_object('installation', me.installation_code, 'site', me.site_code, 'edition', me.edition, 'keyFingerprint', me.key_fingerprint),
    'destination', jsonb_build_object('installation', peer.installation_code, 'site', peer.site_code),
    'preparedAtUs', site.us_text(clock_timestamp()),
    'lot', jsonb_build_object('id', l.id, 'lotCode', l.lot_code, 'materialCode', l.material_code, 'materialName', l.material_name,
                              'materialKind', l.material_kind, 'unit', l.unit, 'quantity', v_qty::text,
                              'retestAtUs', site.us_text(v_retest), 'expiresAtUs', site.us_text(l.expires_at)),
    'status', jsonb_build_object('state', v_state,
                                 'decision', case when v_rel.id is null then null else jsonb_build_object(
                                   'event', v_rel.event, 'route', v_rel.release_route, 'decidedAtUs', site.us_text(v_rel.recorded_at),
                                   'personId', v_rel.person_id, 'signatureId', v_rel.signature_id, 'reason', v_rel.reason_text) end),
    'coa', coalesce((select jsonb_agg(jsonb_build_object('testCode', t.test_code, 'methodReference', t.method_reference, 'purpose', t.purpose,
                                                         'result', t.result_value::text, 'unit', t.unit, 'lowerLimit', t.lower_limit::text,
                                                         'upperLimit', t.upper_limit::text, 'verdict', t.verdict, 'recordedAtUs', site.us_text(t.recorded_at),
                                                         'approvedAtUs', site.us_text(a.approved_at), 'signatureId', a.signature_id)
                                      order by t.test_code, t.recorded_at, t.id)
                       from site.lot_test_result t join site.lot_test_approval a on a.result_id = t.id
                      where t.lot_id = l.id and not exists (select 1 from site.lot_test_result n where n.revises = t.id)), '[]'),
    'hold', jsonb_build_object('untilUs', site.us_text(v_hold), 'basis', v_basis),
    'markets', to_jsonb(v_markets),
    'ruleResolutions', site.transfer_rule_resolutions(v_markets),
    'genealogy', jsonb_build_object('direction', 'BACKWARD', 'asOfUs', site.us_text(clock_timestamp()), 'rows', v_rows, 'nodes', coalesce(v_nodes, '[]'::jsonb)));
  v_payload := v_content::text;
  insert into site.transfer_package (id, package_no, lot_id, origin_installation, destination_installation, quantity, unit, payload, payload_sha256,
                                     prepared_by_person, prepared_by_account, correlation_id)
  values (v_id, v_no, l.id, me.installation_code, peer.installation_code, v_qty, l.unit, v_payload, encode(sha256(convert_to(v_payload, 'UTF8')), 'hex'),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  return jsonb_build_object('packageId', v_id, 'packageNo', v_no, 'payload', v_payload);
end
$$;

create function site.seal_transfer_package(p_package uuid, p_seal text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  x     site.transfer_package;
begin
  perform iam.assert_not_administrator();
  select * into x from site.transfer_package where id = p_package for update;
  if x.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-XFR-017 there is no transfer package %s', coalesce(p_package::text, 'NULL'));
  end if;
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', (select l.site_code from site.material_lot l where l.id = x.lot_id)));
  if x.prepared_by_person::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-017 a package is sealed for the person who prepared it';
  end if;
  if exists (select 1 from site.transfer_package_seal s where s.package_id = x.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-XFR-017 package %s is sealed already', x.package_no);
  end if;
  if not platform.own_seal_valid('transfer-package', x.payload, p_seal) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-XFR-018 the seal of package %s does not verify under this installation''s current key (D-P6i-0-8)', x.package_no);
  end if;
  insert into site.transfer_package_seal (package_id, seal, key_fingerprint, sealed_by_person, sealed_by_account)
  values (x.id, p_seal, (platform.current_installation()).key_fingerprint, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  return jsonb_build_object('packageId', x.id, 'packageNo', x.package_no, 'payload', x.payload, 'seal', p_seal);
end
$$;

revoke all on function site.lot_transferred_out(uuid), site.transfer_rule_tables(), site.transfer_rule_resolutions(text[]), site.us_text(timestamptz),
  site.prepare_transfer_package(uuid, jsonb), site.seal_transfer_package(uuid, text) from public;
grant execute on function site.lot_transferred_out(uuid), site.transfer_rule_resolutions(text[]), site.us_text(timestamptz),
  site.prepare_transfer_package(uuid, jsonb), site.seal_transfer_package(uuid, text) to ebmr_app;

reset role;
