import { describe, expect, it } from 'vitest';
import type { MbrContent } from '../../src/flow/model.ts';
import { defineRule, error } from '../../src/validator/rule-kit.ts';
import type { MinimaRequest, ResolvedMinimum } from '../../src/validator/types.ts';
import { withEditionRules } from '../../src/validator/validate.ts';
import { clone, errors, loadFixture, validate } from '../flow/support.ts';

function withMinima(minima: ResolvedMinimum[], seen: MinimaRequest[] = []) {
  return {
    market: {
      minima: (r: MinimaRequest): ResolvedMinimum[] => {
        seen.push(r);
        return minima;
      },
    },
  };
}

function bound(): MbrContent {
  const m = clone(loadFixture('tablet-granulation-compression'));
  const lod = m.parameters.find((p) => p.id === 'lod');
  if (lod) lod.marketRule = { key: 'tablets.drying.lodMax', bound: 'HIGH' };
  const window = m.timeConstraints.find((t) => t.id === 'TC-GRAN-WINDOW');
  if (window) window.marketRule = { key: 'tablets.granulation.windowMax', bound: 'HIGH' };
  return m;
}

const limit = (ruleKey: string, value: string, unit: string): ResolvedMinimum => ({ kind: 'LIMIT', ruleKey, bound: 'HIGH', value, unit, governingMarkets: ['IN'], tableVersion: 'tablets v3' });

describe('market-resolved content minima (hook for the kernel market engine)', () => {
  it('[PR-03] the validator asks the market engine for the rule keys the MBR binds, for its market set and date', () => {
    const seen: MinimaRequest[] = [];
    validate(bound(), withMinima([], seen));
    expect(seen).toEqual([
      { edition: 'tablets', recordKind: 'PROCESSING', marketSet: ['IN', 'US'], predicates: {}, asOf: '2026-09-28', ruleKeys: ['tablets.drying.lodMax', 'tablets.granulation.windowMax'] },
    ]);
  });

  it('[PR-03] without the market engine the content minima are unchecked and the MBR fails closed', () => {
    const m = loadFixture('tablet-blister-packaging');
    const ctx = { market: undefined };
    const report = validate(m, ctx as never);
    expect(errors(report).map((f) => f.rule)).toEqual(['MKT-MINIMA']);
  });

  it('[PR-03] an MBR limit looser than the value resolved for the market set is refused, naming the governing market', () => {
    const report = validate(bound(), withMinima([limit('tablets.drying.lodMax', '3.0', '%')]));
    const f = errors(report).filter((x) => x.rule === 'MKT-MINIMA');
    // Every tier is checked: the validated range and the alert limit are both looser than 3.0 %.
    expect(f.map((x) => x.message)).toEqual([
      expect.stringMatching(/alert limit of "Loss on drying of granules" \(lod\) \(3\.4 %\) is looser than the maximum of 3\.0 %/),
      expect.stringMatching(/validated limit of "Loss on drying of granules" \(lod\) \(3\.5 %\) is looser than the maximum of 3\.0 % required by IN \(rule tablets\.drying\.lodMax, table tablets v3\)/),
    ]);
    expect(errors(validate(bound(), withMinima([limit('tablets.drying.lodMax', '3.5', '%')])))).toEqual([]);
  });

  it('[PR-03] a time constraint longer than the resolved maximum is refused (units converted exactly)', () => {
    expect(errors(validate(bound(), withMinima([limit('tablets.granulation.windowMax', '300', 'min')]))).map((f) => f.message)).toEqual([
      expect.stringMatching(/Time constraint "Charge-in to end of drying \(per sub-lot\)" \(TC-GRAN-WINDOW\) \(6 h\) is looser than the maximum of 300 min/),
    ]);
    expect(errors(validate(bound(), withMinima([limit('tablets.granulation.windowMax', '360', 'min')])))).toEqual([]);
  });

  it('[PR-03] a key the market engine cannot resolve, or a minimum nothing in the MBR is bound to, fails closed', () => {
    const r1 = validate(bound(), withMinima([{ kind: 'UNRESOLVED', ruleKey: 'tablets.drying.lodMax', problem: 'licence form predicate missing' }]));
    expect(errors(r1).map((f) => f.message)).toEqual([expect.stringMatching(/could not be resolved for this market set: licence form predicate missing/)]);
    const r2 = validate(bound(), withMinima([limit('tablets.compression.ipcSampleMaxInterval', '30', 'min')]));
    expect(errors(r2).map((f) => f.message)).toEqual([expect.stringMatching(/requires tablets\.compression\.ipcSampleMaxInterval .* but no parameter or time constraint of the MBR is bound to it/)]);
  });

  it('[PR-03] a required content item is checked by the rule that covers it; an item no rule covers fails closed', () => {
    const item = (name: string): ResolvedMinimum => ({ kind: 'REQUIRED_ITEM', ruleKey: 'kernel.content.x', item: name, governingMarkets: ['IN'], tableVersion: 'kernel v1' });
    expect(errors(validate(bound(), withMinima([item('HOLD_TIME_EVERY_INTERMEDIATE'), item('SPECIMEN_EVERY_PRINTED_COMPONENT')])))).toEqual([]);
    expect(errors(validate(bound(), withMinima([item('TABLETS_STATION_WISE_CHECK')]))).map((f) => f.message)).toEqual([expect.stringMatching(/requires content item TABLETS_STATION_WISE_CHECK .* which no rule of this validator version checks/)]);
    // An edition rule set plugs in and declares the item it enforces.
    const registry = withEditionRules([defineRule('TAB-STATION-WISE', 'Station-wise checks on multi-point presses', ['PR-03'], () => [], { edition: 'tablets', covers: ['TABLETS_STATION_WISE_CHECK'] })]);
    expect(errors(validate(bound(), withMinima([item('TABLETS_STATION_WISE_CHECK')]), registry))).toEqual([]);
    // An edition rule reports through the same channel and message form.
    const strict = withEditionRules([defineRule('TAB-DEMO', 'Demo edition rule', ['PR-03'], (a) => [error('$', `demo finding for ${a.mbr.header.family}`)], { edition: 'tablets' })]);
    expect(errors(validate(bound(), {}, strict)).map((f) => f.message)).toEqual(['demo finding for ATV40-GRAN-COMP-200K (TAB-DEMO; PR-03)']);
  });
});
