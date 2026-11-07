/**
 * The company formulation library, rule by rule (SQL mutation group "formulas": recipe-core 0640, 0642, 0690). These
 * tests close the gaps the Phase 3 exit SQL mutation run found in apps/tablets-server/test/master-data: each refusal
 * of a malformed formula or version on its own (whole units, 1 to 60 lines, decimal text, flags, basis, one draft at a
 * time, a compensating excipient only with an adjusted active), the state of a version read against its own formula, the readers' answers for
 * the formula named, the signed content of a version, and the row lock of an approval.
 *
 * Every write is made in a command of a seeded person (the application's path); the readers owner-only are called by
 * the superuser.
 *
 * Controls: DI-13, DI-22, DI-35; invariant INV-25.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext } from '../../../kernel/src/db/command.ts';
import { challengeFor, cmd, run, signatureAuth, signWith } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';

let db: TestDatabase;
let steward: SeededActor;
let approver: SeededActor;
let erp: SeededActor;
const STRENGTH = '500 mg';
let serial = 0;
const tag = (): string => `${randomUUID().slice(0, 6).toUpperCase()}${serial++}`;

beforeAll(async () => {
  db = await createTestDatabase();
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Sara Steward' });
  approver = await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Anil Approver' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  for (const [code, kind] of [['F-API', 'API'], ['F-MCC', 'EXCIPIENT'], ['F-MGS', 'EXCIPIENT'], ['F-AID', 'EXCIPIENT']] as const) {
    const id = await run(db, erp, (c) =>
      one<string>(c, 'select site.erp_receive_material($1::jsonb) as r', [JSON.stringify({ materialCode: code, materialName: code, materialKind: kind, unit: 'kg', erpReference: `ERP-${code}` })]),
    );
    await effective('MATERIAL', id);
  }
}, 300_000);
afterAll(async () => {
  await db.drop();
});

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '(not refused)';
}

async function product(): Promise<string> {
  const code = `FP${tag()}`;
  const id = await run(db, erp, (c) =>
    one<string>(c, 'select site.erp_receive_product($1::jsonb) as r', [
      JSON.stringify({ productCode: code, strength: STRENGTH, productName: `Product ${code}`, betaLactam: false, shelfLifeMonths: 36, erpReference: `ERP-${code}` }),
    ]),
  );
  await effective('PRODUCT', id);
  return code;
}

/** QA's signed confirmation of an ERP master version that does not take effect on its own (site services 0802). */
async function effective(kind: 'PRODUCT' | 'MATERIAL', id: string): Promise<void> {
  const state = (await db.app.query<{ s: string }>('select site.erp_master_state($1, $2) as s', [kind, id])).rows[0]?.s;
  if (state !== 'PENDING') return;
  const ch = await challengeFor(db, approver, `${kind}/${id}`, { meaning: 'ERP_MASTER_CONFIRMED', aggregateType: 'erp_master' });
  const ev = await signatureAuth(db, approver, approver, ch.challengeId);
  const sig = (await signWith(db, approver, ch.challengeId, ev, { expectedState: 'PENDING' })).signatureId;
  await run(db, approver, (c) => c.query('select site.confirm_erp_master($1, $2, $3)', [kind, id, sig]));
}

/** `work` as the superuser inside a command of `actor`, always rolled back. */
async function inCommand<T>(actor: SeededActor, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const ctx = await cmd(db, actor);
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

const one = async <T>(c: pg.PoolClient, sql: string, params: unknown[]): Promise<T> => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T;
const createFormula = (p: unknown) => run(db, steward, (c) => one<string>(c, 'select recipe.formula_create($1::jsonb) as r', [JSON.stringify(p)]));
const addVersion = (formula: string, p: unknown) => run(db, steward, (c) => one<string>(c, 'select recipe.formula_add_version($1, $2::jsonb) as r', [formula, JSON.stringify(p)]));

const LINE = { lineId: 'api', materialCode: 'F-API', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '500', potencyAdjusted: false, compensating: false };
const LINES = [LINE, { ...LINE, lineId: 'mcc', materialCode: 'F-MCC', role: 'EXCIPIENT', quantity: '94' }];
const version = (lines: unknown = LINES) => ({ changeReason: 'From the dossier', lines });

async function approve(versionId: string, who: SeededActor = approver): Promise<void> {
  const ch = await challengeFor(db, who, versionId, { meaning: 'FORMULA_APPROVED', aggregateType: 'formula_version' });
  const ev = await signatureAuth(db, who, who, ch.challengeId);
  const sig = (await signWith(db, who, ch.challengeId, ev, { expectedState: 'DRAFT' })).signatureId;
  await run(db, who, (c) => c.query('select recipe.formula_approve($1, $2)', [versionId, sig]));
}

async function newFormula(units = '100000'): Promise<{ id: string; product: string }> {
  const p = await product();
  return { id: await createFormula({ productCode: p, strength: STRENGTH, batchSizeUnits: units }), product: p };
}

describe('a formula and its versions are refused rule by rule', () => {
  it('[INV-25] a formula names a batch size in whole units', async () => {
    const p = await product();
    expect(await refusal(createFormula(['a list']))).toMatch(/whole units.*EBMR-FRM-001/);
    expect(await refusal(createFormula({ productCode: p, strength: STRENGTH, batchSizeUnits: '1.5' }))).toMatch(/EBMR-FRM-001/);
    expect(await refusal(createFormula({ productCode: p, strength: STRENGTH, batchSizeUnits: '0' }))).toMatch(/EBMR-FRM-001/);
    expect(await createFormula({ productCode: p, strength: STRENGTH, batchSizeUnits: '1000' })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[INV-25] a version lists 1 to 60 lines', async () => {
    const f = await newFormula();
    expect(await refusal(addVersion(f.id, version('api')))).toMatch(/1 to 60 lines.*EBMR-FRM-005/);
    expect(await refusal(addVersion(f.id, version([])))).toMatch(/EBMR-FRM-005/);
    const many = Array.from({ length: 61 }, (_, i) => ({ ...LINE, lineId: `l${i}`, materialCode: `F-X${i}` }));
    expect(await refusal(addVersion(f.id, version(many)))).toMatch(/EBMR-FRM-005/);
    // Sixty lines pass the count (the first then fails on its unknown material, a later rule).
    expect(await refusal(addVersion(f.id, version(many.slice(0, 60))))).toMatch(/Line 1: material F-X0 is not in the ERP material master.*EBMR-FRM-008/);
  });

  it('[INV-25] each line: decimal text, an overage and salt factor that are decimal or null, both flags boolean, the basis per unit or per batch', async () => {
    const f = await newFormula();
    const bad = async (over: Record<string, unknown>) => refusal(addVersion(f.id, version([{ ...LINE, ...over }])));
    expect(await bad({ quantity: '1,5' })).toMatch(/Line 1: quantities are decimal text.*EBMR-FRM-007/);
    expect(await bad({ overagePercent: 'two' })).toMatch(/EBMR-FRM-007/);
    expect(await bad({ saltFactor: 'one' })).toMatch(/EBMR-FRM-007/);
    expect(await bad({ potencyAdjusted: 'no' })).toMatch(/EBMR-FRM-007/);
    expect(await bad({ compensating: null })).toMatch(/EBMR-FRM-007/);
    expect(await bad({ basis: 'PER_KG' })).toMatch(/EBMR-FRM-007/);
    // A null overage and a null salt factor are the same as none.
    const id = await addVersion(f.id, version([{ ...LINE, overagePercent: null, saltFactor: null }, LINES[1]]));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-35][INV-25] one draft at a time: a new version follows an approved one; a compensating excipient needs an adjusted active, read in this version only', async () => {
    const f = await newFormula();
    const v1 = await addVersion(f.id, version());
    expect(await refusal(addVersion(f.id, version()))).toMatch(/Version 1 of this formula is still a draft.*EBMR-FRM-006/);
    await approve(v1);
    const adjusted = [
      { ...LINE, potencyAdjusted: true },
      { ...LINE, lineId: 'mcc', materialCode: 'F-MCC', role: 'EXCIPIENT', quantity: '94', compensating: true },
      { ...LINE, lineId: 'mgs', materialCode: 'F-MGS', role: 'EXCIPIENT', quantity: '6' },
    ];
    // Another formula holds a compensating excipient too: only this version's lines count.
    const other = await newFormula();
    await addVersion(other.id, version(adjusted));
    expect(await addVersion(f.id, version(adjusted))).toMatch(/^[0-9a-f-]{36}$/);
    // D-0 sweep (recipe-core 1877): two compensating excipients are allowed; one with no adjusted active in this version
    // is refused, whatever another formula holds.
    const twice = await newFormula();
    const two = [adjusted[0], adjusted[1], { ...adjusted[2], compensating: true }];
    expect(await addVersion(twice.id, version(two))).toMatch(/^[0-9a-f-]{36}$/);
    const none = await newFormula();
    expect(await refusal(addVersion(none.id, version([LINE, adjusted[1], adjusted[2]])))).toMatch(/adjusts none.*EBMR-FRM-011/);
  });
});

describe('what the library answers', () => {
  it('[DI-35] a version is SUPERSEDED only by a later approved version of its own formula', async () => {
    const a = await newFormula();
    const b = await newFormula();
    const a1 = await addVersion(a.id, version());
    await approve(a1);
    const b1 = await addVersion(b.id, version());
    await approve(b1);
    const b2 = await addVersion(b.id, version());
    await approve(b2);
    const state = async (v: string) => (await db.admin.query<{ s: string }>('select recipe.formula_version_state($1) as s', [v])).rows[0]?.s;
    expect([await state(a1), await state(b1), await state(b2)]).toEqual(['APPROVED', 'SUPERSEDED', 'APPROVED']);
  });

  it('[DI-13] the readers answer for the formula named: its own versions; an unknown formula is refused; the composition only when readable', async () => {
    const a = await newFormula();
    const b = await newFormula();
    const a1 = await addVersion(a.id, version());
    await addVersion(b.id, version());
    type Listing = { formulaId: string; compositionReadable: boolean; versions: { versionId: string; lines: unknown }[] }[];
    // recipe.formula_read is owner-only (the server reads through tab.formula_read): the superuser in the steward's command.
    const read = await inCommand(steward, (c) => one<Listing>(c, 'select recipe.formula_read($1) as r', [a.id]));
    expect(read.map((f) => [f.formulaId, f.versions.map((v) => v.versionId)])).toEqual([[a.id, [a1]]]);
    expect(read[0]?.compositionReadable).toBe(true);
    expect(await refusal(inCommand(steward, (c) => c.query('select recipe.formula_read($1)', [randomUUID()])))).toMatch(/There is no formula .*EBMR-FRM-003/);
    const listing = async (readable: boolean | null) => (await db.admin.query<{ r: Listing }>('select recipe.formula_listing($1, $2) as r', [a.id, readable])).rows[0]?.r ?? [];
    expect((await listing(null))[0]).toMatchObject({ compositionReadable: false, versions: [{ versionId: a1, lines: null }] });
    expect((await listing(true))[0]?.versions[0]?.lines).toHaveLength(2);
    expect(await refusal(db.admin.query('select recipe.formula_listing($1, true)', [randomUUID()]))).toMatch(/EBMR-FRM-003/);
  });

  it('[DI-13][INV-25] "Choose a product" takes the approved version, never a later draft', async () => {
    const f = await newFormula('100000');
    const v1 = await addVersion(f.id, version());
    await approve(v1);
    await addVersion(f.id, version([LINE, { ...LINES[1], quantity: '95' }]));
    const choice = await run(db, steward, (c) => one<{ versionId: string }>(c, 'select recipe.formula_choice($1, $2, 100000) as r', [f.product, STRENGTH]));
    expect(choice.versionId).toBe(v1);
  });

  it('[DI-35] the signed content of a version is its own formula\'s; anything else does not exist', async () => {
    const a = await newFormula('2000');
    await newFormula('3000');
    const v = await addVersion(a.id, version());
    const content = async (id: string) => (await db.admin.query<{ c: { exists: boolean; content?: { productCode: string; batchSizeUnits: string } } }>('select recipe.formula_version_content($1) as c', [id])).rows[0]?.c;
    expect(await content(v)).toMatchObject({ exists: true, content: { productCode: a.product, batchSizeUnits: '2000' } });
    expect(await content('not-a-uuid')).toEqual({ exists: false });
    expect(await content(randomUUID())).toEqual({ exists: false });
  });

  it('[DI-35] an MBR check of an unknown MBR or formula version says that it does not exist', async () => {
    const f = await newFormula();
    const v = await addVersion(f.id, version());
    const problem = async (mbr: string, ver: string) => (await db.admin.query<{ p: string }>('select recipe.formula_mbr_problem($1, $2) as p', [mbr, ver])).rows[0]?.p;
    expect(await problem(randomUUID(), v)).toBe('the MBR version or the formula version does not exist');
  });

  it('[DI-35] an approval locks its formula\'s row', async () => {
    const f = await newFormula();
    const v = await addVersion(f.id, version());
    const ch = await challengeFor(db, approver, v, { meaning: 'FORMULA_APPROVED', aggregateType: 'formula_version' });
    const ev = await signatureAuth(db, approver, approver, ch.challengeId);
    const sig = (await signWith(db, approver, ch.challengeId, ev, { expectedState: 'DRAFT' })).signatureId;
    const ctx = await cmd(db, approver);
    const a = await db.admin.connect();
    const b = await db.admin.connect();
    try {
      await a.query('begin');
      await a.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
      await a.query('select recipe.formula_approve($1, $2)', [v, sig]);
      const code = await b.query('select 1 from formulary.formula where id = $1 for no key update nowait', [f.id]).then(
        () => 'free',
        (e: { code?: string }) => e.code,
      );
      expect(code).toBe('55P03');
    } finally {
      await a.query('rollback');
      a.release();
      b.release();
    }
  });
});
