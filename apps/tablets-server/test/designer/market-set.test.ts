/**
 * The market set of an MBR holds only markets the kernel market engine knows (review P13; INV-34, IN-52, PR-03,
 * decision F12 "market minima not resolvable: the MBR fails").
 *
 * The engine knows EU, IN and US (market.market; market.checked_market_set refuses anything else with
 * EBMR-MKT-001). createFamily already refused an unknown market; a later revision could still list one, and the
 * market-minima adapter only asked the engine about the rule keys an MBR binds. dc-mini binds none, so {IN, JP}
 * resolved to an empty minima list, the gate passed and the version entered verification with PASS evidence for
 * a market whose content minima were never resolved.
 *
 * Now: the server refuses the save (DESIGNER_MARKETS), the database refuses such content whoever writes it
 * (EBMR-TAB-165), and the adapter itself asks the engine about the whole market set, so validating such content
 * (the editor validates unsaved content) reports an MKT-MINIMA error.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity } from '@ebmr/kernel';
import { routes, type VersionView } from '@ebmr/api-contract';
import { lifecycle } from '@ebmr/recipe-core';
import { openPersonaSession } from '@ebmr/test-kit';
import { resolveMinima } from '../../src/features/designer/adapters/market-minima.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, refusalOf, saveContent, startDesignerServer, templateMbr, valueOf } from './support.ts';

let server: TestServer;
let author: TestBrowser;

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
});
afterAll(async () => {
  await server?.close();
});

describe('market set of an MBR (INV-34, IN-52, F12)', () => {
  it('[INV-34][IN-52] {IN, JP} on an MBR without bound rule keys neither passes the gate nor enters verification', async () => {
    const v: VersionView = await createFamily(author, { familyCode: 'PCM500-P13', batchSizes: [{ quantity: '77.000', unit: 'kg' }] });
    expect(v.state).toBe('DRAFT');
    // The unchanged template passes with the real adapters, so a failure below is due to the market set.
    const baseline = valueOf(await author.call(routes.designer.validate, { body: { content: v.content, versionId: v.versionId } }));
    expect(baseline.gate.passed).toBe(true);

    const content = edited(v, (j) => (j.header.marketSet = ['IN', 'JP']));

    // Validating the (unsaved) content reports the unknown market as an error at the market set.
    const report = valueOf(await author.call(routes.designer.validate, { body: { content: content as unknown as VersionView['content'], versionId: v.versionId } }));
    const marketErrors = report.findings.filter((f) => f.severity === 'ERROR' && f.rule === 'MKT-MINIMA' && /JP/.test(f.message));
    expect(marketErrors.length, JSON.stringify(report.findings.map((f) => `${f.severity} ${f.rule}: ${f.message}`))).toBeGreaterThan(0);
    expect(report.gate.passed).toBe(false);

    // The revision is refused (as createFamily refuses an unknown market), so nothing reaches verification.
    const saved = await saveContent(author, v, content, 'add export market JP');
    const r = refusalOf(saved);
    expect(r.status).toBe(422);
    expect(r.code).toBe('DESIGNER_MARKETS');
    expect(r.controls).toEqual(expect.arrayContaining(['IN-52', 'INV-34']));

    const started = await author.call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: v.revision } });
    expect(started.ok).toBe(true); // the unchanged revision 1 (IN only) still passes: the refusal was the market set alone
    const after = valueOf(await author.call(routes.designer.version, { params: { versionId: v.versionId } }));
    expect(after.revision).toBe(1);
    expect(after.markets).toEqual(['IN']);
  });

  it('[INV-34][IN-52] the database refuses content with a market the engine does not know, whoever writes it (EBMR-TAB-165)', async () => {
    const v = await createFamily(author, { familyCode: 'PCM500-P13DB', batchSizes: [{ quantity: '78.000', unit: 'kg' }] });
    const actor = { ...(await openPersonaSession(server.db, server.seed, 'author')), reasonCode: 'TEST', reasonText: 'P13 direct write' };
    const write = (markets: string[]) =>
      identity.withGuardedCommand(server.db.app, actor, (c) => lifecycle.saveContent(c, v.versionId, edited(v, (j) => (j.header.marketSet = markets)), 'market set changed directly'));
    await expect(write(['IN', 'JP'])).rejects.toThrow(/EBMR-TAB-165/);
    await expect(write(['IN', 'ZZ', 'US'])).rejects.toThrow(/EBMR-TAB-165/);
    // A known market set is accepted by the same path (so the refusals above are due to the unknown market).
    await expect(write(['IN', 'US'])).resolves.toEqual(expect.objectContaining({ revision: 2 }));
  });

  it('[INV-34][F12] the minima adapter fails closed on an unknown market even when no rule key is bound', async () => {
    const mbr = templateMbr();
    const base = { edition: mbr.header.edition, recordKind: mbr.header.recordKind, predicates: {}, asOf: '2026-09-29', ruleKeys: [] as string[] };
    const unknown = await resolveMinima(server.db.app, { ...base, marketSet: ['IN', 'JP'] });
    expect(unknown).toEqual([expect.objectContaining({ kind: 'UNRESOLVED', ruleKey: 'market-set', problem: expect.stringMatching(/JP/) as unknown })]);
    expect(await resolveMinima(server.db.app, { ...base, marketSet: ['IN', 'US', 'EU'] })).toEqual([]);
  });
});
