# Threat model (STRIDE per component)

- **Status:** Phase 1 exit deliverable (outline 4.7, 11). Reviewed with `asvs-l2-review.md`. Update it whenever a component, trust boundary or data flow changes.
- **Scope:** both editions and site services at one site (v1 topology, outline 4.2): browser clients, API server and workers, site gateway, PostgreSQL databases, site services, integrations, backups, administration console.
- **Method:** for each component, threats by STRIDE category (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege), each with its mitigation, the controls (DI/IN) and invariants (INV) it serves, and the evidence: an existing test (file under `packages/*/test/`) or the phase that will add it. "Identity module", "e-signature module", "platform module", "records module" and "market module" are the Phase 1 kernel modules built in parallel with this one; their tests land with them.

## Trust boundaries and assets

```
 [Shop-floor kiosk / office browser] --TLS--> [API server + workers] --TLS--> [Edition DB]   [Site-services DB]
          |                                        |      ^                         |                |
   badge reader, scanner                           |      +--TLS-- [Site gateway] --+-- OT network (scales, presses, SCADA)
                                                   +--TLS--> [Integrations: ERP, LIMS, QMS, LMS, CMMS, EMS]
 [Admin console] --TLS+MFA--> [API admin routes]      [Backup host] --write-only--> [Write-once store + external ledger]
```

Assets: GMP records and their audit trails; electronic signatures and authentication events; MBRs and formula composition (confidential); identities, credentials and badges; batch numbers and other never-reused identifiers; backups, anchors and the external ledger; keys (seal, backup encryption, TLS).

Assumptions: the database superuser and the storage root account are held by different teams; the site's time source is validated (outline 5.6); customer IT runs malware protection, patching and network segmentation (DI-13).

## 1. Browser (kiosks, panel PCs, cleanroom tablets, office PCs)

| ID | S T R I D E | Threat | Mitigation | Controls / invariants | Evidence |
|---|---|---|---|---|---|
| BR-1 | S | A person enters data in another person's open session on a shared kiosk. | Every GMP command from a SHARED or GRADE_A_B device carries a fresh authentication event of the person it is attributed to (badge tap within 60 s by default); kiosk lock after 5 min (1-15). | DI-14, DI-38, INV-40 | Identity module tests (Phase 1) |
| BR-2 | S | The browser reports a device id, class or room it does not have. | Device identity from an enrolled device key or mTLS certificate; the server derives class and room from the registry. | DI-20 | Identity module (Phase 1) |
| BR-3 | T | The client changes displayed values, limits, "step may start" decisions or the content being signed. | Server-authoritative execution (ADR 0006); the signing challenge rebuilds the canonical content and refuses a hash mismatch. | DI-34, DI-37, INV-09 | E-signature module tests (Phase 1) |
| BR-4 | T | Cross-site scripting or request forgery acts as the logged-in user. | Strict content security policy, output encoding, schema validation on every input, SameSite=Strict cookies plus CSRF tokens. | DI-13 | Phase 2 (first screens: header and CSRF tests) |
| BR-5 | R | A user denies having entered or corrected a value. | Audit event in the same transaction with person, account, role, session, device, authentication event, server time, reason. | DI-22, INV-07, INV-40 | `packages/kernel/test/audit/audit-trail.test.ts` |
| BR-6 | I | Formula or personal data remain on a shared device (cache, download, USB). | No-store caching for GMP responses, no record data in browser storage, USB mass storage blocked and kiosk mode enforced before enrolment. | DI-13 | `packages/kernel/test/continuity/hardening.test.ts`; headers in Phase 2 |
| BR-7 | I | An unsent entry stays on a terminal after the user changes. | Pending entry bound to the authenticating person and event; discarded on user change and listed for the incident record. | DI-28, DI-29 | Phase 3 |
| BR-8 | D | Double submissions or floods of commands. | Idempotency keys on every mutating request; rate limiting on authentication and signing. | DI-28 | Platform module (idempotency, Phase 1); rate limits Phase 2 |
| BR-9 | E | A user calls QA or administrator operations by crafting requests. | Authority checked on the server for every command against scoped grants; the database refuses status and signature writes outside SECURITY DEFINER functions. | DI-17, INV-06, INV-10 | Identity and e-signature module bypass tests (Phase 1) |

## 2. API server and workers

| ID | S T R I D E | Threat | Mitigation | Controls / invariants | Evidence |
|---|---|---|---|---|---|
| API-1 | S | A stolen session cookie is replayed. | Server-side sessions bound to account and device; Secure, HttpOnly, SameSite=Strict; idle and absolute timeouts; signing always re-authenticates. | DI-19, DI-38 | Identity module (Phase 1) |
| API-2 | S | Password guessing or credential stuffing. | Lockout after 5 failures (3-5), rate limiting, real-time misuse alerts with acknowledgement. | DI-19 | Identity module (Phase 1) |
| API-3 | S | An authentication event is replayed to sign twice. | Single-use authentication events bound to person, device and challenge; challenge valid 120 s. | DI-38, INV-10 | E-signature module (Phase 1) |
| API-4 | T | A bug or a compromised process writes GMP data around the rules. | The application role has no UPDATE on status, signature, audit or data rows; transitions and signatures only through SECURITY DEFINER functions. | DI-23, INV-06, INV-10 | `audit-trail.test.ts`; bypass tests in every module |
| API-5 | T | SQL injection. | Parameterised queries only; least-privilege database role; database checks behind every rule. | DI-13 | Code review; Phase 2 lint rule against string-built SQL |
| API-6 | T | Time manipulation makes a late entry look timely. | `recorded_at` always from the database clock; claimed times stored separately with a trust level. | DI-27, INV-16 | `audit-trail.test.ts` (INV-16); platform module |
| API-7 | R | A job or integration acts without attribution. | Actor context required for every GMP write; SYSTEM and INTEGRATION sources need service accounts. | DI-22, INV-07 | `audit-trail.test.ts` (write without actor refused) |
| API-8 | I | Plain-text transport or TLS downgrade. | Configuration validator refuses non-TLS URLs, plain-HTTP serving, weak cookies; run-time check that the database session is encrypted; HSTS. | DI-13 | `packages/kernel/test/continuity/security-baseline.test.ts` |
| API-9 | I | Error responses reveal internals. | Stable error codes; no stack traces or SQL in responses; details only in the server log. | DI-13 | Phase 2 |
| API-10 | D | Large reports or exports exhaust resources. | Pagination and limits; long exports as background jobs; load tests. | - | Phase 4 and 7 (load tests) |
| API-11 | E | Administrator routes reachable with a GMP session. | Separate administration console and roles; MFA; no person holds an administrator and a GMP role. | DI-18, INV-11 | Identity module (Phase 1) |

## 3. Site gateway (automation boundary)

| ID | S T R I D E | Threat | Mitigation | Controls / invariants | Evidence |
|---|---|---|---|---|---|
| GW-1 | S | A fake instrument or gateway sends readings. | Enrolled device identities; gateway authenticates to the server with mTLS; device ids stamped from enrolled identity. | DI-20, DI-32 | Phase 2 (gateway core), Phase 6 |
| GW-2 | T | Buffered readings are changed before upload. | Buffered entries hashed and sequence-numbered by the gateway; the server checks gaps and hashes; raw string kept. | DI-31, DI-32 | Phase 2 and 6 (fault injection) |
| GW-3 | T | Equipment runs a recipe or setpoint different from the MBR. | Setpoints read back before start; recipe version checked. | DI-34 | Phase 3 |
| GW-4 | R | A reading is disputed. | Raw instrument string, device id, stability flag, calibration status and source time stored with the value. | DI-32 | Phase 2 and 3 |
| GW-5 | I | The OT network is exposed to the IT network. | The gateway is the only bridge; OPC UA with SignAndEncrypt only; segmentation checked at IQ. | DI-13 | `security-baseline.test.ts` (endpoint rules); IQ |
| GW-6 | D | Feed gap or gateway failure. | Buffering with source timestamps; feed-gap alarm; paper fallback. | DI-43, DI-49 | Phase 2 and 6 |
| GW-7 | E | A compromised gateway writes arbitrary GMP data. | Inbound data enter only as domain commands through the same guards, under an integration identity that can never sign. | DI-14, DI-31 | Identity module (no sign permission for integration accounts); Phase 6 |

## 4. Databases (edition and site services)

| ID | S T R I D E | Threat | Mitigation | Controls / invariants | Evidence |
|---|---|---|---|---|---|
| DB-1 | S | The application credentials are used from another host. | `hostssl` rules from the application subnet only, SCRAM or certificates, credentials in a vault; TLS session check. | DI-13 | `security-baseline.test.ts` (pg_hba template); IQ |
| DB-2 | T | The application role alters or deletes audit, signature or data rows. | No UPDATE/DELETE privileges; insert-only triggers that stop even the owner. | DI-23, INV-06 | `audit-trail.test.ts` |
| DB-3 | T | A superuser rewrites rows and recomputes hashes. | Per-aggregate hash chains, external anchors outside the database, pgaudit to a write-once sink. | DI-23, INV-08 | `audit-trail.test.ts` (rewrite caught by anchor); `packages/kernel/test/continuity/restore.test.ts` (tampering never covered by a restore event) |
| DB-4 | T | A superuser disables an audit trigger. | DDL event log; start-up and hourly trigger check refuses GMP writes. | DI-23 | `audit-trail.test.ts` |
| DB-5 | T | A restore silently discards history. | Incarnation guard; restore event recorded by the operator, approved by a second named person; external anchors covered only for the discarded anchors and affected chains. | DI-45, INV-08 | `restore.test.ts` |
| DB-6 | T | A number (batch, form, signature, audit or anchor id) is issued twice after a restore, confusing two records. | Protected counters with write-ahead ceilings in the external ledger; restore completion moves every protected source past the ledger; allocation refuses a counter that was moved back. | INV-27, IN-18 | `numbers.test.ts`, `restore.test.ts`, `packages/site-services/test/batch-number-register.test.ts` |
| DB-7 | R | An administrator denies a DDL or break-glass action. | DDL event log; pgaudit; break-glass two-person, time-boxed. | DI-18, DI-23 | `audit-trail.test.ts` (DDL log); Phase 7 (pgaudit sink) |
| DB-8 | I | Disks or backups are stolen. | Volume encryption; backups encrypted with AES-256-GCM before leaving the host. | DI-13 | `backup-drill.test.ts` (encrypted artefact); IQ |
| DB-9 | I | One client's formula is read by another client's user. | Row-level security per tenant for client-owned content. | DI-13 | Phase 2 |
| DB-10 | D | Loss of a database node. | Synchronous quorum standby; failover runbook. | DI-45 | `docs/operations/ha-and-restore.md`; IQ/OQ |
| DB-11 | D | Corruption replicated to standbys. | Backups separate from replicas; retention-grade tier; drills. | DI-45 | `backup-drill.test.ts` |
| DB-12 | E | A SECURITY DEFINER function is abused (public execute, unexpected caller). | EXECUTE revoked from PUBLIC and granted by name; NOLOGIN owner; every function validates its inputs and the actor context. | DI-17 | Migration review; bypass tests per module |
| DB-13 | E, T | Object shadowing: when `pg_temp` is not listed in a function's `search_path`, PostgreSQL searches the session's temporary schema **first** for tables, so an application session could create a temporary table named like a catalog or module table (`pg_class`, `pg_sequences`, `counter`) and make a SECURITY DEFINER function read attacker data and skip its checks. | Every SECURITY DEFINER function sets `search_path = pg_catalog, <own schema>[, kernel], pg_temp` with `pg_temp` explicitly last; catalog tables and module tables are schema-qualified inside functions; TEMP is revoked from PUBLIC on every GMP database (bootstrap), so the application role cannot create temporary objects at all. | DI-17, DI-23 | `packages/kernel/test/continuity/numbers.test.ts` (shadowing temp tables do not change results; every continuity and site definer function ends its path with `pg_temp`); repo-wide check (lead) |

## 5. Site services

| ID | S T R I D E | Threat | Mitigation | Controls / invariants | Evidence |
|---|---|---|---|---|---|
| SS-1 | S | One edition acts as the other to use a reservation. | Per-edition service identities; reservations bound to edition and batch. | IN-24, INV-13 | Phase 3 |
| SS-2 | T | A batch number is reused across editions, after a void, a rework or a restore. | Site-wide unique, insert-only register; protected counter; voids keep the number; recovery only inside a restore's skipped range with evidence. | IN-18, INV-27 | `batch-number-register.test.ts` |
| SS-3 | T | A lot status changes without trace. | Audited transitions through SECURITY DEFINER functions. | IN-24, INV-13 | Phase 3 |
| SS-4 | R | An allocation is disputed. | Allocation written immediately with actor, date, product and batch size on one audit chain per site. | IN-18 | `batch-number-register.test.ts` |
| SS-5 | I | Personal or qualification data exposed to an edition that does not need it. | Least-privilege views per edition; personal-data inventory (DPDP). | DI-13 | Identity module; Phase 6 |
| SS-6 | D | Site services down blocks both editions. | Same HA as the strictest edition; freshness-bounded mirrors fail closed for qualifications and lot status. | INV-38 | Phase 3 and 6 |
| SS-7 | E | A stale mirror lets an unqualified person act. | Freshness bound per data class; fail closed. | INV-26, INV-38 | Identity module (INV-26); Phase 6 |

## 6. Integrations (ERP/WMS, LIMS, QMS, LMS, CMMS, EMS/BMS, printers, serialisation)

| ID | S T R I D E | Threat | Mitigation | Controls / invariants | Evidence |
|---|---|---|---|---|---|
| INT-1 | S | A forged message from a fake external system. | Mutual TLS or signed tokens per adapter; one integration account per system. | DI-31 | Phase 6 (contract tests) |
| INT-2 | T | A message altered or replayed. | TLS; idempotency keys; version tokens for QMS and LIMS status at release. | DI-31 | Platform module (idempotency); Phase 4 and 6 |
| INT-3 | R | An external system denies sending a result. | Inbound data recorded as domain commands with the integration identity and audit trail. | DI-22, DI-31 | Phase 6 |
| INT-4 | I | Confidential data sent out unnecessarily. | Outbox messages with explicit schemas carrying the minimum data. | DI-13 | Phase 6 |
| INT-5 | D | A feed stops. | Heartbeats; stale mirrors fail closed at release; feed-gap alarms. | INV-38, DI-49 | Phase 6 (fault injection) |
| INT-6 | E | An integration identity signs or approves. | Service and integration accounts can never hold signing permissions. | DI-14 | Identity module (Phase 1) |

## 7. Backups and the external ledger

| ID | S T R I D E | Threat | Mitigation | Controls / invariants | Evidence |
|---|---|---|---|---|---|
| BK-1 | S | A restored copy is used as a second production. | Drill copies are closed to the application role and dropped; a restored database refuses to issue numbers until the restore procedure has run. | DI-45, INV-27 | `backup-drill.test.ts`, `restore.test.ts` |
| BK-2 | T | A backup or ledger entry is altered. | Artefact and dump hashes with manifest; fixity check; GCM authentication tag; hash-chained ledger lines. | DI-45 | `backup-drill.test.ts`; ledger integrity in `ledger.ts` |
| BK-3 | T | A backup is deleted by a production administrator or ransomware. | Write-once store in compliance mode under a separate account; insert-only backup catalogue. | DI-45 | `backup-drill.test.ts` (catalogue); IQ/OQ (storage) |
| BK-4 | R | Nobody can show that backups ran or what a restore discarded. | Every job run, backup, drill and restore event recorded, audited and alarmed; restore events copied to the external ledger. | DI-45, INV-08 | `backup-drill.test.ts`, `restore.test.ts` |
| BK-5 | I | Backup content exposed. | Encryption before leaving the host; key in KMS; only its reference stored. | DI-13 | `backup-drill.test.ts` |
| BK-6 | D | Backup jobs fail silently. | Failure recorded, alarm raised, non-zero exit, periodic drills. | DI-45 | `backup-drill.test.ts` |
| BK-7 | E | A restore is used to erase an unwelcome record. | A restore needs an approved event that names the discarded history; a lost-window incident follows; anchors outside the database still show what existed. | DI-45, INV-08 | `restore.test.ts` |

## 8. Administration console

| ID | S T R I D E | Threat | Mitigation | Controls / invariants | Evidence |
|---|---|---|---|---|---|
| ADM-1 | S | Administrator account takeover. | MFA; separate administrator accounts; access only from the management network. | DI-13, DI-18 | Identity module (Phase 1) |
| ADM-2 | T | An administrator changes GMP content or their own grants. | Administrator and GMP roles never held by one person; an administrator account never acts on its owner's GMP account. | DI-18, INV-11 | Identity module (Phase 1) |
| ADM-3 | T | Configuration or rule tables changed without control. | Versioned, audited, approved configuration and policy changes; no loosening applies to batches issued before it. | DI-09, INV-47 | Market module (Phase 1) |
| ADM-4 | R | Administrator actions not attributable. | Audit trail for configuration; pgaudit to a sink administrators cannot write; break-glass logging. | DI-18 | Phase 1 and 7 |
| ADM-5 | I | Administrators see initial or reset secrets. | Single-use secrets changed before signing; never shown to administrators. | DI-15 | Identity module (Phase 1) |
| ADM-6 | D | An administrator stops backups, anchoring or verification. | Job monitoring with alarms (backup failure, missing drill, stale anchor). | DI-45, DI-23 | `backup-drill.test.ts` (failure alarm); stale-anchor alarm: lead, Phase 1 integration |
| ADM-7 | E | Vendor support escalates privileges. | Time-boxed, customer-approved, session-recorded access with MFA and no GMP rights. | DI-13 | Identity module; Phase 7 |

## 9. Cross-cutting

| ID | Threat | Mitigation | Evidence |
|---|---|---|---|
| X-1 | Malicious or vulnerable dependency (supply chain). | Pinned lockfile, few dependencies, SBOM, vulnerability and licence scans, signed artefacts (risk 11). | Phase 0 (lockfile, pins check); scans Phase 7 |
| X-2 | Key compromise (seal, backup, TLS). | KMS/HSM, rotation with a public-key archive, algorithm agility; backup keys referenced, never stored with backups. | E-signature module; Phase 7 |
| X-3 | Incident not reported in time (India: 6-hour CERT-In reporting as read from secondary sources). | Incident workflow with a CERT-In step and deadline. | Records module (DI-12, Phase 1) |

## Open items for the owner

1. Accept the RPO/RTO proposals (`docs/operations/ha-and-restore.md` section 3).
2. Choose the write-once storage product per deployment option (on-premise appliance or private-cloud object lock).
3. Confirm the separation of duties between database administrators and storage administrators at each customer.
