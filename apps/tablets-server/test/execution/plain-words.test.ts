/**
 * Slice 7u (R10 #14, #17; owner demo of 25 October 2026): internal codes on screen ("step p-g21@ is not performed",
 * "granulator.power_kW") and the cartoning step offering "Record: Atd check" on an India-only order. The packaging
 * completion view names its steps by number and MBR name, a process tag reads as words, and the anti-tampering check is
 * offered only where the master record configures it, saying why it is asked. Display only: the stored texts stay.
 */
import { describe, expect, it } from 'vitest';
import type { PackagingCompletionView } from '@ebmr/api-contract';
import { engine, type flow } from '@ebmr/recipe-core';
import { rtwPackagingContent, rtwProcessingContent } from '../../src/cli/demo-route-masters.ts';
import { EXPRESSIONS } from '../../src/features/designer/adapters/expressions.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../src/features/edition-blocks.ts';
import { blockEntryForms } from '../../src/features/execution/block-entries.ts';
import { peopleText, tagWords } from '../../src/features/execution/people-text.ts';
import { packagingViewText } from '../../src/features/labels/index.ts';

const define = (mbr: flow.MbrContent): engine.BatchDefinition =>
  engine.defineBatch(mbr, { registry: tabletsBlockRegistry(), catalog: tabletsBlockCatalog, expressions: EXPRESSIONS, installation: 'GMP', justifications: [] });

describe('MBR names and plain words instead of internal codes (R10 #14)', () => {
  it('[DI-34] a process tag reads as words, in an exception title as the step screen shows it; the stored text keeps the tag', () => {
    expect(tagWords('granulator.power_kW')).toBe('Granulator power, kW');
    expect(tagWords('dryer.inlet_temp_C')).toBe('Dryer inlet temperature, °C');
    expect(tagWords('blister.seal_temp_C')).toBe('Blister seal temperature, °C');
    const def = define(rtwProcessingContent('RTW-WG-TEST', ['IN']));
    const said = peopleText({ def }, "granulator.power_kW at p-gran@ was keyed by hand under the MBR's fallback path; the step now needs a second person");
    expect(said).not.toMatch(/granulator\.power_kW|p-gran@/);
    expect(said).toMatch(/^Granulator power, kW at step \d+(\.\d+)* Wet granulation/);
  });

  it('[DI-34][PR-16] the packaging completion view names its steps by number and MBR name, not by key', () => {
    const def = define(rtwPackagingContent('RTW-CF-TEST', ['IN']));
    const step = { stepKey: 'p-g21@', status: 'IN_PROGRESS', coding: false, expectedCoding: null, codingSpecimens: [], labelSpecimens: [], items: [], waivers: [], problem: 'step p-g21@ is not performed' };
    const v = { batchId: '11111111-2222-4333-8444-555555555555', batchNumber: 'B1', steps: [step], inspections: [], lineStops: [], completionProblem: 'step p-g21@ is not performed' } as PackagingCompletionView;
    const shown = packagingViewText(def, v);
    expect(shown.completionProblem).toMatch(/^step \d+(\.\d+)* Printed foil and cartons: issue, coding and reconciliation is not performed$/);
    expect(shown.steps[0]?.stepText).toMatch(/^\d+(\.\d+)* Printed foil and cartons/);
    expect(shown.steps[0]?.stepKey).toBe('p-g21@');
  });
});

describe('the anti-tampering check on an order whose markets do not need it (R10 #17)', () => {
  const tb24 = (markets: string[]): { block: engine.StepDef['block']; config: Readonly<Record<string, unknown>> } => {
    const def = define(rtwPackagingContent('RTW-CF-TEST', markets));
    const s = [...def.steps.values()].find((x) => x.block?.type === 'TB-24');
    if (!s) throw new Error('no TB-24 step');
    return { block: s.block, config: s.config };
  };

  it('[PR-41][PR-42] not offered where the master configures no anti-tampering check; offered with why where it does', () => {
    const india = tb24(['IN']);
    expect(blockEntryForms(india.block, { config: india.config, markets: ['IN'] }).map((f) => f.kind)).not.toContain('ATD_CHECK');
    const eu = tb24(['IN', 'EU']);
    const atd = blockEntryForms(eu.block, { config: eu.config, markets: ['IN', 'EU'] }).find((f) => f.kind === 'ATD_CHECK');
    expect(atd?.title).toBe('Anti-tampering check');
    expect(atd?.description).toMatch(/the EU, a market of this order, requires an anti-tampering device/);
    // A master copied for India only that keeps the source's check: offered, saying why it is asked.
    const kept = blockEntryForms(eu.block, { config: eu.config, markets: ['IN'] }).find((f) => f.kind === 'ATD_CHECK');
    expect(kept?.description).toMatch(/Asked because the master record configures it on this step \(markets of this order: IN; the EU would require it\)/);
  });
});
