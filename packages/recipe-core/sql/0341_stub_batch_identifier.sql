-- Recipe core, MBR life cycle (A3): a stub batch's batch number follows the sandbox identifier rule (Phase 2 exit review
-- F12, the lane's round-2 verification; DI-05, INV-18; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- What was wrong. recipe.stub_batch (0170) stands in for the batches of the MBR life cycle until Phase 3. Its batch
-- number was held only to the form ^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$. The sandbox identifier rule (kernel 0810,
-- sandbox.guard_identifier) was attached to the batch number of a test batch (0200) and of a site allocation (site
-- services 0690), not to this table, and neither MBR families nor stub batches are refused in a sandbox installation
-- (its roles include MBR_AUTHOR and BATCH_ISSUER). So a stub batch planned in a sandbox could carry a real-format batch
-- number (L2409-0017), and one planned in a GMP installation a reserved TEST- number.
--
-- What changed: the trigger ab_sandbox_identifier_guard (before insert or update of batch_number on recipe.stub_batch,
-- after a1_guard) applies sandbox.guard_identifier('BATCH_NUMBER', 'batch_number'), as site services 0690 does: in a
-- sandbox every batch number starts with TEST- (EBMR-SBX-022), in a GMP installation none does (EBMR-SBX-021). A stub
-- batch already planned keeps its number (the trigger reads new rows; 0170's a1_guard lets only the status change).
--
-- The kernel's market stub tables (market.stub_batch.batch_number, market.stub_material_lot.code) have the same gap; they
-- are kernel tables and are reported to the lead (decision F12.7). sandbox.guard_identifier is the kernel's SECURITY
-- DEFINER trigger function with a pinned search_path. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

create trigger ab_sandbox_identifier_guard before insert or update of batch_number on recipe.stub_batch
  for each row execute function sandbox.guard_identifier('BATCH_NUMBER', 'batch_number');

reset role;
