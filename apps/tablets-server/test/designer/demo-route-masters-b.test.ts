/**
 * Phase 7 slice 7n (requirement R7): the route B masters, the beta-lactam product of the dedicated suite, are GMP
 * masters the designer accepts (they parse, the execution definition finds nothing to refuse) and carry what the route
 * is there to show: both actives potency-adjusted (two TB-01 steps), the dispensing room's humidity check (G-11) and the
 * coating room's (TB-18) against the suite's low limit, the film coat, every stage in a room of the suite, and the alu-alu
 * cold-form pack with its desiccant laminate (TB-21 COLD_FORM, TB-22). The references they pin are in the DEMO-ONLY
 * catalogue (pinned() throws otherwise).
 */
import { describe, expect, it } from 'vitest';
import type { flow } from '@ebmr/recipe-core/pure';
import { definitionFindings } from '../../src/features/designer/definition.ts';
import { RTB_FORMING, RTB_PLANT, RTB_RH_MAX, rtbPackagingContent, rtbProcessingContent } from '../../src/cli/demo-route-masters-b.ts';

type Json = Record<string, unknown>;

function walk(n: unknown, visit: (o: Json) => void): void {
  if (Array.isArray(n)) for (const x of n) walk(x, visit);
  else if (n && typeof n === 'object') {
    visit(n as Json);
    for (const v of Object.values(n as Json)) walk(v, visit);
  }
}
const phases = (mbr: flow.MbrContent): Json[] => {
  const out: Json[] = [];
  walk(mbr.procedure, (o) => (o['kind'] === 'phase' ? out.push(o) : undefined));
  return out;
};
const ofType = (mbr: flow.MbrContent, type: string): Json[] => phases(mbr).filter((p) => (p['block'] as { type: string }).type === type);
const rooms = (mbr: flow.MbrContent): string[] => {
  const out: string[] = [];
  walk(mbr.procedure, (o) => (o['kind'] === 'stage' ? out.push(...((o['binding'] as { rooms: string[] }).rooms)) : undefined));
  return out;
};
const errors = (mbr: flow.MbrContent) => definitionFindings(mbr).filter((f) => f.severity === 'ERROR');

describe('demo route B masters: the beta-lactam product in its dedicated suite (slice 7n, R7)', () => {
  it('[PR-27] the processing master defines without errors, is beta-lactam, runs every stage in the suite and checks both rooms against the low humidity limit', () => {
    const mbr = rtbProcessingContent('RTB-DC-TEST');
    expect(errors(mbr)).toEqual([]);
    expect(mbr.header.product.code).toBe('CXC-325');
    expect(mbr.header.predicates['betaLactam']).toBe(true);
    expect(rooms(mbr)).toEqual([RTB_PLANT.disp, RTB_PLANT.blend, RTB_PLANT.comp, RTB_PLANT.coat]);
    const tb01 = ofType(mbr, 'TB-01');
    expect(tb01.map((p) => ((p['config'] as Json)['active'] as Json)['bomLine'])).toEqual(['BOM-CEF', 'BOM-CLAV']);
    expect(ofType(mbr, 'G-11').map((p) => p['records'])).toEqual([['dispRoomRh']]);
    const rh = mbr.parameters.find((p) => p.id === 'dispRoomRh');
    expect(JSON.stringify(rh?.limits)).toContain(`"high":{"value":"${RTB_RH_MAX}"`);
    expect(ofType(mbr, 'TB-18').some((p) => JSON.stringify((p['config'] as Json)['room']) === JSON.stringify({ temperatureMin: '20', temperatureMax: '25', humidityMax: RTB_RH_MAX }))).toBe(true);
    expect(ofType(mbr, 'TB-18').every((p) => (p['config'] as Json)['coatingType'] === 'FC')).toBe(true);
    for (const t of ['TB-07', 'TB-09', 'TB-10', 'TB-11']) expect(ofType(mbr, t).length, t).toBeGreaterThan(0);
  });

  it('[PR-27] the packaging master defines without errors, runs on the suite\'s line and packs alu-alu cold-form blisters from the desiccant laminate: TB-21 COLD_FORM, TB-22, TB-24', () => {
    const mbr = rtbPackagingContent('RTB-CF-TEST');
    expect(errors(mbr)).toEqual([]);
    expect(mbr.header.packType).toBe('ALU-ALU-BLISTER');
    expect(mbr.header.predicates['betaLactam']).toBe(true);
    expect(rooms(mbr)).toEqual([RTB_PLANT.line]);
    const tb21 = ofType(mbr, 'TB-21');
    expect(tb21.every((p) => ((p['config'] as Json)['packFormat'] as Json)['form'] === 'COLD_FORM')).toBe(true);
    expect(tb21.every((p) => JSON.stringify((p['config'] as Json)['materials']).includes(RTB_FORMING))).toBe(true);
    for (const t of ['TB-22', 'TB-24', 'G-21', 'G-23']) expect(ofType(mbr, t).length, t).toBeGreaterThan(0);
  });
});
