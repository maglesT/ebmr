/**
 * Phase 2 exit review F12, round 9 (the lane's round-2 verification; DI-05, DI-30, INV-26; recipe-core 0340; ADR 0012):
 * the roles an approval names.
 *
 * recipe-core 0335 held an approval's approver to {id, kind, roles}, the roles to a list of texts. recipe.check_signatures
 * (0297) reads the approver's kind, id and signature, and recipe.check_engine_roles binds the roles of the command's
 * actor only (the issuer's are bound at issue). The engine asks of an approver one supervisor or QA role and reads no
 * other, so the release gate's replay reproduces a row whatever else it names. Through the application role, on the
 * honest store and engine path, the round-2 verification recorded an accepted correction approved by qa1 as
 * ['QA', 'L2409-0017']: the real-format lot number sat in the command, 'ok', with an identical replay and no violation.
 * Now an accepted row's approval names only engine roles its approver holds, read from the authority behind the
 * approver's own signature (the signer's declared kernel role, through the permission the kernel evaluated for it, in
 * the role map of decision D4), and a refused row's approval only engine roles.
 *
 * The server offers no correction in this release (the intent is LATER), so, as in db-guards-corrections, the
 * application role (ebmr_sandbox here) records it through the store with signatures made through the kernel. Own file
 * and server: the kiosk's device nonces are rate-limited per terminal and minute.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { execution, type engine } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, messageOf, prepareSignature, signatureAlone, unmatched } from './db-guards-support.ts';
import { importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const EARLY = 'p-early-time@';
const LOT = 'L2409-0017';

/** A run whose first step records the blend time (CRITICAL, keyed by hand), performed by operator1 and verified by verifier1. */
async function verifiedRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyParameter()));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of ['operator1', 'verifier1', 'qa1']) browsers[p] = await sbx.asPersona(p);
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
  await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' });
  return d;
}

/** The id of the valid blend-time data point of a run. */
async function blendTimePoint(runId: string): Promise<string> {
  const st = await execution.loadState(sbx.db.admin, runId);
  const p = Object.values(st?.state.points ?? {}).find((x) => x.item === 'blendTime' && x.status === 'VALID');
  if (!p) throw new Error('SETUP: no blend time recorded');
  return p.id;
}

/** qa1's CORRECTION_APPROVED signature on the point, made in a command of its own, with the approver's roles as given. */
async function approvalOf(d: RunDriver, point: string, roles: readonly string[]): Promise<engine.Approval> {
  const qa1 = personaIn(sbx, 'qa1');
  const id = await signatureAlone(sbx, d.browser('qa1'), 'qa1', 'batch_point', `${d.runId}:${point}`, 'CORRECTION_APPROVED');
  return { approver: { id: qa1.personId, kind: 'PERSON', roles: [...roles] }, signature: { id, meaning: 'CORRECTION_APPROVED', signer: qa1.personId } };
}

/** `approval` with the approver's roles replaced (the signature stays qa1's own). */
const withRoles = (approval: engine.Approval, roles: readonly string[]): engine.Approval => ({ ...approval, approver: { ...approval.approver, roles: [...roles] } });

/**
 * operator1 corrects the blend time to 16 min through the honest store and engine path (ExecutionTx.command), signing
 * CORRECTED in the recording command: 'ok' when the engine accepted it and the row was recorded, else the refusal.
 */
async function correct(d: RunDriver, point: string, approval: engine.Approval): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const me = personaIn(sbx, 'operator1');
  const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_point', `${d.runId}:${point}`, 'CORRECTED');
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (client) => {
      const id = await p.sign(client);
      const tx = await execution.ExecutionTx.open(client, run.def, d.runId);
      const roles = await engineRoles(client);
      const r = await tx.command(
        { type: 'CORRECT_ENTRY', commandId: randomUUID(), actor: engineActor(me.personId, roles), point, value: { kind: 'DECIMAL', value: '16', unit: 'min' }, reason: 'Transcription error: the timer read 16 min', signature: { id, meaning: 'CORRECTED', signer: me.personId }, approval },
        roles,
      );
      if (!r.accepted) throw new Error(`SETUP: the engine refused the correction: ${JSON.stringify(r.refusal)}`);
    }),
  );
}

/**
 * operator1 sends a correction of a data point the run does not have (DP-NONE: since recipe-core 0346 a row names a
 * record id of the engine's form only when the run's state holds it, so the probe names none of that form), approved by
 * qa1 with `roles`, through the honest store and engine path: the engine refuses it (ENG-UNKNOWN-POINT) and the store
 * records the refused row. 'ok'
 * when that refused row was recorded, else the refusal of the database. No signature is made: a refused row's
 * signatures are what was sent.
 */
async function refusedCorrection(d: RunDriver, roles: readonly string[], approverId?: string): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const me = personaIn(sbx, 'operator1');
  const qa1 = { personId: approverId ?? personaIn(sbx, 'qa1').personId };
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (client) => {
      const tx = await execution.ExecutionTx.open(client, run.def, d.runId);
      const roles0 = await engineRoles(client);
      const r = await tx.command(
        {
          type: 'CORRECT_ENTRY',
          commandId: randomUUID(),
          actor: engineActor(me.personId, roles0),
          point: 'DP-NONE',
          value: { kind: 'DECIMAL', value: '16', unit: 'min' },
          reason: 'Transcription error: the timer read 16 min',
          signature: { id: randomUUID(), meaning: 'CORRECTED', signer: me.personId },
          approval: { approver: { id: qa1.personId, kind: 'PERSON', roles: [...roles] }, signature: { id: randomUUID(), meaning: 'CORRECTION_APPROVED', signer: qa1.personId } },
        },
        roles0,
      );
      if (r.accepted) throw new Error('SETUP: the engine accepted a correction of DP-NONE');
    }),
  );
}

/** Rows of run `runId` whose command holds `text`. */
async function rowsWith(runId: string, text: string): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_command where batch_id = $1 and command::text like $2', [runId, `%${text}%`]);
  return Number(rows[0]?.n ?? '0');
}

describe('F12 round 9: an approval names the engine roles its approver holds (DI-05, DI-30, INV-26)', () => {
  const ROW = String.raw`\. An approval names only the engine roles its approver holds, read from the authority behind the approver's own signature, and a refused row's approval only engine roles, so nothing sits in the record unread \(DI-05, DI-30, INV-26\)\. \[EBMR-EXE-126\]$`;

  it('[DI-05][DI-30][INV-26] round 9: an accepted correction approved by qa1 as QA and L2409-0017 (the round-2 verification\'s probe, which the engine accepts), or as PRODUCTION_SUPERVISOR, which qa1 does not hold, and a refused correction approved as QA and L2409-0017, are refused (EBMR-EXE-126) and no row holds L2409-0017; the honest refused and accepted corrections approved as QA are recorded, and the run has no violation', async () => {
    const d = await verifiedRun();
    const point = await blendTimePoint(d.runId);
    const approval = await approvalOf(d, point, ['QA']);

    const outcomes = {
      // The round-2 verification's probe: the engine needs one supervisor or QA role and reads no other.
      lotRole: await correct(d, point, withRoles(approval, ['QA', LOT])),
      // INV-26: an engine role the approver does not hold (qa1 signs as QA_SHOP_FLOOR, which carries QA only); the engine
      // accepts it as a supervisor's approval.
      notHeld: await correct(d, point, withRoles(approval, ['PRODUCTION_SUPERVISOR'])),
      // A refused row records what was sent, but its approval names engine roles only.
      refusedLot: await refusedCorrection(d, ['QA', LOT]),
    };
    expect(
      unmatched(outcomes, {
        lotRole: new RegExp(String.raw`^This accepted CORRECT_ENTRY row cannot be recorded: command\.approval\.approver\.roles\[1\] "L2409-0017" is not an engine role its approver holds: the authority behind the approval's signature \(QA_SHOP_FLOOR, through QA\.FLOOR_APPROVE\) carries QA` + ROW),
        notHeld: new RegExp(String.raw`^This accepted CORRECT_ENTRY row cannot be recorded: command\.approval\.approver\.roles\[0\] "PRODUCTION_SUPERVISOR" is not an engine role its approver holds: the authority behind the approval's signature \(QA_SHOP_FLOOR, through QA\.FLOOR_APPROVE\) carries QA` + ROW),
        refusedLot: new RegExp(String.raw`^This refused CORRECT_ENTRY row cannot be recorded: command\.approval\.approver\.roles\[1\] "L2409-0017" is not an engine role` + ROW),
      }),
    ).toEqual({});
    expect(await rowsWith(d.runId, LOT)).toBe(0);
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'CORRECT_ENTRY')).toEqual([]);

    // The honest rows: a refused correction approved as QA, and the accepted correction approved by qa1 as QA.
    expect(await refusedCorrection(d, ['QA'])).toBe('ok');
    expect(await correct(d, point, approval)).toBe('ok');
    const corrections = (await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'CORRECT_ENTRY');
    expect(corrections.map((x) => x.accepted)).toEqual([false, true]);
    expect(corrections[1]?.signature_ids).toContain(approval.signature.id);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[DI-05][DI-30] round 9 (self-review, sql 0342): an approval names its approver by the id of a person of this installation: a refused correction approved by L2409-0017, or by a person id the installation does not have, is refused (EBMR-EXE-126) and no row holds L2409-0017; the refused correction approved by qa1 is recorded', async () => {
    const d = await verifiedRun();
    const PERSON = String.raw`\. An approval names its approver by the id of a person of this installation, so nothing sits in the record unread \(DI-05, DI-30\)\. \[EBMR-EXE-126\]$`;
    const outcomes = {
      lotApprover: await refusedCorrection(d, ['QA'], LOT),
      unknownPerson: await refusedCorrection(d, ['QA'], '00000000-0000-4000-8000-0000000000ff'),
    };
    expect(
      unmatched(outcomes, {
        lotApprover: new RegExp(String.raw`^This refused CORRECT_ENTRY row cannot be recorded: command\.approval\.approver\.id "L2409-0017" is not the id of a person of this installation` + PERSON),
        unknownPerson: new RegExp(String.raw`^This refused CORRECT_ENTRY row cannot be recorded: command\.approval\.approver\.id "00000000-0000-4000-8000-0000000000ff" is not the id of a person of this installation` + PERSON),
      }),
    ).toEqual({});
    expect(await rowsWith(d.runId, LOT)).toBe(0);
    expect(await refusedCorrection(d, ['QA'])).toBe('ok');
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'CORRECT_ENTRY').map((x) => x.accepted)).toEqual([false]);
  }, 300_000);
});
