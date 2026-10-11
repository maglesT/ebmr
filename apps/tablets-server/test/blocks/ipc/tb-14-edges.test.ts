/**
 * TB-14@1 friability (tablets spec C-15, E.4) at its edges, through its exported handlers with a minimal view: the
 * doubtful first run and its repeats per stream, the mass, sample, rotation and rate limits at their boundaries, the
 * reported loss against the limit (equal passes), the mean of three runs, and the definition checks. Written for the
 * Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks } from '@ebmr/recipe-core/pure';
import { acceptFriabilityRun, friabilityConfigProblems, friabilityNominal, pendingFriability, TB14 } from '../../../src/blocks/tb-14.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const NOW = 1_800_000_000_000_000n;
const view = (entries: E[] = [], o: { type?: string; config?: Json } = {}): blocks.HandlerView =>
  ({
    phase: { block: { type: o.type ?? 'TB-14', version: '1' } },
    config: o.config ?? { tabletType: 'UNCOATED' },
    stepKey: 'p@',
    nowUs: NOW,
    entries: (kind?: string) => entries.filter((e) => kind === undefined || e.kind === kind),
    batch: { marketSet: ['IN'] },
    actor: { id: 'OP1' },
  }) as unknown as blocks.HandlerView;
const RUN = friabilityNominal(undefined)[0] as Json & { kind: string };
const run = (extra: Json = {}): Json & { kind: string } => ({ ...RUN, ...extra });
const refused = (r: ReturnType<typeof acceptFriabilityRun>) => (r.ok ? 'ok' : r.problems.map((p) => p.message).join(' | '));
const dataOf = (r: ReturnType<typeof acceptFriabilityRun>): Json => {
  if (!r.ok) throw new Error(refused(r));
  return r.t.data;
};
/** Records `entry` in `entries` (as the engine would) and returns its stored data. */
const record = (entries: E[], entry: Json & { kind: string }, o: { type?: string; config?: Json } = {}): Json => {
  const d = dataOf(acceptFriabilityRun(view(entries, o), entry));
  entries.push({ id: `R${entries.length + 1}`, kind: 'FRIABILITY_RUN', data: d, recordedAt: NOW - 100n + BigInt(entries.length) });
  return d;
};

describe('TB-14 friability runs', () => {
  it('[IN-35][PR-29] the C-15 run stores its masses, average weight, loss, reported loss, limit and rule sets', () => {
    expect(dataOf(acceptFriabilityRun(view(), run()))).toMatchObject({
      tablets: 26, initialMass: '6.512', finalMass: '6.470', rotations: 100, rpm: '25.0', broken: false, run: 1,
      ruleSets: [{ code: 'IP-FRIABILITY', version: 1 }], averageWeight: '250.46', loss: '0.6450', reported: '0.6', limit: '1', result: 'PASS',
    });
    expect(dataOf(acceptFriabilityRun(view(), run()))).not.toHaveProperty('doubtful');
    expect(dataOf(acceptFriabilityRun(view(), run()))).not.toHaveProperty('meanOfRuns');
  });

  it('[PR-29] the mass after lies between zero and the mass before (both ends allowed); the sample, rotations and rate follow the rule set (rate ends allowed)', () => {
    expect(refused(acceptFriabilityRun(view(), run({ finalMass: '6.513' })))).toBe('The mass after the test lies between zero and the mass before it (TB14-MASS; PR-29)');
    expect(refused(acceptFriabilityRun(view(), run({ finalMass: '-0.001' })))).toBe('The mass after the test lies between zero and the mass before it (TB14-MASS; PR-29)');
    expect(dataOf(acceptFriabilityRun(view(), run({ finalMass: '6.512' })))['reported']).toBe('0.0');
    expect(dataOf(acceptFriabilityRun(view(), run({ finalMass: '0' })))['result']).toBe('REPEAT');
    expect(refused(acceptFriabilityRun(view(), run({ tablets: 20, initialMass: '5.000', finalMass: '4.990' })))).toBe(
      'The sample does not follow the rule set: 20 tablets weighing 5 g are not the whole number of tablets nearest to 6.5 g (TB14-SAMPLE; PR-29, IN-35)',
    );
    expect(refused(acceptFriabilityRun(view(), run({ rotations: 99 })))).toBe('The drum turns 100 times, not 99 (TB14-ROTATIONS; PR-29)');
    expect(refused(acceptFriabilityRun(view(), run({ rpm: '23.9' })))).toBe('The drum turns at 24 to 26 rpm, not 23.9 (TB14-RATE; PR-29)');
    expect(refused(acceptFriabilityRun(view(), run({ rpm: '26.1' })))).toBe('The drum turns at 24 to 26 rpm, not 26.1 (TB14-RATE; PR-29)');
    expect(refused(acceptFriabilityRun(view(), run({ rpm: '24' })))).toBe('ok');
    expect(refused(acceptFriabilityRun(view(), run({ rpm: '26' })))).toBe('ok');
    expect(refused(acceptFriabilityRun(view(), run({ readings: ['00000000-0000-4000-8000-000000000301'] })))).toMatch(/TB14-READINGS/);
  });

  it('[IN-35][PR-29] a first run reported at the limit passes, above it asks for two repeats; a broken tablet fails at once; the MBR may tighten the limit', () => {
    // 6.512 g to 6.447 g: 0.998 %, reported 1.0 %.
    expect(dataOf(acceptFriabilityRun(view(), run({ finalMass: '6.447' })))).toMatchObject({ reported: '1.0', result: 'PASS' });
    expect(dataOf(acceptFriabilityRun(view(), run({ finalMass: '6.440' })))).toMatchObject({ reported: '1.1', result: 'REPEAT' });
    expect(dataOf(acceptFriabilityRun(view(), run({ broken: true })))).toMatchObject({ broken: true, result: 'FAIL' });
    expect(dataOf(acceptFriabilityRun(view([], { config: { tabletType: 'UNCOATED', limitPercent: '0.5' } }), run()))).toMatchObject({ limit: '0.5', result: 'REPEAT' });
  });

  it('[INV-41][DI-29] a doubtful first run is repeated twice; the mean of the three is judged (equal to the limit passes); repeats never replace it', () => {
    expect(refused(acceptFriabilityRun(view(), run({ doubtful: false })))).toBe('Doubtful is stated only when it is so (TB14-DOUBTFUL; DI-29)');
    const entries: E[] = [];
    expect(record(entries, run({ doubtful: true }))).toMatchObject({ doubtful: true, run: 1, result: 'REPEAT' });
    expect(pendingFriability(view(entries))).toEqual(['R1']);
    expect(refused(acceptFriabilityRun(view(entries), run()))).toBe('p@ waits for the repeat runs of its friability test; a new first run never replaces them (TB14-REPEAT-PENDING; INV-41, DI-29)');
    expect(refused(acceptFriabilityRun(view(entries), run({ repeatOf: 'R1', doubtful: true })))).toBe('Only the first run is found doubtful (TB14-DOUBTFUL; DI-29)');
    expect(refused(acceptFriabilityRun(view(entries), run({ repeatOf: 'R9' })))).toBe('R9 is not a first friability run of p@ waiting for its repeats (TB14-NOT-REPEATED; PR-29, INV-41)');
    expect(record(entries, run({ repeatOf: 'R1', finalMass: '6.447' }))).toMatchObject({ repeatOf: 'R1', run: 2, result: 'REPEAT' });
    expect(refused(acceptFriabilityRun(view(entries), run({ repeatOf: 'R2' })))).toBe('R2 is not a first friability run of p@ waiting for its repeats (TB14-NOT-REPEATED; PR-29, INV-41)');
    // Losses 0.645 %, 0.998 % and 1.356 %: mean 0.9998 %, reported 1.0 %, at the limit.
    expect(record(entries, run({ repeatOf: 'R1', finalMass: '6.42370' }))).toMatchObject({ repeatOf: 'R1', run: 3, meanOfRuns: '1.0', result: 'PASS' });
    expect(pendingFriability(view(entries))).toEqual([]);
    expect(refused(acceptFriabilityRun(view(entries), run({ repeatOf: 'R1' })))).toMatch(/^R1 is not a first friability run of p@ waiting for its repeats/);
    // A mean above the limit fails.
    const high: E[] = [];
    record(high, run({ finalMass: '6.440' }));
    record(high, run({ repeatOf: 'R1', finalMass: '6.440' }));
    expect(record(high, run({ repeatOf: 'R1', finalMass: '6.440' }))).toMatchObject({ run: 3, meanOfRuns: '1.1', result: 'FAIL' });
  });

  it('[INV-41][PR-29] on a TB-11 scheduler, the repeats are per stream: a repeat tests its first run\'s stream, and another stream starts its own test', () => {
    const t11 = { streams: [{ id: 'S1' }, { id: 'S2' }], friability: { tabletType: 'UNCOATED' } };
    const entries: E[] = [];
    record(entries, run({ stream: 'S1', doubtful: true }), { type: 'TB-11', config: t11 });
    expect(refused(acceptFriabilityRun(view(entries, { type: 'TB-11', config: t11 }), run({ stream: 'S2' })))).toBe('ok');
    expect(refused(acceptFriabilityRun(view(entries, { type: 'TB-11', config: t11 }), run({ stream: 'S1' })))).toMatch(/TB14-REPEAT-PENDING/);
    expect(refused(acceptFriabilityRun(view(entries, { type: 'TB-11', config: t11 }), run({ stream: 'S2', repeatOf: 'R1' })))).toBe('A repeat run tests the same stream as its first run (TB14-NOT-REPEATED; PR-29)');
    expect(record(entries, run({ stream: 'S1', repeatOf: 'R1' }), { type: 'TB-11', config: t11 })).toMatchObject({ stream: 'S1', run: 2 });
  });

  it('[IN-35][PR-29] the step: an entry of another kind is refused, PERFORMED needs a run and no repeats pending', () => {
    const accept = TB14.handler?.acceptEntry as (v: blocks.HandlerView, e: Json & { kind: string }) => { ok: boolean; problems?: { message: string }[] };
    expect(accept(view(), { kind: 'OTHER' }).problems?.map((p) => p.message)).toEqual(['OTHER is not an entry of a friability step (TB14-ENTRY; PR-29)']);
    const before = TB14.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[];
    expect(before(view()).map((p) => p.message)).toEqual(['p@ has no friability run (TB14-NO-RUN; PR-29, IN-35)']);
    const entries: E[] = [];
    record(entries, run({ doubtful: true }));
    expect(before(view(entries)).map((p) => p.message)).toEqual(['p@ waits for the repeat runs of its friability test (TB14-REPEAT-PENDING; INV-41, PR-29)']);
    expect(friabilityNominal('S1')[0]).toMatchObject({ stream: 'S1' });
    expect(friabilityNominal(undefined)[0]).not.toHaveProperty('stream');
  });

  it('[IN-35][DI-10] definition checks: a rule set covers the tablet type for every market; an in-house limit is never looser (equal allowed)', () => {
    const P = (cfg: Json, markets = ['IN']) => friabilityConfigProblems('F', cfg, markets).map((p) => `${p.code} [${p.controls.join(',')}] ${p.message}`);
    expect(P({ tabletType: 'UNCOATED' })).toEqual([]);
    expect(P({ tabletType: 'UNCOATED', limitPercent: '1.0' })).toEqual([]);
    expect(P({ tabletType: 'UNCOATED', limitPercent: '1.01' })).toEqual(["TB14-LOOSER [PR-29,IN-35] F: the in-house limit of 1.01 % is looser than the rule sets' 1 %"]);
    expect(P({ tabletType: 'NOT_A_TYPE' })).toEqual(['TB14-NO-RULE-SET [PR-29,DI-10] F: no friability rule set covers NOT_A_TYPE tablets']);
    expect(P({ tabletType: 'UNCOATED' }, ['IN', 'XX'])).toEqual(['TB14-NO-RULE-SET [PR-29,DI-10] F: no friability rule set covers UNCOATED tablets']);
  });
});
