/**
 * Designer free text no record can hold (review F32, F33; DI-04, IN-02). MBR content is hashed in TypeScript
 * (flow.mbrContentHash) and again in the database (recipe.json_hash, checked by the mbr_content trigger); notes, product
 * names and justifications go to text columns. Before the fix a step name, note, product name or justification holding
 * U+0000 or a lone surrogate was answered 500 INTERNAL (jsonb 22P05 or 22P02, text 22021), and a lone surrogate in a
 * justification was accepted and stored as U+FFFD: node-postgres encodes a text parameter as UTF-8 and replaces it, so
 * the record held a character the author never sent.
 *
 * Now the contract refuses such text anywhere in a route's params, query and body as 400 INVALID_INPUT naming the field
 * (storableText); a body whose bytes are not UTF-8 is refused before it is read (installStrictJsonBodies), never read as
 * U+FFFD; flow.parseMbr reports such text with its path. Adversarial text a record can hold saves with agreeing hashes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER, IDEMPOTENCY_HEADER, routes, type Result, type VersionView } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core/pure';
import { outcomeOf } from '../execution/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, findPhase, justifyBody, parameter, saveContent, startDesignerServer, valueOf } from './support.ts';

let server: TestServer;
let author: TestBrowser;

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
}, 180_000);
afterAll(async () => {
  await server?.close();
});

const ADVERSARIAL = 'मिश्रण क्ष "quoted" back\\slash tab\t nl\n cr\r \u0001\u001f\u007f\u0085\u009f   ​﻿￿� 😀👩🏽‍🔬 \u{10FFFF} é é';

/** The version with an information-only parameter nobody records: a warning to justify (as justification-binding.test.ts does). */
async function withWarning(code: string, qty: string): Promise<{ v1: VersionView; v2: VersionView }> {
  const v1 = await createFamily(author, { familyCode: code, batchSizes: [{ quantity: qty, unit: 'kg' }] });
  const withInfo = edited(v1, (c) => {
    const p = structuredClone(parameter(c, 'blendTime')) as flow.Parameter & { name: string; id: string };
    p.id = 'pX';
    p.name = 'Room humidity (information only)';
    c.parameters.push(p);
  });
  return { v1, v2: valueOf(await saveContent(author, v1, withInfo, 'information-only parameter added')) };
}

/** A clean INVALID_INPUT refusal that names `field` and what it holds, and never repeats the text sent. */
function expectNamed(r: Result<unknown>, field: string, holds: string, sent: string): void {
  if (r.ok || r.error.kind !== 'REFUSAL') throw new Error(`${field}: expected a refusal, got ${r.ok ? 'ok' : r.error.kind}`);
  const { refusal } = r.error.envelope;
  expect({ status: r.error.status, code: refusal.code, kind: refusal.kind }, field).toEqual({ status: 400, code: 'SCHEMA', kind: 'INVALID_INPUT' });
  expect(refusal.why, field).toContain(`${field} holds ${holds}, which no record can hold`);
  expect(refusal.why.includes(sent), `${field}: the refusal does not repeat the text`).toBe(false);
}

const counts = async (versionId: string) => {
  const { rows } = await server.db.admin.query<{ revisions: string; justifications: string }>(
    'select (select count(*) from recipe.mbr_content where version_id = $1)::text as revisions, (select count(*) from tab.designer_justification where version_id = $1)::text as justifications',
    [versionId],
  );
  return rows[0];
};

describe('designer free text no record can hold (review F32, F33)', () => {
  it('[DI-04][IN-02] adversarial text a record can hold saves with agreeing TypeScript and SQL content hashes', async () => {
    const v1 = await createFamily(author, { familyCode: 'PCM500-FT1', batchSizes: [{ quantity: '71.000', unit: 'kg' }] });
    const content = edited(v1, (c) => {
      findPhase(c, 'p-disp-clear').name = `Clearance ${ADVERSARIAL}`;
      (parameter(c, 'blendTime') as flow.Parameter & { name: string }).name = `Blend time ${ADVERSARIAL}`;
    });
    const r = await saveContent(author, v1, content, `note ${ADVERSARIAL}`);
    expect(outcomeOf(r)).toBe('ok');
    const v2 = valueOf(r);
    expect(v2.contentHash).toBe(flow.mbrContentHash(v2.content as unknown as flow.MbrContent));
    const { rows } = await server.db.admin.query<{ h: string; ok: boolean }>(
      'select recipe.json_hash(content) as h, recipe.json_hash(content) = content_hash as ok from recipe.mbr_content where version_id = $1 order by revision desc limit 1',
      [v1.versionId],
    );
    expect(rows[0]).toEqual({ h: v2.contentHash, ok: true });
  }, 180_000);

  it('[DI-04][IN-02] a step name, note, product name or justification holding U+0000 or a lone surrogate is refused 400 INVALID_INPUT naming the field; nothing is saved', async () => {
    const { v1, v2 } = await withWarning('PCM500-FT2', '72.000');
    const before = await counts(v1.versionId);
    const named = (name: string) => edited(v2, (c) => void (findPhase(c, 'p-disp-clear').name = name));
    // The path of the phase's name in the content, as the contract reports it.
    const nameField = (() => {
      const path: (string | number)[] = [];
      const find = (v: unknown, at: (string | number)[]): boolean => {
        if (v !== null && typeof v === 'object') {
          if (!Array.isArray(v) && (v as { id?: unknown }).id === 'p-disp-clear') {
            path.push(...at, 'name');
            return true;
          }
          return Object.entries(v).some(([k, x]) => find(x, [...at, Array.isArray(v) ? Number(k) : k]));
        }
        return false;
      };
      find(named('x'), []);
      return `/content/${path.join('/')}`;
    })();
    expectNamed(await saveContent(author, v2, named('Booth\u0000 clearance')), nameField, 'U+0000', 'Booth');
    expectNamed(await saveContent(author, v2, named('Booth clearance \ud800')), nameField, 'an unpaired surrogate U+D800', 'Booth');
    expectNamed(await saveContent(author, v2, named('Booth clearance'), 'Renamed the booth\u0000'), '/note', 'U+0000', 'Renamed the booth');
    expectNamed(
      await author.call(routes.designer.createFamily, {
        body: { templateId: 'dc-mini', familyCode: 'PCM500-FT3', product: { code: 'PCM500', name: 'Paracetamol\u0000 tablets', strength: '500 mg' }, batchSizes: [{ quantity: '60.000', unit: 'kg' }], markets: ['IN'] },
      }),
      '/product/name',
      'U+0000',
      'Paracetamol',
    );
    expectNamed(
      await author.call(routes.designer.justify, { params: { versionId: v1.versionId }, body: justifyBody(v2, 'DATA-SINGLE-WRITER@pX', 'Room humidity is in the room log\u0000.') }),
      '/text',
      'U+0000',
      'Room humidity',
    );
    // The live validator's request is refused the same way, naming the place.
    expectNamed(await author.call(routes.designer.validate, { body: { versionId: v1.versionId, content: named('Booth\u0000 clearance') as never } }), nameField, 'U+0000', 'Booth');
    expect(await counts(v1.versionId)).toEqual(before);
    const family = await server.db.admin.query("select 1 from recipe.mbr_family where code = 'PCM500-FT3'");
    expect(family.rowCount).toBe(0);
  }, 180_000);

  it('[DI-04][IN-02] a lone surrogate in a justification, sent as the ASCII escape a browser sends, is refused: never stored as U+FFFD', async () => {
    const { v1, v2 } = await withWarning('PCM500-FT4', '74.000');
    const before = await counts(v1.versionId);
    const raw = JSON.stringify(justifyBody(v2, 'DATA-SINGLE-WRITER@pX', 'Room humidity is in the room log \udbff.'));
    // The wire text is plain ASCII: nothing on the client side replaced the lone surrogate.
    expect(raw).toContain('\\udbff');
    expect(/^[\x20-\x7e]*$/.test(raw)).toBe(true);
    const res = await author.inject({
      method: 'POST',
      url: routes.designer.justify.path.replace(':versionId', v1.versionId),
      payload: raw,
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: author.csrf ?? '', [IDEMPOTENCY_HEADER]: crypto.randomUUID() },
    });
    const body = JSON.parse(res.body) as { refusal?: { code: string; kind: string; why: string } };
    expect({ status: res.statusCode, code: body.refusal?.code, kind: body.refusal?.kind }).toEqual({ status: 400, code: 'SCHEMA', kind: 'INVALID_INPUT' });
    expect(body.refusal?.why).toContain('/text holds an unpaired surrogate U+DBFF, which no record can hold');
    expect(await counts(v1.versionId)).toEqual(before);
    const fffd = await server.db.admin.query("select 1 from tab.designer_justification where version_id = $1 and position(U&'\\FFFD' in text) > 0", [v1.versionId]);
    expect(fffd.rowCount).toBe(0);
  }, 180_000);

  it('[DI-04][IN-02] a body whose bytes are not UTF-8 is refused before it is read, never read as U+FFFD; nothing is stored', async () => {
    const { v1, v2 } = await withWarning('PCM500-FT5', '75.000');
    const before = await counts(v1.versionId);
    const text = JSON.stringify(justifyBody(v2, 'DATA-SINGLE-WRITER@pX', 'Room humidity is in the room log MARK.'));
    const [head, tail] = text.split('MARK') as [string, string];
    // 0xF0 0x9F 0x98 is a four-byte sequence cut short: Fastify's replacing reader made it one U+FFFD of the same byte
    // length, so its Content-Length check passed and the justification was stored holding U+FFFD (review F33 round 2).
    // 0xFF never occurs in UTF-8; 0xED 0xA0 0x80 would be the surrogate U+D800, which UTF-8 does not encode either.
    for (const bad of [Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from([0xff]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xc3])]) {
      const res = await author.inject({
        method: 'POST',
        url: routes.designer.justify.path.replace(':versionId', v1.versionId),
        payload: Buffer.concat([Buffer.from(head, 'utf8'), bad, Buffer.from(tail, 'utf8')]),
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: author.csrf ?? '', [IDEMPOTENCY_HEADER]: crypto.randomUUID() },
      });
      const body = JSON.parse(res.body) as { refusal?: { code: string; kind: string; why: string } };
      expect({ bytes: bad.toString('hex'), status: res.statusCode, code: body.refusal?.code, kind: body.refusal?.kind, why: body.refusal?.why }).toEqual({
        bytes: bad.toString('hex'),
        status: 400,
        code: 'SCHEMA',
        kind: 'INVALID_INPUT',
        why: 'The request body is not UTF-8 text: a byte sequence in it stands for no character, so it was not read.',
      });
    }
    expect(await counts(v1.versionId)).toEqual(before);
    expect((await server.db.admin.query("select 1 from tab.designer_justification where version_id = $1 and text like '%\uFFFD%'", [v1.versionId])).rowCount).toBe(0);
    // The same body in UTF-8 is taken, character for character.
    const ok = await author.inject({
      method: 'POST',
      url: routes.designer.justify.path.replace(':versionId', v1.versionId),
      payload: Buffer.from(text.replace('MARK', 'é 😀'), 'utf8'),
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: author.csrf ?? '', [IDEMPOTENCY_HEADER]: crypto.randomUUID() },
    });
    expect(ok.statusCode).toBe(200);
    const stored = await server.db.admin.query<{ text: string }>('select text from tab.designer_justification where version_id = $1 order by recorded_at desc limit 1', [v1.versionId]);
    expect(stored.rows[0]?.text).toBe('Room humidity is in the room log é 😀.');
  }, 180_000);

  it('[DI-04][IN-02] control: a well-formed surrogate pair (an emoji) in a justification round-trips exactly', async () => {
    const { v1, v2 } = await withWarning('PCM500-FT6', '76.000');
    const sent = 'Room humidity is in the room log \u{1F600}.';
    const r = await author.call(routes.designer.justify, { params: { versionId: v1.versionId }, body: justifyBody(v2, 'DATA-SINGLE-WRITER@pX', sent) });
    expect(outcomeOf(r)).toBe('ok');
    const stored = await server.db.admin.query<{ text: string }>('select text from tab.designer_justification where version_id = $1 order by recorded_at desc limit 1', [v1.versionId]);
    expect(stored.rows[0]?.text).toBe(sent);
  }, 180_000);
});
