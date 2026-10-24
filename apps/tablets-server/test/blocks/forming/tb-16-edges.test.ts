/**
 * TB-16@1 bilayer (multilayer) compression (PR-21, IN-26, IN-35, PR-29) at its edges: every definition check with its
 * message, each layer's scheduler configuration, the charges' refusals with their messages (and none after the run),
 * the missed checks across layers with their title, and PERFORMED's problems listed once. Written for the Phase 3 exit
 * mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { engine, type flow } from '@ebmr/recipe-core/pure';
import { TB16 } from '../../../src/blocks/forming/index.ts';
import { layerConfig, missedOf } from '../../../src/blocks/tb-16.ts';
import { blockMbr, fixturePhase, MIN, OP1, phase, sig, startRun } from './support.ts';

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cfg = fixturePhase(TB16).config as Json;
const layers = cfg['layers'] as Json[];
const l1 = layers[0] as Json;
const t = layers[1] as Json;
const charge = (layer: string, hopper: string, blend: string, n = 1): Entry => ({ kind: 'HOPPER_CHARGE', layer, hopper, blend, chargeId: U(n) });
const group = (stream: string, g: string): Entry => ({ kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream, readings: [U(900)], groupWeight: g });
const refusal = (run: ReturnType<typeof startRun>, entry: Entry) => run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry }).message;
const P = (config: Json, extra: Partial<flow.PhaseNode> = {}, others: flow.FlowNode[] = [], withSetup = true): string[] => {
  const p = fixturePhase(TB16, { ...extra, config: config as never });
  const m = blockMbr(TB16, p, others);
  const mm = withSetup ? m : { ...m, procedure: JSON.parse(JSON.stringify(m.procedure).replaceAll('"TB-10"', '"G-07"')) as flow.MbrContent['procedure'] };
  const check = TB16.checkConfig?.bind(TB16) as unknown as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
  return check(p, p.config as Json, mm).filter((x) => x.code.startsWith('TB16')).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
};
const W = 'Bilayer compression step p';

describe('TB-16 definition checks', () => {
  it('[PR-21][IN-26][PR-23] two or three layers, each id, hopper and blend its own; a press used; a set-up step in the MBR', () => {
    expect(P(cfg)).toEqual([]);
    expect(P({ ...cfg, layers: [t] })).toContain(`TB16-LAYERS [PR-21] ${W} has 1 layers; a bilayer or trilayer run has two or three`);
    expect(P({ ...cfg, layers: [l1, { ...l1, id: 'L2', hopper: 'H3', stage: 'B3' }, { ...l1, id: 'L3', hopper: 'H4', stage: 'B4' }, t] })).toContain(`TB16-LAYERS [PR-21] ${W} has 4 layers; a bilayer or trilayer run has two or three`);
    expect(P({ ...cfg, layers: [l1, { ...l1, id: 'L2', hopper: 'H3', stage: 'B3' }, t] })).toEqual([]);
    expect(P({ ...cfg, layers: [{ ...l1, id: 'T' }, t] })).toContain(`TB16-LAYERS [PR-21,IN-26] ${W}: two layers share a id`);
    expect(P({ ...cfg, layers: [{ ...l1, hopper: 'H2' }, t] })).toEqual([`TB16-LAYERS [PR-21,IN-26] ${W}: two layers share a hopper`]);
    expect(P({ ...cfg, layers: [{ ...l1, stage: 'BLEND_L2' }, t] })).toEqual([`TB16-LAYERS [PR-21,IN-26] ${W}: two layers share a stage`]);
    expect(P(cfg, { equipment: [{ ref: 'PRESS', use: 'STATUS_CHECK' }] })).toEqual([`TB16-NO-EQUIPMENT [PR-23] ${W} names no press it uses`]);
    expect(P(cfg, {}, [], false)).toEqual([`TB16-NO-SETUP [IN-35,PR-23] ${W}: the MBR has no press set-up and first-off step (TB-10) before the bilayer run`]);
  });

  it('[PR-29][IN-35] a layer sampled alone has one in-house weight check and no sweep, by time only, within the 30-min ceiling (equal allowed); the full tablets check total weight and lamination; no layer stream is a scheduler\'s', () => {
    const only = `TB16-LAYER-ONLY [PR-29,IN-35] ${W}: layer L1 is sampled alone: a weight check with in-house limits (GROUP or INDIVIDUAL) and nothing else`;
    expect(P({ ...cfg, layers: [{ ...l1, plan: [...(l1['plan'] as Json[]), { test: 'PHYSICAL', every: { value: '15', unit: 'min' }, qrmRef: 'Q' }], physical: t['physical'] }, t] })).toContain(only);
    expect(P({ ...cfg, layers: [{ ...l1, weight: { ...(l1['weight'] as Json), mode: 'INDIVIDUAL', n: 10, individual: { action: '3' }, weighing: undefined, tolerance: undefined } }, t] })).not.toContain(only);
    expect(P({ ...cfg, layers: [{ ...l1, sweep: t['sweep'] }, t] })).toContain(only);
    expect(P({ ...cfg, layers: [{ ...l1, plan: [{ test: 'WEIGHT', every: { value: '15', unit: 'min' }, everyCount: 1000, qrmRef: 'Q' }] }, t] })).toContain(`TB16-PLAN [PR-29] ${W}: layer L1 plans by time only (no press-count interval)`);
    const ceiling = `TB16-CEILING [IN-35] ${W}: layer L1 is checked no more than 30 min after its previous sample; its interval plus the grace must not exceed it (IN-35 (c))`;
    expect(P({ ...cfg, layers: [{ ...l1, plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'Q' }] }, t] })).not.toContain(ceiling);
    expect(P({ ...cfg, layers: [{ ...l1, plan: [{ test: 'WEIGHT', every: { value: '25.000001', unit: 'min' }, qrmRef: 'Q' }] }, t] })).toContain(ceiling);
    expect(P({ ...cfg, grace: undefined })).toContain(ceiling);
    const sep = `TB16-SEPARATION [PR-29,IN-35] ${W}: the full tablets of layer T are checked for their total weight and for layer separation (a physical check examining LAMINATION)`;
    expect(P({ ...cfg, layers: [l1, { ...t, plan: [(t['plan'] as Json[])[1]] }] })).toContain(sep);
    expect(P({ ...cfg, layers: [l1, { ...t, plan: [(t['plan'] as Json[])[0]] }] })).toContain(sep);
    expect(P({ ...cfg, layers: [l1, { ...t, physical: undefined }] })).toContain(sep);
    const scheduler = phase('ipc', { block: { type: 'TB-11', version: '1' }, config: { process: 'OTHER', streams: [{ id: 'T' }, 'x'], plan: [], grace: { value: '5', unit: 'min' } } });
    expect(P(cfg, {}, [scheduler])).toContain(`TB16-STREAM-CLASH [PR-29] ${W}: layer stream T is also a stream of an IPC scheduler step; a passing check of one would vouch for the other`);
  });

  it('[IN-35][PR-29] each layer runs as a scheduler of its own stream: the last layer compresses (with the sweep), the others not; shared timing members pass through', () => {
    const c = { ...cfg, restartAfter: { value: '10', unit: 'min' }, lateEntry: { value: '5', unit: 'min' } };
    expect(layerConfig(c, 0)).toEqual({ process: 'OTHER', streams: [{ id: 'L1' }], plan: l1['plan'], grace: cfg['grace'], restartAfter: c.restartAfter, lateEntry: c.lateEntry, weight: l1['weight'] });
    expect(layerConfig(c, 1)).toEqual({ process: 'COMPRESSION', streams: [{ id: 'T' }], plan: t['plan'], grace: cfg['grace'], restartAfter: c.restartAfter, lateEntry: c.lateEntry, sweep: t['sweep'], weight: t['weight'], physical: t['physical'] });
    expect(layerConfig({ ...cfg, layers: [{ ...l1, sweep: t['sweep'] }, t] }, 0)).not.toHaveProperty('sweep');
    expect(layerConfig({ ...cfg, layers: [l1, { ...t, sweep: undefined }] }, 1)).not.toHaveProperty('sweep');
  });
});

describe('TB-16 the run', () => {
  it('[PR-21][IN-26] the charges\' refusals name the layer, hopper and blend; nothing is charged after the run; the run starts with every layer charged', () => {
    const run = startRun(TB16);
    expect(refusal(run, charge('L9', 'H1', 'BLEND_L1'))).toBe('L9 is not a layer of p (TB16-LAYER; PR-21, IN-26) (TB16-LAYER; PR-21, IN-26)');
    expect(refusal(run, charge('L1', 'H2', 'BLEND_L1'))).toBe("Layer L1 is fed from hopper H1, not H2: the layers' hoppers are never swapped (TB16-HOPPER; PR-21, IN-26) (TB16-HOPPER; PR-21, IN-26)");
    expect(refusal(run, charge('L1', 'H1', 'BLEND_L2'))).toBe('The container scanned holds BLEND_L2; layer L1 takes BLEND_L1 only (TB16-WRONG-BLEND; PR-21, IN-26) (TB16-WRONG-BLEND; PR-21, IN-26)');
    expect(refusal(run, { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toBe("Layer L1, T has no blend charged into its hopper: the run starts with every layer's kit charged (TB16-LAYER-UNCHARGED; PR-21) (TB16-LAYER-UNCHARGED; PR-21)");
    run.entry('p', charge('L1', 'H1', 'BLEND_L1'));
    expect(Object.values(run.state.entries).find((e) => e.kind === 'HOPPER_CHARGE')?.data).toStrictEqual({ layer: 'L1', hopper: 'H1', blend: 'BLEND_L1', chargeId: U(1), chargedBy: OP1.id });
    expect(refusal(run, { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toMatch(/^Layer T has no blend charged/);
    expect(refusal(run, { kind: 'SETPOINT', tag: 'x' })).toMatch(/TB16-ENTRY|ENG-/);
    run.entry('p', charge('T', 'H2', 'BLEND_L2', 2));
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
    expect(refusal(run, group('X', '1500.0'))).toBe('A check at p@ names the stream of one of its layers (L1, T) (TB16-STREAM; PR-29, IN-35) (TB16-STREAM; PR-29, IN-35)');
    run.entry('p', { kind: 'RUN_END' });
    expect(refusal(run, charge('L1', 'H1', 'BLEND_L1', 3))).toBe('The run of p@ has ended: no more charges (TB16-ENDED; PR-21) (TB16-ENDED; PR-21)');
  });

  it('[PR-21][IN-26] a trilayer run (slice 7q, C9): three layers, each charged from its own hopper with its own blend, and the run starts only with all three charged', () => {
    const tri = { ...cfg, layers: [l1, { ...l1, id: 'L2', hopper: 'H3', stage: 'BLEND_L3' }, t] };
    const p = fixturePhase(TB16, { config: tri as never });
    const run = startRun(TB16, blockMbr(TB16, p));
    run.entry('p', charge('L1', 'H1', 'BLEND_L1'));
    run.entry('p', charge('T', 'H2', 'BLEND_L2', 2));
    expect(refusal(run, { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toMatch(/^Layer L2 has no blend charged into its hopper/);
    expect(refusal(run, charge('L2', 'H3', 'BLEND_L1', 3))).toMatch(/TB16-WRONG-BLEND/);
    run.entry('p', charge('L2', 'H3', 'BLEND_L3', 3));
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
    expect(Object.values(run.state.entries).filter((e) => e.kind === 'HOPPER_CHARGE').map((e) => e.data['layer'])).toEqual(['L1', 'T', 'L2']);
  });

  it('[IN-35][PR-29] a missed check on any layer is listed once by the next entry, layer by layer, with its title', () => {
    const run = startRun(TB16);
    run.entry('p', charge('L1', 'H1', 'BLEND_L1'));
    run.entry('p', charge('T', 'H2', 'BLEND_L2', 2));
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
    run.advance(21n * MIN);
    const entries = () => Object.values(run.state.entries).filter((e) => e.stepKey === 'p@');
    expect(missedOf({ config: cfg, entries: () => entries(), nowUs: run.nowUs } as never).map((m) => `${m.stream}:${m.test}`)).toEqual(['L1:WEIGHT', 'T:WEIGHT', 'T:PHYSICAL', 'T:SWEEP']);
    run.entry('p', group('L1', '1500.0'));
    expect(run.exceptions('IPC_CHECK_MISSED').map((e) => e.title)).toEqual([
      "Missed in-process check at p@: weight of layer L1, weight of layer T, physical of layer T, sweep of layer T; the press output since that layer's last passing check is held and the steps after it wait for a deviation",
    ]);
  });

  it('[IN-35][PR-29][PR-21] PERFORMED lists each problem once across the layers', () => {
    const run = startRun(TB16);
    const msg = run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) }).refusal?.message ?? '';
    expect(msg).toContain('Layer L1, T of p@ was never charged (TB16-LAYER-UNCHARGED; PR-21)');
    expect(msg.split('TB11-RUNNING').length - 1).toBe(1);
  });
});
