-- Site services: slice 4 quick review fixes of 4b (Phase 4 slice 4b; kernel 1160, 1162; site services 0870; INV-42, DI-41;
-- docs/build-plan/phase-4/review-backlog.md).
--
--   4b-2/4b-3  site.qp_package_subject(lot): the QP subject provider of a finished lot (records.register_qp_subject_provider,
--              kernel 1162): the chains a section of its QP batch package may copy (batch:<b> and batch_review:<b> for each
--              release batch, manufacturer_release:<lot>, deviation:<d> for each release deviation), and whether its
--              package is served now: the manufacturer release RELEASED (not suspended or rejected) and the EU market in
--              the set and not REMOVED, INELIGIBLE or RELEASE_SUSPENDED (recipe.disposition_state). The release model is
--              recipe-core's, found when the provider runs (site services apply first); without it the lot is closed.
--   4b-4       site.erp_shipment_interlock (re-created from 0870): the interlock takes exactly the locks of the release acts,
--              recipe.lock_release_evidence (the lot, the execution-state rows of the release batches, the LOT epoch, the
--              lot's blocker epoch, each batch's epoch and blocker epoch, the deviation epochs, the consumed lots' epochs),
--              in the same order, so a post-release link or blocker committing during the check is either seen or waits.
--              Without the release model the interlock refuses (fails closed).
-- Messages: EBMR-SHP-002, EBMR-SHP-004.

set local role ebmr_owner;

create function site.qp_package_subject(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  f        site.finished_lot;
  v_b      uuid[];
  v_d      uuid[];
  v_mfr    text;
  v_eu     text;
  v_set    text[];
  v_chains text[];
  v_prob   text;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into f from site.finished_lot where lot_id = p_id::uuid;
  if f.lot_id is null then
    return '{"exists": false}'::jsonb;
  end if;
  if to_regprocedure('recipe.release_batches(uuid)') is null or to_regprocedure('recipe.release_deviations(uuid)') is null
     or to_regprocedure('recipe.market_set(text, uuid)') is null or to_regprocedure('recipe.disposition_state(uuid, text)') is null then
    return jsonb_build_object('exists', true, 'chains', '[]'::jsonb, 'open', false, 'problem', 'the release model is not installed');
  end if;
  execute 'select recipe.release_batches($1)' into v_b using f.lot_id;
  execute 'select recipe.release_deviations($1)' into v_d using f.lot_id;
  execute 'select recipe.market_set(''LOT'', $1)' into v_set using f.lot_id;
  v_mfr := site.release_model_text('manufacturer_release_state', f.lot_id, null);
  v_eu := site.release_model_text('disposition_state', f.lot_id, 'EU');
  v_chains := array(select 'batch:' || b::text from unnest(coalesce(v_b, '{}')) b
                    union all select 'batch_review:' || b::text from unnest(coalesce(v_b, '{}')) b
                    union all select 'manufacturer_release:' || f.lot_id::text
                    union all select 'deviation:' || d::text from unnest(coalesce(v_d, '{}')) d);
  if v_mfr is distinct from 'RELEASED' then
    v_prob := format('the manufacturer release of lot %s is %s', f.batch_number, coalesce(v_mfr, 'none'));
  elsif not ('EU' = any (coalesce(v_set, '{}'))) or v_eu is null or v_eu in ('REMOVED', 'INELIGIBLE', 'RELEASE_SUSPENDED') then
    v_prob := format('the EU market of lot %s is %s', f.batch_number, coalesce(v_eu, 'not in its market set'));
  end if;
  return jsonb_build_object('exists', true, 'chains', to_jsonb(v_chains), 'open', v_prob is null, 'problem', v_prob);
end
$$;
revoke all on function site.qp_package_subject(text) from public;
select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0871_qp_subject_and_shipping_locks)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the QP subject provider of finished lots (DI-41)'));
select records.register_qp_subject_provider('material_lot', 'site.qp_package_subject(text)');
select kernel.set_actor_context(null);

create or replace function site.erp_shipment_interlock() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_prob     text[];
  v_importer jsonb;
begin
  if to_regprocedure('recipe.lock_release_evidence(uuid)') is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SHP-004 shipment %s refused: the release model is not installed (INV-42)', new.shipment_no);
  end if;
  -- The locks of the release acts, in their order (4b-4).
  execute 'select recipe.lock_release_evidence($1)' using new.lot_id;
  v_prob := site.shipment_problems(new.lot_id, new.market, new.consignee_code, new.quarantine, new.quantity, new.unit);
  if cardinality(v_prob) > 0 then
    raise exception using errcode = 'P0001', message = format('EBMR-SHP-002 shipment %s refused: %s', new.shipment_no, array_to_string(v_prob, '; '));
  end if;
  new.manufacturer_state := site.release_model_text('manufacturer_release_state', new.lot_id, null);
  new.disposition_state := case when new.market = 'IN' then new.manufacturer_state else site.release_model_text('disposition_state', new.lot_id, new.market) end;
  if new.market = 'EU' then
    execute 'select recipe.eu_importer_of($1)' into v_importer using new.lot_id;
    new.eu_importer_id := (v_importer ->> 'importer_id')::uuid;
  else
    new.eu_importer_id := null;
  end if;
  return new;
end
$$;
revoke all on function site.erp_shipment_interlock() from public;

reset role;
