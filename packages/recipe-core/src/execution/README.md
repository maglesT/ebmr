# Execution store (`recipe-core/src/execution`, `sql/0200-0249`, `sql/0260`)

Phase 2 apps, module C3. The database-backed store of batch executions. In Phase 2 it holds sandbox
test runs of MBR versions only (TEST- batches). The pure engine (`../engine`) decides; this store writes
down what the engine decided and re-checks everything a database can check on its own.

Node-only. Import it from the root export (`import { execution } from '@ebmr/recipe-core'`), never from
`@ebmr/recipe-core/pure`.

Reference: Phase 2 apps plan section 7, ADR 0004, 0006, 0010, 0012 and 0016.

Controls: DI-05, DI-34, DI-37 (execution part) and PR-08. Invariants: INV-03, INV-09, INV-10, INV-16,
INV-18, INV-19, INV-20, INV-25, INV-26 and INV-40.

```ts
import { execution } from '@ebmr/recipe-core';

const pkg = execution.parseTestPackage(json, fileName);            // strict; hashes recomputed
await execution.importTestPackage(client, pkg.pkg, fileName);      // SQL recomputes them again; GMP origin only
const { batchNumber } = await execution.issueBatch(client, { def, batchId, packageHash, request });
const tx = await execution.ExecutionTx.open(client, def, batchId); // lock + trusted time (INV-16)
const r = await tx.command(command, roleEvidence);                 // accepted or refused, always a row
await tx.prepare(target, actor, roleEvidence, meaning);            // PREPARE row when system facts changed
await (await execution.ExecutionTx.tryOpen(client, def, batchId))?.sweep(); // the sweeper (SKIP LOCKED)
const report = await execution.replayExecution(db, def, batchId);  // identical, or the first difference
```

## Tables (schema `recipe`, sql/0200)

**Packages and batches**
- `test_package` holds the imported `ebmr.mbr-test-package` files: the package, its MBR content and
  hashes, the family and version, the exporter, and the GMP source stamp.
- `batch_execution` holds one row per test batch:
  - the TEST- number (the kernel's identifier guard refuses anything else);
  - the pinned content hash, engine version and block-registry fingerprint;
  - the pinned policy and its hash;
  - the issue request;
  - the site, room and zone.

**One row per engine call**
- `execution_command` has one row per engine call: ISSUE, COMMAND, PREPARE or SWEEP. Each row carries:
  - its sequence number (gapless) and the hash chain;
  - the trusted database time it ran at;
  - the actor, device, room and the badge-tap event;
  - the engine's verdict and refusal;
  - the hashes of the resulting state and of its events;
  - the role evidence and the signature ids;
  - the evidence the server resolved: reading ids and raw lines, lot facts.
- `execution_event` and `execution_state` hold the events and the projection.

**Signable content**
- There are four insert-only, versioned tables, one per aggregate:
  - `execution_step_content` (`batch_step`);
  - `execution_stage_content` (`batch_stage`);
  - `execution_exception_content` (`batch_exception`);
  - `execution_point_content` (`batch_point`).
- Each is registered with the e-signature module. A new content version therefore supersedes the
  signatures made on the previous one (INV-09).

**Proposed dispositions**
- `execution_disposition_proposal` holds the disposition a QA reviewer is about to sign (see below).

**Configuration and clock**
- `execution_command_permission` gives the permission of each command type.
- `engine_role_permission` gives the permission each engine role needs (INV-26).
- `sandbox_only_block` lists the SANDBOX_ONLY block versions.
- `execution_clock` is the transaction's clock marker. It is unlogged and owner-only.

The application roles (ebmr_app, and ebmr_sandbox in a sandbox) may only read. Every write goes through
a SECURITY DEFINER function in sql/0210.

## Writers (sql/0210)

**`lock_execution(batch, skip_locked)`** locks the batch. It also writes the clock marker: the first
`clock_timestamp()` of the transaction, reused by every later call. A dry run and its apply therefore see
the same instant. It returns the projection and that time. With `skip_locked` set (the sweeper), a batch
that another command holds is skipped.

**`append_execution(...)`** re-checks every row before writing it:
- the actor is validated, is not an administrator, and the installation is the sandbox;
- the actor holds the mapped permission, in the declared role, at its location;
- `now_us` is the marker (INV-16);
- the sequence and the hash chain are intact;
- the state and events hashes are recomputed through `esig.canonical_json`;
- the command id is unique;
- the engine actor is the person signed in, and a SWEEP comes only from a SYSTEM service account;
- every engine role has an allowed authority evaluation of its permission, stored in the same command
  (INV-26);
- for VERIFY, the verifier is not among the stored performers, data enterers, correctors or PERFORMED
  signers (INV-03);
- every e-signature an accepted command uses exists, is valid, has the command's meaning, is on that
  aggregate and was made by the actor (INV-10).

Refused engine calls are written too; their refusal is part of the record. `append_execution` also writes
one plain-language business entry on the chain `batch:<id>`.

**Other writers and checks**
- The constraint trigger `zz_execution_attribution` (INV-40): a row written on a SHARED or GRADE_A_B
  terminal must carry the badge-tap event that this very command consumed.
- `begin_issue`, `issue_execution` and `import_test_package` are sandbox only and require BATCH.ISSUE.
  - The TEST- number comes from a sequence and must be the one allocated in the issuing transaction.
  - The package hash, the content hash and the GMP origin are recomputed in SQL.
- The content providers `batch_step_content`, `batch_stage_content`, `batch_exception_content` and
  `batch_point_content` read the latest content version, the state and the persons involved. For a
  witnessed act, `batch_step` also reports `act {device_id, at, next_step_started}`.
- `execution_violations()` must return no rows. It checks:
  - sequence gaps and the hash chain;
  - the projection against the last row;
  - events against their hash;
  - shared rows without a tap;
  - content versions against their hashes;
  - in a GMP database: any test batch, package or SANDBOX_ONLY block.

Error codes are `EBMR-EXE-NNN`, in brackets at the end of each message:

| Codes | Area |
|---|---|
| 001-009 | actor and installation |
| 010-019 | packages and issue |
| 020-029 | clock and sequence |
| 030-039 | state, events and roles |
| 040-049 | attribution |
| 050-059 | signatures and content |
| 060-064 | definition fit (TypeScript) |
| 070-089 | tablets lots, intents, signing and proposals (server) |

## TypeScript

- `test-package.ts`: the exchange format. It builds a package (`buildTestPackage`, used by the GMP
  exporter) and parses one strictly (`parseTestPackage`: exact member sets, both hashes recomputed, file
  name checked, MBR content parsed and in canonical form).
- `store.ts` has one thin function per SQL writer or reader:
  - lock, append, begin and issue, import;
  - load rows, state and content heads;
  - disposition proposals;
  - violations.
- `run.ts`:
  - `ExecutionTx` holds one command's work on a locked batch. `command`, `dryRun`, `prepare` and `sweep`
    run the pure engine at the trusted time and append what it decided.
  - `issueBatch` issues a batch.
  - `assertDefinitionFits` refuses a definition that is not the batch's own: content, engine version,
    block registry, pinned policy and installation (ADR 0010).
- `verify.ts`: `replayExecution` replays the stored rows with the pure engine, at their stored clocks.
  - Row by row, the result must equal what is stored: the accepted flag, the events hash and the state
    hash.
  - The stored state must be the last row's.
  - The latest stored content of every aggregate must be the content of that state.

## Signing content: what is and is not hashed

`engine/signing-content.ts` defines what a signature binds; the engine README lists the include and
exclude rules. The store adds three decisions, all accepted by the lead.

**1. Times of facts computed during preparation are not in the signed text.** Three times are left out:
- the recorded time of a block-computed value;
- the computation time of a derived value;
- the time at which an exception on a step was raised.

Their values, inputs, evaluations and the exceptions themselves remain signed. Their times stay in the
record, in the hash-chained rows, the events and the state hash.

Reason: these facts are materialised when the step is prepared for signing, by the sweep and by the
PERFORMED finalisation. The signer's preview is computed a moment before the challenge prepares the
record for real. If the times were signed, the preview could never equal the prepared content, and every
PERFORMED signature on a step with computed items would be refused as "the record changed while you were
reviewing it" (EBMR-ESIG-013), on every retry.

**2. A phase instance's first content version is stored when a person first works on it.** That happens
at START_STEP at the latest, or when the phase first changes. It is not stored when the phase is enabled.

Reason: the e-signature module counts the person whose command stores a content version as having
changed that record (`esig.content_change`). A phase is enabled by the command that ends the step before
it, often a VERIFY. Storing its first version then would stop the verifier of step N from verifying
step N+1, a false INV-03 refusal.

Hold points, stage frames, exceptions and data points are stored when they appear. A hold point is decided
by QA, who normally did not enable it. Replay accepts a missing head only for a phase that has not been
started. `ExecutionTx` stores the first version of the phase that an accepted command, or a PREPARE for
SIGN_PERFORMED, works on (`touchedAggregates`).

**3. The disposition an exception is signed with is part of its signed content.** This follows Part 11
signature/record linking and EU GMP Annex 11 section 14.
- When the challenge for DISPOSITION_EXCEPTION is prepared, the proposed `{outcome, justification,
  deviationRef}` is recorded in `execution_disposition_proposal`. The `batch_exception` provider adds the
  latest proposal made on the current content version to the content as `proposedDisposition`, so the
  challenge hash covers it.
- The dry run and the apply refuse a signing whose action differs from that proposal (EBMR-EXE-086).
- The proposal is kept outside the signed content table on purpose. Proposing is not a change of the
  exception's data, so the QA reviewer never becomes an "enterer" of the record they then disposition.
- The signer's preview shows and hashes the proposal. It is passed in the preview's `intent` as
  `EXCEPTION_DISPOSITIONED|<base64url of the JSON {outcome, justification}>`.

## Defaults taken (owner decision 0004)

**Signed aggregates**
- DISPOSITION_EXCEPTION signs the `batch_exception` aggregate; CORRECT_ENTRY (A2) signs `batch_point`.
- The stage's signing content excludes its derived summary statement, which is computed at the sign-off.
- The verdict on a loop endpoint is a later system fact. Inside a loop the content shows it as "judged at
  the loop exit".

**Permissions and roles**
- HOLD_BATCH, RELEASE_HOLD and ATTACH_DEVIATION: STEP.SUPERVISE or QA.FLOOR_APPROVE.
- RAISE_EXCEPTION: any shop-floor permission.
- The sweeper: a new permission, EXECUTION.SWEEP, held only by the role EXECUTION_SWEEPER (sql 0260; SERVICE
  accounts only). Only the sweeper identity is granted that role. sql 0200 first granted the permission to the kernel's
  SERVICE_ACCOUNT role, which the gateway holds too; 0260 removes that row (DI-17 least privilege). The sweeper no
  longer holds SERVICE_ACCOUNT, and so no longer holds INTERFACE.WRITE or the kernel's other service permissions.
- The provider scope is `{site}` of the batch.

**Batches and rows**
- Test batch numbers are `TEST-B<yy>-<nnnn>`, from a protected sequence (INV-27, sql 0220): the serial is
  zero-padded to four digits and never shortened, so 10001 stays 10001 after a restore moves the sequence on (sql 0240).
- A test run's engine purpose is VALIDATION (a run validates an MBR version).
- A PREPARE row is written only when the preparation produced events; a SWEEP row likewise.

**Signing**
- The expected state for esig.sign is the status the engine requires for the command:

  | Command | Expected state |
  |---|---|
  | SIGN_PERFORMED | IN_PROGRESS |
  | VERIFY | AWAITING_VERIFICATION |
  | hold point | ENABLED |
  | sign-off | AWAITING_SIGN_OFF |
  | disposition | OPEN |

- A PERFORMED signature on a step still in progress is superseded when the step's data changes, in the
  engine (`resignAfterChange`) as in the kernel.

## Tests

**recipe-core (`--project db`)**
- `test/engine/codec.test.ts`, `signing-content.test.ts`, `actions.test.ts`, `replay.test.ts`;
- `test/blocks/status.test.ts` and `golden.test.ts`.

**tablets-server (`--project server apps/tablets-server/test/execution`)**
- `store.test.ts`: INV-18/DI-05 in GMP and sandbox; INV-40; INV-16; INV-26; INV-03 in SQL; no
  application-role writes; the role map.
- `commands.test.ts`: packages, issue, DI-34 refusals, ENG-STALE, idempotency, serialisation, INV-25,
  lots, PR-08, views.
- `signing.test.ts`: the ceremony; INV-10; disposition proposals; hold-point decisions; witness; INV-09.
- `sweeper.test.ts`: INV-20.
- `golden.test.ts`: the dc-mini run to EXECUTION_COMPLETE. The persistence model is checked after every
  step: no violations, the kernel's valid signatures equal the engine's, and replay is identical. The
  run records the signature-budget baseline: 29 signatures.
