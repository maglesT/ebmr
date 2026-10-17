-- Phase 7 slice 7a, 6jc-R2 (draft control IN-53, status U): the application role no longer reads controlled-substance
-- records directly. Owner decision 0022 limits the custody records, the batch balance, the controlled list and the
-- register extracts to the controlled-substance roles and QA (CONTROLLED.READ, kernel 1300), decided in the database.
--
-- Handbook: modules/recipe-core.md
--
-- Until now ebmr_app could SELECT the eight tables of recipe-core 1031 to 1034 and execute their read functions, so any
-- session (an operator on a kiosk, a system administrator) or the application's own credentials read every flag,
-- custody record, account and register export. This migration revokes those reads; the writers (record, approve,
-- propose, sign, run) keep their grants and their own permission checks. The edition reads them through its own gated
-- definers, which decide CONTROLLED.READ for the session behind the request in the record's {site, product} scope (the
-- Tablets edition: tablets 1413). The functions themselves are unchanged (no CREATE OR REPLACE); only privileges move.
--
--   tables      plant.controlled_product, plant.controlled_product_approval, recipe.controlled_custody,
--               recipe.controlled_custody_signature, recipe.controlled_custody_use, recipe.controlled_checkpoint,
--               recipe.controlled_checkpoint_signature, recipe.controlled_register_extract
--   functions   the controlled list (plant.controlled_materials, plant.material_is_controlled,
--               plant.controlled_product_state, recipe.batch_controlled_materials, recipe.controlled_moved_materials),
--               the states and custodians (plant.controlled_record_state, recipe.controlled_custody_state,
--               recipe.controlled_custodians, recipe.controlled_checkpoint_state, recipe.controlled_checkpoint_current),
--               the account (recipe.controlled_balance, recipe.controlled_checkpoint_problem,
--               recipe.controlled_batch_end_problem) and the register (recipe.controlled_register_reproduces).
-- The owner, the definers that call these functions and the database's guards are unaffected.

set local role ebmr_owner;

revoke select on plant.controlled_product, plant.controlled_product_approval, recipe.controlled_custody,
  recipe.controlled_custody_signature, recipe.controlled_custody_use, recipe.controlled_checkpoint,
  recipe.controlled_checkpoint_signature, recipe.controlled_register_extract from ebmr_app;

revoke execute on function plant.controlled_materials(text), plant.material_is_controlled(text), plant.controlled_product_state(text),
  recipe.batch_controlled_materials(uuid), recipe.controlled_moved_materials(uuid), plant.controlled_record_state(uuid),
  recipe.controlled_custody_state(uuid), recipe.controlled_custodians(uuid), recipe.controlled_checkpoint_state(uuid),
  recipe.controlled_checkpoint_current(uuid), recipe.controlled_balance(uuid, text), recipe.controlled_checkpoint_problem(uuid, text),
  recipe.controlled_batch_end_problem(uuid), recipe.controlled_register_reproduces(uuid) from ebmr_app;

reset role;
