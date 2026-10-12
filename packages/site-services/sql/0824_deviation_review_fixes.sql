-- The full deviation stand-in after the slice 2 quick review (Phase 4 slice 2a; HIGH 2 and 3, MEDIUM 4).
--
-- HIGH 2 (INV-03, S7; D-2a-1): the QA person who classified a record, and a person who recorded an impact of it, are
--   performers: site.deviation_content (0820) names them in entered_by, and site.assert_deviation_qa_signature (0821)
--   refuses them a conclusion or closure (EBMR-SITE-832), besides the signature service.
-- HIGH 3 (no self-approval): site.assess_deviation_impact (0821) refuses the classifier (EBMR-SITE-833) and a person who
--   recorded an impact row of the record (EBMR-SITE-834).
-- MEDIUM 4 (D-2a-9, default taken, open for the owner): site.deviation_release_items (0822) kept a CLOSED record from
--   blocking whatever its impact. A link whose latest impact for the market is CONFIRMED now keeps the subject blocked
--   after closure: the subject is rejected, or released only through a signed QA disposition of that link (a later
--   slice). A link assessed NONE or POTENTIAL is ended by the closure.
--
-- Each function is re-created from its latest definition (0820, 0821, 0822); CREATE OR REPLACE keeps owners and grants.
-- Messages: EBMR-SITE-832 to 834.

set local role ebmr_owner;

-- As 0820_deviation_full_records.sql; classifiers and impact recorders in entered_by (header).
create or replace function site.deviation_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  d  site.deviation;
  f  site.deviation_finding;
  k  site.deviation_classification;
  b  site.deviation_closure_basis;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into d from site.deviation where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  f := site.deviation_latest_finding(d.id);
  k := site.deviation_latest_classification(d.id);
  b := site.deviation_latest_closure_basis(d.id);
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from site.deviation_link l where l.deviation_id = d.id)
                         + (select count(*) from site.deviation_event e where e.deviation_id = d.id)
                         + (select count(*) from site.deviation_finding x where x.deviation_id = d.id)
                         + (select count(*) from site.deviation_conclusion c where c.deviation_id = d.id)
                         + (select count(*) from site.deviation_classification x where x.deviation_id = d.id)
                         + (select count(*) from site.deviation_impact x where x.deviation_id = d.id)
                         + (select count(*) from site.deviation_impact_signoff x where x.deviation_id = d.id)
                         + (select count(*) from site.deviation_closure_basis x where x.deviation_id = d.id),
    'content', jsonb_build_object(
      'ref', d.ref, 'site_code', d.site_code, 'kind', d.kind, 'title', d.title, 'description', d.description,
      'classification', d.classification, 'risk_rationale', d.risk_rationale, 'raised_by', d.raised_by_person,
      'raised_at', site.utc_text(d.raised_at),
      'links', (select coalesce(jsonb_agg(jsonb_build_object('link_id', l.id, 'subject_kind', l.subject_kind, 'subject_id', l.subject_id, 'subject_ref', l.subject_ref,
                                                             'batch_number', l.batch_number, 'edition', l.edition)
                                          order by l.linked_at, l.id), '[]'::jsonb)
                from site.deviation_link l where l.deviation_id = d.id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'reason', e.reason, 'by', e.person_id) order by e.recorded_at, e.id), '[]'::jsonb)
                 from site.deviation_event e where e.deviation_id = d.id),
      'qa_classification', case when k.id is null then null
                                else jsonb_build_object('id', k.id, 'classification', k.classification, 'risk_rationale', k.risk_rationale,
                                                        'risk_document_id', k.risk_document_id, 'owner', k.owner_person, 'due_date', k.due_date::text,
                                                        'by', k.classified_by_person) end,
      'impacts', (select coalesce(jsonb_agg(jsonb_build_object('link_id', i.link_id, 'market', i.market, 'impact', i.impact, 'rationale', i.rationale,
                                                               'by', i.recorded_by_person) order by i.seq), '[]'::jsonb)
                  from site.deviation_impact i where i.deviation_id = d.id),
      'impact_signoffs', (select coalesce(jsonb_agg(jsonb_build_object('covers', s.covers_seq, 'by', s.person_id) order by s.seq), '[]'::jsonb)
                          from site.deviation_impact_signoff s where s.deviation_id = d.id),
      'finding', case when f.id is null then null
                      else jsonb_build_object('id', f.id, 'assignable_cause', f.assignable_cause, 'cause', f.cause,
                                              'root_cause_category', f.root_cause_category, 'recorded_by', f.recorded_by_person) end,
      'closure_basis', case when b.id is null then null
                            else jsonb_build_object('id', b.id, 'root_cause_method', b.root_cause_method, 'system_factors', b.system_factors,
                                                    'capa_refs', to_jsonb(b.capa_refs), 'no_capa_reason', b.no_capa_reason,
                                                    'notification_required', b.notification_required, 'notification_rationale', b.notification_rationale,
                                                    'authority_reference', b.authority_reference, 'other_batches', b.other_batches,
                                                    'recorded_by', b.recorded_by_person) end,
      'conclusion', (select jsonb_build_object('finding_id', c.finding_id, 'assignable_cause', c.assignable_cause, 'cause', c.cause,
                                               'root_cause_category', c.root_cause_category, 'concluded_by', c.concluded_by_person)
                     from site.deviation_conclusion c where c.deviation_id = d.id)),
    'state', site.deviation_state(d.id),
    'scope', jsonb_build_object('site', d.site_code),
    'entered_by', (select to_jsonb(array_agg(distinct p)) from (
                     select d.raised_by_person as p
                     union all select x.recorded_by_person from site.deviation_finding x where x.deviation_id = d.id
                     union all select x.recorded_by_person from site.deviation_closure_basis x where x.deviation_id = d.id
                     union all select x.classified_by_person from site.deviation_classification x where x.deviation_id = d.id
                     union all select x.recorded_by_person from site.deviation_impact x where x.deviation_id = d.id) y));
end
$$;

-- As 0821_deviation_full_commands.sql; the classifier and the impact recorders neither conclude nor close (header).
create or replace function site.assert_deviation_qa_signature(d site.deviation, p_signature uuid, p_meaning text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_prob text;
begin
  perform esig.assert_signature(p_signature, p_meaning, 'deviation', d.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-308 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-308 %s is recorded by the QA person who signed it', p_meaning);
  end if;
  if exists (select 1 from site.deviation_finding f where f.deviation_id = d.id and f.recorded_by_person::text = v_ctx ->> 'person_id')
     or exists (select 1 from site.deviation_closure_basis b where b.deviation_id = d.id and b.recorded_by_person::text = v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-312 this person recorded a finding or the closure basis of %s; its conclusion and closure are by another QA person than the investigator (PR-50; outline 7.2 S7)', d.ref);
  end if;
  if exists (select 1 from site.deviation_classification k where k.deviation_id = d.id and k.classified_by_person::text = v_ctx ->> 'person_id')
     or exists (select 1 from site.deviation_impact i where i.deviation_id = d.id and i.recorded_by_person::text = v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-832 this person classified %s or recorded an impact of it; its conclusion and closure are by another QA person (INV-03; outline 7.2 S7; D-2a-1)', d.ref);
  end if;
  if d.raised_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-307 %s was raised by this person; its conclusion, closure and cancellation are by QA other than the initiator (PR-50; outline 7.2 S7)', d.ref);
  end if;
  if site.deviation_owner(d.id)::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-823 this person owns the investigation of %s; its conclusion and closure are by QA other than the owner (outline 7.2 S7)', d.ref);
  end if;
end
$$;

-- As 0821_deviation_full_commands.sql; neither the classifier nor an impact recorder signs the impact (header).
create or replace function site.assess_deviation_impact(p_deviation uuid, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  d      site.deviation;
  v_st   text;
  v_prob text;
  v_miss text;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.QA_APPROVE', jsonb_build_object('site', d.site_code));
  v_st := site.deviation_state(d.id);
  if v_st not in ('UNDER_INVESTIGATION', 'PENDING_CLOSURE') or site.deviation_impact_current(d.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-825 %s is %s%s; QA signs the impact assessment of an investigated record whose impact rows are not yet signed (outline 5.2.5)',
                       d.ref, v_st, case when site.deviation_impact_current(d.id) then ' and its impact assessment is current' else '' end);
  end if;
  select string_agg(l.subject_ref, ', ' order by l.linked_at, l.id) into v_miss
    from site.deviation_link l
   where l.deviation_id = d.id and not exists (select 1 from site.deviation_impact i where i.link_id = l.id and i.market = 'IN');
  if v_miss is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-825 the impact on %s is not assessed for IN; every linked subject is assessed for India at least, and for each other market it goes to (outline 5.2.5)', v_miss);
  end if;
  perform esig.assert_signature(p_signature, 'DEVIATION_IMPACT_ASSESSED', 'deviation', d.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-308 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-308 DEVIATION_IMPACT_ASSESSED is recorded by the QA person who signed it';
  end if;
  if d.raised_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-307 %s was raised by this person; its impact assessment is signed by QA other than the initiator (outline 5.2.5, 7.2 S7)', d.ref);
  end if;
  if site.deviation_owner(d.id)::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-823 this person owns the investigation of %s; its impact assessment is signed by QA who is neither the initiator nor the owner (outline 5.2.5)', d.ref);
  end if;
  if exists (select 1 from site.deviation_classification k where k.deviation_id = d.id and k.classified_by_person::text = v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-833 this person classified %s; its impact assessment is signed by another QA person (INV-03; D-2a-1)', d.ref);
  end if;
  if exists (select 1 from site.deviation_impact i where i.deviation_id = d.id and i.recorded_by_person::text = v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-834 this person recorded an impact of %s; QA signs an assessment it did not record (no self-approval; outline 7.2 S7)', d.ref);
  end if;
  insert into site.deviation_impact_signoff (deviation_id, covers_seq, signature_id, person_id, account_id)
  values (d.id, coalesce((select max(i.seq) from site.deviation_impact i where i.deviation_id = d.id), 0), p_signature,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- As 0822_deviation_release_blocking.sql; a CONFIRMED impact keeps blocking after closure (header).
create or replace function site.deviation_release_items(p_kind text, p_id uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_items jsonb := '[]'::jsonb;
  d       site.deviation;
  l       site.deviation_link;
  i       site.deviation_impact;
  v_st    text;
  v_cov   bigint;
  v_block boolean;
  v_why   text;
  v_m     text;
begin
  if p_kind is null or p_kind not in ('BATCH', 'LOT', 'CONTAINER') or p_id is null then
    return v_items;
  end if;
  if p_market is not null and p_market not in ('IN', 'US', 'EU') then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-831 %s is not a market (IN, US or EU)', p_market);
  end if;
  for d in select x.* from site.deviation x
            where exists (select 1 from site.deviation_link y where y.deviation_id = x.id
                           and ((y.subject_kind = p_kind and y.subject_id = p_id) or (p_kind = 'BATCH' and y.batch_id = p_id)))
            order by x.raised_at, x.id loop
    v_st := site.deviation_state(d.id);
    v_block := false;
    v_why := null;
    if v_st <> 'CANCELLED' then
      select s.covers_seq into v_cov from site.deviation_impact_signoff s where s.deviation_id = d.id order by s.seq desc limit 1;
      for l in select y.* from site.deviation_link y where y.deviation_id = d.id
                  and ((y.subject_kind = p_kind and y.subject_id = p_id) or (p_kind = 'BATCH' and y.batch_id = p_id))
                order by y.linked_at, y.id loop
        foreach v_m in array case when p_market is not null then array[p_market]
                                  else coalesce((select array_agg(distinct m.market order by m.market) from site.deviation_impact m where m.link_id = l.id), '{}') || array['IN'] end loop
          i := site.deviation_latest_impact(l.id, v_m);
          if v_st = 'CLOSED' then
            -- D-2a-9: closure ends a link assessed NONE or POTENTIAL; a CONFIRMED impact keeps the subject blocked.
            if i.id is not null and i.impact = 'CONFIRMED' then
              v_why := format('it was closed with the impact on %s %s for %s CONFIRMED; the subject is rejected, or released only on a signed QA disposition of that link (D-2a-9)',
                              lower(l.subject_kind), l.subject_ref, v_m);
            end if;
          elsif i.id is null then
            v_why := format('%s %s is not assessed for %s', lower(l.subject_kind), l.subject_ref, v_m);
          elsif i.impact <> 'NONE' then
            v_why := format('the impact on %s %s for %s is %s', lower(l.subject_kind), l.subject_ref, v_m, i.impact);
          elsif v_cov is null or i.seq > v_cov then
            v_why := format('the impact NONE on %s %s for %s is not yet signed by QA', lower(l.subject_kind), l.subject_ref, v_m);
          end if;
          exit when v_why is not null;
        end loop;
        exit when v_why is not null;
      end loop;
      v_block := v_why is not null;
    end if;
    v_items := v_items || jsonb_build_object(
      'deviationId', d.id, 'ref', d.ref, 'kind', d.kind, 'state', v_st,
      'classification', coalesce((site.deviation_latest_classification(d.id)).classification, d.classification),
      'cancelled', v_st = 'CANCELLED', 'blocking', v_block, 'reason', v_why,
      'cancelledBy', (select e.person_id from site.deviation_event e where e.deviation_id = d.id and e.event = 'CANCELLED'));
  end loop;
  return v_items;
end
$$;

reset role;
