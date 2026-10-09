import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TimeConstraint } from '../../src/flow/model.ts';
import { evaluateTimeConstraint } from '../../src/flow/time.ts';

const MIN = 60_000_000n;

const mixing: TimeConstraint = {
  id: 'TC-MIX',
  name: 'Mix 10-15 min',
  kind: 'TIMER',
  from: { node: 'mix', event: 'START' },
  to: { node: 'mix', event: 'END' },
  min: { value: '10', unit: 'min' },
  max: { value: '15', unit: 'min' },
  warnBefore: { value: '2', unit: 'min' },
  source: { kind: 'VALIDATION_REPORT', ref: 'VR' },
  breach: 'EXCEPTION',
  pauses: 'EXCLUDED',
};

describe('time-constraint evaluation (INV-20 model part)', () => {
  it('[INV-20] no step completes before its minimum duration: the end event is refused until the minimum has elapsed', () => {
    const early = evaluateTimeConstraint(mixing, { fromUs: 0n, nowUs: 10n * MIN - 1n });
    expect(early.status).toBe('MIN_NOT_REACHED');
    expect(early.toEventAllowed).toBe(false);
    const onTime = evaluateTimeConstraint(mixing, { fromUs: 0n, nowUs: 10n * MIN });
    expect(onTime.toEventAllowed).toBe(true);
  });

  it('[INV-20] every maximum breach creates an exception, whether or not the end event has happened', () => {
    const running = evaluateTimeConstraint(mixing, { fromUs: 0n, nowUs: 15n * MIN + 1n });
    expect(running.status).toBe('MAX_BREACHED');
    expect(running.exception).toBe('MAX_BREACH');
    const ended = evaluateTimeConstraint(mixing, { fromUs: 0n, toUs: 16n * MIN, nowUs: 20n * MIN });
    expect(ended.exception).toBe('MAX_BREACH');
    const atMax = evaluateTimeConstraint(mixing, { fromUs: 0n, toUs: 15n * MIN, nowUs: 15n * MIN });
    expect(atMax.status).toBe('WITHIN');
    expect(atMax.exception).toBeUndefined();
  });

  it('[INV-20] an end event recorded before the minimum is an exception, never silent', () => {
    const r = evaluateTimeConstraint(mixing, { fromUs: 0n, toUs: 9n * MIN, nowUs: 9n * MIN });
    expect(r.exception).toBe('MIN_BREACH');
  });

  it('[INV-20] warns before the maximum and excludes pauses when the constraint says so', () => {
    expect(evaluateTimeConstraint(mixing, { fromUs: 0n, nowUs: 13n * MIN }).status).toBe('WARNING');
    expect(evaluateTimeConstraint(mixing, { fromUs: 0n, nowUs: 16n * MIN, pausedUs: 2n * MIN }).status).toBe('WARNING');
    expect(evaluateTimeConstraint(mixing, { fromUs: 0n, nowUs: 16n * MIN, pausedUs: 5n * MIN }).status).toBe('WITHIN');
    expect(evaluateTimeConstraint({ ...mixing, pauses: 'INCLUDED' }, { fromUs: 0n, nowUs: 16n * MIN, pausedUs: 2n * MIN }).status).toBe('MAX_BREACHED');
    expect(evaluateTimeConstraint(mixing, { nowUs: 99n * MIN }).status).toBe('NOT_STARTED');
  });

  it('[INV-20] the breach decision is monotonic: once breached, a later check is breached too', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 40n * MIN }), fc.bigInt({ min: 0n, max: 40n * MIN }), (a, b) => {
        const [t1, t2] = a <= b ? [a, b] : [b, a];
        const first = evaluateTimeConstraint(mixing, { fromUs: 0n, nowUs: t1 });
        const later = evaluateTimeConstraint(mixing, { fromUs: 0n, nowUs: t2 });
        return first.exception !== 'MAX_BREACH' || later.exception === 'MAX_BREACH';
      }),
      { numRuns: 300 },
    );
  });
});
