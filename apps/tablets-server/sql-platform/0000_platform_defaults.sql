-- MEDHANTA platform (Phase B, plan decision 2): the platform's database set-up (databsee db/server/database.sql) gives
-- the app login default rights on every new object of ebmr_owner: SELECT and INSERT on tables and USAGE and SELECT on
-- sequences in schema public, and EXECUTE on routines (platform D-17). Batchwright grants each right explicitly, so
-- these defaults are taken back before its own migrations run; the app login then holds exactly what it holds on a
-- standalone installation. Runs first, and only on the platform (apps/tablets-server/src/cli/platform-migrate.ts).
alter default privileges for role ebmr_owner in schema public revoke select, insert, update, delete, truncate on tables from ebmr_app;
alter default privileges for role ebmr_owner in schema public revoke usage, select on sequences from ebmr_app;
alter default privileges for role ebmr_owner revoke execute on routines from ebmr_app;
