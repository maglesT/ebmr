/**
 * Review P25 (PR-49, DI-37, DI-26, INV-41, INV-10; Part 11 signature/record linking; EU GMP Annex 11 section 14) and
 * its round-1 and round-2 verifications: the database, not the server, binds an exception's disposition to what was
 * signed, keeps an operator's exception as its command raised it, stores a limit exception as the value and the MBR's
 * limits give it, and issues a test batch only from a state in which nothing has been done yet (recipe-core 0270,
 * 0298, 0305). ADR 0012: each forgery below is the application role (ebmr_sandbox here)
 * writing through the store directly, inside a correctly attributed command; the TypeScript checks it would have to
 * pass are bypassed by rewriting the command or the state on its way to the store.
 *
 * The guards covered:
 *   - recipe.check_disposition_proposal: the outcome, the justification and the linked deviation are the proposal's,
 *     and the proposal was prepared by the signer;
 *   - recipe.check_disposition_state: the state records the disposition by the signer, under the one signature used;
 *   - recipe.check_exception_changes: an operator's exception has the facts its RAISE_EXCEPTION gives it (0298), and a
 *     limit exception the facts the verdict on its value gives it (0305);
 *   - recipe.issue_execution / recipe.check_issued_state: the ISSUE row's state records no act of a person (0298).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { openPersonaSession, passwordActor } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, interceptSigned, messageOf, prepareSignature, unmatched } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, RunDriver, startExecServer, violations, withEarlyHoldPoint, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const SIGNED = 'Reprint reconciled; no impact on the batch.';

async function driver(content = dcMini(), personas: string[] = ['operator1', 'supervisor1', 'qa1']): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await sbx.asPersona(p);
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** A run with one open ALERT exception raised by operator1 (no step, no deviation needed). */
async function withException(): Promise<{ d: RunDriver; exception: string }> {
  const d = await driver();
  await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
  const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
  if (!exception) throw new Error('SETUP: no exception');
  return { d, exception };
}

/** What was recorded: the exception's status, outcome and justification, and its EXCEPTION_DISPOSITIONED signatures. */
async function recorded(runId: string, exception: string) {
  const st = await execution.loadState(sbx.db.admin, runId);
  const x = st?.state.exceptions[exception];
  const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [`${runId}:${exception}`]);
  return { status: x?.status, outcome: x?.disposition?.outcome ?? null, justification: x?.disposition?.justification ?? null, signatures: Number(rows[0]?.n) };
}

/** The proposal the signature on the exception's current content version covers. */
async function signedProposal(runId: string, exception: string): Promise<unknown> {
  const agg = `${runId}:${exception}`;
  const { rows } = await sbx.db.admin.query<{ p: unknown }>(
    'select recipe.current_proposal($1::text, (select max(content_version) from recipe.execution_exception_content where aggregate_id = $1::text)) as p',
    [agg],
  );
  return rows[0]?.p ?? null;
}

/**
 * `persona` signs the exception through the kernel (the challenge covers the proposal made last on its current
 * content version) and, in the same command, records DISPOSITION_EXCEPTION with `outcome` and `justification`: the
 * engine accepts it, so only the database decides. Returns 'ok' or the refusal.
 */
async function signAndDisposition(d: RunDriver, persona: string, exception: string, outcome: 'NO_IMPACT' | 'DEVIATION_RAISED', justification: string): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, persona);
  const p = await prepareSignature(sbx, d.browser(persona), persona, 'batch_exception', `${d.runId}:${exception}`, 'EXCEPTION_DISPOSITIONED');
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = {
        type: 'DISPOSITION_EXCEPTION',
        commandId: randomUUID(),
        actor: engineActor(who.personId, roles),
        exception,
        outcome,
        justification,
        signature: { id, meaning: 'EXCEPTION_DISPOSITIONED', signer: who.personId },
      };
      return appendAs(tx, command, engineResult(tx, command), roles);
    }),
  );
}

/** `persona` records a disposition proposal on the exception, in a command of their own. */
async function propose(d: RunDriver, persona: string, exception: string, proposal: execution.DispositionProposal): Promise<void> {
  await withCommand(sbx.db.app, await actorOf(sbx, d.browser(persona), persona), (c) => execution.proposeDisposition(c, d.runId, exception, proposal));
}

/** Grants `roleCode` to the persona's account: requested by the administrator, approved by the process owner. */
async function grantRole(key: string, roleCode: string): Promise<void> {
  const who = personaIn(sbx, key);
  const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: `P25: ${key} also holds ${roleCode}`, correlationId: randomUUID() });
  const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode, scope: {}, reason: `P25 regression: ${key} also holds ${roleCode}` }));
  const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: `P25: approve ${roleCode} for ${key}`, correlationId: randomUUID() });
  await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'P25 regression'));
}

describe('P25: an accepted DISPOSITION_EXCEPTION is the disposition its signature covers', () => {
  it('[PR-49][DI-37][INV-10][Part 11 11.70] a disposition signed NO_IMPACT and recorded as DEVIATION_RAISED is refused by the database (EBMR-EXE-086); the exception stays open', async () => {
    const { d, exception } = await withException();
    // A deviation is linked, so the engine accepts either outcome; the QA reviewer signs NO_IMPACT.
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception, deviationRef: 'TEST-DEV-0025' });
    const r = await interceptSigned(
      'DISPOSITION_EXCEPTION',
      async (tx, command, roles) => {
        if (command.type !== 'DISPOSITION_EXCEPTION') throw new Error('SETUP: not a disposition');
        const tampered: engine.Command = { ...command, outcome: 'DEVIATION_RAISED' };
        const res = engineResult(tx, tampered);
        await appendAs(tx, tampered, res, roles);
        return res;
      },
      () => d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: SIGNED }),
    );
    expect(r.out.stage).toBe('sign');
    expect(r.calls).toBe(1);
    expect(await signedProposal(d.runId, exception)).toEqual({ outcome: 'NO_IMPACT', justification: SIGNED, deviationRef: 'TEST-DEV-0025' });
    expect(String(r.error)).toMatch(/outcome, justification or linked deviation of the disposition .*is not the disposition its signature covers.*\[EBMR-EXE-086\]/);
    expect({ signOk: r.out.result.ok, ...(await recorded(d.runId, exception)) }).toEqual({ signOk: false, status: 'OPEN', outcome: null, justification: null, signatures: 0 });
    // The disposition as signed is recorded.
    expect((await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: SIGNED })).result.ok).toBe(true);
    expect(await recorded(d.runId, exception)).toEqual({ status: 'DISPOSITIONED', outcome: 'NO_IMPACT', justification: SIGNED, signatures: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[PR-49][DI-37][INV-10][DI-35] a disposition whose signed proposal was prepared by another person than the signer is refused (EBMR-EXE-086); prepared by the signer it is recorded', async () => {
    const { d, exception } = await withException();
    // The master-data steward also holds QA_SHOP_FLOOR and prepares the disposition in the office; qa1 signs it.
    await grantRole('steward', 'QA_SHOP_FLOOR');
    const office = await openPersonaSession(sbx.db, sbx.seed, 'steward');
    await withCommand(sbx.db.app, { ...office, roleCode: 'QA_SHOP_FLOOR', correlationId: randomUUID() }, (c) =>
      execution.proposeDisposition(c, d.runId, exception, { outcome: 'NO_IMPACT', justification: SIGNED, deviationRef: null }),
    );
    const { rows } = await sbx.db.admin.query<{ by: string }>('select proposed_by_person::text as by from recipe.execution_disposition_proposal where batch_id = $1 order by id desc limit 1', [d.runId]);
    expect(rows[0]?.by).toBe(personaIn(sbx, 'steward').personId);
    const other = await signAndDisposition(d, 'qa1', exception, 'NO_IMPACT', SIGNED);
    expect(other).toMatch(/was prepared by another person than the signer.*\[EBMR-EXE-086\]/);
    expect(await recorded(d.runId, exception)).toEqual({ status: 'OPEN', outcome: null, justification: null, signatures: 0 });
    // The same disposition, prepared by the signer, is recorded.
    await propose(d, 'qa1', exception, { outcome: 'NO_IMPACT', justification: SIGNED, deviationRef: null });
    expect(await signAndDisposition(d, 'qa1', exception, 'NO_IMPACT', SIGNED)).toBe('ok');
    expect(await recorded(d.runId, exception)).toEqual({ status: 'DISPOSITIONED', outcome: 'NO_IMPACT', justification: SIGNED, signatures: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[PR-49][DI-37][INV-10] a state that records the disposition under another person or another signature id than the signed command is refused (EBMR-EXE-086)', async () => {
    const { d, exception } = await withException();
    const operator = personaIn(sbx, 'operator1').personId;
    const forge = async (edit: (disposition: NonNullable<engine.ExceptionRecord['disposition']>) => void): Promise<string> => {
      const r = await interceptSigned(
        'DISPOSITION_EXCEPTION',
        async (tx, command, roles) => {
          const res = engineResult(tx, command);
          const x = res.state.exceptions[exception];
          if (!x?.disposition) throw new Error('SETUP: the engine recorded no disposition');
          edit(x.disposition);
          await appendAs(tx, command, res, roles);
          return res;
        },
        () => d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: SIGNED }),
      );
      expect(r.calls).toBe(1);
      return String(r.error);
    };
    // Each forgery is judged before the next one: an accepted forgery would close the exception, and the next
    // attempt would then fail for that reason instead of the rule under test.
    const another = /records another disposition of exception \S+ than the signed one.*\[EBMR-EXE-086\]/;
    expect(
      await forge((x) => {
        x.by = operator;
      }),
      'recorded under another person',
    ).toMatch(another);
    expect(await recorded(d.runId, exception)).toEqual({ status: 'OPEN', outcome: null, justification: null, signatures: 0 });
    expect(
      await forge((x) => {
        x.signature = randomUUID();
      }),
      'recorded under another signature id',
    ).toMatch(another);
    expect(await recorded(d.runId, exception)).toEqual({ status: 'OPEN', outcome: null, justification: null, signatures: 0 });
    expect((await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: SIGNED })).result.ok).toBe(true);
    const st = await execution.loadState(sbx.db.admin, d.runId);
    const { rows } = await sbx.db.admin.query<{ id: string }>("select id::text from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [`${d.runId}:${exception}`]);
    expect(st?.state.exceptions[exception]?.disposition).toMatchObject({ by: personaIn(sbx, 'qa1').personId, signature: rows[0]?.id });
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[PR-49][DI-37][INV-10] a disposition whose signed proposal names no deviation, recorded after a deviation was linked without a new content version, is refused (EBMR-EXE-086)', async () => {
    const { d, exception } = await withException();
    const run = await runContext(sbx.db.admin, d.runId);
    await propose(d, 'qa1', exception, { outcome: 'NO_IMPACT', justification: SIGNED, deviationRef: null });
    // The supervisor links a deviation; the writer stores no new content version of the exception, so the proposal
    // above (deviationRef null) is still the one a signature on the exception covers.
    const sup = personaIn(sbx, 'supervisor1');
    await withCommand(sbx.db.app, await actorOf(sbx, d.browser('supervisor1'), 'supervisor1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'ATTACH_DEVIATION', commandId: randomUUID(), actor: engineActor(sup.personId, roles), exception, deviationRef: 'TEST-DEV-0026' };
      return appendAs(tx, command, engineResult(tx, command), roles, engine.encodeCommand(command), []);
    });
    expect(await signedProposal(d.runId, exception)).toEqual({ outcome: 'NO_IMPACT', justification: SIGNED, deviationRef: null });
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions[exception]?.deviation?.ref).toBe('TEST-DEV-0026');
    const unlinked = await signAndDisposition(d, 'qa1', exception, 'NO_IMPACT', SIGNED);
    expect(unlinked).toMatch(/outcome, justification or linked deviation of the disposition .*is not the disposition its signature covers.*\[EBMR-EXE-086\]/);
    expect(await recorded(d.runId, exception)).toEqual({ status: 'OPEN', outcome: null, justification: null, signatures: 0 });
    // A proposal that names the linked deviation is recorded.
    await propose(d, 'qa1', exception, { outcome: 'NO_IMPACT', justification: SIGNED, deviationRef: 'TEST-DEV-0026' });
    expect(await signAndDisposition(d, 'qa1', exception, 'NO_IMPACT', SIGNED)).toBe('ok');
    expect(await recorded(d.runId, exception)).toEqual({ status: 'DISPOSITIONED', outcome: 'NO_IMPACT', justification: SIGNED, signatures: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

describe('P25 follow-up: an operator\'s exception is stored as its command raised it (recipe-core 0298)', () => {
  it('[PR-49][PR-13][DI-26][INV-41] an ACTION exception stored as ALERT, without the need of a deviation or its block, with other flags, relabelled, or added by another row is refused (EBMR-EXE-044); the honest one is recorded and cannot be dispositioned NO_IMPACT', async () => {
    const d = await driver();
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1');
    /**
     * operator1 records `type` at the booth clearance with the engine's result, after `edit` changed it: the
     * exception a RAISE_EXCEPTION raised (and its EXCEPTION_RAISED event, so the forgery is coherent), or the state
     * and events of a START_STEP.
     */
    const record = async (type: 'RAISE_EXCEPTION' | 'START_STEP', edit?: (res: Pick<engine.StepResult, 'state' | 'events'>, x: engine.ExceptionRecord | undefined, nowUs: bigint) => void): Promise<string> =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const base = { commandId: randomUUID(), actor: engineActor(me.personId, roles), step: 'p-disp-clear', context: [] };
          const command: engine.Command = type === 'RAISE_EXCEPTION' ? { ...base, type, description: 'Booth door found open at start', severity: 'ACTION' } : { ...base, type };
          const res = engineResult(tx, command);
          const added = Object.values(res.state.exceptions).find((x) => tx.state.exceptions[x.id] === undefined);
          if (type === 'RAISE_EXCEPTION' && added?.type !== 'OPERATOR_RAISED') throw new Error('SETUP: the engine raised no operator exception');
          edit?.(res, added, tx.nowUs);
          return appendAs(tx, command, res, roles);
        }),
      );
    /** A forged operator's exception added to a row that does not raise one, with its event. */
    const addOperatorException = (res: Pick<engine.StepResult, 'state' | 'events'>, nowUs: bigint): void => {
      res.state.seq += 1;
      const x: engine.ExceptionRecord = {
        id: 'EX-99', type: 'OPERATOR_RAISED', category: 'DEVIATION_OR_OVERRIDE', title: `${me.personId}: Booth door found open`, controls: ['PR-13', 'PR-49'], severity: 'ALERT', source: { frames: [] },
        raisedAt: nowUs, raisedSeq: res.state.seq, raisedBy: me.personId, deviationRequired: false, registrationRelevant: false, qaOnly: false, stageSignOffBlocked: false, releaseBlocking: false, status: 'OPEN',
      };
      res.state.exceptions[x.id] = x;
      res.events.push({ type: 'EXCEPTION_RAISED', exception: x.id, exceptionType: x.type, severity: x.severity, title: x.title, controls: x.controls, seq: res.state.seq, at: nowUs });
    };
    /** Edits the operator's exception the RAISE_EXCEPTION raised. */
    const raised = (edit: (x: engine.ExceptionRecord) => void) => (_res: unknown, x: engine.ExceptionRecord | undefined): void => {
      if (x) edit(x);
    };
    const outcomes = {
      alert: await record(
        'RAISE_EXCEPTION',
        raised((x) => {
          x.severity = 'ALERT';
          x.deviationRequired = false;
          delete x.block;
        }),
      ),
      severity: await record('RAISE_EXCEPTION', raised((x) => void (x.severity = 'ALERT'))),
      noDeviationNeeded: await record('RAISE_EXCEPTION', raised((x) => void (x.deviationRequired = false))),
      unblocked: await record('RAISE_EXCEPTION', raised((x) => void delete x.block)),
      blocksNothing: await record(
        'RAISE_EXCEPTION',
        raised((x) => {
          if (!x.block?.downstream) throw new Error('SETUP: the ACTION exception has no downstream block');
          x.block.downstream.node = 'task:p-nowhere';
        }),
      ),
      qaOnly: await record('RAISE_EXCEPTION', raised((x) => void (x.qaOnly = true))),
      releaseBlocking: await record('RAISE_EXCEPTION', raised((x) => void (x.releaseBlocking = true))),
      retitled: await record('RAISE_EXCEPTION', raised((x) => void (x.title = `${me.personId}: Something else`))),
      relabelled: await record('RAISE_EXCEPTION', (res, x) => {
        if (!x) return;
        x.type = 'POST_ENTRY_CORRECTION';
        for (const e of res.events) if (e.type === 'EXCEPTION_RAISED' && e.exception === x.id) e.exceptionType = x.type;
      }),
      addedByStart: await record('START_STEP', (res, _x, nowUs) => addOperatorException(res, nowUs)),
    };
    const refused = /is not the exception its command raised.*\[EBMR-EXE-044\]/;
    expect(
      unmatched(outcomes, {
        alert: refused,
        severity: refused,
        noDeviationNeeded: refused,
        unblocked: refused,
        blocksNothing: refused,
        qaOnly: refused,
        releaseBlocking: refused,
        retitled: refused,
        relabelled: /RAISE_EXCEPTION of this row is not recorded in the state as the operator's exception.*\[EBMR-EXE-044\]/,
        addedByStart: /is an operator's exception, which only an accepted RAISE_EXCEPTION raises.*\[EBMR-EXE-044\]/,
      }),
    ).toEqual({});
    const before = await execution.loadState(sbx.db.admin, d.runId);
    expect(Object.keys(before?.state.exceptions ?? {})).toEqual([]);
    // The honest command is recorded with the facts the engine gives it, and QA cannot call it "no impact".
    expect(await record('RAISE_EXCEPTION')).toBe('ok');
    const after = await execution.loadState(sbx.db.admin, d.runId);
    const [x] = Object.values(after?.state.exceptions ?? {});
    expect(x).toMatchObject({ type: 'OPERATOR_RAISED', severity: 'ACTION', deviationRequired: true, qaOnly: false, releaseBlocking: false, raisedBy: me.personId, block: { steps: [], until: 'DEVIATION', downstream: { node: 'task:p-disp-clear', frames: [] } } });
    const noImpact = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception: x?.id ?? '', outcome: 'NO_IMPACT', justification: SIGNED });
    expect(noImpact.result.ok).toBe(false);
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions[x?.id ?? '']?.status).toBe('OPEN');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

describe('P25 round-2 verification: a limit exception is stored as the value and the MBR\'s limits give it (recipe-core 0305)', () => {
  it('[PR-08][PR-49][DI-26][INV-41] a blend time outside its internal action limit stored as an ALERT without its deviation or block, with its tier relabelled, left out or not marked on its value is refused (EBMR-EXE-044); the honest exception is recorded and cannot be dispositioned NO_IMPACT', async () => {
    const d = await driver(withEarlyParameter(), ['operator1', 'qa1']);
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1');
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-early-time@' });
    /**
     * operator1 records a blend time of 19 min (the internal action limit is 12-18 min) with the engine's result, after
     * `edit` changed the limit exception it raised, its value or its EXCEPTION_RAISED event.
     */
    const record = async (edit?: (x: engine.ExceptionRecord, point: engine.DataPoint, res: Pick<engine.StepResult, 'state' | 'events'>) => void): Promise<string> =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = {
            type: 'RECORD_DATA', commandId: randomUUID(), actor: engineActor(me.personId, roles), step: 'p-early-time', context: [], item: 'blendTime',
            value: { kind: 'DECIMAL', value: '19', unit: 'min' }, source: { mode: 'MANUAL' },
          };
          const res = engineResult(tx, command);
          const x = Object.values(res.state.exceptions).find((e) => tx.state.exceptions[e.id] === undefined && e.type === 'LIMIT_BREACH');
          const point = Object.values(res.state.points).find((p) => tx.state.points[p.id] === undefined);
          if (!x || !point) throw new Error('SETUP: the engine raised no limit exception for 19 min');
          edit?.(x, point, res);
          return appendAs(tx, command, res, roles);
        }),
      );
    /** The EXCEPTION_RAISED event of `x` says what the forged exception says (a coherent forgery). */
    const told = (x: engine.ExceptionRecord, res: Pick<engine.StepResult, 'events'>): void => {
      for (const e of res.events) if (e.type === 'EXCEPTION_RAISED' && e.exception === x.id) Object.assign(e, { severity: x.severity, tier: x.tier });
    };
    const outcomes = {
      // The verification's forgery: an ALERT of tier ALERT that needs no deviation and stops nothing.
      storedAsAlert: await record((x, _p, res) => {
        Object.assign(x, { severity: 'ALERT', tier: 'ALERT', deviationRequired: false, releaseBlocking: false });
        delete x.block;
        told(x, res);
      }),
      severityLowered: await record((x, _p, res) => {
        x.severity = 'ALERT';
        told(x, res);
      }),
      deviationDropped: await record((x) => void (x.deviationRequired = false)),
      blockDropped: await record((x) => void delete x.block),
      tierRelabelled: await record((x, _p, res) => {
        x.tier = 'ALERT';
        told(x, res);
      }),
      leftOut: await record((x, p, res) => {
        delete res.state.exceptions[x.id];
        p.exceptions = p.exceptions.filter((id) => id !== x.id);
        res.events = res.events.filter((e) => !(e.type === 'EXCEPTION_RAISED' && e.exception === x.id));
      }),
      notFailed: await record((_x, p) => void (p.failed = false)),
    };
    const refused = /The limit verdicts of this COMMAND row are not recorded as the engine gives them: .*\[EBMR-EXE-044\]/;
    expect(
      unmatched(outcomes, {
        storedAsAlert: /exception EX-1 \(LIMIT_BREACH, tier ALERT, severity ALERT\) is not an exception a verdict of this row raises.*\[EBMR-EXE-044\]/,
        severityLowered: refused,
        deviationDropped: refused,
        blockDropped: refused,
        tierRelabelled: refused,
        leftOut: /blendTime of step p-early-time@\) is outside its internal action limit, and the state does not record the LIMIT_BREACH exception that verdict raises.*\[EBMR-EXE-044\]/,
        notFailed: /it is outside its limits and not marked failed.*\[EBMR-EXE-044\]/,
      }),
    ).toEqual({});
    expect(Object.keys((await execution.loadState(sbx.db.admin, d.runId))?.state.points ?? {})).toEqual([]);
    // The honest command is recorded with the facts the engine gives the breach, and QA cannot call it "no impact".
    expect(await record()).toBe('ok');
    const [x] = Object.values((await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions ?? {});
    expect(x).toMatchObject({
      type: 'LIMIT_BREACH', severity: 'ACTION', tier: 'INTERNAL_ACTION', deviationRequired: true, qaOnly: false, releaseBlocking: false, raisedBy: me.personId,
      title: 'Blend time (blendTime) 19 min is outside its internal action limit (internal action high limit; alert high limit): this step and the steps after it wait until a deviation is linked',
      block: { steps: ['p-early-time@'], until: 'DEVIATION', downstream: { node: 'task:p-early-time', frames: [] } },
    });
    const noImpact = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception: x?.id ?? '', outcome: 'NO_IMPACT', justification: 'Within the registered limit; no impact on the batch.' });
    expect(noImpact.result.ok).toBe(false);
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions[x?.id ?? '']?.status).toBe('OPEN');
    expect(await violations(sbx)).toEqual([]);
    expect(await execution.replayExecution(sbx.db.admin, run.def, d.runId)).toMatchObject({ identical: true, firstDifference: null });
  }, 300_000);
});

describe('P25 follow-up: a test batch is issued from the engine\'s initial state (recipe-core 0298)', () => {
  it('[DI-34][INV-41][PR-45][PR-49] an ISSUE row whose state already records a hold-point decision, a closed, linked or operator\'s exception, a data point, a performer or a signature is refused; the honest issue is recorded', async () => {
    const issuer = await sbx.asPersona('issuer');
    const firstRun = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyHoldPoint()));
    const run = await runContext(sbx.db.admin, firstRun);
    const who = personaIn(sbx, 'issuer');
    const operator = personaIn(sbx, 'operator1').personId;
    /** Issues a batch of the same package as the issuer, with the engine's initial state changed by `edit`. */
    const issueWith = async (edit?: (s: engine.BatchState, events: engine.EngineEvent[]) => void): Promise<string> =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, issuer, 'issuer'), async (c) => {
          const batchId = randomUUID();
          const begun = await execution.beginIssue(c, batchId);
          const request: engine.IssueRequest = {
            batchId,
            batchNumber: begun.batchNumber,
            batchSize: run.batch.batchSize,
            marketSet: ['IN'],
            purpose: 'VALIDATION',
            variants: {},
            inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'P25 regression' } },
            issuedBy: { id: who.personId, kind: 'PERSON', roles: [] },
          };
          const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
          edit?.(r.state, r.events);
          await execution.issueExecution(c, {
            batchId,
            packageHash: run.batch.packageHash,
            batchNumber: begun.batchNumber,
            request: engine.encode(request),
            policy: execution.pinnedPolicy(run.def.policy),
            registryFingerprint: run.def.registry.fingerprint(),
            engineVersion: engine.ENGINE_VERSION,
            nowUs: begun.nowUs,
            state: r.state,
            events: r.events,
            contents: engine.changedContents(run.def, undefined, r.state),
          });
        }),
      );
    /** An exception raised by the issuer at issue, with its event (so only the rules on its facts decide). */
    const exception = (s: engine.BatchState, events: engine.EngineEvent[], extra: Partial<engine.ExceptionRecord>): void => {
      const x: engine.ExceptionRecord = {
        id: 'EX-1', type: 'DECISION_NOT_EVALUABLE', category: 'FLOW', title: 'Forged at issue', controls: ['DI-34'], severity: 'ACTION', source: { frames: [] },
        raisedAt: s.header.issuedAt, raisedSeq: s.seq + 1, raisedBy: who.personId, deviationRequired: true, registrationRelevant: false, qaOnly: false,
        stageSignOffBlocked: false, releaseBlocking: false, status: 'OPEN', ...extra,
      };
      s.seq += 1;
      s.exceptions[x.id] = x;
      events.push({ type: 'EXCEPTION_RAISED', exception: x.id, exceptionType: x.type, severity: x.severity, title: x.title, controls: x.controls, seq: s.seq, at: s.header.issuedAt });
    };
    const first = (s: engine.BatchState): engine.StepInstance => {
      const i = Object.values(s.steps)[0];
      if (!i) throw new Error('SETUP: no step is enabled at issue');
      return i;
    };
    const batches = async (): Promise<string> => (await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.batch_execution')).rows[0]?.n ?? '';
    const issued = await batches();
    const outcomes = {
      holdDecision: await issueWith((s) => {
        s.steps['H-TEST@'] = { ...first(s), key: 'H-TEST@', step: 'H-TEST', kind: 'HOLD', status: 'COMPLETED', disposition: { value: 'APPROVED', positive: true, by: operator, signature: randomUUID(), at: s.header.issuedAt } };
      }),
      closedException: await issueWith((s, e) => {
        exception(s, e, { status: 'DISPOSITIONED', disposition: { by: operator, outcome: 'NO_IMPACT', justification: 'Closed before the batch began', signature: randomUUID(), at: s.header.issuedAt } });
      }),
      linkedException: await issueWith((s, e) => {
        exception(s, e, { deviation: { ref: 'TEST-DEV-0027', linkedBy: operator, at: s.header.issuedAt } });
      }),
      operatorException: await issueWith((s, e) => {
        exception(s, e, { type: 'OPERATOR_RAISED', category: 'DEVIATION_OR_OVERRIDE', title: `${who.personId}: forged`, controls: ['PR-13', 'PR-49'], severity: 'ALERT', deviationRequired: false });
      }),
      dataPoint: await issueWith((s) => {
        const i = first(s);
        s.points['PT-1'] = { id: 'PT-1', item: 'balanceCheck', stepKey: i.key, step: i.step, frames: [], attempt: 1, version: 1, kind: 'VALUE', value: { kind: 'BOOLEAN', value: true }, source: { mode: 'MANUAL' }, enteredBy: operator, recordedAt: s.header.issuedAt, recordedSeq: 1, timeBasis: 'RECORDED_AT', status: 'VALID', failed: false, flags: [], exceptions: [] };
      }),
      performer: await issueWith((s) => {
        first(s).performers.push(operator);
      }),
      startedStep: await issueWith((s) => {
        const i = first(s);
        i.status = 'IN_PROGRESS';
        i.startedAt = s.header.issuedAt;
      }),
      usedSignature: await issueWith((s) => {
        s.usedSignatures[randomUUID()] = 'batch issued';
      }),
    };
    expect(
      unmatched(outcomes, {
        holdDecision: /records a decision on hold point H-TEST@ without its own signed decision.*\[EBMR-EXE-044\]/,
        closedException: /Exception EX-1 is raised by this row already dispositioned or linked.*\[EBMR-EXE-044\]/,
        linkedException: /Exception EX-1 is raised by this row already dispositioned or linked.*\[EBMR-EXE-044\]/,
        operatorException: /Exception EX-1 is an operator's exception, which only an accepted RAISE_EXCEPTION raises.*\[EBMR-EXE-044\]/,
        dataPoint: /The issued state already records data points.*\[EBMR-EXE-030\]/,
        performer: /The issued state already records a step that was worked on.*\[EBMR-EXE-030\]/,
        startedStep: /The issued state already records a step that was worked on.*\[EBMR-EXE-030\]/,
        usedSignature: /The issued state already records a signature.*\[EBMR-EXE-030\]/,
      }),
    ).toEqual({});
    expect(await batches()).toBe(issued);
    // The engine's own initial state is issued.
    expect(await issueWith()).toBe('ok');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});
