/**
 * Kill tests of the SQL mutation group evidence-source-and-entries (tools/sql-mutation/src/targets.ts) at database level:
 * rows written past the server through the store with the application role (ADR 0012: the application role is the
 * attacker, with the same database rights as the server), as the group's own tests write them
 * (test/execution/evidence-source-room.test.ts, db-guards-entry-identifiers.test.ts, db-guards-stale-row.test.ts).
 *
 * Mutation batch 2 (e236af3) left these behaviours untested:
 *  - recipe-core 0300: the refusal EBMR-EXE-125 says what is wrong with the step a step command names (none, or one
 *    the MBR does not hold); a step of a stage that names no room is accepted from any terminal (DI-20: a binding the
 *    MBR does not declare restricts nothing);
 *  - tablets 0370, 0380, 0390: an identifier is read where an entry's kind carries one, and an entry a command of
 *    another type carries is the row shape's to refuse (EBMR-EXE-126); the id the output weighing builds from the
 *    test batch's own number is the system's, accepted only for an output whose command names no container, and a
 *    container its command names is read as a test lot number;
 *  - tablets 0510: the words of each refusal of a device weighing's readings (EBMR-EXE-124), a weighing from the
 *    current screen and one refused as stale apart; the readings a command claimed are its own (its correlation id,
 *    its session, this transaction), another command's claims at the same time are not, and a reading backs one
 *    entry of one command.
 * The pure checks of recipe-core in the group are in packages/recipe-core/test/mutation/evidence-source-and-entries.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { roomFreeDispensing } from '../devices/room-scales-support.ts';
import { actorOf, appendAs, engineResult, messageOf, nextState } from '../execution/db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, writePackage, type ExecServer } from '../execution/support.ts';

type Json = Record<string, unknown>;

const CLEAR = 'p-disp-clear@';

describe('the command row and the identifiers of a test run (recipe-core 0300, tablets 0370, 0380, 0390)', () => {
  let sbx: ExecServer;
  beforeAll(async () => {
    sbx = await startExecServer();
    vi.useFakeTimers({ toFake: ['performance'] });
  }, 180_000);
  afterAll(async () => {
    vi.useRealTimers();
    await sbx?.close();
  });

  async function newRun(content = dcMini(), extra: Record<string, [persona: string, terminal?: string]> = {}): Promise<RunDriver> {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
    const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer, operator1: await sbx.asPersona('operator1') };
    for (const [name, [persona, terminal]] of Object.entries(extra)) browsers[name] = await sbx.asPersona(persona, terminal);
    const d = new RunDriver(sbx, runId, browsers);
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    return d;
  }

  interface Forged {
    command: engine.Command;
    result: Pick<engine.StepResult, 'state' | 'events'>;
    /** The JSON recorded in place of the command. */
    recorded?: engine.JsonValue;
    /** Recorded as refused with this refusal (default: accepted). */
    refusal?: engine.Refusal;
    evidence?: engine.JsonValue;
  }

  /**
   * What a writer holding the application role stores past the server, in a command of `persona` (browser `browser`,
   * default the persona's own): `forge` gives the engine command, the state beside it and what the row records. 'ok', or
   * the database's refusal.
   */
  async function forged(d: RunDriver, persona: string, forge: (tx: execution.ExecutionTx, me: engine.Actor) => Forged, browser = persona): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    return messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser(browser), persona), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const f = forge(tx, engineActor(personaIn(sbx, persona).personId, roles));
        const recorded = f.recorded ?? engine.encodeCommand(f.command);
        if (!f.refusal) return appendAs(tx, f.command, f.result, roles, recorded, undefined, f.evidence);
        return execution.appendExecution(tx.client, {
          batchId: tx.locked.batch.id,
          expectedSeq: tx.lastSeq,
          kind: 'COMMAND',
          command: recorded,
          commandId: f.command.commandId,
          nowUs: tx.nowUs,
          accepted: false,
          refusal: f.refusal,
          state: f.result.state,
          events: f.result.events,
          roles,
          contents: engine.changedContents(tx.def, tx.state, f.result.state),
          ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
        });
      }),
    );
  }

  it('[DI-20][DI-34] an accepted step command naming no step, or a step the MBR does not hold, is refused with what is wrong with it (EBMR-EXE-125); nothing is written', async () => {
    const d = await newRun();
    const rowsBefore = (await rowsOf(sbx, d.runId)).length;
    const outcomes = {
      unknownStep: await forged(d, 'operator1', (tx, me) => ({ command: { type: 'START_STEP', commandId: randomUUID(), actor: me, step: 'p-no-such-step', context: [] }, result: nextState(tx) })),
      noStep: await forged(d, 'operator1', (tx, me) => {
        const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: me, step: 'p-disp-clear', context: [] };
        const recorded = Object.fromEntries(Object.entries(engine.encodeCommand(command) as Json).filter(([k]) => k !== 'step')) as engine.JsonValue;
        return { command, result: nextState(tx), recorded };
      }),
      stepNotText: await forged(d, 'operator1', (tx, me) => {
        const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: me, step: 'p-disp-clear', context: [] };
        return { command, result: nextState(tx), recorded: { ...(engine.encodeCommand(command) as Json), step: ['p-disp-clear'] } };
      }),
    };
    expect(outcomes).toEqual({
      unknownStep: "A step command is recorded only for a step of the batch's MBR; the MBR has no step p-no-such-step (DI-20, DI-34). [EBMR-EXE-125]",
      noStep: "A step command is recorded only for a step of the batch's MBR; this one names no step (DI-20, DI-34). [EBMR-EXE-125]",
      stepNotText: "A step command is recorded only for a step of the batch's MBR; this one names no step (DI-20, DI-34). [EBMR-EXE-125]",
    });
    expect((await rowsOf(sbx, d.runId)).length).toBe(rowsBefore);
  }, 300_000);

  it('[DI-20][PR-23] a step of a stage that names no room is accepted from the terminal of any room: its start from the DISP-1 and the BLEND-1 kiosks is recorded', async () => {
    const d = await newRun(roomFreeDispensing(), { operator2: ['operator2'] }); // operator2 on TEST-KIOSK-BLEND-1
    expect(d.browser('operator2').terminal).toBe('TEST-KIOSK-BLEND-1');
    const { rows } = await sbx.db.admin.query<{ p: string | null }>(
      "select recipe.step_room_problem(pk.content, 'p-disp-clear', $2) as p from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = $1",
      [d.runId, 'BLEND-1'],
    );
    expect(rows).toEqual([{ p: null }]);
    const start = (step: string) => (tx: execution.ExecutionTx, me: engine.Actor): Forged => {
      const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: me, step, context: [] };
      return { command, result: engineResult(tx, command) };
    };
    const rowsBefore = (await rowsOf(sbx, d.runId)).length;
    // From the BLEND-1 kiosk, and in another run from the DISP-1 kiosk.
    expect(await forged(d, 'operator2', start('p-disp-clear'))).toBe('ok');
    expect((await rowsOf(sbx, d.runId)).length).toBe(rowsBefore + 1);
    const d2 = await newRun(roomFreeDispensing());
    expect(await forged(d2, 'operator1', start('p-disp-clear'))).toBe('ok');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[DI-05][PR-18][DI-30] an identifier is read where the entry\'s kind carries one; an entry carried by a command that takes none, or a member an entry\'s kind does not have, is refused as a malformed row (EBMR-EXE-126), whatever it names', async () => {
    const d = await newRun();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const rowsBefore = (await rowsOf(sbx, d.runId)).length;
    const answers = ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' }));
    const clearance = (me: engine.Actor): engine.Command => ({ type: 'RECORD_ENTRY', commandId: randomUUID(), actor: me, step: 'p-disp-clear', context: [], entry: { kind: 'CLEARANCE_CHECK', answers } });
    const outcomes = {
      // A START_STEP (which takes no entry) recorded with an entry naming the real previous batch.
      entryOnStart: await forged(d, 'operator1', (tx, me) => {
        const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: me, step: 'p-disp-bal', context: [] };
        return { command, result: nextState(tx), recorded: { ...(engine.encodeCommand(command) as Json), entry: { kind: 'PREVIOUS_BATCH', product: 'P', batchNumber: 'B24-0001' } } };
      }),
      // A line clearance whose entry carries a container (which no clearance has), real-format: accepted and refused.
      containerOnClearance: await forged(d, 'operator1', (tx, me) => {
        const command = clearance(me);
        return { command, result: engineResult(tx, command), recorded: { ...(engine.encodeCommand(command) as Json), entry: { kind: 'CLEARANCE_CHECK', answers, container: 'DRUM-3' } } };
      }),
      containerOnRefusedClearance: await forged(d, 'operator1', (tx, me) => {
        // The engine's own refusal of the clearance from an older screen (ENG-STALE), recorded with the container.
        const command: engine.Command = { ...clearance(me), expectedVersion: tx.state.version - 1 };
        const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        if (r.accepted || !r.refusal) throw new Error('SETUP: the engine accepted the stale clearance');
        return { command, result: r, refusal: r.refusal, recorded: { ...(engine.encodeCommand(command) as Json), entry: { kind: 'CLEARANCE_CHECK', answers, container: 'DRUM-3' } } };
      }),
    };
    const schema = (accepted: boolean) =>
      `This ${accepted ? 'accepted' : 'refused'} RECORD_ENTRY row records at step p-disp-clear ${accepted ? 'an entry that does not meet the data schema of block G-10@1' : 'a refused entry holding a member no block version declares for it'}: CLEARANCE_CHECK.container is not a field of this block (unknown fields are refused) (ENG-ENTRY-SCHEMA): an entry and a step's start data meet the data schema of the step's block version and are of a kind it records, as the engine checks them before the block accepts them (DI-05, DI-30, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47). [EBMR-EXE-126]`;
    expect(outcomes).toEqual({
      entryOnStart:
        'This accepted START_STEP row cannot be recorded: command.entry is a member a START_STEP command does not declare. A row records the engine command of its type with exactly the members that type declares, each of the JSON type it declares, and with evidence of the shape the server records, so nothing sits in the record unread (DI-05, DI-30). [EBMR-EXE-126]',
      containerOnClearance: schema(true),
      containerOnRefusedClearance: schema(false),
    });
    expect((await rowsOf(sbx, d.runId)).length).toBe(rowsBefore);
    expect(await sbx.db.admin.query('select 1 from recipe.execution_command where batch_id = $1 and (command::text like $2 or command::text like $3)', [d.runId, '%B24-0001%', '%DRUM-3%'])).toMatchObject({ rows: [] });
  }, 300_000);

  /** An intermediate whose built container id (<batch number>/<intermediate>/0/<n>) is too long for a test lot number. */
  const LONG = 'I-EARLY-OUTPUT-OF-THE-BOOTH';
  const OUT = 'p-early-out@';

  /** dc-mini with an output step (G-22, producing LONG) first in the dispensing booth, started by operator1. */
  async function earlyOutputRun(): Promise<RunDriver> {
    const content = dcMiniVariant((prep, c) => {
      (c['intermediates'] as Json[]).push({ id: LONG, name: 'Early output', holdTime: { max: { value: '30', unit: 'd' }, source: { kind: 'HOLD_STUDY', ref: 'HS-PCM-01' }, storage: 'Closed, labelled containers' } });
      (c['parameters'] as Json[]).push({ id: 'earlyNet', name: 'Early output (net)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
      const out = { kind: 'phase', id: 'p-early-out', name: 'Discharge the early output', block: { type: 'G-22', version: '1' }, config: {}, records: ['earlyNet'], computes: [], reads: [], consumes: [], produces: [LONG], uses: [], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } }, significant: true, riskClass: 'HIGH' };
      return [out, ...prep];
    });
    const d = await newRun(content);
    await d.ok('operator1', { type: 'START_STEP', stepKey: OUT });
    return d;
  }

  /**
   * operator1's output weighing (keyed by hand) at OUT, resolved as the server resolves it, written past the server with
   * the container its command names replaced by `container` (none: the block builds the id), and `forge` applied to the
   * state the engine leaves. 'ok', or the database's refusal.
   */
  async function outputPast(d: RunDriver, container: string | undefined, forge: (state: engine.BatchState, before: engine.BatchState) => void = () => undefined): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    return messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const resolved = await resolveClientIntent(
          { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
          { type: 'RECORD_ENTRY', stepKey: OUT, entry: { kind: 'OUTPUT_CONTAINER', intermediate: LONG, manual: { gross: '26.100', tare: '1.050', unit: 'kg' } } },
        );
        const command = structuredClone(resolved.command) as engine.Command & { entry: Json };
        delete command.entry['container'];
        if (container !== undefined) command.entry['container'] = container;
        const r = engineResult(tx, command);
        forge(r.state, tx.state);
        return appendAs(tx, command, r, roles, engine.encodeCommand(command), engine.changedContents(tx.def, tx.state, r.state), resolved.evidence as engine.JsonValue);
      }),
    );
  }

  const containersOf = async (d: RunDriver): Promise<string[]> => Object.keys((await execution.loadState(sbx.db.admin, d.runId))?.state.containers ?? {});

  it('[DI-05][PR-18][PR-21] the id the output weighing builds from the test batch\'s own number, when its command names no container, is the system\'s and is recorded although it is no test lot number; a container the command names is read as a test lot number', async () => {
    const d = await earlyOutputRun();
    const { rows } = await sbx.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [d.runId]);
    const built = `${rows[0]?.n ?? '?'}/${LONG}/0/1`;
    // The built id is no test lot number (too long): only the output weighing's rule admits it.
    const { rows: lot } = await sbx.db.admin.query<{ p: string | null }>("select sandbox.identifier_problem('LOT_NUMBER', $1) as p", [built]);
    expect(lot[0]?.p).toMatch(/is not a test lot number/);
    expect(await outputPast(d, undefined)).toBe('ok');
    expect(await containersOf(d)).toEqual([built]);
    // A second output naming its own container, a test lot number (not built from the batch's number): read as one.
    expect(await outputPast(d, 'TEST-L26-0777')).toBe('ok');
    expect((await containersOf(d)).sort()).toEqual([built, 'TEST-L26-0777'].sort());
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[DI-05][DI-30][PR-18] a container is read by its key and by its id when that is another text; one registered under an id other than its key (a number) is refused as a container no entry registers (EBMR-EXE-126), nothing written', async () => {
    const d = await earlyOutputRun();
    const rowsBefore = (await rowsOf(sbx, d.runId)).length;
    let key = '';
    const outcome = await outputPast(d, undefined, (state, before) => {
      const [k] = Object.keys(state.containers).filter((x) => !(x in before.containers));
      if (!k) throw new Error('SETUP: the output registered no container');
      key = k;
      (state.containers[k] as unknown as Json)['id'] = 5;
    });
    expect(outcome).toBe(
      `This accepted RECORD_ENTRY row adds container ${key}; a container is registered, in quarantine, only by the accepted RECORD_ENTRY of the step that produces it: a value, entry, container or computed value once recorded is kept as recorded; it changes only as a correction, a recomputation, an approved invalidation, a charge or a loop exit changes it, by the row that makes that change (DI-24, DI-29, DI-30, DI-32, INV-41). [EBMR-EXE-126]`,
    );
    expect((await rowsOf(sbx, d.runId)).length).toBe(rowsBefore);
    // tablets 0390 reads the key, and the id when it is another text; an id that is no text names no identifier.
    const problem = async (k: string, container: unknown): Promise<string | null> => {
      const { rows } = await sbx.db.admin.query<{ p: string | null }>('select tab.state_container_identifier_problem($1, $2::jsonb, $3::jsonb, $4) as p', [
        k,
        JSON.stringify(container),
        JSON.stringify({ type: 'RECORD_ENTRY', entry: { kind: 'CONTAINER_WEIGHING', container: k } }),
        'TEST-B26-0001',
      ]);
      return rows[0]?.p ?? null;
    };
    const record = (id: unknown) => ({ id, holds: 'BOM-PCM', holdsKind: 'BOM_LINE', producedBy: 'p-disp-pcm@', producedIn: [], status: 'QUARANTINE' });
    expect(await problem('TEST-L26-0101/C1', record('TEST-L26-0101/C1'))).toBeNull();
    expect(await problem('TEST-L26-0101/C1', record('L2409-0017'))).toMatch(/^container "L2409-0017" is not a test lot number/);
    for (const id of [5, true, null]) expect(await problem('TEST-L26-0101/C1', record(id)), JSON.stringify(id)).toBeNull();
  }, 300_000);

  it('[DI-05][PR-18] an output container in a test run\'s record that no command named is the system\'s only when built from the batch\'s own number: a test lot number stored by a command that names no container is refused', async () => {
    const problem = async (entry: unknown, command: unknown, batch: string | null): Promise<string | null> => {
      const { rows } = await sbx.db.admin.query<{ p: string | null }>('select tab.state_entry_identifier_problem($1::jsonb, $2::jsonb, $3) as p', [JSON.stringify(entry), JSON.stringify(command), batch]);
      return rows[0]?.p ?? null;
    };
    const out = (container: string) => ({ id: 'EN-1', kind: 'OUTPUT_CONTAINER', data: { intermediate: 'INT-BLEND', container, gross: '2', tare: '1', unit: 'kg' } });
    // A command with no entry at all (a step start, a signature) names no container.
    for (const command of [{ type: 'START_STEP', step: 'p-blend-out', context: [] }, { type: 'SIGN_PERFORMED', step: 'p-blend-out', context: [] }]) {
      expect(await problem(out('TEST-L26-0101'), command, 'TEST-B26-0001'), command.type).toBe('container TEST-L26-0101 is neither one the command named nor the id the system builds from the batch number TEST-B26-0001');
      expect(await problem(out('TEST-B26-0001/INT-BLEND/0/1'), command, 'TEST-B26-0001'), command.type).toBeNull();
    }
  }, 300_000);
});
