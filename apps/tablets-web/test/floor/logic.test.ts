/**
 * Pure floor logic (module C4): how an answer is read (saved, NOT SAVED, stale, another badge, refused) and the
 * plain words for an entry and for what changed on a stale step.
 */
import { describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { describeChanges, describeIntent } from '../../src/features/floor/describe.ts';
import { classifyOutcome } from '../../src/features/floor/outcome.ts';
import { envelope } from './support.tsx';

describe('classifyOutcome', () => {
  it('[DI-28] no usable answer is NOT SAVED (lost): network failure, an unparseable response, the other installation, a retryable server failure', () => {
    expect(classifyOutcome({ ok: false, error: { kind: 'NETWORK', message: 'x' } }).kind).toBe('LOST');
    expect(classifyOutcome({ ok: false, error: { kind: 'PROTOCOL', status: 200, message: 'does not match' } }).kind).toBe('LOST');
    expect(classifyOutcome({ ok: false, error: { kind: 'PROTOCOL', status: 502, message: 'no envelope' } }).kind).toBe('LOST');
    expect(classifyOutcome({ ok: false, error: { kind: 'INSTALLATION_MISMATCH', expected: 'SANDBOX', actual: 'GMP' } }).kind).toBe('LOST');
    expect(classifyOutcome({ ok: false, error: { kind: 'REFUSAL', status: 503, envelope: envelope('NOT_SAVED', 'TIME-FAULT', {}, true) } }).kind).toBe('LOST');
  });

  it('[INV-40] a definite answer is never resent: stale, another person\'s badge, refusals (tap missing, proof, rate limit, rule)', () => {
    expect(classifyOutcome({ ok: true, value: 1, status: 200 }).kind).toBe('SAVED');
    expect(classifyOutcome({ ok: false, error: { kind: 'REFUSAL', status: 409, envelope: envelope('STALE', 'ENG-STALE') } }).kind).toBe('STALE');
    expect(classifyOutcome({ ok: false, error: { kind: 'REFUSAL', status: 409, envelope: envelope('SWITCH_USER', 'SWITCH_USER') } }).kind).toBe('SWITCH_USER');
    for (const [status, code] of [
      [428, 'TAP_REQUIRED'],
      [428, 'TAP_PIN_REQUIRED'],
      [403, 'DEVICE_PROOF'],
      [429, 'RATE_LIMITED'],
      [422, 'ENG-STEP-ORDER'],
      [409, 'EBMR-PLAT-041'],
      [503, 'INSTALLATION'],
    ] as const) {
      expect(classifyOutcome({ ok: false, error: { kind: 'REFUSAL', status, envelope: envelope('NOT_ALLOWED', code) } }).kind, code).toBe('REFUSED');
    }
  });
});

describe('describeIntent and describeChanges', () => {
  const g04 = example('step-g04-parameters');

  it('words each intent for the NOT SAVED notice', () => {
    expect(describeIntent({ type: 'RECORD_DATA', stepKey: 'p-blend@', item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } }, g04)).toBe('Blend time: 15 min');
    expect(describeIntent({ type: 'START_STEP', stepKey: 'p-blend@' }, g04)).toBe('Start step 2.1.4 Blend');
    expect(describeIntent({ type: 'RECORD_ENTRY', stepKey: 'x@', entry: { kind: 'CONTAINER_WEIGHING', item: 'i', bomLine: 'b', lotCode: 'TEST-L1', manual: { tare: '1.0', gross: '2.0', unit: 'kg' } } })).toContain('typed by hand');
    expect(describeIntent({ type: 'ATTACH_DEVIATION', exception: 'X-3', deviationRef: 'DEV-1' })).toBe('Link deviation DEV-1 to exception X-3');
  });

  it('lists what changed on a stale step: run version, status, new values, entries, exceptions and signatures', () => {
    const after = structuredClone(g04);
    after.run.version = 9;
    after.step.status = 'COMPLETED';
    after.step.statusText = 'Completed';
    after.signatures = [...after.signatures, { ...after.signatures[0]!, signatureId: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a99', meaningText: 'Verified by' }];
    const before = structuredClone(g04);
    before.fields[1]!.attempts = [];
    const changes = describeChanges(before, after);
    expect(changes).toContain('The run moved on (version 7 to 9).');
    expect(changes).toContain('Step status: Performed, waiting for verification → Completed.');
    expect(changes.some((c) => c.startsWith('Blender speed: 15 /min recorded by TEST-Arjun Das'))).toBe(true);
    expect(changes.some((c) => c.startsWith('New signature: Verified by TEST-Arjun Das'))).toBe(true);
    expect(describeChanges(g04, g04)).toEqual(['Nothing changed on this step; the run changed elsewhere (for example a timer or another step).']);
  });
});
