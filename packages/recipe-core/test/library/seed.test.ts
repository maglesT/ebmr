/**
 * The ready-made catalogue (decision 0026, S7 and S8): every item is a well-made library block, its example product
 * values pass the formulation checks, and a nominal batch runs it to completion with no exception, through the same
 * engine and generic handler as any library block. Codes are unique across the catalogue.
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent } from '../../src/flow/model.ts';
import type { LimitSpec } from '../../src/limits/model.ts';
import type { FieldDef } from '../../src/library/model.ts';
import { checkBlockDefinition, checkBlockUse, libraryBlockType, libraryBlockVersion, nominalEntries, TIMER_STOP } from '../../src/library/index.ts';
import { SEED_CATALOGUE, SEED_GROUPS, type SeedItem } from '../../src/library/seed/index.ts';
import { API_CHARGE, API_CRYST, API_DISP, API_DRY, API_FILTER, API_IPC_COMPLETE, API_LABEL_CHECK, API_PACK, API_REACT, API_YIELD, SUBSTANCE_SEEDS } from '../../src/library/seed/substance.ts';
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
  const entries = nominalEntries(def, config as never, mbr);
  // A nominal run keeps its in-process checks on time while a timer runs (R3-ENG-4: the gap from the last round to the
  // step's end is held too): the hour before a timer stops is spent in 10-minute stretches, each closed by a round of
  // every per-interval section (the catalogue's intervals are 15 minutes or more).
  const rounds = entries.filter((e) => def.sections.some((s) => s.id === e.kind && s.repeat?.kind === 'PER_INTERVAL'));
  for (const e of entries) {
    if (e.kind === TIMER_STOP) {
      for (let i = 0; i < 6; i++) {
        run.minutes(10 - rounds.length);
        for (const r of rounds) {
          run.entry('p', r);
          run.minutes(1);
        }
      }
    }
    run.entry('p', e);
    run.minutes(1);
  }
  run.perform('p');
  if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p');
  return { exceptions: run.exceptions().map((x) => x.type), status: run.status('p') };
}

function byCode(code: string): SeedItem {
  const item = SEED_CATALOGUE.find((s) => s.definition.code === code);
  if (!item) throw new Error(`no catalogue item ${code}`);
  return item;
}

function fieldOf(item: SeedItem, id: string): FieldDef {
  const f = item.definition.sections.flatMap((s) => s.fields).find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id} in ${item.definition.code}`);
  return f;
}

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

  it('[PR-03][DI-34][PR-37] API plan A1a: the API pack block (drums or bags, labels) is a substance block, well made, its example values pass, a nominal batch completes it, its signatures are engine roles, and it holds the sections and fields the edition\'s release items read', () => {
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
    // editions/substance/sql 5000 (substance.grel_edition_items) reads these ids.
    const fields = Object.fromEntries(API_PACK.definition.sections.map((s) => [s.id, s.fields.map((f) => f.id)]));
    expect(fields['container']).toEqual(expect.arrayContaining(['netMass', 'labelOk', 'sealed']));
    expect(fields['recon']).toContain('labelRecon');
    expect(fields['exam']).toContain('allCorrect');
    expect(fieldOf(API_PACK, 'netMass')).toMatchObject({ type: 'NUMBER', unit: 'kg' });
  });

  it('[AS-02][PR-03][PR-05] API plan A1b: catalogue v1 holds the ten blocks of a one-step synthesis as substance blocks in the group `substance`; every critical value has a limit slot the example fills, and no calculation reads an earlier step', () => {
    expect(SUBSTANCE_SEEDS.map((s) => s.definition.code)).toEqual(['API-DISP', 'API-CHARGE', 'API-REACT', 'API-IPC-COMPLETE', 'API-CRYST', 'API-FILTER', 'API-DRY', 'API-YIELD', 'API-LABEL-CHECK', 'API-PACK']);
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

  it('[AS-04][AS-09][AS-10] API plan A1b: the reaction records its temperature and time as critical parameters with limits, at each round; the completion check repeats until the remaining starting material is within its limit; crystallisation ages for a limited time', () => {
    expect(fieldOf(API_REACT, 'reactionTemp')).toMatchObject({ critical: true, limitSlot: 'reactionTemp' });
    expect(fieldOf(API_REACT, 'reactionTime')).toMatchObject({ type: 'TIMER', critical: true, limitSlot: 'reactionTime' });
    expect(API_REACT.definition.sections.find((s) => s.id === 'round')?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' });
    expect(fieldOf(API_CRYST, 'ageing')).toMatchObject({ type: 'TIMER', critical: true, limitSlot: 'ageing' });
    expect(API_IPC_COMPLETE.definition.sections[0]?.repeat).toEqual({ kind: 'UNTIL_PASS', untilField: 'remaining', maxRepeatsSlot: 'maxChecks' });
    expect(fieldOf(API_IPC_COMPLETE, 'remaining')).toMatchObject({ critical: true, limitSlot: 'remaining' });
  });

  it('[AS-06][AS-04] API plan A1b: the yield step works out the actual yield against the batch size and the molar yield against the key starting material\'s formula line, both critical with limits; a low yield raises an exception (to be explained and investigated) and blocks completion', () => {
    expect(fieldOf(API_YIELD, 'actualYield')).toMatchObject({ type: 'CALC', expression: 'output / batchSize * 100 [%]', critical: true });
    expect(fieldOf(API_YIELD, 'molarYield')).toMatchObject({ type: 'CALC', critical: true, limitSlot: 'molarYield' });
    expect((API_YIELD.definition.inputs ?? []).map((i) => i.kind)).toEqual(['BATCH_SIZE', 'FORMULA_LINE']);
    expect(API_YIELD.definition.roles).toContain('YIELD_RECONCILIATION');
    expect(() => nominalRun({ ...API_YIELD, exampleUse: { ...API_YIELD.exampleUse, targets: { ...API_YIELD.exampleUse.targets, output: '40.000' } } })).toThrow(/outside its registered limit/);
    // Drying's loss is worked out from the step's own weights, and drying repeats until the LOD passes.
    expect(fieldOf(API_DRY, 'massLost')).toMatchObject({ type: 'CALC', expression: '(wetMass - dryMass) / wetMass * 100 [%]' });
    expect(API_DRY.definition.sections.find((s) => s.id === 'lodLoop')?.repeat).toMatchObject({ kind: 'UNTIL_PASS', untilField: 'lod' });
  });

  it('[AS-14][AS-15][AS-18] API plan A1b: before packing the label line is cleared of earlier labels and one label is checked against the master (name, batch, quantity, retest or expiry date, storage, and the manufacturer and transport conditions for containers leaving the site), with a specimen kept in the record; the filter step offers a Nutsche filter or a centrifuge', () => {
    for (const id of ['noOldLabels', 'name', 'quantity', 'dates', 'storage', 'shipped', 'specimen']) expect(fieldOf(API_LABEL_CHECK, id), id).toMatchObject({ type: 'YES_NO', expected: true });
    expect(fieldOf(API_LABEL_CHECK, 'dates').label).toMatch(/[Rr]etest or expiry date/);
    expect(fieldOf(API_FILTER, 'filterType')).toMatchObject({ type: 'CHOICE', options: ['Nutsche filter', 'Centrifuge'] });
    expect(fieldOf(API_FILTER, 'spin').showWhen).toEqual({ field: 'filterType', equals: 'Centrifuge' });
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
