# OWASP ASVS 4.0.3 level 2: design review

- **Status:** Phase 1 exit deliverable (outline 4.7, 11). Design-level review of chapters V1-V14 by requirement group; Phase 7 verifies the implementation (penetration test and hardening verification).
- **How to read it:** one row per ASVS requirement group (identified by number and short name only; the requirement text is in the OWASP standard). *Status* is where the design stands today: **Implemented** (code and tests exist), **Designed** (decided in the outline, an ADR or this review; implemented in the named phase), **Partial** (some requirements of the group are covered, the rest are listed as gaps), **Gap** (not yet designed), **N/A** (the feature does not exist in the product). Every gap has an owner and a phase.
- **Owners:** *lead* (integration and review), *identity*, *e-signature*, *platform*, *records*, *market*, *continuity* (the Phase 1 kernel modules), *web* (API and screens, from Phase 2), *ops* (installation, customer IT, from Phase 7), *counsel* (Indian legal questions).
- **Related:** `threat-model.md`, `security-baseline.md`, outline 4.7, ADR 0006, 0007, 0012.

## Summary

| Chapter | Implemented | Designed | Partial | Gap | N/A |
|---|---|---|---|---|---|
| V1 Architecture | 1 | 5 | 6 | 0 | 0 |
| V2 Authentication | 0 | 8 | 0 | 0 | 2 |
| V3 Session management | 0 | 5 | 1 | 0 | 1 |
| V4 Access control | 0 | 2 | 1 | 0 | 0 |
| V5 Validation and encoding | 0 | 2 | 2 | 0 | 1 |
| V6 Stored cryptography | 1 | 0 | 3 | 0 | 0 |
| V7 Errors and logging | 0 | 3 | 1 | 0 | 0 |
| V8 Data protection | 0 | 2 | 1 | 0 | 0 |
| V9 Communication | 1 | 0 | 1 | 0 | 0 |
| V10 Malicious code | 0 | 0 | 2 | 1 | 0 |
| V11 Business logic | 0 | 0 | 1 | 0 | 0 |
| V12 Files and resources | 0 | 6 | 0 | 0 | 0 |
| V13 API and web service | 0 | 2 | 0 | 0 | 2 |
| V14 Configuration | 0 | 2 | 3 | 0 | 0 |

## V1 Architecture, design and threat modelling

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V1.1 Secure development lifecycle | Partial | Threat model and this review at Phase 1 exit; security requirements are controls in the register with traced tests; CI runs typecheck, lint, boundaries, pins, register and traceability; CODEOWNERS second review for kernel and compliance. | Security test per ASVS group as each component lands: lead, every phase. |
| V1.2 Authentication architecture | Designed | One authentication service in the kernel; separate database roles for application, authentication service, migrations, backup and replication, each with least privilege (ADR 0012, `ops/postgres/pg_hba.conf.template`). | identity, Phase 1 |
| V1.4 Access control architecture | Partial | Enforcement at trusted points only: server commands plus database privileges and SECURITY DEFINER transitions; deny by default; bypass tests per invariant. | API layer checks: web, Phase 2 |
| V1.5 Input and output architecture | Designed | Schema validation of every input at the API boundary (Zod); the server decides every rule; JSON only; output encoding by the UI framework. | web, Phase 2 |
| V1.6 Cryptographic architecture | Partial | SHA-256 audit chains; seals with a KMS/HSM key, key archive and algorithm agility (outline 4.7); backups AES-256-GCM with the key held in the key-management system and only its reference stored. | Key-management and rotation runbook: e-signature and ops, Phase 1 (seals) and Phase 7 |
| V1.7 Errors, logging and auditing architecture | Partial | Database-captured, hash-chained audit trail that cannot be switched off (ADR 0007); pgaudit to a write-once sink for administrators. | Application log format and sink: web and ops, Phase 2 and 7 |
| V1.8 Data protection and privacy architecture | Partial | Record-type register with classification (DI-01); confidential formula data behind a permission and row-level security; personal-data inventory under DPDP. | Personal-data inventory and notices: records and counsel, Phase 1-4 |
| V1.9 Communications architecture | Implemented | TLS on every path (browser, database, gateway, integrations), verified certificates, mTLS for gateway, backup, migration and replication; configuration validator and server-side session check. | - |
| V1.10 Malicious software architecture | Partial | Source control, reviewed pull requests, pinned lockfile and exact internal pins. | SBOM, dependency and container scanning, signed artefacts: lead and ops, Phase 7 |
| V1.11 Business logic architecture | Designed | Flows as state machines with a database transition table; invariants with database enforcement and bypass tests (outline 5.2, 5.3). | platform (state engine), Phase 1; editions, Phases 3-5 |
| V1.12 Secure file upload architecture | Designed | Attachments content-addressed in an object store outside the web root, never executed, served with a fixed content type. | web, Phase 2 |
| V1.14 Configuration architecture | Designed | Separate databases per edition and a physically separate sandbox (ADR 0001, DI-05); migrations only through the pipeline; configuration validated before start-up. | Deployment hardening: ops, Phase 7 |

## V2 Authentication

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V2.1 Password security | Designed | Local passwords hashed with argon2id; policy as data (length and history), no forced composition rules; passwords are one of two signing components. | Check new passwords against a breached-password list and allow long passphrases: identity, Phase 1 |
| V2.2 General authenticator security | Designed | Lockout after 5 failures (3-5), rate limiting, real-time misuse alerts; MFA for administration, break-glass, vendor and remote access. | identity, Phase 1 |
| V2.3 Authenticator lifecycle | Designed | Initial and reset secrets single-use and changed before the account can sign; badge issue, loss, revocation and replacement with identity re-verification. | identity, Phase 1 |
| V2.4 Credential storage | Designed | argon2id with tuned parameters; badge identifiers and PINs stored only as salted hashes; verifiers excluded from audit copies. | identity, Phase 1 |
| V2.5 Credential recovery | Designed | No self-service recovery for GMP accounts; an administrator reset needs identity re-verification and yields a single-use secret the administrator never sees. | identity, Phase 1 |
| V2.6 Look-up secret verifier | N/A | No recovery codes; revisit if the MFA method adds them. | - |
| V2.7 Out-of-band verifier | N/A | No SMS or e-mail one-time codes. | - |
| V2.8 One-time verifier | Designed | Time-based one-time codes or the identity provider's MFA for privileged and remote access. | identity, Phase 1 |
| V2.9 Cryptographic verifier | Designed | Devices authenticate with enrolled keys or mTLS certificates; non-clonable badges. | identity (device registry), Phase 1; gateway, Phase 6 |
| V2.10 Service authentication | Designed | Service and integration accounts with vault-held secrets, no defaults, never able to sign. | identity, Phase 1; integrations, Phase 6 |

## V3 Session management

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V3.1 Fundamental session security | Designed | Session identifiers only in cookies, never in URLs. | web, Phase 2 |
| V3.2 Session binding | Designed | New random session id at every sign-in; bound to account and device. | identity, Phase 1 |
| V3.3 Session termination | Designed | Idle and absolute timeouts (kiosk lock 5 min, 1-15); one active shop-floor session per person; logout and credential change end sessions. | identity, Phase 1 |
| V3.4 Cookie-based session management | Partial | Secure, HttpOnly and SameSite=Strict enforced by the configuration validator (`security-baseline.ts`, tested). | `__Host-` prefix and path scoping: web, Phase 2 |
| V3.5 Token-based session management | N/A | Browsers use cookies only; integration tokens are covered under V2.10 and V13. | - |
| V3.6 Federated re-authentication | Designed | OIDC step-up with forced login and zero maximum age; `auth_time`, nonce and assurance values checked at signing (outline 5.5). | identity and e-signature, Phase 1 |
| V3.7 Defences against session exploits | Designed | Every signature re-authenticates with the components the policy requires; a signer other than the session owner always gives all components. | e-signature, Phase 1 |

## V4 Access control

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V4.1 General access control design | Partial | Server-side checks against scoped grants; the database refuses what the role may not do, proven by bypass tests (for example `numbers.test.ts`, `batch-number-register.test.ts`, `audit-trail.test.ts`). | API checks: web, Phase 2 |
| V4.2 Operation-level access control | Designed | Object access checked per scope (site, area, product); row-level security for client-owned content; CSRF tokens and SameSite=Strict. | web, Phase 2 |
| V4.3 Other access control considerations | Designed | Administration console with MFA and separate roles; administrators never hold GMP roles (INV-11). | identity, Phase 1 |

## V5 Validation, sanitization and encoding

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V5.1 Input validation | Partial | Database check constraints and allow-lists (for example the batch-number format), stable error codes. | Schema validation of every API input: web, Phase 2 |
| V5.2 Sanitization and sandboxing | Designed | Calculations run in a closed, non-looping expression language with no access to the host (ADR 0005); no dynamic code evaluation. | expr, Phase 2 |
| V5.3 Output encoding and injection prevention | Partial | Parameterised SQL only; dynamic SQL in functions built with identifier and literal quoting; CSV exports neutralise spreadsheet formulas (batch-number register). | UI encoding and a lint rule against string-built SQL: web, Phase 2 |
| V5.4 Memory, string and unmanaged code | N/A | Managed runtime; no native code of our own. | - |
| V5.5 Deserialization prevention | Designed | JSON only, validated against schemas; no native object deserialization. | web, Phase 2 |

## V6 Stored cryptography

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V6.1 Data classification | Partial | Record-type register (DI-01); formula composition classified confidential; personal fields inventoried. | Personal-data inventory: records and counsel, Phase 1-4 |
| V6.2 Algorithms | Partial | SHA-256, AES-256-GCM, argon2id; seal algorithm agility with re-sealing before an algorithm weakens. | Seal algorithm choice and archive: e-signature, Phase 1 |
| V6.3 Random values | Implemented | Operating-system CSPRNG (`node:crypto`, `gen_random_uuid`) for ids, keys, nonces and challenges. | - |
| V6.4 Secret management | Partial | Secrets from a vault; backup keys referenced, never stored with the backup; seal keys in KMS/HSM; demo uses local files labelled demo-only. | Vault and KMS integration: ops, Phase 7 |

## V7 Error handling and logging

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V7.1 Log content | Designed | No secrets, verifiers or session ids in logs or audit copies. | identity, Phase 1; web, Phase 2 |
| V7.2 Log processing | Designed | Authentication and signing successes and failures, lockouts and access-control failures recorded and alerted. | identity, Phase 1 |
| V7.3 Log protection | Partial | Hash-chained audit trail with anchors outside the database; DDL log; trusted database time (INV-16). | pgaudit write-once sink: ops, Phase 7 |
| V7.4 Error handling | Designed | Stable error codes (`EBMR-<AREA>-<NNN>`); generic client messages; details only server-side. | web, Phase 2 |

## V8 Data protection

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V8.1 General data protection | Partial | Backups encrypted, hashed, write-once and access-separated (implemented); data minimisation in integrations. | No-store caching of GMP responses: web, Phase 2 |
| V8.2 Client-side data protection | Designed | No record data in browser storage; kiosks hardened (USB blocked, kiosk mode; attestation implemented). | web, Phase 2 |
| V8.3 Sensitive private data | Designed | Personal data only in request bodies; retention tied to the GMP rule; reading confidential formula data is logged (`security-baseline.md` c). | identity, records and counsel, Phase 1-4 |

## V9 Communication

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V9.1 Client communication security | Partial | HTTPS only, plain HTTP only redirects, TLS 1.2 or later, HSTS for one year: the configuration validator enforces it (tested). | The API server applies the validated TLS settings: web, Phase 2; cipher-suite list confirmed at IQ: ops, Phase 7 |
| V9.2 Server communication security | Implemented | Database connections with `sslmode=verify-full`, server-side check that the session is encrypted, `hostssl`-only `pg_hba`, integrations on encrypted transports, OPC UA SignAndEncrypt (tested). | - |

## V10 Malicious code

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V10.1 Code integrity | Partial | Type-checked and linted code, reviewed merges, no dynamic code loading. | Static analysis for security rules: lead, Phase 2 |
| V10.2 Malicious code search | Partial | Reviews by code owners; few, pinned dependencies. | Dependency review at each upgrade: lead, every phase |
| V10.3 Application integrity | Gap | - | Signed release artefacts, SBOM, verified updates: lead and ops, Phase 7 |

## V11 Business logic

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V11.1 Business logic security | Partial | Steps only in order through state machines and guards in the database; invariants with bypass tests; idempotency; anomaly and misuse alerts; numbers never reused, even after a restore (INV-27, tested). | Extended with each edition, Phases 3-5 |

## V12 Files and resources

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V12.1 File upload | Designed | Size and type limits per attachment kind; archives not expanded server-side. | web, Phase 2 |
| V12.2 File integrity | Designed | Content type checked by signature bytes; hash stored with the record. | web, Phase 2 |
| V12.3 File execution | Designed | Uploaded files are never executed or used as paths. | web, Phase 2 |
| V12.4 File storage | Designed | Object store outside the web root, content-addressed, encrypted. | web, Phase 2 |
| V12.5 File download | Designed | Served as attachments with a fixed content type. | web, Phase 2 |
| V12.6 SSRF protection | Designed | The server calls only integration endpoints from validated configuration; no user-supplied URLs are fetched. | integrations, Phase 6 |

## V13 API and web service

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V13.1 Generic web service security | Designed | One encoding (UTF-8 JSON), TLS, administration routes separated, authorization on every route. | web, Phase 2 |
| V13.2 RESTful web service | Designed | Method and content-type checks, schema validation, CSRF protection, idempotency keys on mutations. | web, Phase 2 |
| V13.3 SOAP web service | N/A | Not used; if an ERP adapter needs it, it is reviewed then. | integrations, Phase 6 if needed |
| V13.4 GraphQL | N/A | Not used. | - |

## V14 Configuration

| Group | Status | How the design meets it | Gap: owner, phase |
|---|---|---|---|
| V14.1 Build and deploy | Partial | CI on every change; migrations only through the pipeline with checksums. | Reproducible builds and hardened deployment: ops, Phase 7 |
| V14.2 Dependency | Partial | Lockfile, exact internal pins checked in CI (ADR 0015). | Vulnerability and licence scanning, SBOM: lead, Phase 7 |
| V14.3 Unintended security disclosure | Designed | No debug mode or version banners in production. | web and ops, Phase 2 and 7 |
| V14.4 HTTP security headers | Partial | HSTS required by the configuration validator. | Content security policy, frame-ancestors, nosniff, referrer policy: web, Phase 2 |
| V14.5 HTTP request header validation | Designed | Allowed methods only; origin checks; proxy headers trusted only from the configured reverse proxy. | web, Phase 2 |

## Decisions and gaps to confirm at the Phase 1 design review

1. Breached-password screening for local passwords (V2.1): identity, Phase 1.
2. Signed release artefacts and SBOM (V10.3, V14.2): lead and ops, Phase 7.
3. Personal-data inventory and DPDP notices (V1.8, V6.1, V8.3): records and counsel.
4. Key-management runbook for seal and backup keys (V1.6, V6.4): e-signature and ops.
