/**
 * The test-package export keeps the recorded export and its file together (review P14 and P65; DI-05, DI-04,
 * DI-22): the export command stages the package file (fsync), records tab.mbr_test_package_export with the business
 * entry "Test package <hash> exported for a sandbox test run" and commits; only then is the file hard-linked to
 * to-sandbox/<packageHash>.json. When that link failed, the handler deleted the staged file although the export was
 * already recorded, answered "Nothing was saved", and every resend with the same Idempotency-Key replayed into a
 * link of the deleted file (500, forever). On an exchange share without hard links, every new attempt recorded one
 * more export (and one more "exported" entry) for a package that never reached the inbox.
 *
 * Now:
 *  - the inbox must take a hard link of the staged file before the export is recorded, so a share without hard links
 *    records nothing, however often the export is tried;
 *  - no new export is recorded while an earlier recorded export cannot be placed in the inbox;
 *  - a staged file is removed only when the command surely did not commit (a commit whose answer was lost is found
 *    in the database and published; an outcome that stays open keeps the staged file);
 *  - after the commit a failed publish is answered as such (the export is recorded, the file is not in the inbox
 *    yet) and a resend with the same key publishes the same package, re-staged from the stored result when the
 *    staged file is gone. Staged packages of recorded exports are published by the next export (or at start-up),
 *    never one that is not recorded;
 *  - a file is published under a package's write-once name only when its text is that package, and a file already
 *    under that name counts as published only when it holds the package (a staged file changed on disk was
 *    published as the recorded package, and any file under the name was taken for it);
 *  - exports pass the inbox gate one at a time (a burst of exports while the inbox took no package used to pass the
 *    gate together and record several exports without their files).
 */
import { randomUUID } from 'node:crypto';
import type * as FsPromises from 'node:fs/promises';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { identity } from '@ebmr/kernel';
import { routes, type VersionView } from '@ebmr/api-contract';
import { execution } from '@ebmr/recipe-core';
import { openPersonaSession } from '@ebmr/test-kit';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import type * as Commands from '../../src/platform/db/commands.ts';
import { createFamily, edited, findPhase, justifyBody, refusalOf, saveContent, startDesignerServer, valueOf } from './support.ts';

// link() failures on demand, then the real link() again (everything else in node:fs/promises is real):
// `failFinal` fails the next links to a package's final name (<hash>.json), `linkBroken` fails every link (an exchange
// share without hard links). `beforeStage` runs when the export command opens its staging file (to change the
// version in between). `loseAnswer` makes the export command's call fail after it committed (the answer lost with the
// connection); `dropAfterWork` makes it fail after its work, before the commit, with an error that says nothing about
// the outcome (as a dropped connection does); `refuseAfterWork` with an error the database itself answered (an
// SQLSTATE with its severity, as a refused commit is answered). `stageDelayMs` holds every staging for a while (so
// concurrent export commands overlap).
const fault = vi.hoisted(() => ({
  failFinal: 0,
  linkBroken: false,
  failed: [] as string[],
  beforeStage: null as (() => Promise<void>) | null,
  loseAnswer: false,
  dropAfterWork: false,
  refuseAfterWork: false,
  stageDelayMs: 0,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const link = (existingPath: string, newPath: string): Promise<void> => {
    const final = String(newPath).endsWith('.json');
    if (fault.linkBroken || (final && fault.failFinal > 0)) {
      if (final && !fault.linkBroken) fault.failFinal -= 1;
      fault.failed.push(String(newPath));
      return Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, link '${String(existingPath)}' -> '${String(newPath)}'`), { code: 'EPERM', errno: -1, syscall: 'link' }));
    }
    return actual.link(existingPath, newPath);
  };
  const open = (async (path: string, ...rest: unknown[]) => {
    if (String(path).endsWith('.tmp') && fault.beforeStage) {
      const hook = fault.beforeStage;
      fault.beforeStage = null;
      await hook();
    }
    if (String(path).endsWith('.tmp') && fault.stageDelayMs > 0) await new Promise((r) => setTimeout(r, fault.stageDelayMs));
    return (actual.open as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, link, open }, link, open };
});
vi.mock('../../src/platform/db/commands.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Commands>();
  const withIdempotentActorCommand: typeof actual.withIdempotentActorCommand = async (pool, actor, key, requestHash, work, options) => {
    const drop = fault.dropAfterWork;
    const refuse = fault.refuseAfterWork;
    const lose = fault.loseAnswer;
    fault.dropAfterWork = false;
    fault.refuseAfterWork = false;
    fault.loseAnswer = false;
    const r = await actual.withIdempotentActorCommand(
      pool,
      actor,
      key,
      requestHash,
      async (c) => {
        const out = await work(c);
        if (drop) throw new Error('Connection terminated unexpectedly');
        if (refuse) throw Object.assign(new Error('could not serialize access due to read/write dependencies among transactions'), { code: '40001', severity: 'ERROR' });
        return out;
      },
      options,
    );
    if (lose) throw new Error('Connection terminated unexpectedly');
    return r;
  };
  return { ...actual, withIdempotentActorCommand };
});

let server: TestServer;
let author: TestBrowser;
let exchange: string;
let families = 0;

const toSandbox = (): string => join(exchange, 'to-sandbox');
const stagingFiles = (): string[] => (existsSync(join(toSandbox(), '.staging')) ? readdirSync(join(toSandbox(), '.staging')) : []);
const publishedFiles = (): string[] => (existsSync(toSandbox()) ? readdirSync(toSandbox()).filter((f) => f.endsWith('.json')) : []);

async function recordedExports(versionId: string): Promise<string[]> {
  const { rows } = await server.db.admin.query<{ file_name: string }>('select file_name from tab.mbr_test_package_export where version_id = $1 order by exported_at', [versionId]);
  return rows.map((r) => r.file_name);
}

async function exportAuditEntries(v: VersionView): Promise<number> {
  const { rows } = await server.db.admin.query<{ message: string | null }>(
    "select payload -> 'body' ->> 'message' as message from kernel.audit_event where chain_key = $1 and action = 'BUSINESS' order by seq",
    [v.auditChain],
  );
  return rows.filter((e) => /Test package [0-9a-f]{12} exported/.test(e.message ?? '')).length;
}

/** Every recorded export (of every version) has its package file in to-sandbox, with the recorded package hash. */
async function recordedWithoutFile(): Promise<string[]> {
  const { rows } = await server.db.admin.query<{ file_name: string; package_hash: string }>('select file_name, package_hash from tab.mbr_test_package_export');
  return rows
    .filter((r) => {
      const path = join(toSandbox(), r.file_name);
      if (!existsSync(path)) return true;
      return execution.packageHashOf(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) !== r.package_hash;
    })
    .map((r) => r.file_name);
}

/** A family whose saved revision has one justified warning (so it may be sent to the sandbox). */
async function sendable(): Promise<VersionView> {
  families += 1;
  const v0 = await createFamily(author, { familyCode: `PCM500-P14-${families}`, batchSizes: [{ quantity: `${40 + families}.000`, unit: 'kg' }] });
  const v = valueOf(await saveContent(author, v0, edited(v0, (j) => (findPhase(j, 'p-disp-exc').config = {})), 'excipient tolerance removed'));
  valueOf(
    await author.call(routes.designer.justify, {
      params: { versionId: v.versionId },
      body: justifyBody(v, 'G07-TOLERANCE-MISSING@p-disp-exc', 'Checked at reconciliation.'),
    }),
  );
  return v;
}

beforeAll(async () => {
  exchange = mkdtempSync(join(tmpdir(), 'ebmr-p14-exchange-'));
  server = await startDesignerServer({ env: { EBMR_EXCHANGE_DIR: exchange, EBMR_OTHER_INSTALLATION_URL: 'http://localhost:3011' } });
  author = await server.asPersona('author');
});
beforeEach(() => {
  fault.failFinal = 0;
  fault.linkBroken = false;
  fault.failed = [];
  fault.beforeStage = null;
  fault.loseAnswer = false;
  fault.dropAfterWork = false;
  fault.refuseAfterWork = false;
  fault.stageDelayMs = 0;
});
afterAll(async () => {
  await server?.close();
  rmSync(exchange, { recursive: true, force: true });
});

describe('test-package export: recorded export and file stay together (DI-05, DI-04)', () => {
  it('[IN-02][DI-04] the package carries only the justifications that answer a warning of its content', async () => {
    const v = await sendable();
    // A justification recorded for this very content under a key that is no warning of it (written directly).
    const actor = { ...(await openPersonaSession(server.db, server.seed, 'author')), reasonCode: 'TEST', reasonText: 'unrelated justification' };
    await identity.withGuardedCommand(server.db.app, actor, (c) =>
      c.query('select tab.record_designer_justification($1, $2, $3, $4)', [v.versionId, 'DATA-SINGLE-WRITER@nowhere', 'Not a warning of this content.', v.contentHash]),
    );
    const r = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() }));
    const pkg = JSON.parse(readFileSync(join(toSandbox(), r.fileName), 'utf8')) as { justifications: { key: string }[] };
    expect(pkg.justifications.map((j) => j.key)).toEqual(['G07-TOLERANCE-MISSING@p-disp-exc']);
  });

  it('[DI-05][DI-04] a retry with the same key after a publish failure behind the commit publishes the recorded package (P14)', async () => {
    const v = await sendable();
    const idempotencyKey = randomUUID();
    fault.failFinal = 1;
    const first = await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey });
    expect(fault.failed.length).toBe(1); // the fault really hit the publish step
    // Answered as what happened: the export is recorded, its file is not in the inbox yet; never "nothing was saved".
    const r = refusalOf(first);
    expect(r.code).toBe('TEST_PACKAGE_NOT_PUBLISHED');
    expect(r.status).toBe(503);
    expect(r.kind).not.toBe('NOT_SAVED');
    const recorded = await recordedExports(v.versionId);
    expect(recorded).toHaveLength(1);
    // The staged copy of the recorded package is kept for the retry.
    expect(stagingFiles().filter((f) => f.startsWith(recorded[0]?.replace(/\.json$/, '') ?? '-'))).toHaveLength(1);

    // The dialog resends with the same Idempotency-Key once the fault has cleared.
    const retry = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey }));
    expect(retry.fileName).toBe(recorded[0]);
    expect(await recordedExports(v.versionId)).toEqual(recorded);
    expect(await exportAuditEntries(v)).toBe(1);
    expect(publishedFiles()).toContain(recorded[0]);
    expect(await recordedWithoutFile()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
  });

  it('[DI-05][DI-22] the same-key retry re-stages the recorded package when its staged file is gone (P65)', async () => {
    const v = await sendable();
    const idempotencyKey = randomUUID();
    fault.failFinal = 1;
    refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey }));
    const [fileName] = await recordedExports(v.versionId);
    // The staged file is lost (a clean-up, a crash before the link): the stored result still holds the package.
    for (const f of stagingFiles()) rmSync(join(toSandbox(), '.staging', f));
    const retry = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey }));
    expect(retry.fileName).toBe(fileName);
    const pkg = JSON.parse(readFileSync(join(toSandbox(), fileName ?? ''), 'utf8')) as Record<string, unknown>;
    expect(execution.parseTestPackage(pkg, fileName ?? '').ok).toBe(true);
    expect(execution.packageHashOf(pkg)).toBe(retry.packageHash);
    expect(await recordedWithoutFile()).toEqual([]);
    expect(await exportAuditEntries(v)).toBe(1);
  });

  it('[DI-05] a recorded export whose publish failed and was never retried is published by the next export', async () => {
    const v = await sendable();
    fault.failFinal = 1;
    refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() }));
    const [abandoned] = await recordedExports(v.versionId);
    expect(publishedFiles()).not.toContain(abandoned);
    // The author gives up on that dialog; later someone sends another version (a new key, a new export).
    const other = await sendable();
    const next = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: other.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(publishedFiles()).toEqual(expect.arrayContaining([abandoned, next.fileName]));
    expect(await recordedWithoutFile()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
  });

  it('[DI-05][DI-04] an export whose command does not commit leaves no file, published or staged, and nothing is published later', async () => {
    const v = await sendable();
    // While the command stages the file, another revision is saved (in the author's other session, so the two
    // commands do not wait on one session): the database refuses the record (EBMR-TAB-160).
    const elsewhere = await server.asPersona('author');
    fault.beforeStage = async () => {
      valueOf(await saveContent(elsewhere, v, edited(v, (j) => (j.header.title = `${j.header.title} (edited meanwhile)`)), 'edited meanwhile'));
    };
    const before = publishedFiles();
    const refused = refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(refused.code).toBe('EBMR-TAB-160');
    expect(await recordedExports(v.versionId)).toEqual([]);
    expect(await exportAuditEntries(v)).toBe(0);
    expect(stagingFiles()).toEqual([]);
    expect(publishedFiles()).toEqual(before);
    // A well-formed package staged without a recorded export (as a command that is still running, or one that
    // crashed before its commit, leaves it): never published by a later export, and left alone.
    const [published] = publishedFiles();
    const forged: Record<string, unknown> = { ...(JSON.parse(readFileSync(join(toSandbox(), published ?? ''), 'utf8')) as Record<string, unknown>), exportedAtUs: '1000000000000000' };
    delete forged['packageHash'];
    const forgedHash = execution.packageHashOf(forged);
    const forgedName = `${forgedHash}.${randomUUID()}.tmp`;
    writeFileSync(join(toSandbox(), '.staging', forgedName), `${JSON.stringify({ ...forged, packageHash: forgedHash }, null, 2)}\n`);
    // The next export publishes only its own package.
    const other = await sendable();
    const next = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: other.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(publishedFiles().sort()).toEqual([...before, next.fileName].sort());
    expect(publishedFiles()).not.toContain(`${forgedHash}.json`);
    expect(stagingFiles()).toEqual([forgedName]);
    expect(await recordedWithoutFile()).toEqual([]);
    rmSync(join(toSandbox(), '.staging', forgedName));
  });
  it('[DI-05][DI-04] on an exchange share without hard links no attempt records an export: nothing piles up on the audit trail (P14)', async () => {
    const v = await sendable();
    const before = publishedFiles();
    fault.linkBroken = true;
    const refused: { status: number; code: string; kind: string }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() }));
      refused.push({ status: r.status, code: r.code, kind: r.kind });
    }
    expect(refused).toEqual(Array.from({ length: 3 }, () => ({ status: 503, code: 'TEST_PACKAGE_INBOX_UNAVAILABLE', kind: 'NOT_SAVED' })));
    expect(fault.failed.length).toBe(3); // each attempt was stopped by its own link check, before anything was recorded
    expect(await recordedExports(v.versionId)).toEqual([]);
    expect(await exportAuditEntries(v)).toBe(0);
    expect(stagingFiles()).toEqual([]);
    expect(publishedFiles()).toEqual(before);
    expect(readdirSync(toSandbox()).filter((f) => f.startsWith('.link-check.'))).toEqual([]);

    // Once the share takes hard links, the export is recorded once and its file is in the inbox.
    fault.linkBroken = false;
    const ok = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(await recordedExports(v.versionId)).toEqual([ok.fileName]);
    expect(await exportAuditEntries(v)).toBe(1);
    expect(publishedFiles()).toContain(ok.fileName);
    expect(await recordedWithoutFile()).toEqual([]);
  });

  it('[DI-05][DI-04] while an earlier recorded export cannot be placed in the inbox, no new export is recorded (P14)', async () => {
    const v = await sendable();
    fault.failFinal = 1;
    expect(refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() })).code).toBe('TEST_PACKAGE_NOT_PUBLISHED');
    const [pending] = await recordedExports(v.versionId);
    expect(publishedFiles()).not.toContain(pending);

    // The next export (another version, a new key) first tries to publish the pending one; that fails again, so the
    // new one is refused and nothing of it is recorded or staged.
    const other = await sendable();
    fault.failFinal = 1;
    const refused = refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: other.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect([refused.status, refused.code, refused.kind]).toEqual([503, 'TEST_PACKAGE_INBOX_BEHIND', 'NOT_SAVED']);
    expect(fault.failed.at(-1)).toMatch(new RegExp(`${pending ?? '-'}$`));
    expect(await recordedExports(other.versionId)).toEqual([]);
    expect(await exportAuditEntries(other)).toBe(0);
    expect(stagingFiles().map((f) => f.slice(0, 64))).toEqual([pending?.slice(0, 64)]);

    // Once the inbox takes it, the next attempt publishes the pending package and then records and publishes its own.
    const next = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: other.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(publishedFiles()).toEqual(expect.arrayContaining([pending, next.fileName]));
    expect(await recordedExports(other.versionId)).toEqual([next.fileName]);
    expect(await recordedWithoutFile()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
  });

  it('[DI-05][DI-22] an export that committed although its call failed (answer lost) keeps its staged file and is published (P14, P65)', async () => {
    const v = await sendable();
    fault.loseAnswer = true;
    const r = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(fault.loseAnswer).toBe(false); // the fault really hit the export command
    expect(await recordedExports(v.versionId)).toEqual([r.fileName]);
    expect(await exportAuditEntries(v)).toBe(1);
    expect(publishedFiles()).toContain(r.fileName);
    expect(await recordedWithoutFile()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
  });

  it('[DI-05][DI-22] when the outcome of the commit stays open, the staged file is kept and published only if the export is recorded', async () => {
    const v = await sendable();
    const before = publishedFiles();
    fault.dropAfterWork = true;
    const r = refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(fault.dropAfterWork).toBe(false);
    expect(r.status).toBe(500);
    // The command did not commit here (the database has no such export), but the error said nothing about it: the
    // staged file is kept rather than risk deleting the only copy of a recorded package.
    expect(await recordedExports(v.versionId)).toEqual([]);
    expect(await exportAuditEntries(v)).toBe(0);
    const kept = stagingFiles();
    expect(kept).toHaveLength(1);
    expect(publishedFiles()).toEqual(before);
    // It is not recorded, so a later export neither publishes it nor is held up by it.
    const next = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(publishedFiles().sort()).toEqual([...before, next.fileName].sort());
    expect(stagingFiles()).toEqual(kept);
    expect(await recordedWithoutFile()).toEqual([]);
    for (const f of kept) rmSync(join(toSandbox(), '.staging', f));
  });
  it('[DI-05][DI-04] when the database itself refused the commit, the staged file is removed and nothing is published', async () => {
    const v = await sendable();
    const before = publishedFiles();
    fault.refuseAfterWork = true;
    const r = refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(fault.refuseAfterWork).toBe(false);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await recordedExports(v.versionId)).toEqual([]);
    expect(await exportAuditEntries(v)).toBe(0);
    expect(stagingFiles()).toEqual([]);
    expect(publishedFiles()).toEqual(before);
  });
  it('[DI-05][DI-04] a staged file changed on disk is never published under the recorded package name; the resend publishes the recorded package (P14)', async () => {
    const b = await server.asPersona('author');
    const v = await sendable();
    const idempotencyKey = randomUUID();
    fault.failFinal = 1;
    expect(refusalOf(await b.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey })).code).toBe('TEST_PACKAGE_NOT_PUBLISHED');
    const [fileName = '-'] = await recordedExports(v.versionId);
    const [stagedName = '-'] = stagingFiles();
    // Someone changes the staged copy of the recorded package on disk, keeping its packageHash member.
    const stagedPath = join(toSandbox(), '.staging', stagedName);
    const changed = JSON.parse(readFileSync(stagedPath, 'utf8')) as { justifications: { text: string }[] };
    expect(changed.justifications).toHaveLength(1);
    for (const j of changed.justifications) j.text = 'Changed on disk.';
    writeFileSync(stagedPath, `${JSON.stringify(changed, null, 2)}\n`);

    // The next export (another version) does not publish it, and records nothing while it stays.
    const other = await sendable();
    const behind = refusalOf(await b.call(routes.designer.testPackage, { params: { versionId: other.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(behind.code).toBe('TEST_PACKAGE_INBOX_BEHIND');
    expect(behind.why).toMatch(/not the recorded package/);
    expect(publishedFiles()).not.toContain(fileName);
    expect(await recordedExports(other.versionId)).toEqual([]);

    // The resend with the same key publishes the recorded package (from the text its command stored), never the
    // changed file; the changed staged copy is gone and exports work again.
    const retry = valueOf(await b.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey }));
    expect(retry.fileName).toBe(fileName);
    const published = JSON.parse(readFileSync(join(toSandbox(), fileName), 'utf8')) as Record<string, unknown> & { justifications: { text: string }[] };
    expect(execution.packageHashOf(published)).toBe(retry.packageHash);
    expect(published.justifications.map((j) => j.text)).toEqual(['Checked at reconciliation.']);
    expect(await recordedWithoutFile()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
    const next = valueOf(await b.call(routes.designer.testPackage, { params: { versionId: other.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(publishedFiles()).toContain(next.fileName);
    expect(await exportAuditEntries(v)).toBe(1);
  });

  it('[DI-05][DI-04] a file of other content under a recorded package\'s inbox name never counts as published; its staged package is kept until the name is cleared (P14)', async () => {
    const b = await server.asPersona('author');
    const v = await sendable();
    const idempotencyKey = randomUUID();
    fault.failFinal = 1;
    expect(refusalOf(await b.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey })).code).toBe('TEST_PACKAGE_NOT_PUBLISHED');
    const [fileName = '-'] = await recordedExports(v.versionId);
    const kept = stagingFiles();
    expect(kept).toHaveLength(1);
    // Something else is written under the package's write-once inbox name.
    const finalPath = join(toSandbox(), fileName);
    const foreign = '{"format":"not the package"}\n';
    writeFileSync(finalPath, foreign);

    // The resend does not take that file for the published package: the export stays unpublished, the file is left
    // as it is and the staged package is kept.
    const resent = refusalOf(await b.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey }));
    expect([resent.status, resent.code]).toEqual([503, 'TEST_PACKAGE_NOT_PUBLISHED']);
    expect(resent.why).toMatch(/is not the recorded package/);
    expect(readFileSync(finalPath, 'utf8')).toBe(foreign);
    expect(stagingFiles()).toEqual(kept);
    // Nor does the next export: nothing new is recorded while the name is taken.
    const other = await sendable();
    const behind = refusalOf(await b.call(routes.designer.testPackage, { params: { versionId: other.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(behind.code).toBe('TEST_PACKAGE_INBOX_BEHIND');
    expect(await recordedExports(other.versionId)).toEqual([]);
    expect(stagingFiles()).toEqual(kept);
    expect(await recordedWithoutFile()).toEqual([fileName]);

    // The administrator's recovery (docs/operations/test-package-exchange.md): the foreign file is moved out of the
    // inbox; the next export then publishes the recorded package first, and its own.
    renameSync(finalPath, join(exchange, `quarantined-${fileName}`));
    const next = valueOf(await b.call(routes.designer.testPackage, { params: { versionId: other.versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(publishedFiles()).toEqual(expect.arrayContaining([fileName, next.fileName]));
    expect(await recordedWithoutFile()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
  });

  it('[DI-05][DI-04] concurrent exports pass the inbox gate one at a time: while the inbox takes no package, only one of them is recorded without its file (P14)', async () => {
    const versions = [await sendable(), await sendable(), await sendable()];
    // Each export from its own session (commands of one session wait on each other anyway).
    const sessions = [await server.asPersona('author'), await server.asPersona('author'), await server.asPersona('author')];
    fault.failFinal = 1_000; // the inbox takes no package file
    fault.stageDelayMs = 1_500; // each export command stays a while between the gate and its record
    const answers = await Promise.all(
      versions.map((v, i) => (sessions[i] as TestBrowser).call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {}, idempotencyKey: randomUUID() })),
    );
    fault.failFinal = 0;
    fault.stageDelayMs = 0;
    const codes = answers.map((a) => refusalOf(a).code).sort();
    expect(codes).toEqual(['TEST_PACKAGE_INBOX_BEHIND', 'TEST_PACKAGE_INBOX_BEHIND', 'TEST_PACKAGE_NOT_PUBLISHED']);
    const recorded = (await Promise.all(versions.map((v) => recordedExports(v.versionId)))).flat();
    expect(recorded).toHaveLength(1);
    expect(await recordedWithoutFile()).toEqual(recorded);

    // Once the inbox takes files again, the next export publishes the pending one first.
    const next = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: (versions[1] as VersionView).versionId }, body: {}, idempotencyKey: randomUUID() }));
    expect(publishedFiles()).toEqual(expect.arrayContaining([...recorded, next.fileName]));
    expect(await recordedWithoutFile()).toEqual([]);
    expect(stagingFiles()).toEqual([]);
  });
});
