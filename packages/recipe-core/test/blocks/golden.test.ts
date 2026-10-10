/**
 * Block contract (outline 6.6; ADR 0010 decision 4): every generic block version of this release is
 * registered with its schemas, handler or engine implementation, exception rules, simulator model,
 * golden fixture and tests; its golden fixture runs through the engine with the expected outcome; the
 * registry reports the rendering parts each version still lacks and the block types still missing.
 */
import { describe, expect, it } from 'vitest';
import { RENDERING_PARTS, type BlockVersion } from '../../src/blocks/contract.ts';
import { GENERIC_BLOCK_VERSIONS, genericBlockRegistry } from '../../src/blocks/generic/index.ts';
import { BlockRegistry, BlockRegistryError } from '../../src/blocks/registry.ts';
import { validateSchema } from '../../src/blocks/schema.ts';
import type { EngineDefinitionError } from '../../src/engine/definition.ts';
import { defineBatch } from '../../src/engine/definition.ts';
import { genericBlockCatalog } from '../../src/flow/blocks.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { expr, loadFixture } from '../flow/support.ts';
import { omit } from '../engine/support.ts';
import { runFixture, sameTo } from './support.ts';

const PHASE_BLOCKS = GENERIC_BLOCK_VERSIONS.filter((b) => b.level === 'PHASE');

describe('block registry and contract', () => {
  it('[DI-34][DI-10] the generic block versions are registered: G-01..G-20 (G-09@1 and G-10@1 sandbox only, G-09@2 and G-10@2 from site services, G-06 since slice 3a), G-22..G-24', () => {
    const reg = genericBlockRegistry();
    expect(reg.all().map((b) => `${b.type}@${b.version}`)).toEqual([
      'G-01@1', 'G-02@1', 'G-03@1', 'G-04@1', 'G-05@1', 'G-06@1', 'G-07@1', 'G-08@1', 'G-09@1', 'G-09@2', 'G-10@1', 'G-10@2', 'G-11@1', 'G-12@1', 'G-13@1', 'G-14@1', 'G-15@1', 'G-16@1', 'G-17@1', 'G-18@1', 'G-19@1', 'G-20@1', 'G-22@1', 'G-23@1', 'G-24@1',
    ]);
    // The validator's catalogue types without a registered execution version (Phase 3 and 4).
    expect(reg.unregistered(genericBlockCatalog)).toEqual(['G-21@1', 'G-25@1']);
    // Only the manual-attestation stand-ins are limited to the sandbox (decision D3).
    expect(reg.sandboxOnly()).toEqual(['G-09@1', 'G-10@1']);
  });

  it('[DI-10] every version has every execution part of the contract; only the rendering parts (UI work) are still missing, and the report says so', () => {
    for (const r of genericBlockRegistry().report()) {
      expect(r.missingExecutionParts, r.key).toEqual([]);
      expect([...r.missing].sort(), r.key).toEqual([...RENDERING_PARTS].sort());
      expect(r.controls.length, r.key).toBeGreaterThan(0);
      expect(r.availability, r.key).toBe((r.type === 'G-09' || r.type === 'G-10') && r.version === '1' ? 'SANDBOX_ONLY' : 'ALL');
    }
  });

  it('[DI-10] a version is registered once; a phase block without a handler, schemas, exception rules or simulator model is refused', () => {
    const g04 = GENERIC_BLOCK_VERSIONS.find((b) => b.type === 'G-04') as BlockVersion;
    expect(() => new BlockRegistry([g04, g04])).toThrow(BlockRegistryError);
    expect(() => new BlockRegistry([omit(g04, 'handler')])).toThrow(/without an execution handler/);
    expect(() => new BlockRegistry([omit(g04, 'simulatorModel')])).toThrow(/simulator model/);
  });

  it('[DI-34][DI-10] an MBR using a block version the registry cannot execute, or a configuration outside its schema, cannot be defined for execution', () => {
    const reg = genericBlockRegistry();
    // G-21 has no execution version yet, even in the sandbox (G-06 has had one since slice 3a).
    try {
      defineBatch(loadFixture('tablet-blister-packaging'), { registry: reg, expressions: expr, installation: 'SANDBOX' });
      expect.unreachable();
    } catch (e) {
      expect([...new Set((e as EngineDefinitionError).problems.map((p) => p.code))]).toEqual(['ENG-DEF-BLOCK']);
      expect((e as EngineDefinitionError).problems.map((p) => p.message).join(' ')).toMatch(/G-21@1/);
      expect((e as EngineDefinitionError).problems.map((p) => p.message).join(' ')).not.toMatch(/G-06@1/);
    }
    try {
      defineBatch(mbrWith(phase('p', { config: { colour: 'blue' } })), { registry: reg, expressions: expr, installation: 'SANDBOX' });
      expect.unreachable();
    } catch (e) {
      expect((e as EngineDefinitionError).problems.map((p) => p.code)).toEqual(['ENG-DEF-CONFIG']);
    }
  });

  it('[PR-19] a configuration warning must be justified before the MBR can be executed (G-07 target without tolerance)', () => {
    const mbr = mbrWith(phase('d', { block: { type: 'G-07', version: '1' }, reads: ['t'], consumes: ['B'], records: ['q'] }), {
      inputs: [{ id: 't', name: 'target', source: 'MASTER_DATA', valueType: 'DECIMAL', unit: 'kg' }],
      bom: [{ id: 'B', material: 'M', role: 'ACTIVE', quantity: { value: '1', unit: 'kg' } }],
      parameters: [{ id: 'q', name: 'q', valueType: 'DECIMAL', unit: 'kg', role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' }],
    });
    expect(() => defineBatch(mbr, { registry: genericBlockRegistry(), expressions: expr })).toThrow(/justification/);
    const def = defineBatch(mbr, { registry: genericBlockRegistry(), expressions: expr, justifications: [{ key: 'G07-TOLERANCE-MISSING@d', text: 'target shown for information', by: 'QA1' }] });
    expect(def.warnings.map((w) => w.key)).toEqual(['G07-TOLERANCE-MISSING@d']);
  });

  it('[DI-30] configuration and entry schemas refuse unknown fields and numbers where decimals are required', () => {
    const g07 = GENERIC_BLOCK_VERSIONS.find((b) => b.type === 'G-07') as BlockVersion;
    expect(validateSchema(g07.configSchema as NonNullable<BlockVersion['configSchema']>, { tolerance: { percent: 0.5 } }).map((p) => p.path)).toEqual(['$.tolerance.percent']);
    expect(validateSchema(g07.configSchema as NonNullable<BlockVersion['configSchema']>, { extra: true }).map((p) => p.path)).toEqual(['$.extra']);
  });
});

describe('golden fixtures of the phase block versions', () => {
  for (const b of PHASE_BLOCKS) {
    const f = b.goldenFixture;
    if (!f) continue;
    const tags = [...new Set(['DI-34', ...(f.controls ?? b.controls.slice(0, 1))])].map((c) => `[${c}]`).join('');
    it(`${tags} ${b.type} ${b.title}: ${f.description}`, () => {
      const out = runFixture(b);
      expect(out.exceptions).toEqual(f.expect.exceptions);
      expect(out.status).toBe(f.expect.status);
      expect(out.performRefusal).toBe(f.expect.performRefusal);
      for (const [item, value] of Object.entries(f.expect.values ?? {})) expect(sameTo(value, out.run.value(item, 'p')), `${item}: ${out.run.value(item, 'p') ?? 'none'}`).toBe(true);
      // The simulator model names every exception type the fixture raised (simulator and engine agree).
      const declared = new Set([...(b.simulatorModel?.exceptionTypes(out.run.def.steps.get('p')?.node as never) ?? []), ...(b.exceptionRules ?? []).map((r) => r.type)]);
      for (const t of out.exceptions) expect(declared.has(t), `${b.type} raised ${t}`).toBe(true);
    });
  }
});
