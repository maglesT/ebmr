-- Tablets server, Phase 4 slice 3b: the QA verification record of a compendial rule set (tablets spec E.1, S-8; Phase 3
-- slice 3c open item; controls IN-34, DI-10; default D-3b-4).
--
-- The compendial rule sets of tab.compendial_rule_set (tablets 0890) were taken from secondary sources. Tablets spec E.1
-- asks for the customer's verification record of each: a QA signature and the reference of the official text it was
-- checked against. Until now nothing recorded it. From this migration:
--
--   * tab.rule_set_verification: insert-only, audited: QA's verification of one rule set version (code, version) against
--     the official pharmacopoeia text: the document reference (the controlled copy of the official text), what was
--     checked (a short note), who recorded it. A later row for the same version supersedes the earlier one (the latest
--     counts).
--   * tab.rule_set_verification_signature: insert-only, audited: the COMPENDIAL_RULE_SET_VERIFIED signature over the rule
--     set's content (the rule set and its latest verification row), by the QA person who recorded that row.
--   * esig meaning COMPENDIAL_RULE_SET_VERIFIED (VENDOR minimum, MASTER_RECORD, APPROVER, all components; permission
--     MBR.APPROVE: the quality unit's approver of master data, scope '{}' as rule sets are global). The ceremony's meaning
--     list for the aggregate type compendial_rule_set (tab.kernel_signing_meanings) is added by the slice 3 lead's tablets
--     1179, which owns the shared signing functions; the aggregate stays GOVERNANCE class (no change there).
--   * esig content provider compendial_rule_set: tab.compendial_rule_set_content('<CODE>:<version>'): the rule set
--     version as stored and its latest verification row; state UNVERIFIED or VERIFIED (by that row's id).
--   * tab.record_rule_set_verification(code, version, documentRef, note) (MBR.APPROVE, never an administrator): records
--     the verification row and returns its id. tab.sign_rule_set_verification(code, version, signature) (MBR.APPROVE):
--     binds the signature over the content that shows that row, signed by the person who recorded it.
--   * tab.rule_set_verification_problem(code, version): why the rule set version is not verified now, or NULL: no
--     verification row, the latest row unsigned, or its signature invalidated. Read by G-REL (tablets 1162) for every rule
--     set a batch's in-process checks cite.
--
-- The rule sets keep being evaluated as shipped (tablets 0890): the release gate, not the evaluation, waits for the
-- verification (default D-3b-4). Messages: EBMR-TAB-860 to EBMR-TAB-864. Every function is owned by ebmr_owner, SECURITY
-- DEFINER where it writes or reads private tables, and pins its search_path with pg_temp last (ADR 0016). Applied as a
-- new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create table tab.rule_set_verification (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null,
  version              integer not null,
  document_ref         text not null check (btrim(document_ref) <> '' and length(document_ref) <= 200),
  note                 text not null check (btrim(note) <> '' and length(note) <= 2000),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  foreign key (code, version) references tab.compendial_rule_set (code, version)
);
create index rule_set_verification_set on tab.rule_set_verification (code, version, recorded_at desc);
revoke all on tab.rule_set_verification from public;

create table tab.rule_set_verification_signature (
  verification_id      uuid primary key references tab.rule_set_verification (id),
  signature_id         uuid not null unique,
  signed_by_person     uuid not null,
  signed_by_account    uuid not null,
  signed_at            timestamptz not null default clock_timestamp()
);
revoke all on tab.rule_set_verification_signature from public;

create trigger aa_rule_set_verification_insert_only before update or delete on tab.rule_set_verification for each row execute function kernel.reject_mutation();
create trigger aa_rule_set_verification_no_truncate before truncate on tab.rule_set_verification for each statement execute function kernel.reject_mutation();
create trigger aa_rule_set_verification_signature_insert_only before update or delete on tab.rule_set_verification_signature for each row execute function kernel.reject_mutation();
create trigger aa_rule_set_verification_signature_no_truncate before truncate on tab.rule_set_verification_signature for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.rule_set_verification', array['recorded_at']);
select platform.enforce_db_time('tab.rule_set_verification_signature', array['signed_at']);
select kernel.register_audited_table('tab.rule_set_verification', 'compendial_rule_set', 'code', true);
select kernel.register_audited_table('tab.rule_set_verification_signature', 'compendial_rule_set', 'verification_id', true);
grant select on tab.rule_set_verification, tab.rule_set_verification_signature to ebmr_app;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1161_rule_set_verification)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the quality unit''s verification of a compendial rule set against the official text (tablets spec E.1)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values ('COMPENDIAL_RULE_SET_VERIFIED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Compendial rule set verified',
        'Quality-unit verification: I checked this rule set against the official pharmacopoeia text named in the verification record; it may be relied on for released batches.',
        array['MBR.APPROVE'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Tablets spec E.1 (S-8); IN-34; DI-10');

select kernel.set_actor_context(null);

-- The latest verification row of a rule set version, or a row of NULLs.
create function tab.rule_set_latest_verification(p_code text, p_version integer) returns tab.rule_set_verification
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select v.* from tab.rule_set_verification v where v.code = p_code and v.version = p_version order by v.recorded_at desc, v.id desc limit 1
$$;

-- The content provider (header). p_id: '<CODE>:<version>'.
create function tab.compendial_rule_set_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  r tab.compendial_rule_set;
  v tab.rule_set_verification;
begin
  if coalesce(p_id, '') !~ '^[A-Z][A-Z-]{1,39}:[1-9][0-9]{0,8}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into r from tab.compendial_rule_set s where s.code = split_part(p_id, ':', 1) and s.version = split_part(p_id, ':', 2)::integer;
  if r.code is null then
    return '{"exists": false}'::jsonb;
  end if;
  v := tab.rule_set_latest_verification(r.code, r.version);
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (select count(*) from tab.rule_set_verification x where x.code = r.code and x.version = r.version),
    'content', jsonb_build_object(
      'title', format('Compendial rule set %s version %s', r.code, r.version),
      'code', r.code, 'version', r.version, 'test', r.test, 'pharmacopoeia', r.pharmacopoeia, 'markets', to_jsonb(r.markets),
      'tablet_types', to_jsonb(r.tablet_types), 'params', r.params, 'confidence', r.confidence, 'source', r.source,
      'effective_from', r.effective_from::text, 'effective_to', r.effective_to::text,
      'verification', case when v.id is null then null else jsonb_build_object(
        'id', v.id, 'document_ref', v.document_ref, 'note', v.note, 'recorded_by', v.recorded_by_person,
        'recorded_at', to_char(v.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) end),
    'state', case when v.id is null then 'UNVERIFIED' else 'VERIFIED:' || v.id::text end,
    'scope', '{}'::jsonb);
end
$$;

select esig.register_content_provider('compendial_rule_set', 'tab.compendial_rule_set_content(text)',
  'Compendial rule set: one version as stored and the quality unit''s latest verification against the official text (tablets spec E.1)');

-- Records QA's verification of rule set p_code version p_version (header). Returns the row's id.
create function tab.record_rule_set_verification(p_code text, p_version integer, p_document_ref text, p_note text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_ctx jsonb;
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  v_ctx := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  if not exists (select 1 from tab.compendial_rule_set s where s.code = p_code and s.version = p_version) then
    raise exception using errcode = 'P0001', message = format('EBMR-TAB-860 rule set %s version %s does not exist', coalesce(p_code, 'NULL'), coalesce(p_version::text, 'NULL'));
  end if;
  if coalesce(btrim(p_document_ref), '') = '' or length(p_document_ref) > 200 or coalesce(btrim(p_note), '') = '' or length(p_note) > 2000 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-TAB-861 a rule set verification names the official text it was checked against (a document reference) and what was checked (tablets spec E.1)';
  end if;
  perform pg_advisory_xact_lock(hashtext('tab.rule_set_verification'), hashtext(p_code || ':' || p_version));
  insert into tab.rule_set_verification (code, version, document_ref, note, recorded_by_person, recorded_by_account)
  values (p_code, p_version, btrim(p_document_ref), btrim(p_note), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- Binds QA's COMPENDIAL_RULE_SET_VERIFIED signature p_signature to the latest verification row (header).
create function tab.sign_rule_set_verification(p_code text, p_version integer, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb;
  v      tab.rule_set_verification;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  v_ctx := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  perform pg_advisory_xact_lock(hashtext('tab.rule_set_verification'), hashtext(coalesce(p_code, '') || ':' || coalesce(p_version::text, '')));
  v := tab.rule_set_latest_verification(p_code, p_version);
  if v.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-TAB-862 rule set %s version %s has no verification record to sign', coalesce(p_code, 'NULL'), coalesce(p_version::text, 'NULL'));
  end if;
  if exists (select 1 from tab.rule_set_verification_signature s where s.verification_id = v.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-TAB-862 the verification of rule set %s version %s is signed already', p_code, p_version);
  end if;
  if v.recorded_by_person::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-TAB-863 the QA person who recorded the verification signs it (tablets spec E.1)';
  end if;
  perform esig.assert_signature(p_signature, 'COMPENDIAL_RULE_SET_VERIFIED', 'compendial_rule_set', p_code || ':' || p_version);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-TAB-863 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-TAB-863 the verification is signed by the QA person who records the signature';
  end if;
  insert into tab.rule_set_verification_signature (verification_id, signature_id, signed_by_person, signed_by_account)
  values (v.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- Why rule set p_code version p_version is not verified now, or NULL (header).
create function tab.rule_set_verification_problem(p_code text, p_version integer) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, esig, pg_temp as $$
declare
  v tab.rule_set_verification := tab.rule_set_latest_verification(p_code, p_version);
  s tab.rule_set_verification_signature;
begin
  if v.id is null then
    return format('rule set %s version %s has no QA verification against the official text (tablets spec E.1)', coalesce(p_code, 'NULL'), coalesce(p_version::text, 'NULL'));
  end if;
  select * into s from tab.rule_set_verification_signature x where x.verification_id = v.id;
  if s.verification_id is null then
    return format('the QA verification of rule set %s version %s is not signed', p_code, p_version);
  end if;
  if exists (select 1 from esig.signature_invalidation i where i.signature_id = s.signature_id) then
    return format('the QA verification signature of rule set %s version %s was invalidated', p_code, p_version);
  end if;
  return null;
end
$$;

revoke all on function tab.rule_set_latest_verification(text, integer), tab.compendial_rule_set_content(text), tab.record_rule_set_verification(text, integer, text, text),
  tab.sign_rule_set_verification(text, integer, uuid), tab.rule_set_verification_problem(text, integer) from public;
grant execute on function tab.compendial_rule_set_content(text), tab.record_rule_set_verification(text, integer, text, text),
  tab.sign_rule_set_verification(text, integer, uuid), tab.rule_set_verification_problem(text, integer) to ebmr_app;

reset role;
