/**
 * Assembling a formulation from library blocks, slice S9 (decision 0026): a library step pins the approved version's
 * content hash and takes its performer and checker from the block; the master carries one snapshot per version; a
 * library limit bound to a market rule is refused when it is looser than the registered value (O-5), as a parameter's is.
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent } from '../../src/flow/model.ts';
import { catalogWithLibrary, definitionHash, libraryPhase, withSnapshot } from '../../src/library/index.ts';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import type { MinimaRequest, ResolvedMinimum } from '../../src/validator/types.ts';
import { errors, mbrWith, phase, validate } from '../flow/support.ts';
import { fluidBedDrying, friability, range } from './examples.ts';
import { INJECTABLE_CATALOGUE } from '../../src/library/seed/index.ts';

describe('assembling a formulation from library blocks', () => {
  it('[PR-05][DI-35] a library step pins the hash and takes its roles from the block; a block with a verifier is significant', () => {
    const p = libraryPhase(fluidBedDrying(), 'p-fbd', 'MEDIUM');
    expect(p.block).toEqual({ type: 'LIB-PROC-FBD', version: '1' });
    expect(p.config).toEqual({ hash: definitionHash(fluidBedDrying()) });
    expect(p.signatures).toEqual({ perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'SUPERVISOR' } });
    expect(p.significant).toBe(true);
    expect(libraryPhase(friability(), 'p-f', 'LOW').significant).toBe(false);
    // An earlier step's value (STEP_VALUE) is read from that step at run time, not from the master's data: the step does
    // not list it among its reads (I-1c: the validator refused INJ-FILL's density as an undeclared value).
    const fill = INJECTABLE_CATALOGUE.find((s) => s.definition.code === 'INJ-FILL')?.definition;
    expect(fill && libraryPhase(fill, 'p-inj-fill', 'HIGH').reads).toEqual([]);
  });

  it('[PR-05] a master carries one snapshot per version; another content under the same version is refused', () => {
    const once = withSnapshot({}, friability());
    expect(withSnapshot({ blockDefinitions: once }, friability())).toHaveLength(1);
    expect(() => withSnapshot({ blockDefinitions: once }, { ...friability(), title: 'Edited' })).toThrow(/already carried with other content/);
  });

  it('[PR-08] a library limit bound to a market rule is refused when looser than the registered value (O-5)', () => {
    const p = phase('p', { block: { type: 'LIB-IPC-FRIAB', version: '1' }, config: { limits: { loss: range('%', undefined, '1.2') }, marketRules: { loss: { key: 'tablets.friability.max', bound: 'HIGH' } } } as never });
    const mbr: MbrContent = { ...mbrWith({ kind: 'sequence', id: 'ops', children: [p] }), blockDefinitions: [friability()] as never };
    const seen: MinimaRequest[] = [];
    const minima: ResolvedMinimum[] = [{ kind: 'LIMIT', ruleKey: 'tablets.friability.max', bound: 'HIGH', value: '1.0', unit: '%', governingMarkets: ['IN'], tableVersion: 't1' }];
    const report = validate(mbr, { blocks: catalogWithLibrary(genericBlockCatalog, mbr), market: { minima: (r: MinimaRequest) => { seen.push(r); return minima; } } });
    expect(seen[0]?.ruleKeys).toEqual(['tablets.friability.max']);
    const found = errors(report).filter((f) => f.rule === 'MKT-MINIMA').map((f) => f.message);
    expect(found.join(' ')).toMatch(/looser than the maximum of 1\.0 %/);
    const tight = { ...mbr, procedure: { ...mbr.procedure, body: { kind: 'sequence' as const, id: 'ops', children: [{ ...p, config: { ...p.config, limits: { loss: range('%', undefined, '0.8') } } } as never] } } };
    expect(errors(validate(tight, { blocks: catalogWithLibrary(genericBlockCatalog, tight), market: { minima: () => minima } })).filter((f) => f.rule === 'MKT-MINIMA')).toEqual([]);
  });
});
