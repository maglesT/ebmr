/**
 * An environmental excursion reaches both departments' notification centre (IN-39 clause 2; recipe-core 1051; Phase 6
 * slice 6f, builder A). A pressure difference below its action limit at a G-11 room check raises ENVIRONMENT_EXCURSION;
 * the register row and one notification for PRODUCTION and one for QA are written in the same transaction, naming the
 * batch, the step and the person whose command raised it; a person of each department acknowledges their own. The
 * application role cannot write, change or delete such a notification.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execution, type flow } from '@ebmr/recipe-core';
import { notificationViews } from '../../src/features/notifications/index.ts';
import type { AppContext } from '../../src/platform/context.ts';
import { dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';

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
const KEY = 'p-room@';

/** A G-11 room check before the preparation steps: the pressure difference has an action limit of 10 Pa at least. */
const withRoomCheck = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    (content['parameters'] as Json[]).push({
      id: 'roomDp', name: 'Room pressure difference', valueType: 'DECIMAL', unit: 'Pa', precision: { kind: 'DECIMALS', digits: 0 },
      role: 'PROCESS_PARAMETER', criticality: 'NON_CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', evidence: 'NONE', target: '15',
      limits: { unit: 'Pa', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '10', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'COMPANY_STANDARD', ref: 'SOP-HVAC-001' } }] },
    });
    const room = {
      kind: 'phase', id: 'p-room', name: 'Check the room pressure difference', block: { type: 'G-11', version: '1' }, config: {},
      records: ['roomDp'], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
      signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } }, significant: true, riskClass: 'HIGH',
    };
    return [room, ...prep];
  });

describe('excursion notifications (IN-39, recipe-core 1051)', () => {
  let runId: string;
  let excursion: string;
  beforeAll(async () => {
    const issuer = await sbx.asPersona('issuer');
    runId = await importAndIssue(sbx, issuer, writePackage(sbx, withRoomCheck()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: KEY, item: 'roomDp', value: { kind: 'DECIMAL', value: '5', unit: 'Pa' }, source: { mode: 'MANUAL' } });
    const st = await execution.loadState(sbx.db.admin, runId);
    excursion = Object.values(st?.state.exceptions ?? {}).find((x) => x.type === 'ENVIRONMENT_EXCURSION')?.id ?? '';
    if (!excursion) throw new Error('SETUP: no excursion');
  });

  it('[IN-39] both departments are notified: an excursion at a room check is delivered to production and QA with the exception that caused it', async () => {
    const { rows } = await sbx.db.admin.query<{ department: string; event: string; subject_kind: string; subject_id: string; cause_exception_id: string; cause_signature_id: string | null; caused_by_person: string; message: string }>(
      `select department, event, subject_kind, subject_id::text, cause_exception_id, cause_signature_id, caused_by_person::text, message
         from recipe.notification where cause_batch_id = $1 order by department`,
      [runId],
    );
    const operator = personaIn(sbx, 'operator1').personId;
    expect(rows.map((r) => ({ ...r, message: undefined }))).toEqual([
      { department: 'PRODUCTION', event: 'ENVIRONMENT_EXCURSION', subject_kind: 'BATCH', subject_id: runId, cause_exception_id: excursion, cause_signature_id: null, caused_by_person: operator, message: undefined },
      { department: 'QA', event: 'ENVIRONMENT_EXCURSION', subject_kind: 'BATCH', subject_id: runId, cause_exception_id: excursion, cause_signature_id: null, caused_by_person: operator, message: undefined },
    ]);
    expect(rows[0]?.message).toMatch(/Room condition roomDp is outside its .* limit .*a deviation is required/);
    // Written in the transaction that registered the exception.
    const tx = await sbx.db.admin.query<{ same: boolean }>(
      `select (select xmin from recipe.exception_register where batch_id = $1 and exception_id = $2) = all (select xmin from recipe.notification where cause_batch_id = $1) as same`,
      [runId, excursion],
    );
    expect(tx.rows[0]?.same).toBe(true);
    // The notification centre lists it for each department, without a signature cause.
    // (The route is a GMP-installation route; this sandbox server runs the batch, so the view is read directly.)
    const app = { formatInstant: (us: string) => us } as unknown as AppContext;
    const views = await notificationViews(app, sbx.db.app, { personId: operator, departments: ['QA'] }, { subjectId: runId });
    expect(views.map((v) => [v.department, v.event, v.subjectKind, v.exceptionId, v.signatureId])).toEqual(
      expect.arrayContaining([['QA', 'ENVIRONMENT_EXCURSION', 'BATCH', excursion, undefined], ['PRODUCTION', 'ENVIRONMENT_EXCURSION', 'BATCH', excursion, undefined]]),
    );
  });

  it('[IN-39] the application role cannot write, change or delete an excursion notification, nor call the notifying trigger function', async () => {
    await expect(sbx.db.app.query("update recipe.notification set message = 'x' where cause_batch_id = $1", [runId])).rejects.toThrow(/permission denied/);
    await expect(sbx.db.app.query('delete from recipe.notification where cause_batch_id = $1', [runId])).rejects.toThrow(/permission denied/);
    await expect(
      sbx.db.app.query(
        "insert into recipe.notification (department, event, subject_kind, subject_id, subject_label, message, cause_batch_id, cause_exception_id, caused_by_person, caused_by_role) values ('QA', 'ENVIRONMENT_EXCURSION', 'BATCH', $1, 'x', 'x', $1, 'x', gen_random_uuid(), 'X')",
        [runId],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(sbx.db.app.query('select recipe.notify_departments_of_excursion()')).rejects.toThrow(/permission denied|trigger functions can only be called as triggers/);
    // A notification has exactly one kind of cause, even for the owner.
    await expect(
      sbx.db.admin.query(
        "insert into recipe.notification (department, event, subject_kind, subject_id, subject_label, message, caused_by_person, caused_by_role) values ('QA', 'ENVIRONMENT_EXCURSION', 'BATCH', $1, 'x', 'x', gen_random_uuid(), 'X')",
        [runId],
      ),
    ).rejects.toThrow(/notification_cause_check/);
  });
});
