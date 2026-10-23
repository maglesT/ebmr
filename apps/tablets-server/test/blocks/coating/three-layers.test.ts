/**
 * Phase 7 slice 7o (requirement R4, second check product; owner's question of 23 October 2026): one master may coat the
 * same tablets two or three times in a row (a seal coat, an enteric coat, a top coat), each layer its own TB-03
 * suspension, its own TB-18 cores step with its own core sample (coreItem) and its own coating loop to its own weight
 * gain (gainItem, with its own limits). Proven here before the browser flow:
 *  - the designer's checks: the validator and the execution definition find no error in such a master (the rabeprazole
 *    shape on route W's processing master, and a dc-mini variant against the real reference catalogue), and the
 *    simulation runs every layer to its weight gain;
 *  - the database: a test batch runs the three layers through the engine and the database guards (tablets 0910 to 0912),
 *    and each layer's weight gain is computed against its own core sample, never another layer's.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import { rtwProcessingContent } from '../../../src/cli/demo-route-masters.ts';
import { definitionFindings } from '../../../src/features/designer/definition.ts';
import { analyse } from '../../../src/features/designer/validation.ts';
import { simulateInWorker } from '../../../src/features/designer/simulation.ts';
import { dcMiniVariant, importAndIssue, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { fakeTimers, lastEntry, stateOf } from '../granulation/db-support.ts';
import { COATER_ACTUALS } from './db-support.ts';

type Json = Record<string, unknown>;

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } };

interface Layer {
  key: 'seal' | 'ent' | 'top';
  coatingType: 'FC' | 'FC_F';
  solutionType: 'FILM_COAT' | 'ENTERIC';
  targetGain: string;
  minGain?: string;
  maxGain: string;
  /** The validated range of the tablets' mean weight before this coat (mg; the dc-mini batch's). */
  core: [string, string];
}

/** Seal coat (film, about 2 %), enteric coat (functional film, at least 8 %), top coat (film, about 3 %). */
const LAYERS: readonly Layer[] = [
  { key: 'seal', coatingType: 'FC', solutionType: 'FILM_COAT', targetGain: '2.0', maxGain: '3.0', core: ['240.0', '260.0'] },
  { key: 'ent', coatingType: 'FC_F', solutionType: 'ENTERIC', targetGain: '9.0', minGain: '8.0', maxGain: '11.0', core: ['245.0', '265.0'] },
  { key: 'top', coatingType: 'FC', solutionType: 'FILM_COAT', targetGain: '3.0', maxGain: '4.0', core: ['270.0', '290.0'] },
];

const cap = (k: string): string => k.charAt(0).toUpperCase() + k.slice(1);

function phase(id: string, type: string, config: Json, extra: Json = {}): Json {
  return {
    kind: 'phase', id, name: `Step ${id}`, block: { type, version: '1' }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures: SIGNATURES, significant: true, riskClass: 'HIGH', ...extra,
  };
}

/** The two items of a layer: its core mean (mg, 6 decimals) and its weight gain (a process end point in %, 4 decimals). */
function layerItems(l: Layer, source: string, core: [string, string] = l.core): Json[] {
  const low = l.minGain ? { low: { value: l.minGain, inclusive: true } } : {};
  const range = (unit: string, bounds: Json) => ({ unit, ranges: [{ tier: 'VALIDATED', ...bounds, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: source } }] });
  const checked = { evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON' };
  return [
    {
      id: `core${cap(l.key)}`, name: `Core mean weight before the ${l.key} coat`, valueType: 'DECIMAL', unit: 'mg', precision: { kind: 'DECIMALS', digits: 6 }, role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL',
      limits: range('mg', { low: { value: core[0], inclusive: true }, high: { value: core[1], inclusive: true } }), ...checked,
    },
    {
      id: `gain${cap(l.key)}`, name: `Weight gain of the ${l.key} coat`, valueType: 'DECIMAL', unit: '%', precision: { kind: 'DECIMALS', digits: 4 }, role: 'PROCESS_ENDPOINT', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL',
      limits: range('%', { ...low, high: { value: l.maxGain, inclusive: true } }), ...checked,
    },
  ];
}

/** The steps of a layer: its suspension, its cores step and its coating loop (equipment refs when the stage binds them). */
function layerSteps(l: Layer, opts: { useBy: Json; equipment: boolean; system: Json; logInterval: Json }): Json[] {
  const core = `core${cap(l.key)}`;
  const gain = `gain${cap(l.key)}`;
  const coater = opts.equipment ? [{ ref: 'COATER', use: 'USE' }] : [];
  const verified = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
  return [
    phase(`p-susp-${l.key}`, 'TB-03', { solutionType: l.solutionType, solvent: 'PURIFIED_WATER', useBy: opts.useBy }, { name: `${cap(l.key)} coating suspension`, signatures: verified }),
    phase(`p-cores-${l.key}`, 'TB-18', {
      part: 'CORES', coatingType: l.coatingType, coreItem: core, sampleSize: '20',
      room: { temperatureMin: '20', temperatureMax: '25', humidityMax: '60' }, loadRange: { min: '20', max: '90', unit: 'kg' },
    }, { name: `Tablets before the ${l.key} coat`, records: [core], equipment: coater }),
    {
      kind: 'loop', id: `L-COAT-${l.key.toUpperCase()}`, name: `Coat until the ${l.key} coat's weight gain is reached`, maxIterations: 3,
      exit: { condition: `${gain} >= ${l.minGain ?? l.targetGain} [%]`, endpoint: gain },
      body: phase(`p-coat-${l.key}`, 'TB-18', {
        part: 'COATING', coatingType: l.coatingType, coreItem: core, gainItem: gain, sampleSize: '20', targetGain: l.targetGain, ...(l.minGain ? { minGain: l.minGain } : {}), maxGain: l.maxGain,
        logInterval: opts.logInterval, actuals: COATER_ACTUALS, manualFallback: true, maxAgeSeconds: 600,
      }, { name: `${cap(l.key)} coat to its weight gain`, records: [gain], reads: [core], equipment: coater, system: opts.system }),
    },
  ];
}

/**
 * The rabeprazole shape on route W's processing master: the enteric layer the master has (p-susp, p-cores, L-COAT) with
 * a seal layer before it and a top layer after it, in the same coating stage (the tablets stay in the pan).
 */
function threeLayerRouteW(): flow.MbrContent {
  const m = structuredClone(rtwProcessingContent('RBZ-TEST')) as unknown as Json;
  const find = (n: unknown, id: string): Json | undefined => {
    if (Array.isArray(n)) for (const x of n) { const r = find(x, id); if (r) return r; }
    else if (n && typeof n === 'object') {
      const o = n as Json;
      if (o['id'] === id) return o;
      for (const v of Object.values(o)) { const r = find(v, id); if (r) return r; }
    }
    return undefined;
  };
  const seq = find(m['procedure'], 'O-COAT-seq') as Json;
  const kids = seq['children'] as Json[];
  const opts = { useBy: { value: '12', unit: 'h' }, equipment: true, system: { kind: 'PLC', ref: 'SYS-COATER', recipe: 'RCP-RTW-COAT', recipeVersion: '1' }, logInterval: { value: '30', unit: 'min' } };
  const [seal, , top] = LAYERS as [Layer, Layer, Layer];
  const at = kids.findIndex((n) => n['id'] === 'p-susp');
  const after = kids.findIndex((n) => n['id'] === 'L-COAT') + 1;
  seq['children'] = [...kids.slice(0, at), ...layerSteps(seal, opts), ...kids.slice(at, after), ...layerSteps(top, opts), ...kids.slice(after)];
  (m['parameters'] as Json[]).push(...layerItems(seal, 'VR-RTW', ['397.7', '422.3']), ...layerItems(top, 'VR-RTW', ['430.0', '480.0']));
  const parsed = flow.parseMbr(m);
  if (!parsed.ok) throw new Error(`the three-layer route W master does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

/** dc-mini with the three layers first in its dispensing preparation (the catalogue's references; sandbox runnable). */
function threeLayerDcMini(where: 'AFTER_CLEARANCE' | 'FIRST' = 'AFTER_CLEARANCE'): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['references'] as Json[]).push({ id: 'SYS-COATER', kind: 'COMPUTERISED_SYSTEM', code: 'SYS-COATER', version: '1' });
    (content['parameters'] as Json[]).push(...LAYERS.flatMap((l) => layerItems(l, 'VR-BLEND-01')));
    const opts = { useBy: { value: '1', unit: 'h' }, equipment: false, system: { kind: 'PLC', ref: 'SYS-COATER', recipe: 'RCP-COAT', recipeVersion: '1' }, logInterval: { value: '30', unit: 'min' } };
    // After the booth clearance (each stage starts with its clearance); first in the test batch, which runs the layers only.
    const layers = { kind: 'sequence', id: 'seq-layers', children: LAYERS.flatMap((l) => layerSteps(l, opts)) };
    const [clear, ...rest] = prep;
    return where === 'FIRST' ? [layers, ...prep] : [clear as Json, layers, ...rest];
  });
}

const tb18 = (n: unknown, out: Json[] = []): Json[] => {
  if (Array.isArray(n)) for (const x of n) tb18(x, out);
  else if (n && typeof n === 'object') {
    const o = n as Json;
    if (o['kind'] === 'phase' && (o['block'] as Json)['type'] === 'TB-18') out.push(o);
    for (const v of Object.values(o)) tb18(v, out);
  }
  return out;
};
const errorsOf = (fs: readonly { severity: string; rule: string; subject: string; message: string }[]) => fs.filter((f) => f.severity === 'ERROR').map((f) => `${f.rule} ${f.subject}: ${f.message}`);

let sbx: ExecServer;

beforeAll(async () => {
  sbx = await startExecServer();
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

describe('three coating layers in a row (slice 7o, R4 second check product)', () => {
  it('[IN-37][PR-29][PR-08] the designer\'s checks accept a master that coats three times: route W\'s master with a seal coat before and a top coat after its enteric coat defines without errors; each layer has its own cores step, core item, loop and weight-gain item', () => {
    const mbr = threeLayerRouteW();
    expect(errorsOf(definitionFindings(mbr))).toEqual([]);
    const steps = tb18(mbr.procedure);
    const cores = steps.filter((s) => (s['config'] as Json)['part'] === 'CORES');
    const coats = steps.filter((s) => (s['config'] as Json)['part'] === 'COATING');
    expect(cores.map((s) => (s['config'] as Json)['coreItem'])).toEqual(['coreSeal', 'coreMean', 'coreTop']);
    expect(coats.map((s) => [(s['config'] as Json)['coreItem'], (s['config'] as Json)['gainItem'], (s['config'] as Json)['coatingType']])).toEqual([
      ['coreSeal', 'gainSeal', 'FC'], ['coreMean', 'gain', 'FC_F'], ['coreTop', 'gainTop', 'FC'],
    ]);
  });

  it('[IN-37][PR-29][DI-04][DI-05] the validator and the definition find no error in three layers, and the simulation runs each layer to its own weight gain', async () => {
    // The sandbox has no GMP reference registers: what the plain dc-mini master already gets is the baseline; the three
    // layers add no error to it.
    const base = errorsOf((await analyse(sbx.db.app, dcMiniVariant((prep) => prep), [])).findings);
    const mbr = threeLayerDcMini();
    const a = await analyse(sbx.db.app, mbr, []);
    expect(errorsOf(a.findings).filter((e) => !base.includes(e) && !/^GMP-REFERENCES SYS-COATER/.test(e))).toEqual([]);
    const out = await simulateInWorker({ content: mbr, asOf: a.loaded.asOf, references: a.loaded.references, minimaRequest: a.loaded.minimaRequest, minima: a.loaded.minima, engineRoles: a.loaded.engineRoles, checkers: a.loaded.checkers });
    if (!out.ok) throw new Error('timeout' in out ? out.message : JSON.stringify(out));
    expect(out.report.paths.enumerated).toBeGreaterThan(0);
    // Every step (the nine of the layers among them) and every decision (each layer's loop exit) is covered.
    expect([out.report.coverage.steps.missing, out.report.coverage.decisions.missing]).toEqual([[], []]);
    expect(out.report.coverage.decisions.total).toBeGreaterThanOrEqual(LAYERS.length);
  });

  it('[IN-37][PR-29][INV-25][DI-29] a batch runs the three layers through the engine and the database: each weight gain is computed against its own layer\'s core sample (seal 250 mg, enteric 255 mg, top 278 mg), each suspension its own', async () => {
    fakeTimers();
    const advance = (): void => {
      vi.advanceTimersByTime(7_000);
    };
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, threeLayerDcMini('FIRST')));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
    d.beforeTap = advance;
    const rec = (stepKey: string, kind: string, data: Json) => d.ok('operator1', { type: 'RECORD_ENTRY', stepKey, entry: { kind: 'BLOCK_ENTRY', entryKind: kind, data } } as never);
    const perform = async (stepKey: string, meaning: 'VERIFIED' | 'WITNESSED'): Promise<void> => {
      await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
      await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning });
    };
    // Group totals of 20 tablets (g): the cores of each layer, then the coated sample of its one iteration.
    const plan: Record<Layer['key'], { core: string; coated: string; mean: string; gain: string }> = {
      seal: { core: '5.0000', coated: '5.1000', mean: '250.000000', gain: '2.0000' },
      ent: { core: '5.1000', coated: '5.5590', mean: '255.000000', gain: '9.0000' },
      top: { core: '5.5600', coated: '5.7268', mean: '278.000000', gain: '3.0000' },
    };
    for (const l of LAYERS) {
      const p = plan[l.key];
      await d.ok('operator1', { type: 'START_STEP', stepKey: `p-susp-${l.key}@` });
      await rec(`p-susp-${l.key}@`, 'PREPARED', { quantity: { value: '10.000', unit: 'kg' }, appearance: 'COMPLIES' });
      await perform(`p-susp-${l.key}@`, 'VERIFIED');
      const prep = await lastEntry(sbx, runId, `p-susp-${l.key}@`, 'PREPARED');
      await d.ok('operator1', { type: 'START_STEP', stepKey: `p-cores-${l.key}@` });
      await rec(`p-cores-${l.key}@`, 'ROOM_CHECK', { filteredAir: true, temperature: '23.0', humidity: '45' });
      await rec(`p-cores-${l.key}@`, 'PAN_LOAD', { quantity: { value: '60.000', unit: 'kg' } });
      await rec(`p-cores-${l.key}@`, 'CORE_SAMPLE', { instrument: 'TEST-BAL-01', weighing: 'GROUP', count: '20', total: p.core, unit: 'g' });
      await perform(`p-cores-${l.key}@`, 'WITNESSED');
      const k = `p-coat-${l.key}@L-COAT-${l.key.toUpperCase()}=1`;
      await d.ok('operator1', { type: 'START_STEP', stepKey: k });
      await rec(k, 'RECIPE_CHECK', { recipe: 'RCP-COAT', recipeVersion: '1' });
      await rec(k, 'SPRAY_START', {});
      for (const a of COATER_ACTUALS) await rec(k, 'ACTUAL', { tag: a.tag, value: a.min, unit: a.unit, source: 'MANUAL' });
      await rec(k, 'SPRAY_END', {});
      await rec(k, 'SUSPENSION_USED', { preparation: prep, quantity: { value: '5.000', unit: 'kg' } });
      await rec(k, 'WEIGHT_CHECK', { instrument: 'TEST-BAL-01', weighing: 'GROUP', count: '20', total: p.coated, unit: 'g' });
      await perform(k, 'WITNESSED');
      await d.ok('operator1', { type: 'COMPLETE_LOOP_ITERATION', stepKey: k });
    }
    const s = await stateOf(sbx, runId);
    const points = Object.values(s.points);
    const value = (item: string) => (points.find((x) => x['item'] === item)?.['value'] as Json | undefined)?.['value'];
    for (const l of LAYERS) {
      const p = plan[l.key];
      expect(value(`core${cap(l.key)}`), `core ${l.key}`).toBe(p.mean);
      expect(value(`gain${cap(l.key)}`), `gain ${l.key}`).toBe(p.gain);
      const at = (kind: string) => Object.values(s.entries).find((e) => e['kind'] === kind && e['stepKey'] === `p-coat-${l.key}@L-COAT-${l.key.toUpperCase()}=1`)?.['data'] as Json;
      expect([at('WEIGHT_CHECK')['coreMeanMg'], at('WEIGHT_CHECK')['weightGain']], `the ${l.key} coat's check`).toEqual([p.mean, p.gain]);
      expect(at('SUSPENSION_USED')['preparation']).toBe(await lastEntry(sbx, runId, `p-susp-${l.key}@`, 'PREPARED'));
    }
    // Each coating step instance completed; nothing raised (no gain below a minimum, none above a maximum).
    for (const l of LAYERS) expect(s.steps[`p-coat-${l.key}@L-COAT-${l.key.toUpperCase()}=1`]?.['status']).toBe('COMPLETED');
    expect(Object.values(s.exceptions).map((e) => e['type']).filter((t) => t !== 'PROCESS_MANUAL_FALLBACK')).toEqual([]);
  }, 240_000);
});
