# Injectables on the MEDHANTA platform: design note for I-0

- **For:** the lead, before I-0 (4 November 2026). Answers (a) and (b) of the platform requirement (databsee
  `docs/05-add-a-product.md`, rules 1-5).
- **Confirmed by the lead (4 November); ADR 0001 amended.** **Changes plan v2 section 2:** "own database `ebmr_injectables` + `EDITION=injectables` deployment" becomes "same
  database, edition as data". Everything else in the plan stands.

## Facts found

- On the platform, Batchwright is one product, `ebmr`, with one database. The platform migrator already runs kernel,
  site-services, recipe-core and tablets migrations **into that one database** (`apps/tablets-server/src/cli/platform-migrate.ts`).
  `ebmr_site` exists only in the standalone build (ADR 0001); on the platform its tables are schemas of `ebmr`.
- The edition is already data: `recipe.mbr_family.edition` is `tablets` or `injectables` (recipe-core 0110). The market
  engine already scopes rule tables by the scope's edition and refuses a `sterile` key for a Tablets scope
  (`EBMR-MKT-054`). Library blocks have no edition yet.
- Master data (rooms, equipment, instruments, materials, products) already comes from core `master_data` through
  `report.*_v1`, `md.item_map` and `md.require_active` (Phase B slice 3). Persons and rights already come from core OIDC
  and the token's `permissions`.

## (a) One product with the edition as data: recommended

Injectables is **not** a separate platform product. It is the edition of an MBR family inside product `ebmr`:

| Rule | How it holds |
|---|---|
| 1 One product, one database | the `ebmr` database only; no `ebmr_injectables`; `ebmr_owner` and `ebmr_app` unchanged; insert-only signed and audited tables unchanged |
| 2 Master data once | sterile rooms, lines, steriliser, lyophiliser and so on are core `master_data` items read through the existing views and item map; grade and qualification due dates stay local fitness facts on the mapped item (like clean status today) |
| 3 People and rights | core OIDC; existing `ebmr.*` codes. A new code only if a sterile act needs one; none is foreseen (plan Q3). Any new code goes to the lead per slice |
| 4 Sharing | existing `report.*_v1` views; deviations from sterile batches reach Deviations through the same views. New views go to the lead |
| 5 Migrations | the platform migrate (`"migrate": "own"`); I-0 needs one small migration (below), with no data movement and so no PL-13 check |

**What I-0 changes (smallest):**
1. One recipe-core migration: an `edition` on library block definitions and formulations (`generic`, `tablets`,
   `injectables`; existing rows become `tablets` or `generic` as they are today). The designer palette and the
   formulation builder show the blocks of the formulation's edition plus `generic` ones. The number is cleared with the
   lead first (shared directory).
2. The MBR family takes its edition from the formulation (the column exists). The market scope reads it (exists).
3. The header badge shows the edition of the record on screen (decision 0020). With no record open it shows
   Batchwright with no edition badge.
4. ADR 0001 amended by the lead: on the platform, one product and one database hold every edition; an edition is a
   property of the MBR family, its library and its rule tables, not a deployment.

No `EDITION` deployment setting is needed. This is smaller than plan v2 and fully neutral, so the API edition (if it
needs one) uses the same column.

**Rejected: a separate product `ebmr_inj`.** It needs its own manifest, codes, database and login. Lots, batch numbers
and the beta-lactam and hazard rules (which must see every product made on a site) would have to cross products through
new published views, with two-way consistency that neither side can enforce. It is more work and weaker.

## (b) What happens to `ebmr_site`

Nothing new. On the platform its tables already live in the `ebmr` database:
- **Persons:** from core identity (PL-03, INV-11); the site-services person rows are the existing mirror keyed to core
  ids.
- **Lots, lot status, batch-number register, devices:** one set inside `ebmr`, used by both editions. A lot rejected for
  a tablet batch is unusable for a sterile one, and batch numbers stay unique. No view and no second copy.
- **Standalone build:** keeps ADR 0001 as it is (frozen branch `standalone`); not in this plan.

## Validation separation (the reason ADR 0001 split the databases)

Sterile content is QA-approved data (library blocks, formulations, `sterile` rule rows) whose effect is limited to
families of the `injectables` edition: the palette filter, the edition check on families and the existing
`EBMR-MKT-054`. A sterile data change creates no Tablets change control. The code stays edition-neutral. A `[meta]`
test proves both directions: a sterile block cannot be placed in a tablets formulation, and the reverse.

## Asks

1. Confirm (a) "one product, edition as data" and the ADR 0001 amendment.
2. Clear one recipe-core migration number for the edition column.
