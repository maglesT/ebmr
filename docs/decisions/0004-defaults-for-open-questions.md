# Decision record 0004: Defaults for every open question

- **Date:** 28 September 2026
- **Decided by:** project owner (maglesT)
- **Decision:** "go for defaults for any question you have". Every open question in
  `docs/decisions/phase-1-open-questions.md` and `docs/decisions/phase-2-open-questions.md` takes the default stated
  there. Questions that arise later in the build also take the stated default unless the owner says otherwise; the
  default and its reason are recorded in the phase's open-questions file for later review.
- **Except:** questions that decision 0003 moved to the separate deployment design (RPO/RTO, backup schedule, WORM
  storage product, administrator separation of storage) are not answered here.
- **Note:** the external expert review of the control register (review pack v0.9) is not replaced by this decision;
  expert decisions stay PENDING in `compliance/controls/`. Decision 0005 narrows what is built.
