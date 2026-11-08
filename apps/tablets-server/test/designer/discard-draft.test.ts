/**
 * Demo finding D-3 (D-0 sweep top row 7; recipe-core 1878): the author discards a never-approved draft with a reason, as
 * the lifecycle's WITHDRAW (a status change in the audit trail; nothing is deleted), and creating the family again under
 * the same code starts the new draft in that family; the identity index still refuses a twin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type VersionView } from '@ebmr/api-contract';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, NEW_FAMILY, refusalOf, startDesignerServer, valueOf } from './support.ts';

let server: TestServer;
let author: TestBrowser;

const discard = (who: TestBrowser, v: VersionView, text = 'Started with the wrong batch-size set') =>
  who.call(routes.designer.discardDraft, { params: { versionId: v.versionId }, body: { reason: { code: 'DRAFT_DISCARDED', text } } });

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
});
afterAll(async () => {
  await server?.close();
});

describe('a never-approved draft is discarded and the family starts again (demo finding D-3)', () => {
  it('[DI-22][DI-24][PR-05] the author discards a DRAFT with a reason: it reads WITHDRAWN, its content and revisions stay, and the state change is in the audit trail and the history with that reason; a second discard and a checker are refused', async () => {
    const v = await createFamily(author, { familyCode: 'PCM500-D3A', batchSizes: [{ quantity: '41.000', unit: 'kg' }] });
    const checker = await server.asPersona('checker');
    expect(refusalOf(await discard(checker, v))).toMatchObject({ status: 403, code: 'ROLE_NOT_ALLOWED' });
    expect(refusalOf(await author.call(routes.designer.discardDraft, { params: { versionId: v.versionId }, body: { reason: { code: 'DRAFT_DISCARDED', text: ' ' } } }))).toMatchObject({ status: 400 });
    const w = valueOf(await discard(author, v));
    expect(w).toMatchObject({ versionId: v.versionId, state: 'WITHDRAWN', revision: v.revision, contentHash: v.contentHash });
    const history = await server.db.admin.query<{ reason_code: string; reason_text: string }>(
      "select reason_code, reason_text from platform.state_history where aggregate_type = 'mbr_version' and aggregate_id = $1 and event = 'WITHDRAW'",
      [v.versionId],
    );
    expect(history.rows).toEqual([{ reason_code: 'DRAFT_DISCARDED', reason_text: 'Started with the wrong batch-size set' }]);
    const audit = await server.db.admin.query<{ reason_text: string; state: string }>(
      `select payload ->> 'reason_text' as reason_text, payload -> 'body' -> 'new' ->> 'state' as state
         from kernel.audit_event where table_name = 'platform.aggregate_state' and action = 'UPDATE' and record_id = $1 order by id desc limit 1`,
      [v.versionId],
    );
    expect(audit.rows).toEqual([{ reason_text: 'Started with the wrong batch-size set', state: 'WITHDRAWN' }]);
    const kept = await server.db.admin.query<{ n: number }>('select count(*)::int as n from recipe.mbr_version where id = $1', [v.versionId]);
    expect(kept.rows[0]?.n).toBe(1);
    expect(refusalOf(await discard(author, v))).toMatchObject({ status: 422, code: 'EBMR-RCP-021' });
  }, 120_000);

  it('[DI-24][PR-06] a version past DRAFT is not discarded here: one in verification is refused and stays IN_VERIFICATION', async () => {
    const v = await createFamily(author, { familyCode: 'PCM500-D3V', batchSizes: [{ quantity: '42.000', unit: 'kg' }] });
    const started = valueOf(await author.call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: v.revision } }));
    expect(started.state).toBe('IN_VERIFICATION');
    expect(refusalOf(await discard(author, started))).toMatchObject({ status: 422, code: 'EBMR-RCP-021', why: expect.stringMatching(/./) as unknown });
    expect(valueOf(await author.call(routes.designer.version, { params: { versionId: v.versionId } })).state).toBe('IN_VERIFICATION');
  }, 120_000);

  it('[PR-01][PR-05] creating the family again under the same code starts a new draft in it (the next version number); a twin under another code, and a family whose draft is not discarded, are refused as before', async () => {
    const sizes = [{ quantity: '43.000', unit: 'kg' }];
    const first = await createFamily(author, { familyCode: 'PCM500-D3B', batchSizes: sizes });
    // Not discarded: the same code, or the same identity under another code, is a twin.
    expect(refusalOf(await author.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, familyCode: 'PCM500-D3B', batchSizes: sizes } }))?.code).toBe('DESIGNER_FAMILY_EXISTS');
    valueOf(await discard(author, first));
    const again = await createFamily(author, { familyCode: 'PCM500-D3B', batchSizes: sizes });
    expect(again).toMatchObject({ familyId: first.familyId, familyCode: 'PCM500-D3B', state: 'DRAFT' });
    expect(again.versionId).not.toBe(first.versionId);
    expect(again.number).not.toBe(first.number);
    // The discarded draft stays on record, WITHDRAWN.
    expect(valueOf(await author.call(routes.designer.version, { params: { versionId: first.versionId } })).state).toBe('WITHDRAWN');
    // A twin under another code is refused, with the hint to discard and reuse the code; so is a third draft while the
    // second is open.
    const twin = await author.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, familyCode: 'PCM500-D3C', batchSizes: sizes } });
    expect(refusalOf(twin)?.code).toBe('DESIGNER_FAMILY_EXISTS');
    expect(JSON.stringify(twin)).toMatch(/discard that draft .* under the same family code/);
    expect(refusalOf(await author.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, familyCode: 'PCM500-D3B', batchSizes: sizes } }))?.code).toBe('DESIGNER_FAMILY_EXISTS');
    // The same code with another batch-size set is not that family: refused.
    valueOf(await discard(author, again));
    expect(refusalOf(await author.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, familyCode: 'PCM500-D3B', batchSizes: [{ quantity: '44.000', unit: 'kg' }] } }))?.code).toBe('DESIGNER_FAMILY_EXISTS');
  }, 120_000);
});
