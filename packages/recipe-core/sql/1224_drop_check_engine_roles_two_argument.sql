-- Recipe core: the dead overload recipe.check_engine_roles(jsonb, jsonb) is dropped (Phase 7 slice 7a; INV-26 unchanged).
--
-- Handbook: modules/recipe-core.md
--
-- The 2-argument form (0210, replaced in 0270) checked a command's engine roles against evaluations made at the actor's
-- location only. Since recipe-core 1100 recipe.append_execution, its only caller, calls the batch form
-- recipe.check_engine_roles(jsonb, jsonb, uuid), which accepts an evaluation at the actor's location as it is or with the
-- batch's own product added. No SQL function body and no TypeScript calls the 2-argument form (the [meta] test in
-- packages/recipe-core/test/execution/dead-overload.test.ts), so it is dead code a later change could call by mistake and
-- the mutation harness kept testing. Only that overload is dropped; the batch form, recipe.role_evaluation_problem in
-- both forms (the test-run issue still uses the 3-argument one) and every other function stay. Applied as a new migration
-- because applied migrations are never edited.

set local role ebmr_owner;

drop function recipe.check_engine_roles(jsonb, jsonb);

reset role;
