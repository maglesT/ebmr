/**
 * Per-market authorisation (ADR 0014; outline 5.2.1): CURRENT per market and scope through a signed
 * record by QA and regulatory, supersession in the same transaction, partial scope, time-limited
 * BRIDGING, withdrawal and retirement; INV-17 in the database, attacked through the application role
 * and by owner-level writers.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { cell, reason, scope, seedCast, uniqueContent, withSecondRole, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

const BS = 'PO-20K';
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];
const select = (familyId: string, markets: string[], s = scope('S1', 'L1', BS), at?: string) =>
  lc.selectVersionForIssue(db.app, { familyId, markets, scope: s, ...(at ? { at } : {}) });
const current = (versionId: string, market: string, cells: lc.ScopeCell[], extra: Partial<lc.MarketAuthorisationDefinition> = {}): lc.MarketAuthorisationDefinition => ({
  versionId,
  market,
  kind: 'CURRENT',
  cells,
  regulatoryBasis: `${market}: registration on file`,
  ...extra,
});

async function cellsOf(versionId: string): Promise<{ market: string; line: string; status: string; valid_until: string | null }[]> {
  return q("select market, line, status, recipe.utc_text(valid_until) as valid_until from recipe.authorisation_cell where version_id = $1 order by market, line, recorded_at", [versionId]);
}

describe('market authorisation through a signed record (ADR 0014, INV-17)', () => {
  it('[INV-17][PR-04] an approved version becomes CURRENT for a market and scope only with the QA and regulatory signatures of two persons', async () => {
    const content = uniqueContent();
    const v = await w.approvedVersion(content);
    expect((await select(v.familyId, ['IN'])).ok).toBe(false);
    const id = await w.run(w.cast.qa, (c) => lc.proposeMarketAuthorisation(c, current(v.versionId, 'IN', [cell('S1', 'L1', BS)])));
    // Without valid signatures of this record nothing is activated.
    await expect(w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, id, randomUUID(), randomUUID()))).rejects.toThrow(/EBMR-ESIG-070/);
    const qaSig = await w.sign(w.cast.qa, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
    // QA cannot also be the regulatory signer, even holding that role.
    const qaAsRegulatory = await withSecondRole(db, w.cast.qa, 'REGULATORY_SIGNER');
    const selfReg = await w.sign(qaAsRegulatory, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'REGULATORY_CONFIRMED', 'PROPOSED');
    await expect(w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, id, qaSig, selfReg))).rejects.toThrow(/two different persons.*EBMR-RCP-085/);
    const regSig = await w.sign(w.cast.regulatory, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'REGULATORY_CONFIRMED', 'PROPOSED');
    // The activating QA person is the one who signed.
    await expect(w.run(w.cast.qa2, (c) => lc.activateMarketAuthorisation(c, id, qaSig, regSig))).rejects.toThrow(/EBMR-RCP-085/);
    const act = await w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, id, qaSig, regSig));
    expect(act).toMatchObject({ market: 'IN', kind: 'CURRENT', versionId: v.versionId });
    const sel = await select(v.familyId, ['IN']);
    expect(sel).toMatchObject({ ok: true, rule: 'CURRENT_FOR_EVERY_MARKET', version_id: v.versionId, version_number: 1 });
    // The scope is exact: another line or batch size is not covered.
    expect((await select(v.familyId, ['IN'], scope('S1', 'L2', BS))).ok).toBe(false);
    // A record is activated once.
    await expect(w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, id, qaSig, regSig))).rejects.toThrow(/EBMR-RCP-083/);
  });

  it('[PR-04] a master is authorised only for markets it is linked to, and only once approved', async () => {
    const content = uniqueContent();
    const v = await w.approvedVersion(content);
    await expect(w.run(w.cast.qa, (c) => lc.proposeMarketAuthorisation(c, current(v.versionId, 'EU', [cell('S1', 'L1', BS)])))).rejects.toThrow(
      /The master is not linked to market EU.*EBMR-RCP-081/,
    );
    const draft = uniqueContent();
    const d = await w.newVersion(draft);
    await expect(w.run(w.cast.qa, (c) => lc.proposeMarketAuthorisation(c, current(d.versionId, 'IN', [cell('S1', 'L1', BS)])))).rejects.toThrow(/EBMR-RCP-086/);
    await expect(w.run(w.cast.qa, (c) => lc.proposeMarketAuthorisation(c, current(v.versionId, 'IN', [cell('S1', 'L1', 'BS-OTHER')])))).rejects.toThrow(/EBMR-RCP-080/);
    await expect(w.run(w.cast.author, (c) => lc.proposeMarketAuthorisation(c, current(v.versionId, 'IN', [cell('S1', 'L1', BS)])))).rejects.toThrow(/EBMR-IAM-040/);
  });

  it('[INV-17][PR-05] the successor supersedes the predecessor for its market and scope in the same transaction; partial scope leaves the rest CURRENT', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    await w.authorise(current(v1.versionId, 'IN', [cell('S1', 'L1', BS), cell('S1', 'L2', BS)]));
    const v2 = await w.approvedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
    const act = await w.authorise(current(v2.versionId, 'IN', [cell('S1', 'L1', BS)]));
    expect(act.cells).toHaveLength(1);
    expect(act.cells[0]?.superseded_cell_id).toBeTruthy();
    const c1 = await cellsOf(v1.versionId);
    expect(c1.map((c) => [c.line, c.status])).toEqual([
      ['L1', 'SUPERSEDED'],
      ['L2', 'CURRENT'],
    ]);
    expect(c1[0]?.valid_until).toBe(act.effectiveFrom);
    expect(await select(v1.familyId, ['IN'], scope('S1', 'L1', BS))).toMatchObject({ ok: true, version_number: 2 });
    expect(await select(v1.familyId, ['IN'], scope('S1', 'L2', BS))).toMatchObject({ ok: true, version_number: 1 });
    // An older version never supersedes a newer one.
    await expect(w.authorise(current(v1.versionId, 'IN', [cell('S1', 'L1', BS)]))).rejects.toThrow(/The newer version 2 is CURRENT.*EBMR-RCP-089/);
    // At most one CURRENT per family, market and scope at any instant.
    const open = await q<{ n: string }>(
      "select count(*)::text as n from recipe.authorisation_cell where family_id = $1 and market = 'IN' and site = 'S1' and line = 'L1' and status = 'CURRENT'",
      [v1.familyId],
    );
    expect(open[0]?.n).toBe('1');
    expect(await w.violations()).toEqual([]);
  });

  it('[INV-17] BRIDGING: a signed, time-limited validity for the superseded version, usable only while the batch has a market where the successor is not CURRENT', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    const S = [cell('S1', 'L1', BS)];
    await w.authorise(current(v1.versionId, 'IN', S));
    await w.authorise(current(v1.versionId, 'US', S));
    const v2 = await w.approvedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
    // India needs no prior approval: v2 becomes CURRENT for IN; the US supplement is pending.
    await w.authorise(current(v2.versionId, 'IN', S, { regulatoryBasis: 'India: notified under change control' }));
    const gap = await select(v1.familyId, ['IN', 'US']);
    expect(gap.ok).toBe(false);
    if (gap.ok) throw new Error('unreachable');
    expect(gap.explanation).toMatch(/IN: version 2 CURRENT; US: version 1 CURRENT/);
    expect(await select(v1.familyId, ['IN'])).toMatchObject({ ok: true, version_number: 2, rule: 'CURRENT_FOR_EVERY_MARKET' });
    // A BRIDGING needs an end, a successor that superseded this version, and the two signatures.
    await expect(w.authorise({ versionId: v1.versionId, market: 'IN', kind: 'BRIDGING', cells: S, successorVersionId: v2.versionId, regulatoryBasis: 'x' })).rejects.toThrow(/time-limited.*EBMR-RCP-082/);
    await expect(
      w.authorise({ versionId: v1.versionId, market: 'US', kind: 'BRIDGING', cells: S, successorVersionId: v2.versionId, effectiveTo: '2027-06-30T00:00:00Z', regulatoryBasis: 'x' }),
    ).rejects.toThrow(/BRIDGING is given only where the named successor superseded this version.*EBMR-RCP-090/);
    const bridging = await w.authorise({
      versionId: v1.versionId,
      market: 'IN',
      kind: 'BRIDGING',
      cells: S,
      successorVersionId: v2.versionId,
      effectiveTo: '2027-06-30T00:00:00Z',
      regulatoryBasis: 'US supplement pending; v1 process remains within the Indian licence',
    });
    expect(bridging.kind).toBe('BRIDGING');
    expect(await select(v1.familyId, ['IN', 'US'])).toMatchObject({
      ok: true,
      rule: 'CURRENT_OR_BRIDGING',
      version_number: 1,
      basis: [
        { market: 'IN', validity: 'BRIDGING' },
        { market: 'US', validity: 'CURRENT' },
      ],
    });
    // India-only batches still take the newest CURRENT version; the bridging is not for them.
    expect(await select(v1.familyId, ['IN'])).toMatchObject({ ok: true, version_number: 2 });
    // Time-limited: after its end the bridging no longer counts.
    expect((await select(v1.familyId, ['IN', 'US'], scope('S1', 'L1', BS), '2027-07-01T00:00:00Z')).ok).toBe(false);
    // When the US approval arrives, v2 serves both markets and the bridging is no longer usable.
    await w.authorise(current(v2.versionId, 'US', S, { regulatoryBasis: 'US: supplement approved' }));
    expect(await select(v1.familyId, ['IN', 'US'])).toMatchObject({ ok: true, rule: 'CURRENT_FOR_EVERY_MARKET', version_number: 2 });
    const bridgingCell = (await q<{ status: string }>("select status from recipe.authorisation_cell where version_id = $1 and kind = 'BRIDGING'", [v1.versionId]))[0];
    expect(bridgingCell?.status).toBe('BRIDGING');
    expect(await w.violations()).toEqual([]);
  });

  it('[INV-17] overlapping validities are refused in plain language: a second BRIDGING, or a successor inside a predecessor\'s remaining validity', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    const S = [cell('S1', 'L1', BS)];
    await w.authorise(current(v1.versionId, 'IN', S));
    await w.authorise(current(v1.versionId, 'US', S));
    const v2 = await w.approvedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
    await w.authorise(current(v2.versionId, 'IN', S));
    const bridging = (to: string): lc.MarketAuthorisationDefinition => ({
      versionId: v1.versionId, market: 'IN', kind: 'BRIDGING', cells: S, successorVersionId: v2.versionId, effectiveTo: to, regulatoryBasis: 'US supplement pending',
    });
    await w.authorise(bridging('2027-06-30T00:00:00Z'));
    await expect(w.authorise(bridging('2027-09-30T00:00:00Z'))).rejects.toThrow(/A BRIDGING validity of version 1 already covers IN .* withdraw it before giving another \(INV-17; EBMR-RCP-093\)/);
    // A successor authorised from a future date and then withdrawn leaves the predecessor valid until that date.
    const v3 = await w.approvedSuccessor(v2.versionId, (m) => (m.header.title = `${m.header.title} v3`));
    const a3 = await w.authorise(current(v3.versionId, 'US', S, { effectiveFrom: '2030-01-01T00:00:00Z' }));
    await w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, a3.authorisationId, 'supplement withdrawn by the applicant'));
    await expect(w.authorise(current(v2.versionId, 'US', S))).rejects.toThrow(/Version 1 remains valid for US .* until 2030-01-01T00:00:00\.000000Z.*EBMR-RCP-093/);
    expect(await select(v1.familyId, ['IN', 'US'])).toMatchObject({ ok: true, rule: 'CURRENT_OR_BRIDGING', version_number: 1 });
    expect(await w.violations()).toEqual([]);
  });

  it('[PR-02] approval does not make the master usable before its effective date', async () => {
    const content = uniqueContent();
    const v = await w.approvedVersion(content, { effectiveFrom: '2030-01-01T00:00:00Z', reviewDue: '2031-01-01' });
    await w.authorise(current(v.versionId, 'IN', [cell('S1', 'L1', BS)]));
    expect((await select(v.familyId, ['IN'])).ok).toBe(false);
    expect(await select(v.familyId, ['IN'], scope('S1', 'L1', BS), '2030-01-02T00:00:00Z')).toMatchObject({ ok: true, version_id: v.versionId });
  });

  it('[PR-05][INV-17] withdrawal ends the authorisation; retirement ends every open authorisation and the version', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    const a = await w.authorise(current(v1.versionId, 'IN', [cell('S1', 'L1', BS)]));
    await w.authorise(current(v1.versionId, 'US', [cell('S1', 'L1', BS)]));
    await expect(w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, a.authorisationId, ''))).rejects.toThrow(/EBMR-RCP-084/);
    expect(await w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, a.authorisationId, 'registration lapsed'))).toEqual({ cellsEnded: 1 });
    expect((await select(v1.familyId, ['IN'])).ok).toBe(false);
    // A version once authorised is retired, never withdrawn.
    let s = await w.state(v1.versionId);
    await expect(w.run(w.cast.qa, (c) => lc.withdrawVersion(c, v1.versionId, s.version), reason('try'))).rejects.toThrow(/never_authorised/);
    // RETIRE through the engine directly is refused while an authorisation is open ...
    await expect(w.run(w.cast.qa, (c) => lc.transitionVersion(c, v1.versionId, 'RETIRE', s.version), reason('retire'))).rejects.toThrow(/no_open_authorisation/);
    // ... retire_version ends them in the same command.
    await w.run(w.cast.qa, (c) => lc.retireVersion(c, v1.versionId, s.version), reason('product discontinued'));
    s = await w.state(v1.versionId);
    expect(s.state).toBe('RETIRED');
    expect((await cellsOf(v1.versionId)).map((c) => c.status)).toEqual(['WITHDRAWN', 'WITHDRAWN']);
    expect((await select(v1.familyId, ['IN', 'US'])).ok).toBe(false);
    expect(await w.violations()).toEqual([]);
  });
});

describe('INV-17 bypass attempts', () => {
  it('[INV-17] the application role cannot write authorisation cells or records; owner-level writers meet the constraints and guards', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    const a = await w.authorise(current(v1.versionId, 'IN', [cell('S1', 'L1', BS)]));
    const cellId = a.cells[0]?.cell_id ?? '';
    const v2 = await w.approvedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
    // Application role: no INSERT, UPDATE or DELETE on any of the tables.
    for (const sql of [
      `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from)
         values ('${a.authorisationId}', '${v1.familyId}', '${v2.versionId}', 2, 'IN', 'S1', 'L1', '${BS}', 'CURRENT', 'CURRENT', now())`,
      `update recipe.authorisation_cell set status = 'WITHDRAWN', valid_until = now() where id = '${cellId}'`,
      `delete from recipe.authorisation_cell where id = '${cellId}'`,
      `insert into recipe.market_authorisation_activation (authorisation_id, qa_signature_id, regulatory_signature_id, effective_from, person_id, account_id)
         values ('${a.authorisationId}', gen_random_uuid(), gen_random_uuid(), now(), gen_random_uuid(), gen_random_uuid())`,
      `update platform.aggregate_state set state = 'APPROVED' where aggregate_id = '${v2.versionId}'`,
    ]) {
      await expect(db.app.query(sql)).rejects.toThrow(/permission denied/);
    }
    // Owner level, triggers on: a cell without an activated, signed record is refused.
    const prop = await w.run(w.cast.qa, (c) => lc.proposeMarketAuthorisation(c, current(v2.versionId, 'IN', [cell('S1', 'L1', BS)])));
    await expect(
      withCommand(db.admin, { ...w.cast.qa, correlationId: randomUUID() }, (c) =>
        c.query(
          `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from)
           values ($1, $2, $3, 2, 'IN', 'S1', 'L1', $4, 'CURRENT', 'CURRENT', now())`,
          [prop, v1.familyId, v2.versionId, BS],
        ),
      ),
    ).rejects.toThrow(/only through an activated authorisation record with valid QA and regulatory signatures.*EBMR-RCP-092/);
    // Superuser with every trigger off: the unique index still allows one open CURRENT cell only ...
    const raw = async (sql: string, params: unknown[]) => {
      const c = await db.admin.connect();
      try {
        await c.query('begin');
        await c.query("set local session_replication_role = 'replica'");
        await c.query(sql, params);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    };
    await expect(
      raw(
        `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from)
         values ($1, $2, $3, 2, 'IN', 'S1', 'L1', $4, 'CURRENT', 'CURRENT', now())`,
        [prop, v1.familyId, v2.versionId, BS],
      ),
    ).rejects.toThrow(/authorisation_cell_one_current/);
    // ... no CURRENT validity may overlap another of the same family, market and scope ...
    await expect(
      raw(
        `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from, valid_until, superseded_by)
         values ($1, $2, $3, 2, 'IN', 'S1', 'L1', $4, 'CURRENT', 'SUPERSEDED', now() - interval '1 day', now() + interval '1 day', $5)`,
        [prop, v1.familyId, v2.versionId, BS, cellId],
      ),
    ).rejects.toThrow(/authorisation_cell_current_no_overlap/);
    // ... and a BRIDGING validity always has an end.
    await expect(
      raw(
        `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from, successor_version_id)
         values ($1, $2, $3, 1, 'IN', 'S9', 'L9', $4, 'BRIDGING', 'BRIDGING', now(), $5)`,
        [prop, v1.familyId, v1.versionId, BS, v2.versionId],
      ),
    ).rejects.toThrow(/check constraint/);
    // Detected: a cell a superuser slips in for an unsigned record shows in the invariant query.
    await raw(
      `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from)
       values ($1, $2, $3, 2, 'US', 'S7', 'L7', $4, 'CURRENT', 'CURRENT', now())`,
      [prop, v1.familyId, v2.versionId, BS],
    );
    const found = (await w.violations()).filter((x) => x.invariant === 'INV-17');
    expect(found.map((x) => x.detail)).toEqual(['cell without an activated, validly signed authorisation record']);
  });
});
