-- Tablets edition, module C1: who may read the content to be signed and the signatures of a record (Phase 2 exit review
-- F34; DI-17, DI-50, DI-37; Annex 11 and Part 11 limit access to authorised persons; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- GET /api/esig/content checked only that a session existed. With no signable handler for the record's aggregate type
-- it called esig.content_for_signing, a SECURITY DEFINER function the application role could execute for any
-- registered aggregate type and any meaning: a data-integrity investigation (subject, concern, window, investigator)
-- was served to the person it investigates, and to any role "to be signed" with a meaning that role may not sign.
-- GET /api/esig/signatures listed the manifestations of any record to any session. The application role could also
-- read the investigation tables directly.
--
-- The read rule (default F34.1, docs/decisions/phase-2-open-questions.md), decided by the database for the session
-- whose cookie token the server presents (tab.reader_of: an active session in a role granted now, EBMR-TAB-018):
--  - a record of the RECORD class (batch steps, stages, exceptions and points, MBR versions and market authorisations,
--    market rule corrections and policies, record types, the demo stub and sample records: tab.aggregate_read_class)
--    is read in a role that holds RECORD.READ;
--  - every other aggregate type (a data-integrity investigation, a record disposal, a restore event, and any type not
--    named: fail closed) is of the GOVERNANCE class: read only in a role that reviews audit trails, data integrity or
--    access, or audits (RECORD.AUDIT_TRAIL_REVIEW, VALIDATION.MANAGE, IAM.ACCESS_RECERTIFY or RECORD.EXPORT: QA reviewer,
--    CSV/DI lead, process owner, auditor), and a data-integrity investigation never by the person it investigates;
--  - content to be signed with meaning M is previewed only when the record may be read, and the session's role holds
--    one of M's permissions; on a shop-floor terminal, where the person who signs is the one who taps (any person
--    present), that last check is made at signing (esig.sign) for RECORD-class records only;
--  - through the kernel's content provider (no signable handler) only the pairs of aggregate type and meaning this
--    installation signs that way are served (tab.kernel_signing_meanings: in Phase 2 only the DEMO-ONLY stub), else
--    EBMR-TAB-019; a refusal of the rule above is EBMR-TAB-020.
-- The application role loses EXECUTE on esig.content_for_signing, esig.record_signatures, esig.manifestation and
-- esig.resigning_required, and SELECT on the investigation tables; it reads RECORD-class content and signatures without a
-- token (tab.record_content_for_signing, tab.signatures_of) for the screens and handlers that need them, and sees only
-- RECORD-class rows of esig.signature and esig.challenge (row-level security).
--
-- The functions are SECURITY DEFINER where they read, owned by ebmr_owner, and pin their search_path with pg_temp last.

set local role ebmr_owner;

-- DI-17 (F34): the read class of an e-signature aggregate type. RECORD: read with RECORD.READ; GOVERNANCE (every type
-- not named here, fail closed): read only in a governance or audit role.
create function tab.aggregate_read_class(p_aggregate_type text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_aggregate_type in ('batch_step', 'batch_stage', 'batch_exception', 'batch_point', 'mbr_version', 'mbr_market_authorisation',
                                        'market_rule_correction', 'market_site_loosening', 'market_policy_version', 'record_type_version',
                                        'esig_stub', 'sample_record')
              then 'RECORD' else 'GOVERNANCE' end
$$;

-- DI-17, DI-50 (F34): the permissions of the roles that read GOVERNANCE-class records: audit-trail review (QA reviewer),
-- data-integrity and validation (CSV/DI lead), access recertification (process owner), export for audit (auditor).
create function tab.governance_read_permissions() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['RECORD.AUDIT_TRAIL_REVIEW', 'VALIDATION.MANAGE', 'IAM.ACCESS_RECERTIFY', 'RECORD.EXPORT']
$$;

-- The session a read is made for.
create type tab.reader as (session_id uuid, person_id uuid, account_id uuid, role_code text, shop_floor boolean);

-- DI-17 (F34): the session bound to p_token_hash, when it is active and works in a role granted now (EBMR-TAB-018).
create function tab.reader_of(p_token_hash text) returns tab.reader
language plpgsql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  s jsonb := tab.resolve_session(p_token_hash);
begin
  if s is null or s ->> 'state' is distinct from 'ACTIVE' or s ->> 'role_code' is null then
    raise exception using errcode = 'P0001', message = format(
      'Only an active session working in a role granted now can read this; the session is %s. [EBMR-TAB-018]',
      case when s is null then 'unknown' when s ->> 'role_code' is null and s ->> 'state' = 'ACTIVE' then 'without a role' else lower(s ->> 'state') end);
  end if;
  return row((s ->> 'session_id')::uuid, (s ->> 'person_id')::uuid, (s ->> 'account_id')::uuid, s ->> 'role_code',
             s ->> 'device_class' in ('SHARED', 'GRADE_A_B'))::tab.reader;
end
$$;

-- Whether role p_role holds at least one of p_permissions now.
create function tab.role_may(p_role text, p_permissions text[]) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select coalesce(iam.role_permissions_at(p_role, clock_timestamp()) && p_permissions, false)
$$;

-- DI-17, DI-50 (F34): why reader p_reader may not read record p_aggregate_type:p_aggregate_id; NULL when it may.
create function tab.record_read_problem(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, records, pg_temp as $$
begin
  if tab.aggregate_read_class(p_aggregate_type) = 'RECORD' then
    if tab.role_may(p_reader.role_code, array['RECORD.READ']) then
      return null;
    end if;
    return format('the role %s does not hold RECORD.READ', p_reader.role_code);
  end if;
  if not tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
    return format('%s records are read only in a role that reviews audit trails, data integrity or access, or audits (one holding %s); the role %s holds none of these',
                  p_aggregate_type, array_to_string(tab.governance_read_permissions(), ', '), p_reader.role_code);
  end if;
  if p_aggregate_type = 'di_investigation' and exists (
       select 1 from records.di_investigation i where i.id::text = p_aggregate_id and i.subject_person_id = p_reader.person_id) then
    return 'a data-integrity investigation is never shown to the person it investigates';
  end if;
  return null;
end
$$;

-- DI-37 (F34): the meanings this installation signs an aggregate type with through the kernel's content provider (no
-- signable handler previews it). In Phase 2 only the DEMO-ONLY stub; every other type is refused (fail closed) until
-- its signing flow is built, with its meanings named here.
create function tab.kernel_signing_meanings(p_aggregate_type text) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_aggregate_type
           when 'esig_stub' then array['PERFORMED', 'VERIFIED', 'WITNESSED', 'LOGBOOK_PERFORMED', 'LOGBOOK_DOUBLE_CHECKED', 'PREPARED', 'CHECKED', 'APPROVED']
           else '{}'::text[]
         end
$$;

-- DI-17, DI-37 (F34): why reader p_reader may not preview record p_aggregate_type:p_aggregate_id as content to be
-- signed with meaning p_meaning; NULL when it may.
create function tab.signing_preview_problem_for(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text, p_meaning text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, esig, pg_temp as $$
declare
  v_problem text := tab.record_read_problem(p_reader, p_aggregate_type, p_aggregate_id);
  v_type    esig.meaning_type;
begin
  if v_problem is not null then
    return v_problem;
  end if;
  v_type := esig.current_meaning(p_meaning);
  -- On a shop-floor terminal the person who signs is the one who taps; for a RECORD-class record esig.sign checks that
  -- person's authority. Everywhere else the session's own role signs.
  if (not p_reader.shop_floor or tab.aggregate_read_class(p_aggregate_type) <> 'RECORD')
     and not tab.role_may(p_reader.role_code, v_type.permissions) then
    return format('the role %s may not sign %s (that needs one of %s)', p_reader.role_code, v_type.code, array_to_string(v_type.permissions, ', '));
  end if;
  return null;
end
$$;

-- DI-17, DI-37 (F34): the same for the session bound to p_token_hash (EBMR-TAB-018 when there is none to read for).
create function tab.signing_preview_problem(p_token_hash text, p_aggregate_type text, p_aggregate_id text, p_meaning text) returns text
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select tab.signing_preview_problem_for(tab.reader_of(p_token_hash), p_aggregate_type, p_aggregate_id, p_meaning)
$$;

-- DI-17, DI-37, DI-50 (F34): the kernel's content to be signed, for the session bound to p_token_hash: only a pair of
-- aggregate type and meaning this installation signs through the kernel's provider (EBMR-TAB-019), and only when the
-- session may preview it (EBMR-TAB-020).
create function tab.content_for_signing(p_token_hash text, p_aggregate_type text, p_aggregate_id text, p_meaning text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, esig, pg_temp as $$
declare
  v_reader  tab.reader := tab.reader_of(p_token_hash);
  v_problem text;
begin
  if p_meaning is null or not (p_meaning = any (tab.kernel_signing_meanings(p_aggregate_type))) then
    raise exception using errcode = 'P0001', message = format(
      'This installation does not sign %s records %s through the kernel''s content. [EBMR-TAB-019]', p_aggregate_type, coalesce(p_meaning, '(no meaning)'));
  end if;
  v_problem := tab.signing_preview_problem_for(v_reader, p_aggregate_type, p_aggregate_id, p_meaning);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read %s %s: %s. [EBMR-TAB-020]', p_aggregate_type, p_aggregate_id, v_problem);
  end if;
  return esig.content_for_signing(p_aggregate_type, p_aggregate_id);
end
$$;

-- DI-37 (F34): the kernel's content of a RECORD-class record, for the signable handlers inside their commands (the
-- record is as readable as its own tables); never a GOVERNANCE-class one (EBMR-TAB-020).
create function tab.record_content_for_signing(p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, esig, pg_temp as $$
begin
  if tab.aggregate_read_class(p_aggregate_type) <> 'RECORD' then
    raise exception using errcode = 'P0001', message = format(
      'The content of %s records is read only by a session that may read them. [EBMR-TAB-020]', p_aggregate_type);
  end if;
  return esig.content_for_signing(p_aggregate_type, p_aggregate_id);
end
$$;

-- The signatures of a record with their stored manifestations and current status (private to the owner).
create function tab.signature_rows(p_aggregate_type text, p_aggregate_id text)
returns table (signature_id uuid, signer_person uuid, meaning_code text, manifestation jsonb, status text, valid boolean)
language sql volatile security definer set search_path = pg_catalog, tab, esig, pg_temp as $$
  select r.signature_id, r.signer_person, r.meaning_code, s.manifestation, r.status, r.valid
    from esig.record_signatures(p_aggregate_type, p_aggregate_id) r
    join esig.signature s on s.id = r.signature_id
   order by r.recorded_at, r.signature_id
$$;

-- DI-17, DI-36, DI-50 (F34): the signatures of a record, for the session bound to p_token_hash when it may read the
-- record (EBMR-TAB-018, EBMR-TAB-020).
create function tab.record_signatures(p_token_hash text, p_aggregate_type text, p_aggregate_id text)
returns table (signature_id uuid, signer_person uuid, meaning_code text, manifestation jsonb, status text, valid boolean)
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_problem text := tab.record_read_problem(tab.reader_of(p_token_hash), p_aggregate_type, p_aggregate_id);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read %s %s: %s. [EBMR-TAB-020]', p_aggregate_type, p_aggregate_id, v_problem);
  end if;
  return query select * from tab.signature_rows(p_aggregate_type, p_aggregate_id);
end
$$;

-- DI-36 (F34): the signatures of a RECORD-class record, for the screens that show a record's signatures beside it (the
-- run's steps and stages) and the handlers; never of a GOVERNANCE-class one (EBMR-TAB-020).
create function tab.signatures_of(p_aggregate_type text, p_aggregate_id text)
returns table (signature_id uuid, signer_person uuid, meaning_code text, manifestation jsonb, status text, valid boolean)
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if tab.aggregate_read_class(p_aggregate_type) <> 'RECORD' then
    raise exception using errcode = 'P0001', message = format(
      'The signatures of %s records are read only by a session that may read them. [EBMR-TAB-020]', p_aggregate_type);
  end if;
  return query select * from tab.signature_rows(p_aggregate_type, p_aggregate_id);
end
$$;

revoke all on function tab.aggregate_read_class(text), tab.governance_read_permissions(), tab.reader_of(text), tab.role_may(text, text[]),
                       tab.record_read_problem(tab.reader, text, text), tab.kernel_signing_meanings(text),
                       tab.signing_preview_problem_for(tab.reader, text, text, text), tab.signing_preview_problem(text, text, text, text),
                       tab.content_for_signing(text, text, text, text), tab.record_content_for_signing(text, text),
                       tab.signature_rows(text, text), tab.record_signatures(text, text, text), tab.signatures_of(text, text) from public;
-- aggregate_read_class is the row-level security predicate below, evaluated as the reading role.
grant execute on function tab.aggregate_read_class(text), tab.kernel_signing_meanings(text), tab.signing_preview_problem(text, text, text, text),
                          tab.content_for_signing(text, text, text, text), tab.record_content_for_signing(text, text),
                          tab.record_signatures(text, text, text), tab.signatures_of(text, text) to ebmr_app;

-- The application reads content and signatures only through the functions above.
revoke execute on function esig.content_for_signing(text, text), esig.record_signatures(text, text), esig.manifestation(uuid),
                           esig.resigning_required(text, text) from ebmr_app;
-- The investigation records are read through their content function only, under the rule above.
revoke select on records.di_investigation, records.di_investigation_link, records.di_investigation_closure, records.di_investigation_current from ebmr_app;

-- The application roles (GMP and sandbox) see only RECORD-class rows of the signatures and the signing requests; the
-- owner's functions see every row.
alter table esig.signature enable row level security;
create policy app_reads_record_class on esig.signature for select to ebmr_app, ebmr_sandbox
  using (tab.aggregate_read_class(aggregate_type) = 'RECORD');
alter table esig.challenge enable row level security;
create policy app_reads_record_class on esig.challenge for select to ebmr_app, ebmr_sandbox
  using (tab.aggregate_read_class(aggregate_type) = 'RECORD');

reset role;
