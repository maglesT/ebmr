-- Test-only GMP tables used to exercise the audit trail. Not part of any product schema.
create schema testgmp authorization ebmr_owner;
set local role ebmr_owner;
grant usage on schema testgmp to ebmr_app;

create table testgmp.sample (
  id        uuid primary key default gen_random_uuid(),
  batch_id  uuid not null,
  value     numeric not null,
  note      text
);
grant select, insert, update, delete on testgmp.sample to ebmr_app;

create table testgmp.reading (
  id        uuid primary key default gen_random_uuid(),
  batch_id  uuid not null,
  value     numeric not null
);
grant select, insert, update, delete on testgmp.reading to ebmr_app;

select kernel.register_audited_table('testgmp.sample', 'batch', 'batch_id', false);
select kernel.register_audited_table('testgmp.reading', 'batch', 'batch_id', true);
reset role;
