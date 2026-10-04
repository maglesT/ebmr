-- Tablets edition, module C1: on a chain the person a data-integrity investigation is about reads, the database counts,
-- dates and orders for that person only the entries shown to them (Phase 2 exit follow-up F35, round 4, lane round 2;
-- DI-17, DI-22, DI-50; Annex 11 and Part 11 limit access to authorised persons; telling the person investigated can
-- compromise the investigation).
--
-- What was wrong. Every investigation places a hold on the account of the person it is about, and the kernel notes the
-- hold on that account's own chain (records.add_hold: "di investigation hold placed", on account:<subject>; its release
-- at closure is noted there too, records.end_hold). Tablets 0440 leaves those entries out of every list of events shown
-- to the subject, but the chain list (tab.audit_chains) counted them and dated and ordered the chain by the last of them,
-- and the chain's length (tab.audit_chain_length, the "events" of the server's verification) counted them too. A subject
-- in a governance role asking about their own account chain was told 9 entries (and "Chain intact: 9 entries verified")
-- where its events showed 8, a colleague asking about their own was told 8 and shown 8, and the chain list named the
-- time of the hold as the chain's last activity and listed the chain first by it: with one request the subject saw that
-- an entry on their own account was withheld from them, which only an investigation about them does. The same held for
-- every chain the subject reads on which an investigation about them placed a hold (a batch, an MBR version: the known
-- limit default F35.2 recorded for record chains) and for a chain whose head row is missing (tablets 0490, counted from
-- its entries).
--
-- Now, for the person of the session (tab.withheld_from of 0440; nothing changes for anyone else):
--  - tab.partly_withheld_chains names the chains that carry entries withheld from that person although the chain itself
--    is read: the held records' own chains (the hold's record key, where records.add_hold and records.end_hold write),
--    with the number of entries withheld on each and the last entry that is not;
--  - tab.audit_chains (replaces 0440's) counts on such a chain the entries shown, dates it by the last of them and orders
--    the list by it; a chain on which nothing is shown is not listed;
--  - tab.audit_chain_length (replaces 0530's) counts the entries shown (NULL, as for a chain with no entry, when none
--    is), so the server's verification says as many entries were verified as the events show;
--  - tab.audit_headless_chains (replaces 0490's) counts the entries shown of a chain whose head row is missing.
-- What stays (default F35.3, known limits, recorded for the owner): the sequence numbers and event ids shown are the
-- hashed ones, so once a later entry is written on such a chain the number of the withheld entry is skipped (seq 1 to 8,
-- then 10), and a list across chains skips its event id; and a problem the verification finds on a withheld entry
-- (a tamper) is named with its sequence number. Renumbering would show values the hash chain does not cover (review P7).
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, keep their grants (the new one is private to the owner) and
-- pin their search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed and
-- never edited.

set local role ebmr_owner;

-- DI-50 (F35): the chains, other than those withheld whole (p_withheld.chains), that carry entries withheld from the
-- person p_withheld was worked out for: the held records' own chains, on which the kernel notes a hold's placing and its
-- release; with the number of entries withheld on each and the id of its last entry, by position, that is not (NULL
-- when none is shown). Private to the owner: the readers below check the session first.
create function tab.partly_withheld_chains(p_withheld tab.withheld)
returns table (chain_key text, withheld bigint, last_shown bigint)
language sql stable security definer set search_path = pg_catalog, tab, kernel, records, pg_temp as $$
  select k.chain_key,
         (select count(*) from kernel.audit_event e where e.chain_key = k.chain_key and tab.entry_withheld(e.payload, p_withheld)),
         (select e.id from kernel.audit_event e
           where e.chain_key = k.chain_key and not tab.entry_withheld(e.payload, p_withheld)
           order by e.seq desc, e.id desc limit 1)
    from (select distinct h.record_key as chain_key from records.retention_hold h where h.id::text = any (p_withheld.holds)) k
   where not (k.chain_key = any (p_withheld.chains))
$$;

-- DI-17, DI-22, DI-50 (F35): 0440's chain list; on a chain carrying entries withheld from the session's person, the
-- count is that of the entries shown, the time that of the last of them, and the list is ordered by it; a chain on which
-- nothing is shown is not listed. What is shown of each chain still comes from hashed payloads of entries the verified
-- head and the chain's positions find (review P7).
create or replace function tab.audit_chains(p_token_hash text, p_prefix text, p_limit integer)
returns table (chain_key text, last_seq text, us text)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld tab.withheld := tab.withheld_from(v_reader.person_id);
begin
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
     order by case when e.id is null then null else coalesce(s.id, e.id) end desc nulls last
     limit greatest(coalesce(p_limit, 500), 0);
end
$$;

-- DI-17, DI-22, DI-23, DI-50 (F35, F06): 0530's number of entries of a chain the session may read; on a chain carrying
-- entries withheld from the session's person, the number of entries shown (NULL, as for a chain with no entry, when none
-- is); NULL for a chain withheld whole.
create or replace function tab.audit_chain_length(p_token_hash text, p_chain_key text) returns bigint
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_problem  text := tab.chain_read_problem(v_reader, p_chain_key);
  v_withheld tab.withheld;
  v_length   bigint;
  v_hidden   bigint;
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
  end if;
  v_withheld := tab.withheld_from(v_reader.person_id);
  if p_chain_key = any (v_withheld.chains) then
    return null;
  end if;
  v_length := coalesce((select h.last_seq from kernel.audit_chain_head h where h.chain_key = p_chain_key),
                       (select nullif(count(*), 0) from kernel.audit_event e where e.chain_key = p_chain_key));
  select p.withheld into v_hidden from tab.partly_withheld_chains(v_withheld) p where p.chain_key = p_chain_key;
  if v_hidden is null then
    return v_length;
  end if;
  return nullif(greatest(v_length - v_hidden, 0), 0);
end
$$;

-- DI-23, DI-22, DI-50 (F06, F35): 0490's chains with entries but no head; the number given is that of the entries shown
-- to the session's person, and a chain on which none is shown is not listed.
create or replace function tab.audit_headless_chains(p_token_hash text, p_prefix text)
returns table (chain_key text, entries bigint)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld tab.withheld := tab.withheld_from(v_reader.person_id);
begin
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
               and tab.chain_listed(k.key, v_record, v_gov, v_withheld.chains)) c
     where c.n > 0
     order by c.key collate "C";
end
$$;

revoke all on function tab.partly_withheld_chains(tab.withheld) from public;

reset role;
