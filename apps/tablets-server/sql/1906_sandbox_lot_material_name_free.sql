-- A test lot's material name is the material's own name (owner report item 20, G9). Tablets 0630 (Phase 2 exit review
-- F12 round 10) put the kernel's sandbox free-text guard on tab.sandbox_lot.material_name, which reads any word with a
-- letter and a digit as a real batch or lot number: "Hypromellose K100M" and "Povidone K30" were refused as not test lots
-- (EBMR-SBX-024). The name is display text for the screen: it reaches no row, state or content of a test run (0630's own
-- finding, decision F12.7; db-guards-sandbox-registers.test.ts checks that it still does not). What keeps a sandbox lot
-- apart is its lot code, TEST- only under the identifier rule (0200), and the material code bound at use (0600); both
-- stay. No binding clause or record-integrity need asks more of a name, so the trigger goes (owner rule: no refusal
-- without a basis; lead ruling of 7 November 2026).
--
-- Handbook: modules/tablets-server.md
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

drop trigger ac_sandbox_free_text on tab.sandbox_lot;

reset role;
