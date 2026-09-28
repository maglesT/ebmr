-- Integration wiring for the sandbox (DI-05, INV-18): identifiers reserved for test, training and simulation data
-- ('TEST-...') are refused in a GMP installation, and real identifiers are refused in a sandbox, on the kernel tables
-- that hold person and device labels. Site-services attaches the same guard to batch numbers (its migration 0690).

set local role ebmr_owner;

create trigger ab_sandbox_identifier_guard
  before insert or update on iam.issued_identifier
  for each row execute function sandbox.guard_identifier('PERSON_LABEL', 'identifier');

create trigger ab_sandbox_identifier_guard
  before insert or update on iam.person
  for each row execute function sandbox.guard_identifier('PERSON_LABEL', 'legal_name');

create trigger ab_sandbox_identifier_guard
  before insert or update on iam.device
  for each row execute function sandbox.guard_identifier('DEVICE_LABEL', 'code');

reset role;
