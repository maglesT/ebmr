# Phase 2 demo: the first clickable version

This is the owner's demo script. It grows with the build: part A0 (the spine) works today; part A1 (the whole
owner path, plan section 3) is filled in by the lead when the journey spec `tools/e2e/specs/journey/fcv.spec.ts`
passes (build order D7), with its video and trace kept as the recorded demo.

Everything in the demo is DEMO-ONLY: the keys, passwords, PINs and badge numbers below exist only in the two
demo databases, which the set-up marks as demo installations. A production start (`EBMR_ENV=production`)
refuses demo switches and plain-http origins.

## Before the demo

Needs Node 22, pnpm, and PostgreSQL 16 running locally with the `ebmr_dev` superuser.

```sh
pnpm install
pnpm demo:setup     # about 15 s: creates both demo databases, keys, personas; builds the SPA
pnpm demo           # starts both servers and prints the addresses and the credential card
```

`pnpm demo:setup` can be re-run at any time; it drops and re-creates `ebmr_tablets_demo` and
`ebmr_sandbox_tablets_demo` and writes fresh DEMO-ONLY keys to `var/demo/keys` (git-ignored).

| What | Address | Notes |
|---|---|---|
| GMP installation | http://localhost:3001 | Designer, audit trail, sessions, e-signatures. |
| Sandbox installation (TEST, NOT GMP) | http://localhost:3011 | Test runs of unapproved MBR versions, shop floor. |
| Scale simulator console | http://localhost:4002 | Once module C5 lands; until then `pnpm demo` says "not installed yet". |

Both installations can be open in the same browser at once: each has its own cookie names, so signing in on
one does not sign you out of the other.

## Credential card (DEMO-ONLY)

GMP (`ebmr_tablets_demo`), office PCs, user ID and password:

| Person | Role | User ID | Password | Terminal |
|---|---|---|---|---|
| Asha Rao | MBR author | `asha.rao` | `Demo-Author-2026!` | PC-DESIGN-01 |
| Vikram Shah | MBR checker | `vikram.shah` | `Demo-Checker-2026!` | PC-DESIGN-01 |
| Meera Iyer | QA MBR approver | `meera.iyer` | `Demo-Approver-2026!` | PC-QA-01 |
| Rahul Menon | Regulatory signer | `rahul.menon` | `Demo-Regulatory-2026!` | PC-QA-01 |
| Neha Joshi | Master-data steward | `neha.joshi` | `Demo-Steward-2026!` | PC-QA-01 |

Sandbox (`ebmr_sandbox_tablets_demo`), every name starts with TEST-:

| Person | Role | Sign-in | Terminal |
|---|---|---|---|
| TEST-Rohan Gupta | Batch issuer | `test-issuer` / `Demo-Issuer-2026!` | TEST-PC-01 |
| TEST-Neha Joshi | Master-data steward | `test-steward` / `Demo-Steward-2026!` | TEST-PC-01 |
| TEST-Priya Nair | Operator | badge `04A10000000001`, PIN `482913` | TEST-KIOSK-DISP-1 |
| TEST-Arjun Das | Operator | badge `04A10000000002`, PIN `573024` | TEST-KIOSK-BLEND-1 |
| TEST-Kavya Reddy | Verifier | badge `04A10000000011`, PIN `691357` | TEST-KIOSK-DISP-1 |
| TEST-Imran Khan | Verifier | badge `04A10000000012`, PIN `715926` | TEST-KIOSK-BLEND-1 |
| TEST-Sanjay Kulkarni | Shift supervisor | badge `04A10000000021`, PIN `846201` | TEST-KIOSK-BLEND-1 |
| TEST-Fatima Sheikh | QA (shop floor) | badge `04A10000000031`, PIN `935172` | TEST-KIOSK-BLEND-1 |

`pnpm demo` prints the same card. The set-up has already replaced each person's initial secret (the kernel's
first-use rule), so these work straight away.

## Part A0: the spine (works now)

1. **Pick a terminal (GMP).** Open http://localhost:3001. The demo device picker lists the GMP terminals.
   Choose PC-DESIGN-01. The browser now holds a non-extractable key for that terminal; the server knows the
   terminal only by proofs made with that key, never by a name the browser sends.
2. **Sign in as the author.** User ID `asha.rao`, password `Demo-Author-2026!`. The identity banner shows the
   person, role, terminal and installation. Show that a wrong password gives a plain-language refusal (what
   happened, why, what you can do, who can help). Five failures in a row lock the account (DI-19); in the demo
   only a new `pnpm demo:setup` unlocks it, so show the lockout with a person you do not need afterwards.
3. **Pick a terminal (sandbox).** Open http://localhost:3011 in a second tab. The amber band "TEST, NOT GMP"
   is on every screen (DI-05). Choose TEST-KIOSK-DISP-1.
4. **Kiosk sign-in.** The kiosk asks for a badge: open the demo badge drawer and tap TEST-Priya Nair, then
   enter PIN `482913` on the PIN pad. Office sign-in (password) is refused on a kiosk, and badge sign-in is
   refused on an office PC.
5. **Both at once.** Switch between the two tabs: each installation keeps its own session.
6. **Sign out** on each installation.

The home screen shows the tiles of the installation (master records and audit trail on GMP; test-run
packages, test runs, the work queue and audit trail on the sandbox); tiles of modules still being built say
"Not available yet".

## Part A1: the owner's path (filled in at D7)

The steps follow `tools/e2e/specs/journey/fcv.spec.ts`; each gets its exact clicks, expected screens and the
controls it shows when the journey passes:

1. GMP sign-in and a new MBR from the dc-mini template in the designer.
2. Validation findings, a justification, save, simulation.
3. Send to the sandbox; import on the sandbox; issue a TEST- batch.
4. Kiosk entries with badge taps; scale capture; alert-tier and action-tier limit breaches; deviation link.
5. PERFORMED; self-verification refused; badge switch; VERIFIED.
6. QA hold-point release and stage sign-offs.
7. Replay gives the identical state.
8. Audit trail verified on both installations.

## If something goes wrong

- "the demo is not set up": run `pnpm demo:setup`.
- A port is busy: another demo or an E2E run is still up; stop it (Ctrl+C) and start again.
- "This terminal could not prove which registered device it is" after a new `pnpm demo:setup`: the keys
  changed; clear the site data for localhost:3001 and :3011 and pick the terminal again.
