-- Tablets edition, module C1: the application role's other doors to investigation, governance and audit-chain data
-- (Phase 2 exit review F34 and F35, round 2; DI-17, DI-50, DI-22, DI-13; Annex 11 and Part 11 limit access to
-- authorised persons; ADR 0012 item 9: the read rules hold when the application's own database credentials are used
-- directly).
--
-- Tablets 0410 and 0420 put the content to be signed, the signature lists and the audit viewer behind the session's
-- read rule, but the application role, with no session token at all, still reached the same data through the kernel's
-- own readers and side tables:
--  - records.investigation_scope(<investigation>) and records.person_activity(<person>, ...) returned the scoping report
--    of an investigation (the subject's chain keys) and any colleague's activity across the trail;
--  - esig.chain_extract(<chain>) returned any chain whole (an account chain with a grant's revocation reason, an
--    investigation's chain with its opener and role); esig.evidence_package(<signature>) returned any signature with its
--    manifestation, challenge and both chain extracts, whatever the record's read class;
--  - kernel.chain_keys() and kernel.verify_all_chains() listed the chains, the investigations' included; so did the
--    heads of every anchor (kernel.audit_anchor, which kernel.create_anchor writes for the application role), and the
--    checkpoints and verification runs name chains too;
--  - the signature seals, the signature-ID register, the content changes, the invalidations and the signing failures
--    have no row-level security: they named every signature and record of the GOVERNANCE class that esig.signature and
--    esig.challenge hide since 0410;
--  - the retention holds a data-integrity investigation places (records.retention_hold, its releases and
--    records.active_hold) named the investigation, its reference and every record of the person it is about.
--
-- Now (default F34.1 and F35.1, docs/decisions/phase-2-open-questions.md):
--  - the application role no longer executes esig.evidence_package, esig.chain_extract, records.investigation_scope,
--    records.person_activity, kernel.chain_keys or kernel.verify_all_chains (the owner's tools still do; no screen of
--    this installation uses them, and a future one reads them through a session-checked function as 0410 and 0420 do);
--  - it no longer selects kernel.audit_anchor, kernel.audit_checkpoint or kernel.audit_verification_run (the kernel's
--    anchor, checkpoint and verification functions still run for it: they are SECURITY DEFINER and answer problems only);
--  - it no longer selects records.retention_hold, records.retention_hold_release or records.active_hold (holds are
--    GOVERNANCE-class, read in the audit viewer's record_hold chains under 0420's rule);
--  - the application roles (GMP and sandbox) see only RECORD-class rows of esig.signature_seal, esig.content_change,
--    esig.signature_invalidation and esig.signing_failure (by the record the row names, tab.aggregate_read_class of 0410:
--    any type not named is GOVERNANCE, and a row naming no record is hidden), and of esig.signature_id_register (a
--    register entry whose signature they may see).
-- What the application role still selects directly from the identity, incident and continuity tables is an owner
-- residual (F34.1 and F35.1, "Not closed in Phase 2").

set local role ebmr_owner;

-- DI-17, DI-50 (F34, F35): the kernel's readers of investigations, chains and evidence run for the owner only here.
revoke execute on function esig.evidence_package(uuid), esig.chain_extract(text), records.investigation_scope(uuid),
                           records.person_activity(uuid, timestamptz, timestamptz), kernel.chain_keys(), kernel.verify_all_chains()
  from ebmr_app;

-- DI-17, DI-22 (F35): the side tables of the audit trail that name chains.
revoke select on kernel.audit_anchor, kernel.audit_checkpoint, kernel.audit_verification_run from ebmr_app;

-- DI-17, DI-50 (F34): the retention holds, a data-integrity investigation's among them.
revoke select on records.retention_hold, records.retention_hold_release, records.active_hold from ebmr_app;

-- DI-17, DI-50 (F34): the read class of the record an aggregate reference (<type>:<id>) names; GOVERNANCE when it names none.
create function tab.aggregate_ref_read_class(p_aggregate_ref text) returns text
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select case when strpos(coalesce(p_aggregate_ref, ''), ':') > 1 then tab.aggregate_read_class(split_part(p_aggregate_ref, ':', 1)) else 'GOVERNANCE' end
$$;
revoke all on function tab.aggregate_ref_read_class(text) from public;
-- The row-level security predicate below, evaluated as the reading role.
grant execute on function tab.aggregate_ref_read_class(text) to ebmr_app;

-- DI-17, DI-50 (F34): the application roles see only RECORD-class rows of the signatures' side tables; the owner's
-- functions see every row.
alter table esig.signature_seal enable row level security;
create policy app_reads_record_class on esig.signature_seal for select to ebmr_app, ebmr_sandbox
  using (tab.aggregate_ref_read_class(aggregate_ref) = 'RECORD');
alter table esig.content_change enable row level security;
create policy app_reads_record_class on esig.content_change for select to ebmr_app, ebmr_sandbox
  using (tab.aggregate_read_class(aggregate_type) = 'RECORD');
alter table esig.signature_invalidation enable row level security;
create policy app_reads_record_class on esig.signature_invalidation for select to ebmr_app, ebmr_sandbox
  using (tab.aggregate_ref_read_class(aggregate_ref) = 'RECORD');
alter table esig.signing_failure enable row level security;
create policy app_reads_record_class on esig.signing_failure for select to ebmr_app, ebmr_sandbox
  using (tab.aggregate_ref_read_class(aggregate_ref) = 'RECORD');
-- A register entry holds only the signature id: it is visible when its signature is (esig.signature's own policy of 0410
-- applies inside this one).
alter table esig.signature_id_register enable row level security;
create policy app_reads_record_class on esig.signature_id_register for select to ebmr_app, ebmr_sandbox
  using (exists (select 1 from esig.signature s where s.id = signature_id));

reset role;
