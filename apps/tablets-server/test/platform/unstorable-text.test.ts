/**
 * The lines behind the contract for text no record can hold (review F30-F33): U+0000 and a UTF-16 surrogate without its
 * other half.
 *  - The database is the last line: it refuses U+0000 in a text parameter (22021) and in jsonb (22P05) and a lone
 *    surrogate's escape in jsonb (22P02). It cannot refuse a lone surrogate in a text parameter: node-postgres encodes it
 *    as UTF-8, which writes U+FFFD in its place, so the database would store a character nobody sent.
 *  - So the server's pools refuse a query whose parameters hold such text before the driver encodes it
 *    (refuseUnstorableParameters), and the error mapper answers each of these refusals 400 INVALID_INPUT, never 500
 *    INTERNAL (logged at warn: the contract should have refused the request first).
 *  - The contract refuses such text in path parameters and query strings too, naming them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CanonicalJsonError, canonicalJson, UnstorableTextError } from '@ebmr/expr';
import { openDatabase, type DatabaseHandle } from '@ebmr/test-kit';
import { routes } from '@ebmr/api-contract';
import { unstorableParameter } from '../../src/platform/db/pools.ts';
import { mapError } from '../../src/platform/http/errors.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let server: TestServer;
/** The application role's own pools on the server's database, without the server's guard (the database's own refusals). */
let raw: DatabaseHandle;

beforeAll(async () => {
  server = await startServer('GMP');
  raw = openDatabase(server.database, 'GMP');
}, 180_000);
afterAll(async () => {
  await raw?.close();
  await server?.close();
});

/** The error a query rejects with. */
async function failure(run: Promise<unknown>): Promise<Error & { code?: string; detail?: string }> {
  try {
    await run;
  } catch (e) {
    return e as Error & { code?: string; detail?: string };
  }
  throw new Error('expected the query to fail');
}

const mapped = (error: unknown) => {
  const m = mapError(server.built.ctx, error, 'cid-test');
  return { status: m.status, code: m.envelope.refusal.code, kind: m.envelope.refusal.kind, why: m.envelope.refusal.why, warn: m.warn ?? false };
};

describe('text no record can hold, behind the contract (review F30-F33)', () => {
  it('[DI-37][DI-34] the database refuses U+0000 in a text parameter (22021) and in jsonb (22P05) and a lone surrogate in jsonb (22P02); the error mapper answers each 400 INVALID_INPUT, never 500, without the text', async () => {
    const version = randomUUID();
    const justification = await failure(raw.app.query('select tab.record_designer_justification($1, $2, $3, $4)', [version, 'DATA-SINGLE-WRITER@pX', 'Room humidity\u0000', 'a'.repeat(64)]));
    expect(justification.code).toBe('22021');
    const nul = await failure(raw.app.query('select $1::jsonb', [JSON.stringify({ outcome: 'NO_IMPACT', justification: 'Reprinted\u0000 label checked' })]));
    expect(nul.code).toBe('22P05');
    const lone = await failure(raw.app.query('select $1::jsonb', [JSON.stringify({ comment: 'Booth released \udfff' })]));
    expect(lone.code).toBe('22P02');
    expect(lone.detail).toMatch(/surrogate/i);
    const written = await server.db.admin.query('select 1 from tab.designer_justification where version_id = $1', [version]);
    expect(written.rowCount).toBe(0);
    for (const [error, state] of [
      [justification, '22021'],
      [nul, '22P05'],
      [lone, '22P02'],
    ] as const) {
      expect(mapped(error)).toEqual({
        status: 400,
        code: 'SCHEMA',
        kind: 'INVALID_INPUT',
        why: `The request holds text no record can hold (U+0000, or half of a surrogate pair); it was refused by the database (SQLSTATE ${state}) and nothing was saved.`,
        warn: true,
      });
      // Wrapped by a command, the refusal is found through its cause.
      expect(mapped(new Error('the command failed', { cause: error })).status).toBe(400);
    }
    // Any other invalid text representation is no client text: still INTERNAL.
    const uuid = await failure(raw.app.query("select 'not-a-uuid'::uuid"));
    expect(uuid.code).toBe('22P02');
    expect(mapped(uuid)).toMatchObject({ status: 500, code: 'INTERNAL', warn: false });
  });

  it('[DI-37] a canonical hash refused for such text is answered 400 INVALID_INPUT; any other canonical JSON refusal stays a programming error (500)', () => {
    const unstorable = (() => {
      try {
        canonicalJson({ title: 'a\ud800' });
      } catch (e) {
        return e;
      }
      throw new Error('expected a refusal');
    })();
    expect(unstorable).toBeInstanceOf(UnstorableTextError);
    expect(mapped(unstorable)).toEqual({
      status: 400,
      code: 'SCHEMA',
      kind: 'INVALID_INPUT',
      why: 'The request holds text no record can hold (U+0000, or half of a surrogate pair); it was refused before it reached the database and nothing was saved.',
      warn: true,
    });
    expect(mapped(new CanonicalJsonError('a Date has no canonical JSON form'))).toMatchObject({ status: 500, code: 'INTERNAL' });
  });

  it('[DI-37] the database cannot refuse a lone surrogate in a text parameter (the driver writes U+FFFD); the server\'s pools refuse such a query before it is sent, U+0000 too, in any parameter', async () => {
    // Without the guard: the text the database receives and stores is not the text that was sent.
    const replaced = await raw.app.query<{ t: string }>('select $1::text as t', ['Room humidity \udbff.']);
    expect(replaced.rows[0]?.t).toBe('Room humidity �.');
    // The server's pools (guarded by buildApp; clients opened before the guard are guarded when handed out).
    const app: pg.Pool = server.db.app;
    const refused = async (run: Promise<unknown>, message: string) => {
      const e = await failure(run);
      expect(e).toBeInstanceOf(UnstorableTextError);
      expect(e.message).toBe(`the query was not sent: its ${message}, which no record can hold`);
      expect(mapped(e).status).toBe(400);
    };
    await refused(app.query('select $1::text as t', ['Room humidity \udbff.']), 'parameter $1 holds an unpaired surrogate U+DBFF');
    await refused(app.query('select $1::text, $2::text[]', ['ok', ['fine', 'Booth\u0000']]), 'parameter $2 holds U+0000');
    await refused(app.query({ text: 'select $1::jsonb', values: [{ ['k\u0000']: 1 }] }), 'parameter $1 holds U+0000');
    await refused(server.db.authn.pool.query('select $1::text', ['\udc00 badge']), 'parameter $1 holds an unpaired surrogate U+DC00');
    const client = await app.connect();
    try {
      await refused(client.query('select $1::text', ['x\ud800']), 'parameter $1 holds an unpaired surrogate U+D800');
      // The callback form of the driver gets the refusal as its error.
      const viaCallback = await new Promise<unknown>((resolve) => {
        client.query('select $1::text', ['x\u0000'], (err: Error | null) => resolve(err));
      });
      expect(viaCallback).toBeInstanceOf(UnstorableTextError);
      // Text a record can hold goes through exactly; bytes are not text (a bytea with 0x00 is fine).
      const ok = await client.query<{ t: string; b: Buffer }>('select $1::text as t, $2::bytea as b', ['é 😀 � \u0001', Buffer.from([0, 1, 0])]);
      expect(ok.rows[0]).toEqual({ t: 'é 😀 � \u0001', b: Buffer.from([0, 1, 0]) });
    } finally {
      client.release();
    }
    expect(unstorableParameter(['a', 1, null, new Date(0), Buffer.from([0]), { a: ['b'] }])).toBeNull();
  });

  it('[DI-37][DI-22] a path parameter or query string holding U+0000 is refused 400 naming it, never 500 (the database refused it before as 22021)', async () => {
    const author = await server.asPersona('author');
    const verify = await author.inject({ method: 'GET', url: '/api/audit/chains/mbr_version%3Ax%00y/verify' });
    const v = JSON.parse(verify.body) as { refusal: { code: string; kind: string; why: string } };
    expect({ status: verify.statusCode, code: v.refusal.code, kind: v.refusal.kind }).toEqual({ status: 400, code: 'SCHEMA', kind: 'INVALID_INPUT' });
    expect(v.refusal.why).toBe('/chainKey holds U+0000, which no record can hold: enter the text again without it');
    const chains = await author.inject({ method: 'GET', url: `${routes.audit.chains.path}?prefix=mbr%00` });
    const c = JSON.parse(chains.body) as { refusal: { code: string; why: string } };
    expect({ status: chains.statusCode, code: c.refusal.code, why: c.refusal.why }).toEqual({ status: 400, code: 'SCHEMA', why: '/prefix holds U+0000, which no record can hold: enter the text again without it' });
  });
});
