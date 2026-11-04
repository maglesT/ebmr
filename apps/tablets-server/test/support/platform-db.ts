/** Phase B: a database as the platform's set-up leaves it for product ebmr, before the eBMR's own migrator runs. */
import { asAdmin, onServer } from '@ebmr/test-kit';

/** What databsee db/server/cluster.sql and database.sql do for product ebmr (roles are cluster-wide and exist). */
export async function platformInitDatabase(database: string): Promise<void> {
  await onServer((s) => s.query(`create database ${database} owner ebmr_owner`));
  await asAdmin(database, async (c) => {
    await c.query(`
      revoke all on schema public from public;
      grant usage on schema public to ebmr_app;
      alter default privileges for role ebmr_owner in schema public revoke update, delete, truncate on tables from ebmr_app;
      alter default privileges for role ebmr_owner in schema public grant select, insert on tables to ebmr_app;
      alter default privileges for role ebmr_owner in schema public grant usage, select on sequences to ebmr_app;
      alter default privileges for role ebmr_owner revoke execute on routines from public;
      alter default privileges for role ebmr_owner grant execute on routines to ebmr_app;
      create schema if not exists report authorization ebmr_owner;
      revoke all on schema report from public;
      create schema if not exists platform authorization ebmr_owner;
      revoke all on schema platform from public;
      create table if not exists platform.home (app text not null, one boolean primary key default true check (one));
      insert into platform.home (app) values ('ebmr_app') on conflict (one) do nothing;
      create table if not exists platform.link_log (id bigint generated always as identity primary key, at timestamptz not null default now(),
        consumer text not null, views text[] not null, switched_on boolean not null, change_ref text not null, reason text not null,
        applied_by text not null default session_user);`);
  });
}

