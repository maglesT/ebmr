/**
 * G-21@1 printed materials, coding, challenges and serialisation (tablets spec K-19 to K-21; Phase 3 slice 4a): the
 * engine's side of every rule. The database holds the same rules (recipe-core 0580, 0581; tablets 0950 to 0952; their
 * own tests, which tamper with this handler to prove it).
 */
import { describe, expect, it } from 'vitest';
import { EngineDefinitionError } from '../../src/engine/definition.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, OP1, QA1, Run, T0 } from '../engine/support.ts';

/** The line lead, who also holds QA (the first-print role) so that one person's entries are signed by that person. */
const IPQA = { ...OP1, roles: [...OP1.roles, 'QA'] };

const MIN = 60_000_000n;
type Json = Record<string, unknown>;
const CARTON = { id: 'CARTON', material: 'MAT-CTN-10', artwork: { IN: 'ART-7' }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' }, coded: true };
const LEAFLET = { id: 'LEAFLET', material: 'MAT-LFT-1', artwork: { IN: 'L-3' }, unit: '1', issue: { need: '1000', allowancePercent: '0' }, counting: 'MANUAL_COUNT', limits: { maxUnexplainedPercent: '0.5' } };
const CONFIG = {
  items: [CARTON, LEAFLET],
  destructionStep: 'after',
  devices: [{ id: 'CODER', kind: 'PRINTER', serial: 'PRN-01' }, { id: 'CAM', kind: 'VISION', serial: 'VIS-01', every: { value: '30', unit: 'min' } }, { id: 'CW', kind: 'CHECKWEIGHER', triggers: ['START'] }],
  unit: 'LINE-1',
  markets: { IN: { gtin: '08901234567890', mrp: true } },
  serialisation: { markets: ['IN'] },
};

function line(config: Json = CONFIG): Run {
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [phase('pk', { block: { type: 'G-21', version: '1' }, config: config as never, signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } }), phase('after')] });
  const run = Run.issue(define(mbr), {}, T0);
  run.start('pk');
  return run;
}

const lot = (over: Json = {}): Json => ({ id: 'CTN-LOT-1', material: 'MAT-CTN-10', status: 'RELEASED', artwork: 'ART-7', ...over });
const issue = (over: Json = {}): Json & { kind: string } => ({ kind: 'ISSUE', item: 'CARTON', lot: lot(), scannedArtwork: 'ART-7', quantity: { value: '1020', unit: '1' }, ...over });
const recon = (item: string, over: Json = {}): Json & { kind: string } => ({ kind: 'RECONCILIATION', item, used: '1000', setupWaste: '10', damaged: '0', codedDestroyed: '10', uncodedReturned: '0', specimens: '0', ...over });
let evt = 0;
const event = (): string => `00000000-0000-4000-8000-${(evt += 1).toString(16).padStart(12, '0')}`;
/** A challenge as recorded now; a gateway device's names its result and the device's time (`at`, default now). */
const challenge = (run: Run, device: string, trigger: string, result = 'PASS', at: bigint = run.nowUs): Json & { kind: string } => ({ kind: 'CHALLENGE', device, trigger, result, ...(device === 'CW' ? {} : { event: event(), at: at.toString() }) });

/** The rule code an entry is refused with, or 'ok'. */
function verdict(run: Run, entry: Json & { kind: string }, who = OP1): string {
  const r = run.exec({ type: 'RECORD_ENTRY', actor: who, step: 'pk', context: [], entry });
  return r.accepted ? 'ok' : /G21-[A-Z-]+/.exec(r.refusal?.message ?? '')?.[0] ?? r.refusal?.code ?? '?';
}
const last = (run: Run, kind: string): Json => Object.values(run.state.entries).filter((e) => e.kind === kind).at(-1)?.data ?? {};
const types = (run: Run): string[] => run.exceptions().map((e) => e.type).sort();

function complete(run: Run): void {
  run.entry('pk', issue());
  run.entry('pk', issue({ item: 'LEAFLET', lot: lot({ id: 'LFT-LOT-1', material: 'MAT-LFT-1', artwork: 'L-3' }), scannedArtwork: 'L-3', quantity: { value: '1000', unit: '1' } }));
  run.entry('pk', { kind: 'FIRST_PRINT', device: 'CODER', job: 'PJ-1', approved: true }, [], IPQA);
  run.entry('pk', challenge(run, 'CAM', 'START'));
  run.entry('pk', challenge(run, 'CW', 'START'));
  run.entry('pk', { kind: 'SERIAL_POOL', poolId: 'POOL-1', market: 'IN', gtin: '08901234567890', quantity: '1000' });
}

describe('G-21@1 printed materials (K-19)', () => {
  it('[PR-32][PR-33] printed material is issued only from a released, unexpired lot of the item\'s material carrying the master\'s artwork for the market, scanned at the line, within the issue rule', () => {
    const run = line();
    expect({
      quarantine: verdict(run, issue({ lot: lot({ status: 'QUARANTINE' }) })),
      expired: verdict(run, issue({ lot: lot({ expiresAtUs: (T0 - 1n).toString() }) })),
      otherMaterial: verdict(run, issue({ lot: lot({ material: 'MAT-CTN-11' }) })),
      wrongScan: verdict(run, issue({ scannedArtwork: 'ART-6' })),
      obsoleteArtwork: verdict(run, issue({ lot: lot({ artwork: 'ART-6' }), scannedArtwork: 'ART-6' })),
      otherUnit: verdict(run, issue({ quantity: { value: '1020', unit: 'kg' } })),
      zero: verdict(run, issue({ quantity: { value: '0', unit: '1' } })),
      overRule: verdict(run, issue({ quantity: { value: '1020.1', unit: '1' } })),
      unknownItem: verdict(run, issue({ item: 'LABEL' })),
      exact: verdict(run, issue({ quantity: { value: '1000', unit: '1' } })),
      thenOver: verdict(run, issue({ quantity: { value: '21', unit: '1' } })),
      rest: verdict(run, issue({ quantity: { value: '20', unit: '1' } })),
    }).toEqual({
      quarantine: 'G21-LOT-STATUS', expired: 'G21-LOT-EXPIRED', otherMaterial: 'G21-MATERIAL', wrongScan: 'G21-SCAN', obsoleteArtwork: 'G21-ARTWORK', otherUnit: 'G21-UNIT',
      zero: 'G21-QUANTITY', overRule: 'G21-OVER-ISSUE', unknownItem: 'G21-ITEM', exact: 'ok', thenOver: 'G21-OVER-ISSUE', rest: 'ok',
    });
    expect(last(run, 'ISSUE')).toEqual({ item: 'CARTON', lot: lot(), artwork: 'ART-7', quantity: { value: '20', unit: '1' }, counting: 'ROLL_COUNTER', issuedBy: OP1.id });
    // A manual count is verified by a second person.
    expect(run.inst('pk')?.verificationRequired).toBe(false);
    run.entry('pk', issue({ item: 'LEAFLET', lot: lot({ id: 'LFT-LOT-1', material: 'MAT-LFT-1', artwork: 'L-3' }), scannedArtwork: 'L-3', quantity: { value: '10', unit: '1' } }));
    expect(run.inst('pk')?.verificationRequired).toBe(true);
  });

  it('[PR-39][IN-17][INV-32] the reconciliation is computed from what was issued, judged against the item\'s limits (absolute or percent), raises a release-blocking exception that waits for a deviation when outside, runs once per item and always: the step is not performed without it', () => {
    const run = line();
    complete(run);
    run.entry('pk', challenge(run, 'CAM', 'END'));
    expect(run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'pk', signature: { id: 'S', meaning: 'PERFORMED', signer: OP1.id } }).refusal?.message).toMatch(/G21-NOT-RECONCILED/);
    // 12 unaccounted against a limit of 0.
    run.entry('pk', recon('CARTON', { used: '990', setupWaste: '6', damaged: '2', codedDestroyed: '5', specimens: '5' }));
    expect(last(run, 'RECONCILIATION')).toMatchObject({ issued: '1020', unexplained: '12', withinLimits: false, unit: '1', counted: 'DEVICE' });
    expect(types(run)).toEqual(['PRINTED_RECONCILIATION']);
    const ex = run.exceptions()[0];
    expect(ex).toMatchObject({ deviationRequired: true, releaseBlocking: true, severity: 'ACTION', block: { until: 'DEVIATION' } });
    expect(verdict(run, recon('CARTON'))).toBe('G21-RECONCILED-TWICE');
    expect(verdict(run, issue({ quantity: { value: '1', unit: '1' } }))).toBe('G21-RECONCILED');
    // 0.5 % of 1000 issued: 5 unexplained is within, scaled exactly; an uncoded item has no coded surplus.
    expect(verdict(run, recon('LEAFLET', { used: '995.0', setupWaste: '0', codedDestroyed: '1' }))).toBe('G21-NOT-CODED');
    run.entry('pk', recon('LEAFLET', { used: '995.0', setupWaste: '0', codedDestroyed: '0' }));
    expect(last(run, 'RECONCILIATION')).toMatchObject({ issued: '1000', unexplained: '5.0', withinLimits: true, counted: 'TYPED' });
    expect(types(run)).toEqual(['PRINTED_RECONCILIATION']);
  });

  it('[PR-39][INV-32] a packaging master without reconciliation limits, without artwork for a market, coding without a destruction step, or challenging without a plant unit cannot be defined', () => {
    const problems = (config: Json): string[] => {
      try {
        line(config);
        return [];
      } catch (e) {
        if (e instanceof EngineDefinitionError) return e.problems.map((p) => /G21-[A-Z-]+/.exec(p.message)?.[0] ?? p.code);
        throw e;
      }
    };
    expect(problems({ items: [{ ...CARTON, limits: {} }], destructionStep: 'after' })).toEqual(['G21-NO-LIMITS']);
    expect(problems({ items: [{ ...CARTON, artwork: { US: 'ART-7' } }], destructionStep: 'after' })).toEqual(['G21-ARTWORK-MARKET']);
    expect(problems({ items: [{ ...CARTON, artwork: {} }], destructionStep: 'after' })).toEqual(['G21-ARTWORK-MARKET']);
    // Review 4a HIGH 2: every market the pack covers names its artwork; an issue checks the lot against each.
    const pack = (items: Json[]) => {
      const m = mbrWith({ kind: 'sequence', id: 'ops', children: [phase('pk', { block: { type: 'G-21', version: '1' }, config: { items, destructionStep: 'after' } as never, signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } }), phase('after')] });
      m.header.marketSet = ['IN', 'US'];
      return m;
    };
    expect(() => define(pack([CARTON]))).toThrow(/G21-ARTWORK-MARKET/);
    const run2 = Run.issue(define(pack([{ ...CARTON, artwork: { IN: 'ART-7', US: 'ART-9' } }])), { markets: ['IN', 'US'] } as never, T0);
    run2.start('pk');
    expect(verdict(run2, issue())).toBe('G21-ARTWORK');
    expect(problems({ items: [CARTON] })).toEqual(['G21-DESTRUCTION-STEP']);
    expect(problems({ devices: [{ id: 'CAM', kind: 'VISION' }] })).toEqual(['G21-NO-UNIT']);
    expect(problems({ serialisation: { markets: ['IN'] } })).toEqual(['G21-SERIAL-GTIN']);
    expect(problems({ markets: { IN: { gtin: '08901234567891' } } })).toEqual(['G21-GTIN-CHECK']);
    // There is no waiver: the configuration has no such member.
    expect(problems({ items: [CARTON], destructionStep: 'after', waiver: true })).toEqual(['ENG-DEF-CONFIG']);
  });
});

describe('G-21@1 printing and challenges (K-20)', () => {
  it('[IN-22][PR-37] a failed challenge, or one taken after its interval, stops the step until QA decides; a gateway device\'s challenge names its result, a manual one needs a second person', () => {
    const run = line();
    expect(verdict(run, { kind: 'CHALLENGE', device: 'CAM', trigger: 'START', result: 'PASS' })).toBe('G21-EVENT');
    expect(verdict(run, { kind: 'CHALLENGE', device: 'CW', trigger: 'START', result: 'PASS', event: event() })).toBe('G21-EVENT');
    expect(verdict(run, challenge(run, 'CODER', 'START'))).toBe('G21-DEVICE');
    run.entry('pk', challenge(run, 'CAM', 'START'));
    expect(last(run, 'CHALLENGE')).toMatchObject({ missed: false, result: 'PASS' });
    run.advance(31n * MIN);
    run.entry('pk', challenge(run, 'CAM', 'INTERVAL', 'FAIL'));
    expect(last(run, 'CHALLENGE')).toMatchObject({ missed: true, result: 'FAIL' });
    expect(types(run)).toEqual(['CHALLENGE_FAILED', 'CHALLENGE_MISSED']);
    for (const x of run.exceptions()) expect(x).toMatchObject({ qaOnly: true, block: { until: 'DISPOSITION', steps: [run.inst('pk')?.key] } });
    expect(run.inst('pk')?.verificationRequired).toBe(false);
    run.entry('pk', challenge(run, 'CW', 'START'));
    expect(run.inst('pk')?.verificationRequired).toBe(true);
  });

  it('[IN-22][PR-37][DI-31] a gateway device\'s challenge is timed by the device\'s result, never later than now and never before its last challenge: a result taken in time but recorded late is not missed, one taken late is', () => {
    const run = line();
    const t0 = run.nowUs;
    expect(verdict(run, { kind: 'CHALLENGE', device: 'CAM', trigger: 'START', result: 'PASS', event: event() })).toBe('G21-EVENT');
    expect(verdict(run, challenge(run, 'CAM', 'START', 'PASS', t0 + 1n))).toBe('G21-EVENT');
    run.entry('pk', challenge(run, 'CAM', 'START'));
    run.advance(40n * MIN);
    expect(verdict(run, challenge(run, 'CAM', 'INTERVAL', 'PASS', t0 - 1n))).toBe('G21-EVENT-ORDER');
    run.entry('pk', challenge(run, 'CAM', 'INTERVAL', 'PASS', t0 + 29n * MIN));
    expect(last(run, 'CHALLENGE')).toMatchObject({ missed: false, at: (t0 + 29n * MIN).toString() });
    run.advance(40n * MIN);
    run.entry('pk', challenge(run, 'CAM', 'INTERVAL', 'PASS', t0 + 59n * MIN));
    expect(last(run, 'CHALLENGE')).toMatchObject({ missed: false });
    expect(types(run)).toEqual([]);
    run.advance(40n * MIN);
    run.entry('pk', challenge(run, 'CAM', 'INTERVAL', 'PASS', run.nowUs));
    expect(last(run, 'CHALLENGE')).toMatchObject({ missed: true });
  });

  it('[PR-36][IN-16][IN-22] the step is performed only with each printer\'s first print approved by its role, each inspection device passed at start and end and not due', () => {
    const run = line({ ...CONFIG, items: [], serialisation: undefined });
    run.entry('pk', challenge(run, 'CAM', 'START'));
    run.entry('pk', challenge(run, 'CW', 'START'));
    const perform = () => run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'pk', signature: { id: `S${evt += 1}`, meaning: 'PERFORMED', signer: OP1.id } });
    expect(perform().refusal?.message).toMatch(/G21-NO-FIRST-PRINT/);
    expect(verdict(run, { kind: 'FIRST_PRINT', device: 'CODER', job: 'PJ-1', approved: true })).toBe('G21-APPROVER');
    expect(verdict(line(), { kind: 'FIRST_PRINT', device: 'CODER', job: 'PJ-1', approved: true }, { ...QA1, roles: [...QA1.roles, 'OPERATOR'] })).toBe('ok');
    expect(verdict(run, { kind: 'FIRST_PRINT', device: 'CAM', job: 'PJ-1', approved: true }, IPQA)).toBe('G21-DEVICE');
    run.entry('pk', { kind: 'FIRST_PRINT', device: 'CODER', job: 'PJ-1', approved: true }, [], IPQA);
    expect(perform().refusal?.message).toMatch(/G21-CHALLENGE-DUE/);
    run.advance(31n * MIN);
    run.entry('pk', challenge(run, 'CAM', 'END'));
    expect(types(run)).toEqual(['CHALLENGE_MISSED']);
  });
});

describe('G-21@1 serialisation (K-21, L-53)', () => {
  it('[PR-42] a pool per serialised market with the master\'s GTIN; its reconciliation closes only with zero unexplained and every serial accounted for, else release is blocked and the step is not performed', () => {
    const run = line({ ...CONFIG, items: [], devices: [] });
    expect(verdict(run, { kind: 'SERIAL_POOL', poolId: 'POOL-1', market: 'US', gtin: '08901234567890', quantity: '1000' })).toBe('G21-MARKET');
    expect(verdict(run, { kind: 'SERIAL_POOL', poolId: 'POOL-1', market: 'IN', gtin: '08901234567807', quantity: '1000' })).toBe('G21-GTIN');
    run.entry('pk', { kind: 'SERIAL_POOL', poolId: 'POOL-1', market: 'IN', gtin: '08901234567890', quantity: '1000' });
    expect(verdict(run, { kind: 'SERIAL_POOL', poolId: 'POOL-2', market: 'IN', gtin: '08901234567890', quantity: '10' })).toBe('G21-POOL-TWICE');
    const rec = (over: Json = {}): Json & { kind: string } => ({ kind: 'SERIAL_RECONCILIATION', poolId: 'POOL-1', commissioned: '990', decommissioned: '2', destroyed: '5', samples: '3', unusedReturned: '0', unexplained: '0', reportHash: 'b'.repeat(64), ...over });
    expect(verdict(run, rec({ poolId: 'POOL-9' }))).toBe('G21-POOL-UNKNOWN');
    run.entry('pk', rec({ commissioned: '989', unexplained: '1' }));
    expect(last(run, 'SERIAL_RECONCILIATION')).toMatchObject({ closed: false, quantity: '1000' });
    expect(types(run)).toEqual(['SERIAL_RECONCILIATION_OPEN']);
    expect(run.exceptions()[0]).toMatchObject({ releaseBlocking: true, deviationRequired: true });
    const perform = () => run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'pk', signature: { id: `P${evt += 1}`, meaning: 'PERFORMED', signer: OP1.id } });
    expect(perform().refusal?.message).toMatch(/G21-SERIALS-OPEN/);
    // Zero unexplained but a serial missing from the counts does not close either.
    run.entry('pk', rec({ commissioned: '989' }));
    expect(last(run, 'SERIAL_RECONCILIATION')).toMatchObject({ closed: false });
    run.entry('pk', rec());
    expect(last(run, 'SERIAL_RECONCILIATION')).toMatchObject({ closed: true });
    expect(perform().accepted).toBe(true);
  });
});
