/**
 * K2 (phase-2 open questions; DI-19, INV-10, INV-40): a signing attempt refused before signing commits its own
 * command on purpose (the refused COMMAND row the handler records, plan section 6), and that command is attributed
 * by the signature authentication the attempt used (the kernel lets a SIGNATURE event attribute its command). The
 * failure is logged INSIDE that command (esig.record_signing_failure), so the kernel can tell the attempt's own
 * committed use of the event from another command's: a COMMAND use of this transaction by the validated command
 * that the event attributes is not re-use. Everything else still is (EBMR-IAM-091), and the other attempted-misuse
 * checks still run on the event: made for another challenge (EBMR-IAM-094), before the challenge (EBMR-ESIG-036),
 * without the components the signing needs (EBMR-ESIG-038).
 *
 * The recognition rests on what the database itself knows (the transaction and the validated command), never on
 * what the application says: a failure reported after the commit cannot claim the committed use as its own.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { logSigningFailure } from '../../src/esig/signing.ts';
import { freshAuthEvent, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  asTimeTraveller,
  challengeFor,
  cmd,
  createStub,
  dbCount,
  ensureSealKey,
  expectRefused,
  signatureAuth,
  signWith,
  syntheticAuthEvent,
  testActor,
} from './helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

type Method = 'PASSWORD' | 'BADGE_PIN';

/** A signer on an office PC (password) or at a kiosk (badge and PIN; every command needs a fresh event, INV-40). */
async function signer(kind: 'OFFICE' | 'KIOSK'): Promise<{ op: SeededActor; method: Method }> {
  return kind === 'OFFICE'
    ? { op: await testActor(db), method: 'PASSWORD' }
    : { op: await testActor(db, { deviceClass: 'SHARED', withPin: true }), method: 'BADGE_PIN' };
}

/** The attempt's own command: its actor carries the signature authentication, which attributes it (INV-40). */
async function attemptContext(op: SeededActor, authEventId: string): Promise<ActorContext> {
  return { ...(await cmd(db, op)), authEventId, correlationId: randomUUID() };
}

const RECORD = 'select esig.record_signing_failure($1, $2, $3, $4)';

/**
 * A signing refused before signing, as the ceremony runs it: one command attributed by the event commits what the
 * handler records on purpose and logs the refusal with the event inside that same command.
 */
async function refusedAttempt(op: SeededActor, challengeId: string, authEventId: string, code = 'ESIG_STUB_ORDER'): Promise<void> {
  await withCommand(db.app, await attemptContext(op, authEventId), async (c) => {
    await c.query(RECORD, [challengeId, authEventId, code, `${code} refused before signing (test)`]);
  });
}

interface Logged {
  code: string;
  misuse: string | null;
}

async function logged(challengeId: string): Promise<Logged[]> {
  const { rows } = await db.admin.query<Logged>('select code, misuse_code as misuse from esig.signing_failure where challenge_id = $1 order by id', [challengeId]);
  return rows;
}

async function alertsFor(authEventId: string): Promise<{ severity: string; person_id: string; code: string }[]> {
  const { rows } = await db.admin.query<{ severity: string; person_id: string; code: string }>(
    `select severity, person_id::text, details ->> 'code' as code from iam.security_alert
      where kind = 'SIGNING_FAILED' and details ->> 'auth_event_id' = $1 order by raised_at`,
    [authEventId],
  );
  return rows;
}

async function usesOf(authEventId: string): Promise<string[]> {
  const { rows } = await db.admin.query<{ use_kind: string }>('select use_kind from iam.auth_event_use where auth_event_id = $1 order by use_kind', [authEventId]);
  return rows.map((r) => r.use_kind);
}

async function unalerted(authEventId: string): Promise<number> {
  return dbCount(db, "select 1 from esig.invariant_violations() where invariant = 'DI-19' and detail like $1", [`%${authEventId}%`]);
}

describe('a refused attempt logged inside its own command (K2)', () => {
  for (const kind of ['OFFICE', 'KIOSK'] as const) {
    it(`[DI-19][INV-10][INV-40] ${kind.toLowerCase()}: the attempt's own committed use of its authentication is not re-use; nobody is alerted, and a later report cannot claim that use`, async () => {
      const { op, method } = await signer(kind);
      const id = await createStub(db, op);
      const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
      const ev = await signatureAuth(db, op, op, ch.challengeId, method);
      await refusedAttempt(op, ch.challengeId, ev);
      // The refused command committed, attributed by the signer's own authentication for this challenge.
      expect(await usesOf(ev)).toEqual(['COMMAND']);
      expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: null }]);
      expect(await alertsFor(ev)).toEqual([]);
      expect(await unalerted(ev)).toBe(0);
      // The event served its one command: it can never sign now, and that attempt is re-use (EBMR-IAM-091).
      await expectRefused(signWith(db, op, ch.challengeId, ev), kind === 'KIOSK' ? 'EBMR-IAM-126' : 'EBMR-IAM-091');
      // Reported after the rollback, outside any command: the committed use is not this report's, so it is re-use,
      // and the security unit is alerted once, naming the person who authenticated.
      await logSigningFailure(db.app, ch.challengeId, new Error('EBMR-IAM-091 the authentication event has already been used'), ev);
      expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: null }, { code: 'EBMR-IAM-091', misuse: 'EBMR-IAM-091' }]);
      expect(await alertsFor(ev)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-IAM-091' }]);
      // A fresh authentication for the same challenge signs normally.
      await signWith(db, op, ch.challengeId, await signatureAuth(db, op, op, ch.challengeId, method));
      expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1', [ch.challengeId])).toBe(1);
    });
  }

  it('[DI-19][INV-10] a resend is logged inside its own command with its own fresh authentication, without misuse; nothing is signed', async () => {
    const { op, method } = await signer('KIOSK');
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const first = await signatureAuth(db, op, op, ch.challengeId, method);
    await refusedAttempt(op, ch.challengeId, first);
    const resend = await signatureAuth(db, op, op, ch.challengeId, method);
    await refusedAttempt(op, ch.challengeId, resend);
    expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: null }, { code: 'UNKNOWN', misuse: null }]);
    expect([...(await usesOf(first)), ...(await usesOf(resend))]).toEqual(['COMMAND', 'COMMAND']);
    expect(await alertsFor(first)).toEqual([]);
    expect(await alertsFor(resend)).toEqual([]);
    expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1', [ch.challengeId])).toBe(0);
  });
});

describe('re-use by another command is still caught (EBMR-IAM-091)', () => {
  it('[DI-19][INV-40] an authentication that already attributed another command, then used for a signing: logged after the rollback, it is re-use', async () => {
    const { op, method } = await signer('OFFICE');
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId, method);
    // Another command (not a signing attempt) is attributed by the signature authentication and commits.
    await withCommand(db.app, await attemptContext(op, ev), (c) => c.query('select 1'));
    await expectRefused(signWith(db, op, ch.challengeId, ev), 'EBMR-IAM-091');
    await logSigningFailure(db.app, ch.challengeId, new Error('EBMR-IAM-091 the authentication event has already been used'), ev);
    expect(await logged(ch.challengeId)).toEqual([{ code: 'EBMR-IAM-091', misuse: 'EBMR-IAM-091' }]);
    expect(await alertsFor(ev)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-IAM-091' }]);
  });

  it('[DI-19][INV-40] logged inside another command, the other command\'s committed use is re-use', async () => {
    const { op, method } = await signer('KIOSK');
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId, method);
    await withCommand(db.app, await attemptContext(op, ev), (c) => c.query('select 1'));
    // A later command, attributed by a fresh tap, reports a refused signing with the used event.
    await withCommand(db.app, await cmd(db, op), async (c) => {
      await c.query(RECORD, [ch.challengeId, ev, 'ESIG_STUB_ORDER', 'reported in another command (test)']);
    });
    expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: 'EBMR-IAM-091' }]);
    expect(await alertsFor(ev)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-IAM-091' }]);
  });

  for (const correlation of ['another', 'the same'] as const) {
    it(`[DI-19][INV-40] in one transaction, a second command attributed by another authentication (${correlation} correlation id) cannot claim the first command's use`, async () => {
      const { op, method } = await signer('OFFICE');
      const id = await createStub(db, op);
      const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
      const ev = await signatureAuth(db, op, op, ch.challengeId, method);
      const first = await attemptContext(op, ev);
      const second: ActorContext = {
        ...(await cmd(db, op)),
        authEventId: await freshAuthEvent(db, op),
        correlationId: correlation === 'the same' ? first.correlationId ?? '' : randomUUID(),
      };
      const c: pg.PoolClient = await db.app.connect();
      try {
        await c.query('begin');
        await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(first))]);
        // Same transaction, another command, attributed by a fresh authentication instead of the event.
        await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(second))]);
        await c.query(RECORD, [ch.challengeId, ev, 'ESIG_STUB_ORDER', 'reported in a second command of the transaction (test)']);
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
      expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: 'EBMR-IAM-091' }]);
      expect(await alertsFor(ev)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-IAM-091' }]);
    });
  }

  it('[DI-19][INV-40] a replay of an earlier attempt\'s authentication in a new command is refused and, logged after the rollback, is re-use', async () => {
    const { op, method } = await signer('KIOSK');
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId, method);
    await refusedAttempt(op, ch.challengeId, ev);
    await expectRefused(refusedAttempt(op, ch.challengeId, ev), 'EBMR-IAM-126');
    await logSigningFailure(db.app, ch.challengeId, new Error('EBMR-IAM-126 INV-40: the authentication event has already attributed another command'), ev);
    expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: null }, { code: 'EBMR-IAM-126', misuse: 'EBMR-IAM-091' }]);
    expect(await alertsFor(ev)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-IAM-091' }]);
  });
});

describe('inside its own command, every other attempted-misuse check still runs (DI-19)', () => {
  it('[DI-19][INV-10] an authentication made for another challenge: EBMR-IAM-094', async () => {
    const { op, method } = await signer('KIOSK');
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const other = await challengeFor(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, other.challengeId, method);
    await refusedAttempt(op, ch.challengeId, ev);
    expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: 'EBMR-IAM-094' }]);
    expect(await alertsFor(ev)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-IAM-094' }]);
  });

  it('[DI-19][DI-38] an authentication recorded before the challenge (pre-signing): EBMR-ESIG-036', async () => {
    const { op, method } = await signer('OFFICE');
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId, method);
    await asTimeTraveller(db, "update iam.auth_event set recorded_at = (select recorded_at from esig.challenge where id = $2) - interval '1 microsecond' where id = $1",
                          [ev, ch.challengeId]);
    await refusedAttempt(op, ch.challengeId, ev);
    expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: 'EBMR-ESIG-036' }]);
    expect(await alertsFor(ev)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-ESIG-036' }]);
  });

  it('[DI-19][DI-38] an authentication without the components the signing needs: EBMR-ESIG-038', async () => {
    const { op } = await signer('OFFICE');
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await syntheticAuthEvent(db, op, op, ch.challengeId, ['USER_ID']);
    await refusedAttempt(op, ch.challengeId, ev);
    expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: 'EBMR-ESIG-038' }]);
    expect(await alertsFor(ev)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-ESIG-038' }]);
  });

  it('[DI-19] another person\'s authentication cannot attribute the signer\'s command, and reported, it is proxy signing: EBMR-IAM-093', async () => {
    const { op, method } = await signer('OFFICE');
    const colleague = await testActor(db, { legalName: 'Proxy Colleague K2' });
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, colleague, op, ch.challengeId, method);
    await expectRefused(refusedAttempt(op, ch.challengeId, ev), 'EBMR-IAM-122');
    await withCommand(db.app, await cmd(db, op), async (c) => {
      await c.query(RECORD, [ch.challengeId, ev, 'EBMR-IAM-093', 'EBMR-IAM-093 proxy signing (test)']);
    });
    expect(await logged(ch.challengeId)).toEqual([{ code: 'EBMR-IAM-093', misuse: 'EBMR-IAM-093' }]);
    expect(await alertsFor(ev)).toEqual([{ severity: 'HIGH', person_id: colleague.personId, code: 'EBMR-IAM-093' }]);
  });
});

/**
 * An edition may let its application role log a failure only through a function of its own (the Tablets edition's
 * session-checked tab.record_signing_failure, its migration 0620): logSigningFailure then hands the failure's code and
 * message to the recorder it is given instead of calling esig.record_signing_failure, and still swallows errors.
 */
describe('logged through the recorder an edition passes (HIGH-WATER round 5)', () => {
  it('[DI-19][INV-10] logSigningFailure gives the code and message to the recorder it is given and does not call the kernel function itself; a failing recorder never hides the refusal; without one the kernel function logs it', async () => {
    const { op } = await signer('OFFICE');
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const seen: [string, string][] = [];
    await logSigningFailure(db.app, ch.challengeId, new Error('EBMR-IAM-020 the password was wrong (test)'), undefined, {
      record: (code, message) => {
        seen.push([code, message]);
        return Promise.resolve();
      },
    });
    expect(seen).toEqual([['EBMR-IAM-020', 'EBMR-IAM-020 the password was wrong (test)']]);
    expect(await logged(ch.challengeId)).toEqual([]);
    await expect(logSigningFailure(db.app, ch.challengeId, new Error('EBMR-IAM-020 again (test)'), undefined, { record: () => Promise.reject(new Error('refused')) })).resolves.toBeUndefined();
    await logSigningFailure(db.app, ch.challengeId, new Error('EBMR-IAM-020 the password was wrong (test)'));
    expect(await logged(ch.challengeId)).toEqual([{ code: 'EBMR-IAM-020', misuse: null }]);
  });
});
