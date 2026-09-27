# Security baseline (DI-13)

- **Control:** DI-13 (security baseline, confidentiality, non-repudiation evidence). Sources, paraphrased: Part 11 expects controls that keep electronic records authentic, intact and, where appropriate, confidential, and that make it hard for a signer to repudiate a signature (11.10 introduction, 11.30); 211.68(b) expects backups to be secure from alteration, erasure and loss; Annex 11 expects physical and electronic protection of data (7.1) and security measures against unauthorised access (12.1-12.2); the draft Annex 11 adds encryption, multi-factor authentication for remote access and periodic penetration testing.
- **Related:** `threat-model.md`, `asvs-l2-review.md`, `../operations/ha-and-restore.md`; outline 4.7; ADR 0012.

| Part | What | Phase 1 status |
|---|---|---|
| a | TLS on every client and interface connection; encryption at rest | Enforced by configuration validation, a run-time session check and server templates; tested |
| b | Hardened shop-floor clients (kiosk mode, removable storage disabled) | Attestation data and enrolment guard; tested; wiring into device enrolment by the lead |
| c | Confidential data (formula composition, personal data) restricted by role and site | Design below; enforced when MBR composition exists (Phase 2) |
| d | Non-repudiation evidence package per signature | Content defined below; produced by the e-signature module; test added by the lead |
| e | MFA for remote and privileged access; platform hygiene; penetration testing | Identity module (MFA), customer IT (hygiene, IQ checks), Phase 7 (penetration test) |
| f | RPO and RTO documented per module | `../operations/ha-and-restore.md` section 3 (proposals for the owner) |

## a. TLS and encryption

**In transit.** No GMP data travels in plain text.

- `packages/kernel/src/continuity/security-baseline.ts` checks the installation configuration before the server opens for GMP work (`assertProductionConfig`); in production and validation any finding below is an error that stops start-up, in development it is a warning:
  - database URLs (edition and site services) need `sslmode=verify-full` (`verify-ca` and `require` are accepted with a warning, because they do not fully authenticate the server); `ssl=false`, `disable`, `allow`, `prefer` or no `sslmode` are refused; a Unix-socket URL must be allowed explicitly for a single-host installation;
  - the public URL must be `https`; a plain-HTTP listener may only redirect; TLS 1.2 or later; HSTS for at least one year; session cookies Secure, HttpOnly, SameSite=Strict;
  - integration endpoints must use encrypted transports (`https`, `wss`, `mqtts`, `amqps`, `sftp`, `ldaps`, OPC UA with `SignAndEncrypt`).
- At run time `assertEncryptedDatabaseSession` asks the database server itself (`pg_stat_ssl`) whether the session is encrypted with TLS 1.2 or later; a plain-text session is refused. The application calls it for every new pooled connection in production and validation.
- `ops/postgres/pg_hba.conf.template`: network access only through `hostssl` rules with SCRAM-SHA-256 or client certificates (`cert`, `clientcert=verify-full` for the migration, backup and replication roles); non-TLS connections rejected explicitly; no `trust`, `password`, `md5` or `ident`; the only non-network rule is the peer-authenticated break-glass superuser on the host. `ops/postgres/postgresql.tls.conf.template`: `ssl = on`, `ssl_min_protocol_version = TLSv1.2`, `password_encryption = scram-sha-256`, pgaudit and connection logging.
- Tests (`packages/kernel/test/continuity/security-baseline.test.ts`): non-TLS URLs and plain-HTTP server settings refused; a plain-text database session refused by the server-side check; a client that requires verification never falls back to plain text; both templates pass the checker, and typical weak rules fail it.
- **IQ on customer infrastructure:** from a host in the application subnet, a non-TLS connection to the database is rejected by `pg_hba`; an HTTP request to the application is redirected or refused; the TLS versions and cipher suites offered are recorded.

**At rest.**

| Data | Protection | Status |
|---|---|---|
| Database files, WAL, temporary files | Volume encryption (LUKS/dm-crypt on premise, provider disk encryption with customer-managed keys in a private cloud) | Installation requirement; IQ check |
| Backups | AES-256-GCM per artefact before it leaves the database host; key in the key-management system, only its reference stored in the backup catalogue | Implemented (`backup-drill.ts`), tested |
| Archive packages (true copies) | Encrypted object store plus the package's own hashes | Phase 4 |
| Attachments | Content-addressed, encrypted object store | Phase 2 |
| Secrets | On-premise vault with rotation; seal keys in KMS/HSM | Outline 4.7; identity and e-signature modules |

## b. Hardened shop-floor clients

Devices of class SHARED (kiosks, panel PCs) and GRADE_A_B (cleanroom terminals) are enrolled only while a passing **hardening attestation** is in force (`packages/kernel/sql/0620_continuity_device_hardening.sql`):

- The attestation states, each as true or false: USB mass storage blocked; kiosk mode enforced (single application, no desktop, no browser address bar); malware protection active; operating system patched within the patch SLA. It records the method (device-management compliance report or documented manual inspection), the evidence reference and hash, the operating-system build, who attested, and when.
- A device passes only if every check holds (kiosk mode is not required for PERSONAL or SERVER devices). A failing attestation is recorded too: the finding stays on record and blocks enrolment.
- Attestations expire (re-attestation interval 30-365 days, default 180), can be revoked with a reason, and the most recent one decides, so a later failing inspection overrides an earlier pass.
- `continuity.assert_device_hardened(device, class)` is the enrolment guard; the identity module's device enrolment will call it (wiring by the lead). Attestations are written only through `continuity.record_hardening_attestation`, audited on the device's chain (`device:<id>`).
- Typical means: Windows kiosks with assigned access and the removable-storage deny policies (Group Policy or Intune device restrictions); Linux kiosks with USBGuard or udev rules and a locked-down session; ChromeOS managed kiosk mode. The device-management platform's compliance export is the preferred evidence.
- Tests (`hardening.test.ts`): no attestation, USB storage enabled, missing kiosk mode, malware protection or patches, expiry, revocation and a later failing inspection all block enrolment.
- **OQ on customer devices:** insert a USB mass-storage device into an enrolled kiosk: not mounted; try to leave kiosk mode: impossible without the administrator procedure.

## c. Confidentiality of formulas and personal data (design; no code in Phase 1)

- **Permissions, not screens.** The identity module owns roles and permissions. Formula composition (BOM quantities, overages, potency adjustments, process parameters marked confidential) is readable only with an explicit permission (proposed key `mbr.composition.read`), granted per site and product scope. The API never sends the composition to a client without it; the browser does not filter. Operators executing a batch see only the quantities of the step they perform.
- **Contract manufacturing.** Client-owned content (MBRs, formulas, batch data) is protected by row-level security per tenant (ADR 0012 decision 5, outline 4.4): a person of one client tenant cannot read another client's formula even through a bug in the API.
- **Reading confidential data is logged.** Opening a composition writes an access entry (who, which MBR version, when), so a leak can be investigated.
- **Exports** (true copies, evidence packages, PQR extracts) inherit the permission check and state their confidentiality class.
- **Personal data** (DPDP Act 2023, outline 4.7; to be confirmed by counsel): an inventory of personal fields, notice, and retention tied to the GMP rule that requires it; biometric data only as templates on the device or reader; eSign only as provider transaction references.
- **Test** (DI-13 catalogue line, Phase 2 when MBR composition exists): a user without the composition permission cannot open the composition through the API, and the attempt is logged.

## d. Non-repudiation evidence package (content for the Phase 1 exit)

For any signature, the e-signature module produces one package (`esig.evidence_package(signature_id)`, JSON plus the hash of every part) that lets an inspector see who signed what, when, how the signer was authenticated, and that nothing changed since. It contains:

1. **Signature row:** signature id, person, account, legal-name snapshot, role, meaning, delegation (if any), server time with site time zone and offset, record reference and version, content hash, authentication event id, qualification and authority evaluation snapshot, status (valid, or superseded by change), and seal.
2. **Manifestation** exactly as displayed and printed (legal name, user id, role, meaning, date and time with zone).
3. **Signed content:** the canonical content the hash was computed over (or a reference to it and its hash).
4. **Authentication event:** components used (for example badge and PIN, or user id and password; never the secrets), device id and class, time, and binding to the signature challenge; for identity-provider step-up, the `auth_time`, nonce and assurance values checked.
5. **Identity verification record** of the person (who verified the identity, how, when; DI-15) and the account's first-use acknowledgement.
6. **Audit chain segment** of the signed aggregate from its last checkpoint to the signature, with the verification result, and the external anchor that includes it (or the statement that the next anchor is pending).
7. **Seal verification:** key id, algorithm, the public key from the key archive, and the result.

Phase 1 exit: the lead adds the `[DI-13]` test that produces the package for a sampled signature and verifies every part once the e-signature module is merged.

## e. Remote and privileged access, platform hygiene, penetration testing

- MFA for the administration console, break-glass and vendor support, and all remote access (identity module); vendor access time-boxed, approved by the customer, session-recorded, without GMP rights.
- Customer IT (checked at IQ and periodically): malware protection and patch SLAs on servers and clients; segmentation between the OT line network and the IT network (the site gateway is the only bridge, outline 4.6); unsupported platforms isolated.
- Penetration testing: before go-live and at least annually for internet-exposed or private-cloud deployments (DI-13 design-choice default), by an external party (Phase 7 and customer).
