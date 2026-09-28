# Phase 2: open questions for the owner and QA

Defaults in use today are listed. Status: all DECIDED by default (owner decision 0004, 28 September 2026); the owner or QA may still change any of them later.

## Calculations and rounding (expression language)

| # | Question | Default in the build |
|---|---|---|
| E1 | Ph. Eur. rounding counts significant figures per bound, so 0.96 against "not less than 1.0" fails under Ph. Eur. but passes under USP (rounded to the limit's decimals). QA to confirm against the official pharmacopoeia texts. | As described; each parameter names its rule set. |
| E2 | A USP limit with two bounds written to different decimals (e.g. 95.0-105) | The finer of the two decimal places is used for both. |
| E3 | Temperatures | `K` always means a temperature difference; absolute temperatures only in `Cel` or `[degF]`. |
| E4 | `kp` (kilopond) on hardness | Accepted as kgf with an information note; `kg/cm²` only through the controlled legacy alias with a justification. |
| E5 | Nested calculations | Each nested library result is kept at 34 significant digits before the outer formula uses it (no intermediate rounding to reporting precision). |
| E6 | Empty series | `sum`/`mean` of an empty series is an error; `count` of an empty series is 0. |
| E7 | Microbial and potency units | CFU and IU convert only within the same unit; there is no endotoxin unit yet (UCUM's [EU] is a different unit) - deferred with injectables. |

## Recipe model, validator and simulator (flow module)

| # | Question | Default in the build (decided by 0004) |
|---|---|---|
| F1 | Branch conditions that cannot be analysed exactly | Analysed exactly over the reals at representative points; an unanalysable condition gives a warning needing justification. |
| F2 | References in an MBR | Every reference carries a version hash and must be EFFECTIVE at validation. |
| F3 | Line clearance and yield | Checked per stage; only stages marked NON_MATERIAL are exempt from yield; AFTER_YIELD roles must follow the yield step; equipment status is checked within the same stage. |
| F4 | Writers of a data item | Exactly one writer on any path. |
| F5 | Reading repeated data | Replicate data read outside the section is the series of instance values; loop data read after the loop is the last iteration's value. |
| F6 | Device or automation capture | Must name the computerised system (GMP-SYSTEMS reference). |
| F7 | IPC limits and manual critical data | Only numeric IPCs need limits; critical parameters entered by hand need an accuracy-check method. |
| F8 | Checker on significant steps | No risk reduction removes the checker except the S5a and S24 cases; no general "no checker" reduction exists. |
| F9 | Conditional "not applicable" items (PR-03) | Not modelled in Phase 2 (execution-time, Phase 3). |
| F10 | Limit sources | Registered limits cite a registration or pharmacopoeia source with edition; validated limits cite a validation report; hold times cite a hold-time study or validation report; timers accept listed source kinds only. |
| F11 | Loops | Repeat only on process endpoints; the exit may not depend on an acceptance or release test result, directly or through a calculation (that is reprocessing). |
| F12 | Market minima not resolvable | The MBR fails (fail closed). |
| F13 | Bounds | At most 100 loop iterations, 500 replicate instances, 64 nesting levels; the simulator enumerates up to 10,000 paths, then adds one targeted run per remaining decision option so decision coverage stays complete. |
| F14 | Sequential replicate instances | Released one at a time. |
| F15 | What counts as a value-only change (delta verification) | Limit values, targets, batch-size quantities, reference version/hash and texts; anything else is structural. |

## MBR life cycle (lifecycle module) - decided by default (0004)

| # | Question | Default in the build |
|---|---|---|
| L1 | Returning a version to DRAFT | Only before approval; a change to an approved master is always a new derived version. |
| L2 | Regulatory sign-off at approval | A valid REGULATORY_CONFIRMED signature on the version by a person other than the approver. |
| L3 | What counts as process-impacting | Conservative: only titles, product display name, reference titles and golden test data are non-process; a first version is a new process and needs a validation link. |
| L4 | Registered elements | REGISTERED-tier ranges and REGISTRATION references; any change needs a reporting category per market; a widening also needs the variation/supplement reference; a unit change counts as widening. |
| L5 | Scope cells for market authorisation | Concrete (site, line, batch size). |
| L6 | Effective dates | A successor cannot take effect inside a predecessor's remaining validity; withdrawing a successor does not reinstate the predecessor. |
| L7 | Withdrawal | By QA from SUBMITTED, CHECKED or APPROVED; from APPROVED only if never authorised. |
| L8 | Periodic review | Recorded by QA (MBR.APPROVE). |
| L9 | S4 "checker may also approve" | Not allowed (outline default). The e-signature catalogue requires APPROVED to be independent of CHECKED, so allowing it later needs a kernel catalogue change. |
| L10 | A person who returned a version to DRAFT | Is treated as an editor by the e-signature independence rule, so cannot sign CHECKED/APPROVED on that version (stricter than INV-04; a kernel option to mark administrative changes as "not a data entry" is a follow-up). |
| L11 | New permission MBR.CHANGE_RECORD | GMP write, held by QA MBR approver and regulatory signer. |

## Phase 2 apps (tablets server, web, gateway) - decided by default (0004)

Source: `docs/build-plan/phase-2/apps/00-plan.md` section 15; architecture in ADR 0017.

| # | Question | Default in the build |
|---|---|---|
| D1 | A kiosk request whose answer was lost | The entry stays on screen behind a blocking NOT SAVED banner. Resending uses the same idempotency key and a fresh badge tap by the same person: if the first attempt committed, the kernel replays its result; if not, the work runs under the new authentication event. This departs from the letter of ADR 0006 item 4 (the entry is bound to the person, not to the original event); the lead records the departure. A tap by another person discards the unsent entry. |
| D2 | Verification on a kiosk | The verifier switches user by badge and PIN and signs in their own session (tap for the challenge, then PIN). Co-signatures on PERSONAL devices come in A2; a kernel proposal to let a co-signer's own tap attribute the challenge goes to the lead. |
| D3 | G-09 equipment status and G-10 clearance in Phase 2 | Version 1 of each is a manual-attestation block marked SANDBOX_ONLY; `defineBatch` refuses it on GMP (ENG-DEF-SANDBOX-ONLY). Database-backed version 2 and PR-22..27 stay in Phase 3. |
| D4 | Role vocabulary | The engine role of a person is derived from the session's declared kernel role through `tab.engine_role_map` (OPERATOR -> PRODUCTION_OPERATOR via STEP.EXECUTE, VERIFIER -> PRODUCTION_VERIFIER via STEP.VERIFY, SHIFT_SUPERVISOR -> PRODUCTION_SUPERVISOR via STEP.SUPERVISE, QA_SHOP_FLOOR -> QA via QA.FLOOR_APPROVE, ...), only when the stored authority evaluation allows the permission at the actor's location (INV-26). Each run pins the engine's DEFAULT_POLICY in engine vocabulary with its hash. |
| D5 | Moving an MBR to the sandbox | An exchange directory (`var/exchange/{to-sandbox,to-gmp}`): in A1 a write-once `ebmr.mbr-test-package v1` file with package hash and GMP stamp; in A2 Ed25519-signed files both ways. No process holds credentials for both databases. Keys are DEMO-ONLY. |
| D6 | Demo device picker | Only when the server runs with EBMR_DEMO=1 and the database carries the `tab.demo_installation` marker, which the set-up CLI writes only for databases named `*_demo` or `*_e2e_*`. Production refuses EBMR_DEMO. |
| D7 | Browser storage | An unsaved MBR authoring draft may live in localStorage; executed data, credentials and tokens never do (the terminal key lives in IndexedDB as a non-extractable WebCrypto key). |
| D8 | Per-entry attribution on shared terminals | A badge tap (TAP) by default; TAP_PIN is available per device class. |
| D9 | Device proofs | On authentication calls (login, change of secret, unlock, tap, signature, switch) in A1; on every mutation in A2. |
| D10 | Designer validation | On the server in A1 (debounced 600 ms); in a Web Worker in A2 with the server authoritative. |
| D11 | Time sweeper | In-process in the sandbox server every 15 s under the `TEST-sweeper` SERVICE identity (SKIP LOCKED); pg-boss arrives in Phase 3. |

### Defaults taken while building the spine (C0)

| # | Question | Default in the build |
|---|---|---|
| C0-1 | A sandbox cannot be bootstrapped: `iam.bootstrap_installation` inserts the "Installation qualification" person and BOOTSTRAP-CONSOLE-n devices, which the sandbox identifier guard (kernel 0920, TEST- only) refuses. | test-kit provisions a sandbox in two stages through the kernel's own functions: the kernel migrations before 0920, then the bootstrap with TEST- administrator and owner names, then every migration (the guard applies to everything created afterwards; the three pipeline labels predate it). Proposal for the lead: a kernel migration that gives the bootstrap TEST- labels in a sandbox. |
| C0-2 | First-login secret change: an initial secret is single use, so the login that proves it cannot be followed by a change that proves it again. | The refused login (409 MUST_CHANGE_SECRET) returns a change ticket (random, in server memory, 2 minutes, bound to identifier and terminal) that stands for the restricted CREDENTIAL_CHANGE authentication event; the change request presents the ticket. |
| C0-3 | Login method per terminal class | Kiosks (SHARED, GRADE_A_B) take badge and PIN only; office PCs take user ID and password only (refusal LOGIN_METHOD). |
| C0-4 | Role choice | When the account holds one role, the session takes it; with several, the session opens without a role and every route except session, lock, unlock and switch answers 409 ROLE_CHOICE_REQUIRED until the person chooses once. |
| C0-5 | Idempotency keys | Required (428 without) on mutating session routes that run GMP commands; not on login, logout, nonce, identification, role choice, lock, unlock, keep-alive, switch or scale capture. The route definition says which (`idempotency`). |
| C0-6 | Locked sessions | Reads and commands answer 423, except the session view (so the SPA can show the lock), logout, lock, unlock and switch user. |
| C0-7 | Extra personas and terminals | Each installation also gets a master-data steward persona (reference documents on GMP, TEST- lots in the sandbox) and the sandbox a second balance, TEST-BAL-02 in BLEND-1 (blend output weighing). |
| C0-8 | Strict CSP and libraries | zod runs jitless in the browser (its parser compiler and even its eval probe would violate script-src 'self'); react-aria's injected pressable style is replaced by the same rule in the kit's stylesheet. |
| C0-9 | Badge-tap rate limit | 30 taps a minute per terminal and badge (the plan said 10): every entry on a kiosk needs a tap, and a fast operator working a checklist would be refused at 10. The kernel's lockout and single-use events stay authoritative; the limiter only slows flooding. |

### Kernel items found while adapting Phase 2 to the Phase 1 exit (for the owner and the kernel lead)

Phase 2 does not change the kernel; each item says what Phase 2 does in the meantime.

| # | Kernel item | What Phase 2 does meanwhile |
|---|---|---|
| K1 | **The site policy `site.zone` takes any text (DI-27).** `iam.set_policy` (kernel 0130) checks only whole-number, true/false and listed-value keys, so `site.zone` accepts an abbreviation such as `IST`, a bare offset or a typo. EBMR-IAM-118 (0190) and EBMR-ESIG-035 (0230) then only compare the context's zone with that text, so they accept contexts that declare the same text. Further down the kernel treats the value in different ways: platform entries refuse it (`platform.entry_site_zone`, EBMR-PLAT-017) and so do retention schedules (EBMR-REC-020). But the signature row's UTC offset (`esig.utc_offset`, set by `esig.signature_guard` in 0220; the manifestation's local signing time is derived from it) and the market publication date (0340, `clock_timestamp() at time zone ...`) read the text as a PostgreSQL time-zone abbreviation. In PostgreSQL's default abbreviation set, `IST` is +02:00 (Israel), not India's +05:30 (checked on the development server). On any signature path that does not also go through `platform.entry_site_zone`, a manifestation could therefore show the wrong local signing time labelled IST. The market's "today" would also be a day behind from 18:30 to 22:00 UTC each day. Proposal: a kernel migration that makes `iam.set_policy` refuse a `site.zone` value that `platform.is_valid_time_zone` refuses (an IANA Area/Location name or UTC that the database knows), tested with `IST`, a bare offset and an unknown name. | The server reads `site.zone` at start-up and refuses to start (ConfigError) when the value is not an IANA zone name. It uses the kernel's `time.isValidTimeZone`, which applies the same rule as EBMR-PLAT-017. If the policy changes while the server runs, the server latches SITE_ZONE_CHANGED: every API request gets 503 and one operations alert is raised until a restart, and the restart then refuses the bad value. Test: `apps/tablets-server/test/platform/startup.test.ts`, "[DI-27] the server refuses to start when EBMR_SITE_ZONE differs from the site policy site.zone, or the policy holds no IANA zone name". Source: the merge review of phase-2/recipe-core (28 September 2026). PROGRESS.md already lists this as a Phase 1 exit follow-up. |
