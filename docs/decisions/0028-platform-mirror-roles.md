# Decision record 0028: platform mirror roles and DI-09 change control (Batchwright Phase B slice 2)

- **Date:** 3 November 2026
- **Decided by:** the lead (session_01PybpFurhHU4ktqworXhVvF), under the owner's delegation, and approved by the project
  owner (maglesT) in the slice 2 session: "approved, add the DI-09 exception as the lead described".
- **Builds on:** `docs/build-plan/phase-b/slice-2-design.md` (approved 3 Nov 2026), kernel 1196 (lead decision
  D-P6f-A-9: roles and permission sets are configuration areas ROLE and ROLE_PERMISSION), the owner note on access
  (`docs/build-plan/phase-b/owner-note-access.md`).

## Context

On the platform build, each person's codes from core's token become two per-person mirror roles (Work, Administration)
with an APPROVED grant, so that every access check of the kernel runs unchanged. DI-09 change control (kernel 1195, 1196)
refuses any write of `iam.role` or `iam.role_permission` without an approved change record. A first sign-on was
therefore refused (EBMR-CFG-001). A person's code set is that person's grant, decided and recorded at core's permission
register (PL-02), not site configuration; the kernel already treats role grants as a person's IAM acts, not configuration.

## Decisions

- **D-B2-1 (DI-09):** rows of a mirror role and of its permissions pass the ROLE and ROLE_PERMISSION change-control guard
  without a change record only when all of these hold (kernel 1400, `platform.is_platform_register_write`):
  - this is a platform build (`iam.platform_mode` exists);
  - the actor context is the one `iam.platform_sync_grants` installs: core's permission register (its SYSTEM person),
    role PLATFORM_SIGN_ON, source SYSTEM, the zero session, and core's grant reference;
  - the row's role is a mirror role named in `iam.platform_identity`.

  Each such row is still a configuration version (`platform.config_version`, basis PLATFORM_REGISTER, the register's
  person and core's grant reference in `platform_ref`). Every other write of a role or a role permission, customer roles
  and a write that imitates a mirror role outside the sync alike, still needs an approved change record. Tests (control
  ID DI-09): `apps/tablets-server/test/medhanta/platform-signon.test.ts`, "change control of the mirror roles".
- **D-B2-2 (INV-11, DI-18):** a token holding administration and GMP codes together is refused at sign-on, and the
  person's mirror grants are revoked until core corrects the codes. The message: "Your permissions for this application mix
  administration and GMP work, which Batchwright does not allow. Ask your platform administrator to give these
  permissions to two different people." Administration with governance or read-only codes chooses a work mode at sign-in.

No control text and no `expert_decision` is changed.
