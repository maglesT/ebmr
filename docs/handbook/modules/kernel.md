# Kernel (`packages/kernel`)

**Draft** (14 October 2026). This page is still being written; the guard catalogue at the end is complete for the
kernel migrations up to 1174.

The kernel is the part of the system that every edition shares and that holds the data-integrity rules a regulator
checks first: who a person is and what they may do, the audit trail, electronic signatures, trusted time, the
market rules (India always, plus the US and the EU), the record register, retention and disposal, true copies and
evidence exports, the state-machine engine, numbers that are never reused after a restore, and the sandbox that keeps
test data away from real data. Almost all of it is PostgreSQL: tables that only the database owner can write, and
SECURITY DEFINER functions and triggers that refuse anything the rules do not allow, whoever calls them. The
TypeScript in `src/` wraps those functions, adds what must happen outside the database (sealing signatures, the
external ledger, PDF rendering) and offers pure versions of some rules for previews. Read this page if you change
anything in `packages/kernel`, or if an `EBMR-AUDIT`, `EBMR-IAM`, `EBMR-ESIG`, `EBMR-MKT`, `EBMR-REC`, `EBMR-PLAT`,
`EBMR-CONT` or `EBMR-SBX` error stops you. If "audit trail", "e-signature" or "QP" are new words, read the
[pharma primer](../01-pharma-primer.md) and the [glossary](../02-glossary.md) first.

## Where the code is

| What | Where |
|---|---|
| Migrations (85 files, run in number order) | [packages/kernel/sql/](../../../packages/kernel/sql/) |
| TypeScript, one folder per area, each with a README | [packages/kernel/src/](../../../packages/kernel/src/) |
| Package entry point (namespaces `identity`, `esig`, `market`, `records`, `time`, `commands`, `state`, `continuity`, `sandbox`) | [src/index.ts](../../../packages/kernel/src/index.ts) |
| Running a command with an actor | [src/db/command.ts](../../../packages/kernel/src/db/command.ts#sym=withCommand) |
| Migration runner | [src/db/migrate.ts](../../../packages/kernel/src/db/migrate.ts) |
| Audit-trail verification in TypeScript | [src/audit/verify.ts](../../../packages/kernel/src/audit/verify.ts#sym=runChainVerification) |
| Tests, one folder per area | [packages/kernel/test/](../../../packages/kernel/test/) |
| Review regression tests (one file per finding, `f1` to `f81`) | [packages/kernel/test/review/](../../../packages/kernel/test/review/) |
| SQL mutation tests of kernel guards | [packages/kernel/test/mutation/](../../../packages/kernel/test/mutation/) |
| Controls the kernel carries | [compliance/controls/](../../../compliance/controls/) (DI-01, DI-05, DI-12 to DI-24, DI-27, DI-35 to DI-38, DI-41, DI-43, DI-45, DI-47, DI-50, IN-11, IN-52) |
| Generated lists: every function and trigger, every error code, the code map | [db-catalogue.md](../reference/db-catalogue.md), [error-codes.md](../reference/error-codes.md), [code-map.md](../code-map.md) |

The kernel areas, their schemas and migrations (the same split as [modules.yaml](../modules.yaml) and the
[code map](../code-map.md)):

| Area (section below) | Schema | Migrations | TypeScript |
|---|---|---|---|
| [Audit trail](#audit-trail) | `kernel` | 0010, 0960 | `src/audit`, `src/db` |
| [Identity and access](#identity-and-access) | `iam` | 0100 to 0190, 0940, 0990, 1000 | `src/identity` |
| [Electronic signatures](#electronic-signatures) | `esig` | 0200 to 0250, 0910, 0930, 0950, 1020, 1112 | `src/esig` |
| [Market rules](#market-rules) | `market` | 0300 to 0360, 1010 | `src/market` |
| [Records](#records) | `records` | 0400 to 0440 | `src/records` |
| [QP package, true copies, contingency forms, evidence export, disposal requests](#qp-package-true-copies-contingency-forms-evidence-export-disposal-requests) | `records` | 1160 to 1174 | `src/records` |
| [Platform services](#platform-services) | `platform` | 0500 to 0552, 1110, 1150 | `src/time`, `src/commands`, `src/state` |
| [Continuity](#continuity) | `continuity` | 0600 to 0620 | `src/continuity` |
| [Authorization](#authorization) | `iam` | 0700 to 0720 | (none) |
| [Sandbox](#sandbox) | `sandbox` | 0800 to 0820, 0920, 1030 to 1102, 1120 to 1140 | `src/sandbox` |
| [Integration wiring](#integration-wiring) | all | 0900 | (none) |
| [Installation](#installation) | `kernel` | 0001, 0970, 0980, 1111 | `src/db` |

## How the kernel is built (read this once)

The general rules are explained in [Architecture](../03-architecture.md) (section 4, "Rules live in PostgreSQL") and
in the [database reference](../05-database.md). In short, for the kernel:

- **Three roles.** `ebmr_owner` owns every table and function and cannot log in. `ebmr_app` is the application: it
  reads, and it writes only by calling functions. `ebmr_authn` is the authentication service; it alone reads password
  verifiers. Migration [0001_bootstrap.sql](../../../packages/kernel/sql/0001_bootstrap.sql) creates them.
- **Every write is a command.** Before any GMP write the server calls `kernel.begin_command` with the actor context
  (person, account, role, session, device, reason). The TypeScript wrapper is
  [`withCommand`](../../../packages/kernel/src/db/command.ts#sym=withCommand). Without it the audit trigger refuses
  the write (`EBMR-AUDIT-001`).
- **Insert-only.** Most kernel tables never change a row: a change is a new row. State (an incident's status, the
  current register version, the active holds) is computed from the rows.
- **Guards fail closed.** A guard that cannot decide (an unknown site, a missing hook, a stale mirror) refuses.
- **Errors.** Every refusal is a PostgreSQL exception whose message starts with an `EBMR-<AREA>-<NNN>` code. The
  server maps it to an HTTP answer; [error-codes.md](../reference/error-codes.md) lists where each code is raised.
- **Order of checks in a gated function.** No actor or not a person → refused; then
  [`iam.assert_not_administrator`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.assert_not_administrator)
  for GMP data (DI-18); then
  [`iam.require_permission`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.require_permission)
  (DI-17); only then the function's own rules and the write.

## Audit trail

### What it does

Every insert, update and delete on a registered GMP table writes an audit event in the same transaction. Events form
one hash chain per record ("aggregate"): each event's hash covers the previous hash and the event's canonical
content, so a changed or removed event breaks the chain. Periodic anchors (a Merkle root over all chain heads) are
copied outside the database, so even a rewrite of a whole chain is found. Checkpoints seal a chain at a point (used
before a lawful purge). Plain-language "business" entries (for example "signed CHECKED") go on the same chains.

### Pharma context

An inspector asks first: who did what, when, and why was it changed? 21 CFR 11.10(e) asks for secure,
computer-generated, time-stamped audit trails that record the creation, change and deletion of records without
hiding the earlier values. EU GMP Annex 11 section 9 asks that changes and deletions of GMP data are recorded with a
reason. Annex 11 section 12.4 and Schedule M ask that the record shows who made each entry and when. So the audit trail
must be always on, impossible to switch off or edit, and it must carry the reason for every change.

### Main tables

| Table | What it holds |
|---|---|
| `kernel.audited_table` | Which tables are audited, their aggregate type and column, and whether they are insert-only |
| `kernel.audit_event` | The events: chain key, sequence, previous hash, hash, `recorded_at`, correlation id, action (INSERT, UPDATE, DELETE, BUSINESS, CHECKPOINT), table, record id, payload |
| `kernel.audit_chain_head` | The last sequence and hash of each chain |
| `kernel.audit_checkpoint` | Sealed points of a chain |
| `kernel.audit_anchor` | Merkle roots over all heads, copied to the external ledger by the continuity module |
| `kernel.audit_verification_run` | Results of scheduled chain verifications (insert-only) |
| `kernel.ddl_log` | Every schema change (event triggers), so a dropped or disabled guard is visible |

### Main functions and guards

- [`kernel.begin_command`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.begin_command) installs the
  actor context for the transaction and calls the identity module's
  [`kernel.validate_actor_context`](../../../packages/kernel/sql/0190_iam_actor_context.sql#sym=kernel.validate_actor_context).
- [`kernel.audit_row_change`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.audit_row_change) is the
  trigger on every audited table. It refuses a write without a validated actor context (`EBMR-AUDIT-001`, `-009`),
  an update or delete without a visible reason code and reason text (`EBMR-AUDIT-002`), and a table that is not
  registered (`EBMR-AUDIT-003`).
- [`kernel.reject_mutation`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.reject_mutation) is the
  trigger that keeps insert-only tables insert-only (`EBMR-AUDIT-004`).
- [`kernel.register_audited_table`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.register_audited_table)
  adds the triggers to a new table; [`kernel.audit_triggers_ok`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.audit_triggers_ok)
  checks that none is missing or disabled; `begin_command` refuses GMP writes while one is (`EBMR-AUDIT-005`).
- [`kernel.verify_chain`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.verify_chain),
  [`kernel.create_anchor`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.create_anchor),
  [`kernel.checkpoint_chain`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.checkpoint_chain)
  (refuses a chain that does not verify, `EBMR-AUDIT-007`) and
  [`kernel.run_chain_verification`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.run_chain_verification).
  The records module adds purge-aware versions (`records.verify_chain`, see [Records](#records)).
- [`kernel.is_blank`](../../../packages/kernel/sql/0960_visible_reason_text.sql#sym=kernel.is_blank) (0960) decides
  whether a reason "shows nothing": NULL, white space, control and format characters, zero-width characters and the
  like all count as blank.

> **Why this exists**
> - **Pharma reason:** every change to a GMP record must say who, when and why, and the history must not be editable
>   (21 CFR 11.10(e); Annex 11 section 9).
> - **Control:** [DI-22](../../../compliance/controls/DI-22.yaml), [DI-23](../../../compliance/controls/DI-23.yaml),
>   [DI-24](../../../compliance/controls/DI-24.yaml); invariants INV-06, INV-07, INV-08.
> - **Code:** [`kernel.audit_row_change`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.audit_row_change),
>   [`kernel.reject_mutation`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.reject_mutation).
> - **Tests:** [audit-trail.test.ts](../../../packages/kernel/test/audit/audit-trail.test.ts) (`[INV-06]`, `[INV-07]`,
>   `[INV-08]`, `[DI-23]`), [visible-reason.test.ts](../../../packages/kernel/test/audit/visible-reason.test.ts)
>   (`[DI-22]`), [actor-context.test.ts](../../../packages/kernel/test/audit/actor-context.test.ts) (`[INV-07]`).
> - **Error:** `EBMR-AUDIT-001` no actor, `-002` no visible reason, `-003` table not registered, `-004` insert-only,
>   `-009` context not set by `begin_command`.

> **Why this exists** (missing or disabled triggers)
> - **Pharma reason:** an audit trail that someone can switch off is not an audit trail (DI-23: always on).
> - **Control:** [DI-23](../../../compliance/controls/DI-23.yaml).
> - **Code:** [`kernel.begin_command`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.begin_command)
>   with [`kernel.audit_triggers_ok`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.audit_triggers_ok).
> - **Tests:** [verification.test.ts](../../../packages/kernel/test/audit/verification.test.ts) (`[DI-23]`),
>   [f4.test.ts](../../../packages/kernel/test/review/f4.test.ts).
> - **Error:** `EBMR-AUDIT-005`.

### How to test it

`pnpm vitest run --project db packages/kernel/test/audit`. The review files
[f2](../../../packages/kernel/test/review/f2.test.ts), [f3](../../../packages/kernel/test/review/f3.test.ts),
[f4](../../../packages/kernel/test/review/f4.test.ts), [f5](../../../packages/kernel/test/review/f5.test.ts),
[f6](../../../packages/kernel/test/review/f6.test.ts) and [f77](../../../packages/kernel/test/review/f77.test.ts) cover
earlier holes; [mutation/audit-trail.test.ts](../../../packages/kernel/test/mutation/audit-trail.test.ts) kills the
mutants of the trigger.

### Pitfalls

- **Rewriting a chain was once possible** (P1-F2, F3, F4 in the [defect log](../08-defect-log.md)): a direct update of
  `table_name`/`record_id`, a deleted head that made a chain disappear from the list, a dropped trigger nobody saw. The
  verifier now works from the data, not from a list that an attacker can edit.
- **A reason of spaces or zero-width characters** passed the old check (P1-F6, F77). Use `kernel.is_blank`, never
  `= ''`, when you test a reason.
- **Facts in an entry came from the client** (P1-F5, F46): a zone or a name the client sent. The audit entry takes
  facts from the validated context and the database clock only.
- A new GMP table must be registered with `kernel.register_audited_table` in its migration, or documented as not
  needing it (P2-F01 round 2). The [database reference](../05-database.md) shows how ("Adding a GMP table").

## Identity and access

### What it does

The `iam` schema says who may act, on which device, in which role, with which qualification, and ties every command
and signature to one real person. It holds persons and their identity checks, accounts and login names (never
reused), roles, permissions and grants (with a second-person approval), qualifications, devices, credentials and
badges, authentication events, sessions, the signing-readiness records (the e-signature acknowledgement, delegation,
the US certification letter) and policy values. It also replaces the audit trail's simple context check with the real
one: [`kernel.validate_actor_context`](../../../packages/kernel/sql/0190_iam_actor_context.sql#sym=kernel.validate_actor_context).
The area README is [src/identity/README.md](../../../packages/kernel/src/identity/README.md).

### Pharma context

- 21 CFR 11.10(d) and Annex 11 section 12.1: only authorised people may use the system, and access is controlled.
- 21 CFR 11.100 and 11.300: each electronic signature belongs to one person, never reused or reassigned, and the
  identity is verified before the credential is issued.
- 11.10(g) and Annex 11 section 2: authority checks per action, so a person does only what their role and training
  allow.
- The FDA data-integrity guidance asks that administrators are independent of the record content: an IT administrator
  must not be able to change GMP data (DI-18).
- 11.300(d) and Annex 11 section 12: misuse of credentials (failed logins) is detected and reported.
- Schedule M and 21 CFR 211.25: people are trained for what they do, so a missing qualification is a hard block
  (DI-21, INV-26).

### Main tables

| Area | Tables |
|---|---|
| Persons | `iam.person` (ACTIVE or LEFT), `person_name_event`, `person_status_event`, `identity_verification` |
| Accounts | `iam.issued_identifier` (every login name ever issued), `reserved_identifier` (names known from the ledger after a restore), `account` (HUMAN, SERVICE, INTEGRATION, READONLY_DISPLAY; PENDING_ACTIVATION, ACTIVE, SUSPENDED, DISABLED), `account_status_event` |
| Roles | `iam.permission`, `role`, `role_permission`, `role_permission_request`, `role_grant`, `access_recertification` |
| Qualifications | `iam.qualification_type`, `qualification_source`, `person_qualification`, `qualification_requirement`, `authority_evaluation` (every evaluation stored, INV-26) |
| Devices | `iam.device` (PERSONAL, SHARED, GRADE_A_B, SERVER, INSTRUMENT; ACTIVE, BLOCKED, DECOMMISSIONED) |
| Credentials | `iam.credential` (metadata, audited), `credential_secret` (argon2id verifier; nobody but the owner can read it), `badge`, `badge_secret`, `badge_test`, `break_glass_window` |
| Authentication and sessions | `iam.authn_attempt`, `account_lock_event`, `auth_event`, `auth_event_use`, `security_alert`, `session`, `session_event`, `command_log` (protected logs) |
| Signing readiness | `iam.esig_policy`, `esig_acknowledgement`, `delegation`, `us_esig_certification`, `segregation_evaluation` |
| Policy | `iam.policy_key`, `policy_value` (insert-only history; lockout 3 to 5, idle lock, password length, ...) |

### Main functions and guards

The full list of refusals is in the [guard catalogue](#guard-catalogue). The ones you meet most:

| Function | What it refuses |
|---|---|
| [`kernel.validate_actor_context`](../../../packages/kernel/sql/0190_iam_actor_context.sql#sym=kernel.validate_actor_context) | A command by an unknown, locked or inactive account; a generic or display account; a source that does not fit the account kind; a role not held now; a session that ended, expired or is locked; a device that is not ACTIVE or not the session's; on a shared or Grade A/B terminal, a command without its own fresh authentication event (INV-40). Codes `EBMR-IAM-100` to `-130`. |
| [`iam.require_permission`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.require_permission) | The actor, in the declared role, does not hold the permission in this scope now, with its qualifications (`EBMR-IAM-040`, with a JSON detail). |
| [`iam.evaluate_authority`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.evaluate_authority) | Computes and stores the answer (INV-26), so the decision can be shown later. |
| [`iam.assert_not_administrator`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.assert_not_administrator) | An administrator role or a break-glass account on a GMP data path (`EBMR-IAM-042`). |
| [`iam.check_static_segregation`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.check_static_segregation) | A grant that gives one person both an administration role and a GMP role, or a role that mixes both (`EBMR-IAM-033`, INV-11), and grants to generic or break-glass accounts (`-034` to `-036`). |
| [`iam.role_grant_guard`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.role_grant_guard) | A grant approved by the requester, by the person who receives it, or for an account that is not ACTIVE (`EBMR-IAM-032`, `-026`, `-003`). |
| [`iam.account_guard`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.account_guard) | A login name issued before (`EBMR-IAM-021`, also after a restore), a second GMP account for one person (`-024`), changes to fixed fields (`-007`). |
| [`iam.check_verifier`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.check_verifier) | A password verifier weaker than argon2id v19, m=19456 KiB, t=2, p=1 (`EBMR-IAM-050`). |
| [`iam.consume_auth_event`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.consume_auth_event) | An authentication event used twice, too old, of another person (proxy signing), or for another challenge (`EBMR-IAM-091` to `-096`). |
| [`iam.lock_auth_event`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.lock_auth_event) | An event made with a badge that has since been lost, revoked or replaced (`EBMR-IAM-097`). |
| [`iam.assert_can_sign`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.assert_can_sign) | A person who has not acknowledged the e-signature policy, or whose secret must still be changed (`EBMR-IAM-054`). |
| [`iam.assert_us_esig_certification`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.assert_us_esig_certification) | Issuing a US batch before the legal entity's certification letter to the FDA is recorded (`EBMR-IAM-170`). |
| [`iam.set_policy`](../../../packages/kernel/sql/0940_site_zone_policy_check.sql#sym=iam.set_policy), [`iam.site_zone_row_guard`](../../../packages/kernel/sql/0940_site_zone_policy_check.sql#sym=iam.site_zone_row_guard) | A policy value outside its allowed range (`EBMR-IAM-111`); a site zone that is not a geographic IANA name or UTC (`EBMR-IAM-119`). |

> **Why this exists** (unique personal accounts and attribution)
> - **Pharma reason:** every entry must be traceable to one person; shared accounts make that impossible
>   (21 CFR 11.10(d), 11.100(a); Annex 11 section 12.1). On a shared shop-floor kiosk, every command needs its own
>   fresh badge tap and PIN, so the next person cannot act under the previous one's session.
> - **Control:** [DI-14](../../../compliance/controls/DI-14.yaml), [DI-20](../../../compliance/controls/DI-20.yaml);
>   invariant INV-40.
> - **Code:** [`kernel.validate_actor_context`](../../../packages/kernel/sql/0190_iam_actor_context.sql#sym=kernel.validate_actor_context),
>   [`iam.use_auth_event_for_command`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.use_auth_event_for_command).
> - **Tests:** [attribution.test.ts](../../../packages/kernel/test/identity/attribution.test.ts) (`[INV-40]`, `[DI-14]`),
>   [generic.test.ts](../../../packages/kernel/test/identity/generic.test.ts) (`[DI-14]`),
>   [devices-sessions.test.ts](../../../packages/kernel/test/identity/devices-sessions.test.ts) (`[DI-20]`).
> - **Error:** `EBMR-IAM-100` to `-118`, `-120` to `-126`.

> **Why this exists** (identity and credentials)
> - **Pharma reason:** before someone gets a signature, the company must verify who they are, and a user ID is never
>   given to anyone else (21 CFR 11.100(a) and (b), 11.300(a)).
> - **Control:** [DI-15](../../../compliance/controls/DI-15.yaml); invariant INV-27 (user IDs).
> - **Code:** [`iam.account_guard`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.account_guard),
>   [`iam.issue_credential`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.issue_credential),
>   [`iam.check_verifier`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.check_verifier).
> - **Tests:** [accounts.test.ts](../../../packages/kernel/test/identity/accounts.test.ts) (`[DI-15]`, `[INV-27]`),
>   [secrets.test.ts](../../../packages/kernel/test/identity/secrets.test.ts) (`[DI-15]`, `[DI-19]`).
> - **Error:** `EBMR-IAM-010` to `-013`, `-020` to `-027`, `-050` to `-051`.

> **Why this exists** (grants, recertification, leavers)
> - **Pharma reason:** a list of who had which access at any date, granted by one person and approved by another,
>   checked regularly and removed at once when someone leaves (21 CFR 11.10(d); Annex 11 section 12.3).
> - **Control:** [DI-16](../../../compliance/controls/DI-16.yaml); invariant INV-11.
> - **Code:** [`iam.role_grant_guard`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.role_grant_guard),
>   [`iam.revoke_role_grant`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.revoke_role_grant),
>   [`iam.process_leaver`](../../../packages/kernel/sql/0180_iam_lifecycle.sql#sym=iam.process_leaver).
> - **Tests:** [access.test.ts](../../../packages/kernel/test/identity/access.test.ts) (`[DI-16]`, `[INV-11]`).
> - **Error:** `EBMR-IAM-030` to `-039`.

> **Why this exists** (authority per action)
> - **Pharma reason:** a person may only do what their role allows and what they are trained for, at the moment they
>   do it (21 CFR 11.10(g); Annex 11 section 2; Schedule M training rules).
> - **Control:** [DI-17](../../../compliance/controls/DI-17.yaml), [DI-21](../../../compliance/controls/DI-21.yaml);
>   invariant INV-26.
> - **Code:** [`iam.require_permission`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.require_permission),
>   [`iam.evaluate_authority`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.evaluate_authority).
> - **Tests:** [authority.test.ts](../../../packages/kernel/test/identity/authority.test.ts) (`[INV-26]`, `[DI-21]`),
>   [access.test.ts](../../../packages/kernel/test/identity/access.test.ts) (`[DI-17]`).
> - **Error:** `EBMR-IAM-040`; qualification records `-160`.

> **Why this exists** (administrators kept out of GMP data)
> - **Pharma reason:** the people who run the system must not be able to change what it records (FDA data-integrity
>   guidance on administrator independence; Annex 11 section 12).
> - **Control:** [DI-18](../../../compliance/controls/DI-18.yaml); invariant INV-11.
> - **Code:** [`iam.assert_not_administrator`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.assert_not_administrator),
>   [`iam.check_static_segregation`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.check_static_segregation).
> - **Tests:** [access.test.ts](../../../packages/kernel/test/identity/access.test.ts) (`[DI-18]`),
>   [f70.test.ts](../../../packages/kernel/test/review/f70.test.ts).
> - **Error:** `EBMR-IAM-042`, `-033`.

> **Why this exists** (lockout and misuse)
> - **Pharma reason:** repeated failed attempts must lock the account and alert security; a lost badge must stop
>   working at once (21 CFR 11.300(b), (d); Annex 11 section 12).
> - **Control:** [DI-19](../../../compliance/controls/DI-19.yaml).
> - **Code:** [`iam.authn_finish`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.authn_finish),
>   [`iam.lock_auth_event`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.lock_auth_event),
>   [`iam.badge_guard`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.badge_guard).
> - **Tests:** [credentials.test.ts](../../../packages/kernel/test/identity/credentials.test.ts) (`[DI-19]`),
>   [f11.test.ts](../../../packages/kernel/test/review/f11.test.ts).
> - **Error:** `EBMR-IAM-097`, `-105`, `-140`, `-060` to `-063`.

### State machines

```mermaid
stateDiagram-v2
  [*] --> PENDING_ACTIVATION: iam.create_account
  PENDING_ACTIVATION --> ACTIVE: iam.activate_account
  ACTIVE --> SUSPENDED: iam.suspend_account (sessions end)
  SUSPENDED --> ACTIVE: iam.reinstate_account
  ACTIVE --> DISABLED: iam.deactivate_account / iam.process_leaver
  SUSPENDED --> DISABLED: iam.deactivate_account
  DISABLED --> [*]: never deleted, login name never reused
```

A person is ACTIVE or LEFT; a rehire ([`iam.rehire_person`](../../../packages/kernel/sql/0180_iam_lifecycle.sql#sym=iam.rehire_person))
makes them ACTIVE again without a new identity. A device is ACTIVE, BLOCKED or DECOMMISSIONED; blocking a device ends
its sessions.

### How to test it

`pnpm vitest run --project db packages/kernel/test/identity`. Create real identities with the helpers in
[test/identity/seed.ts](../../../packages/kernel/test/identity/seed.ts) (`seedActor`, `seedServiceActor`,
`freshAuthEvent`); on SHARED and GRADE_A_B devices each command needs its own fresh event. The mutation files
[actor-validation](../../../packages/kernel/test/mutation/actor-validation.test.ts),
[authentication-events](../../../packages/kernel/test/mutation/authentication-events.test.ts),
[segregation-and-grants](../../../packages/kernel/test/mutation/segregation-and-grants.test.ts) and
[site-zone](../../../packages/kernel/test/mutation/site-zone.test.ts) pin the guards' branches.

### Pitfalls

- **A lockout counter reset by any success** (P1-F11): badge taps reset the count of failed password guesses. Only a
  success that proved a secret resets it now.
- **A lone administrator could give operators a GMP permission** (P1-F70): adding a permission to a role grants it to
  every holder, so it now needs a request and a second-person decision
  ([`iam.add_role_permission`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.add_role_permission),
  [`iam.decide_role_permission`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.decide_role_permission)).
- **Lock order matters.** Grant checks lock the role, then the person, then the account; a leaver or a suspension
  either waits or is seen. Keep this order in any new function that changes access, or you get deadlocks or a grant
  that escapes a leaver.
- **Kiosk secrets** (P2-F04 to F09): a PIN change is refused when the authentication is older than the terminal's
  attribution window ([0990](../../../packages/kernel/sql/0990_shared_terminal_secret_change_window.sql)).
- Every function that changes an existing row needs a reason in the actor context (`EBMR-AUDIT-002`).

## Electronic signatures

### What it does

The `esig` schema implements "challenge, authenticate, sign". The server shows exactly what is signed (the canonical
text of the record version, from a content provider registered per aggregate type), the signer proves who they are at
that moment (password, or badge and PIN), and the signature is bound to that content by its hash and a seal (HMAC or
Ed25519, made in TypeScript with a key the database does not hold). When signed content changes later, the signature
is superseded automatically. The area README is [src/esig/README.md](../../../packages/kernel/src/esig/README.md).

```mermaid
sequenceDiagram
  participant S as Screen
  participant API as Server
  participant DB as PostgreSQL
  participant A as Authentication service
  S->>API: show me what I sign
  API->>DB: esig.content_for_signing(type, id)
  DB-->>API: canonical text, version, hash
  S->>API: challenge(meaning, hash I saw)
  API->>DB: esig.create_challenge (refuses another hash: ESIG-013)
  S->>A: password or badge + PIN for this challenge
  A->>DB: one authentication event, bound to the challenge
  API->>DB: esig.sign(challenge, auth event, expected state)
  DB-->>API: seal payload
  API->>DB: esig.seal_signature (same transaction)
```

### Pharma context

- 21 CFR 11.50: a signed record shows the signer's printed name, the date and time, and the meaning (review, approval,
  responsibility). Annex 11 section 14 says the same.
- 21 CFR 11.70: the signature is linked to its record so it cannot be cut out, copied or moved to another record.
- 21 CFR 11.200: a signature needs two components (ID and password); the first signing in a session needs both.
- The four-eyes principle: a person who did or entered something must not verify or approve it (INV-03).
- 11.10(e) and the draft Annex 11: a later change must invalidate the signature.

### Main tables

| Table | What it holds |
|---|---|
| `esig.meaning_type` | The catalogue of signature types (CHECKED, APPROVED, RELEASED, ...): permissions, meaning text, independence rules, witness rules. Insert-only; the vendor minimum set is never removed or loosened |
| `esig.challenge` | Single-use challenges, valid 120 s at most, bound to signer, session and terminal |
| `esig.signature` | The signatures with the stored manifestation (name, time, UTC offset, meaning); only `esig.sign` inserts |
| `esig.signature_seal`, `seal_key`, `seal_key_retirement` | Seals and the public-key archive |
| `esig.signature_invalidation` | SUPERSEDED_BY_CHANGE rows written when signed content changes |
| `esig.signature_id_register` | Every signature id ever issued (INV-27) |
| `esig.content_change` | Who changed which signed record (for INV-03) |
| `esig.signing_failure` | Refused signings (DI-19) |
| `esig.content_provider`, `signed_table` | The provider per aggregate type and the tables that hold signed content |

### Main functions and guards

| Function | What it refuses |
|---|---|
| [`esig.create_challenge`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.create_challenge) | A hash the screen saw that differs from the server's (`EBMR-ESIG-013`), another version (`-012`), an id that is not the record's canonical id (`-014`), an inactive meaning (`-026`). |
| [`esig.sign`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.sign) | A used or expired challenge, another session or terminal (`-031` to `-034`), another zone (`-035`), an authentication event that does not fit (`-036`), missing components (`-038`), a record not in the expected state (`-039`), a signer without the permission (`-040`), a bad delegation (`-041`), and the independence and witness rules below. |
| [`esig.check_independence`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.check_independence) | A second signature of the same meaning on the same version (`-042`), a meaning the signer must be independent of (`-043`), a verifier who performed or entered data (`-044`, INV-03), a reviewer who later performs (`-045`); in both signing orders. |
| [`esig.check_witness`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.check_witness) | A witness after the next step started, or outside the witness window (`-050` to `-053`). |
| [`esig.signature_guard`](../../../packages/kernel/sql/1112_signature_row_backed_by_its_challenge.sql#sym=esig.signature_guard) | Any signature row not inserted by `esig.sign` (`-060`), not matching its challenge (`-065`), or without an authentication event consumed for that challenge in the same transaction (`-066`). |
| [`esig.signature_sealed_check`](../../../packages/kernel/sql/0220_esig_signatures.sql#sym=esig.signature_sealed_check) | A commit of a signature without its seal (`-061`). |
| [`esig.on_signed_content_change`](../../../packages/kernel/sql/0220_esig_signatures.sql#sym=esig.on_signed_content_change) | Marks signatures superseded when signed content changes (INV-09); [`esig.assert_change_triggers_ok`](../../../packages/kernel/sql/0220_esig_signatures.sql#sym=esig.assert_change_triggers_ok) refuses signing while such a trigger is missing (`-008`). |
| [`esig.aggregate_lock`](../../../packages/kernel/sql/1020_esig_lock_read_committed.sql#sym=esig.aggregate_lock) | Signing or changing a signed record outside READ COMMITTED (`-015`). |
| [`esig.assert_signature`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.assert_signature) | Used by every approving function: a signature that does not exist, has another meaning, belongs to another record or is no longer valid (`-070`). |
| [`esig.meaning_type_guard`](../../../packages/kernel/sql/0210_esig_catalogue.sql#sym=esig.meaning_type_guard) | Removing, disabling or loosening a vendor signature type (`-020` to `-025`). |

> **Why this exists** (signing ceremony)
> - **Pharma reason:** a signature must be made by its owner, at that moment, on exactly the content shown, with its
>   meaning (21 CFR 11.50, 11.200; Annex 11 section 14).
> - **Control:** [DI-35](../../../compliance/controls/DI-35.yaml), [DI-36](../../../compliance/controls/DI-36.yaml),
>   [DI-38](../../../compliance/controls/DI-38.yaml); invariant INV-10.
> - **Code:** [`esig.sign`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.sign),
>   [`esig.create_challenge`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.create_challenge),
>   [`esig.signature_guard`](../../../packages/kernel/sql/1112_signature_row_backed_by_its_challenge.sql#sym=esig.signature_guard);
>   TypeScript [`sign`](../../../packages/kernel/src/esig/signing.ts#sym=sign).
> - **Tests:** [signing.test.ts](../../../packages/kernel/test/esig/signing.test.ts) (`[INV-10]`, `[DI-37]`),
>   [manifestation.test.ts](../../../packages/kernel/test/esig/manifestation.test.ts) (`[DI-36]`),
>   [sessions.test.ts](../../../packages/kernel/test/esig/sessions.test.ts) (`[DI-38]`),
>   [catalogue.test.ts](../../../packages/kernel/test/esig/catalogue.test.ts) (`[DI-35]`).
> - **Error:** `EBMR-ESIG-010` to `-041`, `-060` to `-066`.

> **Why this exists** (four-eyes)
> - **Pharma reason:** the person who did a step, entered its data or corrected it must not verify, witness or approve
>   it; the checker and the approver are two people.
> - **Control:** [DI-35](../../../compliance/controls/DI-35.yaml); invariants INV-03, INV-04.
> - **Code:** [`esig.check_independence`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.check_independence).
> - **Tests:** [independence.test.ts](../../../packages/kernel/test/esig/independence.test.ts) (`[DI-35]`, `[INV-03]`),
>   [f13](../../../packages/kernel/test/review/f13.test.ts), [f73](../../../packages/kernel/test/review/f73.test.ts).
> - **Error:** `EBMR-ESIG-042` to `-045`.

> **Why this exists** (link and invalidation)
> - **Pharma reason:** a signature stays with its record and stops counting when the record changes (21 CFR 11.70;
>   Annex 11 section 14(b)).
> - **Control:** [DI-37](../../../compliance/controls/DI-37.yaml); invariant INV-09.
> - **Code:** [`esig.on_signed_content_change`](../../../packages/kernel/sql/0220_esig_signatures.sql#sym=esig.on_signed_content_change),
>   [`esig.aggregate_lock`](../../../packages/kernel/sql/1020_esig_lock_read_committed.sql#sym=esig.aggregate_lock),
>   [`esig.assert_signature`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.assert_signature).
> - **Tests:** [invalidation.test.ts](../../../packages/kernel/test/esig/invalidation.test.ts) (`[INV-09]`),
>   [isolation.test.ts](../../../packages/kernel/test/esig/isolation.test.ts),
>   [canonical.test.ts](../../../packages/kernel/test/esig/canonical.test.ts) (`[DI-37]`).
> - **Error:** `EBMR-ESIG-006` to `-008`, `-015`, `-070`.

> **Why this exists** (refused signings are logged)
> - **Pharma reason:** attempts to sign as someone else must be detected and reported (21 CFR 11.300(d)).
> - **Control:** [DI-19](../../../compliance/controls/DI-19.yaml).
> - **Code:** [`esig.record_signing_failure`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.record_signing_failure),
>   [`esig.signing_misuse`](../../../packages/kernel/sql/0950_signing_failure_own_command.sql#sym=esig.signing_misuse).
> - **Tests:** [signing-failure-own-command.test.ts](../../../packages/kernel/test/esig/signing-failure-own-command.test.ts) (`[DI-19]`).
> - **Error:** `EBMR-ESIG-031`; identity codes `EBMR-IAM-091`, `-093`, `-094`.

### State machine of a signature

A signature is never updated. Its status is computed by
[`esig.signature_state`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.signature_state):

```mermaid
stateDiagram-v2
  [*] --> UNSEALED: esig.sign inserts the row
  UNSEALED --> VALID: esig.seal_signature (same transaction; otherwise the commit fails)
  VALID --> SUPERSEDED_BY_CHANGE: signed content changed (invalidation row)
  VALID --> CONTENT_MISMATCH: hash differs without an invalidation row (integrity problem)
```

### How to test it

`pnpm vitest run --project db packages/kernel/test/esig`. Helpers in
[test/esig/helpers.ts](../../../packages/kernel/test/esig/helpers.ts). The platform hook
([platform-hook.test.ts](../../../packages/kernel/test/esig/platform-hook.test.ts)) and the review files f1, f13 to f17,
f41, f68, f73, f74 cover the hardest cases. Mutation files: [signing](../../../packages/kernel/test/mutation/signing.test.ts),
[signature-invalidation](../../../packages/kernel/test/mutation/signature-invalidation.test.ts),
[signing-failure-and-reasons](../../../packages/kernel/test/mutation/signing-failure-and-reasons.test.ts).

### Pitfalls

- **A co-signer's context could be reinstalled** (P1-F1, F68, F74, critical). After a co-signature, restore the
  command's own context only with `kernel.set_actor_context`; one marker row per backend makes only the latest context
  valid.
- **Independence checked in one order only** (P1-F13 and others). For every pair of acts that must be done by two
  people, write a test for each signing order.
- **Two spellings of one id** (P1-F16): `BATCH-1` and `batch-1` were two records. Content providers must return the
  canonical id; `create_challenge` refuses another (`-014`).
- **A no-op save changed the hash** (P1-F17): derive a content version from content, never from a counter.
- **A flag is not proof** (P2 mutation D11): the signing marker can be set by any role, so kernel 1112 holds the row
  to its challenge and authentication event.
- Never sign under REPEATABLE READ or SERIALIZABLE: the statements after the lock read an old snapshot (`-015`).

## Market rules

### What it does

Every batch is made under an Indian licence, so India's Revised Schedule M always applies; a batch may add the US
and/or the EU. The `market` schema keeps every market difference as versioned rule data and resolves, per atomic key
(one dimension, one unit), the value that satisfies India and every market in scope: the stricter rule wins. It
records which market required the value and stores every resolution. It also holds site values (a site may only
tighten), and policy switches pinned per batch. The area README is
[src/market/README.md](../../../packages/kernel/src/market/README.md).

### Pharma context

An Indian exporter must meet Schedule M and, for an export, the importing market's GMP (21 CFR 210/211 for the US, EU
GMP and its annexes for the EU). Where they differ, the batch follows the stricter value. A looser value must never
reach a batch by accident, and a correction of a wrong value in the tables must be approved by two quality people.
Schedule M itself is the floor (INV-28: never looser than India).

### Main tables

| Table | What it holds |
|---|---|
| `market.rule_table`, `rule_table_version` | The rule tables `kernel`, `tablets`, `sterile`, each versioned, with a content hash |
| `market.rule_key`, `rule_row` | Keys with their comparison method; rows per market, predicate, value, floor type and effective window (insert-only) |
| `market.evaluation` | Every resolution used for a subject (INV-29), recomputed by a trigger |
| `market.site_value` | Site values (tighten only; loosening needs a justification and a QA signature) |
| `market.policy`, `policy_version`, `batch_policy_pin` | Policy switches and the version pinned to each batch at issue (INV-47) |
| `market.change_impact` | What a new table version affects (looser MBR limits, inadmissible site values) |
| `market.stub_*` | Phase 1 stand-ins for sites, products, lines and batches (scopes) |

### Main functions and guards

| Function | What it refuses |
|---|---|
| [`market.resolve`](../../../packages/kernel/sql/0300_market_rule_model.sql#sym=market.resolve) | A market set without India (`EBMR-MKT-001`), a missing predicate (`-042`), no India value for a key India governs (`-045`), a result looser than India (`-049`). The TypeScript [`resolve`](../../../packages/kernel/src/market/resolve.ts#sym=resolve) gives the same answer. |
| [`market.validate_document`](../../../packages/kernel/sql/0300_market_rule_model.sql#sym=market.validate_document) | A malformed rule-table document (`-010` to `-029`). |
| [`market.publish_rule_table`](../../../packages/kernel/sql/0340_market_publish.sql#sym=market.publish_rule_table) | A version out of sequence, a loosening that applies today or earlier unless it is a signed source correction (`-031`), a source correction without two quality signatures from two people other than the publisher (`-032`). |
| [`market.set_site_value`](../../../packages/kernel/sql/0320_market_site_values.sql#sym=market.set_site_value), [`market.assess_site_value`](../../../packages/kernel/sql/1010_site_value_set_equality.sql#sym=market.assess_site_value) | A site value looser than a binding (`-060`) or DESIGN value (`-061`); a looser GUIDANCE value without justification and QA signature (`-065`); the setter approving their own loosening (`-066`). |
| [`market.evaluation_complete`](../../../packages/kernel/sql/0330_market_evaluations.sql#sym=market.evaluation_complete) | Any stored evaluation that the tables do not give (`-053`), even from the owner. |
| [`market.evaluate_stub_scope`](../../../packages/kernel/sql/0330_market_evaluations.sql#sym=market.evaluate_stub_scope) | A request that changes what the scope fixes: a predicate, the site, a pack's destination, the subject (`-055` to `-058`). |
| [`market.policy_version_guard`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.policy_version_guard) | A policy version in the past or before a scheduled one, without a change reference, or a loosening without another person's signature (`-070` to `-075`). |
| [`market.policy_pin_guard`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.policy_pin_guard) | A pin that would let a loosening reach a batch issued before it took effect (`-080` to `-085`). |

> **Why this exists**
> - **Pharma reason:** the stricter of India and the export markets must win, India is always in, and a looser value
>   needs real approvals (Schedule M; 21 CFR 211; EU GMP).
> - **Control:** [IN-52](../../../compliance/controls/IN-52.yaml); invariants INV-28, INV-29, INV-47.
> - **Code:** [`market.resolve`](../../../packages/kernel/sql/0300_market_rule_model.sql#sym=market.resolve),
>   [`market.publish_rule_table`](../../../packages/kernel/sql/0340_market_publish.sql#sym=market.publish_rule_table),
>   [`market.policy_pin_guard`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.policy_pin_guard).
> - **Tests:** [engine-guards.test.ts](../../../packages/kernel/test/market/engine-guards.test.ts) (`[IN-52]`, `[INV-28]`),
>   [inv28.property.test.ts](../../../packages/kernel/test/market/inv28.property.test.ts),
>   [evaluations.test.ts](../../../packages/kernel/test/market/evaluations.test.ts) (`[INV-29]`),
>   [policy.test.ts](../../../packages/kernel/test/market/policy.test.ts) (`[INV-47]`),
>   [site-values.test.ts](../../../packages/kernel/test/market/site-values.test.ts) (`[IN-52]`),
>   [f24](../../../packages/kernel/test/review/f24.test.ts).
> - **Error:** `EBMR-MKT-001` to `-087`; a bad approval signature `EBMR-ESIG-070`.

### How to test it

`pnpm vitest run --project db packages/kernel/test/market`. [validate.test.ts](../../../packages/kernel/test/market/validate.test.ts)
and [rule-tables.test.ts](../../../packages/kernel/test/market/rule-tables.test.ts) need no special data; the property
test runs the TypeScript and SQL engines against random tables.

### Pitfalls

- **Approvals were free UUIDs** (P1-F24, F76): an approval column must point at a real signature of the right meaning
  (checked with `esig.assert_signature`), by someone other than the person making the change.
- **"Today" in the client's zone** (P1-F27): use the site zone (`kernel.site_zone()`), never a zone from the request.
- **Concurrent tightenings** (P1-F26): pins of one batch and policy are serialised; keep the lock if you add a writer.
- Decimals are strings in the documents (`"7.5"`, never `7.5` or `"7.50"`); see [expr](expr.md) for why.

## Records

### What it does

The `records` schema (migrations 0400 to 0440) holds the record-type register (which record types exist, their
official medium, raw or derived), the incident register, retention schedules with dependencies and holds, controlled
purge, the true-copy register and data-integrity investigations. The area README is
[src/records/README.md](../../../packages/kernel/src/records/README.md).

### Pharma context

- 21 CFR 11.1 and EU GMP Chapter 4: the company decides and documents which records are electronic, which data are raw
  data, and where they live. Any data behind a quality decision is raw data (DI-01).
- Schedule M (record kept at least a year after expiry), 21 CFR 211.180 and EU GMP 4.10 to 4.12: records are kept for a
  set time, and longer while anything depends on them or a hold applies (DI-47, INV-22).
- 21 CFR 211.192 and Annex 11 section 13: incidents are recorded, investigated and linked to the batches they touch
  (DI-12).
- FDA data-integrity guidance: when a person's data is in doubt, everything they touched is scoped, held and
  investigated (DI-50).

### Main tables

| Area | Tables |
|---|---|
| Register (DI-01) | `records.record_type`, `record_type_approval`; view `records.record_register` |
| Incidents (DI-12) | `records.incident`, `incident_link`, `incident_event`, `incident_assessment` (status derived) |
| Retention (DI-47) | `records.retention_rule_set`, `retention_rule`, `retention_schedule`, `retention_input`, `retention_evaluation`, `retention_dependency`, `retention_hold`, `retention_hold_release`, `retention_aggregate`, `blocker_epoch` |
| Purge | `records.purge_approval`, `tombstone`, `true_copy` |
| Investigations (DI-50) | `records.di_investigation`, `di_investigation_link`, `di_investigation_closure` |

### Main functions and guards

| Function | What it refuses |
|---|---|
| [`records.classification_problem`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.classification_problem) | A data item that feeds an acceptance limit and is not RAW, an unregistered record type, a class weaker than the register's (`EBMR-REC-010` to `-014`). |
| [`records.approve_record_type`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.approve_record_type) | Approval by the author, of an older version, or without the approver's own RECORD_TYPE_APPROVED signature (`-012`, `-013`, `-015`, `-017`). |
| [`records.close_incident`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.close_incident) | Closing without a summary; a MAJOR or CRITICAL incident without root cause and CAPA reference; a CERT-In reportable one without the report (`-052` to `-055`). |
| [`records.create_retention_schedule`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.create_retention_schedule), [`records.declare_retention_aggregate`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.declare_retention_aggregate) | A zone other than the site's (`-020`), an aggregate type not declared for retention (`-024`). |
| [`records.approve_purge`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.approve_purge) | An approver who entered retention inputs or dependency links (`-035`), someone else's signature (`-039`), a signature made before a hold was released (`-041`). |
| [`records.purge`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.purge) | A purge while OPEN, on or before retain-until, under a blocker or hold, without a matching approval, when the chain does not verify, or when the cited true copy leaves out a table (`-033` to `-038`, `-041`). |
| [`records.disposal_refusals`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.disposal_refusals) | Lists every reason a record may not be disposed of (`-023`, `-030` to `-032`). |
| [`records.open_di_investigation`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.open_di_investigation), [`records.close_di_investigation`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.close_di_investigation) | Closure by the investigator or the subject, or without the closer's own DI_INVESTIGATION_CLOSED signature (`-060` to `-065`). |
| [`records.register_true_copy`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.register_true_copy) | A copy whose manifest or head does not match the chain (`-070`). |

> **Why this exists** (raw-data register)
> - **Pharma reason:** data behind a quality decision is raw data and must be kept as such; the register is approved by
>   a second person (21 CFR 11.1; EU GMP Chapter 4).
> - **Control:** [DI-01](../../../compliance/controls/DI-01.yaml); invariant INV-03.
> - **Code:** [`records.approve_record_type`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.approve_record_type),
>   [`records.classification_problem`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.classification_problem).
> - **Tests:** [register.test.ts](../../../packages/kernel/test/records/register.test.ts), tests named `[DI-01]`.
> - **Error:** `EBMR-REC-010` to `-017`.

> **Why this exists** (incidents)
> - **Pharma reason:** a system failure that may touch a batch is recorded, linked, investigated and closed with a root
>   cause (21 CFR 211.192; Annex 11 section 13); CERT-In needs cyber incidents reported within hours.
> - **Control:** [DI-12](../../../compliance/controls/DI-12.yaml).
> - **Code:** [`records.close_incident`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.close_incident).
> - **Tests:** [incidents.test.ts](../../../packages/kernel/test/records/incidents.test.ts), tests named `[DI-12]`.
> - **Error:** `EBMR-REC-050` to `-056`.

> **Why this exists** (retention and purge)
> - **Pharma reason:** a record is kept for its full retention, longer while anything depends on it or a hold applies,
>   and destroyed only with QA approval and a kept proof of what was destroyed (Schedule M; 21 CFR 211.180; EU GMP
>   4.10 to 4.12).
> - **Control:** [DI-47](../../../compliance/controls/DI-47.yaml); invariant INV-22.
> - **Code:** [`records.purge`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.purge),
>   [`records.approve_purge`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.approve_purge),
>   [`records.evaluate_retention`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.evaluate_retention).
> - **Tests:** [retention-purge.test.ts](../../../packages/kernel/test/records/retention-purge.test.ts) (`[INV-22]`,
>   `[DI-47]`), [retention-rules.test.ts](../../../packages/kernel/test/records/retention-rules.test.ts),
>   [calendar.test.ts](../../../packages/kernel/test/records/calendar.test.ts).
> - **Error:** `EBMR-REC-020` to `-041`.

> **Why this exists** (data-integrity investigations)
> - **Pharma reason:** when one person's data is in doubt, everything they created or changed in the window is found,
>   held and investigated, and the closure is approved by someone independent (FDA data-integrity guidance; 21 CFR
>   211.192).
> - **Control:** [DI-50](../../../compliance/controls/DI-50.yaml).
> - **Code:** [`records.open_di_investigation`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.open_di_investigation),
>   [`records.close_di_investigation`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.close_di_investigation).
> - **Tests:** [investigations.test.ts](../../../packages/kernel/test/records/investigations.test.ts), tests named `[DI-50]`.
> - **Error:** `EBMR-REC-060` to `-065`.

### State machines

```mermaid
stateDiagram-v2
  direction LR
  state "Incident" as I {
    [*] --> OPEN: records.raise_incident
    OPEN --> UNDER_INVESTIGATION: start_incident_investigation
    UNDER_INVESTIGATION --> CLOSED: close_incident
  }
```

```mermaid
stateDiagram-v2
  [*] --> Open: schedule created (a date missing, or EU certification pending)
  Open --> Kept: every rule that applies has its date (retain-until)
  Kept --> Eligible: site date after retain-until, no hold, no blocker
  Eligible --> Kept: a hold, a blocker or a dependant moves it back
  Eligible --> Purged: approve_purge (signed), then purge
  Purged --> [*]: tombstone kept
```

The retention states above are a reading aid, not stored values: the database stores evaluations (OPEN or a
retain-until date, from `records.evaluate_retention`), holds, blockers and approvals, and derives the rest.

### How to test it

`EBMR_MIGRATIONS='^(00|04)' pnpm vitest run --project db packages/kernel/test/records` runs only the records
migrations (fast). The true-copy verifier has its own offline tests
([true-copy-verifier.test.ts](../../../packages/kernel/test/records/true-copy-verifier.test.ts)). Mutation file:
[retention-and-purge](../../../packages/kernel/test/mutation/retention-and-purge.test.ts).

### Pitfalls

- **Never accept a date from the caller.** Purge recomputes retain-until from stored inputs and rule rows; the
  TypeScript `evaluateOwnRetention` is only a preview, and a property test proves both agree.
- **A hold voids earlier approvals** (owner decision 0004): an approval given before a hold, even a released one, is
  refused (`-041`); a new signature is needed.
- **The application role read too much** (P2-F34, F35): an investigation's subject must get nothing of it. To hide that
  something exists, do not grant the reader; filtering is not enough.
- **Dates are site-local calendar dates.** 29 February plus one year is 1 March; a zone other than the site's is
  refused.

## QP package, true copies, contingency forms, evidence export, disposal requests

### What it does

Phase 4 added five things to the `records` schema (migrations 1160 to 1174):

1. **The EU QP batch package** ([1160](../../../packages/kernel/sql/1160_qp_batch_package.sql),
   [1162](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql)). The server assembles true copies of a lot's
   records and its documents with a manifest; the database recomputes every hash; QA issues it with a
   TRUE_COPY_VERIFIED signature; a QP of the EU importer gets read-only, time-boxed access to one lot.
2. **True copies read by a definer** ([1161](../../../packages/kernel/sql/1161_true_copy_snapshot.sql),
   [1173](../../../packages/kernel/sql/1173_true_copy_table_names.sql)): `records.true_copy_snapshot` returns the
   parts of a copy in one snapshot to a person allowed to register copies.
3. **Contingency forms** ([1170](../../../packages/kernel/sql/1170_contingency_forms.sql)): numbered paper forms
   issued for downtime, then returned, transcribed, verified or voided, and reconciled with a signature before the
   batch may complete.
4. **The certified evidence export** ([1171](../../../packages/kernel/sql/1171_evidence_export.sql),
   [1174](../../../packages/kernel/sql/1174_evidence_export_review_fixes.sql)): true copies plus a PDF/A-3 rendering,
   certified by QA, read in an inspection workspace.
5. **Disposal requests** ([1172](../../../packages/kernel/sql/1172_disposal_requests.sql)): a request to delete a
   record is answered (REFUSED or ELIGIBLE) and logged; nothing is deleted here.

TypeScript: [qp-package.ts](../../../packages/kernel/src/records/qp-package.ts),
[true-copy.ts](../../../packages/kernel/src/records/true-copy.ts#sym=buildTrueCopyBundle),
[contingency.ts](../../../packages/kernel/src/records/contingency.ts),
[evidence-export.ts](../../../packages/kernel/src/records/evidence-export.ts),
[pdf-true-copy.ts](../../../packages/kernel/src/records/pdf-true-copy.ts).

### Pharma context

- **QP certification** (EU GMP Annex 16): before an EU importer releases a batch made in India, its Qualified Person
  needs the batch documentation. The package gives exactly that, as true copies, and nothing more.
- **True copies** (21 CFR 211.180(d); EU GMP 4.1; FDA data-integrity Q&A): a copy that keeps the content and meaning
  of the original, verified as such.
- **Contingency forms** (FDA data-integrity Q&A on paper in the loop; EU GMP Chapter 4): when the system is down,
  numbered and reconciled paper forms are used, so no blank sheet can disappear or be replaced.
- **Certified evidence** (Bharatiya Sakshya Adhiniyam 2023 section 63; IT Act section 7): an electronic record shown
  to a court or inspector needs a certificate that it is a faithful copy.
- **Deletion before the date is refused and logged** (PR-59, Schedule M retention).

### Main tables

| Table | What it holds |
|---|---|
| `records.qp_package`, `qp_package_issue` | Assembled packages and QA's issue signature (ASSEMBLED, then ISSUED) |
| `records.qp_subject_provider` | Which module answers for a QP subject (lots: site services) and which chains a section may copy |
| `records.qp_access`, `qp_access_revocation`, `qp_access_read` | Time-boxed QP access to one lot, its early end, and every read |
| `records.contingency_form`, `contingency_form_event`, `form_reconciliation` | Numbered forms (serial from a protected sequence, INV-27), their steps, and the signed reconciliation |
| `records.evidence_export_subject`, `evidence_export`, `evidence_export_certification`, `evidence_export_read` | What an export may copy, the exports, QA's certification, and every inspection read |
| `records.disposal_request` | Every request to delete a record, with the database's answer |

### Main functions and guards

| Function | What it refuses |
|---|---|
| [`records.register_qp_package`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.register_qp_package) | A package whose hash, sections or copies do not match, or a section that copies a record of another lot (`EBMR-REC-080` to `-083`, `-093`). |
| [`records.issue_qp_package`](../../../packages/kernel/sql/1160_qp_batch_package.sql#sym=records.issue_qp_package) | Issue without QA's own TRUE_COPY_VERIFIED signature of this package (`-084`, `-085`). |
| [`records.grant_qp_access`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.grant_qp_access), [`records.qp_access_role_guard`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.qp_access_role_guard) | Access for an account that holds any other live role, longer than the maximum, or for a closed subject; any other role for an account while it has QP access (`-086` to `-089`, `-091`, `-092`). |
| [`records.read_qp_package`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.read_qp_package) | A read outside a live access, or of a package that is not the latest issued (`-090`, `-091`). |
| [`records.issue_contingency_pack`](../../../packages/kernel/sql/1174_evidence_export_review_fixes.sql#sym=records.issue_contingency_pack) | A pack without batch, template or destination, or for a batch that has ended (`-100`, `-107`). |
| [`records.record_contingency_form_event`](../../../packages/kernel/sql/1170_contingency_forms.sql#sym=records.record_contingency_form_event) | A step out of order, a void or loss without reason, a transcription without reference, a verification by the transcriber, any change after the reconciliation is signed (`-101` to `-103`). |
| [`records.sign_form_reconciliation`](../../../packages/kernel/sql/1170_contingency_forms.sql#sym=records.sign_form_reconciliation), [`records.form_reconciliation_problem`](../../../packages/kernel/sql/1170_contingency_forms.sql#sym=records.form_reconciliation_problem) | A reconciliation while forms are open, or without the FORMS_RECONCILED signature; the completion gate reads the problem (`-104` to `-106`). |
| [`records.register_evidence_export`](../../../packages/kernel/sql/1174_evidence_export_review_fixes.sql#sym=records.register_evidence_export) | A package whose sections, copies or PDF do not match what the database reads now (`-120` to `-124`, `-128`, `-129`). |
| [`records.certify_evidence_export`](../../../packages/kernel/sql/1171_evidence_export.sql#sym=records.certify_evidence_export) | Certification without QA's own EVIDENCE_EXPORT_CERTIFIED signature (`-125`, `-126`). |
| [`records.read_evidence_export`](../../../packages/kernel/sql/1174_evidence_export_review_fixes.sql#sym=records.read_evidence_export) | An administrator (before the permission check), or an export that is not certified (`-127`). |
| [`records.request_disposal`](../../../packages/kernel/sql/1172_disposal_requests.sql#sym=records.request_disposal) | A request without reason or permission (`-130`); the answer is recomputed from stored inputs. |

> **Why this exists** (QP package)
> - **Pharma reason:** the EU QP certifies on documents that must be faithful copies, and the QP must see only that
>   lot, read-only, for a limited time (EU GMP Annex 16; Annex 11).
> - **Control:** [DI-41](../../../compliance/controls/DI-41.yaml), [DI-14](../../../compliance/controls/DI-14.yaml),
>   [DI-17](../../../compliance/controls/DI-17.yaml).
> - **Code:** [`records.register_qp_package`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.register_qp_package),
>   [`records.grant_qp_access`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.grant_qp_access).
> - **Tests:** [qp-package.test.ts](../../../packages/kernel/test/records/qp-package.test.ts) (`[DI-41]`, `[DI-14]`).
> - **Error:** `EBMR-REC-080` to `-093`.

> **Why this exists** (contingency forms)
> - **Pharma reason:** paper used during downtime must be numbered, accounted for and transcribed under a second
>   person's check, and the batch is not complete until every form is reconciled (FDA data-integrity Q&A; EU GMP
>   Chapter 4).
> - **Control:** [DI-43](../../../compliance/controls/DI-43.yaml), [PR-16](../../../compliance/controls/PR-16.yaml);
>   invariant INV-27 (serials).
> - **Code:** [`records.record_contingency_form_event`](../../../packages/kernel/sql/1170_contingency_forms.sql#sym=records.record_contingency_form_event),
>   [`records.form_reconciliation_problem`](../../../packages/kernel/sql/1170_contingency_forms.sql#sym=records.form_reconciliation_problem).
> - **Tests:** [contingency-forms.test.ts](../../../packages/kernel/test/records/contingency-forms.test.ts) (`[DI-43]`),
>   [mutation/records-contingency-forms.test.ts](../../../packages/kernel/test/mutation/records-contingency-forms.test.ts).
> - **Error:** `EBMR-REC-100` to `-107`.

> **Why this exists** (evidence export)
> - **Pharma reason:** an exported record shown to an inspector or a court must be provably the stored record,
>   certified by QA (IN-11; Annex 11 section 8).
> - **Control:** [IN-11](../../../compliance/controls/IN-11.yaml), [DI-40](../../../compliance/controls/DI-40.yaml),
>   [DI-41](../../../compliance/controls/DI-41.yaml).
> - **Code:** [`records.register_evidence_export`](../../../packages/kernel/sql/1174_evidence_export_review_fixes.sql#sym=records.register_evidence_export),
>   [`records.true_copy_bundle_problem`](../../../packages/kernel/sql/1174_evidence_export_review_fixes.sql#sym=records.true_copy_bundle_problem).
> - **Tests:** [evidence-export.test.ts](../../../packages/kernel/test/records/evidence-export.test.ts) (`[IN-11]`,
>   `[DI-41]`, `[DI-40]`), [evidence-export-offline.test.ts](../../../packages/kernel/test/records/evidence-export-offline.test.ts).
> - **Error:** `EBMR-REC-120` to `-129`.

> **Why this exists** (disposal requests)
> - **Pharma reason:** deleting a record before its retention ends is refused, and the refusal is logged (PR-59).
> - **Control:** [PR-59](../../../compliance/controls/PR-59.yaml), [DI-47](../../../compliance/controls/DI-47.yaml).
> - **Code:** [`records.request_disposal`](../../../packages/kernel/sql/1172_disposal_requests.sql#sym=records.request_disposal).
> - **Tests:** [batch-retention.test.ts](../../../packages/kernel/test/records/batch-retention.test.ts) (`[PR-59]`).
> - **Error:** `EBMR-REC-130`.

### State machines

```mermaid
stateDiagram-v2
  [*] --> ISSUED: issue_contingency_pack (serial CF-000001...)
  ISSUED --> RETURNED: came back with entries
  RETURNED --> TRANSCRIBED: back-entered, with a reference
  TRANSCRIBED --> VERIFIED: a second person checked
  ISSUED --> VOIDED: unused or spoilt (reason)
  ISSUED --> MISSING: reported missing
  MISSING --> VOIDED: with the deviation reference
  VERIFIED --> [*]
  VOIDED --> [*]
```

A QP package goes ASSEMBLED to ISSUED (QA signs TRUE_COPY_VERIFIED); an evidence export goes ASSEMBLED to CERTIFIED
(QA signs EVIDENCE_EXPORT_CERTIFIED).

### Pitfalls

- **Table names in true copies** (kernel 1173): the audit trigger names a table under its own search path
  (`records.contingency_form`), the copy reader under another (`contingency_form`); every row of a records-schema
  chain showed as "not captured". Use `records.audit_table_name` when you compare names.
- **The stored hash must never be the caller's word** (6-R1 in 1174): the database recomputes every part the offline
  verifier checks.
- **Kernel migrations run before recipe-core.** The contingency completion gate is a trigger on
  `recipe.execution_state` that only recipe-core can add; the kernel reads batch status late-bound.

## Platform services

### What it does

The `platform` schema holds the shared services every module uses: trusted time (two times per event, the drift
monitor), the transactional outbox, idempotent commands, policy settings, hooks, and the state-machine engine. The area
READMEs are [src/time/README.md](../../../packages/kernel/src/time/README.md),
[src/commands/README.md](../../../packages/kernel/src/commands/README.md) and
[src/state/README.md](../../../packages/kernel/src/state/README.md).

### Pharma context

- **Time** (21 CFR 11.10(e), 11.50; Annex 11 section 12.4; Schedule M): every entry carries a trustworthy date and time
  from the system, not from the user's device; an entry made late says so. The clock is checked against a traceable
  reference (in India, NPL). DI-27, INV-16.
- **State machines**: a record moves through its life (draft, checked, approved) only in allowed steps, each by an
  authorised person and with the required signature (21 CFR 11.10(f), sequencing of steps).
- **Idempotency and the outbox** are not regulatory as such; they make sure a retried request does not record a step
  twice and that a notification is sent once the data is committed.

### Main tables

| Area | Tables |
|---|---|
| Time | `platform.time_source`, `time_source_registration`, `drift_sample`, `alarm`, `alarm_clearance`, `time_anomaly`, `db_time_column` (registered time columns), `aggregate_clock`, the demo `stub_step`, `stub_step_entry` |
| Outbox | `platform.outbox`, `outbox_state`, `outbox_attempt`, `consumed_message` |
| Idempotency | `platform.idempotency_key` (no application privileges) |
| State engine | `platform.machine`, `machine_version`, `machine_transition`, `state_guard`, `aggregate_state`, `state_history`, `hook`, the sample `stub_record` |
| Settings | `platform.setting_definition`, `setting_value` |

### Main functions and guards

| Function | What it refuses |
|---|---|
| [`platform.enforce_db_time`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.enforce_db_time) | Registers a time column so a trigger overwrites any supplied value (INV-16); [`platform.time_model_violations`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.time_model_violations) lists any gap. |
| [`platform.check_time_trust_source`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.check_time_trust_source) | A device time claimed by a person (`EBMR-PLAT-009`). |
| [`platform.check_occurred_at`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.check_occurred_at), [`platform.check_late_entry`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.check_late_entry) | An event time outside the step or after recording (`-010` to `-013`); a late entry without a reason (`-015`) or, beyond the window, without a supervisor's co-signature (`-016`). |
| [`platform.entry_site_zone`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.entry_site_zone) | A command whose context declares a zone other than the site's (`-023`). |
| [`platform.register_time_source`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.register_time_source), [`platform.confirm_time_source`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.confirm_time_source), [`platform.set_time_source_active`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.set_time_source_active) | A time source registered and confirmed by one person (`-033`, `-034`); a deactivation below the minimum without the validator's permission (`-035`). |
| [`platform.report_time_fault`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.report_time_fault) | Reporting a fault the monitor itself evaluates (`-036`). |
| [`platform.claim_idempotency_key`](../../../packages/kernel/sql/0540_platform_idempotency.sql#sym=platform.claim_idempotency_key) | The same key with another request (`-041`) or by another person (`-042`); a commit without a stored result (`-045`). |
| [`platform.enqueue`](../../../packages/kernel/sql/0510_platform_outbox.sql#sym=platform.enqueue) | A reserved topic (`state.`, `incident.`, `platform.`) from the application (`-057`). |
| [`platform.transition`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.transition) | An administrator (`EBMR-IAM-042`), a stale expected version (`-066`), an event not allowed in the state (`-067`), a missing permission (`-005`, `-006`), a missing or replayed signature (`-007`, `-008`, `-075`), a failing guard (`-068`). |
| [`platform.guard_state_row`](../../../packages/kernel/sql/1110_state_rows_follow_published_machine.sql#sym=platform.guard_state_row), [`platform.state_row_history_check`](../../../packages/kernel/sql/1110_state_rows_follow_published_machine.sql#sym=platform.state_row_history_check) | A state or history row not written by the engine or not along a published transition (`-072`, `-077`); a state row that differs from its latest history row at commit (`-078`). |
| [`platform.publish_machine_version`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.publish_machine_version), [`platform.protect_machine_definition`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.protect_machine_definition) | An invalid definition or an unregistered guard (`-062`, `-071`); any change to a published version (`-061`). |
| [`platform.guard_reason_given`](../../../packages/kernel/sql/0960_visible_reason_text.sql#sym=platform.guard_reason_given) | The built-in guard `platform.reason_given`: a transition without a visible reason code and text. |
| [`platform.register_hook`](../../../packages/kernel/sql/1150_platform_scope_hook.sql#sym=platform.register_hook) | A hook of the wrong kind or signature (`-004`). |

> **Why this exists** (trusted time)
> - **Pharma reason:** the time of an entry comes from a checked system clock, not from a device or a person; a late
>   entry says so and, beyond the window, a supervisor approves it (21 CFR 11.10(e); Annex 11 section 12.4).
> - **Control:** [DI-27](../../../compliance/controls/DI-27.yaml); invariant INV-16.
> - **Code:** [`platform.enforce_db_time`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.enforce_db_time),
>   [`platform.check_time_trust_source`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.check_time_trust_source),
>   [`platform.record_drift_check`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.record_drift_check);
>   TypeScript [`runDriftCheck`](../../../packages/kernel/src/time/drift-monitor.ts#sym=runDriftCheck).
> - **Tests:** [time-model.test.ts](../../../packages/kernel/test/platform/time-model.test.ts) (`[INV-16]`, `[DI-27]`),
>   [drift-monitor.test.ts](../../../packages/kernel/test/platform/drift-monitor.test.ts) (`[DI-27]`),
>   [site-time.test.ts](../../../packages/kernel/test/platform/site-time.test.ts), f42, f43, f47, f48, f49, f69.
> - **Error:** `EBMR-PLAT-009` to `-023`, `-030` to `-037`.

> **Why this exists** (state engine)
> - **Pharma reason:** a controlled record changes state only in allowed steps, by an authorised person, with its
>   signature, and the history of every step is kept (21 CFR 11.10(f), (g)).
> - **Control:** [DI-17](../../../compliance/controls/DI-17.yaml), [DI-37](../../../compliance/controls/DI-37.yaml).
> - **Code:** [`platform.transition`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.transition),
>   [`platform.guard_state_row`](../../../packages/kernel/sql/1110_state_rows_follow_published_machine.sql#sym=platform.guard_state_row);
>   TypeScript [`transition`](../../../packages/kernel/src/state/engine.ts#sym=transition).
> - **Tests:** [state-machine.test.ts](../../../packages/kernel/test/platform/state-machine.test.ts),
>   [machine-consistency.test.ts](../../../packages/kernel/test/platform/machine-consistency.test.ts),
>   [mutation/state-engine-rows.test.ts](../../../packages/kernel/test/mutation/state-engine-rows.test.ts).
> - **Error:** `EBMR-PLAT-060` to `-078`.

### The sample state machine

Machines are written in XState 5 in [src/state/machines/](../../../packages/kernel/src/state/machines/), published by a
generated migration ([0552](../../../packages/kernel/sql/0552_machine_sample_record_v1.sql)), and a consistency test
proves the XState definition and the database rows agree. The kernel's own sample:

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> SUBMITTED: SUBMIT
  SUBMITTED --> CHECKED: CHECK (signature CHECKED)
  SUBMITTED --> DRAFT: RETURN (reason)
  CHECKED --> APPROVED: APPROVE (signature APPROVED)
  CHECKED --> DRAFT: RETURN (reason)
  APPROVED --> SUPERSEDED: SUPERSEDE
  APPROVED --> RETIRED: RETIRE
```

### How to test it

`pnpm vitest run --project db packages/kernel/test/platform`. To write a new machine's seed:
`npx tsx packages/kernel/src/state/write-seeds.ts` (`--check` to verify). Outbox and idempotency tests need two pools
(see [test/harness/pools.ts](../../../packages/kernel/test/harness/pools.ts)).

### Pitfalls

- **Trust in time** (P1-F42, F43, F47, F48, F49, F69): a person must not claim a device time; entries across a clock
  step must be flagged; a silent monitor must alarm; nobody may pre-empt a time-fault incident.
- **Edit and transition must lock each other** (P1-F44): every function that changes content a guard reads takes the
  state row FOR SHARE first.
- **The engine flag is not proof** (P2 mutation D11): kernel 1110 checks the rows themselves.
- **No `Date.now()`** in domain code (CLAUDE.md); the X44 ticket defect shows why.
- An unused signature from an earlier stay in the same state is refused by
  [`platform.transition_signature_check`](../../../packages/kernel/sql/0910_integration_esig.sql#sym=platform.transition_signature_check).

## Continuity

### What it does

The `continuity` schema keeps identifiers unique across a restore, records restores, backups and restore drills, and
attests the hardening of shop-floor terminals. Numbers people see (batch numbers, contingency-form numbers) come from
protected counters whose ceilings are written first to an external, write-once ledger; a restored or copied database
issues nothing until its identifiers are secured. The area README is
[src/continuity/README.md](../../../packages/kernel/src/continuity/README.md).

### Pharma context

- 21 CFR 211.68(b) and Annex 11 section 7.2: data is backed up, and restore is tested and documented (DI-45).
- A batch number or signature id issued twice (for example, after a restore to an earlier point) would make two
  records look like one. INV-27: never reused.
- Annex 11 section 12 and 21 CFR 11.10 (security): terminals on the floor are hardened (kiosk mode) before use (DI-13).

### Main tables

| Table | What it holds |
|---|---|
| `continuity.protected_sequence`, `counter`, `ceiling_reservation` | Registered identifier sources, counters and the ceilings reserved in the ledger |
| `continuity.database_incarnation` | Which physical database is bound to the ledger |
| `continuity.restore_event`, `restore_event_approval`, `restore_completion`, `sequence_bump` | The restore procedure and the identifier moves |
| `continuity.alarm`, `alarm_acknowledgement` | Ledger, backup and chain-verification alarms |
| `continuity.backup_job_run`, `backup_catalogue`, `restore_drill` | Backup runs, the backup catalogue, drills |
| `continuity.device_hardening_attestation`, `device_hardening_revocation` | Kiosk hardening of SHARED and GRADE_A_B devices |

### Main functions and guards

| Function | What it refuses |
|---|---|
| [`continuity.next_counter_value`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.next_counter_value) | Issue with no ceiling left (`EBMR-CONT-011`) or under another database incarnation (`-012`). |
| [`continuity.reserve_counter_ceiling`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.reserve_counter_ceiling) | A ledger behind the database (`-013`), a ceiling that moves backwards (`-014`). |
| [`continuity.guard_identifiers_secured`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.guard_identifiers_secured) | Any audit write or anchor from a copy whose identifiers are not yet secured (`-017`). |
| [`continuity.approve_restore_event`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.approve_restore_event) | Approval by the operator, or without the approver's own RESTORE_APPROVED signature (`-021`, `-025`). |
| [`continuity.after_restore`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.after_restore) | Completion before approval, or with a ledger ahead (`-013`, `-022`, `-023`). |
| [`continuity.record_backup_job`](../../../packages/kernel/sql/0610_continuity_backup.sql#sym=continuity.record_backup_job), [`continuity.record_restore_drill`](../../../packages/kernel/sql/0610_continuity_backup.sql#sym=continuity.record_restore_drill) | Incomplete job or drill records (`-030`, `-031`). |
| [`continuity.assert_device_hardened`](../../../packages/kernel/sql/0620_continuity_device_hardening.sql#sym=continuity.assert_device_hardened) | A shop-floor device without a current hardening attestation (`-041`). |

> **Why this exists**
> - **Pharma reason:** backups are made and restores tested; a restore never brings back a number already given out
>   (21 CFR 211.68(b); Annex 11 section 7.2).
> - **Control:** [DI-45](../../../compliance/controls/DI-45.yaml), [DI-13](../../../compliance/controls/DI-13.yaml);
>   invariants INV-27, INV-08.
> - **Code:** [`continuity.next_counter_value`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.next_counter_value),
>   [`continuity.approve_restore_event`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.approve_restore_event);
>   TypeScript [`withProtectedNumbers`](../../../packages/kernel/src/continuity/numbers.ts#sym=withProtectedNumbers),
>   [`checkAgainstLedger`](../../../packages/kernel/src/continuity/restore.ts#sym=checkAgainstLedger).
> - **Tests:** [numbers.test.ts](../../../packages/kernel/test/continuity/numbers.test.ts) (`[INV-27]`),
>   [restore.test.ts](../../../packages/kernel/test/continuity/restore.test.ts) (a real pg_dump and pg_restore),
>   [backup-drill.test.ts](../../../packages/kernel/test/continuity/backup-drill.test.ts) (`[DI-45]`),
>   [hardening.test.ts](../../../packages/kernel/test/continuity/hardening.test.ts) (`[DI-13]`),
>   [f55](../../../packages/kernel/test/review/f55.test.ts) (a physical copy started by crash recovery).
> - **Error:** `EBMR-CONT-001` to `-042`.

### State machine of a restore

```mermaid
stateDiagram-v2
  [*] --> RECORDED: record_restore_event (identifiers secured first)
  RECORDED --> APPROVED: approve_restore_event (every named approver, never the operator)
  APPROVED --> COMPLETED: after_restore (moves sources past the ledger, re-enables issue)
```

### How to test it and pitfalls

`pnpm vitest run --project db packages/kernel/test/continuity`. Actor contexts come only from
[test/continuity/helpers.ts](../../../packages/kernel/test/continuity/helpers.ts). Pitfalls: a refused actor must
write nothing outside the database, so a reservation authorises and locks first, then writes the ledger; after any
server start the rest of a block is retired (a crash-recovery copy keeps the incarnation, P1-F55); the
`FileLedger` is demo-only.

## Authorization

### What it does

Migrations 0700 to 0720 connect the other kernel modules to the identity module. 0700 adds the permissions of the
market, records, continuity, batch-number and platform modules to the catalogue and maps them to roles (GMP,
ADMINISTRATION or GOVERNANCE domain). 0710 adds
[`iam.actor_location_scope`](../../../packages/kernel/sql/0710_authorization_scope_and_platform.sql#sym=iam.actor_location_scope)
(the site and room come from the enrolled device, never from the client) and the platform AUTHORITY adapter,
[`iam.platform_authority`](../../../packages/kernel/sql/1150_platform_scope_hook.sql#sym=iam.platform_authority) (now
in its 1150 version, which adds the record's own scope through the SCOPE hook). 0720 gives the approval signature
types the permissions they need and registers their content providers.

> **Why this exists**
> - **Pharma reason:** every protected action is checked against the actor's permission, in the scope of the object,
>   at the moment it happens (21 CFR 11.10(g); Annex 11 section 12.1).
> - **Control:** [DI-17](../../../compliance/controls/DI-17.yaml), [DI-18](../../../compliance/controls/DI-18.yaml).
> - **Code:** [`iam.platform_authority`](../../../packages/kernel/sql/1150_platform_scope_hook.sql#sym=iam.platform_authority),
>   [`iam.platform_permission_code`](../../../packages/kernel/sql/0710_authorization_scope_and_platform.sql#sym=iam.platform_permission_code).
> - **Tests:** [integration/authorization.test.ts](../../../packages/kernel/test/integration/authorization.test.ts)
>   (`[DI-17]`, `[DI-18]`), [scope-hook.test.ts](../../../packages/kernel/test/platform/scope-hook.test.ts).
> - **Error:** `EBMR-IAM-040`, `-043`, `EBMR-PLAT-006`.

Pitfall: a grant limited to a product never matched a platform transition until 1150 (the SCOPE hook). Phase 3 slice
3a found recipe-core with its own copy of the authority function; there is one adapter only.

## Sandbox

### What it does

Every database migrated with the kernel is marked GMP or SANDBOX once. The sandbox (`ebmr_sandbox_<edition>`) holds
test, training and simulation data; its own login role can never reach a GMP database. Sandbox identifiers start with
`TEST-`; a GMP database refuses them, and a sandbox refuses anything that reads as a real batch or lot number, also
inside free text, look-alike letters and right-to-left text. Every sandbox output carries the watermark
`TEST, NOT GMP`. The area README is [src/sandbox/README.md](../../../packages/kernel/src/sandbox/README.md).

### Pharma context

The FDA data-integrity guidance asks that non-GMP functions (training, testing) cannot influence GMP data; a test
record must never be mistaken for a real one. INV-18: test, simulation and training data live in a separate database.

> **Why this exists**
> - **Pharma reason:** a training or test record must never be taken for a real batch record, and real numbers must
>   never be used up in a test.
> - **Control:** [DI-05](../../../compliance/controls/DI-05.yaml); invariant INV-18.
> - **Code:** [`sandbox.guard_installation`](../../../packages/kernel/sql/0800_sandbox_installation.sql#sym=sandbox.guard_installation),
>   [`sandbox.identifier_problem_for`](../../../packages/kernel/sql/0810_sandbox_identifiers.sql#sym=sandbox.identifier_problem_for),
>   [`sandbox.guard_free_text`](../../../packages/kernel/sql/1120_sandbox_digit_words_ascii.sql#sym=sandbox.guard_free_text),
>   [`sandbox.segregation_problems`](../../../packages/kernel/sql/1100_segregation_problems_missing_roles.sql#sym=sandbox.segregation_problems);
>   TypeScript [`assertInstallationKind`](../../../packages/kernel/src/sandbox/installation.ts#sym=assertInstallationKind).
> - **Tests:** [installation.test.ts](../../../packages/kernel/test/sandbox/installation.test.ts),
>   [identifiers.test.ts](../../../packages/kernel/test/sandbox/identifiers.test.ts),
>   [identifier-words.test.ts](../../../packages/kernel/test/sandbox/identifier-words.test.ts),
>   [bypass.test.ts](../../../packages/kernel/test/sandbox/bypass.test.ts) (`[DI-05]`, `[INV-18]`).
> - **Error:** `EBMR-SBX-001` to `-038`.

Pitfall: the eight rounds of P2-F12 (see [Test mode isolation](../08-defect-log.md#test-mode-isolation-p2-f12-eight-rounds)).
Listing bad characters never ended; the fix that closed it allows only a small safe alphabet (in a sandbox, a word
with a digit is ASCII only, kernel 1120). Do not add another look-alike table; extend the safe-alphabet rule.

## Integration wiring

[0900_integration_wiring.sql](../../../packages/kernel/sql/0900_integration_wiring.sql) runs after every module
migration and connects the modules where one module's event must reach another in the same transaction: it registers
the kernel's externally visible sequences with continuity (INV-27), routes time faults to the incident register, and
wires the time-source validator permission. [0910](../../../packages/kernel/sql/0910_integration_esig.sql) installs the
SIGNATURE hook of the state engine, [0920](../../../packages/kernel/sql/0920_integration_sandbox.sql) the sandbox
identifier guard on person and device labels, and [0930](../../../packages/kernel/sql/0930_esig_engine_meanings.sql)
the signature meanings the recipe engine needs. Tests: [integration/wiring.test.ts](../../../packages/kernel/test/integration/wiring.test.ts).

## Inbound overrides and the LMS mirror (kernel 1181)

[1181_inbound_overrides_and_lms_mirror.sql](../../../packages/kernel/sql/1181_inbound_overrides_and_lms_mirror.sql)
(Phase 6 slice 6a, builder A; DI-31, DI-26, DI-14). `platform.inbound_override` is the register of manual overrides of
interface-captured values: a domain correction command (for example `site.correct_lot_receipt_value`) calls the
owner-only `platform.record_inbound_override` with the message, the record, the field, the original and the corrected
value and unit and the person's reason; a SERVICE or INTEGRATION account is refused (EBMR-INT-020), as are an empty
reason (021), an unknown message (022) and no new value (023). The rows are insert-only and audited on the adapter's
chain, so the integration side shows every override. `iam.qualification_source_fresh` now reads, for LMS rows while the
site runs LMS_QUALIFICATION as a MIRROR, the generic `platform.mirror_sync` with the data class's bound (STAND_IN keeps
the 0130 heartbeat); `iam.lms_mirror_problem()` gives the EBMR-INT-010 words for a stale LMS mirror. Tests:
[overrides-and-lms-mirror.test.ts](../../../packages/kernel/test/inbound/overrides-and-lms-mirror.test.ts). The inbound
framework itself (1180) is in [integrations](integrations.md#the-adapter-framework-phase-6-slice-6a-0).

## Configuration change control (kernel 1195)

[1195_configuration_change_control.sql](../../../packages/kernel/sql/1195_configuration_change_control.sql) (Phase 6
slice 6f, builder A; [DI-09](../../../compliance/controls/DI-09.yaml); defaults D-P6f-1, D-P6f-A-1 to A-4 in the
[phase 6 plan](../../build-plan/phase-6/phase-6-plan.md)). Every configuration change needs a change-record id.

- **Change records.** `platform.change_record` (insert-only: number, title, description, the configuration areas it may
  change) and `platform.change_record_event` (APPROVED, CLOSED). `platform.raise_change_record` (CONFIG.CHANGE_RAISE),
  `platform.approve_change_record(number, signature)` (CONFIG.CHANGE_APPROVE; the caller's own CONFIG_CHANGE_APPROVED
  e-signature of `config_change_record <number>` in state OPEN; never the raiser, EBMR-CFG-014) and
  `platform.close_change_record` (CONFIG.CHANGE_CLOSE). A record is OPEN, then APPROVED, then CLOSED.
- **The guard.** `platform.register_config_area(code, table, ...)` (owner-only, from migrations) puts a table under
  control: trigger `a00_config_change` (BEFORE INSERT OR UPDATE) calls `platform.require_change_record`, which refuses a
  row unless the validated actor context carries `change_record` naming an APPROVED, not CLOSED record covering the area
  (EBMR-CFG-001 none, -002 unknown, -003 not approved or closed, -004 another area). Rows written under the
  software-release identity (migrations) pass as a release. Because it is a trigger, every writer is covered, today's and
  later ones. TypeScript passes the number as `ActorContext.changeRecord` ([command.ts](../../../packages/kernel/src/db/command.ts)).
  Areas: PLATFORM_SETTING (with the 6a adapter modes and freshness bounds), IAM_POLICY, ESIG_POLICY, ESIG_MEANING,
  MARKET_POLICY, SITE_VALUE; [1196](../../../packages/kernel/sql/1196_config_areas_roles_retention.sql) adds ROLE,
  ROLE_PERMISSION (a removal is an update and becomes a version too), RETENTION_RULE_SET and RETENTION_RULE (lead
  decision D-P6f-A-9); recipe-core 1050 adds RBE_RULE. A person's role grant and a person-to-person delegation are not
  configuration (their own signed IAM acts).
- **Versions, as of and diff.** Trigger `zz_config_version` writes every configuration row to `platform.config_version`
  (insert-only: area, item key, value columns, the instant it became valid, basis CHANGE_RECORD, RELEASE or
  BEFORE_CONTROL, the change record). Existing rows were back-filled when each area was registered.
  `platform.config_as_of(at)` and `platform.config_diff(from, to)` read them; [config/change-control.ts](../../../packages/kernel/src/config/change-control.ts)
  wraps them.
- **Tests.** [change-control.test.ts](../../../packages/kernel/test/config/change-control.test.ts): refusals per
  precondition, bypass attempts as the application role, the approval rules, the diff for a past date, and two scans: every
  registered table carries both triggers, and every table named like configuration (`setting`, `policy`, `site_value`,
  `alarm_limit`, `rbe_rule`, `config` ...) is registered or listed with the reason it is not configuration. A new
  configuration table fails that scan until it is registered. Tests that set configuration for another purpose use the
  fixture record of [support/change-record.ts](../../../packages/kernel/test/support/change-record.ts) (`underChange`).

## Vendor support, the contract giver's reviewer and the India DSC (kernel 1202 to 1205)

Phase 6 slice 6f, builder B.

**Vendor support ([1202_support_grant.sql](../../../packages/kernel/sql/1202_support_grant.sql), [DI-08](../../../compliance/controls/DI-08.yaml),
D-P6f-2).** An account holding VENDOR_SUPPORT authenticates only inside a live `iam.support_grant`: requested by IT's
administrator (`iam.request_support_grant`, SUPPORT.GRANT_REQUEST) for one named HUMAN account, approved by two
signatures of two other people, QA (SUPPORT_ACCESS_QA_APPROVED: QA MBR approver or authorised person) and IT
(SUPPORT_ACCESS_IT_APPROVED: process owner), recorded by `iam.approve_support_grant` in the signing command. The second
approval writes `iam.support_grant_activation` with a window of 1 to `iam.support_grant_max_hours` (default 8) hours;
nothing extends it. `iam.authn_resolve` (replaced from 0160) refuses a support authentication outside a grant
(SUPPORT_NO_LIVE_GRANT) or for a signature (SUPPORT_CANNOT_SIGN), records the attempt and raises SUPPORT_ACCESS_REFUSED;
each support authentication raises SUPPORT_ACCESS_USED for review. A support session records its grant
(`iam.support_session`) and `iam.session_state` (replaced from 0160) answers EXPIRED once the grant has ended or was
revoked (`iam.revoke_support_grant`), so every command and read stops (EBMR-IAM-114). Messages EBMR-IAM-180 to -189.
Tests: [support-grant.test.ts](../../../packages/kernel/test/identity/support-grant.test.ts).

**The contract giver's reviewer ([1204_contract_giver_reviewer.sql](../../../packages/kernel/sql/1204_contract_giver_reviewer.sql),
[IN-30](../../../compliance/controls/IN-30.yaml)).** The role CONTRACT_GIVER_REVIEWER gains CONTRACT_GIVER.READ (READ_ONLY);
a trigger on `iam.role_permission` keeps the role at READ permissions only, whoever adds one (EBMR-IAM-190). QA grants
the access (CONTRACT_GIVER_ACCESS.GRANT); the access and the logged reads are recipe-core 1060.

**India DSC ([1203_india_dsc.sql](../../../packages/kernel/sql/1203_india_dsc.sql), [1205_dsc_configuration_areas.sql](../../../packages/kernel/sql/1205_dsc_configuration_areas.sql),
[IN-10](../../../compliance/controls/IN-10.yaml), decision 0001 item 3, D-P6f-3, D-P6f-4).** The policy `esig.india_dsc`
takes OFF (default), TEST_CA and LICENSED (`esig.policy_allowed_values`; `esig.set_policy` and `esig.policy_values`
replaced). TEST_CA needs a live `esig.dsc_trust_anchor` of that kind; LICENSED is refused until a licensed CA or eSign
provider is configured after the legal opinion (EBMR-ESIG-081). `esig.dsc_meaning_setting` says per meaning whether a DSC
is needed (default proposal: APPROVED and MANUFACTURER_RELEASE). For such a meaning the challenge carries the statement
`esig.dsc_statement` (canonical JSON of the challenge id, the content hash and the meaning); the signer's token signs it
through a local bridge; in the signing command the server verifies the chain to the anchor and the signature
([dsc.ts](../../../packages/kernel/src/esig/dsc.ts#sym=verifyDsc)) and `esig.record_dsc_signature` stores it after its own
checks (same transaction, the challenge's statement, the chain ending at the live anchor). A deferred trigger refuses to
commit such a signature without its DSC (EBMR-ESIG-084). The anchors and per-meaning settings are configuration areas
(DSC_ANCHOR, DSC_ANCHOR_RETIREMENT, DSC_MEANING) under change records. The test CA
([dsc-test-ca.ts](../../../packages/kernel/src/esig/dsc-test-ca.ts)) is generated at run time; it is never the CCA root and
its certificates are not legally valid (banner TEST_CA_BANNER). Messages EBMR-ESIG-080 to -085 (090 to 099 belong to the
stub of kernel 0250). Tests: [dsc.test.ts](../../../packages/kernel/test/esig/dsc.test.ts).

**DSC enrolment ([1206_dsc_signer_enrolment.sql](../../../packages/kernel/sql/1206_dsc_signer_enrolment.sql), review fix
of IN-10).** A DSC is accepted only from the certificate enrolled for the person who signs. The person enrols the
certificate of their own token in their own command: the token signs `esig.dsc_enrolment_statement` (the person and the
account), the server verifies chain and signature ([dsc.ts](../../../packages/kernel/src/esig/dsc.ts#sym=enrolDsc)) and
`esig.enrol_dsc_certificate` stores it (`esig.dsc_enrolment`, insert-only). A certificate is live for one person only
(EBMR-ESIG-086); a new enrolment ends the person's old one; an enrolment counts only under the anchor it was verified
against. `esig.end_dsc_enrolment` ends one (the person, or QA with MBR.APPROVE; EBMR-ESIG-088). `esig.record_dsc_signature`
(replaced) refuses a certificate that is not the signer's live enrolment (EBMR-ESIG-087).

> **Why this exists**
> - **Pharma reason:** supplier access is limited, approved by the regulated company and time-boxed (Annex 11, 21 CFR
>   11.10(d)); the IT Act recognises a digital signature with a licensed CA's certificate (sections 3A and 5, paraphrased).
> - **Control:** DI-08, IN-30, IN-10.

## Installation

[0001_bootstrap.sql](../../../packages/kernel/sql/0001_bootstrap.sql) creates the roles and schemas.
[0970](../../../packages/kernel/sql/0970_backend_signal_policy.sql) takes `pg_cancel_backend` and
`pg_terminate_backend` away from every role but a superuser
([`kernel.backend_signals_restricted`](../../../packages/kernel/sql/0970_backend_signal_policy.sql#sym=kernel.backend_signals_restricted)
reports it; the Tablets manual weighing refuses while it is not in place).
[0980](../../../packages/kernel/sql/0980_listener_login_roles.sql) creates the evidence-listener login roles and their
connection shares ([`kernel.apply_listener_share`](../../../packages/kernel/sql/0980_listener_login_roles.sql#sym=kernel.apply_listener_share),
`EBMR-SBX-036`, `-037`). [1111](../../../packages/kernel/sql/1111_connect_policy_unknown_grantee.sql) refuses a grant to
an unknown role oid (`EBMR-SBX-038`). The runner is [src/db/migrate.ts](../../../packages/kernel/src/db/migrate.ts);
[test/db/migrate-concurrency.test.ts](../../../packages/kernel/test/db/migrate-concurrency.test.ts) proves two runners
do not apply a migration twice. Security tests: [test/security/](../../../packages/kernel/test/security/).

## Guard catalogue

Every kernel function in force that raises an `EBMR-` code, with the migration that holds the version in force, each
code with the start of its message, and the controls whose register entry names the function. A function that calls
`iam.require_permission` or `iam.assert_not_administrator` also raises `EBMR-IAM-040` or `-042` through them; those
are not repeated. Generated from the migrations on 14 October 2026; check a row against the code before relying on it.
A control column left empty means the register does not name the function; see the area's box above for its control.

### Guards: Audit trail

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`kernel.append_audit_event`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.append_audit_event) | 0010 | `AUDIT-001` no actor context: call kernel.begin_command first<br>`AUDIT-009` the actor context was not established by kernel.begin_command in this transaction |  |
| [`kernel.audit_business_event`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.audit_business_event) | 0010 | `AUDIT-006` a business audit entry needs a message |  |
| [`kernel.audit_row_change`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.audit_row_change) | 0010 | `AUDIT-001` no actor context: call kernel.begin_command first<br>`AUDIT-002` a reason is required to … …: give a reason code and a reason text<br>`AUDIT-003` … is not registered for audit<br>`AUDIT-009` the actor context was not established by kernel.begin_command in this transaction | [DI-22](../../../compliance/controls/DI-22.yaml) |
| [`kernel.begin_command`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.begin_command) | 0010 | `AUDIT-001` actor context is required<br>`AUDIT-005` an audit trigger is missing or disabled; GMP writes are refused | [DI-22](../../../compliance/controls/DI-22.yaml) |
| [`kernel.checkpoint_chain`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.checkpoint_chain) | 0010 | `AUDIT-007` chain … does not verify; it cannot be checkpointed<br>`AUDIT-008` chain … has no events | [DI-17](../../../compliance/controls/DI-17.yaml), [DI-50](../../../compliance/controls/DI-50.yaml) |
| [`kernel.reject_mutation`](../../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.reject_mutation) | 0010 | `AUDIT-004` … is insert-only; record a correction instead of … | [PR-06](../../../compliance/controls/PR-06.yaml) |
| [`platform.guard_reason_given`](../../../packages/kernel/sql/0960_visible_reason_text.sql#sym=platform.guard_reason_given) | 0960 | `AUDIT-002` ) |  |

### Guards: Identity and access

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`iam.assert_validated_actor`](../../../packages/kernel/sql/0100_iam_foundation.sql#sym=iam.assert_validated_actor) | 0100 | `IAM-001` no actor context: call kernel.begin_command first<br>`IAM-002` the actor context was not established by kernel.begin_command in this transaction |  |
| [`iam.check_scope`](../../../packages/kernel/sql/0100_iam_foundation.sql#sym=iam.check_scope) | 0100 | `IAM-004` a scope must be a JSON object with keys site, area, product |  |
| [`iam.forbid_change`](../../../packages/kernel/sql/0100_iam_foundation.sql#sym=iam.forbid_change) | 0100 | `IAM-006` … is an insert-only log (… refused) |  |
| [`iam.forbid_removal`](../../../packages/kernel/sql/0100_iam_foundation.sql#sym=iam.forbid_removal) | 0100 | `IAM-005` rows of … are never deleted (… refused) |  |
| [`iam.policy_text`](../../../packages/kernel/sql/0100_iam_foundation.sql#sym=iam.policy_text) | 0100 | `IAM-110` unknown policy key … |  |
| [`iam.account_guard`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.account_guard) | 0110 | `IAM-003` nobody creates or administers their own account<br>`IAM-007` account identity, person, login name, kind and flags never change<br>`IAM-011` accounts are created only for active persons<br>`IAM-013` the person has no identity-verification record; the account cannot be activated<br>`IAM-021` the login name must be issued to this account in the identifier register<br>`IAM-023` a new account starts PENDING_ACTIVATION<br>`IAM-024` INV-11: the person already has a live GMP-capable account; disable it before creating a...<br>`IAM-027` service and integration accounts belong to system identities; human and display account... | [DI-15](../../../compliance/controls/DI-15.yaml) |
| [`iam.create_account`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.create_account) | 0110 | `IAM-021` login name … was issued before and is never issued again, even after deactivation or a... |  |
| [`iam.identifier_register_guard`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.identifier_register_guard) | 0110 | `IAM-021` login name … was issued before the last restore and is never issued again |  |
| [`iam.identity_verification_guard`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.identity_verification_guard) | 0110 | `IAM-012` an identity check cannot be dated in the future |  |
| [`iam.normalize_login_name`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.normalize_login_name) | 0110 | `IAM-020` a login name has 3-64 characters: letters, digits, dot, underscore or hyphen, starting... |  |
| [`iam.person_guard`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.person_guard) | 0110 | `IAM-003` nobody administers their own person record<br>`IAM-007` person id, kind and creation time never change<br>`IAM-010` a new person starts ACTIVE |  |
| [`iam.record_identity_verification`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.record_identity_verification) | 0110 | `IAM-010` identity verification applies to a known natural person |  |
| [`iam.reinstate_account`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.reinstate_account) | 0110 | `IAM-023` only a suspended account can be reinstated |  |
| [`iam.rename_person`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.rename_person) | 0110 | `IAM-010` unknown person |  |
| [`iam.reserve_identifiers`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.reserve_identifiers) | 0110 | `IAM-004` a reason is required<br>`IAM-020` the login names to reserve must be a JSON array |  |
| [`iam.set_account_status`](../../../packages/kernel/sql/0110_iam_persons_accounts.sql#sym=iam.set_account_status) | 0110 | `IAM-004` a reason is required<br>`IAM-022` unknown account |  |
| [`iam.add_role_permission`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.add_role_permission) | 0120 | `IAM-004` a reason is required<br>`IAM-039` adding … to role … is already requested |  |
| [`iam.catalogue_guard`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.catalogue_guard) | 0120 | `IAM-007` a permission |  |
| [`iam.check_role_permission_addition`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.check_role_permission_addition) | 0120 | `IAM-030` unknown permission …<br>`IAM-033` INV-11/DI-18: role … cannot combine administration and GMP permissions (…)<br>`IAM-034` DI-14: generic or display account … holds role …; … cannot be added<br>`IAM-035` DI-14: service account … holds role …; … cannot be added<br>`IAM-036` DI-18: break-glass account … holds role …; … cannot be added |  |
| [`iam.check_static_segregation`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.check_static_segregation) | 0120 | `IAM-022` unknown account<br>`IAM-026` a disabled account receives no grants<br>`IAM-030` unknown role …<br>`IAM-033` INV-11/DI-18: role … combines administration and GMP permissions and cannot be granted<br>`IAM-034` DI-14: account … is generic or a read-only display and cannot hold role …, which writes...<br>`IAM-035` DI-14: service or integration account … cannot hold role …, which signs or acknowledges<br>`IAM-036` DI-18: break-glass account … cannot hold role … | [DI-14](../../../compliance/controls/DI-14.yaml), [DI-18](../../../compliance/controls/DI-18.yaml) |
| [`iam.decide_role_grant`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.decide_role_grant) | 0120 | `IAM-031` unknown grant |  |
| [`iam.decide_role_permission`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.decide_role_permission) | 0120 | `IAM-039` unknown role-permission request |  |
| [`iam.recertification_guard`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.recertification_guard) | 0120 | `IAM-003` nobody recertifies their own access |  |
| [`iam.recertify_account`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.recertify_account) | 0120 | `IAM-022` unknown account | [DI-16](../../../compliance/controls/DI-16.yaml) |
| [`iam.remove_role_permission`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.remove_role_permission) | 0120 | `IAM-030` the role does not hold that permission |  |
| [`iam.request_role_grant`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.request_role_grant) | 0120 | `IAM-022` unknown account |  |
| [`iam.revoke_role_grant`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.revoke_role_grant) | 0120 | `IAM-037` only an approved grant can be revoked | [DI-16](../../../compliance/controls/DI-16.yaml) |
| [`iam.role_grant_guard`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.role_grant_guard) | 0120 | `IAM-003` nobody requests a role for their own account<br>`IAM-026` a grant is approved only for an active account; this account is …<br>`IAM-031` the grant<br>`IAM-032` a grant is decided by a second person: never the grantee, never the requester<br>`IAM-037` a grant starts as a request; a second person approves it<br>`IAM-038` what was requested and approved never changes; revoke and request again | [DI-16](../../../compliance/controls/DI-16.yaml) |
| [`iam.role_permission_guard`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.role_permission_guard) | 0120 | `IAM-007` a role permission can only be removed, once<br>`IAM-039` DI-18: … reaches role … only through a request approved by a second person |  |
| [`iam.role_permission_request_guard`](../../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.role_permission_request_guard) | 0120 | `IAM-003` DI-18: nobody requests a permission for a role they hold (…)<br>`IAM-030` role … already holds …<br>`IAM-032` a role-permission request is decided by a second person: never the requester, never a h...<br>`IAM-039` a permission is added to a role on request; a second person approves it |  |
| [`iam.acknowledge_alert`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.acknowledge_alert) | 0130 | `IAM-003` nobody acknowledges a security alert about themselves<br>`IAM-150` unknown alert |  |
| [`iam.assert_not_administrator`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.assert_not_administrator) | 0130 | `IAM-042` DI-18: administrator role … never creates or changes GMP data | [DI-18](../../../compliance/controls/DI-18.yaml) |
| [`iam.end_qualification_requirement`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.end_qualification_requirement) | 0130 | `IAM-160` no live requirement with that id |  |
| [`iam.qualification_guard`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.qualification_guard) | 0130 | `IAM-160` a qualification is recorded before it can be withdrawn |  |
| [`iam.record_mirror_heartbeat`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.record_mirror_heartbeat) | 0130 | `IAM-160` unknown mirror source |  |
| [`iam.record_qualification`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.record_qualification) | 0130 | `IAM-003` nobody records their own qualification |  |
| [`iam.require_permission`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.require_permission) | 0130 | `IAM-040` … acting as … lacks permission … in scope …: … | [DI-17](../../../compliance/controls/DI-17.yaml) |
| [`iam.withdraw_qualification`](../../../packages/kernel/sql/0130_iam_qualifications_authority.sql#sym=iam.withdraw_qualification) | 0130 | `IAM-160` no live qualification record with that id |  |
| [`iam.check_device_location`](../../../packages/kernel/sql/0140_iam_devices.sql#sym=iam.check_device_location) | 0140 | `IAM-070`<br>`IAM-071`<br>`IAM-073` | [DI-20](../../../compliance/controls/DI-20.yaml) |
| [`iam.device_guard`](../../../packages/kernel/sql/0140_iam_devices.sql#sym=iam.device_guard) | 0140 | `IAM-007` a device<br>`IAM-071` a device is registered ACTIVE |  |
| [`iam.relocate_device`](../../../packages/kernel/sql/0140_iam_devices.sql#sym=iam.relocate_device) | 0140 | `IAM-070` unknown device |  |
| [`iam.resolve_device`](../../../packages/kernel/sql/0140_iam_devices.sql#sym=iam.resolve_device) | 0140 | `IAM-070`<br>`IAM-071` | [DI-20](../../../compliance/controls/DI-20.yaml) |
| [`iam.set_device_status`](../../../packages/kernel/sql/0140_iam_devices.sql#sym=iam.set_device_status) | 0140 | `IAM-004` a reason is required<br>`IAM-070` unknown device |  |
| [`iam.approve_break_glass`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.approve_break_glass) | 0150 | `IAM-130` no pending break-glass request with that id |  |
| [`iam.badge_guard`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.badge_guard) | 0150 | `IAM-003` nobody administers their own badge<br>`IAM-007` a badge record never changes except its status<br>`IAM-013` DI-15: no identity-verification record; no badge can be issued<br>`IAM-060` badge technology … is clonable and not accepted<br>`IAM-061` a badge is issued, then tested, then activated<br>`IAM-062` DI-19: a badge is activated only after a passing test at issue<br>`IAM-063` the identity verification is for another person | [DI-15](../../../compliance/controls/DI-15.yaml) |
| [`iam.badge_test_guard`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.badge_test_guard) | 0150 | `IAM-003` nobody records a test of their own badge |  |
| [`iam.badge_uid_hash`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.badge_uid_hash) | 0150 | `IAM-060` a badge UID is 8-64 hexadecimal digits |  |
| [`iam.break_glass_guard`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.break_glass_guard) | 0150 | `IAM-003` the break-glass holder cannot approve their own window<br>`IAM-007` a break-glass request never changes<br>`IAM-130` break-glass windows are for break-glass accounts only |  |
| [`iam.check_verifier`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.check_verifier) | 0150 | `IAM-050` a verifier must be an argon2id (v=19) PHC string; plaintext is never stored | [DI-15](../../../compliance/controls/DI-15.yaml) |
| [`iam.credential_guard`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.credential_guard) | 0150 | `IAM-003` a user changes only their own secret, and an administrator never issues a secret to the...<br>`IAM-051` a credential is issued ACTIVE |  |
| [`iam.issue_badge`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.issue_badge) | 0150 | `IAM-060` this badge UID was issued before and is never issued again<br>`IAM-061` badges are issued to personal human accounts that are not disabled<br>`IAM-063` a replacement replaces a badge of the same person |  |
| [`iam.issue_credential`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.issue_credential) | 0150 | `IAM-013` DI-15: no identity-verification record; no signature component can be issued<br>`IAM-022` unknown account<br>`IAM-026` a disabled account receives no credentials<br>`IAM-051` service and integration accounts use service keys only; people use passwords and PINs | [DI-15](../../../compliance/controls/DI-15.yaml) |
| [`iam.lock_badge_and_account`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.lock_badge_and_account) | 0150 | `IAM-061` unknown badge |  |
| [`iam.report_badge_lost`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.report_badge_lost) | 0150 | `IAM-061` unknown badge |  |
| [`iam.request_break_glass`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.request_break_glass) | 0150 | `IAM-130` a break-glass window is requested by the holder of that break-glass account |  |
| [`iam.review_break_glass`](../../../packages/kernel/sql/0150_iam_credentials_badges.sql#sym=iam.review_break_glass) | 0150 | `IAM-130` no unreviewed break-glass window with that id |  |
| [`iam.authn_finish`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.authn_finish) | 0160 | `IAM-140` |  |
| [`iam.authn_record_refusal`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.authn_record_refusal) | 0160 | `IAM-140` |  |
| [`iam.authn_resolve`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.authn_resolve) | 0160 | `IAM-094` a signature authentication is bound to exactly one challenge; other purposes take none<br>`IAM-096` unknown authentication method or purpose | [DI-14](../../../compliance/controls/DI-14.yaml) |
| [`iam.consume_auth_event`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.consume_auth_event) | 0160 | `IAM-091` the authentication event has already been used<br>`IAM-092` the authentication event is too old<br>`IAM-093` the authentication event belongs to another person (no proxy signing)<br>`IAM-094` the authentication event is bound to another challenge<br>`IAM-096` the authentication event was not made for a signature | [DI-15](../../../compliance/controls/DI-15.yaml), [DI-38](../../../compliance/controls/DI-38.yaml) |
| [`iam.keep_session_alive`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.keep_session_alive) | 0160 | `IAM-082` the session is …<br>`IAM-120` extending a shop-floor session needs a badge tap | [DI-16](../../../compliance/controls/DI-16.yaml) |
| [`iam.lock_auth_event`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.lock_auth_event) | 0160 | `IAM-090` unknown authentication event<br>`IAM-097` DI-19: the badge that made the authentication event is no longer active (lost, revoked...<br>`IAM-103` the account of the authentication event is no longer active or is locked |  |
| [`iam.open_session`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.open_session) | 0160 | `IAM-052` the secret must be changed before a session can open<br>`IAM-091` the authentication event has been used<br>`IAM-092` the authentication event is too old<br>`IAM-095` the login was authenticated on another device<br>`IAM-096` the authentication event was not made to log in<br>`IAM-130` the break-glass window has closed |  |
| [`iam.session_guard`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.session_guard) | 0160 | `IAM-080` a session opens unlocked<br>`IAM-081` a session changes only its lock state and ends once |  |
| [`iam.unlock_account`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.unlock_account) | 0160 | `IAM-003` nobody unlocks their own account<br>`IAM-004` a reason is required<br>`IAM-105` the account is not locked |  |
| [`iam.unlock_session`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.unlock_session) | 0160 | `IAM-081` the session is …; log in again<br>`IAM-084` only the session<br>`IAM-091` the authentication event has been used<br>`IAM-092` the authentication event is too old<br>`IAM-096` the authentication event was not made to unlock a session | [DI-16](../../../compliance/controls/DI-16.yaml) |
| [`iam.use_auth_event_for_command`](../../../packages/kernel/sql/0160_iam_authentication_sessions.sql#sym=iam.use_auth_event_for_command) | 0160 | `IAM-122` INV-40: the authentication event belongs to another person or account<br>`IAM-123` INV-40: the authentication event was made on another device<br>`IAM-124` INV-40: the authentication event was not made to attribute a command<br>`IAM-125` INV-40: the authentication event is older than …<br>`IAM-126` INV-40: the authentication event has already attributed another command | [DI-14](../../../compliance/controls/DI-14.yaml) |
| [`iam.acknowledge_esig_policy`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.acknowledge_esig_policy) | 0170 | `IAM-054` only personal human accounts sign, so only they acknowledge the policy | [DI-21](../../../compliance/controls/DI-21.yaml) |
| [`iam.assert_can_sign`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.assert_can_sign) | 0170 | `IAM-054` the account cannot sign: … | [DI-15](../../../compliance/controls/DI-15.yaml), [DI-21](../../../compliance/controls/DI-21.yaml) |
| [`iam.assert_segregated`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.assert_segregated) | 0170 | `IAM-041` …: this person is involved in … and cannot perform this act | [DI-17](../../../compliance/controls/DI-17.yaml) |
| [`iam.assert_us_esig_certification`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.assert_us_esig_certification) | 0170 | `IAM-170` no 21 CFR 11.100(c) certification is on file for …; US-market batches cannot be issued | [DI-15](../../../compliance/controls/DI-15.yaml) |
| [`iam.decide_delegation`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.decide_delegation) | 0170 | `IAM-180` no pending delegation with that id |  |
| [`iam.delegation_guard`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.delegation_guard) | 0170 | `IAM-180` a delegation starts as a request<br>`IAM-181` no re-delegation: the delegator holds these meanings only by delegation<br>`IAM-182` a delegation is approved by someone other than the delegate, the delegator and the requ... |  |
| [`iam.record_us_esig_certification`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.record_us_esig_certification) | 0170 | `IAM-170` a submission date cannot be in the future |  |
| [`iam.request_delegation`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.request_delegation) | 0170 | `IAM-180` only a person who holds signing authority can delegate it |  |
| [`iam.revoke_delegation`](../../../packages/kernel/sql/0170_iam_signing_readiness.sql#sym=iam.revoke_delegation) | 0170 | `IAM-180` no approved delegation with that id |  |
| [`iam.deactivate_account`](../../../packages/kernel/sql/0180_iam_lifecycle.sql#sym=iam.deactivate_account) | 0180 | `IAM-004` a reason is required<br>`IAM-022` unknown account | [DI-16](../../../compliance/controls/DI-16.yaml) |
| [`iam.process_leaver`](../../../packages/kernel/sql/0180_iam_lifecycle.sql#sym=iam.process_leaver) | 0180 | `IAM-004` a reason is required<br>`IAM-011` no active person with that id | [DI-16](../../../compliance/controls/DI-16.yaml) |
| [`iam.rehire_person`](../../../packages/kernel/sql/0180_iam_lifecycle.sql#sym=iam.rehire_person) | 0180 | `IAM-011` no person who left with that id |  |
| [`kernel.validate_actor_context`](../../../packages/kernel/sql/0190_iam_actor_context.sql#sym=kernel.validate_actor_context) | 0190 | `IAM-100` the actor context holds a malformed identifier<br>`IAM-101` unknown account in the actor context<br>`IAM-102` the account does not belong to the person in the actor context<br>`IAM-103` the account is …<br>`IAM-104` the person has left<br>`IAM-105` the account is locked<br>`IAM-106` DI-14: a generic or read-only display account cannot create, change, sign, verify or ac...<br>`IAM-107` source … cannot be used by a … account<br>`IAM-108` the account does not hold role … now<br>`IAM-110` unknown session in the actor context<br>`IAM-111` the session belongs to another account<br>`IAM-112` the session has ended (…)<br>`IAM-113` the session is locked; unlock it by authenticating again<br>`IAM-114` the session reached its absolute timeout; log in again<br>`IAM-115` the session<br>`IAM-116` DI-20: the actor context must name the session<br>`IAM-117` legal_name in the actor context is not the person<br>`IAM-118` DI-27: the actor context declares the time zone …, but the site<br>`IAM-120` INV-40: every command on a … device needs a fresh authentication event of the person<br>`IAM-130` the break-glass window is closed | [DI-14](../../../compliance/controls/DI-14.yaml), [DI-20](../../../compliance/controls/DI-20.yaml) |
| [`iam.assert_site_zone`](../../../packages/kernel/sql/0940_site_zone_policy_check.sql#sym=iam.assert_site_zone) | 0940 | `IAM-119` DI-27: site.zone takes an IANA time zone name (Area/Location in a geographic area, or U... |  |
| [`iam.set_policy`](../../../packages/kernel/sql/0940_site_zone_policy_check.sql#sym=iam.set_policy) | 0940 | `IAM-110` unknown policy key …<br>`IAM-111` DI-19: password aging or compromised-password screening must be active; this change wou... |  |
| [`iam.site_zone_row_guard`](../../../packages/kernel/sql/0940_site_zone_policy_check.sql#sym=iam.site_zone_row_guard) | 0940 | `IAM-119` DI-27: the site policy site.zone holds …, which is not an IANA time zone name (Area/Loc... |  |
| [`iam.change_event_check`](../../../packages/kernel/sql/0990_shared_terminal_secret_change_window.sql#sym=iam.change_event_check) | 0990 | `IAM-091` the authentication event has been used<br>`IAM-092` the authentication event is too old<br>`IAM-096` the authentication event was not made to change a secret | [DI-15](../../../compliance/controls/DI-15.yaml) |
| [`iam.bootstrap_installation`](../../../packages/kernel/sql/1000_sandbox_bootstrap_labels.sql#sym=iam.bootstrap_installation) | 1000 | `IAM-118` DI-27: the actor context declares the time zone …, but the site<br>`IAM-190` the installation is already bootstrapped |  |

### Guards: Electronic signatures

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`esig.content_for_signing`](../../../packages/kernel/sql/0200_esig_foundation.sql#sym=esig.content_for_signing) | 0200 | `ESIG-014` … names the record by another id than its own: … |  |
| [`esig.forbid_change`](../../../packages/kernel/sql/0200_esig_foundation.sql#sym=esig.forbid_change) | 0200 | `ESIG-001` … is insert-only (… refused) |  |
| [`esig.policy_text`](../../../packages/kernel/sql/0200_esig_foundation.sql#sym=esig.policy_text) | 0200 | `ESIG-002` unknown e-signature policy key … |  |
| [`esig.provide`](../../../packages/kernel/sql/0200_esig_foundation.sql#sym=esig.provide) | 0200 | `ESIG-004` the content provider of … returned an invalid result |  |
| [`esig.register_content_provider`](../../../packages/kernel/sql/0200_esig_foundation.sql#sym=esig.register_content_provider) | 0200 | `ESIG-003` … must have the provider signature (aggregate_id text) returns jsonb |  |
| [`esig.configure_meaning_type`](../../../packages/kernel/sql/0210_esig_catalogue.sql#sym=esig.configure_meaning_type) | 0210 | `ESIG-005` a change to the signature catalogue needs a reason | [DI-35](../../../compliance/controls/DI-35.yaml) |
| [`esig.current_meaning`](../../../packages/kernel/sql/0210_esig_catalogue.sql#sym=esig.current_meaning) | 0210 | `ESIG-026` … is not a signature type of the catalogue; only catalogue types can be signed (no plai... | [DI-35](../../../compliance/controls/DI-35.yaml) |
| [`esig.meaning_type_guard`](../../../packages/kernel/sql/0210_esig_catalogue.sql#sym=esig.meaning_type_guard) | 0210 | `ESIG-020` customer signature types are added through esig.add_meaning_type<br>`ESIG-021` the first version of … is version 1<br>`ESIG-022` … belongs to the minimum set and cannot be removed or disabled<br>`ESIG-023` the meaning of minimum type … is fixed<br>`ESIG-024` … belongs to the minimum set: its independence, re-authentication, witness and delegati...<br>`ESIG-025` … is not a GMP signing or data-entry permission of the identity catalogue | [DI-35](../../../compliance/controls/DI-35.yaml) |
| [`esig.set_policy`](../../../packages/kernel/sql/0210_esig_catalogue.sql#sym=esig.set_policy) | 0210 | `ESIG-002` unknown e-signature policy key …<br>`ESIG-005` a policy change needs a reason and a change-control reference | [DI-38](../../../compliance/controls/DI-38.yaml) |
| [`esig.assert_change_triggers_ok`](../../../packages/kernel/sql/0220_esig_signatures.sql#sym=esig.assert_change_triggers_ok) | 0220 | `ESIG-008` an invalidation trigger of a signed table is missing or disabled; signing is refused un... | [DI-37](../../../compliance/controls/DI-37.yaml) |
| [`esig.forbid_truncate`](../../../packages/kernel/sql/0220_esig_signatures.sql#sym=esig.forbid_truncate) | 0220 | `ESIG-007` … holds signed content and cannot be truncated |  |
| [`esig.on_signed_content_change`](../../../packages/kernel/sql/0220_esig_signatures.sql#sym=esig.on_signed_content_change) | 0220 | `ESIG-006` … is not registered as a signed table | [DI-37](../../../compliance/controls/DI-37.yaml) |
| [`esig.register_signed_table`](../../../packages/kernel/sql/0220_esig_signatures.sql#sym=esig.register_signed_table) | 0220 | `ESIG-006` … has no column … | [DI-37](../../../compliance/controls/DI-37.yaml) |
| [`esig.signature_sealed_check`](../../../packages/kernel/sql/0220_esig_signatures.sql#sym=esig.signature_sealed_check) | 0220 | `ESIG-061` signature … was not sealed; the signing is rolled back (INV-10) |  |
| [`esig.assert_signature`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.assert_signature) | 0230 | `ESIG-070` | [DI-01](../../../compliance/controls/DI-01.yaml), [DI-37](../../../compliance/controls/DI-37.yaml), [DI-45](../../../compliance/controls/DI-45.yaml) |
| [`esig.check_independence`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.check_independence) | 0230 | `ESIG-042` this person already holds a valid … signature on …<br>`ESIG-043` … must be signed by a person other than the signers of … on this record<br>`ESIG-044` INV-03: … is never signed by a person who performed, entered data in or corrected the r...<br>`ESIG-045` a person involved in the record cannot sign … (outline 7.2 S10) | [DI-35](../../../compliance/controls/DI-35.yaml) |
| [`esig.check_witness`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.check_witness) | 0230 | `ESIG-050` the record names no witnessed act (terminal and time); sign VERIFIED for recorded evide...<br>`ESIG-051` the next step has started (or the record cannot show that it has not), so the act can n...<br>`ESIG-052` late witness: the act was recorded at … and the witness window is … (raise an exception...<br>`ESIG-053` the act names terminal …, which is not a registered terminal, so nobody can be shown to... | [DI-35](../../../compliance/controls/DI-35.yaml) |
| [`esig.create_challenge`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.create_challenge) | 0230 | `ESIG-010` unknown signer account<br>`ESIG-011` …:… does not exist or has no content provider<br>`ESIG-012` the record is at content version …, not …: review the current content before signing<br>`ESIG-013` the content shown to the signer differs from the record on the server; nothing is signed<br>`ESIG-014` …:… names the record by another id than its own (…); a record is signed only under its... | [DI-35](../../../compliance/controls/DI-35.yaml), [DI-37](../../../compliance/controls/DI-37.yaml) |
| [`esig.manifestation`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.manifestation) | 0230 | `ESIG-070` signature … does not exist | [DI-36](../../../compliance/controls/DI-36.yaml) |
| [`esig.record_signing_failure`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.record_signing_failure) | 0230 | `ESIG-031` unknown signature challenge: a signing failure is logged against its challenge | [DI-17](../../../compliance/controls/DI-17.yaml), [DI-19](../../../compliance/controls/DI-19.yaml), [DI-50](../../../compliance/controls/DI-50.yaml) |
| [`esig.seal_signature`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.seal_signature) | 0230 | `ESIG-062` only a signature applied in this transaction can be sealed<br>`ESIG-063` seal key … (…) is not registered or has been retired<br>`ESIG-064` the seal is not a base64 … value |  |
| [`esig.sign`](../../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.sign) | 0230 | `ESIG-011` … no longer exists<br>`ESIG-012` the record changed after the challenge was issued; review the current content before si...<br>`ESIG-030` a signature needs its challenge and a fresh authentication of the signer (no signing wi...<br>`ESIG-031` unknown signature challenge<br>`ESIG-032` the challenge has already been used; request a new one<br>`ESIG-033` the challenge expired at …; request a new one<br>`ESIG-034` the challenge belongs to another session or terminal<br>`ESIG-035` the command declares zone … but the site zone is …<br>`ESIG-036` the authentication event belongs to another account than the challenge names<br>`ESIG-037` signature type … changed since the challenge; request a new one<br>`ESIG-038` …: this signing needs … (…); the authentication used …<br>`ESIG-039` the record is in state …, not the expected …<br>`ESIG-040` the signer is not authorised to sign … now: …<br>`ESIG-041` … cannot be signed under a delegation | [DI-19](../../../compliance/controls/DI-19.yaml), [DI-35](../../../compliance/controls/DI-35.yaml), [DI-36](../../../compliance/controls/DI-36.yaml), [DI-37](../../../compliance/controls/DI-37.yaml), [DI-38](../../../compliance/controls/DI-38.yaml) |
| [`esig.evidence_package`](../../../packages/kernel/sql/0240_esig_integrity.sql#sym=esig.evidence_package) | 0240 | `ESIG-070` signature … does not exist | [DI-13](../../../compliance/controls/DI-13.yaml) |
| [`esig.stub_complete`](../../../packages/kernel/sql/0250_esig_stub.sql#sym=esig.stub_complete) | 0250 | `ESIG-091` entry … does not exist<br>`ESIG-092` completing a … entry needs a … signature; an acknowledgement or any other token cannot...<br>`ESIG-093` entry … has no valid … signature | [DI-35](../../../compliance/controls/DI-35.yaml) |
| [`esig.stub_signable_guard`](../../../packages/kernel/sql/0250_esig_stub.sql#sym=esig.stub_signable_guard) | 0250 | `ESIG-090` the identity, kind and creation time of an entry never change |  |
| [`esig.signing_misuse`](../../../packages/kernel/sql/0950_signing_failure_own_command.sql#sym=esig.signing_misuse) | 0950 | `ESIG-036`<br>`ESIG-038`<br>`IAM-091`<br>`IAM-093`<br>`IAM-094` | [DI-19](../../../compliance/controls/DI-19.yaml) |
| [`esig.aggregate_lock`](../../../packages/kernel/sql/1020_esig_lock_read_committed.sql#sym=esig.aggregate_lock) | 1020 | `ESIG-015` a signature, and a change of signed content, are made only in a READ COMMITTED transact... |  |
| [`esig.signature_guard`](../../../packages/kernel/sql/1112_signature_row_backed_by_its_challenge.sql#sym=esig.signature_guard) | 1112 | `ESIG-060` INV-10: signatures are inserted only by the signing function esig.sign<br>`ESIG-065` INV-10: a signature names exactly the record, content, meaning, signer, session and ter...<br>`ESIG-066` INV-10: a signature consumes, in its own transaction, an authentication event of its si... | [DI-36](../../../compliance/controls/DI-36.yaml) |

### Guards: Market rules

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`market.checked_market_set`](../../../packages/kernel/sql/0300_market_rule_model.sql#sym=market.checked_market_set) | 0300 | `MKT-001` a market set is required |  |
| [`market.resolve`](../../../packages/kernel/sql/0300_market_rule_model.sql#sym=market.resolve) | 0300 | `MKT-002` a resolution needs an as-of date<br>`MKT-003` predicates must be an object of attribute values<br>`MKT-040` unknown rule-table version …<br>`MKT-041` key … is not in rule table … version …<br>`MKT-042` key … needs predicate … to choose its branch<br>`MKT-043` predicate … = … is outside the values declared for key …<br>`MKT-045` key … has no India value for predicates … on …; India always applies, so the resolution...<br>`MKT-046` key … cannot be ranked across markets; resolving it needs a stated method (…) with a re...<br>`MKT-047` destination … is not in the market set …<br>`MKT-049` internal error: key … resolved looser than India (INV-28) | [DI-04](../../../compliance/controls/DI-04.yaml), [IN-52](../../../compliance/controls/IN-52.yaml) |
| [`market.select_row`](../../../packages/kernel/sql/0300_market_rule_model.sql#sym=market.select_row) | 0300 | `MKT-044` rows … and … both apply to key … for market …: ambiguous predicate branch |  |
| [`market.validate_document`](../../../packages/kernel/sql/0300_market_rule_model.sql#sym=market.validate_document) | 0300 | `MKT-010`<br>`MKT-011`<br>`MKT-013`<br>`MKT-014`<br>`MKT-015`<br>`MKT-016`<br>`MKT-017`<br>`MKT-018`<br>`MKT-019`<br>`MKT-020`<br>`MKT-021`<br>`MKT-022`<br>`MKT-023`<br>`MKT-024`<br>`MKT-025`<br>`MKT-026`<br>`MKT-027`<br>`MKT-028`<br>`MKT-029` |  |
| [`market.check_market_columns`](../../../packages/kernel/sql/0310_market_scopes.sql#sym=market.check_market_columns) | 0310 | `MKT-050` pack destination … is outside its batch | [IN-52](../../../compliance/controls/IN-52.yaml) |
| [`market.scope_markets`](../../../packages/kernel/sql/0310_market_scopes.sql#sym=market.scope_markets) | 0310 | `MKT-051` a scope id is required<br>`MKT-052` a MATERIAL_LOT rule is resolved at each consumption against the consuming batch; name t... |  |
| [`market.set_site_value`](../../../packages/kernel/sql/0320_market_site_values.sql#sym=market.set_site_value) | 0320 | `AUDIT-001` no actor context: call kernel.begin_command first<br>`MKT-065` site value … for … loosens a … value …; it needs a justification (CCS) reference and a...<br>`MKT-066` the QA approval of the loosening of … is signed by the person who sets the value; anoth... | [IN-52](../../../compliance/controls/IN-52.yaml) |
| [`market.site_value_basis`](../../../packages/kernel/sql/0320_market_site_values.sql#sym=market.site_value_basis) | 0320 | `MKT-002` a site value needs an effective-from date<br>`MKT-040` rule table … has no published version<br>`MKT-041` key … belongs to no rule table<br>`MKT-063` key … is NOT_COMPARABLE; it is resolved per destination and takes no site value |  |
| [`market.evaluate_stub_scope`](../../../packages/kernel/sql/0330_market_evaluations.sql#sym=market.evaluate_stub_scope) | 0330 | `MKT-003` predicates must be an object of attribute values<br>`MKT-041` key … belongs to no rule table<br>`MKT-052` only a MATERIAL_LOT scope is resolved against a consuming batch; a … scope names none<br>`MKT-054` key … belongs to the … table and does not apply to a … scope<br>`MKT-055` predicate … is fixed by the scope as … and cannot be overridden<br>`MKT-056` the site of this evaluation is the site its scope fixes (…); a request cannot name anot...<br>`MKT-057` pack … goes to …; its label rules are resolved for that destination, not for … | [IN-52](../../../compliance/controls/IN-52.yaml) |
| [`market.evaluation_complete`](../../../packages/kernel/sql/0330_market_evaluations.sql#sym=market.evaluation_complete) | 0330 | `AUDIT-001` no actor context: call kernel.begin_command first<br>`MKT-053` the evaluation of … does not match rule table … version … for its inputs; it cannot be... | [IN-52](../../../compliance/controls/IN-52.yaml) |
| [`market.record_evaluation`](../../../packages/kernel/sql/0330_market_evaluations.sql#sym=market.record_evaluation) | 0330 | `MKT-001` a market set is required<br>`MKT-002` a resolution needs an as-of date written YYYY-MM-DD<br>`MKT-040` rule table … has no published version<br>`MKT-041` key … belongs to no rule table |  |
| [`market.stub_evaluation_subject`](../../../packages/kernel/sql/0330_market_evaluations.sql#sym=market.stub_evaluation_subject) | 0330 | `MKT-058` an evaluation subject is {type, id} |  |
| [`market.publish_rule_table`](../../../packages/kernel/sql/0340_market_publish.sql#sym=market.publish_rule_table) | 0340 | `AUDIT-001` no actor context: call kernel.begin_command first<br>`MKT-012` rule table … is at version …, so the next version is …; the document says …<br>`MKT-030` the document is identical to rule table … version …; nothing to publish<br>`MKT-031` this version loosens or removes values that are already in force (first: …); only a SOU...<br>`MKT-032` a source correction needs a citation, a vendor-notice reference and the approval e-sign...<br>`MKT-033` a rule-table version needs a change description<br>`MKT-034` internal error: the stored version does not reproduce the document | [IN-52](../../../compliance/controls/IN-52.yaml) |
| [`market.rule_correction_target`](../../../packages/kernel/sql/0340_market_publish.sql#sym=market.rule_correction_target) | 0340 | `MKT-010` a rule-table document with a known table and a version number is required |  |
| [`market.define_policy`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.define_policy) | 0350 | `AUDIT-001` no actor context: call kernel.begin_command first<br>`MKT-071` policy positions must be distinct identifiers from least to most strict<br>`MKT-074` policy …: a vendor-profile switch is defined by a software release of the vendor profil... |  |
| [`market.pin_policies_for_batch`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.pin_policies_for_batch) | 0350 | `MKT-087` batch … is already pinned; policies are pinned once, at issue |  |
| [`market.policy_for_batch`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.policy_for_batch) | 0350 | `MKT-081` the batch issue instant is required<br>`MKT-086` policy … had no version in force at … |  |
| [`market.policy_pin_guard`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.policy_pin_guard) | 0350 | `AUDIT-001` no actor context: call kernel.begin_command first<br>`MKT-080` version … is not a version of policy …<br>`MKT-081` a batch is pinned at its issue instant, which cannot be in the future<br>`MKT-082` policy …: batch … must pin the version in force at issue (…), not version … (INV-47)<br>`MKT-083` batch … has no issue pin for policy …<br>`MKT-084` policy … version … is not in force yet<br>`MKT-085` policy … version … (…) is not stricter than what batch … already applies (…); a looseni... |  |
| [`market.policy_version_guard`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.policy_version_guard) | 0350 | `AUDIT-001` no actor context: call kernel.begin_command first<br>`MKT-070` policy …: a version cannot take effect in the past (… is before now, …)<br>`MKT-071` … is not a position of policy …<br>`MKT-072` policy …: version … already takes effect at …; a new version cannot take effect before it<br>`MKT-073` policy …: a change needs a change-control reference<br>`MKT-074` policy … is a vendor-profile switch; it changes only through a software release of the...<br>`MKT-075` policy … version …: the author cannot approve their own change; another person signs th... |  |
| [`market.policy_version_target`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.policy_version_target) | 0350 | `MKT-071` unknown policy … |  |
| [`market.set_policy_version`](../../../packages/kernel/sql/0350_market_policies.sql#sym=market.set_policy_version) | 0350 | `MKT-071` unknown policy …<br>`MKT-073` policy …: the approval is the id of an e-signature |  |
| [`market.assess_site_value`](../../../packages/kernel/sql/1010_site_value_set_equality.sql#sym=market.assess_site_value) | 1010 | `MKT-060`<br>`MKT-061`<br>`MKT-062`<br>`MKT-063`<br>`MKT-064` |  |

### Guards: Records

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`records.actor`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.actor) | 0400 | `REC-001` no actor context: call kernel.begin_command first |  |
| [`records.add_period`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.add_period) | 0400 | `REC-003` retention periods are never negative |  |
| [`records.approve_record_type`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.approve_record_type) | 0400 | `REC-012` approving a record type needs the approval signature<br>`REC-013` record type … version … does not exist<br>`REC-015` record type … version … is already approved<br>`REC-017` the approval signature of record type … version … was made by another person | [DI-01](../../../compliance/controls/DI-01.yaml) |
| [`records.classification_problem`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.classification_problem) | 0400 | `REC-010` a data item that feeds an acceptance limit or quality decision is raw data; it cannot b...<br>`REC-011` data class … is not one of RAW, DERIVED, INFORMATIONAL<br>`REC-013` record type … has no approved version in the record register<br>`REC-014` classification … is weaker than the register class … of record type … |  |
| [`records.define_record_type`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.define_record_type) | 0400 | `REC-011` a record type definition must be a JSON object<br>`REC-016` hybrid record type … must declare how paper and electronic parts are linked |  |
| [`records.record_key`](../../../packages/kernel/sql/0400_records_register.sql#sym=records.record_key) | 0400 | `REC-002` aggregate type … is not valid |  |
| [`records.assess_incident_impact`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.assess_incident_impact) | 0410 | `REC-056` an incident impact assessment is made by a person |  |
| [`records.close_incident`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.close_incident) | 0410 | `REC-052` incident … is …; only an incident UNDER_INVESTIGATION can be closed<br>`REC-053` incident … was …: closing it needs a root cause and a CAPA reference<br>`REC-054` closing incident … needs a closure summary<br>`REC-055` incident … is CERT-In reportable; record the report before closing | [DI-12](../../../compliance/controls/DI-12.yaml) |
| [`records.link_incident`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.link_incident) | 0410 | `REC-052` incident … is closed; raise a new incident instead |  |
| [`records.lock_incident`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.lock_incident) | 0410 | `REC-051` incident … does not exist |  |
| [`records.mark_incident_cert_in_reportable`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.mark_incident_cert_in_reportable) | 0410 | `REC-055` incident … is closed or already CERT-In reportable |  |
| [`records.raise_incident`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.raise_incident) | 0410 | `REC-050` incident source … is not in the catalogue |  |
| [`records.reclassify_incident`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.reclassify_incident) | 0410 | `REC-050` severity … must be MINOR, MAJOR or CRITICAL<br>`REC-052` incident … is closed; its severity cannot change |  |
| [`records.record_cert_in_report`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.record_cert_in_report) | 0410 | `REC-055` incident … is not marked CERT-In reportable |  |
| [`records.start_incident_investigation`](../../../packages/kernel/sql/0410_records_incidents.sql#sym=records.start_incident_investigation) | 0410 | `REC-052` incident … is …; only an OPEN incident moves to UNDER_INVESTIGATION |  |
| [`records.add_hold`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.add_hold) | 0420 | `REC-040` … has already been purged; nothing is left to hold |  |
| [`records.compute_effective_retention`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.compute_effective_retention) | 0420 | `REC-021` retention schedule … does not exist | [DI-47](../../../compliance/controls/DI-47.yaml) |
| [`records.create_retention_schedule`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.create_retention_schedule) | 0420 | `REC-013` record type … has no approved version in the record register<br>`REC-020` site zone … is not a known time zone |  |
| [`records.declare_retention_aggregate`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.declare_retention_aggregate) | 0420 | `REC-024` … has no table registered for audit; declare it after its tables |  |
| [`records.evaluate_retention`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.evaluate_retention) | 0420 | `REC-020` retention rule set … does not exist | [DI-47](../../../compliance/controls/DI-47.yaml) |
| [`records.link_retention_dependency`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.link_retention_dependency) | 0420 | `REC-022` a record cannot depend on itself |  |
| [`records.normalize_retention_inputs`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.normalize_retention_inputs) | 0420 | `REC-020` retention inputs must be a JSON object |  |
| [`records.place_legal_hold`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.place_legal_hold) | 0420 | `REC-040` a legal hold is placed by a person | [DI-47](../../../compliance/controls/DI-47.yaml) |
| [`records.release_legal_hold`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.release_legal_hold) | 0420 | `REC-040` hold … does not exist |  |
| [`records.retention_aggregate_problem`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.retention_aggregate_problem) | 0420 | `REC-024` … records are not disposed of on their own: no module declares a retention for them |  |
| [`records.schedule_for`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.schedule_for) | 0420 | `REC-021` … has no retention schedule |  |
| [`records.update_retention_inputs`](../../../packages/kernel/sql/0420_records_retention.sql#sym=records.update_retention_inputs) | 0420 | `REC-020` a change to retention inputs needs a reason<br>`REC-023` … has been purged |  |
| [`records.close_di_investigation`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.close_di_investigation) | 0430 | `REC-061` DI investigation … is already closed<br>`REC-062` closing … needs a conclusion and the remediation<br>`REC-063` closing … needs the approval signature of a person<br>`REC-065` the closure signature of … was made by another person | [DI-50](../../../compliance/controls/DI-50.yaml) |
| [`records.investigation_scope`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.investigation_scope) | 0430 | `REC-061` DI investigation … does not exist | [DI-50](../../../compliance/controls/DI-50.yaml) |
| [`records.link_di_investigation`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.link_di_investigation) | 0430 | `REC-060` a manual link needs a note saying why the record is linked<br>`REC-061` DI investigation … is closed |  |
| [`records.lock_di_investigation`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.lock_di_investigation) | 0430 | `REC-061` DI investigation … does not exist |  |
| [`records.open_di_investigation`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.open_di_investigation) | 0430 | `REC-060` a DI investigation is opened by a person<br>`REC-064` the person investigated cannot open or lead the investigation | [DI-50](../../../compliance/controls/DI-50.yaml) |
| [`records.refresh_di_investigation_scope`](../../../packages/kernel/sql/0430_records_di_investigations.sql#sym=records.refresh_di_investigation_scope) | 0430 | `REC-061` DI investigation … is closed |  |
| [`records.approve_purge`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.approve_purge) | 0440 | `REC-035` disposal is approved by a person with an approval signature<br>`REC-039` the disposal-approval signature of … was made by another person<br>`REC-041` the disposal-approval signature of … was made before the … hold … on … was released; af... | [DI-47](../../../compliance/controls/DI-47.yaml) |
| [`records.disposal_refusals`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.disposal_refusals) | 0440 | `REC-023`<br>`REC-030`<br>`REC-031`<br>`REC-032` |  |
| [`records.purge`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.purge) | 0440 | `REC-033` no QA disposal approval for … at its current retain-until … by a person who entered non...<br>`REC-034` the audit chain of … does not verify; it is not purged<br>`REC-036` a purge needs a reason code and a reason text in the command context<br>`REC-037` rows of … are still referenced by other records (…); purge refused<br>`REC-038` true copy … covers … up to seq …, but the record now ends at seq …; archive it again be...<br>`REC-041` the disposal approval … of … was given before the … hold … was placed on …; after a hol... | [DI-47](../../../compliance/controls/DI-47.yaml) |
| [`records.register_true_copy`](../../../packages/kernel/sql/0440_records_blockers_and_purge.sql#sym=records.register_true_copy) | 0440 | `REC-070` a true copy needs its manifest and purpose |  |

### Guards: QP package, true copies, contingency forms, evidence export, disposal requests

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`records.issue_qp_package`](../../../packages/kernel/sql/1160_qp_batch_package.sql#sym=records.issue_qp_package) | 1160 | `REC-084` … is no QP batch package<br>`REC-085` … (DI-35, DI-37) |  |
| [`records.revoke_qp_access`](../../../packages/kernel/sql/1160_qp_batch_package.sql#sym=records.revoke_qp_access) | 1160 | `REC-086` … is no QP access |  |
| [`records.grant_qp_access`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.grant_qp_access) | 1162 | `REC-086` a QP access is granted to an issued QP batch package only<br>`REC-087` a QP access is for an active, personal (HUMAN) account (DI-14)<br>`REC-088` a QP access ends after now and at most … days later (time-boxed)<br>`REC-089` the account already has a live QP access to another lot: a QP access is scoped to one l...<br>`REC-091` … |  |
| [`records.qp_access_role_guard`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.qp_access_role_guard) | 1162 | `REC-092` the account has a live QP access: it holds EU_QP_READER only until the access ends or i... |  |
| [`records.qp_reader_access`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.qp_reader_access) | 1162 | `REC-090` a QP account reads the package only while it holds read permissions only (read-only) |  |
| [`records.qp_reader_packages`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.qp_reader_packages) | 1162 | `REC-090` a QP account reads the package only while it holds read permissions only (read-only) |  |
| [`records.read_qp_package`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.read_qp_package) | 1162 | `REC-090` no issued QP batch package with this id is open to this account<br>`REC-091` … |  |
| [`records.register_qp_package`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.register_qp_package) | 1162 | `REC-080` a QP batch package names its subject, manifest and content<br>`REC-081` the package does not carry exactly this manifest and its SHA-256<br>`REC-082` section … is no true-copy bundle of chain … with the manifest SHA-256 given<br>`REC-083` the EU QP batch package has no … section (outline 5.2.6)<br>`REC-093` … … is no subject a QP batch package is made of (no module answers for it) |  |
| [`records.register_qp_subject_provider`](../../../packages/kernel/sql/1162_qp_package_review_fixes.sql#sym=records.register_qp_subject_provider) | 1162 | `REC-093` … must have the provider signature (subject_id text) returns jsonb |  |
| [`records.form_reconciliation_problem`](../../../packages/kernel/sql/1170_contingency_forms.sql#sym=records.form_reconciliation_problem) | 1170 | `REC-106` … contingency form(s) of this batch are not reconciled (each is returned, transcribed a... |  |
| [`records.record_contingency_form_event`](../../../packages/kernel/sql/1170_contingency_forms.sql#sym=records.record_contingency_form_event) | 1170 | `REC-101` … is no issued contingency form<br>`REC-102` form …: a void or a loss needs its reason<br>`REC-103` form …: the transcription is verified by a second person, not the one who transcribed i... |  |
| [`records.sign_form_reconciliation`](../../../packages/kernel/sql/1170_contingency_forms.sql#sym=records.sign_form_reconciliation) | 1170 | `REC-104` the reconciliation names its batch<br>`REC-105` … (DI-35, DI-37) |  |
| [`records.certify_evidence_export`](../../../packages/kernel/sql/1171_evidence_export.sql#sym=records.certify_evidence_export) | 1171 | `REC-125` … is no evidence export<br>`REC-126` … (DI-35, DI-37) |  |
| [`records.request_disposal`](../../../packages/kernel/sql/1172_disposal_requests.sql#sym=records.request_disposal) | 1172 | `REC-021`<br>`REC-130` a disposal request names the record and the reason |  |
| [`records.true_copy_parts`](../../../packages/kernel/sql/1173_true_copy_table_names.sql#sym=records.true_copy_parts) | 1173 | `REC-070` … is not an aggregate chain key |  |
| [`records.issue_contingency_pack`](../../../packages/kernel/sql/1174_evidence_export_review_fixes.sql#sym=records.issue_contingency_pack) | 1174 | `REC-100` a contingency pack names its batch, the template version, the destination and the reason<br>`REC-107` the batch is …: a contingency pack is issued at its issue or at a stage start, never af... |  |
| [`records.read_evidence_export`](../../../packages/kernel/sql/1174_evidence_export_review_fixes.sql#sym=records.read_evidence_export) | 1174 | `REC-127` no certified evidence export with this id (an export is read once QA has certified it) |  |
| [`records.register_evidence_export`](../../../packages/kernel/sql/1174_evidence_export_review_fixes.sql#sym=records.register_evidence_export) | 1174 | `REC-120` an evidence export names its subject, manifest and content<br>`REC-121` the package does not carry exactly this manifest and its SHA-256<br>`REC-122` section … copies …, which is no record of … (…)<br>`REC-123` section … is no true-copy bundle of chain … with the manifest SHA-256 given<br>`REC-124` section … is no PDF true copy carrying its content SHA-256 in its metadata (D-6-4)<br>`REC-128` section …: … (DI-41, IN-11)<br>`REC-129` section … claims a content SHA-256 that is not the one of the true copy of … (D-6-4) |  |

### Guards: Platform services

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`platform.authorize`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.authorize) | 0500 | `PLAT-006` permission … denied: … |  |
| [`platform.check_setting_value`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.check_setting_value) | 0500 | `PLAT-020` unknown setting …<br>`PLAT-021` setting … needs a value |  |
| [`platform.enforce_db_time`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.enforce_db_time) | 0500 | `PLAT-003` at least one event-time column is required | [DI-27](../../../compliance/controls/DI-27.yaml) |
| [`platform.permission_problem`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.permission_problem) | 0500 | `PLAT-005` no authority provider is registered; permission … cannot be evaluated |  |
| [`platform.reject_change`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.reject_change) | 0500 | `PLAT-002` … is insert-only; … is refused |  |
| [`platform.require_actor`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.require_actor) | 0500 | `PLAT-001` no actor context: call kernel.begin_command first |  |
| [`platform.set_setting`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.set_setting) | 0500 | `PLAT-022` a reason is required to change setting … |  |
| [`platform.setting_text`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.setting_text) | 0500 | `PLAT-020` unknown setting … |  |
| [`platform.verify_signature`](../../../packages/kernel/sql/0500_platform_base.sql#sym=platform.verify_signature) | 0500 | `PLAT-007` no signature verifier is registered; a signature with meaning … cannot be verified<br>`PLAT-008` a signature with meaning … is required |  |
| [`platform.consume_once`](../../../packages/kernel/sql/0510_platform_outbox.sql#sym=platform.consume_once) | 0510 | `PLAT-056` a message id is required |  |
| [`platform.enqueue`](../../../packages/kernel/sql/0510_platform_outbox.sql#sym=platform.enqueue) | 0510 | `PLAT-057` topic … is reserved for kernel functions |  |
| [`platform.enqueue_message`](../../../packages/kernel/sql/0510_platform_outbox.sql#sym=platform.enqueue_message) | 0510 | `PLAT-050` invalid outbox topic … (expected e.g. incident.requested)<br>`PLAT-051` invalid aggregate reference … (expected type:id)<br>`PLAT-052` an outbox payload must be a JSON object |  |
| [`platform.outbox_claim`](../../../packages/kernel/sql/0510_platform_outbox.sql#sym=platform.outbox_claim) | 0510 | `PLAT-053` a relay name is required |  |
| [`platform.outbox_claimed_state`](../../../packages/kernel/sql/0510_platform_outbox.sql#sym=platform.outbox_claimed_state) | 0510 | `PLAT-054` unknown outbox message …<br>`PLAT-055` outbox message … was not claimed by this transaction (status …) |  |
| [`platform.clear_alarm`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.clear_alarm) | 0520 | `PLAT-032` clearing an alarm needs a reason and a note |  |
| [`platform.confirm_time_source`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.confirm_time_source) | 0520 | `PLAT-030` unknown time source registration …<br>`PLAT-034` only …, named as the validator of time source …, can confirm its validation |  |
| [`platform.raise_alarm`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.raise_alarm) | 0520 | `PLAT-031` an alarm needs a subject (e.g. the database node) |  |
| [`platform.record_drift_check`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.record_drift_check) | 0520 | `PLAT-030` … is not an active time source<br>`PLAT-031` invalid node name …<br>`PLAT-037` drift readings are recorded only by the time monitor (source SYSTEM) | [DI-27](../../../compliance/controls/DI-27.yaml) |
| [`platform.register_time_source`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.register_time_source) | 0520 | `PLAT-033` validated_by … is not an active person: a time source is registered with the person who... |  |
| [`platform.report_time_fault`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.report_time_fault) | 0520 | `PLAT-031` invalid node name …<br>`PLAT-036` … cannot be reported: offset and reference alarms come only from the drift monitor<br>`PLAT-037` time faults are reported only by a time service (source SYSTEM) |  |
| [`platform.set_time_source_active`](../../../packages/kernel/sql/0520_platform_time_sources.sql#sym=platform.set_time_source_active) | 0520 | `PLAT-030` unknown time source …<br>`PLAT-035` deactivating … would leave … active time source(s), fewer than time.min_references (…); |  |
| [`platform.assert_time_zone`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.assert_time_zone) | 0530 | `PLAT-017` … is not an IANA time zone name |  |
| [`platform.check_late_entry`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.check_late_entry) | 0530 | `PLAT-015` a late entry needs a reason<br>`PLAT-016` the late-entry window ended at …; a supervisor co-signature is required<br>`PLAT-019` a late-entry reason or co-signature was given for an entry that is not late |  |
| [`platform.check_occurred_at`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.check_occurred_at) | 0530 | `PLAT-010` unknown time trust level … (DEVICE_SYNCED, DEVICE_UNSYNCED, USER_CLAIMED or PAPER)<br>`PLAT-011` an event time (occurred_at) and its trust level are given together or not at all<br>`PLAT-012` recorded_at is required to check an event time<br>`PLAT-013` the event time … is before the step started (…) | [DI-27](../../../compliance/controls/DI-27.yaml) |
| [`platform.check_step_order`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.check_step_order) | 0530 | `PLAT-014` the event time … is earlier than that of an earlier item of the step (…) |  |
| [`platform.check_time_trust_source`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.check_time_trust_source) | 0530 | `PLAT-009` a … event time is accepted only from an instrument interface or gateway (source INTEGRA... |  |
| [`platform.entry_site_zone`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.entry_site_zone) | 0530 | `PLAT-023` the command declares the time zone …, but the site |  |
| [`platform.stub_step_entry_time_model`](../../../packages/kernel/sql/0530_platform_time_model.sql#sym=platform.stub_step_entry_time_model) | 0530 | `PLAT-018` unknown step …<br>`PLAT-019` a late-entry reason was given for an entry that is not late<br>`PLAT-076` co-signature … already approved another late entry |  |
| [`platform.claim_idempotency_key`](../../../packages/kernel/sql/0540_platform_idempotency.sql#sym=platform.claim_idempotency_key) | 0540 | `PLAT-040` an idempotency key has 8-200 characters from A-Z a-z 0-9 . _ : -<br>`PLAT-041` idempotency key … was already used for a different request<br>`PLAT-042` idempotency key … belongs to another account<br>`PLAT-043` the request hash must be a lower-case hex SHA-256<br>`PLAT-045` idempotency key … is already claimed in this transaction |  |
| [`platform.complete_idempotency_key`](../../../packages/kernel/sql/0540_platform_idempotency.sql#sym=platform.complete_idempotency_key) | 0540 | `PLAT-044` an idempotent command must store a JSON result |  |
| [`platform.idempotency_completed_check`](../../../packages/kernel/sql/0540_platform_idempotency.sql#sym=platform.idempotency_completed_check) | 0540 | `PLAT-045` idempotency key … was claimed but no result was stored before commit |  |
| [`platform.create_aggregate_state_at`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.create_aggregate_state_at) | 0550 | `PLAT-060` unknown machine …<br>`PLAT-063` …:… already has a state<br>`PLAT-065` machine … governs … aggregates, not …<br>`PLAT-069` pinning …:… to machine … v… while v… is the newest needs a reason (code and text) |  |
| [`platform.protect_machine_definition`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.protect_machine_definition) | 0550 | `PLAT-061` published machine definitions are immutable (… on … refused); publish a new version ins... |  |
| [`platform.publish_machine_version`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.publish_machine_version) | 0550 | `PLAT-062` a machine definition needs machine, version and aggregate_type<br>`PLAT-071` machine …: guard … is not registered |  |
| [`platform.register_guard`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.register_guard) | 0550 | `PLAT-071` guard … must have the signature (text, uuid, jsonb, jsonb, jsonb) returns text |  |
| [`platform.run_guard`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.run_guard) | 0550 | `PLAT-071` guard … is not registered |  |
| [`platform.transition`](../../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.transition) | 0550 | `PLAT-008` event … needs a signature with meaning … (payload.signature_id)<br>`PLAT-064` …:… has no state<br>`PLAT-065` …:… follows machine …, not …<br>`PLAT-066` stale command: expected version …, but …:… is at version … in state …<br>`PLAT-067` event … is not allowed in state … (machine … v…)<br>`PLAT-068` … refused in state …: …<br>`PLAT-073` a transition payload must be a JSON object<br>`PLAT-075` signature … was already used for another transition | [PR-02](../../../compliance/controls/PR-02.yaml) |
| [`platform.stub_record_edit_guard`](../../../packages/kernel/sql/0551_platform_sample_record.sql#sym=platform.stub_record_edit_guard) | 0551 | `PLAT-074` sample record … is …; content can change only in DRAFT |  |
| [`platform.guard_state_row`](../../../packages/kernel/sql/1110_state_rows_follow_published_machine.sql#sym=platform.guard_state_row) | 1110 | `PLAT-072` aggregate state rows are never deleted<br>`PLAT-077` the history row of …:… … does not start a published version of … v… (… at version 1) |  |
| [`platform.state_row_history_check`](../../../packages/kernel/sql/1110_state_rows_follow_published_machine.sql#sym=platform.state_row_history_check) | 1110 | `PLAT-078` the state row of …:… (… at version …, … v…) is not its latest history row (…): a state... |  |
| [`iam.platform_authority`](../../../packages/kernel/sql/1150_platform_scope_hook.sql#sym=iam.platform_authority) | 1150 | `IAM-002` no validated actor: the command was not started with kernel.begin_command<br>`IAM-043` the actor given to the authority check is not the validated actor of this command<br>`PLAT-006` permission … denied: … acting as … lacks … in scope … for …:…: … (evaluation …) | [DI-17](../../../compliance/controls/DI-17.yaml) |
| [`platform.register_hook`](../../../packages/kernel/sql/1150_platform_scope_hook.sql#sym=platform.register_hook) | 1150 | `PLAT-004` unknown hook … |  |

### Guards: Continuity

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`continuity.acknowledge_alarm`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.acknowledge_alarm) | 0600 | `CONT-032` alarm … does not exist |  |
| [`continuity.after_restore`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.after_restore) | 0600 | `CONT-013` the external ledger (…) is behind the restored ceiling (…) for …; the write-ahead recor...<br>`CONT-022` restore event … does not exist<br>`CONT-023` the external ledger has no ceiling for counter …, which has issued values; the ledger i... | [DI-45](../../../compliance/controls/DI-45.yaml) |
| [`continuity.approve_restore_event`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.approve_restore_event) | 0600 | `CONT-021` restore event … does not exist<br>`CONT-025` approving a restore needs the approver | [DI-45](../../../compliance/controls/DI-45.yaml) |
| [`continuity.compare_external_anchors`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.compare_external_anchors) | 0600 | `CONT-002` external anchors must be a JSON array | [DI-17](../../../compliance/controls/DI-17.yaml), [DI-50](../../../compliance/controls/DI-50.yaml) |
| [`continuity.external_mark`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.external_mark) | 0600 | `CONT-026` the external high-water mark of … is not a whole number |  |
| [`continuity.guard_identifiers_secured`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.guard_identifiers_secured) | 0600 | `CONT-017` this database is a restored, copied or failed-over copy (incarnation …) whose identifie... |  |
| [`continuity.guard_registry`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.guard_registry) | 0600 | `CONT-016` a protected counter never moves backwards |  |
| [`continuity.next_counter_value`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.next_counter_value) | 0600 | `CONT-010` … is not a protected counter<br>`CONT-011` the server started after the block of … was reserved; the rest of that block is retired...<br>`CONT-012` the database incarnation changed since the ceiling of … was reserved (restore, copy or... | [DI-45](../../../compliance/controls/DI-45.yaml) |
| [`continuity.plan_sequence_moves`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.plan_sequence_moves) | 0600 | `CONT-024` moving … to … would exceed its maximum … |  |
| [`continuity.prepare_counter_reservation`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.prepare_counter_reservation) | 0600 | `CONT-010` … is not a protected counter<br>`CONT-012` the database incarnation changed since the ceiling of … was reserved; run the restore p... |  |
| [`continuity.raise_integrity_alarms`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.raise_integrity_alarms) | 0600 | `CONT-033` integrity alarms are raised only by a system service account (source SYSTEM) |  |
| [`continuity.record_restore_event`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.record_restore_event) | 0600 | `CONT-017` the identifiers of this restored, copied or failed-over database are not secured yet; r...<br>`CONT-020` restore event details are required |  |
| [`continuity.register_protected_sequence`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.register_protected_sequence) | 0600 | `CONT-015` … is not a sequence |  |
| [`continuity.require_actor`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.require_actor) | 0600 | `CONT-001` no actor context: call kernel.begin_command first |  |
| [`continuity.reserve_counter_ceiling`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.reserve_counter_ceiling) | 0600 | `CONT-010` … is not a protected counter<br>`CONT-012` the database incarnation changed since the ceiling of … was reserved; run the restore p...<br>`CONT-013` the external ledger (…) is behind the database ceiling (…) for …; the write-ahead recor...<br>`CONT-014` a reservation needs the external floor, the new ceiling and the ledger receipt |  |
| [`continuity.secure_identifiers`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.secure_identifiers) | 0600 | `CONT-026` external high-water marks must be a JSON array |  |
| [`continuity.verify_external_anchors`](../../../packages/kernel/sql/0600_continuity_core.sql#sym=continuity.verify_external_anchors) | 0600 | `CONT-002` external anchors must be a JSON array |  |
| [`continuity.record_backup_job`](../../../packages/kernel/sql/0610_continuity_backup.sql#sym=continuity.record_backup_job) | 0610 | `CONT-030` a backup job record is required | [DI-45](../../../compliance/controls/DI-45.yaml) |
| [`continuity.record_restore_drill`](../../../packages/kernel/sql/0610_continuity_backup.sql#sym=continuity.record_restore_drill) | 0610 | `CONT-031` a restore drill record is required | [DI-45](../../../compliance/controls/DI-45.yaml) |
| [`continuity.assert_device_hardened`](../../../packages/kernel/sql/0620_continuity_device_hardening.sql#sym=continuity.assert_device_hardened) | 0620 | `CONT-041` … device … cannot be enrolled: … | [DI-13](../../../compliance/controls/DI-13.yaml) |
| [`continuity.device_hardening_status`](../../../packages/kernel/sql/0620_continuity_device_hardening.sql#sym=continuity.device_hardening_status) | 0620 | `CONT-040` unknown device class … |  |
| [`continuity.record_hardening_attestation`](../../../packages/kernel/sql/0620_continuity_device_hardening.sql#sym=continuity.record_hardening_attestation) | 0620 | `CONT-040` attestation details are required | [DI-13](../../../compliance/controls/DI-13.yaml) |
| [`continuity.revoke_hardening_attestation`](../../../packages/kernel/sql/0620_continuity_device_hardening.sql#sym=continuity.revoke_hardening_attestation) | 0620 | `CONT-042` attestation … does not exist |  |

### Guards: Sandbox

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`kernel.installation_kind`](../../../packages/kernel/sql/0800_sandbox_installation.sql#sym=kernel.installation_kind) | 0800 | `SBX-001` ]<br>`SBX-004` ] | [DI-05](../../../compliance/controls/DI-05.yaml) |
| [`sandbox.assert_gmp_installation`](../../../packages/kernel/sql/0800_sandbox_installation.sql#sym=sandbox.assert_gmp_installation) | 0800 | `SBX-010` ] | [DI-05](../../../compliance/controls/DI-05.yaml) |
| [`sandbox.assert_sandbox_installation`](../../../packages/kernel/sql/0800_sandbox_installation.sql#sym=sandbox.assert_sandbox_installation) | 0800 | `SBX-011` ] | [DI-05](../../../compliance/controls/DI-05.yaml) |
| [`sandbox.guard_installation`](../../../packages/kernel/sql/0800_sandbox_installation.sql#sym=sandbox.guard_installation) | 0800 | `SBX-002` ]<br>`SBX-003` ]<br>`SBX-004` ] |  |
| [`sandbox.batch_issue_problem_for`](../../../packages/kernel/sql/0810_sandbox_identifiers.sql#sym=sandbox.batch_issue_problem_for) | 0810 | `SBX-012` ]<br>`SBX-020` ] |  |
| [`sandbox.guard_identifier`](../../../packages/kernel/sql/0810_sandbox_identifiers.sql#sym=sandbox.guard_identifier) | 0810 | `SBX-023` ] | [DI-05](../../../compliance/controls/DI-05.yaml) |
| [`sandbox.identifier_problem_for`](../../../packages/kernel/sql/0810_sandbox_identifiers.sql#sym=sandbox.identifier_problem_for) | 0810 | `SBX-020` ]<br>`SBX-021` ]<br>`SBX-022` ] |  |
| [`sandbox.guard_free_text`](../../../packages/kernel/sql/1120_sandbox_digit_words_ascii.sql#sym=sandbox.guard_free_text) | 1120 | `SBX-023` ]<br>`SBX-024` ] | [DI-05](../../../compliance/controls/DI-05.yaml) |

### Guards: Installation

| Function or trigger function | Migration | Codes and what they refuse | Controls |
|---|---|---|---|
| [`kernel.backend_signals_restricted`](../../../packages/kernel/sql/0970_backend_signal_policy.sql#sym=kernel.backend_signals_restricted) | 0970 | `SBX-035` ] |  |
| [`kernel.apply_listener_share`](../../../packages/kernel/sql/0980_listener_login_roles.sql#sym=kernel.apply_listener_share) | 0980 | `SBX-035` ]<br>`SBX-036` ]<br>`SBX-037` ] |  |
| [`sandbox.mirror_application_privileges`](../../../packages/kernel/sql/0980_listener_login_roles.sql#sym=sandbox.mirror_application_privileges) | 0980 | `SBX-030` ] | [DI-05](../../../compliance/controls/DI-05.yaml) |
| [`sandbox.apply_connect_policy`](../../../packages/kernel/sql/1111_connect_policy_unknown_grantee.sql#sym=sandbox.apply_connect_policy) | 1111 | `SBX-038` ] | [DI-05](../../../compliance/controls/DI-05.yaml) |
## Installation keys and site-to-site seals (Phase 6 slice 6i; kernel 1220)

[1220_installation_keys.sql](../../../packages/kernel/sql/1220_installation_keys.sql)
([DI-31](../../../compliance/controls/DI-31.yaml)): one installation per site per edition (outline L-41). Each holds an
Ed25519 key pair: the server keeps the private key (`EBMR_INSTALLATION_KEY_FILE`, DEMO-ONLY; a KMS or HSM in production),
the database the public keys and verifies every seal itself. `platform.installation_identity` (insert-only versions;
SYSTEM.CONFIGURE; the code, site and edition never change, only the key). `platform.peer_installation` is another
installation proposed by the administrator and trusted only after QA signed PEER_INSTALLATION_APPROVED
(TRANSFER.PEER_APPROVE) and while not revoked. A seal signs `ebmr.<purpose>.v1|` and the SHA-256 of the payload, so a
package seal never verifies as a federation answer. `platform.ed25519_verify` is the kernel twin of tablets 0270 (the
kernel cannot call the edition). `platform.installation_alarm` logs refused imports and federation failures (acknowledged
under ALARM.ACKNOWLEDGE); `platform.accept_federation_request` checks a site-to-site request (trusted sender, seal,
addressed here, within 300 s, nonce once) and logs every one, a refusal with its alarm, without raising.

**Pitfalls.** A refusal must commit its alarm, so these functions return `{ok: false, ...}` instead of raising. The tests
are in site services (`packages/site-services/test/transfer/`, two databases).

## The reporting role and training attempts (Phase 6 slice 6g; kernel 1210, 1211)

[1210_reporting_role.sql](../../../packages/kernel/sql/1210_reporting_role.sql): the login role `ebmr_report` (NOINHERIT,
member of nothing, connection limit 4), CONNECT on GMP databases only, USAGE on the schema `report`, SELECT on its views
and EXECUTE on their non-volatile row functions, nothing else. `sandbox.segregation_problems()` reports any other
privilege, a membership, an elevated attribute, a default privilege, a volatile function it could run, and in a sandbox
that it can connect; `sandbox.apply_connect_policy()` grants and takes CONNECT accordingly. `report.data_as_of()` is the
read's transaction time on a primary and the last replayed commit on a replica.
[1211_training_attempts.sql](../../../packages/kernel/sql/1211_training_attempts.sql): `sandbox.training_attempt` and
`sandbox.training_step`, insert-only, refused in a GMP database whoever writes (EBMR-SBX-039); `sandbox.start_training`
and `sandbox.complete_training_step` (the person's own attempt only, EBMR-SBX-040). Tests:
`packages/kernel/test/sandbox/reporting-and-training.test.ts`.

## How to test the kernel

| What | Command |
|---|---|
| One area | `pnpm vitest run --project db packages/kernel/test/<area>` (areas: `audit`, `identity`, `esig`, `market`, `records`, `platform`, `continuity`, `sandbox`, `security`, `integration`, `review`, `mutation`) |
| One area, only the migrations it needs (fast while developing) | `EBMR_MIGRATIONS='^(00|04)' pnpm vitest run --project db packages/kernel/test/records` |
| One control | `pnpm vitest run --project db packages/kernel/test/<area>/<file> -t "DI-22"` |
| On a spare cluster, beside another run | `EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5433/postgres pnpm vitest run <paths>` |
| SQL mutation run on a group of kernel guards | the `mutation-check` skill; the kernel's files are in [test/mutation/](../../../packages/kernel/test/mutation/) |
| Handbook links on this page | `pnpm handbook:check` |

Rules for kernel tests (see [Testing and debugging](../06-testing-and-debugging.md)):

- A test that proves a control carries its ID in the name: `[DI-22]`, `[INV-08]`. The register lists these tests, and
  `pnpm register:validate` fails when a listed test is missing.
- Make actors through the real functions ([test/identity/seed.ts](../../../packages/kernel/test/identity/seed.ts),
  [test/support/actors.ts](../../../packages/kernel/test/support/actors.ts)), never by inserting rows as the owner: a
  test that writes as the owner skips the very guards it should prove.
- Write a bypass test for each guard: the same write made directly with the application role (`ebmr_app`) must be
  refused by the database, not only by the TypeScript.
- For two acts that must be done by two people, test both orders.
- A refusal test checks the code (`EBMR-...`), not only that something failed.

## Pitfalls that apply to the whole kernel

- **A guard that the application can reach must check the actor itself** (P1-F70 and others): every writer the
  application role can call needs `iam.assert_not_administrator` (GMP data) and `iam.require_permission`.
- **SECURITY DEFINER functions** set `search_path` with `pg_temp` last and qualify every table, so a temporary table
  cannot stand in for a real one (ADR 0016; [definer-hardening.test.ts](../../../packages/kernel/test/security/definer-hardening.test.ts)).
- **Never edit a released migration.** Re-create the function in a new migration from its latest definition, and link
  that migration (see [database reference](../05-database.md), "create or replace": finding the version in force).
- **READ COMMITTED only** for signing and for any guard that locks and then reads.
- **Collation** changed a signing order once (P3 exit, see the [defect log](../08-defect-log.md)): compare ids with
  `COLLATE "C"` where order matters.
- **`check_function_bodies = off`** in a migration hides a wrong name until run time (recipe-core 0719); test the
  function, do not trust that the migration ran.

## Related pages

- [Architecture](../03-architecture.md): roles, definer functions, how a request reaches the database.
- [Database reference](../05-database.md): migrations, security conventions, the audit trail, the state engine, locks.
- [The life of a batch](../04-life-of-a-batch.md): where each kernel function is called during a batch.
- [Glossary](../02-glossary.md), including the [invariants](../02-glossary.md#invariants-inv-01-to-inv-48).
- [Defects and lessons](../08-defect-log.md) and [Removed and replaced](../09-removed-and-replaced.md).
- Generated: [code map](../code-map.md), [database catalogue](../reference/db-catalogue.md),
  [control-to-code map](../reference/control-map.md), [error codes](../reference/error-codes.md).
- The area READMEs in [packages/kernel/src/](../../../packages/kernel/src/) hold more detail (policy ranges, open points).
- Other modules that build on the kernel: [site-services](site-services.md), [recipe-core](recipe-core.md),
  [tablets-server](tablets-server.md).
