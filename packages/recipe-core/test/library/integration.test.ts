/**
 * Library blocks in masters and batches, slice S4 (decision 0026): the master carries the snapshots of the library
 * blocks it uses, and the registry, the catalogue and the validator take them from there. A master without library
 * blocks keeps the registry (and fingerprint) it had, so no batch in flight changes (ADR 0010).
 */
import { describe, expect, it } from 'vitest';
import { EngineDefinitionError } from '../../src/engine/definition.ts';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { parseMbr } from '../../src/flow/parse.ts';
import { catalogWithLibrary, checkBlockDefinition, checkBlockUse, defineOptionsFor, descriptorOf, libraryBlockType, registryWithLibrary, snapshotProblems, type BlockDefinition } from '../../src/library/index.ts';
import { define, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase, validate } from '../flow/support.ts';
import { fluidBedDrying, fluidBedDryingUse, friability, friabilityUse, range } from './examples.ts';

function masterWith(defs: BlockDefinition[], config: Record<string, unknown> = { limits: { loss: range('%', undefined, '0.8') }, equipmentClasses: { friabilatorClass: 'FRIABILATOR' } }): MbrContent {
  const p = phase('p', { block: { type: libraryBlockType('IPC-FRIAB'), version: '1' }, config: config as never });
  return { ...mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }), blockDefinitions: defs as never };
}

describe('library blocks in masters and batches', () => {
  it('[DI-10] a master without library blocks keeps the registry and its fingerprint; one with a snapshot extends it for its own batches', () => {
    const base = testRegistry();
    const plain = mbrWith(phase('p'));
    expect(registryWithLibrary(base, plain, expr)).toBe(base);
    const extended = registryWithLibrary(base, masterWith([friability()]), expr);
    expect(extended.fingerprint()).not.toBe(base.fingerprint());
    expect(extended.fingerprint()).toBe(registryWithLibrary(base, masterWith([friability()]), expr).fingerprint());
  });

  it('[DI-34][PR-03] a batch is defined from the master\'s own snapshot; a snapshot that is not well made, or one carried twice, refuses the batch', () => {
    const mbr = masterWith([friability()]);
    const def = define(mbr, defineOptionsFor(mbr, { registry: testRegistry(), expressions: expr, installation: 'SANDBOX' }));
    expect(def.steps.get('p')?.block?.type).toBe('LIB-IPC-FRIAB');
    const bad = masterWith([{ ...friability(), signatures: [] }]);
    expect(() => defineOptionsFor(bad, { registry: testRegistry(), expressions: expr })).toThrow(EngineDefinitionError);
    expect(snapshotProblems(masterWith([friability(), friability()]), expr).map((p) => p.code)).toEqual(['LIB-SNAPSHOT-DUPLICATE']);
  });

  it('[PR-03] a phase naming a library version the master does not carry cannot be defined (ENG-DEF-BLOCK)', () => {
    const mbr = masterWith([{ ...friability(), version: 2 }]);
    expect(() => define(mbr, defineOptionsFor(mbr, { registry: testRegistry(), expressions: expr, installation: 'SANDBOX' }))).toThrow(/LIB-IPC-FRIAB@1/);
  });

  it('[PR-03] the validator knows a carried library block (FLOW-BLOCKS) and an unknown one stays refused', () => {
    const mbr = masterWith([friability()]);
    const known = validate(mbr, { blocks: catalogWithLibrary(genericBlockCatalog, mbr) }).findings.filter((f) => f.rule === 'FLOW-BLOCKS');
    expect(known).toEqual([]);
    const unknown = validate(mbr, { blocks: genericBlockCatalog }).findings.filter((f) => f.rule === 'FLOW-BLOCKS');
    expect(unknown.length).toBe(1);
  });

  it('[PR-03][DI-35] a library block that needs a checker or a verifier is significant, so its phase needs a checker who is not the performer', () => {
    expect(descriptorOf(friability(), ['1']).significant).toBe(false);
    expect(descriptorOf(fluidBedDrying(), ['1']).significant).toBe(true);
    expect(descriptorOf(friability(), ['1']).roles).toEqual(['IPC']);
    expect(descriptorOf({ ...friability(), category: 'CONTROL', roles: ['CLEARANCE'] }, ['1']).roles).toEqual(['CLEARANCE']);
  });

  it('[PR-03] a library block takes only roles whose meaning needs no block code', () => {
    expect(checkBlockDefinition({ ...friability(), roles: ['CLEARANCE'] }, expr)).toEqual([]);
    expect(checkBlockDefinition({ ...friability(), roles: ['DISPENSING' as never] }, expr).map((p) => p.code)).toEqual(['LIB-ROLES']);
  });

  it('[PR-08] a library limit is written in its field\'s unit, so the database compares in one unit', () => {
    const use = { ...fluidBedDryingUse(), limits: { ...fluidBedDryingUse().limits, dryingTime: range('h', '0.5', '1.5', 'INTERNAL_ACTION') } };
    expect(checkBlockUse(fluidBedDrying(), use, expr).map((p) => p.code)).toEqual(['LIB-USE-LIMIT-UNIT']);
    expect(checkBlockUse(friability(), friabilityUse(), expr)).toEqual([]);
  });

  it('the content format takes library snapshots and library block types; a snapshot names its code and version', () => {
    const mbr = masterWith([friability()]);
    const parsed = parseMbr(JSON.parse(JSON.stringify(mbr)));
    expect(parsed.ok).toBe(true);
    const bad = parseMbr(JSON.parse(JSON.stringify({ ...mbr, blockDefinitions: [{ title: 'x' }] })));
    expect(bad.ok ? [] : bad.problems.map((p) => p.path)).toEqual(['$.blockDefinitions[0]']);
  });
});
