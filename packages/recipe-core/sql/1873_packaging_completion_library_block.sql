-- API edition plan A1a (lead clearance of 5 November 2026): a library block may complete a packaging record.
--
-- Handbook: modules/recipe-core.md
--
-- recipe.packaging_completion_block (0761) names, per edition, the block types that complete a packaging record; an
-- edition with no row plans no packaging order (recipe.packaging_master_problem, 0800). Its block_type check took only
-- the coded blocks (G-nn, TB-nn, IB-nn), so the API edition, whose pack step is a library block, could name none. The
-- check now also takes a library block's step type, 'LIB-' and the library code in the format of recipe-core 1800
-- (a capital letter, then 1 to 39 capitals, digits or dashes). Nothing is narrowed: every existing row still passes, and
-- PostgreSQL validates them when the constraint is added. The API edition's own row is data in its namespace
-- (editions/substance/sql 5000). Nothing else changes.

set local role ebmr_owner;

alter table recipe.packaging_completion_block drop constraint packaging_completion_block_block_type_check,
  add constraint packaging_completion_block_block_type_check check (block_type ~ '^(G|TB|IB)-[0-9]{2}$' or block_type ~ '^LIB-[A-Z][A-Z0-9-]{1,39}$');

reset role;
