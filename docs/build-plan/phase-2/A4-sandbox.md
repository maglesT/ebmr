# Module brief A4: sandbox, training and simulation store (DI-05, INV-18)

Paths: packages/kernel/sql/0800_*.sql .. 0899_*.sql (kernel range reserved for you; schema `sandbox`),
packages/kernel/src/sandbox/**, packages/kernel/test/sandbox/**, docs/design/sandbox.md. Controls: DI-05 (segregation of
non-GMP functions: training, simulation, sandbox, analytics). Invariant: INV-18 (test, simulation and training data live
in a separate database; GMP batches only from CURRENT or BRIDGING versions).
Read: outline 6.5 (sandbox test runs), 4.2 (topology), 7.4 (training), ADR 0001 point 2 (a physically separate
ebmr_sandbox_<edition> database whose role holds no grants on any GMP database), ADR 0012, 0016; the DI-05 control file;
decision 0003 (testing scope).

Build:
1. A sandbox database layout: the sandbox runs the same kernel and recipe migrations in a separate database
   (ebmr_sandbox_<edition>), with its own login role ebmr_sandbox that has CONNECT only on sandbox databases. Provide a
   TS provisioning function (create database, migrate, mark it as sandbox) and a marker in the database itself
   (kernel.installation_kind = 'SANDBOX' vs 'GMP', set once at provisioning, immutable) that every GMP-issuing path can
   check; in the GMP database the marker is 'GMP'.
2. Reserved identifiers: sandbox batch numbers, lot numbers and person/device labels use a reserved prefix/format that the
   GMP database refuses (a check function other modules call, plus a table of reserved patterns) and the sandbox refuses
   anything that looks like a real GMP identifier pattern (reuse of a real lot number is blocked: the test in DI-05).
3. Watermark: every rendering/export helper in the sandbox marks output "TEST, NOT GMP" (provide `watermarkFor(kind)` and
   make the true-copy bundle builder in records include the installation kind: coordinate by exporting a function the
   records module can call; do not edit records files: tell the lead what to wire).
4. Bypass tests: from the sandbox role, connecting to the GMP database is refused; with any credentials the sandbox
   holds, writing to a GMP table is refused; a sandbox-provisioned database refuses to be marked GMP later; a GMP
   database refuses the reserved sandbox identifiers.
5. docs/design/sandbox.md: how sandbox, training and simulation mode share one store, what is copied from GMP (approved
   MBR versions, master data snapshots) and how, and what never is (lots with status, real batches, persons' secrets).
Create the role ebmr_sandbox in your migration idempotently (like kernel 0001 does for its roles). Tests use the existing
harness (packages/kernel/test/support) and may create extra databases through the admin connection.
