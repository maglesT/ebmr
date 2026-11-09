# Declutter: a lighter Batchwright, only the working batch-record path on screen

Owner request of 5 November 2026, through the lead: Batchwright still shows old screens. Anything that does not work
end to end on the platform comes off the screen. QMS functions such as the CAPA register come out for now (the owner
decides later which to keep). The UI gets a new, cleaner look. The other editions inherit the same short list. Data
follows the platform data plan: no copy of what another product owns, reads and writes per product.

Plan only. No code until the lead and owner agree. Slices are in section 6.

## 1. Keep or disconnect

**Keep, by name (owner check of 5 November): the front of the core path, the dynamic method.** The owner must be able to
create and load a new formulation on the demo after the declutter.
- Library: block draft, check, QA approval and retirement, and catalogue load (`/mbr/library`, the `library` routes).
- A new formulation from library blocks with the product's own values: limits, equipment classes and batch sizes. This
  is the formula and designer screens: `/master-data/formulas` and `/master-data/formulas/$formulaId`, plus the
  designer at `/mbr`.
- Master record: family, versions, preparer → checker → QA approval, and the change records a new version needs
  (`/mbr`, `/mbr/change-records`).
- Batch generation from the approved master (`/planning`, `/planning/batches`).
- Packaging (lead review): release is of a finished lot of a packaging batch. `recipe.release_scope` refuses any other
  lot (EBMR-REL-010, recipe-core 0781). A finished-product batch record also includes packaging and labelling (US
  211.188(b), 211.125 and 211.130; the Schedule M batch packaging record). So the minimum is kept: the packaging order
  with its batch, bulk issue, label issuance and label reconciliation.

**Keep** is the batch-record path that works end to end on the platform:
- master record (library, designer, approval and its change record);
- batch issue;
- dispensing;
- shop-floor execution with signatures;
- in-process checks;
- exceptions;
- batch record review;
- release.

Keep also:
- the audit trail;
- the batch-number register;
- the admin minimum: terminals and devices, and the site values the kernel needs.

This is what US 211.186, 211.188 and 211.192, EU Chapter 4 and Annex 16, and India Schedule M (master and batch
records, their review and release) bind for the batch record. Nothing else is kept on screen.

**Disconnect** means off the home, off the menus, and the server routes refused (section 3). Tables and records stay.

Home tiles (all live in `apps/tablets-web/src/features/*/index.tsx` `homeTiles`). "Hidden" today is per role
(`tile-access.ts`), not a fixed list. The table covers every tile.

| Tile (route) | Decision | Belongs to / why |
|---|---|---|
| Audit trail (/audit) | KEEP | Part 11 and Annex 11 audit trail of the batch record |
| Master records (/mbr) | KEEP | the designer and its approval |
| Block library (/mbr/library) | KEEP | the dynamic library the designer builds from |
| MBR change records (/mbr/change-records) | KEEP | the master record's change control (approval path) |
| Labelling specimens (/mbr/specimens) | DISCONNECT | later (packaging artwork; the approved template is what prints) |
| Shop floor (/runs, GMP) | KEEP | execution, signatures, IPC, exceptions |
| Test-run packages, Test runs, Test lots, What you can do now (SANDBOX) | KEEP | the sandbox's test run of a master before approval |
| Planning (/planning) | KEEP | the batch order that issues the batch |
| Batches (/planning/batches) | KEEP | issued batches |
| Batch numbers (/planning/batch-numbers) | KEEP | batch-number register |
| Packaging orders (/planning/packaging) | KEEP | release needs a finished lot of a packaging batch (EBMR-REL-010) |
| Master data (/master-data): Formulas (/master-data/formulas, /master-data/formulas/$formulaId) | KEEP | the new formulation from library blocks (core path) |
| Master data: products, materials (/master-data/erp), rooms and equipment (/master-data/plant), Plant definitions (SANDBOX) | READ-ONLY on the platform | core owns them. Batchwright shows the mapping (`md.item_map`) at most; no create or edit |
| Plant (/plant) | KEEP, reduced | equipment in use, its clean status and the equipment-use checks for the batch; the logbook belongs to Logbook (section 2). D1's request-logged E2E run proves the equipment-use checks still work |
| Quality (/quality) | KEEP, reduced | material lot receipt and status that dispensing needs; lot management belongs to MMS (section 2). D1's request-logged E2E run proves dispensing still works |
| Batch record review (/review) | KEEP | 211.192 |
| Release cockpit (/release) | KEEP | release |
| QP batch packages (/qp) | DISCONNECT | later: EU exports only (owner, 5 November) |
| Suspension and recall (/release/suspended) | DISCONNECT | QMS (recall) |
| Notification centre (/notifications) | DISCONNECT | later (platform notifications) |
| Record locks and amendments (/records) | KEEP | correcting a recorded entry with its reason is a binding data-integrity need |
| Product quality review (/pqr) | DISCONNECT | QMS |
| Archive and retention, Inspection workspace | DISCONNECT from the home | later. Retention runs in the server unchanged; inspection reads move to the audit trail screen |
| Incident register (/incidents) | DISCONNECT | QMS |
| CAPA register (/capa) | DISCONNECT | QMS |
| Penicillin and beta-lactam rules (/plant-rules) | DISCONNECT (owner, with risk acceptance) | the whole `plantRules` namespace, its classification and facility-rule routes included. See the risk acceptance below |
| Plant alarms, Status board, Area authorisations, Trends, Rooms and lines, Reagent lots, Equipment records | DISCONNECT | Logbook (equipment), MMS (reagent lots), later (alarms, trends). The `alarms` routes stay connected: the step screen and the batch review show the batch's alarm log (DI-49); only the tile goes (D1 review) |
| Operations (/operations) | KEEP for the operator role only | set-up and backups |
| API reference (/developer/api) | DISCONNECT from the home | still served for integrators |
| Validation and records (/validation) | DISCONNECT | Qual or later |
| Site values (/market/site-values) | KEEP | values the kernel needs |
| Market policies, QP register, Compendial rule sets, Plant configuration | DISCONNECT from the home | later. Their values stay in force; read-only where the release path needs them |
| Configuration change records, history, review-by-exception rules | DISCONNECT | QMS (change control) or later |
| Vendor support, Digital signature certificates, Contract givers, Batches made for you | DISCONNECT | later |
| Genealogy explorer, Complaint lookup, Mock recalls | DISCONNECT | QMS (complaints, recall) |
| Label store (/labels/store) | KEEP | label issuance and reconciliation (211.125, 211.130) |
| Label templates (/labels/templates) | KEEP read-only | the packaging batch prints from the approved template; editing goes later with artwork |
| Serial lookup (/serialisation/serials) | DISCONNECT | later (serialisation) |
| Licences, Shelf-life bases, Batch-number register (India) | KEEP licences and the register; shelf-life bases DISCONNECT | the Schedule M register of batch numbers; a GMP batch needs the product endorsed on the manufacturing licence (D-D2-1, lead, 5 November) |
| Dashboards, Change impact, Analytics, SPC, MSPC, Audit-trail flags | DISCONNECT | later (analytics product) |
| Integration health, Inter-site transfers, Controlled substances (draft) | DISCONNECT | later |
| Training (SANDBOX), Scales | KEEP Scales under Terminals and devices; Training DISCONNECT | Qual |
| People and accounts, Role grants, Recertification, Break-glass, Role permissions, Delegations | DISCONNECT on the platform (already 410 MANAGED_IN_PLATFORM) | core |
| Terminals and devices, Device configuration | KEEP | admin minimum (DI-20) |
| Security alerts | KEEP inside Terminals and devices | unregistered-device alerts |
| Qualification matrix | DISCONNECT | Qual |
| US e-signature certification | DISCONNECT from the home | core (one certification per organisation) |

About 22 tiles stay; most were already in Home's "show all". Before slice 1 is closed, the kept path's own screens are
checked for every read they call (method in section 3). Any read a kept screen needs stays connected even when its tile
goes.

## 2. Data: no copy of what another product owns

| Data in Batchwright | Owner | Smallest fix |
|---|---|---|
| Full deviation records: `site.deviation*` (site-services 0730, 0820) | Deviations | Disconnect the deviation routes. A batch exception keeps only its `deviation_ref` (recipe-core 0440, already there). Deviations already reads the ebmr views (slice 4). |
| CAPA and the QMS mirror: `site.capa*`, `qms_capa_state`, `qms_deviation_status`, `qms_change_control` (site-services 0925) | QMS | Disconnect the routes. Keep the tables for retention. Release's check "no open CAPA on this batch" reads QMS's published view when QMS publishes it. Until then the check stays as it is. |
| PQR, mock recall, suspension and recall (recipe-core 0910, 1012, 1091, 0840) | QMS | Disconnect the routes. Keep the tables. QMS reads the batch through the ebmr views. |
| Configuration change control `platform.change_record*` (kernel 1195) | Batchwright for its own master and configuration (keep); QMS for site change control | Keep the master's change record. No other change control is shown. |
| Equipment, cleaning, repair, CMMS mirror `plant.*` (recipe-core 0400, 0460, 0950) | Logbook | Keep `equipment_use` and `step_equipment` (they are part of the batch context). Clean status is read from Logbook's published view once Logbook publishes it; until then the current table answers. |
| Material lots and stock `site.material_lot*`, locations, finished and returned lots, reagent lots (site-services 0710, 0911, 0842, 0940) | MMS | Keep the batch's reservation and consumption, which are part of the record. Lot identity and status are read from MMS's published view once it exists. About 40 foreign keys point at `material_lot`, so this is a reference-only change in its own slice, later. |
| Training and qualification `iam.person_qualification*` (kernel 0130) | Qual | Already a mirror with a heartbeat. Read Qual's view when Qual publishes it; the signing check stays. |
| People, accounts, grants, delegations (kernel 0110, 0120, 0170) | core | Done in Phase B (platform identity; 410 on the platform). |
| Master data `md.*`, `plant.product`, materials, rooms, equipment | core | Items done (slice 3). Read-only mapping in Batchwright; the create and edit routes for these refuse on the platform. |
| Formulary `formulary.*` (recipe-core 0640) | Batchwright (owner, 5 November) | Keep: the formulation is the master record's own content. |

No migration is edited and no GMP record is deleted. Every fix is a new migration or only a route change.

## 3. Disconnect in two phases

**Now.**
- One list, `DISCONNECTED` in `packages/api-contract` (feature names and route namespaces), is read by both the server
  and the web.
- Server: `bind.ts` answers `410 DISCONNECTED` for every route in a disconnected namespace. This is the same mechanism
  as `PLATFORM_MANAGED_ROUTES` (bind.ts:404). The plugin stays registered, so its database functions and checks keep
  running for the kept path.
- Web: Home and every menu skip tiles whose route is disconnected, and a deep link shows a short "not part of
  Batchwright" page.
- Tables, records, retention and migrations are unchanged.
- How the keep list is checked: run the kept E2E groups with request logging, and confirm every route the kept
  screens call is still connected.

**Later**, after the owner decides what to keep: delete the dead web features, server plugins and contract
namespaces, one PR per area. Tables stay until their retention ends.

**Tests.**
- Tagged with the access-control ID chosen in D1: every disconnected namespace answers 410, for one route each, generated from the list.
- The kept path is unchanged: the golden batches GB-T-01, -02 and -03, and the E2E groups gmp-batches, library-dc and
  route-w. Together they cover dispensing, the equipment-use checks, packaging, label reconciliation and release.
- A kept E2E step, new in D1: a new formulation from library blocks → master → approval → batch. The owner must be able
  to do this on the demo.
- `home-tiles.test.tsx` checks that the home offers exactly the kept list per role.

## 4. New look

A role-based home of four work cards with counts, then the few kept screens as plain links. Fewer words: a title and a
count, no descriptions. It uses the MEDHANTA card style (ui-kit tokens, as in core and Deviations).

```
Batchwright — Tablets                         Ravi Kumar · Production · PC-ADMIN-01
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ My batches   │ │ To sign      │ │ To review    │ │ To release   │
│      4       │ │      2       │ │      1       │ │      0       │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
Master records · Planning · Shop floor · Audit trail · Batch numbers
```

A card opens a single list. A row opens the record at the step that needs the person.

```
To sign (2)
  B26-0041  Paracetamol 500 mg   Compression · IPC weight    due 14:20   ›
  B26-0039  Metformin 500 mg     Dispensing · second check   due 15:00   ›
```

Admin (the configure holder) gets one card, Administration, with three items: Terminals and devices, Site values, and
Operations.

```
Administration
  Terminals and devices (3)    Site values    Operations
```

**Simplicity review.**
- One home and one list pattern.
- No dashboards and no counts that nobody acts on.
- The menu equals the kept list.
- Every word on a card is a noun or a number.
- The counts come from existing reads (`execution.workQueue`, `review.queue`, `release.queue`), so no new server read
  is needed except one "to sign" count over the work queue.

## 5. Editions

The home, the menus, the `DISCONNECTED` list and the kept list are shared, so Capsules, Injectables and API inherit
them. Edition sessions:
- must not add home tiles or top-level menu entries;
- must not re-connect a disconnected namespace;
- must not add tables for deviations, CAPA, change control, recall, PQR, logbook, cleaning, stock or training.

An edition adds only:
- its blocks, in the library;
- its record content, in the run, review and release screens;
- its edition name in the header.

Anything else goes to the lead first.

## 6. Slices

| Slice | Content | Proof |
|---|---|---|
| D1 | the kept path's front end checked on the demo: a new formulation from library blocks, then its master, approval and batch; `DISCONNECTED` list; server 410 in bind.ts; a route-usage check of the kept screens | a generated 410 test per namespace; golden batches; gmp-batches and library-dc E2E |
| D2 | web: home and menus from the kept list; "not part of Batchwright" page | home-tiles test per role; E2E |
| D3 | new home: four work cards with counts, the to-sign list, the admin card | web tests; E2E updated selectors; screenshot strip for the owner |
| D4 | data references: deviation routes refused on the platform (exception keeps `deviation_ref`); the notes for MMS, Logbook, Qual and QMS views recorded as residuals for when those views exist | server tests by control ID |
| later | delete the dead code per area, after the owner's keep decision | CI green per area |

**Owner decisions (5 November 2026, through the lead; plan approved):**
1. Records and amendments: KEEP.
2. Formulary: Batchwright's.
3. Penicillin and beta-lactam rules: DISCONNECTED, the whole `plantRules` namespace (owner, 5 November, overriding the
   earlier KEEP and the lead's route-by-route proposal). **Risk accepted by the owner:** the beta-lactam classifications
   and penicillin-facility rules already recorded stay in force, and the segregation check at batch issue (recipe-core
   1655, PR-27, IN-27) still runs in the database on them. While the namespace is disconnected, no new product or
   material can be classified and no facility rule can be changed. A new beta-lactam product would then not be held to
   its dedicated rooms and lines by the system. The owner reconnects `plantRules` (one line in `disconnected.ts`)
   before such a product is introduced. Controls PR-27 and IN-27 are not changed.
   The owner's words (5 November 2026): "new beta-lactam products cannot be classified while disconnected, so the
   segregation check will not see them; the owner accepts this until the function is reconnected or moved (later)".
   The routes' code and tables stay, so reconnecting is a one-line change in `DISCONNECTED`.
4. QP batch packages: LATER, so disconnected now (EU exports only).

## 7. Residuals (slice D4)

Data that another product owns and that Batchwright still answers from its own tables until that product publishes a
view (section 2). Each is a residual for when the view exists; no code changes now, and no control changes.

| ID | Owner | What Batchwright does now | When the owner's view is published |
|---|---|---|---|
| D4-R1 | MMS | Material lot identity and status (`site.material_lot*`, locations, finished, returned and reagent lots) are answered by Batchwright's own tables; about 40 foreign keys point at `material_lot`. The batch's reservation and consumption stay Batchwright's (they are part of the record). | Read lot identity and status from MMS's view; a reference-only change in its own slice. |
| D4-R2 | Logbook | Equipment clean status (`plant.*`, recipe-core 0400, 0460, 0950) is answered by the current tables; `equipment_use` and `step_equipment` stay (batch context). | Read clean status from Logbook's view. |
| D4-R3 | Qual | Person qualification (`iam.person_qualification*`, kernel 0130) is a mirror with a heartbeat; the signing check reads it. | Read Qual's view; the signing check stays. |
| D4-R4 | QMS | Release's check "no open CAPA on this batch" reads Batchwright's own CAPA tables (site-services 0925); the CAPA routes are disconnected (D1). | Read QMS's published CAPA view in the release check. |
| D4-R5 | Deviations | The full deviation routes are disconnected (D4: detail, reclassify, impact, closure basis, record, investigation, finding, cancel). Kept connected: raise and link (an exception's or OOS result's reference is checked by the database against a record linked to the batch, PR-49, IN-20), the batch's list and the release checklist. Lead decision (5 November, option A): the investigation and its finding (`startInvestigation`, `recordFinding`) stay connected, only so far as invalidating a result for a laboratory error and reprocessing need a QA-concluded deviation record, until Deviations publishes its view. Slice D4b: the database concludes only a record whose impact is assessed and whose closure basis is recorded (site.conclude_deviation), so the record's detail, its impact and its closure basis stay connected too; the web opens them only as one lot's OOS record from its lot page (`/quality/lots/$lotId/oos/$deviationId`: investigation, finding, impact, closure basis, QA's signed impact assessment and conclusion). The deviation list and the full deviation screens stay off; reclassify, cancel and the lite record stay disconnected. | Check references against Deviations' view; take the conclusion for invalidation and reprocessing from it. **Replaced (9 November 2026) by MEDHANTA slice 2:** with a Deviations link a batch's deviation is its Deviations number and release reads `report.deviation_v1` (tablets 1907); the conclusion for invalidation and reprocessing stays as residual DV-R1. |
