/**
 * The actor-context check behind kernel.begin_command and per-command attribution on shared
 * devices (INV-40; DI-14 every GMP action needs an individually assigned, authenticated account).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { registerDevice, setPolicy } from '../../src/identity/admin.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { openSession } from '../../src/identity/sessions.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asDefinerCommand, asTimeTraveller, authnLoginPool, expectPermissionDenied, expectRefused } from './helpers.ts';
import {
  freshAuthEvent,
  SEED_SITE,
  seedActor,
  seedAdministration,
  seedAuthn,
  seedServiceActor,
  withFreshAuth,
  withReason,
  type SeedAdministration,
  type SeededActor,
} from './seed.ts';

let db: TestDatabase;
let adm: SeedAdministration;
let kiosk: SeededActor;
beforeAll(async () => {
  db = await createTestDatabase();
  adm = await seedAdministration(db);
  kiosk = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
});
afterAll(async () => {
  await db.drop();
});

const insert = (ctx: ActorContext, batch = randomUUID()) =>
  withCommand(db.app, ctx, (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, 1)', [batch]));
const withEvent = (a: ActorContext, authEventId: string): ActorContext => ({ ...a, authEventId, correlationId: randomUUID() });

describe('INV-40: every command on a shared device carries a fresh authentication event of its person', () => {
  it('[INV-40] bypass: a command on a shared device without an authentication event is refused', async () => {
    const bare: ActorContext = { ...kiosk, correlationId: randomUUID() };
    delete bare.authEventId;
    await expectRefused(insert(bare), 'EBMR-IAM-120', /INV-40/);
    const bareGab: ActorContext = { ...(await seedActor(db, { deviceClass: 'GRADE_A_B', acknowledgeEsig: false })) };
    delete bareGab.authEventId;
    await expectRefused(insert(bareGab), 'EBMR-IAM-120');
  });

  it('[INV-40] bypass: an authentication event older than the device class window is refused', async () => {
    const ev = await freshAuthEvent(db, kiosk);
    await asTimeTraveller(db, "update iam.auth_event set recorded_at = clock_timestamp() - interval '61 seconds' where id = $1", [ev]);
    await expectRefused(insert(withEvent(kiosk, ev)), 'EBMR-IAM-125');
    // The window is a policy value per device class; a longer one (within its allowed range) accepts it.
    await withCommand(db.app, withReason(adm.admin, 'POLICY_CHANGE'), (c) => setPolicy(c, 'attribution.freshness_seconds.SHARED', '120', 'test'));
    await insert(withEvent(kiosk, ev));
    await withCommand(db.app, withReason(adm.admin, 'POLICY_CHANGE'), (c) => setPolicy(c, 'attribution.freshness_seconds.SHARED', '60', 'restore'));
    await expectRefused(withCommand(db.app, withReason(adm.admin, 'POLICY_CHANGE'), (c) => setPolicy(c, 'attribution.freshness_seconds.SHARED', '301', 'x')), 'EBMR-IAM-110');
  });

  it('[INV-40] bypass: another person\'s authentication event is refused', async () => {
    const colleague = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    await expectRefused(insert(withEvent(kiosk, await freshAuthEvent(db, colleague))), 'EBMR-IAM-122');
  });

  it('[INV-40] bypass: an event made on another terminal is refused', async () => {
    const fp2 = randomBytes(32).toString('hex');
    await withCommand(db.app, withReason(adm.admin), (c) =>
      registerDevice(c, { code: `KSK-${randomBytes(3).toString('hex')}`, deviceClass: 'SHARED', site: SEED_SITE, fingerprint: fp2, description: 'next kiosk' }));
    const tap = await authenticate(seedAuthn(db), { method: 'BADGE_TAP', identifier: kiosk.seed.badgeUid ?? '', deviceFingerprint: fp2, purpose: 'COMMAND' });
    await expectRefused(insert(withEvent(kiosk, tap.authEventId)), 'EBMR-IAM-123');
  });

  it('[INV-40] bypass: an event that attributed one command cannot attribute another, even under the same correlation ID', async () => {
    const ctx = await withFreshAuth(db, kiosk);
    await insert(ctx);
    await expectRefused(insert({ ...ctx, correlationId: randomUUID() }), 'EBMR-IAM-126');
    await expectRefused(insert(ctx), 'EBMR-IAM-126');
  });

  it('[INV-40] bypass: login, unlock and change-secret events cannot attribute a command', async () => {
    const login = await authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: kiosk.seed.loginName, secret: kiosk.seed.password, deviceFingerprint: kiosk.seed.deviceFingerprint, purpose: 'LOGIN' });
    await expectRefused(insert(withEvent(kiosk, login.authEventId)), 'EBMR-IAM-124');
    await expectRefused(insert(withEvent(kiosk, randomUUID())), 'EBMR-IAM-090');
  });

  it('[INV-40] bypass: the application role cannot create, change or un-consume authentication events', async () => {
    const ev = await freshAuthEvent(db, kiosk);
    await insert(withEvent(kiosk, ev));
    await expectPermissionDenied(
      db.app.query(
        "insert into iam.auth_event (person_id, account_id, device_id, device_class, method, components, purpose) values ($1, $2, $3, 'SHARED', 'BADGE_TAP', '{BADGE}', 'COMMAND')",
        [kiosk.personId, kiosk.accountId, kiosk.deviceId],
      ),
    );
    await expectPermissionDenied(db.app.query("update iam.auth_event set recorded_at = clock_timestamp() where id = $1", [ev]));
    await expectPermissionDenied(db.app.query('delete from iam.auth_event_use where auth_event_id = $1', [ev]));
    await expectPermissionDenied(db.app.query("select iam.authn_finish('BADGE_TAP', $1, $2, 'COMMAND', null, true)", [kiosk.seed.badgeUid, kiosk.seed.deviceFingerprint]));
    await expectPermissionDenied(db.app.query("select iam.use_auth_event_for_command($1, $2, $3, $4, interval '1 hour', gen_random_uuid(), $5)", [ev, kiosk.personId, kiosk.accountId, kiosk.deviceId, kiosk.sessionId]));
    await expectPermissionDenied(db.app.query("select iam.consume_auth_event($1, $2, null, interval '1 minute')", [ev, kiosk.personId]));
    await expectPermissionDenied(db.app.query("select iam.set_internal_actor('{}'::jsonb)"));
    // Even the table owner cannot quietly free or rewrite a used event.
    await expect(db.admin.query('delete from iam.auth_event_use where auth_event_id = $1', [ev])).rejects.toThrow('EBMR-IAM-006');
    await expect(db.admin.query('update iam.auth_event set person_id = $2 where id = $1', [ev, adm.admin.personId])).rejects.toThrow('EBMR-IAM-006');
  });

  it('[INV-40] only the authentication-service role creates events; it can read no table and no secret', async () => {
    const pool = authnLoginPool(db);
    try {
      const ev = await authenticate({ pool }, { method: 'BADGE_TAP', identifier: kiosk.seed.badgeUid ?? '', deviceFingerprint: kiosk.seed.deviceFingerprint, purpose: 'COMMAND' });
      await insert(withEvent(kiosk, ev.authEventId));
      await expectPermissionDenied(pool.query('select * from iam.credential_secret'));
      await expectPermissionDenied(pool.query('select * from iam.auth_event'));
      await expectPermissionDenied(pool.query("insert into iam.auth_event_use (auth_event_id, use_kind) values ($1, 'COMMAND')", [ev.authEventId]));
      await expectPermissionDenied(pool.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(kiosk))]));
    } finally {
      await pool.end();
    }
    await expectPermissionDenied(db.app.query("select iam.authn_prepare('BADGE_TAP', 'x', 'y', 'COMMAND', null)"));
  });

  it('[INV-40] bypass: an actor context set with set_config instead of kernel.begin_command is detected and refused by the identity module', async () => {
    const c = await db.app.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('ebmr.ctx', $1, true)", [JSON.stringify(toDbContext(kiosk))]);
      await expectRefused(c.query('select iam.assert_validated_actor()'), 'EBMR-IAM-002');
    } finally {
      await c.query('rollback');
      c.release();
    }
    const c2 = await db.app.connect();
    try {
      await c2.query('begin');
      await c2.query("select set_config('ebmr.ctx', $1, true)", [JSON.stringify(toDbContext(withReason(adm.admin)))]);
      await expectRefused(c2.query("select iam.create_person('NATURAL', 'Ghost')"), 'EBMR-IAM-002');
    } finally {
      await c2.query('rollback');
      c2.release();
    }
    // A validated context passes the same check.
    await withCommand(db.app, await withFreshAuth(db, kiosk), (c3) => c3.query('select iam.assert_validated_actor()'));
  });

  it.todo('[INV-40] a context set with set_config cannot write any GMP table (needs kernel.append_audit_event to call iam.assert_validated_actor; lead)');

  it('[INV-40] a signature authentication attributes its own signing command and is then consumed once for the signature', async () => {
    const verifier = await seedActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED' });
    const challenge = randomUUID();
    const ev = await freshAuthEvent(db, verifier, 'SIGNATURE', challenge);
    const ctx = withEvent(verifier, ev);
    const consume = (c: pg.PoolClient) =>
      c.query<{ r: Record<string, unknown> }>("select iam.consume_auth_event($1, $2, $3, interval '120 seconds') as r", [ev, verifier.personId, challenge]);
    const used = await asDefinerCommand(db, ctx, async (c) => {
      const r = await consume(c);
      await c.query('savepoint second_use');
      await expectRefused(consume(c), 'EBMR-IAM-091');
      await c.query('rollback to savepoint second_use');
      const cur = await c.query<{ e: string }>('select iam.current_command_auth_event() as e');
      return { r: r.rows[0], current: cur.rows[0] };
    });
    expect(used.current).toEqual({ e: ev });
    const uses = await db.app.query('select use_kind from iam.auth_event_use where auth_event_id = $1 order by use_kind', [ev]);
    expect(uses.rows).toEqual([{ use_kind: 'COMMAND' }, { use_kind: 'SIGNATURE' }]);
    await expectRefused(insert(withEvent(verifier, ev)), 'EBMR-IAM-126');
    await expectRefused(
      asDefinerCommand(db, await withFreshAuth(db, verifier), (c) => consume(c)),
      'EBMR-IAM-091',
    );
  });
});

describe('kernel.validate_actor_context (DI-14)', () => {
  it('[DI-14] every GMP action needs a real, active, individually assigned account, its own live session and a role it holds', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const other = await seedActor(db, { acknowledgeEsig: false });
    await expectRefused(insert({ ...op, accountId: randomUUID() }), 'EBMR-IAM-101');
    await expectRefused(insert({ ...op, personId: other.personId }), 'EBMR-IAM-102');
    await expectRefused(insert({ ...op, sessionId: other.sessionId }), 'EBMR-IAM-111');
    await expectRefused(insert({ ...op, sessionId: randomUUID() }), 'EBMR-IAM-110');
    await expectRefused(insert({ ...op, roleCode: 'AUTHORISED_PERSON' }), 'EBMR-IAM-108');
    await expectRefused(insert({ ...op, legalName: 'Somebody Else' }), 'EBMR-IAM-117');
    await expectRefused(insert({ ...op, source: 'SYSTEM' }), 'EBMR-IAM-107');
    await expectRefused(insert({ ...op, personId: 'not-a-uuid' }), 'EBMR-IAM-100');
    await expectRefused(withCommand(db.app, withReason(adm.admin), (c) => c.query("select iam.suspend_account($1, 'investigation')", [op.accountId])).then(() => insert(op)), 'EBMR-IAM-103');
    await insert(other);
  });

  it('[DI-14] service identities act only with source SYSTEM or INTEGRATION and people never do', async () => {
    const svc = await seedServiceActor(db);
    await insert(svc);
    await insert({ ...svc, source: 'INTEGRATION' });
    await expectRefused(insert({ ...svc, source: 'API' }), 'EBMR-IAM-107');
  });

  it('[DI-14] each validated command is logged with its transaction, context hash, session and authentication event', async () => {
    const ctx = await withFreshAuth(db, kiosk);
    await insert(ctx);
    const { rows } = await db.admin.query('select account_id, session_id, auth_event_id from iam.command_log where correlation_id = $1', [ctx.correlationId]);
    expect(rows).toEqual([{ account_id: kiosk.accountId, session_id: kiosk.sessionId, auth_event_id: ctx.authEventId }]);
    const s = await openSession(db.app, (await authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: kiosk.seed.loginName, secret: kiosk.seed.password, deviceFingerprint: kiosk.seed.deviceFingerprint, purpose: 'LOGIN' })).authEventId, kiosk.seed.deviceFingerprint);
    kiosk = { ...kiosk, sessionId: s.sessionId };
  });
});
