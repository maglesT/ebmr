# Decision record 0025: every act a person performs has a screen in v1.0, for the demo and for testing

- **Date:** 18 October 2026
- **Decided by:** project owner (maglesT), in the Phase 7 session ("we want everything to be there for demo and testing
  on web app, users, registering devices, all things"), on hearing which acts had no screen in v1.0.
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
2. **Completeness is tested, not asserted:** a `[meta]` test lists every route of the API contract that a person calls
   (every route whose permission is not held only by a service identity) and fails unless a screen of the web app calls
   it. Every new screen has a browser-suite flow, so "testing on the web app" covers it.
3. Screens call the existing routes and database functions; the database stays the enforcement point. A screen never
   loosens a check: an act refused in the database is refused on the screen with the database's message.
4. The demo (decision 0021, after the release candidate) shows every act; its seed data is for convenience, not a
   substitute for a screen.

## What does not change

- No control, catalog test or `expert_decision` changes.
- The sandbox, training mode and GMP records are as before; the branding rule of decision 0020 holds (no vendor identity
  on GMP records).
- Merge order (D-P7-9): 7-0, 7a, 7b-1, 7b-2, 7c, 7d, 7e, **7g**, 7f.
