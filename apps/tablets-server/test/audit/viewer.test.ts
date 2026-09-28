/**
 * The audit trail viewer (module C1; plan section 11; DI-22, DI-23): who, what, when, why and how of every entry,
 * business entries and field changes, chain verification that detects tampering, filters with keyset paging, and a
 * route inventory without any audit mutation, on both installations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allRoutes, routes, type AuditEventView } from '@ebmr/api-contract';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { correctStub, createStub, outcome, personaIn, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';

let gmp: TestServer;
let sbx: TestServer;
let author: TestBrowser;
let stub: string;

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startSigningServer('GMP'), startSigningServer('SANDBOX')]);
  author = await gmp.asPersona('author');
  stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg, section 5', value: 'granulation v1', unit: '' });
  await correctStub(gmp, author, 'author', stub, 'granulation v2');
});
afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

async function allEvents(b: TestBrowser, query: Record<string, string>): Promise<AuditEventView[]> {
  const out: AuditEventView[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i += 1) {
    const page = valueOf(await b.call(routes.audit.events, { query: { ...query, ...(cursor ? { cursor } : {}) } }));
    out.push(...page.events);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

describe('audit entries', () => {
  it('[DI-22][DI-23] an entry shows who (legal name, user ID, role), what (fields old and new), when (site time with offset, UTC), why (reason) and how (terminal)', async () => {
    const me = personaIn(gmp, 'author');
    const events = await allEvents(author, { chainKey: `esig_stub:${stub}` });
    expect(events.map((e) => `${e.seq}:${e.kind}:${e.action}`)).toEqual(['1:ROW:INSERT', '2:ROW:UPDATE']);
    const [created, changed] = events;
    expect(created).toMatchObject({ who: { personId: me.personId, legalName: 'Asha Rao', loginName: 'asha.rao', role: 'MBR_AUTHOR' }, device: 'PC-DESIGN-01', why: null, table: 'esig.stub_signable', recordId: stub });
    expect(created?.changes).toContainEqual({ field: 'value', old: null, new: 'granulation v1' });
    expect(changed).toMatchObject({ why: 'ENTRY_ERROR: transcription error corrected', summary: expect.stringContaining('value') as unknown as string });
    expect(changed?.changes).toContainEqual({ field: 'value', old: 'granulation v1', new: 'granulation v2' });
    expect(changed?.changes).toContainEqual({ field: 'content_version', old: '1', new: '2' });
    expect(changed?.at.text).toMatch(/^\d{2}-[A-Z]{3}-\d{4} \d{2}:\d{2}:\d{2} \+05:30 \(Asia\/Kolkata\)$/);
    expect(BigInt(changed?.at.us ?? '0')).toBeGreaterThan(BigInt(created?.at.us ?? '0'));
    expect(changed?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-22] a signature adds a plain-language business entry on the record\'s own chain, with the same correlation as its signature rows', async () => {
    const content = valueOf(await author.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stub, intent: 'PREPARED' } }));
    const { sha256Hex } = await import('@ebmr/expr');
    const ch = valueOf(
      await author.call(routes.esig.createChallenge, {
        body: { aggregateType: 'esig_stub', aggregateId: stub, contentVersion: content.contentVersion, meaning: 'PREPARED', clientContentHash: sha256Hex(content.canonicalText), action: { kind: 'ESIG_STUB', stubId: stub } },
      }),
    );
    const me = personaIn(gmp, 'author');
    const body = { challengeId: ch.challengeId, credentials: { kind: 'PASSWORD' as const, loginName: me.loginName, password: me.password }, action: { kind: 'ESIG_STUB' as const, stubId: stub } };
    valueOf(await author.call(routes.esig.sign, { body: { ...body, proof: await author.proof('POST', '/api/esig/sign', body) } }));
    const events = await allEvents(author, { chainKey: `esig_stub:${stub}` });
    const business = events.find((e) => e.kind === 'BUSINESS');
    expect(business).toMatchObject({ summary: expect.stringMatching(/^signed PREPARED by Asha Rao \(asha\.rao\)/) as unknown as string, who: { loginName: 'asha.rao' }, changes: [] });
    const sameCommand = await allEvents(author, { correlationId: business?.correlationId ?? '' });
    expect(sameCommand.map((e) => e.chainKey)).toEqual(expect.arrayContaining([`esig_signature:esig_stub:${stub}`, `esig_stub:${stub}`]));
  });

  it('[DI-23] verifyChain is green on an intact chain and names the entry whose stored payload was altered', async () => {
    const ok = valueOf(await author.call(routes.audit.verifyChain, { params: { chainKey: `esig_stub:${stub}` } }));
    expect(ok).toMatchObject({ chainKey: `esig_stub:${stub}`, ok: true, problems: [] });
    expect(ok.events).toBeGreaterThanOrEqual(3);
    // A superuser rewrites a stored value behind the audit trail's back (triggers off).
    const victim = await allEvents(author, { chainKey: `esig_stub:${stub}` });
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(`update kernel.audit_event set payload = jsonb_set(payload, '{body,new,value}', '"forged"') where id = $1`, [victim[0]?.eventId]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const bad = valueOf(await author.call(routes.audit.verifyChain, { params: { chainKey: `esig_stub:${stub}` } }));
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/^entry 1: .*altered/);
    expect(outcome(await author.call(routes.audit.verifyChain, { params: { chainKey: 'esig_stub:no-such-record' } }))).toBe('404:AUDIT_CHAIN_NOT_FOUND');
  });
});

describe('filters and paging', () => {
  it('[DI-22] events filter by chain, correlation, person and time, and page by keyset without gaps or repeats', async () => {
    const me = personaIn(gmp, 'author');
    const all = await allEvents(author, { chainKey: `esig_stub:${stub}` });
    const paged: AuditEventView[] = [];
    let cursor: string | undefined;
    do {
      const page = valueOf(await author.call(routes.audit.events, { query: { chainKey: `esig_stub:${stub}`, limit: '1', ...(cursor ? { cursor } : {}) } }));
      expect(page.events.length).toBeLessThanOrEqual(1);
      paged.push(...page.events);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(paged.map((e) => e.eventId)).toEqual(all.map((e) => e.eventId));
    const mine = valueOf(await author.call(routes.audit.events, { query: { personId: me.personId, limit: '200' } })).events;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.who?.personId === me.personId)).toBe(true);
    const first = all[0];
    const last = all.at(-1);
    const window = valueOf(await author.call(routes.audit.events, { query: { chainKey: `esig_stub:${stub}`, from: last?.at.us ?? '0', to: last?.at.us ?? '0' } })).events;
    expect(window.map((e) => e.eventId)).toEqual([last?.eventId]);
    const before = valueOf(await author.call(routes.audit.events, { query: { chainKey: `esig_stub:${stub}`, to: first?.at.us ?? '0' } })).events;
    expect(before.map((e) => e.eventId)).toEqual([first?.eventId]);
    expect(outcome(await author.call(routes.audit.events, { query: { correlationId: 'not-a-uuid' } }))).toBe('400:SCHEMA');
    expect(outcome(await author.call(routes.audit.events, { query: { cursor: 'x' } }))).toBe('400:SCHEMA');
  });

  it('[DI-22] chains list by prefix with a readable label and their last activity', async () => {
    const r = valueOf(await author.call(routes.audit.chains, { query: { prefix: 'esig_stub:' } }));
    const mine = r.chains.find((c) => c.chainKey === `esig_stub:${stub}`);
    expect(mine).toMatchObject({ label: `Signable entry ${stub}` });
    expect(mine?.events).toBeGreaterThanOrEqual(2);
    expect(mine?.lastAt?.text).toMatch(/\(Asia\/Kolkata\)$/);
    expect(r.chains.every((c) => c.chainKey.startsWith('esig_stub:'))).toBe(true);
    // LIKE wildcards in the prefix are taken literally.
    expect(valueOf(await author.call(routes.audit.chains, { query: { prefix: '%' } })).chains).toEqual([]);
  });

  it('[DI-22] the sandbox installation has its own trail and viewer', async () => {
    const op = await sbx.asPersona('operator1');
    const s = await createStub(sbx, op, 'operator1');
    const events = valueOf(await op.call(routes.audit.events, { query: { chainKey: `esig_stub:${s}` } })).events;
    expect(events[0]).toMatchObject({ kind: 'ROW', action: 'INSERT', who: { loginName: 'test-operator-1', role: 'OPERATOR' }, device: 'TEST-KIOSK-DISP-1' });
    expect(valueOf(await op.call(routes.audit.verifyChain, { params: { chainKey: `esig_stub:${s}` } })).ok).toBe(true);
  });
});

describe('route inventory', () => {
  it('[DI-22][DI-23] no route edits, disables or purges the audit trail: every audit route is a read, and writes to its paths do not exist', async () => {
    for (const r of Object.values(routes.audit)) {
      expect(r.method, r.id).toBe('GET');
      expect(r.mutating, r.id).toBe(false);
    }
    const auditPaths = allRoutes(routes).filter((r) => r.path.startsWith('/api/audit'));
    expect(auditPaths.every((r) => r.method === 'GET')).toBe(true);
    expect(allRoutes(routes).filter((r) => /audit/i.test(r.id) && r.mutating)).toEqual([]);
    for (const server of [gmp, sbx]) {
      const bound = [...server.built.ctx.boundRoutes.entries()].filter(([, v]) => v.path.startsWith('/api/audit'));
      expect(bound.map(([, v]) => v.method)).toEqual(['GET', 'GET', 'GET']);
      const b = server === gmp ? author : await sbx.asPersona('issuer');
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        for (const url of ['/api/audit/events', '/api/audit/chains', `/api/audit/chains/esig_stub:${stub}/verify`, `/api/audit/chains/esig_stub:${stub}`]) {
          const res = await b.inject({ method, url, payload: '{}', headers: { 'content-type': 'application/json' } });
          expect(res.statusCode, `${method} ${url}`).toBe(404);
        }
      }
    }
    // The application role itself cannot change or remove audit rows.
    await expect(gmp.db.app.query('delete from kernel.audit_event where id = (select max(id) from kernel.audit_event)')).rejects.toThrow(/permission denied/);
    await expect(gmp.db.app.query("update kernel.audit_event set payload = '{}' where id = (select max(id) from kernel.audit_event)")).rejects.toThrow(/permission denied/);
  });

  it('[DI-22] reading the trail needs a live session', async () => {
    const anon = gmp.browser('PC-QA-01');
    expect(refusalOf(await anon.call(routes.audit.events, { query: {} }))).toMatchObject({ status: 401, code: 'NO_SESSION' });
  });
});
