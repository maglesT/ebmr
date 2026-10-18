# Known issues

What Batchwright Tablets v1.0 does not do yet, or does only in part. The full list for a release is generated from the
backlogs into the validation pack (slice 7c); this page lists what an administrator or a user meets first.

## No screen yet

These acts work, with every check in the database, but have no screen in v1.0. They are done through the server's
routes or the database functions named in this guide, under a named account.

| Area | What has no screen | Where it is described |
|---|---|---|
| People and access | people, accounts, credentials, badges, role grants, recertification, break-glass | [Users, roles and recertification](03-users-roles-and-recertification.md) |
| Devices | terminal registration, balance, printer and equipment bindings, gateway keys | [Devices, gateways and their keys](04-devices-gateways-and-keys.md) |
| Master batch records | the Prepared, Checked, Approved and regulatory-confirmation signatures; the market authorisations | [MBR author](../user-guide/06-mbr-author.md) |
| Plant rules | the penicillin facility rule and the beta-lactam classification: the proposal and QA's approval | [Master-data steward](../user-guide/05-master-data-steward.md) |
| Incidents | the incident register and the CERT-In reporting step | [Incident handling](11-incident-handling.md) |
| System description | recording an interface of the approved system description | [Adapters](05-adapters-and-system-description.md) |

## Coming in the Phase 7 slices (as planned; checked at 7f)

- The periodic evaluation pack and the readability report (7b-2).
- The stand-alone viewer of a full export (7b-2).
- The scheduled reconciliation of every adapter (7b-1).
- The validation pack, the IQ and OQ scripts, the validation-summary interlock at batch issue and the interface-drift
  refusal (7c).
- The restore, upgrade and migration drills, the load and soak runs, the security checklist and the accessibility audit
  (7d).

## Rules waiting for a decision

- **Controlled substances** (IN-53) are a draft: the screens carry a draft banner until the expert's decision.
- **The CERT-In window** (6 hours) comes from secondary sources and is not yet verified against the official text
  ([Incident handling](11-incident-handling.md)).

## Branding

- The Batchwright wordmark in the logo files is text set in Poppins Bold; where that font is not installed the browser
  shows a similar font. A designer converts it to outlines before print or launch (decision 0020).
- The Medhanta logo is the 278 x 148 px file; the larger file for printed documents is still to come from the owner.
- The name goes through the trademark search before launch (decision 0020).
- The browser-tab and app icons are served under fixed names with a long cache time: a changed icon needs a new file
  name to reach browsers that already have the old one.
