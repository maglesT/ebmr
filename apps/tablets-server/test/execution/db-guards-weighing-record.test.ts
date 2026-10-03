/**
 * Lead TODO T2 of the Phase 2 exit, round 2 (INV-25, PR-19, DI-30; recipe-core sql 0322): what the blocks compute from a
 * weighing is checked by the database, not only its net (0321). A container's label carries its weighing's own net and
 * unit, lot and container and the batch's identity (EBMR-EXE-137): the round-1 verification stored a weighing whose net
 * was 50.000 and whose label said "50 kg". And the quantity a step's weighings count into (the dispensed quantity) is the
 * sum of all their nets in the quantity's unit, at the resolution they were weighed at carried through the conversion
 * (EBMR-EXE-138): 50000.0 g is 50.0000 kg, never 50 nor 50.000. The application role is the writer under test.
 *
 * Round 3 (recipe-core sql 0323): which quantity a weighing counts into was the entry's own word (data.item), so the
 * round-2 verification stored a second dispensed container without item, and the honest signature's total then left it
 * out. The database now decides it from the MBR: a dispensed container counts into a mass quantity its phase records, an
 * output container into the first one (EBMR-EXE-139).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf, prepareSignature, unmatched } from './db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const PCM = 'p-disp-pcm@';

/** dc-mini at the paracetamol weighing, started by operator1 (the steps before it done as the server does them). */
async function atWeighing(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  const step = async (key: string, entries: Parameters<RunDriver['ok']>[1][], verify: boolean) => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: key });
    for (const e of entries) await d.ok('operator1', e);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
    if (verify) await d.signed('verifier1', { type: 'VERIFY', stepKey: key, meaning: 'VERIFIED' });
  };
  await step('p-disp-clear@', [
    { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
    { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
  ], true);
  await step('p-disp-bal@', [{ type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } }], false);
  await step('p-disp-sop@', [{ type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } }], false);
  await step('p-disp-calc@', [], false);
  await d.ok('operator1', { type: 'START_STEP', stepKey: PCM });
  return d;
}

type Label = Record<string, unknown>;

/**
 * operator1's hand-keyed weighing of the paracetamol (51.250 - 1.250 kg), resolved and run through the engine as the
 * server does, then stored through the application's role with the new entry's label changed by `forge` (none: the
 * engine's own).
 */
async function weighingWithLabel(d: RunDriver, forge?: (label: Label) => void): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const resolved = await resolveClientIntent(
        { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
        { type: 'RECORD_ENTRY', stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } } },
      );
      const r = engine.step(tx.def, tx.state, resolved.command, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the weighing: ${JSON.stringify(r.refusal)}`);
      const state = structuredClone(r.state);
      const entry = Object.values(state.entries).find((e) => !(e.id in tx.state.entries));
      if (!entry) throw new Error('SETUP: no new entry');
      const label = entry.data['label'] as Label;
      if (label['quantity'] !== '50.000 kg') throw new Error(`SETUP: the engine labelled ${JSON.stringify(label)}`);
      forge?.(label);
      return appendAs(tx, resolved.command, { state, events: r.events }, roles, engine.encodeCommand(resolved.command), engine.changedContents(tx.def, tx.state, state), resolved.evidence as engine.JsonValue);
    }),
  );
}

/**
 * operator1's signed SIGN_PERFORMED of the paracetamol weighing, run through the engine and stored through the
 * application's role with the state changed by `forge` (none: the engine's own result). 'ok', or the refusal's message.
 */
async function performedWith(d: RunDriver, forge?: (state: engine.BatchState, newPoints: engine.DataPoint[]) => void): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_step', `${d.runId}:${PCM}`, 'PERFORMED');
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'SIGN_PERFORMED', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-pcm', context: [], signature: { id, meaning: 'PERFORMED', signer: who.personId } };
      const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the signing: ${JSON.stringify(r.refusal)}`);
      const state = structuredClone(r.state);
      const added = Object.values(state.points).filter((x) => !(x.id in tx.state.points) && x.source.mode === 'BLOCK');
      if (added.length !== 1 || added[0]?.value?.kind !== 'DECIMAL' || added[0].value.value !== '50.0000') throw new Error(`SETUP: the engine computed ${JSON.stringify(added.map((x) => x.value))}`);
      forge?.(state, added);
      return appendAs(tx, command, { state, events: r.events }, roles);
    }),
  );
}

const point = (x: engine.DataPoint | undefined): engine.DataPoint => {
  if (!x) throw new Error('SETUP: no block value');
  return x;
};

describe('T2 round 2: the label and the total of weighings are what the weighings record (INV-25, PR-19; sql 0322)', () => {
  it('[PR-19][INV-25][DI-30] a weighing row whose label says "50 kg" for a net of 50.000 kg, or names another lot or batch, is refused; the engine\'s own label is recorded', async () => {
    const d = await atWeighing();
    const outcomes = {
      quantityWithoutResolution: await weighingWithLabel(d, (l) => {
        l['quantity'] = '50 kg';
      }),
      otherLot: await weighingWithLabel(d, (l) => {
        l['lot'] = 'TEST-L26-0999';
      }),
      otherBatch: await weighingWithLabel(d, (l) => {
        l['batch'] = 'TEST-B26-9998';
      }),
      noLabel: await weighingWithLabel(d, (l) => {
        for (const k of Object.keys(l)) delete l[k];
      }),
      honest: await weighingWithLabel(d),
    };
    expect(outcomes.quantityWithoutResolution).toMatch(/^This accepted RECORD_ENTRY row stores entry EN-\d+ \(CONTAINER_WEIGHING\) labelled \{.*"quantity": "50 kg".*\}, where its weighing and the batch give \{.*"quantity": "50\.000 kg".*\}: .*\[EBMR-EXE-137\]$/);
    expect(outcomes.otherLot).toMatch(/"lot": "TEST-L26-0999".*"lot": "TEST-L26-0101".*\[EBMR-EXE-137\]$/);
    expect(outcomes.otherBatch).toMatch(/"batch": "TEST-B26-9998".*\[EBMR-EXE-137\]$/);
    expect(outcomes.noLabel).toMatch(/labelled \{\}, where .*\[EBMR-EXE-137\]$/);
    expect(outcomes.honest).toBe('ok');
    const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    const weighed = Object.values(state?.entries ?? {}).filter((e) => e.kind === 'CONTAINER_WEIGHING').map((e) => e.data);
    expect(weighed.map((e) => e['label'])).toEqual([
      { component: 'MAT-PCM', lot: 'TEST-L26-0101', quantity: '50.000 kg', batch: state?.header.batchNumber, product: 'PCM500', container: weighed[0]?.['container'] },
    ]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-25][PR-19][DI-30] a dispensed quantity weighed in g and recorded as 50 or 50.000 kg, another figure, or without its weighings is refused; 50.0000 kg is recorded', async () => {
    const d = await atWeighing();
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51250.0', tare: '1250.0', unit: 'g' } } });
    const setValue = (value: string) => (_s: engine.BatchState, added: engine.DataPoint[]) => {
      point(added[0]).value = { kind: 'DECIMAL', value, unit: 'kg' };
    };
    const outcomes = {
      whole: await performedWith(d, setValue('50')),
      grams: await performedWith(d, setValue('50.000')),
      other: await performedWith(d, setValue('49.0000')),
      otherUnit: await performedWith(d, (_s, added) => {
        point(added[0]).value = { kind: 'DECIMAL', value: '50000.0', unit: 'g' };
      }),
      noWeighings: await performedWith(d, (_s, added) => {
        (point(added[0]).source as unknown as { entries: string[] }).entries = [];
      }),
      // The step leaves IN_PROGRESS with no total of its weighings at all.
      noTotal: await performedWith(d, (s, added) => {
        delete s.points[point(added[0]).id];
      }),
      honest: await performedWith(d),
    };
    expect(outcomes.whole).toMatch(/^This accepted SIGN_PERFORMED row records block value DP-\d+ of pcmDispensed at p-disp-pcm@ as \{.*"value": "50".*\}, where the nets of its weighings \["EN-\d+"\] come to 50\.0000 kg at the resolution they were weighed at: .*\[EBMR-EXE-138\]$/);
    expect(outcomes.grams).toMatch(/"value": "50\.000".* come to 50\.0000 kg .*\[EBMR-EXE-138\]$/);
    expect(outcomes.other).toMatch(/"value": "49\.0000".* come to 50\.0000 kg .*\[EBMR-EXE-138\]$/);
    expect(outcomes.otherUnit).toMatch(/"unit": "g".* come to 50\.0000 kg .*\[EBMR-EXE-138\]$/);
    expect(outcomes.noWeighings).toMatch(/computed from the weighings \[\], where its step records the weighings \["EN-\d+"\]: .*\[EBMR-EXE-138\]$/);
    expect(outcomes.noTotal).toMatch(/^This accepted SIGN_PERFORMED row records step p-disp-pcm@ as AWAITING_VERIFICATION with 0 valid block values of pcmDispensed, where its weighings count into exactly one: .*\[EBMR-EXE-138\]$/);
    expect(outcomes.honest).toBe('ok');
    const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    expect(Object.values(state?.points ?? {}).filter((x) => x.item === 'pcmDispensed').map((x) => x.value)).toEqual([{ kind: 'DECIMAL', value: '50.0000', unit: 'kg' }]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-25][PR-19] the database\'s reading: metric mass units, the label a weighing gives, and the total of a step\'s weighings at their resolution', async () => {
    const q = async <T>(sql: string, params: unknown[]): Promise<T> => (await sbx.db.admin.query<{ v: T }>(sql, params)).rows[0]?.v as T;
    expect(await q<(number | null)[]>(`select array_agg(recipe.metric_mass_exponent(u) order by o) as v from unnest($1::text[]) with ordinality as t(u, o)`, [
      ['kg', 'g', 'mg', 'ug', 'dag', 'hg', 'Mg', 'yg', 'Yg', 'kg{wet}', 'g.m/m', 'kgf', 'xg', 'G', ''],
    ])).toEqual([3, 0, -3, -6, 1, 2, 6, -24, 24, null, null, null, null, null, null]);

    const content = { header: { product: { code: 'PCM500' } }, bom: [{ id: 'BOM-PCM', material: 'MAT-PCM' }, { id: 'BOM-X' }], parameters: [{ id: 'disp', unit: 'kg' }, { id: 'odd', unit: 'kg{wet}' }] };
    const weighing = (extra: Record<string, unknown> = {}, label: Record<string, unknown> = {}) => ({
      kind: 'CONTAINER_WEIGHING',
      data: { item: 'disp', bomLine: 'BOM-PCM', container: 'C1', lot: { id: 'L1' }, gross: '9250.0', tare: '1250.0', net: '8000.0', unit: 'g', ...extra, label: { component: 'MAT-PCM', lot: 'L1', quantity: '8000.0 g', batch: 'B1', product: 'PCM500', container: 'C1', ...label } },
    });
    const label = async (entry: unknown, batch = 'B1') => (await q<string | null>('select recipe.weighing_label_problem($1::jsonb, $2, $3::jsonb) as v', [JSON.stringify(entry), batch, JSON.stringify(content)])) ?? 'null';
    expect(unmatched({
      honest: await label(weighing()),
      noMaterial: await label(weighing({ bomLine: 'BOM-X' }, { component: 'BOM-X' })),
      quantity: await label(weighing({}, { quantity: '8000 g' })),
      unit: await label(weighing({}, { quantity: '8.0000 kg' })),
      component: await label(weighing({}, { component: 'MAT-OTHER' })),
      container: await label(weighing({}, { container: 'C2' })),
      product: await label(weighing({}, { product: 'OTHER' })),
      batch: await label(weighing(), 'B2'),
      extra: await label(weighing({}, { note: 'x' })),
      output: await label({ kind: 'OUTPUT_CONTAINER', data: { net: '1', unit: 'kg' } }),
    }, {
      honest: 'null',
      noMaterial: 'null',
      quantity: '(CONTAINER_WEIGHING) labelled {"lot": "L1", "batch": "B1", "product": "PCM500", "quantity": "8000 g", "component": "MAT-PCM", "container": "C1"}, where its weighing and the batch give {"lot": "L1", "batch": "B1", "product": "PCM500", "quantity": "8000.0 g", "component": "MAT-PCM", "container": "C1"}',
      unit: /"quantity": "8\.0000 kg"/,
      component: /"component": "MAT-OTHER"/,
      container: /"container": "C2"/,
      product: /"product": "OTHER"/,
      batch: /"batch": "B2"/,
      extra: /"note": "x"/,
      output: 'null',
    })).toEqual({});

    const w = (step: string, item: string, net: string, unit: string, kind = 'CONTAINER_WEIGHING') => ({ stepKey: step, kind, data: { item, net, unit } });
    const state = (points: Record<string, unknown>, entries: Record<string, unknown>) => ({ points, entries });
    const total = (value: string, entries: string[], unit = 'kg', extra: Record<string, unknown> = {}) => ({ item: 'disp', stepKey: 'd@', kind: 'VALUE', status: 'VALID', value: { kind: 'DECIMAL', value, unit }, source: { mode: 'BLOCK', entries }, ...extra });
    const one = { E1: w('d@', 'disp', '8000.0', 'g'), E3: w('other@', 'disp', '1', 'kg'), E4: w('d@', 'other', '1', 'kg'), E5: { stepKey: 'd@', kind: 'CHARGE_CONTAINER', data: { item: 'disp' } } };
    const two = { ...one, E2: w('d@', 'disp', '4.000', 'kg') };
    const blockTotal = async (s: unknown, unit: string | null = 'kg') => (await q<string | null>('select recipe.block_total_problem($1::jsonb, $2, $3) as v', [JSON.stringify(s), 'DP-1', unit])) ?? 'null';
    expect(unmatched({
      grams: await blockTotal(state({ 'DP-1': total('8.0000', ['E1']) }, one)),
      gramsWhole: await blockTotal(state({ 'DP-1': total('8', ['E1']) }, one)),
      mixed: await blockTotal(state({ 'DP-1': total('12.0000', ['E1', 'E2']) }, two)),
      mixedOrder: await blockTotal(state({ 'DP-1': total('12.0000', ['E2', 'E1']) }, two)),
      mixedCoarse: await blockTotal(state({ 'DP-1': total('12.000', ['E1', 'E2']) }, two)),
      leftOut: await blockTotal(state({ 'DP-1': total('4.000', ['E2']) }, two)),
      twice: await blockTotal(state({ 'DP-1': total('12.0000', ['E1', 'E2', 'E2']) }, two)),
      otherStep: await blockTotal(state({ 'DP-1': total('13.0000', ['E1', 'E2', 'E3']) }, two)),
      kgToG: await blockTotal(state({ 'DP-1': total('8000', ['E1'], 'g') }, { E1: w('d@', 'disp', '8.000', 'kg') }), 'g'),
      mgToKg: await blockTotal(state({ 'DP-1': total('0.000500', ['E1']) }, { E1: w('d@', 'disp', '500', 'mg') })),
      output: await blockTotal(state({ 'DP-1': total('1.0', ['E1']) }, { E1: w('d@', 'disp', '1.0', 'kg', 'OUTPUT_CONTAINER') })),
      sameOddUnit: await blockTotal(state({ 'DP-1': total('1.0', ['E1'], 'kg{wet}') }, { E1: w('d@', 'disp', '1.0', 'kg{wet}') }), 'kg{wet}'),
      oddUnit: await blockTotal(state({ 'DP-1': total('1.0', ['E1']) }, { E1: w('d@', 'disp', '1.0', 'kg{wet}') })),
      noWeighing: await blockTotal(state({ 'DP-1': total('0', []) }, {})),
      noParameter: await blockTotal(state({ 'DP-1': total('8.0000', ['E1']) }, one), null),
      wrongUnit: await blockTotal(state({ 'DP-1': total('8000.0', ['E1'], 'g') }, one)),
      notValue: await blockTotal(state({ 'DP-1': total('8.0000', ['E1'], 'kg', { kind: 'ATTEMPT' }) }, one)),
      textNet: await blockTotal(state({ 'DP-1': total('8.0000', ['E1']) }, { E1: w('d@', 'disp', '8e3', 'g') })),
      absent: await blockTotal(state({}, two)),
    }, {
      grams: 'null',
      gramsWhole: 'block value DP-1 of disp at d@ as {"kind": "DECIMAL", "unit": "kg", "value": "8"}, where the nets of its weighings ["E1"] come to 8.0000 kg at the resolution they were weighed at',
      mixed: 'null',
      mixedOrder: 'null',
      mixedCoarse: /come to 12\.0000 kg/,
      leftOut: 'block value DP-1 of disp at d@, computed from the weighings ["E2"], where its step records the weighings ["E1", "E2"]',
      twice: /computed from the weighings \["E1", "E2", "E2"\]/,
      otherStep: /computed from the weighings \["E1", "E2", "E3"\]/,
      kgToG: 'null',
      mgToKg: 'null',
      output: 'null',
      sameOddUnit: 'null',
      oddUnit: 'block value DP-1 of disp at d@, counted from weighing E1 in kg{wet}, which is not counted into a quantity in kg (the same unit, or both metric mass units)',
      noWeighing: 'block value DP-1 of disp at d@, which no weighing of its step counts into',
      noParameter: "block value DP-1 of disp at d@, which is no quantity of the batch's MBR",
      wrongUnit: /come to 8\.0000 kg/,
      notValue: /come to 8\.0000 kg/,
      textNet: 'block value DP-1 of disp at d@, counted from weighing E1, which records no net and unit as text',
      absent: 'block value DP-1, which the state does not hold',
    })).toEqual({});

    const totals = async (before: unknown, after: unknown) => (await q<string | null>('select recipe.weighing_totals_problem($1::jsonb, $2::jsonb, $3::jsonb) as v', [JSON.stringify(before), JSON.stringify(after), JSON.stringify(content)])) ?? 'null';
    const entries = { E1: w('d@', 'disp', '8000.0', 'g') };
    const running = { steps: { 'd@': { status: 'IN_PROGRESS' } }, points: {}, entries };
    const done = (status: string, points: Record<string, unknown>) => ({ steps: { 'd@': { status } }, points, entries });
    expect(unmatched({
      honest: await totals(running, done('AWAITING_VERIFICATION', { 'DP-1': total('8.0000', ['E1']) })),
      newWrong: await totals(running, { ...running, points: { 'DP-1': total('8', ['E1']) } }),
      noTotal: await totals(running, done('COMPLETED', {})),
      stale: await totals({ ...running, points: { 'DP-1': total('8', ['E1']) } }, done('AWAITING_VERIFICATION', { 'DP-1': total('8', ['E1']) })),
      superseded: await totals(running, done('COMPLETED', { 'DP-1': total('8.0000', ['E1'], 'kg', { status: 'SUPERSEDED' }) })),
      twoValid: await totals(running, done('COMPLETED', { 'DP-1': total('8.0000', ['E1']), 'DP-2': total('8.0000', ['E1']) })),
      stillRunning: await totals({ ...running, points: { 'DP-1': total('8', ['E1']) } }, { ...running, points: { 'DP-1': total('8', ['E1']) } }),
      oldStatus: await totals({ ...running, steps: { 'd@': { status: 'AWAITING_VERIFICATION' } }, points: { 'DP-1': total('8', ['E1']) } }, done('COMPLETED', { 'DP-1': total('8', ['E1']) })),
      // An output container counting into no quantity adds none to check here; whether its phase records one is
      // decided at the entry since sql 0323 (EBMR-EXE-139, round 3 below).
      noItem: await totals({ steps: { 'g@': { status: 'IN_PROGRESS' } }, points: {}, entries: {} }, { steps: { 'g@': { status: 'COMPLETED' } }, points: {}, entries: { E9: { stepKey: 'g@', kind: 'OUTPUT_CONTAINER', data: { item: null, net: '1', unit: 'kg' } } } }),
    }, {
      honest: 'null',
      newWrong: /^block value DP-1 of disp at d@ as .*"value": "8"/,
      noTotal: 'step d@ as COMPLETED with 0 valid block values of disp, where its weighings count into exactly one',
      stale: /^step d@ as AWAITING_VERIFICATION with block value DP-1 of disp at d@ as .* come to 8\.0000 kg/,
      superseded: 'step d@ as COMPLETED with 0 valid block values of disp, where its weighings count into exactly one',
      twoValid: /with 2 valid block values of disp/,
      stillRunning: 'null',
      oldStatus: 'null',
      noItem: 'null',
    })).toEqual({});
  }, 300_000);
});

type Json = Record<string, unknown>;

/**
 * operator1's RECORD_ENTRY of `entry` at `stepKey` in DISP-1, resolved and run through the engine as the server does, then
 * stored through the application's role with the new entry's data and the recorded command changed by `forge`. 'ok', or
 * the refusal's message.
 */
async function entryForged(d: RunDriver, stepKey: string, entry: Json, forge: (data: Json, command: Json) => void): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const resolved = await resolveClientIntent(
        { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
        { type: 'RECORD_ENTRY', stepKey, entry } as Parameters<typeof resolveClientIntent>[1],
      );
      const r = engine.step(tx.def, tx.state, resolved.command, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the entry: ${JSON.stringify(r.refusal)}`);
      const state = structuredClone(r.state);
      const added = Object.values(state.entries).find((e) => !(e.id in tx.state.entries));
      if (!added) throw new Error('SETUP: no new entry');
      const recorded = structuredClone(engine.encodeCommand(resolved.command)) as Json;
      forge(added.data, recorded);
      return appendAs(tx, resolved.command, { state, events: r.events }, roles, recorded as engine.JsonValue, engine.changedContents(tx.def, tx.state, state), resolved.evidence as engine.JsonValue);
    }),
  );
}

/** The block values of `item` the stored state holds: value and the entries they are computed from. */
async function totalsOf(d: RunDriver, item: string): Promise<unknown[]> {
  const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
  return Object.values(state?.points ?? {}).filter((x) => x.item === item && x.source.mode === 'BLOCK').map((x) => ({ value: x.value, status: x.status, entries: (x.source as unknown as { entries: string[] }).entries }));
}

async function entryIds(d: RunDriver, kind: string): Promise<string[]> {
  const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
  return Object.values(state?.entries ?? {}).filter((e) => e.kind === kind).map((e) => e.id);
}

describe('T2 round 3: a weighing counts into the quantity its phase records, decided by the database (INV-25, PR-19; sql 0323)', () => {
  it('[INV-25][PR-19][DI-30] a second dispensed container stored without item, or counting into another quantity, is refused (EBMR-EXE-139); the signed total counts every container stored', async () => {
    const d = await atWeighing();
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } } });
    const [honest] = await entryIds(d, 'CONTAINER_WEIGHING');
    const second: Json = { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '11.250', tare: '1.250', unit: 'kg' } };
    const outcomes = {
      // The round-2 verification's row: the entry's item deleted (0313 binds only the members the entry still holds).
      noItem: await entryForged(d, PCM, second, (data) => {
        delete data['item'];
      }),
      // Another phase's dispensed quantity, in the command and the entry alike.
      otherQuantity: await entryForged(d, PCM, second, (data, command) => {
        data['item'] = 'excDispensed';
        (command['entry'] as Json)['item'] = 'excDispensed';
      }),
      // A quantity of the MBR that is no mass.
      notMass: await entryForged(d, PCM, second, (data, command) => {
        data['item'] = 'blendTime';
        (command['entry'] as Json)['item'] = 'blendTime';
      }),
    };
    expect(unmatched(outcomes, {
      noItem: /^This accepted RECORD_ENTRY row stores entry EN-\d+ \(CONTAINER_WEIGHING\) at p-disp-pcm@ counted into \(no item\), where its phase p-disp-pcm records the mass quantities \["pcmDispensed"\]: .*\[EBMR-EXE-139\]$/,
      otherQuantity: /stores entry EN-\d+ \(CONTAINER_WEIGHING\) at p-disp-pcm@ counted into "excDispensed", where its phase p-disp-pcm records the mass quantities \["pcmDispensed"\]: .*\[EBMR-EXE-139\]$/,
      notMass: /counted into "blendTime", where .*\[EBMR-EXE-139\]$/,
    })).toEqual({});
    expect(await entryIds(d, 'CONTAINER_WEIGHING')).toEqual([honest]);
    // operator1's honest signature: the dispensed quantity counts every container the step holds.
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: PCM });
    expect(await totalsOf(d, 'pcmDispensed')).toEqual([{ value: { kind: 'DECIMAL', value: '50.000', unit: 'kg' }, status: 'VALID', entries: [honest] }]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-25][PR-19][DI-30] an output container stored into no quantity, or into another, where its phase records one is refused (EBMR-EXE-139); the signed total counts it', async () => {
    // dc-mini with an output step first in the dispensing booth: it records earlyNet (kg) and produces I-EARLY.
    const content = dcMiniVariant((prep, c) => {
      (c['intermediates'] as Json[]).push({ id: 'I-EARLY', name: 'Early output', holdTime: { max: { value: '30', unit: 'd' }, source: { kind: 'HOLD_STUDY', ref: 'HS-PCM-01' }, storage: 'Closed, labelled containers' } });
      (c['parameters'] as Json[]).push({ id: 'earlyNet', name: 'Early output (net)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
      const out = { kind: 'phase', id: 'p-early-out', name: 'Discharge the early output', block: { type: 'G-22', version: '1' }, config: {}, records: ['earlyNet'], computes: [], reads: [], consumes: [], produces: ['I-EARLY'], uses: [], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } }, significant: true, riskClass: 'HIGH' };
      return [out, ...prep];
    });
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const OUT = 'p-early-out@';
    await d.ok('operator1', { type: 'START_STEP', stepKey: OUT });
    const container = { kind: 'OUTPUT_CONTAINER' as const, intermediate: 'I-EARLY', manual: { gross: '26.100', tare: '1.050', unit: 'kg' } };
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: OUT, entry: container });
    const [honest] = await entryIds(d, 'OUTPUT_CONTAINER');
    const second: Json = { ...container, manual: { gross: '101.000', tare: '1.000', unit: 'kg' } };
    const outcomes = {
      // G-22 adds item itself (the command has none), so the writer could set it to null or drop it.
      nullItem: await entryForged(d, OUT, second, (data) => {
        data['item'] = null;
      }),
      noItem: await entryForged(d, OUT, second, (data) => {
        delete data['item'];
      }),
      otherQuantity: await entryForged(d, OUT, second, (data) => {
        data['item'] = 'pcmDispensed';
      }),
    };
    expect(unmatched(outcomes, {
      nullItem: /^This accepted RECORD_ENTRY row stores entry EN-\d+ \(OUTPUT_CONTAINER\) at p-early-out@ counted into null, where its phase p-early-out counts it into "earlyNet": .*\[EBMR-EXE-139\]$/,
      noItem: /\(OUTPUT_CONTAINER\) at p-early-out@ counted into \(no item\), where its phase p-early-out counts it into "earlyNet": .*\[EBMR-EXE-139\]$/,
      otherQuantity: /\(OUTPUT_CONTAINER\) at p-early-out@ counted into "pcmDispensed", where its phase p-early-out counts it into "earlyNet": .*\[EBMR-EXE-139\]$/,
    })).toEqual({});
    expect(await entryIds(d, 'OUTPUT_CONTAINER')).toEqual([honest]);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: OUT });
    expect(await totalsOf(d, 'earlyNet')).toEqual([{ value: { kind: 'DECIMAL', value: '25.050', unit: 'kg' }, status: 'VALID', entries: [honest] }]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});
