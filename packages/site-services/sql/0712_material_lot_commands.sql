-- Material lots, part 3: the commands (SECURITY DEFINER), the usage view and the grants (build outline 5.2.9;
-- controls INV-13, INV-14 input side, IN-24 (a)(c), PR-18; defaults D-S1-1, D-S1-2 of the Phase 3 slice 1 plan).
--
--   site.receive_lot               MATERIAL.HANDLE      a lot in QUARANTINE (machine material_lot, 0711)
--   site.record_identity_result    QC.RESULT_RECORD     an identity result (PASS / FAIL)
--   site.propose_vendor_route      MATERIAL.QA_DISPOSITION  QA's statistical justification for one excipient
--   site.enable_vendor_route       MATERIAL.QA_DISPOSITION  with QA's VENDOR_ROUTE_ENABLED signature
--   site.disable_vendor_route      MATERIAL.QA_DISPOSITION
--   site.change_lot_status         per transition       RELEASE (with route), RELEASE_FOR_FURTHER_PROCESSING, REJECT,
--                                                        HOLD, UNHOLD, RETURN, RECALL; leaving a usable status revokes
--                                                        every open reservation of the lot
--   site.record_lot_destruction    MATERIAL.HANDLE      the destruction record (performer)
--   site.destroy_lot               MATERIAL.HANDLE      DESTROY with the witness's signature
--   site.reserve_lot               MATERIAL.HANDLE      a reservation for one batch
--   site.cancel_reservation        MATERIAL.HANDLE
--   site.consume_reservation       DISPENSE.EXECUTE     NOT executable by ebmr_app: called by the edition's batch-side
--                                                        definer (recipe.consume_lot, recipe-core 0430), which passes
--                                                        the batch's own number and market set
-- Every command refuses administrators (DI-18) and checks its permission in the lot's site (DI-17).

set local role ebmr_owner;

-- Usable statuses: material may be reserved and consumed from these (when within retest and expiry).
create function site.usable_lot_states() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['RELEASED', 'RELEASED_FOR_FURTHER_PROCESSING']
$$;

create function site.lock_lot(p_lot uuid) returns site.material_lot
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l site.material_lot;
begin
  select * into l from site.material_lot where id = p_lot for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-102 unknown material lot %s', p_lot);
  end if;
  return l;
end
$$;

-- Revokes every not yet revoked reservation of the lot (the lot left a usable status): one revocation row each,
-- naming the transition and carrying the reason the deciding person gave for it, as given (none for consumption to
-- zero). Returns how many.
create function site.revoke_open_reservations(p_lot uuid, p_cause text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_n   integer;
begin
  insert into site.lot_reservation_revocation (reservation_id, kind, cause, reason_code, reason_text, revoked_by_person, revoked_by_account)
  select r.id, 'STATUS_CHANGE', p_cause, nullif(btrim(coalesce(v_ctx ->> 'reason_code', '')), ''), nullif(btrim(coalesce(v_ctx ->> 'reason_text', '')), ''),
         (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid
    from site.lot_reservation r
   where r.lot_id = p_lot and not exists (select 1 from site.lot_reservation_revocation x where x.reservation_id = r.id);
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Receipt and identity results
-- ---------------------------------------------------------------------------------------------

-- p: {lotCode, materialCode, materialName, materialKind, quantity (decimal text), unit, retestAt?, expiresAt,
--     supplier?, supplierLot?}
create function site.receive_lot(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, kernel, platform, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_site  text;
  v_id    uuid := gen_random_uuid();
  v_qty   numeric;
  v_kind  text := p ->> 'materialKind';
  v_state jsonb;
begin
  perform iam.assert_not_administrator();
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-103 the lot details are required';
  end if;
  v_site := site.actor_site();
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', v_site));
  if coalesce(p ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-103 the received quantity is a positive decimal (INV-13)';
  end if;
  v_qty := (p ->> 'quantity')::numeric;
  if coalesce((p ->> 'expiresAt')::timestamptz <= clock_timestamp(), true) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-104 a lot is received with an expiry instant in the future (PR-18)';
  end if;
  -- One material, one kind: the vendor-history rule is per material and depends on its kind.
  if exists (select 1 from site.material_lot l where l.site_code = v_site and l.material_code = p ->> 'materialCode' and l.material_kind <> v_kind)
     or (v_kind is distinct from 'EXCIPIENT'
         and exists (select 1 from site.vendor_route v where v.site_code = v_site and v.material_code = p ->> 'materialCode')) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-105 material %s is already known at site %s as another kind than %s', p ->> 'materialCode', v_site, coalesce(v_kind, 'NULL'));
  end if;
  insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, supplier, supplier_lot, received_quantity,
                                 unit, retest_at, expires_at, received_by_person, received_by_account, correlation_id)
  values (v_id, v_site, p ->> 'lotCode', p ->> 'materialCode', p ->> 'materialName', v_kind, p ->> 'supplier', p ->> 'supplierLot', v_qty,
          p ->> 'unit', (p ->> 'retestAt')::timestamptz, (p ->> 'expiresAt')::timestamptz, (v_ctx ->> 'person_id')::uuid,
          (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  v_state := platform.create_aggregate_state('material_lot', 'material_lot', v_id);
  return jsonb_build_object('lot_id', v_id, 'site_code', v_site, 'state', v_state ->> 'state', 'state_version', (v_state ->> 'version')::bigint);
end
$$;

create function site.record_identity_result(p_lot uuid, p_result text, p_method_reference text, p_test_reference text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  l     site.material_lot;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('QC.RESULT_RECORD', jsonb_build_object('site', l.site_code));
  if site.lot_state(l.id) in ('CONSUMED', 'DESTROYED') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-106 lot %s is %s; no result is recorded for it', l.lot_code, site.lot_state(l.id));
  end if;
  insert into site.lot_identity_result (lot_id, result, method_reference, test_reference, recorded_by_person, recorded_by_account)
  values (l.id, p_result, p_method_reference, p_test_reference, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Vendor-history route (IN-24 (c)): enabled by QA per excipient, with a signed statistical justification
-- ---------------------------------------------------------------------------------------------

create function site.propose_vendor_route(p_material_code text, p_material_kind text, p_justification text, p_statistical_reference text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_site text;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  v_site := site.actor_site();
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', v_site));
  if p_material_kind is distinct from 'EXCIPIENT'
     or exists (select 1 from site.material_lot l where l.site_code = v_site and l.material_code = p_material_code and l.material_kind <> 'EXCIPIENT') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-131 the vendor-history route is only for excipients; material %s is not one (IN-24 (c))', p_material_code);
  end if;
  if length(btrim(coalesce(p_justification, ''))) < 20 or btrim(coalesce(p_statistical_reference, '')) = '' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-132 the vendor-history route needs QA''s statistical justification (at least 20 characters) and the reference of the study (IN-24 (c))';
  end if;
  insert into site.vendor_route (site_code, material_code, material_kind, justification, statistical_reference, proposed_by_person, proposed_by_account)
  values (v_site, p_material_code, p_material_kind, p_justification, p_statistical_reference, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.enable_vendor_route(p_route uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v      site.vendor_route;
  v_sig  jsonb;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  select * into v from site.vendor_route where id = p_route;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-133 unknown vendor-history route %s', p_route);
  end if;
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', v.site_code));
  -- Every route of the material at the site is locked, so two enablements never overlap.
  perform 1 from site.vendor_route x where x.site_code = v.site_code and x.material_code = v.material_code for update;
  if exists (select 1 from site.vendor_route_enablement e where e.route_id = v.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-133 the vendor-history route of %s was already enabled or disabled; propose a new one', v.material_code);
  end if;
  v_sig := esig.assert_signature(p_signature, 'VENDOR_ROUTE_ENABLED', 'vendor_route', p_route::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-134 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-134 the route is enabled by the QA person who signed it';
  end if;
  if site.vendor_route_enabled(v.site_code, v.material_code) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-133 a vendor-history route of %s is already enabled at site %s; disable it first', v.material_code, v.site_code);
  end if;
  insert into site.vendor_route_enablement (route_id, signature_id, enabled_by_person, enabled_by_account)
  values (p_route, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

create function site.disable_vendor_route(p_route uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v     site.vendor_route;
begin
  perform iam.assert_not_administrator();
  select * into v from site.vendor_route where id = p_route for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-133 unknown vendor-history route %s', p_route);
  end if;
  perform iam.require_permission('MATERIAL.QA_DISPOSITION', jsonb_build_object('site', v.site_code));
  if not exists (select 1 from site.vendor_route_enablement e where e.route_id = v.id)
     or exists (select 1 from site.vendor_route_disablement d where d.route_id = v.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-133 the vendor-history route of %s is not enabled', v.material_code);
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-135 disabling a vendor-history route states the reason';
  end if;
  insert into site.vendor_route_disablement (route_id, reason, disabled_by_person, disabled_by_account)
  values (p_route, p_reason, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Status changes
-- ---------------------------------------------------------------------------------------------

-- Records the command (a RELEASE records its route there), then fires the transition (the engine checks permission,
-- signature and guards). Leaving a usable status revokes every open reservation of the lot.
create function site.lot_transition(l site.material_lot, p_event text, p_expected_version bigint, p_signature uuid, p_route text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_from text := site.lot_state(l.id);
  r      jsonb;
  v_n    integer := 0;
begin
  insert into site.lot_status_command (lot_id, event, from_state, release_route, signature_id, person_id, account_id, xact_id)
  values (l.id, p_event, v_from, p_route, p_signature, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 0);
  r := platform.transition('material_lot', 'material_lot', l.id, p_event, p_expected_version,
                           jsonb_strip_nulls(jsonb_build_object('signature_id', p_signature, 'release_route', p_route)));
  insert into site.lot_state_entry (lot_id, state, state_version, history_id)
  values (l.id, r ->> 'to', (r ->> 'new_version')::bigint, (r ->> 'history_id')::bigint);
  if not ((r ->> 'to') = any (site.usable_lot_states())) then
    v_n := site.revoke_open_reservations(l.id, format('lot %s: %s -> %s', l.lot_code, v_from, r ->> 'to'));
  end if;
  return r || jsonb_build_object('lot_id', l.id, 'revoked_reservations', v_n);
end
$$;

create function site.change_lot_status(p_lot uuid, p_event text, p_expected_version bigint, p_signature uuid default null,
                                       p_route text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  l site.material_lot;
begin
  perform site.require_actor();
  perform iam.assert_not_administrator();
  if p_event is null or p_event not in ('RELEASE', 'RELEASE_FOR_FURTHER_PROCESSING', 'REJECT', 'HOLD', 'UNHOLD', 'RETURN', 'RECALL') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-110 %s is not a lot status decision: lots are consumed by dispensing and destroyed with a witnessed record', coalesce(p_event, 'NULL'));
  end if;
  if (p_event = 'RELEASE') <> (p_route is not null) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-111 a RELEASE records its route (IDENTITY_TESTED or VENDOR_HISTORY), and only a RELEASE does (IN-24 (c))';
  end if;
  if p_route is not null and p_route not in ('IDENTITY_TESTED', 'VENDOR_HISTORY') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-111 unknown release route %s (IN-24 (c))', p_route);
  end if;
  l := site.lock_lot(p_lot);
  -- The permission in the lot's site (DI-17); the engine checks the transition's own permission again.
  perform iam.require_permission(case when p_event = 'RELEASE' or (p_event = 'REJECT' and site.lot_state(l.id) = 'QUARANTINE') then 'MATERIAL.RELEASE'
                                      else 'MATERIAL.QA_DISPOSITION' end,
                                 jsonb_build_object('site', l.site_code));
  return site.lot_transition(l, p_event, p_expected_version, p_signature, p_route);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Witnessed destruction
-- ---------------------------------------------------------------------------------------------

create function site.record_lot_destruction(p_lot uuid, p_method text, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  l     site.material_lot;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  if site.lot_state(l.id) not in ('REJECTED', 'RETURNED', 'RECALLED') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-150 lot %s is %s: only a rejected, returned or recalled lot is destroyed', l.lot_code, site.lot_state(l.id));
  end if;
  if exists (select 1 from site.lot_destruction d where d.lot_id = l.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-150 the destruction of lot %s is already recorded', l.lot_code);
  end if;
  insert into site.lot_destruction (lot_id, method, reason, quantity, unit, performed_by_person, performed_by_account)
  values (l.id, p_method, p_reason, site.lot_quantity(l.id), l.unit, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- DESTROY, fired by the performer of the destruction record with the witness's signature.
create function site.destroy_lot(p_lot uuid, p_expected_version bigint, p_witness_signature uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  l     site.material_lot;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  if not exists (select 1 from site.lot_destruction d where d.lot_id = l.id and d.performed_by_person::text = v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-151 lot %s is destroyed by the person who recorded its destruction, with a witness''s signature', l.lot_code);
  end if;
  return site.lot_transition(l, 'DESTROY', p_expected_version, p_witness_signature, null);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------------------------

create function site.reserve_lot(p_lot uuid, p_batch_id uuid, p_batch_number text, p_edition text, p_quantity numeric, p_unit text,
                                 p_expires_at timestamptz) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  l       site.material_lot;
  v_state platform.aggregate_state;
  v_prob  text;
  v_avail numeric;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  l := site.lock_lot(p_lot);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  select * into v_state from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = l.id;
  if not (v_state.state = any (site.usable_lot_states())) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-141 lot %s is %s: only a released lot is reserved (INV-13, PR-18)', l.lot_code, v_state.state);
  end if;
  v_prob := site.lot_dates_problem(l);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-142 ' || v_prob;
  end if;
  if p_quantity is null or p_quantity <= 0 or p_unit is distinct from l.unit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-143 a reservation is a positive quantity in the lot''s unit %s (INV-13)', l.unit);
  end if;
  if p_expires_at is null or p_expires_at <= clock_timestamp() or p_expires_at > l.expires_at
     or (l.retest_at is not null and p_expires_at > l.retest_at) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-144 a reservation expires in the future and no later than the lot''s retest or expiry instant (%s)',
                       site.utc_text(coalesce(least(l.retest_at, l.expires_at), l.expires_at)));
  end if;
  v_avail := site.lot_available(l.id);
  if p_quantity > v_avail then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-145 lot %s has %s %s available after open reservations; %s %s cannot be reserved (INV-13)', l.lot_code, v_avail, l.unit,
                       p_quantity, p_unit);
  end if;
  insert into site.lot_reservation (lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person,
                                    reserved_by_account)
  values (l.id, p_batch_id, p_batch_number, p_edition, p_quantity, p_unit, p_expires_at, v_state.version, (v_ctx ->> 'person_id')::uuid,
          (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.cancel_reservation(p_reservation uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  r     site.lot_reservation;
  l     site.material_lot;
begin
  perform iam.assert_not_administrator();
  select * into r from site.lot_reservation where id = p_reservation;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-146 unknown reservation %s', p_reservation);
  end if;
  l := site.lock_lot(r.lot_id);
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', l.site_code));
  if exists (select 1 from site.lot_reservation_revocation x where x.reservation_id = r.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-146 the reservation is already revoked';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-146 cancelling a reservation states the person''s own reason (DI-22)';
  end if;
  insert into site.lot_reservation_revocation (reservation_id, kind, cause, reason_code, reason_text, revoked_by_person, revoked_by_account)
  values (r.id, 'CANCELLED', 'reservation cancelled', nullif(btrim(coalesce(v_ctx ->> 'reason_code', '')), ''), p_reason,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Consumption (INV-13, INV-14 input side, IN-24 (c), PR-18): the consumption guard
-- ---------------------------------------------------------------------------------------------

-- Consumes p_quantity of a reservation into the batch named by the caller (the edition's batch-side definer,
-- which reads the batch's number and market set from its own batch record). Refused unless: the lot is the
-- expected material; its status is usable and unchanged since the reservation; it is before its retest and
-- expiry instants at database time; the reservation is for this batch, not revoked, not expired and covers the
-- quantity; the lot holds it; and the release route satisfies the batch's identity-test rule (D-S1-2). Writes
-- the consumption (genealogy) row, from which the lot quantity is derived, in this transaction; at zero the lot is CONSUMED and
-- any other open reservation of it is revoked.
create function site.consume_reservation(p_reservation uuid, p_batch_id uuid, p_batch_number text, p_market_set text[],
                                         p_material_code text, p_quantity numeric, p_unit text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, platform, pg_temp as $$
declare
  v_ctx    jsonb := site.require_actor();
  r        site.lot_reservation;
  l        site.material_lot;
  v_state  platform.aggregate_state;
  v_prob   text;
  v_basis  text;
  v_left   numeric;
  v_id     uuid;
  v_qty    numeric;
  v_tr     jsonb;
begin
  perform iam.assert_not_administrator();
  select * into r from site.lot_reservation where id = p_reservation;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-160 no reservation %s: material is consumed only against a reservation (INV-13)', p_reservation);
  end if;
  l := site.lock_lot(r.lot_id);
  select * into r from site.lot_reservation where id = p_reservation for update;
  perform iam.require_permission('DISPENSE.EXECUTE', jsonb_build_object('site', l.site_code));
  if p_material_code is null or p_material_code is distinct from l.material_code then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-161 wrong material: lot %s is %s, the step expects %s (PR-18)', l.lot_code, l.material_code, coalesce(p_material_code, 'NULL'));
  end if;
  if r.batch_id is distinct from p_batch_id or r.batch_number is distinct from p_batch_number then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-162 the reservation is for batch %s, not batch %s (INV-13)', r.batch_number, coalesce(p_batch_number, 'NULL'));
  end if;
  if exists (select 1 from site.lot_reservation_revocation x where x.reservation_id = r.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-163 the reservation was revoked: %s (INV-13)',
      (select concat_ws(': ', x.cause, x.reason_text) from site.lot_reservation_revocation x where x.reservation_id = r.id));
  end if;
  if clock_timestamp() >= r.expires_at then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-164 the reservation expired at %s (INV-13)', site.utc_text(r.expires_at));
  end if;
  select * into v_state from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = l.id;
  if not (v_state.state = any (site.usable_lot_states())) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-165 lot %s is %s and cannot be used (INV-13, PR-18)', l.lot_code, v_state.state);
  end if;
  if v_state.version <> r.lot_state_version then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-163 the status of lot %s changed after the reservation was granted; reserve it again (INV-13)', l.lot_code);
  end if;
  v_prob := site.lot_dates_problem(l);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-166 ' || v_prob;
  end if;
  if p_quantity is null or p_quantity <= 0 or p_unit is distinct from l.unit then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-167 a consumption is a positive quantity in the lot''s unit %s (INV-13)', l.unit);
  end if;
  v_left := site.reservation_remaining(r.id);
  if p_quantity > v_left then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-168 the reservation has %s %s left; %s %s cannot be consumed (INV-13)', v_left, l.unit, p_quantity, p_unit);
  end if;
  v_qty := site.lot_quantity(l.id);
  if p_quantity > v_qty then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-168 lot %s holds %s %s; %s %s cannot be consumed: a lot quantity is never negative (INV-13)', l.lot_code, v_qty, l.unit,
                       p_quantity, p_unit);
  end if;
  select x.p_problem, x.p_basis into v_prob, v_basis from site.identity_rule_problem(l, p_market_set) x;
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-169 ' || v_prob;
  end if;

  insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before,
                                    quantity_after, market_set, release_route, identity_basis, consumed_by_person, consumed_by_account, xact_id)
  values (l.id, r.id, p_batch_id, p_batch_number, r.edition, l.material_code, p_quantity, p_unit, v_qty, v_qty - p_quantity, p_market_set,
          site.lot_release_route(l.id), v_basis, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 0)
  returning id into v_id;
  if v_qty - p_quantity = 0 then
    v_tr := site.lot_transition(site.lock_lot(l.id), 'CONSUME', v_state.version, null, null);
  end if;
  return jsonb_build_object('consumption_id', v_id, 'lot_id', l.id, 'quantity_after', (v_qty - p_quantity)::text, 'identity_basis', v_basis,
                            'lot_state', coalesce(v_tr ->> 'to', v_state.state));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Usage view (IN-24 (a)): the stored status, with RETEST_DUE and EXPIRED computed at database time
-- ---------------------------------------------------------------------------------------------

create view site.material_lot_usage as
  select l.id as lot_id, l.site_code, l.lot_code, l.material_code, l.material_name, l.material_kind, s.state, s.version as state_version,
         case when s.state in ('CONSUMED', 'DESTROYED', 'REJECTED', 'RETURNED', 'RECALLED') then s.state
              when clock_timestamp() >= l.expires_at then 'EXPIRED'
              when l.retest_at is not null and clock_timestamp() >= l.retest_at then 'RETEST_DUE'
              else s.state end as usage_status,
         site.lot_quantity(l.id) as quantity, l.unit, site.lot_available(l.id) as available, l.retest_at, l.expires_at,
         site.lot_release_route(l.id) as release_route
  from site.material_lot l
  join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = l.id;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------

revoke all on site.material_lot, site.lot_status_command, site.lot_state_entry, site.lot_identity_result, site.vendor_route, site.lot_destruction,
              site.lot_reservation, site.lot_reservation_revocation, site.vendor_route_enablement, site.vendor_route_disablement, site.lot_consumption, site.material_lot_usage from ebmr_app;
grant select on site.material_lot, site.lot_status_command, site.lot_state_entry, site.lot_identity_result, site.vendor_route, site.lot_destruction,
                site.lot_reservation, site.lot_reservation_revocation, site.vendor_route_enablement, site.vendor_route_disablement, site.lot_consumption, site.material_lot_usage to ebmr_app;
grant execute on function site.receive_lot(jsonb), site.record_identity_result(uuid, text, text, text),
                          site.propose_vendor_route(text, text, text, text), site.enable_vendor_route(uuid, uuid), site.disable_vendor_route(uuid, text),
                          site.change_lot_status(uuid, text, bigint, uuid, text), site.record_lot_destruction(uuid, text, text),
                          site.destroy_lot(uuid, bigint, uuid), site.reserve_lot(uuid, uuid, text, text, numeric, text, timestamptz),
                          site.cancel_reservation(uuid, text), site.lot_available(uuid), site.reservation_remaining(uuid), site.lot_quantity(uuid), site.lot_release_route(uuid),
                          site.usable_lot_states() to ebmr_app;
-- site.consume_reservation, the guards, the content providers and the helpers stay private to the owner: the
-- application consumes only through the edition's batch-side definer (recipe.consume_lot).

reset role;
