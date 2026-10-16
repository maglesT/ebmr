# Slice 6i-0: inter-site transfer packages and federated genealogy (fixed 16 October 2026)

The interface commit of slice 6i (plan: [phase-6-plan.md](phase-6-plan.md), "Slice 6i"; outline L-41, 4.2 "v1 topology").
Everything below is fixed for the slice; changes are additive (new routes, new optional fields, new node and edge kinds).
It builds on the genealogy interfaces of [slice-6d-0-interfaces.md](slice-6d-0-interfaces.md).

Branch `phase-6/slice-6i`. Migrations: kernel 1220 to 1229, site services 0980 to 0999, recipe-core 1090 to 1099 (the plan's
ranges) and tablets 1290 to 1299 (taken here, D-P6i-0-1).

## 1. What travels and who decides

One installation per site per edition (L-41). The shipping installation builds a **lot-transfer package** for one released
intermediate lot: the content is assembled by its database from its own records (never from the caller), as canonical JSON
text, and sealed by the installation's Ed25519 key. The receiving installation's database verifies the seal against the
registered key of the sending installation, checks that the package names it as the destination, and creates a local lot of
kind INTERMEDIATE in QUARANTINE. That lot is unusable until local QA accepts the receipt with an e-signature; the ordinary
local release (RELEASE_FOR_FURTHER_PROCESSING) is refused before it, and so is a reservation. A refused package (malformed,
unknown sender, broken seal, wrong destination, already received) creates nothing but a refusal row and an alarm (DI-31).

Cross-site genealogy: a TRANSFER node joins the two sites' graphs (the package id is the node id on both sides). The
explorer and the mock recall ask the other site through a read-only site-to-site endpoint; the request and the answer are
both sealed by installation keys and the answer carries its as-of point. When a site does not answer, the last received
excerpt is shown with its own as-of and the result is marked incomplete, never silently partial.

## 2. SQL

### Kernel 1220 (installation keys, seals, alarms, federation requests)

| Signature | Behaviour |
|---|---|
| `platform.installation_identity` (insert-only versions) | This installation: code, site, edition, raw Ed25519 public key (32 bytes) and fingerprint; the latest version is current; the code never changes once set |
| `platform.set_installation_identity(code, site, edition, public key base64) returns integer` | SYSTEM.CONFIGURE; a new key version (rotation) for the same code; EBMR-XFR-001 to -003 |
| `platform.peer_installation`, `platform.propose_peer_installation(p jsonb) returns uuid` | SYSTEM.CONFIGURE: another installation's code, site, edition, base URL and public key (proposed); EBMR-XFR-004, -005 |
| `platform.approve_peer_installation(id, signature)`, `platform.revoke_peer_installation(id, reason)` | TRANSFER.PEER_APPROVE (QA reviewer, AP), signed PEER_INSTALLATION_APPROVED on `peer_installation <id>`, state PROPOSED; a peer is trusted only while approved and not revoked; EBMR-XFR-006 to -008 |
| `platform.ed25519_verify(key bytea, message bytea, signature bytea) returns boolean` | RFC 8032 verification in PL/pgSQL (the kernel twin of tablets 0270, which the kernel cannot call) |
| `platform.seal_message(purpose, payload) returns bytea` | What is signed: `ebmr.<purpose>.v1|<SHA-256 hex of the payload's UTF-8>`; purposes `transfer-package`, `federation-request`, `federation-answer` (domain separation: a seal of one purpose never verifies as another) |
| `platform.own_seal_valid(purpose, payload, seal)`, `platform.peer_seal_valid(peer, purpose, payload, seal)` | Seal = canonical base64 of 64 bytes; the peer's key only while trusted |
| `platform.installation_alarm`, `platform.raise_installation_alarm(...)` (owner only), `platform.acknowledge_installation_alarm(id, note)` | Alarms of the transfer and federation paths (MALFORMED, UNKNOWN_PEER, TAMPERED, WRONG_DESTINATION, DUPLICATE, REPLAYED, UNREACHABLE, WRONG_ANSWER); ALARM.ACKNOWLEDGE, people only |
| `platform.federation_request` (insert-only log), `platform.accept_federation_request(request text, seal text) returns jsonb` (owner only) | The answering side's check of a request: sender trusted, seal valid, addressed here, issued within 300 s, nonce unused; every request is logged ANSWERED or REFUSED with its reason, a refusal with an alarm |

### Site services 0980 to 0982 (packages, receipts, acceptance)

| Signature | Behaviour |
|---|---|
| `site.transfer_package`, `site.transfer_package_seal` (insert-only, audited, aggregate `material_lot` of the shipped lot) | The outbound package: lot, destination, quantity, the canonical payload, its SHA-256, and (second table) the seal |
| `site.prepare_transfer_package(lot, p jsonb) returns jsonb` | MATERIAL.HANDLE at the lot's site, never an administrator. `p {destination, quantity (decimal text), markets?, holdUntil?}`. The lot is INTERMEDIATE, in a usable status, within its dates; the quantity is not above what is left after earlier packages; the destination is a trusted peer. Returns `{packageId, packageNo, payload}`; EBMR-XFR-010 to -016 |
| `site.seal_transfer_package(package, seal) returns jsonb` | The same person, in the same transaction or later: the seal must verify under this installation's current key; once; EBMR-XFR-017, -018. The genealogy edge TRANSFERRED is the seal row |
| `site.import_transfer_package(payload text, seal text) returns jsonb` | MATERIAL.HANDLE at the actor's site. `{outcome: RECEIVED, receiptId, lotId, lotCode}` or `{outcome: REFUSED, reason, refusalId, alarmId}` (nothing else changes). Checks in order: JSON of format `ebmr.lot-transfer.v1` (MALFORMED), sender trusted (UNKNOWN_PEER), seal (TAMPERED), destination this installation and its site the actor's (WRONG_DESTINATION), not received before (DUPLICATE) |
| `site.transfer_receipt`, `site.transfer_refusal`, `site.transfer_rule_resolution` | The receipt (the local lot, the carried content, the hold limit), refusals, and per rule key the carried, local and resolved value with the winner |
| `site.decide_transfer_receipt(receipt, decision, signature, reason) returns uuid` | MATERIAL.QA_DISPOSITION at the lot's site; ACCEPTED (TRANSFER_RECEIPT_ACCEPTED) or REFUSED (TRANSFER_RECEIPT_REFUSED) on `transfer_receipt <id>`, state RECEIVED; once; the signer is the actor; ACCEPTED only while the lot is in QUARANTINE, within its dates and its hold limit; EBMR-XFR-030 to -036 |
| triggers on `site.lot_status_command` and `site.lot_reservation` | A received lot is released (RELEASE_FOR_FURTHER_PROCESSING) and reserved only once accepted and before its hold limit (EBMR-XFR-040, -041) |
| `site.transfer_receipt_content(id)`, `site.transfer_hold_remaining(receipt)` | The signed content; the hold time left at database time (an interval, never stored) |

### Recipe core 1090, 1091 (genealogy across sites, federation, mock recall)

| Signature | Behaviour |
|---|---|
| `recipe.genealogy_step`, `recipe.genealogy_node_exists`, `recipe.genealogy` re-created | New node kind TRANSFER; new edges LOT -> TRANSFER `TRANSFERRED` (the seal row, sealed_at) and TRANSFER -> LOT `TRANSFER_RECEIVED` (the receipt, received_at). Everything else unchanged |
| `recipe.genealogy_node_views` re-created | TRANSFER: label the package number, code the origin installation, name the destination installation, sub-kind OUTBOUND or INBOUND, state SEALED, RECEIVED, ACCEPTED or REFUSED |
| `recipe.answer_federated_genealogy(request text, seal text) returns jsonb` | Granted to the application role without a session (the request's seal is the authentication). Only from a TRANSFER node exchanged with the requesting installation. `{ok: true, payload}` (the excerpt to seal: format `ebmr.genealogy-excerpt.v1`, the request's nonce, from, to, the query, as-of, rows, node views) or `{ok: false, reason}` |
| `recipe.issue_federated_request(peer, transfer, direction, as_of) returns jsonb` | The asking side builds the request text (nonce, issued-at, query) to seal |
| `recipe.record_federated_excerpt(nonce, payload, seal) returns uuid`, `recipe.record_federation_failure(nonce, status, detail) returns uuid` | The answer is kept only if its seal verifies under the peer's key and it answers the request issued (nonce, peer, transfer, direction, as-of); a failure is logged with an alarm. `recipe.federated_excerpt` is insert-only |
| `recipe.last_federated_excerpt(peer, transfer, direction)` | The last excerpt received, whatever its as-of (shown when the peer does not answer) |
| `recipe.mock_recall_result_v2` | Version 1 plus the TRANSFER nodes reached (`transfers`); `recipe.run_mock_recall` runs version 2 |
| `recipe.mock_recall_remote`, `recipe.record_mock_recall_remote(recall, transfer, status, excerpt, detail) returns uuid` | Per outbound transfer of the result: ANSWERED (an excerpt as of the recall's as-of, FORWARD, from the destination) or UNREACHABLE or REFUSED (with the last excerpt, if any); RECALL.MOCK_RUN; before the sign-off only |
| `recipe.mock_recall_federation(recall) returns jsonb` | `{complete, transfers[]}`: complete only when every outbound transfer has an ANSWERED row; computed by the database, never stored |

### Tablets 1290

`tab.kernel_signing_meanings` and `tab.aggregate_read_class` re-created from their latest definition (tablets 1280) with
`transfer_receipt` (TRANSFER_RECEIPT_ACCEPTED, TRANSFER_RECEIPT_REFUSED; RECORD class) and `peer_installation`
(PEER_INSTALLATION_APPROVED; GOVERNANCE class).

## 3. Contract

- Namespace `transfers` (GMP): `peers` (GET), `proposePeer` (POST, SYSTEM.CONFIGURE), `packages` (GET outbound),
  `prepare` (POST: builds and seals in one command; FRESH_ON_SHARED), `packageFile` (GET: payload and seal for the file
  exchange), `receipts` (GET inbound), `receipt` (GET one, with rule resolutions and hold time left), `import` (POST:
  payload and seal; FRESH_ON_SHARED; the answer is RECEIVED or REFUSED with the reason), `alarms` (GET),
  `acknowledgeAlarm` (POST).
- Signable actions: `TRANSFER_RECEIPT_DECIDE` (`transfer_receipt <id>`, ACCEPTED or REFUSED, state RECEIVED) and
  `PEER_INSTALLATION_APPROVE` (`peer_installation <id>`, PEER_INSTALLATION_APPROVED, state PROPOSED).
- Namespace `federation` (GMP, `auth: NONE`): `genealogy` (POST `/api/federation/genealogy`, body `{request, seal}`,
  answer `{payload, seal}`; a refusal is 403 with the database's reason).
- `genealogy.federatedTrace` (GET `/api/genealogy/federated-trace?kind&id&direction&asOfUs`): the local trace plus one part
  per transfer reached (`ANSWERED`, `UNREACHABLE`, `REFUSED` or `NOT_REGISTERED`, the as-of asked and the excerpt's own
  as-of), `complete`, and the transfers beyond one hop.
- Additive: `GenealogyNodeKind` gains `TRANSFER`, `GenealogyEdgeKind` gains `TRANSFERRED` and `TRANSFER_RECEIVED`,
  `GenealogyTraceView.counts` gains optional `transfers`; `MockRecallView` gains optional `federation`
  (`{complete, transfers[]}`), and `recall.run` fans out to the destinations before it answers.
- Examples in `fixtures/transfers.json` and `fixtures/federation.json`.

## 4. Tests fixed for the slice (titles; 6j maps clauses to them)

- `[DI-31] a tampered transfer package is refused` (with an alarm; nothing created)
- `[DI-31] a package for another installation is refused`, `[DI-31] an unknown sender and a second import of the same package are refused`
- `[DI-39] a received lot is unusable before local QA acceptance` (release and reservation refused; usable after acceptance and release)
- `[DI-39] the status and disposition travel with the lot, and only a released intermediate is packaged`
- `[PR-57] a forward trace crosses a site transfer` (two installations, two databases)
- `[PR-57] a backward trace from the received lot reaches the origin's input lots`
- `[IN-29] a mock recall with one site down is marked incomplete` (and complete once the site answers)
- remaining hold time carries over and keeps running; rule resolutions are re-resolved and the stricter wins
- the federation endpoint refuses an unsigned, replayed, misaddressed or unrelated request

## 5. Decisions (defaults under decision 0004; the owner may change them)

- **D-P6i-0-1** Tablets 1290 to 1299 for the signing meanings (the plan gave 6i no tablets range; 1280 to 1289 is 6d's, the
  others are taken on main and in the open slices). Why: the next free range after every range in use.
- **D-P6i-0-2** A package carries one material lot of kind INTERMEDIATE (intermediates and bulk held as a lot) in a usable
  status (RELEASED or RELEASED_FOR_FURTHER_PROCESSING); finished goods go out as distribution records (6d), purchased
  materials come from their supplier. Shipping in quarantine (for testing elsewhere) is out of v1. Why: L-41 names
  intermediates and bulk, and material leaves for use elsewhere only after its own site's quality decision.
- **D-P6i-0-3** The package states "status and disposition" as the lot state, its release command (event, route, when,
  who, signature id) and "CoA" as every approved, not superseded test result with its limits and verdict. Why: the
  receiving QA decides on the shipping site's evidence, which is quoted, never re-typed.
- **D-P6i-0-4** Acceptance is its own signed act of local QA (TRANSFER_RECEIPT_ACCEPTED or _REFUSED); the local lot then goes
  through the ordinary local release, which is refused before the acceptance. Why: the acceptance is the receiving site's
  decision on the package; the release keeps the one lot machine and its guards.
- **D-P6i-0-5** Remaining hold time travels as an absolute instant (the earliest of the lot's expiry, retest and any earlier
  hold the shipper states or the lot carried from an earlier transfer); the receiving database compares it with its own
  time at acceptance, release and reservation, so the clock keeps running in transit. Why: a duration would restart on
  arrival.
- **D-P6i-0-6** Rule resolutions travel as data (D-P6i-2): the shipping database resolves every key of its current kernel and
  edition rule tables for the material's market set (IN always; the shipper may add markets) without product predicates;
  a key that cannot resolve so is left out. The receiving database resolves each carried key again with its own current
  table and keeps the stricter (`market.at_least_as_strict`; set methods merge); a key it does not know keeps the carried
  value; NOT_COMPARABLE keeps both and is shown. Why: the stricter rule wins (CLAUDE.md), and the data, not code, decides.
- **D-P6i-0-7** Federation is one hop: a site answers only about transfers it exchanged with the asking site; an excerpt that
  reaches a further transfer lists it as beyond one hop and marks the result incomplete. Why: each site discloses only
  what it shared, and nothing is silently left out.
- **D-P6i-0-8** The installation's private key is held by the server (`EBMR_INSTALLATION_KEY_FILE`, DEMO-ONLY file; a KMS or
  HSM in production), never by the database; the database holds the public keys and verifies every seal itself. Why: as
  the gateway keys (tablets 0270) and the seal keys of e-signatures.
- **D-P6i-0-9** A request is valid for 300 seconds and its nonce once; the answer's as-of is the as-of asked (the asking
  site's time; a future instant at the answering site is refused). Why: replay protection without a session.
- **D-P6i-0-10** The suspension cascade (Phase 4 slice 5) stays local; the federated mock recall lists the receiving site's
  lots and consignees, and the receiving site's QA acts on them. Why: each site's QA owns its own lots (L-41).
