/**
 * The Injectables edition's catalogue blocks of slice I-2 (aseptic processing and environmental monitoring; injectables
 * plan v2, sections 4.2 to 4.4 and 5): each is data of the `injectables` edition, passes the library checker, records
 * what its clause asks, and judges it. A value outside its limit, or the unexpected answer, raises an exception through
 * the same generic handler as any library block. Every block also runs nominally to completion in seed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { expr } from '../flow/support.ts';
import type { FieldDef } from '../../src/library/model.ts';
import { blockEdition, checkBlockDefinition, checkBlockUse } from '../../src/library/index.ts';
import { INJECTABLE_ASEPTIC_CATALOGUE, SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { judgedRun, nominalRun } from './seed-support.ts';

function byCode(code: string): SeedItem {
  const item = INJECTABLE_ASEPTIC_CATALOGUE.find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables aseptic catalogue item ${code}`);
  return item;
}

function fieldOf(item: SeedItem, id: string): FieldDef {
  const f = item.definition.sections.flatMap((s) => s.fields).find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id} in ${item.definition.code}`);
  return f;
}

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

const I2_CODES = ['INJ-SUPPLIER-STERILE', 'INJ-SIP', 'INJ-ASEPTIC-ASSEMBLY', 'INJ-VHP', 'INJ-GLOVE-TEST', 'INJ-SUS', 'INJ-SUS-INTEGRITY', 'INJ-ASEPTIC-TRANSFER', 'INJ-STERILE-FILTER', 'INJ-PUPSIT', 'INJ-EM'];

describe('the Injectables catalogue (slice I-2, aseptic processing and EM)', () => {
  it('[PR-05][PR-03] the catalogue holds the 11 blocks of I-2 (INJ-03, 07, 08 and its transfer block, 09, 10, 11 and its integrity block, 13 and its PUPSIT block, 32), each of the injectables edition, loaded with the rest of the catalogue, passing the library checker and the formulation checks, and completed by a nominal batch; only the Annex 1 items are tagged for the EU market', () => {
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
      'INJ-ASEPTIC-TRANSFER': ['EU'], 'INJ-GLOVE-TEST': ['EU'], 'INJ-PUPSIT': ['EU'], 'INJ-SUS-INTEGRITY': ['EU'], 'INJ-VHP': ['EU'],
    });
    expect(byCode('INJ-STERILE-FILTER').definition.sections.map((x) => x.id)).toEqual(['filter', 'preUse', 'filtration', 'postUse']);
    expect(byCode('INJ-STERILE-FILTER').definition.sections.flatMap((x) => x.fields).filter((f) => /pupsit/i.test(f.id))).toEqual([]);
    expect(byCode('INJ-SUS').definition.sections.flatMap((x) => x.fields).map((f) => f.id)).toEqual(['assemblyLot']);
    expect(byCode('INJ-ASEPTIC-ASSEMBLY').definition.sections.map((x) => x.id)).toEqual(['connection']);
  });

  it('[ST-40][ST-49] a supplier-sterilised component is accepted by its lot on the formula line, with its sterilisation method (no UV), certificate and dose or cycle reference; an indicator that has not changed is an exception', () => {
    const item = byCode('INJ-SUPPLIER-STERILE');
    expect(fieldOf(item, 'componentLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'componentLine' });
    for (const id of ['certificate', 'doseOrCycle']) expect(fieldOf(item, id).type, id).toBe('TEXT');
    const method = fieldOf(item, 'method');
    expect(method.type === 'CHOICE' ? method.options.filter((o) => /UV|ultraviolet/i.test(o)) : ['not a choice']).toEqual([]);
    expect(judgedRun(item, { component: { indicator: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(item, { component: { packsIntact: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
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
    for (const id of ['port', 'tester']) expect(fieldOf(item, id).type, id).toBe('TEXT');
    const failed = judgedRun(item, { port: { passed: false } });
    expect(failed.exceptions.length).toBeGreaterThan(0);
    expect(new Set(failed.exceptions)).toEqual(new Set(['LIB_UNEXPECTED_ANSWER']));
  });

  it('[ST-79] a single-use assembly is accepted by its lot on the formula line; for the EU market, in its own block, its integrity not checked before use is an exception', () => {
    const item = byCode('INJ-SUS');
    expect(fieldOf(item, 'assemblyLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'assemblyLine' });
    expect(judgedRun(byCode('INJ-SUS-INTEGRITY'), { integrity: { integrity: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-50][IN-48] the sterilising filter is its lot on the formula line and must be the registered type: another type is not allowed', () => {
    const item = byCode('INJ-STERILE-FILTER');
    expect(fieldOf(item, 'filterLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'filterLine' });
    expect(judgedRun(item, { filter: { filterType: 'Different from the registered filter' } }).exceptions).toEqual(['LIB_NOT_ALLOWED_CHOICE']);
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

  it('[ST-18][ST-22][IN-42] EM records each viable location of the formulation\'s plan (air, settle plate, contact plate, glove print) with its sample, time and count after incubation, and limits the settle plate exposure', () => {
    const item = byCode('INJ-EM');
    expect(item.definition.sections.find((s) => s.id === 'viable')?.repeat).toEqual({ kind: 'COUNT', countSlot: 'viableLocations' });
    const method = fieldOf(item, 'method');
    expect(method.type === 'CHOICE' ? method.options : []).toEqual(['Active air sample', 'Settle plate', 'Contact plate', 'Glove print']);
    expect(fieldOf(item, 'sample')).toMatchObject({ type: 'SAMPLE', unitsSlot: 'platesPerLocation' });
    expect(fieldOf(item, 'sampledAt').type).toBe('DATE_TIME');
    // The exposure limit is the formulation's value, not a critical one (lead): judged all the same.
    expect((fieldOf(item, 'exposure') as { critical?: boolean }).critical).toBeUndefined();
    const settle = { method: 'Settle plate', cfuAir: undefined, cfuSettle: '0', exposure: '240' };
    expect(judgedRun(item, { viable: settle })).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(new Set(judgedRun(item, { viable: { ...settle, exposure: '300' } }).exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
  });

  it('[ST-20][ST-21][IN-42] a count above the action limit is an exception that stops the step until a deviation is opened (the gate then waits); a count above the alert level only is recorded as an alert', () => {
    const item = byCode('INJ-EM');
    const action = judgedRun(item, { viable: { cfuAir: '12' } });
    expect(new Set(action.exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(action.status).not.toBe('COMPLETED');
    const glove = judgedRun(item, { viable: { method: 'Glove print', cfuAir: undefined, cfuGlove: '6' } });
    expect(new Set(glove.exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(glove.status).not.toBe('COMPLETED');
    const alert = judgedRun(item, { viable: { cfuAir: '7' } });
    expect(new Set(alert.exceptions)).toEqual(new Set(['LIB_LIMIT_BREACH']));
    expect(alert.status).toBe('COMPLETED');
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
