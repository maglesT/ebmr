/**
 * The CAPA register over HTTP and the QMS status fetched at release (Phase 6 slice 6a, builder B; contract ns/capa.ts;
 * site services 0925, recipe-core 0951, 0952; IN-01 (d), PR-51, DI-31; D-P6a-3, D-P6a-6). QA raises a CAPA, implements
 * it, records its effectiveness and another QA person closes it through the ceremony (CAPA_ACT, CAPA_CLOSED); the
 * initiator cannot; with a QMS integrated every write is refused. The release's live QMS fetch (the server half of
 * D-P6a-3): an unreachable, slow or cut QMS refuses the release naming the QMS, a changed version token is refused by
 * the database, a matching answer is recorded in the signing transaction.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import { qmsSimulator } from '../../../simulators/src/qms/model.ts';
import { startFeedSimulator, type RunningFeedSimulator } from '../../../simulators/src/system-feed/server.ts';
import { setMirrorMode, type Administration } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { qmsReleaseFetch } from '../../src/features/integrations/adapters/qms/index.ts';
import { HttpRefusal } from '../../src/platform/http/refusal.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { actorOf } from '../support/gmp-world.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let server: TestServer;
let db: TestDatabase;
let adm: Administration;
let qa: TestBrowser;
let qa2: TestBrowser;
let qms: RunningFeedSimulator;
let lot: { id: string; code: string };

beforeAll(async () => {
  server = await startSigningServer('GMP');
  db = server.db as unknown as TestDatabase;
  const b = server.seed.bootstrap;
  adm = { admin: await passwordActor(server.db, b.admin, b.admin.fingerprint), owner: await passwordActor(server.db, b.owner, b.owner.fingerprint), authn: server.db.authn };
  [qa, qa2] = await Promise.all([server.asPersona('qaInvestigator'), server.asPersona('qaApprover2')]);
  const q = qmsSimulator();
  qms = await startFeedSimulator(q.feed, q.plugin, { host: '127.0.0.1', port: 0 });
  lot = { id: randomUUID(), code: `L-${randomUUID().slice(0, 6).toUpperCase()}` };
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                      received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 'FG-1', 'Finished goods', 'FINISHED', 1000, 'units', '2030-01-01T00:00:00Z', $3, $3, $3)`,
      [lot.id, lot.code, randomUUID()],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
}, 600_000);
afterAll(async () => {
  await qms?.close();
  await server?.close();
});

const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r).why.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? refusalOf(r).code));

describe('the CAPA register over HTTP (IN-01 (d), PR-51)', () => {
  it('[IN-01][PR-51] QA raises a CAPA with its check, implements it and records its effectiveness; another QA person closes it through the ceremony, the initiator cannot', async () => {
    const owner = server.seed.personas.find((p) => p.key === 'qaApprover2')!;
    const today = (await db.admin.query<{ d: string }>('select (site.site_today() + 30)::text as d')).rows[0]!.d;
    const raised = valueOf(await qa.call(routes.capa.raise, {
      body: { title: 'Weekly calibration of the moisture analyser', sourceKind: 'COMPLAINT', sourceRef: 'CMP-2026-014', ownerPersonId: owner.personId, dueOn: today,
              needsMasterChange: false, effectivenessCheck: { criteria: 'No LOD result outside the limit in ten batches', periodDays: 90 } },
    }));
    expect(raised).toMatchObject({ origin: 'STAND_IN', state: 'OPEN', ownerName: owner.legalName, raisedBy: 'Divya Menon', checks: [{ periodDays: 90, status: 'OPEN' }] });
    expect(raised.closeProblem).toMatch(/is OPEN/);
    const register = valueOf(await qa.call(routes.capa.register, { query: {} }));
    expect(register.mode).toBe('STAND_IN');
    expect(register.capas.map((x) => x.capaId)).toContain(raised.capaId);
    valueOf(await qa.call(routes.capa.implement, { params: { capaId: raised.capaId }, body: { note: 'SOP-QC-014 rev 6 issued' } }));
    const proven = valueOf(await qa.call(routes.capa.recordEffectiveness, { params: { capaId: raised.capaId, checkId: raised.checks[0]!.checkId }, body: { effective: true, evidence: 'Ten batches within the limit' } }));
    expect(proven).toMatchObject({ state: 'IMPLEMENTED', closeProblem: null, checks: [{ status: 'DONE', effective: true }] });
    // The initiator's signature is refused by the kernel (the meaning excludes the person who entered the CAPA).
    expect(codeOf(await signAction(server, qa, 'qaInvestigator', { kind: 'CAPA_ACT', act: 'CLOSE', capaId: raised.capaId }))).not.toBe('ok');
    const closed = await signAction(server, qa2, 'qaApprover2', { kind: 'CAPA_ACT', act: 'CLOSE', capaId: raised.capaId });
    expect(closed.ok, JSON.stringify(closed)).toBe(true);
    expect(valueOf(await qa.call(routes.capa.detail, { params: { capaId: raised.capaId } }))).toMatchObject({ state: 'CLOSED', events: [{ event: 'IMPLEMENTED' }, { event: 'CLOSED', by: 'Arvind Rao' }] });
    // An unknown CAPA is a 404 with the register's code.
    expect(refusalOf(await qa.call(routes.capa.detail, { params: { capaId: randomUUID() } }))).toMatchObject({ status: 404, code: 'EBMR-CAPA-003' });
  });

  it('[PR-51] with a QMS integrated the stand-in writes are refused (the CAPA is changed in the QMS)', async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR', adm);
    try {
      const owner = server.seed.personas.find((p) => p.key === 'qaApprover2')!;
      const r = await qa.call(routes.capa.raise, {
        body: { title: 'x', sourceKind: 'PQR', sourceRef: 'PQR-1', ownerPersonId: owner.personId, dueOn: '2099-01-01', needsMasterChange: false, effectivenessCheck: { criteria: 'x', periodDays: 30 } },
      });
      expect(refusalOf(r)).toMatchObject({ status: 409, code: 'EBMR-CAPA-002' });
      expect(valueOf(await qa.call(routes.capa.register, { query: {} })).mode).toBe('MIRROR');
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN', adm);
    }
  });
});

describe('the QMS status fetched at release (DI-31; D-P6a-3)', () => {
  const link = (over: { baseUrl?: string | null; timeoutMs?: number } = {}) => ({ baseUrl: `http://127.0.0.1:${qms.port.toString()}`, timeoutMs: 500, ...over });
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${qms.port.toString()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const fault = (f: string, on: boolean, slowMs?: number) => post('/api/fault', { fault: f, on, ...(slowMs ? { slowMs } : {}) });

  /** The release's transaction as the AP: the live fetch, then the database's release check, then rolled back. */
  async function inRelease(l: Parameters<typeof qmsReleaseFetch>[1]): Promise<string | null> {
    const ap = await actorOf(server, 'qcuAuthoriser');
    return withCommand(db.app, { ...ap, correlationId: randomUUID() }, async (c) => {
      await qmsReleaseFetch(c, l, lot.id);
      return (await c.query<{ p: string | null }>('select site.qms_release_problem($1) as p', [lot.id])).rows[0]!.p;
    });
  }
  const refusalCode = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      if (e instanceof HttpRefusal) return `${e.refusal.code} ${e.refusal.whoCanHelp.join(', ')}`;
      return e instanceof Error ? (e.message.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? e.message) : String(e);
    }
  };

  it('[DI-31] QMS unreachable at release: the release is refused and names the QMS', async () => {
    // STAND_IN: no QMS is asked.
    expect(await inRelease(link({ baseUrl: null }))).toBeNull();
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR', adm);
    try {
      expect(await refusalCode(inRelease(link({ baseUrl: null })))).toMatch(/^EBMR-QMS-020 The QMS system owner/);
      expect(await refusalCode(inRelease(link({ baseUrl: 'http://127.0.0.1:9' })))).toMatch(/^EBMR-QMS-020 The QMS system owner/);
      await fault('SLOW', true, 1500);
      expect(await refusalCode(inRelease(link()))).toMatch(/^EBMR-QMS-020/);
      await fault('SLOW', false);
      await fault('LINK_CUT', true);
      expect(await refusalCode(inRelease(link()))).toMatch(/^EBMR-QMS-020/);
      await fault('LINK_CUT', false);
      // Reachable, nothing open, the mirror agrees: recorded in the transaction, no problem.
      expect(await inRelease(link())).toBeNull();
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN', adm);
    }
  });

  it('[DI-31] a changed version token at signing refuses the release', async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR', adm);
    try {
      // The QMS opens a deviation naming the lot; the eBMR's mirror has not received it yet: the token differs.
      expect((await post('/qms/v1/deviations', { deviationRef: 'QD-REL-1', status: 'OPEN', lotNumbers: [lot.code] })).status).toBe(201);
      expect(await refusalCode(inRelease(link()))).toBe('EBMR-QMS-011');
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN', adm);
    }
  });
});
