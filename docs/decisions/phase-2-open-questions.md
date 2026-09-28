# Phase 2: open questions for the owner and QA

Defaults in use today are listed; nothing is blocked. Status: all OPEN.

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
