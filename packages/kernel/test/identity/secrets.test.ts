/**
 * The authentication service's secret rules (identity/secrets.ts; DI-19 password policy, DI-15
 * initial secrets): argon2id hashing and verification, the equal-work verification for unknown
 * accounts, the policy read, the password, PIN and service-key rules with their exact refusal
 * texts, and the generator of initial secrets. credentials.test.ts shows the same rules through
 * changeSecret against the database; these tests pin each rule and its boundaries. No database.
 */
import { performance } from 'node:perf_hooks';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { IdentityError } from '../../src/identity/errors.ts';
import {
  assertAcceptableSecret,
  burnVerification,
  generateSecret,
  hashSecret,
  MAX_PIN_LENGTH,
  passwordProblems,
  pinProblems,
  readSecretPolicy,
  verifySecret,
  type SecretPolicy,
} from '../../src/identity/secrets.ts';

const policy: SecretPolicy = { passwordMinLength: 12, pinLength: 6, compromisedScreening: false };
const withPolicy = (change: Partial<SecretPolicy>): SecretPolicy => ({ ...policy, ...change });

/** The refusal assertAcceptableSecret throws: an IdentityError with code EBMR-IAM-055; returns its message. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(IdentityError);
    expect((e as IdentityError).code).toBe('EBMR-IAM-055');
    return (e as IdentityError).message;
  }
  throw new Error('expected a refusal');
}

describe('hashing and verification (argon2id)', () => {
  it('[DI-19] a secret is stored only as a salted argon2id verifier with the baseline parameters, and verifies only itself', async () => {
    const v1 = await hashSecret('Granulator-Line-7');
    const v2 = await hashSecret('Granulator-Line-7');
    expect(v1).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(v1).not.toContain('Granulator-Line-7');
    expect(v1).not.toBe(v2);
    expect(await verifySecret(v1, 'Granulator-Line-7')).toBe(true);
    expect(await verifySecret(v2, 'Granulator-Line-7')).toBe(true);
    expect(await verifySecret(v1, 'granulator-line-7')).toBe(false);
  });

  it('[DI-19] an empty secret is never hashed', async () => {
    await expect(hashSecret('')).rejects.toThrow(new IdentityError('EBMR-IAM-050', 'an empty secret cannot be hashed'));
    await expect(hashSecret('')).rejects.toMatchObject({ code: 'EBMR-IAM-050' });
  });

  it('[DI-19] a verifier that cannot be decoded verifies nothing: the answer is false, not an error', async () => {
    expect(await verifySecret('not-a-verifier', 'anything')).toBe(false);
    expect(await verifySecret('', '')).toBe(false);
    expect(await verifySecret('$argon2id$v=19$m=19456,t=2,p=1$broken', 'anything')).toBe(false);
  });

  it('[DI-19] an unknown account costs the same argon2id work as a known one, with or without a secret, so timing tells nothing', async () => {
    const known = await hashSecret('Known-account-secret-1');
    // The first call also builds the dummy verifier; measure the calls after it.
    await expect(burnVerification('warm-up')).resolves.toBeUndefined();
    const elapsed = async (work: () => Promise<unknown>): Promise<number> => {
      const start = performance.now();
      await work();
      return performance.now() - start;
    };
    let real = 0;
    let burnt = 0;
    let burntWithoutSecret = 0;
    // Interleaved, so a load change on the machine affects all three alike. A real verification
    // takes milliseconds; skipping the work takes microseconds.
    for (let i = 0; i < 4; i += 1) {
      real += await elapsed(() => verifySecret(known, 'wrong-secret'));
      burnt += await elapsed(() => burnVerification('wrong-secret'));
      burntWithoutSecret += await elapsed(() => burnVerification(undefined));
    }
    expect(burnt).toBeGreaterThan(real / 4);
    expect(burntWithoutSecret).toBeGreaterThan(real / 4);
  });
});

describe('policy values', () => {
  it('[DI-19] the policy row becomes numbers and a flag; no row at all is refused rather than read as no policy', async () => {
    const answering = (rows: unknown[]) => ({ query: () => Promise.resolve({ rows }) }) as unknown as pg.Pool;
    await expect(readSecretPolicy(answering([{ min_len: '14', pin_len: '8', screening: true }]))).resolves.toEqual({
      passwordMinLength: 14,
      pinLength: 8,
      compromisedScreening: true,
    });
    await expect(readSecretPolicy(answering([]))).rejects.toThrow(new IdentityError('EBMR-IAM-110', 'identity policy values are missing'));
    await expect(readSecretPolicy(answering([]))).rejects.toMatchObject({ code: 'EBMR-IAM-110' });
  });
});

describe('password rules', () => {
  it('[DI-19] a password needs the policy\'s minimum length, counted in characters (code points), the minimum itself included', () => {
    expect(passwordProblems('Tq7-vR2m-Lp9', policy)).toEqual([]);
    expect(passwordProblems('Tq7-vR2m-Lp', policy)).toEqual(['shorter than 12 characters']);
    expect(passwordProblems('Tq7-vR2m-Lp9', withPolicy({ passwordMinLength: 13 }))).toEqual(['shorter than 13 characters']);
    // 12 code points written with 15 UTF-16 code units, then 11 code points with 14.
    expect(passwordProblems('a😀b🔒c🌍d9e8f7', policy)).toEqual([]);
    expect(passwordProblems('a😀b🔒c🌍d9e8f', policy)).toEqual(['shorter than 12 characters']);
  });

  it('[DI-19] a password of one repeated character is refused, however long', () => {
    expect(passwordProblems('aaaaaaaaaaaaaa', policy)).toEqual(['a single repeated character']);
    expect(passwordProblems('😀'.repeat(12), policy)).toEqual(['a single repeated character']);
    expect(passwordProblems('aa', withPolicy({ passwordMinLength: 2 }))).toEqual(['a single repeated character']);
    expect(passwordProblems('aaaaaaaaaaab', policy)).toEqual([]);
    expect(passwordProblems('baaaaaaaaaaa', policy)).toEqual([]);
  });

  it('[DI-19] a commonly used password is refused, whatever its case and punctuation', () => {
    const short = withPolicy({ passwordMinLength: 8 });
    expect(passwordProblems('password123', short)).toEqual(['a commonly used password']);
    expect(passwordProblems('PASSWORD123', short)).toEqual(['a commonly used password']);
    expect(passwordProblems('Password!', short)).toEqual(['a commonly used password']);
    expect(passwordProblems('pass-word-1', short)).toEqual(['a commonly used password']);
    expect(passwordProblems('Pharma@123', short)).toEqual(['a commonly used password']);
    expect(passwordProblems('passwordx', short)).toEqual([]);
    expect(passwordProblems('pharma1234', short)).toEqual([]);
  });

  it('[DI-19] a password containing the login name (3 characters or more, any case) is refused', () => {
    expect(passwordProblems('My-JSmith-pass-2026', policy, 'jsmith')).toEqual(['contains the login name']);
    expect(passwordProblems('Line-ABC-batch-77', policy, 'abc')).toEqual(['contains the login name']);
    // A login name shorter than 3 characters would refuse half the dictionary; it is not checked.
    expect(passwordProblems('Line-AB-batch-777', policy, 'ab')).toEqual([]);
    expect(passwordProblems('Line-AB-batch-777', policy, '')).toEqual([]);
    expect(passwordProblems('Line-AB-batch-777', policy)).toEqual([]);
    expect(passwordProblems('Line-ABD-batch-77', policy, 'abc')).toEqual([]);
  });

  it('[DI-19] every problem is reported, in rule order', () => {
    expect(passwordProblems('aaaaaa', withPolicy({ passwordMinLength: 8 }), 'aaa')).toEqual([
      'shorter than 8 characters',
      'a single repeated character',
      'contains the login name',
    ]);
    expect(passwordProblems('admin', withPolicy({ passwordMinLength: 8 }), 'admin')).toEqual([
      'shorter than 8 characters',
      'a commonly used password',
      'contains the login name',
    ]);
  });
});

describe('PIN rules', () => {
  it('[DI-19] a PIN is digits only, the whole of it', () => {
    expect(pinProblems('482915', policy)).toEqual([]);
    expect(pinProblems('48a915', policy)).toEqual(['digits only']);
    expect(pinProblems('a48291', policy)).toEqual(['digits only']);
    expect(pinProblems('48291a', policy)).toEqual(['digits only']);
    expect(pinProblems('482 915', policy)).toEqual(['digits only']);
    expect(pinProblems('', policy)).toEqual(['digits only', 'shorter than 6 digits']);
  });

  it('[DI-19] a PIN needs the policy\'s length, the length itself included', () => {
    expect(pinProblems('48291', policy)).toEqual(['shorter than 6 digits']);
    expect(pinProblems('4829', withPolicy({ pinLength: 4 }))).toEqual([]);
    expect(pinProblems('4829153', policy)).toEqual([]);
  });

  it('[DI-19][DI-15] a PIN longer than the 12 digits every kiosk PIN pad takes is refused, 12 itself accepted (F05)', () => {
    expect(MAX_PIN_LENGTH).toBe(12);
    expect(pinProblems('739146285039', policy)).toEqual([]);
    expect(pinProblems('7391462850391', policy)).toEqual(['longer than 12 digits']);
    expect(pinProblems('73914628503917', policy)).toEqual(['longer than 12 digits']);
    expect(pinProblems('7391462850391a', policy)).toEqual(['digits only', 'longer than 12 digits']);
    expect(refusal(() => assertAcceptableSecret('PIN', '73914628503917', policy))).toBe('EBMR-IAM-055 the new pin is not acceptable: longer than 12 digits');
  });

  it('[DI-19] a PIN of one repeated digit is refused', () => {
    expect(pinProblems('777777', policy)).toEqual(['a single repeated digit']);
    expect(pinProblems('000', withPolicy({ pinLength: 3 }))).toEqual(['a single repeated digit']);
    expect(pinProblems('777778', policy)).toEqual([]);
    expect(pinProblems('877777', policy)).toEqual([]);
  });

  it('[DI-19] a straight sequence of three or more digits is refused, rising or falling, wherever it starts', () => {
    for (const pin of ['123456', '234567', '456789', '012345', '987654', '654321', '543210']) {
      expect(pinProblems(pin, policy)).toEqual(['a straight sequence']);
    }
    expect(pinProblems('123', withPolicy({ pinLength: 3 }))).toEqual(['a straight sequence']);
    expect(pinProblems('210', withPolicy({ pinLength: 3 }))).toEqual(['a straight sequence']);
    expect(pinProblems('1234', policy)).toEqual(['shorter than 6 digits', 'a straight sequence']);
  });

  it('[DI-19] only a full run of steps of one counts as a sequence: broken runs, other steps and two digits do not', () => {
    for (const pin of ['123457', '123465', '234560', '901234', '890123', '765431', '124567']) {
      expect(pinProblems(pin, policy)).toEqual([]);
    }
    // Constant steps other than one are not sequences.
    for (const pin of ['2468', '1357', '9630', '8642']) expect(pinProblems(pin, withPolicy({ pinLength: 4 }))).toEqual([]);
    // Two digits are never a sequence.
    for (const pin of ['12', '98', '01']) expect(pinProblems(pin, withPolicy({ pinLength: 2 }))).toEqual([]);
  });
});

describe('acceptable secrets (the check before hashing)', () => {
  it('[DI-19] a password is judged by the password rules only, a PIN by the PIN rules only', () => {
    expect(() => assertAcceptableSecret('PASSWORD', 'Another-Long-Secret-77', policy)).not.toThrow();
    expect(() => assertAcceptableSecret('PASSWORD', 'Another-Long-Secret-77', policy, 'operator7')).not.toThrow();
    expect(() => assertAcceptableSecret('PIN', '482915', policy)).not.toThrow();
    expect(refusal(() => assertAcceptableSecret('PIN', 'Another-Long-Secret-77', policy))).toBe('EBMR-IAM-055 the new pin is not acceptable: digits only; longer than 12 digits');
    expect(refusal(() => assertAcceptableSecret('PIN', 'Another-77', policy))).toBe('EBMR-IAM-055 the new pin is not acceptable: digits only');
    expect(refusal(() => assertAcceptableSecret('PASSWORD', '482915', policy))).toBe('EBMR-IAM-055 the new password is not acceptable: shorter than 12 characters');
  });

  it('[DI-19] the refusal names the kind of secret and lists every problem', () => {
    expect(refusal(() => assertAcceptableSecret('PASSWORD', 'aaaa', policy))).toBe(
      'EBMR-IAM-055 the new password is not acceptable: shorter than 12 characters; a single repeated character',
    );
    expect(refusal(() => assertAcceptableSecret('PASSWORD', 'Line-ABC-batch-77', policy, 'abc'))).toBe(
      'EBMR-IAM-055 the new password is not acceptable: contains the login name',
    );
    expect(refusal(() => assertAcceptableSecret('PIN', '1234', policy))).toBe('EBMR-IAM-055 the new pin is not acceptable: shorter than 6 digits; a straight sequence');
  });

  it('[DI-19] a service key needs at least 32 characters and nothing else: the password and PIN rules do not apply', () => {
    expect(refusal(() => assertAcceptableSecret('SERVICE_KEY', 'k'.repeat(31), policy))).toBe(
      'EBMR-IAM-055 the new service key is not acceptable: a service key has at least 32 characters',
    );
    expect(refusal(() => assertAcceptableSecret('SERVICE_KEY', '', policy))).toBe(
      'EBMR-IAM-055 the new service key is not acceptable: a service key has at least 32 characters',
    );
    // 32 repeated characters or 32 digits would break the password or PIN rules; a service key is random by design.
    expect(() => assertAcceptableSecret('SERVICE_KEY', 'k'.repeat(32), policy)).not.toThrow();
    expect(() => assertAcceptableSecret('SERVICE_KEY', '1'.repeat(33), policy)).not.toThrow();
  });
});

describe('initial secrets (DI-15: delivered to the user, never chosen by the administrator)', () => {
  it('[DI-15] an initial PIN has the policy\'s length and always passes the PIN rules', () => {
    // With 4 digits about 1 random PIN in 400 is a sequence or a repeated digit; none may come out.
    const four = withPolicy({ pinLength: 4 });
    for (let i = 0; i < 20_000; i += 1) {
      const pin = generateSecret('PIN', four);
      expect(pin).toMatch(/^\d{4}$/);
      expect(pinProblems(pin, four)).toEqual([]);
    }
    expect(generateSecret('PIN', withPolicy({ pinLength: 8 }))).toMatch(/^\d{8}$/);
  });

  it('[DI-15] a policy length no generated secret can meet is refused (EBMR-IAM-110) instead of looping or giving an empty secret', () => {
    for (const pinLength of [1, 0, -4, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => generateSecret('PIN', withPolicy({ pinLength })), String(pinLength)).toThrow(
        new IdentityError('EBMR-IAM-110', `credential.pin_length is ${pinLength}; a generated secret needs a whole number of at least 2`),
      );
    }
    for (let i = 0; i < 200; i += 1) expect(generateSecret('PIN', withPolicy({ pinLength: 2 }))).toMatch(/^(?!(\d)\1)\d{2}$/);
    // Longer than the pads take (F05): refused, never an endless search for an acceptable PIN; 12 itself is generated.
    for (const pinLength of [13, 64]) {
      expect(() => generateSecret('PIN', withPolicy({ pinLength })), String(pinLength)).toThrow(
        new IdentityError('EBMR-IAM-110', `credential.pin_length is ${pinLength}; a PIN has at most 12 digits`),
      );
    }
    expect(generateSecret('PIN', withPolicy({ pinLength: 12 }))).toMatch(/^\d{12}$/);
    for (const passwordMinLength of [0, Number.NaN, 12.5]) {
      expect(() => generateSecret('PASSWORD', withPolicy({ passwordMinLength })), String(passwordMinLength)).toThrow(
        new IdentityError('EBMR-IAM-110', `credential.password_min_length is ${passwordMinLength}; a generated secret needs a whole number of at least 1`),
      );
    }
    expect(generateSecret('PASSWORD', withPolicy({ passwordMinLength: 1 }))).toHaveLength(16);
    // A service key does not depend on the lengths.
    expect(generateSecret('SERVICE_KEY', withPolicy({ pinLength: 1, passwordMinLength: Number.NaN }))).toHaveLength(43);
  });

  it('[DI-15] an initial password has at least 16 characters, more when the policy asks, from an alphabet without look-alike characters', () => {
    const passwords = Array.from({ length: 200 }, () => generateSecret('PASSWORD', policy));
    for (const p of passwords) {
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
      expect(passwordProblems(p, policy)).toEqual([]);
    }
    expect(new Set(passwords).size).toBe(200);
    expect(generateSecret('PASSWORD', withPolicy({ passwordMinLength: 20 }))).toMatch(/^[A-HJ-NP-Za-km-z2-9]{20}$/);
    expect(generateSecret('PASSWORD', withPolicy({ passwordMinLength: 8 }))).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
  });

  it('[DI-15] an initial service key is 32 random bytes in base64url and passes the service-key rule', () => {
    const keys = Array.from({ length: 20 }, () => generateSecret('SERVICE_KEY', policy));
    for (const k of keys) {
      expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(k, 'base64url')).toHaveLength(32);
      expect(() => assertAcceptableSecret('SERVICE_KEY', k, policy)).not.toThrow();
    }
    expect(new Set(keys).size).toBe(20);
  });
});
