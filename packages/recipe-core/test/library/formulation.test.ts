/**
 * Assembling a formulation from library blocks, slice S9 (decision 0026): a library step pins the approved version's
 * content hash and takes its performer and checker from the block; the master carries one snapshot per version; a
 * library limit bound to a market rule is refused when it is looser than the registered value (O-5), as a parameter's is.
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent } from '../../src/flow/model.ts';
import { catalogWithLibrary, definitionHash, libraryPhase, withSnapshot } from '../../src/library/index.ts';
import type { BlockDefinition } from '../../src/library/model.ts';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import type { MinimaRequest, ResolvedMinimum } from '../../src/validator/types.ts';
import { errors, mbrWith, phase, validate } from '../flow/support.ts';
import { fluidBedDrying, friability, range } from './examples.ts';
import { INJECTABLE_CATALOGUE, SEED_CATALOGUE } from '../../src/library/seed/index.ts';

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

  /** A master whose one step is library block `def` (its snapshot carried) with `config` as its values. */
  const stepOf = (def: BlockDefinition, config: Record<string, unknown>): MbrContent => {
    const p = phase(`p-${def.code.toLowerCase()}`, { block: { type: `LIB-${def.code}`, version: String(def.version) }, config: config as never });
    return { ...mbrWith({ kind: 'sequence', id: 'ops', children: [p] }), blockDefinitions: [def] as never };
  };
  const noCheckpoint = (m: MbrContent): string[] =>
    errors(validate(m, { blocks: catalogWithLibrary(genericBlockCatalog, m) })).filter((f) => f.rule === 'GMP-YIELDS' && /names no yield checkpoint/.test(f.message)).map((f) => f.message);
  const item = (code: string) => {
    const found = SEED_CATALOGUE.find((s) => s.definition.code === code);
    if (!found) throw new Error(`${code} is not in the catalogue`);
    return found;
  };
  const unitAccount = item('INJ-UNIT-ACCOUNT');

  it('[PR-03][INV-34][PR-31][PR-39] a library yield or reconciliation step whose block judges a critical calculated limit of its own (units not accounted for) needs no master yield checkpoint', () => {
    expect(noCheckpoint(stepOf(unitAccount.definition, unitAccount.exampleUse as never))).toEqual([]);
  });

  it('[PR-03][INV-34][PR-31][PR-39] every library yield or reconciliation block of the catalogue with a critical calculated limit stands as its own yield checkpoint but the printed-packaging and label reconciliations, and unit accountability needs a master checkpoint when its calculation is not critical', () => {
    const reconciling = SEED_CATALOGUE.filter((s) => (s.definition.roles ?? []).includes('YIELD_RECONCILIATION'));
    expect(reconciling.length).toBeGreaterThan(2);
    for (const s of reconciling) {
      const found = noCheckpoint(stepOf(s.definition, s.exampleUse));
      expect(found, s.definition.code).toHaveLength(['CTRL-PRINTED-RECON', 'PACK-LABEL-RECON'].includes(s.definition.code) ? 1 : 0);
    }
    const notCritical: BlockDefinition = {
      ...unitAccount.definition,
      sections: unitAccount.definition.sections.map((sec) => ({ ...sec, fields: sec.fields.map((f) => (f.type === 'CALC' ? { ...f, critical: false } : f)) })),
    };
    expect(noCheckpoint(stepOf(notCritical, unitAccount.exampleUse as never))).toHaveLength(1);
  });

  it('[PR-03][INV-34][PR-31][PR-39] CTRL-PRINTED-RECON and PACK-LABEL-RECON, each a step with its example limits, still raise names no yield checkpoint: a labeling reconciliation (211.125) is no yield of the product (211.103)', () => {
    for (const code of ['CTRL-PRINTED-RECON', 'PACK-LABEL-RECON']) {
      const s = item(code);
      expect(noCheckpoint(stepOf(s.definition, s.exampleUse as never)), code).toHaveLength(1);
    }
  });
});
