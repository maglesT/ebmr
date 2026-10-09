-- Tablets edition, module C1: who may read which audit chains (Phase 2 exit review F35; DI-17, DI-16, DI-22, DI-50;
-- Annex 11 and Part 11 limit access to authorised persons; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- The audit viewer (GET /api/audit/chains, /api/audit/events, /api/audit/chains/:key/verify) checked nothing beyond a
-- live session with a role, and its read model selected kernel.audit_event and kernel.audit_chain_head directly, which
-- the application role may read whole: an operator on a shop-floor kiosk read every account, person, badge, terminal,
-- role-grant, delegation and break-glass chain (revocation reasons, credential issues, status changes with their
-- reasons), the existence and opener of every data-integrity investigation, and, through the person filter, a
-- cross-chain list of everything a named colleague did: the scoping report of a data-integrity investigation, open to
-- anyone, including the person investigated.
--
-- The rule (default F35.1, docs/decisions/phase-2-open-questions.md), decided by the database for the session whose
-- cookie token the server presents (tab.reader_of of 0410: an active session in a role granted now, EBMR-TAB-018):
--  - a chain of the RECORD class (tab.audit_chain_class: batches, MBR families, versions, change records, market
--    authorisations and risk assessments, test packages, market rules, records' types and true copies, the demo stub
--    and sample records, platform settings, time sources, sandbox lots and readings, the engine's and the signing
--    catalogue's configuration; the signatures and signing requests of a RECORD-class record) is read in a role holding
--    RECORD.READ;
--  - every other chain (accounts, persons, badges, terminals, roles, permissions and policies, delegations, security
--    alerts, gateway and seal keys, data-integrity investigations, incidents, holds, retention, tombstones, backups,
--    restores and continuity alarms, the signatures of such records, and any prefix not named: fail closed) is of the
--    GOVERNANCE class: read only in a role holding RECORD.AUDIT_TRAIL_REVIEW, VALIDATION.MANAGE, IAM.ACCESS_RECERTIFY or
--    RECORD.EXPORT (QA reviewer, CSV/DI lead, process owner, auditor), and the chains of a data-integrity investigation
--    never by the person it investigates (tab.record_read_problem of 0410);
--  - the list of the chains and a list of events across chains show only the chains the session may read;
--  - a person filter names the session's own person, or needs a GOVERNANCE role (a colleague's activity across the trail
--    is an investigation's scoping report);
--  - a chain is verified only by a session that may read it (verification also checks the account and terminal chains
--    its view draws on, and names a problem there, never their content).
-- An entry's user ID and terminal code still come from the hashed INSERT entries of the account and terminal chains
-- (review P7), read by these functions as the owner.
--
-- The application role loses SELECT on kernel.audit_event and kernel.audit_chain_head: it reads the audit trail only
-- through these functions, the settled horizon (tab.audit_horizon_max: an id) and the role an MBR content revision was
-- saved in (tab.mbr_content_saved_role: a RECORD-class chain).
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, private to the owner unless granted below, and pin their
-- search_path with pg_temp last.

set local role ebmr_owner;

-- DI-17 (F35): the read class of an audit chain (by its key's prefix). RECORD: read with RECORD.READ; GOVERNANCE (every
-- prefix not named here, fail closed): read only in a governance or audit role. A signature's or signing request's chain
-- (esig_signature:<type>:<id>, esig_challenge:<type>:<id>) has the class of its record.
create function tab.audit_chain_class(p_chain_key text) returns text
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select case
           when split_part(p_chain_key, ':', 1) in ('esig_signature', 'esig_challenge') then tab.aggregate_read_class(split_part(p_chain_key, ':', 2))
           when split_part(p_chain_key, ':', 1) in (
             'batch', 'mbr_family', 'mbr_version', 'mbr_change_record', 'mbr_market_authorisation', 'mbr_risk_assessment', 'test_package',
             'esig_stub', 'sample_record', 'state', 'device_reading', 'sandbox_lot', 'sandbox_only_block', 'attribution_method',
             'record_type', 'true_copy', 'reference_document', 'esig_meaning', 'esig_policy', 'execution_command_permission',
             'execution_signature_meaning', 'engine_role_map', 'engine_role_permission', 'block_signature_meaning',
             'batch_number_register', 'number_sequence', 'time_source', 'time_node', 'time_anomaly', 'platform_setting',
             'qualification_type', 'qualification_requirement')
             or split_part(p_chain_key, ':', 1) like 'market\_%'
             then 'RECORD'
           else 'GOVERNANCE'
         end
$$;

-- DI-17, DI-50 (F35): why reader p_reader may not read audit chain p_chain_key; NULL when it may. The chains of a record
-- with a read rule of its own (a data-integrity investigation, a signature or signing request) follow that record's
-- rule (tab.record_read_problem of 0410).
create function tab.chain_read_problem(p_reader tab.reader, p_chain_key text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_prefix text := split_part(p_chain_key, ':', 1);
  v_rest   text := substr(p_chain_key, length(v_prefix) + 2);
begin
  if v_prefix in ('esig_signature', 'esig_challenge') then
    return tab.record_read_problem(p_reader, split_part(v_rest, ':', 1), substr(v_rest, length(split_part(v_rest, ':', 1)) + 2));
  end if;
  if v_prefix = 'di_investigation' then
    return tab.record_read_problem(p_reader, 'di_investigation', v_rest);
  end if;
  if tab.audit_chain_class(p_chain_key) = 'RECORD' then
    if tab.role_may(p_reader.role_code, array['RECORD.READ']) then
      return null;
    end if;
    return format('the role %s does not hold RECORD.READ', p_reader.role_code);
  end if;
  if tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
    return null;
  end if;
  return format('%s chains are read only in a role that reviews audit trails, data integrity or access, or audits (one holding %s); the role %s holds none of these',
                v_prefix, array_to_string(tab.governance_read_permissions(), ', '), p_reader.role_code);
end
$$;

-- DI-50 (F35): whether chain p_chain_key is about person p_person: the chain of a data-integrity investigation of that
-- person, or of a signature or signing request of such an investigation.
create function tab.chain_is_about(p_chain_key text, p_person uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select coalesce(case
           when p_chain_key like 'di\_investigation:%' then
             exists (select 1 from records.di_investigation i where i.id::text = split_part(p_chain_key, ':', 2) and i.subject_person_id = p_person)
           when p_chain_key like 'esig\_signature:di\_investigation:%' or p_chain_key like 'esig\_challenge:di\_investigation:%' then
             exists (select 1 from records.di_investigation i where i.id::text = split_part(p_chain_key, ':', 3) and i.subject_person_id = p_person)
           else false
         end, false)
$$;

-- DI-17, DI-50 (F35): whether a chain may be read by a reader whose role holds RECORD.READ (p_record) and a governance
-- read permission (p_governance) and who is person p_person: the rule of tab.chain_read_problem, for lists.
create function tab.chain_readable(p_chain_key text, p_record boolean, p_governance boolean, p_person uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select case when tab.audit_chain_class(p_chain_key) = 'RECORD' then p_record else p_governance end
         and not tab.chain_is_about(p_chain_key, p_person)
$$;

-- The hashed time of an entry as UTC epoch microseconds (the column only if the payload's value is not a time).
create function tab.audit_entry_us(e kernel.audit_event) returns text
language sql stable set search_path = pg_catalog, kernel, pg_temp as $$
  select (extract(epoch from case when pg_input_is_valid(e.payload ->> 'recorded_at', 'timestamptz')
                                  then (e.payload ->> 'recorded_at')::timestamptz else e.recorded_at end) * 1000000)::bigint::text
$$;

-- A registry value as its own chain hashed it (review P7): `field` of the new row of the audited INSERT of p_table whose
-- record is p_id, on chain <p_prefix>:<p_id>.
create function tab.audit_registry_value(p_prefix text, p_table text, p_id text, p_field text) returns text
language sql stable security definer set search_path = pg_catalog, kernel, pg_temp as $$
  select x.payload -> 'body' -> 'new' ->> p_field
    from kernel.audit_event x
   where x.chain_key = p_prefix || ':' || p_id
     and x.payload ->> 'action' = 'INSERT' and x.payload ->> 'table' = p_table and x.payload ->> 'record_id' = p_id
   order by x.seq limit 1
$$;

-- DI-17, DI-22, DI-50 (F35): the chains the session bound to p_token_hash may read, optionally by key prefix (taken
-- literally), newest activity first. What is shown of each comes from the hashed payload of the entry the verified head
-- names (review P7: the head's last_event pointer is never used).
create function tab.audit_chains(p_token_hash text, p_prefix text, p_limit integer)
returns table (chain_key text, last_seq text, us text)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader tab.reader := tab.reader_of(p_token_hash);
  v_record boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov    boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
begin
  return query
    select h.chain_key, coalesce(e.payload ->> 'seq', h.last_seq::text), case when e.id is null then null else tab.audit_entry_us(e) end
      from kernel.audit_chain_head h
      left join kernel.audit_event e on e.chain_key = h.chain_key and e.seq = h.last_seq and e.hash = h.last_hash and e.payload ->> 'chain_key' = h.chain_key
     where (coalesce(p_prefix, '') = '' or starts_with(h.chain_key, p_prefix))
       and tab.chain_readable(h.chain_key, v_record, v_gov, v_reader.person_id)
     order by e.id desc nulls last
     limit greatest(coalesce(p_limit, 500), 0);
end
$$;

-- DI-17, DI-22, DI-50 (F35): events of the chains the session bound to p_token_hash may read, in id order, filtered by
-- chain, correlation, person (the session's own, or any in a GOVERNANCE role) and time, keyset-paged after p_after_id and
-- up to p_up_to_id; one row more than p_limit tells whether more exist. A chain or person the session may not read is
-- refused (EBMR-TAB-020), never answered with an empty list.
create function tab.audit_events(p_token_hash text, p_chain_key text, p_correlation_id uuid, p_person_id uuid, p_from_us text, p_to_us text,
                                 p_after_id text, p_up_to_id text, p_limit integer)
returns table (id text, chain_key text, seq text, us text, correlation_id text, action text, table_name text, record_id text, payload jsonb,
               login_name text, device_code text)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader  tab.reader := tab.reader_of(p_token_hash);
  v_record  boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov     boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_problem text;
begin
  if p_chain_key is not null then
    v_problem := tab.chain_read_problem(v_reader, p_chain_key);
    if v_problem is not null then
      raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
    end if;
  end if;
  if p_person_id is not null and p_person_id <> v_reader.person_id and not v_gov then
    raise exception using errcode = 'P0001', message = format(
      'Another person''s activity across the audit trail is read only in a role that reviews audit trails, data integrity or access, or audits (one holding %s); the role %s holds none of these. [EBMR-TAB-020]',
      array_to_string(tab.governance_read_permissions(), ', '), v_reader.role_code);
  end if;
  return query
    select e.id::text, coalesce(e.payload ->> 'chain_key', ''), coalesce(e.payload ->> 'seq', ''), tab.audit_entry_us(e),
           e.payload ->> 'correlation_id', coalesce(e.payload ->> 'action', ''), e.payload ->> 'table', e.payload ->> 'record_id', e.payload,
           tab.audit_registry_value('account', 'iam.account', e.payload -> 'actor' ->> 'account_id', 'login_name'),
           tab.audit_registry_value('device', 'iam.device', e.payload -> 'actor' ->> 'device_id', 'code')
      from kernel.audit_event e
     where (p_chain_key is null or e.chain_key = p_chain_key)
       and (p_correlation_id is null or e.correlation_id = p_correlation_id)
       and (p_person_id is null or e.payload -> 'actor' ->> 'person_id' = p_person_id::text)
       and (p_from_us is null or e.recorded_at >= timestamptz 'epoch' + p_from_us::bigint * interval '1 microsecond')
       and (p_to_us is null or e.recorded_at <= timestamptz 'epoch' + p_to_us::bigint * interval '1 microsecond')
       and (p_after_id is null or e.id > p_after_id::bigint)
       and (p_up_to_id is null or e.id <= p_up_to_id::bigint)
       and (p_chain_key is not null or tab.chain_readable(e.chain_key, v_record, v_gov, v_reader.person_id))
     order by e.id
     limit greatest(coalesce(p_limit, 50), 0) + 1;
end
$$;

-- DI-17, DI-22 (F35): the number of entries of a chain the session bound to p_token_hash may read (EBMR-TAB-020 when it
-- may not); NULL when no entry was ever written on it.
create function tab.audit_chain_length(p_token_hash text, p_chain_key text) returns bigint
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_problem text := tab.chain_read_problem(tab.reader_of(p_token_hash), p_chain_key);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
  end if;
  return (select h.last_seq from kernel.audit_chain_head h where h.chain_key = p_chain_key);
end
$$;

-- DI-23 (F35): the registry chains the view of a chain the session may read draws on (the account and terminal of every
-- actor on it, review P7), in byte order, for its verification; EBMR-TAB-020 when it may not read the chain.
create function tab.audit_registry_chains(p_token_hash text, p_chain_key text) returns setof text
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_problem text := tab.chain_read_problem(tab.reader_of(p_token_hash), p_chain_key);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
  end if;
  return query
    select k.chain_key
      from kernel.audit_event e
     cross join lateral (values ('account:' || (e.payload -> 'actor' ->> 'account_id')), ('device:' || (e.payload -> 'actor' ->> 'device_id'))) k (chain_key)
     where e.chain_key = p_chain_key and k.chain_key is not null and k.chain_key not like '%:00000000-0000-0000-0000-000000000000'
     group by k.chain_key
     order by k.chain_key collate "C";
end
$$;

-- DI-22 (F35): the highest audit entry id (the settled horizon of a list across chains, review P11); an id, nothing more.
create function tab.audit_horizon_max() returns bigint
language sql stable security definer set search_path = pg_catalog, kernel, pg_temp as $$
  select max(e.id) from kernel.audit_event e
$$;

-- DI-22 (F35): the role an MBR content revision was saved in, from its audited INSERT on its version's chain (a
-- RECORD-class chain the designer shows beside the content).
create function tab.mbr_content_saved_role(p_version_id uuid, p_content_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, kernel, pg_temp as $$
  select e.payload -> 'actor' ->> 'role_code'
    from kernel.audit_event e
   where e.chain_key = 'mbr_version:' || p_version_id and e.table_name = 'recipe.mbr_content' and e.record_id = p_content_id::text
   order by e.seq limit 1
$$;

revoke all on function tab.audit_chain_class(text), tab.chain_read_problem(tab.reader, text), tab.chain_is_about(text, uuid),
                       tab.chain_readable(text, boolean, boolean, uuid), tab.audit_entry_us(kernel.audit_event),
                       tab.audit_registry_value(text, text, text, text), tab.audit_chains(text, text, integer),
                       tab.audit_events(text, text, uuid, uuid, text, text, text, text, integer), tab.audit_chain_length(text, text),
                       tab.audit_registry_chains(text, text), tab.audit_horizon_max(), tab.mbr_content_saved_role(uuid, uuid) from public;
grant execute on function tab.audit_chain_class(text), tab.audit_chains(text, text, integer),
                          tab.audit_events(text, text, uuid, uuid, text, text, text, text, integer), tab.audit_chain_length(text, text),
                          tab.audit_registry_chains(text, text), tab.audit_horizon_max(), tab.mbr_content_saved_role(uuid, uuid) to ebmr_app;

-- The application reads the audit trail only through the functions above.
revoke select on kernel.audit_event, kernel.audit_chain_head from ebmr_app;

reset role;
