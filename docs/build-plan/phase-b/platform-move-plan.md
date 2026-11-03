# Phase B: Batchwright (Tablets) onto the MEDHANTA platform. Plan, draft 1 (3 Nov 2026)

Status: **draft, waiting for the lead's approval** (the owner delegated plan approval to the lead). Scope: platform
D-11, rewire only. Batchwright gets its own database on the shared server, signs people on through core OIDC,
re-authenticates e-signatures through core, reads master data through the platform's versioned views, publishes its
report views as platform links, and its data moves with PL-13 checks. No new features, no rewrites; the block-library
engine is unchanged; the catalogue stays Tablets only. Worked examples: MMS (`docs/06`, `db/move-to-platform.ts`,
`docs/07`) and Deviations (`docs/08`, `docs/09`).

The frozen baseline is branch `standalone` at 0bb289c (tag `batchwright-tablets-v1.0.0-rc.2`). Nothing goes live now:
all products go live together. The cutover runbook is written, not run.

## What is different about Batchwright

Most of the regulated core already lives in the database, so the move changes *where facts come from*, not the checks:

- **Access:** 163 per-action permission codes already exist (`iam.permission`, with domain and effect), together
  with a role → permission map (`iam.role_permission`). Nearly every check is SQL `iam.require_permission(code)`. Only
  6 hard-coded role lists in TypeScript gate read screens.
- **E-signature:** `esig.sign` consumes a one-use authentication event in the signature's own transaction and refuses
  in these cases:
  - the event comes from another session, terminal or account;
  - the event is older than the challenge;
  - the signer lacks the meaning's codes;
  - the signer is not independent.

  DI-35 segregation compares **person ids**, never roles (`esig.check_independence`). EBMR-LIB-007 does the same:
  signer person = actor person, and approver ≠ drafter.
- **Master data:** local tables carry many Batchwright-only facts:
  - equipment classes, qualification, maintenance and retirement events;
  - calibration, cleaning and clean-hold;
  - area rules, adjacency and dedication;
  - the lot register with status, retest and identity tests.

  The guards (`plant.equipment_fitness`, `tab.lot_facts`, `tab.library_smart_problem`, the entry-identifier check) read
  only these local tables. Browser-supplied facts are already re-derived and refused on mismatch.
- **Installation:** Batchwright migrates as a **superuser**. It has 639 migrations in 4 sources and does the following:
  - creates 6 extra roles (`ebmr_authn`, `ebmr_listener`, `ebmr_report`, `ebmr_analytics`, the two sandbox roles);
  - creates the DDL-audit event triggers;
  - sets connection limits;
  - writes bootstrap rows.

  It also refuses to start unless its database session is encrypted, or it reaches the database over a local socket.

## What maps to what

| Batchwright today | On the platform | How |
|---|---|---|
| `iam.person` / `iam.account` (HUMAN), passwords (argon2id), badges, lockout, sessions' sign-in, user/grant/recertification/delegation/break-glass screens | identity `employee` + `ebmr.*` codes | `iam.person`/`account` stay as the **id map** (`employee_id`): signatures, audit and records reference them. Sign-in, passwords, badges, lockout, unlock and grant screens are off on the platform build; core does them (PL-01–PL-04, PL-12). Idle locks stay. |
| SERVICE / INTEGRATION accounts (gateway, ERP, federation, sweeper) | stay local | They are machines, not people. Same service keys, same codes, never in core. |
| role grants + session role choice | codes from the token, recorded at sign-on | An insert-only `iam.platform_grant` row holds each session's codes (who, codes, token id, when). `evaluate_authority` reads them instead of `role_grant` (new migration; checks otherwise unchanged: active person, qualifications, read-only/service rules, logging in `authority_evaluation`). |
| DI-18: administration never does GMP work | kept | If someone's codes mix ADMINISTRATION and GMP, the session asks for the **work mode** (Administration or GMP). That is today's role-choice screen with two choices, so `assert_not_administrator` and static segregation keep working per session. The platform puts no block on administrators signing (D-30); this is Batchwright's own rule, unchanged. |
| e-signature re-auth (password or badge + PIN) | core `prompt=login`, one-use proof | The proof's `sub` must be the signed-in person and it must carry the meaning's code. The server turns it into the `iam` auth event that `esig.sign` consumes in the same transaction, so ESIG-034/036/040/042, EBMR-LIB-007 and DI-35 run unchanged. The manifestation is unchanged. Badge + PIN signing is off on the platform. |
| `plant.product`, `site.erp_product` | master `product` | Id map + Batchwright-only fields (highly potent, hazards, reprocessing, beta-lactam, shelf life). |
| `plant.area` (ROOM) | master `room` | Id map + the area rules. LINE stays local (no master kind). |
| `plant.equipment` (PROCESS/UTILITY → `equipment`, INSTRUMENT → `instrument`) | master equipment / instrument | Id map. Classes and all fitness events stay local. |
| `site.erp_material` | master `material` | Id map + retest months. |
| supplier (free text on the lot) | unchanged | A pick-list would be a new feature (as in Deviations). |
| batches, MBRs, entries, signatures, audit, library blocks, lots and their events | stay in the `ebmr` database | Moved unchanged, with counts and checksums (PL-13). Entries already keep the code and facts as at writing (PL-07). |
| own backups, restore, hardening screen | platform backups (PL-11) | Off on the platform (no superuser URL is given). They stay in `standalone`. |

## Guard facts: trusted and database-side (the simplest way)

1. **Write-time fact.** The server reads the item through the master view, on its own login and second pool, in the
   request that writes. It records the item with `md.record_fact(kind, master_id, code, name, version, active)` in
   the **same transaction**. The function is `SECURITY DEFINER`, only `ebmr_app` may run it, and it inserts into the
   insert-only `md.master_fact` with `txid_current()`.
2. **Database guard.** `md.require_active(kind, code)` refuses (EBMR-MD-001, "No such active <kind>") unless a fact
   recorded **in this transaction** says active and matches the local id map. New migrations add one line to the
   existing write paths:
   - define and change of plant items;
   - lot receipt;
   - batch issue (product);
   - equipment use, through `fitness_problems`;
   - entry record, through `lot_facts` (material).

   A write that skipped the live check is refused by the database itself. The browser never supplies the fact.
3. **The rest is unchanged.** Fitness, lot status and all other Batchwright-only facts stay in their local tables, so
   the guards keep reading trusted local data.
4. **Values as at signing (PL-07).** Signed content hashes are computed from stored rows, never from a live master
   join. Each fact row keeps the code, name and version that applied.
5. **Connection off.** When the master read is refused (42501/28000), the screen shows "Connection to master data is
   off. Ask your administrator." Writes that need the read stop; existing records still open. Stale data is never
   served.

This keeps no browsable local copy (D-02): `md.master_fact` is evidence of each write-time check, not a master list.
The master-data screens shrink to the Batchwright-only fields; code, name and active are edited in core.

## Published views (platform links)

Deviations reads 10 views today (`BATCHWRIGHT_VIEWS` in its `server/readers/batchwright.ts`): `batch_fact_v1`,
`step_use_v1`, `cpp_value_v1`, `exception_v1`, `alarm_v1`, `batch_reference_v1`, `equipment_use_v1`, `ipc_result_v1`,
`process_actual_v1` and `exception_detail_v1`. The manifest publishes these, plus Operations' views (**list to
confirm with the lead**). Each one gets the following:

- `read_at` and `data_as_of` appended (adding columns is allowed in `_v1`);
- `security_barrier`.

A test compares their columns with `standalone`. The links are `deviations: { ebmr: [...] }` and
`ops: { ebmr: [...] }`. Deviations and Operations each switch `BATCHWRIGHT_REPORT_URL` to `EBMR_DATABASE_URL` in their
own repos (to coordinate).

## Permissions

See [`permission-list.md`](permission-list.md):

- **140 codes** in the manifest: each code checked today becomes `ebmr.<code in lower case>`, for example
  `ebmr.step.execute`, with today's description as the label.
- **23 codes** are not in the manifest:
  - 12 `IAM.*` codes, now done by core;
  - 5 backup and restore codes, now done by the platform;
  - 6 service-only codes, which stay local.
- **The 6 TypeScript role lists become codes:**
  - ADMIN/QUALIFICATION/ALERT readers → `ebmr.system.configure` / `ebmr.training.manage` / `ebmr.iam.alert_acknowledge`;
  - ALARM readers → `ebmr.alarm.acknowledge`;
  - SIMULATION/AUTHOR → `ebmr.mbr.author` / `ebmr.mbr.check`.

**Role → codes for the move:** the database's own `iam.role_permission`, applied to each person's current grants and
listed in the mapping report.

## Slices (each: branch, tests by rule/control ID, CI green, one review, squash-merge)

1. **Platform wiring.**
   - databsee `apps/ebmr/manifest.json` (codes, publishes, reads `master_data` equipment/instrument/room/material/product
     `_v1`, pinned commit), compose service, port 8109, config and secrets template.
   - Batchwright: `EBMR_DATABASE_URL` and the master pool, the database reached over the server's Unix socket, keys
     volume, and `test/platform` (a platform-initialised empty database migrates, starts, and passes its start-up
     checks).
2. **Sign-on, permissions and e-signature through core** (PL-01, PL-05, DI-08, DI-18, DI-35, EBMR-LIB-007), one slice
   as in Deviations (D-43): OIDC + PKCE, `iam.platform_grant`, work mode, proof → auth event, the platform build's sign-in
   and user-admin screens off.
3. **Master data** (PL-08, PL-07): the second pool, id maps, `md.master_fact`, `md.require_active`, connection off,
   reduced screens. Tests `PL-08 … refuses an inactive or unknown item` for each kind.
4. **Published views** (PL-08, PL-13): the listed views with `read_at`/`data_as_of`, and a column test against `standalone`.
5. **Demo alignment:** the demo seeds use the demo company's codes (`FG-RAB20`, `FG-LIB400`, `FG-LIB250`, `API-RAB`,
   `EQ-CMP-01`, `RM-105`, …) through core master data. Today's `RAB-GR-20`, `MAT-RAB-*`, `PRESS-01`, `DISP-1` and the
   other old codes are mapped one to one.
6. **Data move** (PL-13): `tools/platform/move-to-platform.ts` after MMS and Deviations. It applies every lesson:
   - dry run first;
   - `--link`, and the `u` prefix;
   - deactivated or locked people get no codes and lose existing `ebmr.*` codes;
   - identity, then master_data, as the outer transactions, so `ebmr` commits first;
   - no password hashes left in `ebmr`;
   - the bootstrap and start-up rows don't break the empty-database check;
   - `COMMIT` exported in manual compose runs;
   - per-table counts and checksums, the audit-chain and signature checks (`esig.verify_signatures`), and a mapping
     report.
7. **Cutover runbook** (written, not run):
   - domain and `proxy: external` with the `Caddyfile.host` blocks;
   - rollback: stop product + core → `dropdb --force` + `pg_restore --create -d postgres` for `ebmr`, identity and
     master_data → start core → licence off + apply → old app;
   - no other move or core admin between snapshot and rollback.

## Risks

1. **Superuser set-up** (decision 2): without it the migrations stop at the extra roles and the event triggers.
2. **Unencrypted platform database connection:** Batchwright refuses to start. Fix: the Unix socket (decision 3); no
   control is relaxed.
3. **Area and product scope on grants is lost:** platform codes are site-wide (D-16), so a grant can no longer be
   limited to one area or product. I will write this up for the owner against DI-08/DI-18 (controls are not edited).
   Qualification gates still apply per person.
4. **Controls whose function core now does** (lockout, password rules, grants, recertification: DI-03, DI-13 …): on
   the platform build these are evidenced by core's PL rules; `standalone` keeps its own tests. A control → PL map goes
   to the owner; `expert_decision` is not touched.
5. **Shop-floor badges:** badge tap and badge + PIN are off on the platform (core has passwords only). Shared
   terminals sign in at core.
6. **Passwords:** core uses scrypt and Batchwright argon2id, so hashes cannot be copied (decision 5).
7. **Size:** 639 migrations and ~20 E2E groups. The platform build runs the full suite once at the Phase B exit
   (decision 0008).
8. **The site gateway** stays a site component outside the platform. It talks to the `ebmr` API with its service key,
   as today.

## Decisions (recommendation first)

1. **Product name and address:** product and database `ebmr`, at `https://ebmr.187-126-126-5.sslip.io`, shown as
   "Batchwright" (*recommended*). The roles `ebmr_owner` and `ebmr_app` are fixed in 639 released migrations, and the
   platform derives roles, subdomain and redirect from the product name. The alternative, `batchwright`, needs a
   platform alias for the roles or the host. **The bare domain** becomes core at the joint go-live (apply's caddy
   blocks). Until then the standalone demo stays on it untouched; at go-live its host block is removed.
2. **Migrations:** apply runs Batchwright's own migrator once, as a superuser, in a one-shot `ebmr migrate` container
   (create + bootstrap on an empty database, upgrade otherwise), instead of copying its files to `db/ebmr`
   (*recommended*). This is how Batchwright installs today and what the upgrade drill proves. It needs a small platform
   change: a manifest `"migrate": "own"` in apply. Alternatives:
   - give `ebmr_owner` CREATEROLE, and still lose the DDL-audit event triggers, which would weaken a control (no);
   - flatten the 4 sources into `db/ebmr` and patch the superuser statements (that rewrites released migrations; no).
3. **Database connection:** the platform db's Unix socket is shared into the `ebmr` container with
   `EBMR_DB_ALLOW_LOCAL_SOCKET=1` (*recommended*, compose only). The alternative is TLS on the platform database for
   everyone (a platform change).
4. **Platform demo data:** start from the demo company (fresh, codes aligned). The move is proven in CI and by a full
   run on a copy of today's demo database (*recommended*). The alternative is to move today's demo records and remap
   their codes.
5. **Passwords for moved people:** core issues each one a temporary password (must change at first sign-in), and
   nothing is copied (*recommended*: no core change). The alternative is for core to accept argon2id hashes and rehash
   them to scrypt at the next sign-in.
6. **Work mode** for people whose codes mix administration and GMP, to keep DI-18 (*recommended*). The alternative,
   dropping DI-18 on the platform, would weaken a Batchwright control and needs the owner.
7. **The Operations view list** and the view versions: to agree with the lead (and the Operations session).
