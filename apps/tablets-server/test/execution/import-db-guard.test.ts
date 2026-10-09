/**
 * The test-package import is refused by the database, not only by the server's TypeScript pre-check (Phase 2 exit
 * review F16; DI-05, INV-18, DI-37; ADR 0012: a rule holds when the application's own database credentials are used).
 *
 * Here the server's pre-check (packages.ts packageToImport: parse, hashes, file name, GMP origin) is replaced by one
 * that hands the inbox file to the import as it is, as if the check had been lost. Every refusal then comes from
 * recipe.import_test_package, through the real import route: a package from a sandbox, one changed after export, and
 * one exported honestly but stored under another package's file name. For the last, the route passes the database the
 * name of the inbox file it read (before the review it passed `<packageHash>.json`, computed from the package, so the
 * database's file-name check could never fail and the rule was the server's alone).
 */
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import type * as Packages from '../../src/features/execution/packages.ts';
import { dcMini, outcomeOf, refusalOf, startExecServer, valueOf, writePackage, type ExecServer } from './support.ts';

vi.mock('../../src/features/execution/packages.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Packages>();
  return {
    ...actual,
    // No pre-check: the inbox file, parsed as JSON and nothing more.
    packageToImport: async (app: Parameters<typeof actual.inboxDir>[0], packageId: string) => JSON.parse(await readFile(join(actual.inboxDir(app), `${packageId}.json`), 'utf8')) as unknown,
  };
});

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
}, 120_000);
afterAll(async () => {
  await server?.close();
});

async function storedPackages(): Promise<string[]> {
  return (await server.db.admin.query<{ h: string }>('select package_hash as h from recipe.test_package order by package_hash')).rows.map((r) => r.h);
}

describe('test-package import with the server pre-check bypassed (F16)', () => {
  it('[DI-05][INV-18][DI-37] the database refuses a package not exported from GMP, one changed after export and one under another file name; nothing is stored', async () => {
    const issuer = await server.asPersona('issuer');
    const importPackage = (packageId: string) => issuer.call(routes.execution.importPackage, { params: { packageId }, body: {} });
    const before = await storedPackages();

    const fromSandbox = writePackage(server, dcMini(), { source: { installationKind: 'SANDBOX', watermark: 'TEST, NOT GMP' } });
    const notGmp = await importPackage(fromSandbox.packageHash);
    expect(outcomeOf(notGmp)).toBe('422:EBMR-EXE-018');
    expect(refusalOf(notGmp).why).toMatch(/does not come from a GMP installation/);

    const good = writePackage(server, dcMini());
    writeFileSync(join(server.exchangeDir, 'to-sandbox', `${good.packageHash}.json`), JSON.stringify({ ...good, version: { ...good.version, number: '9' } }));
    const changed = await importPackage(good.packageHash);
    expect(outcomeOf(changed)).toBe('422:EBMR-EXE-017');
    expect(refusalOf(changed).why).toMatch(/does not match its content or its file name/);

    // An honest package stored under the file name of another package (the sandbox one's): the database checks the
    // name of the file the server read.
    const honest = writePackage(server, dcMini(), {}, `${fromSandbox.packageHash}.json`);
    const renamed = await importPackage(fromSandbox.packageHash);
    expect(outcomeOf(renamed)).toBe('422:EBMR-EXE-017');
    expect(refusalOf(renamed).why).toMatch(/does not match its content or its file name/);
    expect(await storedPackages()).toEqual(before);

    // The same package under its own name is imported.
    writeFileSync(join(server.exchangeDir, 'to-sandbox', `${honest.packageHash}.json`), JSON.stringify(honest));
    expect(valueOf(await importPackage(honest.packageHash))).toMatchObject({ packageHash: honest.packageHash, imported: true, sourceInstallation: 'GMP' });
    expect(await storedPackages()).toEqual([...before, honest.packageHash].sort());
  }, 180_000);
});
