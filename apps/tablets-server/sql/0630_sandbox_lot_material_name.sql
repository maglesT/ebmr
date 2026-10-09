-- Tablets edition, module C3: a test lot's material name names no real-format batch or lot (Phase 2 exit review F12,
-- closed for the class; DI-05, INV-18; ADR 0012: the rules hold when the application's own database credentials are
-- used directly).
--
-- What was wrong. tab.sandbox_lot, the sandbox's register of test lots that the application role writes through
-- tab.register_sandbox_lot, holds a lot code under the identifier rule (0200: TEST- only), a material code bound when a
-- test run uses the lot (0600: a material the batch's MBR names) and a material name, free text for the screen, read by
-- nothing: decision F12.7 recorded that a lot registered with the material name L2409-0017 was stored (and that the name
-- reaches no row, state or content of a test run).
--
-- What changed: the trigger ac_sandbox_free_text (before insert or update of material_name) applies the kernel's
-- sandbox.guard_free_text (kernel 1030): in the sandbox the name holds no word the identifier rule reads as a real batch
-- or lot number (EBMR-SBX-024). The material code stays bound at use (0600): a material code is a code of the MBR's bill
-- of materials, not free text (decision F12.2), and holding it at registration to an imported package would make the
-- set-up order a rule (decision F12.7). The lots already registered keep their names. Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

create trigger ac_sandbox_free_text before insert or update of material_name on tab.sandbox_lot
  for each row execute function sandbox.guard_free_text('material_name');

reset role;
