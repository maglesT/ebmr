/**
 * The designer's document says how a step's second-person check runs in this release (Phase 2 exit follow-up T12.DOC;
 * DI-30, PR-14, DI-35). A later review (VERIFIED) of a critical value typed by hand from the printout or photo the MBR
 * names runs as a witness: no printout or photo can be attached in this release, so the engine and the database ask for
 * a witness within the witness window, and after it for the later review with an exception for QA (engine 1.4.0 and
 * 1.5.0; recipe-core 0325, 0333). Before, the document, the validator and the approval showed only "verified" while the
 * floor asked for a timed witness. The validator warns as well (GMP-WITNESS-NO-ATTACHMENT).
 */
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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

async function blendRow(content: flow.MbrContent): Promise<string> {
  const r = renderRouted(() => (
    <DocumentView content={content} version={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={PALETTE} selected={null} onSelect={() => undefined} dispatch={() => false} readOnly findingsByNode={new Map()} />
  ));
  await waitFor(() => expect(r.container.querySelector('table[aria-label="Procedure"]')).not.toBeNull(), { timeout: 10000 });
  return text(r.container.querySelector('[id="mbr-node-p-blend"]'));
}

const RUNS_AS_WITNESS =
  'Production verifier (verified). In this release this check runs as a witness (witnessed): no printout or photo can be attached to Blend time (blendTime), Blender speed (blenderSpeed), so the second person watches the entry within 5 minutes of the performed signature and before the run moves on; after that, the later review completes the step and records an exception for QA (GMP-WITNESS-NO-ATTACHMENT).';

describe('the document says how a step\'s check runs in this release (T12.DOC)', () => {
  it('[DI-30][PR-14][DI-35] a later review of a critical value typed by hand from its printout reads as the timed witness it runs as; the shipped template asks for the witness itself and reads as such', async () => {
    expect(await blendRow(blendReviewedLater())).toContain(RUNS_AS_WITNESS);
    cleanup();
    const template = await blendRow(parsed(dcMini));
    expect(template).toContain('Production verifier (witnessed)');
    expect(template).not.toContain('In this release this check runs as a witness');
  });

  it('[DI-30][PR-14][DI-35] the step\'s properties say the same next to the check the author chooses', async () => {
    const content = blendReviewedLater();
    const r = renderRouted(() => <StepEditor content={content} stepId="p-blend" number="2.1.4" palette={PALETTE} dispatch={() => undefined} readOnly={false} />);
    await waitFor(() => expect(text(r.container)).toContain('In this release this check runs as a witness (witnessed)'), { timeout: 10000 });
  });
});
