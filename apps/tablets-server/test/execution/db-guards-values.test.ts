/**
 * Review P29 (PR-49, DI-14, DI-34): the database guards of a test-run row are NULL-safe (recipe-core 0270). A guard
 * written `x <> v` or `x not in (...)` let an absent value through, because PL/pgSQL IF treats NULL as false: a
 * proposed disposition without an outcome, an engine actor without a kind, a state without a schema and a SWEEP row
 * without a command type were all recorded. Each is now refused; each has an honest control that is accepted.
 * The blank test of a proposed justification is the engine's (JavaScript's trim, recipe.js_trim): btrim removed
 * ASCII spaces only, so a tab or an ideographic space was a "justification", and a disposition with an empty
 * justification could be committed under a valid signature. The engine's disposition rules (DEVIATION_RAISED only
 * with a linked deviation, never NO_IMPACT where a deviation is needed) hold in the database too.
 *
 * Review P33 (DI-05, PR-10, INV-27): TEST- batch numbers are never cut back to four digits. Addressed by recipe-core
 * 0240 (the serial is written in full); this test confirms it past serial 9999 without a restore.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { openServiceSession } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOfBrowser } from '../esig/support.ts';
import { appendAs, engineResult, interceptSigned } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

/** The error code a promise is rejected with (EBMR-XXX-NNN), or 'ok'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

async function driver(personas: string[]): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await sbx.asPersona(p);
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

describe('P29: absent values are refused, never passed', () => {
  it('[PR-49][DI-37] a proposed disposition without an outcome, with an outcome of null or with a justification that is not a text is refused', async () => {
    const d = await driver(['operator1', 'qa1']);
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
    if (!exception) throw new Error('no exception');
    const propose = async (proposal: unknown) => {
      d.beforeTap();
      return codeOf(withCommand(sbx.db.app, await actorOfBrowser(sbx, d.browser('qa1'), 'qa1'), (c) => c.query('select recipe.propose_disposition($1, $2, $3::jsonb)', [d.runId, exception, JSON.stringify(proposal)])));
    };
    const outcomes = {
      nullOutcome: await propose({ outcome: null, justification: 'x', deviationRef: null }),
      missingOutcome: await propose({ x: 1, justification: 'x', deviationRef: null }),
      numberJustification: await propose({ outcome: 'NO_IMPACT', justification: 5, deviationRef: null }),
      missingDeviationRef: await propose({ outcome: 'NO_IMPACT', justification: 'x', y: null }),
      control: await propose({ outcome: 'NO_IMPACT', justification: 'Reprint reconciled; no impact.', deviationRef: null }),
    };
    expect(outcomes).toEqual({ nullOutcome: 'EBMR-EXE-084', missingOutcome: 'EBMR-EXE-084', numberJustification: 'EBMR-EXE-084', missingDeviationRef: 'EBMR-EXE-084', control: 'ok' });
    const { rows } = await sbx.db.admin.query<{ proposal: Record<string, unknown> }>('select proposal from recipe.execution_disposition_proposal where batch_id = $1 order by id', [d.runId]);
    expect(rows.map((r) => r.proposal)).toEqual([{ outcome: 'NO_IMPACT', justification: 'Reprint reconciled; no impact.', deviationRef: null }]);
  }, 240_000);

  /** A run with helpers: operator1 raises an exception; qa1 proposes a disposition through the application role; the stored proposals. */
  async function proposals(personas: string[] = ['operator1', 'qa1']) {
    const d = await driver(personas);
    const raise = async (severity: 'ALERT' | 'ACTION', description: string) => {
      const before = new Set((await d.runView('qa1')).exceptions.map((e) => e.exceptionId));
      await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description, severity });
      const id = (await d.runView('qa1')).exceptions.map((e) => e.exceptionId).find((e) => !before.has(e));
      if (!id) throw new Error('SETUP: no exception');
      return id;
    };
    const propose = async (exception: string, proposal: unknown) => {
      d.beforeTap();
      return codeOf(withCommand(sbx.db.app, await actorOfBrowser(sbx, d.browser('qa1'), 'qa1'), (c) => c.query('select recipe.propose_disposition($1, $2, $3::jsonb)', [d.runId, exception, JSON.stringify(proposal)])));
    };
    const stored = async () => (await sbx.db.admin.query<{ proposal: { outcome: string; justification: string; deviationRef: string | null } }>('select proposal from recipe.execution_disposition_proposal where batch_id = $1 order by id', [d.runId])).rows.map((r) => r.proposal);
    return { d, raise, propose, stored };
  }

  it('[PR-49][DI-37] a proposed justification of only white space, ASCII or not (a tab, a line break, a no-break or an ideographic space), is refused', async () => {
    const { raise, propose, stored } = await proposals();
    const exception = await raise('ALERT', 'Label printer jammed once; label reprinted');
    const blanks = { tabs: '\t\n', nbsp: '\u00a0\u00a0', ideographic: '\u3000', bom: '\ufeff', separators: '\u2028\u2029', spaces: '   ', mixed: ' \u3000\t\u00a0\r\n' };
    const outcomes: Record<string, string> = {};
    for (const [name, justification] of Object.entries(blanks)) outcomes[name] = await propose(exception, { outcome: 'NO_IMPACT', justification, deviationRef: null });
    outcomes['control'] = await propose(exception, { outcome: 'NO_IMPACT', justification: '\u3000Reprint reconciled; no impact.\t', deviationRef: null });
    expect(outcomes).toEqual({ ...Object.fromEntries(Object.keys(blanks).map((k) => [k, 'EBMR-EXE-084'])), control: 'ok' });
    expect((await stored()).map((p) => p.justification)).toEqual(['\u3000Reprint reconciled; no impact.\t']);
  }, 240_000);

  it('[PR-49][DI-37] a proposed justification that shows nothing (zero-width characters, a word joiner, a soft hyphen, annotation or format controls), which JavaScript\'s trim keeps, is refused as blank; the honest signing of such a disposition stops at the challenge and records nothing', async () => {
    const { d, raise, propose, stored } = await proposals();
    const exception = await raise('ALERT', 'Label printer jammed once; label reprinted');
    // Written as code points, so the source holds no invisible character.
    const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
    const blanks = {
      zeroWidthSpace: cp(0x200b),
      wordJoiner: cp(0x2060),
      softHyphen: cp(0xad),
      mongolianVowelSeparator: cp(0x180e),
      joiners: cp(0x200d, 0x200c),
      annotation: cp(0xfff9, 0xfffb),
      hieroglyphFormat: cp(0x13430),
      mixed: `${cp(0x3000)}${cp(0x200b)}\t${cp(0x2060)}`,
    };
    const outcomes: Record<string, string> = {};
    for (const [name, justification] of Object.entries(blanks)) outcomes[name] = await propose(exception, { outcome: 'NO_IMPACT', justification, deviationRef: null });
    const control = `${cp(0x200b)}Reprint reconciled; no impact.`;
    outcomes['control'] = await propose(exception, { outcome: 'NO_IMPACT', justification: control, deviationRef: null });
    expect(outcomes).toEqual({ ...Object.fromEntries(Object.keys(blanks).map((k) => [k, 'EBMR-EXE-084'])), control: 'ok' });
    expect((await stored()).map((p) => p.justification)).toEqual([control]);

    const out = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: blanks.zeroWidthSpace });
    expect({ stage: out.stage, ok: out.result.ok }).toEqual({ stage: 'challenge', ok: false });
    expect(JSON.stringify(out.result)).toMatch(/EBMR-EXE-084/);
    const x = (await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions[exception];
    const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [`${d.runId}:${exception}`]);
    expect({ status: x?.status, disposition: x?.disposition ?? null, signatures: rows[0]?.n }).toEqual({ status: 'OPEN', disposition: null, signatures: '0' });
    expect((await stored()).map((p) => p.justification)).toEqual([control]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[PR-49][DI-37][INV-10] an application that lets a white-space justification through its own checks cannot record a disposition with an empty justification', async () => {
    const { d, raise, stored } = await proposals();
    const exception = await raise('ALERT', 'Label printer jammed once; label reprinted');
    const BLANK = '\u3000\u3000';
    // The attacker application: its own blank checks (the server's and the engine's, String.prototype.trim) let BLANK
    // through, and the state it records holds what an honest trim makes of it, an empty justification.
    const trim = Object.getOwnPropertyDescriptor(String.prototype, 'trim');
    if (!trim) throw new Error('SETUP: no trim');
    const honest = trim.value as (this: string) => string;
    Object.defineProperty(String.prototype, 'trim', {
      ...trim,
      value: function (this: string): string {
        const text = String(this);
        return text === BLANK ? text : honest.call(text);
      },
    });
    let r: { out: Awaited<ReturnType<RunDriver['sign']>>; calls: number; error: unknown } | undefined;
    try {
      r = await interceptSigned(
        'DISPOSITION_EXCEPTION',
        async (tx, command, roles) => {
          const res = engineResult(tx, command);
          const x = res.state.exceptions[exception];
          if (!x?.disposition) throw new Error('SETUP: the engine recorded no disposition');
          x.disposition = { ...x.disposition, justification: '' };
          await appendAs(tx, command, res, roles);
          return res;
        },
        () => d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: BLANK }),
      );
    } finally {
      Object.defineProperty(String.prototype, 'trim', trim);
    }
    if (!r) throw new Error('SETUP: the signing did not run');
    const x = (await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions[exception];
    const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [`${d.runId}:${exception}`]);
    expect({ signed: r.out.result.ok, status: x?.status, justification: x?.disposition?.justification ?? null, signatures: rows[0]?.n }).toEqual({ signed: false, status: 'OPEN', justification: null, signatures: '0' });
    // The proposal itself was refused (EBMR-EXE-084), so nothing blank was ever offered for signing.
    expect(JSON.stringify(r.out.result)).toMatch(/EBMR-EXE-084/);
    expect(await stored()).toEqual([]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[PR-49][PR-08] a proposal DEVIATION_RAISED without a linked deviation, or NO_IMPACT on an exception that needs a deviation, is refused', async () => {
    const { d, raise, propose, stored } = await proposals(['operator1', 'qa1', 'supervisor1']);
    const alert = await raise('ALERT', 'Label printer jammed once; label reprinted');
    const action = await raise('ACTION', 'Wrong label roll loaded; batch labels checked');
    const why = 'Investigated; see the linked deviation.';
    const before = {
      raisedWithoutLink: await propose(alert, { outcome: 'DEVIATION_RAISED', justification: why, deviationRef: null }),
      noImpactWhereNeeded: await propose(action, { outcome: 'NO_IMPACT', justification: why, deviationRef: null }),
      alertNoImpact: await propose(alert, { outcome: 'NO_IMPACT', justification: why, deviationRef: null }),
    };
    // The supervisor links the deviation the ACTION exception needs.
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: action, deviationRef: 'TEST-DEV-0001' });
    const after = {
      noImpactWhereNeeded: await propose(action, { outcome: 'NO_IMPACT', justification: why, deviationRef: 'TEST-DEV-0001' }),
      raised: await propose(action, { outcome: 'DEVIATION_RAISED', justification: why, deviationRef: 'TEST-DEV-0001' }),
    };
    expect({ before, after }).toEqual({
      before: { raisedWithoutLink: 'EBMR-EXE-084', noImpactWhereNeeded: 'EBMR-EXE-084', alertNoImpact: 'ok' },
      after: { noImpactWhereNeeded: 'EBMR-EXE-084', raised: 'ok' },
    });
    expect((await stored()).map((p) => `${p.outcome}/${p.deviationRef ?? '-'}`)).toEqual(['NO_IMPACT/-', 'DEVIATION_RAISED/TEST-DEV-0001']);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-14][DI-34][INV-26] an engine actor without a kind, an engine state without a schema and a state version that is not a JSON number are refused', async () => {
    const d = await driver(['operator1']);
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1');
    const start = async (forge: 'none' | 'kind' | 'schema' | 'version') => {
      d.beforeTap();
      return codeOf(
        withCommand(sbx.db.app, await actorOfBrowser(sbx, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: engineActor(me.personId, roles), step: 'p-disp-clear', context: [] };
          const r = engine.step(run.def, tx.state, command, { nowUs: tx.nowUs });
          if (!r.accepted) throw new Error(`SETUP: the engine refused the start: ${JSON.stringify(r.refusal)}`);
          const encoded = engine.encodeCommand(command) as Record<string, engine.JsonValue>;
          const actorWithoutKind = { ...(encoded['actor'] as Record<string, engine.JsonValue>) };
          delete actorWithoutKind['kind'];
          const stateWithoutSchema: Partial<engine.BatchState> = { ...r.state };
          delete stateWithoutSchema.schema;
          return execution.appendExecution(c, {
            batchId: d.runId,
            expectedSeq: tx.lastSeq,
            kind: 'COMMAND',
            command: forge === 'kind' ? { ...encoded, actor: actorWithoutKind } : encoded,
            commandId: command.commandId,
            nowUs: tx.nowUs,
            accepted: true,
            state: forge === 'schema' ? (stateWithoutSchema as unknown as engine.BatchState) : forge === 'version' ? ({ ...r.state, version: String(r.state.version) } as unknown as engine.BatchState) : r.state,
            events: r.events,
            roles,
            contents: [],
          });
        }),
      );
    };
    const outcomes = { kind: await start('kind'), schema: await start('schema'), version: await start('version'), control: await start('none') };
    expect(outcomes).toEqual({ kind: 'EBMR-EXE-039', schema: 'EBMR-EXE-030', version: 'EBMR-EXE-030', control: 'ok' });
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.kind === 'COMMAND')).toHaveLength(1);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[INV-20][DI-34] a SWEEP row whose command names no type is refused, even from the sweeper', async () => {
    const d = await driver([]);
    const run = await runContext(sbx.db.admin, d.runId);
    const sweeper = await openServiceSession(sbx.db, sbx.seed, 'sweeper');
    const sweep = (command: engine.JsonValue) =>
      codeOf(
        withCommand(sbx.db.app, { ...sweeper, correlationId: randomUUID() }, async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          // The engine's sweep at the transaction's time: its state keeps the time bookkeeping at the database clock
          // (recipe-core 0299, EBMR-EXE-025), so only the command's type decides.
          const r = engine.sweep(run.def, tx.state, { nowUs: tx.nowUs });
          return execution.appendExecution(c, { batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'SWEEP', command, commandId: `SWEEP:${randomUUID()}`, nowUs: tx.nowUs, accepted: true, state: r.state, events: r.events, roles: [], contents: engine.changedContents(run.def, tx.state, r.state) });
        }),
      );
    expect({ untyped: await sweep({}), control: await sweep({ type: 'SWEEP' }) }).toEqual({ untyped: 'EBMR-EXE-038', control: 'ok' });
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.kind === 'SWEEP').map((x) => x.command_type)).toEqual(['SWEEP']);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});

describe('P33: TEST- batch numbers past serial 9999', () => {
  it('[INV-27][DI-05][PR-10] serials 10000 and 10001 are written in full and give two distinct TEST- numbers', async () => {
    const issuer = await sbx.asPersona('issuer');
    await sbx.db.admin.query("select pg_catalog.setval('recipe.test_batch_number_seq', 9999, true)");
    const numbers: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
      const { rows } = await sbx.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [runId]);
      numbers.push(rows[0]?.n ?? '');
    }
    expect(numbers.map((n) => /^TEST-B\d{2}-(\d+)$/.exec(n)?.[1])).toEqual(['10000', '10001']);
    expect(new Set(numbers).size).toBe(2);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});
