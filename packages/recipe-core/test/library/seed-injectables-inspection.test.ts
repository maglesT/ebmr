/**
 * The Injectables edition's catalogue blocks of slice I-5 (automated visual inspection, deterministic 100 % container
 * closure integrity testing; rapid microbial methods as an option of the release tests): each is data of the
 * `injectables` edition, passes the library checker, records what its clause asks, and judges it. Every block also runs
 * nominally to completion in seed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { blockEdition, checkBlockDefinition, checkBlockUse, libraryBlockType, libraryBlockVersion } from '../../src/library/index.ts';
import { INJECTABLE_INSPECTION_CATALOGUE, SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { define, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';
import { byCode, fieldOf, judgedRun, nominalRun, recordNominal } from './seed-support.ts';

describe('the Injectables catalogue (slice I-5, automated inspection and integrity testing)', () => {
  it('[PR-05][PR-03] the catalogue holds the automated inspection block, its EU-market challenge block and the 100 % integrity test block, each of the injectables edition, loaded with the rest of the catalogue, passing the library checker and the formulation checks, and completed by a nominal batch; only the Annex 1 challenge is tagged for the EU market', () => {
    expect(INJECTABLE_INSPECTION_CATALOGUE.map((s) => s.definition.code)).toEqual(['INJ-AVI', 'INJ-AVI-CHALLENGE-EU', 'INJ-CCIT-100']);
    for (const s of INJECTABLE_INSPECTION_CATALOGUE) {
      const code = s.definition.code;
      expect(blockEdition(s.definition), code).toBe('injectables');
      expect(SEED_CATALOGUE, code).toContain(s);
      expect(checkBlockDefinition(s.definition, expr), code).toEqual([]);
      expect(checkBlockUse(s.definition, { block: { code, version: s.definition.version }, ...s.exampleUse }, expr), code).toEqual([]);
      expect(nominalRun(s), code).toEqual({ exceptions: [], status: 'COMPLETED' });
    }
    expect(byCode('INJ-AVI').definition.markets).toBeUndefined();
    expect(byCode('INJ-CCIT-100').definition.markets).toBeUndefined();
    expect(byCode('INJ-AVI-CHALLENGE-EU').definition.markets).toEqual(['EU']);
  });

  it('[ST-62][ST-63][IN-50] automated inspection names the machine by its class, records the counts by defect category from the machine report, checked by a second person, and judges the reject rate; a reject rate above its limit or no report attached is an exception', () => {
    const item = byCode('INJ-AVI');
    expect(item.definition.roles).toEqual(['OBSERVATION']);
    expect(fieldOf(item, 'machine')).toMatchObject({ type: 'EQUIPMENT', classSlot: 'aviClass' });
    // The same categories and counts as the manual block, so the unit accountability reads both alike.
    const manual = byCode('INJ-VISUAL-INSPECT');
    for (const id of ['inspected', 'particles', 'container', 'fill', 'closure', 'rejected', 'rejectRate', 'accepted']) expect(fieldOf(item, id), id).toEqual(fieldOf(manual, id));
    const [performed, checked] = item.definition.signatures;
    expect([performed?.meaning, checked?.meaning]).toEqual(['PERFORMED', 'CHECKED']);
    expect(checked?.role).not.toBe(performed?.role);
    // No AQL: no binding clause asks for one after automated inspection.
    expect(item.definition.sections.flatMap((s) => s.fields).filter((f) => f.type === 'SAMPLE')).toEqual([]);
    expect(judgedRun(item, { counts: { particles: '300' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { counts: { reportAttached: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-62] for the EU market, the inspection machine is challenged with the defect test set before start-up and at the formulation\'s intervals, recorded by the operator alone; a defect of the test set not rejected is an exception', () => {
    const item = byCode('INJ-AVI-CHALLENGE-EU');
    expect(item.definition.sections[0]?.repeat).toEqual({ kind: 'COUNT', countSlot: 'challengeCount' });
    expect(item.definition.signatures).toEqual([{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }]);
    // Every challenge of the example's three is recorded so: each one is its own exception.
    expect(judgedRun(item, { challenge: { allRejected: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER', 'LIB_UNEXPECTED_ANSWER', 'LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-64][IN-50] the 100 % integrity test names the tester by its class, records the units tested and the leakers from the machine report, checked by a second person; a leaker is a counted reject, not an exception; no report attached is one', () => {
    const item = byCode('INJ-CCIT-100');
    expect(fieldOf(item, 'tester')).toMatchObject({ type: 'EQUIPMENT', classSlot: 'cciClass' });
    expect(fieldOf(item, 'totalRejects')).toMatchObject({ type: 'CALC', expression: 'closingRejects + leakRejects' });
    const [performed, checked] = item.definition.signatures;
    expect([performed?.meaning, checked?.meaning]).toEqual(['PERFORMED', 'CHECKED']);
    expect(judgedRun(item, { test: { leakRejects: '250' } })).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(judgedRun(item, { test: { reportAttached: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-64] the sampled integrity test offers laser headspace analysis among its methods', () => {
    const method = fieldOf(byCode('INJ-CCI'), 'method');
    expect(method.type === 'CHOICE' ? method.options : []).toContain('Laser headspace analysis');
  });

  it('[ST-71] with the 100 % integrity test and automated inspection, unit accountability reads the closing rejects from the integrity test\'s total and the units accepted from the last step, in either order; one unit missing is an exception', () => {
    const fill = byCode('INJ-FILL');
    const cap = byCode('INJ-CAPPING');
    const ccit = byCode('INJ-CCIT-100');
    const avi = byCode('INJ-AVI');
    const account = byCode('INJ-UNIT-ACCOUNT');
    const registry = testRegistry().extend(...[fill, cap, ccit, avi, account].map((i) => libraryBlockVersion(i.definition, expr)));
    const step = (id: string, item: SeedItem, reads: string[] = []): FlowNode => phase(id, { block: { type: libraryBlockType(item.definition.code), version: '1' }, config: item.exampleUse as never, reads });
    const density = fill.exampleInputs?.['density'] ?? { value: '1.0050', unit: 'g/mL' };
    const master = (children: FlowNode[]): MbrContent =>
      mbrWith({ kind: 'sequence', id: 'ops', children: [...children, phase('after')] }, { inputs: [{ id: 'density', name: 'density', source: 'MASTER_DATA', valueType: 'DECIMAL', unit: density.unit }] });
    const sources = (acceptedFrom: { step: string; field: string }): SeedItem => ({
      ...account,
      exampleUse: { ...account.exampleUse, stepValues: { ...account.exampleUse.stepValues, closingRejectsSource: { step: 'ccit', field: 'totalRejects' }, acceptedSource: acceptedFrom } },
    });
    const run = (order: 'CCIT_FIRST' | 'AVI_FIRST', filled: string): string[] => {
      const acct = order === 'CCIT_FIRST' ? sources({ step: 'inspection', field: 'accepted' }) : sources({ step: 'ccit', field: 'passed' });
      // Filled 10,250: 80 rejected at the line, 30 at capping; the next step takes the 10,140 left less 120 sampled and
      // 20 lost (10,000), rejects 10 (integrity) or 80 (inspection), and the last step takes what the first passed.
      const first: [string, SeedItem, Record<string, Record<string, unknown>>] = order === 'CCIT_FIRST' ? ['ccit', ccit, { test: { tested: '10000', leakRejects: '10' } }] : ['inspection', avi, {}];
      const second: [string, SeedItem, Record<string, Record<string, unknown>>] = order === 'CCIT_FIRST' ? ['inspection', avi, { counts: { inspected: '9990' } }] : ['ccit', ccit, { test: { tested: '9920', leakRejects: '10' } }];
      const mbr = master([step('filling', fill, ['density']), step('capping', cap), step(first[0], first[1]), step(second[0], second[1]), step('account', acct)]);
      const batch = Run.issue(define(mbr, { registry }), { inputs: { density: { value: { kind: 'DECIMAL', value: density.value, unit: density.unit }, source: 'seed example' } } }, T0);
      const steps: [string, SeedItem, Record<string, Record<string, unknown>>][] = [['filling', fill, { end: { filled, rejects: '80' } }], ['capping', cap, { round: { rejects: '30' } }], first, second, ['account', acct, {}]];
      for (const [id, item, overrides] of steps) {
        batch.start(id);
        recordNominal(batch, id, item.definition, item.exampleUse, mbr, overrides);
        try {
          batch.perform(id);
        } catch (e) {
          if (!(e instanceof Error && e.message.includes('ENG-BLOCKED'))) throw e;
          break;
        }
        if (batch.status(id) === 'AWAITING_VERIFICATION') batch.verify(id);
      }
      return batch.exceptions().map((x) => x.type);
    };
    expect(run('CCIT_FIRST', '10250')).toEqual([]);
    expect(run('AVI_FIRST', '10250')).toEqual([]);
    expect(run('CCIT_FIRST', '10251')).toEqual(['LIB_LIMIT_BREACH']);
    expect(run('AVI_FIRST', '10251')).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-65][ST-20] a sterility test by a validated rapid method asks for the instrument report, checked by the QC reviewer; a compendial method does not; no report attached is an exception', () => {
    const item = byCode('TEST-INJ-RELEASE');
    expect(fieldOf(item, 'rmmReportAttached')).toMatchObject({ type: 'YES_NO', expected: true, showWhen: { field: 'sterilityMethod', equals: 'Validated rapid microbial method' } });
    const rmm = { sterilityMethod: 'Validated rapid microbial method', rmmReportAttached: true };
    expect(judgedRun(item, { sterility: rmm })).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(judgedRun(item, { sterility: { ...rmm, rmmReportAttached: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(item, { sterility: { ...rmm, noGrowth: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });
});
