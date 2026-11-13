/**
 * The blocks a market's binding clause makes mandatory on a master (lead ruling, I-6 B2). A block's `markets` tag is
 * metadata the engine does not read (owner Q0), so the validator reads a table (MARKET_REQUIRED_BLOCKS): on a master for
 * the market, each trigger step has the required block after it (or before it) on every path. First entry, ST-06: on the
 * EU market the filling step (INJ-FILL) is followed by the assessment of its alarms (INJ-ALARM-ASSESSMENT, A1 5.2).
 * Second, ST-52: on the EU market the sterilising filtration (INJ-STERILE-FILTER) has PUPSIT (INJ-PUPSIT, A1 8.87)
 * before it. I-6 B5 adds the entries whose condition is the technology a trigger step uses: single-use systems (ST-79),
 * lyophilisation (ST-58), manual inspection (ST-62), form-fill-seal (ST-78) and blow-fill-seal (ST-77), and automated
 * inspection (ST-62), whose machine challenge the clause places in no order to the inspection (PRESENT).
 */
import { describe, expect, it } from 'vitest';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { catalogWithLibrary, libraryBlockType } from '../../src/library/index.ts';
import { INJECTABLE_ASEPTIC_CATALOGUE, INJECTABLE_CATALOGUE, SEED_CATALOGUE } from '../../src/library/seed/index.ts';
import { MARKET_REQUIRED_BLOCKS } from '../../src/validator/rules-content.ts';
import { mbrWith, phase, validate } from '../flow/support.ts';

const definition = (code: string) => {
  const item = [...INJECTABLE_CATALOGUE, ...INJECTABLE_ASEPTIC_CATALOGUE, ...SEED_CATALOGUE].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no catalogue item ${code}`);
  return item.definition;
};
const step = (id: string, code: string) => phase(id, { block: { type: libraryBlockType(code), version: '1' }, config: {} });

function master(marketSet: string[], children: FlowNode[]): MbrContent {
  const base = mbrWith({ kind: 'sequence', id: 'ops', children });
  return { ...base, header: { ...base.header, edition: 'injectables', marketSet }, blockDefinitions: ['INJ-FILL', 'INJ-ALARM-ASSESSMENT', 'INJ-STERILE-FILTER', 'INJ-PUPSIT', 'INJ-FILTER-SINGLE-BATCH'].map(definition) as never };
}
const findings = (mbr: MbrContent) =>
  validate(mbr, { blocks: catalogWithLibrary(genericBlockCatalog, mbr) }).findings.filter((f) => f.rule === 'MKT-REQUIRED-BLOCKS');

describe('the blocks a market set makes mandatory on a master (I-6 B2)', () => {
  it('[PR-03][IN-52] each entry of the table names blocks of the catalogue, cites its control and clause, and its required block is tagged for the market that requires it', () => {
    expect(MARKET_REQUIRED_BLOCKS.length).toBeGreaterThan(0);
    for (const e of MARKET_REQUIRED_BLOCKS) {
      const name = `${e.market} ${e.trigger} -> ${e.required}`;
      const codes = SEED_CATALOGUE.map((s) => s.definition.code);
      expect(codes, name).toContain(e.trigger);
      expect(codes, name).toContain(e.required);
      expect(SEED_CATALOGUE.find((s) => s.definition.code === e.required)?.definition.markets, name).toContain(e.market);
      expect(e.control, name).toMatch(/^(ST|IN|PR|DI)-\d+$/);
      expect(e.clause.length, name).toBeGreaterThan(10);
    }
  });

  it('[ST-06][PR-03] a master for the EU market whose filling step is not followed by the assessment of its alarms is refused; with the assessment after filling it passes; a master for India and the US needs none', () => {
    const fill = step('filling', 'INJ-FILL');
    const without = findings(master(['IN', 'EU'], [fill, phase('after')]));
    expect(without).toHaveLength(1);
    expect(without[0]).toMatchObject({ severity: 'ERROR', subject: 'filling' });
    expect(without[0]?.message).toMatch(/INJ-ALARM-ASSESSMENT after it .*ST-06/);
    expect(findings(master(['IN', 'EU'], [fill, step('alarms', 'INJ-ALARM-ASSESSMENT'), phase('after')]))).toEqual([]);
    // The assessment placed before filling does not follow it.
    expect(findings(master(['IN', 'EU'], [step('alarms', 'INJ-ALARM-ASSESSMENT'), fill, phase('after')]))).toHaveLength(1);
    expect(findings(master(['IN', 'US'], [fill, phase('after')]))).toEqual([]);
  });

  it('[ST-52][PR-03] a master for the EU market whose sterilising filtration has no PUPSIT step before it is refused; with PUPSIT before filtration it passes, PUPSIT after filtration is refused; a master for India and the US needs none', () => {
    const filter = step('filtration', 'INJ-STERILE-FILTER');
    const pupsit = step('pupsit', 'INJ-PUPSIT');
    // The single-batch check of IN-48 stands before the filtration on every EU master here, so only PUPSIT is at issue.
    const single = step('single', 'INJ-FILTER-SINGLE-BATCH');
    const without = findings(master(['IN', 'EU'], [phase('before'), single, filter, phase('after')]));
    expect(without).toHaveLength(1);
    expect(without[0]).toMatchObject({ severity: 'ERROR', subject: 'filtration' });
    expect(without[0]?.message).toMatch(/INJ-PUPSIT before it .*ST-52.*8\.87/);
    expect(findings(master(['IN', 'EU'], [phase('before'), single, pupsit, filter, phase('after')]))).toEqual([]);
    // PUPSIT placed after filtration does not precede it.
    const late = findings(master(['IN', 'EU'], [phase('before'), single, filter, pupsit, phase('after')]));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ severity: 'ERROR', subject: 'filtration' });
    expect(findings(master(['IN', 'US'], [phase('before'), filter, phase('after')]))).toEqual([]);
  });
});

describe('the single-batch check of the sterilising filter on an EU master (I-6 B4)', () => {
  const filterMaster = (marketSet: string[], children: FlowNode[]): MbrContent => {
    const base = mbrWith({ kind: 'sequence', id: 'ops', children });
    return { ...base, header: { ...base.header, edition: 'injectables', marketSet }, blockDefinitions: [definition('INJ-STERILE-FILTER'), definition('INJ-FILTER-SINGLE-BATCH'), definition('INJ-PUPSIT')] as never };
  };

  it('[IN-48][PR-03] a master for the EU market whose filtration step has no single-batch check of its filter before it is refused (A1 8.94); with the check before it passes; a master for India and the US needs none', () => {
    const filtration = step('filtration', 'INJ-STERILE-FILTER');
    // PUPSIT (ST-52) stands before the filtration on every EU master here, so only the single-batch check is at issue.
    const pupsit = step('pupsit', 'INJ-PUPSIT');
    const without = findings(filterMaster(['IN', 'EU'], [pupsit, filtration, phase('after')]));
    expect(without).toHaveLength(1);
    expect(without[0]).toMatchObject({ severity: 'ERROR', subject: 'filtration' });
    expect(without[0]?.message).toMatch(/INJ-FILTER-SINGLE-BATCH before it .*IN-48/);
    expect(findings(filterMaster(['IN', 'EU'], [step('single', 'INJ-FILTER-SINGLE-BATCH'), pupsit, filtration, phase('after')]))).toEqual([]);
    // The check placed after the filtration does not come before it.
    expect(findings(filterMaster(['IN', 'EU'], [pupsit, filtration, step('single', 'INJ-FILTER-SINGLE-BATCH'), phase('after')]))).toHaveLength(1);
    expect(findings(filterMaster(['IN', 'US'], [filtration, phase('after')]))).toEqual([]);
  });
});

describe('the blocks a clause asks where the master uses its technology (I-6 B5)', () => {
  /** A master of the market set whose operations are `children`, with the definitions of `codes`. */
  const techMaster = (marketSet: string[], codes: string[], children: FlowNode[]): MbrContent => {
    const base = mbrWith({ kind: 'sequence', id: 'ops', children });
    return { ...base, header: { ...base.header, edition: 'injectables', marketSet }, blockDefinitions: codes.map(definition) as never };
  };
  /**
   * The four cases of one entry: without the required step the trigger is refused (the message names the required block,
   * the relation, the control and the clause); with it in its place the master passes; in the other place it is refused;
   * a master for India and the US needs none. No other entry's trigger is on these masters, so each sees only its own.
   */
  function fourCases(trigger: string, required: string, relation: 'BEFORE' | 'AFTER', control: string, clause: RegExp): void {
    const codes = [trigger, required];
    const t = step('trigger', trigger);
    const r = step('required', required);
    const without = findings(techMaster(['IN', 'EU'], codes, [phase('before'), t, phase('after')]));
    expect(without).toHaveLength(1);
    expect(without[0]).toMatchObject({ severity: 'ERROR', subject: 'trigger' });
    expect(without[0]?.message).toContain(`${required} ${relation === 'AFTER' ? 'after' : 'before'} it`);
    expect(without[0]?.message).toContain(control);
    expect(without[0]?.message).toMatch(clause);
    const right = relation === 'AFTER' ? [phase('before'), t, r, phase('after')] : [phase('before'), r, t, phase('after')];
    expect(findings(techMaster(['IN', 'EU'], codes, right))).toEqual([]);
    const wrong = relation === 'AFTER' ? [phase('before'), r, t, phase('after')] : [phase('before'), t, r, phase('after')];
    const misplaced = findings(techMaster(['IN', 'EU'], codes, wrong));
    expect(misplaced).toHaveLength(1);
    expect(misplaced[0]).toMatchObject({ severity: 'ERROR', subject: 'trigger' });
    expect(findings(techMaster(['IN', 'US'], codes, [phase('before'), t, phase('after')]))).toEqual([]);
  }

  it('[ST-79][PR-03] a master for the EU market that uses a single-use assembly (INJ-SUS) without its check before use (INJ-SUS-INTEGRITY) before it is refused (A1 8.138); with the check before it passes, after it is refused; a master for India and the US needs none', () => {
    fourCases('INJ-SUS', 'INJ-SUS-INTEGRITY', 'BEFORE', 'ST-79', /8\.138/);
  });

  it('[ST-58][PR-03] a master for the EU market that lyophilises (INJ-LYO) without the EU lyophilisation record (INJ-LYO-EU: leak test of each cycle, vent filter integrity) after it is refused (A1 8.124); with it after it passes, before it is refused; a master for India and the US needs none', () => {
    fourCases('INJ-LYO', 'INJ-LYO-EU', 'AFTER', 'ST-58', /8\.124/);
  });

  it('[ST-62][PR-03] a master for the EU market whose manual inspection (INJ-VISUAL-INSPECT) has no check of the booth illumination (INJ-INSPECT-LIGHT) before it is refused (A1 8.31); with the check before it passes, after it is refused; a master for India and the US needs none', () => {
    fourCases('INJ-VISUAL-INSPECT', 'INJ-INSPECT-LIGHT', 'BEFORE', 'ST-62', /8\.31/);
  });

  it('[ST-78][PR-03] a master for the EU market that fills by form-fill-seal (INJ-FFS) without the EU record of its settings and batch seal-strength test (INJ-FFS-EU) after it is refused (A1 8.101(v), 8.102); with it after it passes, before it is refused; a master for India and the US needs none', () => {
    fourCases('INJ-FFS', 'INJ-FFS-EU', 'AFTER', 'ST-78', /8\.102/);
  });

  it('[ST-77][PR-03] a master for the EU market that fills by blow-fill-seal (INJ-BFS) without the EU record of its settings and batch wall-thickness test (INJ-BFS-EU) after it is refused (A1 8.115(vi), 8.116); with it after it passes, before it is refused; a master for India and the US needs none', () => {
    fourCases('INJ-BFS', 'INJ-BFS-EU', 'AFTER', 'ST-77', /8\.116/);
  });

  it('[ST-62][PR-03] a master for the EU market whose automated inspection (INJ-AVI) has no challenge of the machine (INJ-AVI-CHALLENGE-EU) anywhere in it is refused (A1 8.32); with the challenge before it, after it or on a parallel branch beside it, it passes; a master for India and the US needs none', () => {
    const codes = ['INJ-AVI', 'INJ-AVI-CHALLENGE-EU'];
    const avi = step('trigger', 'INJ-AVI');
    const challenge = step('required', 'INJ-AVI-CHALLENGE-EU');
    const without = findings(techMaster(['IN', 'EU'], codes, [phase('before'), avi, phase('after')]));
    expect(without).toHaveLength(1);
    expect(without[0]).toMatchObject({ severity: 'ERROR', subject: 'trigger' });
    expect(without[0]?.message).toMatch(/INJ-AVI-CHALLENGE-EU in the master .*ST-62.*8\.32/);
    // The clause fixes no order to the inspection step: before, after or alongside it on a parallel branch all pass.
    expect(findings(techMaster(['IN', 'EU'], codes, [phase('before'), challenge, avi, phase('after')]))).toEqual([]);
    expect(findings(techMaster(['IN', 'EU'], codes, [phase('before'), avi, challenge, phase('after')]))).toEqual([]);
    const parallel: FlowNode = { kind: 'parallel', id: 'inspection', branches: [{ id: 'b-avi', name: 'Inspection', body: avi }, { id: 'b-challenge', name: 'Challenges', body: challenge }] };
    expect(findings(techMaster(['IN', 'EU'], codes, [phase('before'), parallel, phase('after')]))).toEqual([]);
    expect(findings(techMaster(['IN', 'US'], codes, [phase('before'), avi, phase('after')]))).toEqual([]);
  });
});
