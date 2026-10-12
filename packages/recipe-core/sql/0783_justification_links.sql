-- Recipe core: the PR-53 justification after the slice 3 quick review (core mediums 1 to 3; PR-53, PR-08, INV-46,
-- D-2a-9; ADR 0012). Each function is replaced from its latest definition (0781); nothing else changes.
--
--   * Medium 1: whether an open record may be released under a justification was decided from the text of the first
--     blocking reason (it searched for "is not assessed"). recipe.investigation_unjustifiable_for(lot, market, deviation)
--     now reads every link of the record to the lot, a batch of its records or their containers structurally: each needs
--     an impact row for the market (site.deviation_latest_impact). recipe.grel_core_items and
--     recipe.justify_open_investigation call it; no message text is matched.
--   * Medium 2 (default D-3a-10, open for the owner): a link whose latest impact for the market is CONFIRMED is never
--     released under a justification, the record open or closed (as D-2a-9 keeps it blocking after closure).
--   * Medium 3: recipe.investigation_unjustifiable counted only DEVIATION_LINKED acts of the exception register; any act
--     that names the record (an exception ESCALATED to it in QA review included) now counts.
-- Messages: EBMR-REL-043 (unchanged code, new reasons).

set local role ebmr_owner;

create or replace function recipe.investigation_unjustifiable(p_lot uuid, p_deviation uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select case
    when d.id is null then 'the deviation does not exist'
    when d.kind = 'OOS' then format('%s is an OOS record: a specification failure is never released under a justification (PR-53)', d.ref)
    when exists (select 1 from recipe.exception_register r join recipe.exception_register_act a on a.batch_id = r.batch_id and a.exception_id = r.exception_id
                  where r.batch_id = any (recipe.release_batches(p_lot)) and a.deviation_ref = d.ref
                    and (r.registration_relevant or r.exception_type like any (array['%YIELD%', '%RECONCIL%'])))
      then format('%s concerns a registered limit or a yield or reconciliation discrepancy: never released under a justification (PR-53, PR-08)', d.ref)
  end
  from (select 1) x left join site.deviation d on d.id = p_deviation
$$;

-- PR-53 (header): why the open record cannot be released under a justification for the lot and market, or NULL.
create function recipe.investigation_unjustifiable_for(p_lot uuid, p_market text, p_deviation uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_set  uuid[] := recipe.release_batches(p_lot);
  y      site.deviation_link;
  i      site.deviation_impact;
  v_ref  text := (select d.ref from site.deviation d where d.id = p_deviation);
  v_n    integer := 0;
begin
  v_ref := coalesce(v_ref, '(unknown)');
  for y in select x.* from site.deviation_link x
            where x.deviation_id = p_deviation
              and ((x.subject_kind = 'LOT' and x.subject_id = p_lot) or x.batch_id = any (v_set) or (x.subject_kind = 'BATCH' and x.subject_id = any (v_set)))
            order by x.linked_at, x.id loop
    v_n := v_n + 1;
    i := site.deviation_latest_impact(y.id, p_market);
    if i.id is null then
      return format('%s: its link to %s %s is not assessed for %s; every link is assessed before a justification (PR-53, IN-05 (c))',
                    v_ref, lower(y.subject_kind), y.subject_ref, p_market);
    end if;
    if i.impact = 'CONFIRMED' then
      return format('%s: its impact on %s %s for %s is CONFIRMED; a confirmed impact is never released under a justification (PR-53, D-2a-9, D-3a-10)',
                    v_ref, lower(y.subject_kind), y.subject_ref, p_market);
    end if;
  end loop;
  if v_n = 0 then
    return format('%s is not linked to the lot or a batch of its records', v_ref);
  end if;
  return recipe.investigation_unjustifiable(p_lot, p_deviation);
end
$$;

create or replace function recipe.grel_core_items(p_lot uuid, p_market text) returns jsonb
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
        if v_open and v_dev ->> 'state' not in ('CLOSED', 'CANCELLED')
           and recipe.investigation_unjustifiable_for(p_lot, p_market, (v_dev ->> 'deviationId')::uuid) is null
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

create or replace function recipe.justify_open_investigation(p_lot uuid, p_market text, p_deviation uuid, p_text text, p_signature uuid) returns uuid
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
  v_prob := recipe.investigation_unjustifiable_for(p_lot, p_market, p_deviation);
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

revoke all on function recipe.investigation_unjustifiable_for(uuid, text, uuid) from public;

reset role;
