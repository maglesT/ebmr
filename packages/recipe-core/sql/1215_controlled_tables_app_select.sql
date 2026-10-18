-- Phase 7 slice 7a, 6jc-R2 finding P7A-7 (draft control IN-53, status U): the application role reads the controlled
-- tables again; the person-facing reads stay gated.
--
-- Handbook: modules/recipe-core.md
--
-- What went wrong. Recipe-core 1214 revoked the application role's SELECT on the eight controlled tables. The kernel's
-- generic readers of registered audited tables run as that role, and they then failed. A true copy of a batch, a lot or a
-- controlled flag (kernel.buildTrueCopyBundle, DI-47, review F34) read every table registered on the aggregate and was
-- refused ("permission denied for table controlled_checkpoint"), and so were the archiving and disposal built on it.
--
-- Lead decision (17 October 2026). The application role is the server's own identity. It keeps table SELECT on the
-- controlled tables, as it has on all GMP data, because true copies, evidence exports and archives must be complete.
-- IN-53's database enforcement stays on every path a person uses:
--   * the controlled reads: the gated definers of tablets 1413 and 1415 (session token, CONTROLLED.READ in scope);
--   * the signing preview, the signatures and their chains: tablets 1414;
--   * the audit viewer: tablets 1415 (the controlled chains, and the controlled entries on the lot and batch chains);
--   * the routes: features/controlled reads only through those definers.
-- The EXECUTE revokes of 1214 on the old read functions stay. No generic reader calls them; only the definers of
-- recipe-core 1031 to 1035 and site services 0970 do, as the owner.

set local role ebmr_owner;

grant select on plant.controlled_product, plant.controlled_product_approval, recipe.controlled_custody,
  recipe.controlled_custody_signature, recipe.controlled_custody_use, recipe.controlled_checkpoint,
  recipe.controlled_checkpoint_signature, recipe.controlled_register_extract to ebmr_app;

reset role;
