/**
 * TB-17@1 compression-line reject and detection devices (IN-36, IN-35) at their edges: the devices read from the
 * configuration (default interval, test pieces), the challenge order per device, the interval at its boundary, the held
 * exceptions with their titles, the stored entries, the reject gate and de-duster paths, PERFORMED per device, the
 * definition checks and the nominal path. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { engine, type flow } from '@ebmr/recipe-core/pure';
import { devicesOf, TB17 } from '../../../src/blocks/tb-17.ts';
import { blockMbr, fixturePhase, OP1, sig, startRun } from './support.ts';

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MIN = 60_000_000n;
const GATE = { device: 'RG-01', intervalMinutes: 30 };
const challenge = (timing: string, passed = true, device = 'METAL_DETECTOR', id = 20): Entry => ({ kind: 'CHALLENGE', challengeId: U(id), device, timing, passed });
const run2 = (config: Json) => startRun(TB17, blockMbr(TB17, fixturePhase(TB17, { config: config as never })));
const refusal = (run: ReturnType<typeof startRun>, entry: Entry) => run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry }).message;
const perform = (run: ReturnType<typeof startRun>) => run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
const last = (run: ReturnType<typeof startRun>, kind: string) => Object.values(run.state.entries).filter((e) => e.kind === kind).at(-1)?.data;

describe('TB-17 devices and challenges', () => {
  it('[IN-36] the devices of a configuration: the metal detector with its pieces, the reject gate, the default interval of 120 min', () => {
    expect(devicesOf({ metalDetector: { device: 'MD', pieces: [{ kind: 'FERROUS', size: { value: '0.8', unit: 'mm' } }, 'x', { kind: 'STAINLESS' }] }, rejectGate: GATE })).toEqual([
      { device: 'METAL_DETECTOR', code: 'MD', intervalUs: 120n * MIN, pieces: [{ kind: 'FERROUS', size: { value: '0.8', unit: 'mm' } }, { kind: 'STAINLESS', size: { value: '', unit: '' } }] },
      { device: 'REJECT_GATE', code: 'RG-01', intervalUs: 30n * MIN, pieces: [] },
    ]);
    expect(devicesOf({ metalDetector: 'x' })).toEqual([]);
  });

  it('[IN-36][IN-35] challenges are per device: each starts with START; the interval is inclusive; a late and failed challenge holds with its titles; the stored challenge', () => {
    const run = run2({ ...(fixturePhase(TB17).config as Json), rejectGate: GATE });
    expect(refusal(run, challenge('INTERVAL'))).toBe('The first challenge of the METAL_DETECTOR is the START challenge (TB17-START-FIRST; IN-36, IN-35) (TB17-START-FIRST; IN-36, IN-35)');
    run.entry('p', challenge('START'));
    expect(refusal(run, challenge('START'))).toBe('The METAL_DETECTOR had its START challenge already (TB17-START-FIRST; IN-36) (TB17-START-FIRST; IN-36)');
    // The reject gate has its own order.
    expect(refusal(run, challenge('INTERVAL', true, 'REJECT_GATE'))).toMatch(/^The first challenge of the REJECT_GATE is the START challenge/);
    run.entry('p', challenge('START', true, 'REJECT_GATE'));
    run.advance(30n * MIN);
    run.entry('p', challenge('INTERVAL', true, 'REJECT_GATE'));
    expect(run.exceptions()).toEqual([]);
    expect(last(run, 'CHALLENGE')).toStrictEqual({ challengeId: U(20), device: 'REJECT_GATE', timing: 'INTERVAL', passed: true, recordedBy: OP1.id });
    run.advance(30n * MIN + 1n);
    run.entry('p', challenge('INTERVAL', false, 'REJECT_GATE'));
    expect(run.exceptions().map((e) => [e.type, e.title, e.severity, e.deviationRequired])).toEqual([
      ['CHALLENGE_OVERDUE', 'The REJECT_GATE RG-01 at p@ was challenged later than its interval after its previous challenge: the steps after it wait for a deviation', 'ACTION', true],
      ['DETECTOR_CHALLENGE_FAILED', 'The REJECT_GATE RG-01 at p@ failed its INTERVAL challenge: the tablets since its last passing challenge are held and the steps after it wait for a deviation', 'ACTION', true],
    ]);
    // The metal detector's interval is its own (120 min from its START).
    run.entry('p', challenge('END'));
    expect(run.exceptions().map((e) => e.type)).toEqual(['CHALLENGE_OVERDUE', 'DETECTOR_CHALLENGE_FAILED']);
    expect(refusal(run, challenge('INTERVAL'))).toBe('The METAL_DETECTOR had its END challenge (TB17-AFTER-END; IN-36) (TB17-AFTER-END; IN-36)');
  });

  it('[IN-36][IN-35] devices, rejects and de-dusting the MBR does not configure are refused, with their messages; the entries are stored as recorded', () => {
    const run = run2({ ...(fixturePhase(TB17).config as Json), deDuster: undefined });
    expect(refusal(run, challenge('START', true, 'REJECT_GATE'))).toBe('The MBR configures no REJECT_GATE for p (TB17-DEVICE; IN-36) (TB17-DEVICE; IN-36)');
    expect(refusal(run, { kind: 'REJECT_COUNT', device: 'DEDUSTER', count: '1', disposition: 'DESTRUCTION' })).toBe('The MBR configures no DEDUSTER for p (TB17-DEVICE; IN-35) (TB17-DEVICE; IN-35)');
    expect(refusal(run, { kind: 'DEDUSTING', deDuster: 'DD-01', inUse: true })).toBe('DD-01 is not the de-duster the MBR names (TB17-DEDUSTER; IN-35) (TB17-DEDUSTER; IN-35)');
    run.entry('p', { kind: 'REJECT_COUNT', device: 'SETUP', count: '7', disposition: 'DESTRUCTION' });
    expect(last(run, 'REJECT_COUNT')).toStrictEqual({ device: 'SETUP', count: '7', disposition: 'DESTRUCTION', recordedBy: OP1.id });
    const dd = run2(fixturePhase(TB17).config);
    dd.entry('p', { kind: 'REJECT_COUNT', device: 'DEDUSTER', count: '2', disposition: 'DESTRUCTION' });
    dd.entry('p', { kind: 'DEDUSTING', deDuster: 'DD-01', inUse: false });
    expect(last(dd, 'DEDUSTING')).toStrictEqual({ deDuster: 'DD-01', inUse: false, recordedBy: OP1.id });
    // A de-duster recorded as not in use does not satisfy PERFORMED.
    dd.entry('p', challenge('START'));
    dd.entry('p', { kind: 'REJECT_COUNT', device: 'METAL_DETECTOR', count: '0', disposition: 'DESTRUCTION' });
    dd.entry('p', challenge('END'));
    expect(perform(dd).refusal?.message).toMatch(/^Record the de-duster in use \(TB17-NO-DEDUSTING; IN-35\)/);
  });

  it('[IN-36][IN-35] PERFORMED needs, for each device, a passing END challenge and its rejects; a failing END does not count', () => {
    const run = run2({ metalDetector: (fixturePhase(TB17).config as Json)['metalDetector'], rejectGate: GATE });
    run.entry('p', challenge('START'));
    run.entry('p', challenge('START', true, 'REJECT_GATE'));
    run.entry('p', { kind: 'REJECT_COUNT', device: 'METAL_DETECTOR', count: '1', disposition: 'DESTRUCTION' });
    run.entry('p', challenge('END'));
    const msg = perform(run).refusal?.message ?? '';
    expect(msg).toContain('The REJECT_GATE RG-01 has no passing END challenge (TB17-END-CHALLENGE; IN-36, IN-35)');
    expect(msg).toContain('Record the rejects of the REJECT_GATE (TB17-NO-REJECT-COUNT; IN-35)');
    expect(msg).not.toContain('METAL_DETECTOR');
    run.entry('p', challenge('END', false, 'REJECT_GATE'));
    run.entry('p', { kind: 'REJECT_COUNT', device: 'REJECT_GATE', count: '1', disposition: 'DESTRUCTION' });
    expect(perform(run).refusal?.message).toMatch(/^The REJECT_GATE RG-01 has no passing END challenge/);
  });

  it('[IN-36][IN-35] definition checks: a device, and the metal detector\'s test pieces, each with a decimal size', () => {
    const P = (config: Json): string[] => {
      const check = TB17.checkConfig?.bind(TB17) as unknown as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string }[];
      const p = fixturePhase(TB17, { config: config as never });
      return check(p, p.config as Json, blockMbr(TB17, p)).filter((x) => x.code.startsWith('TB17')).map((x) => `${x.code}: ${x.message}`);
    };
    expect(P({})).toEqual([]);
    expect(P({ metalDetector: null, rejectGate: null, deDuster: 'DD' })).toEqual(['TB17-NO-DEVICE: Reject and detection step p configures neither a metal detector nor a reject gate']);
    expect(P({ metalDetector: null, rejectGate: GATE })).toEqual([]);
    const pieces = 'TB17-NO-PIECES: The metal detector of p names the test pieces it is challenged with (product- and site-specific; no default)';
    expect(P({ metalDetector: { device: 'MD', pieces: [] } })).toEqual([pieces]);
    expect(P({ metalDetector: { device: 'MD', pieces: [{ kind: 'FERROUS', size: { value: '0.8', unit: 'mm' } }, { kind: 'FERROUS', size: { value: 'x', unit: 'mm' } }] } })).toEqual([pieces]);
    expect(P({ metalDetector: { device: 'MD', pieces: [{ kind: 'FERROUS', size: { value: '0.8', unit: 'mm' } }] } })).toEqual([]);
  });

  it('[DI-34] the nominal path challenges each device at START and END around its rejects, then the de-duster in use', () => {
    const p = fixturePhase(TB17, { config: { rejectGate: GATE } });
    const m = blockMbr(TB17, p);
    const entries = TB17.simulatorModel?.nominalEntries({ phase: p, config: p.config, mbr: m, frames: [], containers: [], target: () => undefined }) ?? [];
    const own = entries.filter((x) => ['CHALLENGE', 'REJECT_COUNT', 'DEDUSTING'].includes(x.kind));
    expect(own).toEqual([
      { kind: 'CHALLENGE', challengeId: U(1700), device: 'METAL_DETECTOR', timing: 'START', passed: true },
      { kind: 'REJECT_COUNT', device: 'METAL_DETECTOR', count: '12', disposition: 'DESTRUCTION' },
      { kind: 'CHALLENGE', challengeId: U(1701), device: 'METAL_DETECTOR', timing: 'END', passed: true },
      { kind: 'CHALLENGE', challengeId: U(1702), device: 'REJECT_GATE', timing: 'START', passed: true },
      { kind: 'REJECT_COUNT', device: 'REJECT_GATE', count: '12', disposition: 'DESTRUCTION' },
      { kind: 'CHALLENGE', challengeId: U(1703), device: 'REJECT_GATE', timing: 'END', passed: true },
      { kind: 'DEDUSTING', deDuster: 'DD-01', inUse: true },
    ]);
    const q = fixturePhase(TB17, { config: { deDuster: undefined } as never });
    expect((TB17.simulatorModel?.nominalEntries({ phase: q, config: q.config, mbr: blockMbr(TB17, q), frames: [], containers: [], target: () => undefined }) ?? []).some((x) => x.kind === 'DEDUSTING')).toBe(false);
  });
});
