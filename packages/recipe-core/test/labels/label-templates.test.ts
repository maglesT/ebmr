/**
 * Phase 6 slice 6c (recipe-core 0990; IN-31, PR-36; defaults D-P6c-2, D-P6c-8, D-P6c-10, D-P6c-17): label templates are
 * versioned master data holding layout and record-field bindings only, approved by a second person; an India-domestic
 * template that leaves out an India particular (the manufacturing date among them) fails approval; the labelling
 * declaration of a draft packaging master gates its approval (a cut-label item without its 211.122(g) option, or with a
 * template that is not approved, cannot be approved). Proven as the application role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { again } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { seedCast, uniqueContent, withSecondRole, World } from '../lifecycle/support.ts';

type Json = Record<string, unknown>;
let db: TestDatabase;
let w: World;
let steward: SeededActor;
let steward2: SeededActor;
let operator: SeededActor;

const ALL_INDIA = ['DRUG_NAME', 'STRENGTH', 'BATCH_NUMBER', 'MFG_DATE', 'EXPIRY_DATE', 'MANUFACTURER_NAME_ADDRESS', 'MFG_LICENCE_NO'];
const layout = (fields: string[], extra: Json = {}): Json => ({ width: '60', height: '40', elements: fields.map((f, i) => ({ field: f, x: '2', y: String(2 + i * 4), ...extra })) });
const as = <T>(actor: SeededActor, sql: string, params: unknown[]): Promise<T> =>
  withCommand(db.app, again(actor), async (c: pg.PoolClient) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
const create = (actor: SeededActor, p: Json): Promise<string> => as<string>(actor, 'select recipe.create_label_template($1::jsonb) as r', [JSON.stringify(p)]);
const approve = (actor: SeededActor, id: string): Promise<Json> => as<Json>(actor, 'select recipe.approve_label_template($1) as r', [id]);
const problem = async (id: string): Promise<string | null> => (await db.app.query<{ r: string | null }>('select recipe.label_template_approval_problem($1) as r', [id])).rows[0]?.r ?? null;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  steward2 = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mohan Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator' });
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

describe('label templates (recipe-core 0990)', () => {
  it('[IN-31] an India-domestic template without a manufacturing-date field fails approval; with every India particular a second person approves it, never its designer', async () => {
    const noMfg = await create(steward, { code: 'CTN-IN', scope: 'INDIA_DOMESTIC', markets: ['IN'], layout: layout(ALL_INDIA.filter((f) => f !== 'MFG_DATE')) });
    expect(await problem(noMfg)).toMatch(/an India-domestic label must bind MFG_DATE \(IN-31\)/);
    await expectRefused(approve(w.cast.qa, noMfg), 'EBMR-LBL-003', /MFG_DATE/);
    const full = await create(steward, { code: 'CTN-IN', scope: 'INDIA_DOMESTIC', markets: ['IN'], layout: layout([...ALL_INDIA, 'MRP'], { caption: 'Batch' }) });
    expect((await db.app.query<{ v: number }>('select version as v from recipe.label_template where id = $1', [full])).rows[0]?.v).toBe(2);
    expect(await problem(full)).toBeNull();
    // The designer holds no LABEL.APPROVE.
    await expectRefused(approve(steward, full), 'EBMR-IAM-040');
    expect(await approve(w.cast.qa, full)).toEqual({ templateId: full, ref: 'CTN-IN-v2', status: 'APPROVED' });
    expect(await problem(full)).toMatch(/is APPROVED/);
    await expectRefused(approve(w.cast.qa2, full), 'EBMR-LBL-003', /APPROVED/);
  });

  it('[IN-31] a template for India cannot call itself an export label, and an export label has no India particulars to bind; an author never approves a template', async () => {
    await expectRefused(create(steward, { code: 'CTN-X', scope: 'EXPORT', markets: ['IN', 'US'], layout: layout(['BATCH_NUMBER']) }), 'EBMR-LBL-005');
    const exp = await create(steward, { code: 'CTN-US', scope: 'EXPORT', markets: ['US'], layout: layout(['BATCH_NUMBER', 'EXPIRY_DATE', 'NDC', 'SERIAL']) });
    expect(await problem(exp)).toBeNull();
    // A designer who also holds the approver's role does not approve the template they designed (D-P6c-10).
    const both = await withSecondRole(db, steward2, 'QA_MBR_APPROVER');
    const own = await create(steward2, { code: 'CTN-US2', scope: 'EXPORT', markets: ['US'], layout: layout(['BATCH_NUMBER']) });
    await expectRefused(approve(both, own), 'EBMR-LBL-004');
    expect((await approve(w.cast.qa, own))['status']).toBe('APPROVED');
    expect((await db.app.query<{ n: string }>("select count(*)::text as n from recipe.label_template_event where template_id = $1 and event = 'APPROVED'", [own])).rows[0]?.n).toBe('1');
  });

  it('[IN-31] a template holds layout and record-field bindings only: a value, an unknown field, or a designer without LABEL.DESIGN is refused (D-P6c-2)', async () => {
    await expectRefused(create(steward, { code: 'CTN-V', scope: 'EXPORT', markets: ['US'], layout: { width: '60', height: '40', elements: [{ field: 'BATCH_NUMBER', x: '1', y: '1', value: 'B123' }] } }), 'EBMR-LBL-002');
    await expectRefused(create(steward, { code: 'CTN-V', scope: 'EXPORT', markets: ['US'], layout: layout(['FREE_TEXT']) }), 'EBMR-LBL-001', /no record field/);
    await expectRefused(create(steward, { code: 'CTN-V', scope: 'EXPORT', markets: ['US'], layout: { width: '0', height: '40', elements: [] } }), 'EBMR-LBL-001');
    await expectRefused(create(operator, { code: 'CTN-V', scope: 'EXPORT', markets: ['US'], layout: layout(['BATCH_NUMBER']) }), 'EBMR-IAM-040');
    await expect(db.app.query("insert into recipe.label_template_event (template_id, event, by_person, by_account, correlation_id) select id, 'APPROVED', gen_random_uuid(), gen_random_uuid(), gen_random_uuid() from recipe.label_template limit 1")).rejects.toThrow(/permission denied/);
    await expect(db.admin.query("update recipe.label_template set fields = '{MRP}'")).rejects.toThrow(/EBMR|insert-only|not allowed|reject/i);
  });
});

/** The fixture with a printed carton item configured on its carton step (cut labels when `form` says so). */
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

describe('the packaging master\'s labelling declaration (recipe-core 0990, D-P6c-8)', () => {
  it('[PR-36] a cut-label master without the 211.122(g) option cannot be approved; with the option and an approved template it is approved, and the declaration is frozen once the version leaves DRAFT', async () => {
    const { content, step } = packagingContent();
    const v = await w.newVersion(content);
    const declare = (form: string, template: string | null, option: string | null) =>
      as<Json>(w.cast.author, 'select recipe.declare_packaging_labelling($1, $2, $3, $4, $5, $6) as r', [v.versionId, step, 'CARTON', form, template, option]);
    await expectRefused(as(w.cast.author, 'select recipe.declare_packaging_labelling($1, $2, $3, $4, null, null) as r', [v.versionId, 'p-foil-issue', 'CARTON', 'CUT_LABEL']), 'EBMR-LBL-010');
    await expectRefused(declare('CARTON', null, 'ELECTRONIC_100'), 'EBMR-LBL-013');
    const draftTemplate = await create(steward2, { code: 'CUT-1', scope: 'INDIA_DOMESTIC', markets: ['IN', 'US'], layout: layout(ALL_INDIA) });
    expect((await declare('CUT_LABEL', null, null))['approvalProblem']).toMatch(/uses cut labels without a 211\.122\(g\) option \(PR-36\)/);
    await w.prepare(v.versionId, content);
    await w.startVerification(v.versionId);
    await w.submit(v.versionId);
    await w.check(v.versionId);
    await expect(w.approve(v.versionId)).rejects.toThrow(/EBMR-LBL-011 .*211\.122\(g\) option/);
    expect((await w.state(v.versionId)).state).toBe('CHECKED');
    // The version is no longer DRAFT: its declaration cannot change now; a successor would carry the corrected one.
    await expectRefused(declare('CUT_LABEL', draftTemplate, 'ELECTRONIC_100'), 'EBMR-LBL-012');

    const next = packagingContent();
    const v2 = await w.newVersion(next.content);
    const declare2 = (template: string | null, option: string | null) =>
      as<Json>(w.cast.author, 'select recipe.declare_packaging_labelling($1, $2, $3, $4, $5, $6) as r', [v2.versionId, next.step, 'CARTON', 'CUT_LABEL', template, option]);
    expect((await declare2(draftTemplate, 'ELECTRONIC_100'))['approvalProblem']).toMatch(/is DRAFT, not APPROVED \(IN-31\)/);
    await approve(w.cast.qa, draftTemplate);
    expect(await declare2(draftTemplate, 'ELECTRONIC_100')).toMatchObject({ approvalProblem: null, items: [{ step: next.step, item: 'CARTON', form: 'CUT_LABEL', templateRef: 'CUT-1-v1', option211122g: 'ELECTRONIC_100' }] });
    await w.prepare(v2.versionId, next.content);
    await w.startVerification(v2.versionId);
    await w.submit(v2.versionId);
    await w.check(v2.versionId);
    await w.approve(v2.versionId);
    expect((await w.state(v2.versionId)).state).toBe('APPROVED');
    await expect(db.app.query("insert into recipe.packaging_labelling (version_id, step, item, form, recorded_by_person, recorded_by_account, correlation_id) values ($1, 'p-carton-issue', 'CARTON', 'ROLL_LABEL', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [v2.versionId])).rejects.toThrow(/permission denied/);
  });
});
