-- Batch numbers reserved for test, training and simulation data ('TEST-...') are refused in a GMP installation,
-- and real batch numbers are refused in a sandbox (DI-05, INV-18; kernel sandbox 0810).

set local role ebmr_owner;

create trigger ab_sandbox_identifier_guard
  before insert or update on site.batch_number_allocation
  for each row execute function sandbox.guard_identifier('BATCH_NUMBER', 'batch_number');

reset role;
