-- Recipe core: a market-authorisation record is the record of its version's own family, whoever writes it (INV-17,
-- PR-04; SQL mutation round 2 of the group market-authorisation-and-issue, defect 1).
--
-- recipe.market_authorisation names a family and a version. recipe.propose_market_authorisation takes the family from
-- the version, and the BRIDGING successor from the same family, but the table's guard (0160) only stamped the proposer:
-- an owner-level writer could file another family's version under a family, or name another family's version as the
-- successor. Every INV-17 rule downstream trusts the record's family: authorisation_cell_insert_guard has a cell repeat
-- it, the one-open-CURRENT index and the no-overlap constraint hold per family, and recipe.valid_cells and the pin guard
-- select by it. Such a record, once signed by QA and the regulatory signer and activated, made the other family's
-- version CURRENT for this family's batches, outside the constraints of its own family, and the invariant queries
-- reported nothing. recipe.activate_market_authorisation compares the version numbers of the predecessor's cell and of
-- the new version on the same footing: within one family, distinct versions have distinct numbers.
--
-- From this migration on, the BEFORE INSERT guard refuses (EBMR-RCP-094):
--   * a record whose family is not the family of its version (an unknown version included);
--   * a record whose successor, when it names one (BRIDGING), is not a version of that family.
-- The proposal's own checks (an APPROVED version linked to the market, an approved later successor, the cells) stay
-- in recipe.propose_market_authorisation; only the family, which every INV-17 rule relies on, moves to the table.
--
-- Privileges: CREATE OR REPLACE keeps those of 0160 (the trigger function private to the owner).

set local role ebmr_owner;

create or replace function recipe.market_authorisation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  if new.family_id is distinct from (select v.family_id from recipe.mbr_version v where v.id = new.version_id) then
    raise exception using errcode = 'P0001', message = 'A market authorisation is recorded under its version''s own family (INV-17; EBMR-RCP-094)';
  end if;
  if new.successor_version_id is not null
     and new.family_id is distinct from (select s.family_id from recipe.mbr_version s where s.id = new.successor_version_id) then
    raise exception using errcode = 'P0001', message = 'A BRIDGING validity names a successor of its version''s own family (INV-17; EBMR-RCP-094)';
  end if;
  new.proposed_by_person := (v_ctx ->> 'person_id')::uuid;
  new.proposed_by_account := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;

reset role;
