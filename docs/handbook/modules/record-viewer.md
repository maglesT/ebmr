# Record viewer (`apps/record-viewer`)

The stand-alone record viewer opens a full export of the installation and shows its records, read-only, on any
computer with a current browser: no server, no network, no installation. Read this page if you build, change or test
the viewer or the export it reads, or if you explain to an auditor how records stay readable after the system is gone.

## Where the code is

| What | Where |
|---|---|
| The page, its style and its entry | [src/index.html](../../../apps/record-viewer/src/index.html), [src/style.css](../../../apps/record-viewer/src/style.css), [src/main.ts](../../../apps/record-viewer/src/main.ts) |
| The screens (plain DOM, text only) | [src/view.ts](../../../apps/record-viewer/src/view.ts#sym=renderReport) |
| The export verifier | [src/verify/export.ts](../../../apps/record-viewer/src/verify/export.ts#sym=verifyExport) |
| The true-copy bundle verifier | [src/verify/true-copy.ts](../../../apps/record-viewer/src/verify/true-copy.ts#sym=verifyBundleBytes) |
| Hashes and the Ed25519 seal check (Web Crypto) | [src/verify/crypto.ts](../../../apps/record-viewer/src/verify/crypto.ts#sym=verifyEd25519) |
| Lossless JSON and canonical JSON | [src/verify/lossless-json.ts](../../../apps/record-viewer/src/verify/lossless-json.ts), [src/verify/canonical.ts](../../../apps/record-viewer/src/verify/canonical.ts#sym=canonicalJson) |
| The build (one self-contained file) | [build.ts](../../../apps/record-viewer/build.ts#sym=buildViewer) |
| The export it reads (kernel) | [full-export.ts](../../../packages/kernel/src/records/full-export.ts#sym=buildFullExport), [1335_full_export_closed_records.sql](../../../packages/kernel/sql/1335_full_export_closed_records.sql) |
| Tests | [verify-export.test.ts](../../../apps/record-viewer/test/verify-export.test.ts), the browser test [record-viewer.spec.ts](../../../tools/e2e/specs/records/record-viewer.spec.ts) |

## What it does

1. The CSV / DI lead makes a **full export** of the installation (the kernel's `buildFullExport`, or the command
   `full-export` of [records-cli.ts](../../../packages/kernel/src/records/records-cli.ts); see
   [runbooks](../10-runbooks.md)). It is a folder: `manifest.json`, one true-copy bundle per audit chain of every closed
   record (the record itself, its review, its contingency forms, its signatures), the seal key chains, and
   `signatures.json` with the seal payloads. The database registers the SHA-256 of `manifest.json`: the **export
   SHA-256**.
2. A reader opens `record-viewer.html` from the release (built by `pnpm --filter @ebmr/record-viewer build` into
   `apps/record-viewer/dist/`), picks the export folder and, if they have it, types the export SHA-256 from the
   installation's export register.
3. The viewer checks everything **before it shows anything**:
   - `manifest.json` reads and is of the known format; with a reference given, its SHA-256 must match it, or nothing is
     shown at all;
   - every file the manifest lists is there with its SHA-256 and size; a file nobody listed is reported;
   - every bundle passes the true-copy checks: its own canonical bytes, its manifest and part hashes, the audit chain
     from its genesis value (every link and every event hash), every row against its hash and against the audit trail,
     and nothing the audit trail names is missing;
   - every signature: its seal row is there, the seal payload is the one the seal was made over (payload SHA-256 of the
     audited seal row), the payload names this signature, record, meaning and signer, the manifestation shown is the
     one sealed (its canonical SHA-256 is in the payload), and the seal itself verifies: an Ed25519 seal with the public
     key from the export's seal key chain, in the browser. An HMAC seal needs the installation's secret, so the viewer
     says it cannot check it offline and shows the installation's own check made at export.
4. It shows a verdict: "All checks passed." only when every check passed **and** the export SHA-256 matches the one
   typed; "NOT ANCHORED: origin unverified." when the checks passed but no SHA-256 was given (files that agree with each
   other prove nothing on their own); "Verification failed: ..." otherwise, also when a file cannot be read. Then each
   record: its label, when it closed,
   its signatures with their manifestations (printed name, user ID, role, meaning, date and time with offset and zone)
   and the seal result, and the audit trail of each chain (sequence, time, action, table, row, who, reason), read from its
   file when it is opened and checked again against the manifest's SHA-256. **A record that fails a check is listed
   with its findings and is not shown.** Files are read one at a time (browser File handles), so a large export does not
   have to fit in memory.

## Pharma context

- **Data return at the end of a contract** (EU GMP Annex 11 section 3.1, [DI-08](../../../compliance/controls/DI-08.yaml)):
  the agreement with the supplier says the customer gets a full export with audit trails and signatures in readable
  form. A viewer that needs no part of the supplier's system makes that real.
- **Accurate and complete copies for inspection** (21 CFR 11.10(b)): an inspector can read the records and their audit
  trails, and see that they are intact, without the production system.
- **Readable for the whole retention period** (EU GMP Annex 11 section 17, [DI-44](../../../compliance/controls/DI-44.yaml)):
  the format is plain JSON and the viewer one HTML file; both can be kept with the archive.

## Main guards

> **Why this exists**
> - **Pharma reason:** a copy shown as a record must be proven to be the record before anyone reads it; a page that
>   shows first and warns later invites reading altered data as genuine.
> - **Control:** [DI-08](../../../compliance/controls/DI-08.yaml) clause 2.
> - **Code:** [`verifyExport`](../../../apps/record-viewer/src/verify/export.ts#sym=verifyExport) (every check, then
>   [`renderReport`](../../../apps/record-viewer/src/view.ts#sym=renderReport) shows only records that passed).
> - **Tests:** [verify-export.test.ts](../../../apps/record-viewer/test/verify-export.test.ts) and
>   [record-viewer.spec.ts](../../../tools/e2e/specs/records/record-viewer.spec.ts), tests named `[DI-08]`.

> **Why this exists**
> - **Pharma reason:** a viewer handed to auditors and to a customer after the contract must not be a way to change,
>   sign or move records.
> - **Control:** [DI-08](../../../compliance/controls/DI-08.yaml) (class core in the plan: the viewer cannot write).
> - **Code:** the page's content security policy ([build.ts](../../../apps/record-viewer/build.ts#sym=buildViewer):
>   no network, no form, no frame; only its own script and style by hash); the screens have no form, link or download,
>   and every text is set as text, never parsed as HTML; the dependency rules `record-viewer-standalone` and
>   `record-viewer-no-node-core` ([.dependency-cruiser.cjs](../../../.dependency-cruiser.cjs)) keep every server
>   package out of it.
> - **Tests:** the browser test checks no request leaves the page, no policy violation, and nothing that writes;
>   [boundaries.test.ts](../../../tools/boundaries/test/boundaries.test.ts) proves both rules fire.

## How to test it

- `pnpm vitest run --project db apps/record-viewer/test`: a real export of a test database (closed incidents and DI
  investigations, one signed with an Ed25519 seal and one with the test HMAC key) passes; each alteration (a byte of a
  file, a row re-hashed inside its bundle, a seal payload swapped, a missing or extra file, a manifest that is not the
  registered one) is found; and the viewer's bundle verifier gives the same verdicts as the kernel's on every bundle.
- The browser test (`specs/records/record-viewer.spec.ts`, run under the E2E lock) exports the E2E GMP database with
  its closed batch records, opens the built page from the file system, sees every record verified with its audit trail
  and signature manifestations, and a copy with one byte of a batch record changed shown as failed.

## Pitfalls

- The viewer has its **own** verifier: it may import no server package (the kernel needs a database driver and node
  modules). A change to the true-copy bundle format or to its checks in the kernel
  ([true-copy.ts](../../../packages/kernel/src/records/true-copy.ts)) is made in the viewer too; the cross-check test
  fails when the two disagree.
- An export only agrees with itself until it is compared with the export SHA-256 the installation registered, so the
  viewer never says "passed" without it. The full-export command prints the SHA-256 and the register
  (`records.full_export`) keeps it; hand it over separately from the files.
- HMAC seals are not checkable offline. For an export that must be fully checkable without the installation, seal with
  an Ed25519 key.
- The page needs a browser with Ed25519 in Web Crypto (current Chromium, Firefox and Safari); an older one says so
  instead of passing the seal.

## Related pages

- [kernel](kernel.md), section "The full export, the closed records and the periodic evaluation pack".
- [runbooks](../10-runbooks.md), "Full export and periodic evaluation".
