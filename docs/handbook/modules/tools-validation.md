# tools-validation: the evidence bundle, the pack, the IQ and the OQ

**Draft.** This page is still being written; facts on it were checked against the code on 18 October 2026 (Phase 7
slice 7c).

This page explains `tools/validation`: the commands that build the evidence bundle from a run and a migrated
database, write the validation pack, and qualify an installation (IQ and OQ). It also covers `register:status`, which
sets the controls' build status from a bundle. Read it before you run the pack for a release. The generators
themselves are in [validation-kit](validation-kit.md).

## Where the code is

| What | Where |
|---|---|
| The commands | [src/cli.ts](../../../tools/validation/src/cli.ts) |
| The release from the files (ledger, schema release, version, commit) | [src/sources.ts](../../../tools/validation/src/sources.ts) |
| The inventory of a database and of the code | [src/inventory.ts](../../../tools/validation/src/inventory.ts) |
| Runs and results from the test reports | [src/reports.ts](../../../tools/validation/src/reports.ts) |
| The bundle | [src/bundle.ts](../../../tools/validation/src/bundle.ts) |
| The SBOM (CycloneDX 1.5) | [src/sbom.ts](../../../tools/validation/src/sbom.ts) |
| The IQ script | [src/iq.ts](../../../tools/validation/src/iq.ts) |
| The OQ script | [src/oq.ts](../../../tools/validation/src/oq.ts) |
| The build-status rule (D-P7-2) | [tools/register/src/build-status.ts](../../../tools/register/src/build-status.ts) |
| Tests | [test/validation.test.ts](../../../tools/validation/test/validation.test.ts), [build-status.test.ts](../../../tools/register/test/build-status.test.ts) |

## The commands

| Command | Does |
|---|---|
| `pnpm validation:bundle --results .reports --db <url> [--records <dir>] --out .reports/validation/bundle.json` | the bundle, and the SBOM beside it (`sbom.cdx.json`) |
| `pnpm validation:generate --bundle <file> [--previous <file>] --out .reports/validation/pack` | the pack: a `.md` and an `.html` per document, and `manifest.json` |
| `pnpm validation:iq --db <url> --server <url> --bundle <file> [--out <file>]` | the IQ checks; writes the IQ record; exit 1 when a check fails |
| `pnpm validation:oq --server <url> [--no-run] [--out <file>]` | runs the suites, then writes the OQ record from their reports |
| `pnpm validation:stamp <report>...` | writes each report's stamp, `<report>.stamp.json` (commit, clean or not, SHA-256) |
| `pnpm register:status --bundle <file>` | sets each control's `build_status` by D-P7-2 (only that field) |

- The database is opened read only (`default_transaction_read_only=on`, and each read in a READ ONLY transaction): the
  bundle and the IQ never write to an installation.
- `validation:bundle` refuses a database whose `platform.schema_release()` differs from the release's files: migrate it
  to the release first.
- The bundle carries no time of its own: run times come from the reports, the commit time from git.
- A report counts only with its stamp (R3-VAL-2): written for its bytes, on the bundle's commit, from a clean tree.
  `pnpm test:json`, the OQ suites and CI (the report and end-to-end report jobs) stamp the reports they write;
  `validation:bundle` and `validation:oq` refuse a report without a stamp, of another commit, of a working tree with
  changes, or written again after its stamp, and name it.
- A record of `--records <dir>` is a JSON file with `kind` (load, soak, restore, ..., iq, oq), `passed`, `summary` and
  `measures`; the IQ and OQ records are written in that shape, so the bundle can be built again with them.
- The pack is not committed (D-P7-13). The release candidate's pack and bundle go to the branch `phase-7/rc-evidence`.

## The inventory

From `pg_catalog` and the kernel's registries: migrations (the ledger), functions with SECURITY DEFINER, owner and
EXECUTE grants, triggers, constraints (definition hashed), table privileges, the `ebmr_*` roles, the locked and recorded
settings, audited tables, permissions with their roles, signature meanings, the published state machines, block
types, rule keys. From the code: the message catalogue (each `EBMR-*` code once, with the text of its first
occurrence in the SQL and source files) and every route of the API contract. The analytics methods come from the
runner's catalogue (`catalogMethods`), with the effective versions the database holds.

## The IQ checks

The checks are named in the validation kit (`IQ_CHECKS`), so the protocol and the script agree:

| Check | Fails when |
|---|---|
| IQ-01 release identity | `platform.schema_release()` is not the bundle's |
| IQ-02 migrations | a migration of the release is missing or changed, or one is not of the release |
| IQ-03 package versions | the server's `/api/meta` version or edition differs (no `--server`: not checked, so failed) |
| IQ-04 triggers | a trigger of the release is missing, changed or disabled |
| IQ-05 constraints | a constraint is missing or its definition changed |
| IQ-06 privileges | a privilege of the release is missing, or an application role holds one more |
| IQ-07 SECURITY DEFINER functions | a function is missing, or its definer flag or EXECUTE grants changed |
| IQ-08 roles | an application role is a superuser, may create roles or bypasses row security |
| IQ-09 locked settings | a DEMO-ONLY seal key is active, the database is marked demo, the server offers the demo picker or is plain HTTP off loopback, or a locked PostgreSQL setting (TLS, SCRAM) differs |
| IQ-10 adapters | an active integration adapter is not in the approved system description (DI-06) |
| IQ-11 installation kind | the database is not marked GMP |

The test proves a correct installation passes all eleven and that a dropped trigger, a revoked privilege and a
DEMO-ONLY key each fail by name.

## The build statuses (D-P7-2)

`register:status` computes each status from a bundle:

- **SPECIFIED** while a clause has no listed test that passed, or anything is deferred.
- **IMPLEMENTED** when every clause has a passing listed test and nothing is deferred.
- **VERIFIED** when, in addition, every listed test of every clause passed on the bundle's commit in a run with a report
  hash and none failed; a review pass covers its implementing files (or, when it names none, its test files: D-P7c-3);
  no open critical or high finding names it; a core-class control has a database test; each critical limit of it has
  its boundary tests listed; and it is not a status-U draft.

`register:validate` refuses a VERIFIED the rule does not allow: without a bundle, the part the files show (deferrals,
drafts, the database test, the boundary tests, open findings, review coverage); with `--bundle <file>`, the whole rule.
VERIFIED is never set by hand. `register:status` runs for real only in slice 7f, on the release candidate's bundle.

## How to test it

`pnpm vitest run tools/validation tools/register/test/build-status.test.ts` (the first migrates a database of its own:
set `EBMR_PG_ADMIN_URL` to your cluster).

## Pitfalls

- A test cluster runs without TLS: the test passes its own settings as the locked ones. A real installation keeps the
  release's (`ssl=on`, `password_encryption=scram-sha-256`).
- The OQ runs the suites as CI does; running the browser suite against an already running customer server is not built
  yet (a residual for slice 7f).

## Related pages

- [validation-kit](validation-kit.md), [tools](tools.md).
- [06-testing-and-debugging](../06-testing-and-debugging.md#generating-the-validation-pack).
- [10-runbooks](../10-runbooks.md#validation-summary-and-system-description-phase-7-slice-7c).
