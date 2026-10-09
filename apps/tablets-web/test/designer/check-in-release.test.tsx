/**
 * The designer's document says how a step's second-person check runs in this release (Phase 2 exit follow-up T12.DOC;
 * DI-30, PR-14, DI-35). A later review (VERIFIED) of a critical value typed by hand from the printout or photo the MBR
 * names runs as a witness: no printout or photo can be attached in this release, so the engine and the database ask for
 * a witness within the witness window, and after it for the later review with an exception for QA (engine 1.4.0 and
 * 1.5.0; recipe-core 0325, 0333). Before, the document, the validator and the approval showed only "verified" while the
 * floor asked for a timed witness. The validator warns as well (GMP-WITNESS-NO-ATTACHMENT).
 *
 * Round 4: the words name the people the run accepts for each check (flow `checkersInRun` with the delivered
 * CHECKER_ROLES): a witness by a production verifier or QA (shop floor), the later review by a production verifier. Round
 * 3 named every fallback verifier role, a production supervisor included, whom the kernel refuses for both (no
 * STEP.WITNESS, no STEP.VERIFY), and let QA give the later review (no STEP.VERIFY). That CHECKER_ROLES is what the
 * installation's database and the run accept is proved at the server (test execution/witness-without-printout).
 */
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CHECKER_ROLES } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core/pure';
import dcMini from '../../../../packages/recipe-core/test/fixtures/dc-mini.mbr.json' with { type: 'json' };
import { DocumentView } from '../../src/features/designer/components/DocumentView.tsx';
import { StepEditor } from '../../src/features/designer/components/StepEditor.tsx';
import { fixtureVersion, PALETTE, renderRouted } from './support.tsx';

afterEach(() => cleanup());

const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ');

function parsed(json: unknown): flow.MbrContent {
  const r = flow.parseMbr(structuredClone(json));
  if (!r.ok) throw new Error(`does not parse: ${JSON.stringify(r.problems).slice(0, 800)}`);
  return r.mbr;
}

/** dc-mini with the blend step's check made a later review (VERIFIED), as an author might set it. */
function blendReviewedLater(): flow.MbrContent {
  const c = parsed(dcMini);
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'phase' && n.id === 'p-blend') n.signatures = { ...n.signatures, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
  });
  return c;
}

async function blendRow(content: flow.MbrContent, step = 'p-blend'): Promise<string> {
  const r = renderRouted(() => (
    <DocumentView content={content} version={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={PALETTE} selected={null} onSelect={() => undefined} dispatch={() => false} readOnly findingsByNode={new Map()} />
  ));
  await waitFor(() => expect(r.container.querySelector('table[aria-label="Procedure"]')).not.toBeNull(), { timeout: 10000 });
  return text(r.container.querySelector(`[id="mbr-node-${step}"]`));
}

function parameter(c: flow.MbrContent, id: string): flow.MbrContent['parameters'][number] {
  const p = c.parameters.find((x) => x.id === id);
  if (!p) throw new Error(`no parameter ${id}`);
  return p;
}

const RUNS_AS_WITNESS =
  'Production verifier (verified). In this release this check runs as a witness (witnessed): no printout or photo can be attached to Blend time (blendTime), Blender speed (blenderSpeed), so a second person who holds Production verifier watches the entry within the site\'s witness window (5 minutes by default) after the performed signature and before the run moves on; after that, the later review by a person who holds Production verifier completes the step and records an exception for QA (GMP-WITNESS-NO-ATTACHMENT).';

/** The witness and the later review, as the run accepts them where the MBR names no check (round 4). */
const WHO = 'a second person who holds Production verifier or QA (shop floor)';
const LATER = 'the later review by a person who holds Production verifier';
const PERMISSIONS =
  'Of the roles that check a step whose MBR names no check (Production verifier, Production supervisor, QA (shop floor)), a person witnesses only in one that holds the witness permission (STEP.WITNESS) and reviews later only in one that holds the review permission (STEP.VERIFY).';

/** dc-mini whose blend step names no check, its two values captured as `capture`. */
function unchecked(capture: flow.CaptureMode): flow.MbrContent {
  const c = parsed(dcMini);
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'phase' && n.id === 'p-blend') n.signatures = n.signatures.perform ? { perform: n.signatures.perform } : {};
  });
  for (const id of ['blendTime', 'blenderSpeed']) parameter(c, id).capture = capture;
  return c;
}

describe('the document says how a step\'s check runs in this release (T12.DOC)', () => {
  it('[DI-30][PR-14][DI-35] a later review of a critical value typed by hand from its printout reads as the timed witness it runs as; the shipped template asks for the witness itself and reads as such', async () => {
    expect(await blendRow(blendReviewedLater())).toContain(RUNS_AS_WITNESS);
    cleanup();
    const template = await blendRow(parsed(dcMini));
    expect(template).toContain('Production verifier (witnessed)');
    expect(template).not.toContain('In this release this check runs as a witness');
  });

  it('[DI-30][PR-14][DI-35] T12.DOC round 2: whatever capture the MBR names (device, scan, LIMS, automation), the row says the value is typed by hand in this release and that the check runs as a witness; a weighing step\'s quantity, which its block computes, keeps the check the MBR names', async () => {
    const HOW = { DEVICE: 'from a device', SCAN: 'by scanning', LIMS: 'from LIMS', AUTOMATION: 'from the automation system' } as const;
    for (const [capture, how] of Object.entries(HOW) as [keyof typeof HOW, string][]) {
      const c = blendReviewedLater();
      parameter(c, 'blendTime').capture = capture;
      expect(await blendRow(c), capture).toContain(
        `Production verifier (verified). In this release this check runs as a witness (witnessed): every value is typed by hand on the step screen, whatever capture the MBR names (Blend time (blendTime): ${how}), and no printout or photo can be attached to Blend time (blendTime), Blender speed (blenderSpeed), so a second person who holds Production verifier watches the entry within the site's witness window (5 minutes by default) after the performed signature and before the run moves on; after that, the later review by a person who holds Production verifier completes the step and records an exception for QA (GMP-WITNESS-NO-ATTACHMENT).`,
      );
      cleanup();
    }
    const weighed = parsed(dcMini);
    for (const id of ['pcmDispensed', 'blendNet']) parameter(weighed, id).evidence = 'PRINTOUT';
    for (const step of ['p-disp-pcm', 'p-blend-out']) {
      const row = await blendRow(weighed, step);
      expect(row, step).toContain('Production verifier (verified)');
      expect(row, step).not.toContain('In this release this check runs as a witness');
      cleanup();
    }
  });

  it('[DI-30][PR-14][DI-35] T12.DOC round 3: where the MBR names no check, the row and the step\'s properties say the step is checked all the same in this release, as a timed witness by a production verifier or QA (shop floor), then by the later review of a production verifier with an exception for QA, whatever capture the MBR names', async () => {
    const TAIL = `no printout or photo can be attached to Blend time (blendTime), Blender speed (blenderSpeed), so ${WHO} watches the entry within the site's witness window (5 minutes by default) after the performed signature and before the run moves on; after that, ${LATER} completes the step and records an exception for QA (GMP-WITNESS-NO-ATTACHMENT). ${PERMISSIONS}`;
    expect(await blendRow(unchecked('MANUAL'))).toContain(`The MBR names no check, but in this release the step is checked all the same, as a witness (witnessed): ${TAIL}`);
    cleanup();
    expect(await blendRow(unchecked('DEVICE'))).toContain(
      `The MBR names no check, but in this release the step is checked all the same, as a witness (witnessed): every value is typed by hand on the step screen, whatever capture the MBR names (Blend time (blendTime): from a device; Blender speed (blenderSpeed): from a device), and ${TAIL}`,
    );
    cleanup();
    const content = unchecked('LIMS');
    const r = renderRouted(() => <StepEditor content={content} stepId="p-blend" number="2.1.4" palette={PALETTE} dispatch={() => undefined} readOnly={false} />);
    await waitFor(() => expect(text(r.container)).toContain('The MBR names no check, but in this release the step is checked all the same, as a witness (witnessed)'), { timeout: 10000 });
    expect(text(r.container)).toContain(`${WHO} watches the entry`);
    expect(text(r.container)).toContain(`${LATER} completes the step`);
    cleanup();
    // An uncritical value needs no check where the MBR names none: the cell says nothing more.
    const uncritical = unchecked('MANUAL');
    for (const id of ['blendTime', 'blenderSpeed']) parameter(uncritical, id).criticality = 'NON_CRITICAL';
    const row = await blendRow(uncritical);
    expect(row).not.toContain('in this release the step is checked');
  });

  it('[DI-30][PR-14][DI-35][INV-26] T12.DOC round 4: the row and the step\'s properties name the people the run accepts for each check, never a role the kernel refuses for it: a witness by a production verifier or QA (shop floor) and the later review by a production verifier where the MBR names no check; a check the MBR gives to QA or a production supervisor says who cannot give it', async () => {
    // The delivered checker roles the words read; the server's test (execution/witness-without-printout) holds them to
    // tab.engine_role_map and the kernel role permissions and shows the run refusing a supervisor's witness and a QA
    // later review.
    expect(CHECKER_ROLES).toEqual({ witness: ['PRODUCTION_VERIFIER', 'QA'], review: ['PRODUCTION_VERIFIER'] });
    const row = await blendRow(unchecked('LIMS'));
    expect(row).toContain(`${WHO} watches the entry`);
    expect(row).toContain(`${LATER} completes the step`);
    // A production supervisor is one of the roles that check a step whose MBR names no check, but the run never takes
    // their witness or later review: the words name them only where they say which permission each check needs.
    expect(row.replace(PERMISSIONS, '')).not.toContain('Production supervisor');
    cleanup();
    const checkedBy = (role: string): flow.MbrContent => {
      const c = blendReviewedLater();
      flow.walk(c.procedure.body, (n) => {
        if (n.kind === 'phase' && n.id === 'p-blend' && n.signatures.check) n.signatures.check.role = role;
      });
      return c;
    };
    const ATTACHED = 'no printout or photo can be attached to Blend time (blendTime), Blender speed (blenderSpeed)';
    expect(await blendRow(checkedBy('QA'))).toContain(
      `QA (shop floor) (verified). In this release this check runs as a witness (witnessed): ${ATTACHED}, so a second person who holds QA (shop floor) watches the entry within the site's witness window (5 minutes by default) after the performed signature and before the run moves on; after that, no one may give the later review, as no role that carries QA (shop floor) holds the review permission (STEP.VERIFY), so the run cannot complete this step (GMP-WITNESS-NO-ATTACHMENT).`,
    );
    cleanup();
    expect(await blendRow(checkedBy('PRODUCTION_SUPERVISOR'))).toContain(
      `Production supervisor (verified). In this release this check runs as a witness (witnessed): ${ATTACHED}, and no one may witness it, as no role that carries Production supervisor holds the witness permission (STEP.WITNESS), so the step waits for the site's witness window (5 minutes by default) to pass or the run to move on; after that, no one may give the later review, as no role that carries Production supervisor holds the review permission (STEP.VERIFY), so the run cannot complete this step (GMP-WITNESS-NO-ATTACHMENT).`,
    );
  });

  it('[DI-30][PR-14][DI-35] the step\'s properties say the same next to the check the author chooses', async () => {
    const content = blendReviewedLater();
    const r = renderRouted(() => <StepEditor content={content} stepId="p-blend" number="2.1.4" palette={PALETTE} dispatch={() => undefined} readOnly={false} />);
    await waitFor(() => expect(text(r.container)).toContain('In this release this check runs as a witness (witnessed)'), { timeout: 10000 });
  });
});
