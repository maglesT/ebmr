/**
 * The ready-made catalogue (decision 0026, S7 and S8): every item is a well-made library block, its example product
 * values pass the formulation checks, and a nominal batch runs it to completion with no exception, through the same
 * engine and generic handler as any library block. Codes are unique across the catalogue.
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent } from '../../src/flow/model.ts';
import { checkBlockDefinition, checkBlockUse, libraryBlockType, libraryBlockVersion, nominalEntries, TIMER_STOP } from '../../src/library/index.ts';
import { SEED_CATALOGUE, SEED_GROUPS, type SeedItem } from '../../src/library/seed/index.ts';
import { define, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';

function nominalRun(item: SeedItem): { exceptions: string[]; status: string | undefined } {
  const def = item.definition;
  const config = item.exampleUse as Record<string, unknown>;
  const lines = Object.values(item.exampleUse.bomLines ?? {});
  const inputs = Object.entries(item.exampleInputs ?? {});
  // S10: formula-line and batch-size inputs come from the master (BOM at the reference size, the batch's size), so the
  // example values are written there; the other inputs stay MBR inputs the phase reads.
  const ex = item.exampleInputs ?? {};
  const lineInputs = new Map((def.inputs ?? []).flatMap((i) => (i.kind === 'FORMULA_LINE' ? [[item.exampleUse.bomLines?.[i.slot], ex[i.id]] as const] : [])));
  const sizeInput = (def.inputs ?? []).find((i) => i.kind === 'BATCH_SIZE');
  const bom: MbrContent['bom'] = lines.map((id) => ({ id, material: `MAT-${id}`, role: 'ACTIVE', quantity: lineInputs.get(id) ?? { value: '10', unit: 'kg' } }));
  const p = phase('p', { block: { type: libraryBlockType(def.code), version: String(def.version) }, config: config as never, reads: inputs.map(([k]) => k) });
  const base = mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }, {
    bom,
    inputs: inputs.map(([id, v]) => ({ id, name: id, source: 'MASTER_DATA' as const, valueType: 'DECIMAL' as const, unit: v.unit })),
  });
  const size = sizeInput ? ex[sizeInput.id] : undefined;
  const mbr: MbrContent = size ? { ...base, header: { ...base.header, batchSizes: [{ id: 'BS', quantity: size }] } } : base;
  const d = define(mbr, { registry: testRegistry().extend(libraryBlockVersion(def, expr)) });
  const values = Object.fromEntries(inputs.map(([k, v]) => [k, { value: { kind: 'DECIMAL' as const, value: v.value, unit: v.unit }, source: 'seed example' }]));
  const run = Run.issue(d, { inputs: values }, T0);
  run.start('p');
  for (const e of nominalEntries(def, config as never, mbr)) {
    if (e.kind === TIMER_STOP) run.minutes(60);
    run.entry('p', e);
    run.minutes(1);
  }
  run.perform('p');
  if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p');
  return { exceptions: run.exceptions().map((x) => x.type), status: run.status('p') };
}

describe('the ready-made catalogue', () => {
  it('[PR-05] every code is unique across the catalogue, and every item is version 1', () => {
    const codes = SEED_CATALOGUE.map((s) => s.definition.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const s of SEED_CATALOGUE) expect(s.definition.version, s.definition.code).toBe(1);
  });

  it('[PR-03][DI-34] every catalogue item is well made, its example values pass the formulation checks, and a nominal batch completes it (each item also has its own test below)', () => {
    for (const item of SEED_CATALOGUE) {
      expect(checkBlockDefinition(item.definition, expr).filter((p) => p.code !== 'LIB-REPEAT-NO-MAX'), item.definition.code).toEqual([]);
      expect(checkBlockUse(item.definition, { block: { code: item.definition.code, version: item.definition.version }, ...item.exampleUse }, expr), item.definition.code).toEqual([]);
      expect(nominalRun(item), item.definition.code).toEqual({ exceptions: [], status: 'COMPLETED' });
    }
  });

  it('[PR-03][PR-45] every signature a library step carries names a role a session can carry (the engine roles of recipe.engine_role_permission): a master using any process, control, coating, packaging or IPC block saves (S11 finding)', () => {
    // The engine roles the database lists (recipe-core 0200; the refusal of 0324 names them).
    const ENGINE_ROLES = ['DISPENSER', 'HEAD_OF_PRODUCTION', 'PRODUCTION_OPERATOR', 'PRODUCTION_SUPERVISOR', 'PRODUCTION_VERIFIER', 'QA', 'QA_REVIEWER', 'STAGE_RESPONSIBLE'];
    // Release tests are QC's (QC_ANALYST, QC_REVIEWER): no engine role signs them on the floor yet; a known gap
    // (decision 0026), so they are not used in a master until it is closed.
    for (const [group, items] of Object.entries(SEED_GROUPS)) {
      if (group === 'release tests') continue;
      for (const item of items) {
        for (const sig of item.definition.signatures.filter((x) => ['PERFORMED', 'VERIFIED', 'CHECKED'].includes(x.meaning))) {
          expect(ENGINE_ROLES, `${item.definition.code} ${sig.meaning}`).toContain(sig.role);
        }
      }
    }
  });

  for (const [group, items] of Object.entries(SEED_GROUPS)) {
    for (const item of items) {
      const code = item.definition.code;
      it(`${group}: ${code} is well made, its example values pass, and a nominal batch completes it`, () => {
        const problems = checkBlockDefinition(item.definition, expr).filter((p) => p.code !== 'LIB-REPEAT-NO-MAX');
        expect(problems, `${code} definition`).toEqual([]);
        const use = checkBlockUse(item.definition, { block: { code, version: item.definition.version }, ...item.exampleUse }, expr);
        expect(use, `${code} example use`).toEqual([]);
        const out = nominalRun(item);
        expect(out.exceptions, `${code} exceptions`).toEqual([]);
        expect(out.status, `${code} status`).toBe('COMPLETED');
      });
    }
  }
});
