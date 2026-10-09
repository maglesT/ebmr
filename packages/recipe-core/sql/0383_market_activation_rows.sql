-- Recipe core, MBR life cycle (A3): a market authorisation's activation and its cells are written only as the activation
-- command writes them, whoever writes them (Phase 2 exit, SQL mutation kill work, defect D10; decision D10.1; INV-17,
-- PR-02, PR-04, PR-05, DI-04, DI-37; the table guards act on every writer, including owner-level code, 0160).
--
-- Correction of 0160's header, stated here because applied migrations are never edited. 0160 says a version becomes usable
-- for a market only through a signed record activated by recipe.activate_market_authorisation, and that "a cell can be
-- created only for an activated record whose two signatures are valid". The activation table had only the trigger that
-- stamps the person, and the cell guard did not read the version's state, so owner-level code could write an activation
-- row and a CURRENT cell for a version that is only CHECKED, around every check of the activation command (version
-- APPROVED, complete verification record, the QA signer activating, two persons, the effective date the command computes,
-- the supersession of the predecessor), and the issue command then pinned batches to it (the kill agent and the skeptic of
-- the market-authorisation-and-issue group; reproduced by packages/recipe-core/test/mutation/
-- market-authorisation-and-issue.test.ts "D10: ...").
--
-- What changed (decision D10.1): the table guards re-check the activation command's conditions, so a row written around
-- the command is accepted only when the command itself would have written it. No marker of the command is used: owner-
-- level code can write an owner-only marker as easily as the row, while the conditions hold for any writer.
--   * recipe.market_authorisation_activation_guard, run by the trigger a2_guard before insert on
--     recipe.market_authorisation_activation (after a1_stamp, which stamps the person), refuses an activation row
--     unless, as recipe.activate_market_authorisation requires (0290): the actor is no administrator and holds
--     MBR.APPROVE in the version's scope, with a reason of their own (EBMR-AUDIT-002); the record is known and PROPOSED
--     (EBMR-RCP-083); its QA (MBR_MARKET_AUTHORISED) and regulatory (REGULATORY_CONFIRMED) signatures are valid for it
--     (EBMR-ESIG-070); the QA signer is the person activating and the regulatory signer another person (EBMR-RCP-085); the
--     version is APPROVED (its state row, read with a share lock; EBMR-RCP-086) with a complete verification record
--     (DI-04; EBMR-RCP-087); the activation takes effect at the latest of the record's requested date, the version's
--     effective date and the moment of the activation, so never before this transaction began nor before either date,
--     and later than now only at exactly the later of the two dates (PR-02; EBMR-RCP-095); a BRIDGING window has not
--     ended by then (EBMR-RCP-082);
--   * recipe.authorisation_cell_activation_guard, run by the trigger a2_activation before insert on
--     recipe.authorisation_cell (after a1_guard, 0160, which checks the record, its signatures and that the cell repeats
--     it), refuses a cell unless its version is APPROVED (EBMR-RCP-086) and its record not withdrawn (EBMR-RCP-092); a
--     cell that supersedes another (superseded_by, set in the same transaction) is the successor of the CURRENT cell of an
--     earlier version of the same family, market and scope, which ends where it begins (PR-05; EBMR-RCP-089); and a
--     BRIDGING cell is given only where the record's successor superseded its version for that market and scope
--     (EBMR-RCP-090);
--   * recipe.authorisation_cell_supersession_guard, run by the trigger a2_supersession before update on
--     recipe.authorisation_cell (after a1_guard_update, 0160, which lets a CURRENT cell end SUPERSEDED with any
--     superseded_by), refuses a cell superseded by a cell that exists already: its successor is written after it in the
--     same transaction (the deferred foreign key makes it exist by the commit), so the successor's insert is judged
--     against it by the cell guard above (EBMR-RCP-089). Without it a writer could supersede the predecessor by naming an
--     older cell and then insert the new cell with no predecessor to judge.
-- Not changed here (reported, D10.1): the end of a cell (CURRENT or BRIDGING to WITHDRAWN) and the withdrawal row are
-- still accepted from owner-level code around recipe.withdraw_market_authorisation and recipe.retire_version; they only
-- take an authorisation away, so no batch can be pinned by them to a version the command would not make usable. The
-- guards read the version's state row (platform.aggregate_state); a state row moved along a published transition under
-- the state engine's session flag, which any role can set (D11, open), is trusted here as the issue trusts it.
-- The kill test of recipe.guard_in_flight_dispositioned#3 arranged a batch pinned to a CHECKED version this way (a forged
-- APPROVED history row, then the activation and the cell written directly); that arrangement is refused now: a cell, and
-- so a pinned batch, needs the version's state row APPROVED (D10.1).
--
-- New functions are owned by ebmr_owner and private to the owner (no EXECUTE for PUBLIC); all three are SECURITY DEFINER
-- with a pinned search_path, pg_temp last. Applied as a new migration because applied migrations are checksummed and
-- never edited.

set local role ebmr_owner;

-- INV-17, PR-02, DI-04, DI-37 (D10): an activation row is the one recipe.activate_market_authorisation writes (header).
create function recipe.market_authorisation_activation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, iam, esig, kernel, pg_temp as $$
declare
  a       recipe.market_authorisation;
  v       recipe.mbr_version;
  v_ctx   jsonb;
  v_qa    jsonb;
  v_reg   jsonb;
  v_ev    jsonb;
  v_floor timestamptz;
begin
  perform iam.assert_not_administrator();
  select * into a from recipe.market_authorisation where id = new.authorisation_id;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown market authorisation %s (EBMR-RCP-083)', new.authorisation_id);
  end if;
  v_ctx := iam.require_permission('MBR.APPROVE', recipe.version_scope(a.version_id));
  perform recipe.require_own_reason('the activation of a market authorisation');
  if recipe.market_authorisation_state(a.id) <> 'PROPOSED' then
    raise exception using errcode = 'P0001',
      message = format('This authorisation is %s; only a PROPOSED record is activated (EBMR-RCP-083)', recipe.market_authorisation_state(a.id));
  end if;
  v_qa := esig.assert_signature(new.qa_signature_id, 'MBR_MARKET_AUTHORISED', 'mbr_market_authorisation', a.id::text);
  v_reg := esig.assert_signature(new.regulatory_signature_id, 'REGULATORY_CONFIRMED', 'mbr_market_authorisation', a.id::text);
  if (v_qa ->> 'signer_person') is distinct from (v_ctx ->> 'person_id') then
    raise exception using errcode = 'P0001', message = 'The QA person who signed the authorisation activates it (DI-37; EBMR-RCP-085)';
  end if;
  if (v_reg ->> 'signer_person') is not distinct from (v_qa ->> 'signer_person') then
    raise exception using errcode = 'P0001',
      message = 'QA and the regulatory-conformity signer are two different persons (ADR 0014; EBMR-RCP-085)';
  end if;
  select * into v from recipe.mbr_version where id = a.version_id;
  if recipe.version_state_locked(v.id) is distinct from 'APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('Version %s is %s: only an APPROVED version becomes CURRENT or BRIDGING (ADR 0014; EBMR-RCP-086)', v.version_number, recipe.version_state(v.id));
  end if;
  v_ev := recipe.evidence_status(v.id);
  if not coalesce((v_ev ->> 'complete')::boolean, false) then
    raise exception using errcode = 'P0001',
      message = format('The version has no complete verification record for its content (%s); it cannot become effective for a market (DI-04; EBMR-RCP-087)',
                       (select string_agg(m, '; ') from jsonb_array_elements_text(v_ev -> 'missing') m));
  end if;
  -- recipe.activate_market_authorisation takes effect at greatest(requested date, version's date, its own clock), its
  -- clock read in this transaction before this row.
  v_floor := greatest(a.effective_from, v.effective_from);
  if new.effective_from is null or new.effective_from < now() or new.effective_from < v_floor
     or (new.effective_from > clock_timestamp() and new.effective_from is distinct from v_floor) then
    raise exception using errcode = 'P0001',
      message = format('An activation takes effect at the latest of the requested date (%s), the version''s effective date (%s) and the moment it is activated, not at %s (PR-02; INV-17; EBMR-RCP-095)',
                       coalesce(recipe.utc_text(a.effective_from), 'none'), coalesce(recipe.utc_text(v.effective_from), 'none'), coalesce(recipe.utc_text(new.effective_from), 'none'));
  end if;
  if a.kind = 'BRIDGING' and a.effective_to <= new.effective_from then
    raise exception using errcode = 'P0001', message = 'The bridging window has already ended (INV-17; EBMR-RCP-082)';
  end if;
  return new;
end
$$;
create trigger a2_guard before insert on recipe.market_authorisation_activation for each row execute function recipe.market_authorisation_activation_guard();

-- INV-17, PR-05 (D10): a cell is the one recipe.activate_market_authorisation writes for an APPROVED version of a record
-- still active, and the cell it supersedes is its predecessor's (header). Runs after a1_guard (0160), which has set the
-- cell's version number.
create function recipe.authorisation_cell_activation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  a recipe.market_authorisation;
  p recipe.authorisation_cell;
begin
  select * into a from recipe.market_authorisation where id = new.authorisation_id;
  if recipe.version_state_locked(new.version_id) is distinct from 'APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('Version %s is %s: only an APPROVED version becomes CURRENT or BRIDGING (ADR 0014; EBMR-RCP-086)',
                       new.version_number, coalesce(recipe.version_state(new.version_id), 'unknown'));
  end if;
  if exists (select 1 from recipe.market_authorisation_withdrawal w where w.authorisation_id = new.authorisation_id) then
    raise exception using errcode = 'P0001',
      message = 'A version becomes CURRENT or BRIDGING for a market only through an activated authorisation record with valid QA and regulatory signatures (INV-17; EBMR-RCP-092)';
  end if;
  for p in select * from recipe.authorisation_cell c where c.superseded_by = new.id loop
    if p.family_id <> new.family_id or p.market <> new.market or p.site <> new.site or p.line <> new.line or p.batch_size <> new.batch_size
       or p.kind <> 'CURRENT' or new.kind <> 'CURRENT' or p.version_number >= new.version_number or p.valid_until is distinct from new.effective_from then
      raise exception using errcode = 'P0001',
        message = format('A cell supersedes only the CURRENT cell of an earlier version of the same family, market and scope, which ends where it begins: not cell %s of version %s (PR-05; INV-17; EBMR-RCP-089)',
                         p.id, p.version_number);
    end if;
  end loop;
  if new.kind = 'BRIDGING'
     and not exists (select 1 from recipe.authorisation_cell c join recipe.authorisation_cell s on s.id = c.superseded_by
                      where c.version_id = new.version_id and c.market = new.market and c.site = new.site and c.line = new.line
                        and c.batch_size = new.batch_size and c.status = 'SUPERSEDED' and s.version_id = a.successor_version_id) then
    raise exception using errcode = 'P0001',
      message = format('BRIDGING is given only where the named successor superseded this version: not the case for %s at %s (ADR 0014; EBMR-RCP-090)',
                       new.market, jsonb_build_object('site', new.site, 'line', new.line, 'batch_size', new.batch_size));
  end if;
  return new;
end
$$;
create trigger a2_activation before insert on recipe.authorisation_cell for each row execute function recipe.authorisation_cell_activation_guard();

-- PR-05, INV-17 (D10): a CURRENT cell is superseded only by a cell written after it, in the same transaction (the
-- deferred foreign key of superseded_by makes it exist at the commit), so the successor's insert is judged against it by
-- recipe.authorisation_cell_activation_guard (header). 0160's update guard accepts any superseded_by; naming a cell
-- already written would supersede it with no check of the pair.
create function recipe.authorisation_cell_supersession_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if new.status = 'SUPERSEDED' and old.status is distinct from 'SUPERSEDED'
     and exists (select 1 from recipe.authorisation_cell c where c.id = new.superseded_by) then
    raise exception using errcode = 'P0001',
      message = format('A cell is superseded only by its successor written after it in the same transaction, not by cell %s, which exists already (PR-05; INV-17; EBMR-RCP-089)',
                       new.superseded_by);
  end if;
  return new;
end
$$;
create trigger a2_supersession before update on recipe.authorisation_cell for each row execute function recipe.authorisation_cell_supersession_guard();

revoke all on function recipe.market_authorisation_activation_guard(), recipe.authorisation_cell_activation_guard(),
                       recipe.authorisation_cell_supersession_guard() from public;

reset role;
