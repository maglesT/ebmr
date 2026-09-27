/**
 * Authentication service (outline 5.5 step 2; ADR 0012 decision 1; DI-15, DI-19, INV-40).
 *
 * Runs under the database role ebmr_authn, the only role that can read a verifier (for the account
 * being authenticated) and create authentication events. The service:
 *   1. asks iam.authn_prepare for the checks and the verifier (refusals are recorded and alerted);
 *   2. verifies the secret with argon2id here, in memory;
 *   3. reports the outcome to iam.authn_finish, which records it, applies lockout and, on success,
 *      inserts one single-use authentication event bound to person, account, device, purpose,
 *      components and, for a signature, the challenge.
 * Both steps run in one transaction holding a row lock on the account, so concurrent guesses are
 * counted one after the other. The outcome is committed even when authentication fails.
 */
import type pg from 'pg';
import { AuthenticationFailedError, IdentityError } from './errors.ts';
import { assertAcceptableSecret, burnVerification, hashSecret, readSecretPolicy, verifySecret } from './secrets.ts';

/** A pool for the authentication service. `setRole` switches role per transaction (tools and tests). */
export interface AuthnDb {
  pool: pg.Pool;
  setRole?: 'ebmr_authn';
}

export type AuthMethod = 'PASSWORD' | 'BADGE_PIN' | 'BADGE_TAP' | 'SERVICE_KEY';
export type AuthPurpose = 'LOGIN' | 'COMMAND' | 'SIGNATURE' | 'CREDENTIAL_CHANGE' | 'SESSION_UNLOCK';

export interface AuthenticationRequest {
  method: AuthMethod;
  /** Login name (PASSWORD, SERVICE_KEY) or badge UID as read by the reader (BADGE_PIN, BADGE_TAP). */
  identifier: string;
  /** Password, PIN or service key; not used for BADGE_TAP. */
  secret?: string;
  /** SHA-256 fingerprint of the enrolled device key or client certificate, from the TLS layer. */
  deviceFingerprint: string;
  purpose: AuthPurpose;
  /** Signature challenge (module B2); required for purpose SIGNATURE, refused otherwise. */
  challengeId?: string;
}

export interface AuthenticationEvent {
  authEventId: string;
  personId: string;
  accountId: string;
  deviceId: string;
  deviceClass: string;
  /** CREDENTIAL_CHANGE when the secret used was an initial, reset or aged one (restricted). */
  purpose: AuthPurpose;
  /** True when the event can only be used to change the secret. */
  restricted: boolean;
  components: string[];
}

async function inTransaction<T>(db: AuthnDb, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    if (db.setRole) await client.query(`set local role ${db.setRole}`);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

interface FinishResult {
  status: 'OK' | 'FAILED' | 'REFUSED';
  reason?: string;
  locked?: boolean;
  auth_event_id?: string;
  person_id?: string;
  account_id?: string;
  device_id?: string;
  device_class?: string;
  purpose?: AuthPurpose;
  restricted?: boolean;
  components?: string[];
}

export async function authenticate(db: AuthnDb, request: AuthenticationRequest): Promise<AuthenticationEvent> {
  const args = [request.method, request.identifier, request.deviceFingerprint, request.purpose, request.challengeId ?? null];
  const outcome = await inTransaction(db, async (client) => {
    const prepared = await client.query<{ r: { status: string; reason?: string; needs_secret?: boolean; verifier?: string | null } }>(
      'select iam.authn_prepare($1, $2, $3, $4, $5::uuid) as r',
      args,
    );
    const prep = prepared.rows[0]?.r;
    if (!prep || prep.status === 'REFUSED') {
      await burnVerification(request.secret);
      return { status: 'REFUSED', reason: prep?.reason ?? 'UNKNOWN' } satisfies FinishResult;
    }
    let verified = true;
    if (prep.needs_secret) {
      verified = request.secret !== undefined && typeof prep.verifier === 'string' && (await verifySecret(prep.verifier, request.secret));
    }
    const finished = await client.query<{ r: FinishResult }>('select iam.authn_finish($1, $2, $3, $4, $5::uuid, $6) as r', [...args, verified]);
    const result = finished.rows[0]?.r;
    if (!result) throw new IdentityError('EBMR-IAM-140', 'authentication produced no result');
    return result;
  });
  if (outcome.status !== 'OK') throw new AuthenticationFailedError(outcome.reason ?? outcome.status, outcome.locked ?? false);
  return {
    authEventId: outcome.auth_event_id ?? '',
    personId: outcome.person_id ?? '',
    accountId: outcome.account_id ?? '',
    deviceId: outcome.device_id ?? '',
    deviceClass: outcome.device_class ?? '',
    purpose: outcome.purpose ?? request.purpose,
    restricted: outcome.restricted ?? false,
    components: outcome.components ?? [],
  };
}

export interface ChangeSecretRequest {
  /** A fresh, unused CREDENTIAL_CHANGE authentication event that proved the current secret of this kind. */
  authEventId: string;
  kind: 'PASSWORD' | 'PIN';
  newSecret: string;
  /** Used to refuse passwords containing the login name. */
  loginName?: string;
}

/**
 * The owner changes their own password or PIN (required after an initial, reset or aged secret,
 * before the account can sign). Refuses secrets that break policy or match a recent one.
 */
export async function changeSecret(db: AuthnDb, request: ChangeSecretRequest): Promise<string> {
  return inTransaction(db, async (client) => {
    const policy = await readSecretPolicy(client);
    assertAcceptableSecret(request.kind, request.newSecret, policy, request.loginName);
    const history = await client.query<{ v: string }>('select iam.authn_secret_history($1, $2) as v', [request.authEventId, request.kind]);
    for (const { v } of history.rows) {
      if (await verifySecret(v, request.newSecret)) {
        throw new IdentityError('EBMR-IAM-055', `the new ${request.kind.toLowerCase()} matches a recent one`);
      }
    }
    const verifier = await hashSecret(request.newSecret);
    const { rows } = await client.query<{ id: string }>('select iam.authn_change_secret($1, $2, $3) as id', [
      request.authEventId,
      request.kind,
      verifier,
    ]);
    return rows[0]?.id ?? '';
  });
}
