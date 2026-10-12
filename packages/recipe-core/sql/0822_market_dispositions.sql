-- Recipe core: the US and EU market dispositions and their release gate (Phase 4 slice 4a; outline 5.2.6, 5.2.7 items 8
-- and 11, 5.7, 7.2 S10, S32; controls INV-39, INV-43, INV-05, INV-35, PR-54, PR-56, DI-39; D-P4-5; ADR 0012, ADR 0013).
-- Interfaces of 4-0 (0820) filled from their definitions there: recipe.disposition_state. recipe.grel_evaluate is
-- replaced from its latest definition (0781) and adds the market items; IN's checklist is unchanged.
--
-- G-REL for US and EU (recipe.grel_market_items):
--   G8.MARKET_ADD        the market was added after issue (to the lot, or to a batch of its records): its market-add
--                        evaluation now (recipe.market_add_evaluate) has no unmet item, else RED (INV-43); NA otherwise.
--   G11.MARKET_IN_SET    the market is in the lot's set and in the set of every batch of its records (the packaging
--                        record is made for the market; PR-56).
--   G11.REGISTRATION     each batch's master version held a valid authorisation cell for the market at issue (PR-56).
--   G11.MARKET_REJECTIONS PR-56: a rejection in another market (a US REJECTED decision, an EU REJECTED_BY_QP outcome) is
--                        visible here; it is GREEN only once its investigation is linked to the lot: the deviation-lite
--                        record a US rejection names, or (an EU outcome comes from outside) one linked at or after the
--                        rejection; every market then assesses that record for itself through G2. NA when none.
--   G11.US_RELEASE_RATE  (US) PR-54 [T]: a controlled-release product (the master's dosage form names an extended,
--                        prolonged, modified, controlled, sustained or delayed release) needs, for every active of its
--                        bill of materials (role ACTIVE), a current RELEASE result RELEASE_RATE.<material> that passed
--                        and is approved; NA for other products (default D-4a-3).
--   G11.US_CONTRACT_GIVER (US) PR-54: NA until contract manufacture is recorded (licences, slice 6a).
--
-- recipe.disposition_state(lot, market):
--   NULL when the market was never in the lot's set; REMOVED when it was and is no longer; INELIGIBLE when an addition of
--   the market to the lot or a batch of its records was signed with an UNMET_FINAL evaluation (terminal, 3.3.3);
--   US: the QCU's decision (RELEASED or REJECTED), RELEASED reads RELEASE_SUSPENDED while the manufacturer release is not
--       RELEASED (INV-39); else READY when the manufacturer release is READY or RELEASED and G-REL for US is ready;
--       else NOT_READY.
--   EU: the effective certification outcome (CERTIFIED or REJECTED_BY_QP; 0824), CERTIFIED reads RELEASE_SUSPENDED
--       while the manufacturer release is not RELEASED; else AWAITING_QP_CERTIFICATION when the manufacturer release is
--       RELEASED and G-REL for EU is ready; else NOT_READY.
--
-- Acts (SECURITY DEFINER; signature checked against meaning, record and state, the actor's own):
--   recipe.record_us_disposition(lot, decision RELEASE|REJECT, signature, expected epoch, reason, deviation)
--       RELEASE.US_DISPOSITION; signed US_DISPOSITION on us_disposition <lot>/<decision> by the signer as recorded; US in
--       the lot's set; no decision yet; not INELIGIBLE; INV-39: the manufacturer release RELEASED at that instant (the lot
--       lock serialises it with the manufacturer act); G-REL for US under the locks at an unchanged epoch with the signed
--       checklist the current one (INV-05); the signer outside the involvement set (INV-35); RELEASE: no RED item, every
--       since-review item acknowledged; REJECT: the person's reason and a deviation-lite record linked to the lot (PR-56).
--   recipe.record_release_with_us_disposition(lot, mr signature, us signature, epoch IN, epoch US)   D-P4-5: the AP who
--       also holds the QCU permission releases for the manufacturer and for the US in one ceremony: both signatures are
--       the actor's, made in this command's ceremony; G-REL for US is checked first under the locks (epoch, signed content,
--       ready, acknowledgements), the manufacturer release is recorded (recipe.record_manufacturer_release), then the US
--       decision with the checklist evaluated before it, in the same transaction. Two signature rows, each with its own
--       meaning, content hash and life cycle.
--   recipe.cascade_market_dispositions(lot, cause) owner only: records, in the transaction that changed the manufacturer
--       release, the state every export market of the lot moved to (recipe.market_disposition_event); called by the
--       manufacturer rejection (0823) and by slice 5's suspension.
-- Signed aggregate us_disposition <lot>/<RELEASE|REJECT>: the checklist (G-REL for US, or the one stored with the
-- decision), the decision; `involved` the involvement set (INV-35); state the US disposition state.
-- Messages: EBMR-DSP-030 to EBMR-DSP-049.

set local role ebmr_owner;

create table recipe.us_disposition_decision (
  lot_id                     uuid primary key,
  decision                   text not null check (decision in ('RELEASED', 'REJECTED')),
  signature_id               uuid not null unique,
  epoch                      text not null check (epoch ~ '^[0-9a-f]{64}$'),
  checklist                  jsonb not null check (jsonb_typeof(checklist) = 'object'),
  checklist_hash             text not null check (checklist_hash ~ '^[0-9a-f]{64}$'),
  content_hash               text not null,
  reason                     text check (reason is null or btrim(reason) <> ''),
  deviation_id               uuid,
  with_manufacturer_release  boolean not null default false,
  person_id                  uuid not null,
  account_id                 uuid not null,
  role_code                  text not null,
  correlation_id             uuid not null,
  xact_id                    xid8 not null default pg_current_xact_id(),
  recorded_at                timestamptz not null default clock_timestamp(),
  check (decision = 'RELEASED' or (reason is not null and deviation_id is not null))
);

create table recipe.market_disposition_event (
  id           uuid primary key default gen_random_uuid(),
  lot_id       uuid not null,
  market       text not null check (market in ('US', 'EU')),
  to_state     text not null,
  cause        jsonb not null check (jsonb_typeof(cause) = 'object'),
  xact_id      xid8 not null default pg_current_xact_id(),
  recorded_at  timestamptz not null default clock_timestamp()
);
create index market_disposition_event_lot on recipe.market_disposition_event (lot_id, market, recorded_at);

do $$
declare
  t text;
begin
  foreach t in array array['us_disposition_decision', 'market_disposition_event'] loop
    execute format('revoke all on recipe.%I from public', t);
    execute format('grant select on recipe.%I to ebmr_app', t);
  end loop;
end
$$;
select platform.enforce_db_time('recipe.us_disposition_decision', array['recorded_at']);
select platform.enforce_db_time('recipe.market_disposition_event', array['recorded_at']);
select kernel.register_audited_table('recipe.us_disposition_decision', 'us_disposition', 'lot_id', true);
select kernel.register_audited_table('recipe.market_disposition_event', 'market_disposition', 'lot_id', true);

-- A decision or outcome changes what the other markets read (G11.MARKET_REJECTIONS): the lot's epoch moves.
create function recipe.epoch_on_market_decision() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  perform recipe.bump_epoch('LOT', (to_jsonb(new) ->> 'lot_id')::uuid);
  return null;
end
$$;
create trigger zzze_epoch_market after insert on recipe.us_disposition_decision for each row execute function recipe.epoch_on_market_decision();

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

-- Whether the market was added after issue to the lot or to a batch of its records (G-REL item 8 applies).
create function recipe.market_added(p_lot uuid, p_market text) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select not (p_market = any (coalesce(recipe.market_base_set('LOT', p_lot), '{}')))
      or exists (select 1 from unnest(recipe.release_batches(p_lot)) b where not (p_market = any (coalesce(recipe.market_base_set('BATCH', b), '{}'))))
      or exists (select 1 from recipe.market_change c where c.market = p_market and c.change = 'ADD'
                    and ((c.subject_kind = 'LOT' and c.subject_id = p_lot) or (c.subject_kind = 'BATCH' and c.subject_id = any (recipe.release_batches(p_lot)))))
$$;

-- The signed addition that made the market INELIGIBLE for the lot (an UNMET_FINAL evaluation), or NULL.
create function recipe.market_ineligible_by(p_lot uuid, p_market text) returns recipe.market_change
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select c.* from recipe.market_change c
   where c.market = p_market and c.change = 'ADD' and c.evaluation ->> 'outcome' = 'UNMET_FINAL'
     and ((c.subject_kind = 'LOT' and c.subject_id = p_lot) or (c.subject_kind = 'BATCH' and c.subject_id = any (recipe.release_batches(p_lot))))
   order by c.recorded_at, c.id limit 1
$$;

create function recipe.us_decision(p_lot uuid) returns recipe.us_disposition_decision
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select d.* from recipe.us_disposition_decision d where d.lot_id = p_lot
$$;

-- The effective EU certification outcome (0824 replaces it with the register's reading): NULL until then.
create function recipe.eu_outcome(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select null::text
$$;

-- The rejections in export markets of the lot: (market, at), for G11.MARKET_REJECTIONS (0824 adds the EU outcomes).
create function recipe.market_rejections(p_lot uuid) returns table (market text, rejected_at timestamptz, ref text, deviation_id uuid)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select 'US'::text, d.recorded_at, d.signature_id::text, d.deviation_id from recipe.us_disposition_decision d where d.lot_id = p_lot and d.decision = 'REJECTED'
$$;

-- PR-54 [T] (default D-4a-3): the controlled-release product's actives (BOM role ACTIVE) when any master of the lot's
-- records names a controlled-release dosage form; empty otherwise.
create function recipe.controlled_release_actives(p_lot uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  with c as (select (recipe.current_content(v.id)).content as content
               from unnest(recipe.release_batches(p_lot)) b, lateral (select (recipe.batch_master_version(b)).id) v(id) where v.id is not null)
  select coalesce(array_agg(distinct l ->> 'material' order by l ->> 'material'), '{}')
    from c, jsonb_array_elements(case when jsonb_typeof(c.content -> 'bom') = 'array' then c.content -> 'bom' else '[]'::jsonb end) l
   where l ->> 'role' = 'ACTIVE' and coalesce(l ->> 'material', '') <> ''
     and exists (select 1 from c c2 where c2.content #>> '{header,product,dosageForm}' ~* '(extended|prolonged|modified|controlled|sustained|delayed)[- ]release')
$$;

-- G-REL items 8 and 11 for an export market.
create function recipe.grel_market_items(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_items  jsonb := '[]'::jsonb;
  v_set    uuid[] := recipe.release_batches(p_lot);
  v_eval   jsonb;
  v_prob   text;
  v_ev     jsonb;
  b        uuid;
  s        recipe.stub_batch;
  x        recipe.batch_execution;
  v_ver    recipe.mbr_version;
  r        record;
  a        text;
  v_res    record;
  v_act    text[];
  v_status text;
begin
  -- 8. Market-add evaluation (INV-43).
  if recipe.market_added(p_lot, p_market) then
    v_eval := recipe.market_add_evaluate('LOT', p_lot, p_market);
    select string_agg(format('%s %s: %s', i ->> 'id', i ->> 'outcome', i ->> 'detail'), '; ' order by i ->> 'id') into v_prob
      from jsonb_array_elements(v_eval -> 'items') i where i ->> 'outcome' <> 'MET';
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v_ev from jsonb_array_elements(v_eval -> 'items') i, jsonb_array_elements(i -> 'evidence') e;
    v_items := v_items || jsonb_build_array(recipe.grel_item('G8.MARKET_ADD', '8', format('No unmet market-add item for %s (3.3.3)', p_market),
      case when v_prob is not null then format('the market-add evaluation for %s is %s: %s (INV-43)', p_market, v_eval ->> 'outcome', v_prob) end, v_ev));
  else
    v_items := v_items || jsonb_build_array(recipe.grel_item('G8.MARKET_ADD', '8', format('No unmet market-add item for %s (3.3.3)', p_market), null, '[]'::jsonb, false, 'NA'));
  end if;

  -- 11. Market items.
  v_prob := null;
  v_ev := jsonb_build_array(jsonb_build_object('kind', 'LOT', 'ref', p_lot, 'label', format('lot set %s', array_to_string(coalesce(recipe.market_set('LOT', p_lot), '{}'), ', '))));
  if not (p_market = any (coalesce(recipe.market_set('LOT', p_lot), '{}'))) then
    v_prob := format('%s is not in the lot''s market set', p_market);
  end if;
  foreach b in array v_set loop
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'BATCH', 'ref', b,
              'label', format('%s set %s', (select y.batch_number from recipe.batch_execution y where y.id = b), array_to_string(coalesce(recipe.market_set('BATCH', b), '{}'), ', '))));
    if v_prob is null and not (p_market = any (coalesce(recipe.market_set('BATCH', b), '{}'))) then
      v_prob := format('batch %s is not made for %s: its record is not the market''s (PR-56)', (select y.batch_number from recipe.batch_execution y where y.id = b), p_market);
    end if;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G11.MARKET_IN_SET', '11', format('Lot and records made for %s (PR-56)', p_market), v_prob, v_ev));

  v_prob := null;
  v_ev := '[]'::jsonb;
  foreach b in array v_set loop
    select * into s from recipe.stub_batch where id = b;
    select * into x from recipe.batch_execution where id = b;
    v_ver := recipe.batch_master_version(b);
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'BATCH', 'ref', b, 'label', format('%s master version %s', x.batch_number, v_ver.version_number)));
    if v_prob is null and (s.id is null or v_ver.id is null
       or not exists (select 1 from recipe.valid_cells(s.family_id, array[p_market], s.site, s.line, s.batch_size, x.issued_at) c where c.version_id = v_ver.id)) then
      v_prob := format('batch %s was made on master version %s, which held no authorisation for %s when it was issued (PR-56; 5.2 MBR)', x.batch_number, v_ver.version_number, p_market);
    end if;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G11.REGISTRATION', '11', format('Master authorised for %s (registration conformity, PR-56)', p_market), v_prob, v_ev));

  v_prob := null;
  v_ev := '[]'::jsonb;
  for r in select * from recipe.market_rejections(p_lot) j where j.market <> p_market order by j.rejected_at loop
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'MARKET_REJECTION', 'ref', r.ref, 'label', format('rejected for %s', r.market)));
    if v_prob is null and r.deviation_id is null
       and not exists (select 1 from site.deviation_link k where k.subject_kind = 'LOT' and k.subject_id = p_lot and k.linked_at >= r.rejected_at) then
      v_prob := format('the lot was rejected for %s; an investigation (a deviation record linked to the lot) is opened before %s decides (PR-56)', r.market, p_market);
    end if;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G11.MARKET_REJECTIONS', '11', 'Rejections in other markets investigated (PR-56)', v_prob, v_ev, false,
                                                           case when jsonb_array_length(v_ev) = 0 then 'NA' end));

  if p_market = 'US' then
    v_act := recipe.controlled_release_actives(p_lot);
    v_prob := null;
    v_ev := '[]'::jsonb;
    foreach a in array v_act loop
      select r1.id, r1.result_value, r1.unit, r1.verdict, exists (select 1 from site.lot_test_approval ap where ap.result_id = r1.id) as approved into v_res
        from site.lot_test_result r1
       where r1.lot_id = p_lot and r1.purpose = 'RELEASE' and r1.test_code = 'RELEASE_RATE.' || a and site.lot_test_is_current(r1.id)
       order by r1.recorded_at desc, r1.id desc limit 1;
      if v_res.id is null then
        v_prob := coalesce(v_prob, format('no release-rate result RELEASE_RATE.%s for active %s of this controlled-release product (PR-54)', a, a));
      else
        v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'LIMS_RESULT', 'ref', v_res.id, 'label', format('RELEASE_RATE.%s %s %s %s', a, v_res.result_value, v_res.unit, v_res.verdict)));
        if v_res.verdict <> 'PASS' then
          v_prob := coalesce(v_prob, format('the release-rate result of active %s failed (PR-54)', a));
        elsif not v_res.approved then
          v_prob := coalesce(v_prob, format('the release-rate result of active %s is not approved (PR-54)', a));
        end if;
      end if;
      v_res := null;
    end loop;
    v_status := case when cardinality(v_act) = 0 then 'NA' end;
    v_items := v_items || jsonb_build_array(recipe.grel_item('G11.US_RELEASE_RATE', '11', 'Release-rate result per active of a controlled-release product (PR-54)',
                                                             v_prob, v_ev, false, v_status));
    v_items := v_items || jsonb_build_array(recipe.grel_item('G11.US_CONTRACT_GIVER', '11', 'Contract giver''s QCU disposition, where applicable (PR-54; slice 6a)',
                                                             null, '[]'::jsonb, false, 'NA'));
  end if;
  return v_items;
end
$$;

create or replace function recipe.grel_evaluate(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_items   jsonb;
  v_edition jsonb;
  v_grp     text;
begin
  if p_market is null or p_market not in ('IN', 'US', 'EU') then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-002 G-REL is evaluated for IN, US or EU, not %s', coalesce(p_market, 'NULL'));
  end if;
  v_items := recipe.grel_core_items(p_lot, p_market);
  -- Slice 4a: for US and EU the market-add item and the market items (IN's checklist is unchanged).
  if p_market in ('US', 'EU') and exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    v_items := (select coalesce(jsonb_agg(i order by n), '[]'::jsonb) from jsonb_array_elements(v_items) with ordinality t(i, n) where i ->> 'id' <> 'G8.MARKET_ADD')
               || recipe.grel_market_items(p_lot, p_market);
  end if;
  v_edition := recipe.grel_edition_items(p_lot, p_market);
  -- Groups 4 and 9 are the edition's blocks: RED until the edition answers for them (fails closed).
  foreach v_grp in array array['4', '9'] loop
    if not exists (select 1 from jsonb_array_elements(v_edition) e where e ->> 'group' = v_grp) then
      v_items := v_items || jsonb_build_array(recipe.grel_item(
        case v_grp when '4' then 'G4.RECONCILIATION' else 'G9.PACK_EXAMINATION' end, v_grp,
        case v_grp when '4' then 'Yield, printed-material and serial reconciliation' else 'Finished-pack examination recorded' end,
        format('the edition reports no %s item for the lot yet', case v_grp when '4' then 'reconciliation' else 'finished-pack examination' end)));
    end if;
  end loop;
  v_items := v_items || v_edition;
  return jsonb_build_object(
    'lot', p_lot, 'market', p_market,
    'epoch', encode(sha256(convert_to(jsonb_build_object('versions', recipe.grel_versions(p_lot), 'items', v_items)::text, 'UTF8')), 'hex'),
    'ready', not exists (select 1 from jsonb_array_elements(v_items) i where i ->> 'status' = 'RED'),
    'items', v_items);
end
$$;

create or replace function recipe.disposition_state(p_lot uuid, p_market text) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_mr  text;
  v_out text;
  d     recipe.us_disposition_decision;
begin
  if p_market = 'IN' then
    return recipe.manufacturer_release_state(p_lot);
  end if;
  if p_market is null or p_market not in ('US', 'EU') or recipe.market_base_set('LOT', p_lot) is null then
    return null;
  end if;
  if not (p_market = any (recipe.market_set('LOT', p_lot))) then
    return case when p_market = any (recipe.market_base_set('LOT', p_lot))
                  or exists (select 1 from recipe.market_change c where c.subject_kind = 'LOT' and c.subject_id = p_lot and c.market = p_market)
                then 'REMOVED' end;
  end if;
  if (recipe.market_ineligible_by(p_lot, p_market)).id is not null then
    return 'INELIGIBLE';
  end if;
  v_mr := recipe.manufacturer_release_state(p_lot);
  if p_market = 'US' then
    d := recipe.us_decision(p_lot);
    if d.lot_id is not null then
      return case when d.decision = 'RELEASED' and v_mr is distinct from 'RELEASED' then 'RELEASE_SUSPENDED' else d.decision end;
    end if;
    return case when v_mr in ('READY', 'RELEASED') and (recipe.grel_evaluate(p_lot, 'US') ->> 'ready')::boolean then 'READY' else 'NOT_READY' end;
  end if;
  v_out := recipe.eu_outcome(p_lot);
  if v_out is not null then
    return case when v_out = 'CERTIFIED' and v_mr is distinct from 'RELEASED' then 'RELEASE_SUSPENDED' else v_out end;
  end if;
  return case when v_mr = 'RELEASED' and (recipe.grel_evaluate(p_lot, 'EU') ->> 'ready')::boolean then 'AWAITING_QP_CERTIFICATION' else 'NOT_READY' end;
end
$$;

-- INV-39 cascade (owner only): the state every export market of the lot is in after the manufacturer release changed,
-- recorded in the same transaction.
create function recipe.cascade_market_dispositions(p_lot uuid, p_cause jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  m text;
begin
  foreach m in array array['US', 'EU'] loop
    if m = any (coalesce(recipe.market_set('LOT', p_lot), '{}')) then
      insert into recipe.market_disposition_event (lot_id, market, to_state, cause)
      values (p_lot, m, recipe.disposition_state(p_lot, m), coalesce(p_cause, '{}'::jsonb) || jsonb_build_object('manufacturer_state', recipe.manufacturer_release_state(p_lot)));
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The US disposition
-- ---------------------------------------------------------------------------------------------

create function recipe.us_disposition_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  m  text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(RELEASE|REJECT)$');
  f  site.finished_lot;
  d  recipe.us_disposition_decision;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into f from site.finished_lot where lot_id = m[1]::uuid;
  if f.lot_id is null then
    return '{"exists": false}'::jsonb;
  end if;
  d := recipe.us_decision(f.lot_id);
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'content', jsonb_build_object('lot_id', f.lot_id, 'lot_code', (select l.lot_code from site.material_lot l where l.id = f.lot_id), 'product_code', f.product_code,
                                  'strength', f.strength, 'batch_id', f.batch_id, 'batch_number', f.batch_number,
                                  'decision', case m[2] when 'RELEASE' then 'RELEASED' else 'REJECTED' end,
                                  -- Once decided, the checklist stored with the decision (the signed content stays what was signed).
                                  'checklist', case when d.decision = case m[2] when 'RELEASE' then 'RELEASED' else 'REJECTED' end then d.checklist
                                                    else recipe.grel_evaluate(f.lot_id, 'US') end),
    'market', 'US',
    'state', recipe.disposition_state(f.lot_id, 'US'),
    'scope', recipe.release_scope(f.lot_id),
    'involved', to_jsonb(recipe.release_involvement(f.lot_id)));
end
$$;

select esig.register_content_provider('us_disposition', 'recipe.us_disposition_content(text)',
  'The quality-unit disposition of a finished lot for the US market: G-REL for US and the decision (Phase 4 slice 4a; PR-54, DI-39)');

-- The locks of everything G-REL reads for the lot (outline 5.7), as the manufacturer release takes them.
create function recipe.lock_release_evidence(p_lot uuid) returns site.material_lot
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, records, pg_temp as $$
declare
  l site.material_lot;
  b uuid;
  d uuid;
begin
  l := site.lock_lot(p_lot);
  perform 1 from recipe.execution_state s where s.batch_id = any (recipe.release_batches(p_lot)) order by s.batch_id for update;
  perform recipe.lock_epoch('LOT', p_lot);
  perform records.lock_blocker_epoch('material_lot', p_lot::text);
  foreach b in array recipe.release_batches(p_lot) loop
    perform recipe.lock_epoch('BATCH', b);
    perform records.lock_blocker_epoch('batch', b::text);
  end loop;
  foreach d in array recipe.release_deviations(p_lot) loop
    perform recipe.lock_epoch('DEVIATION', d);
  end loop;
  for b in select distinct lc.lot_id from site.lot_consumption lc where lc.batch_id = any (recipe.release_batches(p_lot)) order by 1 loop
    perform recipe.lock_epoch('LOT', b);
  end loop;
  return l;
end
$$;

-- The checks every export disposition makes under the locks, whatever its decision: the market in the set, not
-- INELIGIBLE, the manufacturer release RELEASED at this instant (INV-39), the signer outside the involvement set (INV-35).
create function recipe.market_act_problem(p_lot uuid, p_market text, p_person uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_code text := (select l.lot_code from site.material_lot l where l.id = p_lot);
begin
  if not (p_market = any (coalesce(recipe.market_set('LOT', p_lot), '{}'))) then
    return format('EBMR-DSP-031 %s is not in the market set of lot %s', p_market, v_code);
  end if;
  if (recipe.market_ineligible_by(p_lot, p_market)).id is not null then
    return format('EBMR-DSP-032 lot %s is INELIGIBLE for %s: the market-add evaluation signed with its addition has an UNMET_FINAL item (3.3.3)', v_code, p_market);
  end if;
  if recipe.manufacturer_release_state(p_lot) is distinct from 'RELEASED' then
    return format('EBMR-DSP-033 the manufacturer release of lot %s is %s: every market disposition needs it RELEASED at that instant (INV-39)',
                  v_code, recipe.manufacturer_release_state(p_lot));
  end if;
  if p_person = any (recipe.release_involvement(p_lot)) then
    return 'EBMR-DSP-034 a person involved in the lot''s records never decides a market disposition (INV-35, S10)';
  end if;
  return null;
end
$$;

-- Why a US act is not possible now (the cockpit shows them; the acts raise them). Acts: RELEASE, REJECT.
create function recipe.us_disposition_gate_problems(p_lot uuid, p_act text) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_out text[] := '{}';
  v_p   text;
  g     jsonb;
  i     jsonb;
begin
  if not exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    return array['the lot is no finished lot of a packaging batch'];
  end if;
  if (recipe.us_decision(p_lot)).lot_id is not null then
    return array[format('the US disposition of the lot is %s', recipe.disposition_state(p_lot, 'US'))];
  end if;
  v_p := recipe.market_act_problem(p_lot, 'US', null);
  if v_p is not null then
    v_out := v_out || v_p;
  end if;
  if p_act = 'RELEASE' then
    g := recipe.grel_evaluate(p_lot, 'US');
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if i ->> 'status' = 'RED' then
        v_out := v_out || format('G-REL item %s is RED: %s', i ->> 'id', i ->> 'problem');
      end if;
    end loop;
  elsif p_act is distinct from 'REJECT' then
    v_out := v_out || format('%s is no act of the US disposition (RELEASE or REJECT)', coalesce(p_act, 'NULL'));
  end if;
  return v_out;
end
$$;

-- Owner only. The US decision once its signature and checklist are checked; p_checked: the G-REL evaluated under the
-- locks before (the two-row act checks it before it records the manufacturer release).
create function recipe.insert_us_disposition(p_lot uuid, p_decision text, p_signature uuid, p_reason text, p_deviation uuid, p_actor jsonb,
                                             p_checked jsonb, p_content_hash text, p_with_mr boolean) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, pg_temp as $$
declare
  v_p text := recipe.market_act_problem(p_lot, 'US', (p_actor ->> 'person_id')::uuid);
begin
  if v_p is not null then
    raise exception using errcode = 'P0001', message = v_p;
  end if;
  insert into recipe.us_disposition_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, reason, deviation_id,
                                              with_manufacturer_release, person_id, account_id, role_code, correlation_id)
  values (p_lot, case p_decision when 'RELEASE' then 'RELEASED' else 'REJECTED' end, p_signature, p_checked ->> 'epoch', p_checked,
          encode(sha256(convert_to(p_checked::text, 'UTF8')), 'hex'), p_content_hash, nullif(btrim(coalesce(p_reason, '')), ''), p_deviation,
          coalesce(p_with_mr, false), (p_actor ->> 'person_id')::uuid, (p_actor ->> 'account_id')::uuid,
          (select s.signer_role_code from esig.signature s where s.id = p_signature), (p_actor ->> 'correlation_id')::uuid);
  return p_signature;
end
$$;

-- Owner only. G-REL for US under the locks: the epoch, the signature (meaning, record, the actor's own), the signed
-- checklist the current one, and for RELEASE every item green and the since-review items acknowledged. Returns the
-- evaluation and the content hash.
create function recipe.check_us_disposition(p_lot uuid, p_decision text, p_signature uuid, p_expected_epoch text, p_reason text, p_deviation uuid, p_actor jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, pg_temp as $$
declare
  v_id      text := p_lot::text || '/' || coalesce(p_decision, '');
  v_code    text := (select l.lot_code from site.material_lot l where l.id = p_lot);
  g         jsonb;
  i         jsonb;
  v_red     text[] := '{}';
  v_sig     jsonb;
  v_content text;
  v_p       text;
begin
  if p_decision is null or p_decision not in ('RELEASE', 'REJECT') then
    raise exception using errcode = 'P0001', message = format('EBMR-DSP-030 %s is no decision of the US disposition (RELEASE or REJECT)', coalesce(p_decision, 'NULL'));
  end if;
  if (recipe.us_decision(p_lot)).lot_id is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-DSP-035 the US disposition of lot %s is already %s', v_code, (recipe.us_decision(p_lot)).decision);
  end if;
  v_p := recipe.market_act_problem(p_lot, 'US', (p_actor ->> 'person_id')::uuid);
  -- The two-row act checks the US side before the manufacturer release it records: INV-39 is checked again at insert.
  if v_p is not null and v_p not like 'EBMR-DSP-033%' then
    raise exception using errcode = 'P0001', message = v_p;
  end if;
  g := recipe.grel_evaluate(p_lot, 'US');
  if p_expected_epoch is null or p_expected_epoch is distinct from g ->> 'epoch' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DSP-036 the evidence of lot %s changed after it was evaluated for US (epoch %s, now %s); evaluate G-REL again (INV-05, DI-37)',
                       v_code, coalesce(left(p_expected_epoch, 12), 'none given'), left(g ->> 'epoch', 12));
  end if;
  v_sig := recipe.assert_release_signature(p_signature, 'US_DISPOSITION', 'us_disposition', v_id, (p_actor ->> 'person_id')::uuid);
  v_content := esig.content_hash_of('us_disposition', v_id, esig.provide('us_disposition', v_id));
  if v_content is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-036 the signed US checklist is not the current one; sign the current evaluation (INV-05, DI-39)';
  end if;
  if p_decision = 'RELEASE' then
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if i ->> 'status' = 'RED' then
        v_red := v_red || format('%s: %s', i ->> 'id', i ->> 'problem');
      end if;
    end loop;
    if cardinality(v_red) > 0 then
      raise exception using errcode = 'P0001', message = format('EBMR-DSP-037 lot %s is not READY for US: %s (PR-54, INV-05)', v_code, array_to_string(v_red, '; '));
    end if;
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if (i -> 'since_review') = 'true'::jsonb and not exists (
           select 1 from recipe.grel_acknowledgement a where a.lot_id = p_lot and a.market = 'US' and a.item_id = i ->> 'id'
              and a.epoch = g ->> 'epoch' and a.person_id = (p_actor ->> 'person_id')::uuid) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-DSP-038 item %s changed after the QA review; the signer acknowledges it at the current evaluation before releasing (outline 5.2.7 item 1)', i ->> 'id');
      end if;
    end loop;
  else
    if p_reason is null or recipe.reason_is_blank(p_reason) then
      raise exception using errcode = 'P0001', message = 'EBMR-DSP-039 a rejection states the person''s own reason (DI-22, L-20)';
    end if;
    if p_deviation is null or not exists (select 1 from site.deviation_link k where k.deviation_id = p_deviation and k.subject_kind = 'LOT' and k.subject_id = p_lot)
       or site.deviation_state(p_deviation) = 'CANCELLED' then
      raise exception using errcode = 'P0001',
        message = 'EBMR-DSP-040 a rejection names the investigation opened for it: a deviation record linked to the lot, not cancelled (PR-56: visible to every market)';
    end if;
  end if;
  return jsonb_build_object('grel', g, 'content_hash', v_content);
end
$$;

create function recipe.record_us_disposition(p_lot uuid, p_decision text, p_signature uuid, p_expected_epoch text, p_reason text, p_deviation uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_chk   jsonb;
  v_p     text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RELEASE.US_DISPOSITION', recipe.release_scope(p_lot));
  perform recipe.lock_release_evidence(p_lot);
  v_p := recipe.market_act_problem(p_lot, 'US', (v_actor ->> 'person_id')::uuid);
  if v_p is not null then
    raise exception using errcode = 'P0001', message = v_p;
  end if;
  v_chk := recipe.check_us_disposition(p_lot, p_decision, p_signature, p_expected_epoch, p_reason, p_deviation, v_actor);
  return recipe.insert_us_disposition(p_lot, p_decision, p_signature, p_reason, p_deviation, v_actor, v_chk -> 'grel', v_chk ->> 'content_hash', false);
end
$$;

create function recipe.record_release_with_us_disposition(p_lot uuid, p_mr_signature uuid, p_us_signature uuid, p_epoch_in text, p_epoch_us text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_chk   jsonb;
  v_a     jsonb;
  v_b     jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RELEASE.US_DISPOSITION', recipe.release_scope(p_lot));
  if p_mr_signature is null or p_us_signature is null or p_mr_signature = p_us_signature then
    raise exception using errcode = 'P0001', message = 'EBMR-DSP-041 the two-row release names two signatures: the manufacturer release and the US disposition (D-P4-5)';
  end if;
  -- One ceremony: both rows are the actor's own and were made in this command.
  select to_jsonb(s) into v_a from esig.signature s where s.id = p_mr_signature;
  select to_jsonb(s) into v_b from esig.signature s where s.id = p_us_signature;
  if v_a is null or v_b is null or (v_a ->> 'signer_person')::uuid is distinct from (v_actor ->> 'person_id')::uuid
     or (v_b ->> 'signer_person')::uuid is distinct from (v_actor ->> 'person_id')::uuid
     or (v_a ->> 'correlation_id') is distinct from (v_actor ->> 'correlation_id') or (v_b ->> 'correlation_id') is distinct from (v_actor ->> 'correlation_id') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-DSP-042 the two rows of a two-row release are the signer''s own, both made in this ceremony (D-P4-5; DI-14, S16)';
  end if;
  perform recipe.lock_release_evidence(p_lot);
  -- The US side first, under the locks, before the manufacturer release changes the lot (its checklist is stored as evaluated).
  v_chk := recipe.check_us_disposition(p_lot, 'RELEASE', p_us_signature, p_epoch_us, null, null, v_actor);
  perform recipe.record_manufacturer_release(p_lot, 'RELEASE', p_mr_signature, p_epoch_in, null);
  -- INV-39: the manufacturer release is RELEASED at this instant (checked again by the insert).
  return recipe.insert_us_disposition(p_lot, 'RELEASE', p_us_signature, null, null, v_actor, v_chk -> 'grel', v_chk ->> 'content_hash', true);
end
$$;

revoke all on function recipe.epoch_on_market_decision(), recipe.market_added(uuid, text), recipe.market_ineligible_by(uuid, text), recipe.us_decision(uuid),
  recipe.eu_outcome(uuid), recipe.market_rejections(uuid), recipe.controlled_release_actives(uuid), recipe.grel_market_items(uuid, text),
  recipe.cascade_market_dispositions(uuid, jsonb), recipe.us_disposition_content(text), recipe.lock_release_evidence(uuid), recipe.market_act_problem(uuid, text, uuid),
  recipe.us_disposition_gate_problems(uuid, text), recipe.insert_us_disposition(uuid, text, uuid, text, uuid, jsonb, jsonb, text, boolean),
  recipe.check_us_disposition(uuid, text, uuid, text, text, uuid, jsonb), recipe.record_us_disposition(uuid, text, uuid, text, text, uuid),
  recipe.record_release_with_us_disposition(uuid, uuid, uuid, text, text) from public;
grant execute on function recipe.market_added(uuid, text), recipe.us_decision(uuid), recipe.eu_outcome(uuid), recipe.controlled_release_actives(uuid),
  recipe.us_disposition_gate_problems(uuid, text), recipe.record_us_disposition(uuid, text, uuid, text, text, uuid),
  recipe.record_release_with_us_disposition(uuid, uuid, uuid, text, text) to ebmr_app;

reset role;
