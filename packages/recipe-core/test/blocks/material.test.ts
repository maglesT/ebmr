/**
 * Material blocks (G-07 weighing and dispensing, G-08 charge-in, G-22 output containers, G-23 returns and
 * destruction): engine-level rules. Material status arrives with each entry; the database-backed status
 * check and reservations come with Phase 3.
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent, PhaseNode } from '../../src/flow/model.ts';
import { netOf, sumDecimals } from '../../src/blocks/generic/common.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, done, OP1, OP2, param, Run, sig, T0, VER1 } from '../engine/support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const DAY = 86_400_000_000n;

function dispensing(extra: Partial<PhaseNode> = {}, markets: string[] = ['IN']): MbrContent {
  const mbr = mbrWith(seq('ops', phase('d', { block: { type: 'G-07', version: '1' }, config: { tolerance: { percent: '0.5' } }, records: ['disp'], reads: ['target'], consumes: ['B-API'], ...extra }), phase('z')), {
    inputs: [{ id: 'target', name: 'Target', source: 'MASTER_DATA', valueType: 'DECIMAL', unit: 'kg' }],
    bom: [{ id: 'B-API', material: 'MAT-API', role: 'ACTIVE', quantity: { value: '8', unit: 'kg' } }],
    references: [
      { id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) },
      { id: 'MAT-API', kind: 'MATERIAL', code: 'API-0042', version: '3', hash: 'c'.repeat(64) },
    ],
    parameters: [param('disp', { precision: { kind: 'DECIMALS', digits: 3 } })],
  });
  mbr.header.marketSet = markets;
  return mbr;
}

function issueDispensing(mbrMarkets: string[] = ['IN']): Run {
  const run = Run.issue(define(dispensing({}, mbrMarkets)), { inputs: { target: { value: { kind: 'DECIMAL', value: '8.000', unit: 'kg' }, source: 'calc' } }, marketSet: mbrMarkets }, T0);
  run.start('d');
  return run;
}

const weigh = (extra: Record<string, unknown> = {}, lot: Record<string, unknown> = {}): Record<string, unknown> & { kind: string } => ({
  kind: 'CONTAINER_WEIGHING',
  item: 'disp',
  bomLine: 'B-API',
  container: 'C1',
  lot: { id: 'AR-1', material: 'API-0042', status: 'RELEASED', identityTested: true, ...lot },
  gross: '9.000',
  tare: '1.000',
  unit: 'kg',
  balance: 'BAL-1',
  source: 'DEVICE',
  ...extra,
});

function entry(run: Run, e: Record<string, unknown> & { kind: string }, step = 'd') {
  return run.exec({ type: 'RECORD_ENTRY', actor: OP1, step, entry: e });
}

describe('G-07 weighing and dispensing', () => {
  it('[PR-18][IN-23] a quarantined lot, an expired lot, a lot past retest and the wrong material are hard-blocked with no override', () => {
    const run = issueDispensing();
    expect(entry(run, weigh({}, { status: 'QUARANTINE' })).refusal?.code).toBe('G07-LOT-STATUS');
    expect(entry(run, weigh({}, { expiresAtUs: String(T0 - DAY) })).refusal?.code).toBe('G07-LOT-EXPIRED');
    expect(entry(run, weigh({}, { retestAtUs: String(T0 - 1n) })).refusal?.code).toBe('G07-LOT-RETEST');
    expect(entry(run, weigh({}, { material: 'LACTOSE' })).refusal?.code).toBe('G07-WRONG-MATERIAL');
    expect(entry(run, weigh({}, { retestAtUs: String(T0 + DAY) })).accepted).toBe(true);
  });

  it('[IN-24] for a batch with a US market, a lot without an identity-test result is blocked', () => {
    const run = issueDispensing(['IN', 'US']);
    expect(entry(run, weigh({}, { identityTested: false })).refusal?.code).toBe('G07-LOT-IDENTITY');
    const india = issueDispensing(['IN']);
    expect(entry(india, weigh({}, { identityTested: false })).accepted).toBe(true);
  });

  it('[PR-19][INV-25] the net weight is computed from gross and tare and the dispensed total from the containers; the label carries the batch identity', () => {
    const run = issueDispensing();
    run.entry('d', weigh({ gross: '5.500', tare: '1.500', container: 'C1' }));
    run.entry('d', weigh({ gross: '5.000', tare: '1.000', container: 'C2' }));
    run.refused({ type: 'RECORD_DATA', actor: OP1, step: 'd', item: 'disp', value: { kind: 'DECIMAL', value: '8.000', unit: 'kg' }, source: { mode: 'DEVICE', device: 'B' } }, 'ENG-DERIVED-TYPED');
    run.perform('d');
    expect(run.value('disp', 'd')).toBe('8.000');
    const e = Object.values(run.state.entries)[0]?.data;
    expect(e?.['net']).toBe('4.000');
    expect(e?.['label']).toEqual({ component: 'MAT-API', lot: 'AR-1', quantity: '4.000 kg', batch: 'B0001', product: 'P', container: 'C1' });
    expect(Object.keys(run.state.containers)).toEqual(['C1', 'C2']);
  });

  it('[INV-25][PR-19][DI-30] a computed net and the dispensed total keep the resolution of the weighings, in the entry, the label, the container and the recorded value (engine 1.2.0; lead TODO T2)', () => {
    const run = issueDispensing();
    run.entry('d', weigh({ gross: '51.250', tare: '1.250', container: 'C1' }));
    run.entry('d', weigh({ gross: '5.50', tare: '1.125', container: 'C2' }));
    const [first, second] = Object.values(run.state.entries).map((x) => x.data);
    expect({ net: first?.['net'], label: (first?.['label'] as { quantity: string }).quantity, container: run.state.containers['C1']?.net }).toEqual({
      net: '50.000',
      label: '50.000 kg',
      container: { value: '50.000', unit: 'kg' },
    });
    // The finer of the two weighings sets the resolution of the net; the finest net, that of the total.
    expect(second?.['net']).toBe('4.375');
    run.perform('d');
    expect(run.value('disp', 'd')).toBe('54.375');
  });

  it('[INV-25][PR-19] netOf and sumDecimals are exact and keep the written resolution: nothing is rounded, no trailing zero dropped (T2)', () => {
    expect([netOf('51.250', '1.250'), netOf('26.10', '1.05'), netOf('10', '2.5'), netOf('7', '2'), netOf('1.0', '1.0')]).toEqual([
      { ok: true, net: '50.000' },
      { ok: true, net: '25.05' },
      { ok: true, net: '7.5' },
      { ok: true, net: '5' },
      { ok: false, message: 'the net weight (1.0 - 1.0) is not positive' },
    ]);
    expect([sumDecimals(['12.55', '12.55']), sumDecimals(['4.000', '4.4']), sumDecimals(['3', '4']), sumDecimals([])]).toEqual(['25.10', '8.400', '7', '0']);
  });

  it('[PR-19][PR-08] a total outside the tolerance of its target cannot be confirmed without an exception and a deviation', () => {
    const run = issueDispensing();
    run.entry('d', weigh({ gross: '9.100', tare: '1.000' }));
    run.perform('d');
    expect(run.exceptions('DISPENSE_OUT_OF_TOLERANCE')).toHaveLength(1);
    run.verify('d');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'z' }, 'ENG-BLOCKED');
  });

  it('[PR-20][PR-14][DI-30] with the scale offline (manual weighing) the step needs a second, different person, and the fallback is an exception', () => {
    const mbr = dispensing({ signatures: { perform: { role: 'OPERATOR' } } });
    const run = Run.issue(define(mbr), { inputs: { target: { value: { kind: 'DECIMAL', value: '8.000', unit: 'kg' }, source: 'calc' } } }, T0);
    run.start('d');
    run.entry('d', weigh({ source: 'MANUAL' }));
    expect(run.exceptions('MANUAL_ENTRY_FALLBACK')).toHaveLength(1);
    run.perform('d');
    expect(run.status('d')).toBe('AWAITING_VERIFICATION');
    run.refused({ type: 'VERIFY', actor: { ...OP1, roles: ['OPERATOR', 'PRODUCTION_VERIFIER'] }, step: 'd', signature: sig('VERIFIED', OP1) }, 'ENG-SEGREGATION');
    run.verify('d', [], VER1, 'CONTAINER_CHECKED');
  });

  it('[PR-21][PR-19] a dispensing step cannot be performed while a BOM line it dispenses has no container', () => {
    const run = issueDispensing();
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'd', signature: sig('PERFORMED', OP1) }, 'G07-BOM-INCOMPLETE');
  });
});

function chargeMbr(): MbrContent {
  return mbrWith(
    seq(
      'ops',
      phase('make', { block: { type: 'G-22', version: '1' }, produces: ['I-KIT'] }),
      { kind: 'replicate', id: 'R', name: 'Sub-lots', count: { mode: 'RUNTIME', min: 2, max: 2, reasonRequired: true }, instances: 'SEQUENTIAL', subLotPrefix: 'GS', body: seq('b', phase('wet', { block: { type: 'G-22', version: '1' }, produces: ['I-WET'] }), phase('load', { block: { type: 'G-08', version: '1' }, uses: ['I-WET'] })) },
      phase('charge', { block: { type: 'G-08', version: '1' }, uses: ['I-KIT'] }),
    ),
    { intermediates: [{ id: 'I-KIT', name: 'Kit' }, { id: 'I-WET', name: 'Wet mass' }] },
  );
}

const out = (intermediate: string, container?: string): Record<string, unknown> & { kind: string } => ({ kind: 'OUTPUT_CONTAINER', intermediate, ...(container ? { container } : {}), gross: '2.0', tare: '1.0', unit: 'kg', balance: 'B', source: 'DEVICE' });

describe('G-08 identification and charge-in, G-22 output containers', () => {
  it('[PR-21] a wrong container is rejected, a missing container blocks completion, and a container is charged only once', () => {
    const run = Run.issue(define(chargeMbr()));
    run.start('make');
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'make', signature: sig('PERFORMED', OP1) }, 'G22-NO-CONTAINER');
    run.entry('make', out('I-KIT', 'K1'));
    run.entry('make', out('I-KIT', 'K2'));
    expect(Object.values(run.state.containers).map((c) => `${c.id}:${c.status}`)).toEqual(['K1:QUARANTINE', 'K2:QUARANTINE']);
    run.perform('make');
    run.verify('make');
    run.ok({ type: 'CHOOSE_REPLICATE_COUNT', actor: { id: 'SUP1', kind: 'PERSON', roles: ['PRODUCTION_SUPERVISOR'] }, construct: 'R', count: 2, reason: 'two parts' });
    for (const i of [1, 2]) {
      const f = [{ construct: 'R', index: i }];
      run.start('wet', f);
      run.entry('wet', out('I-WET', `W${i}a`), f);
      run.entry('wet', out('I-WET', `W${i}b`), f);
      run.perform('wet', f);
      run.verify('wet', f);
      run.start('load', f);
      // A container of another sub-lot is refused: containers never cross sub-lots (W1b is still unconsumed).
      if (i === 2) expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'load', context: f, entry: { kind: 'CHARGE_CONTAINER', container: 'W1b', scannedBatch: 'B0001' } }).refusal?.code).toBe('G08-OTHER-SUBLOT');
      // Inside a sub-lot a partial charge is allowed (the MBR does not say which containers go where).
      run.entry('load', { kind: 'CHARGE_CONTAINER', container: `W${i}a`, scannedBatch: '$BATCH' }, f);
      run.perform('load', f);
      run.verify('load', f);
    }
    run.start('charge');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'charge', entry: { kind: 'CHARGE_CONTAINER', container: 'X9', scannedBatch: 'B0001' } }).refusal?.code).toBe('G08-WRONG-CONTAINER');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'charge', entry: { kind: 'CHARGE_CONTAINER', container: 'K1', scannedBatch: 'B0002' } }).refusal?.code).toBe('G08-LABEL');
    run.entry('charge', { kind: 'CHARGE_CONTAINER', container: 'K1', scannedBatch: '$BATCH' });
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'charge', entry: { kind: 'CHARGE_CONTAINER', container: 'K1', scannedBatch: 'B0001' } }).refusal?.code).toBe('G08-CONSUMED');
    const r = run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'charge', signature: sig('PERFORMED', OP1) }, 'G08-MISSING-CONTAINER');
    expect(r.message).toContain('K2');
    run.entry('charge', { kind: 'CHARGE_CONTAINER', container: 'K2', scannedBatch: '$BATCH' });
    run.perform('charge');
    run.refused({ type: 'VERIFY', actor: OP1, step: 'charge', signature: sig('CHARGE_IN_VERIFIED', OP1) }, 'ENG-ROLE');
    run.verify('charge', [], VER1, 'CHARGE_IN_VERIFIED');
  });

  it('[PR-21][PR-13] a container holding an intermediate the step does not charge is rejected as unplanned', () => {
    const mbr = mbrWith(seq('ops', phase('make', { block: { type: 'G-22', version: '1' }, produces: ['I-A', 'I-B'] }), phase('use', { block: { type: 'G-08', version: '1' }, uses: ['I-A'] })), {
      intermediates: [{ id: 'I-A', name: 'A' }, { id: 'I-B', name: 'B' }],
    });
    const run = Run.issue(define(mbr));
    run.start('make');
    run.entry('make', out('I-A', 'A1'));
    run.entry('make', out('I-B', 'B1'));
    run.perform('make');
    run.verify('make');
    run.start('use');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'use', entry: { kind: 'CHARGE_CONTAINER', container: 'B1', scannedBatch: 'B0001' } }).refusal?.code).toBe('G08-UNPLANNED');
  });
});

describe('G-23 returns, rejects and destruction', () => {
  function disposal(check: 'VERIFIED' | 'WITNESSED'): Run {
    const run = Run.issue(define(mbrWith(seq('ops', phase('x', { block: { type: 'G-23', version: '1' }, signatures: { perform: { role: 'OPERATOR' }, check: { meaning: check, role: 'VERIFIER' } } }), phase('z')))));
    run.start('x');
    return run;
  }
  const disp = (e: Record<string, unknown>) => ({ kind: 'DISPOSAL', material: 'Carton', quantity: { value: '12', unit: '1' }, ...e });

  it('[PR-40] batch-coded leftovers can only be destroyed, never returned to stock; destruction records its method and is witnessed', () => {
    const run = disposal('WITNESSED');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: disp({ category: 'RETURN_TO_STORES', batchCoded: true }) }).refusal?.code).toBe('G23-BATCH-CODED');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: disp({ category: 'DESTRUCTION', batchCoded: true }) }).refusal?.code).toBe('G23-METHOD');
    run.entry('x', disp({ category: 'DESTRUCTION', batchCoded: true, method: 'Shredding' }));
    run.entry('x', disp({ category: 'RETURN_TO_STORES', batchCoded: false }));
    run.perform('x');
    run.verify('x', [], VER1, 'WITNESSED');
    const verified = disposal('VERIFIED');
    expect(verified.exec({ type: 'RECORD_ENTRY', actor: OP2, step: 'x', entry: disp({ category: 'DESTRUCTION', method: 'Incineration' }) }).refusal?.code).toBe('G23-WITNESS');
  });

  it('[PR-46][IN-35] rejects are held in an identified container', () => {
    const run = disposal('VERIFIED');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: disp({ category: 'REJECT_CONTAINER' }) }).refusal?.code).toBe('G23-CONTAINER');
    run.entry('x', disp({ category: 'REJECT_CONTAINER', container: 'REJ-1' }));
    done(run, 'x');
    expect(run.status('x')).toBe('COMPLETED');
  });
});
