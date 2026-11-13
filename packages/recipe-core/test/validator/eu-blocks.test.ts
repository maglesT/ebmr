/**
 * The Annex 1 blocks an EU-market master must place after a given block (lead ruling, I-6 B2). A block's `markets` tag is
 * metadata the engine does not read (owner Q0), so the master validator states the requirement: on a master for the EU
 * market, the filling step (INJ-FILL) is followed on every path by the assessment of its alarms (INJ-ALARM-ASSESSMENT,
 * ST-06, A1 5.2). Outside the EU no clause asks it.
 */
import { describe, expect, it } from 'vitest';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { catalogWithLibrary, libraryBlockType } from '../../src/library/index.ts';
import { INJECTABLE_ASEPTIC_CATALOGUE, INJECTABLE_CATALOGUE } from '../../src/library/seed/index.ts';
import { mbrWith, phase, validate } from '../flow/support.ts';

const definition = (code: string) => {
  const item = [...INJECTABLE_CATALOGUE, ...INJECTABLE_ASEPTIC_CATALOGUE].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no catalogue item ${code}`);
  return item.definition;
};
const step = (id: string, code: string) => phase(id, { block: { type: libraryBlockType(code), version: '1' }, config: {} });

function master(marketSet: string[], children: FlowNode[]): MbrContent {
  const base = mbrWith({ kind: 'sequence', id: 'ops', children });
  return { ...base, header: { ...base.header, edition: 'injectables', marketSet }, blockDefinitions: [definition('INJ-FILL'), definition('INJ-ALARM-ASSESSMENT')] as never };
}
const findings = (mbr: MbrContent) =>
  validate(mbr, { blocks: catalogWithLibrary(genericBlockCatalog, mbr) }).findings.filter((f) => f.rule === 'MKT-EU-BLOCKS-AFTER');

describe('the Annex 1 blocks an EU-market master places (I-6 B2)', () => {
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
});
