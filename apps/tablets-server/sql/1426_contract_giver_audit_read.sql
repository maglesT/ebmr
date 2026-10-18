-- Phase 7 slice 7b-1, review round 1 of 6jc-R3 (IN-30): the audit-trail reads refuse the contract giver's reviewer too.
-- tablets 1425 refused it in tab.record_read_problem only.
--
-- Handbook: modules/tablets-server.md
--
-- Why. CONTRACT_GIVER_REVIEWER holds RECORD.READ, and tab.chain_read_problem (its RECORD-class branch) and the listings of
-- tab.audit_events (no chain asked), tab.audit_chains and tab.audit_headless_chains (tab.chain_listed) grant on
-- RECORD.READ, so a reviewer's session read any batch's audit chain in the database; only the server's route allow-list
-- (bind.ts) stopped it.
--
--   tab.reader_is_contract_giver(reader)  whether the reader acts as CONTRACT_GIVER_REVIEWER or its account holds that role
--                                         now in any grant (the rule of tablets 1425).
--   tab.contract_giver_refusal(reader)    raises EBMR-TAB-020 for such a reader (the audit reads call it first).
--   tab.chain_read_problem                CREATE OR REPLACE from its latest definition (1415): first, such a reader is
--                                         refused for every chain (so tab.audit_chain_length, tab.audit_registry_chains and
--                                         tab.audit_verify_chain, which ask it, refuse too); then every rule of 1415.
--   tab.audit_events, tab.audit_chains, tab.audit_headless_chains
--                                         CREATE OR REPLACE from their latest definitions (1415): first the refusal, then
--                                         the body of 1415 unchanged.
-- Same signatures, owners, SECURITY DEFINER, search_paths and privileges. A later migration that re-creates any of them
-- starts from this definition.

set local role ebmr_owner;

create function tab.reader_is_contract_giver(p_reader tab.reader) returns boolean
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select p_reader.role_code = 'CONTRACT_GIVER_REVIEWER'
         or exists (select 1 from iam.role_grant g
                     where g.account_id = p_reader.account_id and g.role_code = 'CONTRACT_GIVER_REVIEWER'
                       and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp()))
$$;

create function tab.contract_giver_refusal(p_reader tab.reader) returns void
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if tab.reader_is_contract_giver(p_reader) then
    raise exception using errcode = 'P0001',
      message = 'This session may not read the audit trail: the contract giver''s reviewer reads only the batches of its loan licence, through its own logged reads (IN-30). [EBMR-TAB-020]';
  end if;
end
$$;

revoke all on function tab.reader_is_contract_giver(tab.reader), tab.contract_giver_refusal(tab.reader) from public;

create or replace function tab.chain_read_problem(p_reader tab.reader, p_chain_key text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_prefix  text := split_part(p_chain_key, ':', 1);
  v_rest    text := substr(p_chain_key, length(v_prefix) + 2);
  v_problem text;
begin
  -- Phase 7 slice 7b-1 (tablets 1426, 6jc-R3 round 1, IN-30): no chain is read here in the contract giver's reviewer's
  -- role or by an account holding it; its loan licence's batches are read through its own logged reads (recipe-core 1060).
  if tab.reader_is_contract_giver(p_reader) then
    return format('the contract giver''s reviewer reads only the batches of its loan licence, through its own logged reads (IN-30); the audit chain %s is not read here',
                  coalesce(p_chain_key, '(none)'));
  end if;
  -- Phase 7 slice 7a (tablets 1415, 6jc-R2, IN-53): a controlled record's chain needs CONTROLLED.READ in its scope.
  if v_prefix in ('controlled_product', 'controlled_custody', 'controlled_checkpoint', 'controlled_register_extract') then
    v_problem := tab.controlled_aggregate_problem(p_reader, v_prefix, v_rest);
    if v_problem is not null then
      return v_problem;
    end if;
  end if;
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
  -- Phase 7 slice 7b-1 (tablets 1426, 6jc-R3 round 1, IN-30): the contract giver's reviewer reads no audit trail here.
  perform tab.contract_giver_refusal(v_reader);
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
       -- Phase 7 slice 7a (tablets 1415, 6jc-R2, IN-53): no controlled-substance entry for a reader who may not read it.
       and not tab.controlled_entry_hidden(v_reader, e.payload ->> 'table', e.payload ->> 'record_id')
     order by e.id
     limit greatest(coalesce(p_limit, 50), 0) + 1;
end
$$;

create or replace function tab.audit_chains(p_token_hash text, p_prefix text, p_limit integer)
returns table (chain_key text, last_seq text, us text)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld tab.withheld := tab.withheld_from(v_reader.person_id);
begin
  -- Phase 7 slice 7b-1 (tablets 1426, 6jc-R3 round 1, IN-30): the contract giver's reviewer reads no audit trail here.
  perform tab.contract_giver_refusal(v_reader);
  return query
    with partly as (select * from tab.partly_withheld_chains(v_withheld))
    select h.chain_key,
           case when p.chain_key is null then coalesce(e.payload ->> 'seq', h.last_seq::text)
                else (coalesce((e.payload ->> 'seq')::bigint, h.last_seq) - p.withheld)::text end,
           case when e.id is null then null when p.chain_key is null then tab.audit_entry_us(e) else tab.audit_entry_us(s) end
      from kernel.audit_chain_head h
      left join kernel.audit_event e on e.chain_key = h.chain_key and e.seq = h.last_seq and e.hash = h.last_hash and e.payload ->> 'chain_key' = h.chain_key
      left join partly p on p.chain_key = h.chain_key
      left join kernel.audit_event s on s.id = p.last_shown
     where (coalesce(p_prefix, '') = '' or starts_with(h.chain_key, p_prefix))
       and tab.chain_listed(h.chain_key, v_record, v_gov, v_withheld.chains)
       and (p.chain_key is null or p.last_shown is not null)
       -- Phase 7 slice 7a (tablets 1415, 6jc-R2, IN-53): no controlled chain the reader may not read.
       and tab.controlled_aggregate_problem(v_reader, split_part(h.chain_key, ':', 1), substr(h.chain_key, length(split_part(h.chain_key, ':', 1)) + 2)) is null
     order by case when e.id is null then null else coalesce(s.id, e.id) end desc nulls last
     limit greatest(coalesce(p_limit, 500), 0);
end
$$;

create or replace function tab.audit_headless_chains(p_token_hash text, p_prefix text)
returns table (chain_key text, entries bigint)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld tab.withheld := tab.withheld_from(v_reader.person_id);
begin
  -- Phase 7 slice 7b-1 (tablets 1426, 6jc-R3 round 1, IN-30): the contract giver's reviewer reads no audit trail here.
  perform tab.contract_giver_refusal(v_reader);
  return query
    with recursive k (key) as (
      (select e.chain_key from kernel.audit_event e order by e.chain_key limit 1)
      union all
      select (select e.chain_key from kernel.audit_event e where e.chain_key > k.key order by e.chain_key limit 1)
        from k where k.key is not null
    )
    select c.key, c.n
      from (select k.key, (select count(*) from kernel.audit_event e where e.chain_key = k.key and not tab.entry_withheld(e.payload, v_withheld)) as n
              from k
             where k.key is not null
               and not exists (select 1 from kernel.audit_chain_head h where h.chain_key = k.key)
               and (coalesce(p_prefix, '') = '' or starts_with(k.key, p_prefix))
               and tab.chain_listed(k.key, v_record, v_gov, v_withheld.chains)
               -- Phase 7 slice 7a (tablets 1415, 6jc-R2, IN-53): no controlled chain the reader may not read.
               and tab.controlled_aggregate_problem(v_reader, split_part(k.key, ':', 1), substr(k.key, length(split_part(k.key, ':', 1)) + 2)) is null) c
     where c.n > 0
     order by c.key collate "C";
end
$$;

reset role;
