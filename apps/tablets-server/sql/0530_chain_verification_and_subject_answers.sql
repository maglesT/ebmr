-- Tablets edition, module C1: the application role learns from no chain verification and no external anchor whether a
-- chain exists or how long it is, and the person a data-integrity investigation is about is answered as a colleague in
-- the same role is (Phase 2 exit follow-ups F34 and F35, round 4; DI-17, DI-22, DI-50; Annex 11 and Part 11 limit
-- access to authorised persons; telling the person investigated can compromise the investigation; ADR 0012 item 9: the
-- read rules hold when the application's own database credentials are used directly).
--
-- 1. Whether a chain exists, without a session. Tablets 0470 took kernel.checkpoint_chain away because it told which
--    accounts an investigation holds, and 0430 (header) and the defaults F34.2 and F35.1 said the kernel's chain and
--    anchor verification still left to the application role "answer problems only". That was not so:
--     - kernel.verify_chain(<chain>, <from>) started at a position the caller chose. Past the end of the chain it named
--       one problem, at the chain's length, for a chain that has entries and none for one that has not; from position 0
--       it named a gap for a chain with entries only. Asked about record_hold:account:<id> for every account the
--       application role lists, it named every person under investigation;
--     - continuity.compare_external_anchors(<anchors>) weighs a forged anchor against the live chain heads: a forged
--       one-head anchor on record_hold:account:<id> came back UNEXPLAINED for a held account and DISCARDABLE for another.
--    Now the application role (GMP; the sandbox role follows through sandbox.mirror_application_privileges) executes
--    neither, nor records.verify_chain (the same verification, purge-aware), continuity.verify_external_anchors or
--    continuity.external_anchor_problems (the anchor comparison's other entry points). No screen, handler or command of
--    this installation, and no recipe-core function, calls them as the application role except the audit viewer's
--    "Verify chain", which now asks tab.audit_verify_chain below; the restore procedure (continuity.record_restore_event,
--    SECURITY DEFINER) and the owner's continuity and verification tools still run them. What the application role
--    still runs of the kernel's integrity functions: kernel.create_anchor, kernel.verify_anchor and records.verify_anchor
--    (of an anchor the database itself wrote from the real heads: a problem only where a chain differs from it),
--    kernel.run_chain_verification (an id), platform.audit_position (the number of audit entries written so far).
--
-- 2. The person an investigation is about (default F35.3, docs/decisions/phase-2-open-questions.md, which replaces the
--    "refused (403), never answered empty" of F35.1 and F35.2 for what is withheld from that person). A subject who holds
--    a governance role was told about the investigation by the session-checked reads themselves: their own account's
--    hold chain, the investigation's chains and those of the persons who opened and lead it were refused "not shown to
--    the person of this session" (EBMR-TAB-020; the verification too), a person filter on the opener or lead "not shown
--    to the person of this session", the investigation's signatures and its preview "never shown to the person it
--    investigates", where a colleague in the same role, asking about their own account or an investigation that is not
--    there, got an empty list, "no entry", an empty list of signatures and the installation's refusal of the type. Now
--    what tab.withheld_from (0440) withholds from the session's person is answered as what is not there:
--     - tab.chain_read_problem and tab.record_read_problem decide by the session's role only (0420's and 0410's rules);
--     - a withheld chain has no entries (tab.audit_events), no length (tab.audit_chain_length: the server answers 404
--       as for a chain with no entry), nothing to verify (tab.audit_verify_chain) and no registry chains
--       (tab.audit_registry_chains); the chain lists already leave it out (0440, 0490);
--     - a person filter on the opener or lead is served from the chains the person may read, without the entries the
--       investigation wrote (as 0440 filters any list across chains);
--     - an investigation about the session's person has no signatures (tab.record_signatures) and its content is that
--       of a record that does not exist (tab.content_for_signing: the kernel provider's own answer for one);
--    so a subject and a colleague in the same role get the same status, message and body shape. Withheld is unchanged:
--    the chains, entries and activity 0440 and 0470 withhold are still not shown.
--
-- 3. tab.audit_verify_chain(<token>, <chain>): the verification of a chain the session may read (EBMR-TAB-018,
--    EBMR-TAB-020 as for its events), from its first entry, then of the registry chains its view draws on (the chains
--    tab.audit_registry_chains names, through the private tab.registry_chains_of both now share), each problem naming
--    its chain; nothing for a chain withheld from the session's person.
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, keep their grants (the new one is granted below) and pin
-- their search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- DI-17, DI-22, DI-50 (F34, F35): no verification of a chain from a position the caller chooses, and no comparison of a
-- forged anchor with the live chain heads, for the application role.
revoke execute on function kernel.verify_chain(text, bigint), records.verify_chain(text),
                           continuity.compare_external_anchors(jsonb, timestamptz), continuity.verify_external_anchors(jsonb),
                           continuity.external_anchor_problems(jsonb)
  from ebmr_app;

-- DI-17, DI-50 (F34): why reader p_reader may not read record p_aggregate_type:p_aggregate_id, by the reader's role only;
-- NULL when the role may. A record withheld from the reader's person is answered as one that does not exist by the
-- readers below (tab.record_withheld), never refused for that reason.
create or replace function tab.record_read_problem(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
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
  return null;
end
$$;

-- DI-50 (F34): whether record p_aggregate_type:p_aggregate_id is withheld from the person of reader p_reader: a
-- data-integrity investigation about that person (tablets 0440's rule).
create function tab.record_withheld(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text) returns boolean
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select p_aggregate_type = 'di_investigation' and p_aggregate_id = any ((tab.withheld_from(p_reader.person_id)).investigations)
$$;

-- DI-17, DI-37, DI-50 (F34): 0410's content to be signed; an investigation about the session's person is answered as a
-- record that does not exist, as the kernel's provider answers one.
create or replace function tab.content_for_signing(p_token_hash text, p_aggregate_type text, p_aggregate_id text, p_meaning text) returns jsonb
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
  if tab.record_withheld(v_reader, p_aggregate_type, p_aggregate_id) then
    return jsonb_build_object('exists', false, 'aggregate_type', p_aggregate_type, 'aggregate_id', p_aggregate_id);
  end if;
  return esig.content_for_signing(p_aggregate_type, p_aggregate_id);
end
$$;

-- DI-17, DI-36, DI-50 (F34): 0410's signatures of a record; none of an investigation about the session's person.
create or replace function tab.record_signatures(p_token_hash text, p_aggregate_type text, p_aggregate_id text)
returns table (signature_id uuid, signer_person uuid, meaning_code text, manifestation jsonb, status text, valid boolean)
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_reader  tab.reader := tab.reader_of(p_token_hash);
  v_problem text := tab.record_read_problem(v_reader, p_aggregate_type, p_aggregate_id);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read %s %s: %s. [EBMR-TAB-020]', p_aggregate_type, p_aggregate_id, v_problem);
  end if;
  if tab.record_withheld(v_reader, p_aggregate_type, p_aggregate_id) then
    return;
  end if;
  return query select * from tab.signature_rows(p_aggregate_type, p_aggregate_id);
end
$$;

-- DI-17, DI-50 (F35): why reader p_reader may not read audit chain p_chain_key, by the reader's role only (0420's rule);
-- NULL when it may. A chain withheld from the reader's person (tab.chain_is_about of 0440) is answered as one with no
-- entries by the readers below, never refused for that reason.
create or replace function tab.chain_read_problem(p_reader tab.reader, p_chain_key text) returns text
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

-- DI-17, DI-22, DI-50 (F35): 0440's events; a chain withheld from the session's person has no entries, and a person
-- filter on a person who opened or leads an investigation about the session's person is served from the chains the
-- session may read, without the entries the investigation wrote.
create or replace function tab.audit_events(p_token_hash text, p_chain_key text, p_correlation_id uuid, p_person_id uuid, p_from_us text, p_to_us text,
                                            p_after_id text, p_up_to_id text, p_limit integer)
returns table (id text, chain_key text, seq text, us text, correlation_id text, action text, table_name text, record_id text, payload jsonb,
               login_name text, device_code text)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld tab.withheld := tab.withheld_from(v_reader.person_id);
  v_problem  text;
begin
  if p_chain_key is not null then
    v_problem := tab.chain_read_problem(v_reader, p_chain_key);
    if v_problem is not null then
      raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
    end if;
    if p_chain_key = any (v_withheld.chains) then
      return;
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
       and (p_chain_key is not null or tab.chain_listed(e.chain_key, v_record, v_gov, v_withheld.chains))
       and not tab.entry_withheld(e.payload, v_withheld)
     order by e.id
     limit greatest(coalesce(p_limit, 50), 0) + 1;
end
$$;

-- DI-17, DI-22, DI-23 (F35, F06): 0490's number of entries of a chain the session may read; NULL, as for a chain with no
-- entry, for a chain withheld from the session's person.
create or replace function tab.audit_chain_length(p_token_hash text, p_chain_key text) returns bigint
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader  tab.reader := tab.reader_of(p_token_hash);
  v_problem text := tab.chain_read_problem(v_reader, p_chain_key);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
  end if;
  if tab.chain_is_about(p_chain_key, v_reader.person_id) then
    return null;
  end if;
  return coalesce((select h.last_seq from kernel.audit_chain_head h where h.chain_key = p_chain_key),
                  (select nullif(count(*), 0) from kernel.audit_event e where e.chain_key = p_chain_key));
end
$$;

-- DI-22, DI-50 (F35): the registry chains the view of chain p_chain_key draws on (the account and terminal of every actor
-- on it, review P7), in byte order, without the account and terminal of an entry and the chains withheld (p_withheld,
-- 0470's rule). Private to the owner: the readers below check the session first.
create function tab.registry_chains_of(p_chain_key text, p_withheld tab.withheld) returns setof text
language sql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
  select k.chain_key
    from kernel.audit_event e
   cross join lateral (values ('account:' || (e.payload -> 'actor' ->> 'account_id')), ('device:' || (e.payload -> 'actor' ->> 'device_id'))) k (chain_key)
   where e.chain_key = p_chain_key and k.chain_key is not null and k.chain_key not like '%:00000000-0000-0000-0000-000000000000'
     and not tab.entry_withheld(e.payload, p_withheld)
     and not (k.chain_key = any (p_withheld.chains))
   group by k.chain_key
   order by k.chain_key collate "C"
$$;

-- DI-22, DI-50 (F35): 0470's registry chains of a chain the session may read; none for a chain withheld from the
-- session's person.
create or replace function tab.audit_registry_chains(p_token_hash text, p_chain_key text) returns setof text
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_problem  text := tab.chain_read_problem(v_reader, p_chain_key);
  v_withheld tab.withheld;
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
  end if;
  v_withheld := tab.withheld_from(v_reader.person_id);
  if p_chain_key = any (v_withheld.chains) then
    return;
  end if;
  return query select * from tab.registry_chains_of(p_chain_key, v_withheld);
end
$$;

-- DI-22, DI-23, DI-17, DI-50 (F34, F35): the verification of a chain the session bound to p_token_hash may read, from its
-- first entry (kernel.verify_chain), then of the registry chains its view draws on (tab.registry_chains_of, in byte
-- order; registry true), each problem naming its chain; EBMR-TAB-018 without such a session, EBMR-TAB-020 for a chain
-- its role may not read, and nothing for a chain withheld from its person (as for a chain with no entry).
create function tab.audit_verify_chain(p_token_hash text, p_chain_key text)
returns table (chain_key text, registry boolean, seq bigint, problem text)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_problem  text := tab.chain_read_problem(v_reader, p_chain_key);
  v_withheld tab.withheld;
  v_registry text;
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
  end if;
  v_withheld := tab.withheld_from(v_reader.person_id);
  if p_chain_key = any (v_withheld.chains) then
    return;
  end if;
  return query select p_chain_key, false, v.seq, v.problem from kernel.verify_chain(p_chain_key, 1) v;
  for v_registry in select r.c from tab.registry_chains_of(p_chain_key, v_withheld) r (c) loop
    return query select v_registry, true, v.seq, v.problem from kernel.verify_chain(v_registry, 1) v;
  end loop;
end
$$;

revoke all on function tab.record_withheld(tab.reader, text, text), tab.registry_chains_of(text, tab.withheld), tab.audit_verify_chain(text, text) from public;
grant execute on function tab.audit_verify_chain(text, text) to ebmr_app;

reset role;
