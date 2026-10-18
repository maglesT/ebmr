# Defects and lessons

**Draft.** This page lists the significant bugs found and fixed in Phases 1 to 6A: what went wrong, why it matters in
a pharma plant, the root cause, the fix, the test that now guards it and what a developer should learn from it. It is
written for a developer who is new to the project and wants to avoid repeating these mistakes. Read the
[Top lessons](#top-lessons) first. The rest is a reference you search when you touch the same area.

Terms such as batch record, e-signature, hold point, deviation, G-REL and AP are explained once in the
[glossary](02-glossary.md); the [pharma primer](01-pharma-primer.md) gives the background.

## Where the code is

- Review backlogs: [Phase 2 exit](../build-plan/phase-2-exit/review-backlog.md),
  [Phase 3](../build-plan/phase-3/review-backlog.md), [Phase 4](../build-plan/phase-4/review-backlog.md),
  [Phase 6](../build-plan/phase-6/review-backlog.md).
- Phase 1 exit review results: [review-results-2026-09-28.json](../build-plan/phase-1-exit/review-results-2026-09-28.json)
  (88 findings; the reproducer of each is in [packages/kernel/test/review/](../../packages/kernel/test/review/)).
- Phase 4 mutation results: [mutation-results.md](../build-plan/phase-4/mutation-results.md).
- Full history (search it, do not read it whole): [history.md](../progress/history.md).
- Open owner decisions and answers: [phase-2-open-questions.md](../decisions/phase-2-open-questions.md).

## How to read an entry

Finding names differ by phase, and the numbers overlap, so the phase is always given:

- **P1-F12** means finding F12 of the Phase 1 exit review (numbers without a leading zero, F1 to F84).
- **P2-F12** means finding F12 of the Phase 2 exit review (two digits, F01 to F67), with its follow-up rounds.
- **P3-n** and **P4-n** are findings of the quick reviews of a slice (the number is the review's own, for example
  "slice 3b review 2"). **HIGH-n** is a finding of the Phase 3 exit review. **D-n** is a defect found by the Phase 2
  SQL mutation run. **F-A1** is a defect found by the Phase 4 mutation run. **M6-Dn** is a defect found during the Phase 6
  mutation campaign. **P6An-m** is entry m of analytics slice 6A-n (Phase 6A), and **P6g-n** an entry of slice 6g.
- "Control" means a line in `compliance/controls/` (for example DI-37). Tests that prove a control carry its ID in
  their name. See the [control register](../../compliance/controls/).
- "Migration 0319" means the numbered SQL file of that package (for example recipe-core 0319).
  Phase 1 findings were fixed on branch `phase-1/mutation-testing` before any deployment, mostly by editing the Phase 1
  files and adding a few new ones; from Phase 2 on, a fix is a new migration, because a migration that has run is
  never edited.

## Top lessons

These patterns came back again and again. If you remember only one page of this handbook, remember this list.

1. **The database is the last line of defence, not the server.** Many findings were "the server checks it, but a
   caller using the application role's own credentials could skip the server". Every rule that a regulation requires
   must also be a trigger, constraint or function guard in PostgreSQL (ADR 0012, decision 0008 section 2). A check that
   lives only in TypeScript is a convenience, not a control. (P1-F1, P2-F11, P2-F66, P2-F67, HIGH-4)
2. **Never trust a value the caller supplies about itself.** Site zone, time trust level, product, batch, approver
   id, "next step started", reading age, "aggregate type": each was once taken from the caller's word and each was a
   hole. Read the fact from the database (the batch row, the clock, the signature table), and treat the caller's value
   at most as a request to be checked. (P1-F5, P1-F24, P1-F42, P1-F46, P2-F38, P3 slice 1 findings 1 and 2)
3. **A signature must bind exactly what the signer saw.** If anything that matters is not in the signed content
   (a summary, a route, a quantity, an event, a date), it can change under a valid signature. Put every deciding fact
   in the signed text, show it in the dialog, and make the database refuse a row that records something else.
   (P2-F01, P2-F03, P3 slice 1 finding 4, slice 2 findings 1 and 3, HIGH-2, P3 slice 6 review)
4. **Check the rule at the moment the act happens, and again at every later act that could break it.** Rules such as
   "the checker is not the approver" were checked only when one of the two meanings was signed, so signing in the
   other order slipped past. Test both orders, and test the case where the second act is the one that breaks the rule.
   (P1-F13, P1-F41, P1-F73, P2-F11)
5. **Locks: take the same lock in the same order everywhere, and re-read after you wait.** Races showed up between a
   proposal and a signing, an edit and a submit, a close and a hold, two concurrent policy tightenings. Under
   READ COMMITTED a waiter must re-read the row after the lock; under REPEATABLE READ it cannot, so the code refuses
   that isolation level. (P1-F26, P1-F44, P2-F37, slice 3c finding on close and hold, P4 slice 5 amendment)
6. **Fail closed when information is missing.** A missing expiry date gave a shorter retention, a missing rule set
   gave "not applicable", a missing hold unit skipped a check, a lot with no lab results passed the release check.
   The safe answer to "I cannot tell" is "refuse" or "OPEN" (not decided), never "fine". (P1-F31, P1-F79, P3 slice 3c
   finding 5, P3 slice 5 backlog, P4 slice 3 review)
7. **Time has three enemies: the caller, the host clock and the clock zone.** Use database time for facts; use the
   monotonic clock for lifetimes (tickets, timeouts); never `Date.now()` in domain code; never take "today" in a zone
   the client names. A clock that steps back can lengthen a ticket or hide a fault window. (P1-F42, P1-F43, P1-F27,
   X44 in history, the GB-T-01 date fix)
8. **Numbers and text must be stored exactly.** A JavaScript `number` loses digits above 2^53; a lone surrogate or a
   NUL character in free text crashes a database write after the signer has already seen a hash; text that looks like
   a real batch number can hide in look-alike characters. Use bigint or decimal strings, refuse unstorable text at the
   edge, and close a class of problems by structure (an allow-list) rather than by listing bad cases. (the TB-11
   counter, P2-F30 to F33, P2-F12 rounds 1 to 8)
9. **Separate the people.** Segregation of duties was missed again and again: the person who raised an exception also
   dispositioned it; the outgoing person of a hand-over verified the step; the investigator concluded their own
   deviation; the abort requester signed the approval; a consumer witnessed the lot's destruction. When you add an
   act, list who is involved in the record and exclude them from the next act. (P2-F11, slice 2 review findings 4, 5
   and hand-over findings 2 and 6, slice 5 review, P4 slice 2 review)
10. **A guard without a test that fails when the guard is removed proves nothing.** Many early tests were green for
    the wrong reason (a pre-check in TypeScript shielded the database guard, a different rule fired first, a made-up
    id never reached the branch). Write the test that calls the database directly as the application role, and prove
    it fails without the migration. (P2-F13 to F25, the SQL mutation runs)
11. **Reads leak, too.** Hiding a row with row-level security still leaks through the query plan, row counts,
    statistics and error messages. A person under investigation must not learn of it. Revoke the reader instead of
    filtering when the existence of the data is itself secret. (P2-F34, F35, HIGH-WATER)
12. **Compare things in full, not by id or by count.** Strictness compared criterion ids only; a serial-number report
    was not compared with the recorded events; a true copy verifier accepted a bundle that left a table out; a replay
    compared event counts. Compare content, hash and order. (P1-F20, P1-F34, P2-F29, slice 4a findings)
13. **Dead and duplicate code rots.** A recipe-core copy of the platform authority function drifted from the kernel's;
    a function nobody called (`reprocessing_start_problem`) kept a guard no test could reach. Keep one definition (the
    kernel's scope hook, ADR 0018) and delete dead code with a migration. (slice 3a HIGH, migration 0930)
14. **Test infrastructure is production code for the pipeline.** Flaky tests came from real races (a pool closing
    before its sockets, a 5 s wait against a slow disk, a rate limit shared by parallel browser specs, two specs
    acting on one batch). Find the root cause; a retry only hides a bug that may be in the product. (section
    "Test flakiness and races")
15. **Diff replaced functions against their predecessor.** `create or replace function` silently drops any guard
    that the new body forgets. Every later review diffed the replaced functions against the previous definition; do
    the same, and keep the old guard's test in the same file. (slice 2b, 3b, 3c, 3d reviews)

---

## E-signatures

### P1-F1, F68, F74, F12 (critical): a co-signer's context could be reinstalled
- **What went wrong:** after a co-signature (two people sign one act), the second person's validated "actor context"
  stayed valid for the rest of the transaction. The application role could set it again and write rows as if the
  co-signer had done them.
- **Pharma consequence:** one person could forge another person's actions in the audit trail. That breaks attribution
  (who did it), the first thing an inspector checks.
- **Root cause:** the marker that says "this context is the validated one" was a set of rows; every context ever
  installed stayed valid (ADR 0016 flaw).
- **Fix:** `kernel.command_marker` now holds one row per backend, so only the most recently installed context is
  valid. A saved context is restored only through `kernel.set_actor_context`. See
  [0230_esig_sign.sql](../../packages/kernel/sql/0230_esig_sign.sql), [0010_audit_trail.sql](../../packages/kernel/sql/0010_audit_trail.sql) and
  [ADR 0016](../adr/0016-validated-actor-context-and-definer-hardening.md) (rewritten).
- **Test:** [f1.test.ts](../../packages/kernel/test/review/f1.test.ts), "[INV-40][INV-07][DI-22][DI-14][DI-13] bypass: after a
  co-signature, set_config back to the co-signer's context is refused"; also [f68](../../packages/kernel/test/review/f68.test.ts)
  and [f74](../../packages/kernel/test/review/f74.test.ts).
- **Lesson:** four reviewers found the same hole from four angles. Anything that is "valid for the rest of the
  transaction" needs an explicit end.

### P1-F13, F14, F15, F41, F73: segregation checked in only one signing order
- **What went wrong:** the independence rules (the checker is not the approver, the witness signs before the next
  step) were evaluated only when the constrained meaning was signed, only against signatures already present. Signing
  the approval first, or in an earlier lifecycle state, let one person hold both roles. The witness rule trusted a
  boolean (`nextStepStarted`) that the caller supplied, defaulting to false.
- **Pharma consequence:** the four-eyes principle (a second person must independently check) was defeated. That is a
  classic data-integrity finding.
- **Root cause:** rule evaluated in one direction; platform hook adapter ignored the actor and the state; caller-owned
  flag.
- **Fix:** both signing orders are checked, the state engine refuses a signature applied before the transition's
  from-state or by someone other than the actor, the "next step started" fact is read from the record. Files:
  [0230_esig_sign.sql](../../packages/kernel/sql/0230_esig_sign.sql), [0550_platform_state_engine.sql](../../packages/kernel/sql/0550_platform_state_engine.sql).
- **Tests:** [f13](../../packages/kernel/test/review/f13.test.ts) "[INV-03][INV-04][DI-35][DI-17] verify-then-perform and
  approve-then-check by one person are refused or detected"; [f14](../../packages/kernel/test/review/f14.test.ts);
  [f15](../../packages/kernel/test/review/f15.test.ts); [f41](../../packages/kernel/test/review/f41.test.ts);
  [f73](../../packages/kernel/test/review/f73.test.ts) (both orders).
- **Lesson:** for every pair of acts that must be done by different people, write two tests, one for each order.

### P1-F16: a second spelling of an aggregate id was a second record
- **What went wrong:** `BATCH-1` and `batch-1` (or an upper-case step id) made two identities for one record, so
  "once per version", the aggregate lock and the independence rule did not see the earlier signature.
- **Consequence:** the performer could verify their own step by spelling its id differently.
- **Fix:** ids are canonicalised at the point of use (see [0250_esig_stub.sql](../../packages/kernel/sql/0250_esig_stub.sql)).
- **Test:** [f16](../../packages/kernel/test/review/f16.test.ts) "[INV-03][DI-35][INV-09] the performer cannot verify
  their own step by spelling its id in upper case".
- **Lesson:** canonicalise identifiers at the single point of entry.

### P1-F17: a no-op save changed the signed hash
- **What went wrong:** the sample record's content version came from a count of audit UPDATE events, so a save that
  changed nothing altered the hash without superseding the signature (signature read CONTENT_MISMATCH).
- **Fix:** the version no longer comes from the count of UPDATE events ([0910_integration_esig.sql](../../packages/kernel/sql/0910_integration_esig.sql)).
- **Test:** [f17](../../packages/kernel/test/review/f17.test.ts) "[INV-09][DI-37] after an UPDATE that changes no signed
  column the signature is VALID or SUPERSEDED_BY_CHANGE, never CONTENT_MISMATCH".
- **Lesson:** derive a version from content, never from a side counter.

### P1-F24, F76 (high): approvals behind a loosening were free UUIDs
- **What went wrong:** the approvers of a market-rule loosening (a looser limit) were any UUID the caller typed.
- **Consequence:** one person could loosen an India acceptance criterion or a label rule with no real second
  approval, in a system whose rule is that the stricter market wins.
- **Fix:** approvals must be real e-signatures of real people with the right role (checks in
  [0340_market_publish.sql](../../packages/kernel/sql/0340_market_publish.sql) and [0360_market_signatures.sql](../../packages/kernel/sql/0360_market_signatures.sql)).
- **Tests:** [f24](../../packages/kernel/test/review/f24.test.ts) "[IN-52][DI-35][DI-09][INV-47][ST-01] source
  correction, site-value loosening and policy loosening are refused without real signed approvals";
  [f76](../../packages/kernel/test/review/f76.test.ts).
- **Lesson:** an id column that "points at an approval" needs a foreign key and a validity check.

### P2-F01: the stage sign-off summary was not in the signed text
- **What went wrong:** a stage sign-off confirms the stage record and its summary (open exceptions, yields), but the
  summary was in neither the signed content nor the dialog. An alert raised after the supervisor's preview changed
  what the sign-off recorded without refusing the signature. Round 2 found the check compared only the summary's
  canonical form, so a row could add a member (a step count, a yield verdict) under a valid signature.
- **Fix:** the summary is part of the signed text, produced by one function for the dialog and for the database
  (recipe-core 0319); the database refuses a sign-off row that differs from what the engine records (0320, EBMR-EXE-135).
- **Tests:** [db-guards-stage-summary.test.ts](../../apps/tablets-server/test/execution/db-guards-stage-summary.test.ts),
  "[DI-37][IN-15][PR-16] a SIGN_OFF_STAGE row recording another summary than its signature covers is refused
  (EBMR-EXE-135)"; [db-guards-stage-sign-off.test.ts](../../apps/tablets-server/test/execution/db-guards-stage-sign-off.test.ts).
- **Lesson:** a signature is only as strong as the rule that the stored row equals the signed text.

### P2-F02, F03: the dialog named a different thing from the signed content
- **What went wrong:** a time-limit breach dialog said "Not raised at a step" while the signed content named the step.
  The signed header took family and product from the test package's metadata, not from the MBR content.
- **Fix:** dialog and content use the same source; the server and database (recipe-core 0318, EBMR-EXE-134) refuse a
  package whose metadata differs from its content.
- **Test:** [db-guards-package-header.test.ts](../../apps/tablets-server/test/execution/db-guards-package-header.test.ts)
  "[DI-04][DI-37] a package whose family code or product differs from its MBR content is refused".
- **Lesson:** metadata beside content is a second source of truth; avoid it or check it.

### P2-F37 and F37.R: a proposal during a signing landed on the signed version
- **What went wrong:** a second QA user's disposition proposal made while the first was signing landed on the version
  being signed, so the signature read CONTENT_MISMATCH. The first fix (recipe-core 0309) locked only the batch's
  lock; a signer outside the batch lock, or a transaction at REPEATABLE READ or SERIALIZABLE, still raced.
- **Fix:** proposals take the batch lock first and never propose on a signed version (0309); the signing and proposal
  paths share one lock and refuse stricter isolation levels (0329, 0331, kernel 1020).
- **Test:** [db-guards-proposal-race.test.ts](../../apps/tablets-server/test/execution/db-guards-proposal-race.test.ts),
  "[INV-09][DI-37][PR-49] a disposition proposed through the store while QA1's signed disposition commits waits for it
  and is refused; QA1's signature stays VALID".
- **Lesson:** see Concurrency below. Two connections in a test are the only honest proof of a lock.

### P2-F39, F40, F56: ceremony screens signed the wrong thing or told the wrong thing
- **P2-F39:** switching person from the lock screen left the previous person's signing dialog open; the new person
  could sign the previous person's decision. Now any change of person ends the signing with nothing signed
  (web test `ceremony-person-change`).
- **P2-F40:** a resent kiosk sign request after success was told "Nothing was signed". It now gets ESIG_ALREADY_SIGNED
  or ESIG_REQUEST_USED ([ceremony.test.ts](../../apps/tablets-server/test/esig/ceremony.test.ts)).
- **P2-F56:** the signing dialog's focused Badge field sent whatever was keyed in (the PIN) as the badge UID, and any
  refusal ended the signing. The ui-kit badge prompt now accepts only a reader's tap (keys more than 100 ms apart
  restart the field) and sends nothing that cannot be a badge UID (EBMR-IAM-140).
- **Lesson:** a security-sensitive input must know where its data can come from (a badge reader types fast; a
  person does not).

### P3 slice 2 findings 1 and 3, hand-over 3: approvals not bound to the act they approve
- **What went wrong:** approvals of a skip, a void or an invalidation did not name the act, persons and reason. A QA
  approval could be reused for another act. The hand-over's QA approval was not bound to the step, persons and
  reason.
- **Fix:** approved acts are bound (recipe-core 0470, 0471; hand-over 0462); see
  [db-guards-change-paths.test.ts](../../apps/tablets-server/test/execution/db-guards-change-paths.test.ts) and
  [db-guards-hand-over.test.ts](../../apps/tablets-server/test/execution/db-guards-hand-over.test.ts).
- **Lesson:** the approval row carries the identity of the thing approved, and the guard compares it.

### P3 slice 1 finding 4, slice 2 finding 7, HIGH-2: lot signatures that did not bind enough
- **Slice 1, finding 4:** the cleaning clearance signature did not bind its result.
- **Slice 1, backlog 6 and slice 2 finding 7:** the lot release signature did not cover the route or the received
  quantity, and every consumption superseded the lot's release signature (so releasing and using a lot undid each
  other). Fixed in site-services 0720 and 0721: the signature covers route and received quantity; consumption no
  longer supersedes it; a person who consumed from the lot cannot witness its destruction.
- **HIGH-2 (Phase 3 exit):** a lot decision signature (HOLD, UNHOLD, RETURN, RECALL) did not bind the event. Now
  the decision is proposed first and the signature binds the proposed event (site-services 0800); over HTTP it is
  proposed at `POST /api/lots/:lotId/decisions` and signed as LOT_DECISION (0842, D-P4-3).
- **Slice 6 review:** the signed lot retest did not bind its date and results, could reuse one signature, and the
  unsigned writer stayed granted to the application role. Fixed in site-services 0762 and tablets 1042.
- **Tests:** [signables-ids.test.ts](../../apps/tablets-server/test/quality/signables-ids.test.ts) "[DI-37][DI-35] the
  retest binds the lot, the new instant in UTC with microseconds, and the result ids lower-cased, distinct and
  sorted"; [lims.test.ts](../../packages/site-services/test/quality/lims.test.ts) "[PR-18][DI-35] a retest is recorded
  only under QC's own LOT_RETEST_APPROVED signature"; [exit-review.test.ts](../../packages/site-services/test/lots/exit-review.test.ts).
- **Lesson:** after adding any new act, list what the signer must be sure of and put each item in the content.

### P6f review: a DSC from any certificate of the CA stood beside anyone's signature
- **Defect:** kernel 1203 checked the chain to the anchor and the statement, but not whose certificate signed: a
  valid certificate of the test CA held by someone else was recorded beside the signer's password signature. Fixed in
  kernel 1206: a person enrols the certificate of their own token (proof of possession over a statement naming the
  person and account); a certificate is live for one person only; `esig.record_dsc_signature` refuses a certificate that
  is not the signer's live enrolment (EBMR-ESIG-087).
- **Tests:** [dsc.test.ts](../../packages/kernel/test/esig/dsc.test.ts) "[IN-10] a DSC is accepted only from the
  certificate enrolled for the signer: another person's certificate, a stolen enrolment or an ended one is refused";
  [governance-routes.test.ts](../../apps/tablets-server/test/governance/governance-routes.test.ts).
- **Lesson:** a second signature must be bound to its signer as tightly as the first; a valid chain says who issued the
  certificate, not who holds it.

### P2 mutation D8, D9, D11: signature rows accepted on a flag alone
- **D8:** a recorded signature's missing validity went unnoticed (recipe-core 0381). **D9:** any row could invalidate
  another step's signature (0382). **D11:** the kernel took a signature row on the signing marker alone; now a row is
  held to its challenge (EBMR-ESIG-065) and to an authentication consumed for it in the same transaction (EBMR-ESIG-066)
  (kernel 1112), and state rows need a published transition and a history row (EBMR-PLAT-077, -078; kernel 1110).
- **Lesson:** a flag set by trusted code is not proof when the table owner can set it too. Hold the row to the
  evidence rows it depends on.

## Audit trail and attribution

### P1-F2, F3, F4: the chain could be rewritten or hidden
- **F2:** `verify_chain` and anchors did not bind `table_name` and `record_id`, so rewriting them was undetectable.
  Fix in [0010_audit_trail.sql](../../packages/kernel/sql/0010_audit_trail.sql); test
  [f2](../../packages/kernel/test/review/f2.test.ts) "[INV-08][DI-23][INV-07] rewriting table_name/record_id of an
  audit row directly in the database is detected".
- **F3:** full verification listed chains from the head table, so deleting a head row hid a tampered chain. The
  verification now reports a chain whose head is missing; test [f3](../../packages/kernel/test/review/f3.test.ts). The same defect
  reappeared in the screen as **P2-F06** (a chain whose head was deleted vanished from the chain list; tablets 0490).
- **F4:** `kernel.ddl_log` did not record DROP statements and `audit_triggers_ok` ignored the insert-only guard
  triggers, so dropping a guard went unseen; test [f4](../../packages/kernel/test/review/f4.test.ts).
- **Pharma consequence:** the audit trail is the evidence for everything else. A trail that can be edited silently is
  worthless to an inspector.
- **Lesson:** a verifier must work from the data, not from a list the attacker can edit.

### P1-F5, F6, F46, F77: facts in an audit entry came from the client
- **F5/F46:** site zone and printed name came from the client's context. Now `kernel.validate_actor_context` refuses a
  zone other than the site policy zone (EBMR-IAM-118). Tests [f5](../../packages/kernel/test/review/f5.test.ts),
  [f46](../../packages/kernel/test/review/f46.test.ts).
- **F6:** a whitespace-only reason code or no reason text passed the reason-for-change gate. Now both code and text
  are required and non-blank (EBMR-AUDIT-002). Test [f6](../../packages/kernel/test/review/f6.test.ts). It broke six
  platform and records tests that had relied on a missing text, and they were corrected.
- **F77:** a change of a row's aggregate column was recorded only in the new aggregate's chain; the old chain never
  showed the row leaving. Test [f77](../../packages/kernel/test/review/f77.test.ts).
- **Lesson:** "reason for change" is a control (21 CFR 11.10(e) style audit rule); test blank and invisible text, not
  only the empty string.

### P2-F01 round 2 and P4 slice 1: tables that were not audited
- The list of legacy sign-offs (recipe-core 0319) was owner-only and unaudited, so the privilege test failed; 0320
  made it an audited, insert-only record. In general a new table either joins the audit and insert-only machinery or
  is documented as not needing it.
- **P4 slice 1 (epochs):** the evidence epoch was a counter updated in place and not audited. Recipe-core 0718
  replaced it with insert-only rows written under a per-subject lock (see [Removed and replaced](09-removed-and-replaced.md)).

## Time and clocks

### P1-F42, F43, F47, F48, F49, F69: trust in time
- **F42:** the caller could label a typed time DEVICE_SYNCED and skip every late-entry control. Test
  [f42](../../packages/kernel/test/review/f42.test.ts).
- **F43:** the review window of a time fault was bounded by the faulty clock, so entries recorded across a clock
  step were never flagged. Test [f43](../../packages/kernel/test/review/f43.test.ts).
- **F47:** a drift sample with an uncertainty above the threshold cleared the alarm and became the "last good sample".
  Test [f47](../../packages/kernel/test/review/f47.test.ts).
- **F48:** `record_drift_check` aborted (a raw error) for extreme offsets and thresholds with more than 3 decimals,
  and nothing noticed a monitor that cannot run. Test [f48](../../packages/kernel/test/review/f48.test.ts).
- **F49:** a "validated" time source was not verified; one administrator could swap references and silence
  monitoring. Test [f49](../../packages/kernel/test/review/f49.test.ts).
- **F69:** `platform.raise_time_incident` was callable by the application with no authority check, so anyone could
  forge, or pre-empt, a time-fault incident. Test [f69](../../packages/kernel/test/review/f69.test.ts).
- **Files:** [0520_platform_time_sources.sql](../../packages/kernel/sql/0520_platform_time_sources.sql),
  [0530_platform_time_model.sql](../../packages/kernel/sql/0530_platform_time_model.sql).
- **Consequence:** back-dated or late entries are a favourite data-integrity finding; the system must know how much
  to trust each timestamp.

### P1-F27: "today" taken in a zone the client named
- The retroactivity test for rule-table loosenings used a client-supplied zone and could shift "today" back by up to
  seven days. Fixed in [0340_market_publish.sql](../../packages/kernel/sql/0340_market_publish.sql) to use the site zone.
  Test [f27](../../packages/kernel/test/review/f27.test.ts).

### P2-F38, P2 D3: how old a reading may be
- **F38:** the allowed age of a scale reading was the caller's word (up to one hour). Now the platform setting
  `device.reading_max_age_s` (120 s, tightening only) caps it (tablets 0360). Test
  [reading-age-policy.test.ts](../../apps/tablets-server/test/devices/reading-age-policy.test.ts) "[DI-28][DI-32] a
  10-minute-old reading pair is refused at 120 s, and still refused when the application role asks for 3600 s".
- **P53 residual (tablets 0330):** the wait of a reading before upload was the application's word. A holder of the
  application credentials could keep back a genuine unsynced reading and have it counted as fresh. The gateway now
  signs a database-issued challenge together with its wait (`tab.ingest_reading` was replaced; see
  [Removed and replaced](09-removed-and-replaced.md)).
- **Lesson:** age is computed by the database from its own clock plus a signed delay, never reported.

### Ticket lifetimes followed the wall clock (X44, 1 October 2026)
- **What went wrong:** the proof tickets (10 minutes) and first-login change tickets (2 minutes) the server keeps in
  memory used `uptimeMs = Date.now() - start`. A clock set back lengthened a ticket's life.
- **Fix:** `platform/clock.ts` reads both `performance.now()` and `Date.now()` and takes the larger elapsed time, so a
  step back does not lengthen a ticket.
- **Tests:** [proof-ticket-clock.test.ts](../../apps/tablets-server/test/session/proof-ticket-clock.test.ts) "[DI-19] a wall
  clock set back does not lengthen a proof ticket"; [change-ticket-clock.test.ts](../../apps/tablets-server/test/session/change-ticket-clock.test.ts).
- **Lesson:** this is why domain code may not call `Date.now()`; a lint rule and a test enforce it.

### The GB-T-01 true-copy hash changed with the day of the run (PR #19)
- **What went wrong:** the golden batch's true-copy hashes depended on the run date: seeded lot dates were
  normalised as run instants, and a deviation number held the year.
- **Fix:** lot dates stay as seeded; the year is a placeholder; hashes re-recorded and shown equal on runs started on
  different days (`EBMR_GOLDEN_LATER_DAYS`). Test code only.
- **Lesson:** a golden test that is not repeatable tomorrow is not a golden test. Freeze time at midnight UTC.

## Access and read authorisation

### P1-F70, F78, F45, F72, F79, F71: who may do what
- **F70:** one administrator could rewrite the least-privilege permission-to-role map with `iam.add_role_permission`.
  Now a request plus a second approver. Test [f70](../../packages/kernel/test/review/f70.test.ts) "[DI-18][DI-17][INV-11] a lone
  administrator cannot give operators a GMP permission, nor give their own role new authority".
- **F45/F78:** `platform.create_aggregate_state` had no permission or administrator check, so any caller could create
  GMP state or pin it to a retired machine version. Every state machine now declares a `create_permission` and every
  transition a permission. Tests [f45](../../packages/kernel/test/review/f45.test.ts), [f78](../../packages/kernel/test/review/f78.test.ts).
- **F72:** a denied permission left no stored evaluation, so a failed attempt was not logged. Test
  [f72](../../packages/kernel/test/review/f72.test.ts).
- **F79:** qualification (training) requirements were skipped when the request had no scope in that dimension, so the
  training gate failed open. Test [f79](../../packages/kernel/test/review/f79.test.ts).
- **F71:** a batch-number counter reservation was authorised at the actor's own location, so a SITE-1 issuer could
  touch a SITE-2 counter. Test [f71](../../packages/kernel/test/review/f71.test.ts).
- **Lesson:** "who may call this" is a control; every writer that the application role can call needs a permission
  check and an administrator refusal (DI-17, DI-18).

### P1-F11: lockout counter reset by any success
- A single-factor badge tap reset the failed-password counter, so lockout could be dodged by interleaving taps.
  Test [f11](../../packages/kernel/test/review/f11.test.ts) "[DI-19] failed password guesses interleaved with the
  victim's badge taps still lock the account at the threshold". File
  [0160_iam_authentication_sessions.sql](../../packages/kernel/sql/0160_iam_authentication_sessions.sql).

### P2-F34, F35 (rounds 1 to 3, HIGH-WATER): the application role read what it should not
- **What went wrong:** the signing preview served the content of any record to any session; the audit viewer served
  every chain to every role; a data-integrity investigation reached the person it was investigating.
- **Root cause:** read access was decided in the screen; the application role kept SELECT and EXECUTE on kernel
  readers. Row-level security hid rows but the plan statistics (`EXPLAIN ANALYZE` "rows removed by filter", row
  estimates, `reltuples`) still told how many investigations existed, and when (HIGH-WATER).
- **Fix:** the database decides read access per session (tablets 0410, 0420); readers and tables revoked from the
  application role (0430, 0440, 0450, 0460, 0470); table statistics reads closed (0570); the investigation's subject
  gets nothing, whatever their role.
- **Tests:** [esig/read-authorisation.test.ts](../../apps/tablets-server/test/esig/read-authorisation.test.ts) "[DI-17][DI-50] the person
  a DI investigation investigates gets nothing of it, neither its content nor its signatures";
  [audit/read-authorisation.test.ts](../../apps/tablets-server/test/audit/read-authorisation.test.ts).
- **Residual:** the application role still selects the identity, incident and retention tables directly (decision
  F34.2, below).
- **Lesson:** to hide that something exists, do not grant the reader. Filtering is not enough.

### P2-F36, F10, F41, F42, F43: sessions and the browser
- **F36:** a revoked or expired role kept reading and could keep a session alive or unlock it. Now such a session
  resolves no role and ends at the next request (tablets 0400, EBMR-TAB-017); an account with no role opens no session
  (0480). Test [role-withdrawn.test.ts](../../apps/tablets-server/test/session/role-withdrawn.test.ts).
- **F41:** a page on another port could plant a copy of the session cookie that the server read first. A doubled
  session or CSRF cookie is now served as nobody, and the copies are removed.
- **F42:** the sign-out mark was a cookie any port could write or delete. It now lives in site storage and the
  origin's broadcast channel only.
- **F43:** the gate's own refusals (403 ORIGIN, non-literal /api 404) carried no security headers; helmet now runs
  first. Browser security spec covers these.
- **Lesson:** cookies are shared across ports on one host; do not trust a cookie that any local page can set.

### P2-F04, F05, F08, F09: kiosk secrets
- **F04:** a first-login PIN change left open on a shared kiosk let the next person choose the absent person's PIN.
  The kiosk wipes the badge UID after 30 s, names whose PIN is set, and the database refuses the change when the
  authentication is older than the terminal's attribution window (kernel 0990).
- **F05:** a PIN longer than 12 digits was accepted but could never be typed. One maximum now in pads, contract and
  kernel; test [pin-length.test.ts](../../apps/tablets-server/test/session/pin-length.test.ts) "[DI-19][DI-15] the pads, the
  contract and the kernel use one maximum: 12 digits".
- **BADGE-AUTOFILL (round 4):** a password manager filled a ten-digit secret into the kiosk Badge field and it was sent
  as a badge UID; those fields now tell managers to leave them alone.
- **Lesson:** a limit must be the same in every layer, or the layers disagree on what is valid.

### P3 slice 6 review, HIGH-1: confidential and master data
- **Slice 6 high:** the formula composition (confidential) was readable through the e-signature content route by a
  role without FORMULA.READ (DI-13), also for a pinned MBR's BOM. Fixed in tablets 1042; test
  [formula.test.ts](../../apps/tablets-server/test/master-data/formula.test.ts) "[DI-13] the e-signature preview of a formula
  version, or of an MBR version pinning one, is refused to a session without FORMULA.READ, even on a shop-floor kiosk".
- **HIGH-1 (Phase 3 exit):** ERP master data (materials, shelf life, beta-lactam flag) could be written by any
  interface identity with no QA confirmation. Now only the ERP interface writes (`ERP.MASTER_WRITE`) and a
  safety-relevant change (new code, shelf life, reprocessing permission, material kind, retest interval,
  beta-lactam) takes effect only after QA signs `ERP_MASTER_CONFIRMED` (tablets 1101; site-services 0803 added the
  beta-lactam case). Test [interfaces.test.ts](../../packages/site-services/test/quality/interfaces.test.ts) "[PR-47][IN-38] a
  change of the beta-lactam flag (it drives the isolation of the packing line) takes effect only once QA confirms it".
- **Consequence:** a wrong beta-lactam flag removes the cross-contamination isolation on a packing line.
- **P4 low residual (open):** `allocation_register`, `qp_reader_access` and `read_qp_package` do not refuse
  administrators first.

### P4 slice 6 review: records that administrators could read
- The inspection workspace read and the allocation register were readable by administrators; an unsigned hazard
  downgrade was allowed; contingency packs could be made after completion. Fixed with the slice 6 quick-review fixes (kernel 1174, commit eb348d4c; see [evidence-export.test.ts](../../packages/kernel/test/records/evidence-export.test.ts) "[DI-40][DI-18] an
  administrator does not read the inspection workspace (refused before the permission check)").

## State machines and step order

### P2-F66 (critic, reproduced): the database let a step start that the token could not have reached
- **What went wrong:** a row could enable a step ahead of the flow, and the server then started dispensing during
  the line clearance.
- **Consequence:** material weighed into a line that had not been cleared: cross-contamination risk.
- **Fix:** recipe-core 0307 checks every new step instance against the MBR flow (earlier steps finished, stages
  signed off, loops ended, decisions taken, frames right) and 0311 binds a step's status change to the act that makes
  it (EBMR-EXE-129 from 0307, EBMR-EXE-132 from 0311).
- **Test:** [db-guards-step-order.test.ts](../../apps/tablets-server/test/execution/db-guards-step-order.test.ts) "[DI-34][PR-13][INV-18] a row that
  brings in a step the token has not reached is refused, so the dispensing cannot start before the line clearance is done".
- **Lesson:** the engine (TypeScript) walks the flow; the database must independently refuse any row that the walk
  would not produce.

### P2-F67: minimum durations and exception blocks held only by the engine
- A PERFORMED signature before a one-hour minimum, and of a step blocked by an open action-limit breach, were stored
  through the store. Now refused by the database (recipe-core 0308, EBMR-EXE-130/131), and start and end events are
  bound to the acts and token arrivals that make them (0312, 0314, 0316).
- **Test:** [db-guards-step-acts.test.ts](../../apps/tablets-server/test/execution/db-guards-step-acts.test.ts) "[INV-20][PR-30] a step
  signed performed before its minimum duration is refused by the database, not only by the engine".

### P2-F11: an exception's raiser dispositioned it
- A person who worked in the step that raised an exception could disposition it through the store (the content
  provider named only the raiser). Now the provider names performers, data enterers, correctors and PERFORMED signers,
  `check_disposition_state` refuses (EBMR-EXE-087) and, from round 3, the step is also read from the row that raised
  the exception, not only from the writer-supplied source (recipe-core 0306, 0310, 0315).
- **Test:** [db-guards-disposition-involvement.test.ts](../../apps/tablets-server/test/execution/db-guards-disposition-involvement.test.ts)
  "[INV-03][PR-13][PR-49][DI-17] a person who entered data in the raising step, also holding QA_SHOP_FLOOR, cannot
  disposition the exception through the store directly".

### P2 T12.LATE and T12.DOC: a late witness stuck the run
- **What went wrong:** a witness more than five minutes late, or after the run had moved on, was refused by the kernel
  and nothing else could complete the step; the run was stuck for good. The approved master also showed "VERIFIED"
  while the floor asked for a timed witness.
- **Fix:** engine 1.5.0 and recipe-core 0333: once no witness is possible, the step is completed by its later review
  (VERIFIED), which raises WITNESS_LATE for QA (EBMR-EXE-141). The validator rule GMP-WITNESS-NO-ATTACHMENT warns.
- **Lesson:** every refusal must leave the run a way forward (a supervised path), or you create a dead end that people
  work around with paper.

### P2 D6, D12: the designer let impossible MBRs through
- **D6:** a minimum time ending at the start of a node passed the validator, but the engine starts such a node itself;
  an honest run broke the engine's own INV-20 check. The validator now refuses it (rule TIME-MIN-AT-ARRIVAL).
- **D12:** two loops on the same endpoint, one inside the other, judged one reading twice and stopped the batch. The
  validator rule FLOW-LOOPS refuses it. Validator 1.2.0.
- **Lesson:** catch it in the designer, where the author can fix it; keep the database refusal as the last line.

### P3 hand-over (slice 2): hand-over dead ends and conflicts
- A step stayed stuck in ATTEMPT_HANDED_OVER when the incoming person never came; the incoming person was not checked
  to be active and a performer; the hand-over's supervisor, QA approver and both persons could disposition its
  exception or verify the step; the outgoing person could still correct entries (recipe-core 0461, 0462, fix commit
  5f0242a8). Tests in [db-guards-hand-over.test.ts](../../apps/tablets-server/test/execution/db-guards-hand-over.test.ts).

### P4 slice 5 (high): an amendment's cause lacked its reference
- The cause of an appending amendment (after record lock) lacked its reference, so every opening was refused. A
  medium finding: a cause linked again after a re-confirmation did not suspend the lot again. Fixed with tests in
  [after-release.test.ts](../../packages/recipe-core/test/release/after-release.test.ts); also D-5b-9 (an amendment counts lots
  already suspended and its cause resolves at close).

### P4 (commit 7bd4a37c): a recalled or rejected market was removed from the lot's set
- After-release market removal could remove a market that was recalled or rejected, hiding a recall from the lot
  record (recipe-core 0841). Test: "[L-19][INV-39] a market recalled on its own is final for that market only".

## Decimals, numbers and text

### Phase 3 exit: the TB-11 press counter was compared as a JavaScript number
- **What went wrong:** a press counter above 2^53 would be rounded in a comparison.
- **Consequence:** an IPC (in-process check) due-by-count could be missed on a high-volume press.
- **Fix:** compared as an exact integer (bigint), and a counter above the safe integer is refused rather than rounded.
- **Test:** [blocks.test.ts](../../apps/tablets-server/test/blocks/ipc/blocks.test.ts) "[DI-28][PR-29] the press counter is
  compared as an exact integer up to the largest safe integer, and a counter above 2^53 is refused, never rounded".
- **Lesson:** this is the reason for the rule "no JavaScript `number` for GMP values in domain code".

### P3 slice 3d lows: yield rounding before the limit test
- Compaction yield was rounded before it was compared with its limits, which could turn 99.51 against a 99.5
  rounded limit into a pass or a fail incorrectly. Now compared exactly (commit bcc22810); the forming constraint
  values are parsed robustly.
- **Lesson:** round only for display, after the decision.

### P3 slice 3b: TB-01 rounding and base-stated formula
- The golden batch found that TB-01's formula had to be stated on the base (anhydrous) form, and that hardness
  aliases and pressure units were missing. Fixed with tests (slice 6d: seven defects found by running GB-T-01).
  Rounding of the active goes up, never down (see `[PR-19]` test in
  [potency.test.ts](../../apps/tablets-server/test/blocks/dispensing/potency.test.ts) "rounding never lowers the active").

### P2-F30 to F33: NUL characters and lone surrogates in free text
- **What went wrong:** the contract took any string. A U+0000 or an unpaired UTF-16 surrogate in free text
  (exception description, hold reason, justification, product name) reached a `jsonb` or `text` bind. PostgreSQL
  refused it with no EBMR code, the server answered 500, wrote no refusal row, and had already shown the signer a
  hash for content that could never be stored. A lone surrogate was silently turned into U+FFFD, so a justification
  was stored with a character its author never sent. The two canonical JSON writers disagreed on key order for such
  text.
- **Fix:** both canonical JSON writers refuse such text (EBMR-ESIG-004); every route refuses it at any depth with
  400 INVALID_INPUT naming the field and never the text; request bodies must be strict UTF-8; the database pools refuse
  a parameter that holds such text; the gateway listener got the same rules.
- **Tests:** [execution/free-text.test.ts](../../apps/tablets-server/test/execution/free-text.test.ts),
  [designer/free-text.test.ts](../../apps/tablets-server/test/designer/free-text.test.ts),
  [gateway-free-text.test.ts](../../apps/tablets-server/test/devices/gateway-free-text.test.ts).
- **Lesson:** validate text at the edge (storable, strict UTF-8). The signer's hash is only honest if the server can
  store exactly that text.

## Test mode isolation (P2-F12, eight rounds)

This is the longest single finding in the project, and it explains decision 0008 (review cadence). It is listed here
because the lesson is about structure.

- **What went wrong:** a real batch or lot number could be recorded in a test (sandbox) run. A sandbox record must
  never be mistaken for a GMP record, so the rule is: only identifiers that start with `TEST-` are accepted.
- **Rounds 1 to 6:** each round closed the members the previous verification had found (entry identifiers, container
  names, free text, kernel stubs, market stubs), and the next verification found another way, for example a lot
  number inside a comment or an engine-style name like `S24090017` or `E2409/0017`.
- **Rounds 7 and 8:** the identifier rule read text as stored, not as shown. Invisible characters, look-alike letters
  and digits (Cyrillic, Hebrew, Georgian) and bidirectional controls hid a real-format number. Chasing glyphs has no
  end.
- **Final fix (closed structurally, kernel 1050, 1120):** in a sandbox a word that holds a digit is written with ASCII
  letters, ASCII digits and `/ . -` only, so no look-alike can be used. Earlier layers remain (kernel 1030, 1040;
  recipe-core 0346 and 0347 replaced a set of allowed engine words; see [Removed and replaced](09-removed-and-replaced.md)).
- **Tests:** [db-guards-entry-identifiers.test.ts](../../apps/tablets-server/test/execution/db-guards-entry-identifiers.test.ts)
  "[DI-05][INV-18] the same entry written through the store with the application role is refused by the database
  (EBMR-EXE-078)"; [db-guards-kernel-stubs.test.ts](../../apps/tablets-server/test/execution/db-guards-kernel-stubs.test.ts);
  the `db-guards-free-text-*.test.ts` files in the same folder.
- **Lesson:** when a class of bug keeps coming back, stop listing bad cases and allow only a small safe alphabet.
  Also: set an end to review rounds (decision 0008 limits fix rounds to two per finding).

## Release and the release gate

### P3 exit HIGH-3: a packaging order skipped "release for packing"
- A packaging batch could start without bulk that the processing batch had released for packing (hold point H-PACK).
- **Fix:** a packaging order needs a bulk issue of usable containers after H-PACK before any TB-21, TB-23 or TB-24
  entry on GMP (recipe-core 0701, tablets 1102); packing steps inside a GMP processing batch are refused.
- **Test:** [bulk-gate-gmp.test.ts](../../apps/tablets-server/test/blocks/packaging/bulk-gate-gmp.test.ts) "[INV-27][IN-18][PR-37] on GMP the
  first entry of a cartoning step (TB-24) in a batch with no bulk issued is refused by the database (EBMR-TAB-395)".
- **Lesson:** the "demo shortcut" for H-PACK that came later (see below) was removed so that no demo record carries a
  placeholder signature.

### P3 exit HIGH-4: orphan consumption
- `recipe.consume_lot` checked no batch state, so lot material could be "consumed" into a batch that was not running,
  or without a matching entry.
- **Fix:** consumption needs an ISSUED or IN_PROGRESS batch and an entry of the same command; reservations are revoked
  at batch end (recipe-core 0700, 0801; tablets 1100).
- **Test:** [tb-01-gmp.test.ts](../../apps/tablets-server/test/blocks/dispensing/tb-01-gmp.test.ts) "[INV-13][INV-14] past the server, a GMP weighing that
  names no consumption, or a consumption of another quantity, is refused by the database".
- **Consequence:** a stock balance that does not match the batch record: a reconciliation failure.

### P4 slice 2 (high): evidence matched by hash alone
- Recipe-core 0601 and 0716 accepted a fail-to-pass correction's evidence by the hash in `site.evidence_document`, a
  value the storer typed. A self-attested document could clear a failing result. The database now stores the bytes and
  computes the SHA-256 (site-services 0823) and a document is evidence only while its stored bytes match (recipe-core
  0770).
- **Test:** [gmp-references.test.ts](../../packages/recipe-core/test/lifecycle/gmp-references.test.ts) "[DI-24][INV-41] a document
  row without stored bytes (the self-attested form of before site services 0823) is not evidence of a fail-to-pass or
  loop-reading correction".

### P4 slice 2 (high): the person who classified or assessed the deviation also concluded it
- Deviation classifier and impact recorder were excluded from concluding, closing and signing the impact (PR-50
  family). Also: a link with CONFIRMED impact keeps release blocked after the deviation closes (D-2a-9, owner may change).
  Tests in [deviation-full.test.ts](../../packages/site-services/test/quality/deviation-full.test.ts).

### P4 slice 2 (high): demo seeds could run on a non-demo database
- The DEMO-ONLY seeds (`--gmp-review-batch`, `--gmp-packaging`) used a superuser update with triggers off. They now
  refuse a database whose name is not a demo name, and check `tab.demo_installation` (commit dee43262).
- **Lesson:** a shortcut that skips controls must be impossible to run against a real database.

### P4 slice 3: PR-53 justification read the first message only
- The release justification read link types from message text, and a CONFIRMED impact could be justified away. Now
  every link is checked structurally (recipe-core 0783), a CONFIRMED impact is never justifiable (D-3a-10), and
  escalated exceptions count as linked.
- **Tests:** [release.test.ts](../../packages/recipe-core/test/release/release.test.ts) "[PR-53] every link of an open record is
  read structurally"; "a CONFIRMED impact is never released under a justification".
- **Lesson:** never match on message text for a control; match on structured links.

### P4 slice 3: Tablets items failed open
- Rule sets, printed tablets in a library call and a printing master without a G-21 instance returned "not
  applicable" (NA). They now fail closed (RED) (tablets 1163). `since_review` was false on every Tablets edition item
  until the epoch comparison fed it. Tests: [grel-tablets-items.test.ts](../../apps/tablets-server/test/release/grel-tablets-items.test.ts).

### P4 slice 4 (high): a refused QP message blocked the importer's correct resend
- Deduplication applied to refusals, so a correct resend was ignored. Now only an accepted message is acknowledged
  and transient errors are raised, not recorded as refusals (recipe-core 0826).
- **Test:** [dispositions.test.ts](../../packages/recipe-core/test/release/dispositions.test.ts) "[DI-39] a resend of a refused
  message is evaluated afresh". Also: a distinct QP rejection meaning "[PR-55] an in-system QP rejection is signed
  QP_REJECTED".

### F-A1, G6.VALIDATION_BASIS (Phase 4 mutation run, recipe-core 0932)
- **What went wrong:** the gate item read only the change record of the batch's own master version. A revision
  approved as not process-impacting needs no validation link (PR-06), so every lot made on it stayed RED and could
  never be released.
- **Consequence:** a harmless title change to a master recipe would block release of all later lots: a production
  stoppage created by a compliance check that was too literal.
- **Fix:** the item walks back through the versions the master was derived from to the last process-impacting
  version and uses that version's validation references ([0932](../../packages/recipe-core/sql/0932_grel_validation_basis_lineage.sql)).
- **Test:** [release-gate.test.ts](../../packages/recipe-core/test/mutation/release-gate.test.ts) "[PR-06][INV-05]": a
  title-only revision is GREEN through its parent's basis; the same revision marked process-impacting without its own
  link is RED.
- **Lesson:** a mutation run finds real defects, not only weak tests: it asked "what does this branch do?" for a
  branch no test had reached.

### Export permission reason text (Phase 4 mutation run, site services 0903)
- `site.export_permission_problem` said "it lapsed at <valid until>" for an instant inside the permission's validity
  but before its approval. It now says "it is not current", like `site.licence_problem`. Only the text was wrong.

### P3 slice 4a (two high, four medium)
- A gateway FAIL challenge could be dropped and a stale PASS reused; an export pack could be issued without artwork
  for its own market; the serial report was not checked against recorded events; the L-29 hold was skipped without a
  unit and on a late acknowledgement; reconciliation counts were not compared with the printer's; MRP typed with no
  second person. All fixed in commit 5d08d254 (tablets 0951, 0952; recipe-core 0580, 0581); tests in
  [packaging/db-guards.test.ts](../../apps/tablets-server/test/blocks/packaging/db-guards.test.ts).

## Concurrency and locking

### P1-F26: two concurrent policy tightenings left a batch on a looser policy
- Fix and test: [f26](../../packages/kernel/test/review/f26.test.ts) "[INV-47] [DI-09] two concurrent applications to one batch never
  leave it on a looser position than one it already applied".

### P1-F44: edit and submit read each other without locks
- Content could change after submission and the has_body guard could be bypassed. Fix in
  [0551_platform_sample_record.sql](../../packages/kernel/sql/0551_platform_sample_record.sql); test
  [f44](../../packages/kernel/test/review/f44.test.ts) "[INV-04] concurrent edit and SUBMIT: a SUBMITTED record never has
  an empty body and never changes after submission".

### P3 slice 3c: close and hold race on containers
- A container could stay CLOSED with a hold row (unusable but QA could not sort it) or a container opened during a
  failing check could miss the hold. Fixed in recipe-core 0540 after walking every lock order (container lock first,
  then hold). Backlog note: the container lock assumes READ COMMITTED.

### P3 slice 5 review: the charge lock on source containers
- A source container could be charged twice at once. A charge now waits for the take lock; one request per parent
  (commit 8c4a6c89).

### P3 slice 3d low: AQL severity under concurrent batches
- The AQL (acceptance sampling) severity switched under concurrent batches; fixed with a per-product lock (commit
  b351795f).

### P4: the review register recorded a showing from a WHERE clause
- The register and `openItem` routes called a definer function in a `WHERE` clause, so PostgreSQL could call it more
  than once or not at all. They now record the showing and the opening once (commit 4d4d9444); HTTP regression test
  "[PR-52][DI-26]" in [register-routes.test.ts](../../apps/tablets-server/test/review/register-routes.test.ts).
- **Lesson:** never put a function with a side effect in `WHERE`, `SELECT` lists of a view or an index expression.

## SQL semantics

### P3 exit medium: collation changed signing order
- site-services 0733 sorted test codes without `collate "C"`; on a database with another default collation the QC
  extra-testing decision could become unsignable (fails safe). Fixed in site-services 0810 (`collate "C"` in
  `site.qc_test_codes`). A C-collation database is now part of the deployment notes.
- **Lesson:** anything that is hashed or signed must sort and compare in a defined way.

### P4 recipe-core 0719: `check_function_bodies = off`
- 0719 names a table that 0740 creates, so the file sets `check_function_bodies = off`. Apply order is by file number
  within a source, so the functions are only called after 0740 exists. A reminder that body checks are lazy.

### D-series (SQL mutation): guards that could not fire
- Some survivors of the SQL mutation run are real: `recipe.minimum_duration_problem#15` (D6), the family-code refusal
  naming the wrong value (D14, recipe-core 0384), market authorisation cells written around the command (D10, 0383), a
  loop left without its own frame (D7), a lot compared with its BOM line's material also where the line names null
  (D17, recipe-core 0372), a gateway key of small order (D16, tablets 0702, EBMR-DEV-016/017/018: a key of small
  order lets anyone forge a reading signature).
- **Lesson:** run the mutation tool on guards; it finds the branches no test enters.

### Dead functions
- `recipe.reprocessing_start_problem` was never called after recipe-core 0625; dropped by 0930. Also in the Phase 3
  exit review: `batch_record_identity_guard` and a SITE-165 branch of `consume_reservation` can never fire.

## Plant, lots, reprocessing and tablet blocks (Phase 3)

### Slice 1 findings 1 to 4 (two high)
- **1, 2 (high):** plant guards trusted caller-supplied product and batch; one person could skip the two-person
  cleaning check by choosing CIP (clean-in-place) for a class not validated for it.
- **3:** abandoning a cleaning reset the dirty-hold clock (so a dirty press looked newly cleaned).
- **4:** the clearance signature did not bind its result.
- **Fix:** commit 492f8736 (recipe-core 0400, 0403, 0404, 0405). Guards read facts from the batch; CIP allowed only for
  validated classes; the dirty-hold clock survives an abandoned cleaning.
- **Tests:** [equipment.test.ts](../../packages/recipe-core/test/plant/equipment.test.ts) "[IN-25] abandoning a cleaning does not
  restart the dirty-hold clock: past the dirty-hold, a MAJOR cleaning abandoned leaves MINOR refused".
- **Consequence:** product carry-over (the next product contaminated by the last) and wrong release of a press.

### Slice 2b: GMP batches had no product scope
- For a GMP batch `plant.batch_scope` returned no scope, so STEP.EXECUTE was checked with an empty scope; plant
  facts still read the test package. Fixed in recipe-core 0504 and 0502 (commit bb535280). Test
  [gmp-issue.test.ts](../../packages/recipe-core/test/lifecycle/gmp-issue.test.ts).

### Slice 3a (high): recipe-core had its own copy of the platform authority function
- It drifted from the kernel's. Replaced by the kernel SCOPE hook (kernel 1150, ADR 0018, commit 1e66d1b0). Also:
  the setpoint read-back was not tied to its download, alarm acknowledgement was possible outside a step, a G-09@2
  entry was not tied to the unit class. Test [scope-hook.test.ts](../../packages/kernel/test/platform/scope-hook.test.ts).

### Slice 3b: TB-01 dispensing
- TB-01's tolerance, adjustment-cap and FEFO (first-expiry-first-out) exceptions were raised by the handler only; the
  database now requires them. A weighing re-verifies that each calculation lot's assay is still current. TB-01 to
  TB-07 cannot be skipped. A filter bag last used for another product cannot skip its wash record. A null unit no
  longer bypasses the granulation unit check (commits 12f023db, 491120b6).
- **Tests:** [tb-01-db.test.ts](../../apps/tablets-server/test/blocks/dispensing/tb-01-db.test.ts) "[PR-19][DI-33] a weighing against a
  calculation whose lot result QC has superseded since is refused"; "[PR-13][PR-16][IN-07] the database never lets a
  TB-01 to TB-07 step be skipped".

### Slice 3c: compression
- Tooling past its stroke limit was not enforced during the run; strokes could be undercounted without a baseline;
  standalone TB-12 to TB-15 checks held nothing; a missed check held only at the next entry; a batch market without a
  rule set did not fail closed (commit c46c1813, tablets 0871, 0874, 0890 to 0893). TB-11: a missed start sweep stayed
  due and re-raised IPC_CHECK_MISSED forever (tablets 1110, commit e7c63357; test
  [missed-sweep-sql.test.ts](../../apps/tablets-server/test/blocks/ipc/missed-sweep-sql.test.ts)).
- **Consequence:** tablets compressed on a worn die set past its limit; the weight and hardness checks that should
  have held the output did not.

### Slice 3d, slice 4b
- Slice 3d: the out-of-limits and setpoint-mismatch exceptions of G-06 values were not required by the database for
  TB-18 (now a shared check for every block with G-06 entries); the reject destruction step's order was not enforced
  (commit b351795f).
- Slice 4b: TB-23/TB-24 line clearance, occupancy, artwork and isolation moved into the database; the sweeper now
  holds output for missed TB-23/TB-24 line checks and device challenges (commit b0e63dcf, tablets 0988, 0989).

### Slice 5 (three high): reprocessing and lab results
- The forward trace missed whole-batch children (INV-33, PR-57); the printed expiry cap ignored whole-batch parents
  (IN-19 (b)); a failing lot was resolved without a confirmed laboratory error and an approved passing replacement
  (IN-20). Also the person who records a finding could conclude or close the deviation (PR-50).
- **Fix:** recipe-core 0625, site-services 0753, commits 8c4a6c89, 5b05c1bf.
- **Tests:** [reprocessing.test.ts](../../packages/site-services/test/quality/reprocessing.test.ts) "[INV-33][PR-57][IN-19] the
  forward trace of a parent finds its whole-batch child, and the child's expiry is capped at the parent's";
  [lims.test.ts](../../packages/site-services/test/quality/lims.test.ts) "[IN-20][PR-19] an approved failure whose OOS
  concluded any other assignable cause than a laboratory error stands".
- **Consequence:** a recall trace that misses a child lot, and an out-of-specification result "passed" by a retest
  without a real laboratory error (testing into compliance).

### Slice 6d: seven defects found by running GB-T-01 end to end
- Base-stated formula for TB-01, MBR transition signing, G-09@2 instrument use, entries and loop/alternative intents
  over HTTP, hardness alias and pressure units, TB-01 hydrate checks, and the golden CI job running one file at a
  time. Plus: a TB-18 pan load is refused while a compression container is on hold (tablets 1092); a GMP G-07 weighing
  consumes its lot (tablets 1093).
- **Lesson:** end-to-end golden batches find the integration bugs that unit tests cannot.

### Phase 4 slice 1 quick review
- Container work missing from the INV-35 involvement set; the batch evidence epoch did not move when a consumed lot's
  status or LIMS results changed; epoch bumps were not limited to the audit review's scope and window; the high-water
  mark was not taken from the signed content; item dispositions were not re-opened with the review cycle; QUERIED,
  RESPONDED and ESCALATED were not gated on GMP; a weighed close was allowed from several balances. Fixed in commits
  bcec265f, 94d849a5 (recipe-core 0710 to 0721).

### Phase 4 slice 6 and kernel 1173: a true-copy naming defect
- True copies of insert-only tables without an `id` column did not match each row to its own INSERT event (kernel
  slice 4b fix); a table name bug in the archive (kernel 1173, commit 67babc7e). The evidence export is now recomputed
  by the database (kernel 1174).

## Integrations (Phase 6)

### P6a-A1: a feed gap kept a mirror looking fresh (slice 6a, builder A)
- **What went wrong.** The ERP/WMS worker recorded each mirror's synchronisation whenever the source's heartbeat
  answered, before it read the feed. With a feed gap (the source keeps changing its data but delivers nothing) the
  heartbeat still answered, so ERP_LOT_STATUS looked fresh while the eBMR held an old lot status.
- **Why it matters.** A stale mirror must fail closed (INV-26): a lot the WMS has blocked could still be reserved and
  issued on the old status.
- **Fix.** The worker records the synchronisation only when the heartbeat answers **and** it is caught up with the
  source (its cursor reached the source's head):
  [framework.ts](../../apps/tablets-server/src/features/integrations/adapters/framework.ts#sym=AdapterWorker). Found from
  builder B's pull worker, which already kept this rule.
- **Test.** `[DI-31] a feed gap keeps the mirror from looking fresh` in
  [contract.test.ts](../../apps/tablets-server/test/integrations/erp-wms/contract.test.ts).
- **Lesson:** freshness is about the data you hold, not about whether the other system answers.

### P6a-I1: an LMS withdrawal would fail on builder A's worker (slice 6a, merge of the two workers)
- **What went wrong.** Builder A's worker base ran each receiving command without a reason. Its ERP/WMS commands only
  insert, so nothing showed it; an LMS REVOKED or EXPIRED message updates the live qualification row
  (`iam.receive_lms_qualification`), and the audit trail refuses an update without a reason (EBMR-AUDIT-002). On A's
  worker that refusal is unclassified, so the LMS adapter would block on the withdrawal and every later message.
- **Why it matters.** A person whose training the LMS withdrew would stay qualified in the eBMR while the mirror aged;
  the qualification check at signing must see the withdrawal.
- **Fix.** The two workers were merged into one framework that runs every receiving command with the source's reason
  (INBOUND_MESSAGE, naming the message type, record id and system, D-P6a-B-7):
  [framework.ts](../../apps/tablets-server/src/features/integrations/adapters/framework.ts#sym=sourceReason). Found by
  builder B, whose pull worker already carried it.
- **Test.** `[DI-31] LMS: a withdrawal through the worker framework carries the source reason into the audit trail
  (defect P6a-I1)` in [feed-adapters.test.ts](../../apps/tablets-server/test/integrations/feed-adapters.test.ts); it
  fails with EBMR-AUDIT-002 when the reason is taken out.
- **Lesson:** a shared base is proven by its most demanding user, not its first one.

### P6a-R1: the ERP/WMS adapter's functions hid their permission check (slice 6a, review)
- **What went wrong.** Five functions the ERP_WMS adapter calls (outbound pending, delivered and failed, the receiving
  command and the WMS location question) checked INTERFACE.WRITE only inside a helper (`site.require_erp_wms_adapter`)
  or inside the kernel's inbound framework, and `site.location_move_problem`, a read, was declared VOLATILE. The DI-17
  scan of every app-callable writer looks for the check in the function itself, so CI failed.
- **Why it matters.** The scan is how a reviewer knows that no application-callable writer was added without a
  permission; a check that lives one call away is one refactor away from disappearing.
- **Fix.** Each of the five functions calls `platform.authorize('interface.write', ...)` where it is entered, as the
  kernel's inbound functions do; the read is declared STABLE (site-services migration
  [0916](../../packages/site-services/sql/0916_erp_wms_entry_authority.sql)). No exception was added to the test.
- **Test.** `[DI-17] every function of market, records, continuity, site services and the platform that the
  application may call and that can write checks a known permission` in
  [authorization.test.ts](../../packages/kernel/test/integration/authorization.test.ts).
- **Lesson:** run the kernel's authorization scan whenever a slice adds a function the application may call.

### P6a-R2: a release could rely on a stale QMS mirror (slice 6a, review)
- **What went wrong.** `site.record_qms_release_fetch` (site services 0925) takes the answer of the live QMS fetch from
  the server and checks only that it equals the local mirror; neither it nor `site.qms_release_problem` asked whether
  the QMS_STATUS mirror was fresh. A server that copied a stale mirror into the "fetch" passed every database check.
- **Why it matters.** Release must see the QMS as it is at signing (D-P6a-3); a deviation opened after the QMS adapter
  stopped would not stop the lot.
- **Fix.** In MIRROR both refuse with EBMR-INT-010 when the mirror is stale, and the fetch is still required in the
  same transaction (site services [0927](../../packages/site-services/sql/0927_qms_release_mirror_fresh.sql)). The HTTP
  call itself is an accepted residual (the database cannot see it).
- **Test.** `[DI-31] a release with a stale QMS mirror is refused even with a matching fetch record` in
  [cmms-qms-release.test.ts](../../packages/recipe-core/test/integrations/cmms-qms-release.test.ts).
- **Lesson:** a comparison with a local copy proves only as much as the copy is fresh.

### P6a-R3: a heartbeat alone kept a blocking mirror fresh (slice 6a, review)
- **What went wrong.** `platform.record_mirror_sync(class)` (kernel 1180) let any active adapter of the class's system
  refresh the class's last synchronisation with nothing behind it. The worker only called it when caught up, but the
  database did not check that, so any writer could keep LMS, CMMS, ERP lot-status or QMS mirrors fresh while the
  adapter was behind its source.
- **Why it matters.** A stale mirror must fail closed (INV-26): a withdrawn qualification, a failed calibration or a
  WMS block that never arrived would not stop signing, equipment use or issue.
- **Fix.** The function now takes the source's high-water mark and the database refuses the sync unless the adapter
  holds it (EBMR-INT-019) and every number below it since the last proven mark, a missing run counting only once a
  person acknowledged its gap alarm (EBMR-INT-024; D-P6a-F-1, kernel
  [1182](../../packages/kernel/sql/1182_mirror_sync_caught_up.sql)). The one-argument form is dropped; the worker
  passes the head it paged to.
- **Test.** `[DI-31] a heartbeat from an adapter behind the source does not refresh its mirror` and `[DI-31] a
  synchronisation from an adapter caught up with its source refreshes its mirror and keeps the source mark; a gap counts
  once a person acknowledges it` in [inbound.test.ts](../../packages/kernel/test/inbound/inbound.test.ts).
- **Lesson:** a freshness stamp written by the caller proves only that the caller called; make the database check what
  the stamp claims.

### P6c-1: the adapter framework could not read an L3 refusal code (slice 6c)
- **What went wrong.** The worker read a refusal's EBMR code with `EBMR-[A-Z]+-\d{3}`. The L3 contract's codes, fixed in
  the 6c-0 interface, carry a digit in their module (`EBMR-L3-105`), so an aggregation mismatch was unclassified and the
  L3 adapter stopped on it (BLOCKED) instead of recording the refusal with its alarm and moving on.
- **Why it matters.** One mismatched aggregation would have stopped every later L3 message, the decommissioning tasks
  among them, and let the mirror age: release would fail closed for every order, not only the one with the mismatch.
- **Fix.** The framework reads `EBMR-[A-Z][A-Z0-9]*-\d{3}`
  ([framework.ts](../../apps/tablets-server/src/features/integrations/adapters/framework.ts) `ebmrCodeOf`). The test
  `[PR-42][DI-31] the L3 adapter lands aggregations and decommissioning tasks ...` in
  [l3-adapter.test.ts](../../apps/tablets-server/test/integrations/l3-adapter.test.ts) counts the OUT_OF_RANGE refusal
  and needs the worker caught up with nothing stopped.
- **Lesson:** a pattern over codes is a contract too; test it with the codes of every system, not the first ones.

### P6c-2: a PostgreSQL regular expression with a bound above 255 (slice 6c, during the build)
- **What went wrong.** Two checks of tablets 1231 used `{1,500}` in a regular expression. PostgreSQL allows at most 255
  in a bound; the check raised "invalid repetition count(s)" at run time (the migration compiled, the function body
  is only parsed when called).
- **Fix.** Length is checked with `length(...) > 500` beside a `+` pattern; the rejection and receiving tests call both.
- **Lesson:** a PL/pgSQL body is checked when it runs: every branch of a new definer needs a test that reaches it.

### P6c-R1: the specimen capture showed the record's coding (slice 6c, review)
- **What went wrong.** The packaging completion page showed the record's batch number, dates and MRP beside the form
  where the operator types what the coding specimen shows. The database compares the typed coding with the record's,
  but an operator could copy the value on the screen instead of reading the specimen, and the check would pass.
- **Fix.** The capture form tells the operator to type exactly what the specimen shows and no longer shows the record's
  coding ([PackagingCompletionPage.tsx](../../apps/tablets-web/src/features/labels/PackagingCompletionPage.tsx)); the
  web test `[IN-16] the packaging page offers the next coding specimen ...` checks it.
- **Lesson:** a comparison the database makes is only a check when the person cannot see the answer.

### P6c-3: the golden packaging orders' true-copy hashes moved (slice 6c, CI golden job)
- **What went wrong.** The 6c build said the specimens and the post-use inspection, being rows of their own, leave the
  record head and the golden hashes unchanged (D-P6c-21). The first golden run (CI, PR #36) failed three hash checks:
  GB-T-02's bottle order and GB-T-01's two blister orders. The driver ticks the frozen clock one second before every act
  (`dbAs`), so the seven or eight new acts per order (the completion view read, three coding and two label specimens,
  the inspection and its verification) move every later act that many seconds on.
- **What changed in the true copy.** Diffing the normalised true copy of each order with those acts ticking and with
  them not ticking (cluster gate6, libfaketime): no key added or removed and no value changed except instants, each one
  minute later as whole minutes from the issue: GB-T-02 order 9 instants (entries EN-28 to EN-30 at t+24m to t+25m,
  EN-58 to EN-63 at t+31m to t+32m); each GB-T-01 order 8 instants (EN-28 t+52m to t+53m, EN-29 and EN-30 t+54m to
  t+55m; the packaging stage's end, its sign-off and lastRecordedUs t+58m to t+59m). With the new acts not ticking the
  three old hashes come back exactly. The batches' own hashes did not change.
- **Fix.** The scenario is meant to have these acts and each act takes its own second (the driver's rule), so the pinned
  hashes are taken again: GB-T-02 order 8467d0bf79c0... to f97928738d30...; GB-T-01 order 0 84e7e5dd56c4... to
  04b571b906d6...; order 1 8f07940fe378... to 6718a46f8c5e... (full values in
  [gb-t-02/expected.json](../../apps/tablets-server/test/golden/gb-t-02/expected.json) and
  [gb-t-01/expected-release.json](../../apps/tablets-server/test/golden/gb-t-01/expected-release.json)).
- **Lesson:** a row beside the record leaves the record's facts alone, not its clock; a golden output moves with any new
  act before it, so run the golden job before saying a hash is unchanged.

### P6c-4: the integrations reads answered 500 once the L3 mirror existed (slice 6c, CI)
- **What went wrong.** Tablets 1231 adds the mirror data class L3_SERIAL_STATUS, but the contract's MirrorDataClassName
  and the adapter SDK's MIRROR_DATA_CLASSES did not list it, so `integrations.mirrors` built an answer the contract
  refused (INTERNAL, "does not match the contract").
- **Fix.** Both enums list L3_SERIAL_STATUS (the contract-enums test keeps them equal); the test `[DI-31] the health page,
  the adapter detail and the alarm list ...` in
  [alarm-routes.test.ts](../../apps/tablets-server/test/integrations/alarm-routes.test.ts) now expects the L3 class in
  the mirror list.
- **Lesson:** a database catalogue row and the enum that names it are one change; a seed of a new class needs a read of it.

### P6c-5: the label field bindings were not audited (slice 6c, CI)
- **What went wrong.** recipe-core 0990's `recipe.label_field_binding` was insert-only but not registered as an audited
  table; the recipe schema's privilege test (every recipe table audited, ADR 0012) listed it.
- **Fix.** 0990 registers it (`kernel.register_audited_table`, keyed by its code, as esig.meaning_type is); 0990 was not
  yet merged to main. `[DI-17][INV-01][INV-02][INV-04][INV-17] the application role reads every recipe table ...` in
  [authorization.test.ts](../../packages/recipe-core/test/lifecycle/authorization.test.ts) passes unchanged.
- **Lesson:** a reference table is a record table too; the schema meta test is the check, run it with the slice.

### P6d-R1: the chemical recovery could not be done from the application (slice 6d, review)

**Symptom.** Returned goods that QC assessed and signed for chemical recovery could not be recovered by any user: the
database act `site.record_chemical_recovery` (site services 0960) existed and was tested, but no route or screen called
it, so the IN-29 genealogy of recovered material could only be built by the tests.
**Cause.** The slice built the database guard first and the server reads, but the act's route was not in the 6d-0
contract. **Fix.** The additive route `samples.recoverReturn` (`POST /api/quality/returns/:lotId/chemical-recovery`,
D-P6d-7) and the form on the returned-goods screen. **Tests.** `[IN-29][PR-48] the stores record the chemical recovery
...` (genealogy-routes.test.ts, over HTTP, the forward trace reaching the recovered lot) and the web test of the form.

### P6d-R2: slice test files broke the static CI job (slice 6d, review)

**Symptom.** Two lint errors (an unused destructured member; an `any` from a nested `expect.objectContaining`) and three
dependency-rule errors: recipe-core's genealogy tests imported site services' test helpers, and recipe-core may import
only kernel and expr. **Fix.** The genealogy DB tests moved to `packages/site-services/test/genealogy/` (D-P6d-10); the
assertions name the fields. **Lesson.** Lint and `pnpm deps:check` the slice's files before each push.

### P6i-R1: a mock recall across sites could look complete while a destination's part went further (slice 6i, review)
- **What went wrong.** `recipe.mock_recall_federation` (recipe-core 1091) called a run complete once every destination
  site ANSWERED, even when a destination's excerpt reached a further transfer (to a third site, or back to this one)
  that nobody asked; the explorer's federated trace also left out a transfer back to this site.
- **Why it matters.** A mock recall and a cross-site trace must never be silently partial (L-41, IN-29): lots made from
  the material at a third site would be missing from a result shown as complete.
- **Fix.** [1092_transfer_review_fixes.sql](../../packages/recipe-core/sql/1092_transfer_review_fixes.sql) lists every
  such transfer as `beyond_one_hop` and keeps the run incomplete; the server's federated trace counts a transfer back
  here as beyond one hop too ([federation.ts](../../apps/tablets-server/src/features/transfers/federation.ts)).
- **Test.** `[IN-29] a destination's part that reaches a further transfer leaves the mock recall incomplete (one hop,
  D-P6i-0-7)` in [transfer.test.ts](../../packages/site-services/test/transfer/transfer.test.ts); it failed before the fix.
- **Lesson:** "complete" has to name everything that was not asked, not only what failed to answer.

### P6i-R2: the other site's clock refused "now" (slice 6i, review)
- **What went wrong.** `recipe.answer_federated_genealogy` (1090) refused any as-of point after its own clock. The asking
  site sends its own "now"; a clock a few milliseconds ahead made the answer a refusal and the result incomplete.
- **Why it matters.** Two installations never share one clock; a cross-site trace would be incomplete at random.
- **Fix.** 1092: an as-of point up to 2 seconds ahead is answered once the answering clock has passed it (so the answer
  is still as of a past instant there); further ahead is refused as before (EBMR-FED-012).
- **Test.** `[PR-57] an as-of point a moment ahead of the answering site's clock is answered once that instant has
  passed; one far ahead is refused` in transfer.test.ts; it failed before the fix.
- **Lesson:** a rule about "the future" between two systems needs a tolerance and a way to wait, not a bare comparison.

### P6i-R3: an unauthenticated route that costs a seal verification had no rate limit (slice 6i, review)
- **What went wrong.** `/api/federation/genealogy` needs no session (the seal is the authentication) and every request
  makes the database verify an Ed25519 seal in PL/pgSQL and write a log row and, when refused, an alarm.
- **Why it matters.** Anyone who can reach the server could load the database and flood the alarm list.
- **Fix.** The route is counted per client address (30 a minute;
  [transfers/index.ts](../../apps/tablets-server/src/features/transfers/index.ts#sym=FEDERATION_RATE)).
- **Test.** `[DI-31] the site-to-site endpoint is counted per client address: past the limit it answers 429 without
  asking the database (review 6i-R3)` in [transfer-routes.test.ts](../../apps/tablets-server/test/transfers/transfer-routes.test.ts).
- **Lesson:** a route outside the session gate needs its own gate for cost, not only for identity.

### 6jc-R1: the ERP/WMS adapter's identity could record a person's material act (Phase 6 exit review)
- **What went wrong.** Site services 0914 gave the ERP_WMS adapter's INTEGRATION role MATERIAL.HANDLE so that it
  could receive goods, and guarded only reservation and consumption against it. With that right the adapter's account
  could still cancel a person's reservation, record a lot destruction, recover returned goods, receive returns, post a
  finished lot, and prepare, seal or import a transfer package.
- **Why it matters.** These are acts a named person is accountable for (DI-14, DI-20). An interface account doing one
  of them would make the record say "done by the interface" for something no interface may decide.
- **Fix.** A before-insert trigger on the eight tables of these acts refuses a row unless its account is HUMAN
  (EBMR-SITE-925; site services [0990](../../packages/site-services/sql/0990_material_acts_by_person.sql)). The WMS
  path writes none of them.
- **Test.** `[DI-14][DI-20] the adapter's MATERIAL.HANDLE never reaches a person's material act ...` in
  [inbound.test.ts](../../packages/site-services/test/erp-wms/inbound.test.ts).
- **Lesson:** when you give an integration role a broad permission for one path, guard every other path that permission
  opens, at the table rather than in each function.

### 6jc-R8: a seal under an installation key of small order proved nothing (Phase 6 exit review)
- **What went wrong.** Kernel 1220 accepted any 32-byte encoding of a curve point as this installation's key or as a
  peer's key. A point of small order (eight times it is the neutral point) passed. Under the neutral point as the key,
  the seal R = B, S = 1 verifies for every payload. A package forged in such a peer's name, by anyone, was taken in.
- **Why it matters.** A transfer package carries a lot's status and release into another site's stock, and a federation
  answer feeds a recall (DI-31). Once a weak key is trusted, its seal check means nothing; QA's approval of the key only
  limits who can bring one in.
- **Fix.** Kernel [1230](../../packages/kernel/sql/1230_installation_key_large_order.sql), as tablets 0702 did for
  gateway keys: `platform.ed25519_small_order`; `platform.raw_public_key` refuses a small-order key (EBMR-XFR-042), and
  `platform.seal_valid` is false under one, so a key stored earlier verifies nothing either.
- **Test.** `[DI-31] a key of small order is refused as a peer's key and as this installation's key (EBMR-XFR-042)` and
  `[DI-31] a peer key of small order stored before the guard verifies no seal ...` in
  [transfer.test.ts](../../packages/site-services/test/transfer/transfer.test.ts).
- **Lesson:** a signature check is only as good as the key it is checked under. When a second copy of a crypto
  routine is written (the kernel twin of tablets 0270), carry over the key checks that the first copy gained later
  (tablets 0702).

### 6jc-R16: a training requirement for one product refused step work on every product (Phase 6 exit review)
- **What went wrong.** A step command was authorised at the actor's location only ({site, area}), and a step
  signature in the scope {site} given by the batch_step provider (and the stage, exception, point, record and act
  providers). Neither named the batch's product. The kernel applies a product-limited requirement whenever a request
  names no product (it fails closed), so a requirement for product A was applied to every batch at the site.
- **Why it matters.** It fails closed, so no data was at risk. But one training requirement limited to a product, a
  normal set-up under IN-04, stopped the operators of every other product at the site from starting or signing a step.
  A grant limited to a product never covered step work either. Found by the browser-flow agent (F-6jb-1).
- **Fix.** Recipe-core [1100](../../packages/recipe-core/sql/1100_batch_product_in_step_authority.sql) adds the batch's
  product to the providers' scope and checks the command's permission and engine-role evaluations in the batch's scope.
  Another product's evaluation is refused (EBMR-EXE-036). Tablets [1320](../../apps/tablets-server/sql/1320_engine_roles_on_batch.sql)
  evaluates the engine roles on the batch. A requirement with no product limit, and the stale-source refusal, are as before.
- **Test.** The four tests of "a product-limited qualification requirement applies to batches of that product only
  (6jc-R16)" in [gmp-batch.test.ts](../../apps/tablets-server/test/execution/gmp-batch.test.ts), and "[INV-26][DI-17][IN-04]
  past the server, an engine-role evaluation ... with another product is refused" in
  [db-guards-roles.test.ts](../../apps/tablets-server/test/execution/db-guards-roles.test.ts).
- **Lesson:** a fail-closed rule for a missing scope member is right only if every caller passes the members it knows.
  When a scope dimension is added to grants or requirements, check that each authority call on a record names it.

### 6jc-R16, the rest: the other batch acts still checked their permission without the batch's product (Phase 7 slice 7a)
- **What went wrong.** After 1100 the step work named the batch's product, but the other batch acts did not: the alarm
  acknowledgment checked ALARM.ACKNOWLEDGE unscoped before the bound batches' scopes, and the disposition and hold-point
  proposals, the proposal of an act for approval, the exception review act, the dispensing consumption (both its batch
  and its site side) and the GMP batch issue checked at the actor's location only.
- **Why it matters.** The same as 6jc-R16: a requirement limited to product A refused these acts on every product, and
  a person scoped to product A could not acknowledge an alarm of A's own batch (open question O-T1-1).
- **Fix.** Recipe-core [1217](../../packages/recipe-core/sql/1217_batch_scope_remaining_acts.sql) and
  [1218](../../packages/recipe-core/sql/1218_batch_issue_order_product_scope.sql), site services
  [1103](../../packages/site-services/sql/1103_consumption_batch_product_scope.sql): each act's check names the batch's
  product (the order's product at the issue); an alarm bound to no batch is still checked unscoped. Recipe-core
  [1224](../../packages/recipe-core/sql/1224_drop_check_engine_roles_two_argument.sql) drops the location-only
  `recipe.check_engine_roles(jsonb, jsonb)` that nothing called any more.
- **Test.** The `[IN-04]` tests of [alarm-ack-batch-scope.test.ts](../../packages/recipe-core/test/plant-rules/alarm-ack-batch-scope.test.ts),
  [batch-scope.test.ts](../../packages/recipe-core/test/review/batch-scope.test.ts) and
  [consumption-batch-scope.test.ts](../../packages/site-services/test/lots/consumption-batch-scope.test.ts): per act,
  another product's requirement no longer refuses it, this product's and an unlimited one still do, and a stale source
  is still refused; the `[meta]` test of [dead-overload.test.ts](../../packages/recipe-core/test/execution/dead-overload.test.ts).
- **Lesson:** fixing a scope bug in one caller is half the fix. Search every permission check on the same record for
  the same missing member (`iam.actor_location_scope()` alone, or `'{}'`, on a batch act).

## Controlled substances (Phase 6 slice 6e, draft IN-53)

### P6e-R1: a batch could complete after its last controlled checkpoint (slice 6e, review)
- **What went wrong.** The stage sign-off guard (recipe-core 1033) closes the controlled-API account at every stage
  sign-off, but nothing held the end of the batch: a return or a destruction confirmed after the last sign-off moved
  the account, and the batch could still reach EXECUTION_COMPLETE with that movement accounted nowhere.
- **Why it matters.** The account of a controlled API closes with no unexplained difference at every checkpoint
  (IN-53); the end of the batch is the last one.
- **Fix.** The move to EXECUTION_COMPLETE is refused (EBMR-CSM-043) while a controlled material that moved into the
  batch has no signed checkpoint that is still current (recipe-core
  [1035](../../packages/recipe-core/sql/1035_controlled_batch_end.sql)). An aborted or cancelled batch is not held; its
  account is recorded afterwards.
- **Test.** `[IN-53] a yield checkpoint with an unexplained difference of the controlled API is refused` (its last part)
  in [controlled.test.ts](../../packages/site-services/test/controlled/controlled.test.ts).
- **Lesson:** a guard on each step needs one on the end too, or the last movement escapes.

### P6e-B1: a kernel witness meaning on a custody record (slice 6e, build)
- **What went wrong.** The second custodian's meaning was first declared with the kernel's witness flag, which asks the
  record for a witnessed act (terminal and time) and its window (EBMR-ESIG-050). A custody record names no act terminal,
  so every countersignature was refused.
- **Fix.** Like DESTRUCTION_WITNESSED (recipe-core 0840), CONTROLLED_CUSTODY_COUNTERSIGNED is a WITNESS-class meaning
  without the kernel's witness window: it excludes the proposer and is independent of the first signature, and the
  command refuses the first custodian (EBMR-CSM-022). Found by the first DB test run, before the commit.
- **Lesson:** read what a meaning flag asks of the record before using it.

### P6e-B2: a read rule changed inside the slice's range would have been undone (slice 6e, build)
- **What went wrong.** Who may preview a record for signing is `tab.record_read_problem`, re-created in full by each
  slice that changes it. Slice 6e's tablets range (1250 to 1258) runs before 6f's 1276, which re-creates it from 1042:
  a change made in 1250 would have been undone, and the custodians on the floor could not see what they sign.
- **Fix.** The read rule of the controlled records is in tablets
  [1290](../../apps/tablets-server/sql/1290_controlled_read.sql), after 1276 and 6d's 1280 (default D-P6e-10; the plan's
  migration table gains it; first numbered 1280, renumbered when 6d merged with that number).
- **Test.** `[IN-53] a transfer of a controlled lot is signed by two different custodians: the proposer first, another
  person second, never the same person twice` in
  [controlled-routes.test.ts](../../apps/tablets-server/test/controlled/controlled-routes.test.ts).
- **Lesson:** a function re-created in full belongs to the highest migration that touches it; check the numbers after
  your range, not only inside it.

### 6jc-R2: any session read the controlled register and balance (Phase 6 exit review, decision 0022)
- **What went wrong.** The controlled-substance routes checked only that a session existed, and read the tables of
  recipe-core 1031 to 1034 with the application role, which could SELECT them all and run their read functions. An
  operator on a kiosk, a system administrator, or anyone holding the application's database credentials read every
  flag, custody record (who held which lot), batch account and register export.
- **Why it matters.** Draft IN-53 limits these records to the people who hold them in custody and to QA. The register
  and the balance show where a narcotic or psychotropic API is and how much of it, which is what a diversion needs.
- **Fix.** Recipe-core [1214](../../packages/recipe-core/sql/1214_controlled_reads_closed.sql) revokes the application
  role's EXECUTE on the fourteen old read functions (the writers keep their grants). It also revoked SELECT on the
  eight tables, which broke the kernel's true copy of any batch or lot (finding P7A-7). Recipe-core
  [1215](../../packages/recipe-core/sql/1215_controlled_tables_app_select.sql) grants SELECT back: the application role is
  the server's own identity, and true copies and archives must be complete. Every person-facing path stays gated. Tablets
  [1413](../../apps/tablets-server/sql/1413_controlled_reads_gated.sql) adds gated definers for the session behind the
  request: CONTROLLED.READ (tablets 1400), no administrator, and a grant whose scope covers the record's {site, product};
  lists are filtered row by row, a named batch or record out of scope is refused (EBMR-CSM-060, 061: 403). Tablets
  [1414](../../apps/tablets-server/sql/1414_controlled_record_read.sql) asks the same rule of the signing preview and of
  `tab.record_read_problem` (signatures and their audit chains), keeping every rule of 1290. Review round 1, tablets
  [1415](../../apps/tablets-server/sql/1415_controlled_audit_read.sql): the audit viewer had still read the controlled
  records' chains by role. It also showed the custody and checkpoint entries filed on the lot's and the batch's chains.
  Both now need CONTROLLED.READ in scope. A register export (no site, every site's lots) is read only in the scope {}.
  The write routes read their record back before the commit.
- **Test.** `[IN-53] the controlled register and balance reads need CONTROLLED.READ` and the other tests of
  [controlled-read.test.ts](../../apps/tablets-server/test/controlled/controlled-read.test.ts) (HTTP 403, the bypass,
  product and site scope, the preview, `[IN-53] the audit trail shows controlled-substance entries only to a reader
  holding CONTROLLED.READ`); the bypass of 1214 again in the package database in
  [controlled.test.ts](../../packages/site-services/test/controlled/controlled.test.ts).
- **Lesson:** a read route that checks only "a session exists" is no control. Gate every path a person reads through.
  Before revoking a table from the application role, find the generic readers that run as it (true copy, exports).

## Floor screens (web)

### P2-F57 to F65: the shop-floor forms under real use
- **F57:** the "Saved" note fix reset a saved entry once the step moved on, so a still-open dialog came back with Send
  enabled and a second Send raised a duplicate exception.
- **F59:** after any refusal the weighing form threw away both captured scale readings, though only an engine
  refusal spends them; now it drops only those the server names.
- **F60 to F62:** a send with no answer; one live stream per capture slot (two per form against the browser's limit of
  six connections per server, now one per scale); after an unlock the gauge waited up to 15 s.
- **F63, F64, F65:** reload guard; a greyed Save that said nothing; a link with a full stop got a refusal.
- **F58 (and F58.1):** a weighing refused as stale spent its readings, and the first fix stopped recording the stale
  attempt as a row (DI-34 wants every refused engine call recorded). Now the server records the refusal with what was
  entered and the version shown, without using the readings (tablets 0500, 0510). Test:
  [stale-weighing-readings.test.ts](../../apps/tablets-server/test/devices/stale-weighing-readings.test.ts) and
  [db-guards-stale-row.test.ts](../../apps/tablets-server/test/execution/db-guards-stale-row.test.ts).
- **Lesson:** refusing is also a state change: decide which of (a row, readings, a counter) a refusal may touch.

### P2-F44 to F55: the designer
- The document view left out acceptance schemes, calculation limits and risk class (F44); hid an alternative's
  conditions (F45); a library call's steps had no row (F46); an exclusive bound read like an inclusive one (F47); a QA
  hold point could be released by any role (F48, F49); a leftover draft survived sign-out (F50); a whole number the form
  did not take was dropped silently (F53); designer contract examples were hand-written shapes (F55).
- **Lesson:** a document that a reviewer reads must show everything that is signed, in the author's words.

### P2 web: a signing asked for at the moment of a lock or switch
- A lock, switch or poll asked for at the moment the page shows the person was lost (INV-40, DI-14, DI-28; commit
  78de0ca0; follow-up 0e96531c for F39).

## Test flakiness and races

| When | Symptom | Root cause | Fix |
|---|---|---|---|
| 30 Sep | Unhandled errors at test teardown (FATAL 57P01) | `pg-pool` `end()` resolved before sockets closed, so a forced database drop hit idle backends | all test-kit pools come from `openPool` and end with `endPool` in [db.ts](../../packages/test-kit/src/db.ts) |
| 30 Sep | Gateway delivery-readiness test got `uplinked:false` once under load | the upload pass waited for the acknowledgement watermark write (open, fsync, rename) before telling waiters, racing a 5 s limit against the disk | waiters told before the slow write; a real gateway race, not a test issue |
| 1 Oct | Agreement property test skipped big flows to avoid out-of-memory | `fc.pre` skipped every flow above 2,000 paths, so those went unchecked | stream the paths (check and drop), replay engine decisions through the simulator |
| 1 Oct | Listener share limits test could not fail in CI | the global set-up declared a share of 40 before any test, so the test read only its own set-up | two checks that fail without the migration |
| 4 Oct | E2E `[INV-03]` floor test broke | the reader-tap timing and a test persona without both roles | rebuilt on a kiosk persona holding OPERATOR and VERIFIER |
| 12 Oct | Browser specs failed in parallel | specs shared a device rate limit per terminal, and review and release specs acted on the same demo batch | specs spread over office terminals (PC-QA-02, 03, 06, PC-PLAN-02, 03); office specs run one at a time. The limit (X34) is unchanged |
| 12 Oct | Deviation spec race | hardened (Phase 3 exit) | |
| 12 Oct | GB-T-01 hashes changed by day | see "Time" above | fixed lot dates, placeholder year |
| 11 Oct | `db-guards-free-text-shown` failed once under load, passed alone | suspected chance match of "2409" in generated text | **open**: root cause not yet found (Phase 3 backlog, slice 6c) |

Lessons: a retry is not a fix. Reproduce with the same load (see the `local-ci` skill), find the race, and then
decide whether the race is in the test or in the product (two of the entries above were in the product).

## CI

- **Localhost binding (commit 2cdde1ac):** the server listened on `localhost` through a `serverFactory`, and Fastify
  then skips the extra bindings of `localhost`. On GitHub's runners `localhost` resolves to `::1` first, so the health
  check on `127.0.0.1` never got through. The header limit now goes through Fastify's own http options. The test
  resolves `localhost` to 127.0.0.2 first and fails on the old code.
- **Lint heap:** typed linting holds about 2.2 GB, above node's default heap. Run lint with
  `node --max-old-space-size=4096` (also in [PROGRESS.md](../../PROGRESS.md)).
- **E2E job timeout** raised to 45 minutes; the golden job runs one file at a time; a test over 30 minutes is not
  allowed (GB-T-01 takes about 1,300 s).
- **Register and README tests:** adding a test file without listing it in its folder README or in the control's list
  fails a `[meta]` test. Merging two scopes of mutation groups once left a function in two SQL mutation groups (fixed
  by one group per function, commit 79a0e582).
- **Renumbered migrations (commits 5685be5b, 0b4de0b7, 27b1efe2, ...):** when two branches pick the same migration
  number, one is renumbered before the merge.

## Tests that proved too little (Phase 2 exit, F13 to F29 and E2E claims)

- Tests were green for the wrong reason: a refusal checked only as "some failure", a guard reached only through a
  TypeScript pre-check, a rule shown through another rule that fires first, made-up ids that never reach the named
  branch, events compared by count. Each strengthened test now fails when its guard is removed (shown with a
  temporary mutant).
- The E2E evidence record wrote "as expected" for steps that measured nothing, which would have put unmeasured
  results into a validation pack. It now lists the assertions a step made and says "not checked" if none.
- The control register did not check the tests a control listed; `register validate` now refuses a listed test its
  file does not declare, and the trace refuses a listed test the run did not report.
- Phase 3 exit TypeScript mutation: calculations, entries and signing content at 90 percent or more; five
  high-risk blocks between 84 and 90 percent. Phase 4 SQL kill tests on the "not twins": 862 of 883 mutants killed.

## Slice 6g: dashboards, change impact and training (Phase 6)

### P6g-1: a view's functions run with the reader's rights (found while building)

**Symptom.** A report view calling `recipe.overdue_reviews()` directly would have needed EXECUTE on that recipe function
for `ebmr_report`, widening the role beyond reading. **Cause.** PostgreSQL checks functions inside a view with the
caller's EXECUTE right (tables with the owner's). **Fix.** Each view selects from its own STABLE SECURITY DEFINER row
function in the schema `report`; the segregation check reports any other grant to the role. **Tests.** `the reporting
role cannot write: ...` (kernel sandbox tests).

### P6g-2: training commands from a kiosk needed a badge tap (found while building)

**Symptom.** Starting an exercise from a shared terminal was refused (EBMR-IAM-120, INV-40). **Fix.** The training
commands are FRESH_ON_SHARED with the attribution member, as other floor commands. **Tests.** the contract test of
FRESH_ON_SHARED routes; `[DI-05] a training session's attempts are the person's own ...`.

## Phase 6 mutation campaign (decision 0019)

### M6-D1: a typed lot code stopped receiving for the rest of the day (medium, fails safe; site services 1002)

**Symptom.** After stores received a delivery with a lot code typed on a batch that was not the last, every later
receipt that day failed with a duplicate-key error on the lot code. **Why it matters.** Receiving stops until midnight;
no wrong record is written (PR-17: each lot of each shipment has its own code). **Cause.** Site services 0910 numbered
the generated codes (GR<yymmdd>-<nnnn>) from the count of the day's generated codes but advanced the counter for every
batch, also for one with a typed code, so the count fell behind the highest number in use. **Fix.** Site services 1002:
the next number follows the highest generated code of the day, advances only for a batch without a typed code, and
skips a code the site already holds; codes are never reused and gaps are allowed. Found while writing the campaign's
kill tests for erp-wms-receipt-and-stock (triage T2; D-P6j-T2-1). **Tests.** `[PR-17] a lot code typed by stores on
any batch never makes a later receipt of the day reuse a generated code` (packages/site-services/test/erp-wms/receipt.test.ts).
**Lesson.** A sequence derived from `count(*)` breaks as soon as anything else writes rows of the same shape, or the
counter moves without writing one; derive the next value from the highest one in use, under the lock that is already
held, and let the unique constraint stay the last guard.

### M6-D2: an intact message after a tampered copy was lost at the interface (high, DI-31; adapter worker)

**Symptom.** An inbound message whose payload did not match its stated hash was refused with a MALFORMED alarm, as it
should be. When the source then sent the intact message under the same idempotency key and hash, the worker answered it
DUPLICATE and it never reached the database. **Why it matters.** A record from the ERP, QMS, LIMS, OPC UA or another
feed was silently lost after the first alarm: the cursor moved on and the reconciliation (key and hash) matched the
recorded refusal. **Cause.** The worker's memory of refused messages (`refusedKeys` in
`apps/tablets-server/src/features/integrations/adapters/framework.ts`) held the hash the message *stated*, which for a
hash mismatch is not the hash of what arrived. **Fix.** The memory holds the SHA-256 of the whole item as received; only
the very same item repeated is a duplicate. No migration: the database looks for a key among accepted messages only, so
a refusal does not reserve it. Found while writing the Phase 6 mutation campaign's tests (triage T12; D-P6j-T12-3).
**Tests.** `[DI-31] M6-D2: after a message refused because its payload is not the one its hash states, the intact message
under the same key lands, exactly once; ...` and `[DI-31] M6-D2: a page that repeats a refused item unchanged is handled
once; ...` (apps/tablets-server/test/equipment-data/opcua-adapter.test.ts). **Lesson.** De-duplicate on what you
received, never on what the sender claims about it; a claim that failed its check identifies nothing.

## Phase 6A: advisory analytics

The defects and design notes of the analytics slices (ADR 0020), found while building or in each slice's own review,
in slice order. The exit review's findings and residuals are in the Phase 6A review backlog.

### Slice 6A-2: SPC, capability, drift and deviation rates

#### P6A2-1: a distribution function from an inverted quantile lost its tails (found while building)

**Symptom.** The first normal distribution function was the pinned normal quantile inverted by bisection. The quantile
loses its precision below a probability of about 1e-16 (it returned an infinite value), so the Anderson-Darling
statistic, which sums log-probabilities of the outermost points, failed on ordinary data. **Why it matters.** A normality
note or a capability index computed from a wrong tail would mislead QA reading the PQR annex, even though the result is
advisory. **Fix.** The normal distribution function is `@stdlib/math-base-special-erfc` 0.2.5, pinned and recorded in
every run's runtime (D-6A-2-10); the t distribution function stays the inverted t quantile, which keeps its precision.
**Test.** `packages/analytics/test/spc-methods.test.ts` "the normal and t distribution functions agree with SciPy, deep
into the tails" (down to z = -30) and the Anderson-Darling reference values. **Lesson.** Check a numerical door at the
extremes it will meet, against an independent reference, before building on it.

### Slice 6A-3: multivariate monitoring

#### P6A3-1: the open flags list repeated every run's raise of the same hit (6A-2's residual)

**Symptom.** Each run assesses its whole input again, so a nightly run raised an open rule hit again, and
`analytics.open_flag_v1` listed every raise until QA dispositioned each one.

**Fix.** Kernel 1271 lists each open signal (method, version, subject, rule, severity and reasons) once, as its latest
raise with its count; a disposition on any raise covers the signal. The runs still record every raise (D-6A-3-9).

**Test.** `[DI-52] a flag raised again by later runs is listed once while open, ...` (kernel) and the end-to-end test in
`apps/tablets-server/test/analytics/mspc.test.ts`.

#### P6A3-2: a reference set was checked against its candidate by hash only (found while building)

**Symptom.** EBMR-ANA-010 compares the set's model SHA-256 with the candidate's recorded hash. A writer could pair that
hash with another model or with other batches; only the runner's later hash check would notice.

**Fix.** Kernel 1270 (EBMR-ANA-030) requires the candidate's own model and batches, for every writer (D-6A-3-8).

**Test.** `[DI-52] a reference set must carry its model candidate's own model and batches, not only its hash
(EBMR-ANA-030)`.

### Slice 6A-4: audit-trail anomaly detection

#### P6A4-1: an open audit-trail flag could drop out of the list (found in the slice's own review)

**Symptom.** The audit-trail flags list without a period (the open flags) took the newest 500 keys and only then kept
the open ones, so with many dispositioned keys an older open key was not listed; the flag detail looked its key up in
the same capped list and could show a dispositioned key as open. **Cause.** The filter ran after the limit, in the
server. **Fix.** `auditKeys` filters open keys, or the one key asked for, in the query before the limit. **Tests.** the
server's `[DI-53] a flag sends no notification and closes only with a disposition` (open list, period list and detail
of a re-raised key).

#### P6A4-2: a re-run raises every hit again (design note, found while building)

**Symptom.** Each run of the audit-trail methods assesses the whole 26-week window, so QA would have to disposition the
same hit after every nightly run. **Fix.** A flag's key (method, rule, subject, first evidence of the first reason;
kernel 1261 `analytics.flag_key`) groups the repeats; a disposition on any flag of a key closes it (D-6A-4-5). The
flag table still grows by one row per hit and run; measure at a real site.

### Slice 6A-5: review priority

#### P6A5-1: the review priority told every QA viewer that a record's entries had an audit-trail hit (high, DI-53; found in the slice's own review)

**Symptom.** The score's OPEN_AUDIT_FLAG term and its reason ("1 audit-trail rule hit on this record's entries") were
shown in the review queue to every holder of ANALYTICS.VIEW, the head of production included. **Why it matters.** The
hits come from flags about persons, which only data-integrity review may read (D-6A-12, draft DI-53); on a record a few
people worked on, the reason points at them and reaches their line. **Fix.** The queue and the one-record route give
anyone without ANALYTICS.DI_REVIEW (asked of the database) the score without that term and without its reason, and
order by it; the data-integrity lead sees the full score (`features/common/review-priority.ts`). **Tests.**
`[DI-53][PR-61] the audit-trail term of a score is shown only to data-integrity review; ...`
(apps/tablets-server/test/analytics/review.test.ts). **Lesson.** A count derived from restricted data is restricted
data; check what an aggregate implies, not only what it names.

#### P6A5-2: open audit-trail flags cannot reach the score's inputs (design note, found while building)

**Symptom.** The plan counts "open audit-trail flags on the batch", but no report view may read the analytics schema
(the DI-51 dependency proof) and the analytics role reads only catalogued report views. **Fix.** REVIEW.PRIORITY runs
the ATA.RULES version 1 rules over the same snapshot's audit facts and counts the hits on the record's entries
(D-6A-5-4); a disposition does not lower the term in v1. A catalogued input of the open keys per batch is a kernel
change, written up for the lead.

### Slice 6A-6: golden batch profile

#### P6A6-1: the plan's band rule would flag about half of the normal curves (found while building)

**Symptom.** With a pointwise 5th to 95th percentile band of n curves, two curves lie outside it at every point by
construction. Each reference curve therefore has about 10 % of its points outside, which is exactly the flag threshold.
On the synthetic history, the 20 normal curves had 0.5 % to 15 % outside, so about half would have been flagged.

**Fix.** The band at a point spans its neighbours within one resampling step (a timing tolerance, parameter
`bandTolerancePoints`, D-6A-6-3). The normal curves then have at most 5.5 % outside, and the abnormal curve 31 %.

**Test.** `[DI-52] the seeded abnormal press curve is flagged and the 20 normal ones are not` (package and server).

#### P6A6-2: an empirical 99th percentile of the references flags a reference (found while building)

**Symptom.** With 10 to 50 references, the empirical 99th percentile of their distances lies below the largest one. That
reference would then be flagged against its own set.

**Fix.** The limit is a log-normal 99 % prediction limit for one new batch (D-6A-6-4).

#### P6A6-3: the runner could not read the reference sets (found while building)

**Symptom.** `analytics.effective_reference_sets()` is owner only (kernel 1242), and the analytics role may read only its
catalogued report inputs.

**Fix.** Recipe-core 1170 adds `report.analytics_reference_v1` over the configuration store. It does not read the
analytics schema, so the DI-51 dependency proof is unchanged (D-6A-6-7).

#### P6A6-4: an import cycle between the implementation list and a method file (found while building)

**Fix.** The implementation shapes moved to `method-types.ts`, and `implementation.ts` re-exports them.


## Slice 6A-3: multivariate monitoring (Phase 6A)

### P6A3-1: the open flags list repeated every run's raise of the same hit (6A-2's residual)

**Symptom.** Each run assesses its whole input again, so a nightly run raised an open rule hit again, and
`analytics.open_flag_v1` listed every raise until QA dispositioned each one.

**Fix.** Kernel 1271 lists each open signal (method, version, subject, rule, severity and reasons) once, as its latest
raise with its count; a disposition on any raise covers the signal. The runs still record every raise (D-6A-3-9).

**Test.** `[DI-52] a flag raised again by later runs is listed once while open, ...` (kernel) and the end-to-end test in
`apps/tablets-server/test/analytics/mspc.test.ts`.

### P6A3-2: a reference set was checked against its candidate by hash only (found while building)

**Symptom.** EBMR-ANA-010 compares the set's model SHA-256 with the candidate's recorded hash. A writer could pair that
hash with another model or with other batches; only the runner's later hash check would notice.

**Fix.** Kernel 1270 (EBMR-ANA-030) requires the candidate's own model and batches, for every writer (D-6A-3-8).

**Test.** `[DI-52] a reference set must carry its model candidate's own model and batches, not only its hash
(EBMR-ANA-030)`.

## Slice 6A-7: the Phase 6A exit review

### P6A7-1: a later raise of a dispositioned hit took a fresh verdict (high, DI-52, DI-53; kernel 1280)

**Symptom.** QA dispositioned a flag. The next run raised the same hit again. That raise could then be given a fresh
first disposition, with no supersede and no reason, and the hit had two current verdicts. The flags list of a period,
the generic flag detail and the restricted dispositions showed the later raise as undispositioned, and the flags about
persons listed it as open.

**Why it matters.** A verdict on a hit is QA's record. Replacing it needs a reason (DI-52), and a person flag closes
only with a disposition (DI-53).

**Cause.** Two slices grouped the raises in two ways: 6A-4 by key (kernel 1261) and 6A-3 by signal (kernel 1271). Both
let a disposition on any raise close the group, in the views only. `analytics.record_disposition` kept its rules per
flag, and the monitor grouped the audit-trail flags by signal rather than by key.

**Fix.** Kernel 1280 gives one design, `analytics.flag_group`: the key for the audit-trail methods, the signal for the
others. The group is the unit of the verdict in the writer, the views, the restricted dispositions and the monitor.
The server reads a flag's dispositions by group.

**Tests.** Kernel `test/analytics/exit-review.test.ts` (one flag-grouping design) and server
`test/analytics/audit.test.ts`, "[DI-52][DI-53] a later raise of a dispositioned key ...".

**Lesson.** When a view groups rows into the unit people act on, the writer's rules must move to that unit as well.

### P6A7-2: the review priority's audit-trail term reached the application role (high, DI-53; kernel 1281)

**Symptom.** P6A5-1 hid the OPEN_AUDIT_FLAG term from everyone but data-integrity review, in the server only.
`analytics.review_priority_v1` and `analytics.output_v1` still gave the application role the full score, the term's
count and points and its reason, with no person in context.

**Fix.** Kernel 1281: both views leave the term out unless `analytics.viewer_holds_di_review()` says the command's
person holds ANALYTICS.DI_REVIEW. The function refuses administrators first, and any refusal or a read-only
transaction reads as "not held".

**Test.** "[DI-53] the audit-trail term of a review priority is unreadable without ANALYTICS.DI_REVIEW, also through the
app role directly".

**Lesson.** A restriction that holds on one path is not a database control; put it where every reader goes through.

### P6A7-3: every run grew with the site's history (high, DI-51, DI-52; package and runner)

**Symptom.** Every completed batch reran every method in force:
- each SPC run recorded every chart with all its batches, and rule flags over the whole history;
- the rate comparison recorded one output per material lot ever;
- the audit-trail methods re-raised 26 weeks of hits.

The output, flag and audit tables are insert-only, so storage grew by runs times history.

**Fix.**
- A chart shows and flags its newest `chartBatches` (100), with the Phase I limits of its first batches.
- A rate comparison covers the product's newest `windowBatches` (200).
- The audit-trail methods run nightly and on demand only (D-6A-7-R3).

**Tests.** Package `spc-methods.test.ts` (both windows) and server `runner.test.ts`. The full input reads remain a
residual (P6A7-4).

**Lesson.** A run that is repeated on every event must have bounded outputs; 6A-6 found the same for the profile.

### P6A5-2 closed: a QA false alarm now lowers the review priority (kernel 1282)

**Fix.** `analytics.audit_key_verdict_v1`, in the analytics schema and on the analytics role's allow-list only, gives
the current verdict of each audit-trail key. REVIEW.PRIORITY leaves out a hit whose key QA found to be a false alarm.
The DI-51 dependency proof is unchanged: nothing outside the schema reads it.

**Tests.** Package and server `review-priority.test.ts`; kernel `exit-review.test.ts`; the key spelling against
`analytics.flag_key` in server `audit.test.ts`.

## Slice 7a: the decision 0022 security and scope fixes (Phase 7)

### 6jc-R9: the gateway's OPC UA feed and the adapters did not authenticate the sender (DI-31, DI-20; kernel 1305, tablets 1405)

**Symptom.** Anyone holding the OPCUA adapter's credentials, or the application role's, could hand the database series,
alarms, events and endpoint sessions as if from the gateway. Every adapter spoke plain HTTP.

**Why it matters.** Equipment data and alarms enter the batch record. A record that cannot show where its data came
from fails the interface control (DI-31) and the device identity it rests on (DI-20).

**Cause.** The 6a framework authenticated the adapter, not the source. The gateway's feed carried no proof of origin.

**Fix.** The gateway signs each feed envelope with its enrolled key and journals the signature. The database verifies
it (`tab.accept_gateway_envelope`, bound gateway, ACTIVE key, payload text hash). `platform.accept_inbound_detail`
refuses an OPCUA envelope that has no verification in its transaction, so a direct `plant.receive_*` call is refused.
On a GMP installation, adapters off loopback need mutual TLS (EBMR-INT-034). The peer certificate's fingerprint is kept
with each message.

**Tests.** Server `test/equipment-data/feed-signature.test.ts` (the fixed DI-31 titles), kernel
`test/inbound/source-verification.test.ts`, server `test/integrations/adapter-startup.test.ts` (EBMR-INT-034), and the
gateway's `test/opcua-driver.test.ts` (restart serves the same signed bytes).

**Lesson.** A signature over a hash proves nothing about the payload unless the payload is checked against that hash
where the signature is checked. Here that is the database, on the payload text as sent (`json`, not `jsonb`).

### 6jc-R10: one steward set the penicillin facility rule and the beta-lactam classification (PR-27; recipe-core 1210)

**Symptom.** A master-data steward alone could declare a site a penicillin facility, or declassify a penicillin material,
and the latest version counted at once. **Fix.** Recipe-core 1210 makes each version a proposal: it is in force once a
QA person other than the proposer signs it `QA_APPROVED` (`plant.approve_facility_rule`, `plant.approve_beta_lactam_class`).
The stricter rule wins: a loosening (declassified, a penicillin facility) is in force only once approved; a tightening is
in force at once and until an approved loosening (tablets 1410 maps the ceremony). **Tests.** Recipe-core
`test/plant-rules/rule-approval.test.ts` ("[PR-27] a facility rule or beta-lactam classification takes effect only with a
QA signature by someone other than the proposer"), site services `test/plant-rules/materials.test.ts`, server
`test/alarms/plant-rule-approval.test.ts`.

### GB-T-01's investigation due date came from the machine's calendar (test defect; found in slice 7a, 18 October 2026)

**Symptom.** From about the 18th of each month, GB-T-01 stopped at the investigation: "EBMR-SITE-822 the due date
... is in the past", and every later step of the golden batch failed with it, on every branch. **Cause.** The scenario
set the due date to the 28th of the month after the machine's date, while the golden cluster's clock runs weeks ahead
of the machine (the 41 days of the source batch and more); the database checks the due date against its own clock in
the site's zone (site services 0821). **Fix.** The scenario reads the 28th of the next month from the database's clock
in the site's zone. No product code changed; the database's check was right. **Lesson.** A golden scenario takes every
date from the database's clock, never from the machine's.

## Slice 7g-1: a screen for every act of people and devices (Phase 7, decision 0025)

### 7g1-1: person-facing routes with no screen (gap; found by the [meta] completeness test, 18 October 2026)

**Symptom.** Decision 0025 asks for a screen for every act a person performs. The new [meta] test
([screen-completeness.test.ts](../../apps/tablets-web/test/meta/screen-completeness.test.ts)) found, besides the people
and device acts this slice built and the MBR, plant-rule and labelling acts slice 7g-2 builds, 25 routes of the contract
that a person calls and no screen calls (for example the kiosk keep-alive, the India shelf-life bases and hazards, the
reagent lots and room rules of plant rules, scheduling another CAPA check, proposing a peer installation, the dashboard
export). **Cause.** Each was added with its server feature and tested over HTTP; nothing checked that a screen used it.
**Fix.** Not fixed here: the test lists them by name in `NO_SLICE_YET`, so it passes now and fails on any new route
without a screen; each entry is removed when its screen is built. **Lesson.** Completeness is a test over the contract,
not a list in a document.

## Open residuals for the owner

From the Phase 2 exit backlog, the Phase 3 and 4 backlogs and PROGRESS.md. Defaults stand until the owner decides.

**Decisions waiting for the owner (PROGRESS.md "Open for the owner")**
- D-7b-1: GB-T-01's two orders are India-only, since its master is authorised for India only; meeting D-P4-15 literally
  needs re-recording GB-T-01 with a three-market master.
- PR-30: a breach raises an exception that needs a deviation and blocks release, but creates no deviation by itself.
- IN-18 "deferred clauses" read as the register export with each number's use (D-6a-7).
- D-2a-9 (a CONFIRMED impact keeps release blocked after closure), D-3a-10 (a CONFIRMED impact is never justifiable).
- D-P4-6: with India treated as the EU, a process-validation (PPQ) batch's release waits for the validation outcome.
- D-5b-2: a product with no bright-stock maximum hold is not checked.
- Drying-loop correction (the default of phase 4 slice 1a is stricter: evidence and QA approval) and the India
  subdivision rule: TB-12 subdivision can never be recorded until the India rule is decided.

**For the owner and the expert (data to check before validation)**
- Compendial rule-set values in `tab.compendial_rule_set` (tablets 0890) came from secondary sources; AQL table
  values (tablets 0911) have medium confidence; the India Schedule H2 QR payload layout is a stub.
- Weight mode e (subdivision of scored tablets) has no India rule set, so it is refused (fail-closed).
- A QC-unit signature for the TB-19 print approval would need a new signature meaning (default: QA).

**Security and platform residuals**
- F34.2: the application role still selects identity, incident and retention tables directly; HW.1 to HW.3: it still
  sees when and how many investigations and holds were opened, not who.
- Free text in a test run may still hold a real-format identifier within the limits of F12.5.
- Engine-only class (REPLAY-GATE.1): computed values, data-decided branches, loop exits and counts, replicate counts,
  some exceptions and lot usability are not re-derived by the database; G-REL replays the stored rows with the pinned
  engine and keeps a record NOT_READY on any difference.
- The GMP sweeper's secret is a plaintext demo file; production needs a secret store.
- Three read functions (`allocation_register`, `qp_reader_access`, `read_qp_package`) do not refuse administrators first.
- Definer reads granted to the application role (`market_added` and others) are guarded only at the HTTP layer.
- Not covered: Firefox and Safari (E2E runs Chromium only), the simulator console on port 4002, the unauthenticated
  `/gw/v1/nonce`, two installations of the same kind on one host sharing cookie names, and a database whose default
  collation is not C.
- Performance: each `recipe.execution_state` change runs about 50 triggers (GB-T-01 took 20 minutes; now about 22
  minutes in CI); the epoch triggers look up on every audit insert; the QP package grows the audit trail. Measure
  before large sites.

**Mutation work deferred to deployment validation (decision 0012)**
- Kill confirmation of 232 scope A and 118 scope B survivors; the us-disposition, qp-certification and
  market-changes groups; Stryker survivor triage for the server release, records, India, archive and PQR features.

**Features and tests not yet built**
- Detection runs only when asked: replay, `execution_violations()`, chain verification have no scheduler yet.
- Regulatory assessments not yet made: kiosk badge-tap attribution against Part 11 11.10(d) and 11.300; one
  administrator can bind an instrument or enrol a gateway key; no complete human-readable copy of a test run.
- Injectables edition: not reviewed by any area; Phase 5 takes it (decision 0010).
