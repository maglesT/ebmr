# Decision record 0005: Build to the core of the binding regulations only

- **Date:** 28 September 2026
- **Decided by:** project owner (maglesT)
- **Decision:** "let's not go very heavy on the regulations: follow the core FDA, EU and Schedule M regulations needed to
  make the system compliant, but that's it; just enough to make it compliant, the core things."

## Rule

A requirement is **CORE** when a compliant electronic batch record system for tablets made in India (and exported to the
US or EU) needs it to meet binding text:
- India: Drugs and Cosmetics Rules, Revised Schedule M (G.S.R. 922(E));
- US: 21 CFR Parts 210/211 and Part 11;
- EU: EudraLex Volume 4 Part I (chapters relevant to documentation, production, quality control and release), Annex 11,
  and Annex 16 only as far as the EU release step needs it.
Guidance (FDA and EMA Q&As, PIC/S) counts only where it states how one of those binding requirements must be met and a
system without it would fail that requirement. Everything else is **DEFERRED**: drafts (e.g. the 2025 Annex 11 draft),
optional guidance, other laws (CERT-In directions, DPDP Act, IT Act eSign/DSC options), ICH Q12 reporting categories,
injectables and sterile requirements (decision 0002), efficiency and convenience features, and design choices the
regulations do not demand.

## How it is applied

- Each control in `compliance/controls/` gets `build_scope: CORE` or `build_scope: DEFERRED`, with a reason naming the
  binding clause (or why none applies). A CORE control whose behaviour contains non-core parts lists them in
  `scope_note` as deferred parts. The classification was produced by independent reviewers and every DEFERRED call was
  challenged by a skeptic before it was accepted.
- CI (traceability) requires tests only for CORE controls due by the current phase. DEFERRED controls stay in the
  register untouched (their text and expert decision are unchanged) so they can be reinstated by a later decision.
- Code already built for a control now DEFERRED is kept; it is not extended.
- The external expert review is still valid for the CORE set; it is not replaced by this decision.
