/**
 * The MBR life cycle, rule by rule (SQL mutation group "mbr-lifecycle": recipe-core 0100, 0110, 0120, 0130, 0150,
 * 0180 and 0250). These tests close the gaps the SQL mutation run (tools/sql-mutation) found in the module tests of
 * test/lifecycle:
 *   - refusals no module test reached: malformed batch sizes, content that does not belong to its family, unknown
 *     versions, families, kinds, change records and risk assessments, evidence in the wrong state or of the wrong
 *     shape, and owner-level writers that rewrite a version's identity or skip a step of its creation;
 *   - the exact boundaries of the rules: a review due date on the effective date, a signature at the instant its step
 *     began, a registered bound made inclusive, a market set that is India alone;
 *   - the scope of the row locks (one version's command never waits for another version's);
 *   - the comparisons with the baselines (registered changes, process impact) and what the e-signature content of a
 *     version shows;
 *   - the invariant queries INV-04 and PR-06 on histories forged with triggers off.
 *
 * Controls: PR-01, PR-02, PR-04, PR-05, PR-06, PR-07, DI-04, DI-17, DI-22, DI-37; invariants INV-04, INV-07, INV-28.
 * Owner-level writers (the table owner ebmr_owner inside a command) and forged histories (a superuser with
 * session_replication_role = replica) always run in a transaction that is rolled back.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, type ActorContext } from '../../../kernel/src/db/command.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { canonicalJson, sha256Hex } from '../../src/flow/canonical.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { clone, reason, seedCast, stubEvidence, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
/** An approved granulation master whose market set is India alone (the baseline of the derived versions below). */
let base: lc.VersionRef & { familyId: string };
let baseContent: MbrContent;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  baseContent = uniqueContent('tablet-granulation-compression', ['IN']);
  base = await w.approvedVersion(baseContent);
}, 300_000);

afterAll(async () => {
  await db.drop();
});

const ZERO = '00000000-0000-0000-0000-000000000000';
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(sql, params))[0]?.n ?? -1);
/** The canonical hash the database computes (recipe.json_hash). */
const hashOf = (x: unknown): string => sha256Hex(canonicalJson(x));
const tag = (): string => randomBytes(4).toString('hex');

/** The message `p` is refused with, or '(not refused)' when it is not refused. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '(not refused)';
}

/** An owner-level writer: the table owner inside a command of `actor`, in a transaction that is always rolled back. */
async function asOwner<T>(actor: SeededActor, work: (c: pg.PoolClient) => Promise<T>, extra: Partial<ActorContext> = {}): Promise<T> {
  const ctx = await cmd(db, actor, extra);
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    await c.query('set local role ebmr_owner');
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** A history forged by a superuser with triggers off (`forge`), read back by `read`; everything is rolled back. */
async function forged<T>(forge: (c: pg.PoolClient) => Promise<unknown>, read: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await forge(c);
    await c.query("set local session_replication_role = 'origin'");
    return await read(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** A recipe guard of the mbr_version machine evaluated directly (its reason, or null). */
async function guard(c: Pick<pg.PoolClient, 'query'>, name: string, versionId: string, transition: object = {}, signatureId?: string): Promise<string | null> {
  const { rows } = await c.query<{ r: string | null }>(
    `select recipe.guard_${name}('mbr_version', $1, $2::jsonb, jsonb_build_object('signature_id', $3::text), '{}'::jsonb) as r`,
    [versionId, JSON.stringify(transition), signatureId ?? null],
  );
  return rows[0]?.r ?? null;
}

/** A DRAFT version of a new family (the author's), with its content. */
async function draft(name: Parameters<typeof uniqueContent>[0] = 'tablet-blister-packaging', markets?: string[]) {
  const content = uniqueContent(name, markets);
  const v = await w.newVersion(content);
  return { ...v, content };
}

/**
 * Withdraws, with a reason, every version of `from`'s family still in preparation that an earlier test left open: a
 * family holds one version in preparation at a time (recipe-core 1914, EBMR-RCP-436).
 */
async function closeOpenVersions(from: string): Promise<void> {
  const { rows } = await db.admin.query<{ id: string }>(
    `select v.id from recipe.mbr_version v where v.family_id = (select family_id from recipe.mbr_version where id = $1)
        and recipe.version_state(v.id) in ('DRAFT', 'IN_VERIFICATION', 'SUBMITTED', 'CHECKED')`,
    [from],
  );
  for (const { id } of rows) {
    const s = await w.state(id);
    const who = s.state === 'DRAFT' || s.state === 'IN_VERIFICATION' ? w.cast.author : w.cast.qa;
    await w.run(who, (c) => lc.withdrawVersion(c, id, s.version), reason('left open by an earlier test'));
  }
}

/** A version derived from `from` by the author, with `edit` applied to its content (still in DRAFT). */
async function derived(from: string, edit?: (m: MbrContent) => void) {
  await closeOpenVersions(from);
  const v = await w.run(w.cast.author, (c) => lc.deriveVersion(c, from, 'change under test'));
  const content = (await lc.loadContent(db.app, v.versionId)).content;
  if (edit) {
    edit(content);
    await w.run(w.cast.author, (c) => lc.saveContent(c, v.versionId, content, 'edited for the test'));
  }
  return { ...v, content };
}

const ipAvg = (m: MbrContent) => {
  const r = m.acceptanceSchemes.find((s) => s.id === 'AS-UOW')?.criteria.find((c) => c.id === 'IP-AVG')?.range;
  if (!r?.low || !r.high) throw new Error('fixture changed: AS-UOW/IP-AVG');
  return r as typeof r & { low: NonNullable<typeof r.low>; high: NonNullable<typeof r.high> };
};

// -------------------------------------------------------------------------------------------------------------------
// INV-07: no recipe change outside a command
// -------------------------------------------------------------------------------------------------------------------

describe('every recipe change runs inside a validated command (INV-07)', () => {
  it('[INV-07][DI-22] an owner-level insert made outside a command is refused with EBMR-RCP-001 and nothing is written', async () => {
    const code = `NOCMD-${tag()}`;
    const c = await db.admin.connect();
    let message = '(not refused)';
    try {
      await c.query('begin');
      expect((await c.query<{ a: unknown }>('select kernel.current_actor() as a')).rows[0]?.a).toBeNull();
      await c.query('set local role ebmr_owner');
      await c.query(
        `insert into recipe.mbr_family (code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                        created_by_person, created_by_account)
         values ($1, 'Outside a command', 'tablets', 'PACKAGING', $1, 'Product', '1 mg', 'Tablet', '[{"id": "A", "quantity": {"value": "1", "unit": "kg"}}]', $2, $2)`,
        [code, ZERO],
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect(message).toBe('No validated command: every recipe change runs inside a command started with kernel.begin_command (INV-07; EBMR-RCP-001)');
    expect(await count('select count(*) as n from recipe.mbr_family where code = $1', [code])).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------------------------
// PR-01: a family's approved batch sizes
// -------------------------------------------------------------------------------------------------------------------

describe('the approved batch sizes of a family (PR-01)', () => {
  const size = (id: string, value: string, unit = 'kg', extra: Record<string, unknown> = {}, quantityExtra: Record<string, unknown> = {}) => ({
    id,
    quantity: { value, unit, ...quantityExtra },
    ...extra,
  });

  /** define_family with these batch sizes (the author, a new family code); the family id or the refusal. */
  async function define(batchSizes: unknown): Promise<{ code: string; id?: string; message?: string }> {
    const def = { ...lc.familyOf(uniqueContent()), batchSizes };
    try {
      const id = await w.run(w.cast.author, async (c) => (await c.query<{ r: string }>('select recipe.define_family($1::jsonb) as r', [JSON.stringify(def)])).rows[0]?.r);
      return { code: def.code, ...(id ? { id } : {}) };
    } catch (error) {
      return { code: def.code, message: error instanceof Error ? error.message : String(error) };
    }
  }

  it('[PR-01] a family needs at least one approved batch size: an empty list, an object or a string is refused (EBMR-RCP-011) and no family is written', async () => {
    for (const sizes of [[], {}, 'PO-20K']) {
      const r = await define(sizes);
      expect(r.message, JSON.stringify(sizes)).toBe('A family needs at least one approved batch size (PR-01; EBMR-RCP-011)');
      expect(await count('select count(*) as n from recipe.mbr_family where code = $1', [r.code])).toBe(0);
    }
  });

  it('[PR-01] every batch size is exactly {id, quantity: {value, unit}} with a positive decimal value; anything else is refused (EBMR-RCP-011) and no family is written', async () => {
    const malformed = [
      size(' ', '100'), // blank id
      size('BS-1', '1e3'), // not a decimal literal (although PostgreSQL reads it as 1000)
      size('BS-1', '.5'), // not a decimal literal
      size('BS-1', '0'), // not positive
      size('BS-1', '-5'), // not positive
      size('BS-1', '100', ' '), // blank unit
      size('BS-1', '100', 'kg', { note: 'extra key' }), // a third key on the size
      size('BS-1', '100', 'kg', {}, { basis: 'extra key' }), // a third key on the quantity
      { id: 'BS-1', quantity: '100 kg' }, // the quantity is not an object
    ];
    for (const s of malformed) {
      const r = await define([s]);
      expect(r.message, JSON.stringify(s)).toMatch(/^Batch size \{.*\} is not \{id, quantity: \{value, unit\}\} with a positive decimal value \(PR-01; EBMR-RCP-011\)$/);
      expect(await count('select count(*) as n from recipe.mbr_family where code = $1', [r.code])).toBe(0);
    }
  });

  it('[PR-01] batch-size ids are unique within a family (EBMR-RCP-011); well-formed sizes are stored ordered by id', async () => {
    const twice = await define([size('BS-1', '100'), size('BS-1', '200')]);
    expect(twice.message).toBe('Batch size ids must be unique within a family (PR-01; EBMR-RCP-011)');
    expect(await count('select count(*) as n from recipe.mbr_family where code = $1', [twice.code])).toBe(0);
    const ok = await define([size('BS-2', '200'), size('BS-1', '100.5')]);
    expect(ok.message).toBeUndefined();
    expect((await q<{ b: unknown }>('select batch_sizes as b from recipe.mbr_family where id = $1', [ok.id]))[0]?.b).toEqual([size('BS-1', '100.5'), size('BS-2', '200')]);
  });
});

// -------------------------------------------------------------------------------------------------------------------
// The content of a version: hash and family (DI-04, PR-01, INV-28)
// -------------------------------------------------------------------------------------------------------------------

describe('a content revision belongs to its family and carries its own hash (DI-04, PR-01, INV-28)', () => {
  let v: Awaited<ReturnType<typeof draft>>;
  let familyCode: string;

  beforeAll(async () => {
    v = await draft();
    familyCode = v.content.header.family;
  });

  /** save_content called as the application calls it, with the canonical hash of exactly this content. */
  const save = (content: unknown, hash = hashOf(content)) =>
    w.run(w.cast.author, async (c) => (await c.query<{ r: { revision: number } }>('select recipe.save_content($1, $2::jsonb, $3, $4) as r', [v.versionId, JSON.stringify(content), hash, 'kill test'])).rows[0]?.r);
  const revisions = () => count('select count(*) as n from recipe.mbr_content where version_id = $1', [v.versionId]);
  const edited = (edit: (m: MbrContent & Record<string, unknown>) => void): MbrContent => {
    const m = clone(v.content) as MbrContent & Record<string, unknown>;
    edit(m);
    return m;
  };

  it('[DI-04] a revision whose hash is not the canonical hash the database computes is refused (EBMR-RCP-022) and nothing is saved', async () => {
    const before = await revisions();
    const content = edited((m) => (m.header.title = `${m.header.title} (hash)`));
    expect(await refusal(save(content, 'a'.repeat(64)))).toBe(
      `The content hash ${'a'.repeat(64)} does not match the canonical hash ${hashOf(content)} computed by the database; nothing was saved (DI-04; EBMR-RCP-022)`,
    );
    expect(await revisions()).toBe(before);
  });

  it('[PR-01][INV-28] content that does not belong to the family is refused (EBMR-RCP-023), each reason named, and nothing is saved', async () => {
    const h = v.content.header;
    const cases: [string, MbrContent, string][] = [
      ['other format', edited((m) => (m.format = 'ebmr.other-content' as never)), 'the content is not ebmr.mbr-content format version 1'],
      ['other format version', edited((m) => (m.formatVersion = '2' as never)), 'the content is not ebmr.mbr-content format version 1'],
      ['other edition', edited((m) => (m.header.edition = 'injectables' as never)), `the header edition and record kind (injectables, ${h.recordKind}) differ from the family (tablets, ${h.recordKind})`],
      ['other record kind', edited((m) => (m.header.recordKind = 'PROCESSING')), `the header edition and record kind (tablets, PROCESSING) differ from the family (tablets, ${h.recordKind})`],
      ['other product code', edited((m) => (m.header.product.code = `${h.product.code}-X`)),
        `the header product (${h.product.code}-X, ${h.product.strength}, ${h.product.dosageForm}) differs from the family (${h.product.code}, ${h.product.strength}, ${h.product.dosageForm})`],
      ['other strength', edited((m) => (m.header.product.strength = '20 mg')),
        `the header product (${h.product.code}, 20 mg, ${h.product.dosageForm}) differs from the family (${h.product.code}, ${h.product.strength}, ${h.product.dosageForm})`],
      ['other dosage form', edited((m) => (m.header.product.dosageForm = 'Capsule')),
        `the header product (${h.product.code}, ${h.product.strength}, Capsule) differs from the family (${h.product.code}, ${h.product.strength}, ${h.product.dosageForm})`],
      ['no batch sizes', edited((m) => delete (m.header as Partial<MbrContent['header']>).batchSizes), 'the header batch sizes are not valid'],
      ['a market code that is not two capital letters', edited((m) => (m.header.marketSet = ['IN', 'usa'])), 'the market set must list distinct two-letter market codes'],
      ['a market listed twice', edited((m) => (m.header.marketSet = ['IN', 'IN'])), 'the market set must list distinct two-letter market codes'],
      ['no India', edited((m) => (m.header.marketSet = ['US'])), 'India (IN) must be in every market set (INV-28)'],
    ];
    const before = await revisions();
    for (const [what, content, problem] of cases) {
      expect(await refusal(save(content)), what).toBe(`The content does not belong to family ${familyCode}: ${problem} (EBMR-RCP-023)`);
    }
    expect(await revisions()).toBe(before);
    // India alone is a market set.
    const india = edited((m) => (m.header.marketSet = ['IN']));
    expect((await save(india))?.revision).toBe(before + 1);
    expect((await lc.loadContent(db.app, v.versionId)).content.header.marketSet).toEqual(['IN']);
  });
});

// -------------------------------------------------------------------------------------------------------------------
// Unknown objects (DI-17: the permission is checked in the object's own scope)
// -------------------------------------------------------------------------------------------------------------------

describe('a command on an unknown family or version is refused as unknown (DI-17)', () => {
  it('[DI-17][PR-06] every command names the unknown family or version (EBMR-RCP-010, -020) before it checks a permission, a reason or a kind, and writes nothing', async () => {
    const ra = await w.riskAssessment();
    const unknown = randomUUID();
    const versions = await count('select count(*) as n from recipe.mbr_version');
    const author = w.cast.author;
    expect(await refusal(w.run(author, (c) => lc.createVersion(c, unknown, uniqueContent())))).toBe(`Unknown MBR family ${unknown} (EBMR-RCP-010)`);
    const unknownVersion = `Unknown MBR version ${unknown} (EBMR-RCP-020)`;
    expect(await refusal(w.run(author, (c) => lc.deriveVersion(c, unknown, 'a reason')))).toBe(unknownVersion);
    expect(await refusal(w.run(author, (c) => lc.setDraftAttributes(c, unknown, { reviewDue: '2028-01-31' }), reason('review date')))).toBe(unknownVersion);
    expect(await refusal(w.run(author, (c) => lc.linkRiskAssessment(c, unknown, ra)))).toBe(unknownVersion);
    expect(await refusal(w.run(author, (c) => lc.unlinkRiskAssessment(c, unknown, ra)))).toBe(unknownVersion);
    // Before the kind of evidence is looked at.
    expect(await refusal(w.run(author, (c) => c.query("select recipe.record_evidence($1, 'BOGUS', '{}'::jsonb)", [unknown])))).toBe(unknownVersion);
    // Before the permission: an unknown version has no product scope to evaluate MBR.AUTHOR in, so a person without it
    // is told the version is unknown, not evaluated installation-wide.
    const content = uniqueContent();
    expect(await refusal(w.run(w.cast.checker, (c) => c.query('select recipe.save_content($1, $2::jsonb, $3)', [unknown, JSON.stringify(content), hashOf(content)])))).toBe(unknownVersion);
    expect(await refusal(w.run(w.cast.checker, (c) => lc.recordEvidence(c, unknown, 'VALIDATOR', stubEvidence(content, author.personId).validator)))).toBe(unknownVersion);
    expect(await count('select count(*) as n from recipe.mbr_version')).toBe(versions);
    expect(await count('select count(*) as n from recipe.mbr_risk_link where risk_assessment_id = $1', [ra])).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------------------------
// Draft attributes, risk links and change records (PR-06, PR-07)
// -------------------------------------------------------------------------------------------------------------------

describe('draft attributes, risk links and change records (PR-06, PR-07)', () => {
  it('[PR-06] only the change record, effective date and review due date are draft attributes (EBMR-RCP-028); an unknown change record is refused (EBMR-RCP-060); nothing changes', async () => {
    const v = await draft();
    const set = (attrs: Record<string, unknown>) => w.run(w.cast.author, (c) => c.query('select recipe.set_draft_attributes($1, $2::jsonb)', [v.versionId, JSON.stringify(attrs)]), reason('draft attributes'));
    const row = () => q('select change_record_id, effective_from, review_due from recipe.mbr_version where id = $1', [v.versionId]);
    const before = await row();
    expect(await refusal(set({ reviewDue: '2028-01-31', author: w.cast.coAuthor.personId }))).toBe('author is not a draft attribute of an MBR version (EBMR-RCP-028)');
    const unknown = randomUUID();
    expect(await refusal(set({ changeRecordId: unknown }))).toBe(`Unknown change record ${unknown} (PR-06; EBMR-RCP-060)`);
    expect(await row()).toEqual(before);
  });

  it('[PR-06] a change record is unlinked by setting it to null: the version has none and the version log records the change', async () => {
    const v = await draft();
    const cr = await w.changeRecord();
    await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v.versionId, { changeRecordId: cr }), reason('change record linked'));
    await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v.versionId, { changeRecordId: null }), reason('change record unlinked'));
    expect((await q<{ c: string | null }>('select change_record_id as c from recipe.mbr_version where id = $1', [v.versionId]))[0]?.c).toBeNull();
    expect(await q("select detail from recipe.mbr_version_log where version_id = $1 and kind = 'CHANGE_RECORD' order by id", [v.versionId])).toEqual([
      { detail: { old: null, new: cr } },
      { detail: { old: cr, new: null } },
    ]);
  });

  it('[PR-07] a risk link names a recorded assessment (EBMR-RCP-061) and subjects that are ids; only a linked assessment is unlinked; nothing is written by a refusal', async () => {
    const v = await draft();
    const ra = await w.riskAssessment();
    const links = () => count('select count(*) as n from recipe.mbr_risk_link where version_id = $1', [v.versionId]);
    const unknown = randomUUID();
    expect(await refusal(w.run(w.cast.author, (c) => lc.linkRiskAssessment(c, v.versionId, unknown)))).toBe(`Unknown risk assessment ${unknown} (PR-07; EBMR-RCP-061)`);
    for (const subjects of [[''], ['  '], ['sealTemp', ' ']]) {
      expect(await refusal(w.run(w.cast.author, (c) => lc.linkRiskAssessment(c, v.versionId, ra, subjects))), JSON.stringify(subjects)).toBe(
        'Risk-assessment subjects are parameter or calculation ids (PR-07; EBMR-RCP-061)',
      );
    }
    expect(await refusal(w.run(w.cast.author, (c) => lc.unlinkRiskAssessment(c, v.versionId, ra)))).toBe('That risk assessment is not linked to this version (PR-07; EBMR-RCP-061)');
    expect(await links()).toBe(0);
    // Linked with its subjects (stored sorted, without duplicates), then unlinked: no link remains.
    await w.run(w.cast.author, (c) => lc.linkRiskAssessment(c, v.versionId, ra, ['sealTemp', 'leakResult', 'sealTemp']));
    expect(await q('select subjects from recipe.current_risk_links($1)', [v.versionId])).toEqual([{ subjects: ['leakResult', 'sealTemp'] }]);
    await w.run(w.cast.author, (c) => lc.unlinkRiskAssessment(c, v.versionId, ra));
    expect(await q('select * from recipe.current_risk_links($1)', [v.versionId])).toEqual([]);
    expect(await links()).toBe(2);
  });

  it('[PR-06] a change record states whether the change affects the process, as true or false (EBMR-RCP-060); without it nothing is recorded', async () => {
    for (const impacting of [undefined, 'yes', null]) {
      const number = `CC-${tag()}`;
      const def = { number, title: 'Change without impact statement', changeClass: 'MAJOR', ...(impacting === undefined ? {} : { processImpacting: impacting }) };
      expect(await refusal(w.run(w.cast.qa, (c) => c.query('select recipe.record_change_record($1::jsonb)', [JSON.stringify(def)]))), String(impacting)).toBe(
        'A change record states whether the change affects the process (PR-06; EBMR-RCP-060)',
      );
      expect(await count('select count(*) as n from recipe.change_record where number = $1', [number])).toBe(0);
    }
  });
});

// -------------------------------------------------------------------------------------------------------------------
// Versions: the first version and derived versions (PR-06)
// -------------------------------------------------------------------------------------------------------------------

describe('first versions and derived versions (PR-06)', () => {
  it('[PR-06] a family none of whose versions was ever approved takes another first version; only an approved version anywhere in its family stops that', async () => {
    const content = uniqueContent();
    const v1 = await w.newVersion(content);
    await w.prepare(v1.versionId, content);
    await w.startVerification(v1.versionId);
    // v1 has a history (DRAFT, IN_VERIFICATION) and other masters are approved, but no version of this family was.
    expect(await count("select count(*) as n from platform.state_history where aggregate_type = 'mbr_version' and to_state = 'APPROVED'")).toBeGreaterThan(0);
    // While v1 is in preparation the family takes no other version (recipe-core 1914); withdrawn, it is not in the way.
    expect(await refusal(w.run(w.cast.author, (c) => lc.createVersion(c, v1.familyId, content, 'second draft')))).toMatch(/EBMR-RCP-436/);
    await closeOpenVersions(v1.versionId);
    const v2 = await w.run(w.cast.author, (c) => lc.createVersion(c, v1.familyId, content, 'second draft'));
    expect(v2).toMatchObject({ versionNumber: 2, state: 'DRAFT' });
    expect(await q('select version_number, derived_from from recipe.mbr_version where family_id = $1 order by version_number', [v1.familyId])).toEqual([
      { version_number: 1, derived_from: null },
      { version_number: 2, derived_from: null },
    ]);
  });

  it('[PR-06] a new version is derived only with a reason, and only from a version that was approved and is APPROVED or RETIRED (EBMR-RCP-027); nothing is created otherwise', async () => {
    const versionsOf = (familyId: string) => count('select count(*) as n from recipe.mbr_version where family_id = $1', [familyId]);
    // No reason.
    const n = await versionsOf(base.familyId);
    for (const why of ['', '   ']) {
      expect(await refusal(w.run(w.cast.author, (c) => lc.deriveVersion(c, base.versionId, why)))).toBe('A new version states why it is needed (PR-06; EBMR-RCP-027)');
    }
    expect(await versionsOf(base.familyId)).toBe(n);
    // Never approved.
    const d = await draft();
    expect(await refusal(w.run(w.cast.author, (c) => lc.deriveVersion(c, d.versionId, 'a reason')))).toBe(
      'Version 1 is DRAFT: a new version is derived only from an approved master (PR-06; EBMR-RCP-027)',
    );
    expect(await versionsOf(d.familyId)).toBe(1);
    // Approved once, then withdrawn: no longer a master to derive from.
    const withdrawn = await w.approvedVersion(uniqueContent());
    const s = await w.state(withdrawn.versionId);
    await w.run(w.cast.qa, (c) => lc.withdrawVersion(c, withdrawn.versionId, s.version), reason('product dropped before launch'));
    expect((await w.state(withdrawn.versionId)).state).toBe('WITHDRAWN');
    expect(await refusal(w.run(w.cast.author, (c) => lc.deriveVersion(c, withdrawn.versionId, 'a reason')))).toBe(
      'Version 1 is WITHDRAWN: a new version is derived only from an approved master (PR-06; EBMR-RCP-027)',
    );
    expect(await versionsOf(withdrawn.familyId)).toBe(1);
  }, 120_000);
});

// -------------------------------------------------------------------------------------------------------------------
// Owner-level writers: the table guards hold for every writer
// -------------------------------------------------------------------------------------------------------------------

describe('the table guards of the MBR version, content, draft cycle and evidence hold for owner-level writers', () => {
  it('[PR-05][INV-04] the identity of a version (id, family, number, author, predecessor) never changes, whichever column is rewritten (EBMR-RCP-024)', async () => {
    const v = await draft();
    const other = await draft();
    const sets: [string, unknown[]][] = [
      ['id = $2', [randomUUID()]],
      ['family_id = $2', [other.familyId]],
      ['version_number = 99', []],
      ['author_person = $2', [w.cast.coAuthor.personId]],
      ['author_account = $2', [w.cast.coAuthor.accountId]],
      ['derived_from = $2', [base.versionId]],
    ];
    for (const [set, params] of sets) {
      expect(await refusal(asOwner(w.cast.author, (c) => c.query(`update recipe.mbr_version set ${set} where id = $1`, [v.versionId, ...params]), reason('identity rewrite'))), set).toBe(
        'The identity of an MBR version (family, number, author, predecessor) never changes (PR-05; EBMR-RCP-024)',
      );
    }
    // A draft attribute is not identity: the same writer may change it while the version is in DRAFT.
    expect(await asOwner(w.cast.author, async (c) => (await c.query("update recipe.mbr_version set review_due = '2029-01-31' where id = $1", [v.versionId])).rowCount, reason('review date'))).toBe(1);
  });

  it('[DI-04][PR-06] content is written only for a known version, and a version under creation has exactly one initial revision (EBMR-RCP-020)', async () => {
    const d = await draft();
    const insertContent = (c: pg.PoolClient, versionId: string, content: MbrContent) =>
      c.query('insert into recipe.mbr_content (version_id, revision, content, content_hash, edited_by_person, edited_by_account) values ($1, 1, $2::jsonb, $3, $4, $4)', [
        versionId,
        JSON.stringify(content),
        hashOf(content),
        ZERO,
      ]);
    const unknown = randomUUID();
    expect(await refusal(asOwner(w.cast.author, (c) => insertContent(c, unknown, d.content)))).toBe(`Unknown MBR version ${unknown} (EBMR-RCP-020)`);
    // A version row without a state row is under creation (recipe.insert_version writes both in one command).
    const second = await refusal(
      asOwner(w.cast.author, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          'insert into recipe.mbr_version (family_id, version_number, author_person, author_account) values ($1, 2, $2, $2) returning id',
          [d.familyId, ZERO],
        );
        const id = rows[0]?.id ?? '';
        await insertContent(c, id, d.content);
        expect((await c.query('select revision from recipe.mbr_content where version_id = $1', [id])).rows).toEqual([{ revision: 1 }]);
        await insertContent(c, id, d.content);
      }),
    );
    expect(second).toBe('A version under creation has exactly one initial content revision (EBMR-RCP-020)');
  });

  it('[DI-37][INV-04] a return to DRAFT names the state it returns from (EBMR-RCP-026), whoever writes the new draft cycle', async () => {
    const d = await draft();
    expect(
      await refusal(
        asOwner(w.cast.author, (c) =>
          c.query('insert into recipe.mbr_draft_entry (version_id, cycle, person_id, account_id, xact_id) values ($1, 0, $2, $2, 0)', [d.versionId, ZERO]),
        ),
      ),
    ).toBe('A return to DRAFT names the state it returns from (EBMR-RCP-026)');
    expect(await q('select cycle, from_state from recipe.mbr_draft_entry where version_id = $1', [d.versionId])).toEqual([{ cycle: 1, from_state: null }]);
  });

  it('[DI-04] evidence is written only for a known version (EBMR-RCP-020), whoever writes it', async () => {
    const unknown = randomUUID();
    expect(
      await refusal(
        asOwner(w.cast.author, (c) =>
          c.query(
            `insert into recipe.mbr_evidence (version_id, content_hash, kind, result, tool_version, report, report_hash, person_id, account_id)
             values ($1, repeat('0', 64), 'VALIDATOR', 'FAIL', '', '{}'::jsonb, repeat('0', 64), $2, $2)`,
            [unknown, ZERO],
          ),
        ),
      ),
    ).toBe(`Unknown MBR version ${unknown} (EBMR-RCP-020)`);
  });
});

// -------------------------------------------------------------------------------------------------------------------
// Verification evidence (DI-04)
// -------------------------------------------------------------------------------------------------------------------

describe('verification evidence: the database decides what it is and whether it passes (DI-04)', () => {
  const record = (versionId: string, kind: string, report: unknown, actor: SeededActor = w.cast.author) =>
    w.run(actor, (c) => lc.recordEvidence(c, versionId, kind as lc.EvidenceKind, report));
  const evidenceOf = (versionId: string) => count('select count(*) as n from recipe.mbr_evidence where version_id = $1', [versionId]);

  it('[DI-04] an unknown kind, a verification that is neither FULL nor DELTA and a sandbox run without its run id are refused (EBMR-RCP-041); nothing is recorded', async () => {
    const d = await draft();
    const e = stubEvidence(d.content, w.cast.author.personId);
    expect(await refusal(record(d.versionId, 'BOGUS', e.validator))).toBe(
      'Unknown kind of verification evidence BOGUS: VALIDATOR, VERIFICATION, TEST_VECTORS or SANDBOX_RUN (DI-04; EBMR-RCP-041)',
    );
    const { kind: _kind, ...noKind } = e.verification;
    void _kind;
    for (const report of [{ ...e.verification, kind: 'PARTIAL' }, noKind]) {
      expect(await refusal(record(d.versionId, 'VERIFICATION', report))).toBe('Verification evidence must be FULL or DELTA (outline 6.5; EBMR-RCP-041)');
    }
    const { runId: _runId, ...noRun } = e.sandbox;
    void _runId;
    for (const report of [noRun, { ...e.sandbox, runId: '  ' }]) {
      expect(await refusal(record(d.versionId, 'SANDBOX_RUN', report))).toBe('A sandbox run is cited by its run id (outline 6.5; EBMR-RCP-041)');
    }
    expect(await evidenceOf(d.versionId)).toBe(0);
  });

  it('[DI-04][PR-02] evidence is recorded only in DRAFT or IN_VERIFICATION (EBMR-RCP-040): not once the version is submitted or approved', async () => {
    const d = await draft();
    await w.prepare(d.versionId, d.content);
    await w.startVerification(d.versionId);
    await w.submit(d.versionId);
    const before = await evidenceOf(d.versionId);
    const e = stubEvidence(d.content, w.cast.author.personId);
    expect(await refusal(record(d.versionId, 'SANDBOX_RUN', e.sandbox))).toBe(
      'Verification evidence is recorded only in DRAFT or IN_VERIFICATION; this version is SUBMITTED (DI-04; EBMR-RCP-040)',
    );
    expect(await refusal(record(base.versionId, 'VALIDATOR', stubEvidence(baseContent, w.cast.author.personId).validator))).toBe(
      'Verification evidence is recorded only in DRAFT or IN_VERIFICATION; this version is APPROVED (DI-04; EBMR-RCP-040)',
    );
    expect(await evidenceOf(d.versionId)).toBe(before);
  });

  it('[DI-04][PR-02] a validator report passes only with a findings list, zero errors and every warning justified for its own key, with a text and a person', async () => {
    const d = await draft();
    const validation = stubEvidence(d.content, w.cast.author.personId).validator.validation;
    const warning = { key: 'W-1', rule: 'TEST-RULE', severity: 'WARNING', path: '/header', message: 'a warning' };
    const justified = (justifications: unknown[]) => ({ validation: { ...validation, findings: [warning], warnings: 1 }, justifications });
    const { findings: _f, ...noFindings } = validation;
    void _f;
    const cases: [string, unknown, 'PASS' | 'FAIL', string[]][] = [
      ['no findings list', { validation: noFindings, justifications: [] }, 'FAIL', ['the report has no validator findings list']],
      ['a justification of another warning', justified([{ key: 'W-2', text: 'accepted', by: 'Asha Author' }]), 'FAIL', ['warnings without a recorded justification: W-1']],
      ['a justification without a text', justified([{ key: 'W-1', text: ' ', by: 'Asha Author' }]), 'FAIL', ['warnings without a recorded justification: W-1']],
      ['a justification without a person', justified([{ key: 'W-1', text: 'accepted', by: '' }]), 'FAIL', ['warnings without a recorded justification: W-1']],
      ['the warning justified', justified([{ key: 'W-1', text: 'accepted', by: 'Asha Author' }]), 'PASS', []],
    ];
    for (const [what, report, result, problems] of cases) {
      expect(await record(d.versionId, 'VALIDATOR', report), what).toMatchObject({ kind: 'VALIDATOR', result, problems });
    }
  });

  it('[DI-04] author-confirmed test vectors pass only when the golden cases are a list and every one passes', async () => {
    const d = await draft();
    const tv = stubEvidence(d.content, w.cast.author.personId).testVectors;
    const { goldenCases: _g, ...noCases } = tv;
    void _g;
    const cases: [string, unknown, 'PASS' | 'FAIL', string[]][] = [
      ['a failing golden case', { ...tv, goldenCases: [{ id: 'G-1/calc', status: 'PASS' }, { id: 'G-2/calc', status: 'FAIL' }] }, 'FAIL', ['not every golden case passes']],
      ['no golden cases list', noCases, 'FAIL', ['not every golden case passes']],
      ['every golden case passes', tv, 'PASS', []],
    ];
    for (const [what, report, result, problems] of cases) {
      expect(await record(d.versionId, 'TEST_VECTORS', report), what).toMatchObject({ kind: 'TEST_VECTORS', result, problems });
    }
  });

  it('[DI-04] a delta verification builds on the verified evidence of the approved predecessor it cites, by content hash and evidence hash', async () => {
    const v = await derived(base.versionId, (m) => (m.header.title = `${m.header.title} (delta)`));
    const basisHash = (await q<{ h: string }>("select report ->> 'evidenceHash' as h from recipe.mbr_evidence where version_id = $1 and kind = 'VERIFICATION' and result = 'PASS'", [base.versionId]))[0]?.h ?? '';
    expect(basisHash).toMatch(/^[0-9a-f]{64}$/);
    const full = stubEvidence(v.content, w.cast.author.personId).verification;
    const delta = (evidenceHash: string) => {
      const { evidenceHash: _e, ...sealed } = full;
      void _e;
      const report = { ...sealed, kind: 'DELTA', basis: { contentHash: base.contentHash, evidenceHash } };
      return { ...report, evidenceHash: hashOf(report) };
    };
    expect(await record(v.versionId, 'VERIFICATION', delta('f'.repeat(64)))).toMatchObject({
      mode: 'DELTA',
      result: 'FAIL',
      problems: ['the predecessor has no verified evidence with the cited evidence hash'],
    });
    expect(await record(v.versionId, 'VERIFICATION', delta(basisHash))).toMatchObject({ mode: 'DELTA', result: 'PASS', problems: [] });
  });
});

// -------------------------------------------------------------------------------------------------------------------
// Row locks: per version
// -------------------------------------------------------------------------------------------------------------------

describe('a command on one version never waits for a command on another (decision 0003)', () => {
  /** Holds a content revision of `versionId` open on its own connection (the co-author's command) while `work` runs. */
  async function whileHeld<T>(versionId: string, content: MbrContent, work: () => Promise<T>): Promise<T> {
    const c = await db.app.connect();
    try {
      await c.query('begin');
      const ctx = await cmd(db, w.cast.coAuthor);
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
      const held = clone(content);
      held.header.title = `${held.header.title} (held)`;
      await lc.saveContent(c, versionId, held, 'held open');
      return await work();
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  it('[PR-07][PR-06] a risk link of one version is recorded while another version\'s content revision is still open', async () => {
    const held = await draft();
    const v = await draft();
    const ra = await w.riskAssessment();
    await whileHeld(held.versionId, held.content, () =>
      w.run(w.cast.author, async (c) => {
        await c.query("set local lock_timeout = '2s'");
        await lc.linkRiskAssessment(c, v.versionId, ra);
      }),
    );
    expect(await q('select risk_assessment_id from recipe.current_risk_links($1)', [v.versionId])).toEqual([{ risk_assessment_id: ra }]);
  });

  it('[DI-37][INV-04] a return to DRAFT of one version is recorded while another version\'s content revision is still open', async () => {
    const held = await draft();
    const v = await draft();
    await w.prepare(v.versionId, v.content);
    await w.startVerification(v.versionId);
    const s = await w.state(v.versionId);
    await whileHeld(held.versionId, held.content, () =>
      w.run(
        w.cast.author,
        async (c) => {
          await c.query("set local lock_timeout = '2s'");
          await lc.returnToDraft(c, v.versionId, s.version);
        },
        reason('rework while another master is edited'),
      ),
    );
    expect((await w.state(v.versionId)).state).toBe('DRAFT');
    expect(await q('select cycle, from_state from recipe.mbr_draft_entry where version_id = $1 order by cycle', [v.versionId])).toEqual([
      { cycle: 1, from_state: null },
      { cycle: 2, from_state: 'IN_VERIFICATION' },
    ]);
  });
});

// -------------------------------------------------------------------------------------------------------------------
// Guards of the version machine at their boundaries (PR-02, PR-04, PR-05, INV-04)
// -------------------------------------------------------------------------------------------------------------------

describe('the guards of the version machine, on the version they are asked about', () => {
  it('[INV-04][PR-02] the author of this version cannot check or approve it, whoever authored other versions', async () => {
    // An author of exactly one version, who also holds the checker and QA roles.
    const own = await seedActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'Omkar Own-author' });
    const content = uniqueContent();
    const v = await w.newVersion(content, own);
    const signature = await w.sign(own, 'mbr_version', v.versionId, 'PREPARED', 'DRAFT');
    expect(await guard(db.admin, 'checker_independent', v.versionId, {}, signature)).toBe('the author cannot check their own MBR version: the check is independent (INV-04; PR-02)');
    expect(await guard(db.admin, 'approver_independent', v.versionId, {}, signature)).toBe('the author cannot approve their own MBR version (INV-04; PR-02)');
  });

  it('[PR-05] the periodic-review due date is after the effective date in the site zone: the same day is refused, the next day accepted', async () => {
    const d = await draft();
    const due = async (effectiveFrom: string, reviewDue: string) => {
      await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, d.versionId, { effectiveFrom, reviewDue }), reason('dates under test'));
      return guard(db.admin, 'review_due_set', d.versionId);
    };
    expect(await due('2026-06-01T00:00:00Z', '2026-06-01')).toBe('the periodic-review due date 2026-06-01 is not after the effective date (PR-05)');
    // 20:00 UTC on 31 May is 1 June in the site zone (Asia/Kolkata).
    expect(await due('2026-05-31T20:00:00Z', '2026-06-01')).toBe('the periodic-review due date 2026-06-01 is not after the effective date (PR-05)');
    expect(await due('2026-06-01T00:00:00Z', '2026-06-02')).toBeNull();
  });

  it('[PR-02][INV-04] a signature applied at the very instant the version entered the from-state is not ahead of its step; one applied a microsecond earlier is', async () => {
    const d = await draft();
    await w.prepare(d.versionId, d.content);
    await w.startVerification(d.versionId);
    await w.submit(d.versionId);
    const sig = await w.signVersion(w.cast.checker, d.versionId, 'CHECKED', 'SUBMITTED');
    const transition = { from: 'SUBMITTED', event: 'CHECK' };
    expect(await guard(db.admin, 'signed_in_state', d.versionId, transition, sig)).toBeNull();
    const entryAt = (offset: string) => (c: pg.PoolClient) =>
      c.query(
        `update platform.state_history set recorded_at = (select s.recorded_at from esig.signature s where s.id = $2) + $3::interval
          where aggregate_type = 'mbr_version' and aggregate_id = $1 and to_state = 'SUBMITTED'`,
        [d.versionId, sig, offset],
      );
    expect(await forged(entryAt('0'), (c) => guard(c, 'signed_in_state', d.versionId, transition, sig))).toBeNull();
    expect(await forged(entryAt('1 microsecond'), (c) => guard(c, 'signed_in_state', d.versionId, transition, sig))).toBe(
      'the CHECK signature was applied before the version entered SUBMITTED; it must be signed at that step (PR-02; INV-04)',
    );
  });

  it('[PR-04] a registered element that changed needs a regulatory assessment for each market of the version, for that market', async () => {
    // The base master's market set is India alone.
    const v = await derived(base.versionId, (m) => (ipAvg(m).high.value = '260.0'));
    const cr = await w.changeRecord();
    await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v.versionId, { changeRecordId: cr }), reason('change record linked'));
    expect(await guard(db.admin, 'registered_ranges_kept', v.versionId)).toBe(
      'registered elements changed without the regulatory action each market needs: AS-UOW/IP-AVG: registered range changed from [237.5, 262.5] to [237.5, 260.0] without a regulatory assessment for market IN (PR-04)',
    );
    await w.run(w.cast.regulatory, (c) => lc.addChangeRegulatory(c, cr, 'IN', 'NOTIFICATION'));
    expect(await guard(db.admin, 'registered_ranges_kept', v.versionId)).toBeNull();
  });

  it('[PR-04] a registered range whose unit alone changed is a widening: an assessment without a variation, supplement or approval reference does not let it through', async () => {
    // Same bounds, same inclusive flags: only the unit of AS-UOW/IP-AVG moves from mg to g.
    const v = await derived(base.versionId, (m) => {
      const c = m.acceptanceSchemes.find((s) => s.id === 'AS-UOW')?.criteria.find((x) => x.id === 'IP-AVG');
      if (c?.unit !== 'mg') throw new Error('fixture changed: AS-UOW/IP-AVG unit');
      c.unit = 'g';
    });
    const cr = await w.changeRecord();
    await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v.versionId, { changeRecordId: cr }), reason('change record linked'));
    // A widened change names the stricter action it lacks, with or without an assessment.
    const refusalText =
      'registered elements changed without the regulatory action each market needs: AS-UOW/IP-AVG: registered range unit changed from mg to g without a variation, supplement or approval reference for market IN (PR-04)';
    expect(await guard(db.admin, 'registered_ranges_kept', v.versionId)).toBe(refusalText);
    await w.run(w.cast.regulatory, (c) => lc.addChangeRegulatory(c, cr, 'IN', 'NOTIFICATION'));
    expect(await guard(db.admin, 'registered_ranges_kept', v.versionId)).toBe(refusalText);
  });

  it('[PR-04] a unit-only registered change is let through once the assessment for the market carries its reference', async () => {
    const v = await derived(base.versionId, (m) => {
      const c = m.acceptanceSchemes.find((s) => s.id === 'AS-UOW')?.criteria.find((x) => x.id === 'IP-AVG');
      if (c?.unit !== 'mg') throw new Error('fixture changed: AS-UOW/IP-AVG unit');
      c.unit = 'g';
    });
    const cr = await w.changeRecord();
    await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v.versionId, { changeRecordId: cr }), reason('change record linked'));
    await w.run(w.cast.regulatory, (c) => lc.addChangeRegulatory(c, cr, 'IN', 'PRIOR_APPROVAL', `VAR-${tag()}`));
    expect(await guard(db.admin, 'registered_ranges_kept', v.versionId)).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------------------------
// Comparisons with the baselines (PR-04, PR-06)
// -------------------------------------------------------------------------------------------------------------------

describe('registered ranges and their changes (PR-04)', () => {
  const ranges = async (content: unknown) =>
    (await db.app.query<Record<string, unknown>>('select subject, unit, low::text, low_inclusive, high::text, high_inclusive from recipe.registered_ranges($1::jsonb) order by subject', [JSON.stringify(content)])).rows;
  const changes = async (before: unknown, after: unknown) =>
    (await db.app.query<Record<string, unknown>>('select subject, change, widened from recipe.registered_changes($1::jsonb, $2::jsonb) order by subject, change', [JSON.stringify(before), JSON.stringify(after)])).rows;
  /** The granulation master with binderTemp's range as a REGISTERED one; `low`/`high` replace its bounds. */
  const withRegisteredBinder = (low?: Record<string, unknown>, high?: Record<string, unknown>): MbrContent => {
    const m = clone(baseContent);
    const p = m.parameters.find((x) => x.id === 'binderTemp');
    const r = p?.limits?.ranges[0] as Record<string, unknown> | undefined;
    if (!r) throw new Error('fixture changed: binderTemp');
    r['tier'] = 'REGISTERED';
    if (low) r['low'] = low;
    if (high) r['high'] = high;
    return m;
  };

  it('[PR-04] the registered ranges of parameters and acceptance criteria, a bound without "inclusive" being strict', async () => {
    const m = withRegisteredBinder({ value: '20.0' }, { value: '30.0' });
    expect(await ranges(m)).toEqual([
      { subject: 'AS-UOW/IP-AVG', unit: 'mg', low: '237.5', low_inclusive: true, high: '262.5', high_inclusive: true },
      { subject: 'binderTemp', unit: binderUnitOf(m), low: '20.0', low_inclusive: false, high: '30.0', high_inclusive: false },
    ]);
    // An unchanged content changes nothing.
    expect(await changes(m, clone(m))).toEqual([]);
    expect(await changes(baseContent, clone(baseContent))).toEqual([]);
  });

  it('[PR-04] a range added is a change, not a widening; a strict bound made inclusive at the same value is a widening', async () => {
    const strict = withRegisteredBinder({ value: '20.0' }, { value: '30.0', inclusive: false });
    expect(await changes(baseContent, strict)).toEqual([{ subject: 'binderTemp', change: 'registered range added', widened: false }]);
    const lowInclusive = withRegisteredBinder({ value: '20.0', inclusive: true }, { value: '30.0', inclusive: false });
    expect(await changes(strict, lowInclusive)).toEqual([{ subject: 'binderTemp', change: 'registered range changed from (20.0, 30.0) to [20.0, 30.0)', widened: true }]);
    const highInclusive = withRegisteredBinder({ value: '20.0' }, { value: '30.0', inclusive: true });
    expect(await changes(strict, highInclusive)).toEqual([{ subject: 'binderTemp', change: 'registered range changed from (20.0, 30.0) to (20.0, 30.0]', widened: true }]);
  });

  it('[PR-04] a registered range whose unit alone changed (same bounds, same inclusive flags) is a change and a widening', async () => {
    const inGrams = clone(baseContent);
    const c = inGrams.acceptanceSchemes.find((s) => s.id === 'AS-UOW')?.criteria.find((x) => x.id === 'IP-AVG');
    if (c?.unit !== 'mg') throw new Error('fixture changed: AS-UOW/IP-AVG unit');
    c.unit = 'g';
    expect(await changes(baseContent, inGrams)).toEqual([{ subject: 'AS-UOW/IP-AVG', change: 'registered range unit changed from mg to g', widened: true }]);
    // The same on a parameter's limits: binderTemp's unit changes, its registered range does not.
    const before = withRegisteredBinder({ value: '20.0', inclusive: true }, { value: '30.0', inclusive: true });
    const after = clone(before);
    const limits = after.parameters.find((x) => x.id === 'binderTemp')?.limits;
    if (!limits) throw new Error('fixture changed: binderTemp');
    const unitBefore = limits.unit;
    limits.unit = `${unitBefore}-other`;
    expect(await changes(before, after)).toEqual([
      { subject: 'binderTemp', change: `registered range unit changed from ${unitBefore} to ${unitBefore}-other`, widened: true },
    ]);
  });

  it('[PR-04] narrowing one bound while the other stays as it was is not a widening, whether that other bound is inclusive or strict', async () => {
    const narrowLow = clone(baseContent);
    ipAvg(narrowLow).low.value = '240.0';
    expect(await changes(baseContent, narrowLow)).toEqual([
      { subject: 'AS-UOW/IP-AVG', change: 'registered range changed from [237.5, 262.5] to [240.0, 262.5]', widened: false },
    ]);
    const strictHigh = withRegisteredBinder({ value: '20.0', inclusive: true }, { value: '30.0', inclusive: false });
    const narrowStrictHigh = withRegisteredBinder({ value: '21.0', inclusive: true }, { value: '30.0', inclusive: false });
    expect(await changes(strictHigh, narrowStrictHigh)).toEqual([
      { subject: 'binderTemp', change: 'registered range changed from [20.0, 30.0) to [21.0, 30.0)', widened: false },
    ]);
  });
});

/** The unit of binderTemp's limits in the fixture. */
function binderUnitOf(m: MbrContent): string {
  return m.parameters.find((x) => x.id === 'binderTemp')?.limits?.unit ?? '';
}

describe('baselines and process impact (PR-06)', () => {
  it('[PR-06] an approved first version has no baseline, not even itself, and is a new process', async () => {
    expect((await db.app.query('select * from recipe.baseline_versions($1)', [base.versionId])).rows).toEqual([]);
    expect((await lc.versionDiff(db.app, base.versionId)).baselines).toEqual([]);
    expect((await db.app.query<{ r: unknown }>('select recipe.process_impact($1) as r', [base.versionId])).rows[0]?.r).toEqual({ impacting: true, new_master: true, areas: ['new master'] });
  });

  it('[PR-06] a derived version is compared with every top-level area it changed, not as a new master', async () => {
    const v = await derived(base.versionId, (m) => {
      const b = m.bom[0];
      if (b) b.quantity.value = '8.300000';
      m.riskReductions = [];
    });
    expect((await db.app.query<{ r: unknown }>('select recipe.process_impact($1) as r', [v.versionId])).rows[0]?.r).toEqual({
      impacting: true,
      new_master: false,
      areas: ['bom', 'riskReductions'],
    });
  });

  it('[PR-06][PR-04] a version derived from an older master is compared with it and with the newest approved master of its family', async () => {
    await closeOpenVersions(base.versionId);
    const v2 = await w.approvedSuccessor(base.versionId, (m) => (m.header.title = `${m.header.title} (v2)`));
    const v3 = await derived(base.versionId);
    const baselines = (await db.app.query<{ b: string }>('select b::text from recipe.baseline_versions($1) b order by 1', [v3.versionId])).rows.map((r) => r.b);
    expect(baselines).toEqual([base.versionId, v2.versionId].sort());
    // v2 is itself approved: it is never its own baseline.
    expect((await db.app.query<{ b: string }>('select b::text from recipe.baseline_versions($1) b', [v2.versionId])).rows.map((r) => r.b)).toEqual([base.versionId]);
  }, 120_000);
});

// -------------------------------------------------------------------------------------------------------------------
// What a signer of a version sees (DI-37) and the version log (INV-04)
// -------------------------------------------------------------------------------------------------------------------

describe('the signed content of a version and its log (DI-37, INV-04)', () => {
  it('[DI-37][INV-09] the signed content names the version\'s own family, and its content version counts the version\'s own log rows', async () => {
    const d = await draft();
    const edited = clone(d.content);
    edited.header.title = `${edited.header.title} (second revision)`;
    await w.run(w.cast.author, (c) => lc.saveContent(c, d.versionId, edited));
    const provided = (await q<{ r: { content_version: number; content: { family: { code: string }; content_revision: string } } }>('select recipe.mbr_version_content($1) as r', [d.versionId]))[0]?.r;
    const logRows = await count('select count(*) as n from recipe.mbr_version_log where version_id = $1', [d.versionId]);
    expect(logRows).toBe(2);
    expect(await count('select count(*) as n from recipe.mbr_version_log')).toBeGreaterThan(logRows);
    expect(provided?.content.family.code).toBe(d.content.header.family);
    expect(provided?.content.content_revision).toBe('2');
    expect(provided?.content_version).toBe(1 + logRows);
  });

  it('[INV-04][DI-22] the first content revision is logged as the creation of the version, every later one as a content edit', async () => {
    const d = await draft();
    const edited = clone(d.content);
    edited.header.title = `${edited.header.title} (edit)`;
    await w.run(w.cast.coAuthor, (c) => lc.saveContent(c, d.versionId, edited));
    expect(
      await q("select kind, is_edit, person_id, detail ->> 'revision' as revision from recipe.mbr_version_log where version_id = $1 and kind in ('CREATED', 'CONTENT') order by id", [d.versionId]),
    ).toEqual([
      { kind: 'CREATED', is_edit: true, person_id: w.cast.author.personId, revision: '1' },
      { kind: 'CONTENT', is_edit: true, person_id: w.cast.coAuthor.personId, revision: '2' },
    ]);
  });
});

// -------------------------------------------------------------------------------------------------------------------
// The invariant queries on forged histories (INV-04, PR-06)
// -------------------------------------------------------------------------------------------------------------------

describe('the INV-04 and PR-06 invariant queries find a forged history', () => {
  /** Author, co-editor and checker of exactly this one version (nobody else's). */
  let author: SeededActor;
  let editor: SeededActor;
  let checker: SeededActor;
  let v: lc.VersionRef & { familyId: string };
  let checkSig: string;
  let approveSig: string;

  beforeAll(async () => {
    author = await seedActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'Anika Only-author' });
    editor = await seedActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'Esha Only-editor' });
    checker = await seedActor(db, { roleCode: 'MBR_CHECKER', legalName: 'Kunal Only-checker' });
    // Another version enters its second draft cycle before this version is checked.
    const other = await draft();
    await w.prepare(other.versionId, other.content);
    await w.startVerification(other.versionId);
    const so = await w.state(other.versionId);
    await w.run(w.cast.author, (c) => lc.returnToDraft(c, other.versionId, so.version), reason('rework of the other master'));

    const content = uniqueContent();
    v = await w.newVersion(content, author);
    const edited = clone(content);
    edited.header.title = `${edited.header.title} (co-editor)`;
    await w.run(editor, (c) => lc.saveContent(c, v.versionId, edited, 'co-editor edit'));
    await w.prepare(v.versionId, edited, { evidence: 'none' });
    await w.recordEvidence(v.versionId, edited, 'stub', author);
    await w.startVerification(v.versionId, author);
    await w.submit(v.versionId, author);
    checkSig = await w.check(v.versionId, checker);
    approveSig = await w.approve(v.versionId);
    expect((await w.state(v.versionId)).state).toBe('APPROVED');
  }, 300_000);

  const inv04 = (c: pg.PoolClient) => c.query<{ detail: string }>('select detail from recipe.inv04_violations() where version_id = $1 order by detail', [v.versionId]).then((r) => r.rows.map((x) => x.detail));
  const signedBy = (signatureId: string, person: SeededActor) => (c: pg.PoolClient) =>
    c.query('update esig.signature set signer_person = $2, session_person = $2 where id = $1', [signatureId, person.personId]);
  const historyAt = (event: string) => `(select h.recorded_at from platform.state_history h where h.aggregate_type = 'mbr_version' and h.aggregate_id = $1 and h.event = '${event}')`;
  const EDITOR_ROW = 'CHECK was signed by a person who edited the content in the same draft cycle';

  it('[INV-04] the real history has no violation', async () => {
    const nothing = () => Promise.resolve();
    expect(await forged(nothing, inv04)).toEqual([]);
    expect(await forged(nothing, async (c) => (await c.query<Record<string, unknown>>('select * from recipe.approved_content_violations() where version_id = $1', [v.versionId])).rows)).toEqual([]);
  });

  it('[INV-04] a CHECK signed by the version\'s author is found, as the author\'s and as an editor\'s signature', async () => {
    expect(await forged(signedBy(checkSig, author), inv04)).toEqual([EDITOR_ROW, 'CHECK was signed by the author']);
  });

  it('[INV-04] a CHECK signed by a person who edited the content in the same draft cycle is found, whatever cycle other versions are in', async () => {
    expect(await forged(signedBy(checkSig, editor), inv04)).toEqual([EDITOR_ROW]);
  });

  it('[INV-04] an APPROVE signed by the version\'s own checker is found while S4 does not allow it, wherever the APPROVE sits in the history', async () => {
    expect(await forged(signedBy(approveSig, checker), inv04)).toEqual(['APPROVE was signed by the checker while S4 does not allow it']);
    expect(
      await forged(async (c) => {
        await signedBy(approveSig, checker)(c);
        await c.query("update platform.state_history set from_version = 999, to_version = 1000 where aggregate_type = 'mbr_version' and aggregate_id = $1 and event = 'APPROVE'", [v.versionId]);
      }, inv04),
    ).toEqual(['APPROVE was signed by the checker while S4 does not allow it']);
  });

  it('[INV-04] a step belongs to the draft cycle entered at the same instant, and an edit at the same instant as the step counts as before it', async () => {
    const cycleEnteredAtCheck = (c: pg.PoolClient) => c.query(`update recipe.mbr_draft_entry set recorded_at = ${historyAt('CHECK')} where version_id = $1 and cycle = 1`, [v.versionId]);
    expect(await forged(async (c) => { await signedBy(checkSig, editor)(c); await cycleEnteredAtCheck(c); }, inv04)).toEqual([EDITOR_ROW]);
    const editAtCheck = (c: pg.PoolClient) =>
      c.query(`update recipe.mbr_version_log set recorded_at = ${historyAt('CHECK')} where version_id = $1 and person_id = $2 and is_edit`, [v.versionId, editor.personId]);
    expect(await forged(async (c) => { await signedBy(checkSig, editor)(c); await editAtCheck(c); }, inv04)).toEqual([EDITOR_ROW]);
  });

  it('[PR-06] a content revision recorded after the version was first approved is found; one at the instant of approval is not after it', async () => {
    const revisionAt = (offset: string) => (c: pg.PoolClient) =>
      c.query(`update recipe.mbr_content set recorded_at = ${historyAt('APPROVE')} + $2::interval where version_id = $1 and revision = 2`, [v.versionId, offset]);
    const read = async (c: pg.PoolClient) => (await c.query<{ detail: string }>('select detail from recipe.approved_content_violations() where version_id = $1', [v.versionId])).rows.map((r) => r.detail);
    expect(await forged(revisionAt('1 second'), read)).toEqual(['content revision 2 recorded after the version was approved']);
    expect(await forged(revisionAt('0'), read)).toEqual([]);
  });
});

