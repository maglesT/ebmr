# Batchwright API: fit with the MEDHANTA platform (design note before A0)

- **Date:** 4 November 2026. **For:** the lead, before any A0 code. **Plan:** `docs/build-plan/api/plan.md` (approved).
- **The rules it must meet (lead, from databsee `docs/05-add-a-product.md`):**
  1. One product, one database, with its own `<product>_owner` and `<product>_app` roles.
  2. Master data is read only from core.
  3. People and rights come only from core: `ebmr.*` codes in the token.
  4. Data is shared with other products only through `report.<name>_v1` views.
  5. Migrations use `"migrate": "own"`, and any migration that moves data carries its PL-13 check.

## Proposal: API is a catalogue and a schema inside the existing product `ebmr` and its one database

**(a) The product.** It is **not** a separate product and **not** a second database. The API edition lives in the product
`ebmr`, in the database `ebmr`:

| Part | Where it lives |
|---|---|
| API library catalogue (`API-…` blocks) and API master records | Data in the `ebmr` database, approved there by QA like any library block |
| The few API rules (C2 blend guard, C4 rework check, if needed) | Its own namespace and schema `substance` (migrations 5000–5999), applied after `tablets`. Each guard fires only on records of an API or intermediate master. Tablet records never reach it. |
| The edition | The edition value `substance` on `recipe.mbr_family.edition`, and on library blocks and formulations: injectables I-0, migration 1871, the same pattern as injectables (PR #101). It decides the badge and which seed catalogue is offered. There is no `EDITION=` process setting and no second deployment. |

Why this and not a product `ebmr_api` with its own database:

- **Rule 1 holds with no platform change.** The role names `ebmr_owner` and `ebmr_app` are written into 325
  released migration files (kernel, site-services, recipe-core, tablets). We may not edit released migrations. A
  second product would need a second role pair, so every one of those files would have to be copied. That is a fork,
  not an edition.
- **(b) disappears.** One database means one set of lots, one batch-number register and one genealogy. An API lot made
  on site and used by a tablet batch at the same company is an ordinary lot consumed through the existing lot checks.
  No database is shared between products and no cross-database link is needed. On the platform today, site data
  (`site-services`) already sits inside the `ebmr` database (Phase B, slice 6). The separate `ebmr_site` of ADR 0001
  is not deployed.
- **No binding clause asks for a separate database or system.** Schedule M Part XII 5.4 and Annex 11 ask for a
  validated system with access control and an audit trail, not a separate one. Keeping API rules apart from tablet
  rules is met by the `substance` schema, the API-only catalogue and tests proving tablet behaviour is unchanged.
- **One customer, one choice.** A site that makes only APIs approves only API blocks, so its screens show only them. A
  site that makes the API and the tablet shares people, QA and lots, which is what it needs.

**Alignment with injectables.** The same reasoning applies there unless a sterile clause forces a separate database. I
found none in Part XII; the injectables session should confirm for Annex 1. If the lead keeps injectables on a
separate database for its own reasons, API still fits this note unchanged. If the lead wants one pattern for both,
this is the smaller one.

## Each platform rule against this proposal

| Rule | How API meets it | New work |
|---|---|---|
| 1. Database and roles | The `ebmr` database, `ebmr_owner` and `ebmr_app`. The app role gets SELECT and INSERT only; new current-state tables, if any, get exact grants. Signed and audited tables are insert-only (PL-06, PL-08). | None. Grants are written in each `substance` migration. |
| 2. Master data | Solvents, reagents, KSMs, intermediates as materials, products, reactors, Nutsche filters, centrifuges, ANFDs, dryers and rooms all come from core `master_data` through `report.*_v1`, `md.item_map` and `md.require_active`, exactly as for tablets. Dedicated or HPAPI equipment (AS-13) is an equipment class held in core. | None in code. Core must hold API equipment classes and API material kinds (INTERMEDIATE, API), which is data entry in core. If core's material kinds lack INTERMEDIATE, that is a databsee change for the lead (Q-P1). |
| 3. People and rights | Core sign-on; rights only from `ebmr.*` codes; no local users; INV-11 holds | New codes per slice go to the lead. Expected so far: `ebmr.coa.sign` (A3, CoA). Release, blending, recovery and rework reuse existing codes. The list is final when each slice is designed. |
| 4. Sharing | MMS or QMS reading API lots, batches or CoAs only through published views. Existing lot and batch views (Phase B) cover API lots if they show the material kind and retest date. | A3 may add `report.coa_v1`, sent to the lead. Nothing else foreseen. |
| 5. Migrations | `substance` migrations run inside the platform migrator (`"migrate": "own"`), after `tablets` | No migration moves data (A0 to A12 add schema and guards only), so no PL-13 check is needed. If one does, it ships its PL-13 check. |

## What changes in the approved plan

- Q1: the `EDITION=substance` deployment with its own database becomes "same product, same database, `substance`
  schema and catalogue". A0 then shrinks to:
  - the `substance` namespace and its migration-source entry;
  - the edition value `substance` (on I-0's edition columns), the badge and the catalogue load;
  - the AS control files as each slice meets them.

  **A0 still waits for I-0**, because the edition columns come from I-0's migration 1871.
- C1: the batch posts its lot with the **material kind of its product**, INTERMEDIATE or API, instead of always
  FINISHED. A tablet batch can then consume an on-site API lot as an API, and the tablet path stays FINISHED. It is
  still the single shared change, cleared with the lead first.

## Questions for the lead

| # | Question | Default |
|---|---|---|
| Q-P1 | Do core's material master kinds include INTERMEDIATE and API, and its equipment classes the API ones (reactor, Nutsche, ANFD, centrifuge, dryers, mills)? | Yes for API; INTERMEDIATE added by the lead in databsee if missing |
| Q-P2 | Same database, or a separate one? | **Lead, 4 November: the same database.** Injectables follows the same pattern (PR #101). |
