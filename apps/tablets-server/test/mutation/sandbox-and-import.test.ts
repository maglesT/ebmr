/**
 * The sandbox's own guards and the GMP export of test packages, guard by guard (SQL mutation group
 * "sandbox-and-import", the functions that need a provisioned sandbox or the tablets schema: kernel 0800
 * sandbox.assert_gmp_installation and sandbox.guard_installation in a sandbox, recipe-core 0240 recipe.begin_issue,
 * 0318 recipe.package_header_problem, tablets 0001 tab.mark_demo_installation and tab.is_demo_installation, 0150
 * tab.mbr_test_package_export_guard and tab.record_test_package_export, 0701 tab.register_sandbox_lot). The scenario
 * tests go through the server, whose TypeScript checks most inputs before the database sees them; these tests call
 * the database functions with the application role inside properly attributed commands (or, where a migration says a
 * rule holds whoever inserts, as the table owner would), so each refusal is proven where it is enforced, with its own
 * message, and nothing is written after it.
 *
 * Controls: DI-05 (segregation of non-GMP functions), INV-18 (a GMP record only from a GMP installation), INV-27
 * (identifiers never reused), INV-16 (the trusted database time of the command), DI-34 (operational sequencing),
 * DI-04 and DI-37 (a test package names the family and product of the content its signatures bind; an export is of
 * the current content), DI-27 (trusted time), PR-18 (test lots).
 *
 * Two mutants of tab.record_test_package_export stay alive (the export instant's bounds, > to >= and < to <=): each
 * differs from the original only when the instant given is exactly the database clock's microsecond at the moment
 * of the comparison (or that instant less five minutes), which no caller can know or observe.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import type { VersionView } from '@ebmr/api-contract';
import { asAdmin, copyDatabase, dropDatabase, openDatabase, openPersonaSession, uniqueSuffix } from '@ebmr/test-kit';
import { actorOfBrowser } from '../esig/support.ts';
import { createFamily, startDesignerServer } from '../designer/support.ts';
import { dcMini, importAndIssue, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';

let sbx: ExecServer;
let gmp: TestServer;
beforeAll(async () => {
  [sbx, gmp] = await Promise.all([startExecServer(), startDesignerServer()]);
}, 180_000);
afterAll(async () => {
  await Promise.all([sbx?.close(), gmp?.close()]);
});

/** The message a promise is rejected with, or 'ok'. */
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const hex64 = (): string => randomBytes(32).toString('hex');

let issuerBrowser: TestBrowser | undefined;
/** A command of the sandbox's batch issuer (office PC, BATCH.ISSUE). */
async function issuer(): Promise<ActorContext> {
  issuerBrowser ??= await sbx.asPersona('issuer');
  return actorOfBrowser(sbx, issuerBrowser, 'issuer');
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the installation kind in a sandbox (kernel 0800)', () => {
  it('[DI-05][INV-18] a sandbox refuses every GMP-issuing path with the action named (EBMR-SBX-010), and the GMP-only export writer with it', async () => {
    const refused = (action: string) =>
      `${action} is refused: this is a sandbox installation (TEST, NOT GMP), and test, training and simulation work never creates GMP records (DI-05, INV-18). [EBMR-SBX-010]`;
    expect(await messageOf(sbx.db.app.query("select sandbox.assert_gmp_installation('Batch release')"))).toBe(refused('Batch release'));
    expect(await messageOf(sbx.db.app.query("select sandbox.assert_gmp_installation('  ')"))).toBe(refused('This action'));
    await expect(sbx.db.app.query("select sandbox.assert_sandbox_installation('Seeding a review-by-exception challenge')")).resolves.toBeDefined();
    // A GMP-only writer of the tablets schema, called with the sandbox's application role, refuses before anything else.
    const before = (await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from tab.mbr_test_package_export')).rows[0]?.n;
    const h = hex64();
    expect(
      await messageOf(
        withCommand(sbx.db.app, await issuer(), (c) =>
          c.query('select tab.record_test_package_export($1, 1, $2, $3, $4, 0)', [randomUUID(), hex64(), h, `${h}.json`]),
        ),
      ),
    ).toBe(refused('Exporting an MBR test package'));
    expect((await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from tab.mbr_test_package_export')).rows[0]?.n).toBe(before);
  });

  it('[DI-05][INV-18] a database under a sandbox name can never be marked GMP, even when its marker is gone (EBMR-SBX-004)', async () => {
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query('delete from sandbox.installation');
      await c.query('set local session_replication_role = origin');
      expect(await messageOf(c.query("insert into sandbox.installation (kind, database_name) values ('GMP', 'ebmr_tablets')"))).toBe(
        `Database ${sbx.database} cannot be marked GMP: a sandbox database must be named ebmr_sandbox_<edition>, and no GMP database may use that name (DI-05, INV-18). [EBMR-SBX-004]`,
      );
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect((await sbx.db.app.query<{ kind: string }>('select kernel.installation_kind() as kind')).rows[0]?.kind).toBe('SANDBOX');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('test lots (tablets 0200, 0701)', () => {
  let steward: ActorContext | undefined;
  const register = async (lot: unknown): Promise<string> => {
    steward ??= await openPersonaSession(sbx.db, sbx.seed, 'steward');
    return messageOf(withCommand(sbx.db.app, { ...steward, correlationId: randomUUID() }, (c) => c.query('select tab.register_sandbox_lot($1::jsonb)', [JSON.stringify(lot)])));
  };
  const lots = async (): Promise<string[]> => (await sbx.db.admin.query<{ code: string }>('select lot_code as code from tab.sandbox_lot order by lot_code')).rows.map((r) => r.code);
  const lot = (code: string, extra: Record<string, unknown> = {}) => ({ lotCode: code, materialCode: 'MAT-PCM', materialName: 'Paracetamol', status: 'RELEASED', identityTested: true, ...extra });

  it('[PR-18][DI-05] a test lot without a lot code, or without a yes-or-no identity test, is refused (EBMR-EXE-070) and nothing is registered', async () => {
    const before = await lots();
    const incomplete = 'A test lot needs a lot code, a material, a status and whether it is identity-tested (PR-18). [EBMR-EXE-070]';
    const noIdentityTest: Record<string, unknown> = lot('TEST-L26-0901');
    delete noIdentityTest['identityTested'];
    for (const [what, l] of [
      ['an empty lot code', lot('')],
      ['a blank lot code', lot('   ')],
      ['no lot code', { ...lot('x'), lotCode: undefined }],
      ['no identity test', noIdentityTest],
      ['an identity test that is text', lot('TEST-L26-0902', { identityTested: 'true' })],
      ['an identity test that is null', lot('TEST-L26-0903', { identityTested: null })],
      ['a list instead of a lot', [lot('TEST-L26-0904')]],
    ] as const) {
      expect([what, await register(l)]).toEqual([what, incomplete]);
    }
    expect(await lots()).toEqual(before);
  });

  it('[PR-18] expiry and retest dates are whole epoch microseconds: a negative or fractional value of either alone is refused (EBMR-EXE-070); valid dates are stored as given', async () => {
    const before = await lots();
    const notMicros = 'Expiry and retest dates are epoch microseconds (PR-18). [EBMR-EXE-070]';
    for (const [what, extra] of [
      ['a negative expiry', { expiresAtUs: '-1' }],
      ['a fractional expiry', { expiresAtUs: '1790000000000000.5' }],
      ['a negative retest', { retestAtUs: '-1' }],
      ['a fractional retest', { retestAtUs: '1.5' }],
      ['a valid expiry with a negative retest', { expiresAtUs: '1790000000000000', retestAtUs: '-86400000000' }],
      ['a negative expiry with a valid retest', { expiresAtUs: '-86400000000', retestAtUs: '1790000000000000' }],
    ] as const) {
      expect([what, await register(lot('TEST-L26-0911', extra))]).toEqual([what, notMicros]);
    }
    expect(await lots()).toEqual(before);
    expect(await register(lot('TEST-L26-0911', { expiresAtUs: '1790000000000000', retestAtUs: '1780000000000000' }))).toBe('ok');
    const { rows } = await sbx.db.app.query<{ l: Record<string, unknown> }>("select tab.resolve_lot('TEST-L26-0911') as l");
    expect(rows[0]?.l).toMatchObject({ lotCode: 'TEST-L26-0911', expiresAtUs: '1790000000000000', retestAtUs: '1780000000000000', identityTested: true });
  });

  it('[PR-18][DI-05] a lot is registered once and never changed: registering its code again is refused (EBMR-EXE-071) and the first registration stays', async () => {
    expect(await register(lot('TEST-L26-0921'))).toBe('ok');
    expect(await register(lot('TEST-L26-0921', { status: 'QUARANTINE', identityTested: false }))).toBe(
      'Test lot TEST-L26-0921 is registered already; a lot is never changed, register a new one (PR-18). [EBMR-EXE-071]',
    );
    const { rows } = await sbx.db.admin.query<{ status: string; identity_tested: boolean; n: string }>(
      "select status, identity_tested, count(*) over ()::text as n from tab.sandbox_lot where lot_code = 'TEST-L26-0921'",
    );
    expect(rows).toEqual([{ status: 'RELEASED', identity_tested: true, n: '1' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('test batch numbers (recipe-core 0210, 0240)', () => {
  const seqValue = async (): Promise<string> =>
    (await sbx.db.admin.query<{ v: string }>('select last_value::text as v from recipe.test_batch_number_seq')).rows[0]?.v ?? '';

  it('[INV-27][INV-16][DI-05] within one command a batch keeps the TEST- number and trusted time it was given (dry run and apply see the same); another batch gets a number of its own, and so does the same batch in a later command', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const first = await withCommand(sbx.db.app, await issuer(), async (c) => {
      const a1 = await execution.beginIssue(c, a);
      const a2 = await execution.beginIssue(c, a);
      const b1 = await execution.beginIssue(c, b);
      const a3 = await execution.beginIssue(c, a);
      return { a1, a2, b1, a3 };
    });
    expect(first.a1.batchNumber).toMatch(/^TEST-B\d{2}-\d{4,}$/);
    expect(first.a2).toEqual(first.a1);
    expect(first.a3).toEqual(first.a1);
    expect(first.b1.batchNumber).toMatch(/^TEST-B\d{2}-\d{4,}$/);
    expect(first.b1.batchNumber).not.toBe(first.a1.batchNumber);
    // A later command never reuses a number handed out before (INV-27), for the same batch id or another.
    const later = await withCommand(sbx.db.app, await issuer(), (c) => execution.beginIssue(c, a));
    expect([first.a1.batchNumber, first.b1.batchNumber]).not.toContain(later.batchNumber);
  });

  it('[DI-34][DI-05] a test batch whose id exists already is refused at issue (EBMR-EXE-011) before a number is taken', async () => {
    const runId = await importAndIssue(sbx, issuerBrowser ?? (issuerBrowser = await sbx.asPersona('issuer')), writePackage(sbx, dcMini()));
    const before = await seqValue();
    expect(await messageOf(withCommand(sbx.db.app, await issuer(), (c) => execution.beginIssue(c, runId)))).toBe(
      'A test batch with this id exists already (DI-34). [EBMR-EXE-011]',
    );
    expect(await seqValue()).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('a test package names the family and product of its MBR content (recipe-core 0318)', () => {
  type Json = Record<string, unknown>;
  const stored = async (hash: string): Promise<number> =>
    (await sbx.db.admin.query('select 1 from recipe.test_package where package_hash = $1', [hash])).rowCount ?? 0;
  const refusedFor = (pkg: { packageHash: string }, why: string) =>
    `Test package ${pkg.packageHash.slice(0, 12)} is refused: ${why}. The family and product a test run shows are those of the MBR content its signatures bind (DI-04, DI-37). [EBMR-EXE-134]`;
  /** A package as the GMP designer would export dc-mini, with `edit` applied to the family and content before hashing. */
  const pkgWith = (edit: (family: Json, content: Json) => void): execution.TestPackageV1 => {
    const content = JSON.parse(JSON.stringify(dcMini())) as Json;
    const h = (content['header'] as Json & { product: Json; family: string });
    const family: Json = { familyId: randomUUID(), familyCode: h.family, product: { code: h.product['code'], name: h.product['name'], strength: h.product['strength'] } };
    edit(family, content);
    return execution.buildTestPackage({
      source: { installationKind: 'GMP', watermark: null },
      family: family as execution.TestPackageV1['family'],
      version: { versionId: randomUUID(), number: '1', revision: 1, state: 'APPROVED' },
      content: content as unknown as execution.TestPackageV1['content'],
      justifications: [],
      exporter: { personId: randomUUID(), legalName: 'Asha Rao', loginName: 'asha.rao' },
      exportedAtUs: '1790581503000000',
    });
  };
  const importDirect = async (pkg: execution.TestPackageV1): Promise<string> =>
    messageOf(withCommand(sbx.db.app, await issuer(), (c) => execution.importTestPackage(c, pkg, `${pkg.packageHash}.json`)));

  it('[DI-04][DI-37] a package whose family member has no product object, or whose MBR content has no header product, is refused for that reason (EBMR-EXE-134) and not stored', async () => {
    const cases: [string, execution.TestPackageV1, string][] = [
      ['family product is text', pkgWith((f) => void (f['product'] = 'PCM500')), 'the package names no family and product'],
      ['family without product', pkgWith((f) => void delete f['product']), 'the package names no family and product'],
      ['family product is a list', pkgWith((f) => void (f['product'] = [f['product']])), 'the package names no family and product'],
      ['header product is text', pkgWith((_f, c) => void ((c['header'] as Json)['product'] = 'PCM500')), 'the MBR content has no header product'],
      ['header without product', pkgWith((_f, c) => void delete (c['header'] as Json)['product']), 'the MBR content has no header product'],
    ];
    for (const [what, pkg, why] of cases) {
      expect([what, await importDirect(pkg)]).toEqual([what, refusedFor(pkg, why)]);
      expect([what, await stored(pkg.packageHash)]).toEqual([what, 0]);
    }
    // The same package with its own family and product is imported.
    const honest = pkgWith(() => undefined);
    expect(await importDirect(honest)).toBe('ok');
    expect(await stored(honest.packageHash)).toBe(1);
  });

  it('[DI-04][DI-37] a row whose stored family code or product is not its package\'s and content\'s is refused whoever inserts it (EBMR-EXE-134); the same row with the package\'s own values is stored', async () => {
    const insert = async (pkg: execution.TestPackageV1, familyCode: string, product: Json): Promise<string> => {
      const actor = await issuer();
      return messageOf(
        withCommand(sbx.db.admin, actor, (c) =>
          c.query(
            `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                              revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
             values ($1, $1 || '.json', $2::jsonb, $3::jsonb, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb, $15, $16, $17)`,
            [
              pkg.packageHash, JSON.stringify(pkg), JSON.stringify(pkg.content), pkg.contentHash, pkg.family.familyId, familyCode, JSON.stringify(product),
              pkg.version.versionId, pkg.version.number, pkg.version.revision, pkg.version.state, JSON.stringify(pkg.exporter), pkg.exportedAtUs,
              JSON.stringify(pkg.source), actor.personId, actor.accountId, actor.correlationId,
            ],
          ),
        ),
      );
    };
    const pkg = pkgWith(() => undefined);
    const own = { ...pkg.family.product } as Json;
    const familyRefusal = await insert(pkg, 'IBU400-DC', own);
    expect(familyRefusal).toMatch(/^Test package [0-9a-f]{12} is refused: the family code .* is not the family of the MBR content \(PCM500-DC\)\. .*\(DI-04, DI-37\)\. \[EBMR-EXE-134\]$/);
    for (const [k, v] of [['code', 'IBU400'], ['name', 'Ibuprofen tablets'], ['strength', '400 mg']] as const) {
      // The message names the package's value, not the stored one that differs (reported to the lead); the reason is asserted.
      const m = await insert(pkg, pkg.family.familyCode, { ...own, [k]: v });
      expect([k, m]).toEqual([k, expect.stringMatching(new RegExp(`^Test package ${pkg.packageHash.slice(0, 12)} is refused: the product ${k} .* is not the ${k} of the MBR content \\(.*\\)\\. .*\\[EBMR-EXE-134\\]$`))]);
    }
    expect(await stored(pkg.packageHash)).toBe(0);
    expect(await insert(pkg, pkg.family.familyCode, own)).toBe('ok');
    expect(await stored(pkg.packageHash)).toBe(1);
  });

  it('[DI-04][DI-37] a family code that is not text is refused through the application role (EBMR-EXE-134), even when the package\'s family member and the content header agree, and nothing is stored', async () => {
    // recipe.import_test_package stores the family code as text, which is never the header's number, boolean or null.
    // The reason's wording for this case is reported to the lead (it names the same value on both sides); the refusal is asserted.
    for (const odd of [500, true, null]) {
      const pkg = pkgWith((f, c) => {
        f['familyCode'] = odd;
        (c['header'] as Json)['family'] = odd;
      });
      const m = await importDirect(pkg);
      expect([odd, m]).toEqual([odd, expect.stringMatching(new RegExp(`^Test package ${pkg.packageHash.slice(0, 12)} is refused: the family code .* is not the family of the MBR content \\(.*\\)\\. .*\\(DI-04, DI-37\\)\\. \\[EBMR-EXE-134\\]$`))]);
      expect([odd, await stored(pkg.packageHash)]).toEqual([odd, 0]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('test-package exports from GMP (tablets 0150)', () => {
  let author: TestBrowser;
  let v: VersionView;
  beforeAll(async () => {
    author = await gmp.asPersona('author');
    v = await createFamily(author);
  }, 120_000);

  const exportAs = async (o: { version?: string; revision?: number; contentHash?: string; packageHash?: string; fileName?: string; atUs?: string | null }): Promise<string> => {
    const packageHash = o.packageHash ?? hex64();
    const atUs = o.atUs === undefined ? await nowUs() : o.atUs;
    return messageOf(
      withCommand(gmp.db.app, await actorOfBrowser(gmp, author, 'author'), (c) =>
        c.query('select tab.record_test_package_export($1, $2, $3, $4, $5, $6::bigint)', [
          o.version ?? v.versionId, o.revision ?? v.revision, o.contentHash ?? v.contentHash, packageHash, o.fileName ?? `${packageHash}.json`, atUs,
        ]),
      ),
    );
  };
  const nowUs = async (): Promise<string> => (await gmp.db.app.query<{ us: string }>('select tab.now_micros() as us')).rows[0]?.us ?? '';
  const recorded = async (): Promise<{ package_hash: string; content_revision: number; exported_at_us: string }[]> =>
    (
      await gmp.db.admin.query<{ package_hash: string; content_revision: number; exported_at_us: string }>(
        "select package_hash, content_revision, (extract(epoch from exported_at) * 1000000)::bigint::text as exported_at_us from tab.mbr_test_package_export where version_id = $1 order by exported_at",
        [v.versionId],
      )
    ).rows;
  const exportEntries = async (): Promise<number> =>
    (await gmp.db.admin.query("select 1 from kernel.audit_event where chain_key = $1 and action = 'BUSINESS' and payload -> 'body' ->> 'message' like 'Test package % exported%'", [v.auditChain])).rowCount ?? 0;

  it('[DI-04][DI-05] an export is recorded only of the version\'s current content: another revision or another content hash is refused (EBMR-TAB-160) and nothing is recorded', async () => {
    const stale =
      'The package is not of the version\'s current content (it was saved again meanwhile); export again from the saved revision (DI-04). [EBMR-TAB-160]';
    expect(await exportAs({ revision: v.revision + 1 })).toBe(stale);
    if (v.revision > 0) expect(await exportAs({ revision: v.revision - 1 })).toBe(stale);
    expect(await exportAs({ contentHash: 'f'.repeat(64) })).toBe(stale);
    expect(await recorded()).toEqual([]);
    expect(await exportEntries()).toBe(0);
  });

  it('[DI-05] a test package file is named after its package hash (EBMR-TAB-161), and an unknown MBR version is refused (EBMR-RCP-020); nothing is recorded', async () => {
    expect(await exportAs({ fileName: `${hex64()}.json` })).toBe('A test package file is named after its package hash. [EBMR-TAB-161]');
    const unknown = randomUUID();
    expect(await exportAs({ version: unknown })).toBe(`Unknown MBR version ${unknown} (EBMR-RCP-020)`);
    expect(await recorded()).toEqual([]);
    expect(await exportEntries()).toBe(0);
  });

  it('[DI-27][DI-05] the export instant is the command\'s database time: one in the future, one more than five minutes old, or none is refused (EBMR-TAB-162); the database time is recorded as given', async () => {
    const notClock = 'The export instant must come from this command\'s database clock. [EBMR-TAB-162]';
    const now = BigInt(await nowUs());
    expect(await exportAs({ atUs: (now + 60_000_000n).toString() })).toBe(notClock);
    expect(await exportAs({ atUs: (now + 3_600_000_000n).toString() })).toBe(notClock);
    expect(await exportAs({ atUs: (now - 6n * 60_000_000n).toString() })).toBe(notClock);
    expect(await exportAs({ atUs: '0' })).toBe(notClock);
    expect(await exportAs({ atUs: null })).toBe(notClock);
    expect(await recorded()).toEqual([]);
    expect(await exportEntries()).toBe(0);
    // The honest export: the current content, its hash as the file name and the database time of the command.
    const packageHash = hex64();
    const at = await nowUs();
    expect(await exportAs({ packageHash, atUs: at })).toBe('ok');
    expect(await recorded()).toEqual([{ package_hash: packageHash, content_revision: v.revision, exported_at_us: at }]);
    expect(await exportEntries()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the demo installation marker (tablets 0001, decision D6)', () => {
  const created: string[] = [];
  afterAll(async () => {
    for (const name of created) await dropDatabase(name);
  });
  /** A copy of `template` named `name`, with the connect policy applied; retried while the template's last session closes. */
  const copy = async (template: string, name: string): Promise<string> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await copyDatabase(template, name);
        created.push(name);
        return name;
      } catch (e) {
        if (attempt >= 20 || !/is being accessed by other users/.test(e instanceof Error ? e.message : String(e))) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };
  /** tab.is_demo_installation() as the application role of a GMP database. */
  const isDemo = async (database: string): Promise<boolean | undefined> => {
    const db = openDatabase(database, 'GMP');
    try {
      return (await db.app.query<{ d: boolean }>('select tab.is_demo_installation() as d')).rows[0]?.d;
    } finally {
      await db.close();
    }
  };
  const markers = (database: string) => asAdmin(database, async (c) => (await c.query<{ database_name: string }>('select database_name from tab.demo_installation')).rows);

  it('[DI-05] only a database named as a demo database can be marked (EBMR-TAB-001), and the marker counts only in the demo database it names', async () => {
    const template = inject('serverTemplates').gmp.template;
    const suffix = uniqueSuffix();
    // Not a demo name: the marker is refused and nothing is written.
    const plain = await copy(template, `ebmr_t_${suffix}`);
    expect(await messageOf(asAdmin(plain, (c) => c.query("select tab.mark_demo_installation('kill test')")))).toBe(
      `Database ${plain} is not a demo database (names end in _demo or contain _e2e_); the demo device picker stays off (decision D6). [EBMR-TAB-001]`,
    );
    expect(await markers(plain)).toEqual([]);
    expect(await isDemo(plain)).toBe(false);
    // A demo name without the marker is no demo installation; marked, it is.
    const demo = await copy(template, `ebmr_t_${suffix}_demo`);
    expect(await isDemo(demo)).toBe(false);
    await asAdmin(demo, (c) => c.query("select tab.mark_demo_installation('kill test')"));
    expect(await markers(demo)).toEqual([{ database_name: demo }]);
    expect(await isDemo(demo)).toBe(true);
    // A copy of the marked database under another demo name, or under a plain name, is no demo installation: the
    // marker names the database it was written in.
    const copiedDemo = await copy(demo, `ebmr_t_${suffix}c_demo`);
    const copiedPlain = await copy(demo, `ebmr_t_${suffix}c`);
    expect(await markers(copiedDemo)).toEqual([{ database_name: demo }]);
    expect(await isDemo(copiedDemo)).toBe(false);
    expect(await isDemo(copiedPlain)).toBe(false);
    expect(await isDemo(demo)).toBe(true);
  }, 120_000);
});
