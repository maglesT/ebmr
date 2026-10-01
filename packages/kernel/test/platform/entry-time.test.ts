/**
 * The two-times helpers in TypeScript (build outline 5.6; invariant INV-16, control DI-27): which
 * time drives time constraints, who may state a device time, what makes an entry late, and at which
 * instants a status guard is evaluated. They mirror platform.time_basis,
 * platform.check_time_trust_source, platform.is_late_entry and platform.guard_instants (kernel 0530),
 * which remain the authority and are tested in time-model.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAtInstants, guardInstants, isLateEntry, mayClaimTrust, timeBasis, TIME_TRUST_LEVELS, type GuardInstant, type TimeTrust } from '../../src/time/entry-time.ts';
import { Instant } from '../../src/time/instant.ts';

const recorded = Instant.parse('2026-09-27T10:00:00Z');
const occurred = Instant.parse('2026-09-27T09:15:00Z');

describe('time basis', () => {
  it('[INV-16] occurred_at drives time constraints only when it is DEVICE_SYNCED; otherwise recorded_at does', () => {
    expect(timeBasis(recorded, { at: occurred, trust: 'DEVICE_SYNCED' })).toEqual({ basis: 'OCCURRED_AT', at: occurred });
    for (const trust of ['DEVICE_UNSYNCED', 'USER_CLAIMED', 'PAPER'] as const) {
      expect([trust, timeBasis(recorded, { at: occurred, trust })]).toEqual([trust, { basis: 'RECORDED_AT', at: recorded }]);
    }
    expect(timeBasis(recorded)).toEqual({ basis: 'RECORDED_AT', at: recorded });
  });
});

describe('trust a command may claim', () => {
  it('[DI-27][INV-16] a device time comes only from an instrument interface or gateway; a person may state USER_CLAIMED or PAPER', () => {
    const allowed: Record<'UI' | 'API' | 'INTEGRATION' | 'SYSTEM', TimeTrust[]> = {
      UI: ['USER_CLAIMED', 'PAPER'],
      API: ['USER_CLAIMED', 'PAPER'],
      INTEGRATION: [...TIME_TRUST_LEVELS],
      SYSTEM: [...TIME_TRUST_LEVELS],
    };
    for (const [source, trusts] of Object.entries(allowed) as [keyof typeof allowed, TimeTrust[]][]) {
      for (const trust of TIME_TRUST_LEVELS) {
        expect([source, trust, mayClaimTrust(source, trust)]).toEqual([source, trust, trusts.includes(trust)]);
      }
    }
  });
});

describe('late entries', () => {
  it('[INV-16] an entry is late exactly when a person claimed its event time (USER_CLAIMED or PAPER)', () => {
    expect(isLateEntry()).toBe(false);
    expect(TIME_TRUST_LEVELS.map((trust) => [trust, isLateEntry({ trust })])).toEqual([
      ['DEVICE_SYNCED', false],
      ['DEVICE_UNSYNCED', false],
      ['USER_CLAIMED', true],
      ['PAPER', true],
    ]);
  });
});

describe('instants for status guards', () => {
  it('[INV-16] a claimed event time adds an evaluation before the recorded time; without one, or at the same instant, only recorded_at is evaluated', () => {
    expect(guardInstants(recorded, occurred)).toEqual([
      { role: 'OCCURRED_AT', at: occurred },
      { role: 'RECORDED_AT', at: recorded },
    ]);
    expect(guardInstants(recorded)).toEqual([{ role: 'RECORDED_AT', at: recorded }]);
    // The same instant written with another offset is not a second instant.
    expect(guardInstants(recorded, Instant.parse('2026-09-27T15:30:00+05:30'))).toEqual([{ role: 'RECORDED_AT', at: recorded }]);
  });

  it('[INV-16] the guard runs at every instant in order, and only a pass at all of them avoids an exception', async () => {
    const instants = guardInstants(recorded, occurred);
    const seen: string[] = [];
    const allPass = await evaluateAtInstants(instants, (at) => {
      seen.push(at.toIsoString());
      return { passed: true };
    });
    expect(seen).toEqual(['2026-09-27T09:15:00.000000Z', '2026-09-27T10:00:00.000000Z']);
    // A passing evaluation carries no reason property at all (exactOptionalPropertyTypes).
    expect(allPass).toStrictEqual({
      evaluations: [
        { role: 'OCCURRED_AT', at: occurred, passed: true },
        { role: 'RECORDED_AT', at: recorded, passed: true },
      ],
      passed: true,
      exceptionRequired: false,
    });

    const failsAtEvent = await evaluateAtInstants(instants, (at) =>
      Promise.resolve(at.isBefore(recorded) ? { passed: false, reason: 'line clearance not signed at the event time' } : { passed: true }),
    );
    expect(failsAtEvent).toStrictEqual({
      evaluations: [
        { role: 'OCCURRED_AT', at: occurred, passed: false, reason: 'line clearance not signed at the event time' },
        { role: 'RECORDED_AT', at: recorded, passed: true },
      ],
      passed: false,
      exceptionRequired: true,
    });

    const failsWithoutReason = await evaluateAtInstants([{ role: 'RECORDED_AT', at: recorded }], () => ({ passed: false }));
    expect(failsWithoutReason).toStrictEqual({
      evaluations: [{ role: 'RECORDED_AT', at: recorded, passed: false }],
      passed: false,
      exceptionRequired: true,
    });
  });

  it('[INV-16] evaluating at no instant at all is refused, never reported as a pass', async () => {
    const none: GuardInstant[] = [];
    await expect(evaluateAtInstants(none, () => ({ passed: true }))).rejects.toThrow(/^at least one instant is required$/);
  });
});
