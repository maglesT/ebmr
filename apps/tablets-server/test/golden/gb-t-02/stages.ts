/**
 * The GB-T-02 processing batch over HTTP (Phase 4 slice 7b; D-P4-15): dispensing (every material weighed, G-07),
 * blending and lubrication, compression with the left and right weight checks into bulk containers, the release for
 * packing. The conventions are GB-T-01's (gb-t-01/driver.ts); the quantities the hand worksheet's (README.md).
 */
import type { ClientIntent } from '@ebmr/api-contract';
import { BALANCE, UNITS } from '../gb-t-01/plant.ts';
import { dbAs, entry, type GoldenBatch } from '../gb-t-01/driver.ts';
import { closeContainer, openContainer, plantContainer } from '../gb-t-01/stages.ts';

type Json = Record<string, unknown>;

const TARE = '1.000';
const gross = (net: string): string => {
  const [i = '0', f = ''] = net.split('.');
  const milli = BigInt(i) * 1000n + BigInt(f.padEnd(3, '0')) + 1000n;
  return `${(milli / 1000n).toString()}.${(milli % 1000n).toString().padStart(3, '0')}`;
};
const weigh = (stepKey: string, item: string, bomLine: string, lotCode: string, net: string, balance: string): ClientIntent => ({
  type: 'RECORD_ENTRY', stepKey, entry: { kind: 'CONTAINER_WEIGHING', item, bomLine, lotCode, manual: { gross: gross(net), tare: TARE, unit: 'kg', deviceCode: balance } },
});
const output = (stepKey: string, intermediate: string, net: string, balance: string): ClientIntent => ({
  type: 'RECORD_ENTRY', stepKey, entry: { kind: 'OUTPUT_CONTAINER', intermediate, manual: { gross: gross(net), tare: TARE, unit: 'kg', deviceCode: balance } },
});
const data = (stepKey: string, item: string, value: string, unit: string): ClientIntent => ({ type: 'RECORD_DATA', stepKey, item, value: { kind: 'DECIMAL', value, unit }, source: { mode: 'MANUAL' } });

/** The worksheet's dispensed quantities (kg) and the lot each is weighed from (the cellulose from the vendor-history lot). */
export const DISPENSE = [
  ['dispApi', 'BOM-API', 'GBT2-EXF-001', '10.000'],
  ['dispMcc', 'BOM-MCC', 'GBT2-MCC-V01', '8.400'],
  ['dispCcs', 'BOM-CCS', 'GBT2-CCS-001', '1.000'],
  ['dispSio', 'BOM-SIO', 'GBT2-SIO-001', '0.200'],
  ['dispMgs', 'BOM-MGS', 'GBT2-MGS-001', '0.400'],
] as const;

/** Dispensing on DISP-1 from the lots `plan` names (GB-T-03 weighs the cellulose from the identity-tested lot). */
export async function dispensing(g: GoldenBatch, plan: readonly (readonly [string, string, string, string])[] = DISPENSE): Promise<void> {
  await g.floor('DISP-1');
  const bal = BALANCE['DISP-1'];
  const occ = await g.clearAndOccupy('DISP-1', 'S-DISP', 'operator2');
  const use = await g.balanceUse('DISP-1', 'operator2');
  await g.step('p-disp-clear@', { performer: 'operator2', entries: [entry('p-disp-clear@', 'AREA_OCCUPANCY', { areaCode: 'DISP-1', occupancyId: occ })] });
  await g.step('p-disp-status@', { performer: 'operator2', entries: [entry('p-disp-status@', 'EQUIPMENT_USE', { equipmentRef: 'BAL', equipmentCode: bal, useId: use })], checker: null });
  await g.step('p-disp-exc@', { entries: plan.map(([item, bom, lot, net]) => weigh('p-disp-exc@', item, bom, lot, net, bal)) });
  await g.step('p-disp-recon@', { performer: 'operator2' });
  await g.closeStage('S-DISP@');
  await g.release(['DISP-1'], 'operator2');
}

export async function blending(g: GoldenBatch, blend: string): Promise<{ blendLabel: string }> {
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
  await g.step('p-blend@', {
    entries: [
      entry('p-blend@', 'BLEND_START', {}),
      { wait: 10 },
      entry('p-blend@', 'BLEND_END', {}),
      entry('p-blend@', 'LUBRICANT_ADDED', { quantity: { value: '0.400', unit: 'kg' } }),
      { wait: 3 },
      entry('p-blend@', 'LUBRICATION_END', {}),
    ],
  });
  await g.step('p-blend-out@', { entries: [output('p-blend-out@', 'I-BLEND', blend, bal)] });
  const c = await plantContainer(g, 'BLENDING', blend);
  await g.step('p-blend-yield@');
  await g.closeStage('S-BLEND@');
  await g.release([UNITS.BLENDER.code, 'BLEND-1']);
  return { blendLabel: c.label };
}

export const TOOLING_SET = 'TS-GBT02-01';
const COUNTS = { upper: '45', lower: '45', dies: '45' };
const FINDINGS = Object.fromEntries(['TIPS', 'EDGES', 'WEAR', 'EMBOSSING', 'CORROSION', 'CLEANLINESS'].map((k) => [k, true]));

export interface CompressionPlan {
  blendLabel: string;
  checks: { L: string[]; R: string[] };
  containers: { L: string[]; R: string[] };
  good: string;
  residue: string;
  rejects: string;
}

/**
 * What a connected site adds to the compression run (GB-T-03, Phase 6 slice 6j-b: the OPC UA press), at a fixed point of
 * the run. GB-T-02 passes none, so its run is the same act for act.
 */
export interface CompressionHooks {
  /**
   * After the run's start and the first station sweeps, while the batch holds the press; returns the whole minutes of
   * the database clock it used, which the wait before the first weight check leaves out (the checks keep their times).
   */
  duringRun?(g: GoldenBatch): Promise<number>;
}

/** Compression into the bulk containers of each side (the bulk the bottle order packs), the yield, the release for packing. */
export async function compression(g: GoldenBatch, plan: CompressionPlan, hooks: CompressionHooks = {}): Promise<{ id: string; label: string }[]> {
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

  const run = 'p-run@';
  const weight = (stream: 'L' | 'R', groupWeight: string) => entry(run, 'WEIGHT_CHECK', { instrument: bal, capture: 'MANUAL', stream, groupWeight });
  const sweep = (stream: 'L' | 'R') =>
    entry(run, 'STATION_SWEEP', { instrument: bal, capture: 'MANUAL', stream, stations: [1, 2, 3, 4].map((station, i) => ({ station, weight: ['199.8', '200.6', '201.2', '198.9'][i] ?? '200.0' })) });
  await g.d.ok('operator1', { type: 'START_STEP', stepKey: run });
  const open: { L: { id: string; label: string } | null; R: { id: string; label: string } | null } = {
    L: await openContainer(g, 'COMPRESSION', press, 'L'),
    R: await openContainer(g, 'COMPRESSION', press, 'R'),
  };
  const all: { id: string; label: string }[] = [];
  await g.d.ok('operator1', entry(run, 'RUN_START', { press }));
  await g.d.ok('operator1', sweep('L'));
  await g.d.ok('operator1', sweep('R'));
  const spent = (await hooks.duringRun?.(g)) ?? 0;
  const n = plan.checks.L.length;
  for (let i = 0; i < n; i += 1) {
    const last = i === n - 1;
    if (!last) await g.wait(i === 0 ? 20 - spent : 20);
    else await g.d.ok('operator1', entry(run, 'RUN_END', {}));
    for (const s of ['L', 'R'] as const) {
      const c = open[s];
      if (c) {
        await closeContainer(g, c.id, plan.containers[s][i] ?? '0');
        all.push(c);
      }
      await g.d.ok('operator1', weight(s, plan.checks[s][i] ?? ''));
      open[s] = last ? null : await openContainer(g, 'COMPRESSION', press, s);
    }
  }
  await g.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: run });
  await g.signed('verifier1', { type: 'VERIFY', stepKey: run, meaning: 'VERIFIED' });

  await g.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tool-ret@' });
  const returned = await dbAs<Json>(g.w, g.b('operator1'), 'operator1', 'select tab.return_tooling($1, $2, $3) as r', [issue.issueId, COUNTS, '98600']);
  await g.d.ok('operator1', entry('p-tool-ret@', 'TOOLING_RETURNED', { set: TOOLING_SET, issueId: issue.issueId, strokes: returned['strokes'], strokeSource: returned['strokeSource'], countMismatch: returned['countMismatch'], limitExceeded: returned['limitExceeded'] }));
  const post = await dbAs<{ inspectionId: string }>(g.w, g.b('operator1'), 'operator1', 'select tab.inspect_tooling($1, $2, $3, $4, $5) as r', [TOOLING_SET, 'POST_USE', issue.issueId, FINDINGS, null]);
  await g.d.ok('operator1', entry('p-tool-ret@', 'TOOLING_INSPECTED', { set: TOOLING_SET, inspectionId: post.inspectionId, when: 'AFTER', result: 'PASS' }));
  await g.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tool-ret@' });
  await g.signed('verifier1', { type: 'VERIFY', stepKey: 'p-tool-ret@', meaning: 'VERIFIED' });

  // The bulk: each side's containers recorded as the stage's output (the plant containers above are what packing takes).
  await g.step('p-comp-out@', { entries: [...plan.containers.L, ...plan.containers.R].map((net) => output('p-comp-out@', 'I-CORES', net, bal)) });
  await g.step('p-comp-yield@', { entries: [data('p-comp-yield@', 'compGood', plan.good, 'kg'), data('p-comp-yield@', 'compResidue', plan.residue, 'kg'), data('p-comp-yield@', 'compRejects', plan.rejects, 'kg')] });
  await g.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-PACK@', disposition: 'APPROVED', comment: 'Bulk released for packing' });
  await g.closeStage('S-COMP@');
  await g.release([press, 'COMP-1']);
  return all;
}
