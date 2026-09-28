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
  every criterion applies with its own governing market; a value is at least as strict as another
  only when it contains every criterion of the other with an identical definition, so a criterion
  that keeps its id but changes its bands, sampling plan, rounding or stage is a different criterion,
  never a tightening: `market.criteria_cover` / `isAtLeastAsStrict`) and `NOT_COMPARABLE`, which needs a stated
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
scope and calls the owner-only writer `market.record_evaluation`. What the scope fixes the request can
repeat but never change: a predicate the scope fixes (EBMR-MKT-055); the site whose value applies,
always the scope's own (`siteId` is assert-only; another site, an unknown id or null: 056); a PACK's
destination for a PER_DESTINATION key (another destination: 057; `resolveForScope` refuses it too);
the subject the evaluation is filed under (`market.stub_evaluation_subject`: the scope itself, or a
subject the scope entails and the stub tables confirm: a PACK's batch, a lot's consuming batch, a batch
made at a SITE or of a product qualified on a LINE, ROOM or EQUIPMENT whose markets are all in the
scope's set; anything else: 058). Only a MATERIAL_LOT scope names a consuming batch (052). A BEFORE INSERT trigger recomputes
the resolution from the stored inputs and refuses anything else (EBMR-MKT-053), so not even the owner
can store a value the table does not give. Each row holds value, governing markets, predicate
branch, table version, inputs and their SHA-256, the site value applied and its outcome.
Editions will call `market.record_evaluation` from their own SECURITY DEFINER functions, deriving the
market set from their tables.

## Site values

`market.set_site_value(site, key, value, effective_from, {justificationRef, qaApprovalId})`: site
values only tighten. Looser than a binding value (HARD or a hard floor) is refused (EBMR-MKT-060);
looser than a DESIGN value is refused (061); loosening GUIDANCE or an adopted EXAMPLE needs a
justification (CCS) reference and a QA approval (065) and is flagged on every evaluation that
uses it (`market.batch_flags(subject)`). The QA approval (`qaApprovalId`) is the id of a
`SITE_VALUE_LOOSENING_APPROVED` e-signature of exactly that loosening (aggregate
`market_site_loosening`, id `<site>@<key>@<effective from>@<value departed from>@<new value>@<justification>`;
`market.site_value_preview` / TS `siteValuePreview` names it), checked with `esig.assert_signature`
(EBMR-ESIG-070) and signed by someone other than the person setting the value (066); the row keeps the
signature and its signer (`qa_approval_id`, `qa_approver_id`). Sets accept only supersets, and for
ALL_APPLY only identical criteria (064); NOT_COMPARABLE keys take no site value (063). At every
evaluation the site value is re-assessed; one that a later table has made inadmissible is not applied
and is flagged `SITE_VALUE_INADMISSIBLE`. An approved loosening applies only where the resolution
departs from the same basis it was approved against (`market.loosening_basis`: value, floor type,
binding floor, governing markets and their predicate branches); for another basis (a tightened table
version, another market set or branch) it is not applied but flagged `SITE_VALUE_INADMISSIBLE`, and a
new table version that changes the basis puts it on the change-impact list.

## Publishing, source corrections and change impact

`market.publish_rule_table(doc, change)` (TS `publishRuleTable` / `syncRuleTables`) validates the
document (same checks and codes as `validateRuleTableDocument`), requires the next version number,
stores keys and rows, compares the new version with the previous one per market, predicate branch and
date segment, and refuses any loosening that reaches today or earlier unless the version is a
`SOURCE_CORRECTION` (L-38). "Today" is the date at the configured site zone (`iam` policy `site.zone`),
never a zone the command declares. A source correction needs a citation, a vendor-notice reference and
`approvalSignatureIds`: two `RULE_TABLE_CORRECTION_APPROVED` e-signatures of exactly this document
(aggregate `market_rule_correction`, id `<table>:<version>:<content hash>`;
`market.rule_correction_target` / TS `ruleCorrectionApprovalTarget` names it) by two different quality-unit
persons, neither the publisher (EBMR-MKT-032, EBMR-ESIG-070); the version records the signatures and
their signers (`approval_signatures`, `approver_ids`). A loosening that starts in the future is allowed
and recorded. It then writes `market.change_impact`: stub MBR limits (`market.stub_mbr_limit`) looser
than the new resolved value, site values the new version makes inadmissible, and approved site
loosenings whose basis the new version changes, each due by the date the rule applies.
`market.verify_table_version(version)` recomputes the content hash and row hashes.

## Policy switches (INV-47)

`market.define_policy`, `market.set_policy_version(policy, position, effective_from, {approvalId,
changeRef})`, `market.policy_for_batch(policy, issue_instant)`, `market.pin_policies_for_batch(batch)`
(call in the batch-issue transaction; the issue instant is the database clock),
`market.apply_policy_tightening(...)`, `market.batch_policy(batch, policy)`. Positions are listed
least to most strict. Versions never take effect in the past and never before an already scheduled
version; every change needs a change reference, and a loosening needs `approvalId`: the id of a
`POLICY_LOOSENING_APPROVED` e-signature of exactly that version (aggregate `market_policy_version`, id
`<policy>@<version>@<position>`; `market.policy_version_target` / TS `policyVersionApprovalTarget`
names it) by someone other than the author (EBMR-ESIG-070, 075); the version keeps its author and
approver (DI-09). A VENDOR-level switch belongs to the vendor profile: the tenant path can neither
define nor change it (074; only a software release can), and a loosening that needs
`OWNER_CONFIRMATION` is refused on the tenant path (074). Triggers on `market.batch_policy_pin` refuse
any pin that would let a loosening reach a batch issued before it took effect, whoever inserts it; pins
of one batch and policy are serialised, and `market.batch_policy` returns the strictest pin.

## Permissions (DI-17, DI-18)

Every writing function checks the actor's permission, in the role declared in its context, before
its first write (`iam.require_permission`, refusal `EBMR-IAM-040`), and first refuses administrator
roles and break-glass accounts (`iam.assert_not_administrator`, `EBMR-IAM-042`): market data is GMP
data. Catalogue and role map: `sql/0700_authorization_catalogue.sql`.

| Function | Permission | Scope | Held by |
|---|---|---|---|
| `publish_rule_table` (INITIAL, UPDATE) | `MARKET.RULE_TABLE_PUBLISH` | installation `{}` | master-data steward |
| `publish_rule_table` (SOURCE_CORRECTION) | `MARKET.RULE_TABLE_CORRECT` | installation `{}` | regulatory-conformity signer |
| `set_site_value` | `MARKET.SITE_VALUE_SET` | the site (Phase 1: stub site code) | master-data steward |
| `define_policy`, `set_policy_version` | `MARKET.POLICY_CHANGE` | installation `{}` | QA MBR approver |
| `apply_policy_tightening` | `MARKET.POLICY_TIGHTEN_BATCH` | installation `{}` | QA reviewer |
| `pin_policies_for_batch` | `BATCH.ISSUE` (part of issuing) | actor's location | batch issuer |
| `evaluate_stub_scope` | `MARKET.RULE_EVALUATE` | actor's location | MBR author, batch issuer, operator, QA reviewer, service accounts |
| writes to the `stub_*` tables (statement trigger `a0_authorize`) | `MASTERDATA.CHANGE` | installation `{}` | master-data steward |

"Actor's location" is the site and room of the command's session (`iam.actor_location_scope`, 0710).
`assess_site_value`, `apply_site_value` and the other read functions are not gated; `record_evaluation`
stays owner-only (the editions call it from their own gated functions).

## Error codes (EBMR-MKT-…)

001 market set · 002 as-of date · 003 predicates shape · 010–029 document validation (014 method,
015 method/type, 019 unit, 020 value, 024 overlap, 025 ambiguous predicates, 026 India missing) ·
030–035 publishing (031 loosening needs source correction, 032 source-correction approvals, 035 file
differs from published version) · 040–049 resolution (042 predicate needed, 045 no India value, 046/047
stated method) · 050–058 scopes and evaluations (052 consuming batch only and always for a lot, 053
evaluation does not match the table, 054 key not for this edition, 055 fixed predicate, 056 site not
the scope's, 057 pack destination, 058 subject not entailed by the scope) · 060–066 site values (066
the setter approved their own loosening) · 070–075 policy versions (074 vendor-profile switch or owner
confirmation, 075 the author approved their own change) · 080–087 batch pins. Approvals that are not
a valid e-signature of the right meaning and aggregate are refused by esig (EBMR-ESIG-070).

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

## Approval signatures (0360)

| Meaning | Aggregate type | Signed by | Checked in |
|---|---|---|---|
| `RULE_TABLE_CORRECTION_APPROVED` | `market_rule_correction` | quality unit (`MBR.APPROVE`, `RECORD.QA_REVIEW`), two persons, not the publisher | `publish_rule_table` |
| `SITE_VALUE_LOOSENING_APPROVED` | `market_site_loosening` | quality unit, not the person setting the value | `set_site_value` |
| `POLICY_LOOSENING_APPROVED` | `market_policy_version` | quality unit, not the author of the version | `policy_version_guard` |

The change is signed before it is made, so each aggregate id names the change and its content follows
from the id alone (it never changes, INV-09); the signer signs in state `PROPOSED`.

## Open points

- Several seed values are unverified (`S`, `U`, `GK`): Drugs Rules periods (India catalog G-1),
  IP weight bands (G-8), Annex 16/19 and pharmacopoeial dates. They are marked in the rows.
- Market-set changes after issue (market-add evaluation, 3.3.3) and line-tightening gates (3.3.4)
  are Phase 4/5 work on top of this engine.
- Tables reach installations as signed data packages later; the content hash is the basis.
