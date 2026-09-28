/**
 * What batch issue needs from the MBR life cycle (outline 5.2.2, 5.8; ADR 0014 items 6-7): selection
 * of the version (INV-01), the pin record, the control-recipe snapshot and its hash (INV-02),
 * supersession and retirement (PR-05), market linkage (PR-04) and in-flight dispositions (L-24).
 * Batches are Phase 3; recipe.stub_batch stands in for them.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { canonicalJson, sha256Hex } from '../../../kernel/src/esig/canonical.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { mbrContentHash } from '../../src/flow/canonical.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { cell, reason, scope, seedCast, uniqueContent, World } from './support.ts';

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
const S1 = scope('S1', 'L1', BS);
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];
const current = (versionId: string, market: string): lc.MarketAuthorisationDefinition => ({
  versionId,
  market,
  kind: 'CURRENT',
  cells: [cell('S1', 'L1', BS)],
  regulatoryBasis: `${market}: registration on file`,
});

/** Runs SQL as superuser with every trigger off (a break-glass rewrite). */
async function rewrite(sql: string, params: unknown[] = []): Promise<void> {
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
}

/** A family with v1 approved and CURRENT for IN and US at S1/L1. */
async function currentMaster() {
  const content = uniqueContent();
  const v1 = await w.approvedVersion(content);
  await w.authorise(current(v1.versionId, 'IN'));
  await w.authorise(current(v1.versionId, 'US'));
  return { ...v1, content };
}

describe('selection at issue and the pin (INV-01)', () => {
  it('[INV-01] a batch pins exactly one version, CURRENT for every market of its set, with content hash and rule-table versions', async () => {
    const m = await currentMaster();
    const r = await w.issue(m.familyId, ['IN', 'US'], S1);
    expect(r).toMatchObject({ versionId: m.versionId, versionNumber: 1, contentHash: mbrContentHash(m.content), rule: 'CURRENT_FOR_EVERY_MARKET' });
    expect(r.basis.map((b) => [b.market, b.validity])).toEqual([
      ['IN', 'CURRENT'],
      ['US', 'CURRENT'],
    ]);
    const pin = (await q<{ version_id: string; content_hash: string; markets: string[]; rule_table_versions: Record<string, unknown>; selection: { ok: boolean } }>(
      'select version_id, content_hash, markets, rule_table_versions, selection from recipe.batch_mbr_pin where batch_id = $1',
      [r.batchId],
    ))[0];
    expect(pin).toMatchObject({ version_id: m.versionId, content_hash: mbrContentHash(m.content), markets: ['IN', 'US'], selection: { ok: true } });
    expect(Object.keys(pin?.rule_table_versions ?? {}).sort()).toEqual(['kernel', 'tablets']);
    expect((await q<{ status: string }>('select status from recipe.stub_batch where id = $1', [r.batchId]))[0]?.status).toBe('ISSUED');
    // Exactly one pin per batch: a batch is issued once.
    await expect(w.run(w.cast.issuer, (c) => lc.issueStubBatch(c, r.batchId))).rejects.toThrow(/EBMR-RCP-102/);
    expect(await w.violations()).toEqual([]);
  });

  it('[INV-01][INV-28] India is in every market set; the batch size is an approved one; issue is refused otherwise', async () => {
    const m = await currentMaster();
    await expect(w.issue(m.familyId, ['US'], S1)).rejects.toThrow(/India \(IN\) must be in every market set/);
    await expect(w.issue(m.familyId, ['IN'], scope('S1', 'L1', 'PO-99K'))).rejects.toThrow(/PO-99K is not an approved batch size/);
    await expect(w.issue(m.familyId, ['IN'], scope('S1', 'L2', BS))).rejects.toThrow(/IN: no version is CURRENT or BRIDGING for this market and scope/);
  });

  it('[PR-04] creating a batch for a market not linked to the master is refused, naming each market', async () => {
    const m = await currentMaster();
    const sel = await lc.selectVersionForIssue(db.app, { familyId: m.familyId, markets: ['IN', 'EU'], scope: S1 });
    expect(sel.ok).toBe(false);
    if (sel.ok) throw new Error('unreachable');
    expect(sel.explanation).toMatch(/EU: the master is not linked to this market \(no approved version lists it\); IN: version 1 CURRENT \(INV-01; PR-04\)/);
    await expect(w.issue(m.familyId, ['IN', 'EU'], S1)).rejects.toThrow(/cannot be issued.*EU: the master is not linked to this market.*EBMR-RCP-100/);
  });

  it('[PR-05][INV-01] once v2 is CURRENT, a new batch cannot be pinned to v1', async () => {
    const m = await currentMaster();
    const before = await w.issue(m.familyId, ['IN', 'US'], S1, m.versionId);
    expect(before.versionNumber).toBe(1);
    // The v1 batch runs to completion (an issued or running one would need an in-flight disposition first: next test).
    await w.run(w.cast.issuer, async (c) => {
      await lc.setStubBatchStatus(c, before.batchId, 'IN_PROGRESS');
      await lc.setStubBatchStatus(c, before.batchId, 'COMPLETED');
    });
    const v2 = await w.approvedSuccessor(m.versionId, (c) => (c.header.title = `${c.header.title} v2`));
    await w.authorise(current(v2.versionId, 'IN'));
    await w.authorise(current(v2.versionId, 'US'));
    await expect(w.issue(m.familyId, ['IN', 'US'], S1, m.versionId)).rejects.toThrow(/may use only version 2 .*version 1 is not valid for its markets now \(PR-05; INV-01; EBMR-RCP-101\)/);
    expect((await w.issue(m.familyId, ['IN', 'US'], S1)).versionNumber).toBe(2);
    // The batch issued on v1 keeps its pin and its snapshot (a running batch is never affected by later changes).
    expect((await lc.verifyControlRecipe(db.app, before.batchId)).ok).toBe(true);
    expect((await q<{ version_id: string }>('select version_id from recipe.batch_mbr_pin where batch_id = $1', [before.batchId]))[0]?.version_id).toBe(m.versionId);
  });

  it('[PR-05] a retired master blocks new batches; every executed record stays retrievable and verifiable', async () => {
    const m = await currentMaster();
    const b = await w.issue(m.familyId, ['IN'], S1);
    const s = await w.state(m.versionId);
    await w.run(w.cast.qa, (c) => lc.retireVersion(c, m.versionId, s.version), reason('product discontinued'));
    await expect(w.issue(m.familyId, ['IN'], S1)).rejects.toThrow(/EBMR-RCP-100/);
    const check = await lc.verifyControlRecipe(db.app, b.batchId);
    expect(check).toMatchObject({ ok: true, problems: [] });
    const snap = (await q<{ snapshot: { mbr: { version_number: number; content: { header: { family: string } } } } }>('select snapshot from recipe.control_recipe where batch_id = $1', [b.batchId]))[0];
    expect(snap?.snapshot.mbr.version_number).toBe(1);
    expect(snap?.snapshot.mbr.content.header.family).toBe(m.content.header.family);
    expect((await lc.loadContent(db.app, m.versionId)).contentHash).toBe(m.contentHash);
  });
});

describe('in-flight disposition of the predecessor\'s batches (ADR 0014 item 7, L-24)', () => {
  it('[PR-05][INV-01] approving a successor needs a disposition for every issued or running batch of an earlier version', async () => {
    const m = await currentMaster();
    const issued = await w.issue(m.familyId, ['IN'], S1);
    const running = await w.issue(m.familyId, ['IN', 'US'], S1);
    await w.run(w.cast.issuer, (c) => lc.setStubBatchStatus(c, running.batchId, 'IN_PROGRESS'));
    const done = await w.issue(m.familyId, ['IN'], S1);
    await w.run(w.cast.issuer, async (c) => {
      await lc.setStubBatchStatus(c, done.batchId, 'IN_PROGRESS');
      await lc.setStubBatchStatus(c, done.batchId, 'COMPLETED');
    });
    // v2 up to CHECKED.
    const v2 = await w.run(w.cast.author, (c) => lc.deriveVersion(c, m.versionId, 'improvement'));
    const content = (await lc.loadContent(db.app, v2.versionId)).content;
    content.header.title = `${content.header.title} v2`;
    await w.run(w.cast.author, (c) => lc.saveContent(c, v2.versionId, content));
    await w.prepare(v2.versionId, content);
    await w.startVerification(v2.versionId);
    await w.submit(v2.versionId);
    await w.check(v2.versionId);
    expect((await lc.inFlightBatches(db.app, v2.versionId)).map((b) => [b.batchNumber, b.status, b.disposition])).toEqual(
      [
        [issued.batchNumber, 'ISSUED', null],
        [running.batchNumber, 'IN_PROGRESS', null],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    await w.regulatoryConfirm(v2.versionId);
    const sig = await w.signVersion(w.cast.qa, v2.versionId, 'APPROVED', 'CHECKED');
    const approve = async () => {
      const s = await w.state(v2.versionId);
      return w.run(w.cast.qa, (c) => lc.approveVersion(c, v2.versionId, s.version, sig));
    };
    await expect(approve()).rejects.toThrow(new RegExp(`in_flight_dispositioned: batches .*${issued.batchNumber}.* without an in-flight disposition`));
    // A running batch cannot be cancelled as unstarted; a completed one needs nothing.
    await expect(w.run(w.cast.qa, (c) => lc.recordInFlightDisposition(c, v2.versionId, running.batchId, 'CANCEL_UNSTARTED', 'x'))).rejects.toThrow(/EBMR-RCP-071/);
    await expect(w.run(w.cast.qa, (c) => lc.recordInFlightDisposition(c, v2.versionId, done.batchId, 'CONTINUE', 'x'))).rejects.toThrow(/EBMR-RCP-070/);
    await expect(w.run(w.cast.author, (c) => lc.recordInFlightDisposition(c, v2.versionId, issued.batchId, 'CONTINUE', 'x'))).rejects.toThrow(/EBMR-IAM-040/);
    await w.run(w.cast.qa, async (c) => {
      await lc.recordInFlightDisposition(c, v2.versionId, running.batchId, 'CONTINUE', 'finish on the issued version');
      await lc.recordInFlightDisposition(c, v2.versionId, issued.batchId, 'CANCEL_UNSTARTED', 'not started; reissue on v2');
    });
    await approve();
    expect((await w.state(v2.versionId)).state).toBe('APPROVED');
  });
});

describe('the issued control recipe (INV-02)', () => {
  it('[INV-02] the snapshot is built by the database, hashed, and verified in SQL and in TypeScript alike', async () => {
    const m = await currentMaster();
    const r = await w.issue(m.familyId, ['IN', 'US'], S1);
    const check = await lc.verifyControlRecipe(db.app, r.batchId);
    expect(check).toMatchObject({ ok: true, storedHash: r.snapshotHash, computedHash: r.snapshotHash, tsComputedHash: r.snapshotHash, problems: [] });
    const row = (await q<{ snapshot: Record<string, unknown> }>('select snapshot from recipe.control_recipe where batch_id = $1', [r.batchId]))[0];
    expect(sha256Hex(canonicalJson(row?.snapshot))).toBe(r.snapshotHash);
    expect(row?.snapshot).toMatchObject({ format: 'ebmr.control-recipe', batch: { markets: ['IN', 'US'], batch_size: { id: BS } }, mbr: { content_hash: mbrContentHash(m.content) } });
  });

  it('[INV-02] bypass: the application role cannot change or delete it; owner-level changes are refused; a superuser rewrite is detected', async () => {
    const m = await currentMaster();
    const r = await w.issue(m.familyId, ['IN'], S1);
    await expect(db.app.query("update recipe.control_recipe set snapshot = '{}' where batch_id = $1", [r.batchId])).rejects.toThrow(/permission denied/);
    await expect(db.app.query('delete from recipe.control_recipe where batch_id = $1', [r.batchId])).rejects.toThrow(/permission denied/);
    await expect(db.app.query("insert into recipe.control_recipe (batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id) select batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id from recipe.control_recipe where batch_id = $1", [r.batchId])).rejects.toThrow(/permission denied/);
    await expect(db.admin.query("update recipe.control_recipe set snapshot = jsonb_set(snapshot, '{batch,site}', '\"S2\"') where batch_id = $1", [r.batchId])).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(db.admin.query('delete from recipe.control_recipe where batch_id = $1', [r.batchId])).rejects.toThrow(/EBMR-AUDIT-004/);
    // Detected: a rewrite with every trigger off.
    await rewrite("update recipe.control_recipe set snapshot = jsonb_set(snapshot, '{batch,site}', '\"S2\"') where batch_id = $1", [r.batchId]);
    const check = await lc.verifyControlRecipe(db.app, r.batchId);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/does not hash to its stored hash/);
    expect(check.tsComputedHash).not.toBe(check.storedHash);
    expect((await w.violations()).filter((x) => x.invariant === 'INV-02').map((x) => x.subject)).toEqual([r.batchId]);
  });
});

describe('INV-01 bypass attempts', () => {
  it('[INV-01] the application role cannot pin or issue directly; owner-level writers cannot pin another version; a forged pin is detected', async () => {
    const m = await currentMaster();
    const v2 = await w.approvedSuccessor(m.versionId, (c) => (c.header.title = `${c.header.title} v2`));
    await w.authorise(current(v2.versionId, 'IN'));
    const batch = await w.planBatch(m.familyId, ['IN'], S1);
    await expect(
      db.app.query(
        "insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions, person_id, account_id) values ($1, $2, $3, 1, repeat('0', 64), '{IN}', '{}', '{}', '{}', gen_random_uuid(), gen_random_uuid())",
        [batch, m.familyId, m.versionId],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update recipe.stub_batch set status = 'ISSUED' where id = $1", [batch])).rejects.toThrow(/permission denied/);
    // Owner level, in a command: the pin trigger recomputes the selection and refuses v1 (superseded for IN).
    const ctx = { ...w.cast.issuer, correlationId: randomUUID() };
    await expect(
      withCommand(db.admin, ctx, (c) =>
        c.query(
          "insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions, person_id, account_id) values ($1, $2, $3, 1, repeat('0', 64), '{IN}', '{}', '{}', '{}', gen_random_uuid(), gen_random_uuid())",
          [batch, m.familyId, m.versionId],
        ),
      ),
    ).rejects.toThrow(/may use only version 2.*EBMR-RCP-101/);
    // Owner level: a batch is ISSUED only with its pin and control recipe.
    await expect(withCommand(db.admin, { ...ctx, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: 'x' }, (c) => c.query("update recipe.stub_batch set status = 'ISSUED' where id = $1", [batch]))).rejects.toThrow(/EBMR-RCP-122/);
    // Detected: a superuser pins v1 with every trigger off.
    await rewrite(
      `insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions, person_id, account_id, recorded_at)
       values ($1, $2, $3, 1, $4, '{IN}', $5::jsonb, '{}', '{}', gen_random_uuid(), gen_random_uuid(), clock_timestamp())`,
      [batch, m.familyId, m.versionId, m.contentHash, JSON.stringify(S1)],
    );
    await rewrite("update recipe.stub_batch set status = 'ISSUED' where id = $1", [batch]);
    const v = (await w.violations()).filter((x) => x.invariant === 'INV-01' || x.invariant === 'INV-02');
    expect(v.map((x) => [x.invariant, x.detail])).toEqual(
      expect.arrayContaining([
        ['INV-01', expect.stringMatching(/the pinned version 1 is not the version the selection gives at the issue instant \(2\)/)],
        ['INV-02', 'pinned batch without a control recipe'],
      ]),
    );
  });
});
