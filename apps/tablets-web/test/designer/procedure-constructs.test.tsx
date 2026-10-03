/**
 * The procedure table of the read-only document (what the checker reads in IN_VERIFICATION) shows the rules that
 * decide the route and which branch a step belongs to (review F45), and the numbered steps a library call brings in
 * (review F46). The review's reproducers are ported here; the completeness walk (completeness.ts) then looks for every
 * member of every construct and library call of the four contents of document-complete.test.tsx.
 */
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import packaging from '../../../../packages/recipe-core/test/fixtures/tablet-blister-packaging.mbr.json' with { type: 'json' };
import { DocumentView } from '../../src/features/designer/components/DocumentView.tsx';
import { documentLeaves, missingLeaves } from './completeness.ts';
import { fixtureVersion, PALETTE, renderRouted } from './support.tsx';

afterEach(() => cleanup());

const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ');

function parsed(json: unknown): flow.MbrContent {
  const r = flow.parseMbr(structuredClone(json));
  if (!r.ok) throw new Error(`does not parse: ${JSON.stringify(r.problems).slice(0, 800)}`);
  return r.mbr;
}

async function renderDocument(content: flow.MbrContent): Promise<HTMLElement> {
  const r = renderRouted(() => (
    <DocumentView content={content} version={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={PALETTE} selected={null} onSelect={() => undefined} dispatch={() => false} readOnly findingsByNode={new Map()} />
  ));
  await waitFor(() => expect(r.container.querySelector('table[aria-label="Procedure"]')).not.toBeNull(), { timeout: 10000 });
  return r.container;
}

const procedureRows = (doc: HTMLElement): Element[] => [...doc.querySelectorAll('table[aria-label="Procedure"] tbody tr')];

/** Granulation with the construct options the fixtures leave out: a counted replicate running concurrently. */
function otherConstructOptions(): flow.MbrContent {
  const c = parsed(granulation);
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'replicate') {
      n.count = { mode: 'EXPRESSION', expression: 'batchSizeTablets / 100000', min: 1, max: 3 };
      n.instances = 'CONCURRENT';
    }
  });
  return c;
}

describe('the procedure shows the rules of its constructs and which branch a step belongs to (review F45)', () => {
  it('[PR-02][PR-03][DI-34] a data-decided alternative shows each condition and its "otherwise" branch; an operator choice the roles allowed to choose', async () => {
    const rows = procedureRows(await renderDocument(parsed(granulation)));
    const overdry = text(rows.find((r) => r.id === 'mbr-node-ALT-OVERDRY'));
    expect(overdry).toContain('decided by recorded data');
    expect(overdry).toContain('"Over-dried: QA assessment": taken when lod < 2.0 [%]');
    expect(overdry).toContain('"Within range": otherwise (taken when no other condition holds)');
    const ipa = text(rows.find((r) => r.id === 'mbr-node-ALT-IPA'));
    expect(ipa).toContain('chosen by an authorised person, with a reason: Production supervisor may choose');
  });

  it('[PR-02][DI-34] a loop shows its exit condition and endpoint; a replicate section its count and sub-lot prefix', async () => {
    const rows = procedureRows(await renderDocument(parsed(granulation)));
    const loop = text(rows.find((r) => r.id === 'mbr-node-L-DRY'));
    expect(loop).toContain('until lod <= 3.5 [%], on the process endpoint Loss on drying of granules (lod): at most');
    expect(loop).toContain('and at most 3 h');
    const rep = text(rows.find((r) => r.id === 'mbr-node-R-SUBLOT'));
    expect(rep).toContain('count chosen at run time, with a reason, between 1 and 2');
    expect(rep).toContain('<batch number>-GS1');
  });

  it('[PR-02][DI-34] a variant-decided alternative shows the variant values that select each branch', async () => {
    const rows = procedureRows(await renderDocument(parsed(packaging)));
    const dest = text(rows.find((r) => r.id === 'mbr-node-ALT-DESTINATION'));
    expect(dest).toContain('fixed at issue by variant packDestination');
    expect(dest).toContain('taken when variant packDestination is US-EXPORT');
  });

  it('[PR-02][DI-34] each branch body follows its own branch row: P-MIX parallel branches and the ALT-OVERDRY branch are not read as one sequence', async () => {
    const rows = procedureRows(await renderDocument(parsed(granulation)));
    const at = (id: string): number => rows.findIndex((r) => r.id === id);
    const drymix = at('mbr-node-p-drymix');
    const vessel = at('mbr-node-p-vessel-status');
    expect(drymix).toBeGreaterThan(0);
    expect(rows.slice(drymix + 1, vessel).map((r) => text(r)).join(' | ')).toContain('Branch "Binder preparation"');
    const alt = at('mbr-node-ALT-OVERDRY');
    const hold = at('mbr-node-H-OVERDRY');
    expect(rows.slice(alt + 1, hold).map((r) => text(r)).join(' | ')).toContain('Branch "Over-dried: QA assessment": taken when lod < 2.0 [%]');
    expect(rows.slice(hold + 1).map((r) => text(r)).join(' | ')).toContain('Branch "Within range": otherwise (taken when no other condition holds) · no action (no step)');
  });
});

describe('the steps of a library call are numbered rows of the procedure (review F46)', () => {
  it('[PR-02][PR-03][DI-34] step 2.4.3 (c-lod/lod-test) has its row with name, bound records, performer and checker; the call shows its bindings', async () => {
    const content = parsed(granulation);
    expect(flow.numberMbr(content).byId.get('c-lod/lod-test')?.number).toBe('2.4.3');
    const doc = await renderDocument(content);
    const numbers = procedureRows(doc)
      .map((r) => text(r.querySelector('td')).trim())
      .filter((n) => /^2\.4\.\d+$/.test(n));
    expect(numbers).toEqual(['2.4.1', '2.4.2', '2.4.3', '2.4.4']);
    const row = doc.querySelector('[id="mbr-node-c-lod/lod-test"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('aria-label')).toBe('Step 2.4.3 Loss on drying test (moisture analyser)');
    const t = text(row);
    expect(t).toContain('Loss on drying of granules (lod)');
    expect(t).toContain('Production operator');
    expect(t).toContain('Production verifier (verified)');
    expect(t).toContain('Equipment MA: uses it');
    expect(t).toContain('Step of a library element (read-only here)');
    expect(row?.querySelector('button')).toBeNull();
    const call = text(doc.querySelector('[id="mbr-node-c-lod"]'));
    expect(call).toContain('lodValue bound to Loss on drying of granules (lod)');
    expect(call).toContain('analyser bound to MA');
  });

  it('[PR-02][DI-34] a call of an element the master does not embed says so instead of showing nothing', async () => {
    const content = parsed(granulation);
    content.library = [];
    const doc = await renderDocument(content);
    expect(text(doc.querySelector('#mbr-section-8'))).toContain('The element LIB-LOD is not embedded in this master, so its steps cannot be shown');
  });
});

describe('completeness of constructs and library calls (reviews F45, F46)', () => {
  for (const [name, content] of [
    ['the granulation fixture', () => parsed(granulation)],
    ['the packaging fixture', () => parsed(packaging)],
    ['the granulation fixture with a counted, concurrent replicate', otherConstructOptions],
  ] as const) {
    it(`[PR-02][PR-03][DI-34] every member of every construct and library call of ${name} is in the read-only document`, async () => {
      const c = content();
      const doc = await renderDocument(c);
      const leaves = documentLeaves(c);
      expect(leaves.filter((l) => l.area === 'construct').length).toBeGreaterThan(5);
      expect(missingLeaves(doc, leaves, ['construct', 'library'])).toEqual([]);
    });
  }
});
