/**
 * The due-time functions and the held-granulation check in the database alone (SQL mutation groups "tablets-ipc",
 * "packaging-blister", "packaging-bottle" and "tablets-granulation"; tablets 0851, 0892, 0971, 0986, 0989, 1110; Phase
 * 4 slice 7c, the "not twins" of the Phase 3 exit run). The sweeper and the record's overdue view read these functions
 * alone; no engine check computes the same instants in front of them:
 *
 *   * tab.ipc_due / tab.ipc_overdue / tab.ipc_overdue_at: when an in-process check slot (stream, test) falls due from the
 *     run's start, the slot's own last check or a missed record, the plan's interval, a change (sooner), a stoppage (the
 *     end of one the due instant fell in; a long one restarts the clock), the run's end; whether a running stoppage
 *     suspends it; which slots are overdue past the grace at an instant, and for which running steps of a batch.
 *   * tab.leak_due / tab.leak_overdue: the leak test of each track, from its last test or missed record, sooner on a
 *     trigger event after it, never after the run's end.
 *   * tab.packline_last_check / tab.packline_missed / tab.packline_overdue: the bottle and carton line checks and the
 *     device challenges (from the last passing one) that are overdue.
 *   * tab.gran_held: whether a row newly raised the holding exception of a step (ACTION, deviation required, holding
 *     downstream until a deviation is linked).
 *
 * Times are minutes on the record's microsecond clock ({"$u": ...}); each function is called directly.
 *
 * Controls: IN-35, PR-17 (in-process checks at their intervals), IN-36, PR-18, PR-19, INV-12.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';
import { batchWith, code, inCommand, replica, value, type Json } from './kill-support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

const MIN = 60_000_000;
const at = (min: number): Json => ({ $u: String(min * MIN) });
const us = (min: number): string => String(min * MIN);
let seq = 0;
const e = (kind: string, min: number, data: Json = {}): Json => ({ kind, recordedAt: at(min), recordedSeq: String(++seq), data });
const minutes = (v: string | null): number | null => (v === null ? null : Number(v) / MIN);

const CFG: Json = {
  streams: [{ id: 'A' }, { id: 'B' }],
  plan: [{ test: 'WEIGHT', every: { value: '30', unit: 'min' } }, { test: 'PHYSICAL', every: { value: '60', unit: 'min' } }, { test: 'FRIABILITY' }],
  sweep: { every: { value: '45', unit: 'min' } },
  grace: { value: '5', unit: 'min' },
};

describe('in-process check due times (tablets 0892, 1110)', () => {
  it('[IN-35][PR-17] a slot falls due from the run start or its own last check or missed record, plus the plan\'s interval; sooner on a change after it; at the end of a stoppage it fell in; at the end of a long one; never after the run\'s end; a running stoppage suspends it', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const due = async (prior: Json[], stream: string, test: string, cfg: Json = CFG): Promise<[number | null, boolean | null]> => {
        const r = (await c.query<{ d: string | null; s: boolean | null }>('select (x).o_due::text as d, (x).o_suspended as s from (select tab.ipc_due($1, $2, $3, $4) as x) y', [
          JSON.stringify(prior), JSON.stringify(cfg), stream, test,
        ])).rows[0];
        return [minutes(r?.d ?? null), r?.s ?? null];
      };
      expect(await due([], 'A', 'WEIGHT')).toEqual([null, false]);
      const start = [e('RUN_START', 0)];
      expect(await due(start, 'A', 'WEIGHT')).toEqual([30, false]);
      expect(await due(start, 'A', 'FRIABILITY')).toEqual([0, false]);
      expect(await due(start, 'A', 'NOT_PLANNED')).toEqual([null, false]);
      expect(await due(start, 'A', 'SWEEP')).toEqual([0, false]);
      expect(await due(start, 'A', 'SWEEP', { ...CFG, sweep: {} })).toEqual([0, false]);

      // Own checks and a missed record; another test's check and another stream's are not the slot's.
      const p1 = [e('RUN_START', 0), e('STATION_SWEEP', 5, { stream: 'A' }), e('WEIGHT_CHECK', 10, { stream: 'A' }), e('PHYSICAL_CHECK', 15, { stream: 'A' }), e('NOTE', 16, { missed: [{ stream: 'B', test: 'WEIGHT' }] })];
      expect(await due(p1, 'A', 'WEIGHT')).toEqual([40, false]);
      expect(await due(p1, 'B', 'WEIGHT')).toEqual([46, false]);
      expect(await due(p1, 'A', 'PHYSICAL')).toEqual([75, false]);
      expect(await due(p1, 'A', 'SWEEP')).toEqual([50, false]);
      expect(await due(p1, 'B', 'SWEEP')).toEqual([0, false]);
      expect(await due(p1, 'A', 'SWEEP', { ...CFG, sweep: {} })).toEqual([null, false]);

      // A change after the last check brings it forward (not one at the check's own instant); never a sweep's.
      const p2 = [e('RUN_START', 0), e('STATION_SWEEP', 2, { stream: 'A' }), e('WEIGHT_CHECK', 10, { stream: 'A' }), e('CHANGE', 10), e('CHANGE', 12)];
      expect(await due(p2, 'A', 'WEIGHT')).toEqual([12, false]);
      expect(await due(p2, 'A', 'SWEEP')).toEqual([47, false]);

      // Stoppages: the due instant inside one moves to its end (also at its very start); a long one restarts the clock
      // (not one exactly as long as the restart time); a sweep never restarts.
      expect(await due([e('RUN_START', 0), e('STOPPAGE_START', 20), e('STOPPAGE_END', 40)], 'A', 'WEIGHT')).toEqual([40, false]);
      expect(await due([e('RUN_START', 0), e('STOPPAGE_START', 30), e('STOPPAGE_END', 35)], 'A', 'WEIGHT')).toEqual([35, false]);
      const p5 = [e('RUN_START', 0), e('STATION_SWEEP', 1, { stream: 'A' }), e('STOPPAGE_START', 5), e('STOPPAGE_END', 25)];
      expect(await due(p5, 'A', 'WEIGHT')).toEqual([25, false]);
      expect(await due(p5, 'A', 'SWEEP')).toEqual([46, false]);
      expect(await due([e('RUN_START', 0), e('STOPPAGE_START', 5), e('STOPPAGE_END', 20)], 'A', 'WEIGHT')).toEqual([30, false]);
      // A running stoppage suspends a slot due at or after its start; one that started before the last check too.
      expect(await due([e('RUN_START', 0), e('STOPPAGE_START', 20)], 'A', 'WEIGHT')).toEqual([30, true]);
      expect(await due([e('RUN_START', 0), e('STOPPAGE_START', 30)], 'A', 'WEIGHT')).toEqual([30, true]);
      expect(await due([e('RUN_START', 0), e('STOPPAGE_START', 35)], 'A', 'WEIGHT')).toEqual([30, false]);
      expect(await due([e('RUN_START', 0), e('STOPPAGE_START', 2), e('WEIGHT_CHECK', 10, { stream: 'A' })], 'A', 'WEIGHT')).toEqual([40, true]);
      expect(await due([e('RUN_START', 0), e('STOPPAGE_START', 2), e('STOPPAGE_END', 8), e('WEIGHT_CHECK', 10, { stream: 'A' })], 'A', 'WEIGHT')).toEqual([40, false]);
      expect(await due([e('RUN_START', 0), e('STOPPAGE_START', 20), e('CHANGE', 25)], 'A', 'WEIGHT')).toEqual([25, true]);
      // The run's end: a check due later falls due at the end; a sweep not yet due is no longer due at all.
      expect(await due([e('RUN_START', 0), e('RUN_END', 20)], 'A', 'WEIGHT')).toEqual([20, false]);
      expect(await due([e('RUN_START', 0), e('RUN_END', 20)], 'A', 'SWEEP')).toEqual([0, false]);
      expect(await due([e('RUN_START', 0), e('STATION_SWEEP', 5, { stream: 'A' }), e('RUN_END', 20)], 'A', 'SWEEP')).toEqual([null, false]);
      expect(await due([e('RUN_START', 0), e('STATION_SWEEP', 5, { stream: 'A' }), e('RUN_END', 50)], 'A', 'SWEEP')).toEqual([null, false]);
      expect(await due([e('RUN_START', 0), e('STATION_SWEEP', 5, { stream: 'A' }), e('RUN_END', 51)], 'A', 'SWEEP')).toEqual([50, false]);
    });
  });

  it('[IN-35][PR-17] the overdue slots at an instant: every stream with every planned test and the sweep, past the grace, never a suspended one; the running in-process steps of a batch', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const overdue = (prior: Json[], now: number, cfg: Json = CFG) => value<Json[]>(c, 'select tab.ipc_overdue($1, $2, $3) as r', [JSON.stringify(prior), JSON.stringify(cfg), us(now)]);
      const slot = (stream: string, test: string, due: number): Json => ({ stream, test, by: 'TIME', dueUs: us(due) });
      const p = [e('RUN_START', 0), e('WEIGHT_CHECK', 10, { stream: 'A' })];
      const noFri = { ...CFG, plan: [{ test: 'WEIGHT', every: { value: '30', unit: 'min' } }, { test: 'PHYSICAL', every: { value: '60', unit: 'min' } }] };
      expect(await overdue(p, 35, noFri)).toEqual([slot('A', 'SWEEP', 0), slot('B', 'SWEEP', 0)]);
      expect(await overdue(p, 36, noFri)).toEqual([slot('A', 'SWEEP', 0), slot('B', 'WEIGHT', 30), slot('B', 'SWEEP', 0)]);
      expect(await overdue(p, 31, { ...noFri, grace: undefined })).toEqual([slot('A', 'SWEEP', 0), slot('B', 'WEIGHT', 30), slot('B', 'SWEEP', 0)]);
      expect(await overdue(p, 30, { ...noFri, grace: undefined })).toEqual([slot('A', 'SWEEP', 0), slot('B', 'SWEEP', 0)]);
      expect(await overdue(p, 100, { ...noFri, sweep: undefined })).toEqual([slot('A', 'WEIGHT', 40), slot('A', 'PHYSICAL', 60), slot('B', 'WEIGHT', 30), slot('B', 'PHYSICAL', 60)]);
      expect(await overdue(p, 100, { ...noFri, plan: {} })).toEqual([slot('A', 'SWEEP', 0), slot('B', 'SWEEP', 0)]);
      expect(await overdue(p, 100, { ...noFri, streams: {} })).toEqual([]);
      expect(await overdue([...p, e('STOPPAGE_START', 20)], 100, noFri)).toEqual([slot('A', 'SWEEP', 0), slot('B', 'SWEEP', 0)]);
      expect(await overdue([], 100, noFri)).toEqual([]);

      // A batch's running TB-11 step (not a completed one) at an instant; the instant is required.
      const content = { procedure: { kind: 'procedure', id: 'proc', children: [{ kind: 'phase', id: 'p-ipc', block: { type: 'TB-11', version: '1' }, config: noFri }] } };
      let B = '';
      await replica(c, async () => {
        B = await batchWith(c, gmp.seed.siteCode, content);
        const entries: Record<string, Json> = {};
        for (const [k, en] of [['a', e('RUN_START', 0)], ['b', e('WEIGHT_CHECK', 10, { stream: 'A' })], ['c', e('RUN_START', 0)]] as const) {
          entries[k] = { ...en, stepKey: k === 'c' ? 'p-ipc@2' : 'p-ipc@1' };
        }
        await c.query(
          "insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, $2, 1, repeat('0', 64), 1, repeat('0', 64), 'IN_PROGRESS')",
          [B, JSON.stringify({ steps: { 'p-ipc@1': { step: 'p-ipc', status: 'IN_PROGRESS' }, 'p-ipc@2': { step: 'p-ipc', status: 'COMPLETED' } }, entries })],
        );
      });
      const atInstant = (t: string | null) => value<Json[]>(c, 'select tab.ipc_overdue_at($1, $2::timestamptz) as r', [B, t]);
      expect(await atInstant('1970-01-01T00:36:00Z')).toEqual([
        { stepKey: 'p-ipc@1', ...slot('A', 'SWEEP', 0) }, { stepKey: 'p-ipc@1', ...slot('B', 'WEIGHT', 30) }, { stepKey: 'p-ipc@1', ...slot('B', 'SWEEP', 0) },
      ]);
      expect(await code(c, 'select tab.ipc_overdue_at($1, null) as r', [B])).toBe('EBMR-TAB-303');
      await replica(c, async () => {
        await c.query("update recipe.execution_state set state = jsonb_set(state, '{steps}', '[]') where batch_id = $1", [B]);
      });
      expect(await atInstant('1970-01-01T00:36:00Z')).toEqual([]);
    });
  });
});

describe('leak test due times (tablets 0971)', () => {
  it('[IN-35][PR-17] each track falls due from the run start or its own last test or missed record plus the interval; sooner at a trigger event after it; at the run\'s end at the latest, never after a test at or after the end; overdue past the grace', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const L: Json = { every: { value: '30', unit: 'min' }, tracks: ['T1', 'T2'], grace: { value: '5', unit: 'min' } };
      const due = async (prior: Json[], track: string, cfg: Json = L) => minutes(await value<string | null>(c, 'select tab.leak_due($1, $2, $3)::text as r', [JSON.stringify(prior), JSON.stringify(cfg), track]));
      expect(await due([], 'T1')).toBeNull();
      expect(await due([e('RUN_START', 0)], 'T1', { ...L, every: undefined })).toBeNull();
      expect(await due([e('RUN_START', 0)], 'T1')).toBe(0);
      const p2 = [e('RUN_START', 0), e('LEAK_TEST', 10, { track: 'T1' })];
      expect(await due(p2, 'T1')).toBe(40);
      expect(await due(p2, 'T2')).toBe(0);
      const p3 = [e('RUN_START', 0), e('NOTE', 12, { missed: [{ stream: 'T2' }] })];
      expect(await due(p3, 'T2')).toBe(42);
      expect(await due(p3, 'T1')).toBe(0);
      expect(await due([...p2, e('EVENT', 20, { event: 'REEL_CHANGE' }), e('EVENT', 15, { event: 'OTHER' })], 'T1')).toBe(20);
      expect(await due([...p2, e('EVENT', 20, { event: 'REEL_CHANGE' })], 'T1', { ...L, triggers: ['ADJUSTMENT'] })).toBe(40);
      expect(await due([...p2, e('EVENT', 10, { event: 'RESTART' })], 'T1')).toBe(40);
      expect(await due([...p2, e('EVENT', 50, { event: 'RESTART' })], 'T1')).toBe(40);
      expect(await due([...p2, e('NOTE', 20, { event: 'RESTART' })], 'T1')).toBe(40);
      expect(await due([...p2, e('RUN_END', 20)], 'T1')).toBe(20);
      expect(await due([e('RUN_START', 0), e('LEAK_TEST', 20, { track: 'T1' }), e('RUN_END', 20)], 'T1')).toBeNull();
      expect(await due([e('RUN_START', 0), e('RUN_END', 0)], 'T1')).toBe(0);
      const over = (prior: Json[], now: number, cfg: Json = L) => value<Json[]>(c, 'select tab.leak_overdue($1, $2, $3) as r', [JSON.stringify(prior), JSON.stringify(cfg), us(now)]);
      const slot = (t: string, d: number): Json => ({ stream: t, test: 'LEAK', by: 'TIME', dueUs: us(d) });
      expect(await over(p2, 45)).toEqual([slot('T2', 0)]);
      expect(await over(p2, 46)).toEqual([slot('T1', 40), slot('T2', 0)]);
      expect(await over(p2, 41, { ...L, grace: undefined })).toEqual([slot('T1', 40), slot('T2', 0)]);
      expect(await over([e('RUN_START', 0)], 1, { every: L['every'] })).toEqual([slot('LEAK', 0)]);
      expect(await over([], 100)).toEqual([]);
    });
  });
});

describe('bottle and carton line checks (tablets 0986, 0989)', () => {
  it('[IN-35][PR-17][IN-36] the last check of a stream (with a result); missed when later than the interval; the overdue line checks of TB-23 and TB-24 and device challenges from their last pass, except once ended', async () => {
    await inCommand(gmp, 'operator1', async (c: PoolClient) => {
      const chk = (stream: string, min: number, result: unknown = 'PASS'): Json => e('LINE_CHECK', min, { stream, result });
      const p = [chk('COUNT', 0), chk('TORQUE', 5), chk('COUNT', 10), { ...chk('COUNT', 12), data: { stream: 'COUNT' } }];
      const last = (prior: unknown, stream: string) => value<Json | null>(c, 'select tab.packline_last_check($1, $2) as r', [JSON.stringify(prior), stream]);
      expect(await last(p, 'COUNT')).toEqual(p[2]);
      expect(await last(p, 'TORQUE')).toEqual(p[1]);
      expect(await last(p, 'SEAL')).toBeNull();
      expect(await last({ a: p[0] }, 'COUNT')).toBeNull();
      const missed = (stream: string, every: number | null, now: number) => value<boolean>(c, 'select tab.packline_missed($1, $2, $3, $4) as r', [JSON.stringify(p), stream, every === null ? null : us(every), us(now)]);
      expect(await missed('COUNT', null, 100)).toBe(false);
      expect(await missed('SEAL', 30, 100)).toBe(false);
      expect(await missed('COUNT', 30, 40)).toBe(false);
      expect(await missed('COUNT', 30, 41)).toBe(true);
      // A last check with no instant on the record clock is never read as missed.
      const noTime = [{ kind: 'LINE_CHECK', recordedSeq: '1', data: { stream: 'COUNT', result: 'PASS' } }];
      expect(await value<boolean>(c, 'select tab.packline_missed($1, $2, $3, $4) as r', [JSON.stringify(noTime), 'COUNT', us(30), us(100)])).toBe(false);

      const over = (prior: Json[], cfg: Json, type: string, now: number) => value<Json[]>(c, 'select tab.packline_overdue($1, $2, $3, $4) as r', [JSON.stringify(prior), JSON.stringify(cfg), type, us(now)]);
      const slot = (stream: string, test: string, d: number): Json => ({ stream, test, by: 'TIME', dueUs: us(d) });
      const every = (m: number): Json => ({ value: String(m), unit: 'min' });
      const b = [chk('COUNT', 0), chk('DESICCANT', 10), chk('TORQUE', 20)];
      const bottle = { checkEvery: every(30), desiccant: {} };
      expect(await over(b, bottle, 'TB-23', 40)).toEqual([slot('COUNT', 'LINE_CHECK', 30)]);
      expect(await over(b, bottle, 'TB-23', 41)).toEqual([slot('COUNT', 'LINE_CHECK', 30), slot('DESICCANT', 'LINE_CHECK', 40)]);
      expect(await over(b, { checkEvery: every(30) }, 'TB-23', 41)).toEqual([slot('COUNT', 'LINE_CHECK', 30)]);
      expect(await over(b, bottle, 'TB-24', 100)).toEqual([]);
      expect(await over(b, { desiccant: {} }, 'TB-23', 100)).toEqual([]);
      expect(await over([...b, chk('SEAL', 0)], bottle, 'TB-23', 51)).toEqual([slot('COUNT', 'LINE_CHECK', 30), slot('DESICCANT', 'LINE_CHECK', 40), slot('TORQUE', 'LINE_CHECK', 50), slot('SEAL', 'LINE_CHECK', 30)]);

      const ch = (device: string, min: number, result: string, extra: Json = {}): Json => e('CHALLENGE', min, { device, result, trigger: 'INTERVAL', ...extra });
      const carton = {
        atd: { every: every(60) },
        examination: { every: every(45) },
        devices: [{ id: 'CW', every: every(20) }, { id: 'VIS' }, { id: 'MD', every: every(20) }, { id: 'LD', every: every(20) }],
      };
      const t = [chk('ATD', 0), chk('EXAM', 0), ch('CW', 10, 'PASS'), ch('CW', 15, 'FAIL'), ch('VIS', 12, 'PASS'), ch('MD', 5, 'PASS', { trigger: 'END' }), ch('LD', 3, 'PASS', { at: String(8 * MIN) }), e('NOTE', 1, { device: 'CW', result: 'PASS' })];
      expect(await over(t, carton, 'TB-24', 100)).toEqual([slot('ATD', 'LINE_CHECK', 60), slot('EXAM', 'LINE_CHECK', 45), slot('D.CW', 'CHALLENGE', 30), slot('D.LD', 'CHALLENGE', 28)]);
      expect(await over(t, carton, 'TB-24', 30)).toEqual([slot('D.LD', 'CHALLENGE', 28)]);
      expect(await over(t, carton, 'TB-24', 28)).toEqual([]);
      expect(await over([...t, e('EXAMINATION', 50, { timing: 'END' })], carton, 'TB-24', 100)).toEqual([slot('ATD', 'LINE_CHECK', 60), slot('D.CW', 'CHALLENGE', 30), slot('D.LD', 'CHALLENGE', 28)]);
      expect(await over([...t, e('EXAMINATION', 50, { timing: 'START' })], carton, 'TB-24', 100)).toHaveLength(4);
      expect(await over(t, { ...carton, atd: 'x' }, 'TB-24', 100)).toEqual([slot('EXAM', 'LINE_CHECK', 45), slot('D.CW', 'CHALLENGE', 30), slot('D.LD', 'CHALLENGE', 28)]);
      expect(await over(t, carton, 'TB-23', 100)).toEqual([slot('D.CW', 'CHALLENGE', 30), slot('D.LD', 'CHALLENGE', 28)]);
      expect(await over(t, { ...carton, devices: {} }, 'TB-24', 100)).toEqual([slot('ATD', 'LINE_CHECK', 60), slot('EXAM', 'LINE_CHECK', 45)]);
    });
  });
});

describe('the held-granulation check (tablets 0851)', () => {
  it('[PR-18][PR-19][INV-12] true only for an exception the new row raised at this step, of this type, ACTION, a deviation required, holding downstream until a deviation is linked', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const X: Json = { type: 'LOD_OUT', source: { stepKey: 'p-dry@1' }, severity: 'ACTION', deviationRequired: true, block: { until: 'DEVIATION', downstream: { steps: 'ALL' } } };
      const held = (old: unknown, now: unknown, key = 'p-dry@1', type = 'LOD_OUT') => value<boolean>(c, 'select tab.gran_held($1, $2, $3, $4) as r', [JSON.stringify(old), JSON.stringify(now), key, type]);
      expect(await held({}, { exceptions: { x1: X } })).toBe(true);
      expect(await held({ exceptions: { x0: X } }, { exceptions: { x0: X, x1: X } })).toBe(true);
      expect(await held({ exceptions: { x1: X } }, { exceptions: { x1: X } })).toBe(false);
      expect(await held({}, { exceptions: [X] })).toBe(false);
      expect(await held({}, { exceptions: { x1: X } }, 'p-dry@2')).toBe(false);
      expect(await held({}, { exceptions: { x1: X } }, 'p-dry@1', 'OTHER')).toBe(false);
      for (const v of [
        { ...X, severity: 'ALERT' },
        { ...X, deviationRequired: false },
        { ...X, deviationRequired: 'true' },
        { ...X, block: { until: 'QA', downstream: { steps: 'ALL' } } },
        { ...X, block: { until: 'DEVIATION', downstream: 'ALL' } },
        { ...X, block: { until: 'DEVIATION' } },
      ]) {
        expect(await held({}, { exceptions: { x1: v } }), JSON.stringify(v)).toBe(false);
      }
    });
  });
});
