# Data integrity and computerised-system controls: eBMR control catalog (US FDA + EU GMP)

Scope: the shared compliance kernel used by both the TABLETS and INJECTABLES editions. Every control here is kernel (applies to both editions) unless a line says "Tablets:" or "Injectables:". India Revised Schedule M is mandatory for every product and lives in the separate India catalog. The kernel combines the two catalogs using the same stricter-wins rule described below.

Inputs: register bucket-data-integrity.jsonl (148 rows), _guardrails.json (secondary), ALCOA rows (intl-annex11-pics.jsonl) and ALCOA checks (di-verified.jsonl). Doubts were resolved against the local official texts: 21 CFR 11, 21 CFR 211, EU Annex 11 (2011), EU Ch.4 (2011) and the FDA DI Q&A (Dec 2018). Everything is paraphrased.

## Legend

- **Market profile.** Each product/MBR declares its target markets: IN (always) plus US and/or EU. The kernel applies the union of the applicable controls. Where parameters differ, it uses the strictest value (the max of retention periods, the tightest timing, and so on).
- **Type**
  - ENFORCED: engine behaviour that no tenant, site, MBR, role or administrator setting can weaken.
  - CONFIGURABLE: gives a safe default and an allowed range. Settings can only be made stricter, unless the rule itself allows options (stated when it does).
  - DESIGN-CHOICE: a product decision that no rule dictates. The reason is given, along with whether the engine enforces it.
- **Citation markers.** Unmarked means checked against the local official text (primary). (s) = secondary / web-summary only. (u) = unverified. (draft) = July 2025 EU consultation draft, not in force.
- **Binding status.** 21 CFR 11/211, EU Ch.4 (2011) and Annex 11 (2011) are binding. FDA guidance, EMA Q&A and ICH texts are guidance. The July 2025 Annex 11 and Chapter 4 drafts are pending (see section b).
- Row references are written nNNN and point to register rows.

---

## Controls

### DI-01 Record-type, official-record and raw-data register
**Covers:** n96, n616, n59, n648, n227, n43
**Behaviour:**
- Each tenant keeps a controlled register (versioned, approved by QA e-signature) of every GMP record type the eBMR holds or references: batch/packaging record, logbooks, forms, attachments, device printouts, interface-sourced data. For each type it records:
  - official medium (electronic, paper or hybrid);
  - which item is the original and which are copies;
  - raw / derived / informational class;
  - owner, retained metadata, retention rule ID and review rule;
  - where the record is stored.
- Raw-data floor: every data item a quality decision relies on is raw data. This covers release, IPC acceptance, yield and reconciliation evaluation, and deviation decisions. The engine derives "decision use" from limits, gates and review rules, and blocks approval of an MBR or register that classes such a field as anything other than raw.
- For anything executed in the eBMR, the electronic record is the official record. PDFs and printouts are copies and are marked as copies (DI-40). Each hybrid point must be declared with its linkage method (DI-41, DI-43).
- All eBMR records are treated as Part 11 records. The design does not rely on the 2003 enforcement-discretion policy, because the eBMR replaces paper and users create and modify GMP data in normal operation.
**Type:** ENFORCED: the register must exist, and the raw-data floor is checked at MBR/register approval. Register content is CONFIGURABLE per tenant.
**Citations:** US: 11.1(b), 11.1(e), 11.2(a), 11.3(b)(4),(6),(9); FDA DI Q&A Q10, Q12; FDA Part 11 Scope and Application guidance (2003) sec. III (s) | EU: Ch.4 Principle (records include raw data; for electronic records the user defines raw data, at minimum all data behind quality decisions), 4.1, 4.10 | ICH/EMA/draft: draft Ch.4 data governance / ALCOA++ (draft)(u)
**Jurisdiction:** EU Ch.4 is explicit on defining raw data. FDA gets to the same place through Q10/Q12 and the completeness wording in 211.188/211.194. There is no conflict, and the EU wording sets the floor.
**Test:** Classify an IPC result that feeds an acceptance limit as "informational" and try to approve the MBR. It is blocked. The register shows the official medium and storage location for each record type.

### DI-02 Metadata bound to every value across the data lifecycle
**Covers:** n60, n640, n111, n181, n108, n110, n88
**Behaviour:**
- Every stored GMP value carries its metadata, and the two cannot be separated. The metadata is:
  - unit;
  - acting user ID;
  - server timestamp;
  - source (device, interface or manual);
  - instrument/equipment ID;
  - material identity and status where relevant;
  - MBR version and step;
  - formula version for derived values;
  - a link to the value's audit-trail history.
- Metadata and audit trail travel with the value into every copy, export, backup, archive and migration. A copy without them is not a true copy (DI-41).
- Each record has a tracked lifecycle state: captured, verified, reviewed, used for decision, archived, eligible for disposal, disposed. Disposal happens only through DI-47.
- Values are stored locale-neutral (canonical number, unit code, UTC). Language and locale affect display only, never limits, units or meaning.
**Type:** ENFORCED (metadata binding). DESIGN-CHOICE (explicit lifecycle-state model and canonical storage): this makes the draft Ch.4 lifecycle expectations demonstrable, and the engine enforces it.
**Citations:** US: 11.10(e); 211.188, 211.194(a); FDA DI Q&A Q1a (life cycle through disposition), Q1b (metadata includes audit trails; data-metadata relationship kept secure and traceable), Q1e | EU: Ch.4 4.1, 4.10 | ICH/EMA/draft: draft Ch.4 draft-4.12 data lifecycle (draft)(s); draft Ch.4 metadata/audit-trail and ALCOA++ provisions (draft)(s)
**Jurisdiction:** FDA Q1b says outright that audit trails are metadata. The 2011 EU texts only imply it, and the EU draft states it. No conflict.
**Test:** Export a batch and restore it into an isolated environment. For 20 sampled values, confirm that unit, user, time, source ID, MBR/formula version and full change history are all present.

### DI-03 Computerised-system validation (application, infrastructure, life cycle)
**Covers:** n44, n147, n628, n200, n194, n209, n642, n167
**Behaviour:**
- The vendor supplies a validation package for each release: risk-based requirements, design/configuration specs, test evidence including negative and boundary tests on parameter limits, data limits and error handling, validation deviations and how each was resolved, release notes, known issues, and SDLC/QMS evidence. The customer performs risk-based verification of its configured use.
- Infrastructure is qualified: servers, DB, network, cloud tenancy and peripherals.
- Validation scope follows FDA's notion of the "system": hardware, software, peripherals (balances, scanners, label printers, terminals), network, cloud hosting, personnel roles and training, and the SOPs/manuals.
- A production tenant accepts a new software release for GMP use only after the customer records an approval e-signature on the validation summary for that release (staged release: validation tenant, then production). Every batch stamps the release it ran on (DI-10).
- The system can detect invalid or altered records. A scheduled integrity job checks record and signature hashes and raises an alarm if anything was changed outside the application (the hash mechanism is a design choice).
- High-impact functions get the deepest testing: limit checks, calculations, signature binding, status/release interlocks, exception reports, and any automated check that replaces a human check.
- Customer-specific scripts, reports and interfaces are treated as bespoke, with their own specifications, tests and quality metrics.
- Automated test tools and test environments carry documented adequacy assessments.
- A paper-to-electronic control map shows that no paper control was lost without a risk justification.
- Retirement is planned, so records stay readable after decommissioning (DI-46).
**Type:** ENFORCED (release-approval gate per tenant; integrity job). Package content is a vendor DESIGN-CHOICE within the listed minimum.
**Citations:** US: 11.10(a); 211.68(a)-(b); FDA DI Q&A Q1f, Q3 | EU: Annex 11 Principle, §1, §3.3, §4.1, §4.2, §4.5, §4.6, §4.7 | ICH/EMA/draft: ICH Q9(R1) sec. 1 (s); draft Annex 11 §9 qualification/validation incl. cloud documentation access (draft)(s)
**Jurisdiction:** Annex 11 is more prescriptive on documentation: supplier assessment, COTS documentation review, bespoke metrics, test-tool assessment. 11.10(a) adds the explicit duty to be able to detect altered records. Both apply.
**Test:** In a test environment, change a DB row outside the application. The integrity job alarms and names the record. Try to execute a GMP batch on a release that has no approved validation summary in that tenant. It is refused.

### DI-04 Verification of each MBR version and configured workflow before it becomes Effective
**Covers:** n61, n36, n617
**Behaviour:**
- QA cannot set Effective status until a verification record is linked. This applies to every MBR version and every configured GMP workflow, report, calculation, interface mapping and review-by-exception rule set. The record shows that the steps, requirements, limits, calculations and signature points work as intended.
- The verification method is documented review plus test. A dry-run/simulation mode is one acceptable method, not a requirement (see DI-05 if one is offered).
- MBR steps name the computerised systems they rely on: PLC/SCADA recipe and version, weighing system, checkweigher, vision/serialisation system, autoclave or lyophiliser controller, filter-integrity tester.
- PAT steps define the method, the model version and the acceptance criteria. An MBR containing a PAT step without acceptance criteria cannot be approved.
- At execution, the record captures the system/recipe version actually used and flags any mismatch with the MBR.
- The MPCR carries author and independent-checker e-signatures from two different people, then QU approval (the signature types are in DI-35; MBR content minima are in the production catalog).
**Type:** ENFORCED.
**Citations:** US: 211.68(b), 211.100(a), 211.186(a); FDA DI Q&A Q3, Q6, Q11 | EU: Ch.4 preamble "instructions" type (starting materials, equipment and computerised systems to be named; PAT with acceptance criteria), 4.3; Annex 11 §4.1, §10 | ICH/EMA/draft: none
**Jurisdiction:** FDA Q3 says explicitly that qualifying the platform does not prove that a given MPCR calculates correctly. The EU reaches the same result through Ch.4 4.3 approval plus Annex 11 validation. A verification record for every version satisfies both.
**Test:** Try to make a new MBR version Effective without a verification record. It is blocked. Run a batch whose PLC reports a different recipe version from the MBR. It is flagged as an exception.

### DI-05 Segregation of non-GMP functions (training, simulation, sandbox, analytics)
**Covers:** n643, n61
**Behaviour:**
- Non-GMP functions keep their data in segregated stores. Examples: training tenant, MBR simulation, planning/scheduling, analytics.
- They cannot:
  - write to GMP records, inventory, equipment status or genealogy;
  - change GMP configuration;
  - use real lot or batch identifiers (a reserved namespace is used instead);
  - have a non-GMP record converted into, or merged with, a GMP record.
- Their outputs carry a visible NOT-GMP watermark.
- A GMP record can only come from an Effective MBR.
- The validation package contains a documented impact assessment for each non-GMP function.
**Type:** ENFORCED (segregation). Offering a simulation mode at all is a DESIGN-CHOICE: FDA does not expect one.
**Citations:** US: FDA DI Q&A Q3 (assess and mitigate influence of non-CGMP functions on CGMP operations); 211.68(b) | EU: no dedicated clause; Annex 11 §1 (risk management) applies | ICH/EMA/draft: none
**Jurisdiction:** US guidance is explicit, and the EU covers it through general risk management. No conflict.
**Test:** From the training tenant, try to post to a production batch or reuse a real lot number. It is blocked. Simulation output carries the watermark.

### DI-06 System inventory, system description and requirements traceability
**Covers:** n149, n193
**Behaviour:**
- The system exports its own configuration inventory: modules, each enabled interface with endpoint and version, connected devices (balances, scanners, PLC/SCADA, printers, vision systems), and data flows.
- The export is compared automatically with the approved system description. An undocumented interface or device raises an alarm to the system owner and becomes a periodic-review item.
- The customer inventory lists the eBMR and each connected system with its GMP function.
- User requirements are based on documented risk assessment and GMP impact, and they are traceable to configuration items and tests. The traceability matrix is generated from linked IDs and kept current with each release and configuration change.
- Validation evidence includes boundary tests (just inside, on and just outside) for every critical limit, and negative tests of error handling.
**Type:** ENFORCED (inventory export and drift alarm). DESIGN-CHOICE (generated traceability matrix): this makes the draft's mandatory traceability matrix cheap to keep current, and it is enforced.
**Citations:** US: 211.68(b); FDA DI Q&A Q1f | EU: Annex 11 §4.3, §4.4, §4.7 | ICH/EMA/draft: draft Annex 11 §6 requirements, traceability matrix (draft)(s)
**Jurisdiction:** Only the EU texts explicitly require an inventory and a system description for critical systems. That requirement is adopted for all markets.
**Test:** Enable an interface that is not in the approved description. The drift alarm fires. Every critical limit shows boundary-test evidence in the matrix.

### DI-07 Risk-based data-criticality classification (raises controls, never removes floors)
**Covers:** n148, n202, n203, n183, n209
**Behaviour:**
- Every MBR field and step carries a criticality class (e.g., CQA/CPP-linked, GMP-supporting, informational) with a reference to an approved risk assessment.
- The class drives three things: whether manual entry needs a second-person or validated-electronic check (DI-30), whether limits are hard or soft, and highlighting in review (DI-25/26).
- Floors apply to all GMP data regardless of class, and a class cannot remove them: audit trail, attribution, mandatory reason for change, and inclusion of every post-entry change in audit-trail review.
- A new field defaults to "critical" until it is classified. Downgrading a class requires a QA e-signature, a linked risk assessment and change control.
- The data-risk assessment covers the whole business process, including manual hand-offs at interfaces, and prefers automated capture for critical values.
- Injectables: sterility-assurance data (sterilisation cycles, filter integrity, EM excursions, interventions) is critical by default.
- Tablets: blend uniformity, weight, hardness and similar IPCs are critical by default.
**Type:** CONFIGURABLE (class per field; default critical; downgrade only under QA-approved change control). Floors are ENFORCED.
**Citations:** US: FDA DI Q&A Introduction (risk-based strategies), Q8 (risk assessment considers data criticality, controls, product impact) | EU: Annex 11 §1, §6 | ICH/EMA/draft: EMA GMP DI Q&A on data criticality and data risk (s); ICH Q9(R1) sec. 1 (s)
**Jurisdiction:** Both markets allow a risk-based extent of controls. Neither lets risk classification remove the audit trail or attribution, which is why the floors exist.
**Test:** Try to downgrade a field without QA approval. It is blocked. A change to a field classed "informational" still appears in the audit trail and in the batch audit-trail review list.

### DI-08 Closed-system classification, hosting and supplier agreements, open-system data flows
**Covers:** n43, n53, n166, n179, n186, n225, n615
**Behaviour:**
- The deployment is documented as a closed system. The regulated company, not the vendor, controls access provisioning and approves privileged access.
- Vendor or support access is individually named, time-boxed, approved by the customer, protected by MFA, logged and reviewed. If customer control cannot be demonstrated, the tenant is treated as open (11.30): the 11.10 controls plus extra measures (e.g., encryption, digital signatures) as the circumstances need.
- Data flows that cross organisational boundaries protect authenticity, integrity and (where appropriate) confidentiality from creation to receipt. Examples: data exchanged with a CMO or contract giver, imported supplier CoAs, trading-partner messages, remote support. The protection is TLS in transit plus signed payloads or an equivalent. The importer records source metadata and the supplier's qualification status.
- A formal written agreement exists with every third party, internal and group IT included: vendor, cloud host, validation contractor, remote-maintenance provider, archive provider. It covers:
  - responsibilities and data ownership;
  - backup/restore and retention;
  - audit-trail availability;
  - notification of changes and security incidents;
  - support during inspections and customer audit rights;
  - exit/data return as a full export with audit trails and signatures in readable form.
- Supplier QMS and audit information can be produced for inspectors. The need for a supplier audit is decided by risk.
- The MIA holder / contract giver keeps access to complete batch records for the full retention period, including after the contract ends.
- System documentation and the computer systems themselves are readily available for FDA inspection.
**Type:** ENFORCED for the product capabilities: customer-controlled access, the vendor-access grant workflow and log, and full export. The agreements are organisational and are tracked in a go-live checklist.
**Citations:** US: 11.1(e), 11.3(b)(4),(9), 11.10 introductory text (authenticity, integrity, confidentiality when appropriate, non-repudiation), 11.30 | EU: Annex 11 §2, §3.1, §3.2, §3.4 | ICH/EMA/draft: EMA GMP DI Q&A on outsourced activities / chain of contracts (s); ICH Q10 sec. 2.7 (s); draft Annex 11 §7 supplier and service management incl. exit strategy (draft)(s)
**Jurisdiction:** Annex 11 §3.1 requires agreements even with internal IT departments, which is broader in scope. 11.30 adds a separate control set when access is not controlled by the record owners. Both apply.
**Test:** A support engineer tries to log in without a customer-approved time-boxed grant. Refused. A full tenant export re-opens in the stand-alone viewer with audit trails and signature manifestations intact.

### DI-09 Change and configuration management (including systems documentation)
**Covers:** n157, n52, n8, n62
**Behaviour:**
- Every configuration object is versioned through Draft, Review, Approved (e-signature) and Effective. This covers MBRs, workflows, calculations, limits, roles and permission sets, signature policies, interface settings, exception/RBE rules, retention rules and report templates.
- Each change carries a change-record ID. The configuration audit trail stores diffs, and an exportable baseline is kept per environment. Drift from the validated baseline raises an alarm.
- New batches can use only one Effective version per product plus batch size (processing), or per product, pack size and pack type (packaging). A batch in progress stays on the version it was issued from unless an approved change says otherwise.
- There is no direct DB editing in production, and no admin-console path that changes specifications, process parameters or MBR content outside the change workflow.
- Only authorised people can change master records or other records. A change without a change-record ID is refused.
- Systems documentation (URS, configuration specs, SOPs, admin manuals) is held under controlled distribution, access and use, with a time-ordered revision history.
- Software releases are tested in a non-production environment before production.
**Type:** ENFORCED.
**Citations:** US: 211.68(b), 211.100(a); 11.10(k)(1)-(2); FDA DI Q&A Q4 | EU: Annex 11 §10, §4.7 (test environments); Ch.4 4.3, 4.29 (change-control records) | ICH/EMA/draft: none
**Jurisdiction:** Both markets require controlled change. 11.10(k) additionally requires documentation control with a time-sequenced audit trail. Both apply.
**Test:** Try to change a specification limit through the admin console. Impossible. Submit a configuration change without a change-record ID. Rejected. A configuration diff can be retrieved for any past date.

### DI-10 Version-in-force stamping (executed-context snapshot)
**Covers:** n194, n617
**Behaviour:**
- Each executed step stores the version or value of everything it depended on:
  - software release and configuration baseline ID;
  - MBR version and hash, and formula version;
  - specification limits and SOP version;
  - equipment status and calibration due date;
  - material status;
  - device and recipe versions.
- A later change to master data never alters how a completed record is displayed or how its results were evaluated.
**Type:** DESIGN-CHOICE, engine-enforced. No rule names this mechanism, but without it 211.188(a), 11.10(e) and Ch.4 4.20 could not be shown to hold after master data changes.
**Citations:** US: 211.188(a) (accurate reproduction of the master), 11.10(e) | EU: Ch.4 4.20 (record based on the currently approved instructions), Ch.4 preamble (instructions name computerised systems); Annex 11 §10 | ICH/EMA/draft: draft Annex 11 §9 context (draft)(s): recording the version in force per batch is a design means from the register row, not reported draft text
**Jurisdiction:** No conflict.
**Test:** Tighten a specification limit after a batch completes. The completed record still shows the original limit version and its original pass/fail evaluation.

### DI-11 Periodic evaluation and routine checks of the eBMR itself
**Covers:** n158, n178, n7
**Behaviour:**
- For a chosen period the system generates a periodic-review pack covering:
  - software releases and configuration changes;
  - open validation gaps;
  - incidents and interface failures;
  - access changes and privileged activity;
  - audit-trail review completion;
  - backup/restore and DR test results;
  - archive fixity and readability results;
  - time-sync events;
  - alarm statistics;
  - supplier SLA performance;
  - training status of active users.
- The approved periodic-review report and its actions are stored in the system or linked to it.
- A written routine-check program for the eBMR as a "computer or related system" covers interface health, backup success, time sync and integrity-job results, and its check records are kept.
**Type:** CONFIGURABLE for review frequency. No rule sets a number. DESIGN-CHOICE default: 12 months; shorter allowed; longer only with a QA-approved risk rationale. Pack content is ENFORCED.
**Citations:** US: 211.68(a) (routine checks under a written program, records kept) | EU: Annex 11 §11 | ICH/EMA/draft: draft Annex 11 §14 periodic review (draft)(u)
**Jurisdiction:** 211.68(a) applies a routine calibration/inspection/check program to computers as well as other equipment. Annex 11 §11 requires periodic evaluation of validated state. Both apply.
**Test:** Generate the pack for a test period and trace 5 sampled entries per topic back to their source logs.

### DI-12 Incident management linked to batches
**Covers:** n161
**Behaviour:**
- The system automatically raises incidents for:
  - interface failures;
  - loss of connection during a step;
  - client or server crashes;
  - repeated signature failures;
  - time-sync faults;
  - print failures;
  - integrity-check failures.
- Users can also raise incidents manually.
- Each incident is linked to the affected batches and steps. An open incident linked to a batch is shown on the review and disposition screens and blocks disposition until it has been assessed.
- Every incident carries a criticality rating. A critical incident cannot be closed without a root cause and a CAPA link.
**Type:** ENFORCED for logging, batch linkage, and root cause plus CAPA on critical incidents. The disposition block is a DESIGN-CHOICE, engine-enforced by default: it puts the Ch.4 4.27 "special observations" indication into effect.
**Citations:** US: 211.192 (unexplained discrepancies investigated) | EU: Annex 11 §13; Ch.4 4.27 | ICH/EMA/draft: none
**Jurisdiction:** Only the EU text explicitly requires incident management for computerised systems. It is adopted for all markets.
**Test:** Kill the balance interface in the middle of a weighing. An incident is created, linked to the batch and shown as open on the disposition screen. Try to close it as critical without a root cause and CAPA. Blocked.

### DI-13 Security baseline, confidentiality and non-repudiation evidence
**Covers:** n176, n615
**Behaviour:**
- Encryption:
  - TLS on all client and interface connections; plain HTTP is refused.
  - Encryption at rest for the DB, attachments, backups and archives.
- Access to confidential data (formula composition, personal data) is restricted by role and site.
- Shop-floor clients are hardened: kiosk mode, removable storage disabled.
- Platform hygiene:
  - malware protection and patch SLAs;
  - segmentation between the OT line network and the IT network;
  - isolation of unsupported platforms.
- MFA is required for all remote access and all privileged access.
- Internet-exposed or SaaS deployments are penetration-tested periodically.
- RTO and RPO are documented per module. The execution module has the tightest RPO (Injectables: continuous aseptic filling).
- Each signature has a non-repudiation evidence package: identity-verification record, authentication event, manifestation and audit trail.
**Type:** ENFORCED for TLS, encryption at rest, and MFA on remote/privileged access (designed to the stricter draft; no conflict). CONFIGURABLE for RTO/RPO values and pen-test frequency (DESIGN-CHOICE defaults: annual pen test; RPO set by risk).
**Citations:** US: 11.10 introductory text (authenticity, integrity, confidentiality when appropriate, non-repudiation), 11.30; 211.68(b) (backup data secure from alteration, erasure, loss) | EU: Annex 11 §7.1, §12.1, §12.2 | ICH/EMA/draft: draft Annex 11 §15 security incl. reported 15.19 penetration testing (draft)(s); draft Annex 11 §10 encryption, §11 MFA for remote access (draft)(s)
**Jurisdiction:** The 2011 texts set general protection duties. The draft Annex 11 is prescriptive, and the kernel designs to it.
**Test:** A non-TLS connection is refused. USB storage on a kiosk is blocked. A user without formula permission cannot open the composition. For a sampled signature, the evidence package can be produced.

### DI-14 Unique personal accounts; no shared write-capable accounts
**Covers:** n63, n173, n226, n47, n159
**Behaviour:**
- Every GMP action requires an individually assigned, authenticated account. GMP actions are create, change, verify, review, approve, sign and acknowledge (including alarm acknowledgment).
- An account flagged generic or shared cannot be given any write, sign, verify or acknowledge permission. The engine checks this when a role is assigned, not only by policy.
- A shared read-only view (e.g., a line-status display) is allowed only if it is technically unable to create, change, sign, verify or acknowledge anything.
- Interface and service accounts are non-interactive and cannot sign. Their entries are attributed to the interface or device.
- On shared terminals, each entry is attributed to the person who authenticated for that entry. Re-authentication is fast (e.g., badge plus PIN).
- Injectables: cleanroom terminals use a method that works with gloves (badge/RFID plus PIN, or biometrics), so a shared login is never needed.
**Type:** ENFORCED.
**Citations:** US: 11.10(d), 11.10(g), 11.100(a), 11.300(a); 211.68(b), 211.188(b)(11), 211.194(a)(7)-(8); FDA DI Q&A Q5 | EU: Annex 11 §12.1, §12.4 | ICH/EMA/draft: draft Annex 11 §11 identity and access management (shared accounts read-only only) (draft)(s)(u)
**Jurisdiction:** Both markets allow shared read-only viewing (FDA Q5; draft). Neither allows shared accounts for any action, including second-person review.
**Test:** Assign a write permission to an account flagged generic. Refused. A service account attempts a signature. Blocked. A directory scan finds no generic account holding GMP permissions.

### DI-15 Identity verification, credential issuance and permanent identifier uniqueness
**Covers:** n56
**Behaviour:**
- Before any signature component is issued, account activation requires a recorded identity verification: who verified, method, document type and date.
- User IDs are never reused or reassigned, even after deactivation. A permanent registry spans sites and tenants. Accounts are disabled, never deleted, so historical attribution survives.
- There is no proxy or delegated signing.
- Initial and admin-reset passwords are single-use and must be changed before the account can sign. This guarantees that misusing another person's signature would need two or more people to collude.
- US market: a go-live checklist per legal entity records submission of the FDA non-repudiation certification letter (11.100(c)). This is an organisational duty. The system flags a missing letter for US-market tenants but does not block execution.
**Type:** ENFORCED. NRL tracking is a DESIGN-CHOICE, because it is a firm's submission to FDA, not a system function.
**Citations:** US: 11.100(a)-(c) (as amended 2 March 2023), 11.200(a)(2)-(3), 11.300(a) | EU: Annex 11 §12.1, §12.4 | ICH/EMA/draft: draft Annex 11 §11 (draft)(s)
**Jurisdiction:** The NRL certification is US-only, with no EU equivalent. Identity verification before issuing credentials is explicit only in the US text and is adopted for all markets.
**Test:** Create an account with a deactivated user's ID. Blocked. Activate an account with no identity-verification record. Blocked. Sign with an admin-reset password before changing it. Refused.

### DI-16 Access lifecycle: recorded grants, point-in-time access lists, recertification, prompt removal
**Covers:** n644, n159, n62, n47, n173
**Behaviour:**
- Every grant, change and revocation of access rights is recorded in a protected log with requester, approver, date and reason. The requester and the approver must be different people (design).
- The system reports the current and point-in-time (any past date) list of users, roles, privileges and sites for each system. This is the "authorised users and privileges" list.
- A leaver event from HR or the IdP disables the account. DESIGN-CHOICE default: the same business day. No rule sets a time.
- Periodic access recertification by the area owners records the reviewer, the outcome and each user's last activity. DESIGN-CHOICE default: every 6 months; allowed 3-12 months.
**Type:** ENFORCED for recording and point-in-time reports. CONFIGURABLE for timings (no regulatory numbers exist).
**Citations:** US: 11.10(d); 211.68(b); FDA DI Q&A Q4 (documented list of authorised personnel and privileges) | EU: Annex 11 §12.3 | ICH/EMA/draft: draft Annex 11 §11 (timely handling and review of access rights) (draft)(s)
**Jurisdiction:** EU §12.3 explicitly requires recording of access changes. FDA Q4 recommends a documented privilege list. Both apply.
**Test:** Produce the role list as of a past date and reconcile it with the access-request records. Disable a leaver, then try to log in and to sign. Both fail.

### DI-17 Authority checks per action, least privilege and segregation of duties
**Covers:** n50, n2, n173
**Behaviour:**
- At every action the engine checks that the user holds a role permitted for that action on that object. Objects are scoped by legal entity, site, area, product, line and step type. Actions include:
  - execute, verify, supervise;
  - QA review and audit-trail review;
  - disposition / QP certification;
  - MBR author, checker, approver;
  - master-data change, configure, administer.
- A failed check blocks the action (it does not just warn) and is logged.
- Signature meanings are bound to roles. For example, only the QU-disposition role can sign "Approved for release" or "Rejected".
- Segregation of duties is enforced by the engine:
  - the performer of an entry is not its verifier;
  - the MBR author, checker and QU approver are three different users;
  - a user who executed or verified any step of batch X cannot do the audit-trail review of batch X or sign its disposition.
- Data is isolated between sites by default.
- Status changes on materials, intermediates and batches are QU-only e-signatures; the details are in the production catalog.
**Type:** ENFORCED for the checks, performer-not-verifier and author-not-checker. The executor-not-reviewer/disposer rule is a DESIGN-CHOICE, engine-enforced: it is good practice supporting QU independence and the draft's independent-reviewer expectation, not explicit rule text.
**Citations:** US: 11.10(g); 211.22(a),(c); 211.68(b); 211.101(c)-(d), 211.103, 211.186(a), 211.188(b)(11) | EU: Annex 11 §2 (level of access), §12.1; Ch.4 4.20(c), 4.21(c) | ICH/EMA/draft: draft Annex 11 §11 least privilege (draft)(s); draft Annex 11 §12 independent audit-trail reviewer (draft)(s)
**Jurisdiction:** US second-person rules (211.101, 211.103, 211.186(a), 211.188(b)(11)) require the checker to be someone other than the performer. EU Ch.4 asks for a checker "where appropriate". The stricter US rule applies.
**Test:** Run a permission-matrix suite with positive and negative tests for every role and action. The performer tries to verify their own entry. Refused. A batch executor tries to sign disposition of that batch. Refused. A role without the QU function tries to sign "Approved for release". Refused.

### DI-18 System-administration segregation (administrators independent of record content)
**Covers:** n645, n62, n168
**Behaviour:**
- No account in a tenant can hold both a system-administration permission and a GMP data permission. The engine rejects the assignment.
  - System-administration permissions: user/role management, configuration, interface settings, audit-related settings, file or DB access.
  - GMP data permissions: execute, verify, review, approve, release, MBR authoring.
- Administrators cannot change GMP data values, cannot sign GMP records, and cannot grant themselves any role. Every role grant needs a second approver.
- Break-glass accounts are sealed and time-limited, need dual authorisation, raise an alarm when used, and are reviewed afterwards. They cannot perform GMP actions.
- Privileged actions go to a protected system log. That log is covered by periodic review (DI-11) and by the configuration audit trail.
- The product has no in-built exception for small sites: FDA Q4 offers no fallback. Any compensating arrangement is owned by the firm (see open questions).
**Type:** ENFORCED (designed to the stricter draft; FDA text says "should").
**Citations:** US: 11.10(d), 11.10(g); 211.68(b); FDA DI Q&A Q4 (administrator rights assigned to people independent of record content) | EU: Annex 11 §12.1, §12.2 | ICH/EMA/draft: draft Annex 11 §11 segregation of duties, §12 privileged functions only for administrators independent of GMP work (draft)(s)
**Jurisdiction:** FDA recommends. The 2011 EU text is silent. The EU draft is explicit, so the kernel follows the draft.
**Test:** Assign an administrator role to a user who holds a QA role. Refused. An administrator tries to edit a GMP value through the UI or API. Refused and logged. A break-glass login raises an alarm and cannot sign.

### DI-19 Credential protection: password policy, lockout, misuse detection, token and badge management
**Covers:** n58, n173
**Behaviour:**
- Each ID-plus-password combination belongs to one individual. This follows from unique IDs (DI-15).
- Issued credentials are checked, recalled or revised periodically. At least one of these must be active, and the engine refuses a configuration with neither:
  - password aging (DESIGN-CHOICE default: 90 days);
  - a documented risk-based equivalent, i.e. compromised-password screening plus access recertification.
- Lockout after N consecutive failed login or signing attempts. DESIGN-CHOICE default N = 5; allowed 3-5.
- Transaction safeguards: failed attempts, signing attempts on locked or disabled accounts, and anomalous use raise an immediate alert to the security unit (and to management where defined). Acknowledgment is tracked and unanswered alerts escalate.
- A lost, stolen or possibly compromised badge or token is de-authorised electronically at once. A replacement is issued only after identity is re-verified.
- Badges and tokens are tested when issued and periodically, and the results are recorded.
- There is no "remember password", and administrators can never see passwords.
**Type:** ENFORCED (mechanisms). CONFIGURABLE (numeric values). Neither Part 11 nor Annex 11 (2011) sets any number for password length, aging, lockout count or alert time.
**Citations:** US: 11.300(a)-(e); 11.200(a)(2)-(3) | EU: Annex 11 §12.1, §12.2 | ICH/EMA/draft: draft Annex 11 §11 automatic lock-out after repeated failed log-ins (draft)(s)
**Jurisdiction:** 11.300(d) requires immediate and urgent reporting of attempted misuse, which is stricter than the 2011 EU text. The EU draft adds lockout. Both apply.
**Test:** Make 5 failed signing attempts. The account locks and the security unit receives the alert within the configured time. A revoked badge cannot authenticate. Badge test records exist.

### DI-20 Device and data-source checks
**Covers:** n51, n7
**Behaviour:**
- Every device has a registered identity and an assigned room or line: terminals, tablets, balances, scanners, instruments, PLC/SCADA connectors, printers.
- Every value stores the ID of the device it came from.
- For steps where the MBR declares device binding, data is accepted only from a registered device assigned to that step's location. Recipe downloads go only to the registered equipment for the step.
- A measuring device can be used only if it is within calibration and has passed any required pre-use check. The calibration details are in the production catalog.
**Type:** CONFIGURABLE for device-to-location binding per step. The rule applies it "as appropriate". Default ON for weighing, dispensing and critical-parameter capture; it can be turned OFF only for non-critical steps, with a rationale. The device registry and the source-ID stamp are ENFORCED.
**Citations:** US: 11.10(h); 211.68(a) | EU: Annex 11 §5 | ICH/EMA/draft: none
**Jurisdiction:** 11.10(h) is the only explicit device-check rule. The EU reaches a similar result through §5 built-in checks.
**Test:** Data arriving from an unregistered or relocated scale is rejected with an alert. A stored weight shows its source balance ID.

### DI-21 Training of system users, e-signature accountability policy and signature register
**Covers:** n3, n52, n655, n624
**Behaviour:**
- Before a user can execute, verify, review or approve an action, the engine checks that the user holds a current qualification for that operation, SOP version and MBR (via LMS integration or an internal curriculum). A lapse is a hard stop that names the missing item. A supervisor cannot sign on the user's behalf.
- The qualification evidence as it stood at signing time is snapshotted with each executed signature.
- Required training content: using the eBMR; preventing and detecting data-integrity problems; audit-trail review (for reviewers).
- Training also covers administrators, key users and the vendor's developers and maintainers (evidenced through supplier qualification).
- A written e-signature accountability policy exists. Before first signing, a user acknowledges it electronically, and the acknowledgment is recorded (design).
- The signature register maps each user ID to full name, initials (if used), roles, permitted signature meanings and validity dates. It is kept at least as long as any record that user signed, and it can resolve any signer as of the signing date.
- Injectables: aseptic roles also need current gowning and APS qualification. That check lives in the sterile catalog.
**Type:** ENFORCED (signature register; acknowledgment before first signing is an engine-enforced DESIGN-CHOICE). CONFIGURABLE for training gating: default hard block, which may be relaxed to a flag-and-review mode only by QA-approved configuration. The rules require trained staff; they do not require system gating.
**Citations:** US: 11.10(i), 11.10(j); 211.25(a); FDA DI Q&A Q16 | EU: Annex 11 §2; Ch.4 4.29 (personnel records incl. signature lists and training) | ICH/EMA/draft: none
**Jurisdiction:** 11.10(i) explicitly extends training duties to developers and maintainers. EU Ch.4 4.29 explicitly requires signature lists. Both apply.
**Test:** Expire a user's SOP training. Execution and verification are both blocked. A new user tries to sign before acknowledging the policy. Blocked. An archived signer resolves to the name and role valid on the signing date.

### DI-22 Audit trail: capture scope and entry content
**Covers:** n48, n156, n168, n111, n640, n160, n88, n226
**Behaviour:**
- The server generates the audit trail independently of the UI, and it is append-only.
- It records every create, modify, delete/void, confirm/verify, sign, status change and configuration change of GMP-relevant data: execution data, MBRs, master data, roles, limits, review and release.
- Each entry holds:
  - user ID, printed full name and role at the time;
  - action type;
  - object, record and field;
  - old and new value;
  - server date-time (UTC plus site offset);
  - reason, chosen from a controlled list with free text. A reason is mandatory for any modification and any delete/void of GMP data after initial commit. It is not required for initial creation.
  - source terminal or device ID (design).
- A separate protected system log records: logins, failed logins, lockouts, permission changes, configuration changes, interface and equipment-communication events, and alert records.
- The audit trail is kept at least as long as its subject record and travels with it (DI-02).
- It can be viewed and exported in plain language (not raw codes) and filtered by batch, step, user, data class and date.
**Type:** ENFORCED.
**Citations:** US: 11.10(e); FDA DI Q&A Q1b, Q1c (data-level and record/system-level audit trails; reprocessing justified) | EU: Annex 11 §9 (reason for change or deletion of GMP-relevant data; available in intelligible form), §12.4 (identity and date/time for entering, changing, confirming, deleting); Ch.4 4.9 | ICH/EMA/draft: draft Annex 11 §12 (creation included; who/what/when/why; role; time zone; reason prompted) (draft)(s); draft Ch.4 metadata/audit-trail provisions (draft)(s); draft summary (draft)(u)
**Jurisdiction:**
- The US makes the audit trail mandatory and covers creation, but 11.10(e) does not require a reason.
- EU 2011 makes the audit trail risk-based ("consideration should be given"), but it requires a documented reason for any change or deletion and captures confirmations.
- Combined: the trail is mandatory and covers creation, changes, deletions and confirmations, and a reason is required for changes and deletions.
- The draft's role and time-zone fields are adopted.
**Test:** As each role, create, modify and void a value. Every entry carries all fields. Saving a modification without a reason is blocked. A failed login, a role change and a configuration change each appear in the system log.

### DI-23 Audit trail: always on, immutable, tamper-evident
**Covers:** n645, n168, n44
**Behaviour:**
- No tenant, site, MBR, role or administrator setting can disable, pause, narrow at capture time, edit or purge the GMP audit trail.
- Audit-related settings (e.g., adding event types) can be changed only by independent administrators (DI-18) under change control. The change itself goes to the protected system log and is flagged for QA.
- No UI or API function deletes audit entries during retention.
- The trail is tamper-evident: it is hash-chained, a scheduled verification job checks the chain, and a break raises a critical alarm. DB-level activity monitoring detects direct changes.
**Type:** ENFORCED. The hash chain is the DESIGN-CHOICE used to meet "secure" and "ability to discern altered records".
**Citations:** US: 11.10(e) (secure), 11.10(a) (discern altered records); FDA DI Q&A Q4, Q12 (inference; the Q&A does not itself say who may switch audit trails off) | EU: Annex 11 §9 | ICH/EMA/draft: draft Annex 11 §12 (should not be possible to turn off, edit or delete) (draft)(s)
**Jurisdiction:** Neither the 2011 EU text nor the FDA Q&A explicitly forbids deactivation. 11.10(e) requires a secure trail, and the draft forbids deactivation outright, so the kernel follows the draft.
**Test:** Search the UI, the API and the admin console for any disable or purge function. None exists. In a test environment, change an audit row directly in the DB. The verification job alarms and names the entry.

### DI-24 Corrections, voids and deletions: the original is always preserved
**Covers:** n658, n145, n203, n48
**Behaviour:**
- After initial commit, a GMP value can only be corrected by creating a new version linked to the original.
- The original stays visible in the record, in review views and on printouts (DI-40).
- A correction requires the corrector to re-authenticate (signature meaning "Corrected by"). It records user, date-time and a mandatory reason.
- "Delete" of GMP data is implemented as void/invalidate with a reason. The data is retained and shown as voided.
- Correcting signed content supersedes the signature (DI-37).
- Physical purge is possible only after retention ends, through DI-47. Deletion at DB level is prevented or detected.
**Type:** ENFORCED (original preserved, reason, no deletion within retention). DESIGN-CHOICE, engine-enforced: a correction needs re-authentication because EU Ch.4 4.9 asks for alterations to be signed and dated, and an e-signature ceremony is the conservative reading. Physical-deletion ban during retention: 11.10(e) tolerates audited deletion; the ban is stricter.
**Citations:** US: 11.10(e); FDA DI Q&A Q1c, Q12, Q13; Background (data secure until disposition) | EU: Ch.4 4.9; Annex 11 §9, §12.4 | ICH/EMA/draft: EMA GMP DI Q&A on data risk (s)
**Jurisdiction:** US: prior information must not be obscured. EU: alteration signed and dated, original readable, reason (Annex 11 §9: for all GMP-relevant changes and deletions). The EU is stricter on the reason and the signature.
**Test:** Try to delete an entry through the UI and the API. Only void-with-reason is offered. Correct a value. The original is visible in the record, in the review list and in the PDF, alongside the corrector's signature and reason.

### DI-25 Audit-trail review within batch review (step level and before disposition)
**Covers:** n65, n169, n172, n170, n226
**Behaviour:**
- **Step level.** When a checker or verifier signs a significant step, the system shows inline every post-entry change, void and signature supersession on that step's data, like paper cross-outs: old and new value, who, when, why. The checker's signature covers that review.
- **Batch level.** Before QU disposition (US) and before QP certification (EU, where recorded in the system), someone must complete and e-sign a batch-scoped audit-trail review task ("Audit trail reviewed").
  - The reviewer must not have executed or verified any step in that batch.
  - Disposition/certification is blocked until the review is signed and every discrepancy raised from it is closed or impact-assessed.
- **Scope.** Every change to any data in the batch record is in scope. Criticality may order or highlight entries but never excludes them. Scope also includes batch-linked system events: interface failures, signature failures, lockouts, time-sync faults and alarms.
- **No deferral.** There is no option to defer audit-trail review until after release.
- **Discrepancies.** Any entry can be escalated to a deviation directly.
- **QU/QP view.** The QU and QP can open the full batch audit trail from the disposition/certification screen. That screen shows review status, reviewer, date and findings.
**Type:** ENFORCED.
**Citations:** US: 211.22(a), 211.188(b), 211.192; FDA DI Q&A Q7 (reviewers of a record review the audit trails of its data; QU review includes audit trails), Q8 (same frequency as the data: after each significant step and before release) | EU: Annex 11 §9 (regular review); Ch.4 4.27 (indication of changes to critical data; records available to QP) | ICH/EMA/draft: draft Annex 11 §12 review (written procedure, independent reviewer, before release, QP access) (draft)(s); draft summary (draft)(u); draft removal of 2011 §15 with QP audit-trail access (draft)(s)
**Jurisdiction:**
- The US is stricter on timing: every significant step, plus before release.
- EU 2011 says only "regularly".
- The draft moves to "before release" but is reported to allow a justified later review. That option conflicts with the US before-release rule and is not offered.
**Test:** Change a value after entry. It appears in the checker's step view and in the batch review list. Disposition stays blocked until the review is signed. A batch executor tries to sign the review. Refused. No configuration offers deferral.

### DI-26 Review by exception, error detection and risk-based review of system logs
**Covers:** n184, n201, n646, n639, n61
**Behaviour:**
- The engine builds a batch exception report from a mandatory set of exception types:
  - out-of-limit values;
  - deviations and overrides;
  - forced, skipped or NA steps;
  - post-entry changes and voids/invalidations;
  - repeats and aborted attempts;
  - late or back-entered data;
  - manual entry where automatic capture was configured;
  - interface fallbacks and failures;
  - signature failures;
  - alarm events;
  - time-sync events;
  - open incidents.
- Customers may add types or raise severity. They cannot remove a mandatory type.
- A clean batch report states "no exceptions" and shows a completeness summary. Every item drills down to the full record. Reviewers work on the electronic record, not on printouts.
- The RBE rule set is version-controlled configuration and changes only under QA-approved change control. It is validated by seeded-exception tests with zero false negatives, and challenged periodically by comparing sampled full audit trails with the filtered view.
- A new product or process, or one with a poor recent history, defaults to full review until a configured confidence criterion is met (design).
- Instrument-status and communication logs and alert records are reviewed at a frequency set by a documented risk assessment. Any such event tied to a batch surfaces in that batch's review.
- Detection is built in: range checks, completeness checks before sign-off, out-of-sequence/late-entry detection, and interface reconciliation.
**Type:** ENFORCED for the mandatory type set, validation, drill-down and change control. CONFIGURABLE for whether an MBR uses RBE: default full review until the confidence criterion is met. The QU still approves the complete record (DI-39).
**Citations:** US: 211.68(b), 211.192; FDA DI Q&A Q1a (design for easy detection of errors, omissions, aberrant results), Q3 (validate the workflow), Q8 and footnote 13 (risk-based review of instrument status/communication logs and alerts; reliability of review proven) | EU: Annex 11 §9; Ch.4 4.20 Note (compliance summaries and exception reports for continuously monitored validated processes) | ICH/EMA/draft: EMA GMP DI Q&A on review of electronic data / review by exception (s)
**Jurisdiction:** The EMA Q&A explicitly accepts review by exception when it is scientifically justified and validated. The FDA DI Q&A does not mention RBE: it requires the QU to review all records, audit trails included, and asks that review reliability be proven. So RBE is used only as a validated way of doing the full QU review, never as a reduction of what the QU approves.
**Test:** Seed a batch with one instance of every exception type. All are listed. A clean batch shows "no exceptions" with its summary. Try to edit an RBE rule without a change record. Blocked.

### DI-27 Trusted time
**Covers:** n160, n88, n10
**Behaviour:**
- Every GMP timestamp comes from the synchronised server clock: entries, audit trail, signatures, status changes, step start and completion, and significant intermediate stages.
- Client-device clocks and user-typed times are never used as the time of an action.
- Timestamps are stored in UTC with the site time zone and offset, and displayed as site-local time with the offset. Ordering stays correct across daylight-saving changes.
- Event times a user enters from another source (e.g., cycle start read off a printout) are separate, flagged data fields. They are kept distinct from the time the entry was made.
- Server-to-reference offset is monitored:
  - Beyond the threshold, an alarm and an incident are raised, and entries made during the fault are flagged for review.
  - Capture is never simply blocked without the controlled contingency path of DI-43, because staff must never fall back to scrap-paper notes.
**Type:** ENFORCED for server time and UTC storage. CONFIGURABLE for the drift threshold: DESIGN-CHOICE default 1 s, allowed 0.1-5 s. No rule sets a clock tolerance.
**Citations:** US: 11.10(e) (computer-generated, time-stamped), 11.50(a)(2); 211.188(b)(1) (dates) | EU: Annex 11 §12.4 (date and time), §14 (time and date of signature); Ch.4 4.20(b), 4.21(b) (dates and times) | ICH/EMA/draft: draft Annex 11 §12 and §13 (time zone where relevant) (draft)(s)
**Jurisdiction:** 211.188(b)(1) asks only for dates in the batch record. EU 4.20(b)/4.21(b) require dates and times, so the stricter EU rule applies. Time-zone display comes from the draft. The DI Q&A says nothing about clocks: NTP, UTC and the drift threshold are design choices.
**Test:** Change a terminal clock, then record a step. The stored time is unaffected. Run a DST-transition test. Simulate loss of the time reference. An alarm and an incident are raised.

### DI-28 Contemporaneous capture, immediate durable commit, late entries and offline buffering
**Covers:** n10, n66, n183, n221, n106, n92, n94
**Behaviour:**
- Each GMP entry is committed to durable, audit-trailed server storage the moment the user confirms it (auto-save per entry).
  - Executed GMP data has no editable client-side draft.
  - There is no end-of-shift bulk save.
- Limit evaluation (pass/fail, OOS warning) is shown only after the value is committed, so a value cannot be re-keyed before it is saved.
- Free-text or scratch fields can never be the source of a GMP field.
- A late entry (recorded after the event) goes only through an explicit late-entry path:
  - a mandatory reason;
  - both the claimed event time and the entry time are stored;
  - the entry is flagged for review.
- Back-dating a batch, packaging or logbook entry is impossible.
- Batch and packaging records identify who performed each significant step and who checked it, who performed each IPC, and dates and times. Attribution comes from DI-22 and DI-35.
- Logbook entries are chronological and attributed, and are filled in automatically from execution wherever possible.
- An SOP pairs these controls with the procedural duty to enter data at the time of the work.
- Offline/edge mode, if offered:
  - entries are signed and hashed locally at capture against a trusted clock;
  - they are immutable, uploaded in order and flagged "offline-captured";
  - they never overwrite server data; a conflict becomes an exception;
  - a status check that needs server data either uses a pre-cached value with a validity window or blocks the step.
**Type:** ENFORCED. Offline mode is a DESIGN-CHOICE; if enabled, its rules are ENFORCED.
**Citations:** US: 211.100(b), 211.160(a), 211.182 (chronological equipment log), 211.188; FDA DI Q&A Q12 | EU: Ch.4 4.8, 4.20(b),(c),(f), 4.21(b),(c), 4.31 | ICH/EMA/draft: EMA GMP DI Q&A on temporary memory and on OOS warnings before saving (s)
**Jurisdiction:**
- The final FDA Q&A says no storage method may allow data to be manipulated before a permanent record exists.
- The "temporary memory" and "warning before save" wording comes from the EMA Q&A, not from the FDA final text.
- Commit-before-evaluate satisfies both.
**Test:** Enter a value, then kill the browser. The value persists with its timestamp. Enter an out-of-limit value. The audit trail shows the value committed before any warning appeared. Submit a late entry without a reason. Blocked. Try to insert a back-dated logbook entry. Blocked.

### DI-29 Complete data: every attempt, repeat, aborted operation and invalidated result is retained; invalidation needs an investigation
**Covers:** n69, n651, n652, n41, n17
**Behaviour:**
- Every capture attempt on product is stored with who, when and reason, and is shown in review. This includes:
  - repeat weighings and re-reads;
  - failing or suspect IPC results;
  - aborted weighings, cancelled label prints and aborted equipment cycles;
  - restarted steps.
- There is no unrecorded trial, practice or check mode on product samples. Set-up and suitability checks use registered standards under their own IDs, never a product sample ID.
- Correcting an entry error (DI-24) is distinct from invalidating a genuine result.
  - Invalidation requires a link to a documented investigation (deviation or OOS-type) with a scientifically sound justification.
  - The invalidated data and the investigation report are part of the record the QU sees at disposition.
- A repeat-until-pass pattern is flagged. DESIGN-CHOICE default: any new attempt after a failing result is flagged.
- For IPCs, all individual values are stored (not just means), with:
  - the raw instrument output;
  - a link to the material and lot tested;
  - the method reference and version;
  - the sample quantity;
  - calculations with units and conversion factors.
- Where the SOP classes a shop-floor IPC as a laboratory test, second-person review of the original record is mandatory (211.194(a)(8)).
**Type:** ENFORCED. CONFIGURABLE for flag thresholds, stricter only.
**Citations:** US: 211.160(b), 211.188, 211.192, 211.194(a)(3)-(8); FDA DI Q&A Q2, Q12 (aborted/incomplete runs captured and justified), Q13 (all data including errors, failing, passing and suspect retained and reviewed) | EU: Ch.4 Principle (raw data), 4.20(f); Annex 11 §9 | ICH/EMA/draft: draft Ch.4 ALCOA++ "complete" (draft)(s)
**Jurisdiction:** FDA is explicit, through Q2 and Q13. The EU reaches the same result through its raw-data definition. No conflict. Applying Q12/Q13 to production IPCs is by analogy with the laboratory examples.
**Test:** Take three readings on one sample where the first two fail. All three are stored and flagged. Try to invalidate a value without an investigation link. Blocked. Abort a weighing. A reason is required and the attempt appears in review.

### DI-30 Manually entered critical data: additional accuracy check
**Covers:** n151, n175, n649
**Behaviour:**
- A manually entered value classed critical (DI-07) must pass an additional accuracy check before the step can complete. The check is one of:
  - an independent second person using their own authentication, who is not the performer;
  - a validated electronic means: barcode match against the expected item/lot, or device capture that replaces manual keying (the interface then falls under DI-31).
- The engine refuses to approve an MBR in which a critical manual field has no check method.
- Every manual field gets plausibility checks: type, range, format, unit, expected lot or material.
- A value transcribed by hand is marked "manual/transcribed" and always needs second-person verification. This covers interface bypass and back-entry from paper.
- Manual readings (plate counts, visual checks, gauge readings) are entered by the reader at the time of reading and verified by a different person. The record shows the reader, the verifier and both times.
- US-market floors (details in the production catalog):
  - every container of a dispensed component is checked by a second person (211.101(c));
  - each charge-in is added by one person and verified by a second (211.101(d));
  - each yield calculation is verified by a second person (211.103);
  - each significant step identifies the person performing it and the person directly supervising or checking it (211.188(b)(11)).
  - One-person checking is allowed only where the operation itself is performed by automated equipment under 211.68 and one person checks that the equipment did it correctly (211.68(c)).
**Type:** ENFORCED (floor). CONFIGURABLE for the check method per field (second person vs validated electronic check), within the floors.
**Citations:** US: 211.68(c), 211.101(c)-(d), 211.103, 211.188(b)(11), 211.194(a)(8); FDA DI Q&A Q10 | EU: Annex 11 §6 | ICH/EMA/draft: draft Annex 11 §10 handling of data (plausibility checks; prefer validated interfaces to manual transfer) (draft)(s)
**Jurisdiction:** EU §6 lets a validated electronic check replace the second operator for manual data. The US second-person rules for dispensing, charge-in and yield drop to one person only when the operation itself is performed by automated equipment. For US-market products, device capture on its own does not remove the second-person check at dispensing and charge-in unless QA documents that the operation qualifies under 211.68(c) (see open questions).
**Test:** Configure a critical manual field and try to complete the step without verification. Blocked. The same user tries to verify. Refused. Take the interface down. The manual value is flagged "manual" and needs verification.

### DI-31 Interface data integrity
**Covers:** n155, n8, n88
**Behaviour:**
- Each interface checks what it receives. In scope: ERP/WMS, LIMS, balances, PLC/SCADA/historian, EMS, label printers, vision/serialisation, QMS. The checks are:
  - schema and completeness validation;
  - identity matching (material, lot, batch, equipment);
  - unit and range checks;
  - duplicate and sequence detection;
  - acknowledgment and retry;
  - reconciliation by counts or checksums.
- Check depth is set by the interface's complexity and reliability.
- A failed or rejected transfer raises an alarm. It never silently drops a value or substitutes a default. A partial transfer is never committed.
- Each received value keeps its provenance: source system, source record ID, source timestamp, raw value and unit.
- An interface-captured value can be overwritten only by an audit-trailed correction with a reason. A manual override appears in the exception report (DI-26).
- Transport is authenticated and encrypted (DI-13).
**Type:** ENFORCED (no silent loss or defaulting; provenance; alarms). CONFIGURABLE for check depth per interface risk. Idempotency keys and checksums on every interface are a DESIGN-CHOICE: 211.68(b) scales checking to complexity and reliability.
**Citations:** US: 211.68(b) (input/output checked for accuracy; degree and frequency by complexity and reliability) | EU: Annex 11 §5 | ICH/EMA/draft: draft Annex 11 §10 data transfer (draft)(s)
**Jurisdiction:** Consistent across markets. Annex 11 §5 adds "secure", which leads to the transport security.
**Test:** Inject malformed, duplicate, out-of-order and wrong-batch messages. Each is rejected or de-duplicated, with an alarm. Cut the link mid-transfer. No partial value lands in the record.

### DI-32 Instrument and device data; original records from simple devices; dynamic data
**Covers:** n7, n648, n67, n41, n17
**Behaviour:**
- Where a device can transmit, capture its data directly: value, raw device output, device ID, unit and device timestamp. The raw output is stored and must match the displayed value. The electronic capture is then the original record.
- Manual keying is allowed only in a documented fallback mode, flagged and verified (DI-30).
- Where a balance or pH-meter printout is the original (no electronic capture), the printout or a verified true copy is retained and linked by reference to the eBMR entry. Thermal slips are true-copied promptly before they fade (DI-41).
- Dynamic device data are kept in native form with a viewer: trends, cycle data, spectra, chromatograms, PAT outputs. A static rendering alone never replaces them.
**Type:** ENFORCED (an original is defined per data source; dynamic data kept native). CONFIGURABLE for direct capture per step: default ON wherever a validated device interface exists.
**Citations:** US: 211.68(a)-(b), 211.180(d), 211.194(a)(4); FDA DI Q&A Q1d, Q9, Q10 | EU: Ch.4 Principle (raw data), 4.20 Note; Annex 11 §5 | ICH/EMA/draft: none
**Jurisdiction:** FDA Q10 is the only text that explicitly says a simple device's printout can be the original and that a printout of dynamic data is not enough. It is adopted for all markets.
**Test:** A weighing with direct capture stores a raw string that matches the display. A weighing with a printed ticket shows the ticket linked. Trend data from a restored archive can be re-rendered interactively.

### DI-33 Calculations and reprocessing
**Covers:** n641, n653, n108
**Behaviour:**
- GMP calculations run only in validated, version-controlled engine logic. Examples: yield, reconciliation %, potency-adjusted quantities, means/RSD, unit conversions.
  - The logic is a sandboxed expression language with a closed function library, and GMP masters have no custom-script escape hatch (design).
  - Each result stores its inputs, formula version, units and conversion factors, and the result.
- Automated yield calculations are independently verified by one person. Manual calculations are done by one person and verified by a second (211.103).
- Recalculation or reprocessing is allowed only in SOP-defined cases (e.g., after an input correction, or re-evaluated PAT data). Every result version is kept with its inputs, parameters, user, time and justification, and reviewers see the full history.
- A spreadsheet used for a GMP calculation must be a controlled template version, stored in native form with its formulas intact (a dynamic record). It is never the unlogged source of a GMP result.
**Type:** ENFORCED. The sandboxed expression language is an engine-enforced DESIGN-CHOICE.
**Citations:** US: 211.68(b), 211.103, 211.188(b)(7), 211.194(a)(5); FDA DI Q&A Q1d, Q3, Q6, Q14 | EU: Annex 11 §4.7 | ICH/EMA/draft: draft Ch.4 draft-4.12 (derived data reconstructable from raw data) (draft)(s)
**Jurisdiction:** US text is explicit about verifying yield. The EU reaches the same result through validation. Applying Q14 to production calculations is by analogy with laboratory reprocessing.
**Test:** The yield step shows inputs, formula version, result and a verification signature. Correct an input and recalculate. Both results are kept, with their reasons.

### DI-34 Operational sequencing checks
**Covers:** n49
**Behaviour:**
- An execution state machine enforces:
  - MBR step order and declared parallel branches;
  - prerequisites: line clearance, equipment and material status, IPC due, timers, QA gates;
  - guarded batch lifecycle transitions: Issued, In Execution, Production Complete, Under Review, Released/Rejected, with Hold and Cancelled.
- Out-of-sequence execution is possible only through a deviation path approved in the system. It is recorded and appears in review (design).
**Type:** ENFORCED wherever the MBR declares sequence (the rule applies sequencing "as appropriate").
**Citations:** US: 11.10(f); 211.100(b) | EU: Ch.4 4.20(h) (signed authorisation for departures); Annex 11 Principle (no loss of process control) | ICH/EMA/draft: none
**Jurisdiction:** Only the US has an explicit sequencing-check rule, and it is adopted for all markets.
**Test:** Try step N+1 before step N. Blocked. Try disposition before review is complete. Blocked.

### DI-35 Electronic-signature catalogue: every predicate-rule signature point
**Covers:** n614, n145, n36, n68, n113, n182
**Behaviour:**
- A vendor-defined catalogue of signature types covers every point where a rule asks for a signature, initials, a check or an approval:
  - MPCR/MBR prepared, independently checked, QU-approved;
  - batch record issued (accurate reproduction checked);
  - step performed; step checked or directly supervised;
  - component container checked at dispensing; charge-in verified;
  - yield verified;
  - IPC performed and verified;
  - deviation authorised; correction;
  - labeling specimen approved;
  - logbook entry performed and double-checked;
  - production and packaging record approved;
  - audit trail reviewed;
  - QU review and disposition;
  - QP certification (if used);
  - true copy verified;
  - void or reprint authorised.
- Each type defines:
  - the permitted roles and the meaning text;
  - the independence rule (which earlier signers on the same object it must differ from);
  - the re-authentication rule (DI-38).
- Every type is a full Part 11 / Annex 11 e-signature, never a click-acknowledgment.
- A handwritten (stylus) signature on an electronic record, if offered, is still a handwritten signature: it must show the 11.50 elements and be linked under 11.70.
- The company signature policy (who may sign which meaning) is configured in the system.
- E-signing is the default everywhere. There is no print-to-sign path.
- Customers may add signature points but cannot remove the minimum set.
**Type:** ENFORCED.
**Citations:** US: 11.1(c)-(d), 11.2(a), 11.3(b)(7)-(8); 211.101(c)-(d), 211.103, 211.182, 211.186(a), 211.188(a),(b)(11), 211.194(a)(7)-(8); FDA DI Q&A Q11 (e-signature satisfies "full signature, handwritten"; document signer-identification controls) | EU: Ch.4 4.3, 4.9, 4.13, 4.20(c),(f),(h),(i), 4.21(c),(g),(i), 4.31; Annex 11 §14 | ICH/EMA/draft: draft Ch.4 signatures and signature policy (draft)(s); draft Ch.4 hybrid systems and recognition of e-signatures (draft)(s)
**Jurisdiction:** US signature points are more numerous (second-person rules). EU adds approval of the completed processing and packaging records by the responsible person. The catalogue is the union.
**Test:** An inventory maps every predicate signature point to a catalogue type. Try to complete a cleaning-log entry with a plain acknowledgment. Impossible.

### DI-36 Signature manifestation
**Covers:** n54, n162, n171
**Behaviour:**
- Every human-readable form of a signed record shows, for each signature:
  - the printed full name as it was at signing;
  - user ID and role;
  - date and time with time zone / UTC offset;
  - the meaning.
- The human-readable forms are screen, print, PDF and export.
- The manifestation is stored immutably with the signature when it is applied, not re-derived later from the user table. It is controlled like the record itself.
**Type:** ENFORCED.
**Citations:** US: 11.50(a)-(b) | EU: Annex 11 §14(c) (time and date) | ICH/EMA/draft: draft Annex 11 §13 (name, role, meaning, date/time with time zone where applicable) (draft)(s); draft Ch.4 signatures (draft)(s)
**Jurisdiction:** The printed name and meaning are US requirements (11.50). EU 2011 requires only date and time. The draft adds role and time zone. All are adopted.
**Test:** Sign a step, then view it on screen, in the PDF and in the export. All elements appear. Rename the user. Historic signatures keep the original name.

### DI-37 Signature-record linking and invalidation on change
**Covers:** n55, n162, n171
**Behaviour:**
- A signature record binds the signer ID, the manifestation, the meaning, the timestamp and a cryptographic hash of the exact content version it signs.
- No UI or API path can cut, copy or transfer a signature to another record. An integrity job detects any DB-level transplant.
- A permitted change to signed content automatically:
  - marks the signature "superseded by change";
  - shows the element as unsigned;
  - requires re-signing by the relevant signer(s).
  The history stays in the audit trail.
- Wet-ink signing on printouts is avoided. If it cannot be avoided, the scanned signed page is indexed to the record ID and version hash under an SOP. A wet-ink signature never substitutes for an e-signature the MBR requires.
**Type:** ENFORCED (linking). DESIGN-CHOICE, engine-enforced: invalidation on change goes beyond the 11.70 "ordinary means" standard and follows the draft's hybrid-signature expectation.
**Citations:** US: 11.70; 11.10(e) | EU: Annex 11 §14(b) (permanently linked) | ICH/EMA/draft: draft Annex 11 §13 (hybrid: later change must invalidate the signature) (draft)(s)
**Jurisdiction:** 11.70 targets falsification by ordinary means. Annex 11 §14 asks for permanent linkage. Automatic supersession after a change goes further than both and matches the draft.
**Test:** Correct a signed value. The signature shows as superseded and re-signing is required. Copy a signature row to another record in a test DB. The integrity check fails.

### DI-38 Signature components, re-authentication and session rules
**Covers:** n57, n47, n171, n226
**Behaviour:**
- Non-biometric signatures use two distinct components: ID plus password/PIN, or badge plus PIN.
- **Default:** every signing requires all components.
- **Allowed relaxation** (CONFIGURABLE, QA-approved): within one continuous controlled session, routine signings other than disposition, certification or MBR approval may use only the private component (password/PIN). A signing is never completed with zero components.
- The continuous session ends at lock, inactivity timeout, logout or a terminal switch. The next signing then uses all components.
- Shop-floor terminals lock after inactivity. DESIGN-CHOICE default: 5 min; allowed 1-15 min.
- A verifier signs with their own full credentials in the same dialog. The performer's session can never supply the verifier's signature.
- The signing dialog states the meaning explicitly and shows what is being signed.
- Biometric signatures must be usable only by their owner, with evidence of liveness/anti-spoofing.
- MFA at signing can be switched on (optional, stricter).
- There is no remember-password and no pre-signing.
**Type:** CONFIGURABLE (default = strictest practical). Floors are ENFORCED.
**Citations:** US: 11.200(a)(1)(i)-(ii), (a)(2)-(3), (b); 11.10(d) | EU: Annex 11 §12.1, §14 | ICH/EMA/draft: draft Annex 11 §13 (re-authentication at signing) (draft)(s); draft IAM/e-signature summary incl. reported MFA for signatures (draft)(u)
**Jurisdiction:** 11.200 allows a single private component for later signings within one continuous session. The EU draft expects re-authentication at each signing, and typing the password/PIN each time satisfies that. The default of all components every time meets both.
**Test:** Sign twice in one session. The second signing needs at least the password. After a timeout, both components are needed. Try to apply the verifier's signature through the performer's session. Refused.

### DI-39 QU disposition and QP certification by e-signature; quarantine interlock
**Covers:** n163, n170, n191, n2, n31
**Behaviour:**
- **US.** Batch disposition (Released/Rejected) is a QU-role e-signature with an explicit meaning.
  - No other role, administrators included, can set a released status.
  - The QU is shown the complete record: invalidated data with their investigation reports (DI-29), deviations, exceptions and the audit-trail review (DI-25).
  - The release record lists the criteria evaluated. The criteria themselves are in the production catalog.
- **EU.** If the system records certification/release (QP-certification feature ON), only accounts registered as a QP named on the authorisation can certify, by e-signature, and the certifier's identity is recorded.
  - This stays in force even though the July 2025 draft reportedly drops the stand-alone clause.
  - The QP screen links to the full audit trail and its review record.
- **Quarantine interlock.**
  - An uncertified or unreleased batch cannot be allocated or shipped in the integrated ERP/WMS.
  - Status is carried across inter-site transfers.
  - Notice of certification to the site that moves stock to saleable status is a structured, signed, audit-trailed message with acknowledgment, as defined in the technical agreement.
  - Any electronic safeguard used as the quarantine control is validated (DI-03).
- A release approval sent by email or chat is not the record (DI-40).
**Type:** ENFORCED. The QP-certification feature is CONFIGURABLE ON/OFF per tenant; when ON its rules are ENFORCED. An Indian exporter's own system usually records QU disposition only.
**Citations:** US: 211.22(a), 211.165(a), 211.192; FDA DI Q&A Q2 | EU: Annex 11 §15; Annex 16 sec. 4 (s) | ICH/EMA/draft: draft Annex 11 (removal of 2011 clause 15; QP access to audit trail) (draft)(s)
**Jurisdiction:** US: QU approval before release or distribution. EU: QP certification (Annex 16), which is recorded by QP-only e-signature only if the system is used for it. 2011 §15 stays binding until a final revision replaces it.
**Test:** A QA reviewer, a supervisor and an admin each try to certify. All fail. The QP certifies, and the record shows name, date/time and meaning. ERP stock status changes only after certification.

### DI-40 Copies for inspection, printouts that flag changes, GMP communications
**Covers:** n45, n70, n656, n154, n32
**Behaviour:**
- One action produces an accurate and complete copy of any batch record in two forms:
  - **Human-readable** (PDF/A): all values, corrections showing both the original and the new value, exceptions, deviations, attachments, signature manifestations and the audit trail.
  - **Electronic**: structured JSON/XML/CSV with metadata, native attachments, and dynamic data with a viewer.
- Report configuration cannot trim a copy below this minimum.
- A printout of a record supporting batch release flags every value changed since original entry: old value, new value, who, when and why, or a reference to the audit-trail entry. Unchanged values are not flagged.
- Every printout or export carries:
  - a "copy" mark with print time, user and record status;
  - the record ID and "page x of y" (good practice).
- Every export is itself logged.
- Records can be retrieved at once from every site where the activity happened (central hosting is acceptable if retrieval is immediate).
- Read-only, audited, time-limited viewing access can be granted for inspections (design option).
- GMP decisions are made in the system by e-signature: release, deviations, holds. Comments and messages linked to a batch are kept with an audit trail. An approval that arrives by email is attached and kept with the batch record, and all of these appear in inspection copies.
**Type:** ENFORCED.
**Citations:** US: 11.10(b), 11.10(e) (audit trail available for review and copying); 211.180(c); FDA DI Q&A Q17 and footnote 14 | EU: Annex 11 §8.1, §8.2; Ch.4 4.27 (all records available to the QP) | ICH/EMA/draft: none
**Jurisdiction:** Only the EU (§8.2) explicitly requires printouts that indicate changed data. The US (11.10(b)) requires copies in both human-readable and electronic form. The union applies.
**Test:** Export a batch and compare it field by field with the database. Correct a value, then print. The release printout flags the change and shows the original. A records package for 5 batches includes their audit trails.

### DI-41 True copies (paper to electronic, electronic to electronic)
**Covers:** n67, n114, n647
**Behaviour:**
- The true-copy function keeps the content and meaning of the original: all metadata needed to reconstruct the activity, and the original's static or dynamic nature.
- Each true copy carries the source ID, a checksum and capture metadata.
- A verifier e-signature confirms that the copy is complete and legible.
- A true copy of a dynamic record is kept in the original format or in one that preserves content and meaning, and a suitable reader stays available for the whole retention period.
- Fading or short-lived media are true-copied promptly: thermal balance, pH or checkweigher slips, and chart-recorder output (e.g., autoclave or lyophiliser charts in the Injectables edition).
- Paper originals are kept unless QA approves destruction under an SOP after a verified true copy exists (see open questions).
**Type:** ENFORCED (preservation of content, meaning and metadata). DESIGN-CHOICE, engine-enforced: the verifier signature is not described in the FDA Q&A; it follows the EU draft's documented-verification expectation, which does not conflict.
**Citations:** US: 211.180(d), 211.68(b); FDA DI Q&A Q1e, Q9, Q10 | EU: Ch.4 4.1 (official copies), 4.10 | ICH/EMA/draft: draft Ch.4 retention/copies and glossary (true/verified copy) (draft)(s)
**Jurisdiction:** FDA says "true copy". "Certified" or "verified copy" is EU/PIC/S terminology. The requirements match, and the EU draft adds documented verification.
**Test:** Scan a thermal printout. The copy carries a checksum, a verifier signature and a link to its step. Alter the file. The checksum check fails.

### DI-42 Controlled issuance of electronic record instances and templates
**Covers:** n38, n64
**Behaviour:**
- Issuing records:
  - Batch record instances, logbooks and ad-hoc GMP forms are issued only from Effective, approved template versions.
  - Each issued instance stores the master version ID and hash, and is an exact instantiation of it plus the batch header.
  - Instances are uniquely numbered, and a later master edit never changes an issued instance.
- Reconciliation of issuance (issued, in execution, completed, voided) shows no gaps.
- Voided or re-issued instances are kept and retrievable, each with a written reason and a signer.
- A spreadsheet or electronic worksheet used to create CGMP data is a controlled form. An uncontrolled attachment is allowed only as labelled supporting information, never as the source of a GMP result.
**Type:** ENFORCED. CONFIGURABLE for QA approval of each void: default ON. Q6 asks for a written justification under QU or other document control, not QA sign-off on every void.
**Citations:** US: 211.100(a), 211.186, 211.188(a); FDA DI Q&A Q3, Q6 | EU: Ch.4 4.1 (controls for electronic templates, forms, masters), 4.2 (reproduction without error), 4.3 | ICH/EMA/draft: EMA GMP DI Q&A on template control (s)
**Jurisdiction:** No conflict.
**Test:** Change the MBR after issuing a batch. The issued instance is unchanged and its hash still matches its source version. Void an instance. It stays retrievable with its reason. The reconciliation report has no gaps.

### DI-43 Paper in the loop: hybrid steps, contingency (downtime) forms and business continuity
**Covers:** n164, n650, n185, n222, n112, n182, n96
**Behaviour:**
- **Hybrid points.**
  - Each hybrid point is declared in the register (DI-01) with its official record. Examples: supplier CoA, device printouts, chart recorders, downtime forms.
  - No GMP step may have a required signature that exists only on paper.
- **Paper forms.**
  - A paper form can be printed only through controlled issuance. Each page carries a unique serial number, batch ID, MBR and template version, "page x of y" and issue time. Issuer, quantity and destination are logged.
  - User roles cannot print a template outside this control.
  - A reprint needs a reason and QA approval, is marked as a reprint and is linked to the original serial number.
- **Reconciliation.** A batch cannot close until every issued form is reconciled as returned/used or voided with a reason. A form reported missing raises a deviation automatically.
- **Business continuity.**
  - The downtime procedure is documented and tested.
  - Contingency forms are pre-issued, generated from the current master. Entries are made on them at the time of the work.
  - After recovery, the data is back-entered and flagged "transcribed from paper". Each back-entered value gets second-person verification (DI-30), and both the original execution time and the entry time are kept.
  - The paper originals are true-copied (DI-41) and kept, and the contingency period is reviewed. There are no ad-hoc notes.
- **Fallback timing.** How quickly the fallback must be available is set by risk.
  - Injectables: aseptic filling needs an immediate, pre-staged fallback.
  - Tablets: may pause at defined hold points.
**Type:** ENFORCED for issuance, reconciliation and back-entry. CONFIGURABLE for drill frequency and fallback time: DESIGN-CHOICE default is an annual downtime drill per site. §16 requires the arrangements to be documented and tested, not "validated".
**Citations:** US: 211.100(b), 211.180(d), 211.186, 211.188(a); FDA DI Q&A Q6, Q12 (no scrap-paper transcription) | EU: Ch.4 4.1 (hybrid relationships and controls stated); Annex 11 §6, §16 | ICH/EMA/draft: EMA GMP DI Q&A on blank/template forms (s); draft Ch.4 hybrid systems, reported as draft 4.82-4.85 (draft)(s); draft Ch.4 hybrid provisions (draft)(u)
**Jurisdiction:** Both markets allow controlled paper. The EU draft pushes firms to avoid hybrid signing wherever possible, and the kernel follows it.
**Test:** Issue 3 contingency sheets and return 2. Batch closure is blocked and a deviation is raised. In a downtime drill, back-entered values are flagged, verified and linked to scans, with both timestamps.

### DI-44 Protection and integrity checking of stored data
**Covers:** n46, n152, n44
**Behaviour:**
- Finalised records sit on protected, redundant storage, and completed records are immutable (design: WORM/object lock).
- A scheduled integrity check runs over hashes and DB consistency.
- A scheduled readability check opens and renders sampled old records, including their audit trails and signatures.
- Results are recorded, and any failure opens an incident (DI-12).
- Access to the data is maintained for the whole retention period, including across upgrades.
**Type:** ENFORCED (the checks exist and alarm). CONFIGURABLE for frequency: DESIGN-CHOICE default is quarterly for readability sampling and weekly for integrity jobs. Neither rule sets a frequency.
**Citations:** US: 11.10(a), 11.10(c); 211.68(b) | EU: Annex 11 §7.1 | ICH/EMA/draft: none
**Jurisdiction:** EU §7.1 explicitly requires stored data to be checked for accessibility, readability and accuracy. It is adopted for all markets.
**Test:** The periodic readability report lists the sampled records, each opened with its audit trail. Deliberately corrupt a record in a test environment. The check detects it.

### DI-45 Backup and restore
**Covers:** n153, n177, n8, n60, n88
**Behaviour:**
- Regular automated backups cover all relevant data as one consistent set:
  - database and attachments;
  - configuration (MBRs, roles);
  - audit trails and signature records;
  - system logs.
- There are two tiers:
  - (1) **Retention-grade backup.** A true copy, including metadata, in the original or a compatible format, secured against alteration, erasure and loss, and kept for the full retention period. This is FDA's meaning of the 211.68(b) backup, which FDA equates with an archive.
  - (2) **Operational/DR snapshots.** These never count toward (1). A replica that mirrors deletions or corruption does not qualify.
- Backups are kept physically and logically apart from primary data (separate site, account and credentials) and are encrypted. Immutable storage is preferred: production administrators cannot delete backups.
- Each backup job's success or failure is logged, and a failure raises an alarm.
- Restores are tested during validation and then periodically. A restore test compares record counts and hashes and opens sample records with their audit trails, and its results are recorded.
- RPO and RTO are set by risk; the Injectables execution module has the tightest.
**Type:** ENFORCED (both tiers, separation, alarms, periodic restore testing). CONFIGURABLE for frequencies: DESIGN-CHOICE default is a quarterly restore test.
**Citations:** US: 211.68(b); FDA DI Q&A Q1e (backup is a true copy kept for the retention period; temporary crash copies do not satisfy 211.68(b)) | EU: Annex 11 §7.2 | ICH/EMA/draft: draft Annex 11 §16 backup (physically and logically separate; restore tested regularly) (draft)(s)
**Jurisdiction:** For the US, the backup must last the full retention period. EU §7.2 requires the integrity and restorability of backups to be checked during validation and monitored periodically. The draft adds separation. All are adopted.
**Test:** Restore into an isolated environment and hash-compare records, audit trails and signatures with production. Make a backup job fail. An alarm is raised. Try to delete a backup with production-admin credentials. Refused.

### DI-46 Archiving
**Covers:** n165, n647, n177
**Behaviour:**
- Completed batch records are archived to read-only storage with the full audit trail, signatures, attachments and metadata. "Completed" includes released, rejected and never-released batches.
- Fixity is checked periodically.
- Retrieval and re-rendering are tested before and after any relevant system change (hardware, software upgrade, format change). Upgrade validation includes retrieving archived records created under earlier versions.
- For dynamic data, a validated viewer is kept for the full retention period, or the data is migrated (DI-48) to a format that preserves content and meaning.
- Retiring the system requires a documented migration plan or a read-only retention plan.
**Type:** ENFORCED. §17 sets no fixity frequency; the default follows DI-44.
**Citations:** US: 11.10(c); 211.68(b), 211.180(d); FDA DI Q&A Q1e, Q9 | EU: Annex 11 §17 | ICH/EMA/draft: draft Annex 11 §17 archiving (draft)(s)
**Jurisdiction:** Consistent across markets.
**Test:** Archive a batch and run a fixity check. Upgrade the test environment, then retrieve and render the record. Content, audit trail and signatures are intact and the hashes match.

### DI-47 Retention periods, holds and controlled disposal
**Covers:** n32, n104, n152, n658, n181
**Behaviour:**
- The retention engine computes each record's retention end from genealogy. The floor is the maximum over every rule that applies to the product's markets, plus the India catalog value:
  - **US batch records:** at least 1 year after batch expiry. OTC products exempt from expiry dating: 3 years after distribution of the batch.
  - **US component, container, closure and labeling records:** at least 1 year after expiry (read as the expiry of the last lot that used them). Exempt OTC: 3 years after distribution of that last lot.
  - **EU batch documentation:** 1 year after expiry or at least 5 years after QP certification, whichever is longer. IMPs: at least 5 years after the last clinical trial using the batch is completed or formally discontinued.
  - **EU critical documentation supporting the marketing authorisation** (e.g., validation and stability raw data): kept while the authorisation is in force. Process-validation raw data: at least as long as the records of every batch released on the strength of that validation.
  - **Audit trails and signature records:** at least as long as their subject record.
  - **Shared and master objects:** extended to the latest retention end of any record that depends on them. This covers MBR and formula versions, validation-linked configuration, component lot records, logbooks, the signature register and training evidence.
- If the QP certification date of an exported batch is unknown, its retention end stays open (no disposal) until the date is received.
- Tenants may lengthen retention, never shorten it.
- Legal holds and DI-investigation holds (DI-50) override disposal.
- After retention ends, disposal happens only through a QA-approved workflow that writes a disposal record: what, when and who approved. No user or configuration can delete a record during retention.
**Type:** ENFORCED (floors). CONFIGURABLE for longer periods.
**Citations:** US: 211.180(a)-(b); 11.10(c), 11.10(e); FDA DI Q&A Q1a (life cycle through disposition), Background | EU: Ch.4 4.10, 4.11, 4.12; Annex 11 §7.1 | ICH/EMA/draft: draft Ch.4 data lifecycle with controlled destruction (draft)(s)
**Jurisdiction:** The EU is usually stricter for EU-certified batches because of the "5 years after certification" limb. Example: a 24-month shelf life certified 2 months after manufacture gives US = manufacture + 36 months, EU = manufacture + 62 months, so the EU period wins. The US is the only source of the component-record and OTC rules. The kernel takes the maximum.
**Test:** Try to delete a batch record before its retention end. Blocked. A component lot used in two batches with different expiries follows the later one. An EU batch whose certification date has not been received shows retention "open".

### DI-48 Data migration
**Covers:** n150, n175, n647
**Behaviour:**
- Any move of data to another format or system is a validated migration. This includes schema upgrades, archive exports, legacy imports, platform changes and tenant exit.
- The migration verifies that neither values nor meaning change. It checks:
  - record counts and per-record checksums;
  - field-level values, units and precision;
  - timestamps and time zones;
  - the audit trail;
  - signature manifestations and signature-record linkage.
- The migration report is approved before go-live.
**Type:** ENFORCED (the checks). Automating them is a DESIGN-CHOICE: §4.8 requires the checks, not automation.
**Citations:** US: 11.10(a), 11.10(c); 211.68(b), 211.180(d); FDA DI Q&A Q9 | EU: Annex 11 §4.8, §14(b) (linkage survives) | ICH/EMA/draft: draft Annex 11 §10 data migration (draft)(s)
**Jurisdiction:** Only the EU (§4.8) has an explicit migration rule. The US reaches the same result through 11.10(c) and the true-copy rules.
**Test:** In a migration dry run, counts and hashes match, and spot-checked audit trails, e-signature meaning and date-time, and units are unchanged.

### DI-49 Alarms and equipment events in the batch context
**Covers:** n174
**Behaviour:**
- GMP-relevant alarms that occur during a batch appear in the batch record. They may come from the eBMR itself or from connected SCADA/EMS. Each shows:
  - the time raised and the time acknowledged;
  - who acknowledged it;
  - the comment and action taken;
  - a deviation link where one is required.
- Acknowledging a GMP-critical alarm requires a comment.
- The alarm log cannot be erased or deactivated.
- Alarm limits are controlled configuration (DI-09).
- Each batch has an alarm log that is part of review (DI-26), and alarms are trended across batches.
- Injectables: aseptic-area alarms (differential pressure, particles, glove breach, filter-integrity failure) are visible to reviewers and the QP.
- Tablets: examples are compression-force excursions and checkweigher reject bursts.
**Type:** CONFIGURABLE for the integration scope, which depends on the connected systems. Where alarms are integrated, the rules above are ENFORCED. The kernel is designed to the draft (no conflict).
**Citations:** US: 211.68(a); FDA DI Q&A Q8 footnote 13 (alert records reviewed on a risk basis) | EU: Ch.4 4.20(e),(h) (relevant events, special problems) | ICH/EMA/draft: draft Annex 11 §8 alarms (draft)(s)
**Jurisdiction:** The 2011 texts have no alarm clause. The draft adds one, and the kernel adopts it.
**Test:** Simulate an excursion. It appears with raise and acknowledgment times, acknowledger identity and comment. Try to acknowledge without a comment. Refused. Try to delete the alarm log. Impossible.

### DI-50 Data-integrity investigations, remediation and scoping support
**Covers:** n654, n657
**Behaviour:**
- A DI concern can be raised as an investigation linked to users, time windows and batches.
  - Linked records and audit trails go on hold until the investigation closes: no archive purge and no disposal.
- Scoping reports list, per user and per period, all records created or changed, across batches and sites.
- A user's GMP rights can be revoked immediately across all sites.
- Tighter controls (e.g., added verifications) can be rolled out as CAPA through configuration under change control.
- The documented DI risk assessment of eBMR workflows is reviewed periodically.
- Tips and suspected falsification go into the QMS investigation route and are never handled informally.
**Type:** ENFORCED for holds, scoping reports and immediate revocation. The tooling scope is a DESIGN-CHOICE.
**Citations:** US: 211.22(a), 211.192; FDA DI Q&A Q15, Q18, Introduction | EU: Annex 11 §13 | ICH/EMA/draft: none
**Jurisdiction:** FDA is explicit (Q15, Q18). The EU covers it through incident management and CAPA.
**Test:** Open a DI investigation for a user and date range. The system lists every record that user created or changed. The linked batches cannot be disposed of until the investigation closes.

---
## (a) ALCOA+ principles mapped to controls, and which document defines each term

**What each source actually does (row basis: n60, n110, n227 and the ALCOA verification notes):**
- **FDA DI Q&A (Dec 2018), Q1a.**
  - It defines *data integrity* as the completeness, consistency and accuracy of data.
  - It then *lists* the ALCOA traits (attributable, legible, contemporaneously recorded, original or a true copy, accurate) without defining any of them.
  - Footnote 5 ties each letter to Part 211: attributable to 211.101(d), 211.122, 211.186, 211.188(b)(11); legible to 211.180(e); contemporaneous to 211.100(b), 211.160(a); original/true copy to 211.180, 211.194(a); accurate to 211.22(a), 211.68, 211.188.
  - FDA does not use "enduring", "available" or "traceable" as ALCOA terms. It uses "traceable" only for the data-metadata relationship (Q1b). "Complete" and "consistent" appear in its data-integrity definition, not as ALCOA letters. (Primary.)
- **EU GMP Ch.4 (2011, binding).** It uses none of the ALCOA labels, but its text carries the ideas (primary):
  - controls for the accuracy, integrity, availability and legibility of documents (Principle);
  - handwritten entries clear, legible and indelible (4.7);
  - records made when each action is taken, with significant activities traceable (4.8);
  - alterations signed and dated, with the original still readable (4.9);
  - record integrity kept for the whole retention period (4.10).
- **EU Annex 11 (2011, binding).** Stored data checked for accessibility, readability and accuracy (§7.1). Identity and date-time recorded for entering, changing, confirming or deleting data (§12.4). (Primary.)
- **EU Ch.4 July 2025 draft.** Defines ALCOA++ as ten attributes: attributable, legible, contemporaneous, original, accurate, complete, consistent, enduring, available, traceable. "Traceable" is its addition to ALCOA+. The definition wording was confirmed only through secondary excerpts and could not be checked against a local official text (draft)(s)/(u).
- **EMA GMP DI Q&A (2016)** uses ALCOA terminology (s). The EMA GCP computerised-systems guideline (2023) defines several "+" terms, but it is a GCP document and is cited only as evidence of EU usage (s). Neither is in the local files.

| Principle | Defined by | eBMR meaning used here (paraphrase) | Kernel controls |
|---|---|---|---|
| Attributable | Listed: FDA Q1a. Defined: EU Ch.4 draft (draft)(s). Binding hooks: 211.188(b)(11), Annex 11 §12.4 | Every value, change and confirmation is tied to one authenticated person (or registered device/interface) and a time | DI-14, DI-15, DI-17, DI-20, DI-22, DI-35, DI-36, DI-37, DI-38 |
| Legible | Listed: FDA Q1a. Defined: EU Ch.4 draft (draft)(s). Binding hooks: Ch.4 Principle, 4.7, 4.9; 211.180(e) | Readable in plain language for the whole retention period; corrections never hide the original | DI-22, DI-24, DI-36, DI-40, DI-41, DI-44 |
| Contemporaneous | Listed: FDA Q1a ("contemporaneously recorded"). Defined: EU Ch.4 draft (draft)(s). Binding hooks: 211.100(b), 211.160(a); Ch.4 4.8 | Recorded and durably committed when the activity happens, on trusted server time; late entries explicit and flagged | DI-27, DI-28 |
| Original (or true copy) | Listed: FDA Q1a ("original or a true copy"). Defined: EU Ch.4 draft (draft)(s). Binding hooks: 211.180(d), 211.194(a); Ch.4 Principle (raw data) | First capture kept (including dynamic form and metadata), or a verified true copy keeping content and meaning | DI-01, DI-32, DI-41, DI-45 |
| Accurate | Listed: FDA Q1a. EU Ch.4 draft wording not verified (draft)(u). Binding hooks: 211.68(b), 211.188; Annex 11 §5, §6; Ch.4 Principle | Correct values from validated capture, interfaces and calculations; manual critical data double-checked | DI-03, DI-04, DI-30, DI-31, DI-33 |
| Complete | FDA data-integrity definition (Q1a), not an ALCOA letter; EU Ch.4 draft (draft)(u) | All attempts, repeats, aborted and invalidated data plus metadata and audit trail retained; no silent omissions | DI-02, DI-26, DI-29, DI-42, DI-43 |
| Consistent | FDA data-integrity definition (Q1a), not an ALCOA letter; EU Ch.4 draft (draft)(u) | Uniform units, formats and time order; sequence enforced; out-of-order entries stand out | DI-02, DI-10, DI-27, DI-34 |
| Enduring | EU Ch.4 draft only (draft)(u); not an FDA term. Binding hook: Ch.4 4.10, Annex 11 §7.1 | Survives intact on protected media through backups, archives and migrations | DI-44, DI-45, DI-46, DI-48 |
| Available | EU Ch.4 draft only (draft)(u); not an FDA term. Binding hooks: Ch.4 Principle; Annex 11 §7.1; 211.180(c) | Retrievable in readable form for review, QP/QU decisions and inspection throughout retention | DI-08, DI-40, DI-46, DI-47 |
| Traceable | EU Ch.4 draft (the "++" addition) (draft)(s); FDA uses the word only for data-metadata links (Q1b). Binding hook: Ch.4 4.8 | The whole history (creation, change, movement, location) can be reconstructed from identifiers and audit trail | DI-02, DI-10, DI-22 |

## (b) Revision notes: what is binding, what is draft, and how the kernel treats drafts

- **Binding today (checked against local texts).**
  - EU Annex 11 rev. 1 and EU Ch.4 rev., both in operation since 30 June 2011.
  - 21 CFR Part 11: eCFR as of 24 Sept 2026, including the 2 March 2023 amendment to 11.100(c)(1).
  - 21 CFR Part 211: eCFR as of 24 Sept 2026.
  - FDA DI Q&A: final guidance of December 2018 (non-binding, but checked as primary).
- **Pending.** The July 2025 consultation drafts of a revised Annex 11 and a revised Chapter 4 (EC/EMA with PIC/S) are not in force. Their final wording and effective dates were not known when this research was done. Their content here comes only from secondary summaries (a few items unverified). The draft section numbers used in this catalog (Annex 11 draft §6-§17; Ch.4 draft 4.12 and 4.82-4.85) are *reported* numbers.
- **Design rule applied.** Adopt the draft wherever it is stricter and conflicts with no binding text. Draft-derived elements adopted:
  - audit trail covers creation, is never disableable, and prompts for a reason (DI-22, DI-23);
  - administrators independent of GMP work (DI-18);
  - audit-trail review before release by an independent reviewer, with QP access (DI-25);
  - signature manifestation shows role and time zone (DI-36);
  - re-authentication at every signing (DI-38);
  - supersession of signatures after change and avoidance of hybrid signing (DI-37, DI-43);
  - IAM: least privilege, lockout, MFA for remote/privileged access (DI-16, DI-17, DI-19, DI-13);
  - encryption, patching, pen-testing and DR objectives (DI-13);
  - backups separated from primary data (DI-45);
  - expanded periodic review (DI-11);
  - supplier exit strategy and access to cloud validation documentation (DI-08, DI-03);
  - traceability matrix (DI-06);
  - alarms (DI-49);
  - ALCOA++, data lifecycle and verified true copies (DI-02, DI-41, DI-47).
- **Draft elements deliberately not followed.**
  - (1) The reported removal of the stand-alone QP e-signature clause: 2011 §15 stays binding, and removal would be less strict (DI-39).
  - (2) A reported allowance for justified audit-trail review after release: it conflicts with 211.22/211.192 as FDA reads them in Q8, so it is not offered (DI-25).
  - (3) MFA for every signature: unconfirmed, so it is offered as an option, not as the default (DI-38).
- **FDA side.**
  - The 2003 Part 11 Scope and Application guidance (s) grants enforcement discretion on validation, audit trails, retention and copying. The kernel does not rely on it (DI-01).
  - Earlier research carried some wording that is **not** in the final Dec 2018 Q&A and is therefore not treated as FDA text:
    - "review critical data audit trails with each record, on a schedule set by system complexity";
    - "temporary memory" (that is EMA wording);
    - a small-site fallback for administrator/QA overlap (n62, n65, n66 verification notes).
- **On finalisation of the drafts:** re-run a gap assessment clause by clause against DI-02, DI-08, DI-11, DI-13, DI-14 to DI-19, DI-22, DI-23, DI-25, DI-36 to DI-39, DI-41, DI-43, DI-45 to DI-47 and DI-49, and correct the reported section numbers.

## (c) Claims made in earlier research that are NOT actually required

The kernel still implements many of these as design choices. The point is that nobody should cite them as regulatory text.

1. **Numeric floors for passwords, lockout or session timeout.** Guardrail 25 speaks of "regulatory floors". Neither 11.300 nor Annex 11 §12 sets any number, and the draft reportedly requires lockout only qualitatively. Every number in DI-19 and DI-38 is a design default.
2. **Mandatory password aging.** 11.300(b) gives aging only as an example of periodic checking. A documented risk-based equivalent is acceptable (n58).
3. **"11.10(e) requires a reason for change."** It does not. The binding reason duty comes from Annex 11 §9 (all changes and deletions of GMP-relevant data) and Ch.4 4.9 ("where appropriate") (n48 scope note). The reason is still mandatory in the kernel.
4. **"Annex 11 (2011) makes an audit trail mandatory."** §9 says building one in should be *considered* on the basis of risk (n156, corrected). The audit trail is mandatory in the kernel because of 11.10(e) and because any risk assessment of an eBMR would conclude it is needed.
5. **"Annex 11 §14 requires printed name, meaning and re-authentication."** §14 requires equal effect to handwritten signatures inside the company, permanent linkage, and date and time. Printed name, meaning and signing components come from 11.50 and 11.200 (n145, n154, n162).
6. **Specific technologies.** Hash chains, cryptographic content hashes, WORM/object lock, encryption at rest, DB activity monitoring, idempotency keys and checksums on *every* interface are design choices serving 11.10(a), 11.10(e) and 211.68(b). No rule names them (n8, n44, n48, n55, n88).
7. **Clock rules.** NTP synchronisation, UTC storage and drift thresholds appear in no 2011 EU or FDA text, and the DI Q&A says nothing about clocks (n88). Only the draft adds time zone to audit and signature records (s).
8. **A ban on physical deletion.** 11.10(e) assumes deletions may happen and must be audit-trailed. The ban during retention is a stricter design choice (n48, n658).
9. **Automatic invalidation and re-signing of a signature after its content changes.** This goes beyond the 11.70 "ordinary means" standard. It is a design choice that matches the draft's hybrid-signature expectation (n55, n171).
10. **Electronic acknowledgment of the accountability policy before first signing.** 11.10(j) requires written policies, not a system acknowledgment (n52).
11. **Inspector accounts, retrieval SLAs, and FD&C 704(a)(4) / remote regulatory assessments.** None is in the DI Q&A. They are other-source or design items (n45, n70).
12. **Verifier signature on scanned true copies; conditions for destroying paper originals.** Neither is described in the FDA Q&A. Documented verification is an EU draft expectation (s) (n67, n114).
13. **QA approval of every void or reprint.** A firm choice. Q6 asks for a written justification under document control (n64, n222).
14. **An MBR simulation/dry-run mode.** Not an FDA expectation. Q3 asks for verification of each MPCR, by any sound method (n61).
15. **A small-site exception letting one person be both administrator and QA "per the DI Q&A".** The final Q&A contains no such fallback (n50, n62).
16. **"Audit-trail review of critical data only" or "frequency set by system complexity".** This is draft-era wording, not the final Q&A. The final text ties review frequency to the data's own review frequency or to a documented risk assessment (n65).
17. **"Temporary memory" as FDA text.** The phrase is EMA Q&A wording. The final FDA Q&A bans any storage that allows manipulation before a permanent record exists (n66).
18. **A "validated" downtime mode.** Annex 11 §16 requires the arrangements to be documented and tested (n164).
19. **Per-field criticality tagging.** A design means for evidencing risk management, not required by Annex 11 §1 (n148).
20. **Training-gated hard stops and qualification snapshots.** 211.25 and Annex 11 §2 require qualified staff, not system gating (n3, n655, n624).
21. **Automated migration reconciliation; a fixity-check frequency; backup alerts and RPO values.** §4.8, §17 and §7.2 require the checks, not automation or specific frequencies (n150, n153, n165).
22. **Binding every device to a location.** 11.10(h) applies device checks "as appropriate" (n51).
23. **"Executor cannot release".** Good practice supporting QU independence. It is not 211.22 text (n2, n50).
24. **Requester, approver and reason on every access change, and point-in-time role history.** Annex 11 §12.3 only requires that access changes be recorded (n159).
25. **System-generated periodic-review evidence.** §11 does not require the evidence to be system-generated (n158).
26. **MFA for every signature under the draft.** Unconfirmed (n226).
27. **Serial-number reconciliation as the Ch.4 4.21(h) "electronic control" equivalent.** An interpretation. Serialisation comes from other EU legislation (n95).
28. **QP certification recorded in every tenant.** Annex 11 §15 applies only *when* the system is used to record certification. An Indian exporter's own eBMR normally records QU disposition, and the EU importer's QP certifies elsewhere (n163).
29. **A 10+ year retention horizon and training-record retention under 211.180.** These come from policy or other rules, not 211.180 (n32).
30. **Scanned or vision images as the Ch.4 4.21(f) printed-material specimen.** The literal expectation is physical samples whenever possible. An image is an interpretation, so both are supported (n94).

## (d) Conflicts between rows and how they were resolved

1. **Scope of audit-trail review.**
   - Conflict: n111, n148, n172 and n202 imply that review can focus on GMP-critical entries; n65 (corrected) says every change in the batch record is in scope.
   - Evidence: FDA Q7 says the people who review a record review the audit trails of changes to that record's data. 211.192 requires QU review of *all* production and control records, and Q7 counts audit trails as part of them.
   - Resolution: every post-entry change is in scope; criticality only orders and highlights (DI-25).
2. **Timing of audit-trail review; deferral after release.**
   - Conflict: n172 (draft, s) reports that a justified later review is allowed; n156 (2011) says only "regularly"; n65 says after each significant step and before release.
   - Evidence: FDA Q8 applies the data's own review frequency to its audit trail, which means 211.188(b) at each significant step and 211.22 before release.
   - Resolution: no deferral option; the stricter US timing applies (DI-25).
3. **Audit trail mandatory vs risk-based.**
   - Conflict: n156 (§9 "consideration ... based on risk") vs n48 and n168.
   - Evidence: 11.10(e) uses mandatory wording for audit trails in closed systems.
   - Resolution: mandatory (DI-22).
4. **Is creation of data audited?**
   - Conflict: n156 (2011 EU: changes and deletions) vs n48 and n168.
   - Evidence: 11.10(e) covers operator entries that create, modify or delete records; the draft reportedly adds creation.
   - Resolution: creation is audited (DI-22).
5. **Reason for change.**
   - Conflict: Ch.4 4.9 says "where appropriate"; 11.10(e) is silent; n48 says always.
   - Evidence: Annex 11 §9 requires the reason for any change or deletion of GMP-relevant data to be documented.
   - Resolution: mandatory for every change or void of GMP data; not required at creation (DI-22, DI-24).
6. **Void approval.**
   - Conflict: n64's system text calls QA approval per void a firm choice, but n64's own test demands QA approval; n38 requires "an approver"; n222 requires QA approval for reprints.
   - Evidence: Q6 asks for written justification under QU or other document control.
   - Resolution: a reason and an attributable signature are ENFORCED; QA approval is CONFIGURABLE, default ON (DI-42, DI-43).
7. **Re-authentication at signing.**
   - Conflict: n57 (Part 11 minimum: private component only within a continuous session; recommends both components for critical signatures) vs n171 (draft: re-authenticate at each signing).
   - Resolution: all components at every signing by default. Relaxation is allowed only down to the private component within a continuous session, for routine signings, which still meets both texts (DI-38).
8. **MBR dry-run.**
   - Conflict: n61's test makes a dry-run verification record a precondition; n61's corrected text calls the dry-run mode a design choice.
   - Evidence: Q3 requires the workflow to be verified, not a specific method.
   - Resolution: a verification record is mandatory and the method is open (DI-04, DI-05).
9. **Administrator/GMP-user exception.**
   - Conflict: n50 cites an "approved exception with a second reviewer (per the DI Q&A)"; n62 says the final Q&A has no fallback; n173 (draft) says no admin rights for GMP workers.
   - Evidence: the Q4 text recommends administrator independence and has no exception clause.
   - Resolution: no product-level exception (DI-18). The staffing issue is an open question.
10. **Verification signature on true copies.**
    - Conflict: n67's test requires it; n67's corrected text says the Q&A does not describe it; n114 (draft) expects documented verification.
    - Resolution: design to the draft, since there is no conflict with FDA (DI-41).
11. **QP e-signature clause.** n170 (draft reportedly drops 2011 §15) vs n163 (binding §15). The binding text prevails; the clause is kept (DI-39).
12. **Physical deletion.** n48's system text bans it, while its scope note says 11.10(e) allows audited deletion; n658 allows purge after retention. Resolution: no deletion during retention; controlled, recorded disposal afterwards (DI-24, DI-47).
13. **Training gating.** n3: hard stop with no override. n655: blocked *or flagged* per SOP. n624: good practice. Resolution: CONFIGURABLE, default hard block (DI-21).
14. **Packaging reconciliation exemption.**
    - Conflict: n95 (EU Ch.4 4.21(h): reconciliation data may be omitted where robust electronic controls operate and the omission is justified) vs n23 (US: labeling reconciliation waived only for cut or roll labeling that gets 100% electronic examination under 211.122(g)(2), per 211.125(c)).
    - Resolution: for US-market products only the 211.125(c) waiver is available. The EU exemption applies only to EU-only products and never removes investigation of discrepancies. Routed to the packaging catalog; recorded here because the rows sit in this bucket.
15. **Retention period.** n32 and n647 give the US figure only (1 year after expiry); n152 gives the EU figure.
    - Evidence: Ch.4 4.11 says 1 year after expiry or at least 5 years after QP certification, whichever is longer; 211.180(a) says at least 1 year after expiry.
    - Resolution: the maximum across the product's markets (DI-47).
16. **Attribution of "temporary memory".**
    - Conflict: n66 (FDA row; verification note says the phrase is not in the final Q&A) vs n183 and n221 (EMA Q&A).
    - Resolution: attributed to EMA. The control (commit before evaluation) satisfies both texts (DI-28).
17. **Blocking capture on clock drift.**
    - Conflict: n88's test says capture stops on edge devices past the drift threshold; n88's correction warns that blocking without a fallback pushes staff to scrap paper, which Q12 rejects.
    - Resolution: server timestamps, an alarm and an incident, and the controlled contingency path of DI-43 (DI-27).
18. **Review by exception.**
    - Conflict: n184 and n201 (EMA: RBE acceptable when justified and validated) vs n65 (FDA: the QU reviews all records, audit trails included).
    - Resolution: RBE is only a validated way of doing the full QU review. The QU approves the complete record, with full drill-down (DI-26).
19. **Signature elements in EU rows.** n162 and n145 list printed name and meaning as if they came from Annex 11. The check notes show they come from 11.50. Resolution: kept for all markets as the union (DI-36).
20. **Printed-material specimen.** n94 offers a vision image; the Ch.4 4.21(f) literal text asks for samples whenever possible. Resolution: both are supported, with a physical specimen by default for EU-market packaging (routed to the packaging catalog).

## (e) Rows that are not an eBMR data-integrity concern

### (e1) Not an eBMR concern: another system or organisational process owns the requirement
- **n83** DSCSA package-level tracing, EPCIS and exemption timeline (secondary). Owned by serialisation level 3/4 and trading-partner exchange. At most, the eBMR reads an aggregation-completeness status at release (packaging catalog). If a DI hook is needed, the exchange falls under DI-08 (open-system flows) and DI-31 (interfaces).
- **n596** 211.65 equipment contact surfaces and lubricants. This is equipment design and qualification. The eBMR only reads the equipment's qualification status (production catalog).
- **n600** 211.84(d)-(e) component testing and CoA reliance. This is QC/LIMS release testing. The eBMR only reads the resulting lot status.
- **n602** 211.94 container-closure suitability. This is design and qualification. The eBMR only enforces the approved bill of materials (production catalog).
- **n603** 211.142 warehousing quarantine and storage conditions. Owned by the WMS. The eBMR reads quarantine status through the DI-39 interlock.
- **n612** 211.204 returned products. Owned by QMS/WMS.
- **n613** 211.208 drug product salvaging. Owned by QMS/WMS.

### (e2) eBMR functions outside this topic: routed to the production, packaging and materials catalogs (DI hooks noted)
- **n22** 211.122 labeling and packaging material controls and the special controls for cut labels (packaging). Hooks: device challenge records (DI-20, DI-32); e-signatures (DI-35).
- **n23** 211.125 labeling issuance and reconciliation (packaging). See conflict (d)14.
- **n27** 211.137 expiration dating (production/packaging). Hook: calculate the date once, with no manual entry (DI-33).
- **n28** 211.84(a), 211.87, 211.89 material quarantine, retest and rejection (materials). Hook: status changes are QU-only e-signatures (DI-17).
- **n35** 211.184 component, container, closure and labeling records (materials). Hook: append-only inventory ledger (DI-24).
- **n37** 211.186(b) required MBR content (production). Hook: MBR verification (DI-04).
- **n95** Ch.4 4.21(h) reconciliation exemption (packaging). See conflict (d)14.
- **n124** Ch.5 5.52 checks at arrival in the packaging area (packaging).
- **n128** Ch.5 5.57-5.58 code readers, counters and print durability (packaging). Hook: device checks (DI-20).
- **n141** Ch.5 5.32-5.34 starting-material labelling and status (materials). Hook: when labels carry only a barcode, the system is the authoritative source and must be validated for that (DI-03).
- **n635** Ch.5 5.19 and 5.21 cleaning records and status labels (production/equipment). Hook: chronological, attributed logbook entries (DI-28).

## (f) Open questions

1. **Final EU drafts.** Final text and effective dates of the July 2025 Annex 11 and Chapter 4 revisions. Confirm:
   - the reported section numbers;
   - whether audit-trail review after release is ever allowed;
   - MFA for signatures;
   - IAM, alarm and hybrid details;
   - the ALCOA++ definitions.
   Then re-run the gap assessment listed in (b).
2. **EU retention for exported batches.** "5 years after QP certification" needs the certification date, which the EU importer's QP holds. A technical-agreement data feed is needed. Until it exists, retention stays open (DI-47). The kernel must also take the India Schedule M figure from the India catalog when computing the maximum.
3. **211.101(c)/(d) and 211.68(c).** Does a validated balance interface with barcode identity checking count as "automated equipment", so that dispensing or charge-in can drop to one person? This needs a regulatory-affairs position. The default keeps the second person for US-market products (DI-30).
4. **Small sites.** Staffing for administrator segregation (DI-18): vendor-managed or group-IT administration, and any firm-owned compensating control, need a decision per customer.
5. **EU Ch.4 4.9 "signed and dated".** Is an audit-trail entry by an authenticated user enough, or is a signature ceremony needed? The kernel takes the conservative route (re-authentication for corrections, DI-24). Confirm with QA before any relaxation.
6. **SaaS classification.** Can a vendor-hosted, multi-tenant deployment be shown to be a closed system (customer-controlled access, vendor access under customer approval), or must 11.30 open-system measures apply? Data-residency constraints also need confirming (DI-08).
7. **What counts as "remote access" for MFA.** Does access from the shop floor to a SaaS tenant count? The default treats badge plus PIN as two factors on site and requires MFA off-network and for all privileged/vendor access (DI-13, DI-38).
8. **Destroying paper originals after a verified true copy.** 211.180(d) allows true copies, and the 2011 EU texts are silent. The default is to keep the paper; destruction only under a QA-approved SOP (DI-41).
9. **FDA and review by exception.** The FDA DI Q&A neither endorses nor forbids RBE; it requires proven review reliability. The default is full review until a validated confidence criterion is met. The criterion needs defining per customer (DI-26).
10. **Design defaults with no regulatory number.** Customer risk assessments must confirm them:
    - lockout 5 attempts;
    - inactivity lock 5 min;
    - clock drift 1 s;
    - periodic review 12 months;
    - access recertification 6 months;
    - restore test quarterly;
    - downtime drill annual;
    - password aging 90 days (or its equivalent).
11. **Auditor-facing citations.** The EMA GMP DI Q&A, PIC/S PI 041, Annex 16 and ICH Q9(R1)/Q10 were not in the local files (all (s)). Verify them against official text before citing them in customer validation documents.
12. **IPC records and 211.194.** Are shop-floor IPCs "laboratory records" under 211.194? If so, second-person review of original records is mandatory (DI-29). This is a documented firm decision per product.
13. **Independence of the audit-trail reviewer.** Does a QA person who performed in-process QA checks on the batch count as "involved"? The default blocks anyone who executed or verified any step (DI-17, DI-25).
14. **Alarm scope.** Which SCADA/EMS alarms are GMP-relevant per line needs defining per site before DI-49 can be configured (Injectables edition especially).
15. **Other-source claims.** The DSCSA timeline (n83), the FDA 2025 remote-assessment guidance (n70) and FD&C 704(a)(4) are outside the local texts and need their own verification. They belong to other catalogs.
