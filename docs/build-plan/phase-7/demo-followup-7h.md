# Follow-up after slice 7h (PR #63): hosted demo, 20 October 2026

**Status on the hosted demo (187.126.126.5):** main at `db08ee70` (slice 7h, PR #63) is deployed and reset with
`pnpm demo:setup --with-gmp-samples`. `tools/e2e/specs/phase7/gmp-kiosk-batch.spec.ts` was run on this server against
its own e2e cluster (port 5433): **8 passed (24.7 min)**. The full GMP batch and its packaging work through the screens.

## G1. A presenter cannot sign the floor people in on KIOSK-BLEND-1, KIOSK-COMP-1 and KIOSK-PACK-1 (blocks the live demo)

**What happens.** On a GMP kiosk the sign-in screen's "Demo badge reader (DEMO-ONLY)" offers one *Tap* button per
persona whose **home terminal** is that kiosk (`apps/tablets-web/src/features/session/Login.tsx:380`: `demoBadges`
from `routes.session.demoDevices`, the device's `personas`). Checked on the live demo:

| Kiosk | Tap buttons offered |
|---|---|
| KIOSK-DISP-1 | Priya Nair, Kavya Reddy, Pooja Venkatesh |
| KIOSK-BLEND-1 | none |
| KIOSK-COMP-1 | Harish Bhatt |
| KIOSK-PACK-1 | none |

The full batch (as `gmp-kiosk-batch.spec.ts` runs it) needs Arjun Das (operator), Kavya Reddy (verifier), Pooja
Venkatesh (dispenser), Fatima Sheikh (QA on the floor) and Sanjay Kulkarni (supervisor) on KIOSK-BLEND-1, KIOSK-COMP-1
and KIOSK-PACK-1. Their home terminal is KIOSK-GRAN-1 or KIOSK-DISP-1, so those kiosks show no button for them. A person
cannot type a badge UID by hand (keys more than `BURST_GAP_MS` = 100 ms apart start a new burst) and a paste is refused
on purpose (`packages/ui-kit/src/identity/BadgePrompt.tsx`, `NOT_TAPPED`, BADGE-AUTOFILL). That control is right and
must stay.

**Why the browser suite did not catch it.** `fixtures/index.ts` `readerTap` sends the badge UID as a reader-speed burst
through CDP, so the spec never uses the Tap buttons.

**Fix (DEMO-ONLY, small).** On a demo installation, the kiosk's demo badge reader offers every kiosk persona of the
installation (all personas with a badge), not only those whose home terminal is this kiosk. Keep the home-terminal ones
first, or group them under "Works here" and "Other people". Alternatively the demo seed gives each production room's
kiosk its own home personas, but the first fix is simpler and covers every room. The server stays the authority: a
person without the right for the room or the act is refused as now.

**Test.** A browser test on KIOSK-BLEND-1 that signs in by **pressing the Tap button** of a person whose home kiosk is
another one (not through `readerTap`), and a unit test of the list the demo devices route returns. Ideally the kiosk
batch spec uses the Tap buttons wherever a presenter would.

## G2. Planning a processing batch links it to the oldest open order, not the one clicked (known; avoided in the demo)

`apps/tablets-server/src/features/execution/gmp-issue.ts:133` uses `plan.erpOrder ?? openErpOrder(...)`, and the
planning screen does not send `erpOrder` for a processing batch, so `recipe.open_erp_order_for` (0602) picks the oldest
open order with the same product, strength, site and batch size. Packaging orders are not affected (the packaging plan
sends `erpOrder`, `features/planning/index.ts:192`).

**Demo and manual, until fixed:** the hosted demo's reset now leaves exactly one open GB-T-02 processing order
(`/home/batchwright/post-demo-order.mjs`, run by `/usr/local/bin/batchwright-demo-reset`), and the demo guide plans only
from orders that are the only open order of their product and size.

**Text for the user guide** (`docs/guides/user-guide/02-operator-and-shift-supervisor.md` or the planning section), until
the fix lands:

> **Planning from an ERP order (v1.0-rc).** When a product has more than one open production order of the same batch
> size, plan them oldest first: a batch planned from that screen is linked to the oldest open order of its product and
> size, whichever order card you used. Check the order number shown on the issued batch. Packaging orders are linked to
> the order you choose.

**Fix:** send the clicked order with the plan (`erpOrder` in the request body from the order card), have the server use
it (it already accepts it), with its check (the order exists, is open and matches the master), and a test that plans
from the second of two open orders and finds the batch on that order.
