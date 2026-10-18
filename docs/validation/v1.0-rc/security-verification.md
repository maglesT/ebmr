# Security verification (v1.0-rc)

Slice 7d of Phase 7. The checklist is [docs/security/pentest-checklist.md](../../security/pentest-checklist.md): every
item AUTOMATED (its test), INTERNAL (this record) or EXTERNAL (a penetration tester at deployment). This record holds
what was checked by hand, the results of the automated sweeps and scans when they were run here, and the findings with
their rating (D-P6j-c-1: critical or high only when reproduced on a migrated database and it lets a person or a system
change, sign or release GMP data against a control).

Commit: the slice 7d branch (`phase-7/slice-7d`) on main e49c332 (7-0 and 7a merged). Host: the cloud container
(4 CPUs), PostgreSQL 16.15. The pod's run at the exit (7f) repeats the automated part.

## 1. Automated sweeps and scans, as run here

| What | Result |
|---|---|
| Route-by-role matrix (`route-matrix.test.ts`) | 330 GMP routes x 30 roles and 33 sandbox routes x 8 roles; every SESSION route answers 401 without a session (328 of the 341 GMP and 37 of the 41 sandbox SESSION routes reached with schema-valid input; the rest stop at validation, 400); no 5xx and no 401 in a live session; no GMP write succeeds for the system administrator or the read-only auditor; every role is refused somewhere; the result equals the reviewed matrix (`fixtures/route-role-matrix.json`) |
| Fuzzing (`route-fuzz.test.ts`) | every route of both installations, 6 malformed and 3 schema-valid requests each (seed 20261018): no 500, no stack trace, path or database text in any answer, after the P7D-1 fix (2 routes answered 500 before it) |
| Headers and CSP (`session-and-headers.test.ts`) | the exact CSP, nosniff, frame denial, COOP, CORP and no-referrer on every one of the SPA's pages and every GET route of both an http and an https installation; HSTS one year on https; no-store on every API answer |
| Cookies, fixation, timeouts, rate limits | `__Host-` names with Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain on https; a planted cookie stays nobody's and sign-in sets a new one; the absolute timeout ends an office session (401), the idle timeout locks a kiosk session (423); sign-in 429 at the 11th attempt a minute, signing 429 at the 21st |
| TLS (`tls.test.ts`) | the adapters negotiate TLS 1.2 or 1.3, refuse a system offering only TLS 1.1, refuse plain http with TLS material, and trust only the pinned CA |
| Production start (`production-baseline.test.ts`) | database URLs without verified TLS refused; a start on unencrypted database sessions refused (EBMR-SEC-015), after the P7D-6 fix |
| Dependency audit | `pnpm audit --prod --audit-level=high`: no known vulnerability in a production dependency. All dependencies: 1 high (source-map-js, under vite's postcss: the web build) and 4 moderate (qs under Stryker, csv-parse under @lhncbc/ucum-lhc: the expression language's unit generator, a development dependency), none shipped |
| Licence scan | 911 packages: 904 permissive, 5 file-level copyleft or data licences in development tools only (MPL-2.0: axe-core and its Playwright binding, lightningcss; CC-BY-4.0: caniuse-lite), 2 reviewed (humanize 0.0.9 and precond 0.2.3, node-opcua dependencies without a licence field: MIT by their licence text and README), none denied |
| Secret scan | every tracked file: 41 hits, all allowlisted with their reason (the development cluster's documented credentials in tests and docs; the test vectors of the gateway feed signature, a key made for the test only); none open |
| SBOM and manifest | CycloneDX 1.5 with 974 components (purl, licence, SHA-512 integrity, scope), the release manifest (commit, schema release, the SBOM's and lockfile's SHA-256) signed with Ed25519; verified; one changed byte fails the verification. Here the key is DEMO-ONLY, made for the run; at deployment the release key is a KMS key (`EBMR_RELEASE_SIGNING_KEY` in CI) |
| Hardening check (`pnpm security:hardening`) | rules proven pass and fail (`tools/security/test`). Run on the drill database of this container (a development cluster), it fails, as it should: no connection logging, no pgaudit, no WAL archiving, `host` rules without TLS, a development superuser login, the demo marker, the DEMO-ONLY seal key and the demo persons, and two tool ports open off loopback. It is the IQ's check on the customer's installation |

## 2. Checked by hand (INTERNAL items)

| Item | What was checked | Result |
|---|---|---|
| 1.1 threat model | the rows of the 7a changes: the gateway's signed OPC UA feed (GW-1, GW-2) and the adapters' mutual TLS (integrations): mitigations built and tested | current; P7D-3 adds the anchor job gap to threat model section 7 for the lead |
| 5.4 SQL injection | every `query(` call of `apps/tablets-server/src` and `packages/*/src` takes `$n` parameters; dynamic identifiers come from catalog names through `format('%I')` or `quoteIdent` in tools | no string-built value found |
| 5.5 XSS | `dangerouslySetInnerHTML` in `apps/tablets-web/src` and `packages/ui-kit/src` | none |
| 8.2 browser storage | `localStorage` and `sessionStorage` in the web app | only the sign-out mark (a random token, no record data) and the page's person binding (a person id per tab) |
| 3.7 inactivity warning | the session controller and the lock overlay | no warning before the idle lock (A11Y-1): fixed in this slice (tablets 1460 and the web app's IdleWarning), now AUTOMATED |
| 9.5 plain-HTTP listener | `EBMR_HOST` default 127.0.0.1; the hardening check's SRV-LISTEN | loopback by default; a non-loopback listener is the hardening check's failure |
| 14.4 anchors and scheduled verification | the server's features and sweeper | no job exports external anchors or runs the scheduled chain verification: P7D-3 |

## 3. Findings

| ID | Finding | Rating (D-P6j-c-1) | State |
|---|---|---|---|
| P7D-1 | The register extract (`controlled.runRegister`) and the PQR extract (`pqr.run`) took any `NNNN-NN-NN` text as a date; one that is no calendar day (9177-00-56, 2026-02-30) reached the database's date cast and was answered 500 instead of the 400 a malformed request gets. Nothing was written (the command rolled back), no internals were shown | low | fixed: the contract's `CalendarDate` (a real day of the calendar) in both namespaces; `route-fuzz.test.ts` "[DI-13] a date that is no calendar day ... (P7D-1)" failed before |
| P7D-2 | A refusal for want of a right in the database (EBMR-IAM-040, -041, -042, EBMR-PLAT-006) is answered 422 NOT_ALLOWED, not 403. The refusal is effective; only the status differs from ASVS's expectation | low | residual for the owner: changing the status moves the golden outputs and how the screens treat a refusal. The route matrix reads the code (cell F) |
| P7D-3 | No job of the Tablets server exports external audit anchors (`continuity.exportAnchor`) or runs the scheduled chain verification with its alarm (`continuity.runIntegrityVerification`). DI-23 names both; a restore is still detected by the incarnation guard, and the restore drill exports an anchor itself (`--export-anchor`) | medium | residual: a sweeper job for both, with the installation's external ledger (a hardening item for 7b-1 or 7f) |
| P7D-4 | Two planners at once take the same oldest open ERP order: the later is refused EBMR-EXE-605 ("cannot be planned"), not marked retryable; planning again succeeds against the next order | low | residual (the load driver plans the history one at a time) |
| P7D-5 | The kernel's `recordRestoreEvent` reads back the event it recorded through the pool it is given; on a Tablets installation the application role selects no restore event (tablets 0450, F34.2), so the restore procedure must call it with the owner's connection, and no product tool records a restore event on a Tablets installation | medium | residual: the drill tool records it through the owner's connection (`tools/drills/src/restore-event.ts`); the procedure of ha-and-restore.md 5.2 needs the same tool for a real restore |
| P7D-6 | The production start did not apply the kernel's security baseline to its database connections: a URL without sslmode or with sslmode=disable was accepted, and the database's view of the session's encryption was never asked, although security-baseline.md says so | medium | fixed (cheap, removes a misleading statement: D-P7-6): production refuses such URLs and refuses to open on unencrypted sessions; `production-baseline.test.ts` (both tests failed before) |
| A11Y-1 | No warning before the inactivity lock (WCAG 2.2.1, outline 7.4); the session view did not say when the lock would fall | not a security rating (accessibility; the lock itself worked) | fixed: tablets 1460 (`tab.resolve_session` answers the seconds until the lock and the end), the session view's `idleLockInSeconds` and `endsInSeconds`, and the warning with keep-alive (badge tap on a kiosk); see the accessibility audit |

No critical or high finding.

## 4. Left to the penetration tester (EXTERNAL)

The items marked EXTERNAL in the checklist, and its last section: the network scan from the site LAN and the OT network,
the reverse proxy's TLS, an authenticated scan per role with the route matrix as the expected answer, session handling
in a real browser, injection and file upload, the administration path's MFA (2.8), the KMS, the write-once backup store
and the external ledger.
