# Module C4-shop-floor-web: Sandbox web: package import, issue form, runs, cockpit, generic step screen with block renderers, exceptions, hold point and stage sign-off, glove-first floor kit

Depends on: C0-spine

## Paths owned
- `apps/tablets-web/src/features/floor/**` (`index.ts` replaces the stub):
  - pages: packages inbox and import, issue form, runs list, run overview and record (with a replay button), cockpit, step screen;
  - the `renderers/<type>@<version>.tsx` registry, a schema-driven fallback, the exception panel, the link-deviation dialog, the hold-point and stage sign-off dialogs, `useRunCommand`;
  - `test/floor/**`.
- `packages/ui-kit/src/floor/**`: Keypad, NumericEntry (DecimalField + echo), ChecklistEntry, ScanField, SeriesGrid (A2), StepHeader, TimerChip, PrimaryActionBar, RefusalPanel, ExceptionBanner, LimitDisplay, StatusOutline.
- `packages/ui-kit/src/machines/pending-entry.ts` and `test/floor/**`.
- `tools/e2e/specs/floor/**`.

## Working mode

**Days 1-3: fixtures only.**
- Build against the C0 contract fixtures through `createFixtureFetch` and the stub ports (`useSignatureCeremony`, `useBadgeTap`, `ScaleCaptureSlot`).
- Never decide GMP outcomes in the client:
  - `actions` come from the server;
  - verdicts come only from the server's post-commit view;
  - values are never pre-filled.

**Checkpoint D5.** Switch to the live sandbox API (C3). The real ceremony and badge providers (C1) and the scale slot (C5) arrive through the already-wired port contexts, with no edits to their files.

## A1 deliverables

1. **Kiosk layout** at floor density:
   - targets at least 56 px, primary action bar 80 px, keypad keys 72 px, base font 20 px, values 32 px;
   - no drag, hover-only or multi-finger controls;
   - a fixed header: product, TEST- batch, IN/US/EU badges, stage, room, equipment, timers, connection and last-saved, identity banner;
   - a stage and step outline with colour + icon + word;
   - a step card, "Step 2.1.4 of 13 · Blend", with the instruction as issued and its SOP reference;
   - one primary action and a "More" menu (raise exception, link deviation, hold batch);
   - RefusalPanel: what happened, why, rule code and controls, what you can do, who can help.
2. **`pendingEntry` machine:** editing → awaitingTap (`useBadgeTap`) → sending (fixed idempotency key) → saved | notSaved | refused | stale.
   - notSaved shows a blocking banner: "Not saved: tap your badge to send again"; the resend uses the same key and a fresh tap (D1).
   - A session change (C1 event) discards the entry.
   - stale refetches and explains what changed.
3. **Renderers:**
   - G-03 acknowledge;
   - G-04 NumericEntry per item, with LimitDisplay (tier, source) beside the input;
   - G-07: `ScaleCaptureSlot` for tare and gross; lot ScanField (keyboard-wedge 2D); manual fallback clearly marked "two-person"; commit with one tap; the entry sends reading ids or manual values only;
   - G-08 container scan;
   - G-09@1 and G-10@1 ChecklistEntry;
   - G-17 hold-point disposition through the ceremony;
   - G-20 computed display with no input field;
   - G-22 output containers;
   - the schema-driven fallback;
   - a registry test listing each executable version's renderer or fallback (strict in A2).
4. **Signatures.** Sign as performed, Verify, Sign off stage and Dispose hold point call `useSignatureCeremony` with an ENGINE_COMMAND action. A refusal such as "a different person must verify (INV-03)" shows who can verify.
5. **Exceptions.**
   - The in-card ExceptionBanner shows expected vs actual, why it matters, whether it blocks, and who it is routed to.
   - The link-deviation dialog is for supervisors.
   - QA disposition through the ceremony.
6. **Stage sign-off** shows the derived summary ("completed per MBR / with deviations"), which cannot be typed.
7. **Cockpit:** "What you can do now" from `/api/work-queue`, with greyed items and the server's reason.
8. **Pages:**
   - package inbox and import (hash and GMP origin shown);
   - issue form (approved sizes only; header inputs with sources; the server allocates TEST-);
   - runs list;
   - run overview and record: stages → steps, exceptions, holds, timers, timeline, "Verify record" (replay identical or first difference), audit links;
   - the watermark band on every sandbox route (from the C0 shell).

## A2
- The IPC SeriesGrid, committed once with one tap.
- A verification queue with inline post-entry changes.
- Correction, void and invalidation dialogs; loop, alternative and replicate controls.
- The next-check countdown and mini charts.
- An unsent-entries notice; late entry.
- A strict renderer completeness test; Hindi strings.

## Contract
- **Consumes:** the frozen `execution` and `devices` views and intents, and the port contexts.
- **Provides:** the floor routes and ui-kit floor components.

## Tests (IDs in names)

**Component tests (happy-dom)**
- NumericEntry echoes the value with its unit, never pre-fills, and never produces a number.
- The verdict is absent until the commit response.
- `[INV-25]` Computed items have no input.
- `@xstate/graph` paths through `pendingEntry`: same key on resend, re-tap required, discard on switch.
- `[DI-28]` An entry lost in transit shows NOT SAVED and is not shown as recorded.
- Target sizes are checked through computed styles.

**E2E `floor.spec` (after D5)**
- `[DI-34]` A later step is shown as unavailable, with its reason.
- `[INV-03]` The performer's own verify is refused, naming who can verify.
- `[PR-08]` An action-limit breach blocks completion until a deviation is linked, with the explanation.
- `[DI-05][INV-18]` The watermark and TEST- numbers appear on every sandbox screen.
- axe clean on the cockpit, step screen and signature dialog.

## Controls
DI-28, DI-34, INV-03, INV-25 and PR-08 (UI parts); DI-05 (watermark).

## Must not
- Compute availability, limit verdicts or signature validity in the browser.
- Send DEVICE values, lot facts or actors.
- Store executed data in browser storage.
- Edit the contract, server code, C1 or C5 components, or C0 shell files.
