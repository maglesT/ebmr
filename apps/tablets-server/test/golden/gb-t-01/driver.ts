/**
 * The GB-T-01 driver (Phase 3 slice 6d): one GMP batch of the gb-t-01 master run over HTTP as the seeded personas, each
 * at the kiosk of the stage's room (badge tap and PIN) or at the office PC (user ID and password): the batch routes
 * (/api/batches/*) with BLOCK_ENTRY and the typed entries, the e-signature ceremony, the signed acts of quality and
 * plant. Floor acts that have no route in Phase 3 (the lot reservation by stores, the start of an equipment use, an
 * instrument check and use, a room occupancy, an output container at the press) run as the person's own command in the
 * database, the same function a route would call: they are listed as a residual. Time moves only through the golden
 * clock (clock.ts): the driver "waits" by moving the database's clock forward.
 */
import { vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { routes, type ClientIntent, type SignableAction, type SignatureCredentials, type SignedIntent } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { personaOf } from '@ebmr/test-kit';
import { GBT01_LOTS } from '../../../src/features/execution/seed-gb-t-01.ts';
import { actorOfBrowser, refusalOf, tapFor, valueOf } from '../../esig/support.ts';
import { asPersonaInRole, RunDriver, type ExecServer } from '../../execution/support.ts';
import type { TestBrowser } from '../../support/harness.ts';
import { advanceMinutes, advanceSeconds, frozenSeconds } from '../clock.ts';
import { BALANCE, UNITS, type Room, type UnitRef } from './plant.ts';
import { BATCH_SIZE_ID, LINE, SITE, type GoldenWorld } from './world.ts';

type Json = Record<string, unknown>;

export const KIOSK: Record<Room | 'PL-1', string> = { 'DISP-1': 'KIOSK-DISP-1', 'GRAN-1': 'KIOSK-GRAN-1', 'BLEND-1': 'KIOSK-BLEND-1', 'COMP-1': 'KIOSK-COMP-1', 'COAT-1': 'KIOSK-COAT-1', 'INSP-1': 'KIOSK-INSP-1', 'PL-1': 'KIOSK-PACK-1' };
const kiosk = (b: TestBrowser): boolean => b.terminal.includes('KIOSK');

/** The tap limiter runs on the monotonic clock: a long run advances it before every badge tap (as the block tests do). */
export const tapAdvance = (): void => {
  vi.advanceTimersByTime(7_000);
  tick();
};

/** On the frozen golden clock, each act happens one second after the one before (the driver's own sequence). */
export function tick(): void {
  if (frozenSeconds() !== null) advanceSeconds(1);
}

export function ok<T>(r: { ok: true; value: T } | { ok: false; error: unknown }, what: string): T {
  if (!r.ok) throw new Error(`${what} was refused: ${JSON.stringify(refusalOf(r as never))}`);
  return r.value;
}

const credentials = (w: GoldenWorld, b: TestBrowser, key: string): SignatureCredentials => {
  const p = personaOf(w.seed, key);
  return kiosk(b) && p.pin ? { kind: 'PIN', pin: p.pin } : { kind: 'PASSWORD', loginName: p.loginName, password: p.password };
};

/** The ceremony of a signable action at any terminal (a badge tap on the challenge at a kiosk, the PIN there). */
export async function signAct(w: GoldenWorld, b: TestBrowser, key: string, action: SignableAction) {
  tick();
  const d = valueOf(await b.call(routes.esig.describe, { body: { action } }));
  const preview = valueOf(await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: d.meaning ?? '' } }));
  const body = { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.contentVersion, meaning: d.meaning ?? '', clientContentHash: sha256Hex(preview.canonicalText), action };
  if (kiosk(b)) tapAdvance();
  const challenge = ok(
    await b.call(routes.esig.createChallenge, { body, ...(kiosk(b) ? { attribution: await tapFor(b, personaOf(w.seed, key), 'POST', '/api/esig/challenges', body) } : {}) }),
    `the challenge of ${action.kind}`,
  );
  const signBody = { challengeId: challenge.challengeId, credentials: credentials(w, b, key), action };
  return b.call(routes.esig.sign, { body: { ...signBody, proof: await b.proof('POST', '/api/esig/sign', signBody) } });
}

/** A database command of persona `key` in its browser's session (a fresh tap at a kiosk). */
export async function dbAs<T = Json>(w: GoldenWorld, b: TestBrowser, key: string, sql: string, params: unknown[], reason?: { reasonCode: string; reasonText: string }): Promise<T> {
  if (kiosk(b)) tapAdvance();
  else tick();
  const actor = await actorOfBrowser(w.server, b, key, reason ?? {});
  return withCommand(w.server.db.app, actor, async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
}

export interface StepPlan {
  /** Entries and data, in order, by the performer (or by `as`). */
  entries?: (ClientIntent | { as: string; intent: ClientIntent } | { wait: number })[];
  performer?: string;
  /** The second person, or null for a step without one. */
  checker?: string | null;
  meaning?: 'VERIFIED' | 'WITNESSED';
  /** Leave the step started, not signed. */
  noSign?: boolean;
}

export const entry = (stepKey: string, entryKind: string, data: Json): ClientIntent =>
  ({ type: 'RECORD_ENTRY', stepKey, entry: { kind: 'BLOCK_ENTRY', entryKind, data } }) as ClientIntent;

/** One GMP batch of the gb-t-01 master. */
export class GoldenBatch {
  d!: RunDriver;
  room: Room | 'PL-1' | null = null;
  /** Equipment uses and room occupancies started for the batch, by unit or room code. */
  readonly uses = new Map<string, string>();
  readonly occupancies = new Map<string, string>();
  /** What the negatives saw on this batch (refusals), for the assertions. */
  readonly notes: Record<string, unknown> = {};

  private constructor(
    readonly w: GoldenWorld,
    readonly batchId: string,
    readonly batchNumber: string,
  ) {}

  get server(): ExecServer {
    return Object.assign(this.w.server, { exchangeDir: this.w.keysDir });
  }

  /** A batch planned elsewhere (a packaging order, Phase 4 slice 7b), driven the same way. */
  static of(w: GoldenWorld, batchId: string, batchNumber: string): GoldenBatch {
    return new GoldenBatch(w, batchId, batchNumber);
  }

  /** The issuer plans a batch of the effective version against the oldest open ERP order. */
  static async plan(w: GoldenWorld, opts: { familyId?: string; markets?: string[]; batchSize?: string } = {}): Promise<GoldenBatch> {
    const issuer = await w.server.asPersona('issuer');
    const body = { familyId: opts.familyId ?? w.familyId, markets: opts.markets ?? ['IN'], site: SITE, line: LINE, batchSize: opts.batchSize ?? BATCH_SIZE_ID };
    const p = ok(await issuer.call(routes.execution.planBatch, { body }), 'the plan');
    return new GoldenBatch(w, p.batchId, p.batchNumber);
  }

  /** The issuer's ISSUED signature with the batch's own inputs (2,00,000 tablets). */
  async issue(tablets = '200000'): Promise<void> {
    const action: SignableAction = { kind: 'GMP_BATCH_ISSUE', batchId: this.batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the production plan' }, variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT', value: tablets } } };
    ok(await signAct(this.w, await this.office('issuer'), 'issuer', action), 'the issue');
  }

  /** Browsers of the floor personas at the kiosk of `room` (a new session each; the operator of dispensing as DISPENSER). */
  async floor(room: Room | 'PL-1'): Promise<RunDriver> {
    const t = KIOSK[room];
    const s = this.w.server;
    const browsers: Record<string, TestBrowser> = {
      operator1: room === 'DISP-1' || room === 'PL-1' ? await asPersonaInRole(s, 'operator1', 'DISPENSER', t) : await s.asPersona('operator1', t),
      operator2: await s.asPersona('operator2', t),
      verifier1: await s.asPersona('verifier1', t),
      supervisor1: await s.asPersona('supervisor1', t),
      qa1: await s.asPersona('qa1', t),
    };
    this.d = new RunDriver(this.server, this.batchId, browsers);
    this.d.beforeTap = tapAdvance;
    this.room = room;
    return this.d;
  }

  /** Moves the database's clock forward by `minutes` (the golden clock); the kiosk sessions locked meanwhile are opened again. */
  async wait(minutes: number): Promise<void> {
    advanceMinutes(minutes);
    if (this.room) await this.floor(this.room);
  }

  /** A fresh session of an office persona at its home PC (a long run idles out the earlier ones). */
  async office(key: string): Promise<TestBrowser> {
    return this.w.server.asPersona(key);
  }

  b(persona: string): TestBrowser {
    return this.d.browser(persona);
  }

  /** The room cleared by operator1 and verified by verifier1 (PLANT_VERIFY), and occupied for `stage` by operator1. */
  async clearAndOccupy(room: Room | 'PL-1', stage: string, operator = 'operator1', type: 'PRODUCT_CHANGE' | 'CAMPAIGN' | 'PACKAGING_ORDER' = 'PRODUCT_CHANGE', artworkSet?: string): Promise<string> {
    const op = this.b(operator);
    tapAdvance();
    const line = type === 'PACKAGING_ORDER' ? { order: this.batchNumber, artworkSet: artworkSet ?? '' } : {};
    const body = { areaCode: room, type, batchId: this.batchId, result: 'PASSED' as const, ...line };
    const c = ok(await op.call(routes.plant.recordClearance, { body, attribution: await tapFor(op, personaOf(this.w.seed, operator), 'POST', '/api/plant/clearances', body) }), `the clearance of ${room}`);
    ok(await signAct(this.w, this.b('verifier1'), 'verifier1', { kind: 'PLANT_VERIFY', act: 'CLEARANCE', id: c.clearanceId }), `the verification of the clearance of ${room}`);
    const id = type === 'PACKAGING_ORDER'
      ? await dbAs<string>(this.w, op, operator, 'select plant.start_area_occupancy($1, $2, $3, $4, $5) as r', [room, this.batchId, stage, this.batchNumber, artworkSet])
      : await dbAs<string>(this.w, op, operator, 'select plant.start_area_occupancy($1, $2, $3) as r', [room, this.batchId, stage]);
    this.occupancies.set(room, id);
    return id;
  }

  /** The use of a process unit for the batch (operator1), planned for `hours`. */
  async startUse(unit: UnitRef | { code: string }, hours = 12): Promise<string> {
    const code = typeof unit === 'string' ? UNITS[unit].code : unit.code;
    const id = await dbAs<string>(this.w, this.b('operator1'), 'operator1', `select plant.start_equipment_use($1, $2, clock_timestamp() + make_interval(hours => $3)) as r`, [code, this.batchId, hours]);
    this.uses.set(code, id);
    return id;
  }

  /** The balance of `room`: its per-use check and its use for the batch (operator1), planned for `hours`. */
  async balanceUse(room: Room | 'PL-1', operator = 'operator1', hours = 12): Promise<string> {
    const code = room === 'PL-1' ? 'BAL-PL-01' : BALANCE[room];
    const op = this.b(operator);
    await dbAs(this.w, op, operator, "select plant.record_instrument_check($1, 'PASS', $2, $3::uuid) as r", [code, `${code} per-use check`, this.batchId]);
    const id = await dbAs<string>(this.w, op, operator, `select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + make_interval(hours => $3)) as r`, [code, this.batchId, hours]);
    this.uses.set(code, id);
    return id;
  }

  /**
   * Ends the batch's uses and occupancies of `codes` (operator1). Once the batch has finished (its last stage signed off)
   * the operator states why, as the database requires then (recipe-core 1922, EBMR-PLANT-065; owner decision of
   * 13 November 2026); while it runs, the end carries no reason, as on the step screen.
   */
  async release(codes: string[], operator = 'operator1'): Promise<void> {
    const { rows } = await this.w.server.db.admin.query<{ status: string }>('select status from recipe.execution_state where batch_id = $1', [this.batchId]);
    const finished = ['EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED'].includes(rows[0]?.status ?? '');
    const reason = finished ? 'The batch has finished (its last stage is signed off); the use ends after it' : null;
    for (const code of codes) {
      const use = this.uses.get(code);
      if (use && !code.startsWith('BAL-')) await dbAs(this.w, this.b(operator), operator, 'select plant.end_equipment_use($1, $2) as r', [use, reason]);
      const occ = this.occupancies.get(code);
      if (occ) await dbAs(this.w, this.b(operator), operator, 'select plant.end_area_occupancy($1, $2) as r', [occ, reason]);
    }
  }

  /** Stores reserve every GB-T-01 lot's quantity for the batch (MATERIAL.HANDLE), for 30 days. */
  async reserveLots(quantities: Record<string, string>, lots: readonly { lotCode: string; materialCode: string }[] = GBT01_LOTS): Promise<void> {
    const stores = await this.office('stores');
    for (const lot of lots) {
      const q = quantities[lot.materialCode];
      if (!q) continue;
      const { rows } = await this.w.server.db.app.query<{ id: string }>('select id from site.material_lot where lot_code = $1', [lot.lotCode]);
      await dbAs(this.w, stores, 'stores', "select site.reserve_lot($1, $2, $3, 'TABLETS', $4::numeric, 'kg', clock_timestamp() + interval '30 days') as r", [rows[0]?.id, this.batchId, this.batchNumber, q]);
    }
  }

  /** Runs one step: start, entries, PERFORMED, the check. */
  async step(stepKey: string, plan: StepPlan = {}): Promise<void> {
    const performer = plan.performer ?? 'operator1';
    await this.d.ok(performer, { type: 'START_STEP', stepKey });
    for (const e of plan.entries ?? []) {
      if ('wait' in e) await this.wait(e.wait);
      else if ('as' in e) await this.d.ok(e.as, e.intent);
      else await this.d.ok(performer, e);
    }
    if (plan.noSign) return;
    await this.signed(performer, { type: 'SIGN_PERFORMED', stepKey });
    const checker = plan.checker === undefined ? 'verifier1' : plan.checker;
    if (checker) await this.signed(checker, { type: 'VERIFY', stepKey, meaning: plan.meaning ?? 'VERIFIED' });
  }

  async signed(persona: string, intent: SignedIntent, opts: { meaning?: string } = {}): Promise<unknown> {
    return this.d.signed(persona, intent, opts);
  }

  /** The id of the last entry of `kind` at step instance `stepKey`. */
  async entryId(stepKey: string, kind: string): Promise<string> {
    const e = (await this.stepView(stepKey)).entries.filter((x) => x.kind === kind).at(-1);
    if (!e) throw new Error(`no ${kind} entry at ${stepKey}`);
    return e.entryId;
  }

  /** QA dispositions the open alerts (NO_IMPACT, `why`); the supervisor signs the stage off. */
  async closeStage(stageKey: string, why = 'Second person checked each value keyed by hand at the time; no impact on the batch.'): Promise<void> {
    let n = 0;
    for (const e of (await this.view()).exceptions.filter((x) => x.status === 'OPEN' && x.severity === 'ALERT')) {
      // The signing attempts of one person at one terminal are rate-limited (DI-19): QA works through them at a human pace.
      if (n > 0 && n % 4 === 0) await this.wait(1);
      if (e.type === 'QC_ADDITIONAL_TESTING_DECISION') {
        // PR-47: QC decides on additional testing of a batch that received an addition (the signed act over HTTP); QA
        // then dispositions the alert with that decision.
        const qc = await this.office('qcApprover');
        ok(await signAct(this.w, qc, 'qcApprover', { kind: 'QUALITY_ACT', act: 'QC_EXTRA_TESTING_DECISION', subjectId: this.batchId, input: { decision: 'NONE_REQUIRED' } }), 'the QC decision on additional testing');
        await this.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: e.exceptionId, outcome: 'NO_IMPACT', justification: 'QC decided that no additional testing is required: 2.000 kg of milled rejects of the same product, reserved and authorised, 2.45 % of the batch.' });
      } else {
        await this.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: e.exceptionId, outcome: 'NO_IMPACT', justification: why });
      }
      n += 1;
    }
    await this.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey });
  }

  async view() {
    return this.d.runView('supervisor1');
  }

  async stepView(stepKey: string) {
    return this.d.stepView('supervisor1', stepKey);
  }
}

/** The quantities of the hand worksheet (README.md), in kg, with a tare of 1.000 kg per container. */
export const W = {
  api: '54.529',
  mcc: '7.131',
  lac: '14.000',
  pvp: '2.400',
  ipa: '2.400',
  ccs: '2.400',
  sio: '0.400',
  mgs: '0.800',
  fcs: '2.450',
} as const;
const TARE = '1.000';
const gross = (net: string): string => {
  const [i = '0', f = ''] = net.split('.');
  const milli = BigInt(i) * 1000n + BigInt(f.padEnd(3, '0')) + 1000n;
  return `${(milli / 1000n).toString()}.${(milli % 1000n).toString().padStart(3, '0')}`;
};

const weigh = (stepKey: string, item: string, bomLine: string, lotCode: string, net: string, balance: string): ClientIntent => ({
  type: 'RECORD_ENTRY',
  stepKey,
  entry: { kind: 'CONTAINER_WEIGHING', item, bomLine, lotCode, manual: { gross: gross(net), tare: TARE, unit: 'kg', deviceCode: balance } },
});

/** Stage 1: dispensing in DISP-1 (TB-01 salt to base with the compensating excipient, G-07 for the other materials). */
export async function dispensing(g: GoldenBatch): Promise<void> {
  await g.floor('DISP-1');
  const bal = BALANCE['DISP-1'];
  // operator2 clears the booth and records the balance's use; operator1, the designated dispenser, dispenses.
  const occ = await g.clearAndOccupy('DISP-1', 'S-DISP', 'operator2');
  const use = await g.balanceUse('DISP-1', 'operator2');
  await g.step('p-disp-clear@', { performer: 'operator2', entries: [entry('p-disp-clear@', 'AREA_OCCUPANCY', { areaCode: 'DISP-1', occupancyId: occ })] });
  await g.step('p-disp-status@', { performer: 'operator2', entries: [entry('p-disp-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: bal, useId: use })], checker: null });
  await g.step('p-disp-api@', {
    entries: [
      { type: 'RECORD_ENTRY', stepKey: 'p-disp-api@', entry: { kind: 'POTENCY_CALCULATION', lots: [{ lotCode: 'GBT-API-001' }] } },
      weigh('p-disp-api@', 'dispApi', 'BOM-API', 'GBT-API-001', W.api, bal),
      weigh('p-disp-api@', 'dispMcc', 'BOM-MCC', 'GBT-MCC-001', W.mcc, bal),
    ],
  });
  // The dispenser weighs the other materials too: on GMP the server consumes each net from the batch's reservation of
  // its lot in the same command (tablets 1093), so the genealogy holds every lot.
  await g.step('p-disp-exc@', {
    entries: [
      weigh('p-disp-exc@', 'dispLac', 'BOM-LAC', 'GBT-LAC-001', W.lac, bal),
      weigh('p-disp-exc@', 'dispPvp', 'BOM-PVP', 'GBT-PVP-001', W.pvp, bal),
      weigh('p-disp-exc@', 'dispIpa', 'BOM-IPA', 'GBT-IPA-001', W.ipa, bal),
      weigh('p-disp-exc@', 'dispCcs', 'BOM-CCS', 'GBT-CCS-001', W.ccs, bal),
      weigh('p-disp-exc@', 'dispSio', 'BOM-SIO', 'GBT-SIO-001', W.sio, bal),
      weigh('p-disp-exc@', 'dispMgs', 'BOM-MGS', 'GBT-MGS-001', W.mgs, bal),
      weigh('p-disp-exc@', 'dispFcs', 'BOM-FCS', 'GBT-FCS-001', W.fcs, bal),
    ],
  });
  await g.step('p-disp-recon@', { performer: 'operator2' });
  await g.closeStage('S-DISP@');
  await g.release(['DISP-1'], 'operator2');
}

const output = (stepKey: string, intermediate: string, net: string, balance: string): ClientIntent => ({
  type: 'RECORD_ENTRY',
  stepKey,
  entry: { kind: 'OUTPUT_CONTAINER', intermediate, manual: { gross: gross(net), tare: TARE, unit: 'kg', deviceCode: balance } },
});

export interface GranulationPlan {
  /** Dried granules of each sub-lot (net, kg). */
  granules: [string, string];
  /** LOD of each drying iteration, per sub-lot (%). */
  lods: [string[], string[]];
  /** Extra isopropyl alcohol per sub-lot (kg), or null for none. */
  extraIpa: [string | null, string | null];
  /** Called after each drying iteration is performed (the step key), before the loop's iteration ends. */
  afterDrying?: (g: GoldenBatch, stepKey: string) => Promise<void>;
}

/** Stage 2: granulation in GRAN-1, in two sub-lots (replicate R-GRAN), each binder, wet massing, LOD loop and output. */
export async function granulation(g: GoldenBatch, plan: GranulationPlan): Promise<void> {
  await g.floor('GRAN-1');
  const bal = BALANCE['GRAN-1'];
  const occ = await g.clearAndOccupy('GRAN-1', 'S-GRAN');
  const balUse = await g.balanceUse('GRAN-1');
  const rmg = await g.startUse('RMG');
  const fbd = await g.startUse('FBD');
  await g.step('p-gran-clear@', { entries: [entry('p-gran-clear@', 'AREA_OCCUPANCY', { areaCode: 'GRAN-1', occupancyId: occ })] });
  await g.step('p-gran-status@', {
    checker: null,
    entries: [
      entry('p-gran-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: bal, useId: balUse }),
      entry('p-gran-status@', 'EQUIPMENT_USE', { equipmentRef: 'RMG', equipmentCode: UNITS.RMG.code, useId: rmg }),
      entry('p-gran-status@', 'EQUIPMENT_USE', { equipmentRef: 'FBD', equipmentCode: UNITS.FBD.code, useId: fbd }),
    ],
  });
  for (const n of [1, 2] as const) {
    const ctx = `R-GRAN=${n}`;
    const k = (step: string) => `${step}@${ctx}`;
    await g.step(k('p-binder'), { entries: [entry(k('p-binder'), 'PREPARED', { quantity: { value: '7.200', unit: 'kg' }, appearance: 'COMPLIES' })] });
    const prepared = await g.entryId(k('p-binder'), 'PREPARED');
    const extra = plan.extraIpa[n - 1];
    await g.d.ok('supervisor1', { type: 'CHOOSE_ALTERNATIVE', construct: 'A-IPA', context: ctx, branch: extra ? 'B-IPA-EXTRA' : 'B-IPA-NONE', reason: extra ? 'Wet mass too dry at the end of binder addition' : 'Wet mass consistency normal' });
    if (extra) {
      await g.step(k('p-ipa-extra'), { meaning: 'WITNESSED', entries: [entry(k('p-ipa-extra'), 'EXTRA_FLUID', { quantity: { value: extra, unit: 'kg' }, reason: 'Wet mass too dry: extra isopropyl alcohol within the MBR maximum' })] });
    }
    await g.step(k('p-gran'), {
      entries: [
        entry(k('p-gran'), 'MASSING_START', {}),
        entry(k('p-gran'), 'BINDER_ADDITION', { preparation: prepared, quantity: { value: '7.200', unit: 'kg' } }),
        { wait: 5 },
        entry(k('p-gran'), 'END_POINT', {}),
      ],
    });
    const lods = plan.lods[n - 1] ?? [];
    for (let i = 1; i <= lods.length; i += 1) {
      const dk = `p-dry@${ctx}/L-DRY=${i}`;
      await g.step(dk, {
        meaning: 'WITNESSED',
        entries: [
          entry(dk, 'BAG_CHECK', { bag: 'FBD-01-BAG-1', when: 'BEFORE', result: 'INTACT', lastProduct: 'GBT01-250' }),
          entry(dk, 'DRYING_START', {}),
          { wait: 40 },
          entry(dk, 'DRYING_END', {}),
          entry(dk, 'LOD_SAMPLE', { analyser: 'MA-GRAN-01', sampleMass: { value: '5.012', unit: 'g' } }),
          { type: 'RECORD_DATA', stepKey: dk, item: 'lod', value: { kind: 'DECIMAL', value: lods[i - 1] ?? '', unit: '%' }, source: { mode: 'MANUAL' } },
          entry(dk, 'BAG_CHECK', { bag: 'FBD-01-BAG-1', when: 'AFTER', result: 'INTACT' }),
        ],
      });
      if (plan.afterDrying) await plan.afterDrying(g, dk);
      await g.d.ok('operator1', { type: 'COMPLETE_LOOP_ITERATION', stepKey: dk });
    }
    await g.step(k('p-gran-out'), { entries: [output(k('p-gran-out'), 'I-GRAN', plan.granules[n - 1] ?? '', bal)] });
  }
  await g.step('p-gran-yield@');
  await g.closeStage('S-GRAN@');
  await g.release([UNITS.RMG.code, UNITS.FBD.code, 'GRAN-1']);
}

/**
 * Phase 6 slice 6c (tablets 1230; IN-16, PR-16): the specimens of G-21 step `stepKey` while it runs, by `persona` in its
 * own session: START, MIDDLE and END coding specimens showing the record's coding (when the step codes) and a label
 * specimen of each printed item. They are rows of their own, not record entries, so the record head (and its normalised
 * true copy) is unchanged.
 */
export async function recordSpecimens(g: GoldenBatch, stepKey: string, items: readonly string[], persona = 'operator2'): Promise<void> {
  const view = await dbAs<{ steps: { stepKey: string; coding: boolean; expectedCoding: Record<string, string> | null }[] }>(g.w, g.b(persona), persona, 'select tab.packaging_completion_view($1) as r', [g.batchId]);
  const step = view.steps.find((s) => s.stepKey === stepKey);
  if (!step) throw new Error(`${stepKey} is no printed-materials step of ${g.batchNumber}`);
  if (step.coding) {
    for (const position of ['START', 'MIDDLE', 'END']) {
      await dbAs(g.w, g.b(persona), persona, 'select tab.record_coding_specimen($1, $2, $3, $4::jsonb) as r', [g.batchId, stepKey, position, JSON.stringify(step.expectedCoding)]);
    }
  }
  for (const item of items) await dbAs(g.w, g.b(persona), persona, 'select tab.record_label_specimen($1, $2, $3, null) as r', [g.batchId, stepKey, item]);
}

/** Phase 6 slice 6c (tablets 1230; PR-34): the post-use inspection of the line, passed, verified by another person. */
export async function recordPostUseInspection(g: GoldenBatch, persona = 'operator2', verifier = 'verifier1'): Promise<void> {
  const checks = { noPrintedMaterial: true, noProduct: true, noDocuments: true, lineClean: true };
  const id = await dbAs<string>(g.w, g.b(persona), persona, 'select tab.record_post_use_inspection($1, $2::jsonb, null) as r', [g.batchId, JSON.stringify(checks)]);
  await dbAs(g.w, g.b(verifier), verifier, 'select tab.verify_post_use_inspection($1) as r', [id]);
}
