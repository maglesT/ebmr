-- The full deviation stand-in, its commands (Phase 4 slice 2a; outline 5.2.5; D-P4-2; controls IN-02, PR-49, PR-50, PR-51;
-- L-21). The records are 0820. Every write is a SECURITY DEFINER command; ebmr_app reads (DI-17, DI-18; ADR 0012, 0016).
--
--   site.start_deviation_investigation(id, p)   DEVIATION.CLASSIFY   OPEN -> UNDER_INVESTIGATION with QA's classification
--                                    {classification, riskRationale (>= 10 characters, IN-02), ownerPersonId, dueDate,
--                                    riskDocumentId?}; never by the initiator; the owner holds DEVIATION.INVESTIGATE at the
--                                    record's site; the due date is not in the past (site zone). The one-argument form of
--                                    0730 is refused from now on (EBMR-SITE-820).
--   site.reclassify_deviation(id, p)            DEVIATION.CLASSIFY   the same, while UNDER_INVESTIGATION or IMPACT_ASSESSED.
--   site.record_deviation_impact(id, p)         DEVIATION.INVESTIGATE  {linkId, market IN|US|EU, impact NONE|POTENTIAL|
--                                    CONFIRMED, rationale}; while UNDER_INVESTIGATION, IMPACT_ASSESSED or PENDING_CLOSURE.
--   site.assess_deviation_impact(id, sig)       DEVIATION.QA_APPROVE  DEVIATION_IMPACT_ASSESSED: every link has an IN row;
--                                    signed by QA who is neither the initiator nor the owner (EBMR-SITE-307, 823).
--   site.record_deviation_closure_basis(id, p)  DEVIATION.INVESTIGATE  {rootCauseMethod?, systemFactors?: {process,
--                                    procedure, system}, capaRefs[], noCapaReason?, notificationRequired, notificationRationale,
--                                    authorityReference?, otherBatches: [{subjectKind BATCH|PRODUCT|LOT, ref, included,
--                                    reason}] (non-empty)}; while UNDER_INVESTIGATION or IMPACT_ASSESSED.
--   site.conclude_deviation(id, sig)            re-created from 0730: IMPACT_ASSESSED -> PENDING_CLOSURE, with a finding and
--                                    a closure basis that fits it: a HUMAN_ERROR finding needs the system-factor assessment;
--                                    MAJOR or CRITICAL needs the root-cause method; MAJOR, CRITICAL or NOT_DETERMINED needs at
--                                    least one CAPA reference (PR-50, PR-51).
--   site.close_deviation(id, sig)               re-created from 0730: PENDING_CLOSURE -> CLOSED while the impact assessment is
--                                    current (a subject linked after the conclusion is assessed first).
--   site.cancel_deviation(id, reason)           re-created from 0730: OPEN only (outline 5.2.5, L-21), QA other than the
--                                    initiator, with the reason. The other half of L-21 (the canceller never signs a linked
--                                    lot's release) is 0822.
--   site.record_deviation_finding(id, p)        re-created from 0730: also while IMPACT_ASSESSED.
--   site.assert_deviation_qa_signature          re-created from 0753: the owner and a recorder of the closure basis neither
--                                    conclude nor close either (S7).
--   site.lot_test_failure_resolved              re-created from 0753: a laboratory-error conclusion counts in PENDING_CLOSURE
--                                    (the old CONCLUDED) or CLOSED.
--
-- Messages: EBMR-SITE-820 to 829.

set local role ebmr_owner;

-- The classification body checks (IN-02); raises, or returns the row values as jsonb.
create function site.deviation_classification_input(d site.deviation, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_owner uuid;
  v_due   date;
  v_doc   text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-821 QA''s classification is required: classification, risk rationale, owner and due date (IN-02)';
  end if;
  if coalesce(p ->> 'classification', '') not in ('MINOR', 'MAJOR', 'CRITICAL') or length(btrim(coalesce(p ->> 'riskRationale', ''))) < 10 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-821 QA classifies the record MINOR, MAJOR or CRITICAL with a written risk rationale of at least 10 characters (IN-02)';
  end if;
  if coalesce(p ->> 'ownerPersonId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-822 the investigation has an owner (a person id)';
  end if;
  v_owner := (p ->> 'ownerPersonId')::uuid;
  if not exists (select 1 from iam.role_grant g join iam.role_permission rp on rp.role_code = g.role_code
                  where g.person_id = v_owner and rp.permission_code = 'DEVIATION.INVESTIGATE'
                    and iam.grant_is_live(g.status, g.valid_to, g.revoked_at)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-822 the owner %s does not hold a role that investigates deviations (DEVIATION.INVESTIGATE)', v_owner);
  end if;
  if coalesce(p ->> 'dueDate', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-822 the investigation has a due date (YYYY-MM-DD)';
  end if;
  begin
    v_due := (p ->> 'dueDate')::date;
  exception when others then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-822 %s is not a date', p ->> 'dueDate');
  end;
  if v_due < (clock_timestamp() at time zone coalesce(nullif(v_ctx ->> 'site_zone', ''), 'UTC'))::date then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-822 the due date %s is in the past', v_due);
  end if;
  v_doc := nullif(p ->> 'riskDocumentId', '');
  if v_doc is not null then
    if v_doc !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or site.evidence_document_problem(v_doc::uuid, d.site_code) is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-821 the risk assessment %s is not a stored evidence document of site %s (IN-02)', v_doc, d.site_code);
    end if;
  end if;
  return jsonb_build_object('classification', p ->> 'classification', 'riskRationale', btrim(p ->> 'riskRationale'), 'owner', v_owner,
                            'dueDate', v_due, 'riskDocumentId', v_doc);
end
$$;

create function site.insert_deviation_classification(d site.deviation, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v     jsonb;
  v_id  uuid;
begin
  if d.raised_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-307 %s was raised by this person; QA other than the initiator classifies it (IN-02, PR-50; outline 7.2 S7)', d.ref);
  end if;
  v := site.deviation_classification_input(d, p);
  insert into site.deviation_classification (deviation_id, classification, risk_rationale, risk_document_id, owner_person, due_date,
                                             classified_by_person, classified_by_account)
  values (d.id, v ->> 'classification', v ->> 'riskRationale', (v ->> 'riskDocumentId')::uuid, (v ->> 'owner')::uuid, (v ->> 'dueDate')::date,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- The one-argument form of 0730 started an investigation without QA's classification; it is refused from now on.
create or replace function site.start_deviation_investigation(p_deviation uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  raise exception using errcode = 'P0001',
    message = 'EBMR-SITE-820 an investigation starts with QA''s classification (classification, risk rationale, owner, due date) (IN-02; outline 5.2.5)';
end
$$;

create function site.start_deviation_investigation(p_deviation uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.CLASSIFY', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) <> 'OPEN' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-305 %s is %s; only an OPEN record moves to UNDER_INVESTIGATION (IN-20)', d.ref, site.deviation_state(d.id));
  end if;
  v_id := site.insert_deviation_classification(d, p);
  insert into site.deviation_event (deviation_id, event, person_id, account_id)
  values (d.id, 'INVESTIGATION_STARTED', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  return v_id;
end
$$;

create function site.reclassify_deviation(p_deviation uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  d site.deviation;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.CLASSIFY', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) not in ('UNDER_INVESTIGATION', 'IMPACT_ASSESSED') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-821 %s is %s; it is reclassified while UNDER_INVESTIGATION or IMPACT_ASSESSED (IN-02)', d.ref, site.deviation_state(d.id));
  end if;
  return site.insert_deviation_classification(d, p);
end
$$;

create function site.record_deviation_impact(p_deviation uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.INVESTIGATE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) not in ('UNDER_INVESTIGATION', 'IMPACT_ASSESSED', 'PENDING_CLOSURE') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-824 %s is %s; impact is assessed once the investigation started and until the record is closed (outline 5.2.5)', d.ref, site.deviation_state(d.id));
  end if;
  if p is null or jsonb_typeof(p) <> 'object'
     or coalesce(p ->> 'linkId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or not exists (select 1 from site.deviation_link l where l.id = (p ->> 'linkId')::uuid and l.deviation_id = d.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-824 the impact names a subject linked to %s (its link id)', d.ref);
  end if;
  if coalesce(p ->> 'market', '') not in ('IN', 'US', 'EU') or coalesce(p ->> 'impact', '') not in ('NONE', 'POTENTIAL', 'CONFIRMED')
     or length(btrim(coalesce(p ->> 'rationale', ''))) < 10 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-824 an impact names the market (IN, US or EU), the impact (NONE, POTENTIAL or CONFIRMED) and its rationale (at least 10 characters) (outline 5.2.5)';
  end if;
  insert into site.deviation_impact (deviation_id, link_id, market, impact, rationale, recorded_by_person, recorded_by_account)
  values (d.id, (p ->> 'linkId')::uuid, p ->> 'market', p ->> 'impact', btrim(p ->> 'rationale'), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.assess_deviation_impact(p_deviation uuid, p_signature uuid) returns uuid
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
  insert into site.deviation_impact_signoff (deviation_id, covers_seq, signature_id, person_id, account_id)
  values (d.id, coalesce((select max(i.seq) from site.deviation_impact i where i.deviation_id = d.id), 0), p_signature,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.record_deviation_closure_basis(p_deviation uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  d      site.deviation;
  v_sf   jsonb;
  v_capa text[];
  e      jsonb;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.INVESTIGATE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) not in ('UNDER_INVESTIGATION', 'IMPACT_ASSESSED') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-826 %s is %s; the closure basis is recorded while UNDER_INVESTIGATION or IMPACT_ASSESSED (outline 5.2.5)', d.ref, site.deviation_state(d.id));
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-826 the closure basis is required';
  end if;
  v_sf := p -> 'systemFactors';
  if v_sf is not null and jsonb_typeof(v_sf) <> 'null' then
    if jsonb_typeof(v_sf) <> 'object' or length(btrim(coalesce(v_sf ->> 'process', ''))) < 10 or length(btrim(coalesce(v_sf ->> 'procedure', ''))) < 10
       or length(btrim(coalesce(v_sf ->> 'system', ''))) < 10 or (select count(*) from jsonb_object_keys(v_sf)) <> 3 then
      raise exception using errcode = 'P0001',
        message = 'EBMR-SITE-826 a system-factor assessment states the process, procedure and system factors considered, each in at least 10 characters (PR-50)';
    end if;
  else
    v_sf := null;
  end if;
  if jsonb_typeof(coalesce(p -> 'capaRefs', '[]'::jsonb)) <> 'array'
     or exists (select 1 from jsonb_array_elements(coalesce(p -> 'capaRefs', '[]'::jsonb)) x(v)
                 where jsonb_typeof(x.v) <> 'string' or x.v #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9/._-]{1,39}$') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-826 each CAPA reference is a code of 2 to 40 letters, digits, / . _ or - (PR-51)';
  end if;
  select coalesce(array_agg(distinct x.v #>> '{}' order by x.v #>> '{}'), '{}') into v_capa from jsonb_array_elements(coalesce(p -> 'capaRefs', '[]'::jsonb)) x(v);
  if cardinality(v_capa) = 0 and length(btrim(coalesce(p ->> 'noCapaReason', ''))) < 10 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-826 the record names its CAPA references, or why no CAPA is needed (at least 10 characters) (PR-51)';
  end if;
  if jsonb_typeof(p -> 'notificationRequired') is distinct from 'boolean' or length(btrim(coalesce(p ->> 'notificationRationale', ''))) < 10
     or ((p -> 'notificationRequired') = 'true'::jsonb and btrim(coalesce(p ->> 'authorityReference', '')) = '') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-826 the regulatory-notification assessment states whether a notification is required, why (at least 10 characters) and, when it is, the licensing-authority reference';
  end if;
  if jsonb_typeof(p -> 'otherBatches') is distinct from 'array' or jsonb_array_length(p -> 'otherBatches') = 0 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-826 the record lists the other batches and products assessed, with the reason each is included or excluded (a non-empty list; PR-50)';
  end if;
  for e in select x.v from jsonb_array_elements(p -> 'otherBatches') x(v) loop
    if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'subjectKind', '') not in ('BATCH', 'PRODUCT', 'LOT') or btrim(coalesce(e ->> 'ref', '')) = ''
       or jsonb_typeof(e -> 'included') is distinct from 'boolean' or length(btrim(coalesce(e ->> 'reason', ''))) < 5
       or (select count(*) from jsonb_object_keys(e)) <> 4 then
      raise exception using errcode = 'P0001',
        message = 'EBMR-SITE-826 each other batch or product assessed is {subjectKind BATCH, PRODUCT or LOT, ref, included (true or false), reason (at least 5 characters)}';
    end if;
  end loop;
  insert into site.deviation_closure_basis (deviation_id, root_cause_method, system_factors, capa_refs, no_capa_reason, notification_required,
                                            notification_rationale, authority_reference, other_batches, recorded_by_person, recorded_by_account)
  values (d.id, nullif(btrim(coalesce(p ->> 'rootCauseMethod', '')), ''), v_sf, v_capa,
          case when cardinality(v_capa) = 0 then btrim(p ->> 'noCapaReason') else nullif(btrim(coalesce(p ->> 'noCapaReason', '')), '') end,
          (p ->> 'notificationRequired')::boolean, btrim(p ->> 'notificationRationale'),
          case when (p ->> 'notificationRequired')::boolean then btrim(p ->> 'authorityReference') else nullif(btrim(coalesce(p ->> 'authorityReference', '')), '') end,
          p -> 'otherBatches', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- As 0730; a finding is recorded while UNDER_INVESTIGATION or IMPACT_ASSESSED (the root cause may follow the impact).
create or replace function site.record_deviation_finding(p_deviation uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.INVESTIGATE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) not in ('UNDER_INVESTIGATION', 'IMPACT_ASSESSED') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-306 %s is %s; a finding is recorded while it is UNDER_INVESTIGATION or IMPACT_ASSESSED (IN-20)', d.ref, site.deviation_state(d.id));
  end if;
  if p is null or jsonb_typeof(p -> 'assignableCause') is distinct from 'boolean' or length(btrim(coalesce(p ->> 'cause', ''))) < 10
     or coalesce(p ->> 'rootCauseCategory', '') not in ('HUMAN_ERROR', 'EQUIPMENT', 'MATERIAL', 'METHOD', 'ENVIRONMENT', 'PROCESS', 'LABORATORY_ERROR', 'NOT_DETERMINED')
     or ((p -> 'assignableCause') = 'true'::jsonb and p ->> 'rootCauseCategory' = 'NOT_DETERMINED') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-306 a finding states whether a cause was assigned, the cause (at least 10 characters) and its root-cause category (NOT_DETERMINED only without an assignable cause) (IN-20)';
  end if;
  insert into site.deviation_finding (deviation_id, assignable_cause, cause, root_cause_category, recorded_by_person, recorded_by_account)
  values (d.id, (p ->> 'assignableCause')::boolean, btrim(p ->> 'cause'), p ->> 'rootCauseCategory', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- As 0753; the owner and a recorder of the closure basis neither conclude nor close (header).
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

-- As 0730; IMPACT_ASSESSED -> PENDING_CLOSURE with a closure basis that fits the finding and the classification (header).
create or replace function site.conclude_deviation(p_deviation uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
  f     site.deviation_finding;
  k     site.deviation_classification;
  b     site.deviation_closure_basis;
  v_so  uuid;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.QA_APPROVE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) <> 'IMPACT_ASSESSED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-309 %s is %s; QA concludes a record whose impact is assessed (IMPACT_ASSESSED) (IN-20; outline 5.2.5)', d.ref, site.deviation_state(d.id));
  end if;
  f := site.deviation_latest_finding(d.id);
  if f.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-309 %s has no finding to conclude (IN-20)', d.ref);
  end if;
  b := site.deviation_latest_closure_basis(d.id);
  if b.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-827 %s has no closure basis: root-cause method, CAPA, regulatory-notification assessment and the other batches assessed (outline 5.2.5)', d.ref);
  end if;
  k := site.deviation_latest_classification(d.id);
  if f.root_cause_category = 'HUMAN_ERROR' and b.system_factors is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-827 %s concludes a human error; that needs the assessment of the process, procedure and system factors (PR-50)', d.ref);
  end if;
  if k.classification in ('MAJOR', 'CRITICAL') and b.root_cause_method is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-827 %s is %s; its closure basis names the root-cause method used (PR-50)', d.ref, k.classification);
  end if;
  if (k.classification in ('MAJOR', 'CRITICAL') or f.root_cause_category = 'NOT_DETERMINED') and cardinality(b.capa_refs) = 0 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-827 %s is %s%s; it names at least one CAPA (PR-50, PR-51)', d.ref, k.classification,
                       case when f.root_cause_category = 'NOT_DETERMINED' then ' with the root cause not determined' else '' end);
  end if;
  perform site.assert_deviation_qa_signature(d, p_signature, 'DEVIATION_CONCLUDED');
  select s.id into v_so from site.deviation_impact_signoff s where s.deviation_id = d.id order by s.seq desc limit 1;
  insert into site.deviation_conclusion (deviation_id, finding_id, assignable_cause, cause, root_cause_category, signature_id, concluded_by_person, concluded_by_account)
  values (d.id, f.id, f.assignable_cause, f.cause, f.root_cause_category, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  insert into site.deviation_conclusion_basis (deviation_id, classification_id, impact_signoff_id, closure_basis_id) values (d.id, k.id, v_so, b.id);
end
$$;

-- As 0730; closed while the impact assessment is current (header).
create or replace function site.close_deviation(p_deviation uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.QA_APPROVE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) <> 'PENDING_CLOSURE' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-310 %s is %s; QA closes a record PENDING_CLOSURE (IN-20; outline 5.2.5)', d.ref, site.deviation_state(d.id));
  end if;
  if not site.deviation_impact_current(d.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-828 the impact assessment of %s does not cover every linked subject and impact row; QA signs it again before closure (outline 5.2.5)', d.ref);
  end if;
  perform site.assert_deviation_qa_signature(d, p_signature, 'DEVIATION_CLOSED');
  insert into site.deviation_event (deviation_id, event, signature_id, person_id, account_id)
  values (d.id, 'CLOSED', p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- As 0730; OPEN only (L-21; header).
create or replace function site.cancel_deviation(p_deviation uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  d     site.deviation;
begin
  perform iam.assert_not_administrator();
  d := site.lock_deviation(p_deviation);
  perform iam.require_permission('DEVIATION.QA_APPROVE', jsonb_build_object('site', d.site_code));
  if site.deviation_state(d.id) <> 'OPEN' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-311 %s is %s; only an OPEN record is cancelled (L-21; outline 5.2.5)', d.ref, site.deviation_state(d.id));
  end if;
  if d.raised_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-307 %s was raised by this person; its conclusion, closure and cancellation are by QA other than the initiator (PR-50; outline 7.2 S7)', d.ref);
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-311 cancelling a deviation record states the person''s own reason (DI-22; L-21)';
  end if;
  insert into site.deviation_event (deviation_id, event, reason, person_id, account_id)
  values (d.id, 'CANCELLED', btrim(p_reason), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- As 0753; a laboratory-error conclusion counts in PENDING_CLOSURE (the old CONCLUDED) or CLOSED (header).
create or replace function site.lot_test_failure_resolved(p_result uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select exists (select 1 from site.lot_test_oos o join site.deviation_conclusion c on c.deviation_id = o.deviation_id
                  where o.result_id = r.id and c.assignable_cause and c.root_cause_category = 'LABORATORY_ERROR'
                    and site.deviation_state(o.deviation_id) in ('PENDING_CLOSURE', 'CLOSED'))
     and exists (select 1 from site.lot_test_result n
                  where n.lot_id = r.lot_id and n.test_code = r.test_code and n.purpose = r.purpose and n.id <> r.id
                    and n.recorded_at > r.recorded_at and n.verdict = 'PASS' and site.lot_test_state(n.id) = 'APPROVED')
  from site.lot_test_result r where r.id = p_result
$$;

revoke all on function site.deviation_classification_input(site.deviation, jsonb), site.insert_deviation_classification(site.deviation, jsonb) from public;
revoke all on function site.start_deviation_investigation(uuid) from ebmr_app;
grant execute on function site.start_deviation_investigation(uuid, jsonb), site.reclassify_deviation(uuid, jsonb), site.record_deviation_impact(uuid, jsonb),
                          site.assess_deviation_impact(uuid, uuid), site.record_deviation_closure_basis(uuid, jsonb) to ebmr_app;

reset role;
