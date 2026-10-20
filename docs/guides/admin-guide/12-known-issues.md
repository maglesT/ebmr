# Known issues

What Batchwright Tablets v1.0 does not do yet, or does only in part. The full list for a release is generated from the
backlogs into the validation pack (slice 7c); this page lists what an administrator or a user meets first.

## Every act has a screen

Since slice 7h every act a person performs in v1.0 has a screen of the web app (decision 0025); nobody needs a terminal,
a script or a database console to work. The acts the hosted demo's review of v1.0.0-rc.1 found without one now have
theirs:

| Area | Act | Where |
|---|---|---|
| Shop floor | reserving lots for a batch; starting and ending the use of a room or of equipment; the per-use check and booking of a balance; charging a container; inspecting, issuing and returning press tooling; the press discharge; an in-process check on equipment | the step screen of the step that needs it (a kiosk act is confirmed by a badge tap); the lot screen; calibrations on `/plant` |
| Master records | raising the change record of a master record; recording and linking a risk assessment; a draft's attributes; the verification evidence (the designer's validator report and simulation are recorded when verification starts; the sandbox test run comes back as a hash-checked result package) | `/mbr` and the version's review and signing screens; the sandbox run page (export) and GMP (import) |
| Batch numbers | defining a numbering rule of the site | `/planning/batch-numbers` (the master-data steward) |
| Reference documents | recording a new version of a reference document | `/mbr`, reference documents (the master-data steward) |
| EU QP register | registering an EU importer (QA's signature) | `/qp-register` |
| Plant | the plant's product list (whether a product is highly potent) | `/master-data/plant`, Products |
| Configuration | every platform setting | `/config/history`, Platform settings (one screen lists every setting the database defines) |

The home screen shows each role the screens it can use; "Show all screens" lists the others, which answer with the
server's refusal when opened (the server always decides).

On a shop-floor kiosk a read that the role may not make is refused at once; a read it may make asks for the badge tap
first, as every entry on a kiosk does.

## Not in the hosted demo (deferred to deployment)

These concern only the hosted demo, not an installation (decision D-P7R-17):

- The GMP installation of the demo has no simulated balance or gateway; GMP weighings on the demo use the manual
  two-person path. The scale simulator and the gateway serve the sandbox.
- The scale simulator's console is reached through an SSH tunnel, not through the demo's web address.
- Behind the demo's reverse proxy every visitor shares one address, so the per-address rate limits are shared (the
  per-user limits still apply); the trusted-proxy setting of decision 0021 is optional.

See [the hosted demo](../../operations/hosted-demo.md) for how the demo is reset (`pnpm demo:setup --with-gmp-samples`)
and why browsers clear their site data after a reset.

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
