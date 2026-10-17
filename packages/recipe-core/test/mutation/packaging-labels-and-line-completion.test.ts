/**
 * Label templates and the packaging master's labelling declaration, rule by rule (SQL mutation group
 * "packaging-labels-and-line-completion", recipe-core 0990). The scenario test (labels/label-templates.test.ts) shows
 * templates designed, approved by a second person and declared on a master; these take each rule the Phase 6 mutation
 * run found unproven to the input where it alone decides:
 *  - a template and its layout: every malformed part alone is refused (EBMR-LBL-001), and an element carrying a text or
 *    a default is a value, which a template never holds (EBMR-LBL-002; D-P6c-2, IN-31);
 *  - a template's status is its own events' (another template's retirement leaves it as it is);
 *  - the declaration: an unknown version, an unknown form or option and an unknown template are refused by name; a
 *    declared item the draft no longer prints is an approval problem; the master's labelling view reports the
 *    version's own life-cycle state (PR-36, D-P6c-8).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { seedActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { again } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { seedCast, uniqueContent, World } from '../lifecycle/support.ts';

type Json = Record<string, unknown>;
let db: TestDatabase;
let w: World;
let steward: SeededActor;

const layout = (fields: string[], extra: Json = {}): Json => ({ width: '60', height: '40', elements: fields.map((f, i) => ({ field: f, x: '2', y: String(2 + i * 4), ...extra })) });
const as = <T>(actor: SeededActor, sql: string, params: unknown[]): Promise<T> =>
  withCommand(db.app, again(actor), async (c: pg.PoolClient) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
const create = (p: unknown): Promise<string> => as<string>(steward, 'select recipe.create_label_template($1::jsonb) as r', [JSON.stringify(p)]);
const status = async (id: string): Promise<string | null> => (await db.app.query<{ r: string | null }>('select recipe.label_template_status($1) as r', [id])).rows[0]?.r ?? null;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

describe('label templates, rule by rule (recipe-core 0990)', () => {
  it('[IN-31] each malformed template alone is refused with EBMR-LBL-001', async () => {
    const ok = { code: 'CTN-M', scope: 'EXPORT', markets: ['US'], layout: layout(['BATCH_NUMBER']) };
    const { code: _code, ...noCode } = ok;
    void _code;
    for (const bad of [
      [ok],
      { ...ok, owner: 'x' },
      noCode,
      { ...ok, code: 'ctn-lower' },
      { ...ok, scope: null },
      { ...ok, scope: 'WORLD' },
      { ...ok, markets: 'US' },
      { ...ok, markets: [] },
      { ...ok, markets: ['US', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT'] },
      { ...ok, markets: [1] },
      { ...ok, markets: ['usa'] },
    ]) {
      await expectRefused(create(bad), 'EBMR-LBL-001', /a label template is \{code/);
    }
    expect(await create(ok)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-31] each malformed layout or element alone is refused; a text or a default on an element is a value (D-P6c-2)', async () => {
    const t = (l: unknown) => create({ code: 'CTN-L', scope: 'EXPORT', markets: ['US'], layout: l });
    const ok = layout(['BATCH_NUMBER']);
    const el = { field: 'BATCH_NUMBER', x: '2', y: '2' };
    for (const bad of [
      [ok],
      { ...ok, depth: '1' },
      { ...ok, width: '0' },
      { ...ok, height: 'x' },
      { ...ok, elements: {} },
      { ...ok, elements: [] },
      { ...ok, elements: Array.from({ length: 41 }, () => el) },
    ]) {
      await expectRefused(t(bad), 'EBMR-LBL-001', /a label layout is/);
    }
    for (const bad of [
      'BATCH_NUMBER',
      { ...el, z: '1' },
      { ...el, x: '-1' },
      { ...el, y: '1.25' },
      { ...el, caption: 5 },
      { ...el, caption: 'x'.repeat(81) },
      { ...el, caption: '   ' },
      { ...el, caption: 'Lot nº' },
    ]) {
      await expectRefused(t({ ...ok, elements: [bad] }), 'EBMR-LBL-001', /element 1 is not \{field, x, y, caption\?\}/);
    }
    await expectRefused(t({ ...ok, elements: [{ ...el, text: 'B123' }] }), 'EBMR-LBL-002');
    await expectRefused(t({ ...ok, elements: [{ ...el, default: 'B123' }] }), 'EBMR-LBL-002');
    // At the limits: 40 elements and an 80-character caption are a layout.
    expect(await t({ ...ok, elements: Array.from({ length: 40 }, () => ({ ...el, caption: 'x'.repeat(80) })) })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-31] a template\'s status is its own events\': another template\'s retirement does not retire it', async () => {
    const a = await create({ code: 'CTN-R1', scope: 'EXPORT', markets: ['US'], layout: layout(['BATCH_NUMBER']) });
    const b = await create({ code: 'CTN-R2', scope: 'EXPORT', markets: ['US'], layout: layout(['BATCH_NUMBER']) });
    // No command retires a template yet (the status reads the event the table already admits): arranged as set-up.
    await withCommand(db.admin, withReason(w.cast.qa), (c) =>
      c.query("insert into recipe.label_template_event (template_id, event, by_person, by_account, correlation_id) values ($1, 'RETIRED', $2, $3, gen_random_uuid())", [a, w.cast.qa.personId, w.cast.qa.accountId]));
    expect(await status(a)).toBe('RETIRED');
    expect(await status(b)).toBe('DRAFT');
  });
});

/** The fixture with a printed carton item configured on its carton step. */
function packagingContent(): { content: MbrContent; step: string } {
  const content = uniqueContent('tablet-blister-packaging');
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return;
    const o = n as Json;
    if (o['kind'] === 'phase' && o['id'] === 'p-carton-issue') {
      o['config'] = { items: [{ id: 'CARTON', material: 'MAT-CTN', artwork: { IN: 'ART-1', US: 'ART-1' }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' } }] };
    }
    Object.values(o).forEach(visit);
  };
  visit(content);
  return { content, step: 'p-carton-issue' };
}
/** The same content with the carton item's id renamed on its step (the item declared before is no longer printed there). */
function renamedItem(content: MbrContent): MbrContent {
  const copy = JSON.parse(JSON.stringify(content)) as MbrContent;
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return;
    const o = n as Json;
    if (o['kind'] === 'phase' && o['id'] === 'p-carton-issue') ((o['config'] as Json)['items'] as Json[])[0]!['id'] = 'CARTON2';
    Object.values(o).forEach(visit);
  };
  visit(copy);
  return copy;
}

describe('the labelling declaration, rule by rule (recipe-core 0990, D-P6c-8)', () => {
  it('[PR-36] an unknown version, form, option or template is refused by name; a valid option on cut labels is declared', async () => {
    const { content, step } = packagingContent();
    const v = await w.newVersion(content);
    const declare = (version: string, form: string | null, template: string | null, option: string | null) =>
      as<Json>(w.cast.author, 'select recipe.declare_packaging_labelling($1, $2, $3, $4, $5, $6) as r', [version, step, 'CARTON', form, template, option]);
    const nowhere = randomUUID();
    await expectRefused(declare(nowhere, 'ROLL_LABEL', null, null), 'EBMR-LBL-010', new RegExp(`${nowhere} is no MBR version`));
    for (const [form, option] of [[null, null], ['BOX', null], ['CUT_LABEL', 'BOGUS']] as const) {
      await expectRefused(declare(v.versionId, form, null, option), 'EBMR-LBL-013', /the form is CUT_LABEL/);
    }
    const ghost = randomUUID();
    await expectRefused(declare(v.versionId, 'ROLL_LABEL', ghost, null), 'EBMR-LBL-014', new RegExp(`${ghost} is no label template`));
    expect(await declare(v.versionId, 'CUT_LABEL', null, 'DEDICATED_LINES')).toMatchObject({ state: 'DRAFT', approvalProblem: null, items: [{ item: 'CARTON', form: 'CUT_LABEL', option211122g: 'DEDICATED_LINES' }] });
  });

  it('[PR-36] a declared item the draft no longer prints is an approval problem; the labelling view reports the version\'s own state', async () => {
    const { content, step } = packagingContent();
    const v = await w.newVersion(content);
    const other = await w.newVersion(packagingContent().content);
    const view = async (version: string): Promise<Json> => (await db.app.query<{ r: Json }>('select recipe.master_labelling($1) as r', [version])).rows[0]!.r;
    expect((await as<Json>(w.cast.author, 'select recipe.declare_packaging_labelling($1, $2, $3, $4, null, null) as r', [v.versionId, step, 'CARTON', 'ROLL_LABEL']))['approvalProblem']).toBeNull();
    // The draft is edited after the declaration: the carton step's item is renamed, so CARTON is printed nowhere.
    const edited = renamedItem(content);
    await w.run(w.cast.author, (c) => lc.saveContent(c, v.versionId, edited, 'carton item renamed for the test'));
    expect((await view(v.versionId))['approvalProblem']).toMatch(new RegExp(`step ${step} item CARTON is declared but is no printed item of a G-21 step of this version`));
    // Back to the printed item; the version goes on to CHECKED while the other stays DRAFT.
    await w.run(w.cast.author, (c) => lc.saveContent(c, v.versionId, content, 'carton item restored'));
    await w.prepare(v.versionId, content);
    await w.startVerification(v.versionId);
    await w.submit(v.versionId);
    await w.check(v.versionId);
    expect(await view(v.versionId)).toMatchObject({ versionId: v.versionId, state: 'CHECKED', approvalProblem: null });
    expect(await view(other.versionId)).toMatchObject({ versionId: other.versionId, state: 'DRAFT', items: [] });
  });
});
