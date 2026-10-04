# Phase 2 demo: the first clickable version

**DEMO-ONLY.** This is the owner's demo script. Part A0 shows the spine. Part A1 is the whole owner path, the
first clickable version (plan section 1, milestone A1). It follows the journey spec
`tools/e2e/specs/journey/fcv.spec.ts` step for step. That spec passes against the running stack and records the
demo video and screenshots (see "The recorded demo" below).

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
| Scale simulator console | http://localhost:4002 | The simulated balance TEST-BAL-01 of room DISP-1 (DEMO-ONLY), behind the site gateway. |

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
| TEST-Sanjay Kulkarni | Shift supervisor | badge `04A10000000021`, PIN `846201` | TEST-KIOSK-BLEND-1 (any kiosk) |
| TEST-Fatima Sheikh | QA (shop floor) | badge `04A10000000031`, PIN `935172` | TEST-KIOSK-BLEND-1 (any kiosk) |
| TEST-Deepa Pillai | Operator and verifier (two roles) | badge `04A10000000041`, PIN `358264` | TEST-KIOSK-DISP-1 |

The kiosk people also have a password, which they use only on an office PC. Their user IDs are
`test-operator-1`, `test-operator-2`, `test-verifier-1`, `test-verifier-2`, `test-supervisor-1`, `test-qa-1` and
`test-operator-verifier-1`. The passwords are `Demo-Operator1-2026!`, `Demo-Operator2-2026!`, `Demo-Verifier1-2026!`,
`Demo-Verifier2-2026!`, `Demo-Supervisor1-2026!`, `Demo-QaFloor1-2026!` and `Demo-OpVerifier1-2026!`.

TEST-Deepa Pillai holds two roles, OPERATOR and VERIFIER. After the PIN the kiosk asks which role she works in; the
session keeps that role, so she signs out and in again to act in the other. She can verify other people's steps, but
a step she performed, entered data in or corrected is refused to her by the segregation rule (INV-03).

These values come from the test-kit persona catalogue (`packages/test-kit/src/personas.ts`, persona set 0).
`pnpm demo` prints the same card. The set-up has already replaced each person's initial secret (the kernel's
first-use rule), so these work straight away. A person has one shop-floor session at a time: signing in on
another kiosk ends that person's session on the first one.

TEST- lots of the demo seed, to type into the lot field (or scan): `TEST-L26-0101` paracetamol, `TEST-L26-0102`
microcrystalline cellulose, `TEST-L26-0103` magnesium stearate (all released), and `TEST-L26-0199` paracetamol
(in quarantine: the system refuses it).

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

The home screen shows the tiles of the installation: master records and the audit trail on GMP; test-run
packages, test runs, "What you can do now", scales and the audit trail on the sandbox.

## Part A1: the owner's path (the first clickable version)

### Where each person works

Every browser keeps one terminal key per installation. To have all terminals open side by side, use one
browser profile per terminal, for example four Chrome profiles or Chrome plus Firefox. With one browser, the
sandbox tab can change terminal instead: open http://localhost:3011/demo/devices, pick the next terminal and
sign in again.

| Terminal | Installation, address | Who works there | What they do |
|---|---|---|---|
| PC-DESIGN-01 (office) | GMP, http://localhost:3001 | Asha Rao, MBR author | Designs the master record, simulates it, sends it to the sandbox; reads the GMP audit trail |
| TEST-PC-01 (office) | Sandbox, http://localhost:3011 | TEST-Rohan Gupta, batch issuer | Imports the package, issues the TEST- batch; "Verify record" and the batch audit trail at the end |
| TEST-KIOSK-DISP-1 (kiosk, room DISP-1) | Sandbox | TEST-Priya Nair (operator), TEST-Kavya Reddy (verifier); the supervisor and QA switch in | Stage 1, Dispensing, weighing on balance TEST-BAL-01 |
| TEST-KIOSK-BLEND-1 (kiosk, room BLEND-1) | Sandbox | TEST-Arjun Das (operator), TEST-Imran Khan (verifier), TEST-Sanjay Kulkarni (supervisor), TEST-Fatima Sheikh (QA) | Stage 2, Blending, to the QA hold point and the end of the batch |
| Scale simulator console | http://localhost:4002 | The presenter | Puts containers on the balance |

On a kiosk, a badge tap is the badge number followed by Enter in the Badge field; a badge reader does exactly
this. The demo badge drawer below the field has one button per person of that terminal. A PIN is entered on the
on-screen keypad and confirmed with OK. Every entry on a kiosk asks for the badge of the person signed in
(INV-40). A signature asks for the badge, then the PIN.

### 1. Design the master record (GMP, PC-DESIGN-01, Asha Rao)

1. Sign in with `asha.rao` / `Demo-Author-2026!`. Open **Master records**, then **New master record from a
   template**.
2. The template "Paracetamol 500 mg tablets, direct compression (mini)" is already chosen. Give a new family code
   and product code (for example `FAM-DEMO-1`, `PCM500-DEMO-1`) and batch size 1 = `60.000` kg. Click **Create the
   family and its draft**.
3. The designer shows the whole document (sections 0 to 11). The toolbar says **Passed: no errors, no warnings**.
   The Findings tab holds only information notes: G-09 and G-10 are sandbox-only blocks until Phase 3 (PR-03).
4. **Simulation** tab, **Simulate saved revision 1**. The report is stamped TEST, NOT GMP (DI-05), it passes, and
   coverage is 100.0 % (DI-04).
5. **Send to sandbox…**, **Write the test package**. The message "The test package is in the sandbox inbox"
   appears, with a link to the sandbox.

Optional, as in the designer spec: change a limit, delete a step to see a finding and "Go to", undo with Ctrl+Z,
justify a warning, and save a revision with a change note.

### 2. Import and issue (sandbox, TEST-PC-01, TEST-Rohan Gupta)

1. Sign in with `test-issuer` / `Demo-Issuer-2026!`. Open **Test-run packages**, or follow the designer's link.
2. The package shows "Exported from GMP by Asha Rao", its package hash and content hash. Click **Import**. The
   server recomputes both hashes and requires the GMP stamp (DI-05, INV-18).
3. **Issue a test batch**. Choose the batch size (approved sizes only, PR-01), enter the tablets per batch
   (`100000`), and click **Issue the test batch**. The run overview opens on **TEST-B26-000n**.

### 3. Stage 1, Dispensing (kiosk TEST-KIOSK-DISP-1)

1. **Sign in**: TEST-Priya Nair taps her badge and enters PIN `482913`. Open **What you can do now**. The work of
   room DISP-1 lists step 1.1.1 of the new batch. Click **Open step 1.1.1**.
2. **1.1.1 Dispensing booth clearance (G-10).** Click **Start step** and tap the badge. Answer the three checklist
   items **Confirmed**, then **Save** and tap. Enter the previous product and batch number (for example
   `TEST-Ibuprofen tablets 400 mg`, `TEST-B26-9001`), then **Save** and tap. Click **Sign as performed**: the
   signature window shows exactly what is signed and the meaning "LINE_CLEARANCE_PERFORMED". Click **Sign**, tap
   the badge, check the preview of the signature (name, user ID, role, meaning, time zone, 120 s countdown), and
   enter the PIN (DI-36, DI-38).
3. **Self-verification is refused.** The primary button is now **Verify**, greyed, with the server's reason why
   the operator may not verify her own step (INV-03).
4. **Switch user**: TEST-Kavya Reddy taps her badge and enters PIN `691357`. **Verify** is now offered. Sign it:
   Sign, tap, PIN. The step is Completed with two signatures. Switch back to TEST-Priya Nair.
5. **1.1.2 Balance status (G-09).** Start. Choose the equipment, type or scan the status label (for example
   `TEST-LBL-BAL-01`, then Enter), answer the three checks **Yes**, then Save and tap. Sign as performed.
6. **1.1.3 Read the dispensing SOP (G-03)**: start, choose "I have read the instruction", save, sign.
   **1.1.4 Dispensing quantities**: start, sign. The quantities are computed, never typed (INV-25).
7. **1.2.1 Dispense paracetamol (G-07), on the balance.** Start. Choose the material, type the lot
   `TEST-L26-0101` and press Enter; the lot's status, expiry and identity test appear. The step shows the live
   gauge of TEST-BAL-01, marked "live, not recorded" (DI-32). Put the empty container on the balance and press
   **Capture tare**. Then fill it and press **Capture gross**. Each capture shows the value, the balance and the
   raw MT-SICS line. **Save** and tap. The net (50 kg) is computed by the server, inside the action limit
   49.75 to 50.25 kg. Sign as performed; TEST-Kavya Reddy switches in and verifies.
   To put a load on the pan, open the simulator console (http://localhost:4002) in a second tab: the buttons
   under "Set the load on the pan" put exactly the demo's weights on it in one click (1.250 tare, 51.250 gross;
   1.000 and 10.400, 0.200 and 0.800 for step 1.2.2; 0.000 empties the pan). "Set another load…" opens a page to
   type any mass. Wait for the step's gauge to show the new weight as stable before you capture. The control API
   does the same from a terminal:

   ```sh
   curl -s -X POST localhost:4002/api/set -H 'content-type: application/json' -d '{"mass":"1.250"}'    # tare
   curl -s -X POST localhost:4002/api/set -H 'content-type: application/json' -d '{"mass":"51.250"}'   # gross
   curl -s -X POST localhost:4002/api/remove                                                         # empty the pan
   ```

8. **1.2.2 Dispense excipients**: two containers, the same way. Use lot `TEST-L26-0102`, tare `1.000`, gross
   `10.400` (microcrystalline cellulose), and lot `TEST-L26-0103`, tare `0.200`, gross `0.800` (magnesium
   stearate). Performed and verified.
9. **1.3.1 Dispensing reconciliation (G-20)**: computed, no input field. Performed and verified.
10. **Stage sign-off.** Switch user to TEST-Sanjay Kulkarni (PIN `846201`) and open step 1.3.1. The primary action
    is **Sign off the stage**. The dialog shows the summary the system derives, "Completed per MBR" (G-02; it
    cannot be typed). Continue to the signature: Sign, tap, PIN.

If a step raised an exception (for example a weight typed by hand), QA dispositions it before the sign-off; see
stage 2.

### 4. Stage 2, Blending (kiosk TEST-KIOSK-BLEND-1)

1. TEST-Arjun Das signs in (PIN `573024`). **2.1.1 Blending room clearance**: as in 1.1.1. TEST-Imran Khan
   (PIN `715926`) switches in to verify.
2. **2.1.2 Blender and scale status (G-09)**: one entry per equipment (blender, then scale), each with its label and
   checks. Sign as performed.
3. **2.1.3 Charge the dispensed materials (G-08)**: scan or type the three container labels of stage 1. They are
   shown in the entries of steps 1.2.1 and 1.2.2, for example `TEST-B26-0001/C1`. Only this batch's containers
   are accepted, each once. Performed and verified.
4. **2.1.4 Blend (G-04): limit tiers.** Enter blend time `19` min and blender speed `12` /min, each saved with its
   own tap. The verdict appears only after saving. 19 min is outside the internal action limit (12 to 18 min),
   which raises a blocking exception. 12 /min is outside the alert limit (9 to 11 /min), which raises an alert
   (PR-08). **Sign as performed** is greyed with the reason. **Link a deviation** is greyed for the operator,
   because only a supervisor or QA may link one.
5. **Deviation link.** TEST-Sanjay Kulkarni switches in, clicks **Link a deviation** on the exception, enters
   `DEV-TEST-0001`, clicks **Send** and taps. The block is lifted. The operator switches back and signs as
   performed, and the verifier signs as witness (**Witness**): the blend time and speed were typed by hand and the
   printout the MBR names cannot be attached in this release, so the second person witnesses them instead of
   reviewing them later (engine 1.4.0, default T12.1; the dc-mini template asks for the witness itself since
   T12.3). The witness signs within five minutes of the performed signature. Later, the step offers **Verify**
   instead: the review completes the step and records a WITNESS_LATE exception that only QA dispositions in step 6
   (engine 1.5.0, default T12.2).
6. **QA hold point.** TEST-Fatima Sheikh (PIN `935172`) switches in and opens 2.2.1. **Decide the hold point**
   lists "Approved (released)" as not available, with the reason: open exceptions have no QA decision yet (PR-45).
   Cancel. Open the run overview: the steps with open exceptions are marked "n open". On step 2.1.4, click
   **Disposition the exception (QA)** for each exception. Choose "Deviation raised" for the one with the
   deviation and "No impact" for the alert, write a justification, and sign each through the ceremony. Back on
   2.2.1, choose **Approved (released)**, add a comment and sign.
7. **2.2.2 Discharge into output containers (G-22).** Room BLEND-1 has no connected balance, so the step offers
   the manual path, marked "Manual weighing: two-person rule". Choose the intermediate, type tare `1.000` and
   gross `60.500`, then save and tap. Performed, then verified by a second person. The hand-typed weight raises an
   alert, which QA dispositions as above.
8. **2.2.3 Blend yield (G-20)**: computed. Performed and verified.
9. **Stage sign-off.** TEST-Sanjay Kulkarni opens 2.2.3 and clicks **Sign off the stage**. The summary reads
   "Completed with deviations", with the exceptions and DEV-TEST-0001. Sign. The batch is **Execution complete**.

### 5. Replay and audit trails

1. **Sandbox office (TEST-PC-01).** Open **Test runs**, then the batch. **Verify record (replay)**: the server
   replays every stored engine row and answers "Replay identical: n rows replayed, the stored state matches"
   (DI-34, DI-37). The timeline lists every command, refused ones too.
2. **Audit trail of this run**: every entry shows who (name, user ID, role), when (site time with offset, and
   UTC), the terminal, and the fields that changed. **Verify chain**: "Chain intact: n entries verified" (DI-22,
   DI-23).
3. **GMP (PC-DESIGN-01).** Open **Master records**, then the version, then **Audit trail**. The version's chain
   holds the creation, the revisions and the test-package export. **Verify chain**: intact.

### The recorded demo

The journey spec records the demo: one video per terminal segment (office 1440x900, kiosk 1280x800), and a
full-page screenshot at each milestone:

```sh
EBMR_E2E_VIDEO=1 EBMR_E2E_SLOWMO=250 EBMR_E2E_PAUSE_MS=3000 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  flock /tmp/ebmr-e2e.lock pnpm --filter @ebmr/e2e test specs/journey
```

The output goes to `.reports/playwright-output/<test>/`: `milestones/NN-<name>.png` and
`videos/<n>-<segment>.webm`, where the segments are 1-gmp-designer, 2-sandbox-import-and-issue,
3-kiosk-dispensing-DISP-1, 4-kiosk-blending-BLEND-1, 5-sandbox-replay-and-audit and 6-gmp-audit-trail. Media are
not committed. Without the variables, the spec runs as part of `pnpm e2e` in about 2.5 minutes.

## If something goes wrong

- "the demo is not set up": run `pnpm demo:setup`.
- A port is busy: another demo or an E2E run is still up; stop it (Ctrl+C) and start again.
- "This terminal could not prove which registered device it is" after a new `pnpm demo:setup`: the keys
  changed; clear the site data for localhost:3001 and :3011 and pick the terminal again.
- The step says "Scale offline: manual entry needs a second person": check the simulator console (a fault may
  be switched on; "Clear all faults") and that `pnpm demo` started the site gateway. With the scale offline,
  the manual two-person path still works.
- A badge tap is refused as too frequent: a terminal accepts 30 taps a minute per badge (decision C0-9). Wait a
  minute.
- A kiosk suddenly shows "Sign in": the same person signed in on another kiosk (one shop-floor session per
  person). Sign in again.
