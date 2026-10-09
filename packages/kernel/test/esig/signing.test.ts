/**
 * Challenge, authenticate, sign (outline 5.5) and INV-10: every signature consumes one unused
 * authentication event of the same person, bound to its challenge, with the components the policy
 * requires; signatures are inserted only by the signing function. Bypass tests attack the tables
 * and functions with raw SQL as the application role and as the table owner.
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand } from '../../src/db/command.ts';
import { canonicalEnvelope, canonicalJson, contentHash } from '../../src/esig/canonical.ts';
import { contentForSigning, createChallenge, sign, signCommand } from '../../src/esig/signing.ts';
import { freshAuthEvent } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  asSuperuserTransaction,
  asTimeTraveller,
  challengeFor,
  cmd,
  createStub,
  dbCount,
  ensureSealKey,
  expectPermissionDenied,
  expectRefused,
  run,
  signatureAuth,
  signStub,
  signWith,
  syntheticAuthEvent,
  testActor,
  testSealKey,
} from './helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

describe('challenge (outline 5.5 step 1)', () => {
  it('[DI-37] the server rebuilds the canonical content and refuses a challenge whose displayed hash differs', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const content = await contentForSigning(db.app, 'esig_stub', id);
    expect(content.contentHash).toBe(contentHash(content.canonical ?? ''));
    // The client can rebuild the same canonical text itself.
    expect(canonicalEnvelope('esig_stub', id, '1', { kind: 'STEP', title: 'Granulation: binder added', value: '12.503', unit: 'kg', site: null, area: null, product: null }))
      .toBe(content.canonical);
    const wrong = contentHash(canonicalEnvelope('esig_stub', id, '1', { kind: 'STEP', title: 'Granulation: binder added', value: '12.530', unit: 'kg', site: null, area: null, product: null }));
    await expectRefused(challengeFor(db, op, id, { meaning: 'PERFORMED', clientContentHash: wrong }), 'EBMR-ESIG-013');
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    expect(ch.contentHash).toBe(content.contentHash);
    expect(ch.meaning.code).toBe('PERFORMED');
    expect(ch.manifestationPreview).toMatchObject({ printed_name: op.legalName, meaning_code: 'PERFORMED', role_code: 'OPERATOR' });
    const row = await db.admin.query<{ secs: number; session_id: string; device_id: string; signer_account: string }>(
      'select extract(epoch from expires_at - recorded_at)::int as secs, session_id, device_id, signer_account from esig.challenge where id = $1',
      [ch.challengeId],
    );
    expect(row.rows[0]).toEqual({ secs: 120, session_id: op.sessionId, device_id: op.deviceId, signer_account: op.accountId });
  });

  it('[DI-37] canonical JSON is identical in TypeScript and SQL, whatever the key order and escaping', async () => {
    const value = { z: 'last', a: ['x', { b: true, a: null }], 'é': 'accent', 'A': 'upper', q: 'quote " backslash \\ tab \t nl \n ctl \u0001', n: 42 };
    const { rows } = await db.app.query<{ t: string }>('select esig.canonical_json($1::jsonb) as t', [JSON.stringify(value)]);
    expect(canonicalJson(value)).toBe(rows[0]?.t);
    expect(() => canonicalJson({ q: 1.5 })).toThrow(/EBMR-ESIG-004/);
  });

  it('[DI-37] text no record can hold has no canonical form in SQL nor in TypeScript; any other text gets the same canonical text in both (review F31)', async () => {
    const refused = [
      { v: { title: 'a\u0000b' }, sql: '22P05', ts: 'U+0000' },
      { v: { title: 'a\ud800b' }, sql: '22P02', ts: 'an unpaired surrogate U+D800' },
      { v: { title: 'a\udfffb' }, sql: '22P02', ts: 'an unpaired surrogate U+DFFF' },
      { v: { ['k\u0000']: '1' }, sql: '22P05', ts: 'U+0000' },
      { v: { ['\uE000']: 1, ['\uD800']: 2 }, sql: '22P02', ts: 'an unpaired surrogate U+D800' },
    ];
    for (const { v, sql, ts } of refused) {
      const got = await db.app.query('select esig.canonical_json($1::jsonb) as t', [JSON.stringify(v)]).then(
        () => 'text',
        (e: unknown) => `refused ${(e as { code?: string }).code ?? '?'}`,
      );
      expect(got, JSON.stringify(v)).toBe(`refused ${sql}`);
      expect(() => canonicalJson(v), JSON.stringify(v)).toThrow(`EBMR-ESIG-004 text holding ${ts} has no canonical JSON form: no record can hold it`);
    }
    // Text a record can hold, as adversarial as it gets: every plane, controls, quotes, backslashes, U+2028, BOM,
    // noncharacters, U+FFFD, combining marks, keys that differ only in case or order.
    const units = ['a', 'A', 'b', 'B', '\u00E9', 'e\u0301', '\u00C9', '_', '-', '"', '\\', '\u0001', '\u001f', '\u007f', '\u0085', '\u2028', '\uFEFF', '\uFFFD', '\uFFFF', '\uD7FF', '\uE000', 'क', '\u{1F600}', '\u{10000}', '\u{10FFFF}', ' '];
    const str = fc.oneof(fc.string({ unit: 'grapheme', maxLength: 10 }), fc.string({ unit: fc.constantFrom(...units), maxLength: 6 }));
    const value = fc.letrec((tie) => ({
      v: fc.oneof(
        { depthSize: 'small' },
        str,
        fc.boolean(),
        fc.constant(null),
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        fc.array(tie('v'), { maxLength: 4 }),
        fc.dictionary(str, tie('v'), { maxKeys: 6 }),
      ),
    })).v;
    const samples: unknown[] = fc.sample(value, { numRuns: 1500, seed: 20261002 });
    samples.push({ b: 1, a: 2, B: 3, A: 4, aa: 5, 'a ': 6, 'a\u0001': 7, '': 8 }, { '\uFFFF': 1, '\u{10000}': 2, '\uFFFD': 3, '\uD7FF': 4, '\u00E9': 5, 'e\u0301': 6, '\u00C9': 7 });
    const { rows } = await db.app.query<{ t: string }>(
      'select esig.canonical_json(u.j::jsonb) as t from unnest($1::text[]) with ordinality as u (j, i) order by u.i',
      [samples.map((x) => JSON.stringify(x))],
    );
    const differ = samples.map((x, i) => ({ x, ts: canonicalJson(x), sql: rows[i]?.t })).filter((d) => d.ts !== d.sql);
    expect(differ.slice(0, 3)).toEqual([]);
  });

  it('[DI-35] only catalogue meanings can be challenged; a stale content version is refused', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    await expectRefused(challengeFor(db, op, id, { meaning: 'ACKNOWLEDGED' }), 'EBMR-ESIG-026');
    const content = await contentForSigning(db.app, 'esig_stub', id);
    await expectRefused(
      withCommand(db.app, await cmd(db, op), (c) =>
        c.query('select esig.create_challenge($1, $2, 2, $3, $4)', ['esig_stub', id, 'PERFORMED', content.contentHash])),
      'EBMR-ESIG-012',
    );
    await expectRefused(challengeFor(db, op, randomUUID(), { meaning: 'PERFORMED' }), 'EBMR-ESIG-011');
  });
});

describe('sign (outline 5.5 step 3; INV-10)', () => {
  it('[INV-10][DI-38] a signature consumes the signer\'s own authentication event for its challenge, with both components, and is sealed', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    const { rows } = await db.admin.query(
      `select s.signer_person, s.auth_event_id, s.components_used, s.components_required, s.challenge_id, e.challenge_id as event_challenge,
              (select array_agg(use_kind order by use_kind) from iam.auth_event_use u where u.auth_event_id = s.auth_event_id) as uses,
              x.key_id, x.algorithm
         from esig.signature s join iam.auth_event e on e.id = s.auth_event_id join esig.signature_seal x on x.signature_id = s.id
        where s.id = $1`,
      [sig.signatureId],
    );
    const r = rows[0] as Record<string, unknown>;
    expect(r['signer_person']).toBe(op.personId);
    expect(r['components_used']).toEqual(['USER_ID', 'PASSWORD']);
    expect(r['components_required']).toBe('ALL');
    expect(r['event_challenge']).toBe(r['challenge_id']);
    expect(r['uses']).toEqual(['SIGNATURE']);
    expect(r).toMatchObject({ key_id: 'test-hmac-1', algorithm: 'HMAC-SHA256' });
    expect(sig.componentsRequired).toBe('ALL');
  });

  it('[INV-10] an authentication event can serve one signature only, and a challenge only once', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    await signWith(db, op, ch.challengeId, ev);
    await expectRefused(signWith(db, op, ch.challengeId, ev), 'EBMR-ESIG-032');
    const other = await createStub(db, op);
    const ch2 = await challengeFor(db, op, other, { meaning: 'PERFORMED' });
    // The used event, even though made for another challenge, is refused; a fresh event for another challenge too.
    await expectRefused(signWith(db, op, ch2.challengeId, ev), 'EBMR-IAM-094');
    const evOther = await signatureAuth(db, op, op, ch.challengeId);
    await expectRefused(signWith(db, op, ch2.challengeId, evOther), 'EBMR-IAM-094');
  });

  it('[INV-10] an authentication event of another person is refused (no proxy signing)', async () => {
    const op = await testActor(db);
    const colleague = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const evColleague = await signatureAuth(db, colleague, op, ch.challengeId);
    await expectRefused(signWith(db, op, ch.challengeId, evColleague), 'EBMR-IAM-093');
    expect(await dbCount(db, 'select 1 from esig.signature where aggregate_id = $1', [id])).toBe(0);
  });

  it('[INV-10] a command-attribution tap, a login event or no event at all can never complete a signature', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const login = await freshAuthEvent(db, op, 'LOGIN');
    await expectRefused(signWith(db, op, ch.challengeId, login), 'EBMR-IAM-096');
    await expectRefused(
      withCommand(db.app, await cmd(db, op), (c) => c.query('select esig.sign($1, null)', [ch.challengeId])),
      'EBMR-ESIG-030',
    );
  });

  it('[INV-10] an authentication event older than the challenge validity, or an expired challenge, is refused', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    await asTimeTraveller(db, "update iam.auth_event set recorded_at = recorded_at - interval '10 minutes' where id = $1", [ev]);
    await expectRefused(signWith(db, op, ch.challengeId, ev), 'EBMR-IAM-092');
    const ch2 = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    await asTimeTraveller(db, "update esig.challenge set expires_at = clock_timestamp() - interval '1 second' where id = $1", [ch2.challengeId]);
    const ev2 = await signatureAuth(db, op, op, ch2.challengeId);
    await expectRefused(signWith(db, op, ch2.challengeId, ev2), 'EBMR-ESIG-033');
  });

  it('[INV-10] the signer must authenticate on the terminal that shows the challenge', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const elsewhere = await testActor(db);
    const ev = await signatureAuth(db, op, elsewhere, ch.challengeId);
    await expectRefused(signWith(db, op, ch.challengeId, ev), 'EBMR-ESIG-036');
  });

  it('[INV-10] a challenge is bound to its session: another session of the signer cannot use it', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    const other = await testActor(db, { roleCode: 'OPERATOR' });
    await expectRefused(
      withCommand(db.app, await cmd(db, other), (c) => sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey)),
      'EBMR-ESIG-034',
    );
  });

  it('[INV-10] any failure aborts everything: a signature that is not sealed never commits, and its event stays unused', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    await expectRefused(
      withCommand(db.app, await cmd(db, op), (c) => c.query("select esig.sign($1, $2, 'OPEN')", [ch.challengeId, ev])),
      'EBMR-ESIG-061',
    );
    expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1', [ch.challengeId])).toBe(0);
    expect(await dbCount(db, 'select 1 from iam.auth_event_use where auth_event_id = $1', [ev])).toBe(0);
    // A seal with an unregistered key or a malformed seal also aborts.
    await expectRefused(
      withCommand(db.app, await cmd(db, op), async (c) => {
        const r = await c.query<{ r: { signature_id: string } }>("select esig.sign($1, $2, 'OPEN') as r", [ch.challengeId, ev]);
        await c.query("select esig.seal_signature($1, 'unknown-key', 'HMAC-SHA256', $2)", [r.rows[0]?.r.signature_id, Buffer.alloc(32).toString('base64')]);
      }),
      'EBMR-ESIG-063',
    );
    expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1', [ch.challengeId])).toBe(0);
    // The same event still completes the signature properly.
    await signWith(db, op, ch.challengeId, ev);
  });

  it('[INV-10] the record state must be the one the caller expects', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    await expectRefused(signWith(db, op, ch.challengeId, ev, { expectedState: 'COMPLETED' }), 'EBMR-ESIG-039');
  });

  it('[INV-10][DI-38] the signer must hold a permitted role now, and the stored authority evaluation is referenced', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    // An operator cannot sign VERIFIED (STEP.VERIFY), even on someone else's entry.
    const other = await testActor(db);
    const id2 = await createStub(db, other);
    await expectRefused(signStub(db, op, id2, { meaning: 'VERIFIED' }), 'EBMR-ESIG-040');
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    const { rows } = await db.admin.query('select allowed, permission_code, person_id, role_code from iam.authority_evaluation where id = $1', [sig.authorityEvaluationId]);
    expect(rows[0]).toEqual({ allowed: true, permission_code: 'STEP.SIGN_PERFORMED', person_id: op.personId, role_code: 'OPERATOR' });
  });

  it('[INV-10] signCommand logs a refused signing after the rollback, with the authority evaluation', async () => {
    const op = await testActor(db);
    const other = await testActor(db);
    const id = await createStub(db, other);
    const ch = await challengeFor(db, op, id, { meaning: 'VERIFIED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    await expectRefused(signCommand(db.app, await cmd(db, op), { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey), 'EBMR-ESIG-040');
    expect(await dbCount(db, "select 1 from esig.signing_failure where challenge_id = $1 and code = 'EBMR-ESIG-040'", [ch.challengeId])).toBe(1);
    expect(await dbCount(db, "select 1 from iam.authority_evaluation where person_id = $1 and permission_code = 'STEP.VERIFY' and not allowed", [op.personId])).toBeGreaterThan(0);
  });
});

describe('INV-10 bypass: signatures are inserted only by the signing function', () => {
  it('[INV-10] the application role cannot insert, change or delete signatures, seals, challenges or invalidations', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    const row = (await db.admin.query('select * from esig.signature where id = $1', [sig.signatureId])).rows[0] as Record<string, unknown>;
    await expectPermissionDenied(db.app.query('insert into esig.signature (id, aggregate_type) values ($1, $2)', [randomUUID(), 'esig_stub']));
    await expectPermissionDenied(db.app.query("update esig.signature set meaning_code = 'VERIFIED' where id = $1", [sig.signatureId]));
    await expectPermissionDenied(db.app.query('delete from esig.signature where id = $1', [sig.signatureId]));
    await expectPermissionDenied(db.app.query('insert into esig.signature_seal (signature_id) values ($1)', [sig.signatureId]));
    await expectPermissionDenied(db.app.query('insert into esig.challenge (id) values ($1)', [randomUUID()]));
    await expectPermissionDenied(db.app.query('insert into esig.signature_invalidation (signature_id) values ($1)', [sig.signatureId]));
    await expectPermissionDenied(db.app.query('delete from esig.signature_seal where signature_id = $1', [sig.signatureId]));
    await expectPermissionDenied(db.app.query("select iam.consume_auth_event($1, $2, $3, interval '1 minute')", [row['auth_event_id'], op.personId, row['challenge_id']]));
    await expectPermissionDenied(db.app.query("select esig.register_signed_table('esig.stub_signable', 'x', 'id')"));
    await expectPermissionDenied(db.app.query("select esig.register_content_provider('esig_stub', 'esig.stub_content(text)', 'x')"));
    // Internal steps of the signing and invalidation paths are not callable on their own.
    await expectPermissionDenied(db.app.query("select esig.content_changed('esig_stub', $1, 'esig.stub_signable', 'UPDATE')", [id]));
    await expectPermissionDenied(db.app.query("select esig.provide('esig_stub', $1)", [id]));
    await expectPermissionDenied(db.app.query("select esig.platform_signature_check($1, 'PERFORMED', 'esig_stub', $2, '{}'::jsonb)", [sig.signatureId, id]));
    await expectPermissionDenied(db.app.query('select esig.aggregate_lock($1, $2)', ['esig_stub', id]));
  });

  it('[INV-10] even the table owner cannot insert a signature outside esig.sign, nor change or delete one', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    await asSuperuserTransaction(db, async (c) => {
      await c.query('set local role ebmr_owner');
      await c.query('savepoint a');
      await expectRefused(
        c.query(`insert into esig.signature select * from esig.signature where id = $1`, [sig.signatureId]),
        'EBMR-ESIG-060',
      );
      await c.query('rollback to savepoint a');
      await expectRefused(c.query("update esig.signature set signer_legal_name = 'Someone Else' where id = $1", [sig.signatureId]), 'EBMR-AUDIT-004');
      await c.query('rollback to savepoint a');
      await expectRefused(c.query('delete from esig.signature where id = $1', [sig.signatureId]), 'EBMR-AUDIT-004');
      await c.query('rollback to savepoint a');
      await expectRefused(c.query('delete from esig.signature_seal where signature_id = $1', [sig.signatureId]), 'EBMR-AUDIT-004');
      await c.query('rollback to savepoint a');
      await expectRefused(c.query('truncate esig.signature cascade'), 'EBMR-AUDIT-004');
    });
  });

  /**
   * The same defect as D11 of the Phase 2 exit (the state history taken on a session setting any role can set): the
   * signature guard took a row on the signing marker alone, and the table owner can set that marker to the id of an
   * open challenge. Kernel 1112 holds the row to its challenge and to the authentication event esig.sign consumes.
   */
  it('[INV-10][DI-37] with the signing marker forged for an open challenge, even the table owner cannot insert a signature the challenge and its authentication do not back: other content, another signer or other meaning wording than the challenge names (EBMR-ESIG-065), or an authentication event not consumed for that challenge in the same transaction (EBMR-ESIG-066)', async () => {
    const op = await testActor(db);
    const other = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    // An authentication event made for the challenge on another connection, committed, never consumed.
    const unconsumed = await signatureAuth(db, op, op, ch.challengeId);
    const FROM_CHALLENGE = `
      insert into esig.signature (aggregate_type, aggregate_id, aggregate_ref, content_version, content_hash, meaning_code, meaning_version,
                                  meaning_title, meaning_text, signer_person, signer_account, signer_login, signer_legal_name, signer_role_code,
                                  signer_role_name, session_id, session_person, cosignature, device_id, auth_event_id, auth_method,
                                  components_used, components_required, authority_evaluation_id, challenge_id, correlation_id, site_zone,
                                  utc_offset, manifestation, manifestation_text)
      select c.aggregate_type, c.aggregate_id, c.aggregate_ref, c.content_version, coalesce($2, c.content_hash), c.meaning_code, c.meaning_version,
             coalesce($4, t.title), t.meaning_text, c.signer_person, coalesce($3::uuid, c.signer_account), 'login', 'A. Name', 'ROLE', 'Role',
             c.session_id, c.session_person, c.cosignature, c.device_id, coalesce($5::uuid, gen_random_uuid()), 'PASSWORD',
             array['USER_ID', 'PASSWORD'], 'ALL', gen_random_uuid(), c.id, gen_random_uuid(), 'Asia/Kolkata', '+00:00', '{}'::jsonb, ''
        from esig.challenge c join esig.meaning_type t on t.code = c.meaning_code and t.version = c.meaning_version
       where c.id = $1`;
    const CHALLENGE = 'EBMR-ESIG-065 INV-10: a signature names exactly the record, content, meaning, signer, session and terminal of its challenge';
    const AUTHENTICATION =
      'EBMR-ESIG-066 INV-10: a signature consumes, in its own transaction, an authentication event of its signer made for its challenge on its terminal';
    const ctx = toDbContext(await cmd(db, op));
    await asSuperuserTransaction(db, async (c) => {
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(ctx)]);
      await c.query('set local role ebmr_owner');
      const attempt = async (o: { hash?: string; account?: string; title?: string; authEvent?: string }): Promise<string> => {
        await c.query('savepoint a');
        try {
          await c.query("select set_config('esig.signing_challenge', $1, true)", [ch.challengeId]);
          await c.query(FROM_CHALLENGE, [ch.challengeId, o.hash ?? null, o.account ?? null, o.title ?? null, o.authEvent ?? null]);
          return 'accepted';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        } finally {
          await c.query('rollback to savepoint a');
        }
      };
      expect(await attempt({ hash: 'a'.repeat(64) })).toBe(CHALLENGE);
      expect(await attempt({ account: other.accountId })).toBe(CHALLENGE);
      expect(await attempt({ title: 'Approved by the quality unit' })).toBe(CHALLENGE);
      // Exactly what the challenge names, with an authentication event no one made, or one made for it but not consumed.
      expect(await attempt({})).toBe(AUTHENTICATION);
      expect(await attempt({ authEvent: unconsumed })).toBe(AUTHENTICATION);
    });
    expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1', [ch.challengeId])).toBe(0);
  });

  it('[INV-10] a forged authentication event with a single component cannot complete a signature (two distinct components)', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    for (const components of [['USER_ID'], ['PASSWORD'], ['BADGE'], ['FINGERPRINT', 'PIN']]) {
      const ev = await syntheticAuthEvent(db, op, op, ch.challengeId, components);
      await expectRefused(signWith(db, op, ch.challengeId, ev), 'EBMR-ESIG-038');
    }
    expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1', [ch.challengeId])).toBe(0);
  });

  it('[INV-10] the invariant query finds no signature without its consumed event, challenge and seal', async () => {
    const { rows } = await db.admin.query(`
      select s.id from esig.signature s
      where not exists (select 1 from iam.auth_event_use u where u.auth_event_id = s.auth_event_id and u.use_kind = 'SIGNATURE')
         or not exists (select 1 from esig.challenge c where c.id = s.challenge_id and c.signer_person = s.signer_person)
         or not exists (select 1 from esig.signature_seal x where x.signature_id = s.id)`);
    expect(rows).toEqual([]);
    expect(await dbCount(db, 'select 1 from esig.signature')).toBeGreaterThan(0);
  });
});

describe('one record, one identity (DI-37)', () => {
  it('[DI-37][INV-03] a record is signed only under its canonical id: another spelling of the same entry is refused', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const content = await contentForSigning(db.app, 'esig_stub', id);
    for (const alias of [id.toUpperCase(), `{${id}}`, id.replace(/-/g, '')]) {
      const shown = await contentForSigning(db.app, 'esig_stub', alias);
      expect(shown.exists).toBe(false);
      expect(shown.problem ?? '').toMatch(new RegExp(`^EBMR-ESIG-014 .*canonical id is ${id}$`));
      await expectRefused(
        run(db, op, (c) => createChallenge(c, {
          aggregateType: 'esig_stub', aggregateId: alias, contentVersion: '1', meaning: 'PERFORMED', clientContentHash: content.contentHash ?? '',
        })),
        'EBMR-ESIG-014', new RegExp(`canonical id is ${id}`),
      );
    }
    expect(await dbCount(db, "select 1 from esig.challenge where aggregate_type = 'esig_stub' and lower(aggregate_id) like '%' || $1 || '%'",
                         [id.replace(/-/g, '').slice(0, 8)])).toBe(0);
    // Under its own id the entry is signed as usual.
    await signStub(db, op, id, { meaning: 'PERFORMED' });
  });
});

describe('refused signings reach the security unit (DI-19)', () => {
  const alertsFor = async (authEventId: string): Promise<{ severity: string; person_id: string; code: string; reported: string }[]> =>
    (await db.admin.query<{ severity: string; person_id: string; code: string; reported: string }>(
      `select severity, person_id::text, details ->> 'code' as code, details ->> 'reported_code' as reported from iam.security_alert
        where kind = 'SIGNING_FAILED' and details ->> 'auth_event_id' = $1`, [authEventId])).rows;

  it('[DI-19] a reported failure raises an alert only on misuse the database finds: the application cannot accuse anybody', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    // The application role, with no command at all, reports proxy signing for the signer's own clean event.
    await db.app.query('select esig.record_signing_failure($1, $2, $3, $4)', [ch.challengeId, ev, 'EBMR-IAM-093', 'forged: proxy signing attempt']);
    await db.app.query('select esig.record_signing_failure($1, null, $2, $3)', [ch.challengeId, 'EBMR-ESIG-036', 'forged: another terminal']);
    expect(await alertsFor(ev)).toEqual([]);
    expect(await dbCount(db, "select 1 from iam.security_alert where kind = 'SIGNING_FAILED' and person_id = $1", [op.personId])).toBe(0);
    // The reports are logged as reported, with no misuse found.
    const { rows } = await db.admin.query('select code, misuse_code from esig.signing_failure where challenge_id = $1 order by id', [ch.challengeId]);
    expect(rows).toEqual([{ code: 'EBMR-IAM-093', misuse_code: null }, { code: 'EBMR-ESIG-036', misuse_code: null }]);
    // A failure is logged against a real challenge only.
    await expectRefused(db.app.query('select esig.record_signing_failure($1, null, $2, $3)', [randomUUID(), 'EBMR-IAM-093', 'x']), 'EBMR-ESIG-031');
    // The event is still good for the real signing.
    await signWith(db, op, ch.challengeId, ev);
  });

  it('[DI-19][INV-10] a proxy signing attempt reaches the security unit whether or not the application reports it', async () => {
    const op = await testActor(db);
    const colleague = await testActor(db, { legalName: 'Proxy Colleague' });
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const evColleague = await signatureAuth(db, colleague, op, ch.challengeId);
    const unreported = async (): Promise<number> =>
      dbCount(db, "select 1 from esig.invariant_violations() where invariant = 'DI-19' and detail like $1", [`%${evColleague}%`]);
    // Refused, and the application does not report it: the invariant query shows the unalerted misuse.
    await expectRefused(signWith(db, op, ch.challengeId, evColleague), 'EBMR-IAM-093');
    expect(await unreported()).toBe(1);
    // Reported by signCommand after the rollback: one HIGH alert naming the person who authenticated.
    await expectRefused(signCommand(db.app, await cmd(db, op), { challengeId: ch.challengeId, authEventId: evColleague, expectedState: 'OPEN' }, testSealKey),
                        'EBMR-IAM-093');
    expect(await alertsFor(evColleague)).toEqual([{ severity: 'HIGH', person_id: colleague.personId, code: 'EBMR-IAM-093', reported: 'EBMR-IAM-093' }]);
    expect(await unreported()).toBe(0);
    // A repeated attempt is logged again but alerts once.
    await expectRefused(signCommand(db.app, await cmd(db, op), { challengeId: ch.challengeId, authEventId: evColleague, expectedState: 'OPEN' }, testSealKey),
                        'EBMR-IAM-093');
    expect(await alertsFor(evColleague)).toHaveLength(1);
    expect(await dbCount(db, "select 1 from esig.signing_failure where auth_event_id = $1 and misuse_code = 'EBMR-IAM-093'", [evColleague])).toBe(2);
  });
});
