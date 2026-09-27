# Electronic signatures (kernel module B2)

Challenge, authenticate, sign: the server shows exactly what is signed, the signer proves who they
are at that moment, and the signature is bound to that content by its hash and a seal. Schema
`esig`, migrations `packages/kernel/sql/0200`–`0250`, TypeScript in this folder, tests in
`packages/kernel/test/esig/`.

Controls: DI-35 (catalogue), DI-36 (manifestation), DI-37 (linking and invalidation), DI-38
(components and session rules), DI-13 (evidence package). Invariants: INV-03 (generic: a verifier
or witness is never a person who performed, entered data in or corrected the record), INV-09,
INV-10, and the "signature IDs never reused" part of INV-27. Outline 5.5, 7.1, 7.2, 5.4; ADR 0006,
0012. Builds on the identity module (B1): authentication events, `iam.consume_auth_event`,
`iam.assert_can_sign`, `iam.resolve_signer`, `iam.evaluate_authority` (INV-26),
`iam.delegation_valid`, `iam.evaluate_segregation`, `iam.assert_validated_actor`.

## Flow

1. **Content.** `esig.content_for_signing(type, id)` returns the canonical text of the record
   version (from the provider registered for the aggregate type), its content version and its hash.
   The client renders exactly that text and hashes it (`contentHash`).
2. **Challenge.** `esig.create_challenge(type, id, content_version, meaning, client_hash[, signer_account])`
   in the session owner's command: the server rebuilds the canonical content and refuses a different
   hash (EBMR-ESIG-013) or version (012); the meaning must be an active catalogue type (026). The
   challenge is single-use, valid 120 s (policy, never longer), bound to the signer's account, the
   session and its terminal, and returns the manifestation preview and the components to ask for.
   `signer_account` names another person signing at this terminal (a co-signature).
3. **Authenticate.** The signer authenticates through the authentication service (role
   `ebmr_authn`, `authenticate(... purpose: 'SIGNATURE', challengeId)`), which inserts one event
   bound to the challenge. Signatures take user ID + password or badge + PIN.
4. **Sign.** `esig.sign(challenge, auth_event, expected_state, delegation, next_step_started)` is the
   only writer of `esig.signature`. In this order it: checks the challenge (unused, unexpired, this
   session and terminal); takes a per-record transaction lock; consumes the event
   (`iam.consume_auth_event`: same person, this challenge, fresh, unused; no proxy signing) and
   checks its account and terminal; checks the components (below); `iam.assert_can_sign`; re-reads
   the record (same version and hash, expected state); evaluates authority for one of the type's
   permissions at this instant (stored, INV-26; the session owner in the role declared in the
   command, a co-signer in any role that grants it); checks a cited delegation; the independence
   rules on the person; the WITNESSED rules; then inserts the row (ID, time, UTC offset and
   manifestation set by the database), writes a business entry on the record's audit chain and
   returns the canonical seal payload. A co-signature's rows are attributed to the co-signer
   (`iam.set_internal_actor`), with the terminal session they were applied in.
5. **Seal.** `sign()` in TypeScript seals the payload with a `SealKeyProvider` (HMAC-SHA256 or
   Ed25519; KMS/HSM in production) and calls `esig.seal_signature` in the same transaction. A
   deferred constraint refuses to commit a signature without its seal, so any failure aborts
   everything, including the consumption of the authentication event.

## Components and sessions (DI-38)

`esig.required_components` returns ALL or PRIVATE. Default: ALL at every signing. PRIVATE (the
password or PIN alone) only when the QA-approved policy `esig.session_relaxation` is on, the type
is `SESSION_RELAXABLE`, the signer owns the session, and they already signed with all components in
this continuous session (which starts at login and again at every lock or unlock; an inactivity
timeout always ends in an unlock; a terminal change is a new session). Master-record, release and
certification types are always ALL (check constraints). A co-signature always needs ALL. Policy
`esig.mfa_at_signing` (off) additionally requires an MFA component.

The authentication service always records both components for a signature, so the relaxation is
not usable yet: the identity module needs a session-bound method that verifies only the private
component (see "Open points").

## Tables

| Table | Content | Protection |
|---|---|---|
| `meaning_type` | Catalogue of signature types, versioned: permissions, meaning text, independence, INV-03 and involvement exclusions, witness, re-authentication, delegation | insert-only, audited (`esig_meaning:<code>`); minimum set never removed, disabled or loosened (guard trigger) |
| `predicate_signature_point` | Inventory: every predicate-rule signature point and its type | protected log |
| `policy_key`, `policy_value` | Challenge validity, relaxation, witness window, MFA at signing, India DSC (OFF) | values insert-only, audited |
| `content_provider`, `signed_table` | Provider per aggregate type; tables holding signed content | owner-only registration |
| `challenge` | Challenges | insert-only, audited (`esig_challenge:<type>:<id>`) |
| `signature` | Signatures with stored manifestation | insert-only, audited (`esig_signature:<type>:<id>`); only `esig.sign` inserts |
| `signature_seal` | Seal, key ID, algorithm, payload digest | insert-only, audited |
| `signature_invalidation` | SUPERSEDED_BY_CHANGE rows | insert-only, audited |
| `signature_id_register` | Every signature ID ever issued (INV-27) | protected log |
| `content_change` | Who changed which signed record (INV-03 involvement) | protected log |
| `seal_key`, `seal_key_retirement` | Key registry and public-key archive | insert-only, audited |
| `signing_failure` | Refused signings, logged after rollback | protected log |
| `stub_signable` | Stub signed entries (step, cleaning-log entry, master document) with provider `esig_stub` | audited; state only through `esig.stub_complete` |

## What other modules call

SQL (inside a command):

- **Register** (in a migration, as `ebmr_owner`): `esig.register_content_provider(type, 'schema.fn(text)', description)`
  and `esig.register_signed_table(table, type, aggregate_column, content_columns)`. The provider
  contract is at the top of `0200_esig_foundation.sql`; decimals travel as strings.
- **Verify a signature before acting on it**: `esig.assert_signature(signature_id, meaning, type, id)`
  (raises EBMR-ESIG-070 unless it exists, has the meaning, belongs to the record and is valid) or
  `esig.signature_problem(...)` (NULL or the reason). Status: `esig.signature_state(id)`,
  `esig.record_signatures(type, id)`, `esig.resigning_required(type, id)`.
- **Platform state engine**: `esig.platform_signature_check(uuid, text, text, text, jsonb)` is the
  SIGNATURE hook adapter (register it with `platform.register_hook` in an integration migration).
- **Renderers**: `esig.manifestation(id)`; **integrity job**: `esig.verify_signatures(since)`,
  `esig.invariant_violations()`; **evidence**: `esig.evidence_package(id)`.

TypeScript (`@ebmr/kernel` once `./esig/index.ts` is exported): `contentForSigning`,
`createChallenge`, `sign`, `signCommand` (logs refusals after the rollback), `signatureState`,
`assertSignature`, `recordSignatures`, `resigningRequired`; `getManifestation`,
`renderManifestation` (SCREEN, PRINT, PDF), `manifestationExport`; `verifySignatures`,
`verifySeal`, `evidencePackage`; `hmacSealKey`, `ed25519SealKey`, `createSealKeyRing`,
`sealMessage`; catalogue and policy: `listMeanings`, `addMeaningType`, `configureMeaningType`,
`retireMeaningType`, `setEsigPolicy`, `registerSealKey`, `retireSealKey`; `canonicalJson`,
`canonicalEnvelope`, `contentHash`.

## Invariants and how they are enforced

- **INV-10**: the application role has no write privilege on any esig table; a guard trigger
  accepts a signature row only from `esig.sign` (EBMR-ESIG-060, also against the table owner);
  `auth_event_id` and `challenge_id` are unique; a deferred check refuses an unsealed commit.
  Detected: `esig.verify_signatures`, `esig.invariant_violations`.
- **INV-09**: every registered signed table has an AFTER ROW trigger that, in the changing
  transaction, compares each unsuperseded signature's hash with the record's current hash and
  inserts SUPERSEDED_BY_CHANGE rows; signing and changing a record take the same transaction lock;
  signing is refused while an invalidation trigger is missing or disabled (EBMR-ESIG-008).
- **INV-03**: types whose role class is VERIFIER or WITNESS must exclude performers (check
  constraint); the excluded set is every person in `content_change` for the record, the provider's
  `entered_by` and every signer of a PERFORMER-class meaning, superseded or not; evaluated on the
  person with `iam.evaluate_segregation` (stored).
- **INV-27**: the signature ID is drawn by the insert guard from `gen_random_uuid()` (never a
  sequence, never caller-chosen) and entered in `signature_id_register`, which nobody can change or
  empty; the register outlives purged signature rows. After a restore to an earlier point the
  register is restored with the database, so uniqueness then rests on the 122 random bits of each ID.

## Refusal codes (EBMR-ESIG-NNN)

001 protected log; 002–005 policy; 006–008 signed tables and triggers; 010–013 challenge (signer,
record, version, displayed hash); 020–026 catalogue; 030–041 signing (030 no event, 031–034
challenge, 035 zone, 036 event account/terminal/time, 037 type changed, 038 components, 039 state,
040 authority, 041 delegation); 042–045 independence (042 duplicate, 043 independent-of, 044
INV-03, 045 involvement); 050–053 witness; 060–064 insertion and seal; 070 signature not valid for
the use; 090–093 stub entries. Identity refusals keep their EBMR-IAM codes (for example 093 proxy
signing, 091 event already used, 092 too old, 094 other challenge).

## Extension points

- **India DSC / eSign (IN-10)**: off (`esig.india_dsc` allows only OFF). A second signature with a
  Class 3 DSC or eSign would sign the same content hash; it would be stored beside the signature
  and required per meaning once a licensed provider is configured and validated.
- **Biometric signing**: not offered (component_problem refuses unknown components).
- **KMS/HSM**: implement `SealKeyProvider` against the KMS; configure the verifier's
  `SealKeyRing` from the KMS or a sealed key archive (never from the database key registry).

## Open points

- The identity module offers no private-component-only authentication for the DI-38 relaxation.
- Tenancy row-level security: `content_for_signing` and `evidence_package` run as the owner and
  must check the caller's read permission once RLS arrives.
- Retention purge of a record leaves its signature rows (superseded by the deletion); the records
  module decides whether they are purged with the record.
