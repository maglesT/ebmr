/**
 * The synthetic analytics history (Phase 6A slice 6A-0; interfaces section 6): deterministic, decimal text out, and the
 * seeded shifts and anomalies are where its expected flags say, with the clean subjects clean. The SQL fixture loads.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ADMIN_URL, urlFor } from '../../kernel/test/support/db.ts';
import { analyticsHistory, analyticsHistorySql, HISTORY_ITEMS, HISTORY_SEEDS, type AnalyticsHistory } from '../src/index.ts';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const num = (t: string): number => Number(t);
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const values = (h: AnalyticsHistory, item: string): number[] =>
  h.batches.map((b) => num(h.cppValues.find((v) => v.batch_id === b.batch_id && v.item === item && !v.failed)?.value_text ?? 'NaN'));

describe('analyticsHistory (test-kit)', () => {
  it('is deterministic per seed, writes every GMP value as decimal text and keeps every value within its limits', () => {
    expect(JSON.stringify(analyticsHistory())).toBe(JSON.stringify(analyticsHistory(6)));
    expect(JSON.stringify(analyticsHistory(7).cppValues)).not.toBe(JSON.stringify(analyticsHistory(6).cppValues));
    const h = analyticsHistory();
    expect(h.batches).toHaveLength(30);
    expect(new Set(h.batches.map((b) => b.batch_id)).size).toBe(30);
    for (const v of h.cppValues) {
      for (const t of [v.value_text, v.lower_text, v.upper_text, v.target_text]) expect(t, v.item).toMatch(DECIMAL);
      expect(v.failed, `${v.item} ${v.value_text}`).toBe(num(v.value_text) < num(v.lower_text) || num(v.value_text) > num(v.upper_text));
    }
    for (const c of h.pressCurves) for (const s of c.samples) expect(s.raw_text).toMatch(DECIMAL);
    for (const e of h.manualEntries) expect(e.value_text).toMatch(DECIMAL);
  });

  it('carries the seeded shift, the broken correlation and the room with three times the deviation rate', () => {
    for (const seed of [6, 7, 11]) {
      const h = analyticsHistory(seed);
      const ep = values(h, HISTORY_ITEMS.endpoint.item);
      const centre = mean(ep.slice(0, 20));
      // Nine in a row above the Phase I centre (batches 22 to 30), the mean of 24 to 30 about one sigma up.
      expect(ep.slice(HISTORY_SEEDS.nelsonRunFrom - 1).every((x) => x > centre), String(seed)).toBe(true);
      const up = mean(ep.slice(HISTORY_SEEDS.shiftFrom - 1)) - centre;
      expect(up, String(seed)).toBeGreaterThan(0.5 * HISTORY_ITEMS.endpoint.sd);
      expect(up, String(seed)).toBeLessThan(2 * HISTORY_ITEMS.endpoint.sd);
      // Hardness and thickness move together, but not on batch 27, which stays within every limit.
      const hz = values(h, HISTORY_ITEMS.hardness.item).map((x) => (x - HISTORY_ITEMS.hardness.mean) / HISTORY_ITEMS.hardness.sd);
      const tz = values(h, HISTORY_ITEMS.thickness.item).map((x) => (x - HISTORY_ITEMS.thickness.mean) / HISTORY_ITEMS.thickness.sd);
      const others = hz.map((x, i) => [x, tz[i] ?? 0] as const).filter((_, i) => i !== HISTORY_SEEDS.brokenCorrelation - 1);
      const corr = mean(others.map(([a, b]) => a * b)) / Math.sqrt(mean(others.map(([a]) => a * a)) * mean(others.map(([, b]) => b * b)));
      expect(corr, String(seed)).toBeGreaterThan(0.7);
      const i27 = HISTORY_SEEDS.brokenCorrelation - 1;
      expect((hz[i27] ?? 0) * (tz[i27] ?? 0)).toBeLessThan(-1);
      // Deviations: R-2 at three times the others' share of batches.
      const room = (id: string): string => h.stepUses.find((s) => s.batch_id === id && s.step === 'compression')?.room_code ?? '';
      const share = (inR2: boolean): number => {
        const bs = h.batches.filter((b) => (room(b.batch_id) === 'R-2') === inR2);
        return bs.filter((b) => h.deviations.some((d) => d.batch_id === b.batch_id)).length / bs.length;
      };
      expect(share(true)).toBeCloseTo(3 * share(false), 10);
    }
  });

  it('carries each seeded audit anomaly once, the clean persons none, and one abnormal press curve among 20 normal ones', () => {
    const h = analyticsHistory();
    const person = (key: string) => h.persons.find((p) => p.key === key)!;
    const lag = (e: { recorded_at: string; claimed_at: string | null }): number => (Date.parse(e.recorded_at) - Date.parse(e.claimed_at ?? e.recorded_at)) / 60_000;
    const late = h.auditEvents.filter((e) => lag(e) > 15);
    expect(late.map((e) => e.person_id)).toEqual([person('op-late').person_id]);
    for (const p of h.persons.filter((x) => x.anomaly === null)) {
      expect(h.auditEvents.filter((e) => e.person_id === p.person_id).every((e) => lag(e) >= 0 && lag(e) <= 15), p.key).toBe(true);
      const ends = h.manualEntries.filter((e) => e.person_id === p.person_id).map((e) => e.value_text.slice(-1));
      expect(new Set(ends).size, p.key).toBeGreaterThan(3);
    }
    const digits = h.manualEntries.filter((e) => e.person_id === person('op-digits').person_id);
    expect(digits.length).toBeGreaterThanOrEqual(50);
    expect(digits.every((e) => /[05]$/.test(e.value_text))).toBe(true);
    const two = h.authEvents.filter((e) => e.person_id === person('op-two').person_id).sort((a, b) => (a.at < b.at ? -1 : 1));
    const pairs = two.slice(1).filter((e, i) => e.terminal !== two[i]!.terminal && Date.parse(e.at) - Date.parse(two[i]!.at) <= 60_000);
    expect(pairs).toHaveLength(1);
    const repeats = h.cppValues.filter((v) => v.person_id === person('op-repeat').person_id);
    expect(repeats.map((v) => [v.attempt, v.failed])).toEqual([[1, true], [2, true], [3, false]]);
    expect(h.deviations.some((d) => d.batch_id === repeats[0]!.batch_id)).toBe(false);
    expect(h.pressCurves).toHaveLength(21);
    expect(h.pressCurves.filter((c) => c.abnormal).map((c) => c.batch_id)).toEqual([h.batches[HISTORY_SEEDS.abnormalCurve - 1]!.batch_id]);
    expect(h.expected.map((e) => `${e.method} ${e.rule}`)).toEqual([
      'SPC.IMR NELSON_2', 'MSPC.PCA Q_ABOVE', 'RATE.DEVIATION RATE_ABOVE', 'ATA.RULES LATE_ENTRY', 'ATA.RULES BACK_DATED', 'ATA.RULES TWO_TERMINALS',
      'ATA.RULES TOO_REGULAR', 'ATA.RULES REPEAT_UNTIL_PASS', 'GBP.DTW_BAND OUT_OF_BAND',
    ]);
  });

  it('loads as SQL into view-shaped tables with every row', async () => {
    const h = analyticsHistory();
    const name = `ebmr_t_hist_${randomBytes(4).toString('hex')}`;
    const server = new pg.Client({ connectionString: ADMIN_URL });
    await server.connect();
    await server.query(`create database ${name} template template0 encoding 'UTF8'`);
    try {
      const c = new pg.Client({ connectionString: urlFor(name) });
      await c.connect();
      try {
        await c.query(analyticsHistorySql(h));
        const count = async (t: string): Promise<number> => Number((await c.query<{ n: string }>(`select count(*) as n from analytics_fixture.${t}`)).rows[0]?.n);
        expect(await count('batch_fact_v1')).toBe(30);
        expect(await count('cpp_value_v1')).toBe(h.cppValues.length);
        expect(await count('audit_fact_v1')).toBe(h.auditEvents.length);
        expect(await count('series_sample_v1')).toBe(21 * 120);
        const { rows } = await c.query<{ v: string }>("select value_text as v from analytics_fixture.cpp_value_v1 where item = 'granulation.endpoint' order by recorded_at limit 1");
        expect(rows[0]!.v).toBe(h.cppValues.find((v) => v.item === 'granulation.endpoint')!.value_text);
      } finally {
        await c.end();
      }
    } finally {
      await server.query(`drop database ${name} with (force)`);
      await server.end();
    }
  });
});
