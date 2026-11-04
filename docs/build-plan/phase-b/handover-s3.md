# Handover: Phase B, slice 2 done → slice 3 next

Written 4 Nov 2026 by the slice 2 session (`session_01PybpFtJvZZchsek7SCfvG2`) for a fresh session. Lead:
`session_01PybpFurhHU4ktqworXhVvF`. Report to the lead after each merge and for decisions, with the claude-code-remote
`send_message` tool. Owner rules: CLAUDE.md, no model name in commit trailers, squash-merge yourself once CI is green
and the one review pass is done.

## Slice 2 (merged, #89, 2fea87f)

Sign-on, permissions and e-signature through core on the platform build. Read `slice-2-design.md`, decision 0028 and
the owner note section 3 if you touch access.

- **Kernel 1400:**
  - `iam.enable_platform_build()`, which the platform migrator calls at the end of its run;
  - `iam.platform_identity`, the map from core's employee id to person, account and mirror roles
    `PLATFORM_<account hex>_WORK` / `_ADMIN`;
  - `iam.platform_sync_grants`, which spends the proof's nonce first, then mirrors the token's `permissions` through the
    kernel's request and approval rows;
  - `iam.platform_auth_event`, the PLATFORM event for LOGIN or SIGNATURE, made in the same transaction as the sync;
  - the DI-09 path of the mirror roles (`platform.is_platform_register_write`, basis PLATFORM_REGISTER).
- **Core's contract (databsee `deploy/apply.ts`, `apps/hello`):**
  - environment: `OIDC_ISSUER`, `OIDC_CLIENT_SECRET` and `OIDC_REDIRECT_URI`; the client id is `ebmr`;
  - endpoints: `<issuer>/auth`, `/token` (Basic auth, PKCE) and `/me`, which returns sub, name and permissions;
  - scope `openid profile permissions`.
- **Decisions:**
  - the ID token's signature is not checked (OIDC Core 3.1.3.7(6)); add a check if core turns out to publish keys;
  - a token with administration and GMP codes together is refused (INV-11);
  - the refusal messages name no product (decision 0020).
- **Tests:** `apps/tablets-server/test/medhanta/platform-signon.test.ts` (13 tests, fake core in
  `test/support/fake-core.ts`), plus the SQL mutation group `platform-identity`.
- **Left open:**
  - the platform first-run set-up (design section 4: site code, name, zone and seal key; the first administrator is
    whoever core gives `ebmr.system.configure`);
  - unlocking an idle lock through core (until then, a locked platform session signs in again);
  - pending sign-ons are kept in memory (one instance).

## Next: slice 3, master data

`md.master_fact` and `md.require_active`; see `platform-move-plan.md`. Then slice 4 (views), 5 (demo codes), 6 (move
script, which also maps existing people to core's employee ids, since the sync refuses a login already issued) and 7
(runbook).

The lead's notes for slice 4, from the Deviations link review:

- the ebmr report views stay owner-rights views (not `security_invoker`);
- they must not call functions revoked from PUBLIC;
- test a read as `deviations_app` and as `ops_app`;
- no TLS enforcement for linked readers (internal network).

## Environment notes

- The local PostgreSQL 16 `main` cluster needs the superuser role `ebmr_dev`/`ebmr_dev`. Create it with
  `su postgres -c "psql -c \"create role ebmr_dev login superuser password 'ebmr_dev'\""` after
  `pg_ctlcluster 16 main start`.
- The permission checker refused attaching `maglesT/databsee` and `maglesT/dev-mang-modu`. Ask the lead for contract
  details.
- Force-push is refused: merge main into the branch instead of rebasing.
