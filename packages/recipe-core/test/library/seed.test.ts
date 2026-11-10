/**
 * The ready-made catalogue (decision 0026, S7 and S8): every item is a well-made library block, its example product
 * values pass the formulation checks, and a nominal batch runs it to completion with no exception, through the same
 * engine and generic handler as any library block. Codes are unique across the catalogue.
 */
import { describe, expect, it } from 'vitest';
import type { LimitSpec } from '../../src/limits/model.ts';
import { checkBlockDefinition, checkBlockUse } from '../../src/library/index.ts';
import { SEED_CATALOGUE, SEED_GROUPS } from '../../src/library/seed/index.ts';
import { API_CENTRIFUGE, API_CHARGE, API_CRYST, API_DISP, API_DRY, API_FILTER, API_IPC_COMPLETE, API_LABEL_CHECK, API_PACK, API_REACT, API_YIELD, SUBSTANCE_SEEDS } from '../../src/library/seed/substance.ts';
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

  /** The material lots that name no formula line: an injectable's primary components (block code and field id). */
  // The injectable components named where they are used (lead, 6 November 2026; I-2 filter, single-use assembly and
  // supplier-sterilised component, 10 November 2026; I-4 plunger, FFS film and BFS polymer).
  const COMPONENT_LOTS = ['INJ-WASH containerLot', 'INJ-PARTS-AUTOCLAVE stopperLot', 'INJ-CAPPING sealLot', 'INJ-STERILE-FILTER filterLot', 'INJ-SUS assemblyLot', 'INJ-SUPPLIER-STERILE componentLot', 'INJ-PLUNGER plungerLot', 'INJ-FFS filmLot', 'INJ-BFS polymerLot'];

  it('[PR-18][PR-03] every material lot a catalogue block records names the bill-of-materials line whose material it must be, and the example fills that line, so the lot is checked as the right material and not only as released (R3-CAT-2); the only exceptions, the primary component lots of an injectable, are verified by a second person', () => {
    for (const item of SEED_CATALOGUE) {
      for (const f of item.definition.sections.flatMap((s) => s.fields)) {
        if (f.type !== 'MATERIAL_LOT') continue;
        const where = `${item.definition.code} ${f.id}`;
        // An injectable's primary component (vial or ampoule, stopper, seal, plunger, FFS film, BFS polymer) is no formula line (lead, 6 November 2026):
        // its lot is checked as released at use, and a second person verifies it is the right component.
        if (COMPONENT_LOTS.includes(where)) {
          expect(f.bomLineSlot, where).toBeUndefined();
          expect(item.definition.signatures.some((sg) => sg.meaning === 'VERIFIED'), where).toBe(true);
          continue;
        }
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

  it('[PR-03][PR-18][IN-37][PR-29][PR-14] liquid fill preparation records the fill type, the critical mixing temperature and time, the deaeration vacuum, the viscosity against limits, not critical (its hold is the master\'s PROC-HOLD step); liquid and plate filling record the shell lot as its bill-of-materials line and the fill weight of each round as a critical value with limits, liquid filling the fill-line connection and the fill temperature; each signed by an operator and a verifier (Capsules edition plan, C5)', () => {
    const prep = byCode('PROC-FILL-PREP');
    expect(fieldOf(prep, 'fillType')).toMatchObject({ type: 'CHOICE', options: ['Oil solution', 'Suspension', 'Emulsion', 'SMEDDS', 'Paste', 'Thermosoftening'] });
    expect(fieldOf(prep, 'mixTemp')).toMatchObject({ type: 'NUMBER', unit: 'Cel', limitSlot: 'mixTemp', critical: true });
    expect(fieldOf(prep, 'mixing')).toMatchObject({ type: 'TIMER', limitSlot: 'mixTime', critical: true });
    expect(fieldOf(prep, 'vacuum')).toMatchObject({ type: 'NUMBER', limitSlot: 'vacuum' });
    expect(fieldOf(prep, 'viscosity')).toMatchObject({ type: 'NUMBER', limitSlot: 'viscosity' });
    expect(fieldOf(prep, 'viscosity')).not.toHaveProperty('critical');
    expect(fieldOf(prep, 'container')).toMatchObject({ type: 'CONTAINER', action: 'REGISTER' });
    const liquid = byCode('PROC-CAPS-FILL-LIQUID');
    expect(fieldOf(liquid, 'fillIn')).toMatchObject({ type: 'CONTAINER', action: 'CONSUME' });
    expect(fieldOf(liquid, 'linesConnected')).toMatchObject({ type: 'YES_NO', expected: true });
    expect(fieldOf(liquid, 'fillTemp')).toMatchObject({ type: 'NUMBER', limitSlot: 'fillTemp' });
    expect(fieldOf(liquid, 'fillTemp')).not.toHaveProperty('critical');
    expect(fieldOf(liquid, 'noLeakers')).toMatchObject({ type: 'YES_NO', expected: true });
    const plate = byCode('PROC-CAPS-FILL-PLATE');
    expect(fieldOf(plate, 'blendIn')).toMatchObject({ type: 'CONTAINER', action: 'CONSUME' });
    expect(fieldOf(plate, 'locked')).toMatchObject({ type: 'YES_NO', expected: true });
    for (const filler of [liquid, plate]) {
      expect(fieldOf(filler, 'capsuleSize')).toMatchObject({ type: 'CHOICE', options: ['000', '00', '0', '1', '2', '3', '4', '5'] });
      expect(fieldOf(filler, 'shellLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'shellLine' });
      expect(filler.exampleUse.bomLines).toEqual({ shellLine: 'L1' });
      expect(fieldOf(filler, 'fillWeight')).toMatchObject({ type: 'NUMBER', unit: 'mg', limitSlot: 'fillWeight', critical: true });
      expect(filler.definition.sections.find((x) => x.id === 'round')?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' });
    }
    for (const item of [prep, liquid, plate]) {
      expect(item.definition.signatures.map((x) => [x.meaning, x.role])).toEqual([['PERFORMED', 'PRODUCTION_OPERATOR'], ['VERIFIED', 'PRODUCTION_VERIFIER']]);
    }
    expect(SEED_GROUPS['capsule fill']?.map((s) => s.definition.code)).toEqual(['PROC-FILL-PREP', 'PROC-CAPS-FILL-LIQUID', 'PROC-CAPS-FILL-PLATE']);
  });

  it('[IN-37][PR-41][IN-38][PR-03] post-fill capsule steps (Capsules C3): the checkweigher\'s reject limits are recorded against limits (not critical); inspection removes defective and foreign capsules with an independent check; printing records segregation, the edible ink and a print check each round and holds the print for QC; banding records the sealing technology, a band-solution temperature against limits (not critical; a breach still raises an exception) and a band check each round; a leaker fails the seal check', () => {
    const cw = byCode('PROC-CAPS-CHECKWEIGH');
    expect([fieldOf(cw, 'rejectLow'), fieldOf(cw, 'rejectHigh')]).toEqual([expect.objectContaining({ limitSlot: 'rejectLow' }), expect.objectContaining({ limitSlot: 'rejectHigh' })]);
    for (const id of ['rejectLow', 'rejectHigh']) expect(fieldOf(cw, id), id).not.toHaveProperty('critical');
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
    expect(fieldOf(band, 'solutionTemp')).toMatchObject({ limitSlot: 'solutionTemp' });
    expect(fieldOf(band, 'solutionTemp')).not.toHaveProperty('critical');
    // Not critical, still judged: a band solution outside its limits raises the out-of-limit exception (21 CFR 211.192).
    expect(judgedRun(band, { setup: { solutionTemp: '90.0' } }).exceptions).toContain('LIB_LIMIT_BREACH');
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
      // A1b registers the group: the catalogue load drafts the API blocks with the rest.
      expect(SEED_GROUPS['substance']?.map((s) => s.definition.code), code).toContain(code);
      expect(checkBlockDefinition(item.definition, expr).filter((p) => p.code !== 'LIB-REPEAT-NO-MAX'), code).toEqual([]);
      expect(checkBlockUse(item.definition, { block: { code, version: item.definition.version }, ...item.exampleUse }, expr), code).toEqual([]);
      expect(nominalRun(item), code).toEqual({ exceptions: [], status: 'COMPLETED' });
      for (const sig of item.definition.signatures) expect(['PRODUCTION_OPERATOR', 'PRODUCTION_VERIFIER'], code).toContain(sig.role);
    }
    expect(fieldOf(API_PACK, 'container')).toMatchObject({ type: 'CONTAINER', action: 'REGISTER' });
    expect(fieldOf(API_PACK, 'netMass')).toMatchObject({ type: 'NUMBER', unit: 'kg' });
  });

  it('[AS-02][PR-03][PR-05] API plan A1b: catalogue v1 holds the eleven blocks of a one-step synthesis as substance blocks in the group `substance`; critical only on the time limits, the in-process results and the yield, each with a limit slot the example fills; no calculation reads an earlier step', () => {
    expect(SUBSTANCE_SEEDS.map((s) => s.definition.code)).toEqual(['API-DISP', 'API-CHARGE', 'API-REACT', 'API-IPC-COMPLETE', 'API-CRYST', 'API-FILTER', 'API-CENTRIFUGE', 'API-DRY', 'API-YIELD', 'API-LABEL-CHECK', 'API-PACK']);
    expect(SEED_GROUPS['substance']).toBe(SUBSTANCE_SEEDS);
    for (const item of SUBSTANCE_SEEDS) {
      const code = item.definition.code;
      expect(item.definition.edition, code).toBe('substance');
      expect((item.definition.inputs ?? []).map((i) => i.kind), code).not.toContain('STEP_VALUE');
      for (const f of item.definition.sections.flatMap((s) => s.fields)) {
        if (!('critical' in f) || f.critical !== true) continue;
        expect(f.limitSlot !== undefined && item.exampleUse.limits?.[f.limitSlot] !== undefined, `${code} ${f.id}`).toBe(true);
      }
    }
    const critical = SUBSTANCE_SEEDS.flatMap((i) => i.definition.sections.flatMap((s) => s.fields).filter((f) => 'critical' in f && f.critical === true).map((f) => `${i.definition.code}.${f.id}`));
    expect(critical.sort()).toEqual(['API-CRYST.ageing', 'API-DRY.drying', 'API-DRY.lod', 'API-IPC-COMPLETE.remaining', 'API-REACT.reactionTime', 'API-YIELD.actualYield']);
  });

  it('[AS-05][AS-04][PR-18] API plan A1b: API dispensing weighs each container against its bill-of-materials line, records the lot as that line\'s material, checks the sub-divided container\'s label (material, control number, quantity, retest date), and a second person of another role verifies it', () => {
    expect(fieldOf(API_DISP, 'lot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'materialLine' });
    expect(fieldOf(API_DISP, 'net')).toMatchObject({ type: 'WEIGHING', bomLine: true, limitSlot: 'net' });
    expect(fieldOf(API_DISP, 'labelled').label).toMatch(/material, control number, quantity, retest date/);
    expect(API_DISP.definition.sections.find((s) => s.id === 'weigh')?.repeat).toEqual({ kind: 'PER_CONTAINER' });
    expect(API_DISP.definition.signatures).toEqual([{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }, { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' }]);
    // Charging checks each lot as its line too, and the reactor's clean status before anything goes in (AS-07).
    expect(fieldOf(API_CHARGE, 'lot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'materialLine' });
    expect(fieldOf(API_CHARGE, 'clean')).toMatchObject({ type: 'YES_NO', expected: true });
  });

  it('[AS-04][AS-09][AS-10] API plan A1b: the reaction records its temperature against limits at each round and its time as a critical time limit; the completion check repeats until the remaining starting material is within its limit; crystallisation ages for a limited time', () => {
    expect(fieldOf(API_REACT, 'reactionTemp')).toMatchObject({ limitSlot: 'reactionTemp' });
    expect(fieldOf(API_REACT, 'reactionTemp')).not.toHaveProperty('critical');
    expect(fieldOf(API_REACT, 'reactionTime')).toMatchObject({ type: 'TIMER', critical: true, limitSlot: 'reactionTime' });
    expect(API_REACT.definition.sections.find((s) => s.id === 'round')?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' });
    expect(fieldOf(API_CRYST, 'ageing')).toMatchObject({ type: 'TIMER', critical: true, limitSlot: 'ageing' });
    expect(API_IPC_COMPLETE.definition.sections[0]?.repeat).toEqual({ kind: 'UNTIL_PASS', untilField: 'remaining', maxRepeatsSlot: 'maxChecks' });
    expect(fieldOf(API_IPC_COMPLETE, 'remaining')).toMatchObject({ critical: true, limitSlot: 'remaining' });
  });

  it('[AS-06][AS-04] API plan A1b: the yield step works out the actual yield against the expected yield (the batch size), critical with limits; a low yield raises an exception (to be explained and investigated) and blocks completion', () => {
    expect(fieldOf(API_YIELD, 'actualYield')).toMatchObject({ type: 'CALC', expression: 'output / batchSize * 100 [%]', critical: true, limitSlot: 'actualYield' });
    expect((API_YIELD.definition.inputs ?? []).map((i) => i.kind)).toEqual(['BATCH_SIZE']);
    expect(API_YIELD.definition.roles).toContain('YIELD_RECONCILIATION');
    expect(judgedRun(API_YIELD, { yield: { output: '0.800' } })).toEqual({ exceptions: ['LIB_LIMIT_BREACH'], status: 'IN_PROGRESS' });
    // Drying repeats until the LOD passes.
    expect(API_DRY.definition.sections.find((s) => s.id === 'lodLoop')?.repeat).toMatchObject({ kind: 'UNTIL_PASS', untilField: 'lod' });
  });

  it('[AS-14][AS-15][AS-18] API plan A1b: before packing the label line is cleared of earlier labels and one label is checked against the master (name, batch, quantity, retest or expiry date, storage, and the manufacturer and transport conditions for containers leaving the site; the specimen label is the G-21 step\'s); isolation is one block per type, each keeping the mother liquor as a registered container', () => {
    for (const id of ['noOldLabels', 'batchOnLabel', 'name', 'quantity', 'dates', 'storage', 'shipped']) expect(fieldOf(API_LABEL_CHECK, id), id).toMatchObject({ type: 'YES_NO', expected: true });
    expect(fieldOf(API_LABEL_CHECK, 'dates').label).toMatch(/[Rr]etest or expiry date/);
    for (const block of [API_FILTER, API_CENTRIFUGE]) {
      expect(fieldOf(block, 'motherLiquor'), block.definition.code).toMatchObject({ type: 'CONTAINER', action: 'REGISTER' });
      expect(block.definition.sections.flatMap((s) => s.fields).map((f) => f.type), block.definition.code).not.toContain('CHOICE');
    }
    expect(fieldOf(API_FILTER, 'vacuum')).toMatchObject({ limitSlot: 'vacuum' });
    expect(fieldOf(API_CENTRIFUGE, 'spin')).toMatchObject({ limitSlot: 'spin' });
    // The seed is a lot of the formula (SM Part XII 6.5.3; Q7 6.52).
    expect(fieldOf(API_CRYST, 'seedLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'seedLine' });
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
