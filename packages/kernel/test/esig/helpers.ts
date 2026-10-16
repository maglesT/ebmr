/**
 * Test helpers for the e-signature module. `testActor` is the one place tests in this folder get an
 * actor from (coordination rule); signers need real identities (credentials, sessions, terminals),
 * so it always seeds one through the identity module (test/identity/seed.ts).
 *
 * The full signing flow runs exactly as production would: the canonical content from the server,
 * a challenge in the session owner's command, an authentication by the signer through the
 * authentication service (role ebmr_authn) for that challenge, then sign + seal in one command.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { registerSealKey, setEsigPolicy, type EsigPolicyKey } from '../../src/esig/catalogue.ts';
import { createSealKeyRing, hmacSealKey, type SealKeyProvider } from '../../src/esig/keys.ts';
import { contentForSigning, createChallenge, sign, type Challenge, type SignatureResult } from '../../src/esig/signing.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { seedActor, seedAdministration, seedAuthn, withFreshAuth, type SeedActorOptions, type SeededActor } from '../identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import type { TestDatabase } from '../support/db.ts';

export { expectPermissionDenied, expectRefused, asSuperuserTransaction, asTimeTraveller } from '../identity/helpers.ts';

export async function testActor(db: TestDatabase, options: SeedActorOptions = {}): Promise<SeededActor> {
  return seedActor(db, options);
}

// ---------------------------------------------------------------------------------------------
// Seal key (HMAC, demo and test only) registered once per test database by the administrator.
// ---------------------------------------------------------------------------------------------

const TEST_SECRET = randomBytes(32);
export const TEST_KEY_ID = 'test-hmac-1';
export const testSealKey: SealKeyProvider = hmacSealKey(TEST_KEY_ID, TEST_SECRET);
export const testKeyRing = createSealKeyRing([{ keyId: TEST_KEY_ID, algorithm: 'HMAC-SHA256', secret: TEST_SECRET }]);

const keyRegistrations = new WeakMap<TestDatabase, Promise<void>>();

export function ensureSealKey(db: TestDatabase): Promise<void> {
  let p = keyRegistrations.get(db);
  if (!p) {
    p = (async () => {
      const { admin } = await seedAdministration(db);
      await withCommand(db.app, { ...admin, correlationId: randomUUID() }, (c) =>
        registerSealKey(c, { keyId: TEST_KEY_ID, algorithm: 'HMAC-SHA256' }, 'test HMAC seal key (demo only)'),
      );
    })();
    keyRegistrations.set(db, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

export const shopFloor = (a: SeededActor): boolean => a.seed.deviceClass === 'SHARED' || a.seed.deviceClass === 'GRADE_A_B';

/** A context for one command of the actor; on shop-floor terminals with a fresh badge tap (INV-40). */
export async function cmd(db: TestDatabase, actor: SeededActor, extra: Partial<ActorContext> = {}): Promise<ActorContext> {
  const base: SeededActor = shopFloor(actor) ? await withFreshAuth(db, actor) : { ...actor, correlationId: randomUUID() };
  const { seed: _seed, authEventId, ...ctx } = base;
  void _seed;
  return { ...ctx, ...(shopFloor(actor) && authEventId ? { authEventId } : {}), ...extra };
}

export async function run<T>(db: TestDatabase, actor: SeededActor, work: (c: pg.PoolClient) => Promise<T>, extra: Partial<ActorContext> = {}): Promise<T> {
  return withCommand(db.app, await cmd(db, actor, extra), work);
}

// ---------------------------------------------------------------------------------------------
// Stub signable entries
// ---------------------------------------------------------------------------------------------

export interface StubInput {
  kind?: 'STEP' | 'CLEANING_LOG' | 'MASTER_DOCUMENT';
  title?: string;
  value?: string;
  unit?: string;
}

export async function createStub(db: TestDatabase, actor: SeededActor, input: StubInput = {}): Promise<string> {
  return run(db, actor, async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into esig.stub_signable (kind, title, value, unit) values ($1, $2, $3, $4) returning id', [
      input.kind ?? 'STEP',
      input.title ?? 'Granulation: binder added',
      input.value ?? '12.503',
      input.unit ?? 'kg',
    ]);
    return rows[0]?.id ?? '';
  });
}

/** A permitted change (DI-24 correction with a reason) through the application role. */
export async function correctStub(db: TestDatabase, actor: SeededActor, id: string, value: string): Promise<void> {
  await run(db, actor, (c) => c.query('update esig.stub_signable set value = $2 where id = $1', [id, value]), {
    reasonCode: 'ENTRY_ERROR',
    reasonText: 'transcription error corrected',
  });
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

export type SignMethod = 'PASSWORD' | 'BADGE_PIN';

/** The signer authenticates at the terminal of `terminal` for the challenge (authentication service). */
export async function signatureAuth(db: TestDatabase, signer: SeededActor, terminal: SeededActor, challengeId: string, method: SignMethod = 'PASSWORD'): Promise<string> {
  const req =
    method === 'PASSWORD'
      ? { method: 'PASSWORD' as const, identifier: signer.seed.loginName, secret: signer.seed.password }
      : { method: 'BADGE_PIN' as const, identifier: signer.seed.badgeUid ?? '', secret: signer.seed.pin ?? '' };
  const ev = await authenticate(seedAuthn(db), { ...req, deviceFingerprint: terminal.seed.deviceFingerprint, purpose: 'SIGNATURE', challengeId });
  return ev.authEventId;
}

export interface ChallengeOptions {
  meaning: string;
  /** Another person signing at the actor's terminal (co-signature). */
  signer?: SeededActor;
  aggregateType?: string;
  /** Override the hash the client claims to display. */
  clientContentHash?: string;
}

/** Step 1 in the session owner's command. */
export async function challengeFor(db: TestDatabase, actor: SeededActor, aggregateId: string, opts: ChallengeOptions): Promise<Challenge> {
  const type = opts.aggregateType ?? 'esig_stub';
  const content = await contentForSigning(db.app, type, aggregateId);
  return run(db, actor, (c) =>
    createChallenge(c, {
      aggregateType: type,
      aggregateId,
      contentVersion: content.contentVersion ?? '1',
      meaning: opts.meaning,
      clientContentHash: opts.clientContentHash ?? content.contentHash ?? '',
      ...(opts.signer && opts.signer.accountId !== actor.accountId ? { signerAccountId: opts.signer.accountId } : {}),
    }),
  );
}

export interface SignWithOptions {
  expectedState?: string | null;
  nextStepStarted?: boolean;
  delegationId?: string;
  key?: SealKeyProvider;
  /** The signer (default the actor); decides how the command is attributed on shop-floor terminals. */
  signer?: SeededActor;
}

/** Steps 3-4 in the session owner's command (on a shop-floor terminal the owner's own signature event attributes it). */
export async function signWith(db: TestDatabase, actor: SeededActor, challengeId: string, authEventId: string, opts: SignWithOptions = {}): Promise<SignatureResult> {
  await ensureSealKey(db);
  const ownSignature = !opts.signer || opts.signer.personId === actor.personId;
  const ctx = shopFloor(actor) && ownSignature ? { ...(await cmd(db, actor)), authEventId } : await cmd(db, actor);
  return withCommand(db.app, ctx, (c) =>
    sign(
      c,
      {
        challengeId,
        authEventId,
        expectedState: opts.expectedState === undefined ? 'OPEN' : opts.expectedState,
        ...(opts.delegationId ? { delegationId: opts.delegationId } : {}),
        ...(opts.nextStepStarted !== undefined ? { nextStepStarted: opts.nextStepStarted } : {}),
      },
      opts.key ?? testSealKey,
    ),
  );
}

export interface SignStubOptions extends ChallengeOptions, Omit<SignWithOptions, 'signer'> {
  method?: SignMethod;
}

/** The whole flow: challenge, authentication of the signer at the actor's terminal, sign and seal. */
export async function signStub(db: TestDatabase, actor: SeededActor, aggregateId: string, opts: SignStubOptions): Promise<SignatureResult> {
  const signer = opts.signer ?? actor;
  const ch = await challengeFor(db, actor, aggregateId, opts);
  const ev = await signatureAuth(db, signer, actor, ch.challengeId, opts.method ?? 'PASSWORD');
  return signWith(db, actor, ch.challengeId, ev, { ...opts, signer });
}

/**
 * An authentication event with chosen components, inserted directly (superuser). The
 * authentication service always records both components for a signature; this stands in for a
 * future session-bound private-component authentication (DI-38 relaxation) and for forged events,
 * so the signing function's own component rule can be exercised.
 */
export async function syntheticAuthEvent(db: TestDatabase, signer: SeededActor, terminal: SeededActor, challengeId: string, components: string[],
                                         method: 'PASSWORD' | 'BADGE_PIN' = 'PASSWORD'): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    `insert into iam.auth_event (person_id, account_id, device_id, device_class, method, components, purpose, challenge_id)
     values ($1, $2, $3, $4, $5, $6, 'SIGNATURE', $7) returning id`,
    [signer.personId, signer.accountId, terminal.deviceId, terminal.seed.deviceClass, method, components, challengeId],
  );
  return rows[0]?.id ?? '';
}

// ---------------------------------------------------------------------------------------------
// Policy (quality unit)
// ---------------------------------------------------------------------------------------------

const qaApprovers = new WeakMap<TestDatabase, Promise<SeededActor>>();

export function qaApprover(db: TestDatabase): Promise<SeededActor> {
  let p = qaApprovers.get(db);
  if (!p) {
    p = testActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Quality Approver' });
    qaApprovers.set(db, p);
  }
  return p;
}

export async function setPolicy(db: TestDatabase, key: EsigPolicyKey, value: string): Promise<void> {
  const qa = await qaApprover(db);
  await ensureFixtureChangeRecord(db);
  await run(db, underChange(qa), (c) => setEsigPolicy(c, key, value, 'test configuration', 'CC-TEST-001'));
}

export async function dbCount(db: TestDatabase, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>(`select count(*)::text as n from (${sql}) x`, params);
  return Number(rows[0]?.n ?? '0');
}
