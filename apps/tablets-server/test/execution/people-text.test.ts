/**
 * Lead TODO T4 of the Phase 2 exit (DI-34): engine texts shown to people named the MBR's internal ids ("Step
 * p-disp-bal@ is not enabled", "Clearance at p-disp-clear@ was not confirmed", "START_STEP p-disp-clear@" in the
 * timeline). The step screen, the run overview and the timeline now name the step by its document number and name;
 * the record keeps the engine's own text (the stored exception title and refusal are never rewritten).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { peopleText } from '../../src/features/execution/people-text.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { dcMini, importAndIssue, RunDriver, startExecServer, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

const CLEAR = 'p-disp-clear@';
const BAL = 'p-disp-bal@';

describe('T4: engine texts name steps and items as people do (DI-34)', () => {
  it('[DI-34] the step screen, the run overview and the timeline name the step by number and name; the stored title keeps the id', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', {
      type: 'RECORD_ENTRY',
      stepKey: CLEAR,
      entry: { kind: 'CLEARANCE_CHECK', answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'NOT_CONFIRMED' }, ...['NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const }))] },
    });
    const clear = await d.stepView('operator1', CLEAR);
    const bal = await d.stepView('operator1', BAL);
    const clearLabel = `${clear.step.number} ${clear.step.title}`;
    const balLabel = `${bal.step.number} ${bal.step.title}`;

    // The step screen of a step not enabled yet: its greyed Start names the step, not its key.
    const start = bal.actions.find((a) => a.action === 'START_STEP');
    expect(start?.available).toBe(false);
    expect(start?.reason).toContain(`Step ${balLabel} `);
    expect(start?.reason).not.toContain(BAL);

    // The exception the clearance raised, on its step and on the run overview.
    const shown = clear.exceptions.map((e) => e.title);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(`Clearance at step ${clearLabel} was not confirmed`);
    const run = await d.runView('operator1');
    expect(run.exceptions.map((e) => e.title)).toEqual(shown);

    // The timeline.
    const timeline = await d.browser('operator1').call(routes.execution.timeline, { params: { runId } });
    if (!timeline.ok) throw new Error('timeline refused');
    const summaries = timeline.value.entries.map((e) => e.summary).join(' | ');
    expect(summaries).toContain(`START_STEP step ${clearLabel}`);
    expect(summaries).not.toContain(CLEAR);

    // A refused command's answer names the step too; the refused row keeps the engine's text.
    const refused = await d.command('operator1', { type: 'START_STEP', stepKey: BAL });
    const why = refused.ok || refused.error.kind !== 'REFUSAL' ? '' : refused.error.envelope.refusal.why;
    expect(why).toContain(`Step ${balLabel} is not enabled`);
    expect(why).not.toContain(BAL);
    const row = await server.db.admin.query<{ message: string }>("select refusal ->> 'message' as message from recipe.execution_command where batch_id = $1 and not accepted order by seq desc limit 1", [runId]);
    expect(row.rows[0]?.message).toContain(`Step ${BAL} is not enabled`);

    // The record keeps the engine's text.
    const stored = await server.db.admin.query<{ titles: string[] }>("select array(select e ->> 'title' from jsonb_each(state -> 'exceptions') x(k, e)) as titles from recipe.execution_state where batch_id = $1", [runId]);
    expect(stored.rows[0]?.titles.join(' ')).toContain(`Clearance at ${CLEAR} was not confirmed`);
  }, 180_000);

  it('[DI-34] only ids of this MBR are replaced, as whole tokens; a step or item id that reads as a word is left inside a sentence', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
    const { def } = await runContext(server.db.app, runId);
    const say = (text: string) => peopleText({ def, person: (id) => (id === '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e51' ? 'TEST-Asha Rao' : null) }, text);
    const n = (key: string) => {
      const id = key.slice(0, key.indexOf('@'));
      const node = [...def.steps.values()].find((s) => s.node.id === id);
      return node?.node.name ?? '';
    };
    expect(say(`Step ${CLEAR} is in progress: START_STEP is not possible (ENG-STEP-STATUS; DI-34)`)).toMatch(new RegExp(`^Step [0-9.]+ ${n(CLEAR)} is in progress`));
    expect(say(`cannot verify step ${CLEAR}.`)).toMatch(new RegExp(`^cannot verify step [0-9.]+ ${n(CLEAR)}\\.$`));
    expect(say(`Step p-unknown@ has not been reached`)).toBe('Step p-unknown@ has not been reached');
    expect(say(`Step ${CLEAR}x is unknown`)).toBe(`Step ${CLEAR}x is unknown`);
    expect(say('3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e51 does not hold a role; 00000000-0000-4000-8000-000000000000 neither')).toBe('TEST-Asha Rao does not hold a role; 00000000-0000-4000-8000-000000000000 neither');
    const item = def.mbr.parameters.find((p) => /[A-Z0-9_-]/.test(p.id));
    if (item) expect(say(`${item.id} takes a decimal value with a unit`)).toBe(`${item.name} takes a decimal value with a unit`);
  }, 180_000);
});
