/**
 * The blocks a market's binding clause makes mandatory on a master (lead ruling, I-6 B2). A block's `markets` tag is
 * metadata the engine does not read (owner Q0), so the validator reads a table (MARKET_REQUIRED_BLOCKS): on a master for
 * the market, each trigger step has the required block after it (or before it) on every path. First entry, ST-06: on the
 * EU market the filling step (INJ-FILL) is followed by the assessment of its alarms (INJ-ALARM-ASSESSMENT, A1 5.2).
 * Second, ST-52: on the EU market the sterilising filtration (INJ-STERILE-FILTER) has PUPSIT (INJ-PUPSIT, A1 8.87)
 * before it.
 */
import { describe, expect, it } from 'vitest';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { catalogWithLibrary, libraryBlockType } from '../../src/library/index.ts';
import { INJECTABLE_ASEPTIC_CATALOGUE, INJECTABLE_CATALOGUE, SEED_CATALOGUE } from '../../src/library/seed/index.ts';
import { MARKET_REQUIRED_BLOCKS } from '../../src/validator/rules-content.ts';
import { mbrWith, phase, validate } from '../flow/support.ts';

const definition = (code: string) => {
  const item = [...INJECTABLE_CATALOGUE, ...INJECTABLE_ASEPTIC_CATALOGUE].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no catalogue item ${code}`);
  return item.definition;
};
const step = (id: string, code: string) => phase(id, { block: { type: libraryBlockType(code), version: '1' }, config: {} });

function master(marketSet: string[], children: FlowNode[]): MbrContent {
  const base = mbrWith({ kind: 'sequence', id: 'ops', children });
  return { ...base, header: { ...base.header, edition: 'injectables', marketSet }, blockDefinitions: ['INJ-FILL', 'INJ-ALARM-ASSESSMENT', 'INJ-STERILE-FILTER', 'INJ-PUPSIT'].map(definition) as never };
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
    const without = findings(master(['IN', 'EU'], [phase('before'), filter, phase('after')]));
    expect(without).toHaveLength(1);
    expect(without[0]).toMatchObject({ severity: 'ERROR', subject: 'filtration' });
    expect(without[0]?.message).toMatch(/INJ-PUPSIT before it .*ST-52.*8\.87/);
    expect(findings(master(['IN', 'EU'], [phase('before'), pupsit, filter, phase('after')]))).toEqual([]);
    // PUPSIT placed after filtration does not precede it.
    const late = findings(master(['IN', 'EU'], [phase('before'), filter, pupsit, phase('after')]));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ severity: 'ERROR', subject: 'filtration' });
    expect(findings(master(['IN', 'US'], [phase('before'), filter, phase('after')]))).toEqual([]);
  });
});
