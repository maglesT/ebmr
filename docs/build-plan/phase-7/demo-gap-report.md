# Batchwright Tablets v1.0.0-rc.1: acts without a screen, and other gaps

**For:** the development sessions working in the git repository.
**From:** a review of the hosted demo (https://187-126-126-5.sslip.io) and of the code deployed there (`/opt/batchwright`, the `deploy/demo-server` tree, v1.0.0-rc.1), 19–20 October 2026.
**Why it matters:** owner decision 0025 says every act a person performs has a screen in the web app at v1.0, so that nobody has to use a terminal. That is not true yet. The main consequence is that **a GMP batch cannot be run on the kiosks from its first step to its packaging**, and **a new master record cannot be taken from draft to approved** through the product.

## How this was found and checked

1. The owner wanted to demo a full GMP batch with packaging. The only full GMP batch in the system is the one the demo data load builds (`apps/tablets-server/src/cli/release-path.ts`, the `--gmp-packaging` option). It performs many acts by calling database functions directly (`app.dbAs(..., 'select plant.xxx(...)')`) instead of through the API.
2. Every database function that `apps/tablets-server/src/cli/*.ts`, `tools/e2e/specs/**` and `tools/e2e/fixtures/**` call directly was listed (46 functions). For each one I checked whether any server feature outside `cli/`, the seeds and the tests references it (i.e. whether an API route exists), and whether the web app calls that route.
3. Where a screen might reach the act under another name, the screen's API calls were read (for example `DevicesPage.tsx` calls `routes.deviceRegistry.registerTerminal`, so device registration is covered).
4. The browser suite (75 tests) passed on this code on 19 October 2026, on a separate PostgreSQL cluster.

"No route" below means: no API route, and therefore no screen, can perform the act. Each item names the database function and where the demo load or a test calls it.

## A. Critical: a GMP batch cannot pass its steps on screen

The step screen (`/runs/$runId/steps/$stepKey`) shows forms for these entries (`features/floor/renderers/block-entry.tsx`, `renderers/tablets.tsx`), but each entry needs an identifier (`occupancyId`, `useId`, `inspectionId`, `issueId`, `chargeId`) that only a no-route act produces. No web file contains `occupancyId`. **The first room clearance step of any GMP batch therefore cannot be completed from screens.**

| # | Act a person performs | Database function(s), no route | Used by the demo load | Blocks step(s) |
|---|---|---|---|---|
| A1 | Reserve material lots for a batch (stores) | `site.reserve_lot` (the web can only cancel a reservation: `quality/LotHandling.tsx`) | release-path.ts, batch section | Dispensing (lots must be reserved) |
| A2 | Start and end the use of a room by a batch (area occupancy) | `plant.start_area_occupancy`, `plant.end_area_occupancy` | release-path.ts `clearAndOccupy`, `end` | Every room clearance step (`p-disp-clear@`, `p-blend-clear@`, `p-comp-clear@`) and the packing-line clearance of every packaging order |
| A3 | Per-use check and booking of a balance or instrument | `plant.record_instrument_check`, `plant.record_instrument_use` | release-path.ts `instrumentUse` | Every equipment-status step (`p-*-status@`) |
| A4 | Start and end the use of equipment (blender, press, filler, cartoner) | `plant.start_equipment_use`, `plant.end_equipment_use` | release-path.ts `unitUse`, `end` | Equipment-status steps, press set-up |
| A5 | Charge a container into equipment (blend into the press hopper) | `plant.charge_container` | release-path.ts (`HOPPER_CHARGE`) | Press set-up (`p-setup@`) |
| A6 | Inspect, issue and return press tooling (punches and dies) | `tab.inspect_tooling`, `tab.issue_tooling`, `tab.return_tooling` (the only tooling screen defines tooling sets in master data) | release-path.ts compression | `p-tool@`, `p-setup@`, `p-tool-ret@` |
| A7 | Configure the press discharge | `plant.configure_press_discharge` | demo load | Compression (to confirm with the block spec) |
| A8 | Record an in-process check on equipment (IPC that can hold a container) | `plant.record_ipc_check` | review-batch.ts | Compression IPC and container hold (to confirm whether the step screen's IPC entry covers it) |
| A9 | Record a calibration | `plant.record_calibration` (master data only marks "Calibration required") | demo load | Balance and instrument checks that need a current calibration |

**What works on screen today** (verified in the web code): planning and issue (`/planning`, "Sign and issue"), cleaning and clearance with their verification (`/plant`), manual two-person weighing and output-container entries, blend and press entries (BLEND_*, PRESS_SETUP, PRE_USE_CHECKLIST, FIRST_OFF, RUN_*, STATION_SWEEP, WEIGHT_CHECK), exceptions, hold points (H-PACK), stage sign-off, container open/close/verify/release (`/review/$batchId/containers`), packaging order issue and bulk issue (`/planning/packaging/$batchId`), SSCC issue on TB-24, coding and label specimens and post-use inspection (`/labels/packaging/$batchId`), posting the finished lot, QC results and approval and reserve samples (`/quality/lots/$lotId`), specifications, deviations, production approval, register, audit-trail review and QA review (`/review/$batchId`), release.

**Needed:** for A1–A9, an API route (contract in `packages/api-contract`) and a screen, at the place the person does the act. The natural place for A2–A6 is the step screen of the step that needs the identifier ("Start using this room", "Book the balance", "Book the blender", "Charge container …", "Inspect and issue tooling"), so that the operator never sees an identifier. A1 belongs on the stores side of `/quality/lots/$lotId` or the batch, A9 on `/plant`. The database functions already exist and enforce the rules: only the route, its attribution (badge tap on a kiosk), and the screen are missing. Tests carry the control IDs of the functions' controls.

## B. Critical: a new master record cannot be approved through the product

The four life-cycle signatures and the market authorisations **do** have a screen (`/mbr/versions/$versionId/signing`, `MbrSigningPage.tsx`, spec `tools/e2e/specs/phase7/master-records.spec.ts`, which passes). But before **Start verification…** succeeds, a draft needs records that no route can make. The spec records them directly in the database (`tools/e2e/specs/phase7/support.ts`, `prepareForVerification`, whose header says "the arrangements no screen makes yet").

| # | Act | Database function(s), no route | Notes |
|---|---|---|---|
| B1 | Raise the master-record change record (change control of an MBR) | `recipe.record_change_record` | `/mbr/change-records` (`master-records/ChangeRecordsPage.tsx`) only lists change records and adds validation and regulatory assessments to them; it cannot raise one |
| B2 | Record a risk assessment and link it to a draft | `recipe.record_risk_assessment`, `recipe.link_risk_assessment` | `/mbr/versions/$versionId/review` (`VersionReviewPage.tsx`) can only **unlink** one |
| B3 | Set the draft's attributes (its change record, effective-from, review due) | `recipe.set_draft_attributes` | |
| B4 | Record the verification evidence: validator report, verification seal, test vectors, **sandbox run** | `recipe.record_evidence` | The GMP designer validates and simulates, and the sandbox runs the test batch, but nothing turns those results into evidence on the GMP version. The exchange folder `to-gmp` is created by the set-up (`cli/installation.ts:184`) but no server code reads it: **the return of the sandbox test run's evidence to GMP is missing**. Decide which evidence is produced automatically (validator and simulation on GMP; the sandbox run's result package from the sandbox, hash-checked as the outbound package is) and which a person records |

**Needed:** routes and screens for B1–B3; for B4, the designer's own validation and simulation reports recorded as evidence when the author starts verification, and a sandbox-to-GMP **test-run result package** (export on the sandbox's run page, import on GMP, hash and GMP-stamp checks mirroring the outbound package, INV-18, DI-05). Then a browser test that takes a **new** draft from the template through sandbox run, verification, the four signatures and a market authorisation, with no database arrangement.

## C. Master-data and configuration acts without a route

| # | Act | Database function, no route | Where it would belong |
|---|---|---|---|
| C1 | Define a batch-number rule | `site.define_batch_number_rule` (`/planning/batch-numbers` registers, voids and recovers numbers only) | `/planning/batch-numbers` |
| C2 | Record a reference document (computerised system, equipment class, hold study…) | `tab.record_reference_document` (`designer/ReferenceDocuments.tsx` lists and retires only) | `/mbr` reference documents |
| C3 | Register an EU importer (the EU QP register) | `recipe.register_eu_importer` (`/qp-register`, `market/QpRegisterPage.tsx`, is read-only) | `/qp-register` |
| C4 | Define a plant product | `plant.define_product` | to confirm: whether products only come from the ERP; if a person defines them, master data |
| C5 | Change a platform setting | `platform.set_setting` | to confirm: whether every setting is covered by a screen through another route (site values have one) |

Helpers the scan also found and that are **not** person acts (no screen needed): `recipe.json_hash`, `recipe.content_hash_of`, `tab.aggregate_read_class`, `tab.printed_lot_facts`, `platform.create_aggregate_state`, `tab.mark_demo_installation`, `iam.issue_setup_token` (first-run set-up), `iam.end_session` (test).

## D. The guard that should have caught this, and the tests that are missing

| # | Gap | Evidence | Needed |
|---|---|---|---|
| D1 | The decision-0025 meta test exempts exactly the files that perform these acts | `apps/tablets-web/test/meta/commands-have-screens.test.ts:103-106` exempts `cli/release-path.ts`, `cli/line-completion.ts`, `cli/review-batch.ts`, `cli/demo-app.ts` as "library of the demo data load" | The meta test checks that every database function a **person** act calls (in the demo load, the golden batches and the e2e arrangements) is reachable through an API route the web app calls; a list of allowed exceptions only for non-person helpers, each with a reason |
| D2 | No browser test runs a GMP batch on the kiosks | `floor/`, `phase6/english-step`, `journey/fcv` use sandbox TEST- batches (the dc-mini template); `floor-tablets/void.spec.ts` mocks the batch; `planning/packaging-order.spec.ts` stops at the bulk issue | A browser test (tagged `@kiosk`/`@office`, control IDs in the name) that plans and issues a GB-T-02 batch and runs **every step** on the GMP kiosks (DISP-1, BLEND-1, COMP-1) through compression and H-PACK, then a bottle packaging order on KIOSK-PACK-1 to its end, posts the lot, records QC results and samples, reviews and releases it, with **no database arrangement** in the spec |
| D3 | No browser test takes a new master record to approval | `phase7/master-records.spec.ts` arranges B1–B4 in the database | See section B |
| D4 | The admin guide's known-issues page is out of date | `docs/guides/admin-guide/12-known-issues.md` "No screen yet" still lists people, devices and MBR signatures, which now have screens, and does not list A, B and C | Regenerate it from the real gaps |

## E. Demo and deployment gaps

| # | Gap | Detail |
|---|---|---|
| E1 | `pnpm demo:setup` cannot load the GMP sample records | `tools/demo/src/cli.ts` calls `setupStack` without `gmpReviewBatch`/`gmpPackaging`, so a reset leaves GMP with no approved master, batch or lot. On the hosted demo a one-off script (`/home/batchwright/seed-demo.mts`) and `/usr/local/bin/batchwright-demo-reset` now pass both options. Add a flag, e.g. `pnpm demo:setup --with-gmp-samples`, and make the hosted demo use it |
| E2 | `docs/operations/hosted-demo.md` describes the reset without the sample records | Update it with E1, the reset time (about 11 minutes with the samples) and clearing the browsers' site data after a reset |
| E3 | GMP has no simulated balance or gateway | The scale simulator and the gateway serve the sandbox only (`tools/demo/src/stack.ts`); every GMP weighing is the manual two-person path, and the manual form never sends a `deviceCode` (`floor/renderers/parts.tsx:457`). For a demo of the real installation, a GMP gateway with a simulated balance per room |
| E4 | The scale simulator console cannot be reached on the hosted demo | It listens on 127.0.0.1:4002; presenters need an SSH tunnel. Serve it (DEMO-ONLY) behind the proxy, or drive the simulators from the Operations screen, which already drives the integration simulators |
| E5 | Roles with nobody seeded | No persona holds CSV_DI_LEAD, DISPENSER, STAGE_RESPONSIBLE or EU_QP_READER on GMP (and none of the CONTROLLED.* roles), so their screens can only be shown as refusals. The administrator and process owner (`demo.admin`, `demo.owner`) exist but are not on the printed credential card |
| E6 | Shared rate limits behind the proxy | Behind Caddy every request comes from 127.0.0.1, so per-address limits are shared by all visitors (known; the trusted-proxy setting of decision 0021 is still optional) |

## F. Smaller observations (no defect proven)

| # | Observation |
|---|---|
| F1 | The office home screen links to every screen for every role; most roles get 15–20 links that end in a refusal (EBMR-IAM-040). Consider hiding or marking tiles the role cannot use (the server stays the authority) |
| F2 | On a kiosk, read-only screens the operator may not use answer 428 "Tap your badge to confirm it is you" (EBMR-IAM-120) before the permission refusal (QP packages, archive inspection, analytics, contract giver, India register). The fresh-authentication check seems to run before the permission check on these reads; worth confirming the order is intended |
| F3 | One "404 Not Found" page at `/config/change-records` for one persona during a sweep of 1,216 page loads; it did not reproduce and the service log shows nothing |

## Rules for the fix (from the repository's CLAUDE.md)

- Work on a branch; keep the boundaries in `.dependency-cruiser.cjs` and the exact `workspace:<version>` pins; run `pnpm run ci` before pushing; update `PROGRESS.md` at the milestone.
- Never weaken a control: the database functions above already enforce their rules (segregation, attribution, state); the new routes call them, they do not re-implement or loosen them. A kiosk route is attributed by a fresh badge tap (INV-40).
- Tests that prove a control carry its ID in the name (`[DI-xx]`, `[INV-xx]`, …); one review pass per feature (decision 0008).
- When this is merged and deployed to the hosted demo, the demo guide's full-batch act is written from a rehearsal of D2 on the live demo.
