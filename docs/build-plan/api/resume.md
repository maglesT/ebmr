# API edition (substance): resume notes (paused 5 November 2026)

**Why paused:** owner decision of 5 November: two editions at a time (capsules and injectables) plus declutter. The API
edition resumes when capsules is finished; the lead starts a fresh session from this file.

Read with: `plan.md`, `platform-fit.md`, `handover-a0.md` (sections "A1a done", "A1b paused", "A2 part 1").

## State

| Slice | Branch / PR | State |
|---|---|---|
| A0 | #111 | merged |
| A1a | `api-a1a`, PR #119 | lead-audited and cleared; merged on green (if not, merge it first: main in only on a conflict, squash) |
| A1b | `api-a1b`, draft PR | catalogue v1 and AS controls done; on-screen E2E not built (blocked, below) |
| A2 | `api-a2`, draft PR | part 1 done (intermediate lot posting and release); consumption chain and batch C not built |
| A3 | `api-a3`, draft PR | CoA content, prepare, sign, screen and print done; open points below |

The three drafts were cut from `api-a1a` before #119 merged. Rebase each onto main after #119 merges (each holds A1a's
commits). A1b also needs rebasing onto the audited API-PACK (below).

## Reserved numbers

- substance namespace: 5000 to 5999 is the API edition's. Used: 5000 (A1a), 5003 (A1b), 5004 (A2, was 5001), 5005 (A3, was 5002) (renumbered 7 Nov: main has 5003, the AS
  engine names). Ask the lead for nothing in this range; still ask for every shared number.
- site-services 1732: A2 (`site.intermediate_lot`, `site.create_intermediate_lot`).
- Shared numbers already used by A1a: kernel 1404, recipe-core 1873.

## The lead's decisions of 5 November (in force)

1. **No over-engineering (lead audit of #119):** only what C1 to C5 and the binding clauses need. No new designer start
   (PACKAGING_BLANK was removed). API-PACK registers each drum or bag as a container; labels go through the existing
   printed-materials block G-21; no own label reconciliation. The API G-REL hook returns the existing tablets items plus
   one group-9 item, E.PACK_EXAMINATION (the core gate requires an edition answer for group 9: recipe-core 0781;
   SM 11.3.7, PR-37). Anything new must cite a binding clause number.
2. **C1, intermediate lots (A2):** approved as designed, without production delegation and without a shipping guard: the
   existing QC/QA lot release is enough (Q7 says the QU *can* delegate, which is not binding).
3. **Core material category 'intermediate'** is in core master data (databsee #61, 73c8254); `report.material_v1` shows
   it as a category value, no new columns. A2 consumes intermediates as that category.
4. **CoA (A3):** sign with the existing QA lot-release permission; no new right code `ebmr.coa.sign` unless a binding
   clause needs CoA signing separate from release (cite it); no `report.coa_v1` until a consumer exists.
5. **One dosage-form → edition rule:** the injectables session adds it in recipe-core flow (PR inj/i1c-shared), with
   substance in it. Use that rule for the header and the edition; add none of our own.
6. **UI:** Batchwright is a simple digital form (label, input, unit, limits, signature at the bottom); the declutter
   session builds the shared layout (D3). No edition-specific screens or panels; the CoA is a plain form-style document.
   D3 removes the edition prop from SignInBrand; the header names the record's edition through capsules C2's mechanism.
7. **Merging:** merge your own PR on green yourself; merge main in only when GitHub shows a conflict; report each merge
   to the lead in two lines. After #126 (generated files): do not run `pnpm handbook` before pushing; keep control test
   lists sorted with `pnpm register:sort-tests`, and on a controls-yaml conflict take main's and re-sort.
8. **No STEP_VALUE workaround needed any more:** the shared fix (#117) is on main.

## Open points (for the lead or the next session)

- **A1b E2E blocked:** the New master page sends no edition, and with PACKAGING_BLANK gone no existing designer start
  makes an API packaging master (PACKAGING_COPY copies only an existing packaging master, refused for non-tablets). The
  lead decides the smallest way (e.g. let PACKAGING_COPY copy a substance packaging master, or the page pass the edition).
- **A1b:** the "Batchwright API" header via the C2 mechanism and the shared dosage-form rule (point 5); AS-tagged
  server tests for AS-01, AS-03, AS-16 and the C5 check (AS-24); AS-14's label specimen (SM 9.3.7) is only a recorded
  confirmation in API-LABEL-CHECK, not the specimen itself. 5003 adds the AS names to `recipe.engine_name`; the register,
  its schemas and the validation bundle now accept the AS prefix and the `substance` edition (shared tooling: review).
- **A1b rebase:** API_PACK on main is the audited one (container REGISTER, net mass, sealed, label check; no recon/exam).
- **A2:** the database lets QA release an intermediate only as RELEASE_FOR_FURTHER_PROCESSING; A2 added that decision to
  `proposeLotDecision` and the LOT_DECISION signed action (contract change: lead to confirm). Next: batch B consumes A
  through a G-07 weighing (consumption must be named by a batch-record entry, EBMR-RCP-433; needs plant set-up), the
  lot_consumption chain A → B → C, and batch C to a released API lot.
- **A3:** (a) `QA_APPROVED` is tied to plant-rule approval, so A3 added a meaning `COA_APPROVED` (on
  RELEASE.MANUFACTURER) and a signable action `COA_ACT`: a new signing meaning, lead to confirm under decision 4;
  (b) 5005 re-creates the tablets function `tab.aggregate_read_class` to add `substance_coa` (a test guards it, but a
  later tablets redefinition would drop it: lead to decide the right home); (c) no master data holds the manufacturer's
  telephone (SM 11.3 / Q7 11.40 name it): the CoA shows "not on record"; (d) "grade" comes from the specification's
  monograph reference; (e) A3's CoA tests extend `api-chain.test.ts` and must be adjusted to the audited A1a.
- **Upgrade drill:** `tools/drills/src/upgrade.ts` ADDED_ONLY_ALLOWED lists `recipe.grel_edition_hook` and
  `recipe.packaging_completion_block` (A1a).

## Next steps when resumed

1. Confirm #119 is merged; rebase `api-a1b`, `api-a2`, `api-a3` onto main (A1b onto the audited API_PACK).
2. Get the lead's answers on the open points above (E2E path, A2 contract change, A3 meaning and read class).
3. A1b: E2E on screen and its group; the AS server tests; merge.
4. A2: consumption chain and batch C; merge.
5. A3: adjust to decisions; merge.
6. Then A4 (recovery, reprocessing, rework) and A5 (blending), per `plan.md`.
