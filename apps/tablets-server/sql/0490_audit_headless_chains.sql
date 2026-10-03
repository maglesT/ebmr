-- Tablets edition, module C1: a chain whose head row was deleted is still a chain of the audit viewer: it is listed,
-- and "Verify chain" reports the tamper instead of saying that no entry was ever written (Phase 2 exit review F06;
-- DI-23, DI-22; INV-08).
--
-- The viewer's reads (tablets 0420 and 0440) took the chains that exist from kernel.audit_chain_head only:
--  - tab.audit_chains listed heads, so a chain whose head a superuser deleted (for example to hide entries removed from
--    its tail) disappeared from the chain list, while its entries were still shown by tab.audit_events;
--  - tab.audit_chain_length answered NULL for it, and the server answered 404 "This audit chain does not exist on this
--    installation. No audit entry was ever written on chain X" without asking kernel.verify_chain, which names exactly
--    this tamper ("chain head is missing although the chain has events (head deleted)").
-- The scheduled verification of every chain already finds such a chain through its entries (kernel.chain_keys).
--
-- Now:
--  - tab.audit_headless_chains lists, for the session bound to p_token_hash and under the same read rules as the chain
--    list (tab.chain_listed of 0440: read class, role, and the chains withheld from an investigation's subject), every
--    chain that has entries but no head, with the number of entries found, in byte order. The chain keys are found by
--    a skip scan of the (chain_key, seq) index, never by reading every entry;
--  - tab.audit_chain_length (CREATE OR REPLACE) answers, for a chain without a head, the number of entries found, and
--    NULL only when the chain has neither a head nor an entry: the server then verifies it and reports the problems.
-- Nothing shown in the list is taken from an entry that does not match a verified head (review P7): a chain without a
-- head is listed with no count and no time, flagged so the screen says to verify it.
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, private to the owner unless granted below, and pin their
-- search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-23, DI-22 (F06): the chains with entries but no head that the session bound to p_token_hash may list, optionally by
-- key prefix, with the number of entries found, in byte order.
create function tab.audit_headless_chains(p_token_hash text, p_prefix text)
returns table (chain_key text, entries bigint)
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_record   boolean := tab.role_may(v_reader.role_code, array['RECORD.READ']);
  v_gov      boolean := tab.role_may(v_reader.role_code, tab.governance_read_permissions());
  v_withheld text[] := (tab.withheld_from(v_reader.person_id)).chains;
begin
  return query
    with recursive k (key) as (
      (select e.chain_key from kernel.audit_event e order by e.chain_key limit 1)
      union all
      select (select e.chain_key from kernel.audit_event e where e.chain_key > k.key order by e.chain_key limit 1)
        from k where k.key is not null
    )
    select k.key, (select count(*) from kernel.audit_event e where e.chain_key = k.key)
      from k
     where k.key is not null
       and not exists (select 1 from kernel.audit_chain_head h where h.chain_key = k.key)
       and (coalesce(p_prefix, '') = '' or starts_with(k.key, p_prefix))
       and tab.chain_listed(k.key, v_record, v_gov, v_withheld)
     order by k.key collate "C";
end
$$;

-- DI-17, DI-22, DI-23 (F35, F06): the number of entries of a chain the session bound to p_token_hash may read
-- (EBMR-TAB-020 when it may not): the head's count, or, when the head row is missing, the entries found; NULL only when
-- no entry was ever written on it and it has no head.
create or replace function tab.audit_chain_length(p_token_hash text, p_chain_key text) returns bigint
language plpgsql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_problem text := tab.chain_read_problem(tab.reader_of(p_token_hash), p_chain_key);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the audit chain %s: %s. [EBMR-TAB-020]', p_chain_key, v_problem);
  end if;
  return coalesce((select h.last_seq from kernel.audit_chain_head h where h.chain_key = p_chain_key),
                  (select nullif(count(*), 0) from kernel.audit_event e where e.chain_key = p_chain_key));
end
$$;

revoke all on function tab.audit_headless_chains(text, text) from public;
grant execute on function tab.audit_headless_chains(text, text) to ebmr_app;

reset role;
