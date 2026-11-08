/**
 * D-6 (owner's MGL-SR-BL report, item 9): a library block's equipment class is a class of the plant. The run accepts
 * only a unit of the class the formulation names (LIB-EQUIPMENT-CLASS), so a class the plant lacks is caught on the
 * master as a WARNING (no clause refuses a master over it; LIB-USE-EQUIPMENT-CLASS keeps the binding duty to name the
 * equipment). Without the plant's classes (the web's own check, a simulation job) the rule says nothing.
 */
import { describe, expect, it } from 'vitest';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { catalogWithLibrary, libraryBlockType } from '../../src/library/index.ts';
import { mbrWith, phase, validate } from '../flow/support.ts';
import { friability, range } from '../library/examples.ts';

function master(cls: string): MbrContent {
  const p = phase('p', { block: { type: libraryBlockType('IPC-FRIAB'), version: '1' }, config: { limits: { loss: range('%', undefined, '0.8') }, equipmentClasses: { friabilatorClass: cls } } as never });
  return { ...mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }), blockDefinitions: [friability()] as never };
}
const findings = (mbr: MbrContent, plantClasses?: readonly string[]) =>
  validate(mbr, { blocks: catalogWithLibrary(genericBlockCatalog, mbr), ...(plantClasses ? { plantClasses } : {}) }).findings.filter((f) => f.rule === 'GMP-EQUIPMENT-CLASS-PLANT');

describe('a library block names a class of the plant (D-6)', () => {
  it('[PR-03] a class the plant holds passes; one it lacks is a warning naming the class and the slot; without the plant\'s classes nothing is said', () => {
    expect(findings(master('EQC-FRB'), ['EQC-BAL', 'EQC-FRB'])).toEqual([]);
    const lacking = findings(master('FRIABILATOR'), ['EQC-BAL', 'EQC-FRB']);
    expect(lacking.map((f) => [f.severity, f.subject])).toEqual([['WARNING', 'p']]);
    expect(lacking[0]?.message).toMatch(/names the equipment class FRIABILATOR for friabilatorClass, which is not a class of the plant/);
    expect(findings(master('FRIABILATOR'))).toEqual([]);
  });
});
