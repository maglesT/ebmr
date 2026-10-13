-- Recipe core: drop recipe.reprocessing_start_problem (Phase 4 slice 7c; Phase 3 exit SQL mutation, low). Its only caller
-- was recipe.g24v2_check of 0622, which 0625 replaced without calling it; no SQL body, view, trigger or TypeScript
-- module refers to it since then, so it is dead code that the SQL mutation run could only record as unreachable. The
-- start of a reprocessing step stays checked by recipe.g24v2_check and recipe.reprocessing_start_take (0625).

set local role ebmr_owner;

drop function recipe.reprocessing_start_problem(uuid, text, text, text);

reset role;
