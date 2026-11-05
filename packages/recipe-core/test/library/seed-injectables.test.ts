/**
 * The Injectables edition's catalogue blocks of slice I-1 (terminally sterilised vials and ampoules; injectables plan
 * v2, sections 4 and 5): each is data of the `injectables` edition, records what its clause asks, and judges it. A value
 * outside its limit, or the unexpected answer, raises an exception through the same generic handler as any library
 * block. Every block also runs nominally to completion in seed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { libraryBlockType, libraryBlockVersion } from '../../src/library/index.ts';
import type { FieldDef } from '../../src/library/model.ts';
import { blockEdition, editionFits } from '../../src/library/model.ts';
import { INJECTABLE_CATALOGUE, SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { define, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';
import { judgedRun, recordNominal } from './seed-support.ts';

function byCode(code: string): SeedItem {
  const item = INJECTABLE_CATALOGUE.find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables catalogue item ${code}`);
  return item;
}

function fieldOf(item: SeedItem, id: string): FieldDef {
  const f = item.definition.sections.flatMap((s) => s.fields).find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id} in ${item.definition.code}`);
  return f;
}

/** The item with some example product values changed (limits, inputs), to see the block judge a value against them. */
function withUse(item: SeedItem, change: { limits?: SeedItem['exampleUse']['limits']; inputs?: SeedItem['exampleInputs'] }): SeedItem {
  return {
    ...item,
    exampleUse: { ...item.exampleUse, limits: { ...item.exampleUse.limits, ...change.limits } },
    ...(change.inputs ? { exampleInputs: { ...item.exampleInputs, ...change.inputs } } : {}),
  };
}

const I1_CODES = [
  'INJ-ROOM-READY', 'INJ-COMPONENT-ACCEPT', 'INJ-WASH', 'INJ-DEPYRO', 'INJ-PARTS-AUTOCLAVE', 'INJ-COMPOUND', 'INJ-BULK-FILTER', 'INJ-FILL', 'IPC-INJ-FILL-WEIGHT',
  'INJ-AMPOULE-SEAL', 'INJ-CAPPING', 'INJ-TERMINAL-STERILISE', 'INJ-VISUAL-INSPECT', 'INJ-CCI', 'INJ-UNIT-ACCOUNT', 'INJ-STERILITY-SAMPLE', 'TEST-INJ-RELEASE',
];

describe('the Injectables catalogue (slice I-1)', () => {
  it('[PR-05] the catalogue holds the 17 blocks of I-1 (INJ-01, 02, 04, 05, 06, 12, 14, 15, 18 to 26), each of the injectables edition, loaded with the rest of the catalogue', () => {
    expect(INJECTABLE_CATALOGUE.map((s) => s.definition.code).sort()).toEqual([...I1_CODES].sort());
    for (const s of INJECTABLE_CATALOGUE) {
      expect(blockEdition(s.definition), s.definition.code).toBe('injectables');
      expect(SEED_CATALOGUE, s.definition.code).toContain(s);
    }
    // The edition fence (recipe-core 1871): a sterile block is not offered to a Tablets master, nor a Tablets block to
    // an injectables master.
    expect(editionFits('injectables', 'tablets')).toBe(false);
    expect(editionFits('tablets', 'injectables')).toBe(false);
    expect(SEED_CATALOGUE.filter((s) => blockEdition(s.definition) === 'injectables')).toHaveLength(I1_CODES.length);
  });

  it('[ST-14][ST-15][ST-17] room readiness names the room by the class of its grade, records the disinfectant and its lot, holds its validated contact time, and judges the pressure difference', () => {
    const item = byCode('INJ-ROOM-READY');
    expect(fieldOf(item, 'room')).toMatchObject({ type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' });
    expect(fieldOf(item, 'contact')).toMatchObject({ type: 'TIMER', limitSlot: 'contactTime', critical: true });
    for (const id of ['agent', 'agentLot']) expect(fieldOf(item, id).type).toBe('TEXT');
    // The exception blocks the step: it cannot be signed as performed until QA dispositions it.
    const low = judgedRun(item, { readings: { pressureDiff: '5' } });
    expect(low.exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(low.status).not.toBe('COMPLETED');
    expect(judgedRun(item, { disinfection: { agentInDate: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    // A contact time shorter than the validated minimum (the run holds the agent 60 minutes; a 90-minute minimum).
    const short = withUse(item, { limits: { contactTime: { ...item.exampleUse.limits?.['contactTime'], ranges: (item.exampleUse.limits?.['contactTime']?.ranges ?? []).map((r) => ({ ...r, low: { value: '90', inclusive: true } })) } as never } });
    expect(judgedRun(short, {}).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-39] a primary component is accepted by its lot on the formula line (the lot register checks its material and QC release); an open pack is an exception', () => {
    const item = byCode('INJ-COMPONENT-ACCEPT');
    expect(fieldOf(item, 'componentLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'componentLine' });
    expect(judgedRun(item, { component: { packsIntact: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-41][ST-43][ST-47][ST-61] values typed from a device printout (washer, depyrogenation, parts and terminal sterilisation) are critical with limits, and a second person of another role checks them against the printout', () => {
    const critical: Record<string, string[]> = {
      'INJ-WASH': ['wfiTemp', 'wfiPressure'],
      'INJ-DEPYRO': ['zoneTemp', 'beltSpeed'],
      'INJ-PARTS-AUTOCLAVE': ['temperature', 'holdTime', 'f0'],
      'INJ-TERMINAL-STERILISE': ['temperature', 'holdTime', 'f0'],
    };
    for (const [code, ids] of Object.entries(critical)) {
      const item = byCode(code);
      for (const id of ids) expect(fieldOf(item, id), `${code} ${id}`).toMatchObject({ type: 'NUMBER', critical: true });
      const [performed, checked] = item.definition.signatures;
      expect([performed?.meaning, checked?.meaning], code).toEqual(['PERFORMED', 'CHECKED']);
      expect(checked?.role, code).not.toBe(performed?.role);
    }
    expect(judgedRun(byCode('INJ-DEPYRO'), { cycle: { zoneTemp: '280.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-DEPYRO'), { cycle: { beltSpeed: '130' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-WASH'), { run: { wfiTemp: '65.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-WASH'), { run: { wfiPressure: '1.00' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-PARTS-AUTOCLAVE'), { cycle: { temperature: '120.5' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-PARTS-AUTOCLAVE'), { cycle: { holdTime: '18.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-PARTS-AUTOCLAVE'), { cycle: { f0: '10.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-PARTS-AUTOCLAVE'), { cycle: { cyclePassed: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-61][ST-66] terminal sterilisation runs per load: every filled tray is consumed into its numbered load, and each load records its cycle once, takes its own sterility samples and registers the sterilised load; F0, temperature or time below the minimum is an exception', () => {
    const item = byCode('INJ-TERMINAL-STERILISE');
    const actions = (id: string): string[] => (item.definition.sections.find((s) => s.id === id)?.fields ?? []).flatMap((f) => (f.type === 'CONTAINER' ? [f.action] : []));
    for (const id of ['tray', 'load']) expect(item.definition.sections.find((s) => s.id === id)?.repeat, id).toEqual({ kind: 'PER_CONTAINER' });
    expect(actions('tray')).toEqual(['CONSUME']);
    expect(actions('load')).toEqual(['REGISTER']);
    expect(fieldOf(item, 'sterilitySample')).toMatchObject({ type: 'SAMPLE', unitsSlot: 'loadSterilitySamples' });
    expect(judgedRun(item, { load: { f0: '8.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { load: { temperature: '120.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { load: { holdTime: '14.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-54] compounding takes the pre-filtration bioburden sample and judges the final volume and density; the bioburden-reducing filtration judges its pressure', () => {
    const item = byCode('INJ-COMPOUND');
    expect(fieldOf(item, 'bioburdenSample')).toMatchObject({ type: 'SAMPLE', unitsSlot: 'bioburdenSamples' });
    expect(judgedRun(item, { makeUp: { finalVolume: '205.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-BULK-FILTER'), { filtration: { pressure: '2.50' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-56][ST-57] filling judges the fill weight at each round and the volume from the bulk density; the stopper-height check is asked for vials only; each unit\'s fill weight is judged on the mean and on every unit', () => {
    const fill = byCode('INJ-FILL');
    expect(fill.definition.sections.find((s) => s.id === 'round')?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' });
    expect(fieldOf(fill, 'fillVolume')).toMatchObject({ type: 'CALC', critical: true, expression: 'convert(volume_from_mass(fillWeight, density), [mL])' });
    expect(fieldOf(fill, 'stopperCheck').showWhen).toEqual({ field: 'format', equals: 'Vial' });
    // 2.040 g is below the fill-weight limit, and its volume (2.030 mL at 1.0050 g/mL) is just inside.
    expect(judgedRun(fill, { round: { fillWeight: '2.040' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    // The volume is judged on its own: a denser bulk (1.0400 g/mL) puts 2.100 g inside its weight limit and its volume
    // (2.019 mL) below the volume limit.
    expect(judgedRun(withUse(fill, { inputs: { density: { value: '1.0400', unit: 'g/mL' } } }), {}).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    // A vial line without the stopper-height check is an exception; an ampoule line records no such check.
    expect(judgedRun(fill, { setup: { stopperCheck: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(fill, { setup: { format: 'Ampoule', stopperCheck: undefined } })).toEqual({ exceptions: [], status: 'COMPLETED' });
    const weights = Array.from({ length: 10 }, (_, i) => (i === 0 ? '2.160' : '2.100'));
    expect(judgedRun(byCode('IPC-INJ-FILL-WEIGHT'), { check: { weights } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-57] an ampoule seal or a vial crimp that fails at a round is an exception', () => {
    expect(judgedRun(byCode('INJ-AMPOULE-SEAL'), { round: { sealsIntact: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(byCode('INJ-AMPOULE-SEAL'), { setup: { gasFlow: '2.00' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-CAPPING'), { round: { crimpOk: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[ST-62][ST-63] 100 % inspection counts the rejects by defect category and judges the reject rate; one critical defect in the AQL sample is an exception', () => {
    const item = byCode('INJ-VISUAL-INSPECT');
    for (const id of ['particles', 'container', 'fill', 'closure']) expect(fieldOf(item, id).type, id).toBe('NUMBER');
    // Accepted units are calculated, never typed: inspected less every reject.
    expect(fieldOf(item, 'accepted')).toMatchObject({ type: 'CALC', expression: 'inspected - rejected' });
    // 300 rejects of 10,000 inspected: 3 %, above the 2 % limit.
    expect(judgedRun(item, { counts: { particles: '240' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { aql: { aqlCritical: '1' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-64] one unit failing the container closure integrity test is an exception', () => {
    expect(judgedRun(byCode('INJ-CCI'), { test: { failures: '1' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-71] every unit filled is accounted for: one unit missing from the counts is an exception', () => {
    const item = byCode('INJ-UNIT-ACCOUNT');
    expect(fieldOf(item, 'unaccounted')).toMatchObject({ type: 'CALC', critical: true });
    expect(judgedRun(item, {})).toEqual({ exceptions: [], status: 'COMPLETED' });
    const accepted = (value: string) => withUse(item, { inputs: { accepted: { value, unit: '{unit}' } } });
    expect(judgedRun(accepted('9699'), {}).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    // Counted twice (more units accounted for than filled) is as much an exception as one missing.
    expect(judgedRun(accepted('9701'), {}).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    // A typed count that leaves one unit out (the losses) is judged the same way.
    expect(judgedRun(item, { account: { losses: '19' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-71] unit accountability reads the units filled and rejected at the line from the filling step, and the units accepted and rejected at inspection from the inspection step, never typed again; one unit missing is an exception', () => {
    const fill = byCode('INJ-FILL');
    const inspect = byCode('INJ-VISUAL-INSPECT');
    const account = byCode('INJ-UNIT-ACCOUNT');
    // Only the samples and the documented losses are typed; the other counts are earlier-step values.
    expect(account.definition.sections.flatMap((s) => s.fields).filter((f) => f.type === 'NUMBER').map((f) => f.id)).toEqual(['sampled', 'losses']);
    expect(account.exampleUse.stepValues).toEqual({
      filledSource: { step: 'filling', field: 'filled' },
      lineRejectsSource: { step: 'filling', field: 'rejects' },
      acceptedSource: { step: 'inspection', field: 'accepted' },
      inspectionRejectsSource: { step: 'inspection', field: 'rejected' },
    });
    const registry = testRegistry().extend(...[fill, inspect, account].map((i) => libraryBlockVersion(i.definition, expr)));
    const step = (id: string, item: SeedItem, reads: string[] = []): FlowNode => phase(id, { block: { type: libraryBlockType(item.definition.code), version: '1' }, config: item.exampleUse as never, reads });
    const density = fill.exampleInputs?.['density'] ?? { value: '1.0050', unit: 'g/mL' };
    const master = (children: FlowNode[]): MbrContent =>
      mbrWith({ kind: 'sequence', id: 'ops', children: [...children, phase('after')] }, { inputs: [{ id: 'density', name: 'density', source: 'MASTER_DATA', valueType: 'DECIMAL', unit: density.unit }] });
    const filling = step('filling', fill, ['density']);
    const inspection = step('inspection', inspect);
    const refusal = (mbr: MbrContent): string => {
      try {
        define(mbr, { registry });
        return 'defined';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    // The master check refuses the wiring if inspection comes after the account, or if the count named is a tray's (repeated).
    expect(refusal(master([filling, step('account', account), inspection]))).toContain('step inspection does not come before account in the flow (ENG-DEF-STEP-VALUE');
    const trayUnits: SeedItem = { ...account, exampleUse: { ...account.exampleUse, stepValues: { ...account.exampleUse.stepValues, filledSource: { step: 'filling', field: 'units' } } } };
    expect(refusal(master([filling, inspection, step('account', trayUnits)]))).toContain('step filling records no single value units (ENG-DEF-STEP-VALUE');

    const run = (filled: string): { exceptions: string[]; status: string | undefined; unaccounted: Record<string, unknown> | undefined } => {
      const mbr = master([filling, inspection, step('account', account)]);
      const batch = Run.issue(define(mbr, { registry }), { inputs: { density: { value: { kind: 'DECIMAL', value: density.value, unit: density.unit }, source: 'seed example' } } }, T0);
      const steps: [string, SeedItem, Record<string, Record<string, unknown>>][] = [['filling', fill, { end: { filled, rejects: '80' } }], ['inspection', inspect, {}], ['account', account, {}]];
      for (const [id, item, overrides] of steps) {
        batch.start(id);
        recordNominal(batch, id, item, mbr, overrides);
        try {
          batch.perform(id);
        } catch (e) {
          if (!(e instanceof Error && e.message.includes('ENG-BLOCKED'))) throw e;
          break;
        }
        if (batch.status(id) === 'AWAITING_VERIFICATION') batch.verify(id);
      }
      const entry = Object.values(batch.state.entries).find((x) => x.stepKey.startsWith('account') && x.kind === 'account');
      return { exceptions: batch.exceptions().map((x) => x.type), status: batch.status('account'), unaccounted: (entry?.data['computed'] as Record<string, Record<string, unknown>> | undefined)?.['unaccounted'] };
    };
    // 10,220 filled = 9,920 accepted (10,000 inspected less 80 rejects) + 80 rejected at the line + 80 at inspection
    // + 120 sampled + 20 lost.
    const ok = run('10220');
    expect(ok).toMatchObject({ exceptions: [], status: 'COMPLETED' });
    expect(ok.unaccounted?.['value']).toMatch(/^0(\.0*)?$/);
    expect(ok.unaccounted?.['inputs']).toMatchObject({ filled: { value: '10220' }, accepted: { value: '9920' } });
    // Where each count came from is in the calculation's record.
    expect(ok.unaccounted?.['stepValues']).toMatchObject({ filled: { step: 'filling', field: 'filled' }, accepted: { step: 'inspection', field: 'accepted' } });
    expect(run('10221').exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[ST-66] sterility sampling records each point of the formulation\'s plan (count of points, units per point, time)', () => {
    const item = byCode('INJ-STERILITY-SAMPLE');
    expect(item.definition.sections[0]?.repeat).toEqual({ kind: 'COUNT', countSlot: 'samplingPoints' });
    expect(fieldOf(item, 'units')).toMatchObject({ type: 'SAMPLE', unitsSlot: 'unitsPerPoint' });
  });

  it('[ST-65][ST-68] the release tests are QC\'s: growth in the sterility test, or endotoxin above the product limit, is an exception', () => {
    const item = byCode('TEST-INJ-RELEASE');
    expect(item.definition.signatures.map((s) => s.role)).toEqual(['QC_ANALYST', 'QC_REVIEWER']);
    expect(judgedRun(item, { sterility: { noGrowth: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(judgedRun(item, { endotoxin: { endotoxin: ['0.20', '0.60'] } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(item, { particulates: { particles10: Array.from({ length: 10 }, () => '6500') } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });
});
