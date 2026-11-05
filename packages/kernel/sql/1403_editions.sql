-- API edition plan A0 (docs/build-plan/api/plan.md, platform-fit.md; lead decision of 5 November 2026): the list of
-- editions lives in one place. Every edition column's check is re-created against it, so a later edition is a one-line
-- change here and nothing else. The list only grows: tablets and injectables as before, plus substance (the API
-- edition). No check is narrowed; every existing row already satisfies the new checks, which PostgreSQL validates when
-- each constraint is added (the migration fails otherwise).
--
-- Handbook: modules/kernel.md
--
--   kernel.editions()        the editions, lower case (the market scopes, the master families, the library)
--   kernel.edition_codes()   the same, upper case (the site registers: batch numbers, lots, deviations)
--
-- This file re-creates the market scopes' checks (kernel 0310). site-services 1731 and recipe-core 1872 re-create
-- theirs. The installation keys (kernel 1220) keep their own list: an installation hosts every edition.

set local role ebmr_owner;

create function kernel.editions() returns text[]
language sql immutable set search_path = pg_catalog as $$ select array['tablets', 'injectables', 'substance'] $$;

create function kernel.edition_codes() returns text[]
language sql immutable set search_path = pg_catalog as $$ select array(select upper(e) from unnest(kernel.editions()) e) $$;

grant execute on function kernel.editions(), kernel.edition_codes() to ebmr_app;

alter table market.stub_product   drop constraint stub_product_edition_check,
  add constraint stub_product_edition_check check (edition = any (kernel.editions()));
alter table market.stub_line      drop constraint stub_line_edition_check,
  add constraint stub_line_edition_check check (edition = any (kernel.editions()));
alter table market.stub_room      drop constraint stub_room_edition_check,
  add constraint stub_room_edition_check check (edition = any (kernel.editions()));
alter table market.stub_equipment drop constraint stub_equipment_edition_check,
  add constraint stub_equipment_edition_check check (edition = any (kernel.editions()));

reset role;
