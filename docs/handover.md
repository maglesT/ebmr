# Batchwright: handover

Written 3 November 2026 at the end of the S11b / v1.0-rc.2 session, for a fresh session. Read with `PROGRESS.md`
(state and rules) and `CLAUDE.md` (hard rules). The MEDHANTA lead is session `session_01PybpFurhHU4ktqworXhVvF`;
report there.

## S11b done → Phase B next

### Where things stand

- **The dynamic library is accepted.** Three very different tablets go from the catalogue to a released lot on screens
  only, with no tablet-specific code. S0 to S11b are on main (PRs #83, #84), as are O-6 (the TB blocks are no longer
  offered for new steps) and the two S11a findings (PR #85).
- **Release review R3 is done** (`docs/build-plan/release-1.0/r3-review.md`; merged in PR #86, 0bb289c):
  - 1 critical, 10 high and 12 medium findings, all fixed with tests; PR #86's CI run 378 was green, every E2E group
    included;
  - 6 low findings listed;
  - R3-APP-2 and R3-ENG-6, found during the fixes, are open for after Phase B.
- **Focused mutation testing (V3) is done** (`docs/build-plan/release-1.0/mutation-results.md`).
- **Branch `standalone` at 0bb289c:** the reviewed standalone baseline and the fallback. The tag
  `batchwright-tablets-v1.0.0-rc.2` belongs on that commit; the session's proxy refused tag pushes, so the owner creates
  it (GitHub Releases, or `git tag -a ... 0bb289c` and push). The live demo code stays frozen; don't touch the server.
- **Owner's order** (decision 0027, amendment of 3 November): Phase B moves Batchwright onto the MEDHANTA platform, and
  all products go live together. R2's bundle part, R4 (guides), R5 (release notes and validation pack) and R6 (final
  run) are done once, on the platform version, which is tagged `v1.0.0`.
- **CI:** GitHub-hosted runners (`CI_RUNNER=github`). The RunPod pod is stopped; ask the owner to restart it for the
  final v1.0 run.

### Phase B recipe (from the lead, 3 November)

- **Read first:**
  - in `maglesT/databsee`: `docs/handover.md`, `docs/05-add-a-product.md` (the recipe, including the mandatory
    write-time active-item check), the decisions and the register;
  - worked examples: MMS (`maglesT/mater-managemen-syst`: docs/06 plan, `db/move-to-platform.ts`, docs/07 runbook) and
    Deviations (`maglesT/dev-mang-modu`).
- **D-11, rewire only:**
  - own database on the shared server;
  - master data (equipment, rooms, instruments, materials, suppliers, products) read through the platform's versioned
    views instead of local copies, with id maps, and product-only fields kept local;
  - core OIDC sign-on, and e-signature re-authentication through core (`prompt=login`, one-use proof);
  - signed records keep their values as at signing (PL-07);
  - the write-time check (PL-08), with "connection off" when the link is cut;
  - the data move with PL-13 counts and checksums. The upgrade drill's dry run (`tools/drills`, hardened in R3) is the
    model.
  - No new features and no rewrites; the block-library engine stays unchanged.
- **Permissions (A10):** one code per action the app checks today, plus a role → codes table. Send the list to the lead
  for approval. No system block on administrators signing.
- **Lessons already learned on the other products:**
  - `0000_platform_defaults` takes back the platform's default grants;
  - a `--link` list for people already in core;
  - a `u` prefix for logins that start with a digit;
  - deactivated or locked people get no codes;
  - the startup audit/integrity row must not break the move's empty-database check;
  - rollback runs `plat stop core` first;
  - COMMIT export in manual compose runs.
- **Links:** Deviations and Operations already expect Batchwright's report views (today through
  `BATCHWRIGHT_REPORT_URL`, switched off on the platform). Publish those views in Batchwright's manifest so they become
  platform links.
- **Domain:** `187-126-126-5.sslip.io` with `proxy: external` (the host's Caddy keeps 80/443 and copies the platform's
  `Caddyfile.host` blocks). The Batchwright demo sits on the bare domain today; propose its platform address in the
  plan.
- **Test data:** the demo company (`databsee` `docs/demo-company.md`: 22 people, tablet-plant master data, 8 tablets
  including rabeprazole). Align Batchwright's demo with those codes.
- **Process:** plan first → lead approval → small slices, tests named by rule ID, CI green, one review, squash-merge. No
  over-engineering. Commit trailers carry no model name.

### Batchwright specifics the move must respect

- Regulated core in the database (decision 0008): audit trail, e-signatures, access, record integrity, trusted time,
  status and release interlocks, limits. Never weaken a control in `compliance/controls/`; tests carry control IDs.
- **E-signature:** the kernel's signing (`packages/kernel`, esig) binds meaning, content hash and re-authentication.
  Replacing the re-authentication with core's one-use proof must keep:
  - the signature manifestation;
  - the signer = actor checks (e.g. `EBMR-LIB-007`);
  - the DI-35 segregation tests.
- **Master data:** plant equipment, the lot register and products feed database guards (e.g.
  `tab.library_smart_problem`, `plant.equipment_fitness`, `recipe.lot_usability_problem`). Read through the platform
  views, the facts those guards check must stay database-side and trusted. Browser-supplied facts stay refused.
- **The library catalogue** loads the Tablets set only (hard capsules deferred).

### Open items carried over

- R3-APP-2: a second formula for the same product, strength and batch size gives a 500 instead of a refusal.
- R3-ENG-6: a STEP_VALUE slot is not checked against the master's steps and fields.
- The low findings in `r3-review.md`.
- R2's bundle part, R4, R5 and R6 on the platform version (decision 0027, amendment).
