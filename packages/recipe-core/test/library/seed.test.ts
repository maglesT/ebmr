/**
 * The ready-made catalogue (decision 0026, S7 and S8): every item is a well-made library block, its example product
 * values pass the formulation checks, and a nominal batch runs it to completion with no exception, through the same
 * engine and generic handler as any library block. Codes are unique across the catalogue.
 */
import { describe, expect, it } from 'vitest';
import type { LimitSpec } from '../../src/limits/model.ts';
import { checkBlockDefinition, checkBlockUse } from '../../src/library/index.ts';
import { SEED_CATALOGUE, SEED_GROUPS } from '../../src/library/seed/index.ts';
import { API_PACK, SUBSTANCE_SEEDS } from '../../src/library/seed/substance.ts';
import { expr } from '../flow/support.ts';
import { byCode, fieldOf, judgedRun, nominalRun } from './seed-support.ts';

describe('the ready-made catalogue', () => {
  it('[PR-19][PR-03] potency-adjusted dispensing works on one basis: the assay is the dried-basis figure the LOD term converts, stated in the help, and the example target corrects for water once (R3-CAT-1)', () => {
    const item = byCode('PROC-DISP-POTENCY');
    const assay = (item.definition.inputs ?? []).find((i) => i.id === 'assay');
    expect(assay?.label).toMatch(/dried basis/);
    expect(assay?.label).not.toMatch(/as is/);
    expect(item.definition.instructions).toMatch(/dried basis/);
    expect(fieldOf(item, 'required').help).toMatch(/dried basis/);
    // 10 kg at 100 %, assay 98 % on the dried basis, LOD 2 %: 10 / 0.98 / 0.98 = 10.412 kg.
    expect(item.exampleInputs?.['assay']?.value).toBe('98');
    expect(item.exampleInputs?.['lodLot']?.value).toBe('2');
    expect(item.exampleUse.targets?.['net']).toBe('10.412');
  });

  it('[PR-18][PR-03] every material lot a catalogue block records names the bill-of-materials line whose material it must be, and the example fills that line, so the lot is checked as the right material and not only as released (R3-CAT-2)', () => {
    for (const item of SEED_CATALOGUE) {
      for (const f of item.definition.sections.flatMap((s) => s.fields)) {
        if (f.type !== 'MATERIAL_LOT') continue;
        const where = `${item.definition.code} ${f.id}`;
        expect(f.bomLineSlot, where).toBeDefined();
        expect(item.exampleUse.bomLines?.[f.bomLineSlot ?? ''], where).toBeDefined();
      }
    }
  });

  it('[PR-19][PR-03] geometric dilution weighs the active and each diluent addition as bill-of-materials lines against limits, records the diluent lot as its line\'s material, and limits the premix net (R3-CAT-3)', () => {
    const item = byCode('PROC-GEO-DIL');
    for (const id of ['activeQty', 'diluentQty']) {
      const f = fieldOf(item, id);
      expect(f.type, id).toBe('WEIGHING');
      expect(f.type === 'WEIGHING' && f.bomLine, id).toBe(true);
      expect(f.type === 'WEIGHING' && f.limitSlot !== undefined && item.exampleUse.limits?.[f.limitSlot] !== undefined, id).toBe(true);
    }
    const net = fieldOf(item, 'net');
    expect(net.type === 'WEIGHING' && net.limitSlot !== undefined && item.exampleUse.limits?.[net.limitSlot] !== undefined).toBe(true);
    const diluentLot = item.definition.sections.flatMap((s) => s.fields).find((f) => f.type === 'MATERIAL_LOT' && f.bomLineSlot === 'diluentLine');
    expect(diluentLot).toBeDefined();
    expect(item.exampleUse.bomLines?.['diluentLine']).toBeDefined();
  });

  it('[PR-14][DI-17] no catalogue block has two of its signatures signed by the same role: the checker or verifier is never the performer\'s role (R3-CAT-5)', () => {
    for (const item of SEED_CATALOGUE) {
      const roles = item.definition.signatures.map((x) => x.role);
      expect(new Set(roles).size, `${item.definition.code} ${roles.join(', ')}`).toBe(roles.length);
    }
  });

  it('[PR-08][PR-03] content uniformity holds its first-stage acceptance value to 10 units: a critical check that exactly 10 units were tested, a wider limit on it is flagged for a written reason, and a batch testing 30 units raises a registered-limit exception that blocks the step; the help states the first-stage scope (R3-CAT-6)', () => {
    const item = byCode('REL-CONTENT-UNIFORMITY');
    expect(fieldOf(item, 'tenUnits')).toMatchObject({ type: 'CALC', expression: 'count(content) == 10 ? 1 : 0', critical: true, limitSlot: 'tenUnits' });
    expect(item.definition.referenceLimits?.['tenUnits']).toMatchObject({ low: '1', high: '1' });
    expect(fieldOf(item, 'acceptanceValue').help).toMatch(/[Ff]irst stage.*exactly 10 units/);
    expect(item.definition.instructions).toMatch(/First stage only/);
    // A product widening the check to let another count pass is flagged at design until a reason is recorded (O-5).
    const own = item.exampleUse.limits?.['tenUnits'] as LimitSpec;
    const wider: LimitSpec = { ...own, ranges: own.ranges.map((r) => ({ ...r, low: { value: '0', inclusive: true } })) };
    const use = { block: { code: item.definition.code, version: 1 }, ...item.exampleUse, counts: { units: '30' }, limits: { ...item.exampleUse.limits, tenUnits: wider } };
    expect(checkBlockUse(item.definition, use, expr).map((p) => [p.code, p.path])).toEqual([['LIB-USE-LOOSER-THAN-REFERENCE', 'limits.tenUnits']]);
    // A batch testing 30 units raises an exception on the check and cannot complete with it open (no wrong AV passes).
    expect(() => nominalRun({ ...item, exampleUse: { ...item.exampleUse, counts: { units: '30' } } })).toThrow(/First stage: 10 units tested.*outside its registered limit/);
  });

  it('[PR-03][PR-18][IN-37] automatic capsule filling records the filling principle (dosator, tamping disc, vacuum or auger), the capsule size, the empty-shell lot as its bill-of-materials line, and the fill weight of each round as a critical value with limits (Capsules edition plan, C1)', () => {
    const fill = byCode('PROC-CAPS-FILL');
    expect(fieldOf(fill, 'fillingPrinciple')).toMatchObject({ type: 'CHOICE', options: ['Dosator', 'Tamping / dosing disc', 'Vacuum', 'Auger'] });
    expect(fieldOf(fill, 'capsuleSize')).toMatchObject({ type: 'CHOICE', options: ['000', '00', '0', '1', '2', '3', '4', '5'] });
    expect(fieldOf(fill, 'shellLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'shellLine' });
    expect(fieldOf(fill, 'fillWeight')).toMatchObject({ type: 'NUMBER', unit: 'mg', limitSlot: 'fillWeight', critical: true });
    expect(fill.definition.sections.find((x) => x.id === 'round')?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' });
    expect(fill.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
  });

  it('[IN-37][PR-41][IN-38][PR-03] post-fill capsule steps (Capsules C3): the checkweigher\'s reject limits are critical values; inspection removes defective and foreign capsules with an independent check; printing records segregation, the edible ink and a print check each round and holds the print for QC; banding records the sealing technology, a critical band-solution temperature and a band check each round; a leaker fails the seal check', () => {
    const cw = byCode('PROC-CAPS-CHECKWEIGH');
    expect([fieldOf(cw, 'rejectLow'), fieldOf(cw, 'rejectHigh')]).toEqual([expect.objectContaining({ limitSlot: 'rejectLow', critical: true }), expect.objectContaining({ limitSlot: 'rejectHigh', critical: true })]);
    const inspect = byCode('PROC-CAPS-INSPECT');
    expect(fieldOf(inspect, 'defectsRemoved')).toMatchObject({ type: 'YES_NO', expected: true });
    expect(inspect.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    const print = byCode('PROC-CAPS-PRINT');
    expect(fieldOf(print, 'segregated')).toMatchObject({ type: 'YES_NO', expected: true });
    expect(fieldOf(print, 'inkApproved')).toMatchObject({ type: 'YES_NO', expected: true });
    expect(print.definition.sections.find((x) => x.id === 'round')?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'checkInterval' });
    expect(fieldOf(print, 'heldForQc')).toMatchObject({ type: 'YES_NO', expected: true });
    const band = byCode('PROC-CAPS-BAND');
    expect(fieldOf(band, 'technology')).toMatchObject({ type: 'CHOICE', options: ['Gelatin band', 'HPMC band', 'Liquid fusion sealing'] });
    expect(fieldOf(band, 'solutionTemp')).toMatchObject({ limitSlot: 'solutionTemp', critical: true });
    expect(band.definition.sections.find((x) => x.id === 'round')?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' });
    const leak = byCode('IPC-CAPS-SEAL-LEAK');
    expect(fieldOf(leak, 'leakers')).toMatchObject({ type: 'NUMBER', limitSlot: 'leakers', critical: true });
    expect(nominalRun(leak)).toEqual({ exceptions: [], status: 'COMPLETED' });
    // One leaker is outside the registered limit of none: the step raises an exception and cannot complete with it open.
    expect(judgedRun(leak, { test: { leakers: '1' } })).toEqual({ exceptions: ['LIB_LIMIT_BREACH'], status: 'IN_PROGRESS' });
  });

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

  it('[PR-03][DI-34][PR-37] API plan A1a: the API pack block (drums or bags) is a substance block, well made, its example values pass, a nominal batch completes it, its signatures are engine roles, and each drum or bag is a registered container with its net mass', () => {
    for (const item of SUBSTANCE_SEEDS) {
      const code = item.definition.code;
      expect(item.definition.edition, code).toBe('substance');
      expect(SEED_CATALOGUE.map((s) => s.definition.code), code).not.toContain(code);
      expect(checkBlockDefinition(item.definition, expr).filter((p) => p.code !== 'LIB-REPEAT-NO-MAX'), code).toEqual([]);
      expect(checkBlockUse(item.definition, { block: { code, version: item.definition.version }, ...item.exampleUse }, expr), code).toEqual([]);
      expect(nominalRun(item), code).toEqual({ exceptions: [], status: 'COMPLETED' });
      for (const sig of item.definition.signatures) expect(['PRODUCTION_OPERATOR', 'PRODUCTION_VERIFIER'], code).toContain(sig.role);
    }
    expect(fieldOf(API_PACK, 'container')).toMatchObject({ type: 'CONTAINER', action: 'REGISTER' });
    expect(fieldOf(API_PACK, 'netMass')).toMatchObject({ type: 'NUMBER', unit: 'kg' });
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
