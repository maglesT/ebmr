# Module brief B7: authority checks across the kernel modules (DI-17, DI-18 wiring)

The identity module (iam, migrations 0100-0190, packages/kernel/src/identity/README.md) provides persons, accounts, a
role and permission catalogue, scoped grants, `iam.require_permission(permission, scope)`,
`iam.evaluate_authority(...)` (stores every evaluation, INV-26) and `iam.assert_not_administrator()` (DI-18). The other
modules were built in parallel and today accept ANY validated actor for their mutating functions. Your job: make every
mutating kernel function check the actor's permission, and keep administrators out of GMP data.

Paths you may change:
- New migrations packages/kernel/sql/0700_*.sql .. 0799_*.sql (they run after every module and after nothing else;
  the lead's 0900 integration file runs later).
- Function bodies in packages/kernel/sql/03xx (market), 04xx (records), 06xx (continuity) and
  packages/site-services/sql/0600_*.sql: add the authority calls, nothing else unless a check needs a small helper. These
  migrations are on no persistent database, so edit them in place.
- If the permission catalogue cannot take new rows from a later migration, you may make the smallest necessary change
  in packages/kernel/sql/0120_iam_roles_grants.sql (explain it in your final message).
- Tests: packages/kernel/test/{market,records,continuity}/**, packages/site-services/test/**, and a new
  packages/kernel/test/integration/authorization.test.ts. Do not edit test/support/*, test/identity/*, the
  platform tests, packages/kernel/src/index.ts, package.json files or 0001/0010/0900.
- READMEs of the modules you touch (a short "Permissions" section each).
- compliance/controls/DI-17.yaml and DI-18.yaml: append your test names to `tests` and implemented_by entries; do not
  remove what is there.
Do NOT touch anything under esig (migrations 02xx, src/esig, test/esig): another agent is building e-signatures right now.

Build:
1. Permissions: add catalogue entries for every protected action, named in the catalogue's existing style, with the
   right domain/effect, and map them to the kernel roles that should hold them (read the role list and the features doc
   docs/design/features-ux-roles-configuration.md; least privilege). Actions, at minimum:
   - market: publish a rule table (normal and SOURCE_CORRECTION), set/apply a site value, define a policy / set a policy
     version / apply a policy tightening, record stub scope data (stub tables are test scaffolding: keep them usable by
     whatever role the tests need, but gate them too).
   - records: define and approve record types, create/update retention schedules and dependencies, place/release legal
     holds, approve a purge, purge, raise/link/reclassify/investigate/assess/close incidents, CERT-In marking and
     reporting, open/link/refresh/close DI investigations, register a true copy. Suggested by the records author:
     RECORD.DISPOSAL_APPROVE, RECORD.LEGAL_HOLD, INCIDENT.CLOSE, VALIDATION.MANAGE (existing) for DI investigations, a
     register-approval permission. Raising an incident must be possible for SYSTEM service accounts (the time monitor
     raises incidents through platform.raise_time_incident inside its own command) and for shop-floor roles.
   - continuity: record/approve restore events, run after_restore, record backup jobs and restore drills (SYSTEM only,
     already enforced by source), record/revoke hardening attestations (IT/system administration: this is not GMP data,
     so administrators hold it), acknowledge alarms, reserve counter ceilings.
   - site (batch-number register): define rules, allocate, register external numbers, void, recover.
   - platform: the permissions the platform already names: platform.settings.change, platform.time_source.manage,
     platform.alarm.clear, sample_record.submit/check/approve/retire (sample machine; test scaffolding).
2. Platform AUTHORITY adapter: a function with the hook signature `(permission text, actor jsonb, aggregate_type text,
   aggregate_id text) returns text` (NULL = allowed, else the reason) over iam.evaluate_authority, registered with
   `platform.register_hook('AUTHORITY', ...)` in your 07xx migration (platform exists by then). Decide and document how
   the scope is derived (the platform passes aggregate type and id only; the actor's session carries site and room).
   Platform tests install stub hooks that override the registration; add your own test of the real adapter in
   test/integration/authorization.test.ts.
3. DI-18: call iam.assert_not_administrator() in every function that creates or changes GMP data (records, market rules
   and policies, site batch numbers, restore approvals). Not in pure IT functions (hardening attestations, backup
   catalogue, drift/time-source administration if you classify it as IT: justify in the README).
4. Tests: every existing test must keep passing with real seeded identities (test/support/seeded-actor.ts; each module
   helper's testActor({roleCode}) seeds a person holding that role). Change role codes in tests where the role that now
   holds the permission differs. Add negative tests, named with [DI-17] (and [DI-18] where an administrator is refused),
   at least one per module: e.g. "[DI-17] an operator cannot publish a rule table", "[DI-17] a QC analyst cannot approve
   a purge", "[DI-18] a system administrator cannot allocate a batch number". Add a test that the permission-to-role map
   has no role holding both an ADMINISTRATION-domain permission and a GMP permission (INV-11 must still hold).

Conventions: read docs/build-plan/phase-1/00-common-brief.md (the hard rules and conventions still apply: no commits,
no installs, pg_temp last in every SECURITY DEFINER search_path, error codes, paraphrase regulations). Run the whole
suite at the end: `npx vitest run packages/kernel packages/site-services` must pass except for tests inside
test/esig (another agent's work in progress; report their failures, do not fix them). Typecheck with
`npx tsc -p tsconfig.json`, lint your files with `npx eslint <paths>`, and `pnpm -s register:validate`.
Final message: files changed, permissions added and their role mapping (a table), functions gated, tests added, anything
the lead must decide.
