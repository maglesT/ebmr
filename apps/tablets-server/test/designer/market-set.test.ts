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
import { library, lifecycle, librarySeed } from '@ebmr/recipe-core';
import { openPersonaSession } from '@ebmr/test-kit';
import { resolveMinima } from '../../src/features/designer/adapters/market-minima.ts';
import { analyse } from '../../src/features/designer/validation.ts';
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

/**
 * The Grade B viable action limits of an injectables master, per market (ST-01, ST-20): the EM counts step (INJ-EM-COUNTS)
 * binds its action limits to the sterile rule table's Grade B viable keys, and the designer's validation resolves them
 * from the published table for the master's market set. India (Schedule M Part II Table 3) binds every master, the EU
 * (Annex 1 Table 6) an EU-market one; both give 10 CFU/m3 for an active air sample.
 */
describe('Grade B viable action limits of an injectables master, per market (ST-01, ST-20)', () => {
  const COUNTS = librarySeed.INJECTABLE_ASEPTIC_CATALOGUE.find((s) => s.definition.code === 'INJ-EM-COUNTS');
  /** An injectables master whose one step counts the EM plates, with the active-air action limit `air` and market set `markets`. */
  const master = (markets: string[], air: string) =>
    templateMbr((j) => {
      if (!COUNTS) throw new Error('INJ-EM-COUNTS is not in the catalogue');
      type Json = Record<string, unknown>;
      const header = j['header'] as Json;
      header['edition'] = 'injectables';
      header['marketSet'] = markets;
      delete header['unitMassMg'];
      const use = structuredClone(COUNTS.exampleUse) as unknown as { limits: { cfuAir: { ranges: { tier: string; high: { value: string } }[] } } };
      for (const r of use.limits.cfuAir.ranges) if (r.tier === 'INTERNAL_ACTION') r.high.value = air;
      const p = library.libraryPhase(COUNTS.definition, 'p-counts', 'HIGH') as unknown as Json;
      const body = (j['procedure'] as Json)['body'] as Json;
      const like = (body['children'] as Json[])[0];
      body['children'] = [{ ...like, id: 'S-EM', name: 'EM counts', body: { kind: 'sequence', id: 'seq-S-EM', children: [{ ...p, config: { ...(p['config'] as Json), ...use } }] } }];
      for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) j[k] = [];
      j['blockDefinitions'] = [COUNTS.definition];
    });
  /** The market-minima findings of the validation about the Grade B viable keys. */
  const viableFindings = async (markets: string[], air: string): Promise<string[]> =>
    (await analyse(server.db.app, master(markets, air), [])).report.findings
      .filter((f) => f.rule === 'MKT-MINIMA' && /sterile\.viable\.gradeB/.test(f.message))
      .map((f) => `${f.severity}: ${f.message}`);

  it('[ST-01][ST-20] India: an India-only master with a Grade B active-air action limit of 15 CFU/m3 is refused by Schedule M Table 3 (10, governed by IN); exactly 10 is accepted', async () => {
    const minima = await resolveMinima(server.db.app, { edition: 'injectables', recordKind: 'PROCESSING', marketSet: ['IN'], predicates: {}, asOf: '2026-09-29', ruleKeys: ['sterile.viable.gradeB.airMax'] });
    expect(minima).toEqual([expect.objectContaining({ kind: 'LIMIT', ruleKey: 'sterile.viable.gradeB.airMax', bound: 'HIGH', value: '10', governingMarkets: ['IN'] })]);
    const refused = await viableFindings(['IN'], '15');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/^ERROR: .*cfuAir \(15 \{CFU\}\/m3\) is looser than the maximum of 10 \{CFU\}\/m3 required by IN \(rule sterile\.viable\.gradeB\.airMax/);
    expect(await viableFindings(['IN'], '10')).toEqual([]);
  });

  it('[ST-01][ST-20] EU: an EU-market master with a Grade B active-air action limit of 15 CFU/m3 is refused by Annex 1 Table 6 (10, governed by EU and IN); exactly 10 is accepted', async () => {
    const minima = await resolveMinima(server.db.app, { edition: 'injectables', recordKind: 'PROCESSING', marketSet: ['IN', 'EU'], predicates: {}, asOf: '2026-09-29', ruleKeys: ['sterile.viable.gradeB.airMax'] });
    expect(minima).toEqual([expect.objectContaining({ kind: 'LIMIT', ruleKey: 'sterile.viable.gradeB.airMax', bound: 'HIGH', value: '10', governingMarkets: ['EU', 'IN'] })]);
    const refused = await viableFindings(['IN', 'EU'], '15');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/^ERROR: .*cfuAir \(15 \{CFU\}\/m3\) is looser than the maximum of 10 \{CFU\}\/m3 required by EU, IN \(rule sterile\.viable\.gradeB\.airMax/);
    expect(await viableFindings(['IN', 'EU'], '10')).toEqual([]);
  });
});
