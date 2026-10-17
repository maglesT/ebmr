# Slice 7-0: Phase 7 interfaces (fixed 17 October 2026)

These are the interface notes of Phase 7: what more than one slice reads or writes. The plan is
[phase-7-plan.md](phase-7-plan.md). The lead's 7-0 commit turns them into code before any builder starts. After that
every change is additive: a new optional field, a new document, a new check, a new message. Nothing is renamed or
removed. New messages: `EBMR-INT-030` and up, `EBMR-VAL-001` and up.

## 1. The evidence bundle v1 (what the validation-pack generators read)

One JSON file, `validation-bundle.json`, built by `pnpm validation:bundle` (`tools/validation`) and read by the pure
generators of `packages/validation-kit`. Its JSON schema is `packages/validation-kit/src/bundle/bundle.schema.json`;
the TypeScript types are generated beside it. The generators read nothing else: no database, no file system, no clock.

**Determinism.** Every array is sorted by the key named below; object keys are written sorted; no field holds the time
the bundle was built. Times come from the inputs (the commit time, the test reports). The bundle's own SHA-256 is
written into every generated document's footer and into the pack manifest.

| Field | Content | Sorted by |
|---|---|---|
| `bundleVersion` | `1` | |
| `edition` | `tablets` (later `injectables`) | |
| `release` | `product` ("Batchwright Tablets"), `maker` ("Medhanta"), `version` (for example `1.0.0-rc.1`), `commit`, `commitTime`, `schemaRelease` (section 3) | |
| `register.controls[]` | per control: `id`, `title`, `editions`, `type`, `targetPhase`, `sources`, `behaviour`, `catalogTest`, `requirementRows`, `implementedBy`, `clauses[]` (`clause`, `tests[]`, `deferred?`), `deferredScope[]`, `expertDecision` (status, reviewer, date, pack version), `buildStatus`, `draft` (true for status-U drafts), `class` (`core` or `other`, from section 1a) | `id` |
| `register.requirements[]` | the requirement rows (`n`, source, verification marker, paraphrase) | `n` |
| `runs[]` | `id`, `kind` (`vitest`, `golden`, `playwright`, `load`, `drill`, `security`, `accessibility`, `mutation`), `commit`, `startedAt` and `finishedAt` (from the report), `reportFile`, `reportSha256`, `host` (cpu, memory, os, node, postgres versions) | `id` |
| `results[]` | `test` (the `<file> > ... > title` form the register uses), `run`, `status` (`passed`, `failed`, `skipped`), `durationMs`, `controls[]` (ids parsed from the title), `evidence?` (the browser suite's step record) | `test`, `run` |
| `trace` | `phase`, `editions`, `ok`, and per control `passing[]` and per clause `status` (`PROVEN`, `DEFERRED`, `MISSING`) | `control` |
| `inventory` | from a migrated database and the code (section 1b) | each list by its name |
| `criticalLimits[]` | from `compliance/validation/critical-limits.yaml`: `key`, `description`, `controls[]`, `boundaryTests[]` | `key` |
| `reviews[]` | from `compliance/validation/reviews.yaml`: `id` (for example `6j-c`, `7a-quick`), `date`, `scope` (path globs), `findings` (counts by severity, open and fixed) | `id` |
| `openFindings[]` | from `compliance/validation/open-findings.yaml`: `id`, `severity`, `controls[]`, `summary`, `source` (backlog file) | `id` |
| `analytics.methods[]` | from the method registry: `id`, `versions[]`, `intendedUse`, `changesGmpData` | `id` |
| `records[]` | the Phase 7 records (load, soak, restore, upgrade, migration dry run, security, accessibility, mutation, IQ, OQ): `kind`, `file`, `sha256`, `passed`, `summary` (short text), `measures` (name, value, unit, limit) | `kind` |
| `sbom` | `file`, `sha256`, `format` (`CycloneDX 1.5`) | |
| `knownIssues[]` | from the backlogs and `openFindings`: `id`, `severity`, `controls[]`, `text` | `id` |

**1a. Control class.** `core` when the control falls under decision 0008 section 2's regulation-required core (audit
trail, e-signatures, access and segregation, record integrity, trusted time, status and release interlocks, limits and
calculations, market resolution), `other` otherwise. The class is written once per control in
`compliance/validation/control-class.yaml` (7-0 seeds it from the phase plans' class tables; a control not listed is
`core`, the stricter reading). It is not a control field and changes no control file.

**1b. Inventory.** Built by `tools/validation/src/inventory.ts` over a database migrated to the release (a read-only
connection; it queries `pg_catalog` and the kernel registries) and over the code:
- `migrations[]`: namespace, file name, SHA-256 of the file (as `public.schema_migration` holds them);
- `functions[]`: schema, name, argument types, SECURITY DEFINER or not, owner, the roles that may EXECUTE;
- `triggers[]`: table, name, enabled, function;
- `constraints[]`: table, name, kind, definition hash;
- `privileges[]`: role, object, privilege;
- `roles[]`: name and attributes (LOGIN, SUPERUSER, CREATEROLE, BYPASSRLS, INHERIT, connection limit);
- `settings[]`: name, value, and the expected value where the release fixes one;
- `auditedTables[]` (`kernel.audited_table`), `permissions[]` (permission, roles, scope kinds), `meanings[]` (signature
  meanings), `messages[]` (code, text, source file; from the SQL and the TypeScript);
- `stateCharts[]` (machine, states, transitions; from the XState definitions), `blocks[]` (block type, version,
  controls), `ruleKeys[]`, `routes[]` (namespace, route, method, permission; from the contract).

**1c. The files under `compliance/validation/`** (new in 7-0; schema-checked by `register:validate`):
`critical-limits.yaml`, `reviews.yaml`, `open-findings.yaml`, `control-class.yaml`. Every test a file names must be a
test the register lists; `register:validate` refuses one it does not know.

**1d. Commands.**

| Command | Does |
|---|---|
| `pnpm validation:bundle --results .reports --db <url> --records <dir> --out .reports/validation/bundle.json` | builds the bundle |
| `pnpm validation:generate --bundle <file> --out .reports/validation/pack` | writes the pack (Markdown, HTML, then PDF) and `manifest.json` |
| `pnpm validation:iq --db <url> --server <url> --bundle <file>` | the IQ checks and record of an installation |
| `pnpm validation:oq --server <url>` | runs the regression, golden and browser suites against an installation and writes the OQ record |
| `pnpm register:status --bundle <file>` | sets each control's `build_status` by D-P7-2 (the only writer of VERIFIED) |

## 2. The gateway feed signature (6jc-R9; slice 7a)

**What is signed.** Every envelope of the gateway's OPC UA feed (`opcua.series_chunk`, `opcua.alarm`, `opcua.event`,
`opcua.endpoint_session`): the existing 6a envelope gains one optional field, required for the OPCUA source from 7a on.

```
gatewaySignature: {
  alg: "Ed25519",
  gatewayCode: string,        // the gateway's code in tab.gateway_key
  keyId: string,              // lowercase hex SHA-256 of the key's SPKI DER
  sig: string                 // standard base64 (padded) of the 64-byte signature
}
```

**The signed message** is the UTF-8 bytes of these lines joined by `\n`, with no trailing newline, built only by
`feedSignatureMessage(envelope, gatewayCode, keyId)` in `@ebmr/integration-sdk/adapter` (the one implementation; the
SQL twin is tested against its vectors):

```
ebmr-gateway-feed-v1
<gatewayCode>
<sourceSystem>
<messageType>@<messageVersion>
<sequence, decimal, no leading zeros>
<idempotencyKey>
<payloadHash, lowercase hex>
<keyId>
```

The domain line keeps it apart from the reading and login proofs the gateway already signs (`uplink.ts`). The
sequence, the type and the payload hash are inside the signature, so a replayed envelope with a new sequence fails the
check, and an exact resend is de-duplicated as today. Test vectors (key, envelope, message bytes, signature) are in
`packages/integration-sdk/fixtures/feed-signature-v1.json`, generated with a key made for the test only.

**Where it is checked: in the database**, through an edition-neutral marker in the kernel and the edition's own
verifier:
- `platform.source_requires_signature(source_system)` is true for `OPCUA` (kernel, 7a range; a configuration row, so an
  Injectables gateway can join it later).
- `platform.record_source_verification(envelope_key text, verifier text)` (SECURITY DEFINER, executable by owner-level
  edition functions only) marks the envelope verified in this transaction.
- `tab.accept_gateway_envelope(p_envelope jsonb) returns jsonb` (tablets, SECURITY DEFINER, INTERFACE.WRITE of the
  OPCUA adapter's identity): finds the ACTIVE key of `gatewayCode` in `tab.gateway_key` whose SHA-256 is `keyId`,
  checks the gateway is the one bound to the calling adapter, verifies the signature with `tab.ed25519_verify` (small
  order keys refused, tablets 0702), records the verification, then calls the existing `plant.receive_*` function for
  the message type and returns its answer.
- The `plant.receive_*` functions (re-created in recipe-core's 7a range) refuse an envelope of a source that requires a
  signature without a verification in the transaction. So a direct call by the integration identity is refused (the
  bypass test).
- Refusals are the 6a kind: an integration alarm is recorded and nothing else is written.

| Code | Refusal |
|---|---|
| `EBMR-INT-030` | the envelope of a signing source has no `gatewaySignature`, or reached `plant.receive_*` without verification |
| `EBMR-INT-031` | unknown, inactive or unbound gateway key |
| `EBMR-INT-032` | the signature does not verify |
| `EBMR-INT-033` | `gatewayCode` or `keyId` disagree with the adapter's binding |
| `EBMR-INT-034` | (server start-up) an adapter base URL off loopback without mutual TLS on a GMP installation |
| `EBMR-INT-035` | an inbound message or adapter start for an interface not in the approved system description (section 4) |

**The gateway** signs at journal time and journals the signature with the envelope; a restart serves the same bytes.
Its key stays the DEMO-ONLY key file for development and tests (a KMS or HSM at deployment, as today).

## 3. Adapter transport: mutual TLS (6jc-R9; slice 7a)

- Every adapter's options gain `tls?: AdapterTls` with `ca`, `cert`, `key` (PEM file paths) and `serverName`. On a GMP
  installation a base URL whose host is not loopback requires `tls`; without it the server refuses to start that
  adapter (`EBMR-INT-034`) and the health page names it. Loopback without TLS stays allowed (D-P7-10).
- Configuration: `EBMR_ADAPTER_TLS_DIR`, holding `<adapter code>.ca.pem`, `<adapter code>.cert.pem` and
  `<adapter code>.key.pem`; the server name defaults to the base URL's host.
- The server verifies the peer against the pinned CA and name (no system trust store) and records the peer
  certificate's SHA-256 fingerprint with each pulled page: the inbound record gains `transport_peer text null`
  (additive, kernel 7a range).
- Tests make their CA and certificates at run time; no key material is committed.

## 4. Release identity, validation summary and system description (slice 7c; tables in 7-0)

- **`platform.schema_release() returns text`** (kernel 1300-1304): the lowercase hex SHA-256 over the migration
  runner's ledger, `public.schema_migration` (`namespace`, `name`, `checksum`, the file's SHA-256), one line
  `namespace/name/checksum` per row, ordered by namespace and name (not by apply order, so a database upgraded slice by
  slice and a fresh one give the same value). It is the release as the database knows it; the IQ compares it with the
  bundle's `release.schemaRelease`, which `tools/validation` computes the same way from the migration files.
- **Validation summary approval.** Table `platform.validation_summary` (insert-only, audited): `id uuid`,
  `schema_release text`, `summary_sha256 text`, `title text`, `approved_signature uuid`, `approved_at timestamptz`
  (database clock). `platform.approve_validation_summary(schema_release, summary_sha256, title, signature)` needs
  `VALIDATION.APPROVE_SUMMARY` and a QA signature with meaning `VALIDATION_SUMMARY_APPROVED` bound to the summary hash.
  `platform.validation_summary_problem() returns text` gives `EBMR-VAL-001` when the running `schema_release()` has no
  approved summary; the batch issue on a GMP installation calls it (7c). Sandbox and training are not gated.
- **Approved system description.** Configuration area `SYSTEM_DESCRIPTION` (kernel 1195 change control): one row per
  interface (`source_system`, `adapter_code`, `endpoint_host`, `transport` `LOOPBACK` or `MTLS`, `signed_feed`
  boolean). `platform.interface_described(adapter_code) returns boolean`. `platform.accept_inbound` and the adapter start
  refuse an interface that is not described, with the INTERFACE_DRIFT alarm (`EBMR-INT-035`; 7c).
- **Test-kit helpers** (7-0): `approveValidationSummary(db)` and `approveSystemDescription(db, interfaces)`, both through
  real signed acts by test QA persons; the GMP test databases, the golden set-ups and the browser set-up call them, so
  7c's interlocks land without breaking other slices (D-P7-12).

## 5. Scope and permissions (slice 7a)

- **Batch scope (rest of 6jc-R16).** Each remaining batch act is evaluated as recipe-core 1100 did: the permission and
  qualification check uses `recipe.with_batch_scope(<location scope>, batch)` (or `recipe.batch_scope_members(batch)`),
  so a product-limited requirement applies to batches of that product only. The batch issue uses the order's product.
  Signatures and error codes stay as they are; only the scope the check is made in changes.
- **`CONTROLLED.READ`** (kernel 1300-1304): granted in tablets 1400-1404 to every role that holds a CONTROLLED.*
  permission and to QA. The controlled list, balance and register reads require it in scope (7a).
- **`VALIDATION.APPROVE_SUMMARY`**: granted to QA only.

## 6. Records and their places

| Record | Written by | Place |
|---|---|---|
| Load and soak | `tools/load` | `.reports/load/*.json`; summary `docs/validation/v1.0-rc/load-and-soak.md` |
| Restore, upgrade and migration dry run | the kernel drill CLI and `tools/validation` | `docs/validation/v1.0-rc/restore-drill.md` (from the template), `upgrade-drill.md` |
| Security verification | `tools/security` and the checklist | `docs/security/pentest-checklist.md`; `docs/validation/v1.0-rc/security-verification.md` |
| Accessibility audit | the browser suite and the checklist | `docs/validation/accessibility-audit.md` |
| Mutation | the harness and Stryker | `docs/build-plan/phase-7/mutation-results.md` |
| IQ and OQ | `pnpm validation:iq`, `validation:oq` | `.reports/validation/`; summaries in `docs/validation/v1.0-rc/` |
| The pack and bundle of the release candidate | `validation:generate` | branch `phase-7/rc-evidence`, hashes in the checklist |

Each record states the commit, the host and the inputs, so a later run can be compared with it.

## 7. Test titles (fixed; slices may add more)

- `[DI-31] an OPC UA feed envelope without a gateway signature is refused with an alarm and leaves nothing`
- `[DI-31] an envelope signed by another gateway's key, or replayed with a new sequence, is refused`
- `[DI-31] a direct call of plant.receive_series_chunk for the OPCUA source is refused without the gateway's verification`
- `[DI-31] a GMP installation refuses an adapter base URL off loopback without mutual TLS`
- `[PR-27] a facility rule or beta-lactam classification takes effect only with a QA signature by someone other than the proposer`
- `[IN-53] the controlled register and balance reads need CONTROLLED.READ`
- `[IN-04] a product-limited requirement no longer refuses <act> on another product's batch` (one per act)
- `[DI-03] a GMP batch is refused on a release without an approved validation summary`
- `[DI-06] an interface not in the approved system description raises the drift alarm and is refused`
- `[DI-06] every critical limit shows its boundary tests in the trace matrix`
- `[IN-12] the validation package contains each listed artefact and the SMF paragraph`
- `[PR-60] the AI feature inventory lists every analytics method and none changes GMP data without a human e-signature`
- `[meta] the validation pack is byte-identical for the same bundle`
- `[meta] every migration added by a branch sorts after every migration of its source on main`

## 8. Defaults of the interfaces

- **D-P7-0-1** The generators are pure and read only the bundle; everything that touches a database, a server or the
  file system is in `tools/validation`. Why: product code never imports `tools/`, and pure generators test with a
  fixture.
- **D-P7-0-2** The signature check is in the database, behind an edition-neutral kernel marker, because the gateway
  keys are an edition's (`tab.gateway_key`) while the receiving functions are recipe-core's. Why: the core holds under
  the application's own credentials (ADR 0012), and Injectables can add its verifier without touching recipe-core.
- **D-P7-0-3** Only the OPCUA source requires a signature in v1; every other adapter is protected by mutual TLS. A source
  that signs its own answers (a QMS, an L3 system) can be added to `platform.source_requires_signature` later.
- **D-P7-0-4** The control class lives in `compliance/validation/control-class.yaml`, not in the control files, so no
  control file changes for the pack; a control not listed counts as core.
- **D-P7-0-5** `schema_release()` hashes the migration ledger rather than reading a version the server reports, because
  the database cannot trust what a client says it is.
- **D-P7-0-6** The bundle schema is versioned; a generator refuses a bundle whose `bundleVersion` it does not know.

## 9. As built in the 7-0 commit (the lead, 17 October 2026)

Additive to the sections above; slices build on these names.

- **Messages.** `EBMR-VAL-001` no approved summary (kernel 1300); `EBMR-VAL-002` unknown bundle version, `EBMR-VAL-007`
  bundle does not match the schema, `EBMR-VAL-008` an array out of order or a repeated key (`parseBundle`,
  `packages/validation-kit/src/bundle/validate.ts`); `EBMR-VAL-003` malformed approval, `EBMR-VAL-004` not the running
  release, `EBMR-VAL-005` already approved, `EBMR-VAL-006` no signature or not the approver's own (kernel 1300);
  `EBMR-INT-036` a malformed interface of the system description. Next free: `EBMR-VAL-009`, `EBMR-INT-037`.
- **One more permission:** `CONFIG.SYSTEM_DESCRIPTION` (GMP, WRITE): the writer `platform.describe_interface(def)`
  needs it, under an approved change record of area SYSTEM_DESCRIPTION. Kernel 1300 grants it to PROCESS_OWNER and
  CSV_DI_LEAD, and `VALIDATION.APPROVE_SUMMARY` to QA_REVIEWER and QA_MBR_APPROVER (as kernel 1195 grants CONFIG.*: a
  signature meaning's permission is held by a kernel role, DI-35); tablets 1400 grants `CONTROLLED.READ` to every role
  holding a CONTROLLED.* permission and to QA_REVIEWER. No recipe-core migration was needed (recipe-core 1200-1204 stay
  free).
- **The signed aggregate** of a summary approval is `validation_summary`, id `<schema release>@<summary sha256>`, meaning
  `VALIDATION_SUMMARY_APPROVED`, expected state `PROPOSED`. The system description is `platform.system_interface`
  (one version per adapter code, status DESCRIBED or WITHDRAWN; a LOOPBACK interface's host is a loopback name; an
  OPCUA interface has a signed feed), read by `platform.system_description()` and `platform.interface_described(code)`.
- **Kernel callers:** `config.schemaRelease`, `config.releaseOfLedger` (the same value from the files, for
  `tools/validation`), `config.approveValidationSummary`, `config.validationSummaryProblem`, `config.describeInterface`,
  `config.systemDescription`, `config.interfaceDescribed` (`packages/kernel/src/config/release.ts`).
- **Test-kit helpers** take the people as `ValidationActs` (`app`, `qa()`, `qaSign(aggregate, meaning, state)`,
  `systemOwner()`): `approveValidationSummary(acts, opts?)` and `approveSystemDescription(acts, interfaces)`;
  `seededValidationActs(db, seed)` builds them for a seeded site (QA persona `qaInvestigator`, the bootstrap process
  owner, a DEMO-ONLY seal key). The server's feature seed adapts `FeatureSeedContext.signAs` the same way.
- **D-P7-0-7 Where the helpers are called.** Slice 7c, which adds the two interlocks, adds the calls to the GMP test
  set-ups, the golden set-ups and the browser set-up in the same PR, and takes a golden output again there if the
  approvals' audit entries move it (D-P7-12). Why: a call before the interlock exists changes golden outputs for
  nothing, and 7c is the one slice that can show each set-up needs it. Slices merged before 7c are unaffected; slices
  after it start from a main that has the calls.
- **The feed signature** is `feedSignatureMessage` in `packages/integration-sdk/src/adapter/feed-signature.ts`, with 4
  vectors in `packages/integration-sdk/fixtures/feed-signature-v1.json` (a key made for the test only) and their
  generator `test/adapter/feed-signature-vectors.generate.ts`. The OPC UA event message type is `opcua.equipment_event`
  (section 2's `opcua.event` means it). The SDK has no shared adapter options type, so it exports `AdapterTls` and
  `AdapterTransportOptions { tls? }` for the server's adapters to extend (7a).
- **The bundle** schema, types, `parseBundle`, `canonicalJson` and `bundleSha256` are in
  `packages/validation-kit/src/bundle/`, with `fixtures/example-bundle.json`.
- **The files of 1c** are in `compliance/validation/` with their schemas in `compliance/schema/`, checked by
  `register:validate` (`tools/register/src/validation-files.ts`). `control-class.yaml` lists IN-12 as `other` and
  names the Phase 4 "other" controls that later plans enforce in the database as `core`, with reasons.
- **The migration-order check** is `tools/register/src/migration-order.ts` with its `[meta]` test; it compares the
  working tree with `origin/main` (the CI tests job fetches one commit of it) and skips with the reason locally when
  `origin/main` is missing.
