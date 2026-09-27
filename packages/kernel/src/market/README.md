# Market-profile engine (`market` schema)

Every batch is made under an Indian licence, so India's Revised Schedule M always applies; a batch
may add the US and/or the EU. This module keeps every market difference as versioned rule data and
resolves, per atomic key, the value that satisfies India and every market in scope, records which
market required it, and stores every resolution. Build outline 3.3, 3.5, 5.8; ADR 0008 (and 0014
for per-market MBR effectivity, which builds on it in Phase 2).

Controls and invariants: **IN-52** (market-profile rule resolution, Phase 1 with stub scopes),
**INV-28** (India in every set; never looser than India), **INV-29** (every evaluation stored),
**INV-47** (no policy loosening reaches a batch issued before it took effect).

## Rule model

- **Rule tables** `kernel`, `tablets`, `sterile` (`market.rule_table`), each versioned on its own
  (L-57). Keys are namespaced `kernel.*`, `tablets.*`, `sterile.*`.
- **Versions** (`market.rule_table_version`): immutable, numbered per table, with a SHA-256 content
  hash, change kind (`INITIAL`, `UPDATE`, `SOURCE_CORRECTION`), change description, citation and
  approver ids (source corrections), and the list of loosenings found against the previous version.
- **Keys** (`market.rule_key`): atomic (one dimension, one unit), with a comparison method:
  `SMALLER_STRICTER`, `LARGER_STRICTER` (decimals), `ORDERED` (categories, least to most strict),
  `REQUIRED_IF_ANY` (booleans), `SET_UNION` (sets of identifiers), `ALL_APPLY` (compendial criteria:
  every criterion applies with its own governing market) and `NOT_COMPARABLE`, which needs a stated
  method (`PER_DESTINATION`: resolved per pack destination with a regulatory decision reference). A
  scalar method on a multi-component value type is refused. `indiaGoverns` says whether India must
  have a value; `predicates` declares the allowed values of each predicate attribute;
  `catalogRefs` cites the India catalog row the value was reviewed against (ADR 0008 decision 12).
- **Rows** (`market.rule_row`): key, market, optional predicate, value, unit, floor type (`HARD`,
  `GUIDANCE`, `EXAMPLE`, `DESIGN`), optional `hardFloor` (the binding value under a non-HARD value),
  source citation, verification status (`P`, `P~`, `S`, `U`, `CHK`, `GK`), effective window
  `[effectiveFrom, effectiveTo)`. Insert-only: a change is a new version with new rows.
- **Values** are JSON without numbers. Decimals are canonical decimal strings (`"7.5"`, never `7.5`
  or `"7.50"`); TypeScript compares them as scaled `bigint`s, SQL as `numeric`.

### Rule-table files

`compliance/rule-tables/<table>/<table>.v<N>.yaml` (or `.json`), one file per version holding the
full table: `table`, `version`, `title`, `change {kind, description, citation?}`, `keys[]`, `rows[]`
with the fields above. Quote every decimal. A published file is frozen: the loader refuses a file
whose content differs from the published version (EBMR-MKT-035). To change a value, add the next
version file with the whole table.

## Resolution

`resolve(snapshot, {key, marketSet, predicates, asOf, stated})` (TypeScript, pure) and
`market.resolve(version, key, markets, predicates, as_of, stated)` (SQL) return the same document:
`value`, `unit`, `governingMarkets`, `floorType`, `hardFloor`, `predicateBranch` (per market),
`contributions` (the row used per market), `components` (per element for sets and criteria),
`tableVersionId`/`tableVersion` and `inputs`. Rules:

1. The market set must contain `IN` (EBMR-MKT-001; INV-28). It is never added silently.
2. Per market the most specific effective row whose predicate matches is used; equal specificity is
   ambiguous and refused. Every predicate attribute an applicable row uses must be supplied
   (EBMR-MKT-042): a missing licence form is refused, not defaulted.
3. A key India governs with no India row on that date is refused (EBMR-MKT-045).
4. The key's method combines the markets' values; the result is checked again to be at least as
   strict as India's (EBMR-MKT-049). Property tests (fast-check) prove INV-28 over the seed tables
   and random tables, and that the two engines agree.

## Scopes and the `ResolutionContextProvider` port

`context.ts` defines the port the editions implement: `scopeContext(scope, table)` returns the market
set, its derivation, the predicates, site and edition of a scope. Scope rules: `PRODUCT` (scope id =
batch id) and `PACK` use the batch's markets; `SITE` its declared markets plus every product
qualified there; `LINE`, `ROOM`, `EQUIPMENT` the union over the products qualified there (a PIC/S
destination counts as EU for `sterile.*` keys); `PERSON` the union over the lines and rooms the
person is qualified for; `MATERIAL_LOT` the consuming batch's set (required). Phase 1 uses
`StubResolutionContext` over the `market.stub_*` tables (`market.scope_markets`); these are stubs and
are replaced when the editions arrive.

## Stored evaluations (INV-29)

`market.evaluation` is insert-only and audited (chain `market_evaluation:<subject id>`). The
application calls `market.evaluate_stub_scope(request)` (TS `evaluateStubScope`), which derives the
scope and calls the owner-only writer `market.record_evaluation`. A BEFORE INSERT trigger recomputes
the resolution from the stored inputs and refuses anything else (EBMR-MKT-053), so not even the owner
can store a value the table does not give. Each row holds value, governing markets, predicate
branch, table version, inputs and their SHA-256, the site value applied and its outcome.
Editions will call `market.record_evaluation` from their own SECURITY DEFINER functions, deriving the
market set from their tables.

## Site values

`market.set_site_value(site, key, value, effective_from, {justificationRef, qaApprovalId})`: site
values only tighten. Looser than a binding value (HARD or a hard floor) is refused (EBMR-MKT-060);
looser than a DESIGN value is refused (061); loosening GUIDANCE or an adopted EXAMPLE needs a
justification (CCS) reference and a QA approval record (065) and is flagged on every evaluation that
uses it (`market.batch_flags(subject)`). Sets accept only supersets (064); NOT_COMPARABLE keys take
no site value (063). At every evaluation the site value is re-assessed; one that a later table has
made inadmissible is not applied and is flagged `SITE_VALUE_INADMISSIBLE`.

## Publishing, source corrections and change impact

`market.publish_rule_table(doc, change)` (TS `publishRuleTable` / `syncRuleTables`) validates the
document (same checks and codes as `validateRuleTableDocument`), requires the next version number,
stores keys and rows, compares the new version with the previous one per market, predicate branch and
date segment, and refuses any loosening that reaches today or earlier unless the version is a
`SOURCE_CORRECTION` with a citation and two distinct approver ids other than the publisher (L-38).
A loosening that starts in the future is allowed and recorded. It then writes
`market.change_impact`: stub MBR limits (`market.stub_mbr_limit`) looser than the new resolved value
and site values the new version makes inadmissible, each due by the date the rule applies.
`market.verify_table_version(version)` recomputes the content hash and row hashes.

## Policy switches (INV-47)

`market.define_policy`, `market.set_policy_version(policy, position, effective_from, {approvalId,
changeRef})`, `market.policy_for_batch(policy, issue_instant)`, `market.pin_policies_for_batch(batch)`
(call in the batch-issue transaction; the issue instant is the database clock),
`market.apply_policy_tightening(...)`, `market.batch_policy(batch, policy)`. Positions are listed
least to most strict. Versions never take effect in the past and never before an already scheduled
version; a loosening needs an approval record and a change reference. Triggers on
`market.batch_policy_pin` refuse any pin that would let a loosening reach a batch issued before it
took effect, whoever inserts it.

## Error codes (EBMR-MKT-…)

001 market set · 002 as-of date · 003 predicates shape · 010–029 document validation (014 method,
015 method/type, 019 unit, 020 value, 024 overlap, 025 ambiguous predicates, 026 India missing) ·
030–035 publishing (031 loosening needs source correction, 032 source-correction approvals, 035 file
differs from published version) · 040–049 resolution (042 predicate needed, 045 no India value, 046/047
stated method) · 050–055 scopes and evaluations (052 lot needs consuming batch, 053 evaluation does
not match the table, 054 key not for this edition) · 060–065 site values · 070–073 policy versions ·
080–087 batch pins.

## For other modules

- Retention (B4): read `kernel.retention.*` through `resolve` or `evaluateStubScope`; retain-until is
  the latest of the components that apply (expiry + batchRecord.monthsAfterExpiry, manufacture +
  monthsAfterManufacture, QP certification + monthsAfterQpCertification (open until known),
  distribution + monthsAfterDistributionOtcExempt), test records via `testRecord.*` with the licence
  predicate.
- Recipe engine (Phase 2): the MBR validator reads `tablets.compression.ipcSampleMaxInterval`
  (INV-34) and `tablets.uniformity.acceptanceCriteria` (ALL_APPLY: evaluate every criterion).
- Editions: implement `ResolutionContextProvider`; record evaluations through `market.record_evaluation`
  from your own SECURITY DEFINER functions; call `market.pin_policies_for_batch` when issuing a batch.

## Open points

- Several seed values are unverified (`S`, `U`, `GK`): Drugs Rules periods (India catalog G-1),
  IP weight bands (G-8), Annex 16/19 and pharmacopoeial dates. They are marked in the rows.
- Market-set changes after issue (market-add evaluation, 3.3.3) and line-tightening gates (3.3.4)
  are Phase 4/5 work on top of this engine.
- Tables reach installations as signed data packages later; the content hash is the basis.
