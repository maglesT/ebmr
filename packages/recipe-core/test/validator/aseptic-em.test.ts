/**
 * INV-23 (b) (lead ruling, 14 November 2026; 21 CFR 211.42(c)(10)(iv)): on every market, a master with a filling step and
 * no terminal sterilisation step fills aseptically, so it monitors the environment during the operation and enters the
 * counts after the filling. The validator reads roles (FILLING, TERMINAL_STERILISATION, EM_IN_OPERATION, EM_COUNTS),
 * never block codes, so a firm's own blocks count (rule INJ-ASEPTIC-EM). The database re-checks it at QA approval
 * (injectables 3080; apps/tablets-server/test/injectables/aseptic-em-approval.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { catalogWithLibrary, libraryBlockType, type BlockDefinition } from '../../src/library/index.ts';
import { INJECTABLE_ASEPTIC_CATALOGUE, INJECTABLE_CATALOGUE } from '../../src/library/seed/index.ts';
import { mbrWith, phase, validate } from '../flow/support.ts';

const definition = (code: string): BlockDefinition => {
  const item = [...INJECTABLE_CATALOGUE, ...INJECTABLE_ASEPTIC_CATALOGUE].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no catalogue item ${code}`);
  return item.definition;
};
const step = (id: string, code: string) => phase(id, { block: { type: libraryBlockType(code), version: '1' }, config: {} });
/** The firm's own terminal sterilisation block: another code, the role TERMINAL_STERILISATION. */
const OWN_TERMINAL: BlockDefinition = {
  code: 'FIRM-AUTOCLAVE-LOAD', version: 1, title: 'Our terminal sterilisation of the filled load', category: 'PROCESS', edition: 'injectables', roles: ['PARAMETER_RECORD', 'TERMINAL_STERILISATION'],
  description: 'The filled load sterilised in its final container.', instructions: 'Run the validated cycle.',
  sections: [{ id: 'cycle', title: 'Cycle', fields: [{ id: 'cyclePassed', label: 'Cycle passed', type: 'YES_NO', expected: true }] }],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }, { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' }],
};

function master(marketSet: string[], children: FlowNode[]): MbrContent {
  const base = mbrWith({ kind: 'sequence', id: 'ops', children });
  const defs = ['INJ-FILL', 'INJ-EM', 'INJ-EM-COUNTS', 'INJ-TERMINAL-STERILISE'].map(definition);
  return { ...base, header: { ...base.header, edition: 'injectables', marketSet }, blockDefinitions: [...defs, OWN_TERMINAL] as never };
}
const findings = (mbr: MbrContent) =>
  validate(mbr, { blocks: catalogWithLibrary(genericBlockCatalog, mbr) }).findings.filter((f) => f.rule === 'INJ-ASEPTIC-EM');

describe('an aseptic fill monitors its environment during the operation and enters the counts after it (INV-23 (b))', () => {
  it('[INV-23] the catalogue blocks carry the roles the rule reads: INJ-FILL FILLING, INJ-TERMINAL-STERILISE TERMINAL_STERILISATION, INJ-EM EM_IN_OPERATION, INJ-EM-COUNTS EM_COUNTS (each beside its role before)', () => {
    expect(definition('INJ-FILL').roles).toEqual(['PARAMETER_RECORD', 'FILLING']);
    expect(definition('INJ-TERMINAL-STERILISE').roles).toEqual(['PARAMETER_RECORD', 'TERMINAL_STERILISATION']);
    expect(definition('INJ-EM').roles).toEqual(['ENVIRONMENT_CHECK', 'EM_IN_OPERATION']);
    expect(definition('INJ-EM-COUNTS').roles).toEqual(['ENVIRONMENT_CHECK', 'EM_COUNTS']);
  });

  it('[INV-23] an aseptic master (a fill, no terminal sterilisation) with no EM during the operation and no counts after the fill is refused, on every market; with both it passes', () => {
    for (const markets of [['IN'], ['US'], ['EU'], ['IN', 'US', 'EU']]) {
      const without = findings(master(markets, [step('filling', 'INJ-FILL'), phase('after')]));
      expect(without.map((f) => f.message).join(' | '), markets.join()).toMatch(/no step that monitors the environment during the operation.*\| .*no step after it on every path enters the environmental monitoring counts/);
      expect(without.every((f) => f.severity === 'ERROR' && f.subject === 'filling')).toBe(true);
      expect(findings(master(markets, [step('em', 'INJ-EM'), step('filling', 'INJ-FILL'), step('counts', 'INJ-EM-COUNTS')])), markets.join()).toEqual([]);
    }
  });

  it('[INV-23] the counts must follow the fill: counts before the fill, or EM during the operation alone, are refused', () => {
    const before = findings(master(['IN'], [step('em', 'INJ-EM'), step('counts', 'INJ-EM-COUNTS'), step('filling', 'INJ-FILL')]));
    expect(before).toHaveLength(1);
    expect(before[0]?.message).toMatch(/no step after it on every path enters the environmental monitoring counts/);
    const noCounts = findings(master(['IN'], [step('em', 'INJ-EM'), step('filling', 'INJ-FILL')]));
    expect(noCounts).toHaveLength(1);
    const noEm = findings(master(['IN'], [step('filling', 'INJ-FILL'), step('counts', 'INJ-EM-COUNTS')]));
    expect(noEm).toHaveLength(1);
    expect(noEm[0]?.message).toMatch(/monitors the environment during the operation/);
  });

  it('[INV-23] a terminally sterilised master needs no EM step: with the catalogue terminal sterilisation, or the firm\'s own block of the role TERMINAL_STERILISATION, it is accepted', () => {
    expect(findings(master(['IN', 'US'], [step('filling', 'INJ-FILL'), step('ts', 'INJ-TERMINAL-STERILISE')]))).toEqual([]);
    expect(findings(master(['EU'], [step('filling', 'INJ-FILL'), step('ts', 'FIRM-AUTOCLAVE-LOAD')]))).toEqual([]);
  });

  it('[INV-23] a master with no filling step is not concerned', () => {
    expect(findings(master(['IN'], [phase('only')]))).toEqual([]);
  });
});
