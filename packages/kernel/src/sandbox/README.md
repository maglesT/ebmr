# Sandbox, training and simulation store (kernel module, schema `sandbox`)

Keeps test, training and simulation data out of GMP databases and makes it impossible to mistake for
GMP records. Build outline 4.4 (Databases), 6.5 (sandbox test runs), 5.3 (INV-18); ADR 0001 item 2,
ADR 0012 items 1 and 8. Design note: `docs/design/sandbox.md`.

**Control:** DI-05 (segregation of non-GMP functions). **Invariant:** INV-18 (test, simulation and
training data live in a separate database; GMP batches only from CURRENT or BRIDGING versions).

## What it provides

| Piece | Where | What it does |
|---|---|---|
| Installation marker | `sql/0800`, `kernel.installation_kind()` | Every database migrated with the kernel is marked `GMP` or `SANDBOX` once, when it is provisioned. The marker can never be updated, deleted, truncated or re-inserted, by any role. A sandbox must be named `ebmr_sandbox_<edition>` and no GMP database may use that prefix; a copy or restore under the wrong name reports no kind at all (`EBMR-SBX-004`). |
| Sandbox login role | `sql/0800`, `sql/0820` | `ebmr_sandbox` (LOGIN, NOINHERIT, member of nothing). CONNECT on sandbox databases only; in a GMP database CONNECT is revoked from PUBLIC and granted to `ebmr_app` and `ebmr_authn`. Inside a sandbox the role holds exactly the object privileges of `ebmr_app` and `ebmr_authn` (mirrored after every migration run), never a role membership, since memberships are cluster-wide. |
| Reserved identifiers | `sql/0810`, `identifiers.ts` | Sandbox batch numbers, lot numbers and person and device labels start with `TEST-`. A GMP database refuses any identifier whose NFKC form starts with `TEST-` in any letter case (`EBMR-SBX-021`); the sandbox refuses anything else (`EBMR-SBX-022`), so a real batch or lot number is never reused. Patterns are rows of `sandbox.reserved_identifier_pattern`. |
| Identifiers in free text | `sql/1030` | `sandbox.real_identifiers(text | jsonb)` reads a text, or every string and member name of a JSON value at any depth, for the words 0810's rule reads as real batch or lot numbers in a sandbox: a word of the batch/lot alphabet (after NFKC and with percent and backslash escapes read) holding a letter and a digit, not an ordinal or a UUID, that the rule accepts with `TEST-` in front and refuses as it stands; a word too long to be one is read part by part (`sandbox.real_identifier_parts`). No second definition of an identifier. It cannot see an identifier of digits only, one broken by a space or another character, or written in words. Trigger function `sandbox.guard_free_text(column, ...)`: outside a GMP installation a row whose named columns hold such a word is refused (`EBMR-SBX-024`), naming the column, never the word. On the kernel's stub tables: `guard_identifier` on `market.stub_batch.batch_number`, `market.stub_material_lot.code`, `market.stub_pack.code`, `guard_free_text` on the stubs' free text (Phase 2 exit follow-up F12.KERNEL; recipe-core 0344 reads a test run's record with the same functions). |
| Identifiers as written, person register | `sql/1040` | `sandbox.identifier_words` reads a text as written (`sandbox.as_written`: NFKC, only the escapes of U+0000 and of `%` itself, `%00`, `%25` and `\u0000`, read as a space) as well as with its escapes read, so an escape no longer hides the identifier written right after it (`50%B24-0001` holds `B24-0001`). Outside a GMP installation `guard_free_text` also guards the person register: `iam.person.legal_name` and `.employee_ref`, `iam.issued_identifier.identifier` (login names), whatever follows the `TEST-` prefix (`EBMR-SBX-024`); a GMP installation keeps its real names (Phase 2 exit follow-up F12, round 11). |
| Identifiers as they show | `sql/1050`, `sql/1060`, `sql/1070`, `sql/1080`, `sql/1090`, `sql/1101`, `sql/1102` | `sandbox.identifier_words` reads every text, as stored, as written in NFKC and with its escapes read, in four forms (`sandbox.text_readings`): as it is; as it shows (`sandbox.shown_text`: NFD, the combining marks, since `sql/1090` every spacing mark and what Chromium 141 lays out with no advance (`sandbox.no_advance_class`: U+FFFC among them), and the characters `kernel.is_blank` counts as showing nothing removed, white space kept but, since `sql/1070`, a space narrower than the thin space (hair, six-per-em), NFC); with its look-alikes read (`sandbox.look_alikes_read` and the table `sandbox.look_alike`, data from UTS #39 confusables.txt and the Unicode Character Database 18.0.0: decimal digits of every script by value, letters, dashes, slashes and full stops that look like the identifier alphabet, since `sql/1060` the letters and digits their Unicode names give (a small capital L, a regional indicator, a dingbat digit), since `sql/1070` the look-alikes as a class (every member of a confusables class another member of which is read by its look: the class of U+30FC, which holds the em dash, as '-'; one character drawn as a letter with a dot or an apostrophe, U+013F; dashes, solidi and (`sql/1080`) full stops by name or as Chromium 141 draws them, U+1680 included; compatibility forms PostgreSQL 16's NFKC does not know; since `sql/1101` and `sql/1102` the letters and digits Chromium 141 draws as the alphabet at weights 400, 600 and 700, alone or with a combining mark, such as U+053C as L); punctuation stays a separator; ASCII is read as coded); and both. A text that can display in another order (a right-to-left letter, an Arabic-Indic digit, a bidi control or mark: `sandbox.reordering_class`) is also read in every arrangement of its runs (`sandbox.rearranged_words`: each run of letters joined to each run of digits). The stored text is never changed. Corrects 1040's "the text as it shows" (Phase 2 exit follow-up F12, decision F12.11). Not read (decision F12.13 (6)): digits only, a break by a gap at least as wide as the thin space or by a visible character that is no look-alike by UTS #39, name or drawing, a character drawn no closer to a letter than two letters are to each other, another font's drawing, words, images. |
| A word with a digit is ASCII | `sql/1120` | In a sandbox a word that holds a digit (an ASCII digit or any character `sandbox.look_alike` reads as one: every decimal digit, the numeral digits by name, letters and signs read as a digit) is written with ASCII letters, ASCII digits, '/', '.' and '-' only, in the text as stored and in every reading above, whatever a table lists. A word ends only at Unicode White_Space or ASCII punctuation other than '/', '.' and '-' (`sandbox.text_words`); `sandbox.holds_digit`; `sandbox.non_ascii_digit_words`. `sandbox.identifier_words` gives such a word whole and `sandbox.real_identifier_parts` reads it as a real identifier, so every guard of the rule refuses it (`guard_free_text`, EBMR-SBX-024, with a message that says to write the digits 0 to 9 and a space; recipe-core's triggers, EBMR-EXE-147). Closes by structure what the drawing tables could not (decision F12.14: U+0460 as W, U+10EB as d in the monospace face of the signed text); the accepted cost (Devanagari digits, 25वां, 3개, 25°C, ½, Russian б) and the residual are in F12.14 (6) and (7). |
| A reordered line is read in every arrangement | `sql/1130` | A text that can display in another order (`sandbox.reordering_class`) is read in every arrangement of its runs: each run of ASCII letters (1050) and, since `sql/1130`, each run of non-digit characters inside a word (`sandbox.text_words`) that holds a character outside ASCII is joined to each run of digits (`sandbox.rearranged_words`, replaced). Such a joined word is read whole by 1120's rule, so every guard refuses, in a sandbox, a right-to-left mark or letter that makes a line show a word with a digit drawn with a letter no table lists ('बैच <U+0460><U+200F> 24-0001 मिला', shown as Ѡ24-0001). Corrects 1120's item 3 and 1050's item 4 (decision F12.15); the accepted cost (Urdu, Arabic or Hebrew prose with a number, a text with a direction mark and a number) and the residual (each text read on its own) are in F12.15 (3) and (6). |
| The characters that reorder a line are every browser's | `sql/1140` | `sandbox.reordering_class`, which decides which texts 1050 and 1130 read in every arrangement, is every code point of the ranges reserved for right-to-left scripts (U+0590-08FF, U+FB1D-FDCF, U+FDF0-FDFF, U+FE70-FEFE, U+10800-10FFF, U+1E800-1EFFF), whatever a Unicode version assigns there, and the bidi controls and direction marks (5837 code points). 1050 built it from Unicode 18.0.0; Chromium 141, the E2E browser, ships ICU 74 (Unicode 15.1), in which 61 code points Unicode 16 to 18 assigned as marks or neutrals (U+05C8, U+10D69, U+FBC3, U+10ED0 ...) are unassigned and reorder a line as R or AL, so 'Drum of L<U+05C8> 2409-0017 set aside', drawn as L2409-0017, was kept. The class holds every R, AL or AN code point of ICU 74, Unicode 14.0 and 18.0.0. Corrects 1050's item 4 and 1130's residual (decision F12.16); the accepted cost (a number with a mark or sign of a right-to-left script) and the residual (a renderer whose bidi data gives R, AL or AN outside the ranges) are in F12.16 (3) and (5). |
| Batch source rule | `sql/0810`, `batchIssueProblem` | GMP: every market state of the pinned version is CURRENT or BRIDGING (`EBMR-SBX-012`). Sandbox: any version may be test-run. |
| Watermark | `watermark.ts`, `sandbox.watermark()` | `TEST, NOT GMP` on every output of a sandbox and of every non-GMP function (simulation, training, analytics). |
| Provisioning | `provision.ts` | Creates, migrates, marks, closes and checks a sandbox; upgrades re-level its privileges. |
| Backend signals | `sql/0970`, `kernel.backend_signals_restricted()` | No role but a superuser may cancel or end another connection's work: `sandbox.apply_connect_policy()` takes `pg_cancel_backend` and `pg_terminate_backend` away from PUBLIC and every role that is not a superuser (function privileges live in the database, so a template copy keeps them; applying the policy again repairs a restore that lost them). `kernel.backend_signals_restricted()` reports whether the database holds the policy (also that no login role other than a superuser is in `pg_signal_backend`); the tablets manual-weighing gate refuses while it does not (tablets 0350, review P50 round 4). A grant on either function to a role oid the cluster does not know (only a direct write into `pg_proc` makes one; no REVOKE can name it) is refused with `EBMR-SBX-038`, naming the function and the oid, before the policy applies anything (kernel 1111; before it the policy failed with a syntax error). |
| Listener login roles | `sql/0980`, `sandbox.role_mirror_differences(role, roles[])` | `ebmr_listener` (GMP) and `ebmr_sandbox_listener` (sandbox): an edition's evidence listener logs in with a role of its own (LOGIN, NOINHERIT, member of nothing, no members), CONNECT only on databases of its kind; inside a sandbox the sandbox one holds exactly the GMP one's object privileges (mirrored with the others). Migrations grant the GMP one only what the listener records (tablets 0350 item 6). Each listener role gets CONNECTION LIMIT = the listener's share (8 for one listener; a cluster running more declares 8 per listener with `kernel.apply_listener_share(n)`, superuser only, which later migrations keep), and the application role of its kind (`ebmr_app`, `ebmr_sandbox`) the cluster's slots for ordinary roles less that share, set when a database is migrated (EBMR-SBX-036 when the cluster has no room for it, EBMR-SBX-037 for a share below 8; run `kernel.apply_listener_share()` again after changing max_connections). Review P50 follow-up round 4 and its final verification, decisions X36, X38, X41. |
| Invariant query | `sandbox.segregation_problems()` | Must return no rows. GMP: any way in for the sandbox role or the sandbox listener (CONNECT, an object privilege, a default privilege, a membership, an elevated attribute). Sandbox: GMP roles (the GMP listener among them) or PUBLIC able to connect, privileges different from the mirror. Both: a listener role with an elevated attribute, a membership, or a member (kernel 0980). A role the cluster does not have is reported (the sandbox role, a listener role) or passed over (a GMP application role), never an error (kernel 1100). |

## Public API (`import { sandbox } from '@ebmr/kernel'` once exported)

TypeScript (`src/sandbox/`):

- `readInstallationKind(db)`, `assertInstallationKind(db, 'GMP' | 'SANDBOX')`: start-up guard for every
  server, job and adapter (`EBMR-SBX-007` on a mismatch).
- `readInstallationStamp(db)` returns `{ installationKind, watermark }` for exports and true-copy bundles;
  `assertGmpOrigin(stamp, what)` refuses anything not from a GMP installation (`EBMR-SBX-013`).
- `watermarkFor(subject)` where subject is `'GMP' | 'SANDBOX' | 'SANDBOX_TEST_RUN' | 'TRAINING' | 'SIMULATION' | 'ANALYTICS'`
  (null only for `GMP`); `stampText(text, w)`, `stampJson(value, w)`, `isStamped(text)`.
- `identifierProblem(installation, kind, value)`, `assertIdentifierAllowed(...)`, `isReservedTestIdentifier(value)`,
  `testIdentifier(kind, body)` (builds `TEST-<body>`), `RESERVED_PATTERNS`, `batchIssueProblem(installation, marketStates)`.
- `provisionSandboxDatabase({ adminUrl, database, sources })`, `upgradeSandboxDatabase(...)`,
  `sandboxDatabaseName(edition)`, `applyConnectPolicy(db)`, `segregationProblems(db)`.

SQL (granted to `ebmr_app`; mirrored to `ebmr_sandbox` in a sandbox):

- `kernel.installation_kind()`; `sandbox.assert_gmp_installation(action)` (`EBMR-SBX-010`);
  `sandbox.assert_sandbox_installation(action)` (`EBMR-SBX-011`); `sandbox.watermark()`.
- `sandbox.identifier_problem(kind, value)`, `sandbox.identifier_problem_for(installation, kind, value)`,
  `sandbox.assert_identifier_allowed(kind, value)`; trigger function `sandbox.guard_identifier(kind, column [, column ...])`.
- `sandbox.identifier_words(text | jsonb)`, `sandbox.real_identifier_parts(word)`, `sandbox.real_identifiers(text | jsonb)`,
  `sandbox.escapes_decoded(text)` (1030), `sandbox.as_written(text)` (1040); trigger function
  `sandbox.guard_free_text(column [, column ...])` (owner only).
- `sandbox.batch_issue_problem_for(installation, market_states)`, `sandbox.assert_batch_issue_allowed(market_states)`.
- `sandbox.segregation_problems()`, `sandbox.direct_privileges(role)`, `sandbox.mirror_differences()`, `sandbox.role_mirror_differences(role, roles[])` (0980).
- Superuser only: `sandbox.apply_connect_policy()` (connect policy, since kernel 0980 with the listener role of the
  database's kind, and, since kernel 0970, backend signals), `sandbox.mirror_application_privileges()` (since kernel
  0980 also `ebmr_sandbox_listener`).
- Owner only (called by database code): `kernel.backend_signals_restricted()`.

## How other modules use it

- **GMP-issuing paths** (release and market dispositions, real lot status and inventory, equipment status,
  true copies registered as GMP records, outbound messages to real ERP/LIMS/QMS): call
  `perform sandbox.assert_gmp_installation('<what>')` first. Sandbox-only features (test runs of
  unapproved versions, seeded review-by-exception challenges, training scenarios) call
  `sandbox.assert_sandbox_installation('<what>')`.
- **Tables holding identifiers**, in the owning module's migration:
  `create trigger zz_reserved_identifiers before insert or update on <table> for each row execute function sandbox.guard_identifier('BATCH_NUMBER', 'batch_number');`
  Kernel migrations below 0800 and the site-services and recipe-core migrations run on their own, so these
  triggers are added in an integration migration (list in section 6 of the design note).
- **Batch issue** (Phase 3): after the MBR life cycle's selection function, call
  `sandbox.assert_batch_issue_allowed(<market states of the pinned version>)` and check the batch number.
- **Renderers and exports:** `watermarkFor(stamp.installationKind)`, or `watermarkFor('SIMULATION')` for the
  designer's automated simulation, then `stampText` / `stampJson` (PDF and screen banners in Phase 3-4 use
  the same `Watermark`).
- **True copies:** include `await readInstallationStamp(client)` in the bundle manifest (inside the builder's
  snapshot transaction); an importer into GMP calls `assertGmpOrigin(manifest.installation, 'True-copy bundle')`.
- **Operations:** provision with `provisionSandboxDatabase`, upgrade only with `upgradeSandboxDatabase`
  (never plain `migrate`, which would not re-level the sandbox role). After a restore or a
  `CREATE DATABASE ... TEMPLATE`, run `select sandbox.apply_connect_policy()` as a superuser: database
  privileges are not copied, and only a superuser can take the backend signals away (run by the database owner,
  PostgreSQL only warns, and `kernel.backend_signals_restricted()` then answers false). Other login roles that must
  reach a GMP database (backup, monitoring) need an explicit `grant connect`; none may be a member of
  `pg_signal_backend`. Run `sandbox.segregation_problems()` with the other invariant queries.

## Error codes

`EBMR-SBX-001` no marker, `-002` marker is permanent, `-003` marker already set, `-004` marker and database
name disagree, `-005` bad provisioning setting, `-006` bad sandbox name, `-007` process connected to the
wrong kind, `-010` GMP-only action in a sandbox, `-011` sandbox-only action in GMP, `-012` batch source not
allowed, `-013` non-GMP origin, `-014` watermark misuse, `-020` unknown kind, `-021` reserved test
identifier in GMP, `-022` non-test identifier in the sandbox, `-023` misconfigured guard trigger, `-024` a real-format
batch or lot number in free text in the sandbox (1030), `-030`
mirror outside a sandbox, `-031`..`-034` provisioning (exists, missing, not a sandbox, segregation check failed), `-035`
backend signals still open to roles other than superusers after the policy was applied (kernel 0970), `-036` no room
in the cluster's connections for the listener's share (kernel 0980), `-037` a listener share below one listener's 8
connections (kernel 0980), `-038` a backend-signal function granted to a role oid the cluster does not know, so the
connect policy applies nothing (kernel 1111).
Messages give the reason first, then the control, then the code.

## Tests (`packages/kernel/test/sandbox/`)

`identifiers.test.ts` (rules, disjointness property, TypeScript and SQL agree on random input incl. NFKC
look-alikes), `identifier-words.test.ts` (1030: what the reading reads and does not, `guard_free_text` in both
installations; 1040: an escape hides nothing, the person register in both installations; 1050: what shows nothing, look-alikes, digits of other scripts and reordered text are read, every row of `sandbox.look_alike` is folded, honest prose in Hindi, Tamil, Greek, Japanese and Korean is not read; 1060: letters and digits by their names; 1070: the separators' look-alikes as a class, a letter drawn with a dot, spaces narrower than the thin space, honest Japanese, Chinese, Korean and Greek prose; 1080: the full stops; 1090: what takes no room, U+FFFC and every spacing mark, honest Hindi, Tamil and Telugu prose; 1101: letters and digits as Chromium draws them, U+053C and U+14AB as L; 1102: the same in bold and with a complete comparison; 1120: a word with a digit is ASCII, the 18 characters no table lists read whole glued to digits, the word boundary, honest prose and the accepted cost, `guard_free_text`, a person label and an employee reference; the earlier kernels' tests read the identifier alphabet with `readText`, the 1120 tests everything with `readWhole`; 1130: the 18 characters of 1120 followed by a right-to-left mark, a Hebrew letter or a mark and a comma, then a space and digits, in Hindi and Tamil prose, read; honest prose and the accepted cost; `guard_free_text` and an employee reference; 1140: the 61 code points Chromium 141 reorders that Unicode 18.0.0 classes as marks or neutrals, read in every arrangement; the class is exactly the reserved ranges and the controls; honest prose and the accepted cost; `guard_free_text` and an employee reference), `watermark.test.ts`, `installation.test.ts` (GMP marker, identifier guard, connect policy,
copy under a sandbox name), `bypass.test.ts` (INV-18 bypass attempts through the sandbox role; DI-05 catalog
test), `provision.test.ts` (provisioning, upgrade re-levelling, no half-built sandbox, kind/name mismatch);
`test/security/backend-signals.test.ts` (the backend-signal policy, kept by a copy, repaired by the connect policy, a
grant to a role the cluster does not know refused with `EBMR-SBX-038`, kernel 1111, and why only a catalogue write makes
such a grant: PostgreSQL refuses to drop a role that still holds one);
`test/security/listener-roles.test.ts` (the listener roles, their segregation and mirror, the listener roles' and the
application roles' connection limits, `kernel.apply_listener_share`, and 0980 applying the share itself: run on a fresh
cluster's roles in a transaction rolled back at the end it must give exactly 8 and the slots less 8, and a database
migrated to 0980 keeps each declared share and levels the application roles with it; the server tests' set-up declares
a share of its own, which the limits as the cluster stands would only echo).
`helpers.ts#openSandbox` gives a test sandbox's pools; its `drop()` ends them with `endPool` (`test/harness/pools.ts`),
which waits until the socket of every connection has closed, before the forced drop (checked in
`test/harness/teardown.test.ts`).

Handbook: [modules/kernel.md](../../../../docs/handbook/modules/kernel.md)
