/**
 * The read-only document (what the author, the checker and the approver read in IN_VERIFICATION) shows every member
 * of the saved MBR content that decides how a batch runs, exactly as written (review F44; plan section 8). The first
 * tests port the review's reproducers; the completeness tests walk every member of the shipped dc-mini template, the
 * two shared tablet fixtures and a copy of the granulation fixture that sets every optional member, and look for
 * each value in its own place (completeness.ts).
 */
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import packaging from '../../../../packages/recipe-core/test/fixtures/tablet-blister-packaging.mbr.json' with { type: 'json' };
import dcMini from '../../../tablets-server/src/features/designer/templates/dc-mini.mbr.json' with { type: 'json' };
import { DocumentView } from '../../src/features/designer/components/DocumentView.tsx';
import { jumpTarget } from '../../src/features/designer/model/sections.ts';
import { documentLeaves, missingLeaves, type Area } from './completeness.ts';
import { fixtureVersion, PALETTE, renderRouted } from './support.tsx';

afterEach(() => cleanup());

const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ');

function parsed(json: unknown): flow.MbrContent {
  const r = flow.parseMbr(structuredClone(json));
  if (!r.ok) throw new Error(`does not parse: ${JSON.stringify(r.problems).slice(0, 800)}`);
  return r.mbr;
}

const granulationContent = (): flow.MbrContent => parsed(granulation);

async function renderDocument(content: flow.MbrContent): Promise<HTMLElement> {
  const version = fixtureVersion({ state: 'IN_VERIFICATION', content: content as never, contentHash: flow.mbrContentHash(content) });
  const r = renderRouted(() => (
    <DocumentView content={content} version={version} palette={PALETTE} selected={null} onSelect={() => undefined} dispatch={() => false} readOnly findingsByNode={new Map()} />
  ));
  await waitFor(() => expect(r.container.querySelector('#mbr-section-11')).not.toBeNull(), { timeout: 10000 });
  return r.container;
}

function phase(c: flow.MbrContent, id: string): flow.PhaseNode {
  let found: flow.PhaseNode | undefined;
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'phase' && n.id === id) found = n;
  });
  if (!found) throw new Error(`fixture has no step ${id}`);
  return found;
}

/** The granulation fixture with every optional member set to a value found nowhere else (well formed, not valid). */
function allMembers(): flow.MbrContent {
  const c = granulationContent();
  c.header.predicates = { licenceFormX7: 'FORM-25-X7', exportOrientedX7: true, sterileX7: false };
  c.header.variants = [{ id: 'VAR-X7', values: ['VAL-A7', 'VAL-B7'] }];
  c.references.push({ id: 'SPEC-X7', kind: 'SPECIMEN', code: 'SPEC-CODE-X7', version: '3', hash: 'c7'.repeat(32), title: 'Carton specimen X7' });
  (c.inputs[0] as flow.ExternalInput).categories = ['CAT-X7', 'CAT-Y7'];
  (c.bom[0] as flow.BomLine).specimen = 'SPEC-X7';
  const blend = c.intermediates.find((i) => i.id === 'I-BLEND') as flow.Intermediate;
  blend.finalOutput = false;
  (blend.holdTime as { storage?: string }).storage = 'Storage X7, 2-8 degC';
  const lod = c.parameters.find((p) => p.id === 'lod') as flow.Parameter;
  lod.precision = { kind: 'SIGNIFICANT_FIGURES', digits: 3 };
  lod.readings = 7;
  lod.evidence = 'PHOTO';
  lod.accuracyCheck = 'SECOND_PERSON';
  lod.marketRule = { key: 'tablets.lodMax.x7', bound: 'HIGH' };
  const lodLimits = lod.limits as flow.LimitSpec;
  lodLimits.actionBreach = 'CONTINUE_CURRENT_STEP_WITH_DEVIATION';
  const validated = lodLimits.ranges[0] as flow.LimitSpec['ranges'][number];
  validated.pharmacopoeia = { code: 'PHARM-X7', edition: '2031' };
  (validated.high as { inclusive: boolean }).inclusive = false;
  (validated.low as { inclusive: boolean }).inclusive = false;
  c.parameters.push({ id: 'colourX7', name: 'Colour X7', valueType: 'CATEGORY', categories: ['RED-X7', 'BLUE-X7'], role: 'OBSERVATION', criticality: 'NON_CRITICAL', riskClass: 'LOW', capture: 'MANUAL', evidence: 'NONE' });
  c.parameters.push({ id: 'cartonsX7', name: 'Cartons counted X7', valueType: 'COUNT', role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'SCAN', target: '257' });
  const rsd = c.calculations.find((x) => x.id === 'rsdWeight') as flow.Calculation;
  rsd.output.semanticTag = 'SEM-X7';
  rsd.limits = { unit: '%', ranges: [{ tier: 'INTERNAL_ACTION', high: { value: '2.07', inclusive: true }, rounding: 'PH_EUR_SIG_FIGS', source: { kind: 'COMPANY_STANDARD', ref: 'SOP-IPC' } }], actionBreach: 'STOP_DEPENDENT_STEP' };
  const tc = c.timeConstraints[0] as flow.TimeConstraint;
  tc.min = { value: '1.5', unit: 'h' };
  tc.max = { value: '71.5', unit: 'h' };
  tc.warnBefore = { value: '45', unit: 'min' };
  tc.marketRule = { key: 'tablets.holdMax.x7', bound: 'HIGH' };
  c.timeConstraints.push({ id: 'TC-X7', name: 'From cleaning X7', kind: 'USE_BY', from: { external: 'EXT-CLEAN-X7', description: 'Equipment cleaning ends X7' }, to: { node: 'p-drymix', event: 'START' }, max: { value: '3', unit: 'd' }, breach: 'EXCEPTION', pauses: 'INCLUDED' });
  const firstOff = phase(c, 'p-first-off');
  firstOff.yieldCheckpoint = c.yieldCheckpoints[0]?.id as string;
  firstOff.sampling = [
    { point: 'PT-X7', purpose: 'PURP-X7', units: 13, destructive: true },
    { point: 'PT-Y7', purpose: 'PURP-Y7', units: 11, destructive: false },
  ];
  firstOff.system = { kind: 'SCADA', ref: 'SYS-RMG', recipe: 'RCP-X7', recipeVersion: 'v9.7' };
  firstOff.pat = { method: 'NIR-X7', model: 'MDL-X7', modelVersion: '4.2.7', acceptance: 'lod < 9.97' };
  firstOff.reprocessing = { case: 'RECOVERY', maxPercent: '7.5', maxAge: { value: '30', unit: 'd' }, maxSourceBatches: 3 };
  c.riskReductions.push({ id: 'RR-X7', kind: 'REDUCED_IPC_FREQUENCY', subjects: ['hardness'], riskClass: 'LOW', rationale: 'RA-MINOR-01' });
  c.goldenCases.push({ id: 'G-X7', description: 'Every kind of golden value X7', inputs: { flagX7: { bool: true }, colourX7: { category: 'RED-X7' }, seriesX7: { series: ['1.10', '2.20'], unit: 'kg' } }, expected: { outX7: { value: '3.30' }, offX7: { bool: false } } });
  return parsed(JSON.parse(JSON.stringify(c)));
}

const RECORD_AND_STEPS: readonly Area[] = ['record', 'step'];

describe('the read-only document shows the members of the saved content (review F44)', () => {
  it('[PR-02][PR-03][IN-33] acceptance schemes are shown with their criteria, markets, pharmacopoeia, ranges in words and sampling', async () => {
    const doc = await renderDocument(granulationContent());
    const scheme = text(doc.querySelector('[id="mbr-item-AS-UOW"]'));
    expect(scheme).toContain('Tablet weight (in-process): every criterion applies');
    expect(scheme).toContain('Average weight within the IP band of the target (IN)');
    expect(scheme).toContain('Weight RSD within the in-house limit derived from process data (US)');
    expect(scheme).toContain('at least 237.5 mg');
    expect(scheme).toContain('at most 262.5 mg');
    expect(scheme).toContain('IP 2026');
    expect(scheme).toContain('at first-off: 20 units for weight, not destructive');
    // A finding about the scheme jumps to it, not to the section heading.
    expect(jumpTarget({ section: '6', nodeId: null, subjectPath: ['acceptanceSchemes', 'AS-UOW'] }, () => false).elementId).toBe('mbr-item-AS-UOW');
  });

  it('[PR-08][IN-13][INV-34] time constraints show what a breach does, the early warning and whether pauses count; hold times their storage', async () => {
    const doc = await renderDocument(granulationContent());
    const win = text(doc.querySelector('[id="mbr-item-TC-GRAN-WINDOW"]'));
    expect(win).toContain('exception and block');
    expect(win).toContain('Warning 30 min before the maximum');
    expect(text(doc.querySelector('[id="mbr-item-TC-DRYCYCLE"]'))).toContain('Pauses excluded');
    expect(text(doc.querySelector('[id="mbr-item-I-KIT"]'))).toContain('Closed containers, 15-25 degC');
    cleanup();
    const mini = await renderDocument(parsed(dcMini));
    expect(text(mini.querySelector('[id="mbr-item-I-BLEND"]'))).toContain('Closed, labelled containers, 15-25 degC');
    expect(text(mini.querySelector('[id="mbr-item-TC-DISP-HOLD"]'))).toContain('Warning 4 h before the maximum');
  });

  it('[PR-08][IN-52] the breach handling of a limit and the market rule it must respect change what the parameter shows', async () => {
    const plain = granulationContent();
    const marked = granulationContent();
    const lod = marked.parameters.find((p) => p.id === 'lod') as flow.Parameter;
    (lod.limits as flow.LimitSpec).actionBreach = 'CONTINUE_CURRENT_STEP_WITH_DEVIATION';
    lod.marketRule = { key: 'tablets.lodMax', bound: 'HIGH' };
    const a = text((await renderDocument(plain)).querySelector('[id="mbr-item-lod"]'));
    cleanup();
    const b = text((await renderDocument(marked)).querySelector('[id="mbr-item-lod"]'));
    expect(a).toContain('stops the dependent step until a deviation is opened (the default)');
    expect(b).toContain('continue current step with deviation');
    expect(b).toContain('market rule tablets.lodMax (high bound');
  });

  it('[PR-08][PR-02] the limits of a calculation are shown, with its criticality and risk class', async () => {
    const c = granulationContent();
    const rsd = c.calculations.find((x) => x.id === 'rsdWeight') as flow.Calculation;
    rsd.limits = { unit: '%', ranges: [{ tier: 'INTERNAL_ACTION', high: { value: '2.0', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'COMPANY_STANDARD', ref: 'SOP-IPC' } }] };
    const doc = await renderDocument(c);
    const table = doc.querySelector('table[aria-label="Limits of Relative standard deviation of tablet weight"]');
    expect(text(table)).toContain('at most 2.0 %');
    expect(text(doc.querySelector('[id="mbr-item-rsdWeight"]'))).toContain(`risk class ${rsd.riskClass}`);
  });

  it('[PR-03][DI-04] readings per capture are shown (10 readings reads differently from 20), and a step shows its acceptance scheme and sampling', async () => {
    const c20 = granulationContent();
    const c10 = granulationContent();
    (c10.parameters.find((p) => p.id === 'tabletWeight') as flow.Parameter).readings = 10;
    const doc = await renderDocument(c20);
    const a = text(doc.querySelector('[id="mbr-item-tabletWeight"]'));
    expect(a).toContain('20 readings per capture');
    expect(text(doc.querySelector('[id="mbr-node-p-first-off"]'))).toMatch(/Acceptance scheme Tablet weight \(in-process\): every criterion applies \(AS-UOW\)/);
    cleanup();
    const b = text((await renderDocument(c10)).querySelector('[id="mbr-item-tabletWeight"]'));
    expect(b).toContain('10 readings per capture');
  });

  it('[PR-03][IN-14] a printed component shows its approved specimen; the market predicates and golden-case values are shown', async () => {
    const c = allMembers();
    const doc = await renderDocument(c);
    const line = c.bom[0] as flow.BomLine;
    expect(text(doc.querySelector(`[id="mbr-item-${line.id}"]`))).toContain('SPEC-CODE-X7 v3: Carton specimen X7 (SPEC-X7)');
    const predicates = [...doc.querySelectorAll('table[aria-label="Market predicates"] tbody tr')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));
    expect(predicates).toEqual([
      ['licenceFormX7', 'FORM-25-X7'],
      ['exportOrientedX7', 'yes'],
      ['sterileX7', 'no'],
    ]);
    const golden = text(doc.querySelector('[id="mbr-item-G-POTENCY"]'));
    expect(golden).toContain('8.741486 kg');
    expect(golden).toContain('1155.36 g/mol');
  });

  for (const [name, content] of [
    ['the shipped dc-mini template', () => parsed(dcMini)],
    ['the granulation fixture', granulationContent],
    ['the packaging fixture', () => parsed(packaging)],
    ['the granulation fixture with every optional member set', allMembers],
  ] as const) {
    it(`[PR-02][PR-03][DI-04] completeness: every member of ${name} outside the procedure tree, and of its stages, operations, steps (but their configuration) and hold points, is in its place in the read-only document`, async () => {
      const c = content();
      const doc = await renderDocument(c);
      const leaves = documentLeaves(c);
      expect(leaves.filter((l) => RECORD_AND_STEPS.includes(l.area)).length).toBeGreaterThan(100);
      expect(missingLeaves(doc, leaves, RECORD_AND_STEPS)).toEqual([]);
    });
  }
});
