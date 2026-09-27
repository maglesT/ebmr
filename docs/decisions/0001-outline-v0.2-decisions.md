# Decision record 0001: Build outline v0.2 decisions

- **Date:** 27 September 2026
- **Decided by:** project owner (maglesT)
- **Decision:** "go with the recommendations". Every decision in section 13 of the build outline v0.2 takes its recommended option, and every default listed there applies.
- **Source:** `docs/outline/build-outline.md` section 13 and `docs/outline/pdf/eBMR-Build-Outline-v0.2.pdf`

| # | Decision | Chosen |
|---|---|---|
| 1 | Share recipe-core between editions | **A.** Share the kernel, site services and recipe-core. Each edition pins exact versions. The kernel boundary is as proposed. |
| 2 | Tiered FDA/India media-fill acceptance on lines with no EU/PIC/S product | **B.** "Any contaminated unit fails" on every line. The tiers are out of v1. |
| 3 | DSC/eSign for Indian signatures | **B.** Optional per signature meaning. It stays off until a licensed CA or eSign provider is configured and validates to the CCA root. A test CA is used in v1, with a banner while the counsel questions are open. |
| 4 | Pressure-differential defaults | **A.** 10 Pa between grades, and the site's qualified value governs. 12.5 Pa from aseptic rooms to unclassified areas is the default in all profiles. |
| 5 | Continuous particle-count evaluation | **B.** Isolated counts are annotated. Consecutive or recurring counts escalate per Annex 1 Table 5 note 2, with QA-approved window parameters. |
| 6 | IP weight bands for export-only tablet batches | **A.** IP bands apply to every India-made batch, and the tighter band wins. |
| 7 | v1 scope | **Accept.** Tablets without capsules or continuous manufacturing. Injectables V-1, V-2, V-4, V-5, V-9 and V-10 are complete in v1. V-3, V-6 and V-7 get their blocks in v1 and golden batches in v1.1. V-8 is v1.1. No parametric release, powder filling or biologics. |
| 8 | One verifier for validated automated dispensing/charging (211.68(c)) | **A.** Two persons on every batch in every profile by default. One-verifier mode is allowed only after the customer documents its regulatory position. |
| 9 | Batch sizes and generic masters | **A.** Discrete approved sizes only. "Structure + parameter set" is approved as the master. |
| 10 | Review by exception | **A.** Built in v1. Full review is the default until an MBR earns confidence. |
| 11 | Build or integrate LIMS, QMS, LMS, EMS | **B.** Integrate, plus minimal stand-ins. The EMS is always imported. |
| 12 | Topology, deployment, offline | **A.** One installation per site, a pre-staged paper fallback, and no signing on devices. The enterprise hub is v1.1. |
| 13 | Sites running both editions | **A.** One site-services database per site. The edition databases stay separate. |
| 14 | Controlled substances (NDPS) | **A.** A product-master flag, in Phase 6. The draft control IN-53 stays at status U until the NDPS Act and Rules are verified. |

## Defaults adopted

- The India authorised person's manufacturer release gates every market.
- A QA person who did in-process checks counts as involved in the batch.
- Every signing requires all signature components.
- The MBR checker and the QA approver must be different people.
- Dispensing and charge-in need two persons on every batch.
- There is no grace period on the 6-month APS interval.
- The first batch after a change waits for a post-change evaluation.
- In-system EU QP certification is off.
- EU-destined lots ship only to the named importer, in quarantine.
- Retention stays open until the EU certification date is received.
- Free text on US and EU batches is in English, or carries a verified translation.
- Release is blocked while an investigation is open.

## Still pending

The external expert's Follow / Don't follow / Modify decisions on the 241 controls in review pack v0.9. Until they arrive:
- every control's `expert_decision` is `PENDING`;
- design choices default to the pack's proposal;
- controls stay pending in each phase's release notes.
