-- Tablets edition, module C1: the application role learns from no table statistics when and how many data-integrity
-- investigations and retention holds were opened or closed (Phase 2 exit follow-up HIGH-WATER, round 4, lane round 2;
-- DI-17, DI-50; Annex 11 and Part 11 limit access to authorised persons; ADR 0012 item 9: the read rules hold when the
-- application's own database credentials are used directly).
--
-- Correction of tablets 0540's header. 0540 said that once continuity.sequence_high_water() and continuity.sequence_bump
-- were the owner's, the investigation and hold numbers told the application role neither when nor how many
-- investigations and holds were opened, and defaults F34.2 and the DI-17/DI-50 guards said the same. That was not so:
-- PostgreSQL's cumulative statistics served the same facts to every role, without a session and without any privilege on
-- the tables. Connected as ebmr_app (GMP) or ebmr_sandbox (sandbox), pg_stat_user_tables showed n_tup_ins and n_live_tup
-- of records.di_investigation, di_investigation_link and retention_hold move from 1 to 2 when one more investigation was
-- opened (and of di_investigation_closure and retention_hold_release when one closed), and so did
-- pg_stat_get_tuples_inserted(<oid>) and the other per-table counters; pg_statio_* counted their blocks, pg_stat_*_indexes
-- the probes of their keys (a foreign key check reads the investigation's primary key), pg_statio_*_sequences the blocks
-- of their number sequences, and pg_relation_size and its siblings their size on disk. Polled, they told when and how
-- many (not who). A role with no privilege reads them because the views and functions are executable by PUBLIC out of the
-- box; the privileges live in each database's own catalogue (as 0970's backend signals do), so they are confined per
-- database, here in each installation's own.
--
-- Now, in this database (GMP or sandbox: each runs this migration), PUBLIC, and so the application roles ebmr_app and
-- ebmr_sandbox, the authentication service, the listeners and the gateway roles, no longer:
--  - selects the per-table, per-index, per-sequence and per-function statistics views (pg_stat_{all,sys,user}_tables,
--    pg_stat_xact_{all,sys,user}_tables, pg_statio_{all,sys,user}_{tables,indexes,sequences},
--    pg_stat_{all,sys,user}_indexes, pg_stat_user_functions, pg_stat_xact_user_functions);
--  - executes the counter functions behind them (pg_stat_get_ and pg_stat_get_xact_ of tuples, blocks, scans, live and
--    dead rows, changes since the last vacuum or analyze, vacuum and analyze times and counts, function calls and times);
--  - executes the size functions (pg_relation_size, pg_table_size, pg_indexes_size, pg_total_relation_size).
-- Nothing of this installation reads them as one of those roles (the server, the kernel's and recipe-core's SQL and
-- TypeScript, the gateway); the owner's tools and an operator's monitoring run as a superuser, and a monitoring login that
-- is not one is granted them by the operator, never an application role. What the application role still reads of the
-- statistics, because the server or the kernel needs it, and what that still tells, is default HW.1
-- (docs/decisions/phase-2-open-questions.md): pg_stat_ssl (the kernel's check that the session is encrypted),
-- pg_locks (the audit viewer's settled horizon), pg_stat_activity, the database-wide counters, and the planner's estimates
-- in pg_class.
--
-- This part runs as the migration's own role, a superuser (as kernel 0970 requires): the views and functions belong to
-- the bootstrap superuser. The migration fails if any of them is still open to PUBLIC or to an application role. A copy
-- made from a template keeps the privileges, and pg_dump carries them to a restore. Applied as a new migration because
-- applied migrations are checksummed and never edited.

do $$
declare
  r record;
begin
  -- DI-17, DI-50 (HIGH-WATER): the statistics views of tables, indexes, sequences and functions.
  for r in
    select c.oid::pg_catalog.regclass::text as name
      from pg_catalog.pg_class c
     where c.relnamespace = 'pg_catalog'::pg_catalog.regnamespace and c.relkind = 'v'
       and c.relname ~ '^pg_stat(io)?_(xact_)?(all|sys|user)_(tables|indexes|sequences|functions)$'
  loop
    execute format('revoke select on %s from public', r.name);
  end loop;
  -- DI-17, DI-50 (HIGH-WATER): the per-object counter functions behind them, and the size functions.
  for r in
    select p.oid::pg_catalog.regprocedure::text as name
      from pg_catalog.pg_proc p
     where p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
       and (p.proname ~ '^pg_stat_get_(xact_)?(tuples_|blocks_|numscans$|lastscan$|live_tuples$|dead_tuples$|mod_since_analyze$|ins_since_vacuum$|last_(auto)?(vacuum|analyze)_time$|(auto)?(vacuum|analyze)_count$|function_)'
            or p.proname in ('pg_relation_size', 'pg_table_size', 'pg_indexes_size', 'pg_total_relation_size'))
  loop
    execute format('revoke execute on function %s from public', r.name);
  end loop;
end
$$;

do $$
declare
  v_open text;
begin
  select string_agg(x.name || ' (' || x.who || ')', ', ' order by x.name, x.who) into v_open
    from (
      select c.oid::pg_catalog.regclass::text as name, w.who
        from pg_catalog.pg_class c
       cross join (values ('public'), ('ebmr_app'), ('ebmr_sandbox')) w (who)
       where c.relnamespace = 'pg_catalog'::pg_catalog.regnamespace and c.relkind = 'v'
         and c.relname ~ '^pg_stat(io)?_(xact_)?(all|sys|user)_(tables|indexes|sequences|functions)$'
         and pg_catalog.has_table_privilege(w.who, c.oid, 'SELECT')
      union all
      select p.oid::pg_catalog.regprocedure::text, w.who
        from pg_catalog.pg_proc p
       cross join (values ('public'), ('ebmr_app'), ('ebmr_sandbox')) w (who)
       where p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
         and (p.proname ~ '^pg_stat_get_(xact_)?(tuples_|blocks_|numscans$|lastscan$|live_tuples$|dead_tuples$|mod_since_analyze$|ins_since_vacuum$|last_(auto)?(vacuum|analyze)_time$|(auto)?(vacuum|analyze)_count$|function_)'
              or p.proname in ('pg_relation_size', 'pg_table_size', 'pg_indexes_size', 'pg_total_relation_size'))
         and pg_catalog.has_function_privilege(w.who, p.oid, 'EXECUTE')) x;
  if v_open is not null then
    raise exception using errcode = 'P0001',
      message = format('The table statistics are still open to roles that are not superusers: %s. Run this migration as a superuser (DI-17, DI-50). [EBMR-TAB-022]', v_open);
  end if;
end
$$;
