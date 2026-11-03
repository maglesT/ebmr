/**
 * Decision 0026 slice S3 over HTTP (feature library, contract ns/library.ts, recipe-core sql/1800_library_blocks.sql):
 * an author drafts versions of a block definition (the server checks the form first; the database keeps the hash, the
 * version order and the permissions), QA approves with a LIBRARY_BLOCK_APPROVED signature (never the author), and an
 * approved version is retired with a reason. Every change is audited.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { library } from '@ebmr/recipe-core/pure';
import type { TestServer } from '../support/harness.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
const L = routes.library;

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
}, 600_000);
afterAll(async () => {
  await gmp?.close();
});

function friability(code: string, version: number, title = 'Friability'): Record<string, unknown> {
  return {
    code,
    version,
    title,
    category: 'TEST_IPC',
    sections: [
      {
        id: 'run',
        title: 'Run',
        fields: [
          { id: 'w0', label: 'Weight before', type: 'NUMBER', unit: 'g' },
          { id: 'w1', label: 'Weight after', type: 'NUMBER', unit: 'g' },
          { id: 'loss', label: 'Weight loss', type: 'CALC', expression: '(w0 - w1) / w0 * 100 [%]', unit: '%', limitSlot: 'loss', critical: true },
        ],
      },
    ],
    signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
  };
}

const newCode = (): string => `IPC-T${randomUUID().slice(0, 6).toUpperCase()}`;

describe('the library of block definitions', () => {
  it('[PR-03][PR-05] the author drafts versions; the server refuses a definition with problems; the hash is the canonical hash the formulation pins', async () => {
    const author = await gmp.asPersona('author');
    const code = newCode();
    const bad = { ...friability(code, 1), sections: [{ id: 'run', title: 'Run', fields: [{ id: 'x', label: 'X', type: 'NUMBER', unit: 'furlongs' }] }] };
    const checked = valueOf(await author.call(L.check, { body: { definition: bad } }));
    expect(checked.problems.map((p) => p.code)).toEqual(['LIB-FIELD-UNIT']);
    const refused = refusalOf(await author.call(L.draft, { body: { definition: bad } }));
    expect(refused.code).toBe('LIB-FIELD-UNIT');

    const v1 = valueOf(await author.call(L.draft, { body: { definition: friability(code, 1) } }));
    expect(v1.block).toMatchObject({ code, version: 1, state: 'DRAFT', approvedBy: null });
    expect(v1.block.contentHash).toBe(library.definitionHash(friability(code, 1) as unknown as library.BlockDefinition));
    // Each change is a new version: the next version is 2, never a rewrite of 1 (and not 3).
    expect(refusalOf(await author.call(L.draft, { body: { definition: friability(code, 3) } })).code).toBe('EBMR-LIB-004');
    const v2 = valueOf(await author.call(L.draft, { body: { definition: friability(code, 2, 'Friability (v2)') } }));
    expect(v2.block.version).toBe(2);
    const listed = valueOf(await author.call(L.list, { query: { code } }));
    expect(listed.blocks.map((b) => b.version)).toEqual([2, 1]);
  });

  it('[DI-35][PR-05] QA approves with a LIBRARY_BLOCK_APPROVED signature, never the author; an approved version is retired with a reason', async () => {
    const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
    const code = newCode();
    const v1 = valueOf(await author.call(L.draft, { body: { definition: friability(code, 1) } })).block;
    const approve: SignableAction = { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: v1.blockId };
    expect(valueOf(await approver.call(routes.esig.describe, { body: { action: approve } }))).toMatchObject({ aggregateType: 'library_block', meaning: 'LIBRARY_BLOCK_APPROVED' });
    // The author holds no MBR.APPROVE and is excluded as the performer; a tampered content hash is refused.
    expect((await signAction(gmp, author, 'author', approve)).ok).toBe(false);
    expect((await signAction(gmp, approver, 'approver', approve, { tamper: true })).ok).toBe(false);
    const signed = await signAction(gmp, approver, 'approver', approve);
    expect(signed.ok, signed.ok ? '' : JSON.stringify(signed.error)).toBe(true);
    const [approved] = valueOf(await approver.call(L.list, { query: { code } })).blocks;
    expect(approved).toMatchObject({ state: 'APPROVED', approvedBy: { role: 'APPROVER' } });
    // Approved once: a second approval is refused.
    expect((await signAction(gmp, approver, 'approver', approve)).ok).toBe(false);

    // Only QA retires, only an approved version, and always with a reason.
    expect(refusalOf(await author.call(L.retire, { body: { blockId: v1.blockId, reason: 'superseded' } })).status).toBeGreaterThanOrEqual(400);
    const retired = valueOf(await approver.call(L.retire, { body: { blockId: v1.blockId, reason: 'Replaced by a revised friability form' } }));
    expect(retired).toMatchObject({ state: 'RETIRED', retirementReason: 'Replaced by a revised friability form' });
    expect(refusalOf(await approver.call(L.retire, { body: { blockId: v1.blockId, reason: 'again' } })).code).toBe('EBMR-LIB-008');
    const draftOnly = valueOf(await author.call(L.draft, { body: { definition: friability(code, 2) } })).block;
    expect(refusalOf(await approver.call(L.retire, { body: { blockId: draftOnly.blockId, reason: 'not approved' } })).code).toBe('EBMR-LIB-008');
  });

  it('[PR-05][DI-35] the ready-made catalogue loads as drafts only, by an author; a second load leaves the held codes alone; the deferred hard-capsule blocks are not in the Tablets load (R3-CAT-4)', async () => {
    const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
    expect(refusalOf(await approver.call(L.loadCatalogue, { body: {} })).status).toBeGreaterThanOrEqual(400);
    const first = valueOf(await author.call(L.loadCatalogue, { body: {} }));
    expect(first.drafted).toContain('PROC-SIFT');
    expect(first.drafted).toContain('CTRL-LINE-CLEAR-START');
    const listed = valueOf(await author.call(L.list, { query: { code: 'PROC-SIFT' } })).blocks;
    expect(listed.map((b) => [b.version, b.state])).toEqual([[1, 'DRAFT']]);
    const second = valueOf(await author.call(L.loadCatalogue, { body: {} }));
    expect(second.drafted).toEqual([]);
    expect(second.skipped).toEqual(expect.arrayContaining(first.drafted));
    // Owner decision of 3 November 2026: hard capsules are deferred, so the Tablets load leaves their 7 blocks out.
    const capsules = ['PROC-CAPS-FILL', 'PROC-CAPS-POLISH', 'IPC-CAPS-FILL-WEIGHT', 'IPC-CAPS-LOCK-LENGTH', 'IPC-CAPS-APPEARANCE', 'IPC-CAPS-DT', 'REL-CAPS-DISSO'];
    for (const load of [first, second]) expect([...load.drafted, ...load.skipped].filter((c) => capsules.includes(c))).toEqual([]);
  });

  it('[DI-22][PR-05] library rows are insert-only and audited: the application credentials cannot change or delete them', async () => {
    const author = await gmp.asPersona('author');
    const v1 = valueOf(await author.call(L.draft, { body: { definition: friability(newCode(), 1) } })).block;
    await expect(gmp.db.app.query("update recipe.library_block set title = 'x' where id = $1", [v1.blockId])).rejects.toThrow();
    await expect(gmp.db.app.query('delete from recipe.library_block where id = $1', [v1.blockId])).rejects.toThrow();
    const { rows } = await gmp.db.admin.query<{ n: string }>("select count(*)::text as n from kernel.audit_event where table_name = 'recipe.library_block' and record_id = $1", [v1.blockId]);
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });
});
