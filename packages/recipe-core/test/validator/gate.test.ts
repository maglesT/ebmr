import { describe, expect, it } from 'vitest';
import { defineRule, warning } from '../../src/validator/rule-kit.ts';
import { createGenericRegistry, gate, requiredLookups, RuleRegistry, validateMbr, withEditionRules } from '../../src/validator/validate.ts';
import { clone, context, loadFixture, validate } from '../flow/support.ts';

describe('the gate: errors block, warnings need a recorded justification', () => {
  it('[DI-04] a warning blocks until it is justified by a named person; errors always block', () => {
    const registry = withEditionRules([defineRule('TAB-WARN', 'A warning', ['PR-03'], () => [warning('p-blend', 'Check the blender fill level')], { edition: 'tablets' })]);
    const report = validate(loadFixture('tablet-granulation-compression'), {}, registry);
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(1);
    expect(gate(report).passed).toBe(false);
    expect(gate(report, [{ key: 'TAB-WARN@p-blend', text: '   ', by: 'P-100' }]).passed).toBe(false);
    const ok = gate(report, [
      { key: 'TAB-WARN@p-blend', text: 'Fill level verified in PV-ATV-BLEND', by: 'P-100' },
      { key: 'OLD@x', text: 'stale', by: 'P-100' },
    ]);
    expect(ok.passed).toBe(true);
    expect(ok.unusedJustifications).toEqual(['OLD@x']);
  });

  it('[DI-04] the report is deterministic and bound to the content hash', () => {
    const m = loadFixture('tablet-granulation-compression');
    const broken = clone(m);
    broken.intermediates.forEach((i) => delete i.holdTime);
    const a = validate(broken);
    const b = validate(clone(broken));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.contentHash).not.toBe(validate(m).contentHash);
    expect(a.findings.map((f) => f.severity)).toEqual([...a.findings.map((f) => f.severity)].sort());
  });

  it('[DI-04] a rule that crashes is a failed check, never a pass', () => {
    const registry = withEditionRules([
      defineRule(
        'TAB-BROKEN',
        'Broken rule',
        ['PR-03'],
        () => {
          throw new Error('boom');
        },
        { edition: 'tablets' },
      ),
    ]);
    const report = validate(loadFixture('tablet-blister-packaging'), {}, registry);
    expect(report.findings.map((f) => f.message)).toEqual(['Rule TAB-BROKEN could not complete (boom) (TAB-BROKEN; PR-03)']);
  });
});

describe('the rule registry', () => {
  it('edition rule sets plug in; rules of another edition never run', () => {
    const injectablesOnly = defineRule('INJ-DEMO', 'Injectables demo', ['PR-03'], () => [warning('$', 'should not run for tablets')], { edition: 'injectables' });
    const registry = withEditionRules([injectablesOnly]);
    const report = validate(loadFixture('tablet-blister-packaging'), {}, registry);
    expect(report.rules).not.toContain('INJ-DEMO');
    expect(report.findings).toEqual([]);
    expect(registry.rulesFor('injectables').map((r) => r.id)).toContain('INJ-DEMO');
  });

  it('a rule id can be registered only once; an edition rule must name its edition', () => {
    expect(() => new RuleRegistry([defineRule('X', 'x', [], () => []), defineRule('X', 'x', [], () => [])])).toThrow(/registered twice/);
    expect(() => withEditionRules([defineRule('Y', 'y', [], () => [])])).toThrow(/must name its edition/);
  });

  it('the generic registry runs structure, data, time, GMP content and market rules', () => {
    const ids = createGenericRegistry()
      .all()
      .map((r) => r.id);
    for (const prefix of ['FLOW-', 'GRAPH-', 'DATA-', 'TIME-', 'GMP-', 'MKT-']) expect(ids.some((id) => id.startsWith(prefix))).toBe(true);
    for (const r of createGenericRegistry().all()) expect(r.controls.length).toBeGreaterThan(0);
  });

  it('requiredLookups lists what the caller must pre-load for the pure validator', () => {
    const m = loadFixture('tablet-granulation-compression');
    const l = requiredLookups(m);
    expect(l.references).toHaveLength(m.references.length);
    expect(l.blockTypes).toContain('G-06@1');
    expect(l.ruleKeys).toEqual([]);
    expect(validateMbr(m, context()).errors).toBe(0);
  });
});
