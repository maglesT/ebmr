/**
 * Secrets (DI-15, DI-19). Plaintext passwords, PINs and service keys exist only here, in the
 * authentication service's memory: they are hashed with argon2id before anything reaches the
 * database, and the database refuses anything that is not an argon2id verifier with at least the
 * baseline parameters (iam.check_verifier). Nothing in this module stores or pre-fills a secret.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import type pg from 'pg';
import { IdentityError } from './errors.ts';

/** argon2id, 19 MiB, 2 passes, 1 lane: the OWASP baseline; the database refuses weaker verifiers. */
const ARGON2ID = { algorithm: 2 as Algorithm, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export type SecretKind = 'PASSWORD' | 'PIN' | 'SERVICE_KEY';

export interface SecretPolicy {
  passwordMinLength: number;
  pinLength: number;
  compromisedScreening: boolean;
}

export async function hashSecret(secret: string): Promise<string> {
  if (secret.length === 0) throw new IdentityError('EBMR-IAM-050', 'an empty secret cannot be hashed');
  return hash(secret, ARGON2ID);
}

export async function verifySecret(verifier: string, secret: string): Promise<boolean> {
  try {
    return await verify(verifier, secret);
  } catch {
    return false;
  }
}

let dummyVerifier: Promise<string> | undefined;

/** Spend the same work as a real verification, so an unknown account cannot be told apart by timing. */
export async function burnVerification(secret: string | undefined): Promise<void> {
  dummyVerifier ??= hash(randomBytes(32).toString('hex'), ARGON2ID);
  await verifySecret(await dummyVerifier, secret ?? '');
}

/** Policy values the service needs to judge a new secret (all are data in iam.policy_*). */
export async function readSecretPolicy(db: pg.Pool | pg.PoolClient): Promise<SecretPolicy> {
  const { rows } = await db.query<{ min_len: string; pin_len: string; screening: boolean }>(
    `select iam.policy_int('credential.password_min_length') as min_len, iam.policy_int('credential.pin_length') as pin_len,
            iam.policy_bool('credential.compromised_screening') as screening`,
  );
  const row = rows[0];
  if (!row) throw new IdentityError('EBMR-IAM-110', 'identity policy values are missing');
  return { passwordMinLength: Number(row.min_len), pinLength: Number(row.pin_len), compromisedScreening: row.screening };
}

// A short built-in list of passwords that appear at the top of every breach corpus. Full
// compromised-password screening (credential.compromised_screening) plugs in a larger source later.
const COMMON = new Set([
  'password', 'password1', 'password123', '123456', '12345678', '123456789', '1234567890', 'qwerty', 'qwerty123', 'letmein',
  'welcome', 'welcome1', 'admin', 'admin123', 'iloveyou', 'monkey', 'abc123', 'passw0rd', 'changeme', 'india123', 'pharma123',
]);

/** Problems with a proposed password; empty when acceptable. */
export function passwordProblems(password: string, policy: SecretPolicy, loginName?: string): string[] {
  const problems: string[] = [];
  if ([...password].length < policy.passwordMinLength) problems.push(`shorter than ${policy.passwordMinLength} characters`);
  if (/^(.)\1*$/u.test(password)) problems.push('a single repeated character');
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9]/g, ''))) problems.push('a commonly used password');
  if (loginName && loginName.length >= 3 && lower.includes(loginName.toLowerCase())) problems.push('contains the login name');
  return problems;
}

/** Problems with a proposed PIN; empty when acceptable. */
export function pinProblems(pin: string, policy: SecretPolicy): string[] {
  const problems: string[] = [];
  if (!/^\d+$/.test(pin)) problems.push('digits only');
  if (pin.length < policy.pinLength) problems.push(`shorter than ${policy.pinLength} digits`);
  if (/^(\d)\1*$/.test(pin)) problems.push('a single repeated digit');
  const digits = [...pin].map(Number);
  const step = digits.length > 1 ? (digits[1] ?? 0) - (digits[0] ?? 0) : 0;
  if (digits.length > 2 && Math.abs(step) === 1 && digits.every((d, i) => i === 0 || d - (digits[i - 1] ?? 0) === step)) {
    problems.push('a straight sequence');
  }
  return problems;
}

export function assertAcceptableSecret(kind: SecretKind, secret: string, policy: SecretPolicy, loginName?: string): void {
  const problems = kind === 'PIN' ? pinProblems(secret, policy) : kind === 'PASSWORD' ? passwordProblems(secret, policy, loginName) : [];
  if (kind === 'SERVICE_KEY' && secret.length < 32) problems.push('a service key has at least 32 characters');
  if (problems.length > 0) throw new IdentityError('EBMR-IAM-055', `the new ${kind.toLowerCase().replace('_', ' ')} is not acceptable: ${problems.join('; ')}`);
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A random initial secret the service delivers to the user out of band (never to the administrator). */
export function generateSecret(kind: SecretKind, policy: SecretPolicy): string {
  if (kind === 'PIN') {
    for (;;) {
      const pin = Array.from({ length: policy.pinLength }, () => String(randomInt(10))).join('');
      if (pinProblems(pin, policy).length === 0) return pin;
    }
  }
  if (kind === 'SERVICE_KEY') return randomBytes(32).toString('base64url');
  const length = Math.max(policy.passwordMinLength, 16);
  return Array.from({ length }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');
}
