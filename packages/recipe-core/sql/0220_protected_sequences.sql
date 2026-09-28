-- Recipe core: identifiers that leave the database are protected against reuse after a restore (INV-27).
--
-- recipe-core is applied after the kernel, so kernel 0900's sweep of the kernel's own id sequences never saw its
-- sequences; each one is registered here, the same way (continuity.register_protected_sequence, as ebmr_owner). With
-- them the scheduled INV-27 query (continuity.unprotected_sequences) returns no rows on a correct installation, and
-- continuity's restore procedure moves these sequences past every value that may already have been handed out.
--
--   recipe.mbr_version_log.id                    record ids in the hash-chained audit trail (kernel.audit_event.record_id,
--                                                 audited on the version's chain), which leave the database in audit-trail
--                                                 exports and reviews
--   recipe.execution_disposition_proposal.id     record ids in the audit trail of the batch chain; the latest proposal of
--                                                 a content version is the one with the highest id, so a reused id after a
--                                                 restore could also change which proposal a reviewer signs
--   recipe.batch_execution.batch_number          the TEST- batch number (TEST-B<yy>-<nnnn>) drawn from
--                                                 recipe.test_batch_number_seq: printed on sandbox records, quoted in test
--                                                 reports and in the audit trail; a number is never issued twice (INV-27)
--
-- Restore margins: values that may have been issued after the last exported high-water mark. The audit-trail record
-- ids follow the kernel's margin for such ids (0900); test batches are issued by hand in the sandbox, far fewer.

set local role ebmr_owner;

select continuity.register_protected_sequence('recipe.mbr_version_log.id',
  pg_get_serial_sequence('recipe.mbr_version_log', 'id')::regclass,
  'OTHER', 'recipe-core', 'Ids of recipe.mbr_version_log (record ids in the audit trail of an MBR version)', 100000);

select continuity.register_protected_sequence('recipe.execution_disposition_proposal.id',
  pg_get_serial_sequence('recipe.execution_disposition_proposal', 'id')::regclass,
  'OTHER', 'recipe-core', 'Ids of recipe.execution_disposition_proposal (record ids in the audit trail of a test batch)', 100000);

select continuity.register_protected_sequence('recipe.batch_execution.batch_number',
  'recipe.test_batch_number_seq'::regclass,
  'BATCH_NUMBER', 'recipe-core', 'TEST- batch numbers of sandbox test batches (recipe.test_batch_number_seq; printed and quoted in test reports)', 10000);

reset role;
