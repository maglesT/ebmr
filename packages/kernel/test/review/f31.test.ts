/**
 * Review reproducer F31: the Revised Schedule M rule "batch records kept at least one year after the
 * expiry of the finished product" (IN_SCHEDULE_M_EXPIRY, migration 0420 line 51) carries the predicate
 * {"expiryLabelled": true}, and records.evaluate_retention derives expiryLabelled from
 * `(p_inputs ->> 'expiryDate') is not null`. An expiry that is simply not entered yet (or cleared with
 * records.update_retention_inputs(key, '{"expiryDate": null}', ...)) is therefore read as "no labelled
 * expiry": the Schedule M rule no longer applies at all (instead of being OPEN with
 * MISSING_INPUT:EXPIRY), and with licenceForm FORM_25 / FORM_28 the manufacture + 5 years rules give a
 * DATED retain-until that can lie more than a year before the Schedule M floor.
 *
 * Safe behaviour asserted (outline 3.3.6 "Schedule M expiry + 1 y (always)"; retention-rules.ts header
 * "OPEN when ... the anchor date is missing (retention never ends on an unknown input)"; open question
 * R3 default "Retention stays OPEN" when an input date is missing; DI-47, INV-22): an India batch
 * record whose expiry date is unknown is OPEN with MISSING_INPUT:EXPIRY, in the authoritative SQL copy
 * and through the stored schedule, whatever its licence form.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import type { EffectiveRetention, OwnRetention, RetentionInputs } from '../../src/records/retention.ts';
import { createRetentionSchedule, updateRetentionInputs } from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, recordType, registerType, testActor } from '../records/helpers.ts';

let db: TestDatabase;
let qa: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  qa = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Reviewer' });
});
afterAll(async () => {
  await db.drop();
});

/** The authoritative database evaluation (records.evaluate_retention, 0420). */
async function sqlEvaluate(inputs: RetentionInputs): Promise<OwnRetention> {
  const { rows } = await db.app.query<{ r: OwnRetention }>(
    `select records.evaluate_retention(records.normalize_retention_inputs($1::jsonb) || jsonb_build_object('retentionKey', 'BATCH_RECORD')) as r`,
    [JSON.stringify(inputs)],
  );
  return rows[0]?.r as OwnRetention;
}

async function effectiveOf(recordKey: string): Promise<EffectiveRetention> {
  const { rows } = await db.app.query<{ e: EffectiveRetention }>(
    'select records.compute_effective_retention(s.id) as e from records.retention_schedule s where s.record_key = $1',
    [recordKey],
  );
  return rows[0]?.e as EffectiveRetention;
}

describe('F31 Schedule M expiry + 1 year when the expiry date is unknown', () => {
  it('[DI-47][INV-22] India Form 25 batch without an expiry date: Schedule M rule is OPEN (MISSING_INPUT:EXPIRY), not manufacture + 5 years', async () => {
    const r = await sqlEvaluate({ markets: ['IN'], licenceForm: 'FORM_25', manufactureDate: '2026-01-10' });
    const scheduleM = r.evaluated.find((e) => e.ruleId === 'IN_SCHEDULE_M_EXPIRY');
    expect({ status: r.status, retainUntil: r.retainUntil, openReasons: r.openReasons, scheduleM }).toEqual({
      status: 'OPEN',
      retainUntil: null,
      openReasons: ['MISSING_INPUT:EXPIRY'],
      scheduleM: { ruleId: 'IN_SCHEDULE_M_EXPIRY', status: 'OPEN', date: null, reason: 'MISSING_INPUT:EXPIRY' },
    });
  });

  it('[DI-47][INV-22] India Form 28 batch without an expiry date: retention stays OPEN (Schedule M expiry + 1 year cannot be computed)', async () => {
    const r = await sqlEvaluate({ markets: ['IN'], licenceForm: 'FORM_28', manufactureDate: '2026-01-10' });
    expect({ status: r.status, retainUntil: r.retainUntil }).toEqual({ status: 'OPEN', retainUntil: null });
    expect(r.openReasons).toContain('MISSING_INPUT:EXPIRY');
  });

  it('[DI-47][INV-22] clearing a Form 25 batch expiry with update_retention_inputs leaves the stored effective retention OPEN, not DATED 2031-01-10', async () => {
    const batch = randomUUID();
    const key = `batch:${batch}`;
    await withCommand(db.app, again(qa), (c) =>
      createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', {
        markets: ['IN'],
        licenceForm: 'FORM_25',
        manufactureDate: '2026-01-10',
        expiryDate: '2031-01-31',
      }),
    );
    // With the real 60-month expiry the Schedule M floor governs.
    expect(await effectiveOf(key)).toMatchObject({ status: 'DATED', retainUntil: '2032-01-31' });

    const afterClear = await withCommand(db.app, again(qa), (c) =>
      updateRetentionInputs(c, key, { expiryDate: null }, 'expiry under re-assessment after stability excursion'),
    );
    expect({ status: afterClear.status, retainUntil: afterClear.retainUntil }).toEqual({ status: 'OPEN', retainUntil: null });

    const { rows } = await db.app.query<{ effective_status: string; effective_retain_until: string | null }>(
      "select effective_status, to_char(effective_retain_until, 'YYYY-MM-DD') as effective_retain_until from records.retention_evaluation where record_key = $1 order by id desc limit 1",
      [key],
    );
    expect(rows[0]).toEqual({ effective_status: 'OPEN', effective_retain_until: null });
  });
});
