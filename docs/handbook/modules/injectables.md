# injectables: the Injectables edition (placeholders)

**Draft.** This page is still being written; facts on it were checked against the code on 14 October 2026.

This page explains the two placeholder apps of the Injectables edition, `apps/injectables-server` and
`apps/injectables-web`, what the edition will add when it is built, and the **extension points** the shared code keeps
open for it today. Read it before you change a shared package (kernel, site-services, recipe-core, expr, ui-kit,
integration-sdk): a review of such a change asks whether these points stay open. Pharma terms are in the
[glossary](../02-glossary.md).

## Where the code is

| What | Where |
|---|---|
| Injectables server (identity only) | [apps/injectables-server/src/index.ts](../../../apps/injectables-server/src/index.ts#sym=PACKAGE) |
| Injectables web app (identity only) | [apps/injectables-web/src/index.ts](../../../apps/injectables-web/src/index.ts#sym=PACKAGE) |
| Their tests (package identity) | [injectables-server/test](../../../apps/injectables-server/test/package.test.ts), [injectables-web/test](../../../apps/injectables-web/test/package.test.ts) |
| The decision to build Tablets to v1.0 first | [decision 0010](../../decisions/0010-tablets-to-v1-then-injectables.md) (confirms [0002](../../decisions/0002-tablets-first-injectables-deferred.md)) |
| Two editions, separate databases, shared site services | [ADR 0001](../../adr/0001-two-editions-separate-databases-shared-site-services.md) |
| recipe-core shared between editions | [ADR 0011](../../adr/0011-recipe-core-shared-between-editions.md) |
| Which editions the trace gate covers | [compliance/phase.yaml](../../../compliance/phase.yaml) |

## What it does today

Nothing yet. Each app exports only its package identity and `BUILT_AGAINST`, the exact versions of the shared
packages it was built against ([ADR 0015](../../adr/0015-exactly-pinned-shared-packages.md)). The server already
depends on kernel, site-services, expr, recipe-core and integration-sdk; the web app on ui-kit (through
`@ebmr/ui-kit/package`, the identity alone, so the skeleton needs no browser set-up). Each has a `[meta]` test that the
identity is right. The apps exist so that the dependency boundaries, the exact pins and the CI checks cover both
editions from the start: a shared-package change that would break the Injectables wiring fails now, not in Phase 5.

## The edition's database migrations (editions/injectables/sql)

The edition is data on the shared kernel (library blocks, formulations, masters); its own migrations are few:

- 3000: a packaging record of the edition ends with the finished-pack examination, and the release gate G-REL has the
  edition's items (printed materials and yields reconciled, held containers, rule sets, and `E.PACK_EXAMINATION`).
- 3020: `E.PACK_EXAMINATION` takes every step that completes the packaging record (recipe-core 1892: a listed block or a
  library block with the role `PACK_EXAMINATION`), not only the catalogue block INJ-PACK-EXAM. An examination that ran
  and is not completed is red; a failed one stays red until each critical breach or unexpected answer of the step is
  dispositioned and its deviation closed (21 CFR 211.134(b), (c)).

## Pharma context: why a second edition

Injectables are sterile medicines given by injection (vials, ampoules, prefilled syringes). They follow the same data
integrity and release rules as tablets, plus a large body of **sterile manufacturing** rules: clean-area grades (A to
D) with particle and microbial limits, environmental monitoring (EM) data in the batch record, aseptic process
simulation (media fills), sterilisation cycles (autoclaves, dry heat), sterile filtration with integrity tests,
lyophilisation (freeze-drying), maximum hold times between steps, 100 % visual inspection, container closure integrity
(EU GMP Annex 1; India Revised Schedule M Part XIII for parenterals; FDA's aseptic processing guidance).

The register holds these as controls `ST-01` to `ST-79` (sterile) and `IN-40` to `IN-51` (India parenterals), 91
controls whose only edition is `injectables`, all with target phase 5. Example: [IN-40](../../../compliance/controls/IN-40.yaml)
clean-area grades, particle limits and airflow; [IN-47](../../../compliance/controls/IN-47.yaml) sterilisation cycle
records and revalidation.

## The build order (decision 0010)

The outline's Phase 5 is the Injectables edition (about 22 % of the work). Decision 0010 moved it: Tablets goes
through Phase 6 (integrations) and Phase 7 (validation pack, hardening) to **Tablets v1.0 first**; Injectables is built
after that as its own release, with its own integration and validation pass. Reasons: a validated Tablets product
reaches sites sooner, and the riskiest part is built on a core already proven in use.

### What Phase 5 will add

From the outline's phase plan (section 11, Phase 5; search for "Phase 5, Injectables edition"):

- the Injectables blocks **IB-01 to IB-30** (the Tablets edition has TB-01 to TB-24);
- the clean-area hierarchy, EM linkage to the batch, trends and completeness;
- sterilisers, filter trains, technology profiles, intervention catalogues with a path for an unlisted intervention
  that needs real-time QA authorisation;
- the aseptic process simulation (APS, media fill) status, envelope and record machines;
- sterile hold timers, the sterility dossier and timeline;
- sterility-assurance investigations kept out of the PR-53 justification path;
- simulators for EMS/BMS (environmental and building monitoring), autoclave, lyophiliser, particle counter and access
  control;
- `apps/injectables-server` (with its own `inj` schema) and `apps/injectables-web` (its own screens and designer
  palette), each with its own GMP and sandbox databases ([ADR 0001](../../adr/0001-two-editions-separate-databases-shared-site-services.md)).

Exit: invariants INV-23, 36, 37, 44, 45 and every ST and IN-40 to IN-51 control proven by named tests.

## Extension points kept open

Shared code is written **edition-neutral**. These are the places where Injectables will plug in; keep them open. The
list in [Architecture, section 15](../03-architecture.md#15-editions-and-the-injectables-extension-points) is the
short form.

| Extension point | Where it is today | What Injectables adds |
|---|---|---|
| An `edition` on every MBR family | `recipe.mbr_family` column `edition` checked to `tablets` or `injectables` ([0110_mbr_family_version.sql](../../../packages/recipe-core/sql/0110_mbr_family_version.sql)); `Edition` in [flow/model.ts](../../../packages/recipe-core/src/flow/model.ts#sym=Edition) | Injectables MBRs |
| Edition of a lot reservation | `site.lot_reservation.edition` checked to `TABLETS` or `INJECTABLES` in [0710_material_lots.sql](../../../packages/site-services/sql/0710_material_lots.sql) | lots reserved by sterile batches, one lot status per site |
| Block registry and catalogue | each block version names its `edition` (`generic`, `tablets`, `injectables`) and its aliases ([BlockVersion](../../../packages/recipe-core/src/blocks/contract.ts#sym=BlockVersion)); generic blocks list their Injectables alias (G-06 is `KB-03`); editions extend the generic catalogue with [createBlockCatalog](../../../packages/recipe-core/src/flow/blocks.ts#sym=createBlockCatalog), as Tablets does in [edition-blocks.ts](../../../apps/tablets-server/src/features/edition-blocks.ts#sym=tabletsBlockCatalog) | IB-01 to IB-30; a designer palette with only its own blocks |
| Generic guards stay in recipe-core | [ADR 0019](../../adr/0019-generic-block-guards-in-recipe-core.md) | Injectables reuses them; it does not copy them |
| Market rule tables | `market.rule_table` rows `kernel`, `tablets`, `sterile` ([0300_market_rule_model.sql](../../../packages/kernel/sql/0300_market_rule_model.sql)); a key of the `tablets` table is refused for an injectables scope and a `sterile` key for a tablets scope (`EBMR-MKT-054`, [0330_market_evaluations.sql](../../../packages/kernel/sql/0330_market_evaluations.sql)); the scope's `edition` in [market/context.ts](../../../packages/kernel/src/market/context.ts) | `sterile.*` keys; a sterile change never creates change-control work for Tablets |
| Platform scope hook | [platform.scope_of](../../../packages/kernel/sql/1150_platform_scope_hook.sql#sym=platform.scope_of) ([ADR 0018](../../adr/0018-platform-scope-hook.md)) | product or area scope for sterile permissions |
| Plant equipment states | plant machines are versioned, so a new state is a new machine version | DRIED, STERILISED, clean-area grades, sterile hold timers |
| Late-entry window | kernel policy `time.late_entry_window_min`, the injectables default of 15 minutes ([0500_platform_base.sql](../../../packages/kernel/sql/0500_platform_base.sql)) | the sterile late-entry rule |
| Calculation library | deferred functions (F0 lethality, fill volume and weight, filled units) named in [expr library](../../../packages/expr/src/library/index.ts) | the sterile calculations |
| Shared site data | site-services (persons, training, lots, batch numbers, devices) shared by both editions ([ADR 0001](../../adr/0001-two-editions-separate-databases-shared-site-services.md)) | a lot rejected in one edition is unusable in the other; batch numbers unique across both |
| Device contracts and gateway | edition-agnostic [integration-sdk](integrations.md) and site gateway | OPC UA, EMS, autoclave and lyophiliser feeds |

> **Why this exists** (the edition checks on market rule keys)
> - **Pharma reason:** a GMP customer validates exactly what it runs. A rule written for sterile products must never
>   change a Tablets batch, or every sterile change would force a Tablets revalidation (and the reverse).
> - **Control:** the market engine's separation ([ADR 0008](../../adr/0008-market-profile-engine-atomic-keys-stored-resolutions.md));
>   lesson L-57 of the outline.
> - **Code:** the `EBMR-MKT-054` check in [0330_market_evaluations.sql](../../../packages/kernel/sql/0330_market_evaluations.sql),
>   the rule tables in [0300_market_rule_model.sql](../../../packages/kernel/sql/0300_market_rule_model.sql).
> - **Tests:** the kernel market tests ([packages/kernel/test/market/](../../../packages/kernel/test/market/)).
> - **Error:** `EBMR-MKT-054`.

## The editions filter of the trace gate

The trace (`pnpm trace`, [tools, tools-register](tools.md#tools-register-the-control-register)) fails CI when a
control due by the current phase has no passing test. Raising `current_phase` to 5 or more for Tablets Phases 6 and 7
would make the 91 injectables-only controls due, although nobody is building them. So
[phase.yaml](../../../compliance/phase.yaml) lists the editions the gate covers:

```yaml
current_phase: 4
editions:
  - tablets
```

A control is due only when one of its editions is listed; controls shared by both editions are always due. The
register code reads the list with [gateEditions](../../../tools/register/src/register.ts#sym=gateEditions) and
[buildTrace](../../../tools/register/src/trace.ts#sym=buildTrace) applies it. **No control file and no
`expert_decision` changes**: the filter only decides when a control is due.

Tests in [register.test.ts](../../../tools/register/test/register.test.ts): `[meta] with the gate on tablets, an
injectables-only control at a started phase is not due, while a shared control still is`; `[meta] phase.yaml lists
the editions: absent means both, an empty list or an unknown edition is refused`; `[meta] every control due by phase 4
belongs to the tablets edition, so the filter changes nothing before the Phase 6 raise`.

When the Injectables edition starts: add `injectables` to `editions`.

## How to test it

`pnpm vitest run --project db apps/injectables-server apps/injectables-web` runs the two `[meta]` identity tests.
`pnpm deps:check` and `pnpm pins:check` check their dependencies and exact `workspace:0.1.0` pins with the rest.

## Pitfalls

- **Do not put a Tablets-only rule in a shared package.** It belongs in `apps/tablets-server` (the `tab` schema, the TB
  blocks) or in the `tablets` market rule table. A generic guard belongs in recipe-core (ADR 0019).
- **Do not close an edition check.** A `check (edition in ('tablets'))` or an enum without `injectables` would block
  the edition later.
- **Do not hard-code equipment states.** Add a new plant machine version.
- **Do not remove the placeholder apps** to save CI time: they keep the boundaries and pins honest.

## Differences between the code and the docs (14 October 2026)

- [ADR 0001](../../adr/0001-two-editions-separate-databases-shared-site-services.md) describes a separate
  site-services database per site (`ebmr_site`) with reservations; today the `site` schema is migrated into each
  edition database ([editionMigrationSources](../../../packages/test-kit/src/db.ts#sym=editionMigrationSources);
  also noted in [Architecture, schemas](../03-architecture.md#44-schemas)). The split matters first when both editions
  run on one site.
- The edition is spelt in upper case in `site.lot_reservation` (site-services 0710: `TABLETS`, `INJECTABLES`) and in
  lower case in `recipe.mbr_family` (recipe-core 0110: `tablets`, `injectables`). Code that compares them must map one
  to the other.

## Related pages

- [Architecture, editions and the Injectables extension points](../03-architecture.md#15-editions-and-the-injectables-extension-points).
- [recipe-core](recipe-core.md) (the block registry), [kernel](kernel.md) (market rules, scope hook),
  [tools](tools.md) (the register and the trace gate).
- Generated: [code map](../code-map.md#injectables-server).
