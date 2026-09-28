# Phase 2: open questions for the owner and QA

Defaults in use today are listed. Status: all DECIDED by default (owner decision 0004, 28 September 2026); the owner or QA may still change any of them later.

## Calculations and rounding (expression language)

| # | Question | Default in the build |
|---|---|---|
| E1 | Ph. Eur. rounding counts significant figures per bound, so 0.96 against "not less than 1.0" fails under Ph. Eur. but passes under USP (rounded to the limit's decimals). QA to confirm against the official pharmacopoeia texts. | As described; each parameter names its rule set. |
| E2 | A USP limit with two bounds written to different decimals (e.g. 95.0-105) | The finer of the two decimal places is used for both. |
| E3 | Temperatures | `K` always means a temperature difference; absolute temperatures only in `Cel` or `[degF]`. |
| E4 | `kp` (kilopond) on hardness | Accepted as kgf with an information note; `kg/cm²` only through the controlled legacy alias with a justification. |
| E5 | Nested calculations | Each nested library result is kept at 34 significant digits before the outer formula uses it (no intermediate rounding to reporting precision). |
| E6 | Empty series | `sum`/`mean` of an empty series is an error; `count` of an empty series is 0. |
| E7 | Microbial and potency units | CFU and IU convert only within the same unit; there is no endotoxin unit yet (UCUM's [EU] is a different unit) - deferred with injectables. |

## Recipe model, validator and simulator (flow module)

| # | Question | Default in the build (decided by 0004) |
|---|---|---|
| F1 | Branch conditions that cannot be analysed exactly | Analysed exactly over the reals at representative points; an unanalysable condition gives a warning needing justification. |
| F2 | References in an MBR | Every reference carries a version hash and must be EFFECTIVE at validation. |
| F3 | Line clearance and yield | Checked per stage; only stages marked NON_MATERIAL are exempt from yield; AFTER_YIELD roles must follow the yield step; equipment status is checked within the same stage. |
| F4 | Writers of a data item | Exactly one writer on any path. |
| F5 | Reading repeated data | Replicate data read outside the section is the series of instance values; loop data read after the loop is the last iteration's value. |
| F6 | Device or automation capture | Must name the computerised system (GMP-SYSTEMS reference). |
| F7 | IPC limits and manual critical data | Only numeric IPCs need limits; critical parameters entered by hand need an accuracy-check method. |
| F8 | Checker on significant steps | No risk reduction removes the checker except the S5a and S24 cases; no general "no checker" reduction exists. |
| F9 | Conditional "not applicable" items (PR-03) | Not modelled in Phase 2 (execution-time, Phase 3). |
| F10 | Limit sources | Registered limits cite a registration or pharmacopoeia source with edition; validated limits cite a validation report; hold times cite a hold-time study or validation report; timers accept listed source kinds only. |
| F11 | Loops | Repeat only on process endpoints; the exit may not depend on an acceptance or release test result, directly or through a calculation (that is reprocessing). |
| F12 | Market minima not resolvable | The MBR fails (fail closed). |
| F13 | Bounds | At most 100 loop iterations, 500 replicate instances, 64 nesting levels; the simulator enumerates up to 10,000 paths, then adds one targeted run per remaining decision option so decision coverage stays complete. |
| F14 | Sequential replicate instances | Released one at a time. |
| F15 | What counts as a value-only change (delta verification) | Limit values, targets, batch-size quantities, reference version/hash and texts; anything else is structural. |

## MBR life cycle (lifecycle module) - decided by default (0004)

| # | Question | Default in the build |
|---|---|---|
| L1 | Returning a version to DRAFT | Only before approval; a change to an approved master is always a new derived version. |
| L2 | Regulatory sign-off at approval | A valid REGULATORY_CONFIRMED signature on the version by a person other than the approver. |
| L3 | What counts as process-impacting | Conservative: only titles, product display name, reference titles and golden test data are non-process; a first version is a new process and needs a validation link. |
| L4 | Registered elements | REGISTERED-tier ranges and REGISTRATION references; any change needs a reporting category per market; a widening also needs the variation/supplement reference; a unit change counts as widening. |
| L5 | Scope cells for market authorisation | Concrete (site, line, batch size). |
| L6 | Effective dates | A successor cannot take effect inside a predecessor's remaining validity; withdrawing a successor does not reinstate the predecessor. |
| L7 | Withdrawal | By QA from SUBMITTED, CHECKED or APPROVED; from APPROVED only if never authorised. |
| L8 | Periodic review | Recorded by QA (MBR.APPROVE). |
| L9 | S4 "checker may also approve" | Not allowed (outline default). The e-signature catalogue requires APPROVED to be independent of CHECKED, so allowing it later needs a kernel catalogue change. |
| L10 | A person who returned a version to DRAFT | Is treated as an editor by the e-signature independence rule, so cannot sign CHECKED/APPROVED on that version (stricter than INV-04; a kernel option to mark administrative changes as "not a data entry" is a follow-up). |
| L11 | New permission MBR.CHANGE_RECORD | GMP write, held by QA MBR approver and regulatory signer. |
