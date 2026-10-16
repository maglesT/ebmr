/**
 * Review-by-exception rules under change control (DI-26, DI-09) and review by exception on a step only with a
 * validation reference (PR-52 clause 2); recipe-core 1050, kernel 1195. Phase 6 slice 6f, builder A.
 *
 * Run as the application role with bypass attempts: a rule is edited only by the quality unit, only under an approved
 * change record covering RBE_RULE; a mandatory category cannot be taken off the review; the rule set of a past instant
 * is read back; an MBR that enables review by exception on a step is submitted only when the reduction cites a
 * validation of the version's change record.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveChangeRecord, raiseChangeRecord } from '../../../kernel/src/config/change-control.ts';
import { withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import { seedActor, seedAdministration, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
let owner: SeededActor;
let admin: SeededActor;
let qaReviewer: SeededActor;
let operator: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  ({ owner, admin } = await seedAdministration(db));
  qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  operator = await seedActor(db, { roleCode: 'OPERATOR' });
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });
const under = (ctx: ActorContext, changeRecord?: string): ActorContext => ({ ...withReason(ctx, 'RBE_RULE', 'rule change'), ...(changeRecord ? { changeRecord } : {}) });

async function approvedRecord(areas: string[]): Promise<string> {
  const num = `CR-${randomBytes(4).toString('hex').toUpperCase()}`;
  await withCommand(db.app, again(owner), (c) => raiseChangeRecord(c, { number: num, title: 'RBE rule change', description: 'raise severity floors', areas }));
  const sig = await signFor(db, qaReviewer, { type: 'config_change_record', id: num }, 'CONFIG_CHANGE_APPROVED', 'OPEN');
  await withCommand(db.app, again(qaReviewer), (c) => approveChangeRecord(c, num, sig));
  return num;
}
const setRule = (ctx: ActorContext, category: string, included: boolean, severity: string, rationale = 'risk review 2026') =>
  withCommand(db.app, ctx, (c) => c.query('select recipe.set_rbe_rule($1, $2, $3, $4) as id', [category, included, severity, rationale]));
const dbNow = async (): Promise<string> => (await db.admin.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0]!.t;

describe('review-by-exception rules are versioned configuration under change control (DI-26, DI-09)', () => {
  it('[DI-26] editing an RBE rule without a change record is blocked', async () => {
    const qa = w.cast.qa;
    await expect(setRule(under(qa), 'LATE_ENTRY', true, 'ACTION')).rejects.toThrow('EBMR-CFG-001');
    const other = await approvedRecord(['PLATFORM_SETTING']);
    await expect(setRule(under(qa, other), 'LATE_ENTRY', true, 'ACTION')).rejects.toThrow('EBMR-CFG-004');
    const open = `CR-${randomBytes(4).toString('hex').toUpperCase()}`;
    await withCommand(db.app, again(owner), (c) => raiseChangeRecord(c, { number: open, title: 'not approved', description: 'd', areas: ['RBE_RULE'] }));
    await expect(setRule(under(qa, open), 'LATE_ENTRY', true, 'ACTION')).rejects.toThrow('EBMR-CFG-003');
    // Bypass attempts: the application role cannot write the rule table, and only the quality unit edits rules.
    await expect(
      db.app.query("insert into recipe.rbe_rule_version (category, version, included, min_severity, rationale, recorded_by_person, recorded_by_account) values ('LATE_ENTRY', 1, true, 'ALERT', 'x', gen_random_uuid(), gen_random_uuid())"),
    ).rejects.toThrow(/permission denied/);
    const rec = await approvedRecord(['RBE_RULE']);
    await expect(setRule(under(operator, rec), 'LATE_ENTRY', true, 'ACTION')).rejects.toThrow('EBMR-IAM-040');
    await expect(setRule(under(admin, rec), 'LATE_ENTRY', true, 'ACTION')).rejects.toThrow('EBMR-IAM-042');
    const { rows } = await db.admin.query('select 1 from recipe.rbe_rule_version');
    expect(rows).toEqual([]);
  });

  it('[DI-26] under an approved change record a rule raises a severity floor; a mandatory category cannot be taken off the review', async () => {
    const rec = await approvedRecord(['RBE_RULE']);
    await expect(setRule(under(w.cast.qa, rec), 'MANUAL_ENTRY', false, 'ALERT')).rejects.toThrow('EBMR-RBE-002');
    await expect(setRule(under(w.cast.qa, rec), 'NO_SUCH', true, 'ALERT')).rejects.toThrow('EBMR-RBE-001');
    await expect(setRule(under(w.cast.qa, rec), 'MANUAL_ENTRY', true, 'URGENT')).rejects.toThrow('EBMR-RBE-001');
    await expect(setRule(under(w.cast.qa, rec), 'MANUAL_ENTRY', true, 'ACTION', ' ')).rejects.toThrow('EBMR-RBE-004');
    await setRule(under(w.cast.qa, rec), 'MANUAL_ENTRY', true, 'ACTION');
    await setRule(under(qaReviewer, rec), 'MANUAL_ENTRY', true, 'CRITICAL');
    const { rows } = await db.admin.query<{ version: number; min_severity: string; area: string; cr: string }>(
      `select r.version, r.min_severity, v.area, c.number as cr from recipe.rbe_rule_version r
         join platform.config_version v on v.area = 'RBE_RULE' and v.source_row ->> 'id' = r.id::text
         join platform.change_record c on c.id = v.change_record_id where r.category = 'MANUAL_ENTRY' order by r.version`,
    );
    expect(rows).toEqual([
      { version: 1, min_severity: 'ACTION', area: 'RBE_RULE', cr: rec },
      { version: 2, min_severity: 'CRITICAL', area: 'RBE_RULE', cr: rec },
    ]);
    await expect(db.admin.query("update recipe.rbe_rule_version set min_severity = 'ALERT'")).rejects.toThrow(/EBMR-/);
  });

  it('[DI-26] the rule set of a past date is read back, and the register shows each item at least at its rule\'s severity', async () => {
    const rec = await approvedRecord(['RBE_RULE']);
    await setRule(under(w.cast.qa, rec), 'TIME_SYNC', true, 'ACTION');
    const t1 = await dbNow();
    await setRule(under(w.cast.qa, rec), 'TIME_SYNC', true, 'CRITICAL');
    const at = async (t: string) =>
      (await db.app.query<{ min_severity: string; version: number | null; mandatory: boolean; included: boolean }>(
        "select min_severity, version, mandatory, included from recipe.rbe_rules_as_of($1::timestamptz) where category = 'TIME_SYNC'", [t])).rows[0];
    expect(await at(t1)).toEqual({ min_severity: 'ACTION', version: 1, mandatory: true, included: true });
    expect(await at(await dbNow())).toEqual({ min_severity: 'CRITICAL', version: 2, mandatory: true, included: true });
    expect(await at('2000-01-01T00:00:00Z')).toEqual({ min_severity: 'ALERT', version: null, mandatory: true, included: true });
    // The same history through the kernel's configuration read (DI-09).
    const { rows } = await db.app.query<{ value: { min_severity: string } }>(
      "select value from platform.config_as_of($1::timestamptz) where area = 'RBE_RULE' and item_key = 'TIME_SYNC'", [t1]);
    expect(rows[0]?.value.min_severity).toBe('ACTION');
    // The review view raises, never lowers: severity_rank orders ALERT < ACTION < CRITICAL.
    const { rows: ranks } = await db.app.query<{ r: number[] }>("select array[recipe.severity_rank('ALERT'), recipe.severity_rank('ACTION'), recipe.severity_rank('CRITICAL')] as r");
    expect(ranks[0]?.r).toEqual([1, 2, 3]);
    const cols = await db.admin.query<{ c: string }>("select attname as c from pg_attribute where attrelid = 'recipe.exception_register_rbe'::regclass and attname in ('review_severity', 'rule_version', 'listed') order by 1");
    expect(cols.rows.map((r) => r.c)).toEqual(['listed', 'review_severity', 'rule_version']);
  });
});

/** The id of the first phase in an MBR's flow. */
function firstPhase(content: MbrContent): string {
  const seen: unknown[] = [content];
  while (seen.length) {
    const x = seen.shift();
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o['kind'] === 'phase' && typeof o['id'] === 'string') return o['id'];
      for (const v of Object.values(o)) if (v && typeof v === 'object') seen.push(v);
    }
  }
  throw new Error('no phase in the fixture');
}

describe('review by exception on a step needs a validation reference (PR-52)', () => {
  async function submitWith(reduction: Record<string, unknown>, validationRef: string): Promise<string> {
    const content = uniqueContent();
    content.riskReductions = [
      ...content.riskReductions,
      { id: 'rbeStep', kind: 'REVIEW_BY_EXCEPTION', subjects: [firstPhase(content)], riskClass: 'LOW', rationale: 'qrmRbe', ...reduction } as never,
    ];
    const v = await w.newVersion(content);
    await w.prepare(v.versionId, content, { changeRecord: false });
    const cr = await w.changeRecord({ validationRef });
    await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, v.versionId, { changeRecordId: cr, effectiveFrom: '2026-01-01T00:00:00Z', reviewDue: '2027-12-31' }),
      reason('change record of the review-by-exception enablement'));
    await w.startVerification(v.versionId);
    await w.submit(v.versionId);
    return v.versionId;
  }

  it('[PR-52] RBE on a step without a validation reference is refused', async () => {
    await expect(submitWith({}, 'PV-RBE-1')).rejects.toThrow(/review by exception rbeStep needs a validation reference.*PR-52/);
  });

  it('[PR-52] RBE on a step citing a validation that is not on the version\'s change record, or without a risk class, is refused', async () => {
    await expect(submitWith({ validationRef: 'PV-ELSEWHERE' }, 'PV-RBE-2')).rejects.toThrow(/cites validation PV-ELSEWHERE, which is not a validation of the version's change record/);
    await expect(submitWith({ validationRef: 'PV-RBE-3', riskClass: ' ' }, 'PV-RBE-3')).rejects.toThrow(/needs a risk class and a rationale/);
  });

  it('[PR-52][DI-26] RBE on a step with the risk class, rationale and a validation of its change record is submitted', async () => {
    const id = await submitWith({ validationRef: 'PV-RBE-4' }, 'PV-RBE-4');
    expect((await w.state(id)).state).toBe('SUBMITTED');
  });
});
