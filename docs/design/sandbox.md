# Sandbox, training and simulation store

Status: implemented in Phase 2 (kernel migrations 0800-0820, `packages/kernel/src/sandbox`). Controls: DI-05
(segregation of non-GMP functions). Invariant: INV-18 (test, simulation and training data live in a separate
database; GMP batches only from CURRENT or BRIDGING versions). Basis: build outline 4.4, 6.5 and 5.3; ADR 0001
item 2; ADR 0012 items 1 and 8. Regulatory basis, paraphrased: FDA expects a manufacturer to assess and limit the
influence of non-GMP functions on GMP operations (DI Q&A, question 3) and to control access to computerised
systems (21 CFR 211.68(b)); the EU has no dedicated clause and reaches the same result through risk management
of computerised systems (Annex 11 section 1). No rule requires a simulation mode; offering one is a design
choice, and keeping it apart from GMP data is what the rules require.

## 1. One separate store per edition

- Each edition has one sandbox database, `ebmr_sandbox_<edition>` (for example `ebmr_sandbox_tablets`), beside
  its GMP databases. It is built from the same kernel, site-services, recipe and edition migrations, so the
  screens and rules behave exactly as in GMP. It is never a copy of a GMP database: it is created empty and
  migrated (`provisionSandboxDatabase`), then loaded with what section 3 allows.
- **Installation marker.** Every database records once, at provisioning, whether it is `GMP` or `SANDBOX`
  (`kernel.installation_kind()`). Nothing can change it afterwards, not even the table owner. The marker must
  agree with the database name (only sandboxes start with `ebmr_sandbox_`); a GMP database copied under a
  sandbox name, or a sandbox restored under another name, reports no kind and is refused as both.
- **Own login role.** `ebmr_sandbox` may connect only to sandbox databases; every GMP database revokes CONNECT
  from PUBLIC and grants it to the GMP login roles only. The sandbox role is a member of no role and holds no
  object privilege in any GMP database. Inside the sandbox it receives exactly the object privileges of the GMP
  application and authentication roles (re-levelled after every migration run), because role membership would
  carry their grants into every GMP database on the same server. One sandbox role serves both the application
  and the authentication service: the sandbox holds no real person and no real secret (default taken; a second
  role can be split off if sandbox evidence ever needs it).
- **Listener login role.** The edition's gateway listener has a login of its own in each kind (kernel 0980):
  `ebmr_sandbox_listener` connects only to sandbox databases and holds there exactly the object privileges of the GMP
  `ebmr_listener` (mirrored the same way), which connects only to GMP databases. Neither is a member of any role nor
  has members, so no other login can write the listener's evidence (decision X36). Each is limited to the listener's
  share of the server's connections (decision X41).
- **Recommended deployment:** the sandbox on its own PostgreSQL server; when it shares a server with GMP
  databases, no cross-database extension (dblink, postgres_fdw) may be installed, and other login roles that
  must reach a GMP database (backup, monitoring) get an explicit CONNECT grant.

## 2. How sandbox test runs, training and simulation share the store

| Mode | What happens in the sandbox | What leaves it |
|---|---|---|
| Sandbox test run (MBR verification, outline 5.2.1 and 6.5) | A version under verification, identified by its content hash, is executed on the real screens with `TEST-` batch and lot numbers. Test runs may use any version state (`batchIssueProblem`). | A reference only: run id, content hash, coverage report and its SHA-256, stamped SANDBOX. The MBR life cycle stores it as verification evidence, never as batch data. |
| Training | Trainees work through scenarios under `TEST-` person labels and sandbox-only credentials. | Nothing automatic. Completion reaches the qualification record through the normal LMS/QA path. |
| Simulation mode | Interactive walk-through of an MBR, same as a test run but not claimed as verification evidence. The designer's automated simulation writes nothing anywhere; its report carries the watermark (`watermarkFor('SIMULATION')`). | Watermarked reports only. |

One store serves all three: when batch records arrive (Phase 3), each sandbox batch records its purpose (test
run, training or simulation), and the watermark names it (`watermarkFor('SANDBOX_TEST_RUN' | 'TRAINING' | ...)`). Seeded review-by-exception challenges (outline
9.2) also run here only (`sandbox.assert_sandbox_installation`).

## 3. What is copied from GMP, how, and what never is

- **Copied, one way, read-only:** approved and in-verification MBR versions (content and content hash), and
  master-data snapshots: materials and specifications, units, equipment classes, rooms and lines as structure,
  published rule tables and policies, the permission catalogue. A job holding GMP read credentials exports a
  hashed package; the sandbox tooling imports it under sandbox credentials. There is no live link, and no
  process holds credentials for both databases at once. The package format arrives with the MBR package
  export; the import refuses non-`TEST-` identifiers through the same reserved-identifier rules.
- **Never copied:** lots and their status or quantities (the sandbox creates `TEST-` lots), real batches and
  their records, genealogy, equipment and room status, audit trails, signatures and true copies, persons and
  their secrets (password verifiers, PINs, badges; trainees get sandbox identities), integration endpoints
  (the sandbox talks to simulators only).
- **Never returned:** nothing from the sandbox is converted into or merged with a GMP record. GMP databases
  refuse `TEST-` identifiers, every export and true-copy bundle states its installation kind, and an importer
  into GMP accepts only GMP origin (`assertGmpOrigin`).

## 4. Layers that keep the two apart

| Layer | Prevents | Where |
|---|---|---|
| Separate database, connect policy | Sandbox sessions on a GMP database; GMP sessions on the sandbox | 0800 `apply_connect_policy`; bypass tests |
| No grants, no memberships | Writes to GMP tables even if CONNECT were left open | 0820; bypass tests enumerate every table, sequence, schema and definer function |
| Permanent marker plus name rule | A sandbox becoming GMP later; a copy passing as the other kind | 0800 triggers and `kernel.installation_kind()` |
| Reserved identifiers | Test identifiers in GMP; real identifiers reused in the sandbox | 0810, `identifiers.ts` (disjoint by construction; property-tested) |
| Batch source rule | GMP batches from versions not CURRENT or BRIDGING | `sandbox.assert_batch_issue_allowed` |
| Start-up guard | A GMP process pointed at the sandbox, or the reverse | `assertInstallationKind` |
| Watermark | Sandbox or simulation output read as a GMP record | `watermarkFor`, `sandbox.watermark()` |
| Invariant query | Drift (a stray grant, an open CONNECT, a mismatched mirror) | `sandbox.segregation_problems()`, run with the other invariant queries |

Residual risk: a superuser can disable the marker triggers (recorded in `kernel.ddl_log`) or bypass them for a
session; that stays with the break-glass controls of ADR 0012 item 7. Even then the name rule still refuses a
sandbox that claims to be GMP unless the database is also renamed.

## 5. Impact assessment of each non-GMP function (for the validation package)

| Function | Possible GMP impact if segregation failed | Mitigation | Residual risk |
|---|---|---|---|
| Sandbox test runs | Test batches or entries in GMP records; unapproved versions issued as GMP | Separate database and role; `TEST-` identifiers refused by GMP; batch source rule; evidence returned by reference only | Low |
| Training mode | Trainee entries or signatures counted as GMP; real identities misused | Sandbox identities with `TEST-` labels and sandbox-only credentials; no copied persons or secrets; watermark | Low |
| Simulation (interactive and automated) | A simulation report taken as a batch record or as verification evidence | Watermark on every report; automated simulation writes nothing; only test-run references count as evidence | Low |
| Analytics (later phases) | Changes to GMP data through reporting connections; unverified figures in GMP reports | Read-only replica or export, watermark `ANALYTICS`; never a writer | Low, assessed again when built |
| Planning and scheduling | Not in v1; would be assessed before release | none yet | n/a |

## 6. Integration still to wire (lead)

- Export the module from `packages/kernel/src/index.ts` (`export * as sandbox from './sandbox/index.ts';`).
- Test harness: `createTestDatabase` should run `select sandbox.apply_connect_policy()` after copying the
  template (database privileges are not copied), in place of or beside the TEMPORARY revoke; then
  `sandbox.segregation_problems()` is empty in every test database.
- Identifier guards in an integration migration: `site.batch_number_allocation.batch_number` (BATCH_NUMBER),
  `iam.issued_identifier.identifier` and `iam.person.legal_name` (PERSON_LABEL), `iam.device.code`
  (DEVICE_LABEL); lots, containers and samples when they arrive (Phase 3).
- GMP-only paths call `sandbox.assert_gmp_installation`: release and market dispositions (Phase 4), lot status
  changes and outbound integration messages (Phase 3 and 6), `records.registerTrueCopy` when the copy is
  declared a GMP record.
- True copies: add the installation stamp to the bundle manifest and have the verifier report a non-GMP stamp.
- Recipe core: the simulator's report is stamped with `watermarkFor('SIMULATION')`; batch issue (Phase 3) calls
  `sandbox.assert_batch_issue_allowed` after `recipe.select_version_for_issue`.
- Continuity: the restore procedure re-applies `sandbox.apply_connect_policy()` after a restore.

## 7. What the application role writes in a sandbox, and what reads it for the identifier rule (F12.8)

Inventory taken on 4 October 2026 from the catalogue of a sandbox migrated to kernel 1030, recipe-core 0345 and
tablets 0630 (decision F12.8 in `docs/decisions/phase-2-open-questions.md`), and taken again after kernel 1040 and
recipe-core 0346 and 0347 (decision F12.9) and after recipe-core 0348 and tablets 0640 (decision F12.10): the write
surface is the same (no new writer; recipe.engine_name is written by its migration only and the application roles have
no right on it); what reads it changed as A, C and D say. Correction (F12.10, the lane's round-12 verification): the
inventory of F12.8 and F12.9 filed `tab.manual_weighing_basis` in D and said no entry quotes a reading's serial; the
basis is keyed to a run's row and its reasons quote a heartbeat's serial and not-ready text, the registered serial, the
server's API detail and a refused reading's alarm code. It is in A since tablets 0640. The
application's credential in a sandbox is `ebmr_sandbox`, which holds exactly `ebmr_app`'s privileges. It writes 185 tables: 15 by its own grants (the
kernel's stub tables) and 170 through the SECURITY DEFINER functions it may execute, followed through the functions and
triggers they call, plus the four content stores, which recipe-core 0210, 0280 and 0299 write by dynamic SQL (the
only dynamic writes a function the role may execute makes), and the legacy stage summary. Only
text, text[] and jsonb columns can hold a word; the other columns are ids, numbers, times, booleans, intervals and
enumerated types.

**A. A test run's record: every text read (recipe-core 0344, 0346, 0347, EBMR-EXE-147).** `recipe.batch_execution`,
`execution_command` (every text column, `actor_legal_name` included since 0346), `execution_state`, `execution_event`,
`execution_clock`, `execution_step_content`, `execution_stage_content`, `execution_exception_content`,
`execution_point_content`, `execution_disposition_proposal`, `execution_decision_proposal`,
`execution_stage_summary_legacy`; `tab.manual_weighing_basis` (the room and every scale's status and reason, tablets
0640, which also allows there the system's own error codes EBMR-<area>-<nnn> that a function of the installation names:
a refused reading's alarm code); in `kernel.audit_event`, on a run's chains and their signing chains the chain key
after the run's id, the reason code and text, the actor's name and every business entry, and on a scale reading's chain
the same for every entry (the gateway's, the claims' and any the application role appends). Every string and member
name of a JSON value is read, at any depth, at commit, as written and with its escapes read (kernel 1040). A copy into
the record from anywhere else is read where it lands, so this does not depend on tracing where a text comes from. The
words allowed there are bound to the run, none by its form: the imported package (the MBR), the batch number and the
site and room of the session that issued it or writes a row, the names of the engine's registers (`recipe.engine_name`:
rule codes, block types, the controls and invariants, the schema tag), the record ids the run's state holds, the edges
of its MBR's flow, compounds of these whose every part holds a letter, a compound of the batch number only as the state
holds it, a number in a compound only in the engine's shapes (a context fragment <n>/<section> within the enclosing
section's maximum, a compound the MBR, its expanded ids or a held container or sample holds; recipe-core 0348), and in
an audit entry the run's hash prefixes; on a reading's chain the site and room of the writing session and its device. A
person's name is not an allowed word. A catalogue check after recipe-core 0348 and tablets 0640: every table with a
foreign key to `recipe.batch_execution` or `recipe.execution_command` (`execution_command`, `execution_state`,
`execution_event`, the four content stores, both proposal tables, `execution_stage_summary_legacy`,
`tab.manual_weighing_basis`) carries `zzz_sandbox_free_text`, and so do `recipe.batch_execution` and
`recipe.execution_clock` (keyed by the batch id without a foreign key); in these thirteen record tables every text,
text[] and jsonb column is an argument of `zzz_sandbox_free_text` (the basis's room and scales through its own trigger
function); of `kernel.audit_event` the chain key, action,
table name and record id are the kernel's (a record id is the audited row's key) and of its payload the members listed
above are read, the others being ids, times, the kernel's enumerations and the audited row, read in its own table.

**B. The kernel's stub tables (kernel 1030).** Identifier rule: `market.stub_batch.batch_number`,
`market.stub_material_lot.code`, `market.stub_pack.code` (EBMR-SBX-022). Read for the rule (EBMR-SBX-024):
`market.stub_site.predicates`, `market.stub_product.predicates`, `market.stub_mbr_limit.value` and `.predicates`,
`esig.stub_signable.title`, `.value`, `.unit`, `platform.stub_record.title`, `.body`, `platform.stub_step_entry.late_reason_text`,
`.unit`. Not read, codes of master data or values the database sets: the `code` of `market.stub_site`, `stub_product`,
`stub_line`, `stub_room` and `stub_equipment`; `market.stub_mbr_limit.mbr_code` and `.key`; the `markets` lists;
`market.stub_pack.destination` (a market, by key); `esig.stub_signable.site`, `.area`, `.product`;
`platform.stub_step_entry.late_reason_code` (the kernel's list), `.entered_by`, `.site_zone`, `.review_flags` (set by
the database). `platform.stub_step`, `market.stub_product_qualification` and `market.stub_person_qualification` hold
no free text.

**C. Registers a test run reads, bound when it reads them.** `tab.sandbox_lot`: lot code under the rule (tablets 0200),
material code bound at use to the batch's MBR (0600), material name read (0630). `tab.reading_use`: purpose TARE or
GROSS (0600), room bound to the session. `tab.device_reading`: a reading's value and device label enter the record
only as evidence, bound by 0335 and read by 0344; the business entry of its chain that the gateway's ingest writes
quotes its device and gateway codes, value, unit, status and raw line and is read since recipe-core 0346 (A), so a
reading whose raw line holds an unbound real-format word is not ingested in a sandbox; its serial is not read there.
`tab.instrument_heartbeat` (serial, not-ready text), `tab.gateway_instrument` (registered serial),
`tab.gateway_api_contact` (detail) and `tab.device_alarm` (code): the manual-weighing gate quotes them in the reason it
records with a hand-keyed weighing (correction of F12.9's "which no entry quotes"), where they are read since tablets
0640 (A); a word there that the rule reads as real refuses the weighing in a sandbox, an honest serial of letters and
digits included (decision F12.10). `iam.person`,
`iam.person_name_event`, `iam.issued_identifier`: names and labels under the PERSON_LABEL rule (TEST- in front), and
since kernel 1040 a legal name, an employee reference and a login name are read for the identifier rule whatever follows
the prefix (EBMR-SBX-024; the name history is written with the person's update, so it holds no other name); a name
stored before kernel 1040 is refused wherever a run would copy it (A). `iam.device` and `iam.session`: a device's label is
under the DEVICE_LABEL rule, its site, room and line codes and description are not read; a session takes the site and
room of its device, and they are allowed words of a run and of a reading's chain (A): master-data codes such as DISP-1
have the form of a lot number, so the rule cannot be applied to them (residual, F12.8 (6)). `recipe.test_package`: the
imported MBR, hash-consistent and allowed in a run (A). `recipe.stub_batch`: number under the rule (0341); site, line and batch size not read.
`site.batch_number_allocation`: number under the rule; product name and external reference not read.

**D. Free text nothing reads for the rule, outside every test run's record (residual, for the owner and the lead).**
Set-up and administration of the sandbox, logs that keep what was presented, and values the kernel derives:
- `iam` (29): access_recertification (comment); account (status_reason); account_lock_event (reason); account_status_event (status, reason); auth_event (device_class, components); authn_attempt (method, purpose, device_fingerprint, reason); authority_evaluation (permission_code, role_filter, scope, reasons, role_code, inputs); badge (label, status_reason); badge_test (notes); break_glass_window (reason, review_comment); credential (end_reason); credential_secret (verifier); delegation (scope_site, scope_area, scope_product, markets, meanings, sop_ref, reason, decision_reason, revocation_reason); esig_acknowledgement (manifestation_name); identity_verification (document_type, evidence_ref); person_qualification (source_ref, withdrawal_reason); person_status_event (status); policy_value (value, reason); qualification_requirement (scope_site, scope_area, scope_product, reason); qualification_type (name, description); reserved_identifier (reason); role (catalogue_ref, name, description, account_kinds); role_grant (scope_site, scope_area, scope_product, reason, decision_reason, revocation_reason); role_permission_request (reason, decision_reason); security_alert (details); security_alert_action (comment); segregation_evaluation (rule_code, subject); session_event (reason); us_esig_certification (legal_entity, letter_ref, fda_acknowledgement_ref).
- `esig` (10): challenge (aggregate_type, aggregate_id, aggregate_ref, client_content_hash, preview); content_change (aggregate_type, aggregate_id, aggregate_ref, table_name); meaning_type (title, meaning_text, permissions, independent_of, sources); policy_value (value, reason, change_ref); seal_key (public_key, description); seal_key_retirement (reason); signature (aggregate_type, aggregate_id, aggregate_ref, meaning_title, meaning_text, signer_login, signer_legal_name, signer_role_code, signer_role_name, auth_method, components_used, site_zone, witness, manifestation, manifestation_text, record_state); signature_invalidation (aggregate_ref, previous_content_hash, current_content_hash); signature_seal (aggregate_ref); signing_failure (code, message, misuse_code, misuse_detail, aggregate_ref, meaning_code).
- `kernel` (5): audit_anchor (heads); audit_chain_head (chain_key); audit_checkpoint (chain_key, reason); audit_verification_run (problems, run_by); ddl_log (session_user_name, command_tag, object_identity). And `kernel.audit_event` outside A: an entry on any other chain, which the application role can append itself (`kernel.audit_business_event` takes any chain key and is the kernel's API for the application); it is part of no run's record (a run's and a reading's chains are A).
- `market` (9): batch_policy_pin (reason); change_impact (ref_label, key, market_set, pinned_value, required_value, governing_markets, problem, note); evaluation (key, table_code, market_set, market_derivation, predicates, stated, method, unit, resolved_value, governing_markets, predicate_branch, floor_type, hard_floor, effective_value, resolution, inputs); policy (title, controls, positions, default_position); policy_version (position, change_ref, reason); rule_key (key, title, unit, ordered_values, stated_method, predicate_domain, catalog_refs, description); rule_row (row_ref, predicate, value, unit, hard_floor, source, note); rule_table_version (change_description, citation, vendor_notice_ref, loosening, source_file, source_sha256); site_value (key, value, unit, market_set, predicates, resolution, justification_ref).
- `platform` (15): aggregate_clock (aggregate_type, aggregate_id); aggregate_state (state); alarm (subject, details, raised_by_person); alarm_clearance (subject, note); drift_sample (node, error); idempotency_key (person_id, account_id, result_json); machine_version (initial_state, states, final_states); outbox (aggregate_id, payload, person_id, source); outbox_attempt (relay, error); outbox_state (aggregate_type, aggregate_id, claimed_by, delivered_by, last_error); setting_value (value, set_by_person, reason_code, reason_text); state_history (aggregate_type, machine_code, from_state, event, to_state, guard_results, permission_code, signature_meaning, payload, person_id, account_id, role_code, reason_code, reason_text); time_anomaly (aggregate_type, aggregate_id); time_source (endpoint, reference, validation_ref, registered_by); time_source_registration (endpoint, reference, validation_ref, registered_by).
- `records` (18): blocker_epoch (record_key); di_investigation (concern, qms_reference); di_investigation_closure (conclusion, remediation); di_investigation_link (record_key, aggregate_type, aggregate_id, note); incident (title, description); incident_assessment (aggregate_type, aggregate_id, deviation_ref, rationale); incident_event (note, root_cause, capa_ref, closure_summary, report_reference); incident_link (aggregate_id, step_ref); purge_approval (record_key, reason); record_type (title, description, original_and_copies, hybrid_linkage, storage_location, owning_module, owner_role, review_rule, retained_metadata); retention_dependency (supporting_record_key, dependant_record_key, link_kind); retention_evaluation (record_key, own, effective); retention_hold (record_key, aggregate_type, aggregate_id, reason, reference); retention_hold_release (record_key, reason); retention_input (record_key, inputs, change_reason); retention_schedule (record_key, aggregate_id, site_zone); tombstone (record_key, aggregate_type, aggregate_id, record_type_code, retention_key, rule_set_version, effective_retention, site_zone, true_copy_manifest_sha256, executed_by_source, reason_code, reason_text, purged_tables, chain_key); true_copy (record_key, bundle_format, tables, purpose).
- `continuity` (15): backup_job_run (error_text); alarm (subject, details); alarm_acknowledgement (comment); backup_catalogue (database_name, storage_uri, encryption_key_ref, tool_version); ceiling_reservation (ledger_receipt, incarnation); counter (ceiling_incarnation); database_incarnation (incarnation); device_hardening_attestation (os_build, evidence_ref); device_hardening_revocation (reason); protected_sequence (description); restore_completion (incarnation, bumps); restore_drill (source_database, restored_database, report_uri); restore_event (reason, change_reference, operator_role_code, new_incarnation, anchor_comparison, affected_chains, affected_chain_keys); restore_event_approval (approver_role_code); sequence_bump (sequence_key).
- `site` (3): batch_number_rule (site_zone, counter_key, reason); batch_number_serial_skip (site_code, rendered_number); batch_number_void (site_code, reason_text).
- `recipe` (17): authorisation_cell (market, site, line, batch_size); batch_mbr_pin (markets, scope, selection, rule_table_versions); change_record (title, qms_reference); change_record_regulatory (reporting_category, regulatory_reference); change_record_validation (validation_ref, description); control_recipe (snapshot); in_flight_disposition (reason); market_authorisation (cells, regulatory_basis); market_authorisation_withdrawal (reason); mbr_content (content, reason); mbr_draft_entry (from_state, reason_code, reason_text); mbr_evidence (tool_version, report, reference, problems); mbr_family (title, product_code, product_name, strength, dosage_form, batch_sizes); mbr_risk_link (subjects); mbr_version_log (detail); periodic_review (summary); risk_assessment (code, version, title, risk_class, rationale_ref).
- `tab` (12): attribution_method (reason); designer_justification (text, role_code); device_alarm (code, gateway_code, device_code, reading_id, message, details); gateway_api_contact (detail); gateway_instrument (device_code, resolution, ended_reason); gateway_key (gateway_code, revoked_reason); instrument_heartbeat (serial, not_ready); mbr_test_package_export (role_code); reference_document (title, content, recorded_role); reference_document_retirement (reason, recorded_role); scale_room_lock (room_code); session_binding (role_code).

None of these is part of a test run's record, and a copy of any of them into the record is read there (A). Searched on
4 October for a test run's id after a run with signatures, an exception and a hold (every table of a sandbox), the
tables outside A that hold it are: `esig.challenge` and `esig.signature` (the record named by its canonical id, which
must have a content provider, the printed name and login from the person register, read since kernel 1040, the
meaning from the meaning register, the content hash computed by the kernel; their audit entries are on the run's
signing chains, read in A), `esig.content_change` and `esig.signature_seal` (ids, table names and seals the kernel's
triggers write), `iam.segregation_evaluation` (the rule code and subject the kernel derives), `kernel.audit_chain_head`
(the keys of the run's chains, read in A where their entries are) and `platform.idempotency_key` (the server's answer to
a command that committed, kept to answer a repetition of it; it is claimed in the command's own transaction, so a
refused command, an EBMR-EXE-147 or EBMR-EXE-074 refusal included, keeps no answer, and an answer kept copies what the
committed record holds, read in A at that commit). Text that reaches a run unread only through the bound sources of A: an imported package (a writer holding the
application's credentials can import an MBR text of its own, decision F12.5; a signed export would close it) and the
device register's site and room codes (the person register's names are read since kernel 1040 and are no longer a
bound source). `esig.signature` prints the signer's name from the register: a run's signature is made in the
transaction of its row and after its challenge, both read (A), so it never prints a name A refuses; a signature of
another record may print a name stored before kernel 1040. Logs keep what was presented on purpose
(DI-19: every failed attempt is logged as made).

**E. No free text.** No text column: `kernel.command_marker`, `iam.command_log`, `iam.badge_secret`,
`iam.session_activity`, `esig.signature_id_register`, `recipe.mbr_version`, `recipe.mbr_evidence_void`,
`recipe.market_authorisation_activation`, `tab.ingest_challenge`, `tab.reading_claim_mark`. Every text column an
enumeration, a pattern or a key of another table: `iam.role_permission`, `iam.mirror_heartbeat`, `iam.auth_event_use`,
`records.record_type_approval`, `platform.consumed_message`, `tab.device_nonce`, `tab.gateway_session`.

Counted: A 9 tables of the 185 (and the 5 stores outside them), B 15, C 11, D 133, E 17; `kernel.audit_event` is counted
in A, its entries on other chains are D's (recount of 4 October after recipe-core 0348 and tablets 0640: the same 185
tables; `tab.manual_weighing_basis` moved from D to A).
