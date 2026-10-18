# Users, roles and recertification

Access is the regulation-required core of the system, and the database enforces it (DI-14 to DI-18, INV-11). This page
describes what the system administrator and the system owner do; the full lists of rights and roles are in
[Rights, roles and signature meanings](../reference/permissions.md).

In v1.0 people, accounts, grants and devices are managed through the kernel's database functions (the `iam` schema),
called by the administrator's tools under their own named account; there is no administration screen yet (see
[Known issues](12-known-issues.md)). Every call is attributed and audited like any GMP act.

## People and accounts

| Task | Function | Right |
|---|---|---|
| Record a person (legal name), verify their identity | `iam.create_person`, `iam.record_identity_verification` | `IAM.PERSON_MANAGE`, `IAM.IDENTITY_VERIFY` |
| Create an account (human, service, integration or read-only display) and activate it | `iam.create_account`, `iam.activate_account` | `IAM.ACCOUNT_MANAGE` |
| Issue an initial password or PIN (changed at the first sign-in) | `iam.issue_credential` | `IAM.CREDENTIAL_ISSUE` |
| Issue a badge, report one lost, revoke it | `iam.issue_badge`, `iam.report_badge_lost`, `iam.revoke_badge` | `IAM.CREDENTIAL_ISSUE`, `IAM.ACCOUNT_MANAGE` |
| Unlock an account locked after failed sign-ins | `iam.unlock_account` | `IAM.UNLOCK` |
| Suspend, deactivate or reinstate an account; process a leaver | `iam.suspend_account`, `iam.deactivate_account`, `iam.reinstate_account`, `iam.process_leaver` | `IAM.ACCOUNT_MANAGE`, `IAM.PERSON_MANAGE` |

A login name is never reused, and a person keeps one legal name in every record (a rename is recorded, not
overwritten).

## Role grants: requested by one person, approved by another

A role is granted to an account for a scope (a site, and where it applies a product). A grant is requested by one person
and approved by a second; the grantee is a third. Nobody revokes their own grant.

| Task | Function | Right |
|---|---|---|
| Request a role grant for an account and scope | `iam.request_role_grant` | `IAM.GRANT_REQUEST` |
| Approve or refuse it | `iam.decide_role_grant` | `IAM.GRANT_APPROVE` |
| Revoke a grant | `iam.revoke_role_grant` | `IAM.GRANT_REVOKE` |
| Ask to add a right to a role, and decide on it (neither person holding the role) | `iam.add_role_permission`, `iam.decide_role_permission` | `IAM.ROLE_MANAGE`, `IAM.GRANT_APPROVE` |
| Approve a delegation of a role for a period | `iam.decide_delegation` | `IAM.DELEGATION_APPROVE` |
| See who held which right at any instant | `iam.access_list` | none (a read) |

The database refuses, at the request and again at the approval:

- a person holding an administration right and a GMP right, in any scope and through any of their accounts (INV-11);
- a shared or read-only display account with anything but read rights;
- a service or integration account with a signing or acknowledging right;
- a break-glass account with a GMP, signing or acknowledging right.

## Recertification

Access is recertified periodically: the system owner confirms that each account still needs each grant.

| Task | Function | Right |
|---|---|---|
| List the accounts due for recertification | `iam.recertification_due` | none (a read) |
| Recertify an account (or revoke what it no longer needs) | `iam.recertify_account` | `IAM.ACCESS_RECERTIFY` |
| Record a user's US e-signature certification | `iam.record_us_esig_certification` | `IAM.CERTIFICATION_RECORD` |

The periodic evaluation pack lists the recertifications done in its period
([The periodic evaluation pack](09-periodic-evaluation-pack.md)).

## Break-glass and vendor support

| Task | Function or screen | Right | Signature meaning |
|---|---|---|---|
| Request break-glass access, and approve it (a second person) | `iam.request_break_glass`, `iam.approve_break_glass` | `SYSTEM.CONFIGURE`, `IAM.BREAK_GLASS_APPROVE` | none |
| Review a break-glass session afterwards | `iam.review_break_glass` | `IAM.BREAK_GLASS_APPROVE` | none |
| Request vendor support access | `/governance/support` | `SUPPORT.GRANT_REQUEST` | none |
| Approve it for IT, and for QA | `/governance/support` | `SUPPORT.APPROVE_IT`, `SUPPORT.APPROVE_QA` | `SUPPORT_ACCESS_IT_APPROVED`, `SUPPORT_ACCESS_QA_APPROVED` |
| Register a digital signature certificate anchor | `/governance/dsc` | `SYSTEM.CONFIGURE` | none |

A vendor support session is time-limited, approved by both IT and QA, read-only for GMP data, and every act in it is
audited.
