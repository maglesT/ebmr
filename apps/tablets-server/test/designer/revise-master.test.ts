/**
 * Demo report r13 (13 November 2026), bugs 2 and 3: no screen could revise an APPROVED master or take a version out of
 * verification. recipe.derive_version and recipe.return_to_draft existed in the database, but no route called them, so a
 * change needed a new formula version and a copied master family, and a version IN_VERIFICATION stayed there for good.
 *
 *  - designer.deriveVersion: the MBR author starts the next version of an APPROVED (or RETIRED) master as a DRAFT derived
 *    from it, with their own reason (PR-06); the approved version stays APPROVED, in force, until its successor is approved
 *    and authorised. One open version per family at a time: the route refuses a second one and names the open one.
 *  - designer.returnToDraft: a version IN_VERIFICATION (the author), SUBMITTED (the checker) or CHECKED (QA) returns to
 *    DRAFT with the person's own reason; the new draft cycle supersedes every signature (DI-22, DI-37). The DRAFT can then
 *    be edited, or discarded (designer.discardDraft).
 * The database decides each refusal (permission by state, the reason, the source state); the route adds the roles and the
 * one-open-version check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { lifecycle } from '@ebmr/recipe-core';
import type { World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { edited, saveContent } from './support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';

const D = routes.designer;
let server: TestServer;
let world: World;
let author: TestBrowser;
let checker: TestBrowser;
let qa: TestBrowser;

beforeAll(async () => {
  server = await startSigningServer('GMP', { stub: false });
  world = await gmpLifecycleWorld(server);
  [author, checker, qa] = await Promise.all([server.asPersona('author'), server.asPersona('checker'), server.asPersona('approver')]);
}, 300_000);
afterAll(async () => {
  await server?.close();
});

const why = (text: string) => ({ reason: { code: 'MBR_REVISION', text } });
const derive = (who: TestBrowser, versionId: string, text = 'Blend yield basis corrected (CR-2026-031)') => who.call(D.deriveVersion, { params: { versionId }, body: why(text) });
const giveBack = (who: TestBrowser, versionId: string, text = 'Golden case G-BLEND-YIELD must be corrected first') =>
  who.call(D.returnToDraft, { params: { versionId }, body: why(text) });
const stateOf = async (versionId: string) => valueOf(await qa.call(D.version, { params: { versionId } })).state;

/** A version of a new family, in verification. */
async function inVerification(): Promise<string> {
  const content = gmpContent();
  const v = await world.newVersion(content);
  await world.prepare(v.versionId, content);
  await world.startVerification(v.versionId);
  return v.versionId;
}

describe('revising an approved master (demo report r13, bug 2)', () => {
  it('[PR-06][DI-22] the author starts the next version of an APPROVED master: a DRAFT of the same family, derived from it, with its content and the author\'s reason; the approved version stays APPROVED', async () => {
    const approved = await world.approvedVersion(gmpContent());
    const before = valueOf(await author.call(D.version, { params: { versionId: approved.versionId } }));
    const next = valueOf(await derive(author, approved.versionId));
    expect(next).toMatchObject({ familyId: approved.familyId, state: 'DRAFT', revision: 1, contentHash: before.contentHash, savedNote: 'Blend yield basis corrected (CR-2026-031)' });
    expect(next.versionId).not.toBe(approved.versionId);
    expect(await stateOf(approved.versionId)).toBe('APPROVED');
    const row = await server.db.admin.query<{ derived_from: string; version_number: number }>('select derived_from, version_number from recipe.mbr_version where id = $1', [next.versionId]);
    expect(row.rows[0]).toEqual({ derived_from: approved.versionId, version_number: approved.versionNumber + 1 });
    const audit = await server.db.admin.query<{ reason_code: string; reason_text: string }>(
      "select payload ->> 'reason_code' as reason_code, payload ->> 'reason_text' as reason_text from kernel.audit_event where table_name = 'recipe.mbr_version' and action = 'INSERT' and record_id = $1",
      [next.versionId],
    );
    expect(audit.rows).toEqual([{ reason_code: 'MBR_REVISION', reason_text: 'Blend yield basis corrected (CR-2026-031)' }]);
    // The new DRAFT is edited as any draft: a revision is saved on it.
    const content = edited(next, (c) => {
      c.header.title = `${c.header.title} (rev.)`;
    });
    const saved = valueOf(await saveContent(author, next, content, 'title'));
    expect(saved).toMatchObject({ state: 'DRAFT', revision: 2 });
  }, 300_000);

  it('[PR-06][DI-22] a revision is refused without a reason, by anyone but the MBR author, from a version that was never approved, and while the family already has an open version', async () => {
    const approved = await world.approvedVersion(gmpContent());
    expect(refusalOf(await derive(author, approved.versionId, ' '))).toMatchObject({ status: 400 });
    expect(refusalOf(await derive(checker, approved.versionId))).toMatchObject({ status: 403, code: 'ROLE_NOT_ALLOWED' });
    expect(refusalOf(await derive(qa, approved.versionId))).toMatchObject({ status: 403, code: 'ROLE_NOT_ALLOWED' });
    const draft = valueOf(await derive(author, approved.versionId));
    // From a DRAFT: the database refuses (EBMR-RCP-027).
    expect(refusalOf(await derive(author, draft.versionId))).toMatchObject({ status: 422, code: 'EBMR-RCP-027' });
    // A second open version of the family: refused, naming the open one.
    const twice = refusalOf(await derive(author, approved.versionId));
    expect(twice).toMatchObject({ status: 409, code: 'DESIGNER_OPEN_VERSION' });
    expect(twice.why).toContain(draft.number);
    // Once that draft is discarded, the next one may start.
    valueOf(await author.call(D.discardDraft, { params: { versionId: draft.versionId }, body: { reason: { code: 'DRAFT_DISCARDED', text: 'Started twice' } } }));
    expect(valueOf(await derive(author, approved.versionId)).state).toBe('DRAFT');
  }, 300_000);
});

describe('taking a version out of verification (demo report r13, bug 2)', () => {
  it('[DI-22][DI-24][PR-06] the author returns a version IN_VERIFICATION to DRAFT with a reason; it is edited again, or discarded, and the return is in the state history with that reason', async () => {
    const id = await inVerification();
    expect(refusalOf(await giveBack(author, id, ' '))).toMatchObject({ status: 400 });
    // IN_VERIFICATION returns by the author only (MBR.AUTHOR): the checker is refused by the database.
    expect(refusalOf(await giveBack(checker, id))).toMatchObject({ status: 422, code: 'EBMR-IAM-040', why: expect.stringContaining('MBR.AUTHOR') as unknown });
    expect(await stateOf(id)).toBe('IN_VERIFICATION');
    const back = valueOf(await giveBack(author, id));
    expect(back.state).toBe('DRAFT');
    const history = await server.db.admin.query<{ reason_code: string; reason_text: string; from_state: string }>(
      "select reason_code, reason_text, from_state from platform.state_history where aggregate_type = 'mbr_version' and aggregate_id = $1 and event = 'RETURN'",
      [id],
    );
    expect(history.rows).toEqual([{ reason_code: 'MBR_REVISION', reason_text: 'Golden case G-BLEND-YIELD must be corrected first', from_state: 'IN_VERIFICATION' }]);
    // A DRAFT is not returned again (the engine refuses the event).
    expect(refusalOf(await giveBack(author, id))?.status).toBe(422);
    const gone = valueOf(await author.call(D.discardDraft, { params: { versionId: id }, body: { reason: { code: 'DRAFT_DISCARDED', text: 'Abandoned after verification failed' } } }));
    expect(gone.state).toBe('WITHDRAWN');
  }, 300_000);

  it('[DI-37][DI-22] the checker returns a SUBMITTED version to DRAFT: the author\'s PREPARED signature no longer counts, and the author may not return it', async () => {
    const id = await inVerification();
    await world.submit(id);
    expect(await stateOf(id)).toBe('SUBMITTED');
    expect(refusalOf(await giveBack(author, id))).toMatchObject({ status: 422, code: 'EBMR-IAM-040', why: expect.stringContaining('MBR.CHECK') as unknown });
    expect(valueOf(await giveBack(checker, id, 'Step 3 instruction unclear')).state).toBe('DRAFT');
    const sigs = valueOf(await qa.call(routes.esig.signatures, { query: { aggregateType: 'mbr_version', aggregateId: id } })).signatures;
    expect(sigs.filter((s) => s.meaning === 'PREPARED').map((s) => s.valid)).toEqual([false]);
    const s = await lifecycle.versionState(server.db.app, id);
    expect(s?.state).toBe('DRAFT');
  }, 300_000);

  it('[PR-06] an APPROVED version is not returned to DRAFT: it changes only through a derived version', async () => {
    const approved = await world.approvedVersion(gmpContent());
    expect(refusalOf(await giveBack(qa, approved.versionId))?.status).toBe(422);
    expect(await stateOf(approved.versionId)).toBe('APPROVED');
  }, 300_000);
});
