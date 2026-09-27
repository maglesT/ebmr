# Batch-number allocation register (site services, schema `site`)

One register per site, shared by both editions: a batch number is allocated once, ever, across Tablets and Injectables, including after a void, a rework or a restore. Build outline 4.2 (site services), 5.2.2 (issue guard: number never used before, voids included, entered in the register); ADR 0001. Control IN-18 (target phase 4; this is its register, built early as INV-27 context). Invariant INV-27.

## Tables (`sql/0600_batch_number_register.sql`)

| Table | Content |
|---|---|
| `site.batch_number_rule` | Numbering rule per site, product (or site-wide) and batch kind (PROCESSING, PACKAGING): format, site time zone, effective-from, reason. Each rule owns a protected continuity counter `site.batch_number:<rule_code>`. |
| `site.batch_number_allocation` | Every number: batch number (unique site-wide), product code and name, edition, kind, processing parent (packaging), batch size (numeric) and UCUM unit, source (GENERATED, EXTERNAL, RECOVERED_AFTER_RESTORE), rule and serial, external reference, who, and `recorded_at` from the database clock. |
| `site.batch_number_void` | A void with reason code and text; the number stays in the register. |
| `site.batch_number_serial_skip` | A serial whose rendered number was already taken (for example registered from ERP); the serial stays accounted for. |
| `site.batch_number_register` (view) | The export: allocation date (site-local), product identity, batch size and unit, status and void reason. |

All tables are insert-only and on one audit chain per site (`batch_number_register:<site>`). The application role reads only.

Format tokens: `{SITE}` `{PRODUCT}` `{YYYY}` `{YY}` `{MM}` (site-local calendar at allocation), `{SEQ:n}` (serial zero-padded to n digits, exactly once), `{PARENT}` (packaging rules: the processing number). Literals: `A-Z 0-9 / . -`. Examples: `AT{YY}{SEQ:4}` gives `AT260001`; packaging `{PARENT}-P{SEQ:2}` gives `AT260001-P01`. A rule never wraps: when `{SEQ:n}` is exhausted allocation stops (`EBMR-SITE-012`) and a new rule is defined. A new yearly series is a new rule with a later effective-from.

## Functions (SECURITY DEFINER; all need `kernel.begin_command` first)

| SQL | TypeScript (`src/batch-numbers/register.ts`) | Purpose |
|---|---|---|
| `site.define_batch_number_rule(jsonb)` | `defineBatchNumberRule` | Master data: a new rule and its protected counter. |
| `site.allocate_batch_number(jsonb)` | `allocateBatchNumber` | Next number of the rule in force; product rule before site-wide rule. |
| `site.register_external_batch_number(jsonb)` | `registerExternalBatchNumber` | A number issued by ERP; an existing number (voided included) is refused (`EBMR-SITE-013`); input is never silently changed. |
| `site.void_batch_number(uuid, text, text)` | `voidBatchNumber` | Void with reason; never reissued. |
| `site.recover_batch_number(jsonb)` | `recoverBatchNumber` | After a completed restore: re-enter a number issued in the lost window, with evidence, only for a serial inside the range the restore skipped. |
| `site.batch_number_invariant_violations()` | `batchNumberInvariantViolations` | Invariant query (must be empty). |
| view `site.batch_number_register` | `exportBatchNumberRegister`, `registerToCsv` | Export (CSV cells quoted, spreadsheet formulas neutralised). |

Allocation draws serials from `continuity.next_counter_value`. When the counter's write-ahead block is used up the database raises `EBMR-CONT-011`; call allocation inside the kernel's `withProtectedNumbers(pool, ctx, ledger, (c) => allocateBatchNumber(c, request))`, which reserves the next block in the external ledger and retries. A serial the rule already drew means its counter was moved back: allocation refuses (`EBMR-SITE-017`) instead of skipping silently. Batch sizes are decimal strings, never JavaScript numbers.

## Permissions (DI-17, DI-18)

Every function first refuses administrators and break-glass accounts (`iam.assert_not_administrator`,
`EBMR-IAM-042`: batch numbers are GMP data) and then checks the permission in the number's site and
product scope (`iam.require_permission`, `EBMR-IAM-040`; `site.batch_number_scope`).

| Function | Permission | Scope | Held by |
|---|---|---|---|
| `define_batch_number_rule` | `BATCH_NUMBER.RULE_DEFINE` | rule's site (+ product) | master-data steward |
| `allocate_batch_number` | `BATCH_NUMBER.ALLOCATE` | site + product | batch issuer |
| `register_external_batch_number` | `BATCH_NUMBER.REGISTER_EXTERNAL` | site + product | batch issuer, service accounts (ERP) |
| `void_batch_number` | `BATCH_NUMBER.VOID` | site + product of the allocation | batch issuer |
| `recover_batch_number` | `BATCH_NUMBER.RECOVER` | rule's site + product | batch issuer |

A missing site or product is left out of the scope, and such a request is covered only by a grant not
limited in that dimension. Issuing numbers may reserve a write-ahead ceiling in the issuer's context:
`continuity.reserve_counter_ceiling` needs `CONTINUITY.COUNTER_RESERVE` at the issuer's location (see the
continuity README). Tests: `test/authorization.test.ts`.

## Tests

`packages/site-services/test/batch-number-register.test.ts`: format and immediate register entry, voids never reissued, uniqueness across editions, export fields, packaging linkage, site-wide rule, no wrap-around, bypass attempts, a rewound counter, and a real restore (a number allocated in the lost window is never reissued and can be recovered only inside the skipped range).

## Later phases

Phase 4 (IN-18 proper): the batch issue guard calls `allocateBatchNumber` / `registerExternalBatchNumber`; the rework rule (a reworked batch always gets a new number, IN-19) and contingency-form numbering use the same protected counters.
