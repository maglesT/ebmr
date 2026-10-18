# The analytics runner

The analytics (control charts, capability, deviation rates, multivariate monitoring, golden-batch profiles, review
priority, audit-trail flags) are advisory. They never change a GMP record: every decision on a flag is a person's,
with their own signature where one is needed. The analytics run in their own process, the **runner**, with their own
database role.

## The runner and its role

- The runner starts with the server on the GMP installation only (`EBMR_ANALYTICS`, on by default; a sandbox never
  runs it). It connects with its own login, `ebmr_analytics` (a vault credential in production), reads only the input
  views registered for it, in one snapshot, and records its results only through the analytics schema's functions.
  It cannot write a GMP table.
- It runs nightly at 02:00 site time and after a batch completes.
- Reporting tools connect as `ebmr_report` and read `report.catalog_v1` and the views it lists.
- It runs only the method versions QA put in force, and scores only against reference sets QA approved. It refuses a
  method version whose recorded code identity or parameters are not the running code's (a FAILED run with the reason).
- After any change of grants, `select * from sandbox.segregation_problems()` must stay empty.

## Putting a method version in force

1. Validate the version on the build that will run it (its known-answer tests and acceptance criteria).
2. Raise a configuration change record for the area `ANALYTICS_METHOD` and have QA approve it.
3. As a holder of `ANALYTICS.METHOD` (QA reviewer or system owner), open **Analytics**, then **Methods, versions and
   monitoring** (`/analytics/methods`), and make the version effective with the change-record number and a reason.
4. Check that the version is listed as in force, and that **Configuration history** (`/config/history`) shows it.
5. To retire a version, use the same form with status Retired. A changed method is always a new version.

## Approving a reference set

1. A run without a reference set fits a model candidate and lists the batches it used and the ones it left out, with
   why.
2. Raise a change record for the area `ANALYTICS_REFERENCE` and have QA approve it.
3. As a holder of `ANALYTICS.METHOD`, make the candidate the reference set on **Control charts and deviation rates**
   (`/analytics/spc`), **Multivariate monitoring** (`/analytics/mspc`) or **Golden batch profiles**
   (`/analytics/profiles`), with the change-record number and a reason. A set never changes; a new selection is a new
   set.

The developer's version is in the handbook's
[runbook](../../handbook/10-runbooks.md#analytics-method-versions-and-reference-sets-phase-6a).
