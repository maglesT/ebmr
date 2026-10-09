-- Recipe core: the application role reads recipe.engine_name, as it reads every other recipe table (ADR 0012: the
-- application role reads every recipe table and writes none; DI-17, INV-01).
--
-- 0346 created recipe.engine_name (the names of the engine's registers that a test run's record may hold: block rule
-- codes, block types, controls, schema tags, member names) as configuration shipped by migrations, insert-only and
-- audited, and gave the application roles no right on it. The privilege test of the recipe schema
-- (packages/recipe-core/test/lifecycle/authorization.test.ts) holds that the application role reads every recipe
-- table except the transaction clock marker, and failed on this table. The names are the engine's own, published in
-- its source, and hold nothing a person entered, so reading them is safe; writing stays with the owner, as for
-- recipe.block_data_schema (0332). Correction of 0346's header ("the application roles have no right on it"): from
-- this migration on they may read it.
-- Applied as a new migration because applied migrations are checksummed and never edited. The number is in the range
-- kept for the Phase 2 exit's lead fixes (0380-0389).

set local role ebmr_owner;

grant select on recipe.engine_name to ebmr_app;

reset role;
