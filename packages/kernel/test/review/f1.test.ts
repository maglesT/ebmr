/**
 * Review reproducer F1: a context that module code installed and then switched away from inside a
 * command must not stay reusable for the rest of the transaction.
 *
 * esig.sign installs the co-signer's context (iam.set_internal_actor) for the co-signature's own
 * audit entries and then restores the performer's context (kernel.set_actor_context). If the
 * co-signer's marker survives until commit, the application role can bring that context back with
 * set_config('ebmr.ctx', ...) and attribute further writes to the co-signer: a person paired with
 * the performer's session (which begin_command refuses, EBMR-IAM-111) and an authentication event
 * already consumed by the signature (INV-40).
 *
 * Safe behaviour asserted here: after the co-signature, the reinstalled co-signer context is not the
 * validated actor (kernel.current_actor() is NULL, iam.assert_validated_actor() refuses with
 * EBMR-IAM-002) and an audited write under it is refused (EBMR-AUDIT-009), so nothing is committed
 * in the co-signer's name.
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

describe('F1: a co-signer\'s context cannot be reinstalled after the co-signature', () => {
  it('[INV-40][INV-07][DI-22][DI-14][DI-13] bypass: after a co-signature, set_config back to the co-signer\'s context is refused and attributes nothing to the co-signer', async () => {
    const performer = await testActor(db, { deviceClass: 'SHARED', withPin: true, legalName: 'Kiosk Performer F1' });
    const verifier = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED', withPin: true, legalName: 'Kiosk Verifier F1' });
    const stubId = await createStub(db, performer);
    await signStub(db, performer, stubId, { meaning: 'PERFORMED', method: 'BADGE_PIN' });

    // Sanity: the kernel never validates the verifier's person with the performer's session.
    {
      const c0 = await db.app.connect();
      try {
        await c0.query('begin');
        const mixed = toDbContext({ ...performer, personId: verifier.personId, accountId: verifier.accountId, roleCode: 'VERIFIER', legalName: 'Kiosk Verifier F1' });
        const r = await attempt(c0, 'mixed', () => c0.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(mixed)]));
        expect(r).toEqual({ ok: false, code: 'EBMR-IAM-111' });
      } finally {
        await c0.query('rollback');
        c0.release();
      }
    }

    // The verifier co-signs at the performer's kiosk with their own badge and PIN.
    const ch = await challengeFor(db, performer, stubId, { meaning: 'VERIFIED', signer: verifier });
    expect(ch.cosignature).toBe(true);
    const verifierEvent = await signatureAuth(db, verifier, performer, ch.challengeId, 'BADGE_PIN');
    const performerCtx = await cmd(db, performer); // the performer's own fresh badge tap (INV-40)

    const observed: Record<string, unknown> = {};
    let forgedStubId: string | null = null;
    const c = await db.app.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(performerCtx))]);
      const sig = await sign(c, { challengeId: ch.challengeId, authEventId: verifierEvent, expectedState: 'OPEN' }, testSealKey);
      expect(sig.cosignature).toBe(true);
      // esig.sign restored the performer's context.
      const back = await c.query<{ p: string }>("select iam.assert_validated_actor() ->> 'person_id' as p");
      expect(back.rows[0]?.p).toBe(performer.personId);

      // Everything the application needs to rebuild the co-signer's context: its own context plus
      // the actor recorded on the signature's audit entry (readable by ebmr_app).
      const { rows: evRows } = await c.query<{ actor: Record<string, string> }>(
        "select payload -> 'actor' as actor from kernel.audit_event where table_name = 'esig.signature' and record_id = $1", [sig.signatureId]);
      const a = evRows[0]?.actor ?? {};
      expect(a['person_id']).toBe(verifier.personId);
      const overlay = { person_id: a['person_id'], account_id: a['account_id'], role_code: a['role_code'], auth_event_id: a['auth_event_id'], legal_name: a['legal_name'] };
      await c.query("select set_config('ebmr.ctx', (current_setting('ebmr.ctx')::jsonb || $1::jsonb)::text, true)", [JSON.stringify(overlay)]);

      // 1. The reinstalled context must not be read as the actor.
      const cur = await c.query<{ a: Record<string, string> | null }>('select kernel.current_actor() as a');
      observed['currentActorPerson'] = cur.rows[0]?.a?.['person_id'] ?? null;

      // 2. The identity module must refuse it.
      const asserted = await attempt(c, 'assert_actor', () => c.query<{ p: string }>("select iam.assert_validated_actor() ->> 'person_id' as p"));
      observed['assertValidatedActor'] = asserted.ok ? `ACCEPTED as ${asserted.value.rows[0]?.p}` : asserted.code;

      // 3. An audited GMP write under it must be refused.
      const ins = await attempt(c, 'forged_write', () =>
        c.query<{ id: string }>("insert into esig.stub_signable (kind, title, value, unit) values ('STEP', 'forged entry', '99', 'kg') returning id"));
      if (ins.ok) {
        forgedStubId = ins.value.rows[0]?.id ?? null;
        observed['forgedInsert'] = 'ACCEPTED';
      } else {
        observed['forgedInsert'] = ins.code;
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }

    // What was committed in the verifier's name (nothing, if the guarantee holds).
    let committedForgery: unknown = null;
    if (forgedStubId) {
      const { rows } = await db.admin.query<{ person: string; role: string; session: string; ev: string }>(
        `select e.payload -> 'actor' ->> 'person_id' as person, e.payload -> 'actor' ->> 'role_code' as role,
                e.payload -> 'actor' ->> 'session_id' as session, e.payload -> 'actor' ->> 'auth_event_id' as ev
           from kernel.audit_event e where e.table_name = 'esig.stub_signable' and e.record_id = $1`, [forgedStubId]);
      const r = rows[0];
      committedForgery = r
        ? {
            attributedToVerifier: r.person === verifier.personId,
            role: r.role,
            inPerformersSession: r.session === performer.sessionId,
            reusedConsumedSignatureEvent: r.ev === verifierEvent,
          }
        : 'row committed without audit event';
    }
    observed['committedForgery'] = committedForgery;

    expect(observed).toEqual({
      currentActorPerson: null,
      assertValidatedActor: 'EBMR-IAM-002',
      forgedInsert: 'EBMR-AUDIT-009',
      committedForgery: null,
    });
  });
});
