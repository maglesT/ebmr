/**
 * The Injectables edition's catalogue blocks of slice I-3 (lyophilisation, INJ-17; injectables plan v2, section 4.3):
 * each is data of the `injectables` edition, passes the library checker, records what its clause asks, and judges it.
 * A value outside its limit, or the unexpected answer, raises an exception through the same generic handler as any
 * library block. Every block also runs nominally to completion in seed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { expr } from '../flow/support.ts';
import { blockEdition, checkBlockDefinition, checkBlockUse } from '../../src/library/index.ts';
import { INJECTABLE_LYO_CATALOGUE, SEED_CATALOGUE } from '../../src/library/seed/index.ts';
import { byCode, fieldOf, judgedRun, nominalRun } from './seed-support.ts';

const CYCLE_FIELDS = ['freezeShelfTemp', 'primaryShelfTemp', 'primaryPressure', 'primaryTime', 'secondaryShelfTemp', 'secondaryTime'];

describe('the Injectables catalogue (slice I-3, lyophilisation)', () => {
  it('[PR-05][PR-03] the catalogue holds the lyophilisation block INJ-17 and its EU-market block, each of the injectables edition, loaded with the rest of the catalogue, passing the library checker and the formulation checks, and completed by a nominal batch; only the Annex 1 block is tagged for the EU market', () => {
    expect(INJECTABLE_LYO_CATALOGUE.map((s) => s.definition.code)).toEqual(['INJ-LYO', 'INJ-LYO-EU']);
    for (const s of INJECTABLE_LYO_CATALOGUE) {
      const code = s.definition.code;
      expect(blockEdition(s.definition), code).toBe('injectables');
      expect(SEED_CATALOGUE, code).toContain(s);
      expect(checkBlockDefinition(s.definition, expr), code).toEqual([]);
      expect(checkBlockUse(s.definition, { block: { code, version: s.definition.version }, ...s.exampleUse }, expr), code).toEqual([]);
      expect(nominalRun(s), code).toEqual({ exceptions: [], status: 'COMPLETED' });
      for (const sec of s.definition.sections) {
        for (const f of sec.fields) if (f.showWhen) expect(sec.fields.map((x) => x.id), `${code} ${f.id}`).toContain(f.showWhen.field);
      }
      // Time limits (filling to loading, part-stoppered exposure) are the master's time constraints: no typed times.
      expect(s.definition.sections.flatMap((x) => x.fields).filter((f) => f.type === 'CALC' || f.type === 'DATE_TIME'), code).toEqual([]);
    }
    expect(byCode('INJ-LYO').definition.markets).toBeUndefined();
    expect(byCode('INJ-LYO-EU').definition.markets).toEqual(['EU']);
  });

  it('[ST-59][ST-72] lyophilisation consumes every filled tray into its numbered load and, for each load, records the programme and the cycle values from the printout as critical values with the firm\'s limits, checked by a second person, and registers the lyophilised load; a value outside its limit, stoppers not seated or an alarm is an exception', () => {
    const item = byCode('INJ-LYO');
    expect(item.definition.sections.map((s) => [s.id, s.repeat?.kind ?? 'ONCE'])).toEqual([['setup', 'ONCE'], ['tray', 'PER_CONTAINER'], ['load', 'PER_CONTAINER']]);
    expect(fieldOf(item, 'lyophiliser')).toMatchObject({ type: 'EQUIPMENT', classSlot: 'lyophiliserClass' });
    expect(fieldOf(item, 'trayIn')).toMatchObject({ type: 'CONTAINER', action: 'CONSUME' });
    expect(fieldOf(item, 'loadOut')).toMatchObject({ type: 'CONTAINER', action: 'REGISTER' });
    for (const id of ['programme', 'cycleNumber']) expect(fieldOf(item, id).type, id).toBe('TEXT');
    for (const id of CYCLE_FIELDS) expect(fieldOf(item, id), id).toMatchObject({ type: 'NUMBER', critical: true, limitSlot: id });
    // The limits are the firm's (formulation slots): the block itself holds none.
    expect(JSON.stringify(item.definition)).not.toMatch(/"low"|"high"/);
    const [performed, checked] = item.definition.signatures;
    expect([performed?.meaning, checked?.meaning]).toEqual(['PERFORMED', 'CHECKED']);
    expect(checked?.role).not.toBe(performed?.role);
    expect(judgedRun(item, { load: { primaryShelfTemp: '-10.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { load: { primaryPressure: '15.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { load: { secondaryTime: '4.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { load: { stoppered: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(item, { load: { cyclePassed: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-58][ST-59][ST-66] for the EU market, its own block records the trays checked, the Grade A transfer means, sterile utensils, the vent filter sterilised and its integrity by the formulation\'s method, and per load the lyophiliser\'s sterilisation cycle, the leak test against the firm\'s maximum and the load\'s sterility samples; a failed check is an exception', () => {
    const item = byCode('INJ-LYO-EU');
    expect(item.definition.sections.find((s) => s.id === 'load')?.repeat).toEqual({ kind: 'PER_CONTAINER' });
    expect(fieldOf(item, 'sterilisationCycle').type).toBe('TEXT');
    expect(fieldOf(item, 'leakRise')).toMatchObject({ type: 'NUMBER', critical: true, limitSlot: 'leakRise' });
    expect(fieldOf(item, 'sterilitySample')).toMatchObject({ type: 'SAMPLE', unitsSlot: 'loadSterilitySamples' });
    expect(judgedRun(item, { load: { leakRise: '2.5' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { loading: { traysChecked: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(item, { loading: { utensilsSterile: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(item, { ventFilter: { ventFilterSterilised: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(item, { ventFilter: { ventBubblePoint: '1.00' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    // By diffusion: the bubble point is not asked, the diffusion is judged.
    const diffusion = { ventFilter: { ventMethod: 'Diffusion', ventBubblePoint: undefined, ventDiffusion: '8.0' } };
    expect(judgedRun(item, diffusion)).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(judgedRun(item, { ventFilter: { ...diffusion.ventFilter, ventDiffusion: '20.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });
});
