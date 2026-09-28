/**
 * Review reproducer F74: a co-signature must not leave the co-signer's validated actor context
 * installable by the application for the rest of the transaction (attribution forgery).
 *
 * esig.sign (0230, co-signature branch) installs the co-signer's context with
 * iam.set_internal_actor (kernel.command_marker + iam.command_log row for that context's hash) and
 * afterwards only restores ebmr.ctx with kernel.set_actor_context(v_actor). If the co-signer's marker
 * survives, ebmr_app can put the co-signer's context back with set_config('ebmr.ctx', ...) and every
 * later statement of the transaction is attributed to the co-signer: audited updates of the signed
 * entry (esig.content_change then names the co-signer as a person who changed the record, INV-03),
 * permission-gated functions (records.raise_incident evaluated with the co-signer's grants), without
 * any fresh authentication of the co-signer (INV-40) and without kernel.begin_command (INV-07).
 *
 * Scenario (the finding's): an operator on a SHARED kiosk runs one command with a correction reason;
 * a VERIFIER co-signs VERIFIED at that kiosk in that command; the application then re-installs the
 * verifier's context, corrects the signed entry and raises an incident, and commits.
 *
 * Control: the very same set_config overlay issued BEFORE esig.sign is not a validated actor, so the
 * only thing that can make it validated afterwards is what esig.sign left behind.
 *
 * Safe behaviour asserted: after the co-signature the re-installed verifier context is not validated
 * (iam.actor_is_validated() false, kernel.current_actor() NULL), the audited update and the incident
 * are refused (EBMR-AUDIT-* / EBMR-IAM-*), and nothing committed names the verifier as actor of the
 * update, as a person who changed the entry, or as the raiser of an incident.
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

const OVERLAY_SQL = "select set_config('ebmr.ctx', (current_setting('ebmr.ctx')::jsonb || $1::jsonb)::text, true)";

describe('F74: the co-signer context is not installable by the application after esig.sign', () => {
  it('[INV-40][INV-07][INV-03][DI-14][DI-22][DI-35] after a co-signature, re-installing the verifier context with set_config attributes no update, content change or incident to the verifier', async () => {
    const performer = await testActor(db, { deviceClass: 'SHARED', withPin: true, legalName: 'F74 Kiosk Operator' });
    const verifier = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED', withPin: true, legalName: 'F74 Kiosk Verifier' });
    const stubId = await createStub(db, performer, { value: '12.503' });
    await signStub(db, performer, stubId, { meaning: 'PERFORMED', method: 'BADGE_PIN' });

    // The verifier co-signs VERIFIED at the operator's kiosk (own badge + PIN, SIGNATURE event).
    const ch = await challengeFor(db, performer, stubId, { meaning: 'VERIFIED', signer: verifier });
    expect(ch.cosignature).toBe(true);
    const verifierEvent = await signatureAuth(db, verifier, performer, ch.challengeId, 'BADGE_PIN');
    // The operator's command: fresh badge tap (INV-40) and a correction reason (DI-24).
    const operatorCtx = await cmd(db, performer, { reasonCode: 'ENTRY_ERROR', reasonText: 'transcription error corrected' });

    const observed: Record<string, unknown> = {};
    let forgedIncidentId: string | null = null;
    const c = await db.app.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(operatorCtx))]);
      const operatorRaw = (await c.query<{ s: string }>("select current_setting('ebmr.ctx') as s")).rows[0]?.s ?? '';

      // Control: before the co-signature, the verifier overlay is NOT a validated actor.
      const plannedOverlay = {
        person_id: verifier.personId, account_id: verifier.accountId, role_code: 'VERIFIER', auth_event_id: verifierEvent, legal_name: 'F74 Kiosk Verifier',
      };
      await c.query(OVERLAY_SQL, [JSON.stringify(plannedOverlay)]);
      const pre = await c.query<{ ok: boolean; p: string | null }>("select iam.actor_is_validated() as ok, kernel.current_actor() ->> 'person_id' as p");
      expect(pre.rows[0]).toEqual({ ok: false, p: null });
      // Back to the operator's own (validated) context.
      await c.query("select set_config('ebmr.ctx', $1, true)", [operatorRaw]);
      const restored = await c.query<{ p: string }>("select iam.assert_validated_actor() ->> 'person_id' as p");
      expect(restored.rows[0]?.p).toBe(performer.personId);

      // The co-signature itself (esig.sign + esig.seal_signature) in the operator's command.
      const sig = await sign(c, { challengeId: ch.challengeId, authEventId: verifierEvent, expectedState: 'OPEN' }, testSealKey);
      expect(sig.cosignature).toBe(true);
      const back = await c.query<{ p: string }>("select iam.assert_validated_actor() ->> 'person_id' as p");
      expect(back.rows[0]?.p).toBe(performer.personId);

      // Everything needed is readable by ebmr_app from the signature row it just wrote.
      const { rows: sigRows } = await c.query<{ person_id: string; account_id: string; role_code: string; auth_event_id: string; legal_name: string }>(
        `select signer_person::text as person_id, signer_account::text as account_id, signer_role_code as role_code,
                auth_event_id::text as auth_event_id, signer_legal_name as legal_name
           from esig.signature where id = $1`, [sig.signatureId]);
      const overlay = sigRows[0];
      // Same values as the control overlay: the only difference is that esig.sign has run.
      expect(overlay).toEqual(plannedOverlay);

      // The application re-installs the verifier's context with set_config (no kernel code involved).
      await c.query(OVERLAY_SQL, [JSON.stringify(overlay)]);

      // 1. Not a validated actor.
      const v = await c.query<{ ok: boolean; p: string | null }>("select iam.actor_is_validated() as ok, kernel.current_actor() ->> 'person_id' as p");
      observed['actorIsValidated'] = v.rows[0]?.ok ?? null;
      const p = v.rows[0]?.p ?? null;
      observed['currentActorPerson'] = p === verifier.personId ? 'VERIFIER (co-signer)' : p === performer.personId ? 'OPERATOR' : p;

      // 2. An audited correction of the signed entry under it must be refused.
      const upd = await attempt(c, 'forged_update', () => c.query("update esig.stub_signable set value = '13.000' where id = $1", [stubId]));
      observed['forgedUpdate'] = upd.ok ? 'ACCEPTED' : upd.code;

      // 3. A permission-gated function under it must be refused.
      const inc = await attempt(c, 'forged_incident', () =>
        c.query<{ id: string }>("select records.raise_incident('OTHER', 'FORGED', 'MINOR', 'F74 forged incident', '', '[]'::jsonb)::text as id"));
      if (inc.ok) {
        forgedIncidentId = inc.value.rows[0]?.id ?? null;
        observed['forgedIncident'] = 'ACCEPTED';
      } else {
        observed['forgedIncident'] = inc.code;
      }

      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }

    // What was committed in the verifier's name (nothing, if the guarantee holds).
    const { rows: updAudit } = await db.admin.query<{ n: string }>(
      `select count(*)::text as n from kernel.audit_event
        where table_name = 'esig.stub_signable' and record_id = $1 and action = 'UPDATE'
          and payload -> 'actor' ->> 'person_id' = $2`, [stubId, verifier.personId]);
    observed['committedUpdateAuditedAsVerifier'] = Number(updAudit[0]?.n ?? '0');
    const { rows: changes } = await db.admin.query<{ n: string }>(
      "select count(*)::text as n from esig.content_change where aggregate_ref = $1 and person_id = $2", [`esig_stub:${stubId}`, verifier.personId]);
    observed['committedContentChangesByVerifier'] = Number(changes[0]?.n ?? '0');
    const { rows: incidents } = await db.admin.query<{ n: string }>(
      "select count(*)::text as n from records.incident where raised_by_person = $1", [verifier.personId]);
    observed['committedIncidentsRaisedByVerifier'] = Number(incidents[0]?.n ?? '0');
    const { rows: value } = await db.admin.query<{ v: string }>('select value as v from esig.stub_signable where id = $1', [stubId]);
    observed['entryValue'] = value[0]?.v ?? null;
    void forgedIncidentId;

    expect(observed).toEqual({
      actorIsValidated: false,
      currentActorPerson: null,
      forgedUpdate: expect.stringMatching(/^EBMR-(AUDIT|IAM)-\d+$/) as unknown,
      forgedIncident: expect.stringMatching(/^EBMR-(AUDIT|IAM)-\d+$/) as unknown,
      committedUpdateAuditedAsVerifier: 0,
      committedContentChangesByVerifier: 0,
      committedIncidentsRaisedByVerifier: 0,
      entryValue: '12.503',
    });
  });
});
