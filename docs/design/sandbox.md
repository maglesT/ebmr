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
  has members, so no other login can write the listener's evidence (decision X36).
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
