# Decision record 0025: every act a person performs has a screen in v1.0, for the demo and for testing

- **Date:** 18 October 2026
- **Decided by:** project owner (maglesT), in the Phase 7 session ("we want everything to be there for demo and testing
  on web app, users, registering devices, all things"; "its not just demo its testing of all features of the system,
  developers as well as pharma professional would use it so all things have to be there and also we shouldnt have to
  write code in terminal like before while using it"), on hearing which acts had no screen in v1.0.
- **Amends:** the Phase 7 plan (`docs/build-plan/phase-7/phase-7-plan.md`): a new slice **7g** before the exit (7f).
  It also amends the v1.0 known issues of slice 7e: the "No screen yet" list is emptied by 7g.

## Decision

1. Every act a person performs in Batchwright Tablets has a screen in the web app at v1.0-rc. That includes the acts
   that had none:
   - people and access: people, accounts, credentials, badges and PINs, role grants (request and approval),
     recertification, break-glass;
   - devices: terminal registration and hardening attestation, balances, printers and equipment bindings, gateway keys
     and the gateway feed binding, adapter registration;
   - master batch records: the Prepared, Checked, regulatory-confirmation and Approved signatures, the market
     authorisations and the labelling specimens;
   - plant rules: the steward's proposal and QA's approval (penicillin facility rule, beta-lactam classification);
   - incidents: the incident register and the CERT-In reporting step;
   - the approved system description and the validation-summary approval (slice 7c);
   - the full export, the periodic evaluation pack and its QA sign-off (slice 7b-2).
2. **No terminal to use the system.** Developers and pharma professionals test every feature from the web app. Every
   operation that used a command line becomes a screen too:
   - a first-run set-up of a new installation (the bootstrap administrator and process owner, the site, the zone);
   - loading the demo or test data, and resetting a demo or sandbox installation;
   - the full export, the periodic evaluation pack, the evidence bundle, the validation pack and the IQ checks, each
     run from a screen and downloaded from it;
   - backups, the restore and upgrade drills and their records;
   - starting and stopping adapters and the analytics runner; on demo and sandbox installations a test console for the
     simulators (ERP/WMS, QMS, LIMS, LMS, CMMS, L3, the OPC UA press and their faults);
   - for developers, the API reference (the OpenAPI document of the contract) as a page.
   Only putting the software on a server stays a script, made one command (`install` with its prompts); GMP
   installations keep their segregation: an operation is done by the role the kernel names, and a demo or sandbox
   convenience (reset, simulator faults) is refused on a GMP installation.
3. **Completeness is tested, not asserted:** a `[meta]` test lists every route of the API contract that a person calls
   (every route whose permission is not held only by a service identity) and fails unless a screen of the web app calls
   it; a second `[meta]` test lists every command-line entry point (`package.json` scripts and `src/cli`) used to
   operate an installation and fails unless a screen does the same, except the installer. Every new screen has a browser-suite flow, so "testing on the web app" covers it.
4. Screens call the existing routes and database functions; the database stays the enforcement point. A screen never
   loosens a check: an act refused in the database is refused on the screen with the database's message.
5. The demo (decision 0021, after the release candidate) shows every act; its seed data is for convenience, not a
   substitute for a screen.

## What does not change

- No control, catalog test or `expert_decision` changes.
- The sandbox, training mode and GMP records are as before; the branding rule of decision 0020 holds (no vendor identity
  on GMP records).
- Merge order (D-P7-9): 7-0, 7a, 7b-1, 7b-2, 7c, 7d, 7e, **7g**, 7f.
