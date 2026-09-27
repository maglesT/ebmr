# ADR-0013: India manufacturer release plus per-market dispositions

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 and its defaults (decision record 0001: the India AP release gates every market; in-system EU QP certification off; EU lots ship only to the named importer in quarantine; release blocked while an investigation is open)
- **Supersedes:** the v0.1 model of one batch-level RELEASED state with an in-system QP, and "one signature, two meanings"

## Context

- Every batch is made in India under an Indian licence. Schedule M (Part I 11.3.6-11.3.9) makes the authorised person (AP) certify each finished batch before it is sold or supplied anywhere, exports included (IN-05; outline 2.5 assumption 1).
- For US distribution the quality control unit approves or rejects each batch (21 CFR 211.22(a), with 211.165(a) and 211.192; PR-54). For the EU, a qualified person certifies each batch; for product made in India this normally happens at the EU importer's site after importation, outside this system (PR-55; Annex 16 text is not in the inputs).
- The market catalogs require each market's decision to be independent of the others (PR-56, S32), while Schedule M makes the India release a precondition of all of them (resolution in outline 5.9 item 4).
- DI-39 says uncertified stock cannot be shipped, yet EU certification happens after import. Resolved as "cannot be moved to saleable status": quarantined shipment to the named importer is allowed (outline 5.9 item 5).
- Evidence can arrive after release (late EM result, revised LIMS result, deviation, as-found calibration failure), so a release must be suspendable.

## Decision

1. **Manufacturer release,** one per finished lot, by the India AP or a named delegate with a valid delegation (checked at signing; S10 applies to the delegate). NOT_READY -> READY is computed by the release gate G-REL, never set by hand; then RELEASED or REJECTED, after head-of-QC approval, with re-authentication using all signature components. NOT_READY -> REJECTED is also allowed. The evaluated checklist is stored with the signature (IN-05(d)). For a lot packed for India-domestic sale, this release is also its India market release.
2. **Market dispositions,** one per finished lot and export market. They are independent of each other, except that each requires the manufacturer release to be RELEASED at the instant of signing (INV-39).
3. **US:** NOT_READY -> READY (G-REL plus US items) -> RELEASED or REJECTED by the QCU-disposition role. If the AP also holds the QCU permission, one signing ceremony writes two signature rows, each with its own meaning, manifestation, content hash and invalidation life cycle. A contract giver's QCU disposition is recorded where applicable.
4. **EU, with the in-system QP switch OFF (default):** once the manufacturer release is RELEASED and the EU items of G-REL are green, the EU disposition moves to AWAITING_QP_CERTIFICATION and the system generates the **EU QP batch package**: a signed true-copy bundle of the processing and packaging records, the audit-trail review, the list of post-entry changes to critical data and special observations (EU Ch.4 4.27), deviations with per-market assessments, the manufacturer release with its checklist, and the batch certificate or CoA the technical agreement requires (Annex 16 content to verify). It is delivered as a package or through a read-only, time-boxed QP account scoped to the lot. The QP at the EU site returns a structured, signed certification message (certifier, MIA number, date, lot) with acknowledgement -> CERTIFIED or REJECTED_BY_QP. Manual entry is a fallback flagged "transcribed" and verified by a second person.
5. **EU, with the switch ON:** only registered QP accounts certify in-system, into an append-only register.
6. **Shipping (INV-42):** no shipment without a current, unsuspended manufacturer release; to a US consignee only after the US disposition; to the EU only to the importer named in the technical agreement, as quarantined goods, while the EU status is AWAITING_QP_CERTIFICATION. ERP/WMS never sets EU saleable status. Certification overdue (default 60 days) raises an escalation task. EU retention stays open until the certification date is received.
7. **Cascade:** rejecting, suspending or invalidating the manufacturer release moves every dependent market disposition to RELEASE_SUSPENDED (if released) or NOT_READY in the same transaction.
8. **After release:** a deviation, incident, as-found calibration failure, APS failure, EM result, revised LIMS result or DI investigation linked to the lot or its genealogy moves RELEASED to RELEASE_SUSPENDED automatically; the same transaction blocks remaining stock in ERP/WMS via the outbox and creates an AP-owned recall-assessment task. Exits: RELEASED (QA re-confirmation with impact assessment), RECALLED, or REJECTED_AFTER_RELEASE. Suspension propagates to downstream lots.
9. **Gate mechanics:** G-REL is computed outside the signing transaction and confirmed inside it at an unchanged evidence epoch (INV-05). Signers are outside the batch's involvement set (INV-35). A market whose market-add evaluation has an UNMET_FINAL item is INELIGIBLE (ADR-0008). Release with an open investigation stays blocked (PR-53 switch off).

## Consequences

### Positive

- Meets the India precondition while keeping export-market decisions independent of each other.
- The normal EU route (certification after importation) works without a QP at the Indian site.
- Each legal act has its own signature row, so one can be invalidated without touching the other.
- Late evidence has a defined, automatic path instead of relying on someone noticing.

### Negative

- More states, signatures and model-based test paths; the cascade and suspension logic is a named risk (risk 7).
- The AP is on the critical path for every market.
- EU QP package content is unverified until Annex 16 text is obtained.
- ERP/WMS must honour the quarantine-shipping and stock-block messages; the adapter is safety-relevant.
- Two signature rows in one ceremony must be made unmistakable in the signing dialog.

## Alternatives considered

- **One batch-level RELEASED state with an in-system QP.** Rejected: there is no EU QP at the Indian site; certification happens after importation.
- **Fully independent market dispositions.** Rejected: contradicts the Schedule M precondition.
- **One signature carrying two meanings.** Rejected: the two acts need separate manifestation and invalidation (DI-35 lists the QU disposition as its own signature type).
- **No shipment before EU certification.** Rejected: blocks the normal import route.

## Related controls and invariants

- Controls: IN-05 (disposition by the authorised person), IN-29 (recalls), PR-45 (quarantine and release status), PR-53 (open deviations), PR-54 (US QCU disposition), PR-55 (EU QP certification), PR-56 (market-specific disposition), DI-30, DI-35, DI-39 (disposition and quarantine interlock), DI-41 (true copies).
- Invariants: INV-05, INV-35, INV-39, INV-42, INV-43, INV-48.

## References

- Build outline v0.2: sections 1 (Release model), 2.5 assumptions 1-2, 4.6 (ERP shipping rule, EU importer), 5.2.6, 5.2.7, 5.9 items 3-5, 7.2 (S10, S32), 11 Phase 4.
- Decision record 0001, Defaults adopted.
- Resolution log: R-01, R-02, R-03, R-04, L-19.
