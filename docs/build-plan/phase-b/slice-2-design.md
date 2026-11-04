# Phase B slice 2: sign-on, permissions and e-signature through core. Design

Status: draft for the lead, 3 Nov 2026. This revises the approved plan's mechanism for access. The goal is unchanged:
codes come from core's token, and re-authentication happens at core. Only the way the kernel consumes them changes,
so that every existing database check runs unchanged.

## Why a revision

The kernel's access checks read roles everywhere:

- `evaluate_authority` joins `role_grant` → `role_permission`;
- `assert_not_administrator`/DI-18 asks whether the session's role has an ADMINISTRATION permission;
- `can_sign` needs a live role with a SIGN permission;
- `validate_actor_context` re-checks the session's role grant on every command;
- static segregation forbids any role that mixes ADMINISTRATION and GMP.

The plan's `iam.platform_grant`, read instead of roles, would have meant rewriting each of these. Instead, slice 2
turns the token into the data these checks already read.

## 1. Codes become two per-person mirror roles

- At each sign-on, the token's `ebmr.*` codes are mapped back to today's codes (`ebmr.step.execute` → `STEP.EXECUTE`)
  and split by the permission's domain:
  - **`P:<login>:WORK`** holds the GMP, GOVERNANCE and READ_ONLY codes;
  - **`P:<login>:ADMIN`** holds the ADMINISTRATION codes.
- These roles belong to that one person. Their `role_permission` rows and their APPROVED `role_grant` are brought in
  line with the token, insert-only as today:
  - a code removed at core is revoked here at the next sign-on;
  - no codes left means the grant is revoked.
- The grant is recorded as decided by the platform's permission register: who, when, and core's grant reason (PL-02).
  A new function `iam.platform_sync_grants` writes these rows. It is `SECURITY DEFINER`, only the authn login may run
  it, and it is called only after core's token has been verified.
- **Role choice** becomes the work mode (decision 6), with "Work" and "Administration". Only someone with both roles
  is asked. DI-18 and static segregation hold unchanged, because neither role mixes the two domains.
- **Unchanged:** `evaluate_authority`, `can_sign`, `validate_actor_context`, qualification gates by permission,
  account-kind rules and authority logging.
- **Scope:** site-wide (owner note §1).
- **Qualification requirements set per role** cannot attach to mirror roles. On the platform a site sets them per
  permission (the kernel already supports both). The move script converts any per-role requirement into
  per-permission ones and lists them in the mapping report.

## 2. Core's sign-ons become ordinary authentication events

- **New `iam.auth_event.method` `PLATFORM`,** with components `{USER_ID, PASSWORD}`: core asked for both, PL-05.
- **New `iam.platform_auth_event(employee_id, purpose, challenge, device_fingerprint, auth_time)`**, authn login only.
  It writes the same `auth_event` (and `authn_attempt`) rows as `authn_finish`, for purpose LOGIN or SIGNATURE.
- **Sign-in:**
  1. The browser goes to core (code + PKCE).
  2. `/cb` verifies the tokens and gives the page a short HMAC proof (sub, codes, auth_time, nonce), as Deviations does.
  3. The page posts it to `POST /api/session/login` `{method: 'PLATFORM', proof}`, with the usual device proof.
  4. The server checks the proof and its one-time nonce, finds or creates the person, syncs the grants, writes the LOGIN
     event, then calls `open_session` and `bind_session` unchanged.
- **Signing:**
  1. The sign dialog opens core with `prompt=login` and `max_age=0`, after the challenge exists.
  2. `/cb` refuses when `auth_time` is earlier than the challenge's start.
  3. The proof goes back to the dialog, and the sign request carries it instead of the password.
  4. The server checks: sub = the session's person, the meaning's codes are in the proof, the nonce is unused. It then
     writes the SIGNATURE event bound to the challenge.
  5. `esig.sign` consumes it unchanged: same account, same device, after the challenge, one use. ESIG-034/036/040/042,
     DI-35 independence, EBMR-LIB-007 and the manifestation are all untouched.
- **Session-relaxable later signings** (PRIVATE component only) still ask core for the password. Core cannot ask for
  the password alone.

## 3. People

- New `iam.platform_identity(person_id, account_id, employee_id unique, login)`: the id map.
- At first sign-on a NATURAL person and a HUMAN account are created. Identity verification is recorded as done at
  core (PL-03, with core's employee id). The login is core's, never reused (PL-03).
- No password credential exists, so `can_sign`'s expired-password rule has nothing to block.
- The e-signature acknowledgement (policy version) stays Batchwright's own screen, as today (DI-21).
- A person with no `ebmr.*` code is refused at core (PL-01). A person who loses every code is refused here too: their
  grant is revoked at the next sign-on.

## 4. Switched off on the platform build (a flag the platform migrator sets)

- Local password, badge and PIN sign-in and signing.
- Lockout and unlock, credential issue, the people, account, grant, delegation, break-glass and recertification screens
  and routes: core does these (owner note §2).
- The routes answer 404 or 410 with "Managed in the platform".
- First-run set-up becomes: site code, name and zone, plus the seal key. The first administrator is whoever core gives
  `ebmr.system.configure`.

## 5. Tests

- **New tests by control ID**, on a platform-flagged database: DI-14, DI-16, DI-17, DI-18 (work mode), DI-19 (no
  local password path), DI-35 (independence with core re-auth), DI-38 (auth_time after the challenge; proof bound to
  person, code and nonce), EBMR-LIB-007, plus the platform's PL-01 and PL-05.
- **The existing suite stays standalone.** About 118 files use local login helpers. Because the platform build is a
  flag, they keep running unchanged, and nothing is weakened on either build.

## Size

This is one slice, as in Deviations (D-43). It is the biggest of Phase B: kernel migrations (sync grants, auth event,
identity map, flag), server routes (`/cb`, `/sign`, login method, disabled admin routes) and the web sign-in and sign
dialog.
