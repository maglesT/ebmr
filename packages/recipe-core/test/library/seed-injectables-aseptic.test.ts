/**
 * The Injectables edition's catalogue blocks of slice I-2 (aseptic processing and environmental monitoring; injectables
 * plan v2, sections 4.2 to 4.4 and 5): each is data of the `injectables` edition, passes the library checker, records
 * what its clause asks, and judges it. A value outside its limit, or the unexpected answer, raises an exception through
 * the same generic handler as any library block. Every block also runs nominally to completion in seed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { expr } from '../flow/support.ts';
import { blockEdition, checkBlockDefinition, checkBlockUse } from '../../src/library/index.ts';
import { INJECTABLE_ASEPTIC_CATALOGUE, SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { byCode, configOf, fieldOf, judgedRun, nominalRun, recordNominal, type CatalogueStep } from './seed-support.ts';
import { libraryBlockType, libraryBlockVersion } from '../../src/library/index.ts';
import { define, OP1, Run, sig, T0, testRegistry } from '../engine/support.ts';
import { mbrWith, phase } from '../flow/support.ts';
import type { BlockUse } from '../../src/library/model.ts';

/** The item with some example limits changed, to see the block judge a value against them. */
function withLimits(item: SeedItem, limits: NonNullable<SeedItem['exampleUse']['limits']>): SeedItem {
  return { ...item, exampleUse: { ...item.exampleUse, limits: { ...item.exampleUse.limits, ...limits } } };
}

/** Signatures of a block whose values are typed from a printout or report: performed, then checked by another role. */
function checkedBySecondPerson(item: SeedItem): void {
  const [performed, checked] = item.definition.signatures;
  expect([performed?.meaning, checked?.meaning], item.definition.code).toEqual(['PERFORMED', 'CHECKED']);
  expect(checked?.role, item.definition.code).not.toBe(performed?.role);
}

const I2_CODES = ['INJ-APS-READ', 'INJ-EM-COUNTS', 'INJ-SUPPLIER-STERILE', 'INJ-STERILE-PACK-INDICATOR', 'INJ-SIP', 'INJ-ASEPTIC-ASSEMBLY', 'INJ-VHP', 'INJ-GLOVE-TEST', 'INJ-SUS', 'INJ-SUS-INTEGRITY', 'INJ-ASEPTIC-TRANSFER', 'INJ-STERILE-FILTER', 'INJ-PUPSIT', 'INJ-EM'];

describe('the Injectables catalogue (slice I-2, aseptic processing and EM)', () => {
  it('[PR-05][PR-03] the catalogue holds the 14 blocks of I-2 (INJ-03 and its indicator block, 07, 08 and its transfer block, 09, 10, 11 and its integrity block, 13 and its PUPSIT block, 26 for the media fill, 32 and its counts after incubation), each of the injectables edition, loaded with the rest of the catalogue, passing the library checker and the formulation checks, and completed by a nominal batch; only the Annex 1 items are tagged for the EU market', () => {
    expect(INJECTABLE_ASEPTIC_CATALOGUE.map((s) => s.definition.code).sort()).toEqual([...I2_CODES].sort());
    for (const s of INJECTABLE_ASEPTIC_CATALOGUE) {
      const code = s.definition.code;
      expect(blockEdition(s.definition), code).toBe('injectables');
      expect(SEED_CATALOGUE, code).toContain(s);
      expect(checkBlockDefinition(s.definition, expr), code).toEqual([]);
      expect(checkBlockUse(s.definition, { block: { code, version: s.definition.version }, ...s.exampleUse }, expr), code).toEqual([]);
      expect(nominalRun(s), code).toEqual({ exceptions: [], status: 'COMPLETED' });
      // A field's condition is read from its own section's entry, so every condition names a field of the same section
      // (otherwise the field would never be asked).
      for (const sec of s.definition.sections) {
        for (const f of sec.fields) if (f.showWhen) expect(sec.fields.map((x) => x.id), `${code} ${f.id}`).toContain(f.showWhen.field);
      }
      // Time limits are the master's time constraints: no block types a date and time into a calculation.
      expect(s.definition.sections.flatMap((x) => x.fields).filter((f) => f.type === 'CALC'), code).toEqual([]);
    }
    // Owner Q0 (lead, 6 November 2026): an item only Annex 1 asks for is its own block tagged for the EU market; the base
    // blocks carry no tag (every market) and no PUPSIT field.
    const tagged = INJECTABLE_ASEPTIC_CATALOGUE.filter((s) => s.definition.markets !== undefined);
    expect(Object.fromEntries(tagged.map((s) => [s.definition.code, s.definition.markets]))).toEqual({
      'INJ-ASEPTIC-TRANSFER': ['EU'], 'INJ-GLOVE-TEST': ['EU'], 'INJ-PUPSIT': ['EU'], 'INJ-STERILE-PACK-INDICATOR': ['EU'], 'INJ-SUS-INTEGRITY': ['EU'], 'INJ-VHP': ['EU'],
    });
    expect(byCode('INJ-STERILE-FILTER').definition.sections.map((x) => x.id)).toEqual(['filter', 'preUse', 'filtration', 'postUse']);
    expect(byCode('INJ-STERILE-FILTER').definition.sections.flatMap((x) => x.fields).filter((f) => /pupsit/i.test(f.id))).toEqual([]);
    expect(byCode('INJ-SUS').definition.sections.flatMap((x) => x.fields).map((f) => f.id)).toEqual(['assemblyLot']);
    expect(byCode('INJ-ASEPTIC-ASSEMBLY').definition.sections.map((x) => x.id)).toEqual(['connection']);
    // Lean review: a block of one answer is signed by the person who did it; no clause asks a second person.
    for (const code of ['INJ-STERILE-PACK-INDICATOR', 'INJ-ASEPTIC-TRANSFER', 'INJ-SUS-INTEGRITY']) expect(byCode(code).definition.signatures.map((x) => x.meaning), code).toEqual(['PERFORMED']);
  });

  it('[ST-40][ST-49] a supplier-sterilised component is accepted by its released lot, named where it is used and verified by a second person, with its sterilisation method (no UV), certificate and dose or cycle reference; a damaged wrap, or for the EU market an indicator that has not changed, is an exception', () => {
    const item = byCode('INJ-SUPPLIER-STERILE');
    expect(fieldOf(item, 'componentLot')).toEqual({ id: 'componentLot', label: 'Component lot', type: 'MATERIAL_LOT' });
    expect(item.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    for (const id of ['certificate', 'doseOrCycle']) expect(fieldOf(item, id).type, id).toBe('TEXT');
    const method = fieldOf(item, 'method');
    expect(method.type === 'CHOICE' ? method.options.filter((o) => /UV|ultraviolet/i.test(o)) : ['not a choice']).toEqual([]);
    expect(judgedRun(byCode('INJ-STERILE-PACK-INDICATOR'), { packs: { indicator: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(item, { component: { packsIntact: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-40] a supplier-sterilised lot cannot be accepted without its sterility certificate: the entry is refused and nothing is recorded', () => {
    const item = byCode('INJ-SUPPLIER-STERILE');
    expect(() => judgedRun(item, { component: { certificate: undefined } })).toThrow(/Sterilisation certificate reference is required \(LIB-ENTRY-REQUIRED/);
    expect(() => judgedRun(item, { component: { certificate: '' } })).toThrow(/ENG-ENTRY-SCHEMA/);
    expect(judgedRun(item, {}).exceptions).toEqual([]);
  });

  it('[ST-48][ST-42] sterilisation in place records the cycle values from the printout as critical values with limits, checked by a second person; a temperature or exposure below the minimum is an exception', () => {
    const item = byCode('INJ-SIP');
    for (const id of ['temperature', 'holdTime']) expect(fieldOf(item, id), id).toMatchObject({ type: 'NUMBER', critical: true });
    checkedBySecondPerson(item);
    expect(judgedRun(item, { cycle: { temperature: '120.5' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { cycle: { holdTime: '15.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { cycle: { cyclePassed: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-42][ST-46] aseptic assembly records each connection of the formulation\'s list as made under Grade A and, for the EU market in its own block, the transfer into Grade A/B by the validated method; either answered no is an exception', () => {
    const item = byCode('INJ-ASEPTIC-ASSEMBLY');
    expect(item.definition.sections.find((s) => s.id === 'connection')?.repeat).toEqual({ kind: 'COUNT', countSlot: 'connections' });
    const one = judgedRun(item, { connection: { underGradeA: false } });
    expect(one.exceptions.every((e) => e === 'LIB_UNEXPECTED_ANSWER') && one.exceptions.length > 0).toBe(true);
    expect(one.status).not.toBe('COMPLETED');
    expect(judgedRun(byCode('INJ-ASEPTIC-TRANSFER'), { transfer: { transferred: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-76] isolator bio-decontamination (EU market) records the cycle values from the printout with their limits, checked by a second person; its validity is a time constraint of the master, not a typed date', () => {
    const item = byCode('INJ-VHP');
    expect(item.definition.markets).toEqual(['EU']);
    // No binding clause names these values, so they are not critical (lead, 6 November 2026); they are judged all the same.
    for (const id of ['peroxide', 'exposureTime']) expect(fieldOf(item, id), id).toMatchObject({ type: 'NUMBER', limitSlot: id });
    for (const id of ['peroxide', 'exposureTime']) expect((fieldOf(item, id) as { critical?: boolean }).critical, id).toBeUndefined();
    checkedBySecondPerson(item);
    expect(item.definition.sections.flatMap((s) => s.fields).filter((f) => f.type === 'DATE_TIME' || f.type === 'CALC')).toEqual([]);
    expect(judgedRun(item, { cycle: { peroxide: '25.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { cycle: { exposureTime: '15.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { cycle: { cyclePassed: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-75] glove and sleeve integrity is recorded per port of the formulation\'s count, with the tester; a port that fails is an exception', () => {
    const item = byCode('INJ-GLOVE-TEST');
    expect(item.definition.sections[0]?.repeat).toEqual({ kind: 'COUNT', countSlot: 'glovePorts' });
    expect(fieldOf(item, 'port').type).toBe('TEXT');
    // The tester is a registered instrument of the formulation's class, as the EM particle counter is.
    expect(fieldOf(item, 'tester')).toMatchObject({ type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'testerClass' });
    const failed = judgedRun(item, { port: { passed: false } });
    expect(failed.exceptions.length).toBeGreaterThan(0);
    expect(new Set(failed.exceptions)).toEqual(new Set(['LIB_UNEXPECTED_ANSWER']));
  });

  it('[ST-79] a single-use assembly is accepted by its released lot, named where it is used and verified by a second person; for the EU market, in its own block, its integrity not checked before use is an exception', () => {
    const item = byCode('INJ-SUS');
    expect(fieldOf(item, 'assemblyLot')).toEqual({ id: 'assemblyLot', label: 'Single-use assembly lot', type: 'MATERIAL_LOT' });
    expect(item.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    expect(judgedRun(byCode('INJ-SUS-INTEGRITY'), { integrity: { integrity: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-50][IN-48] the sterilising filter is its released lot, named where it is used, and a second person verifies it is the filter registered for the product; a lot that is not released is refused; no typed type can stand in for it', () => {
    const item = byCode('INJ-STERILE-FILTER');
    expect(fieldOf(item, 'filterLot')).toEqual({ id: 'filterLot', label: 'Sterilising filter lot', type: 'MATERIAL_LOT' });
    expect(item.definition.sections.find((x) => x.id === 'filter')?.fields.map((f) => f.id)).toEqual(['filterLot']);
    expect(item.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    // 211.84: only a released lot may be used (the engine's lot checks of every MATERIAL_LOT field).
    const quarantined = { filterLot: { id: 'SIM-FILTERLOT', material: 'SIM-MATERIAL', status: 'QUARANTINE', identityTested: true } };
    expect(() => judgedRun(item, { filter: { lots: quarantined } })).toThrow(/G07-LOT-STATUS/);
  });

  it('[ST-52][IN-48] filter integrity is judged before use and after use by the formulation\'s method and, for the EU market, after sterilisation in its own PUPSIT block; a result outside its limit is an exception', () => {
    const item = byCode('INJ-STERILE-FILTER');
    expect(judgedRun(item, { preUse: { preBubblePoint: '3.00' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { postUse: { postBubblePoint: '3.10' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    // By diffusion: the bubble-point fields are not asked, the diffusion fields are judged.
    const diffusion = {
      preUse: { preMethod: 'Diffusion', preBubblePoint: undefined, preDiffusion: '10.0' },
      postUse: { postMethod: 'Diffusion', postBubblePoint: undefined, postDiffusion: '12.0' },
    };
    expect(judgedRun(item, diffusion)).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(judgedRun(item, { ...diffusion, postUse: { ...diffusion.postUse, postDiffusion: '25.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    // PUPSIT (EU market): its own block, judged by the formulation's method in the same way.
    const pupsit = byCode('INJ-PUPSIT');
    expect(fieldOf(pupsit, 'pupsitBubblePoint').showWhen).toEqual({ field: 'pupsitMethod', equals: 'Bubble point' });
    expect(judgedRun(pupsit, { pupsitTest: { pupsitBubblePoint: '3.00' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    const byDiffusion = { pupsitTest: { pupsitMethod: 'Diffusion', pupsitBubblePoint: undefined, pupsitDiffusion: '10.0' } };
    expect(judgedRun(pupsit, byDiffusion)).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(judgedRun(pupsit, { pupsitTest: { ...byDiffusion.pupsitTest, pupsitDiffusion: '25.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-51][IN-48] the filtration pressure is judged against its limit and the filtration time, on a timer, against its validated maximum', () => {
    const item = byCode('INJ-STERILE-FILTER');
    expect(fieldOf(item, 'filtrationTime')).toMatchObject({ type: 'TIMER', limitSlot: 'filtrationTime' });
    // No binding clause names the filtration pressure or time: judged against their limits, not critical (lead).
    for (const id of ['pressure', 'filtrationTime']) expect((fieldOf(item, id) as { critical?: boolean }).critical, id).toBeUndefined();
    expect(judgedRun(item, { filtration: { pressure: '2.50' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    // The nominal run holds the timer about an hour: a 30-minute maximum is breached.
    expect(judgedRun(withLimits(item, { filtrationTime: { unit: 'min', ranges: [{ tier: 'VALIDATED', high: { value: '30', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'PV-REF' } }] } }), {}).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-18][ST-22][IN-42] EM records each viable location of the formulation\'s plan (air, settle plate, contact plate, glove print) with its plates while the operation runs and limits the settle plate exposure; the counts after incubation are a later step of their own, so incubation does not hold the batch', () => {
    const item = byCode('INJ-EM');
    expect(item.definition.sections.find((s) => s.id === 'viable')?.repeat).toEqual({ kind: 'COUNT', countSlot: 'viableLocations' });
    const method = fieldOf(item, 'method');
    expect(method.type === 'CHOICE' ? method.options : []).toEqual(['Active air sample', 'Settle plate', 'Contact plate', 'Glove print']);
    expect(fieldOf(item, 'sample')).toMatchObject({ type: 'SAMPLE', unitsSlot: 'platesPerLocation' });
    // When each location was sampled is the entry's trusted time, not a typed date and time.
    expect(item.definition.sections.flatMap((x) => x.fields).filter((f) => f.type === 'DATE_TIME')).toEqual([]);
    // The exposure limit is the formulation's value, not a critical one (lead): judged all the same.
    expect((fieldOf(item, 'exposure') as { critical?: boolean }).critical).toBeUndefined();
    // The counts after incubation are not asked here (lead, 10 November 2026): INJ-EM-COUNTS takes them per location.
    expect(item.definition.sections.flatMap((x) => x.fields).filter((f) => f.id.startsWith('cfu'))).toEqual([]);
    const counts = byCode('INJ-EM-COUNTS');
    expect(counts.definition.sections.map((x) => [x.id, x.repeat])).toEqual([['count', { kind: 'COUNT', countSlot: 'viableLocations' }]]);
    expect(fieldOf(counts, 'method')).toEqual(fieldOf(item, 'method'));
    const settle = { method: 'Settle plate', exposure: '240' };
    expect(judgedRun(item, { viable: settle })).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(new Set(judgedRun(item, { viable: { ...settle, exposure: '300' } }).exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
  });

  it('[ST-20][ST-21][IN-42] a count above the action limit is an exception that stops the step until a deviation is opened (the gate then waits); a count above the alert level only is recorded as an alert', () => {
    const item = byCode('INJ-EM-COUNTS');
    const action = judgedRun(item, { count: { cfuAir: '12' } });
    expect(new Set(action.exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(action.status).not.toBe('COMPLETED');
    const glove = judgedRun(item, { count: { method: 'Glove print', cfuAir: undefined, cfuGlove: '6' } });
    expect(new Set(glove.exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(glove.status).not.toBe('COMPLETED');
    const alert = judgedRun(item, { count: { cfuAir: '7' } });
    expect(new Set(alert.exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(alert.status).toBe('COMPLETED');
  });

  it('[ST-21] for a Grade A location, whose action limit is no growth, one colony on a settle plate is an exception that stops the step until it is handled', () => {
    // A Grade A use of the block: the formulation sets the grade's action limit (A1 Table 6: no growth) as its maximum 0.
    const gradeA = withLimits(byCode('INJ-EM-COUNTS'), {
      cfuSettle: { unit: '{CFU}', ranges: [{ tier: 'INTERNAL_ACTION', high: { value: '0', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'RULE_TABLE', ref: 'A1-TABLE-6' } }] },
    });
    const one = judgedRun(gradeA, { count: { method: 'Settle plate', cfuAir: undefined, cfuSettle: '1' } });
    expect(new Set(one.exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(one.status).not.toBe('COMPLETED');
    expect(judgedRun(gradeA, { count: { method: 'Settle plate', cfuAir: undefined, cfuSettle: '0' } })).toEqual({ exceptions: [], status: 'COMPLETED' });
  });

  it('[ST-19][ST-20][IN-40] particle counts per size, typed from the counter report and checked by a second person, are bound to the grade\'s keys of the sterile rule table; a count above the limit is an exception', () => {
    const item = byCode('INJ-EM');
    checkedBySecondPerson(item);
    expect(item.exampleUse.marketRules).toEqual({
      particles05: { key: 'sterile.particles.gradeB.inOperation.max0_5um', bound: 'HIGH' },
      particles50: { key: 'sterile.particles.gradeB.inOperation.max5_0um', bound: 'HIGH' },
    });
    for (const id of ['particles05', 'particles50']) expect(fieldOf(item, id), id).toMatchObject({ type: 'NUMBER', unit: '{particles}/m3', critical: true });
    expect(new Set(judgedRun(item, { particles: { particles50: '3000' } }).exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(new Set(judgedRun(item, { particles: { reportAttached: false } }).exceptions)).toEqual(new Set(['LIB_UNEXPECTED_ANSWER']));
  });
});

/**
 * Runs the filling block (INJ-FILL) once with its nominal entries and the events given, each recorded in its optional
 * event section while the step is in progress, as the operator records one when it happens.
 */
function fillWithEvents(events: readonly Readonly<Record<string, unknown>>[]): { exceptions: string[]; status: string | undefined } {
  const item = byCode('INJ-FILL');
  const def = item.definition;
  const config = item.exampleUse as Record<string, unknown>;
  const inputs = Object.entries(item.exampleInputs ?? {});
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [phase('p', { block: { type: libraryBlockType(def.code), version: '1' }, config: config as never, reads: inputs.map(([k]) => k) }), phase('after')] }, {
    inputs: inputs.map(([id, v]) => ({ id, name: id, source: 'MASTER_DATA' as const, valueType: 'DECIMAL' as const, unit: v.unit })),
  });
  // The nominal entries hold one event of each optional section; this run records only the events given.
  const noEvent = { ...def, sections: def.sections.filter((x) => x.id !== 'event') };
  const run = Run.issue(define(mbr, { registry: testRegistry().extend(libraryBlockVersion(def, expr)) }), { inputs: Object.fromEntries(inputs.map(([k, v]) => [k, { value: { kind: 'DECIMAL' as const, value: v.value, unit: v.unit }, source: 'seed example' }])) }, T0);
  run.start('p');
  recordNominal(run, 'p', noEvent, config, mbr);
  for (const e of events) {
    run.entry('p', { kind: 'event', eventKind: 'Intervention', eventWhat: 'Fallen vial removed with sterile forceps', eventMinutes: '2', eventListed: true, ...e });
    run.minutes(1);
  }
  try {
    run.perform('p');
  } catch (e) {
    if (!(e instanceof Error && e.message.includes('ENG-BLOCKED'))) throw e;
    return { exceptions: run.exceptions().map((x) => x.type), status: run.status('p') };
  }
  if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p');
  return { exceptions: run.exceptions().map((x) => x.type), status: run.status('p') };
}

/** The aseptic set-ups of slice I-2 (ST-74): the blocks a formulation adds for its barrier, and the class of its filling room. */
interface AsepticSetUp {
  name: string;
  market: 'IN' | 'EU';
  /** The background room of the filling line (the formulation's room class in INJ-FILL and INJ-EM). */
  roomClass: string;
  lineClass: string;
  steps: readonly CatalogueStep[];
}

/** Every aseptic set-up: sterilising filtration, sterilisation in place, aseptic assembly, single-use systems, filling, EM. */
const ASEPTIC_CORE: readonly CatalogueStep[] = [{ code: 'INJ-SUPPLIER-STERILE' }, { code: 'INJ-SIP' }, { code: 'INJ-SUS' }, { code: 'INJ-STERILE-FILTER' }, { code: 'INJ-ASEPTIC-ASSEMBLY' }, { code: 'INJ-FILL' }, { code: 'INJ-EM' }, { code: 'INJ-EM-COUNTS' }];

const SET_UPS: readonly AsepticSetUp[] = [
  // Open Grade A: a unidirectional airflow zone in a Grade B room; the operators reach in gowned for Grade B.
  { name: 'open Grade A', market: 'IN', roomClass: 'ROOM-GRADE-B', lineClass: 'VIAL-FILLING-LINE', steps: ASEPTIC_CORE },
  // RABS: the Grade A zone behind a barrier with glove ports in a Grade B room. Its glove test is the EU block (A1 4.21).
  { name: 'RABS', market: 'IN', roomClass: 'ROOM-GRADE-B', lineClass: 'VIAL-FILLING-RABS', steps: ASEPTIC_CORE },
  // Isolator for the EU market: a Grade C (or D) background; the isolator is bio-decontaminated (A1 4.22) and its gloves
  // tested (A1 4.21); the EU blocks for the transfer, the pack indicator, single-use integrity and PUPSIT come with it.
  {
    name: 'isolator',
    market: 'EU',
    roomClass: 'ROOM-GRADE-C',
    lineClass: 'VIAL-FILLING-ISOLATOR',
    steps: [...ASEPTIC_CORE, { code: 'INJ-VHP' }, { code: 'INJ-GLOVE-TEST' }, { code: 'INJ-ASEPTIC-TRANSFER' }, { code: 'INJ-STERILE-PACK-INDICATOR' }, { code: 'INJ-SUS-INTEGRITY' }, { code: 'INJ-PUPSIT' }],
  },
];

/** A step's use in a set-up: the item's example values with the set-up's room and line classes where the block names them. */
function setUpUse(setUp: AsepticSetUp, step: CatalogueStep): BlockUse {
  const ex = byCode(step.code).exampleUse;
  const classes = { ...ex.equipmentClasses };
  if ('roomClass' in classes) classes['roomClass'] = setUp.roomClass;
  if ('lineClass' in classes) classes['lineClass'] = setUp.lineClass;
  return { block: { code: step.code, version: 1 }, ...ex, ...(ex.equipmentClasses ? { equipmentClasses: classes } : {}) };
}

describe('aseptic filling events, the media fill and the aseptic set-ups (slice I-2a)', () => {
  it('[ST-35][PR-03] filling records interventions, stoppages, glove changes and alarms in an optional event section as many times as they happen (what, when, units removed); a fill with none, or with several, completes', () => {
    const event = byCode('INJ-FILL').definition.sections.find((x) => x.id === 'event');
    expect(event).toMatchObject({ required: false, repeat: { kind: 'PER_CONTAINER' } });
    expect(event?.when).toMatch(/intervention/);
    // The entry is made when the event is over, so its trusted time is the event's end (lead, ALCOA accurate).
    expect(event?.when).toMatch(/when the event is over/);
    expect(event?.fields.map((f) => f.id)).toEqual(['eventKind', 'eventWhat', 'eventMinutes', 'eventListed']);
    // When it happened is the entry's trusted time, not a typed date and time.
    expect(event?.fields.filter((f) => f.type === 'DATE_TIME')).toEqual([]);
    expect(fieldOf(byCode('INJ-FILL'), 'eventKind')).toMatchObject({ type: 'CHOICE', options: ['Intervention', 'Stoppage', 'Glove change', 'Alarm'] });
    expect(fillWithEvents([])).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(fillWithEvents([{}, { eventKind: 'Stoppage', eventWhat: 'Stopper bowl empty' }, { eventKind: 'Glove change', eventWhat: 'Right glove of port 2 changed' }])).toEqual({ exceptions: [], status: 'COMPLETED' });
    // Nothing judged sits in the event section: it is the record of an event, not a planned check.
    for (const f of event?.fields ?? []) expect('limitSlot' in f ? f.limitSlot : undefined, f.id).toBeUndefined();
  });

  it('[ST-11] a torn glove is recorded as a glove-change event of the filling, with what happened; the fill then completes', () => {
    expect(fieldOf(byCode('INJ-FILL'), 'eventKind')).toMatchObject({ type: 'CHOICE', options: expect.arrayContaining(['Glove change']) as unknown });
    expect(fillWithEvents([{ eventKind: 'Glove change', eventWhat: 'Right glove of port 2 torn and changed', eventMinutes: '3' }])).toEqual({ exceptions: [], status: 'COMPLETED' });
  });

  it('[ST-34][ST-36] an event not on the formulation\'s list of validated interventions is an exception that keeps the filling step from being signed until it is handled (then the gate waits for its deviation)', () => {
    const run = fillWithEvents([{ eventListed: false, eventWhat: 'Unlisted: stopper chute cleared by hand' }]);
    expect(run.exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(run.status).not.toBe('COMPLETED');
  });

  it('[ST-32][IN-45] the media fill reading records the units removed before incubation and why, the units incubated, each incubation period against the site\'s validated conditions, and the contaminated units; the second period is asked only for a two-temperature scheme', () => {
    const item = byCode('INJ-APS-READ');
    expect(item.definition.sections.map((x) => x.id)).toEqual(['incubation', 'reading']);
    for (const id of ['firstTemperature', 'firstDays', 'secondTemperature', 'secondDays', 'contaminated']) expect(fieldOf(item, id), id).toMatchObject({ critical: true });
    expect(fieldOf(item, 'secondTemperature').showWhen).toEqual({ field: 'scheme', equals: 'Two temperatures in sequence' });
    const two = { scheme: 'Two temperatures in sequence', secondTemperature: '32.5', secondDays: '7' };
    expect(judgedRun(item, { incubation: two })).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(new Set(judgedRun(item, { incubation: { ...two, secondTemperature: '37.0' } }).exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(new Set(judgedRun(item, { incubation: { firstDays: '5' } }).exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
  });

  it('[ST-33][IN-45] one contaminated media-fill unit is a critical breach of the acceptance limit: the reading cannot be signed until it is handled, and its deviation holds the record', () => {
    const run = judgedRun(byCode('INJ-APS-READ'), { reading: { contaminated: '1', identification: 'Staphylococcus sp.' } });
    expect(new Set(run.exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(run.status).not.toBe('COMPLETED');
  });

  it('[ST-02] the sterility-assurance route is the formulation\'s choice of blocks: every aseptic set-up filters to sterility and assembles aseptically and has no terminal sterilisation, which is a block of its own', () => {
    for (const setUp of SET_UPS) {
      const codes = setUp.steps.map((x) => x.code);
      expect(codes, setUp.name).toEqual(expect.arrayContaining(['INJ-STERILE-FILTER', 'INJ-ASEPTIC-ASSEMBLY', 'INJ-SIP']));
      expect(codes, setUp.name).not.toContain('INJ-TERMINAL-STERILISE');
    }
    expect(SEED_CATALOGUE.map((s) => s.definition.code)).toContain('INJ-TERMINAL-STERILISE');
  });

  it('[ST-74][IN-41] the open Grade A, RABS and isolator set-ups are formulations of the same blocks: each names its background room and line by class; the isolator adds bio-decontamination and the glove test; EU-market blocks appear only in the EU set-up', () => {
    for (const setUp of SET_UPS) {
      for (const st of setUp.steps) {
        const def = byCode(st.code).definition;
        const use = setUpUse(setUp, st);
        expect(checkBlockUse(def, use, expr), `${setUp.name} ${st.code}`).toEqual([]);
        if (def.markets !== undefined) expect(def.markets, `${setUp.name} ${st.code}`).toContain(setUp.market);
        expect(Object.keys(configOf(use))).not.toContain('block');
      }
      const fill = setUpUse(setUp, { code: 'INJ-FILL' }).equipmentClasses;
      expect([fill?.['roomClass'], fill?.['lineClass']], setUp.name).toEqual([setUp.roomClass, setUp.lineClass]);
    }
    const codes = (name: string) => SET_UPS.find((x) => x.name === name)?.steps.map((x) => x.code) ?? [];
    expect(codes('isolator')).toEqual(expect.arrayContaining(['INJ-VHP', 'INJ-GLOVE-TEST']));
    expect(codes('RABS').filter((c) => byCode(c).definition.markets !== undefined)).toEqual([]);
  });
});

describe('what the approved MODIFY decisions keep, in the I-2 blocks (slice I-6.3)', () => {
  it('[ST-46] for the EU market, an item not transferred into Grade A/B by the validated method (only disinfected, say) is an exception that holds the step until QA dispositions it', () => {
    const transfer = byCode('INJ-ASEPTIC-TRANSFER');
    expect(transfer.definition.markets).toEqual(['EU']);
    expect(fieldOf(transfer, 'transferred')).toMatchObject({ type: 'YES_NO', expected: true });
    const not = judgedRun(transfer, { transfer: { transferred: false } });
    expect(not.exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(not.status).not.toBe('COMPLETED');
  });

  it('[IN-42] a Grade A settle plate of 1 CFU during a fill is above the Grade A action limit (no growth): an exception that stops the step until a deviation is opened', () => {
    const gradeA = withLimits(byCode('INJ-EM-COUNTS'), {
      cfuSettle: { unit: '{CFU}', ranges: [{ tier: 'INTERNAL_ACTION', high: { value: '0', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'RULE_TABLE', ref: 'B-12' } }] },
    });
    const plate = { method: 'Settle plate', cfuAir: undefined };
    expect(judgedRun(gradeA, { count: { ...plate, cfuSettle: '0' } })).toEqual({ exceptions: [], status: 'COMPLETED' });
    const one = judgedRun(gradeA, { count: { ...plate, cfuSettle: '1' } });
    expect(new Set(one.exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(one.status).not.toBe('COMPLETED');
  });

  it('[ST-74][IN-41][ST-55] aseptic filling on a RABS line takes a room of the Grade B class the formulation names: a Grade C room is refused', () => {
    const fill = byCode('INJ-FILL');
    const rabs: SeedItem = { ...fill, exampleUse: { ...fill.exampleUse, equipmentClasses: { lineClass: 'VIAL-FILLING-RABS', roomClass: 'ROOM-GRADE-B' } } };
    const units = (roomClass: string) => ({
      line: { code: 'SIM-LINE', classCode: 'VIAL-FILLING-RABS', fitness: 'QUALIFIED' },
      room: { code: 'SIM-ROOM', classCode: roomClass, fitness: 'QUALIFIED' },
    });
    expect(judgedRun(rabs, { setup: { equipment: units('ROOM-GRADE-B') } }).exceptions).toEqual([]);
    expect(() => judgedRun(rabs, { setup: { equipment: units('ROOM-GRADE-C') } })).toThrow(/LIB-EQUIPMENT-CLASS/);
  });

  it('[ST-53] each sterilising filter is a lot named in the step that uses it, verified by a second person; a lot QC rejected cannot be used', () => {
    const item = byCode('INJ-STERILE-FILTER');
    expect(fieldOf(item, 'filterLot').type).toBe('MATERIAL_LOT');
    expect(item.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    const rejected = { filterLot: { id: 'SIM-FILTERLOT', material: 'SIM-MATERIAL', status: 'REJECTED', identityTested: true } };
    expect(() => judgedRun(item, { filter: { lots: rejected } })).toThrow(/G07-LOT-STATUS/);
  });

  it('[ST-50] the registered sterilising filter is verified by a second person: the filter step waits for the verification, and its own performer cannot give it', () => {
    const item = byCode('INJ-STERILE-FILTER');
    const def = item.definition;
    expect(def.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [phase('p', { block: { type: libraryBlockType(def.code), version: String(def.version) }, config: item.exampleUse as never }), phase('after')] });
    const run = Run.issue(define(mbr, { registry: testRegistry().extend(libraryBlockVersion(def, expr)) }), {}, T0);
    run.start('p');
    recordNominal(run, 'p', def, item.exampleUse, mbr);
    run.perform('p');
    expect(run.status('p')).toBe('AWAITING_VERIFICATION');
    // The performer, even holding the verifier's role, cannot verify the filter of their own step.
    const sameOperator = { ...OP1, roles: [...OP1.roles, 'PRODUCTION_VERIFIER', 'VERIFIER'] };
    run.refused({ type: 'VERIFY', actor: sameOperator, step: 'p', context: [], signature: sig('VERIFIED', sameOperator) }, 'ENG-SEGREGATION');
    expect(run.status('p')).toBe('AWAITING_VERIFICATION');
    run.verify('p');
    expect(run.status('p')).toBe('COMPLETED');
  });

  it('[ST-73] the interventions of a fill are kept as structured entries (what, kind, duration, listed), so an extract per line reads them as recorded', () => {
    const item = byCode('INJ-FILL');
    const def = item.definition;
    const config = item.exampleUse as Record<string, unknown>;
    const inputs = Object.entries(item.exampleInputs ?? {});
    const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [phase('p', { block: { type: libraryBlockType(def.code), version: '1' }, config: config as never, reads: inputs.map(([k]) => k) }), phase('after')] }, {
      inputs: inputs.map(([id, v]) => ({ id, name: id, source: 'MASTER_DATA' as const, valueType: 'DECIMAL' as const, unit: v.unit })),
    });
    const run = Run.issue(define(mbr, { registry: testRegistry().extend(libraryBlockVersion(def, expr)) }), { inputs: Object.fromEntries(inputs.map(([k, v]) => [k, { value: { kind: 'DECIMAL' as const, value: v.value, unit: v.unit }, source: 'seed example' }])) }, T0);
    run.start('p');
    recordNominal(run, 'p', { ...def, sections: def.sections.filter((x) => x.id !== 'event') }, config, mbr);
    const recorded = [
      { eventKind: 'Intervention', eventWhat: 'Fallen vial removed with sterile forceps', eventMinutes: '2', eventListed: true },
      { eventKind: 'Stoppage', eventWhat: 'Stopper bowl empty', eventMinutes: '6', eventListed: true },
    ];
    for (const e of recorded) {
      run.entry('p', { kind: 'event', ...e });
      run.minutes(1);
    }
    const extract = Object.values(run.state.entries).filter((x) => x.kind === 'event').map((x) => ({ eventKind: x.data['eventKind'], eventWhat: x.data['eventWhat'], eventMinutes: x.data['eventMinutes'], eventListed: x.data['eventListed'] }));
    expect(extract).toEqual(recorded);
    expect(extract.filter((x) => x.eventKind === 'Intervention')).toHaveLength(1);
  });
});
