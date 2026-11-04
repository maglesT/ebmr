# Phase B slice 6: the platform move, and its run on a copy of today's demo

The move (`tools/platform/src/move.ts`, CLI `tools/platform/src/cli.ts`) follows MMS's `db/move-to-platform.ts` and the
lead's contract of 4 November 2026. Its steps:

1. **Refusal.** It refuses unless the platform's `ebmr` database is a platform build with no records yet. Start-up and
   migration rows do not count.
2. **Dump, restore and compare.** It dumps the source in one snapshot and restores it on the platform server. Every
   table is counted and hashed on both sides (PL-13).
3. **Upgrade drill.** The upgrade drill (`tools/drills`) runs with the platform's migrations and must PASS. It compares
   tables, chains, renderings and spot checks. The platform build is then switched on. The move adds no
   `esig.verify_signatures()` problem; problems the source already has are carried over and counted.
4. **People.** Human accounts only.
   - Core login: the old login in lower case; `u` + login when it starts with a digit.
   - Each person gets an employee and its version 1.
   - The credential is reset in core: argon2id verifiers cannot become scrypt ones, and no hash is copied.
   - Codes: the ebmr.* codes of the person's live role grants, without the 23 codes the manifest leaves out.
   - Deactivated, suspended or locked people get no codes.
   - `--link` people keep their core identity and credential. They get the codes they lack, or lose their ebmr.* codes
     when they are off in the source.
   - Administration and GMP codes together: no codes, and the report says so (INV-11).
   - Administrators also get `core.people.manage` and `core.masterdata.edit`.
   - In ebmr, `iam.platform_map_existing` (kernel 1401) maps each person to their employee id and revokes their local
     role grants (PL-01).
5. **Master items.** Each local product, room, equipment, instrument and material code is linked in `md.item_map`. The
   link goes to the code map's master item (`--code-map`), or to the master item with the same code. When core has
   none, the move creates it as a moved item.
6. **One unit.** Identity, master_data and the ebmr copy are opened in that order. The copy commits first and takes the
   place of the empty `ebmr`; then master_data commits, then identity. A failure after that is undone by the
   runbook's rollback.

After the platform build is on, the sign-in login can no longer obtain a password or PIN verifier.
`iam.authn_prepare` and `iam.authn_secret_history` are revoked from `ebmr_authn` (platform-migrate.ts). The verifiers
stay in their insert-only table, which no login reads; no audit history is rewritten. The move checks both.

Tests: `tools/platform/test/move.test.ts`, tagged [PL-01], [PL-03], [PL-07], [PL-08], [PL-13] and [INV-11]:
- a dry run, a refused unlinked person, the move, codes and withdrawals;
- links reused and created, and no second run;
- a moved person signs in through core as the same account.

## Run on a copy of today's demo (4 November 2026)

The source was today's full demo set-up (`setup.ts --gmp-review-batch --gmp-packaging --gmp-sr-profile
--gmp-p3-demo`), built on this tree in a scratch cluster. The live demo server was not touched. The platform side was
a platform-initialised `ebmr`, with stand-ins for identity and master_data. master_data held the demo company's
items named in `demo-code-map.json`.

| | |
|---|---|
| Result | PASS, committed, in 107 s |
| Source | 623 tables, 73,504 rows; restored copy identical (counts and hashes) |
| Upgrade drill (platform migrations) | PASS |
| Signatures | 62 problems after, all 62 already in the source (none added) |
| People | 28 moved, all new in core; 0 refused |
| Master items | 39 linked through the code map, 71 created as moved items |
| Checks | every account mapped; no local grant left; every item linked; no login reads a verifier; platform build on |

**Finding for the lead:** the demo source itself has 62 signatures that `esig.verify_signatures()` reports as
`CONTENT_CHANGED_WITHOUT_INVALIDATION` (INV-09). This is the standalone build's demo data and is not caused by the
move. It needs a look before go-live.
