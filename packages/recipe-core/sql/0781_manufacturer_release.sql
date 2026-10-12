-- Recipe core: the release gate G-REL items 1 to 9 and the manufacturer release (Phase 4 slice 3a; outline 5.2.6, 5.2.7,
-- 5.7; controls INV-05, IN-05, INV-35, PR-53, PR-09, IN-03, DI-12, PR-08, PR-47, PR-44, IN-32; defaults D-P4-4, D-P4-6;
-- ADR 0012: every rule holds when the application's own database credentials are used directly).
--
-- Interfaces of 3-0 (0780) filled from their definitions there: recipe.grel_evaluate and recipe.manufacturer_release_state.
--
-- The evidence set of a finished lot (recipe.release_batches): the packaging batch it was posted from and the processing
-- batch that batch packs (recipe.packaging_parent_of). The release reads, for a market:
--   G1.REVIEW_<n>          each record of the set QA_REVIEWED, its QA review signature still valid, and the audit-trail
--                          mark covering every in-scope event (recipe.review_disposition_problem: DI-34, INV-48).
--   G2.DEVIATIONS          site.deviation_release_items for the lot (LOT) and each batch (BATCH) and market: a blocking
--                          link is RED (a CONFIRMED impact keeps blocking after closure, D-2a-9; for IN every link needs an
--                          assessment, IN-05 (c)); cancelled records are listed. PR-53: with release.open_investigation_path
--                          ON, an open record (neither CLOSED nor CANCELLED) assessed for the market is GREEN under a signed
--                          justification of the release authority, never for an OOS record (a specification failure), a
--                          record linked to a registration-relevant exception or to a yield or reconciliation exception.
--   G2.REGISTRATION        PR-08: the registration-relevant exceptions of the set (registered or validated limit breached)
--                          are shown with their deviations; NA when none (they block through G2.DEVIATIONS and the review).
--   G2.CHANGE_NOTIFICATION a batch that is the first under a changed master: its change record holds a regulatory
--                          assessment for the market (IN-05 (c), Schedule M 11.3.9 (e)).
--   G3.LIMS                site.lot_lims_release_problem (required tests, approved, failures resolved; IN-33, PR-45) and
--                          every current RELEASE result approved by the head of QC (signer role HEAD_OF_QC; IN-05).
--   G3.EXTRA_TESTING       site.extra_testing_problem for each batch, recipe.reprocessing_release_problem (PR-47).
--   G3.SAMPLES             site.lot_sample_problem (reserve samples, PR-44, IN-32).
--   G4.RECONCILIATION, G9.PACK_EXAMINATION  RED until the edition answers for group 4 and 9 (fails closed; tablets 3b).
--   G5.MATERIALS           every lot a batch of the set consumed is not REJECTED, RECALLED or ON_HOLD now and had no
--                          result revised after it was consumed (outline 5.2.7 item 5).
--   G6.VALIDATION_BASIS    the master of each batch cites at least one validation reference in its change record (11.3.9 (c)).
--   G6.POST_CHANGE         IN-03 (c): a batch that is the first issued on a master version above 1 needs QA's signed
--                          post-change evaluation (recipe.record_post_change_evaluation).
--   G6.PPQ                 PR-09, D-P4-6: a batch made under a protocol (purpose PPQ or VALIDATION) needs its recorded
--                          validation outcome PASSED; CONCURRENT_RELEASE (an approved protocol permitting it, results
--                          complete, QA's signature) counts for the US only: India is treated as the EU until the expert
--                          confirms (so the manufacturer release, always IN, waits for the outcome).
--   G6.LICENCE             NA (licence, product approval and export permission: slice 6a).
--   G7.INCIDENTS           DI-12, DI-50: no incident linked to a batch of the set or to the lot is open and unassessed for
--                          it, and no DI investigation or record hold blocks it (records.open_blockers); every open one is
--                          listed for the disposition screen.
--   G8.MARKET_ADD          NA (the market-add evaluation is slice 4).
-- Each item says whether its evidence changed after the QA review of the packaging record ("since review"); the signer
-- acknowledges those items one by one at the evaluated epoch (recipe.acknowledge_release_item) before releasing.
--
-- The epoch of an evaluation (D-P4-4, INV-05, outline 5.7) is the SHA-256 of the evidence versions (the BATCH epochs of the
-- set, the LOT epoch of the lot and of every consumed lot, the DEVIATION epochs of the linked records, the kernel's blocker
-- epochs of the batches and the lot) and of the evaluated items themselves (stand-in LIMS, sample and deviation rows serve
-- as their own version tokens). The release act takes the locks of all of them, evaluates again and refuses a moved epoch.
--
-- Signed aggregates (content providers here):
--   manufacturer_release         <lot>/<RELEASE|REJECT>   G-REL for IN (the checklist, IN-05 (d)), the decision, the lot;
--                                                          `involved`: the involvement set of the batches (INV-35).
--   post_change_evaluation       <batch>/<sha256 of the text>   the batch, its master version and change record.
--   ppq_outcome                  <batch>/<outcome>/<sha256 of protocol and text>  the batch and its purpose.
--   investigation_justification  <lot>/<market>/<deviation>/<sha256 of the text>  the open record; its state is the record's
--                                (the justification lapses when the investigation's state moves).
-- A decided manufacturer release provides the checklist stored with the decision, so its signature stays the signed content.
-- New meanings: POST_CHANGE_EVALUATED, VALIDATION_OUTCOME_RECORDED (QA), OPEN_INVESTIGATION_JUSTIFIED (release authority).
--
-- Acts (SECURITY DEFINER; the signature is checked against meaning, record and state, and is the actor's own):
--   recipe.record_manufacturer_release(lot, decision RELEASE|REJECT, signature, expected epoch, reason)  RELEASE.MANUFACTURER;
--       the signer is the AP or a delegate whose cited delegation is still valid (kernel checks it at signing, here again
--       at recording), signs as AUTHORISED_PERSON, is outside the involvement set (INV-35), cancelled no linked deviation
--       (L-21); G-REL for IN evaluated again under the locks at an unchanged epoch, with the signed content still the
--       current one (INV-05); RELEASE needs every item green and every since-review item acknowledged by the signer;
--       REJECT needs a reason and is possible from NOT_READY or READY. The decision row keeps the checklist; the finished
--       lot leaves QUARANTINE in the same transaction (material_lot v2: MANUFACTURER_RELEASE or MANUFACTURER_REJECT).
--   recipe.record_post_change_evaluation(batch, text, signature), recipe.record_ppq_outcome(batch, outcome, protocol, text,
--       signature), recipe.justify_open_investigation(lot, market, deviation, text, signature),
--       recipe.acknowledge_release_item(lot, market, item, epoch).
--   recipe.release_gate_problems(lot, act) text[], recipe.manufacturer_decision_in_xact(lot) (site 0860's guard).
-- Messages: EBMR-REL-010 to EBMR-REL-059.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0781_manufacturer_release)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the manufacturer release, its post-change evaluation, validation outcome and open-investigation justification (IN-05, IN-03, PR-09, PR-53)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('POST_CHANGE_EVALUATED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'REVIEWER', 'Post-change evaluation',
   'Quality unit: I evaluated this first batch made under the changed master as stated.',
   array['RECORD.QA_REVIEW'], '{}', true, true, false, 'ALL_COMPONENTS', false, 'Revised Schedule M 8.6 (first batch after a change); IN-03 (c)'),
  ('VALIDATION_OUTCOME_RECORDED', 1, 'VENDOR', true, 'ACTIVE', 'REVIEW', 'REVIEWER', 'Validation outcome recorded',
   'Quality unit: I record the validation outcome of this batch made under its protocol, as stated.',
   array['RECORD.QA_REVIEW'], '{}', true, true, false, 'ALL_COMPONENTS', false, 'PR-09; EU Annex 15 section 5; outline 5.2.6 concurrent release'),
  ('OPEN_INVESTIGATION_JUSTIFIED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'RELEASE', 'Open investigation justified',
   'As the release authority, I justify the release of this lot while the named investigation is still open: it is advanced enough to support the decision.',
   array['RELEASE.MANUFACTURER'], '{}', true, true, false, 'ALL_COMPONENTS', true, 'PR-53; EU Annex 16 1.7; outline 5.2.7 item 2');

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis)
values ('release.open_investigation_path', 'TEXT', 'OFF', null, null, array['OFF', 'ON'], null, null,
        'PR-53: the release authority may release a lot under a signed justification while a linked investigation is still open',
        'PR-53 CONFIGURABLE, default OFF (release blocked while any linked deviation or investigation is open); never for reconciliation discrepancies or registered-specification failures');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables (insert-only, audited; the application role reads them, the definers write them)
-- ---------------------------------------------------------------------------------------------

create table recipe.manufacturer_release_decision (
  lot_id          uuid primary key,
  decision        text not null check (decision in ('RELEASED', 'REJECTED')),
  signature_id    uuid not null unique,
  delegation_id   uuid,
  reason          text check (reason is null or btrim(reason) <> ''),
  epoch           text not null check (epoch ~ '^[0-9a-f]{64}$'),
  checklist       jsonb not null check (jsonb_typeof(checklist) = 'object'),
  checklist_hash  text not null check (checklist_hash ~ '^[0-9a-f]{64}$'),
  content_hash    text not null,
  person_id       uuid not null,
  account_id      uuid not null,
  role_code       text not null,
  correlation_id  uuid not null,
  xact_id         xid8 not null default pg_current_xact_id(),
  recorded_at     timestamptz not null default clock_timestamp(),
  check (decision = 'RELEASED' or reason is not null)
);

create table recipe.post_change_evaluation (
  id                uuid primary key default gen_random_uuid(),
  batch_id          uuid not null unique references recipe.batch_execution (id),
  version_id        uuid not null,
  change_record_id  uuid not null,
  evaluation        text not null check (btrim(evaluation) <> '' and length(evaluation) <= 4000),
  signature_id      uuid not null unique,
  person_id         uuid not null,
  account_id        uuid not null,
  recorded_at       timestamptz not null default clock_timestamp()
);

create table recipe.ppq_outcome (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references recipe.batch_execution (id),
  outcome       text not null check (outcome in ('PASSED', 'FAILED', 'CONCURRENT_RELEASE')),
  protocol_ref  text not null check (btrim(protocol_ref) <> '' and length(protocol_ref) <= 128),
  statement     text not null check (btrim(statement) <> '' and length(statement) <= 4000),
  signature_id  uuid not null unique,
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp()
);
create index ppq_outcome_batch on recipe.ppq_outcome (batch_id, recorded_at desc);

create table recipe.open_investigation_justification (
  id             uuid primary key default gen_random_uuid(),
  lot_id         uuid not null,
  market         text not null check (market in ('IN', 'US', 'EU')),
  deviation_id   uuid not null,
  justification  text not null check (btrim(justification) <> '' and length(justification) <= 4000),
  signature_id   uuid not null unique,
  person_id      uuid not null,
  account_id     uuid not null,
  recorded_at    timestamptz not null default clock_timestamp()
);
create index open_investigation_justification_lot on recipe.open_investigation_justification (lot_id, market, deviation_id);

create table recipe.grel_acknowledgement (
  id           uuid primary key default gen_random_uuid(),
  lot_id       uuid not null,
  market       text not null check (market in ('IN', 'US', 'EU')),
  item_id      text not null,
  epoch        text not null check (epoch ~ '^[0-9a-f]{64}$'),
  person_id    uuid not null,
  account_id   uuid not null,
  recorded_at  timestamptz not null default clock_timestamp(),
  unique (lot_id, market, item_id, epoch, person_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['manufacturer_release_decision', 'post_change_evaluation', 'ppq_outcome', 'open_investigation_justification', 'grel_acknowledgement'] loop
    execute format('revoke all on recipe.%I from public', t);
    execute format('grant select on recipe.%I to ebmr_app', t);
  end loop;
end
$$;
select platform.enforce_db_time('recipe.manufacturer_release_decision', array['recorded_at']);
select platform.enforce_db_time('recipe.post_change_evaluation', array['recorded_at']);
select platform.enforce_db_time('recipe.ppq_outcome', array['recorded_at']);
select platform.enforce_db_time('recipe.open_investigation_justification', array['recorded_at']);
select platform.enforce_db_time('recipe.grel_acknowledgement', array['recorded_at']);
select kernel.register_audited_table('recipe.manufacturer_release_decision', 'manufacturer_release', 'lot_id', true);
select kernel.register_audited_table('recipe.post_change_evaluation', 'batch_release', 'batch_id', true);
select kernel.register_audited_table('recipe.ppq_outcome', 'batch_release', 'batch_id', true);
select kernel.register_audited_table('recipe.open_investigation_justification', 'manufacturer_release', 'lot_id', true);
select kernel.register_audited_table('recipe.grel_acknowledgement', 'manufacturer_release', 'lot_id', true);

-- Writes that change what G-REL reads take the epoch lock of their subject (a write after the evaluation waits for the
-- release act, then is seen by the next evaluation): the batch decisions bump the BATCH epoch, the justifications and
-- the samples of a lot its LOT epoch.
create function recipe.epoch_on_release_evidence() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
begin
  if tg_table_name in ('post_change_evaluation', 'ppq_outcome') then
    perform recipe.bump_epoch('BATCH', (to_jsonb(new) ->> 'batch_id')::uuid);
  elsif tg_table_name = 'lot_sample_disposal' then
    perform recipe.bump_epoch('LOT', (select s.lot_id from site.lot_sample s where s.id = (to_jsonb(new) ->> 'sample_id')::uuid));
  else
    perform recipe.bump_epoch('LOT', (to_jsonb(new) ->> 'lot_id')::uuid);
  end if;
  return null;
end
$$;
create trigger zzze_epoch_release after insert on recipe.post_change_evaluation for each row execute function recipe.epoch_on_release_evidence();
create trigger zzze_epoch_release after insert on recipe.ppq_outcome for each row execute function recipe.epoch_on_release_evidence();
create trigger zzze_epoch_release after insert on recipe.open_investigation_justification for each row execute function recipe.epoch_on_release_evidence();
create trigger zzze_epoch_release after insert on site.lot_sample for each row execute function recipe.epoch_on_release_evidence();
create trigger zzze_epoch_release after insert on site.lot_sample_disposal for each row execute function recipe.epoch_on_release_evidence();

-- ---------------------------------------------------------------------------------------------
-- Reads of the evidence set
-- ---------------------------------------------------------------------------------------------

-- The batches whose records a finished lot rests on: its packaging batch, then the processing batch it packs.
create function recipe.release_batches(p_lot uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(array_agg(x order by o), '{}') from (
    select f.batch_id as x, 1 as o from site.finished_lot f where f.lot_id = p_lot
    union all
    select recipe.packaging_parent_of(f.batch_id), 2 from site.finished_lot f where f.lot_id = p_lot) y
  where x is not null
$$;

-- When QA reviewed the lot's own (packaging) record last; NULL when it is not QA reviewed.
create function recipe.release_review_time(p_lot uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select max(a.recorded_at) from recipe.batch_review_act a join site.finished_lot f on f.batch_id = a.batch_id
   where f.lot_id = p_lot and a.act = 'QA_REVIEWED' and a.cycle = recipe.batch_review_cycle(a.batch_id)
$$;

-- The master version and change record a batch was issued on.
create function recipe.batch_master_version(p_batch uuid) returns recipe.mbr_version
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select v.* from recipe.batch_execution b join recipe.control_recipe cr on cr.id = b.control_recipe_id
    join recipe.mbr_version v on v.id = cr.version_id where b.id = p_batch
$$;

-- IN-03 (c): the change record when the batch is the first GMP batch issued on a master version above 1, else NULL.
create function recipe.post_change_record(p_batch uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select v.change_record_id
    from recipe.batch_execution b join recipe.control_recipe cr on cr.id = b.control_recipe_id
    join recipe.mbr_version v on v.id = cr.version_id
   where b.id = p_batch and b.purpose = 'GMP_BATCH' and v.version_number > 1
     and not exists (select 1 from recipe.batch_execution o join recipe.control_recipe ocr on ocr.id = o.control_recipe_id
                      where ocr.version_id = v.id and o.purpose = 'GMP_BATCH' and o.id <> b.id
                        and (o.issued_at, o.id) < (b.issued_at, b.id))
$$;

-- The batch's purpose from its issue (COMMERCIAL, PPQ, EXHIBIT, VALIDATION).
create function recipe.batch_purpose(p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(s.state -> 'header' ->> 'purpose', 'COMMERCIAL') from recipe.execution_state s where s.batch_id = p_batch
$$;

-- The deviation-lite records linked to the lot or a batch of its set (subject, id).
create function recipe.release_deviations(p_lot uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(array_agg(distinct y.deviation_id order by y.deviation_id), '{}') from site.deviation_link y
   where (y.subject_kind = 'LOT' and y.subject_id = p_lot) or y.batch_id = any (recipe.release_batches(p_lot))
      or (y.subject_kind = 'BATCH' and y.subject_id = any (recipe.release_batches(p_lot)))
$$;

-- PR-53: why an open record cannot be released under a justification, or NULL.
create function recipe.investigation_unjustifiable(p_lot uuid, p_deviation uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select case
    when d.id is null then 'the deviation does not exist'
    when d.kind = 'OOS' then format('%s is an OOS record: a specification failure is never released under a justification (PR-53)', d.ref)
    when exists (select 1 from recipe.exception_register r join recipe.exception_register_act a on a.batch_id = r.batch_id and a.exception_id = r.exception_id
                  where r.batch_id = any (recipe.release_batches(p_lot)) and a.act = 'DEVIATION_LINKED' and a.deviation_ref = d.ref
                    and (r.registration_relevant or r.exception_type like any (array['%YIELD%', '%RECONCIL%'])))
      then format('%s concerns a registered limit or a yield or reconciliation discrepancy: never released under a justification (PR-53, PR-08)', d.ref)
  end
  from (select 1) x left join site.deviation d on d.id = p_deviation
$$;

-- The valid justification of an open record for the lot and market, or NULL.
create function recipe.investigation_justification_of(p_lot uuid, p_market text, p_deviation uuid) returns recipe.open_investigation_justification
language sql stable security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
  select j.* from recipe.open_investigation_justification j
   where j.lot_id = p_lot and j.market = p_market and j.deviation_id = p_deviation
     and coalesce((esig.signature_state(j.signature_id) ->> 'valid')::boolean, false)
   order by j.recorded_at desc limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- G-REL
-- ---------------------------------------------------------------------------------------------

create function recipe.grel_core_items(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, records, esig, platform, pg_temp as $$
declare
  f        site.finished_lot;
  l        site.material_lot;
  v_items  jsonb := '[]'::jsonb;
  v_set    uuid[];
  v_rev    timestamptz;
  b        uuid;
  v_bn     text;
  v_prob   text;
  v_ev     jsonb;
  v_since  boolean;
  v_sig    uuid;
  v_n      integer;
  v_open   boolean := platform.setting_text('release.open_investigation_path') = 'ON';
  v_dev    jsonb;
  v_subj   record;
  v_reason text;
  v_why    text;
  v_cr     uuid;
  v_ver    recipe.mbr_version;
  v_out    recipe.ppq_outcome;
  v_purp   text;
  r        record;
begin
  select * into f from site.finished_lot where lot_id = p_lot;
  select * into l from site.material_lot where id = p_lot;
  if f.lot_id is null or l.id is null then
    return jsonb_build_array(recipe.grel_item('G1.LOT', '1', 'Finished lot', 'the lot is no finished lot of a packaging batch'));
  end if;
  v_set := recipe.release_batches(p_lot);
  v_rev := recipe.release_review_time(p_lot);

  -- 1. Evidence set and review.
  v_n := 0;
  foreach b in array v_set loop
    v_n := v_n + 1;
    select x.batch_number into v_bn from recipe.batch_execution x where x.id = b;
    v_prob := recipe.review_disposition_problem(b);
    if v_prob is null then
      select a.signature_id into v_sig from recipe.batch_review_act a
       where a.batch_id = b and a.act = 'QA_REVIEWED' and a.cycle = recipe.batch_review_cycle(b) order by a.recorded_at desc limit 1;
      if not coalesce((esig.signature_state(v_sig) ->> 'valid')::boolean, false) then
        v_prob := 'its QA review signature no longer stands (the reviewed content changed); review it again (DI-37)';
      end if;
    end if;
    v_items := v_items || jsonb_build_array(recipe.grel_item(
      format('G1.REVIEW_%s', v_n), '1',
      format('%s record %s QA reviewed, audit trail covered', initcap(lower(coalesce(recipe.batch_record_kind(b), 'batch'))), v_bn),
      case when v_prob is not null then format('record %s: %s', v_bn, v_prob) end,
      jsonb_build_array(jsonb_build_object('kind', 'BATCH', 'ref', b, 'label', v_bn))));
  end loop;

  -- 2. Deviations and investigations.
  v_ev := '[]'::jsonb;
  v_prob := null;
  v_since := false;
  for v_subj in select 'LOT' as k, p_lot as id union all select 'BATCH', x from unnest(v_set) x loop
    for v_dev in select value from jsonb_array_elements(site.deviation_release_items(v_subj.k, v_subj.id, p_market)) loop
      v_reason := null;
      if (v_dev -> 'blocking') = 'true'::jsonb then
        v_why := v_dev ->> 'reason';
        if v_open and v_dev ->> 'state' not in ('CLOSED', 'CANCELLED') and strpos(coalesce(v_why, ''), 'is not assessed') = 0
           and recipe.investigation_unjustifiable(p_lot, (v_dev ->> 'deviationId')::uuid) is null
           and (recipe.investigation_justification_of(p_lot, p_market, (v_dev ->> 'deviationId')::uuid)).id is not null then
          v_reason := 'JUSTIFIED';
        elsif v_prob is null then
          v_prob := format('deviation %s linked to %s %s is %s: %s (INV-46, PR-49, PR-53)', v_dev ->> 'ref', lower(v_subj.k),
                           case v_subj.k when 'LOT' then l.lot_code else (select x.batch_number from recipe.batch_execution x where x.id = v_subj.id) end,
                           v_dev ->> 'state', v_why);
        end if;
      end if;
      v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'DEVIATION', 'ref', v_dev ->> 'deviationId',
        'label', format('%s %s%s%s', v_dev ->> 'ref', v_dev ->> 'state', case when (v_dev -> 'cancelled') = 'true'::jsonb then ' (cancelled)' else '' end,
                        case when v_reason = 'JUSTIFIED' then ' (open, released under a signed justification)' else '' end)));
      if v_rev is not null and exists (select 1 from recipe.evidence_epoch e where e.subject_kind = 'DEVIATION'
                                         and e.subject_id = (v_dev ->> 'deviationId')::uuid and e.bumped_at > v_rev) then
        v_since := true;
      end if;
    end loop;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G2.DEVIATIONS', '2', format('Deviations closed or assessed with no impact for %s', p_market),
                                                           v_prob, v_ev, v_since));

  select coalesce(jsonb_agg(jsonb_build_object('kind', 'EXCEPTION', 'ref', r2.batch_id || '/' || r2.exception_id,
                    'label', format('%s: %s%s', r2.exception_id, r2.title,
                                    coalesce(' (' || (select a.deviation_ref from recipe.exception_register_act a where a.batch_id = r2.batch_id
                                                       and a.exception_id = r2.exception_id and a.act = 'DEVIATION_LINKED' limit 1) || ')', '')))
                  order by r2.batch_id, r2.exception_id), '[]'::jsonb)
    into v_ev from recipe.exception_register r2 where r2.batch_id = any (v_set) and r2.registration_relevant;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G2.REGISTRATION', '2', 'Registration-relevant deviations (registered or validated limits)', null, v_ev, false,
                                                           case when jsonb_array_length(v_ev) = 0 then 'NA' end));

  v_prob := null;
  v_ev := '[]'::jsonb;
  foreach b in array v_set loop
    v_cr := recipe.post_change_record(b);
    if v_cr is not null then
      v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'CHANGE_RECORD', 'ref', v_cr, 'label', (select c.number from recipe.change_record c where c.id = v_cr)));
      if v_prob is null and not exists (select 1 from recipe.change_record_regulatory g where g.change_record_id = v_cr and g.market = p_market) then
        v_prob := format('change record %s of the master batch %s is the first under holds no regulatory-notification assessment for %s (IN-05 (c), Schedule M 11.3.9 (e))',
                         (select c.number from recipe.change_record c where c.id = v_cr), (select x.batch_number from recipe.batch_execution x where x.id = b), p_market);
      end if;
    end if;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G2.CHANGE_NOTIFICATION', '2', 'Regulatory-notification assessment of the change', v_prob, v_ev, false,
                                                           case when jsonb_array_length(v_ev) = 0 then 'NA' end));

  -- 3. Testing and samples.
  v_prob := site.lot_lims_release_problem(p_lot);
  if v_prob is null then
    select format('the %s result %s %s of the lot is approved by %s, not by the head of QC (IN-05)', r1.test_code, r1.result_value, r1.unit, s.signer_role_code)
      into v_prob
      from site.lot_test_result r1 join site.lot_test_approval a on a.result_id = r1.id join esig.signature s on s.id = a.signature_id
     where r1.lot_id = p_lot and r1.purpose = 'RELEASE' and site.lot_test_is_current(r1.id) and s.signer_role_code is distinct from 'HEAD_OF_QC'
     order by r1.recorded_at, r1.id limit 1;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind', 'LIMS_RESULT', 'ref', r1.id, 'label', format('%s %s %s %s', r1.test_code, r1.result_value, r1.unit, r1.verdict))
                            order by r1.recorded_at, r1.id), '[]'::jsonb)
    into v_ev from site.lot_test_result r1 where r1.lot_id = p_lot and r1.purpose = 'RELEASE' and site.lot_test_is_current(r1.id);
  v_since := v_rev is not null and (exists (select 1 from site.lot_test_result r1 where r1.lot_id = p_lot and r1.recorded_at > v_rev)
                                    or exists (select 1 from site.lot_test_approval a join site.lot_test_result r1 on r1.id = a.result_id
                                                where r1.lot_id = p_lot and a.approved_at > v_rev));
  v_items := v_items || jsonb_build_array(recipe.grel_item('G3.LIMS', '3', 'Release tests passed with head-of-QC approval', v_prob, v_ev, v_since));

  v_prob := null;
  v_ev := '[]'::jsonb;
  foreach b in array v_set loop
    v_prob := coalesce(v_prob, site.extra_testing_problem(b, p_lot), recipe.reprocessing_release_problem(b));
    if v_prob is not null and left(v_prob, 6) <> 'batch ' then
      v_prob := format('batch %s: %s', (select x.batch_number from recipe.batch_execution x where x.id = b), v_prob);
    end if;
    exit when v_prob is not null;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G3.EXTRA_TESTING', '3', 'QC decision on extra testing of reprocessed or recovered material carried out', v_prob));

  select coalesce(jsonb_agg(jsonb_build_object('kind', 'SAMPLE', 'ref', s.id, 'label', format('%s %s %s', s.kind, s.quantity, s.unit)) order by s.pulled_at, s.id), '[]'::jsonb)
    into v_ev from site.lot_sample s where s.lot_id = p_lot and not exists (select 1 from site.lot_sample_disposal d where d.sample_id = s.id);
  v_items := v_items || jsonb_build_array(recipe.grel_item('G3.SAMPLES', '3', 'Reserve samples taken', site.lot_sample_problem(p_lot), v_ev,
    v_rev is not null and exists (select 1 from site.lot_sample s where s.lot_id = p_lot and s.pulled_at > v_rev)));

  -- 5. Materials.
  v_prob := null;
  v_ev := '[]'::jsonb;
  v_since := false;
  for r in select distinct c.lot_id, m.lot_code, c.batch_number, min(c.consumed_at) over (partition by c.lot_id) as first_use
             from site.lot_consumption c join site.material_lot m on m.id = c.lot_id where c.batch_id = any (v_set) order by 2 loop
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'LOT', 'ref', r.lot_id, 'label', format('%s (%s)', r.lot_code, site.lot_state(r.lot_id))));
    if v_prob is null and site.lot_state(r.lot_id) in ('REJECTED', 'RECALLED', 'ON_HOLD') then
      v_prob := format('consumed lot %s is %s now (outline 5.2.7 item 5)', r.lot_code, site.lot_state(r.lot_id));
    end if;
    if v_prob is null and exists (select 1 from site.lot_test_result x where x.lot_id = r.lot_id and x.revises is not null and x.recorded_at > r.first_use) then
      v_prob := format('a QC result of consumed lot %s was revised after the lot was consumed (outline 5.2.7 item 5)', r.lot_code);
    end if;
    if v_rev is not null and exists (select 1 from recipe.evidence_epoch e where e.subject_kind = 'LOT' and e.subject_id = r.lot_id and e.bumped_at > v_rev) then
      v_since := true;
    end if;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G5.MATERIALS', '5', 'Consumed lots not rejected, recalled or on hold, results not revised since use', v_prob, v_ev, v_since));

  -- 6. Licence, change and validation.
  v_prob := null;
  v_ev := '[]'::jsonb;
  foreach b in array v_set loop
    v_ver := recipe.batch_master_version(b);
    v_ev := v_ev || coalesce((select jsonb_agg(jsonb_build_object('kind', 'VALIDATION_REF', 'ref', x.validation_ref, 'label', coalesce(x.description, x.validation_ref)) order by x.recorded_at, x.id)
                                from recipe.change_record_validation x where x.change_record_id = v_ver.change_record_id), '[]'::jsonb);
    if v_prob is null and not exists (select 1 from recipe.change_record_validation x where x.change_record_id = v_ver.change_record_id) then
      v_prob := format('the master of batch %s (version %s) cites no validation report for its processes (Schedule M 11.3.9 (c); PR-09)',
                       (select x.batch_number from recipe.batch_execution x where x.id = b), v_ver.version_number);
    end if;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G6.VALIDATION_BASIS', '6', 'Validation basis of the master present', v_prob, v_ev));

  v_prob := null;
  v_ev := '[]'::jsonb;
  foreach b in array v_set loop
    v_cr := recipe.post_change_record(b);
    continue when v_cr is null;
    select jsonb_build_object('kind', 'SIGNATURE', 'ref', e.signature_id, 'label', 'post-change evaluation of ' || x.batch_number)
      into v_dev from recipe.post_change_evaluation e join recipe.batch_execution x on x.id = e.batch_id
     where e.batch_id = b and coalesce((esig.signature_state(e.signature_id) ->> 'valid')::boolean, false);
    if v_dev is null then
      v_prob := coalesce(v_prob, format('batch %s is the first made under change record %s; QA has not signed its post-change evaluation (IN-03 (c))',
                                        (select x.batch_number from recipe.batch_execution x where x.id = b), (select c.number from recipe.change_record c where c.id = v_cr)));
      v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'BATCH', 'ref', b, 'label', 'post-change evaluation due'));
    else
      v_ev := v_ev || jsonb_build_array(v_dev);
    end if;
    v_dev := null;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G6.POST_CHANGE', '6', 'Post-change evaluation of the first batch after a change', v_prob, v_ev, false,
                                                           case when jsonb_array_length(v_ev) = 0 then 'NA' end));

  v_prob := null;
  v_ev := '[]'::jsonb;
  foreach b in array v_set loop
    v_purp := recipe.batch_purpose(b);
    continue when v_purp not in ('PPQ', 'VALIDATION');
    select * into v_out from recipe.ppq_outcome o where o.batch_id = b and coalesce((esig.signature_state(o.signature_id) ->> 'valid')::boolean, false)
     order by o.recorded_at desc, o.id desc limit 1;
    v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', 'BATCH', 'ref', b,
              'label', format('%s %s: %s', (select x.batch_number from recipe.batch_execution x where x.id = b), v_purp, coalesce(v_out.outcome || ' (' || v_out.protocol_ref || ')', 'no outcome'))));
    if v_prob is null then
      v_prob := case
        when v_out.id is null then format('batch %s was made under a %s protocol and its validation outcome is not recorded (PR-09)', (select x.batch_number from recipe.batch_execution x where x.id = b), v_purp)
        when v_out.outcome = 'FAILED' then format('the validation outcome of batch %s is FAILED (PR-09)', (select x.batch_number from recipe.batch_execution x where x.id = b))
        when v_out.outcome = 'CONCURRENT_RELEASE' and p_market <> 'US'
          then format('batch %s is released concurrently under protocol %s, which is allowed for the US only; for %s it waits for the validation outcome (PR-09, D-P4-6)',
                      (select x.batch_number from recipe.batch_execution x where x.id = b), v_out.protocol_ref, p_market)
      end;
    end if;
    v_out := null;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G6.PPQ', '6', 'Validation outcome or concurrent-release rule of protocol batches', v_prob, v_ev, false,
                                                           case when jsonb_array_length(v_ev) = 0 then 'NA' end));
  v_items := v_items || jsonb_build_array(recipe.grel_item('G6.LICENCE', '6', 'Licence, product approval and export permission (slice 6a)', null, '[]'::jsonb, false, 'NA'));

  -- 7. Incidents, DI investigations and holds.
  v_prob := null;
  v_ev := '[]'::jsonb;
  v_since := false;
  for v_subj in select 'material_lot' as k, p_lot as id, l.lot_code as label union all
                select 'batch', x, (select y.batch_number from recipe.batch_execution y where y.id = x) from unnest(v_set) x loop
    for r in select * from records.open_blockers(v_subj.k, v_subj.id::text) loop
      v_ev := v_ev || jsonb_build_array(jsonb_build_object('kind', r.blocker_kind, 'ref', r.blocker_id,
                'label', format('%s %s %s%s on %s', r.reference, r.status, coalesce(r.severity, ''), case when r.blocks_disposition then ' (not assessed)' else ' (assessed)' end, v_subj.label)));
      if v_prob is null and r.blocks_disposition then
        v_prob := format('%s %s (%s) linked to %s blocks the disposition until it is assessed for it or closed (DI-12, DI-50)',
                         lower(replace(r.blocker_kind, '_', ' ')), r.reference, r.status, v_subj.label);
      end if;
      if v_rev is not null and r.since > v_rev then
        v_since := true;
      end if;
    end loop;
  end loop;
  v_items := v_items || jsonb_build_array(recipe.grel_item('G7.INCIDENTS', '7', 'No unassessed incident, open DI investigation or hold', v_prob, v_ev, v_since));

  -- 8. Market-add evaluation (slice 4).
  v_items := v_items || jsonb_build_array(recipe.grel_item('G8.MARKET_ADD', '8', 'No unmet market-add item (slice 4)', null, '[]'::jsonb, false, 'NA'));
  return v_items;
end
$$;

-- The evidence versions an evaluation rests on (the epoch's first half).
create function recipe.grel_versions(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, records, pg_temp as $$
  select jsonb_build_object(
    'batches', (select coalesce(jsonb_agg(jsonb_build_array(x, recipe.epoch_of('BATCH', x),
                                                            coalesce((select e.version from records.blocker_epoch e where e.record_key = records.record_key('batch', x::text)), 0)) order by x), '[]'::jsonb)
                  from unnest(recipe.release_batches(p_lot)) x),
    'lot', jsonb_build_array(recipe.epoch_of('LOT', p_lot),
                             coalesce((select e.version from records.blocker_epoch e where e.record_key = records.record_key('material_lot', p_lot::text)), 0)),
    'consumed', (select coalesce(jsonb_agg(jsonb_build_array(c.lot_id, recipe.epoch_of('LOT', c.lot_id)) order by c.lot_id), '[]'::jsonb)
                   from (select distinct lc.lot_id from site.lot_consumption lc where lc.batch_id = any (recipe.release_batches(p_lot))) c),
    'deviations', (select coalesce(jsonb_agg(jsonb_build_array(d, recipe.epoch_of('DEVIATION', d)) order by d), '[]'::jsonb)
                     from unnest(recipe.release_deviations(p_lot)) d))
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

create function recipe.manufacturer_decision(p_lot uuid) returns recipe.manufacturer_release_decision
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select d.* from recipe.manufacturer_release_decision d where d.lot_id = p_lot
$$;

create or replace function recipe.manufacturer_release_state(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((recipe.manufacturer_decision(p_lot)).decision,
                  case when (recipe.grel_evaluate(p_lot, 'IN') ->> 'ready')::boolean then 'READY' else 'NOT_READY' end)
$$;

-- The decision the manufacturer release recorded for the lot in this transaction (site 0860's guard), or NULL.
create function recipe.manufacturer_decision_in_xact(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select d.decision from recipe.manufacturer_release_decision d where d.lot_id = p_lot and d.xact_id = pg_current_xact_id()
$$;

-- INV-35: everyone involved in the records of the lot's evidence set (performers, production approvers, other signers).
create function recipe.release_involvement(p_lot uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(distinct p order by p), '{}') from unnest(recipe.release_batches(p_lot)) b, unnest(recipe.batch_involvement(b)) p
$$;

-- The scope of the lot's release acts: the packaging batch's scope (site, product).
create function recipe.release_scope(p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, plant, pg_temp as $$
declare
  v_batch uuid;
begin
  select f.batch_id into v_batch from site.finished_lot f where f.lot_id = p_lot;
  if v_batch is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-010 %s is no finished lot of a packaging batch', coalesce(p_lot::text, 'NULL'));
  end if;
  return plant.batch_scope(v_batch);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Content providers
-- ---------------------------------------------------------------------------------------------

create function recipe.manufacturer_release_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, plant, pg_temp as $$
declare
  m  text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(RELEASE|REJECT)$');
  f  site.finished_lot;
  l  site.material_lot;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into f from site.finished_lot where lot_id = m[1]::uuid;
  select * into l from site.material_lot where id = m[1]::uuid;
  if f.lot_id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('lot_id', l.id, 'lot_code', l.lot_code, 'product_code', f.product_code, 'strength', f.strength,
                                  'markets', to_jsonb(f.markets), 'batch_id', f.batch_id, 'batch_number', f.batch_number,
                                  'decision', case m[2] when 'RELEASE' then 'RELEASED' else 'REJECTED' end,
                                  -- Once decided, the checklist stored with the decision (the signed content stays what was signed).
                                  'checklist', coalesce((select d.checklist from recipe.manufacturer_release_decision d
                                                          where d.lot_id = l.id and d.decision = case m[2] when 'RELEASE' then 'RELEASED' else 'REJECTED' end),
                                                        recipe.grel_evaluate(l.id, 'IN'))),
    'market', 'IN',
    'state', recipe.manufacturer_release_state(l.id),
    'scope', recipe.release_scope(l.id),
    'involved', to_jsonb(recipe.release_involvement(l.id)));
end
$$;

create function recipe.post_change_evaluation_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  m  text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{64})$');
  b  recipe.batch_execution;
  v  recipe.mbr_version;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.batch_execution where id = m[1]::uuid and purpose = 'GMP_BATCH';
  if b.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  v := recipe.batch_master_version(b.id);
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'content', jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'version_id', v.id, 'version_number', v.version_number,
                                  'change_record', (select c.number from recipe.change_record c where c.id = recipe.post_change_record(b.id)),
                                  'evaluation_sha256', m[2]),
    'state', recipe.batch_review_state(b.id),
    'scope', plant.batch_scope(b.id),
    'involved', to_jsonb(recipe.batch_involvement(b.id)));
end
$$;

create function recipe.ppq_outcome_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  m  text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(PASSED|FAILED|CONCURRENT_RELEASE)/([0-9a-f]{64})$');
  b  recipe.batch_execution;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.batch_execution where id = m[1]::uuid and purpose = 'GMP_BATCH';
  if b.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'content', jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'purpose', recipe.batch_purpose(b.id),
                                  'outcome', m[2], 'statement_sha256', m[3]),
    'state', recipe.batch_review_state(b.id),
    'scope', plant.batch_scope(b.id),
    'involved', to_jsonb(recipe.batch_involvement(b.id)));
end
$$;

create function recipe.investigation_justification_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  m  text[] := regexp_match(coalesce(p_id, ''),
                 '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(IN|US|EU)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{64})$');
  d  site.deviation;
begin
  if m is null or not exists (select 1 from site.finished_lot f where f.lot_id = m[1]::uuid) then
    return '{"exists": false}'::jsonb;
  end if;
  select * into d from site.deviation where id = m[3]::uuid;
  if d.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'content', jsonb_build_object('lot_id', m[1], 'market', m[2], 'deviation_id', d.id, 'deviation_ref', d.ref, 'deviation_kind', d.kind,
                                  'deviation_state', site.deviation_state(d.id), 'justification_sha256', m[4]),
    'market', m[2],
    -- The record's state is the investigation's (never G-REL: G-REL reads this signature's validity).
    'state', site.deviation_state(d.id),
    'scope', recipe.release_scope(m[1]::uuid),
    'involved', to_jsonb(recipe.release_involvement(m[1]::uuid)));
end
$$;

select esig.register_content_provider('manufacturer_release', 'recipe.manufacturer_release_content(text)',
  'The manufacturer release of a finished lot: the G-REL checklist for IN and the decision (Phase 4 slice 3a; IN-05 (d))');
select esig.register_content_provider('post_change_evaluation', 'recipe.post_change_evaluation_content(text)',
  'QA''s evaluation of the first batch made under a changed master (IN-03 (c))');
select esig.register_content_provider('ppq_outcome', 'recipe.ppq_outcome_content(text)',
  'The validation outcome of a batch made under a protocol (PR-09)');
select esig.register_content_provider('investigation_justification', 'recipe.investigation_justification_content(text)',
  'The release authority''s justification for releasing a lot while an investigation is open (PR-53)');

-- ---------------------------------------------------------------------------------------------
-- Acts
-- ---------------------------------------------------------------------------------------------

-- Why an act on the lot is not possible now (the cockpit shows them; the acts raise them). Acts: RELEASE, REJECT.
create function recipe.release_gate_problems(p_lot uuid, p_act text) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_out   text[] := '{}';
  d       recipe.manufacturer_release_decision := recipe.manufacturer_decision(p_lot);
  l       site.material_lot;
  g       jsonb;
  i       jsonb;
begin
  select * into l from site.material_lot where id = p_lot;
  if not exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    return array['the lot is no finished lot of a packaging batch'];
  end if;
  if d.lot_id is not null then
    return array[format('the manufacturer release of lot %s is %s', l.lot_code, d.decision)];
  end if;
  if site.lot_state(p_lot) is distinct from 'QUARANTINE' then
    v_out := v_out || format('lot %s is %s, not in quarantine', l.lot_code, site.lot_state(p_lot));
  end if;
  if (select s.machine_version from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = p_lot) < 2 then
    v_out := v_out || format('lot %s was posted before the release model (material lot machine version 1); it cannot leave quarantine through it', l.lot_code);
  end if;
  if p_act = 'RELEASE' then
    g := recipe.grel_evaluate(p_lot, 'IN');
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if i ->> 'status' = 'RED' then
        v_out := v_out || format('G-REL item %s is RED: %s', i ->> 'id', i ->> 'problem');
      end if;
    end loop;
  elsif p_act is distinct from 'REJECT' then
    v_out := v_out || format('%s is no act of the manufacturer release (RELEASE or REJECT)', coalesce(p_act, 'NULL'));
  end if;
  return v_out;
end
$$;

create function recipe.record_manufacturer_release(p_lot uuid, p_decision text, p_signature uuid, p_expected_epoch text, p_reason text)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, records, pg_temp as $$
declare
  v_actor   jsonb;
  v_scope   jsonb;
  l         site.material_lot;
  v_sig     jsonb;
  v_prob    text;
  v_deleg   jsonb;
  b         uuid;
  d         uuid;
  g         jsonb;
  i         jsonb;
  v_red     text[] := '{}';
  v_content text;
  v_id      text := p_lot::text || '/' || coalesce(p_decision, '');
  v_from    platform.aggregate_state;
  v_role    text;
  v_deleg_id uuid;
begin
  perform iam.assert_not_administrator();
  if p_decision is null or p_decision not in ('RELEASE', 'REJECT') then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-011 %s is no decision of the manufacturer release (RELEASE or REJECT)', coalesce(p_decision, 'NULL'));
  end if;
  v_scope := recipe.release_scope(p_lot);
  v_actor := iam.require_permission('RELEASE.MANUFACTURER', v_scope);

  -- The locks of everything G-REL reads (outline 5.7): the lot, the records, then every evidence version.
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

  if (recipe.manufacturer_decision(p_lot)).lot_id is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-012 the manufacturer release of lot %s is already %s', l.lot_code, (recipe.manufacturer_decision(p_lot)).decision);
  end if;

  -- INV-05: G-REL again, under the locks, at the epoch the signer evaluated, first (the signature is checked against it below).
  g := recipe.grel_evaluate(p_lot, 'IN');
  if p_expected_epoch is null or p_expected_epoch is distinct from g ->> 'epoch' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REL-018 the evidence of lot %s changed after it was evaluated (epoch %s, now %s); evaluate G-REL again (INV-05, DI-37)',
                       l.lot_code, coalesce(left(p_expected_epoch, 12), 'none given'), left(g ->> 'epoch', 12));
  end if;

  -- The signature: this record, this meaning, valid, the actor's own, as the AP or a delegate with a valid delegation.
  v_prob := coalesce(esig.signature_problem(p_signature, 'MANUFACTURER_RELEASE', 'manufacturer_release', v_id), esig.signature_state_problem(p_signature));
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-013 %s (DI-35, DI-37)', v_prob);
  end if;
  v_sig := esig.signature_state(p_signature);
  if (v_sig ->> 'signer_person')::uuid is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-013 the manufacturer release is recorded by the person who signed it (DI-14, S16)';
  end if;
  select s.signer_role_code, s.delegation_id into v_role, v_deleg_id from esig.signature s where s.id = p_signature;
  if v_role is distinct from 'AUTHORISED_PERSON' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REL-014 the manufacturer release is signed by the authorised person or a named delegate in that role, not as %s (IN-05 (b))', coalesce(v_role, 'no role'));
  end if;
  if v_deleg_id is not null then
    v_deleg := iam.delegation_valid(v_deleg_id, (v_sig ->> 'signer_person')::uuid, 'MANUFACTURER_RELEASE', v_scope, 'IN', clock_timestamp());
    if not (v_deleg ->> 'valid')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REL-015 the delegation the signer cited is no longer valid: %s (IN-05 (b), outline 7.1)', v_deleg -> 'reasons');
    end if;
  end if;
  -- INV-35 (the kernel refuses it at signing; the record keeps its own copy of the rule).
  if (v_actor ->> 'person_id')::uuid = any (recipe.release_involvement(p_lot)) then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-016 a person involved in the lot''s records never decides its release (INV-35, IN-05)';
  end if;
  if p_decision = 'RELEASE' then
    foreach b in array array[p_lot] || recipe.release_batches(p_lot) loop
      v_prob := site.deviation_release_problem(case when b = p_lot then 'LOT' else 'BATCH' end, b, 'IN', (v_actor ->> 'person_id')::uuid);
      if v_prob is not null and strpos(v_prob, 'cancelled') > 0 then
        raise exception using errcode = 'P0001', message = format('EBMR-REL-017 %s', v_prob);
      end if;
    end loop;
  end if;

  -- INV-05: the signed checklist is the current one.
  v_content := esig.content_hash_of('manufacturer_release', v_id, esig.provide('manufacturer_release', v_id));
  if v_content is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-018 the signed checklist is not the current one; sign the current evaluation (INV-05, IN-05 (d))';
  end if;
  if site.lot_state(p_lot) is distinct from 'QUARANTINE' then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-019 lot %s is %s: the manufacturer release decides a lot in quarantine', l.lot_code, site.lot_state(p_lot));
  end if;

  if p_decision = 'RELEASE' then
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if i ->> 'status' = 'RED' then
        v_red := v_red || format('%s: %s', i ->> 'id', i ->> 'problem');
      end if;
    end loop;
    if cardinality(v_red) > 0 then
      raise exception using errcode = 'P0001', message = format('EBMR-REL-020 lot %s is not READY: %s (IN-05, INV-05)', l.lot_code, array_to_string(v_red, '; '));
    end if;
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if (i -> 'since_review') = 'true'::jsonb and not exists (
           select 1 from recipe.grel_acknowledgement a where a.lot_id = p_lot and a.market = 'IN' and a.item_id = i ->> 'id'
              and a.epoch = g ->> 'epoch' and a.person_id = (v_actor ->> 'person_id')::uuid) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-REL-021 item %s changed after the QA review; the signer acknowledges it at the current evaluation before releasing (outline 5.2.7 item 1)', i ->> 'id');
      end if;
    end loop;
  elsif p_reason is null or recipe.reason_is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-022 a rejection states the person''s own reason (DI-22, L-20)';
  end if;

  insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, delegation_id, reason, epoch, checklist, checklist_hash, content_hash,
                                                     person_id, account_id, role_code, correlation_id)
  values (p_lot, case p_decision when 'RELEASE' then 'RELEASED' else 'REJECTED' end, p_signature, v_deleg_id,
          nullif(btrim(coalesce(p_reason, '')), ''), g ->> 'epoch', g, encode(sha256(convert_to(g::text, 'UTF8')), 'hex'), v_content,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_role, (v_actor ->> 'correlation_id')::uuid);
  -- IN-05 (a): the finished lot leaves quarantine through this act only (material_lot v2, site services 0860, 0861).
  select * into v_from from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = p_lot;
  perform site.lot_transition(l, case p_decision when 'RELEASE' then 'MANUFACTURER_RELEASE' else 'MANUFACTURER_REJECT' end, v_from.version, p_signature, null);
  return p_signature;
end
$$;

create function recipe.record_post_change_evaluation(p_batch uuid, p_evaluation text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_cr    uuid;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.QA_REVIEW', plant.batch_scope(p_batch));
  perform recipe.lock_epoch('BATCH', p_batch);
  v_cr := recipe.post_change_record(p_batch);
  if v_cr is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-030 the batch is not the first made under a changed master; no post-change evaluation is due (IN-03 (c))';
  end if;
  if recipe.batch_review_state(p_batch) is distinct from 'QA_REVIEWED' then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-031 the record is %s; the post-change evaluation follows its QA review (IN-03 (c))', recipe.batch_review_state(p_batch));
  end if;
  if exists (select 1 from recipe.post_change_evaluation e where e.batch_id = p_batch) then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-032 the post-change evaluation of the batch is already recorded';
  end if;
  if p_evaluation is null or recipe.reason_is_blank(p_evaluation) then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-033 the post-change evaluation states what was evaluated and found (IN-03 (c))';
  end if;
  perform recipe.assert_release_signature(p_signature, 'POST_CHANGE_EVALUATED', 'post_change_evaluation',
                                          p_batch::text || '/' || encode(sha256(convert_to(btrim(p_evaluation), 'UTF8')), 'hex'), (v_actor ->> 'person_id')::uuid);
  insert into recipe.post_change_evaluation (batch_id, version_id, change_record_id, evaluation, signature_id, person_id, account_id)
  values (p_batch, (recipe.batch_master_version(p_batch)).id, v_cr, btrim(p_evaluation), p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.ppq_statement_hash(p_protocol text, p_statement text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(btrim(coalesce(p_protocol, '')) || E'\n' || btrim(coalesce(p_statement, '')), 'UTF8')), 'hex')
$$;

create function recipe.record_ppq_outcome(p_batch uuid, p_outcome text, p_protocol text, p_statement text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_last  text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.QA_REVIEW', plant.batch_scope(p_batch));
  perform recipe.lock_epoch('BATCH', p_batch);
  if recipe.batch_purpose(p_batch) not in ('PPQ', 'VALIDATION') then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-034 the batch was made for %s, under no validation protocol (PR-09)', recipe.batch_purpose(p_batch));
  end if;
  if p_outcome is null or p_outcome not in ('PASSED', 'FAILED', 'CONCURRENT_RELEASE') then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-035 %s is no validation outcome (PASSED, FAILED or CONCURRENT_RELEASE)', coalesce(p_outcome, 'NULL'));
  end if;
  select o.outcome into v_last from recipe.ppq_outcome o where o.batch_id = p_batch order by o.recorded_at desc, o.id desc limit 1;
  if v_last in ('PASSED', 'FAILED') then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-036 the validation outcome of the batch is already %s; it is final (PR-09)', v_last);
  end if;
  if v_last = 'CONCURRENT_RELEASE' and p_outcome = 'CONCURRENT_RELEASE' then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-036 concurrent release of the batch is already recorded; the next record is its outcome (PR-09)';
  end if;
  if p_outcome = 'CONCURRENT_RELEASE' and recipe.batch_review_state(p_batch) is distinct from 'QA_REVIEWED' then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-037 concurrent release is recorded on the batch''s complete protocol results, after its QA review (PR-09)';
  end if;
  if p_protocol is null or recipe.reason_is_blank(p_protocol) or p_statement is null or recipe.reason_is_blank(p_statement) then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-035 a validation outcome names its protocol and states what was found (PR-09)';
  end if;
  perform recipe.assert_release_signature(p_signature, 'VALIDATION_OUTCOME_RECORDED', 'ppq_outcome',
                                          p_batch::text || '/' || p_outcome || '/' || recipe.ppq_statement_hash(p_protocol, p_statement), (v_actor ->> 'person_id')::uuid);
  insert into recipe.ppq_outcome (batch_id, outcome, protocol_ref, statement, signature_id, person_id, account_id)
  values (p_batch, p_outcome, btrim(p_protocol), btrim(p_statement), p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.justify_open_investigation(p_lot uuid, p_market text, p_deviation uuid, p_text text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, platform, pg_temp as $$
declare
  v_actor jsonb;
  v_scope jsonb;
  v_prob  text;
  v_state text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_scope := recipe.release_scope(p_lot);
  if p_market is null or p_market <> 'IN' then
    -- The US and EU release authorities justify through their own dispositions (slice 4).
    raise exception using errcode = 'P0001', message = format('EBMR-REL-040 an open investigation is justified for the manufacturer release (IN) here, not for %s', coalesce(p_market, 'NULL'));
  end if;
  v_actor := iam.require_permission('RELEASE.MANUFACTURER', v_scope);
  if platform.setting_text('release.open_investigation_path') <> 'ON' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REL-041 the open-investigation path is off: a lot is released only once every linked investigation is closed or assessed with no impact (PR-53)';
  end if;
  perform recipe.lock_epoch('LOT', p_lot);
  if not (p_deviation = any (recipe.release_deviations(p_lot))) then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-042 the deviation is not linked to the lot or a batch of its records';
  end if;
  v_state := site.deviation_state(p_deviation);
  if v_state in ('CLOSED', 'CANCELLED') then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-042 the deviation is %s: only an open investigation is justified (PR-53)', v_state);
  end if;
  v_prob := recipe.investigation_unjustifiable(p_lot, p_deviation);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-043 %s', v_prob);
  end if;
  if p_text is null or recipe.reason_is_blank(p_text) then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-044 the justification states why the investigation is advanced enough to support the decision (PR-53)';
  end if;
  perform recipe.assert_release_signature(p_signature, 'OPEN_INVESTIGATION_JUSTIFIED', 'investigation_justification',
    p_lot::text || '/' || p_market || '/' || p_deviation::text || '/' || encode(sha256(convert_to(btrim(p_text), 'UTF8')), 'hex'), (v_actor ->> 'person_id')::uuid);
  insert into recipe.open_investigation_justification (lot_id, market, deviation_id, justification, signature_id, person_id, account_id)
  values (p_lot, p_market, p_deviation, btrim(p_text), p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.acknowledge_release_item(p_lot uuid, p_market text, p_item text, p_epoch text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb;
  g       jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission(case p_market when 'US' then 'RELEASE.US_DISPOSITION' when 'EU' then 'RECORD.QA_REVIEW' else 'RELEASE.MANUFACTURER' end,
                                    recipe.release_scope(p_lot));
  g := recipe.grel_evaluate(p_lot, p_market);
  if p_epoch is distinct from g ->> 'epoch' then
    raise exception using errcode = 'P0001', message = 'EBMR-REL-050 the evidence changed since it was shown; acknowledge the item in the current evaluation (INV-05)';
  end if;
  if not exists (select 1 from jsonb_array_elements(g -> 'items') i where i ->> 'id' = p_item and (i -> 'since_review') = 'true'::jsonb) then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-051 %s is no item that changed after the QA review', coalesce(p_item, 'NULL'));
  end if;
  insert into recipe.grel_acknowledgement (lot_id, market, item_id, epoch, person_id, account_id)
  values (p_lot, p_market, p_item, p_epoch, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  on conflict (lot_id, market, item_id, epoch, person_id) do nothing
  returning id into v_id;
  return coalesce(v_id, (select a.id from recipe.grel_acknowledgement a where a.lot_id = p_lot and a.market = p_market and a.item_id = p_item
                                                                            and a.epoch = p_epoch and a.person_id = (v_actor ->> 'person_id')::uuid));
end
$$;

-- The signature of a release-side act: this record, this meaning, valid, in the record's state, the actor's own.
create function recipe.assert_release_signature(p_signature uuid, p_meaning text, p_type text, p_id text, p_person uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_prob text := coalesce(esig.signature_problem(p_signature, p_meaning, p_type, p_id), esig.signature_state_problem(p_signature));
  v      jsonb;
begin
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-013 %s (DI-35, DI-37)', v_prob);
  end if;
  v := esig.signature_state(p_signature);
  if (v ->> 'signer_person')::uuid is distinct from p_person then
    raise exception using errcode = 'P0001', message = format('EBMR-REL-013 %s is recorded by the person who signed it (DI-14, S16)', p_meaning);
  end if;
  return v;
end
$$;

revoke all on function recipe.epoch_on_release_evidence(), recipe.release_batches(uuid), recipe.release_review_time(uuid), recipe.batch_master_version(uuid),
  recipe.post_change_record(uuid), recipe.batch_purpose(uuid), recipe.release_deviations(uuid), recipe.investigation_unjustifiable(uuid, uuid),
  recipe.investigation_justification_of(uuid, text, uuid), recipe.grel_core_items(uuid, text), recipe.grel_versions(uuid), recipe.manufacturer_decision(uuid),
  recipe.manufacturer_decision_in_xact(uuid), recipe.release_involvement(uuid), recipe.release_scope(uuid),
  recipe.manufacturer_release_content(text), recipe.post_change_evaluation_content(text), recipe.ppq_outcome_content(text),
  recipe.investigation_justification_content(text), recipe.release_gate_problems(uuid, text),
  recipe.record_manufacturer_release(uuid, text, uuid, text, text), recipe.record_post_change_evaluation(uuid, text, uuid),
  recipe.ppq_statement_hash(text, text), recipe.record_ppq_outcome(uuid, text, text, text, uuid), recipe.justify_open_investigation(uuid, text, uuid, text, uuid),
  recipe.acknowledge_release_item(uuid, text, text, text), recipe.assert_release_signature(uuid, text, text, text, uuid) from public;
grant execute on function recipe.release_batches(uuid), recipe.release_review_time(uuid), recipe.release_involvement(uuid), recipe.post_change_record(uuid), recipe.batch_purpose(uuid),
  recipe.release_deviations(uuid), recipe.manufacturer_decision(uuid), recipe.release_gate_problems(uuid, text), recipe.ppq_statement_hash(text, text),
  recipe.record_manufacturer_release(uuid, text, uuid, text, text), recipe.record_post_change_evaluation(uuid, text, uuid),
  recipe.record_ppq_outcome(uuid, text, text, text, uuid), recipe.justify_open_investigation(uuid, text, uuid, text, uuid),
  recipe.acknowledge_release_item(uuid, text, text, text) to ebmr_app;

reset role;
