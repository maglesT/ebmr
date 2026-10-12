/**
 * TB-11, Phase 3 exit mutation backlog (medium), fixed in Phase 4 slice 1b (tablets 1110): a station sweep marked missed is
 * dealt with at the marking, in the database's twin tab.ipc_due as in tb-11.ts dueOf, so a missed start sweep does not stay
 * due and later entries do not raise IPC_CHECK_MISSED for it again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueOf } from '../../../src/blocks/tb-11.ts';
import { startExecServer, type ExecServer } from '../../execution/support.ts';

type Json = Record<string, unknown>;

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
}, 180_000);
afterAll(async () => {
  await sbx?.close();
});

const T = 1_800_000_000_000_000n;
const MIN = 60_000_000n;
const at = (m: bigint) => T + m * MIN;
const entry = (kind: string, us: bigint, data: Json = {}) => ({ id: `${kind}@${String(us)}`, kind, data, recordedAt: us, stepKey: 'p@', enteredBy: 'OP1', recordedSeq: 0 });
const wire = (e: ReturnType<typeof entry>) => ({ ...e, recordedAt: { $u: e.recordedAt.toString() } });
const base: Json = { streams: [{ id: 'L' }, { id: 'R' }], plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'Q' }], grace: { value: '5', unit: 'min' } };

async function sqlDue(entries: ReturnType<typeof entry>[], config: Json, stream: string, test: string): Promise<string | null> {
  const { rows } = await sbx.db.admin.query<{ d: string | null }>('select (tab.ipc_due($1::jsonb, $2::jsonb, $3, $4)).o_due::text as d', [JSON.stringify(entries.map(wire)), JSON.stringify(config), stream, test]);
  return rows[0]?.d ?? null;
}
const tsDue = (entries: ReturnType<typeof entry>[], config: Json, stream: string, test: string): string | null => {
  const d = dueOf(entries, config, stream, test as never).dueUs;
  return d === undefined ? null : d.toString();
};

describe('TB-11 missed start sweep (tablets 1110)', () => {
  it('[IN-35][PR-29] the database\'s twin agrees: a start sweep marked missed is not due again without a repeat interval, and due one interval after the marking with one', async () => {
    const once = { ...base, sweep: { stations: 4, weight: {} } };
    const every = { ...base, sweep: { stations: 4, weight: {}, every: { value: '60', unit: 'min' } } };
    const marked = [entry('RUN_START', T), entry('WEIGHT_CHECK', at(10n), { stream: 'L', missed: [{ stream: 'L', test: 'SWEEP', by: 'TIME' }] })];
    for (const [config, stream, want] of [
      [once, 'L', null],
      [once, 'R', T.toString()],
      [every, 'L', at(70n).toString()],
      [every, 'R', T.toString()],
    ] as const) {
      expect(await sqlDue(marked, config, stream, 'SWEEP'), `${stream} ${JSON.stringify(config['sweep'])}`).toBe(want);
      expect(tsDue(marked, config, stream, 'SWEEP')).toBe(want);
    }
    // A sweep actually recorded still counts as before; a weight check's due time is unchanged by the fix.
    const swept = [entry('RUN_START', T), entry('STATION_SWEEP', at(2n), { stream: 'L' })];
    expect(await sqlDue(swept, every, 'L', 'SWEEP')).toBe(at(62n).toString());
    expect(await sqlDue(marked, once, 'L', 'WEIGHT')).toBe(at(35n).toString());
    expect(tsDue(marked, once, 'L', 'WEIGHT')).toBe(at(35n).toString());
  });
});
