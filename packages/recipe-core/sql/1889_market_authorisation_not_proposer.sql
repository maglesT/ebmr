-- Recipe core: a market authorisation is activated by a QA person other than the one who proposed it (owner retest of
-- 10 November 2026, item 11: one QA person proposed and authorised India alone).
-- Handbook: modules/recipe-core.md
--
-- Owner ruling: the proposal and the activation are two QA persons, so the person who activates (signs MBR_MARKET_AUTHORISED
-- and runs the command, 0290 and 0383) is never the person who proposed the record. The regulatory-conformity signer stays a
-- further, different person (EBMR-RCP-085). No regulation names this split; it is the owner's choice for the act that makes
-- a master usable for a market (PR-04), and it narrows nothing else.
--
--   * recipe.market_authorisation_activation_not_proposer (new) and trigger a3_not_proposer: every activation row, from the
--     command or any other writer, is refused when its person (stamped by a1_stamp from the actor) proposed the record
--     (EBMR-RCP-434). The trigger runs after a1_stamp and a2_guard (names sort in order).
--
-- New functions are owned by ebmr_owner and private to the owner (no EXECUTE for PUBLIC); SECURITY DEFINER with a pinned
-- search_path, pg_temp last. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create function recipe.market_authorisation_activation_not_proposer() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_proposer uuid;
begin
  select a.proposed_by_person into v_proposer from recipe.market_authorisation a where a.id = new.authorisation_id;
  if new.person_id is null or new.person_id is not distinct from v_proposer then
    raise exception using errcode = 'P0001',
      message = 'EBMR-RCP-434 the QA person who proposed this market authorisation cannot also authorise it; a second QA person activates it (owner ruling, item 11; PR-04)';
  end if;
  return new;
end
$$;
revoke all on function recipe.market_authorisation_activation_not_proposer() from public;

create trigger a3_not_proposer before insert on recipe.market_authorisation_activation
  for each row execute function recipe.market_authorisation_activation_not_proposer();

reset role;
