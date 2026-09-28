/**
 * Review reproducer F11: a routine single-factor badge tap must not reset the failed-attempt
 * counter that drives DI-19 lockout.
 *
 * iam.consecutive_failures (0160) counts FAILURE rows after the most recent SUCCESS of any method
 * or purpose. A BADGE_TAP for COMMAND needs no secret, but it still records a SUCCESS row, so every
 * tap the victim makes while working on a shared terminal sets the count back to zero. An attacker
 * guessing the victim's password then never reaches authn.lockout_threshold.
 *
 * Safe behaviour asserted here: an attacker makes (threshold - 1) wrong password guesses, the victim
 * taps their badge once to attribute an entry, and this repeats for three rounds. The account must
 * lock no later than the threshold-th failed guess, because the taps proved no secret. With the
 * defect the account is still unlocked after three rounds (12 failed guesses at the default
 * threshold of 5), with consecutive_failures back at 0 and no LOCKED event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '../../src/identity/authentication.ts';
import { AuthenticationFailedError } from '../../src/identity/errors.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seedActor, seedAdministration, seedAuthn, type SeededActor } from '../identity/seed.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAdministration(db);
});

afterAll(async () => {
  await db.drop();
});

const wrongPasswordLogin = (a: SeededActor) =>
  authenticate(seedAuthn(db), {
    method: 'PASSWORD', identifier: a.seed.loginName, secret: 'attacker-guess-not-the-password',
    deviceFingerprint: a.seed.deviceFingerprint, purpose: 'LOGIN',
  });

const badgeTap = (a: SeededActor) =>
  authenticate(seedAuthn(db), { method: 'BADGE_TAP', identifier: a.seed.badgeUid ?? '', deviceFingerprint: a.seed.deviceFingerprint, purpose: 'COMMAND' });

async function lockState(accountId: string): Promise<{ locked: boolean; consecutive: number; failures: number; lockEvents: number }> {
  const { rows } = await db.admin.query<{ locked: boolean; consecutive: number; failures: number; lock_events: number }>(
    `select iam.account_locked($1) as locked,
            iam.consecutive_failures($1)::int as consecutive,
            (select count(*)::int from iam.authn_attempt where account_id = $1 and outcome = 'FAILURE') as failures,
            (select count(*)::int from iam.account_lock_event where account_id = $1 and event = 'LOCKED') as lock_events`,
    [accountId],
  );
  const r = rows[0];
  return { locked: r?.locked ?? false, consecutive: r?.consecutive ?? -1, failures: r?.failures ?? -1, lockEvents: r?.lock_events ?? -1 };
}

describe('F11: a single-factor badge tap does not reset the lockout counter', () => {
  it('[DI-19] failed password guesses interleaved with the victim\'s badge taps still lock the account at the threshold', async () => {
    const threshold = Number(
      (await db.admin.query<{ n: number }>("select iam.policy_int('authn.lockout_threshold')::int as n")).rows[0]?.n,
    );
    expect(threshold).toBeGreaterThanOrEqual(3);
    expect(threshold).toBeLessThanOrEqual(5);

    // An operator on a SHARED terminal: each entry is attributed with a badge tap (INV-40).
    const victim = await seedActor(db, { deviceClass: 'SHARED', legalName: 'Shared Terminal Operator F11' });
    expect(victim.seed.badgeUid).toBeDefined();
    expect(await lockState(victim.accountId)).toMatchObject({ locked: false, failures: 0 });

    // Sanity: a badge tap is a single-factor event that proves no secret.
    const probe = await badgeTap(victim);
    expect(probe).toMatchObject({ purpose: 'COMMAND', components: ['BADGE'], restricted: false });

    let failedGuesses = 0;
    let lockedAtGuess: number | null = null;
    let tapsBetweenGuesses = 0;
    const rounds = 3;
    outer: for (let round = 1; round <= rounds; round++) {
      for (let i = 1; i < threshold; i++) {
        failedGuesses++;
        const err = await wrongPasswordLogin(victim).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, `guess ${failedGuesses} must fail`).toBeInstanceOf(AuthenticationFailedError);
        const failure = err as AuthenticationFailedError;
        expect(failure.reason).toBe('WRONG_SECRET');
        if (failure.locked) {
          lockedAtGuess = failedGuesses;
          break outer;
        }
      }
      // The victim keeps working: one legitimate badge tap to attribute an entry.
      await badgeTap(victim);
      tapsBetweenGuesses++;
    }

    const state = await lockState(victim.accountId);
    const evidence = `threshold=${threshold} failedGuesses=${failedGuesses} tapsBetweenGuesses=${tapsBetweenGuesses} ` +
      `lockedAtGuess=${String(lockedAtGuess)} state=${JSON.stringify(state)}`;

    // Safe behaviour: the badge taps proved no secret, so the account locks by the threshold-th guess.
    expect(state.locked, `account must be locked after ${failedGuesses} failed password guesses (${evidence})`).toBe(true);
    expect(state.lockEvents, evidence).toBe(1);
    expect(lockedAtGuess, evidence).not.toBeNull();
    expect(lockedAtGuess ?? Infinity, evidence).toBeLessThanOrEqual(threshold);

    // Once locked, the victim's own badge tap is refused too (so the guesses stop being masked).
    await expect(badgeTap(victim)).rejects.toMatchObject({ reason: 'ACCOUNT_LOCKED' });
  });
});
