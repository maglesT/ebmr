/**
 * Review reproducer F68: after a co-signature, the co-signer's actor context stays validated for the
 * rest of the transaction, so the application role can re-install it with set_config and act as the
 * co-signer (authorization checks, attribution, audit actor).
 *
 * esig.sign (0230) installs the co-signer's context with iam.set_internal_actor, which leaves a
 * kernel.command_marker row and an iam.command_log row for the context's hash, and then restores the
 * terminal owner's context with kernel.set_actor_context without removing those rows.
 * kernel.actor_context_validated / iam.actor_is_validated accept any context whose hash has a marker
 * in the current transaction, and the context itself is the transaction-local GUC ebmr.ctx that any
 * role may set.
 *
 * Safe behaviour asserted here: once esig.sign has handed the command back to the performer, a
 * set_config back to the co-signer's exact context is not a validated actor
 * (iam.actor_is_validated() is false, kernel.current_actor() is NULL) and records.raise_incident
 * under it is refused, so no incident and no audit event is attributed to the co-signer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { toDbContext } from '../../src/db/command.ts';
import { sign } from '../../src/esig/signing.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { challengeFor, cmd, createStub, ensureSealKey, signatureAuth, signStub, testActor, testSealKey } from '../esig/helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

const codeOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.match(/EBMR-[A-Z]+-\d+/)?.[0] ?? `UNEXPECTED: ${m}`;
};

async function attempt<T>(c: pg.PoolClient, name: string, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  await c.query(`savepoint ${name}`);
  try {
    const value = await work();
    await c.query(`release savepoint ${name}`);
    return { ok: true, value };
  } catch (e) {
    await c.query(`rollback to savepoint ${name}`);
    return { ok: false, code: codeOf(e) };
  }
}

describe('F68: the co-signer context cannot be re-installed by the application after esig.sign', () => {
  it('[DI-17][DI-18][INV-40][INV-07][DI-22] after a co-signature, set_config to the co-signer context is not validated and raise_incident is not attributed to the co-signer', async () => {
    const performer = await testActor(db, { deviceClass: 'SHARED', withPin: true, legalName: 'F68 Performer' });
    const verifier = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED', withPin: true, legalName: 'F68 Verifier' });
    const stubId = await createStub(db, performer);
    await signStub(db, performer, stubId, { meaning: 'PERFORMED', method: 'BADGE_PIN' });

    // Normal co-signature: challenge for VERIFIED naming the verifier, the verifier authenticates at
    // the performer's shared terminal, esig.sign applies the co-signature in the performer's command.
    const ch = await challengeFor(db, performer, stubId, { meaning: 'VERIFIED', signer: verifier });
    expect(ch.cosignature).toBe(true);
    const verifierEvent = await signatureAuth(db, verifier, performer, ch.challengeId, 'BADGE_PIN');
    const performerCtx = await cmd(db, performer);

    const observed: Record<string, unknown> = {};
    const c = await db.app.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(performerCtx))]);
      const sig = await sign(c, { challengeId: ch.challengeId, authEventId: verifierEvent, expectedState: 'OPEN' }, testSealKey);
      expect(sig.cosignature).toBe(true);

      // esig.sign handed the command back to the performer.
      const back = await c.query<{ p: string }>("select iam.assert_validated_actor() ->> 'person_id' as p");
      expect(back.rows[0]?.p).toBe(performer.personId);

      // Control: with the performer's context back, raising an incident is attributed to the performer.
      const control = await attempt(c, 'control', () =>
        c.query<{ id: string }>("select records.raise_incident('OTHER', 'F68_CONTROL', 'MINOR', 'F68 control incident', 'by the performer') as id"));
      expect(control.ok).toBe(true);
      if (control.ok) {
        const { rows } = await c.query<{ p: string }>('select raised_by_person::text as p from records.incident where id = $1', [control.value.rows[0]?.id]);
        expect(rows[0]?.p).toBe(performer.personId);
      }

      // What the application can read from the signature it just wrote (ebmr_app has select on esig.signature).
      const { rows: sigRows } = await c.query<{ person_id: string; account_id: string; role_code: string; auth_event_id: string; legal_name: string }>(
        `select signer_person::text as person_id, signer_account::text as account_id, signer_role_code as role_code,
                auth_event_id::text as auth_event_id, signer_legal_name as legal_name
           from esig.signature where id = $1`, [sig.signatureId]);
      const s = sigRows[0];
      expect(s?.person_id).toBe(verifier.personId);

      // The application re-installs the co-signer's context with set_config (no kernel code involved).
      await c.query("select set_config('ebmr.ctx', (current_setting('ebmr.ctx')::jsonb || $1::jsonb)::text, true)", [JSON.stringify(s)]);

      // 1. Not a validated actor.
      const v = await c.query<{ ok: boolean }>('select iam.actor_is_validated() as ok');
      observed['actorIsValidated'] = v.rows[0]?.ok ?? null;
      const cur = await c.query<{ p: string | null }>("select kernel.current_actor() ->> 'person_id' as p");
      observed['currentActorPerson'] = cur.rows[0]?.p ?? null;

      // 2. A GMP write under it must not be attributed to the co-signer.
      const forged = await attempt(c, 'forged', () =>
        c.query<{ id: string }>("select records.raise_incident('OTHER', 'F68_FORGED', 'MINOR', 'F68 forged incident', 'raised as the verifier') as id"));
      if (forged.ok) {
        const id = forged.value.rows[0]?.id;
        const inc = await c.query<{ p: string }>('select raised_by_person::text as p from records.incident where id = $1', [id]);
        const aud = await c.query<{ p: string; ev: string; sess: string }>(
          `select payload -> 'actor' ->> 'person_id' as p, payload -> 'actor' ->> 'auth_event_id' as ev, payload -> 'actor' ->> 'session_id' as sess
             from kernel.audit_event where table_name = 'records.incident' and record_id = $1`, [id]);
        observed['forgedIncident'] = {
          accepted: true,
          raisedByVerifier: inc.rows[0]?.p === verifier.personId,
          auditActorIsVerifier: aud.rows[0]?.p === verifier.personId,
          auditReusesConsumedSignatureEvent: aud.rows[0]?.ev === verifierEvent,
          auditInPerformersSession: aud.rows[0]?.sess === performer.sessionId,
        };
      } else {
        observed['forgedIncident'] = forged.code;
      }
    } finally {
      // Nothing is committed: the forgery is observed inside the transaction only.
      await c.query('rollback');
      c.release();
    }

    expect(observed).toEqual({
      actorIsValidated: false,
      currentActorPerson: null,
      forgedIncident: expect.stringMatching(/^EBMR-(IAM|AUDIT)-\d+$/),
    });
  });
});
