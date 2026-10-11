/**
 * GB-T-01 stages 3 to 6 over HTTP (Phase 3 slice 6d): blending with the case 2 addition, compression with the left and
 * right IPC and the approval for coating, film coating to the weight gain, inspection with the witnessed destruction
 * and the release for packing. See driver.ts for the conventions.
 */
import type { ClientIntent } from '@ebmr/api-contract';
import { BALANCE, UNITS } from './plant.ts';
import { dbAs, entry, type GoldenBatch, type StepPlan } from './driver.ts';

type Json = Record<string, unknown>;

const TARE = '1.000';
const gross = (net: string): string => {
  const [i = '0', f = ''] = net.split('.');
  const milli = BigInt(i) * 1000n + BigInt(f.padEnd(3, '0')) + 1000n;
  return `${(milli / 1000n).toString()}.${(milli % 1000n).toString().padStart(3, '0')}`;
};
const output = (stepKey: string, intermediate: string, net: string, balance: string): ClientIntent => ({
  type: 'RECORD_ENTRY',
  stepKey,
  entry: { kind: 'OUTPUT_CONTAINER', intermediate, manual: { gross: gross(net), tare: TARE, unit: 'kg', deviceCode: balance } },
});
const data = (stepKey: string, item: string, value: string, unit: string): ClientIntent => ({
  type: 'RECORD_DATA',
  stepKey,
  item,
  value: { kind: 'DECIMAL', value, unit },
  source: { mode: 'MANUAL' },
});

/** A closed plant output container of the batch at `stage` (operator1 opens and closes it), on `press` and `stream` when given. */
export async function plantContainer(g: GoldenBatch, stage: string, net: string, press?: string, stream?: string): Promise<{ id: string; label: string }> {
  const o = await openContainer(g, stage, press, stream);
  await closeContainer(g, o.id, net);
  return o;
}

export async function openContainer(g: GoldenBatch, stage: string, press?: string, stream?: string): Promise<{ id: string; label: string }> {
  const o = await dbAs<{ container_id: string; label_code: string }>(g.w, g.b('operator1'), 'operator1', 'select plant.open_container($1, $2, $3, $4, $5) as r', [g.batchId, stage, 'kg', press ?? null, stream ?? null]);
  return { id: o.container_id, label: o.label_code };
}

export async function closeContainer(g: GoldenBatch, id: string, net: string): Promise<void> {
  const v = (await g.w.server.db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [id])).rows[0]?.v;
  await dbAs(g.w, g.b('operator1'), 'operator1', 'select plant.close_container($1, $2::numeric, $3::bigint) as r', [id, net, v]);
}

export interface BlendingPlan {
  /** The reserved residue container and the quality unit's authorisation of its use, or null (no addition). */
  addition: { container: string; authorisation: string; gross: string; tare: string } | null;
  blend: string;
  /** Outline 9.1: an addition without its approval is tried first and refused (recorded in g.notes). */
  tryUnapproved?: boolean;
}

/** Stage 3: blending in BLEND-1: the case 2 addition of milled rejects (or none), blending and lubrication, the blend. */
export async function blending(g: GoldenBatch, plan: BlendingPlan): Promise<{ blendLabel: string }> {
  await g.floor('BLEND-1');
  const bal = BALANCE['BLEND-1'];
  const occ = await g.clearAndOccupy('BLEND-1', 'S-BLEND');
  const balUse = await g.balanceUse('BLEND-1');
  const blender = await g.startUse('BLENDER');
  await g.step('p-blend-clear@', { entries: [entry('p-blend-clear@', 'AREA_OCCUPANCY', { areaCode: 'BLEND-1', occupancyId: occ })] });
  await g.step('p-blend-status@', {
    checker: null,
    entries: [
      entry('p-blend-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: bal, useId: balUse }),
      entry('p-blend-status@', 'EQUIPMENT_USE', { equipmentRef: 'BLENDER', equipmentCode: UNITS.BLENDER.code, useId: blender }),
    ],
  });
  const a = plan.addition;
  if (plan.tryUnapproved) {
    // DI-34, PR-13: the choice is the supervisor's; the operator's is refused.
    const r = await g.d.command('operator1', { type: 'CHOOSE_ALTERNATIVE', construct: 'A-RPR', branch: 'B-RPR-ADD', reason: 'Operator tries to choose' });
    g.notes['choiceByOperator'] = r.ok ? 'ok' : r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.code : r.error.kind;
  }
  await g.d.ok('supervisor1', {
    type: 'CHOOSE_ALTERNATIVE',
    construct: 'A-RPR',
    branch: a ? 'B-RPR-ADD' : 'B-RPR-NONE',
    reason: a ? 'Reserved milled rejects of the same product, authorised by the quality unit' : 'No reserved rejects of this product to add',
  });
  if (a && plan.tryUnapproved) {
    await g.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-rework@' });
    const r = await g.d.command('operator1', entry('p-rework@', 'ADDITION', { container: a.container, gross: a.gross, tare: a.tare, unit: 'kg' }));
    g.notes['additionWithoutApproval'] = r.ok ? 'ok' : r.error.kind === 'REFUSAL' ? r.error.envelope.refusal : r.error.kind;
    await g.d.ok('operator1', entry('p-rework@', 'ADDITION', { container: a.container, gross: a.gross, tare: a.tare, unit: 'kg', authorisation: a.authorisation }));
    await g.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-rework@' });
    await g.signed('verifier1', { type: 'VERIFY', stepKey: 'p-rework@', meaning: 'VERIFIED' });
  } else if (a) {
    await g.step('p-rework@', { entries: [entry('p-rework@', 'ADDITION', { container: a.container, gross: a.gross, tare: a.tare, unit: 'kg', authorisation: a.authorisation })] });
  } else {
    await g.step('p-rework-none@', { entries: [data('p-rework-none@', 'recAdded', '0.000', 'kg')] });
  }
  await g.step('p-blend@', {
    entries: [
      entry('p-blend@', 'BLEND_START', {}),
      { wait: 10 },
      entry('p-blend@', 'BLEND_END', {}),
      entry('p-blend@', 'LUBRICANT_ADDED', { quantity: { value: '0.800', unit: 'kg' } }),
      { wait: 3 },
      entry('p-blend@', 'LUBRICATION_END', {}),
    ],
  });
  await g.step('p-blend-out@', { entries: [output('p-blend-out@', 'I-BLEND', plan.blend, bal)] });
  const blendContainer = await plantContainer(g, 'BLENDING', plan.blend);
  await g.step('p-blend-yield@');
  await g.closeStage('S-BLEND@');
  await g.release([UNITS.BLENDER.code, 'BLEND-1']);
  return { blendLabel: blendContainer.label };
}

export const TOOLING_SET = 'TS-GBT01-01';
const COUNTS = { upper: '45', lower: '45', dies: '45' };
const FINDINGS = Object.fromEntries(['TIPS', 'EDGES', 'WEAR', 'EMBOSSING', 'CORROSION', 'CLEANLINESS'].map((k) => [k, true]));

export interface CompressionPlan {
  blendLabel: string;
  /** Group weights of 20 tablets (mg) of each periodic check, per stream; the last is the end-of-run check. */
  checks: { L: string[]; R: string[] };
  /** Net of each stream's containers (kg), one container per check interval. */
  containers: { L: string[]; R: string[] };
  good: string;
  residue: string;
  rejects: string;
  /** Called when the right side's check `i` failed (exception-rich): the deviation, the disposition, the held containers. */
  onFailure?: (g: GoldenBatch, held: { id: string; label: string }[]) => Promise<void>;
}

/** Stage 4: compression in COMP-1: tooling, set-up and first-off, the run with left and right IPC, tooling return, yield, approval for coating. */
export async function compression(g: GoldenBatch, plan: CompressionPlan): Promise<void> {
  await g.floor('COMP-1');
  const bal = BALANCE['COMP-1'];
  const press = UNITS.PRESS.code;
  const occ = await g.clearAndOccupy('COMP-1', 'S-COMP');
  const balUse = await g.balanceUse('COMP-1');
  const pressUse = await g.startUse('PRESS');
  await g.step('p-comp-clear@', { entries: [entry('p-comp-clear@', 'AREA_OCCUPANCY', { areaCode: 'COMP-1', occupancyId: occ })] });
  await g.step('p-comp-status@', {
    checker: null,
    entries: [
      entry('p-comp-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: bal, useId: balUse }),
      entry('p-comp-status@', 'EQUIPMENT_USE', { equipmentRef: 'PRESS', equipmentCode: press, useId: pressUse }),
    ],
  });
  const pre = await dbAs<{ inspectionId: string }>(g.w, g.b('operator1'), 'operator1', 'select tab.inspect_tooling($1, $2, $3, $4, $5) as r', [TOOLING_SET, 'PRE_USE', null, FINDINGS, null]);
  await g.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tool@' });
  await g.d.ok('operator1', entry('p-tool@', 'TOOLING_INSPECTED', { set: TOOLING_SET, inspectionId: pre.inspectionId, when: 'BEFORE', result: 'PASS' }));
  const issue = await dbAs<{ issueId: string }>(g.w, g.b('operator1'), 'operator1', 'select tab.issue_tooling($1, $2, $3, $4) as r', [TOOLING_SET, g.batchId, press, COUNTS]);
  await g.d.ok('operator1', entry('p-tool@', 'TOOLING_ISSUED', { set: TOOLING_SET, issueId: issue.issueId, press }));
  await g.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tool@' });
  await g.signed('verifier1', { type: 'VERIFY', stepKey: 'p-tool@', meaning: 'VERIFIED' });

  await g.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-setup@' });
  await g.d.ok('operator1', entry('p-setup@', 'PRESS_SETUP', { press, useId: pressUse, issueId: issue.issueId }));
  await g.d.ok('operator1', entry('p-setup@', 'PRE_USE_CHECKLIST', { items: [{ item: 'DUST_EXTRACTION', ok: true }, { item: 'NOZZLES_CLEAN_NO_LEAK', ok: true }, { item: 'CALIBRATED_BALANCE', ok: true }] }));
  const charge = await dbAs<{ charge_id: string }>(g.w, g.b('operator1'), 'operator1', 'select plant.charge_container($1, $2, $3) as r', [g.batchId, 'COMPRESSION', plan.blendLabel]);
  await g.d.ok('operator1', entry('p-setup@', 'HOPPER_CHARGE', { chargeId: charge.charge_id }));
  await g.d.ok('operator1', entry('p-setup@', 'FIRST_OFF', { result: 'PASS' }));
  await g.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-setup@' });
  await g.signed('verifier1', { type: 'VERIFY', stepKey: 'p-setup@', meaning: 'VERIFIED' });

  // The run: one container per stream and check interval; the weight checks of both sides every 20 minutes.
  const run = 'p-run@';
  const weight = (stream: 'L' | 'R', groupWeight: string) => entry(run, 'WEIGHT_CHECK', { instrument: bal, capture: 'MANUAL', stream, groupWeight });
  const sweep = (stream: 'L' | 'R') =>
    entry(run, 'STATION_SWEEP', { instrument: bal, capture: 'MANUAL', stream, stations: [1, 2, 3, 4].map((station, i) => ({ station, weight: ['409.8', '410.6', '411.2', '408.9'][i] ?? '410.0' })) });
  await g.d.ok('operator1', { type: 'START_STEP', stepKey: run });
  const open: { L: { id: string; label: string } | null; R: { id: string; label: string } | null } = {
    L: await openContainer(g, 'COMPRESSION', press, 'L'),
    R: await openContainer(g, 'COMPRESSION', press, 'R'),
  };
  await g.d.ok('operator1', entry(run, 'RUN_START', { press }));
  await g.d.ok('operator1', sweep('L'));
  await g.d.ok('operator1', sweep('R'));
  const n = plan.checks.L.length;
  const heldR: { id: string; label: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    const last = i === n - 1;
    if (!last) await g.wait(20);
    else await g.d.ok('operator1', entry(run, 'RUN_END', {}));
    for (const s of ['L', 'R'] as const) {
      const c = open[s];
      if (c) await closeContainer(g, c.id, plan.containers[s][i] ?? '0');
      await g.d.ok('operator1', weight(s, plan.checks[s][i] ?? ''));
      open[s] = last ? null : await openContainer(g, 'COMPRESSION', press, s);
      if (s === 'R' && c) {
        const state = (await g.w.server.db.app.query<{ s: string }>('select plant.container_state($1) as s', [c.id])).rows[0]?.s;
        if (state === 'HELD') heldR.push(c);
      }
    }
  }
  await g.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: run });
  await g.signed('verifier1', { type: 'VERIFY', stepKey: run, meaning: 'VERIFIED' });
  if (heldR.length > 0 && plan.onFailure) await plan.onFailure(g, heldR);

  await g.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tool-ret@' });
  const returned = await dbAs<Json>(g.w, g.b('operator1'), 'operator1', 'select tab.return_tooling($1, $2, $3) as r', [issue.issueId, COUNTS, '197800']);
  await g.d.ok('operator1', entry('p-tool-ret@', 'TOOLING_RETURNED', { set: TOOLING_SET, issueId: issue.issueId, strokes: returned['strokes'], strokeSource: returned['strokeSource'], countMismatch: returned['countMismatch'], limitExceeded: returned['limitExceeded'] }));
  const post = await dbAs<{ inspectionId: string }>(g.w, g.b('operator1'), 'operator1', 'select tab.inspect_tooling($1, $2, $3, $4, $5) as r', [TOOLING_SET, 'POST_USE', issue.issueId, FINDINGS, null]);
  await g.d.ok('operator1', entry('p-tool-ret@', 'TOOLING_INSPECTED', { set: TOOLING_SET, inspectionId: post.inspectionId, when: 'AFTER', result: 'PASS' }));
  await g.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tool-ret@' });
  await g.signed('verifier1', { type: 'VERIFY', stepKey: 'p-tool-ret@', meaning: 'VERIFIED' });

  await g.step('p-comp-yield@', { entries: [data('p-comp-yield@', 'compGood', plan.good, 'kg'), data('p-comp-yield@', 'compResidue', plan.residue, 'kg'), data('p-comp-yield@', 'compRejects', plan.rejects, 'kg')] });
  await g.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-COAT@', disposition: 'APPROVED', comment: 'Cores approved for coating' });
  await g.closeStage('S-COMP@');
  await g.release([press, 'COMP-1']);
}

export interface CoatingPlan {
  coreTotal: string;
  /** Per iteration: the coated sample's total (g, 20 tablets) and the minutes of spraying. */
  iterations: { total: string; minutes: number }[];
  coated: string;
}

const COATER = { 'inlet.temp_C': ['degC', '55.0'], 'exhaust.temp_C': ['degC', '42.0'], 'bed.temp_C': ['degC', '41.5'], 'spray.rate_g_min': ['g/min', '120.0'], 'pan.speed_rpm': ['rpm', '5.0'] } as const;

/** Stage 5: film coating in COAT-1: suspension, cores, coating loop to the weight gain, the coated tablets. */
export async function coating(g: GoldenBatch, plan: CoatingPlan): Promise<void> {
  await g.floor('COAT-1');
  const bal = BALANCE['COAT-1'];
  const occ = await g.clearAndOccupy('COAT-1', 'S-COAT');
  const balUse = await g.balanceUse('COAT-1');
  const coater = await g.startUse('COATER');
  await g.step('p-coat-clear@', { entries: [entry('p-coat-clear@', 'AREA_OCCUPANCY', { areaCode: 'COAT-1', occupancyId: occ })] });
  await g.step('p-coat-status@', {
    checker: null,
    entries: [
      entry('p-coat-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: bal, useId: balUse }),
      entry('p-coat-status@', 'EQUIPMENT_USE', { equipmentRef: 'COATER', equipmentCode: UNITS.COATER.code, useId: coater }),
    ],
  });
  await g.step('p-susp@', { entries: [entry('p-susp@', 'PREPARED', { quantity: { value: '12.000', unit: 'kg' }, appearance: 'COMPLIES' })] });
  const susp = await g.entryId('p-susp@', 'PREPARED');
  await g.step('p-cores@', {
    meaning: 'WITNESSED',
    entries: [
      entry('p-cores@', 'ROOM_CHECK', { filteredAir: true, temperature: '23.0', humidity: '45' }),
      entry('p-cores@', 'PAN_LOAD', { quantity: { value: '80.920', unit: 'kg' } }),
      entry('p-cores@', 'CORE_SAMPLE', { instrument: bal, weighing: 'GROUP', count: '20', total: plan.coreTotal, unit: 'g' }),
    ],
  });
  for (let i = 1; i <= plan.iterations.length; i += 1) {
    const it = plan.iterations[i - 1] ?? { total: '', minutes: 0 };
    const k = `p-coat@L-COAT=${i}`;
    const actuals = (): ClientIntent[] => Object.entries(COATER).map(([tag, [unit, value]]) => entry(k, 'ACTUAL', { tag, value, unit, source: 'MANUAL' }));
    const entries: NonNullable<StepPlan['entries']> = [entry(k, 'RECIPE_CHECK', { recipe: 'RCP-GBT01-COAT', recipeVersion: '1' }), entry(k, 'SPRAY_START', {}), ...actuals()];
    for (let t = 0; t < it.minutes; t += 20) entries.push({ wait: Math.min(20, it.minutes - t) }, ...actuals());
    entries.push(entry(k, 'SPRAY_END', {}), entry(k, 'SUSPENSION_USED', { preparation: susp, quantity: { value: '5.500', unit: 'kg' } }), entry(k, 'WEIGHT_CHECK', { instrument: bal, weighing: 'GROUP', count: '20', total: it.total, unit: 'g' }));
    await g.step(k, { meaning: 'WITNESSED', entries });
    await g.d.ok('operator1', { type: 'COMPLETE_LOOP_ITERATION', stepKey: k });
  }
  await g.step('p-coat-out@', { entries: [output('p-coat-out@', 'I-COATED', plan.coated, bal)] });
  await g.step('p-coat-gain@');
  await g.closeStage('S-COAT@');
  await g.release([UNITS.COATER.code, 'COAT-1']);
}

export interface InspectionPlan {
  inspected: { count: string; mass: string };
  accepted: { count: string; mass: string };
  destroyed: { count: string; mass: string };
  /** Reusable residue kept for a later batch's case 2 addition (the source batch only). */
  residue?: { count: string; mass: string };
  defects: { code: string; count: string }[];
  aql: Record<string, string>;
}

/** Stage 6: inspection in INSP-1: the sort, the AQL, the witnessed destruction of the rejects, the yield, the release for packing. */
export async function inspection(g: GoldenBatch, plan: InspectionPlan): Promise<{ residue: string | null }> {
  await g.floor('INSP-1');
  const bal = BALANCE['INSP-1'];
  const occ = await g.clearAndOccupy('INSP-1', 'S-INSP');
  const balUse = await g.balanceUse('INSP-1');
  await g.step('p-insp-clear@', { entries: [entry('p-insp-clear@', 'AREA_OCCUPANCY', { areaCode: 'INSP-1', occupancyId: occ })] });
  await g.step('p-insp-status@', { checker: null, entries: [entry('p-insp-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: bal, useId: balUse })] });
  const destroy = await plantContainer(g, 'INSPECTION', plan.destroyed.mass);
  const residue = plan.residue ? await plantContainer(g, 'INSPECTION', plan.residue.mass) : null;
  const rejects = [
    { category: 'DESTRUCTION', container: destroy.id, count: plan.destroyed.count, mass: { value: plan.destroyed.mass, unit: 'kg' } },
    ...(residue && plan.residue ? [{ category: 'REUSABLE_RESIDUE', container: residue.id, count: plan.residue.count, mass: { value: plan.residue.mass, unit: 'kg' } }] : []),
  ];
  await g.step('p-insp@', {
    entries: [
      entry('p-insp@', 'INSPECTION_START', {}),
      { wait: 120 },
      entry('p-insp@', 'INSPECTION_END', {}),
      entry('p-insp@', 'SORT_RESULT', {
        inspected: { count: plan.inspected.count, mass: { value: plan.inspected.mass, unit: 'kg' } },
        accepted: { count: plan.accepted.count, mass: { value: plan.accepted.mass, unit: 'kg' } },
        defects: plan.defects,
        rejects,
      }),
      entry('p-insp@', 'AQL_RESULT', { severity: 'NORMAL', found: plan.aql }),
      data('p-insp@', 'acceptedNet', plan.accepted.mass, 'kg'),
    ],
  });
  await g.step('p-destroy@', {
    meaning: 'WITNESSED',
    entries: [entry('p-destroy@', 'DISPOSAL', { category: 'DESTRUCTION', material: 'Coated tablets rejected at inspection', batchCoded: false, quantity: { value: plan.destroyed.mass, unit: 'kg' }, container: destroy.label, method: 'Incineration' })],
  });
  await g.step('p-insp-yield@');
  await g.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-PACK@', disposition: 'APPROVED', comment: 'Bulk released for packing' });
  await g.closeStage('S-INSP@');
  await g.release(['INSP-1']);
  return { residue: residue?.id ?? null };
}
