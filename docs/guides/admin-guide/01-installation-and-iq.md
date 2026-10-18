# Installation and the IQ

## What an installation is

A site runs two installations of Batchwright Tablets, each with its own server and its own PostgreSQL 16 database:

| Installation | Database | Purpose |
|---|---|---|
| GMP | a GMP database (kernel, site services, recipe-core and the Tablets SQL) | the real batch records |
| Sandbox | a sandbox database, provisioned by the kernel, every screen marked TEST, NOT GMP | test runs of MBRs, training |

The rules that matter for GMP live in the database: who may do what, the signatures, the audit trail, the limits. The
server and the screens show and ask; the database decides. So the database's settings, roles and privileges are part of
what is qualified.

The web application is served by each server from the same address as its API, under a strict content security
policy. Browsers reach it over TLS; the database connection uses TLS too (`ops/postgres/postgresql.tls.conf.template`
and `pg_hba.conf.template`).

## Before the installation

- A PostgreSQL 16 cluster per installation, with the settings of the templates in `ops/postgres/`.
- The server's keys and secrets in the site's vault (a KMS or HSM): never the DEMO-ONLY files of the demo set-up (the IQ
  check refuses demo keys).
- The time source the site trusts, configured for the database host (the database's clock is the clock of every
  record).
- For each interface off the server's own host: its certificates ([Adapters](05-adapters-and-system-description.md)).

The demo and test set-up script (`apps/tablets-server/src/cli/setup.ts`) is never used for a production installation:
it seeds DEMO-ONLY credentials and keys.

## The installation qualification (IQ) (as planned; checked at 7f)

Slice 7c delivers an executable IQ check (`pnpm validation:iq`) that writes the IQ record with the expected and the
actual value of each check:

- the release identity: the hash of the database's migration ledger (`platform.schema_release()`) equals the release's;
- the package and image versions and digests against the SBOM;
- every expected trigger, constraint and privilege enabled, and the database roles' attributes;
- the locked settings: demo keys refused, plain HTTP refused, the TLS and password settings of PostgreSQL;
- the adapters against the approved system description.

The customer's operational and performance qualification (OQ, PQ) follow from the validation pack (slice 7c).

## The release identity

The database knows which release it runs: `platform.schema_release()` is the SHA-256 over the migration ledger, the
same value whatever order the migrations were applied in. The validation summary approval and the IQ record both name
it (see [Validation summary approval](10-validation-summary-approval.md)). The about page of the application shows the
server's version.
