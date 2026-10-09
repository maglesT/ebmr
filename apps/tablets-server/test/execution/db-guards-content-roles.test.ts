/**
 * A test package's MBR content names only roles that can act there (Phase 2 exit review F48, F49; PR-45, INV-26;
 * recipe-core 0324). A package is the content a sandbox test run executes; a hold point its content says a production
 * operator releases, or a step performed by a role no session carries, must not reach a run, whatever wrote the
 * package. The server refuses such a package before the database (the engine's definition: ENG-DEF-HOLD-ROLE), and the
 * database refuses to store it when recipe.import_test_package is called directly by the application role
 * (EBMR-RCP-123).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { routes } from '@ebmr/api-contract';
import { execution, flow } from '@ebmr/recipe-core';
import { actorOf, codeOf, messageOf } from './db-guards-support.ts';
import { dcMini, startExecServer, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, unknown>;

/** dc-mini with the role of node `id` at `path` set to `role`. */
function withRole(id: string, set: (node: Json) => void): flow.MbrContent {
  const c = JSON.parse(JSON.stringify(dcMini())) as Json;
  let found = false;
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Json;
    if (o['id'] === id && typeof o['kind'] === 'string') {
      set(o);
      found = true;
    } else Object.values(o).forEach(visit);
  };
  visit(c);
  if (!found) throw new Error(`SETUP: dc-mini has no node ${id}`);
  const parsed = flow.parseMbr(c);
  if (!parsed.ok) throw new Error(`SETUP: ${JSON.stringify(parsed.problems)}`);
  return parsed.mbr;
}

async function importDirect(pkg: execution.TestPackageV1): Promise<Promise<unknown>> {
  const issuer = await sbx.asPersona('issuer');
  const actor = await actorOf(sbx, issuer, 'issuer');
  return withCommand(sbx.db.app, actor, (c) => execution.importTestPackage(c, pkg, `${pkg.packageHash}.json`));
}

describe('F48, F49: the content of a test package names only roles that can act (PR-45, INV-26)', () => {
  it('[PR-45][INV-26] a package whose hold point a production operator releases, or whose step a role no session carries performs, is refused by the server and, called directly, by the database', async () => {
    const issuer = await sbx.asPersona('issuer');
    const cases: [string, flow.MbrContent, RegExp][] = [
      ['hold point released by PRODUCTION_OPERATOR', withRole('H-BLEND', (n) => void (n['role'] = 'PRODUCTION_OPERATOR')), /hold point H-BLEND is released by PRODUCTION_OPERATOR; a QA hold point is released only by QA/],
      ['hold point released by QA_SHOP_FLOOR', withRole('H-BLEND', (n) => void (n['role'] = 'QA_SHOP_FLOOR')), /the releaser of H-BLEND is "QA_SHOP_FLOOR", which is not an engine role/],
      ['step performed by OPERATOR', withRole('p-disp-sop', (n) => void ((n['signatures'] as { perform: { role: string } }).perform.role = 'OPERATOR')), /the performer of p-disp-sop is "OPERATOR"/],
    ];
    for (const [what, content, message] of cases) {
      const pkg = writePackage(sbx, content);
      const r = await issuer.call(routes.execution.importPackage, { params: { packageId: pkg.packageHash }, body: {} });
      expect(r.ok, what).toBe(false);
      const direct = await messageOf(importDirect(pkg));
      expect(direct, what).toMatch(message);
      expect(direct, what).toMatch(/\[EBMR-RCP-123\]$/);
      const stored = await sbx.db.admin.query('select 1 from recipe.test_package where package_hash = $1', [pkg.packageHash]);
      expect(stored.rowCount, what).toBe(0);
    }
    // Control: the template's own package is imported directly (so each refusal above is the role's).
    expect(await codeOf(importDirect(writePackage(sbx, dcMini())))).toBe('ok');
  });
});
