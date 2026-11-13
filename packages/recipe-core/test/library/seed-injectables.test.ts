/**
 * The Injectables edition's catalogue blocks of slice I-1 (terminally sterilised vials and ampoules; injectables plan
 * v2, sections 4 and 5): each is data of the `injectables` edition, records what its clause asks, and judges it. A value
 * outside its limit, or the unexpected answer, raises an exception through the same generic handler as any library
 * block. Every block also runs nominally to completion in seed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent, TimeConstraint } from '../../src/flow/model.ts';
import { checkBlockDefinition, checkBlockUse, libraryBlockType, libraryBlockVersion } from '../../src/library/index.ts';
import type { FieldDef } from '../../src/library/model.ts';
import { blockEdition, editionFits } from '../../src/library/model.ts';
import { INJECTABLE_ASEPTIC_CATALOGUE, INJECTABLE_CATALOGUE, INJECTABLE_INSPECTION_CATALOGUE, INJECTABLE_LYO_CATALOGUE, INJECTABLE_ROUTE_CATALOGUE, SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { define, done, OP1, Run, T0, testRegistry } from '../engine/support.ts';
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
  'INJ-INSPECT-LIGHT',
  'INJ-ROOM-READY', 'INJ-WASH', 'INJ-DEPYRO', 'INJ-PARTS-AUTOCLAVE', 'INJ-COMPOUND', 'INJ-GAS-FILTER', 'INJ-BULK-FILTER', 'INJ-FILL', 'IPC-INJ-FILL-WEIGHT',
  'INJ-AMPOULE-SEAL', 'INJ-CAPPING', 'INJ-TERMINAL-STERILISE', 'INJ-VISUAL-INSPECT', 'INJ-CCI', 'INJ-UNIT-ACCOUNT', 'INJ-STERILITY-SAMPLE', 'TEST-INJ-RELEASE',
  // Slice I-1c2: the finished-pack examination that closes a packaging record of the edition.
  'INJ-PACK-EXAM',
];

describe('the Injectables catalogue (slice I-1)', () => {
  it('[PR-05] the catalogue holds the 18 blocks of I-1 (INJ-01, 04, 05, 06, 12, 14, 15, 18 to 27 and the EU inspection-light block; INJ-02 dropped, its lots named where used), each of the injectables edition, loaded with the rest of the catalogue', () => {
    expect(INJECTABLE_CATALOGUE.map((s) => s.definition.code).sort()).toEqual([...I1_CODES].sort());
    for (const s of INJECTABLE_CATALOGUE) {
      expect(blockEdition(s.definition), s.definition.code).toBe('injectables');
      expect(SEED_CATALOGUE, s.definition.code).toContain(s);
    }
    // The edition fence (recipe-core 1871): a sterile block is not offered to a Tablets master, nor a Tablets block to
    // an injectables master.
    expect(editionFits('injectables', 'tablets')).toBe(false);
    expect(editionFits('tablets', 'injectables')).toBe(false);
    // Lean review: the booth illumination is Annex 1 8.31 only, an EU-market block signed by the operator alone; the base
    // inspection block keeps no illumination answer and no inspection timer (no limit, no clause).
    expect(byCode('INJ-INSPECT-LIGHT').definition).toMatchObject({ markets: ['EU'], signatures: [{ meaning: 'PERFORMED' }] });
    expect(byCode('INJ-VISUAL-INSPECT').definition.sections.flatMap((x) => x.fields).filter((f) => f.id === 'illuminationOk' || f.type === 'TIMER')).toEqual([]);
    // No 211 or Schedule M clause names a process indicator: the base sterilisation blocks record none.
    for (const code of ['INJ-PARTS-AUTOCLAVE', 'INJ-TERMINAL-STERILISE']) expect(byCode(code).definition.sections.flatMap((x) => x.fields).map((f) => f.id), code).not.toContain('indicator');
    expect(SEED_CATALOGUE.filter((s) => blockEdition(s.definition) === 'injectables')).toHaveLength(I1_CODES.length + INJECTABLE_ASEPTIC_CATALOGUE.length + INJECTABLE_LYO_CATALOGUE.length + INJECTABLE_ROUTE_CATALOGUE.length + INJECTABLE_INSPECTION_CATALOGUE.length);
  });

  it('[ST-14][ST-15] room readiness names the room by the class of its grade, records the disinfectant and its lot, holds its validated contact time, and judges the pressure difference', () => {
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

  it('[ST-39] each primary component lot is named where it is used (vial or ampoule at washing, stopper in a stopper load, seal at capping), not as a formula line; a second person verifies it, and a lot QC has not released is refused (G07-LOT-STATUS)', () => {
    const lots: [string, string, string][] = [['INJ-WASH', 'run', 'containerLot'], ['INJ-PARTS-AUTOCLAVE', 'cycle', 'stopperLot'], ['INJ-CAPPING', 'setup', 'sealLot']];
    for (const [code, section, id] of lots) {
      const item = byCode(code);
      const f = fieldOf(item, id);
      expect(f.type, code).toBe('MATERIAL_LOT');
      expect(f.type === 'MATERIAL_LOT' && f.bomLineSlot, code).toBeUndefined();
      expect(item.definition.signatures.map((x) => x.meaning), code).toEqual(['PERFORMED', 'VERIFIED']);
      // The nominal run uses a released lot; the same entry with a quarantined lot is refused at once.
      expect(judgedRun(item, {}).exceptions, code).toEqual([]);
      const quarantined = { lots: { [id]: { id: `SIM-${id.toUpperCase()}`, material: 'SIM-MATERIAL', status: 'QUARANTINE', identityTested: true } } };
      expect(() => judgedRun(item, { [section]: quarantined }), code).toThrow(/G07-LOT-STATUS/);
    }
    // An ampoule has no stopper: the stopper lot is asked only for a stopper load.
    expect(fieldOf(byCode('INJ-PARTS-AUTOCLAVE'), 'stopperLot').showWhen).toEqual({ field: 'loadPattern', equals: 'Stoppers' });
  });

  it('[ST-41][ST-43][ST-47][ST-61] values typed from a device printout (washer, depyrogenation, parts and terminal sterilisation) are judged against the firm\'s limits, critical where a clause names the value (the sterilising temperature, hold time and F0, the depyrogenation temperature), and a second person of another role checks them against the printout', () => {
    const critical: Record<string, string[]> = {
      'INJ-WASH': [],
      'INJ-DEPYRO': ['zoneTemp'],
      'INJ-PARTS-AUTOCLAVE': ['temperature', 'holdTime', 'f0'],
      'INJ-TERMINAL-STERILISE': ['temperature', 'holdTime', 'f0'],
    };
    for (const [code, ids] of Object.entries(critical)) {
      const item = byCode(code);
      for (const id of ids) expect(fieldOf(item, id), `${code} ${id}`).toMatchObject({ type: 'NUMBER', critical: true });
      const [performed, checked] = item.definition.signatures;
      // Washing and parts sterilisation also name a component lot, so their second person VERIFIES (lead, I-1c).
      expect([performed?.meaning, checked?.meaning], code).toEqual(['PERFORMED', ['INJ-WASH', 'INJ-PARTS-AUTOCLAVE'].includes(code) ? 'VERIFIED' : 'CHECKED']);
      expect(checked?.role, code).not.toBe(performed?.role);
    }
    expect(judgedRun(byCode('INJ-DEPYRO'), { cycle: { zoneTemp: '280.0' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(judgedRun(byCode('INJ-DEPYRO'), { cycle: { beltSpeed: '130' } }).exceptions).toEqual(['LIB_LIMIT_BREACH']);
    // No clause names the rinse water or the belt speed: judged against the firm's limits, not critical (lean review).
    for (const [code, id] of [['INJ-WASH', 'wfiTemp'], ['INJ-WASH', 'wfiPressure'], ['INJ-DEPYRO', 'beltSpeed']] as const) {
      expect(fieldOf(byCode(code), id), `${code} ${id}`).toMatchObject({ type: 'NUMBER', limitSlot: id });
      expect((fieldOf(byCode(code), id) as { critical?: boolean }).critical, `${code} ${id}`).toBeUndefined();
    }
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

  it('[ST-56][ST-57] the fill weights are recorded once, in the fill weight check, each unit judged and the mean; filling checks the closures at each round; the stopper-height check is asked for vials only', () => {
    const fill = byCode('INJ-FILL');
    expect(fill.definition.sections.find((s) => s.id === 'round')?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' });
    // Recorded once (lean review): the filling round checks the closures; the weights are the fill weight check's.
    expect(fill.definition.sections.find((s) => s.id === 'round')?.fields.map((f) => f.id)).toEqual(['closures']);
    expect(fill.definition.inputs ?? []).toEqual([]);
    expect(fieldOf(fill, 'stopperCheck').showWhen).toEqual({ field: 'format', equals: 'Vial' });
    expect(judgedRun(fill, { round: { closures: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
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

  it('[ST-62] the booth illumination check is an EU-market block (Annex 1 8.31) signed by the operator alone: not in the IN or US base, which inspects without it; an illumination out of range is an exception', () => {
    const light = byCode('INJ-INSPECT-LIGHT');
    expect(light.definition.markets).toEqual(['EU']);
    for (const m of ['IN', 'US']) expect(light.definition.markets, m).not.toContain(m);
    expect(light.definition.signatures).toHaveLength(1);
    expect(light.definition.signatures[0]).toMatchObject({ meaning: 'PERFORMED' });
    expect(light.definition.sections.flatMap((x) => x.fields).map((f) => f.id)).toEqual(['illuminationOk']);
    // The base inspection block, offered to every market, keeps no illumination answer.
    expect(byCode('INJ-VISUAL-INSPECT').definition.markets).toBeUndefined();
    expect(judgedRun(light, {})).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(judgedRun(light, { light: { illuminationOk: false } }).exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
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

  it('[ST-71] unit accountability reads the units filled and rejected at the line from the filling step, the units rejected at closing from the capping or sealing total, and the units accepted and rejected at inspection from the inspection step, never typed again; one unit missing is an exception', () => {
    const fill = byCode('INJ-FILL');
    const inspect = byCode('INJ-VISUAL-INSPECT');
    const cap = byCode('INJ-CAPPING');
    const account = byCode('INJ-UNIT-ACCOUNT');
    // Capping and sealing add their rounds' rejects up once at the end of the step, for the account to read.
    for (const code of ['INJ-CAPPING', 'INJ-AMPOULE-SEAL']) expect(fieldOf(byCode(code), 'totalRejects')).toMatchObject({ type: 'CALC', expression: 'sum(rejects)' });
    // Only the samples and the documented losses are typed; the other counts are earlier-step values.
    expect(account.definition.sections.flatMap((s) => s.fields).filter((f) => f.type === 'NUMBER').map((f) => f.id)).toEqual(['sampled', 'losses']);
    expect(account.exampleUse.stepValues).toEqual({
      filledSource: { step: 'filling', field: 'filled' },
      lineRejectsSource: { step: 'filling', field: 'rejects' },
      closingRejectsSource: { step: 'capping', field: 'totalRejects' },
      acceptedSource: { step: 'inspection', field: 'accepted' },
      inspectionRejectsSource: { step: 'inspection', field: 'rejected' },
    });
    const registry = testRegistry().extend(...[fill, cap, byCode('INJ-AMPOULE-SEAL'), inspect, account].map((i) => libraryBlockVersion(i.definition, expr)));
    const step = (id: string, item: SeedItem, reads: string[] = []): FlowNode => phase(id, { block: { type: libraryBlockType(item.definition.code), version: '1' }, config: item.exampleUse as never, reads });
    const density = fill.exampleInputs?.['density'] ?? { value: '1.0050', unit: 'g/mL' };
    const master = (children: FlowNode[]): MbrContent =>
      mbrWith({ kind: 'sequence', id: 'ops', children: [...children, phase('after')] }, { inputs: [{ id: 'density', name: 'density', source: 'MASTER_DATA', valueType: 'DECIMAL', unit: density.unit }] });
    const filling = step('filling', fill, ['density']);
    const capping = step('capping', cap);
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
    expect(refusal(master([filling, capping, step('account', account), inspection]))).toContain('step inspection does not come before account in the flow (ENG-DEF-STEP-VALUE');
    const trayUnits: SeedItem = { ...account, exampleUse: { ...account.exampleUse, stepValues: { ...account.exampleUse.stepValues, filledSource: { step: 'filling', field: 'units' } } } };
    // An ampoule master points the closing count at its sealing step's total instead.
    const viaSealing: SeedItem = { ...account, exampleUse: { ...account.exampleUse, stepValues: { ...account.exampleUse.stepValues, closingRejectsSource: { step: 'sealing', field: 'totalRejects' } } } };
    expect(refusal(master([filling, step('sealing', byCode('INJ-AMPOULE-SEAL')), inspection, step('account', viaSealing)]))).toBe('defined');
    expect(refusal(master([filling, capping, inspection, step('account', trayUnits)]))).toContain('step filling records no single value units (ENG-DEF-STEP-VALUE');

    const run = (filled: string): { exceptions: string[]; status: string | undefined; unaccounted: Record<string, unknown> | undefined } => {
      const mbr = master([filling, capping, inspection, step('account', account)]);
      const batch = Run.issue(define(mbr, { registry }), { inputs: { density: { value: { kind: 'DECIMAL', value: density.value, unit: density.unit }, source: 'seed example' } } }, T0);
      const steps: [string, SeedItem, Record<string, Record<string, unknown>>][] = [['filling', fill, { end: { filled, rejects: '80' } }], ['capping', cap, { round: { rejects: '30' } }], ['inspection', inspect, {}], ['account', account, {}]];
      for (const [id, item, overrides] of steps) {
        batch.start(id);
        recordNominal(batch, id, item.definition, item.exampleUse, mbr, overrides);
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
    // 10,250 filled = 9,920 accepted (10,000 inspected less 80 rejects) + 80 rejected at the line + 30 at capping
    // + 80 at inspection + 120 sampled + 20 lost.
    const ok = run('10250');
    expect(ok).toMatchObject({ exceptions: [], status: 'COMPLETED' });
    expect(ok.unaccounted?.['value']).toMatch(/^0(\.0*)?$/);
    expect(ok.unaccounted?.['inputs']).toMatchObject({ filled: { value: '10250' }, accepted: { value: '9920' } });
    // Where each count came from is in the calculation's record.
    expect(ok.unaccounted?.['stepValues']).toMatchObject({ filled: { step: 'filling', field: 'filled' }, accepted: { step: 'inspection', field: 'accepted' } });
    expect(ok.unaccounted?.['inputs']).toMatchObject({ rejected: { value: '190' } });
    expect(run('10251').exceptions).toEqual(['LIB_LIMIT_BREACH']);
  });

  it('[PR-37] the finished-pack examination at completion takes the sample the master sets, records the label as read on a unit and every count as found; a unit with a wrong or missing label fails it (an exception for QA), and it refuses nothing at entry', () => {
    const item = byCode('INJ-PACK-EXAM');
    expect(item.definition.category).toBe('PACKAGING');
    // 211.134(b): the sample size is the master's (a count slot), not a number of the block.
    expect(fieldOf(item, 'sample')).toMatchObject({ type: 'SAMPLE', unitsSlot: 'examUnits' });
    expect(fieldOf(item, 'wrongLabel')).toMatchObject({ type: 'NUMBER', limitSlot: 'wrongLabel', critical: true });
    for (const id of ['printedBatch', 'printedExpiry']) expect(fieldOf(item, id).type).toBe('TEXT');
    // Owner rule (flexibility within compliance): no other field is judged and none expects an answer.
    const fields = item.definition.sections.flatMap((s) => s.fields);
    expect(fields.filter((f) => 'limitSlot' in f && f.limitSlot !== undefined).map((f) => f.id)).toEqual(['wrongLabel']);
    expect(fields.filter((f) => 'expected' in f)).toEqual([]);
    expect(item.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    expect(judgedRun(item, {}).exceptions).toEqual([]);
    // Two wrong labels are recorded as found and raise the exception that keeps the step from completing until QA
    // decides; the entry itself is not refused.
    const wrong = judgedRun(item, { exam: { wrongLabel: '2' } });
    expect(wrong.exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(wrong.status).not.toBe('COMPLETED');
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

/** A time limit of the master between two injectables steps (the plan's way to hold a time: seed header above). */
function limit(id: string, kind: TimeConstraint['kind'], from: [string, 'START' | 'END'], to: [string, 'START' | 'END'], max: string, unit: string, breach: TimeConstraint['breach']): TimeConstraint {
  return {
    id, name: `Limit ${id}`, kind, from: { node: from[0], event: from[1] }, to: { node: to[0], event: to[1] },
    max: { value: max, unit }, source: { kind: 'VALIDATION_REPORT', ref: 'VR-INJ' }, breach, pauses: 'INCLUDED',
  };
}

describe('the master\'s time limits between injectables steps (slice I-6.3)', () => {
  const seq = (...ids: string[]): FlowNode => ({ kind: 'sequence', id: 'ops', children: ids.map((x) => phase(x)) });

  it('[ST-41] stoppers sterilised with a 72 h use-by and used 73 h later: the use-by is breached, filling cannot start, and the exception needs a deviation and QA\'s disposition', () => {
    const mbr = mbrWith(seq('stopper-autoclave', 'filling'), { timeConstraints: [limit('TC-STOPPER-USE-BY', 'USE_BY', ['stopper-autoclave', 'END'], ['filling', 'START'], '72', 'h', 'EXCEPTION_AND_BLOCK')] });
    const within = Run.issue(define(mbr));
    done(within, 'stopper-autoclave');
    within.minutes(72 * 60);
    within.start('filling');
    expect(within.exceptions()).toEqual([]);
    const late = Run.issue(define(mbr));
    done(late, 'stopper-autoclave');
    late.minutes(73 * 60);
    late.refused({ type: 'START_STEP', actor: OP1, step: 'filling' }, 'ENG-BLOCKED');
    const [breach, ...more] = late.exceptions('TIME_MAX_BREACH');
    expect(more).toEqual([]);
    expect(breach).toMatchObject({ deviationRequired: true, qaOnly: true, releaseBlocking: true });
    expect(breach?.source.constraint).toBe('TC-STOPPER-USE-BY');
  });

  it('[ST-57][ST-59][IN-46] a time limit beyond its maximum (stoppering to capping 3 h against 2 h, part-stoppered vials exposed past their limit before the lyophiliser is loaded, compounding to filtration past its maximum) is an exception that needs a deviation and holds the release', () => {
    const cases: [string, string, string, TimeConstraint['kind'], string, number][] = [
      ['filling', 'capping', 'TC-STOPPER-TO-CRIMP', 'HOLD', '2', 3 * 60],
      ['filling', 'lyo-loading', 'TC-PART-STOPPERED', 'EXPOSURE', '4', 4 * 60 + 1],
      ['compounding', 'filtration', 'TC-PREP-TO-FILTRATION', 'PROCESS_WINDOW', '8', 8 * 60 + 1],
    ];
    for (const [from, to, id, kind, max, minutes] of cases) {
      const mbr = mbrWith(seq(from, to), { timeConstraints: [limit(id, kind, [from, 'END'], [to, 'START'], max, 'h', 'EXCEPTION')] });
      const ok = Run.issue(define(mbr));
      done(ok, from);
      ok.minutes(Number(max) * 60);
      done(ok, to);
      expect(ok.exceptions(), id).toEqual([]);
      const run = Run.issue(define(mbr));
      done(run, from);
      run.minutes(minutes);
      run.start(to);
      const breaches = run.exceptions('TIME_MAX_BREACH');
      expect(breaches.map((b) => b.source.constraint), id).toEqual([id]);
      expect(breaches[0], id).toMatchObject({ deviationRequired: true, releaseBlocking: true });
    }
  });
});

describe('what the approved MODIFY decisions keep, in the I-1 blocks (slice I-6.3)', () => {
  /** The facts the plant reports for one equipment field, in place of the nominal ones. */
  const unit = (id: string, classCode: string, fitness = 'QUALIFIED') => ({ [id]: { code: `SIM-${id.toUpperCase()}`, classCode, fitness } });

  it('[ST-44] a parts-sterilisation cycle whose temperature failed stays an exception when every other value passed and the cycle is answered passed: the load cannot complete until QA dispositions it', () => {
    for (const code of ['INJ-PARTS-AUTOCLAVE', 'INJ-TERMINAL-STERILISE']) {
      const section = code === 'INJ-PARTS-AUTOCLAVE' ? 'cycle' : 'load';
      const failed = judgedRun(byCode(code), { [section]: { temperature: '120.5', cyclePassed: true } });
      expect(failed.exceptions, code).toEqual(['LIB_LIMIT_BREACH']);
      expect(failed.status, code).not.toBe('COMPLETED');
    }
  });

  it('[ST-45] each sterilisation and depyrogenation cycle block is signed by the operator and checked or verified by a second person of another role, so a cycle is not complete until it is reviewed', () => {
    for (const code of ['INJ-DEPYRO', 'INJ-PARTS-AUTOCLAVE', 'INJ-TERMINAL-STERILISE']) {
      const [performed, second, ...more] = byCode(code).definition.signatures;
      expect(performed?.meaning, code).toBe('PERFORMED');
      expect(['CHECKED', 'VERIFIED'], code).toContain(second?.meaning);
      expect(second?.role, code).not.toBe(performed?.role);
      expect(more, code).toEqual([]);
    }
  });

  it('[ST-60] the preparation room is of the class the formulation names for its grade: a room of another class (a lower grade) is refused', () => {
    const item = byCode('INJ-ROOM-READY');
    expect(fieldOf(item, 'room')).toMatchObject({ type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' });
    expect(item.exampleUse.equipmentClasses).toEqual({ roomClass: 'ROOM-GRADE-C' });
    expect(judgedRun(item, {}).exceptions).toEqual([]);
    expect(() => judgedRun(item, { clearance: { equipment: unit('room', 'ROOM-GRADE-D') } })).toThrow(/LIB-EQUIPMENT-CLASS/);
  });

  it('[IN-44] a disinfectant dilution used past its use-by time is an exception that holds the room clearance until QA dispositions it', () => {
    const late = judgedRun(byCode('INJ-ROOM-READY'), { disinfection: { agentInDate: false } });
    expect(late.exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(late.status).not.toBe('COMPLETED');
  });

  it('[ST-64][INV-45] visual inspection is never a container closure integrity method: the methods offered are physical tests only', () => {
    const method = fieldOf(byCode('INJ-CCI'), 'method');
    expect(method.type).toBe('CHOICE');
    const options = method.type === 'CHOICE' ? method.options : [];
    expect(options.length).toBeGreaterThan(0);
    expect(options.filter((o) => /visual|inspect/i.test(o))).toEqual([]);
  });

  it('[IN-49] sterility sampling takes a sample at each point of the formulation\'s plan, which may name a point after an intervention or stoppage', () => {
    const item = byCode('INJ-STERILITY-SAMPLE');
    expect(item.definition.sections[0]?.repeat).toEqual({ kind: 'COUNT', countSlot: 'samplingPoints' });
    const point = fieldOf(item, 'point');
    expect(point.type === 'CHOICE' ? point.options : []).toContain('After an intervention');
    expect(fieldOf(item, 'units')).toMatchObject({ type: 'SAMPLE', unitsSlot: 'unitsPerPoint' });
    const unlabelled = judgedRun(item, { point: { labelled: false } });
    expect(unlabelled.exceptions.length).toBeGreaterThan(0);
    expect(new Set(unlabelled.exceptions)).toEqual(new Set(['LIB_UNEXPECTED_ANSWER']));
  });

  // The one due date of a unit (decision 0030; injectables plan 4.1): the site sets the calibration due date of a unit to
  // the earliest of its calibration, requalification and, for a steriliser, leak test; past it the plant reports the
  // unit CALIBRATION_OVERDUE, and the step refuses it. A unit within a week of it is still usable.
  it('[ST-43] a steriliser whose leak test has lapsed is past its one due date and is not selectable: the parts sterilisation refuses it', () => {
    const item = byCode('INJ-PARTS-AUTOCLAVE');
    expect(judgedRun(item, { cycle: { equipment: unit('autoclave', 'STEAM-STERILISER', 'CALIBRATION_DUE_SOON') } }).exceptions).toEqual([]);
    expect(() => judgedRun(item, { cycle: { equipment: unit('autoclave', 'STEAM-STERILISER', 'CALIBRATION_OVERDUE') } })).toThrow(/LIB-EQUIPMENT-FITNESS/);
  });

  it('[IN-43] a room past its one due date (its requalification lapsed: 12 months for India, earlier where the site sets it for an EU profile) is refused, with no warning stage before it', () => {
    const item = byCode('INJ-ROOM-READY');
    expect(() => judgedRun(item, { clearance: { equipment: unit('room', 'ROOM-GRADE-C', 'CALIBRATION_OVERDUE') } })).toThrow(/LIB-EQUIPMENT-FITNESS/);
    // Before the due date the room is usable and nothing is raised: there is no warning in between.
    expect(judgedRun(item, { clearance: { equipment: unit('room', 'ROOM-GRADE-C', 'QUALIFIED') } })).toEqual({ exceptions: [], status: 'COMPLETED' });
  });

  it('[IN-47] a steriliser past its one due date (its revalidation lapsed) is refused by terminal sterilisation; a cycle with an alarm (not answered passed) is an exception that holds the step and the release until QA dispositions it', () => {
    const item = byCode('INJ-TERMINAL-STERILISE');
    expect(() => judgedRun(item, { setup: { equipment: unit('steriliser', 'STEAM-STERILISER', 'CALIBRATION_OVERDUE') } })).toThrow(/LIB-EQUIPMENT-FITNESS/);
    const alarm = judgedRun(item, { load: { cyclePassed: false } });
    expect(alarm.exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(alarm.status).not.toBe('COMPLETED');
  });

  it('[ST-67] a failing release test is an exception that holds the QC step until QA dispositions it under a deviation', () => {
    const growth = judgedRun(byCode('TEST-INJ-RELEASE'), { sterility: { noGrowth: false } });
    expect(growth.exceptions).toEqual(['LIB_UNEXPECTED_ANSWER']);
    expect(growth.status).not.toBe('COMPLETED');
  });

  it('[ST-54][IN-46] compounding records the pre-filtration bioburden sample: an entry without it is refused, so the step, and the record the gate waits for, cannot be completed without the sample', () => {
    const item = byCode('INJ-COMPOUND');
    expect(fieldOf(item, 'bioburdenSample')).toMatchObject({ type: 'SAMPLE', unitsSlot: 'bioburdenSamples' });
    expect(() => judgedRun(item, { makeUp: { bioburdenSample: undefined } })).toThrow(/LIB-ENTRY-REQUIRED/);
  });
});

describe('formulation maxima on calculated values (I-6.2)', () => {
  it('[ST-31] a maximum the formulation sets on a calculated value (here the reject rate of the inspection) is judged like any limit: above it the step stops on an exception, within it the step completes', () => {
    const item = byCode('INJ-VISUAL-INSPECT');
    expect(fieldOf(item, 'rejectRate')).toMatchObject({ type: 'CALC', limitSlot: 'rejectRate', critical: true });
    // Nominal: 80 rejects of 10 000 inspected, 0.8 %, within the formulation's maximum of 2.0 %.
    expect(judgedRun(item, {})).toEqual({ exceptions: [], status: 'COMPLETED' });
    const over = judgedRun(item, { counts: { particles: '200' } });
    expect(over.exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(over.status).not.toBe('COMPLETED');
  });
});

/**
 * The equipment an injectables block names (a room, a tunnel, a balance, a point of use) is read with its fitness from
 * the plant register (step entry facts, plant.equipment_fitness): a unit that is not fit is refused at the entry, before
 * anything is recorded (plan section 4.1; the MODIFY decisions of I-6).
 */
describe('equipment named by an injectables block is refused when it is not fit (I-6.2)', () => {
  /** The facts the server would read for the field: a unit of the formulation's class, with the given fitness. */
  const unit = (item: SeedItem, id: string, fitness: string): Record<string, unknown> => {
    const f = fieldOf(item, id);
    const classCode = f.type === 'EQUIPMENT' ? item.exampleUse.equipmentClasses?.[f.classSlot] : undefined;
    return { equipment: { [id]: { code: `SIM-${id.toUpperCase()}`, classCode, fitness } } };
  };

  it('[ST-05] the fill-weight check on a balance whose calibration has expired is refused; one due soon is still used', () => {
    const item = byCode('IPC-INJ-FILL-WEIGHT');
    expect(() => judgedRun(item, { check: unit(item, 'weighBalance', 'CALIBRATION_OVERDUE') })).toThrow(/calibration overdue and may not be used \(LIB-EQUIPMENT-FITNESS/);
    expect(judgedRun(item, { check: unit(item, 'weighBalance', 'CALIBRATION_DUE_SOON') }).exceptions).toEqual([]);
  });

  it('[ST-14] room readiness refuses a room past its requalification due date, an unqualified room and a room of another grade class', () => {
    const item = byCode('INJ-ROOM-READY');
    // A room's requalification is its due date in the plant register (plan 4.1): past it, the unit is overdue.
    expect(() => judgedRun(item, { clearance: unit(item, 'room', 'CALIBRATION_OVERDUE') })).toThrow(/calibration overdue and may not be used \(LIB-EQUIPMENT-FITNESS/);
    expect(() => judgedRun(item, { clearance: unit(item, 'room', 'NOT_QUALIFIED') })).toThrow(/LIB-EQUIPMENT-FITNESS/);
    expect(() => judgedRun(item, { clearance: { equipment: { room: { code: 'SIM-ROOM', classCode: 'ROOM-GRADE-D', fitness: 'QUALIFIED' } } } })).toThrow(/LIB-EQUIPMENT-CLASS/);
  });

  it('[ST-16] line clearance refuses a room taken out of service (an HVAC shutdown) until it is returned to service', () => {
    const item = byCode('INJ-ROOM-READY');
    expect(() => judgedRun(item, { clearance: unit(item, 'room', 'OUT_OF_SERVICE') })).toThrow(/out of service and may not be used \(LIB-EQUIPMENT-FITNESS/);
    expect(judgedRun(item, { clearance: unit(item, 'room', 'QUALIFIED') }).exceptions).toEqual([]);
  });

  it('[ST-17] a pressure difference typed below its limit at room readiness is an exception: the record shows the excursion and the step stops until it is handled', () => {
    const item = byCode('INJ-ROOM-READY');
    expect(fieldOf(item, 'pressureDiff')).toMatchObject({ type: 'NUMBER', unit: 'Pa' });
    const dip = judgedRun(item, { readings: { pressureDiff: '8' } });
    expect(dip.exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(dip.status).not.toBe('COMPLETED');
  });

  it('[ST-17] depyrogenation refuses a tunnel whose HEPA test (its due date) has expired', () => {
    const item = byCode('INJ-DEPYRO');
    expect(() => judgedRun(item, { cycle: unit(item, 'tunnel', 'CALIBRATION_OVERDUE') })).toThrow(/calibration overdue and may not be used \(LIB-EQUIPMENT-FITNESS/);
    expect(judgedRun(item, { cycle: unit(item, 'tunnel', 'QUALIFIED') }).exceptions).toEqual([]);
  });

  it('[ST-25][ST-26] compounding refuses water from a WFI point of use that is out of service (QC has not released it); a released point is used', () => {
    const item = byCode('INJ-COMPOUND');
    // The vessel named in the same section stays fit; only the point of use changes.
    const units = (fitness: string) => ({ equipment: { ...unit(item, 'vessel', 'QUALIFIED')['equipment'] as object, ...unit(item, 'wfiPoint', fitness)['equipment'] as object } });
    expect(() => judgedRun(item, { preparation: units('OUT_OF_SERVICE') })).toThrow(/WFI point of use: .* out of service and may not be used \(LIB-EQUIPMENT-FITNESS/);
    expect(judgedRun(item, { preparation: units('QUALIFIED') }).exceptions).toEqual([]);
  });
});

/** The binding minimum of ST-12 and ST-28 (lead ruling I-6 B1, 12 November 2026). */
describe('aseptic headcount and the overlay gas filter (I-6 B1)', () => {
  it('[ST-12] filling records the most people present in the filling room at once; more than the formulation\'s maximum (the number qualified in the process simulation) is an exception that stops the step', () => {
    const item = byCode('INJ-FILL');
    expect(fieldOf(item, 'peoplePresent')).toMatchObject({ type: 'NUMBER', limitSlot: 'peoplePresent' });
    expect(judgedRun(item, { end: { peoplePresent: '4' } })).toEqual({ exceptions: [], status: 'COMPLETED' });
    const five = judgedRun(item, { end: { peoplePresent: '5' } });
    expect(five.exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(five.status).not.toBe('COMPLETED');
  });

  it('[ST-28] the overlay gas filter\'s integrity after use is a critical value with its limit (every market): below it is an exception that stops the step, and without the result the step cannot complete', () => {
    const item = byCode('INJ-GAS-FILTER');
    expect(item.definition.markets).toBeUndefined();
    expect(fieldOf(item, 'gasFilterPost')).toMatchObject({ type: 'NUMBER', limitSlot: 'gasFilterPost', critical: true });
    expect(judgedRun(item, { gasFilter: { gasFilterPost: '1.20' } })).toEqual({ exceptions: [], status: 'COMPLETED' });
    const failed = judgedRun(item, { gasFilter: { gasFilterPost: '0.80' } });
    expect(failed.exceptions).toEqual(['LIB_LIMIT_BREACH']);
    expect(failed.status).not.toBe('COMPLETED');
    expect(() => judgedRun(item, { gasFilter: { gasFilterPost: undefined } })).toThrow(/is required \(LIB-ENTRY-REQUIRED/);
  });

  it('[ST-28] a compounding use without a nitrogen overlay needs no gas-filter limit: compounding has no gas-filter field, and its use passes the checker without one', () => {
    const item = byCode('INJ-COMPOUND');
    expect(item.definition.sections.flatMap((x) => x.fields).filter((f) => /gas/i.test(f.id))).toEqual([]);
    expect(Object.keys(item.exampleUse.limits ?? {}).filter((k) => /gas/i.test(k))).toEqual([]);
    expect(checkBlockUse(item.definition, { block: { code: 'INJ-COMPOUND', version: item.definition.version }, ...item.exampleUse }, expr)).toEqual([]);
    expect(judgedRun(item, { preparation: { nitrogen: 'Not required by the product' } })).toEqual({ exceptions: [], status: 'COMPLETED' });
  });

  it('[ST-28] the database reads the overlay and its gas filter test by marks, not codes (lead, B5): compounding marks the option recording an applied overlay, the gas filter test has the role GAS_FILTER_INTEGRITY and marks its one critical result; a mark out of place is refused', () => {
    expect(fieldOf(byCode('INJ-COMPOUND'), 'nitrogen')).toMatchObject({ type: 'CHOICE', gasOverlayApplied: 'Applied' });
    const gas = byCode('INJ-GAS-FILTER').definition;
    expect(gas.roles).toEqual(['GAS_FILTER_INTEGRITY']);
    expect(fieldOf(byCode('INJ-GAS-FILTER'), 'gasFilterPost')).toMatchObject({ type: 'NUMBER', critical: true, limitSlot: 'gasFilterPost', postUseIntegrity: true });
    expect(checkBlockDefinition(byCode('INJ-COMPOUND').definition, expr)).toEqual([]);
    expect(checkBlockDefinition(gas, expr)).toEqual([]);
    const codes = (def: library) => checkBlockDefinition(def, expr).map((p) => p.code);
    type library = typeof gas;
    const mapFields = (def: library, fn: (f: FieldDef) => object): library => ({ ...def, sections: def.sections.map((x) => ({ ...x, fields: x.fields.map((f) => fn(f) as FieldDef) })) });
    const compound = byCode('INJ-COMPOUND').definition;
    // An option the field does not have; the mark on a field of another type; a yes/no marked with anything but true.
    expect(codes(mapFields(compound, (f) => (f.id === 'nitrogen' ? { ...f, gasOverlayApplied: 'Yes' } : f)))).toEqual(['LIB-GAS-OVERLAY']);
    expect(codes(mapFields(compound, (f) => (f.id === 'wfiVolume' ? { ...f, gasOverlayApplied: 'Applied' } : f)))).toEqual(['LIB-GAS-OVERLAY']);
    expect(codes(mapFields(compound, (f) => (f.id === 'additionOrder' ? { ...f, gasOverlayApplied: true } : f)))).toEqual([]);
    expect(codes(mapFields(compound, (f) => (f.id === 'additionOrder' ? { ...f, gasOverlayApplied: 'true' } : f)))).toEqual(['LIB-GAS-OVERLAY']);
    // The result mark without the role; the role without the mark; the mark on a value that is not critical.
    expect(codes({ ...gas, roles: ['OBSERVATION'] })).toEqual(['LIB-GAS-FILTER']);
    expect(codes(mapFields(gas, (f) => { const c = { ...f } as Record<string, unknown>; delete c['postUseIntegrity']; return c; }))).toEqual(['LIB-GAS-FILTER']);
    expect(codes(mapFields(gas, (f) => ({ ...f, critical: false })))).toEqual(['LIB-GAS-FILTER']);
  });
});
