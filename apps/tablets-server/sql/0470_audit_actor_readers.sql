-- Tablets edition, module C1: the application role finds no investigation, its subject or the persons running it
-- through the kernel's readers of who acted on a chain, and the person an investigation is about learns nothing of it
-- from the verification of a chain they read (Phase 2 exit review F35, round 3; DI-17, DI-50, DI-22; Annex 11 and
-- Part 11 limit access to authorised persons; ADR 0012 item 9: the read rules hold when the application's own database
-- credentials are used directly).
--
-- Tablets 0420 took the audit tables away from the application role and 0430 the kernel's chain extract, person
-- activity, scoping report and chain lists, but these still ran for it with no session token (SECURITY DEFINER, kernel):
--  - iam.chain_persons(<chain>) returned every person who acted on any chain: on di_investigation:<id> and on
--    record_hold:account:<the account of the person investigated>, the person who opened the investigation; on
--    account:<id>, everyone who acted on that account;
--  - iam.record_entry_persons(<table>, <id>) returned the persons who created or changed any row (on
--    records.di_investigation, the opener);
--  - kernel.checkpoint_chain(<chain>, <reason>) refuses a chain with no entries and checkpoints any other: tried on
--    record_hold:account:<id> for every account the application role lists, it told which accounts an investigation
--    holds, that is who is investigated;
--  - platform.entries_in_time_fault_windows() lists every audit entry written during a time fault, of any chain, with
--    its chain key, table and record id (an investigation's and its holds' among them);
--  - iam.segregation_evaluation names, for each signing, the record and the persons excluded from signing it: for an
--    investigation's closure, the investigation and the persons who opened and lead it.
-- And tab.audit_registry_chains (0420), which names the account and terminal chains that the verification of a chain
-- also checks, still named to the person an investigation is about the account and terminal of an entry withheld from
-- that person (the opener placing a hold on their record or account) and the account chains of the persons who opened
-- and lead it, which tablets 0440 withholds from them.
--
-- Now (defaults F35.1 and F35.2, docs/decisions/phase-2-open-questions.md):
--  - the application role (GMP; the sandbox role follows through sandbox.mirror_application_privileges) executes none
--    of the four functions and selects no segregation evaluation. No screen, handler or command of this installation,
--    and no recipe-core function, uses them as the application role; the kernel's own SECURITY DEFINER code (the
--    signing ceremony, the purge) and the owner's tools still do;
--  - tab.audit_registry_chains leaves out, for the session's person, the account and terminal of every entry withheld
--    from that person (tab.entry_withheld of 0440) and every chain withheld from them (tab.withheld_from): their
--    verification of a chain they read neither names nor checks those chains (the scheduled verification of every
--    chain still does).
--
-- The function is SECURITY DEFINER, owned by ebmr_owner, keeps 0420's grant and pins its search_path with pg_temp last.

set local role ebmr_owner;

-- DI-17, DI-50, DI-22 (F35): who acted on a chain or a row, whether a chain exists, the entries of a time fault, and
-- the persons excluded from a signing.
revoke execute on function iam.chain_persons(text), iam.record_entry_persons(regclass, text), kernel.checkpoint_chain(text, text),
                           platform.entries_in_time_fault_windows()
  from ebmr_app;
revoke select on iam.segregation_evaluation from ebmr_app;

-- DI-22, DI-50 (F35): 0420's registry chains of a chain the session may read, without the account and terminal of an
-- entry withheld from the session's person and without a chain withheld from that person.
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
  return query
    select k.chain_key
      from kernel.audit_event e
     cross join lateral (values ('account:' || (e.payload -> 'actor' ->> 'account_id')), ('device:' || (e.payload -> 'actor' ->> 'device_id'))) k (chain_key)
     where e.chain_key = p_chain_key and k.chain_key is not null and k.chain_key not like '%:00000000-0000-0000-0000-000000000000'
       and not tab.entry_withheld(e.payload, v_withheld)
       and not (k.chain_key = any (v_withheld.chains))
     group by k.chain_key
     order by k.chain_key collate "C";
end
$$;

reset role;
