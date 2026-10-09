-- Tablets edition, module C1: what a data-integrity investigation writes is never shown to the person it is about,
-- whatever that person's role (Phase 2 exit review F35, round 2; DI-50, DI-17; Annex 11 and Part 11 limit access to
-- authorised persons; telling the person investigated can compromise the investigation).
--
-- Tablets 0420 withheld from the person an investigation is about only the investigation's own chain and the chains of
-- its signatures and signing requests. A subject who holds a governance role (a QA reviewer, a process owner) still read
-- everything else the investigation wrote and the persons running it:
--  - the hold chains of the records it holds (record_hold:<record key>, "data-integrity investigation DII-...", placed
--    by the opener), the subject's own account among them;
--  - the hold entries it writes on those records' own chains (a batch, an MBR version, the subject's account: "data
--    integrity investigation hold placed", and released at closure);
--  - the account and person chains of the persons who opened and lead it;
--  - through the person filter, their activity across the trail.
--
-- Now (default F35.2, docs/decisions/phase-2-open-questions.md), for every investigation about the session's person,
-- open or closed (tab.withheld_from):
--  - its chains, the chains of its signatures and signing requests, the hold chains of the records it holds, and the
--    account and person chains of the persons who opened and lead it are neither listed nor read (EBMR-TAB-020), in
--    the chain list, a list across chains, a chain's events, its length and its verification;
--  - an entry on any other chain that names one of its holds or the investigation itself (the hold placed and released)
--    is left out of every list of events;
--  - a person filter on a person who opened or leads it is refused (EBMR-TAB-020), whatever the session's role.
-- The refusals do not say why beyond "not shown to the person of this session". The application role's other doors to
-- these chains were closed by tablets 0430.
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, private to the owner unless granted, and pin their
-- search_path with pg_temp last.

set local role ebmr_owner;

-- What is withheld from one person: chain keys, the persons whose activity is, the holds and the investigations.
create type tab.withheld as (chains text[], persons text[], holds text[], investigations text[]);

-- DI-50 (F35): what every data-integrity investigation about person p_person (open or closed) withholds from that person.
-- The investigator and the opener are never the subject (records.di_investigation's checks).
create function tab.withheld_from(p_person uuid) returns tab.withheld
language sql stable security definer set search_path = pg_catalog, records, iam, pg_temp as $$
  with inv as (select i.id, i.investigator_person, i.opened_by_person from records.di_investigation i where i.subject_person_id = p_person),
       hold as (select h.id, h.record_key from records.retention_hold h join inv on inv.id = h.investigation_id),
       who as (select inv.investigator_person as p from inv union select inv.opened_by_person from inv)
  select row(
    coalesce((select array_agg(x.k order by x.k) from (
                select 'di_investigation:' || inv.id from inv
                union select 'esig_signature:di_investigation:' || inv.id from inv
                union select 'esig_challenge:di_investigation:' || inv.id from inv
                union select 'record_hold:' || hold.record_key from hold
                union select 'person:' || who.p from who
                union select 'account:' || a.id from iam.account a join who on who.p = a.person_id) x(k)), '{}'),
    coalesce((select array_agg(who.p::text order by who.p) from who), '{}'),
    coalesce((select array_agg(hold.id::text order by hold.id) from hold), '{}'),
    coalesce((select array_agg(inv.id::text order by inv.id) from inv), '{}'))::tab.withheld
$$;

-- DI-50 (F35): whether chain p_chain_key is withheld from person p_person (replaces 0420's: every chain above, not
-- only the investigation's own).
create or replace function tab.chain_is_about(p_chain_key text, p_person uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select p_chain_key = any ((tab.withheld_from(p_person)).chains)
$$;

-- DI-50 (F35): whether an audit entry names, in the details of its hashed business payload, a hold or an investigation
-- of p_withheld; false, never NULL, for an entry that names neither (it is listed).
create function tab.entry_withheld(p_payload jsonb, p_withheld tab.withheld) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_payload -> 'body' -> 'details' ->> 'hold_id' = any (p_withheld.holds)
                  or p_payload -> 'body' -> 'details' ->> 'investigation_id' = any (p_withheld.investigations), false)
$$;

-- DI-17, DI-50 (F35): whether a reader whose role holds RECORD.READ (p_record) and a governance read permission
-- (p_governance) lists chain p_chain_key, with p_withheld the chains withheld from it (replaces 0420's chain_readable,
-- which worked out what is withheld once per chain).
create function tab.chain_listed(p_chain_key text, p_record boolean, p_governance boolean, p_withheld text[]) returns boolean
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select case when tab.audit_chain_class(p_chain_key) = 'RECORD' then p_record else p_governance end
         and not (p_chain_key = any (p_withheld))
$$;
drop function tab.chain_readable(text, boolean, boolean, uuid);

-- DI-17, DI-50 (F35): why reader p_reader may not read audit chain p_chain_key; NULL when it may (0420's rule, and a
-- chain withheld from the reader's person is refused whatever the role).
create or replace function tab.chain_read_problem(p_reader tab.reader, p_chain_key text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_prefix  text := split_part(p_chain_key, ':', 1);
  v_rest    text := substr(p_chain_key, length(v_prefix) + 2);
  v_problem text;
begin
  if v_prefix in ('esig_signature', 'esig_challenge') then
    v_problem := tab.record_read_problem(p_reader, split_part(v_rest, ':', 1), substr(v_rest, length(split_part(v_rest, ':', 1)) + 2));
  elsif v_prefix = 'di_investigation' then
    v_problem := tab.record_read_problem(p_reader, 'di_investigation', v_rest);
  elsif tab.audit_chain_class(p_chain_key) = 'RECORD' then
    if not tab.role_may(p_reader.role_code, array['RECORD.READ']) then
      v_problem := format('the role %s does not hold RECORD.READ', p_reader.role_code);
    end if;
  elsif not tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
    v_problem := format('%s chains are read only in a role that reviews audit trails, data integrity or access, or audits (one holding %s); the role %s holds none of these',
                        v_prefix, array_to_string(tab.governance_read_permissions(), ', '), p_reader.role_code);
  end if;
  if v_problem is null and tab.chain_is_about(p_chain_key, p_reader.person_id) then
    v_problem := 'this chain is not shown to the person of this session';
  end if;
  return v_problem;
end
$$;

-- DI-17, DI-22, DI-50 (F35): 0420's chain list, without the chains withheld from the session's person.
create or replace function tab.audit_chains(p_token_hash text, p_prefix text, p_limit integer)
returns table (chain_key text, last_seq text, us text)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld text[] := (tab.withheld_from(v_reader.person_id)).chains;
begin
  return query
    select h.chain_key, coalesce(e.payload ->> 'seq', h.last_seq::text), case when e.id is null then null else tab.audit_entry_us(e) end
      from kernel.audit_chain_head h
      left join kernel.audit_event e on e.chain_key = h.chain_key and e.seq = h.last_seq and e.hash = h.last_hash and e.payload ->> 'chain_key' = h.chain_key
     where (coalesce(p_prefix, '') = '' or starts_with(h.chain_key, p_prefix))
       and tab.chain_listed(h.chain_key, v_record, v_gov, v_withheld)
     order by e.id desc nulls last
     limit greatest(coalesce(p_limit, 500), 0);
end
$$;

-- DI-17, DI-22, DI-50 (F35): 0420's events, without the chains and entries withheld from the session's person, and
-- with no person filter on a person who opened or leads an investigation about the session's person.
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
  end if;
  if p_person_id is not null and p_person_id <> v_reader.person_id then
    if not v_gov then
      raise exception using errcode = 'P0001', message = format(
        'Another person''s activity across the audit trail is read only in a role that reviews audit trails, data integrity or access, or audits (one holding %s); the role %s holds none of these. [EBMR-TAB-020]',
        array_to_string(tab.governance_read_permissions(), ', '), v_reader.role_code);
    end if;
    if p_person_id::text = any (v_withheld.persons) then
      raise exception using errcode = 'P0001', message = 'This person''s activity across the audit trail is not shown to the person of this session. [EBMR-TAB-020]';
    end if;
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

revoke all on function tab.withheld_from(uuid), tab.entry_withheld(jsonb, tab.withheld), tab.chain_listed(text, boolean, boolean, text[]) from public;

reset role;
