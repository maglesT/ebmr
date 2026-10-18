# Learnova: minimum regulatory requirements for use as a GMP training system

Version 0.1, 18 October 2026. Draft for the owner.

**Scope.** These are the minimum requirements Learnova (Medhanta's LMS) must meet before an Indian pharmaceutical
manufacturer that exports can use it as its system of record for GMP training. The bases are India Revised
Schedule M (always applies), US FDA 21 CFR Part 11, 211.25 and 211.68, EU GMP Annex 11 and Part I Chapters 2 and 4,
and FDA and PIC/S data-integrity guidance where they settle a point. Where two rules differ, the stricter one wins.

**Where the citations come from.** Most citations come from the Batchwright eBMR compliance register
(`compliance/controls/*.yaml`, where the regulations are paraphrased with their section numbers). The eBMR control is
named for each requirement, for example "(eBMR DI-22)". A citation marked **[to confirm]** is from memory: the register
does not cover that point, and it has to be checked against the regulation PDF. All regulation text in this document
is paraphrased.

**How to use it.** The "Tester checks" lines are written for a browser test of Learnova. Run them with at least these
accounts: Admin A, Faculty F1 and F2, Employee E1 and E2 (both reporting to Manager M), and a second Admin B. Each
check gives what to do and what you should see. If you see anything else, it is a gap. A check that cannot be done in
the UI at all (for example, there is no audit-trail screen) also counts as a gap.

Priority: **MUST** means required before go-live. **SHOULD** means expected by inspectors, but a documented procedural
workaround could cover it for a limited time.

---

## 1. Accounts and access

### LMS-01 Unique personal accounts, never reused (MUST)
- **Requirement:** Each person has one personal account. Accounts are never shared, and an identifier (email or user
  ID) is never reassigned to another person, even after the first person leaves.
- **Sources:** 21 CFR 11.10(d), 11.100(a), 11.300(a); Annex 11 §12.1. eBMR DI-14, DI-15.
- **Why:** A training record is only evidence if it points to exactly one person. A reused email address would
  attach a former employee's history to a new hire.
- **Tester checks:** (1) Try to create a second user with E1's email. Expect a refusal. (2) Deactivate E1, then
  create a new user with E1's email. Expect a refusal, or a new and distinct identity that does not inherit E1's records
  or certificates. (3) Look for any generic account (for example "trainer@", "admin") that can complete or approve
  training. There should be none.

### LMS-02 Role-based access and least privilege (MUST)
- **Requirement:** Each action (create or approve content, assign training, take an assessment, view team records,
  administer users) needs a role that allows it. A user sees and changes only what the role allows.
- **Sources:** 21 CFR 11.10(d), 11.10(g); 211.68(b); Annex 11 §12.1. eBMR DI-17.
- **Why:** Only authorised people may create or approve training content or change who must be trained.
- **Tester checks:** (1) As E1, open the faculty and admin URLs directly (copy them from an admin session). Expect
  "access denied", with no data shown. (2) As M, try to view E2's assessment answers or records outside M's own team.
  Expect only what the design allows (team overview). (3) As F1, try to edit or approve an SOP owned by F2 without being
  assigned as its reviewer. Expect a refusal.

### LMS-03 Segregation of duties: author is not approver; administrators do not change record content (MUST)
- **Requirement:** The person who writes training content or questions cannot be the one who approves it. A user
  cannot mark their own training complete or grade their own assessment. Admin rights do not let anyone edit training
  results, completion dates or certificates.
- **Sources:** 211.22, 211.68(b); Annex 11 §12.1; FDA DI Q&A Q4 (administrators independent of record content). eBMR
  DI-17, DI-18.
- **Why:** Self-approval and administrator edits are the main ways training records get falsified.
- **Tester checks:** (1) As F1, author an SOP and try to approve it yourself as peer reviewer. Expect a block.
  (2) Give E1 faculty access, then have E1 assign themselves an SOP and try to approve it, or to mark it complete without
  taking the assessment. Expect a block. (3) As Admin A, look for any way to change E1's score, completion date or
  certificate. There should be none. A correction must go through LMS-11.

### LMS-04 Access lifecycle: recorded grants, prompt removal, periodic review (MUST)
- **Requirement:** Every grant or removal of a role is recorded with who, when and why. This includes the "faculty
  access" toggle and Manager and Admin rights. Leavers lose access promptly. Admin can produce the list of users and
  their roles as of any past date, and access is reviewed periodically.
- **Sources:** 21 CFR 11.10(d); 211.68(b); FDA DI Q&A Q4; Annex 11 §12.3. eBMR DI-16.
- **Why:** An inspector asks who could approve training content on a given date.
- **Tester checks:** (1) Toggle faculty access on for E2, then off. Expect both changes in the audit trail with the
  actor, the time and a reason. (2) Deactivate E1 and try to log in as E1 (request a code). Expect a refusal, with E1's
  records still kept. (3) Ask for a "users and roles as of [past date]" report. If it does not exist, that is a gap.

### LMS-05 Bulk onboarding (CSV) is controlled (SHOULD)
- **Requirement:** A CSV import is validated before it is applied: duplicate emails, unknown managers and reporting
  loops are rejected. It is recorded as an audited change that names who imported it. It cannot overwrite the identity
  or history of an existing person.
- **Sources:** 211.68(b) (accuracy of input); Annex 11 §5 (data exchange checks) **[to confirm]**. eBMR DI-14, DI-31.
- **Why:** The CSV builds the reporting line, and the reporting line decides who oversees whose training.
- **Tester checks:** Import a CSV that contains a duplicate email, a manager who does not exist, an A→B→A reporting
  loop, and a row that changes an existing user's name. Expect each bad row to be rejected with a reason. The name
  change should appear in the audit trail, or be refused.

## 2. Authentication and electronic signatures

### LMS-06 Login strength: is an email one-time code enough? (MUST)
- **Requirement:** Login identifies the person with two distinct components. With an email one-time code, those
  components are the user ID (email) and possession of the mailbox. This is acceptable for **login** only if: the
  mailbox is a personal company mailbox that is itself protected (company SSO or MFA); codes are single-use,
  short-lived (5 to 10 minutes) and rate-limited; repeated failures lock the account and alert an administrator; and
  sessions time out when idle.
- **Sources:** 21 CFR 11.10(d), 11.300(a)-(e); Annex 11 §12.1; draft Annex 11 §11 (MFA for remote access). eBMR DI-19.
- **Why:** In an emailed code there is no secret that only the user knows, so the mailbox is the whole of the
  security. A personal Gmail address, or a mailbox shared with a supervisor, breaks the attribution of every record.
- **Tester checks:** (1) Ask for a code, use it, then use it again. Expect it to be refused the second time.
  (2) Wait past the stated expiry and use a code. Expect a refusal. (3) Enter 10 wrong codes. Expect a lockout and an
  audit or alert entry. (4) Leave a session idle beyond the timeout. Expect to have to log in again. (5) Look for the
  setting that limits sign-in to company email domains or SSO. If it does not exist, record a gap.

### LMS-07 Electronic signatures for the training acts that need them (MUST)
- **Requirement:** These acts are electronically signed, each with its own stated meaning:
  - the trainee's attestation that they read and understood the SOP and completed the training ("Trained / read and
    understood");
  - the peer reviewer's review of an SOP or training module and its questions ("Reviewed");
  - the QA or authorised approver's approval of an SOP version, a curriculum or a training matrix before it becomes
    effective ("Approved");
  - the trainer's sign-off on practical or on-the-job training, if Learnova records it ("Trainer verified");
  - the approval of any correction to a training record (LMS-11).

  Passing an auto-graded quiz is a system-generated result; the trainee's attestation is the signed act.
- **Sources:** 211.25(a); 21 CFR 11.50, 11.70, 11.100, 11.200; Annex 11 §14; EU Ch.4 4.29 (training records)
  **[to confirm]**; Schedule M Part I 17.2 (documents approved, signed and dated) (eBMR IN-06); Schedule M Part I
  11.4 (training) (eBMR IN-04). eBMR DI-35.
- **Why:** In the paper system each of these is a handwritten signature. The electronic record has to carry an
  equivalent.
- **Tester checks:** Complete an SOP as E1, review it as F2, approve it as QA. At each act, expect a signing dialog
  that states the meaning and asks for re-authentication (LMS-08). If an act ends with a plain "Submit" or "Approve"
  button and no signing step, record a gap.

### LMS-08 Signature components and re-authentication at signing (MUST)
- **Requirement:** At each signature the signer re-authenticates on the spot with two distinct components, at least
  one of which is a secret that only the signer knows (a PIN or password). Recommended minimum: email (ID) plus a
  personal signing PIN. An email one-time code alone **should not** count as a signature. When a user signs several
  times in one continuous session, later signatures need at least the secret component again. No one can sign through
  another person's session.
- **Sources:** 21 CFR 11.200(a)(1)-(3), 11.300; Annex 11 §12.1, §14; Schedule M Part XII 6.1 (e-signatures
  authenticated and secure) and IT Act 2000 s.3A, s.5 (eBMR IN-10). eBMR DI-38.
- **Why:** A signature must be attributable beyond doubt. Anyone who can read the mailbox could produce a
  code-only signature.
- **Tester checks:** (1) Start a signing step and check what it asks for. If it only re-sends an email code, record a
  gap against this requirement and raise owner question Q1. (2) Sign twice in one session. Expect the secret to be asked
  for again. (3) While logged in as E1, try to sign as F2 (for example by entering F2's details in the dialog). Expect a
  refusal.

### LMS-09 Signature manifestation and permanent linking (MUST)
- **Requirement:** Every signed record shows, on screen, in print, in PDF and in exports: the signer's full name as
  it was at signing, the user ID, the role, the date and time with time zone, and the meaning. This information is
  stored with the signature, not looked up later from the user table. The signature is bound to the exact content and
  version it signed. If the content changes, the signature is shown as no longer valid and must not carry over.
- **Sources:** 21 CFR 11.50(a)-(b), 11.70; Annex 11 §14(b)-(c). eBMR DI-36, DI-37.
- **Why:** A signature that can move onto a different SOP version, or that shows today's name instead of the name at
  signing, proves nothing.
- **Tester checks:** (1) After signing, open the record, print it and export it. Expect all five elements in each
  form. (2) Rename E1 (for example after marriage). Expect old signatures to keep the old name. (3) Edit an approved SOP
  (or create v2). Expect v1's approval not to appear on v2, and v2 to need a new approval.

### LMS-10 E-signature policy acknowledgment and signature register (SHOULD; MUST for US export sites)
- **Requirement:** Before signing for the first time, each user electronically acknowledges a written policy that
  their e-signature is the legally binding equivalent of a handwritten one. Learnova keeps a signature register that
  maps each user to their name, roles and allowed signature meanings over time. (For the US, the company's
  certification letter to FDA is a procedural step outside the product.)
- **Sources:** 21 CFR 11.10(j), 11.100(c); FDA DI Q&A Q16; EU Ch.4 4.29 (signature lists) **[to confirm]**. eBMR
  DI-21.
- **Tester checks:** Create a new user and try to sign before acknowledging the policy. Expect a block. Ask Admin
  for the signature register, or a "who could sign what, when" report.

## 3. Audit trail

### LMS-11 Complete, secure, computer-generated audit trail (MUST)
- **Requirement:** The system records every creation, change and deletion of a GMP-relevant record: users, roles,
  SOP content and versions, questions, pass marks, assignments, due dates, completions, scores, attempts, certificates
  and signatures. Each entry holds who, what (old and new value), when (trusted time) and why (a reason, which the user
  must give for any change or deletion). No one can switch the audit trail off, edit it or delete it, administrators
  included. It can be read in plain language, filtered by user, record and date, and exported.
- **Sources:** 21 CFR 11.10(e); Annex 11 §9, §12.4; EU Ch.4 4.9; Schedule M Part I 17.2 electronic data-processing
  clause (record of changes and deletions) (eBMR IN-09). eBMR DI-22, DI-23.
- **Why:** The audit trail is how an inspector tells a real training record from a back-dated one.
- **Tester checks:** (1) Change an SOP's pass mark, a due date and a user's manager. Expect an entry for each with the
  old and new value, the actor, the time and a reason (the reason must be asked for). (2) As Admin, look for a setting
  that turns auditing off, or any edit or delete action on audit entries. There should be none. (3) Export the audit
  trail for E1 over a date range. Expect a readable file.

### LMS-12 Audit-trail review (SHOULD)
- **Requirement:** QA or the training coordinator can review the audit trail regularly, for example with an
  exceptions view (back-dated completions, edits after a signature, role changes, repeated failed attempts), and that
  review is recorded.
- **Sources:** 211.68(b), 211.192; FDA DI Q&A Q1a, Q8; Annex 11 §9. eBMR DI-25, DI-26.
- **Tester checks:** Look for an audit-trail review screen or report, and for a way to record "reviewed by X on
  date". If neither exists, record a gap. A procedure using exports could serve as an interim workaround.

## 4. Record integrity (ALCOA+)

### LMS-13 Originals preserved; corrections are new entries with reasons (MUST)
- **Requirement:** A completed training record, score, attempt or certificate is never overwritten or deleted. A
  correction (for example, wrong person credited) is a new entry. It is linked to the original, gives a reason, and is
  approved by e-signature. The original stays readable.
- **Sources:** 21 CFR 11.10(e); EU Ch.4 4.9; Annex 11 §9; Schedule M Part I 17.2 (alterations signed and dated,
  original legible, reason where appropriate) (eBMR IN-06). eBMR DI-24.
- **Tester checks:** As Admin, try to delete E1's completion or certificate. Expect it to be refused, or to be a
  reasoned and audited void that keeps the original visible. Check for any "reset progress" action, and if one exists,
  that it keeps the history.

### LMS-14 Every assessment attempt is retained (MUST)
- **Requirement:** Each attempt is kept with its answers, score, pass or fail result, start and end time, and question
  version, failed attempts included. "Unlimited attempts" must not mean that only the last attempt is kept. The
  certificate and the training record show the number of attempts. A configurable maximum number of attempts, with
  retraining required after N failures, is recommended.
- **Sources:** FDA DI Q&A Q12, Q13 (all data, including failing data, retained); Annex 11 §9; EU Ch.4 Principle
  (raw data). eBMR DI-29.
- **Why:** Failing four times and passing on the fifth try is a quality signal (was the training effective?). Hiding
  the failures is a data-integrity problem.
- **Tester checks:** As E1, fail the assessment twice, then pass. As F1 or QA, open E1's record. Expect three
  attempts, each with its answers and time. Check whether the pass mark and attempt limit can be configured.

### LMS-15 Contemporaneous, attributable data; no back-dating (MUST)
- **Requirement:** Completion, attempt and signature times are set by the server when the act happens. No user can
  enter or edit them. Training done outside the system (classroom, on the job) and recorded later is clearly marked as
  a late entry, showing both the actual date of the training and the date it was recorded, with a reason.
- **Sources:** 211.188; EU Ch.4 4.8; Annex 11 §12.4; FDA DI Q&A Q12. eBMR DI-28.
- **Tester checks:** Look for any date field on a completion or certificate that can be edited. There should be none.
  If classroom training can be recorded, record one for a past date. Expect both dates to be shown, and the entry to be
  flagged as late.

### LMS-16 Stored data protected and checked (SHOULD)
- **Requirement:** Records are protected against change outside the application (database access is limited, and
  integrity checks can detect a changed record). Certificate numbers are unique and cannot be guessed. The public
  verification page confirms a certificate against the stored record and reports revoked or superseded certificates.
- **Sources:** 21 CFR 11.10(a), 11.10(c); 211.68(b); Annex 11 §7.1. eBMR DI-44, DI-13.
- **Tester checks:** (1) Verify a real certificate number. Expect a match. (2) Verify the same number with one digit
  changed. Expect "not found". (3) Revoke or supersede a certificate (if this is possible). Expect the verification page
  to show its current status. (4) Ask the supplier how direct changes to the database are detected. A written answer is
  enough at this stage.

## 5. SOP and curriculum document control

### LMS-17 Versioned training content with approval and effective dates (MUST)
- **Requirement:** Each SOP or training module has a version number, an approval (LMS-07) and an effective date. Only
  the approved, effective version can be assigned. Superseded versions are kept, read-only, with their training
  records. If Learnova is where the SOP itself is written, it must meet the full document-control rules (draft, review,
  approve, effective, superseded, retired). Otherwise each module is linked to the controlled SOP number and version in
  the company's document management system.
- **Sources:** Schedule M Part I 17.2 (approval, signature and dating; regular review; prevent use of superseded
  versions; keep superseded versions) (eBMR IN-06); EU Ch.4 4.3, 4.5; 211.100(a). eBMR PR-05.
- **Why:** A training record is worth no more than the SOP version it names. "Trained on SOP-QA-012" with no version
  is not evidence.
- **Tester checks:** (1) Create SOP v1, then try to assign it before peer review and approval. Expect a block.
  (2) Approve v1, then revise it. Expect v2 as a new version, with v1 still readable and E1's v1 record still pointing
  to v1. (3) Check that each training record shows the SOP code and version. (4) Check for an effective-date field, and
  that a version cannot be assigned before that date.

### LMS-18 Retraining on a new version, and training before the task (MUST)
- **Requirement:** When a new SOP version becomes effective, everyone in the affected groups is automatically assigned
  the new version, with a due date. A setting decides whether the training must be completed before the effective date
  (the recommended default for significant changes) or within a grace period. Learnova can answer the question "was
  person X qualified on SOP Y version Z on date D?", as a report and through an export or API, so that the eBMR and other
  GMP systems can block untrained people.
- **Sources:** 211.25(a) (training in the particular operations, frequent enough to stay familiar); EU Ch.2 2.8-2.12
  **[to confirm]**; Schedule M Part I 11.4 (training) (eBMR IN-04); 21 CFR 11.10(i). eBMR DI-21 (the eBMR checks
  current qualification against the LMS before every act), PR-15.
- **Why:** The rules require people to be trained before they do the work. The LMS is where that status comes from.
- **Tester checks:** (1) E1 completes v1. Make v2 effective. Expect E1 to show v2 as pending or overdue and to be no
  longer "current". (2) Run a report of qualification status for E1 as of a past date. Expect the answer as it stood on
  that date. (3) Look for an API or export of qualification status.

### LMS-19 Training matrix (curriculum) is controlled (MUST)
- **Requirement:** The assignment of SOPs to roles, groups or departments is an approved, versioned and audited
  record. New joiners and people who move role are assigned their curriculum automatically, including induction GMP
  training and data-integrity training. Removing a required SOP from a group needs approval and a reason.
- **Sources:** 211.25(a) (CGMP training and job-specific training); EU Ch.2 (training programmes approved and
  records kept) **[to confirm]**; Annex 11 §2; Schedule M Part I 11.4 (eBMR IN-04). eBMR DI-21.
- **Tester checks:** Move E2 to another group. Expect the new group's SOPs to be assigned and the change to be
  audited. As F1, try to remove an SOP from a group. Expect it to need approval, or to be at least audited with a
  reason.

## 6. Training records and evidence

### LMS-20 Complete training record per person (MUST)
- **Requirement:** For each person, Learnova keeps and can show: the curriculum; each training done (SOP code and
  version, method, trainer or faculty, start and completion time, every assessment attempt and score, pass mark, and
  the trainee's signature); the certificate; and the overdue or pending items. Effectiveness can be assessed, for example
  with a periodic assessment or a manager sign-off on practical competence.
- **Sources:** 211.25(a); EU Ch.2 (records kept; practical effectiveness periodically assessed) **[to confirm]**;
  EU Ch.4 4.29 **[to confirm]**; Schedule M Part I 11.4 (eBMR IN-04).
- **Tester checks:** Open E1's training history and export it. Expect every listed element. Compare it with the
  manager's team overview. Expect the two to agree.

### LMS-21 Retention and controlled disposal (MUST)
- **Requirement:** Training records, signatures, audit trail and superseded content are kept for a configurable
  period. The default should be at least as long as any batch record signed by that person (in India and the US, at
  least one year after expiry of the last batch they worked on; companies commonly keep them for employment plus N
  years). They survive the person leaving and their account being deactivated. Disposal is approved and recorded.
- **Sources:** Schedule M Part I 17.2 (retention at least one year after expiry) (eBMR IN-08); 211.180(a);
  EU Ch.4 4.10-4.12; Annex 11 §7.1, §17. eBMR DI-47, DI-21 (signature register kept as long as signed records).
- **Tester checks:** Deactivate E1. Expect E1's full history and certificates to stay viewable and exportable by QA.
  Look for a retention setting, and check that no one can bulk-delete users or records without an approval step.

### LMS-22 Readable copies and true-copy export for inspection (MUST)
- **Requirement:** Any training record can be produced as a complete, accurate, human-readable copy (PDF) and in a
  machine-readable format (CSV or JSON), with its signatures and audit trail. The copy states that it is a copy and
  when it was generated. The export must be faithful enough to serve as a true copy, and to be certified as one for
  Indian legal evidence if needed.
- **Sources:** 21 CFR 11.10(b), 211.180(c); Annex 11 §8.1-8.2; EU Ch.4 4.1; Schedule M Part XII 6.1 (hard copy
  obtainable; originals or true copies) (eBMR IN-10); Bharatiya Sakshya Adhiniyam 2023 s.63 (eBMR IN-11). eBMR DI-40,
  DI-41.
- **Tester checks:** Export E1's record for one SOP as PDF and as CSV. Compare every field with the screen. Expect them
  to match, and expect the signature manifestation and attempts to be included. Expect the PDF to show the time it was
  generated and a "copy" marking.

## 7. Qualified trainers and reviewers

### LMS-23 Faculty and reviewers are qualified, and the qualification is recorded (MUST)
- **Requirement:** Faculty access and peer-reviewer status are granted only to people recorded as qualified for the
  subject (with the evidence and the approver's name), not just by flipping a toggle. Faculty must themselves be current
  on the SOPs they teach or review.
- **Sources:** 211.25(a) (training conducted by qualified individuals); EU Ch.2 **[to confirm]**; Schedule M Part I
  11.4 **[to confirm]**. eBMR IN-04, DI-17.
- **Tester checks:** Turn on faculty access for E2. Check whether a qualification record or reason is required, and
  whether it is audited. Assign F1 to review an SOP version F1 is not trained on. Expect a warning or a block.

## 8. Trusted time

### LMS-24 Time from a trusted, synchronised source, shown with time zone (MUST)
- **Requirement:** All timestamps come from the server, which is synchronised to a trusted time source. They are
  stored unambiguously (UTC) and shown with the time zone (IST for Indian sites). The user's PC clock never sets a GMP
  time.
- **Sources:** 21 CFR 11.10(e), 11.50(a)(2); Annex 11 §12.4, §14(c). eBMR DI-27.
- **Tester checks:** Set the test PC clock 2 hours wrong, then complete a training. Expect the recorded time to be the
  true time, not the PC time. Check that the record, the certificate and the audit trail all show the time zone.

## 9. Backup and restore

### LMS-25 Regular backup, tested restore, business continuity (MUST)
- **Requirement:** Data, attachments (videos, documents) and audit trails are backed up regularly to a separate
  location and kept for the retention period. Restore is tested periodically and the test is recorded. A plan exists
  for an outage (for example, paper training records entered later as late entries, see LMS-15).
- **Sources:** 211.68(b); FDA DI Q&A Q1e; Annex 11 §7.2, §16; Schedule M Part I 17.2 electronic data-processing clause
  (backup) (eBMR IN-09). eBMR DI-45, DI-43.
- **Tester checks:** This is not testable in the browser. Ask the supplier for the backup schedule, the location, the
  date of the last restore test and its report. If they cannot provide them, record a gap.

## 10. Validation of the system

### LMS-26 Risk-based computerised-system validation, with the supplier's part defined (MUST)
- **Requirement:** The regulated company validates Learnova for its intended use. The work is risk-based (GAMP 5
  approach): user requirements (this list), a risk assessment, supplier assessment, configuration specification,
  tests of the GMP functions, a traceability matrix and a validation report, before go-live. For the SaaS, the supplier
  (Medhanta) provides: a quality system for its software development, release notes, its own test evidence, a written
  quality or service agreement (responsibilities, change notification, data ownership, data return when the contract
  ends, audit rights), and hosting controls. The regulated company stays accountable.
- **Sources:** 21 CFR 11.10(a); 211.68(a); Annex 11 Principle, §1, §3, §4; Schedule M Part I section 5 and 20.2-20.3
  (eBMR IN-12, IN-09); ICH Q9(R1). eBMR DI-03, DI-06, DI-08.
- **Why:** An unvalidated LMS cannot be relied on as evidence that people were trained.
- **Tester checks:** This is a document check. Ask Medhanta for: a supplier quality-system overview, a template
  quality agreement, release and test records for the current version, and an exit or data-return clause. Record
  whatever is missing.

### LMS-27 Non-GMP features kept from changing GMP records (SHOULD)
- **Requirement:** Features that are not GMP features (the AI assistant, analytics, screenshot blocking) are
  assessed in the risk assessment. The AI assistant can never create, grade or change a GMP record, or answer an
  assessment. Turning it off during assessments is controlled by configuration and audited.
- **Sources:** FDA DI Q&A Q3; 211.68(b); Annex 11 §1. eBMR DI-05, DI-51.
- **Tester checks:** During an assessment, confirm that the AI assistant cannot be opened by any route (a menu, a
  shortcut, a direct URL). Check who can change that setting, and that changing it is audited.

## 11. Change control and periodic review

### LMS-28 Change control for releases and configuration; periodic review (MUST)
- **Requirement:** Every Learnova release and every GMP-relevant change of configuration (roles, pass marks,
  sign-in method, signature settings, retention) is assessed, approved, tested and recorded before use. The supplier
  notifies customers of releases in advance and provides release notes, and the customer can assess a release before it
  reaches its production tenant. The system is reviewed periodically (access, audit-trail review, incidents, open
  changes, validation status) and the review is recorded.
- **Sources:** 211.68(a)-(b), 211.100(a); 21 CFR 11.10(k); Annex 11 §10, §11; Schedule M Part I 20.x (change
  procedure) (eBMR IN-09); Schedule M Part I section 5 (periodic review) (eBMR IN-12). eBMR DI-09, DI-11.
- **Tester checks:** Ask for the release history, the notice given before the last release, and whether a staging or
  validation tenant exists. In the product, change a pass mark. Expect it to be audited and to apply only to new
  attempts, never to re-grade past ones.

## 12. Data privacy (only where it touches the records)

### LMS-29 Privacy without losing the records (SHOULD)
- **Requirement:** The public certificate-verification page shows only the minimum (certificate number, name, SOP
  title and version, date, status), never email addresses or scores. Personal-data deletion requests do not delete GMP
  training records during their retention period. Any anonymisation keeps the records attributable for inspection.
- **Sources:** India Digital Personal Data Protection Act 2023 (retention where another law requires it)
  **[to confirm]**; GDPR Art. 17(3)(b) for EU-resident staff, if any **[to confirm]**; Annex 11 §7.1.
- **Tester checks:** Open the verification page logged out. Expect minimal fields. Check that the page cannot be used
  to list or search other people's certificates (try sequential numbers and partial names). Ask how an erasure request
  is handled for a former employee.

---

## Out of scope for the minimum

- Validation-grade test depth (mutation testing, multiple rounds of adversarial review).
- Integration-level enforcement in other systems. The LMS has to provide the qualification status (LMS-18); blocking
  untrained people is the job of the eBMR, QMS or MES.
- Digital signature certificates (Class 3 DSC or eSign under the IT Act) for training signatures. A password or PIN
  e-signature is enough for training acts.
- Screenshot blocking, video-watch percentage and sequential unlocking. These are good teaching features but not
  regulatory requirements. Note them only if they are claimed as controls.
- Gowning, aseptic-process-simulation and cleanroom qualification (EU Annex 1). These are separate qualification
  records unless Learnova is meant to hold them.
- A document management system for SOPs beyond LMS-17 (if the company already runs a separate one).
- Full GDPR programme, penetration-test depth, ISO 27001 certification.

## Citations still to confirm against the PDF

1. EU GMP Part I Chapter 2, training clauses: the exact numbers (2.8-2.12 in the 2014 text?) for these points: a
   training programme approved by the head of production or QC; continuing training; records kept; practical
   effectiveness periodically assessed; GMP induction for new staff. (Used in LMS-18, LMS-19, LMS-20, LMS-23.)
2. EU GMP Chapter 4, 4.29: whether it lists training, personnel and signature records among the documents that must
   be kept. (Used in LMS-07, LMS-10, LMS-20.)
3. Revised Schedule M (2023) Part I 11.4: the wording on training (initial and continuing, by qualified persons,
   records, effectiveness). The eBMR register cites "11.4 (training)" only at clause level. Also check whether
   Schedule M says anything about trainer qualification (LMS-23).
4. Annex 11 §5 (data exchange checks), for CSV import (LMS-05).
5. India DPDP Act 2023: the section that allows retention required by another law, and the DPDP Rules 2025 (LMS-29).
6. GDPR Art. 17(3)(b), only if the manufacturer has EU-resident staff (LMS-29).
7. 21 CFR 211.25(a)-(b): confirm the paraphrase used here. The register cites 211.25(a)-(c) under PR-15 and ST-07,
   but not in training-specific terms.
8. EU Ch.2 2.9-2.10: whether training must be done by qualified people.

## Questions for the owner

1. **Signature method.** Will Learnova add a personal signing PIN or password (recommended; meets 11.200 and Annex
   11 §14)? Or does the company want to argue that ID plus an email code, re-sent at each signature, is two components?
   The second option is weaker and likely to be challenged in an inspection.
2. **Login.** Must sign-in be restricted to company SSO or a company email domain with MFA? (Recommended: yes.)
3. **Where SOPs live.** Is Learnova the controlled source of SOP text (full document control, LMS-17)? Or does it only
   hold training on SOPs controlled in another system (link by SOP number and version)?
4. **Retraining timing.** For a new SOP version: must training be complete before the effective date, or within a
   grace period of N days? Should the rule differ for major and minor changes?
5. **Attempt limit.** Keep "unlimited attempts", or set a maximum (for example 3) followed by mandatory retraining
   with the trainer?
6. **Retention period** for training records (employment plus N years, or tied to batch-record retention)?
7. **Public verification page.** Keep it public, or limit it to logged-in or company users? Which fields may it show?
8. **Practical and on-the-job training.** Is this in scope for Learnova (with a trainer sign-off signature), or is it
   recorded elsewhere?
9. **Who approves SOP training content.** Is peer faculty review enough, or must QA also approve before training
   becomes effective? (Recommended: QA approval, since the rules call for quality-unit approval of procedures.)
