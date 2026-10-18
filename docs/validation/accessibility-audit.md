# Accessibility audit (v1.0-rc)

Slice 7d of Phase 7, against WCAG 2.2 level AA (outline 7.4: the target; shop-floor targets at least 44 x 44 CSS px,
state shown by colour, icon and word, contrast at least 4.5:1, keyboard and screen-reader support on the office
screens, a warning before the inactivity lock). The screens audited are main's at this slice's commit; slice 7e changes
the branding (the sign-in page, the header and the product title), so its axe run in the browser suite repeats this one
on the new look.

Commit: the slice 7d branch (`phase-7/slice-7d`). Browser: Chromium of the browser suite (`PLAYWRIGHT_BROWSERS_PATH`).
Evidence: `tools/e2e/specs/accessibility/accessibility.spec.ts` (axe-core 4 through `@axe-core/playwright`, rules tagged
wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa), the web unit tests named below, and the checks by hand in section 3.

Each criterion is marked:

- **AUTOMATED**: a test checks it on every run (the axe rules named, or a unit or browser test);
- **BY HAND**: checked here by reading the screens and their code; repeated at each release's audit;
- **AT DEPLOYMENT**: left to the customer's test with assistive-technology users (a screen reader on the office
  screens, a speech-input user, a 200 % zoom user), because a script cannot judge it.

## 1. What the automated audit covers

| Check | Screens | Result |
|---|---|---|
| axe, no serious or critical violation | every page of the SPA's route tree on GMP signed in as a QA reviewer (each parameter given an example id, so a page that names nothing shows its own "not found" or refusal state, which is audited too), the sandbox's pages as the batch issuer with the TEST, NOT GMP watermark, and the kiosk's sign-in, PIN keypad and floor screens at KIOSK-DISP-1 | pass |
| Keyboard alone | the office sign-in (user ID, password, Enter), Tab through the home screen's tiles with the focus visible at each stop, Enter into a list, back with Alt+Left | pass: every stop showed its focus ring; the back step is taken by the browser's history (Alt+Left is the browser's own key, not delivered to headless Chromium) |
| Targets at least 44 x 44 CSS px | every button, link, field and ARIA control on the kiosk's sign-in, PIN keypad and floor screens, measured with getBoundingClientRect | pass: none under 44 x 44 px on the 8 floor pages (after A11Y-7; a radio's visually hidden input is measured by its label) |
| Colour, icon and word | every state chip (`[data-tone]`) on every GMP page has an icon and a word | pass: none without icon or word on 104 pages |
| The warning before the inactivity lock | the session control with the real boot state (web `test/access/idle-warning.test.tsx`, server `test/access/session.test.ts`) | pass (after A11Y-1) |
| Single-key shortcuts can be turned off | the exception register (web `test/review/review.test.tsx`) | pass (after A11Y-3) |
| Each screen has its own title | the shell (web `test/app/page-title.test.tsx`) | pass (after A11Y-2) |

## 2. The criteria

Level A and AA of WCAG 2.2 (4.1.1 Parsing is obsolete in 2.2 and not listed). "Media" criteria do not apply: the
screens play no audio or video.

| Criterion | Level | How | Result |
|---|---|---|---|
| 1.1.1 Non-text content | A | AUTOMATED: axe image-alt, svg-img-alt, input-image-alt, role-img-alt; BY HAND: the state chips' icons are decorative next to their word | pass |
| 1.2.1 to 1.2.5 Time-based media | A, AA | not applicable (no audio or video) | n/a |
| 1.3.1 Info and relationships | A | AUTOMATED: axe label, list, listitem, definition-list, th-has-data-cells, aria-required-children/parent; BY HAND: forms use the ui-kit Field (a label element for every input), tables are React Aria tables (column headers and row headers named) | pass |
| 1.3.2 Meaningful sequence | A | BY HAND: reading order is source order (no CSS reordering of content) | pass |
| 1.3.3 Sensory characteristics | A | BY HAND: instructions name the control ("Tap your badge", "Press N"), never a shape or a place on the screen alone | pass |
| 1.3.4 Orientation | AA | BY HAND: no orientation lock in the CSS or the manifest | pass |
| 1.3.5 Identify input purpose | AA | AUTOMATED: axe autocomplete-valid; BY HAND: the office user ID is `autocomplete=username`; GMP entry fields are `off` on purpose (an entry is never autofilled, DI-14) | pass |
| 1.4.1 Use of colour | A | AUTOMATED: the chip check (colour, icon and word) and axe link-in-text-block | pass |
| 1.4.2 Audio control | A | not applicable | n/a |
| 1.4.3 Contrast (minimum) | AA | AUTOMATED: axe color-contrast on every audited page (the outline's floor of 4.5:1 is the criterion's) | pass |
| 1.4.4 Resize text | AA | AT DEPLOYMENT: 200 % browser zoom on the office screens (the font size comes from one token per density and the layout wraps) | at deployment |
| 1.4.5 Images of text | AA | BY HAND: none (the logo is the only image with text) | pass |
| 1.4.10 Reflow | AA | AT DEPLOYMENT: 320 CSS px width on the office screens; the browser suite's phone viewport covers the kiosk layout | at deployment |
| 1.4.11 Non-text contrast | AA | BY HAND: focus ring and field borders use the ui-kit tokens (3:1 or more against the background); AT DEPLOYMENT on the customer's displays | pass (tokens) |
| 1.4.12 Text spacing | AA | AT DEPLOYMENT: a text-spacing bookmarklet on the office screens | at deployment |
| 1.4.13 Content on hover or focus | AA | BY HAND: no tooltip or hover content carries information (descriptions are text under the field) | pass |
| 2.1.1 Keyboard | A | AUTOMATED: the keyboard flow; axe scrollable-region-focusable; BY HAND: the designer's procedure table takes the keyboard on its rows (ProcedureTable) | pass |
| 2.1.2 No keyboard trap | A | AUTOMATED: the keyboard flow Tabs through and leaves every stop; dialogs (React Aria) return the focus on close | pass |
| 2.1.4 Character key shortcuts | A | AUTOMATED: the exception register's N and P can be turned off (A11Y-3); the designer's shortcuts need Ctrl or Cmd | pass (after A11Y-3) |
| 2.2.1 Timing adjustable | A | AUTOMATED: the warning 60 s before the inactivity lock with one action to stay (a badge tap on a kiosk), and 5 min before the absolute end (A11Y-1). The absolute end is a security limit no action extends (the criterion's exception for an essential limit: 11.10(d) and DI-38 bound a session's life) | pass (after A11Y-1) |
| 2.2.2 Pause, stop, hide | A | BY HAND: nothing moves or blinks for more than 5 s; the status board refreshes its data, not an animation | pass |
| 2.3.1 Three flashes | A | BY HAND: nothing flashes | pass |
| 2.4.1 Bypass blocks | A | AUTOMATED: axe bypass, region, landmark-one-main (one main region, the header and the banner in their own landmarks) | pass |
| 2.4.2 Page titled | A | AUTOMATED: web `test/app/page-title.test.tsx`; axe document-title. Before A11Y-2 every screen was titled "eBMR Tablets" | pass (after A11Y-2) |
| 2.4.3 Focus order | A | AUTOMATED: the keyboard flow (the order of the tiles and the sign-in fields); BY HAND: no positive tabindex (axe tabindex) | pass |
| 2.4.4 Link purpose (in context) | A | AUTOMATED: axe link-name; BY HAND: links name their target ("Back to the review of the record") | pass |
| 2.4.5 Multiple ways | AA | BY HAND: the home screen's tiles (a navigation landmark), the links between related records and each list's filters | pass |
| 2.4.6 Headings and labels | AA | AUTOMATED: axe empty-heading, label; BY HAND: every screen has one h1 naming it | pass |
| 2.4.7 Focus visible | AA | AUTOMATED: the keyboard flow checks an outline or a box shadow on every focused element | pass |
| 2.4.11 Focus not obscured (minimum) | AA | BY HAND: the floor's run header and action bar are sticky; scroll padding on the floor density now keeps a focused element clear of both (ui-kit tokens.css, this slice); dialogs are modal | pass (after the scroll padding) |
| 2.5.1 Pointer gestures | A | BY HAND: no multipoint or path gesture | pass |
| 2.5.2 Pointer cancellation | A | BY HAND: buttons act on release (React Aria's press) | pass |
| 2.5.3 Label in name | A | AUTOMATED: axe label-content-name-mismatch | pass |
| 2.5.4 Motion actuation | A | not applicable (no motion input) | n/a |
| 2.5.7 Dragging movements | AA | BY HAND: no screen uses dragging (no drag handler in the web app or the ui-kit) | pass |
| 2.5.8 Target size (minimum) | AA | AUTOMATED: axe target-size (24 px) on every page; the 44 x 44 px floor on the kiosk screens | pass (after A11Y-6, A11Y-7) |
| 3.1.1 Language of page | A | AUTOMATED: axe html-has-lang, html-lang-valid (`lang="en"`) | pass |
| 3.1.2 Language of parts | AA | BY HAND: text entered in another language is marked `lang="und"` where shown in review | pass |
| 3.2.1 On focus | A | BY HAND: focusing never submits or navigates | pass |
| 3.2.2 On input | A | BY HAND: a change of a field never submits on its own; filters change the list they filter, which is announced as the list | pass |
| 3.2.3 Consistent navigation | AA | BY HAND: one shell (header, banner, main) on every signed-in screen | pass |
| 3.2.4 Consistent identification | AA | BY HAND: the same action has the same name everywhere (the ui-kit's strings) | pass |
| 3.2.6 Consistent help | A | BY HAND: every refusal says who can help in the same place (RefusalNotice's "Who can help") | pass |
| 3.3.1 Error identification | A | BY HAND: a refused entry says what happened, why and what to do (RefusalNotice), next to the field it concerns | pass |
| 3.3.2 Labels or instructions | A | AUTOMATED: axe label; BY HAND: units and limits are shown with each entry field | pass |
| 3.3.3 Error suggestion | AA | BY HAND: "what you can do" in every refusal | pass |
| 3.3.4 Error prevention (legal, financial, data) | AA | BY HAND: every GMP act is reviewed before it is signed (the signing ceremony shows what is signed, DI-37) and corrections keep the original (DI-22) | pass |
| 3.3.7 Redundant entry | A | BY HAND: a resent entry keeps what was typed (the floor's pending entries); the badge tapped for a switch is kept 30 s so only the PIN is asked | pass |
| 3.3.8 Accessible authentication (minimum) | AA | BY HAND: the password field accepts paste and password managers (only the GMP PIN and badge fields refuse autofill, by design, DI-14); no cognitive test | pass |
| 4.1.2 Name, role, value | A | AUTOMATED: axe button-name, aria-valid-attr, aria-roles, aria-allowed-attr, nested-interactive; React Aria controls | pass |
| 4.1.3 Status messages | AA | BY HAND: results and refusals are in live regions (role status or alert) through the ui-kit Banner and RefusalNotice; AT DEPLOYMENT with a screen reader | pass; screen reader at deployment |

## 3. Findings

| ID | Finding | State |
|---|---|---|
| A11Y-1 | No warning before the inactivity lock (2.2.1; outline 7.4). The session view did not say when the lock would fall, and the page learnt of it from its 15-second poll | fixed: tablets 1460 (`tab.resolve_session` answers the seconds until the idle lock and the absolute end by the database clock), the session view's `idleLockInSeconds` and `endsInSeconds`, and ui-kit `IdleWarning` in the session control: "Keep working" on an office PC, a badge tap of the session's own person on a kiosk, "Lock now" |
| A11Y-2 | Every screen had the same title, "eBMR Tablets" (2.4.2) | fixed: the shell titles the page "<the screen's heading> - <product>"; slice 7e's product name comes from index.html's title |
| A11Y-3 | The exception register's single-key shortcuts (N, P, J, K) could not be turned off (2.1.4; a speech-input user types letters) | fixed: a "Single-key shortcuts (N, P)" switch on the screen; the "Next item" button stays |
| A11Y-4 | The GMP floor's runs page (/runs) failed with "Something went wrong!" on every load (4.1.2, and the page did nothing): the GMP batches list answers `{ batches }`, the page read `runs` | fixed: `features/floor/family.ts` maps the batches list's answer to the runs view; web `test/floor/tablet-blocks.test.tsx` ("lists the GMP batches from /api/batches on the runs page ...", failed before the fix) |
| A11Y-5 | The PIN keypad's digit count carried a name on a div with no role (4.1.2; axe aria-prohibited-attr, serious) | fixed: the count is a named live status (`role="status"`); ui-kit `test/identity/identity.test.tsx` |
| A11Y-6 | Targets under 24 px (2.5.8; axe target-size, serious): the plain link lists of /master-data and /quality and the disclosures of /config/history were 22 px tall | fixed: ui-kit `tokens.css`, in a layer the screens' own classes override: a link alone in a list item and a summary are at least 24 px tall |
| A11Y-7 | Floor targets under 44 x 44 px (outline 7.4): the status board's links were 27 px tall ("L1" 23 px wide) | fixed: ui-kit `tokens.css`: on floor density every link is at least 44 x 44 px |

## 4. Left to the deployment test

A screen-reader user test on the office screens (NVDA or JAWS on Windows, the customer's browser): the review queue
and record review, the exception register, the signing ceremony and the investigation; 200 % zoom and 320 px reflow on
the office screens; the text-spacing check; a speech-input user on the exception register; the kiosk's targets and
contrast on the customer's own displays and gloves (outline 7.4: primary actions about 15 to 20 mm for double gloves).
