/**
 * A step's configuration is shown in full (review F51): in the step panel, lists and maps are never cut (a clearance
 * checklist with the answer each item expects, an equipment status check list, expected answers per item); a step
 * whose block is not in the palette shows the configuration it says it shows, and the computerised system its recipe
 * and version; and the checker's document carries every step's configuration in its procedure row. The review's
 * reproducers are ported here, with a completeness walk over every configuration member (completeness.ts).
 */
import { cleanup, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { blocks, flow } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import packaging from '../../../../packages/recipe-core/test/fixtures/tablet-blister-packaging.mbr.json' with { type: 'json' };
import dcMini from '../../../tablets-server/src/features/designer/templates/dc-mini.mbr.json' with { type: 'json' };
import { ConfigForm } from '../../src/features/designer/components/ConfigForm.tsx';
import { DocumentView } from '../../src/features/designer/components/DocumentView.tsx';
import { StepEditor } from '../../src/features/designer/components/StepEditor.tsx';
import { documentLeaves, missingLeaves } from './completeness.ts';
import { fixtureContent, fixtureVersion, PALETTE, renderRouted } from './support.tsx';

afterEach(() => cleanup());

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ');

/** The configuration schema of a registry block as JSON (as the palette route sends it). */
function schemaOf(type: string): Record<string, unknown> {
  const b = blocks.genericBlockRegistry().get(type, '1');
  if (!b?.configSchema) throw new Error(`no schema for ${type}`);
  return JSON.parse(JSON.stringify(b.configSchema)) as Record<string, unknown>;
}

function parsed(json: unknown): flow.MbrContent {
  const r = flow.parseMbr(structuredClone(json));
  if (!r.ok) throw new Error(`does not parse: ${JSON.stringify(r.problems).slice(0, 800)}`);
  return r.mbr;
}

function phaseOf(c: flow.MbrContent, id: string): flow.PhaseNode {
  let found: flow.PhaseNode | undefined;
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'phase' && n.id === id) found = n;
  });
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

const CHECKLIST = Array.from({ length: 6 }, (_, i) => ({
  id: `C${i + 1}`,
  text: `Clearance item number ${i + 1}: no material, label or document of the previous batch in the room, checked behind the equipment`,
  expected: i < 3 ? 'CONFIRMED' : 'CONFIRMED_OR_NOT_APPLICABLE',
}));
const CHECKS = Array.from({ length: 5 }, (_, i) => ({ id: `E${i + 1}`, text: `Equipment status check number ${i + 1}: labelled CLEAN with a valid date` }));

/** dc-mini with list and map configurations on its clearance, status and charge steps. */
function dcMiniWithLists(): flow.MbrContent {
  const c = parsed(dcMini);
  phaseOf(c, 'p-disp-clear').config = { checklist: CHECKLIST };
  phaseOf(c, 'p-disp-bal').config = { checks: CHECKS };
  phaseOf(c, 'p-blend-charge').config = { expected: { kitIntact: 'YES', labelMatches: 'CONFIRMED' }, blockOnUnexpected: false };
  return c;
}

async function renderDocument(content: flow.MbrContent): Promise<HTMLElement> {
  const r = renderRouted(() => (
    <DocumentView content={content} version={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={PALETTE} selected={null} onSelect={() => undefined} dispatch={() => false} readOnly findingsByNode={new Map()} />
  ));
  await waitFor(() => expect(r.container.querySelector('#mbr-section-11')).not.toBeNull(), { timeout: 10000 });
  return r.container;
}

describe('the configuration of a step is shown in full (review F51)', () => {
  it('[PR-03][PR-02][PR-23] the step panel shows every clearance checklist item with the answer it expects, never a cut text', () => {
    const r = render(<ConfigForm schema={schemaOf('G-10')} value={{ checklist: CHECKLIST }} onChange={() => undefined} readOnly sopOptions={[]} />);
    const table = within(r.container).getByRole('table', { name: 'checklist (optional)' });
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    expect(rows).toEqual(CHECKLIST.map((c, i) => [String(i + 1), c.id, c.text, c.expected]));
    expect(r.container.textContent).not.toMatch(/\.\.\.|…/);
  });

  it('[PR-03][PR-02] the step panel shows every equipment status check and every expected answer', () => {
    const a = render(<ConfigForm schema={schemaOf('G-09')} value={{ checks: CHECKS }} onChange={() => undefined} readOnly sopOptions={[]} />);
    for (const c of CHECKS) expect(a.container.textContent).toContain(c.text);
    cleanup();
    const b = render(<ConfigForm schema={schemaOf('G-05')} value={{ expected: { kitIntact: 'YES', labelMatches: 'CONFIRMED' } }} onChange={() => undefined} readOnly sopOptions={[]} />);
    expect(norm(b.container.textContent)).toContain('kitIntact: YES');
    expect(norm(b.container.textContent)).toContain('labelMatches: CONFIRMED');
  });

  it('[PR-03][DI-04] a step whose block is not in the palette shows its saved configuration, and the computerised system its recipe and version', () => {
    const c = fixtureContent();
    phaseOf(c, 'p-drymix').config = { impellerSetpoint: 'VALUE-7731', interlocks: ['LID-CLOSED', 'EXTRACTION-ON'] };
    const r = render(<StepEditor content={c} stepId="p-drymix" number="2.2.2" palette={PALETTE} readOnly dispatch={() => undefined} />);
    const shown = norm(r.container.textContent);
    expect(shown).toContain('its configuration is shown as saved');
    expect(shown).toContain('impellerSetpoint: VALUE-7731');
    expect(shown).toContain('LID-CLOSED');
    expect(shown).toContain('EXTRACTION-ON');
    expect(shown).toContain('scada SYS-RMG, recipe ATV-DRYMIX version 3');
  });

  it('[PR-02][PR-03][PR-23] the checker\'s document carries each step\'s configuration in its procedure row: every checklist item of the clearance', async () => {
    const doc = await renderDocument(dcMiniWithLists());
    const row = doc.querySelector('[id="mbr-node-p-disp-clear"]');
    const table = row?.querySelector('table');
    expect(table?.getAttribute('aria-label')).toBe('Configuration of step 1.1.1: checklist');
    expect([...(table?.querySelectorAll('tbody tr') ?? [])].map((tr) => tr.querySelectorAll('td')[3]?.textContent)).toEqual(CHECKLIST.map((c) => c.expected));
    expect(norm(doc.querySelector('[id="mbr-node-p-disp-pcm"]')?.textContent)).toContain('tolerance: percent: 0.5');
  });

  for (const [name, content] of [
    ['the shipped dc-mini template', () => parsed(dcMini)],
    ['dc-mini with list and map configurations', dcMiniWithLists],
    ['the granulation fixture', () => parsed(granulation)],
    ['the packaging fixture', () => parsed(packaging)],
  ] as const) {
    it(`[PR-02][PR-03][DI-04] completeness: every configuration member of every step of ${name}, a library step's included, is in the read-only document`, async () => {
      const c = content();
      const doc = await renderDocument(c);
      const leaves = documentLeaves(c);
      expect(missingLeaves(doc, leaves, ['config'])).toEqual([]);
    });
  }
});
