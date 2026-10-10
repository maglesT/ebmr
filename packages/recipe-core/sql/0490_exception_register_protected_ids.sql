-- Phase 3 slice 2: the exception register's id sequence is protected against reuse after a restore (INV-27).
-- recipe.exception_register_act (0440) numbers the review and disposition acts on an exception from an identity
-- sequence. An id reused after a restore could put two acts under one id in the audit trail, so the sequence is
-- registered with the continuity module like the other recipe-core ids (0220, 0295).

set local role ebmr_owner;

select continuity.register_protected_sequence('recipe.exception_register_act.id',
  pg_get_serial_sequence('recipe.exception_register_act', 'id')::regclass,
  'OTHER', 'recipe-core', 'Ids of recipe.exception_register_act (acts on a batch exception in its audit trail)', 100000);

reset role;
