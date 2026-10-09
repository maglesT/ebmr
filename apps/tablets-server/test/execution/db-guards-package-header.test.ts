/**
 * A test package names the family and product of its own MBR content (Phase 2 exit review F03; DI-04, DI-37; recipe-core
 * 0318). The signatures of a test run bind the content's family, product code and MBR hash (content.batch), and every
 * screen, the signature dialog included, names that family and product; a package whose metadata says otherwise used to
 * be imported, and its runs showed a family and product name the signatures do not bind.
 *
 * The server's parser refuses such a package (EBMR-EXE-017 with the reason) and, whatever the server does, the database
 * refuses to store it (EBMR-EXE-134): the application role (ebmr_sandbox; ADR 0012) calls recipe.import_test_package
 * itself here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { execution, flow } from '@ebmr/recipe-core';
import { routes } from '@ebmr/api-contract';
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

type Family = execution.TestPackageV1['family'];

/** dc-mini's own family, with `edit` applied. */
function family(edit: (f: Family) => void): Family {
  const h = dcMini().header;
  const f: Family = { familyId: randomUUID(), familyCode: h.family, product: { code: h.product.code, name: h.product.name, strength: h.product.strength } };
  edit(f);
  return f;
}

/** recipe.import_test_package called by the issuer's own command through the application role, bypassing the server's parser. */
async function importDirect(pkg: execution.TestPackageV1): Promise<Promise<unknown>> {
  const issuer = await sbx.asPersona('issuer');
  const actor = await actorOf(sbx, issuer, 'issuer');
  return withCommand(sbx.db.app, actor, (c) => execution.importTestPackage(c, pkg, `${pkg.packageHash}.json`));
}

describe('F03: a test package names the family and product of its MBR content (DI-04, DI-37)', () => {
  it('[DI-04][DI-37] a package whose family code or product differs from its MBR content is refused by the server and, called directly, by the database', async () => {
    const issuer = await sbx.asPersona('issuer');
    const cases: [string, Family][] = [
      ['familyCode', family((f) => void (f.familyCode = 'IBU400-DC'))],
      ['product.code', family((f) => void (f.product.code = 'IBU400'))],
      ['product.name', family((f) => void (f.product.name = 'Ibuprofen tablets'))],
      ['product.strength', family((f) => void (f.product.strength = '400 mg'))],
    ];
    for (const [what, fam] of cases) {
      const pkg = writePackage(sbx, dcMini(), { family: fam, version: { versionId: randomUUID(), number: '7', revision: 3, state: 'APPROVED' } });
      // The server: the parser names the difference; nothing is imported.
      const r = await issuer.call(routes.execution.importPackage, { params: { packageId: pkg.packageHash }, body: {} });
      expect(r.ok, what).toBe(false);
      if (!r.ok && r.error.kind === 'REFUSAL') {
        expect(r.error.envelope.refusal.code, what).toBe('EBMR-EXE-017');
        expect(r.error.envelope.refusal.why, what).toContain(`$.family.${what}`);
      }
      // The database, whatever the server does.
      const direct = await messageOf(importDirect(pkg));
      expect(direct, what).toMatch(/\(DI-04, DI-37\)\. \[EBMR-EXE-134\]$/);
      expect(direct, what).toContain(what === 'familyCode' ? 'the family code IBU400-DC is not the family of the MBR content (PCM500-DC)' : `the product ${what.slice('product.'.length)}`);
      const stored = await sbx.db.admin.query('select 1 from recipe.test_package where package_hash = $1', [pkg.packageHash]);
      expect(stored.rowCount, what).toBe(0);
    }
    // The content's own product name, changed in the content, is the one the package must carry.
    const raw = JSON.parse(JSON.stringify(dcMini())) as { header: { product: { name: string } } };
    raw.header.product.name = 'Paracetamol Tablets IP';
    const parsed = flow.parseMbr(raw);
    if (!parsed.ok) throw new Error('SETUP: the renamed content does not parse');
    const renamed = writePackage(sbx, parsed.mbr, { family: family((f) => void (f.product.name = 'Paracetamol tablets')) });
    expect(await codeOf(importDirect(renamed))).toBe('EBMR-EXE-134');
    // A package that names its content's own family and product is imported (by the server and directly).
    const honest = writePackage(sbx, parsed.mbr);
    expect(await codeOf(importDirect(honest))).toBe('ok');
  }, 300_000);
});
