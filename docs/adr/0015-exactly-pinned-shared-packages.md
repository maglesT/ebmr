# ADR-0015: Exactly pinned shared packages

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001); Phase 0 stand-in set by the build lead
- **Supersedes:** none

## Context

- Both editions depend on shared packages: `kernel`, `site-services`, `expr`, `recipe-core`, `ui-kit` and `integration-sdk` (ADR-0011).
- Each edition is validated on its own. A change to shared code may reach an edition only through that edition's change control, and every edition release must identify exactly which shared versions it contains (L-57).
- A plain workspace link (`workspace:*`) or a version range would let an edition pick up shared changes silently at the next build.
- The outline specifies a private registry with Changesets, maintenance branches per kernel minor line and a written backport policy (outline 4.3). No registry exists in this environment during Phase 0.
- Kernel migrations change the edition databases, so they must travel with the kernel version.

## Decision

1. **Exact pins only.** Every dependency of an app or package on an internal `@ebmr/*` package names one exact version. Ranges, `workspace:*`, `workspace:^` and `workspace:~` are forbidden. External dependencies are also saved exactly (`save-exact=true` in `.npmrc`).
2. **Phase 0 stand-in: exact workspace pins.** Until the registry exists, internal dependencies use the pnpm workspace protocol with an exact version, for example `"@ebmr/kernel": "workspace:0.1.0"`. pnpm resolves such a specifier only to a workspace package that satisfies it, and rewrites it to the plain version (`0.1.0`) when packing, so manifests already carry exact versions.
3. **CI check.** The `pins:check` step of `pnpm run ci` fails if any app's or package's pin on an internal package does not equal the `version` field of the package it builds against at that commit, or if an internal dependency uses a range or a bare `workspace:` specifier. Raising a shared package's version therefore forces an explicit, reviewable pin change in each dependant.
4. **At deployment: private registry with Changesets.** Before the first customer validation the stand-in is replaced: shared packages are versioned with Changesets and published to a private registry with provenance; each edition depends on exact published versions, never on the workspace copy. CI builds each edition against its pinned versions (blocking) plus a canary build against HEAD (informational, triaged by the package owner). Kernel migrations are versioned and published with the kernel.
5. **Maintenance lines.** A maintenance branch is cut for each kernel minor line (x.y) that a released edition pins; `recipe-core`, `expr` and `site-services` follow the same rule.
6. **Backport policy per kernel minor line.**
   - A minor line is supported while any supported edition release pins it.
   - Backported: fixes for security vulnerabilities, for data-integrity defects (audit trail, signatures, attribution, time, retention, sealing) and for wrong regulatory rule evaluation. Not backported: features, refactors, and dependency upgrades other than security fixes.
   - A fix lands on the main line first where it applies, then is cherry-picked to each affected supported line and released there as a patch version with its own changeset, release notes naming the affected controls, semantic-change report (ADR-0010) and validation delta.
   - A patch release makes no incompatible schema change; a migration added on a maintenance line is carried forward to every later line, so an edition moving up never skips it.
   - An edition takes a patch only by changing its pin under its own change control.
   - Until `REPO-GUIDE.md` carries it, this ADR is the written backport policy.
7. Each edition's release notes and SBOM list the exact shared versions, and every batch records the software release it ran on (DI-03).

## Consequences

### Positive

- A shared change reaches an edition only through a visible pin change that edition's owners approve.
- An edition's validated state names exact shared versions, which the IQ script can check against the SBOM.
- Moving to the registry is mechanical: the published manifests already hold exact versions.
- Supported lines receive security and data-integrity fixes without forcing feature upgrades on validated customers.

### Negative

- The Phase 0 stand-in cannot let editions run different kernel versions at the same commit; a version bump must update every dependant in one change. The Phase 0 exit criterion "an edition skeleton builds against a published kernel" is met in this stand-in form and fully only once the registry exists.
- Every shared version bump touches several manifests, which adds review friction by design.
- The registry needs hosting, access control, backups and provenance signing; maintenance branches and backports cost engineering time.
- A red canary with green pinned builds needs a triage rule so it is neither ignored nor allowed to block edition releases.

## Alternatives considered

- **`workspace:*` or version ranges.** Rejected: silent drift; an edition would absorb kernel changes without its own change control.
- **Vendored copies or git submodules per edition.** Rejected: copies drift and are hard to audit.
- **One repository per shared package.** Rejected: cross-package changes and CI become slow and fragmented; the monorepo keeps boundaries through lint instead.
- **One lockstep version for the whole monorepo.** Rejected: editions could not be validated and upgraded independently.
- **Publishing to the public npm registry.** Rejected: exposes proprietary code.

## Related controls and invariants

- Controls: DI-03 (computerised-system validation; software release per batch), DI-06 (system inventory and traceability), DI-09 (change and configuration management), DI-13 (security baseline: signed artefacts, SBOM).
- Invariants: none directly; pinning protects every invariant implemented in shared packages from unreviewed change.

## References

- Build outline v0.2: sections 4.3 (Exact pinning that really works), 10.1 (CI on every change), 11 Phase 0, 12 risk 11.
- Resolution log: L-57.
- Architecture research: 7.3.
