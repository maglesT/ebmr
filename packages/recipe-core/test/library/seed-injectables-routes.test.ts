/**
 * The Injectables edition's catalogue blocks of slice I-4 (other containers and routes; injectables plan v2, section
 * 4.3): each is data of the `injectables` edition, passes the library checker, records what its clause asks, and judges
 * it. A value outside its limit, or the unexpected answer, raises an exception through the same generic handler as any
 * library block. Every block also runs nominally to completion in seed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { expr } from '../flow/support.ts';
import { blockEdition, checkBlockDefinition, checkBlockUse } from '../../src/library/index.ts';
import { INJECTABLE_ROUTE_CATALOGUE, SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { byCode, fieldOf, judgedRun, nominalRun } from './seed-support.ts';

const I4_CODES = ['INJ-HOMOGENISE', 'INJ-POWDER-FILL', 'INJ-PLUNGER', 'INJ-FFS', 'INJ-FFS-EU', 'INJ-BFS', 'INJ-BFS-EU', 'INJ-RADIATION', 'INJ-RADIATION-EU'];

/** Signatures of a block whose values are typed from a device or certificate: performed, then checked by another role. */
function checkedBySecondPerson(item: SeedItem): void {
  const [performed, checked] = item.definition.signatures;
  expect([performed?.meaning, checked?.meaning], item.definition.code).toEqual(['PERFORMED', 'CHECKED']);
  expect(checked?.role, item.definition.code).not.toBe(performed?.role);
}

/** A filling block's output: registered containers and the counts unit accountability reads, by INJ-FILL's field ids. */
function fillsLikeInjFill(item: SeedItem): void {
  const code = item.definition.code;
  expect(fieldOf(item, 'trayOut'), code).toMatchObject({ type: 'CONTAINER', action: 'REGISTER' });
  expect(item.definition.sections.find((s) => s.id === 'tray')?.repeat, code).toEqual({ kind: 'PER_CONTAINER' });
  expect(item.definition.sections.find((s) => s.id === 'end')?.fields.map((f) => f.id).slice(0, 2), code).toEqual(['filled', 'rejects']);
  expect(fieldOf(item, 'room'), code).toMatchObject({ type: 'EQUIPMENT', kind: 'ROOM' });
  // The fill weight is recorded once, by IPC-INJ-FILL-WEIGHT.
  expect(item.definition.sections.flatMap((s) => s.fields).map((f) => f.id), code).not.toContain('fillWeight');
}

describe('the Injectables catalogue (slice I-4, other containers and routes)', () => {
  it('[PR-05][PR-03] the catalogue holds the 9 blocks of I-4 (INJ-16, 28, 29 and its EU block, 30 and its EU block, 31, and the radiation variant of INJ-21 and its EU block), each of the injectables edition, loaded with the rest of the catalogue, passing the library checker and the formulation checks, and completed by a nominal batch; only the Annex 1 blocks are tagged for the EU market', () => {
    expect(INJECTABLE_ROUTE_CATALOGUE.map((s) => s.definition.code)).toEqual(I4_CODES);
    for (const s of INJECTABLE_ROUTE_CATALOGUE) {
      const code = s.definition.code;
      expect(blockEdition(s.definition), code).toBe('injectables');
      expect(SEED_CATALOGUE, code).toContain(s);
      expect(checkBlockDefinition(s.definition, expr), code).toEqual([]);
      expect(checkBlockUse(s.definition, { block: { code, version: s.definition.version }, ...s.exampleUse }, expr), code).toEqual([]);
      expect(nominalRun(s), code).toEqual({ exceptions: [], status: 'COMPLETED' });
      expect(s.definition.sections.flatMap((x) => x.fields).filter((f) => f.type === 'DATE_TIME'), code).toEqual([]);
    }
    const tagged = INJECTABLE_ROUTE_CATALOGUE.filter((s) => s.definition.markets !== undefined);
    expect(Object.fromEntries(tagged.map((s) => [s.definition.code, s.definition.markets]))).toEqual({ 'INJ-BFS-EU': ['EU'], 'INJ-FFS-EU': ['EU'], 'INJ-RADIATION-EU': ['EU'] });
  });

  it('[IN-41][ST-56] homogenisation of a bulk that cannot be filtered records the homogeniser in its room (the grade from the formulation), the speed and time against the validated settings (not critical: no clause names them), and the particle size of each sample against its limits; a value outside is an exception', () => {
    const item = byCode('INJ-HOMOGENISE');
    expect(fieldOf(item, 'room')).toMatchObject({ type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' });
    // No binding clause names the speed or time as critical: judged against the validated settings, not critical.
    expect(fieldOf(item, 'speed')).toMatchObject({ type: 'NUMBER', limitSlot: 'speed' });
    expect('critical' in fieldOf(item, 'speed') || 'critical' in fieldOf(item, 'time')).toBe(false);
    expect(fieldOf(item, 'size')).toMatchObject({ type: 'TEST_RESULT', replicatesSlot: 'sizeReplicates' });
    expect(judgedRun(item, { homogenisation: { speed: '2500' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-56][IN-41] sterile powder filling records the line in its room and the closures at each round, and registers the filled trays with the counts unit accountability reads; the fill weights are recorded once, by IPC-INJ-FILL-WEIGHT; a closure fault is an exception', () => {
    const item = byCode('INJ-POWDER-FILL');
    fillsLikeInjFill(item);
    expect(judgedRun(item, { round: { closures: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-56] plunger or middle-stopper placement names the lot used, verified by a second person, and judges the position of every unit measured at each round; a unit out of position is an exception', () => {
    const item = byCode('INJ-PLUNGER');
    expect(fieldOf(item, 'plungerLot').type).toBe('MATERIAL_LOT');
    expect(item.definition.signatures.map((s) => s.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    expect(fieldOf(item, 'position')).toMatchObject({ type: 'TEST_RESULT', statistics: [{ statistic: 'INDIVIDUAL', limitSlot: 'position' }] });
    expect(judgedRun(item, { round: { position: ['5.0', '5.0', '6.5', '5.0', '5.0'] } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-78][IN-51] form-fill-seal records the machine in its room and the film lot, the seals at each round (the fill weights are IPC-INJ-FILL-WEIGHT\'s), and registers the filled units; for the EU market its own block judges the forming and sealing settings and the batch\'s seal strength; a value outside is an exception', () => {
    const item = byCode('INJ-FFS');
    fillsLikeInjFill(item);
    // Closing happens in the machine: the sealing rejects are the units rejected at closing that accountability reads.
    expect(fieldOf(item, 'totalRejects')).toMatchObject({ type: 'CALC', expression: 'sum(sealRejects)' });
    expect(fieldOf(item, 'filmLot').type).toBe('MATERIAL_LOT');
    expect(judgedRun(item, { round: { sealsOk: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    const eu = byCode('INJ-FFS-EU');
    checkedBySecondPerson(eu);
    for (const id of ['formingTemp', 'sealingTemp', 'sealingTime']) expect(fieldOf(eu, id), id).toMatchObject({ type: 'NUMBER', critical: true });
    expect(judgedRun(eu, { settings: { sealingTemp: '185.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(eu, { sealStrength: { strength: ['30', '30', '15', '30', '30'] } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-77][IN-51] blow-fill-seal records the machine in its room and the polymer lot, the seals at each round (the fill weights are IPC-INJ-FILL-WEIGHT\'s), and registers the filled units; for the EU market its own block judges the extrusion and mould temperatures and the batch\'s wall thickness; a value outside is an exception', () => {
    const item = byCode('INJ-BFS');
    fillsLikeInjFill(item);
    // Closing happens in the machine: the sealing rejects are the units rejected at closing that accountability reads.
    expect(fieldOf(item, 'totalRejects')).toMatchObject({ type: 'CALC', expression: 'sum(sealRejects)' });
    expect(fieldOf(item, 'polymerLot').type).toBe('MATERIAL_LOT');
    expect(judgedRun(item, { round: { sealsOk: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    const eu = byCode('INJ-BFS-EU');
    checkedBySecondPerson(eu);
    expect(judgedRun(eu, { settings: { mouldTemp: '25.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(eu, { wallThickness: { thickness: ['0.50', '0.35', '0.50', '0.50', '0.50'] } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-49][ST-61][IN-47] terminal sterilisation by radiation consumes every filled tray into its numbered load and, per load, records the certificate, the lowest and highest dose measured against the firm\'s limits (checked by a second person), the dosimeters read, the dose within its period and the package indicators, and registers the irradiated load; ultraviolet is not offered; for the EU market its own block records each load\'s loading pattern, reconciliation and the plant\'s signed records, signed by the operator; a dose outside its limits or a failed check is an exception', () => {
    const item = byCode('INJ-RADIATION');
    checkedBySecondPerson(item);
    expect(fieldOf(item, 'trayIn')).toMatchObject({ type: 'CONTAINER', action: 'CONSUME' });
    expect(fieldOf(item, 'loadOut')).toMatchObject({ type: 'CONTAINER', action: 'REGISTER' });
    const method = fieldOf(item, 'method');
    expect(method.type === 'CHOICE' ? method.options.filter((o) => /UV|ultraviolet/i.test(o)) : ['not a choice']).toEqual([]);
    for (const id of ['minDose', 'maxDose']) expect(fieldOf(item, id), id).toMatchObject({ type: 'NUMBER', unit: 'kGy', critical: true });
    expect(judgedRun(item, { load: { minDose: '24.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { load: { maxDose: '42.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    for (const id of ['dosimetersRead', 'withinPeriod', 'indicators']) expect(judgedRun(item, { load: { [id]: false } }).exceptions, id).toEqual(['LIB_UNEXPECTED_ANSWER']);
    const eu = byCode('INJ-RADIATION-EU');
    // Nothing typed from a device: the operator signs alone.
    expect(eu.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED']);
    expect(eu.definition.sections.map((s) => [s.id, s.repeat?.kind])).toEqual([['load', 'PER_CONTAINER']]);
    for (const id of ['loadingPattern', 'reconciled', 'plantRecordsSigned']) expect(judgedRun(eu, { load: { [id]: false } }).exceptions, id).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });
});
