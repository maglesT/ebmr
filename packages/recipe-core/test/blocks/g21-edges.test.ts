/**
 * G-21@1 printed materials, coding, challenges and serialisation (PR-32, PR-33, PR-36, PR-37, PR-39, PR-40, PR-42,
 * IN-16, IN-17, IN-22, INV-32) at their edges, through its handler on a minimal view: the issue (released, unexpired
 * lot of the material with the scanned and market artwork, the item's unit, a positive quantity, never above the rule;
 * equal allowed), the reconciliation (exact unexplained against both limits, equal allowed; device or typed counts), the
 * first print, the challenges (gateway result and time, order, interval strictly), the serial pools and their
 * reconciliation, PERFORMED and the definition checks. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { G21, gtinValid, issuedOf, lineDevices, printedItems, serialisedMarkets, withinLimits } from '../../src/blocks/generic/printed.ts';
import { Dec } from '@ebmr/expr';
import type { HandlerView } from '../../src/blocks/contract.ts';
import type { MbrContent, PhaseNode } from '../../src/flow/model.ts';

type Json = Record<string, unknown>;
const NOW = 1_800_000_000_000_000n;
const MIN = 60_000_000n;
const GTIN = '08901234567890';
const ITEM = { id: 'CARTON', material: 'MAT-C', artwork: { IN: 'ART-7', US: 'ART-7' }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '5' }, coded: true };
const CFG: Json = {
  items: [ITEM],
  destructionStep: 'after',
  devices: [
    { id: 'CODER', kind: 'PRINTER', serial: 'PRN-01' },
    { id: 'CAM', kind: 'VISION', serial: 'VIS-01', every: { value: '30', unit: 'min' } },
    { id: 'CW', kind: 'CHECKWEIGHER', triggers: ['START'] },
  ],
  unit: 'LINE-1',
  firstPrintRole: 'OPERATOR',
  markets: { IN: { gtin: GTIN } },
  serialisation: { markets: ['IN'] },
};

class World {
  entries: { id: string; kind: string; data: Json; recordedAt: bigint }[] = [];
  now = NOW;
  actor: Json = { id: 'OP1', kind: 'PERSON', roles: ['OPERATOR'] };
  constructor(readonly config: Json = CFG, readonly markets: string[] = ['IN']) {}
  view(): HandlerView {
    return {
      phase: { id: 'p' },
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      batch: { marketSet: this.markets },
      entries: (k?: string) => this.entries.filter((e) => k === undefined || e.kind === k),
      actor: this.actor,
    } as unknown as HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[]; verificationRequired?: boolean } {
    const r = (G21.handler?.acceptEntry as (v: HandlerView, e: Json) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[]; verificationRequired?: boolean })(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
  before(): string[] {
    return (G21.handler?.beforePerform as (v: HandlerView) => { code: string; message: string }[])(this.view()).map((p) => p.message);
  }
}
const LOT = { id: 'L1', material: 'MAT-C', status: 'RELEASED', artwork: 'ART-7' };
const issue = (value: string, over: Json = {}, lot: Json = {}) => ({ kind: 'ISSUE', item: 'CARTON', lot: { ...LOT, ...lot }, scannedArtwork: 'ART-7', quantity: { value, unit: '1' }, ...over });
const recon = (over: Json = {}) => ({ kind: 'RECONCILIATION', item: 'CARTON', used: '990', setupWaste: '5', damaged: '0', codedDestroyed: '0', uncodedReturned: '0', specimens: '0', ...over });
const ch = (device: string, over: Json = {}) => ({ kind: 'CHALLENGE', device, trigger: 'START', result: 'PASS', ...over });

describe('G-21 issue', () => {
  it('[PR-32][PR-33] a released, unexpired lot of the material, the scanned artwork the lot\'s and every market\'s, in the item\'s unit, positive', () => {
    const w = new World(CFG, ['IN', 'US']);
    expect(w.rec(issue('10', { item: 'LEAFLET' })).refused).toBe('LEAFLET is not a printed item of p (G21-ITEM; PR-33)');
    expect(w.rec(issue('10', {}, { status: 'QUARANTINE' })).refused).toBe('Lot L1 is quarantine: printed material is issued only from released lots (G21-LOT-STATUS; PR-32, PR-33)');
    expect(w.rec(issue('10', {}, { expiresAtUs: NOW.toString() })).refused).toBe('Lot L1 is past its expiry date (G21-LOT-EXPIRED; PR-32)');
    expect(w.rec(issue('10', {}, { expiresAtUs: (NOW + 1n).toString() })).refused).toBeUndefined();
    expect(w.rec(issue('10', {}, { material: 'MAT-X' })).refused).toBe('Lot L1 is MAT-X, not MAT-C (G21-MATERIAL; PR-33)');
    expect(w.rec(issue('10', { scannedArtwork: 'ART-6' })).refused).toBe('The label scanned at the line reads artwork ART-6, but lot L1 carries ART-7 (G21-SCAN; PR-33)');
    const other = new World({ ...CFG, items: [{ ...ITEM, artwork: { IN: 'ART-7', US: 'ART-8' } }] }, ['IN', 'US', 'EU']);
    expect(other.rec(issue('10')).refused).toBe('Lot L1 carries artwork ART-7; the master names ART-8 for US, none for EU (G21-ARTWORK; PR-32, PR-33)');
    expect(w.rec(issue('10', { quantity: { value: '10', unit: 'kg' } })).refused).toBe('CARTON is issued in 1, not kg (G21-UNIT; PR-33)');
    expect(w.rec(issue('0')).refused).toBe('An issue of CARTON is a positive quantity (G21-QUANTITY; PR-33)');
    expect(w.rec(issue('0', { scannedArtwork: 'X' })).refused?.split(' | ')).toHaveLength(2);
  });

  it('[PR-33][IN-17] the issued total never above the need plus the allowance (equal allowed); manual counts need a second person; nothing after the reconciliation', () => {
    const w = new World();
    const first = w.rec(issue('1000'));
    expect(first).toStrictEqual({ data: { item: 'CARTON', lot: LOT, artwork: 'ART-7', quantity: { value: '1000', unit: '1' }, counting: 'MANUAL_COUNT', issuedBy: 'OP1' }, verificationRequired: true });
    expect(w.rec(issue('21')).refused).toBe('CARTON would be issued 1021 1, above the rule of 1000 1 plus 2 % (G21-OVER-ISSUE; PR-33, IN-17)');
    expect(w.rec(issue('20')).refused).toBeUndefined();
    expect(issuedOf(w.view(), 'CARTON')).toEqual({ total: Dec.parse('1020'), text: '1020' });
    expect(issuedOf(w.view(), 'NONE').text).toBe('0');
    const scanned = new World({ ...CFG, items: [{ ...ITEM, counting: 'SCANNED' }] });
    expect(scanned.rec(issue('1')).verificationRequired).toBeUndefined();
    w.rec(recon({ used: '1015' }));
    expect(w.rec(issue('1')).refused).toBe('CARTON is reconciled already: nothing more is issued at this step (G21-RECONCILED; PR-39, IN-17)');
  });
});

describe('G-21 reconciliation', () => {
  it('[INV-32][IN-17][PR-39] unexplained = issued - accounted, at the finest scale; inside both limits (equal allowed) or a release-blocking exception', () => {
    const w = new World();
    w.rec(issue('1000.0'));
    expect(w.rec(recon({ item: 'X' })).refused).toBe('X is not a printed item of p (G21-ITEM; PR-39)');
    const r = w.rec(recon({ used: '990', setupWaste: '5' }));
    expect(r.data).toStrictEqual({ item: 'CARTON', used: '990', setupWaste: '5', damaged: '0', codedDestroyed: '0', uncodedReturned: '0', specimens: '0', unit: '1', issued: '1000.0', unexplained: '5.0', withinLimits: true, counted: 'DEVICE', reconciledBy: 'OP1' });
    expect(r.exceptions).toBeUndefined();
    expect(r.verificationRequired).toBeUndefined();
    expect(w.rec(recon()).refused).toBe('CARTON is reconciled already at this step (G21-RECONCILED-TWICE; PR-39, IN-17)');
    const over = new World();
    over.rec(issue('1000'));
    const bad = over.rec(recon({ used: '1000', setupWaste: '5.5' }));
    expect([bad.data?.['unexplained'], bad.data?.['withinLimits']]).toEqual(['-5.5', false]);
    expect(bad.exceptions).toEqual([
      { type: 'PRINTED_RECONCILIATION', title: 'The reconciliation of CARTON at p@ leaves -5.5 1 unexplained of 1000 issued, outside its limits: an investigation is needed and release is blocked', controls: ['PR-39', 'IN-17', 'INV-32'], severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, releaseBlocking: true, item: 'CARTON' },
    ]);
  });

  it('[INV-32][PR-40] limits as an amount and as a percentage of the issued; an uncoded item has nothing coded; typed counts need a second person', () => {
    const item = (limits: Json) => printedItems({ items: [{ ...ITEM, limits }] })[0]!;
    expect(withinLimits(item({ maxUnexplained: '5' }), Dec.parse('100'), Dec.parse('-5'))).toBe(true);
    expect(withinLimits(item({ maxUnexplained: '5' }), Dec.parse('100'), Dec.parse('5.01'))).toBe(false);
    expect(withinLimits(item({ maxUnexplainedPercent: '1' }), Dec.parse('500'), Dec.parse('-5'))).toBe(true);
    expect(withinLimits(item({ maxUnexplainedPercent: '1' }), Dec.parse('500'), Dec.parse('5.01'))).toBe(false);
    expect(withinLimits(item({ maxUnexplained: '10', maxUnexplainedPercent: '1' }), Dec.parse('500'), Dec.parse('6'))).toBe(false);
    expect(withinLimits(item({}), Dec.parse('1'), Dec.parse('999'))).toBe(true);
    const plain = new World({ ...CFG, items: [{ ...ITEM, coded: false }] });
    plain.rec(issue('1000'));
    expect(plain.rec(recon({ codedDestroyed: '1' })).refused).toBe('CARTON is not printed on the line, so none of it is coded (G21-NOT-CODED; PR-39, PR-40)');
    const typed = plain.rec(recon({ codedDestroyed: '0.0' }));
    expect([typed.data?.['counted'], typed.verificationRequired]).toEqual(['TYPED', true]);
    const noSerial = new World({ ...CFG, devices: [{ id: 'CODER', kind: 'PRINTER' }] });
    noSerial.rec(issue('1000'));
    expect(noSerial.rec(recon()).data?.['counted']).toBe('TYPED');
    const camOnly = new World({ ...CFG, devices: [{ id: 'CAM', kind: 'VISION', serial: 'V' }] });
    camOnly.rec(issue('1000'));
    expect(camOnly.rec(recon()).data?.['counted']).toBe('TYPED');
  });
});

describe('G-21 first print and challenges', () => {
  it('[PR-36][IN-16] the first print of a printer, approved by the MBR\'s role (QA by default); a system records it', () => {
    const w = new World();
    expect(w.rec({ kind: 'FIRST_PRINT', device: 'CAM', job: 'J' }).refused).toBe('CAM is not a printer of p (G21-DEVICE; PR-36)');
    expect(w.rec({ kind: 'FIRST_PRINT', device: 'NONE', job: 'J' }).refused).toMatch(/G21-DEVICE/);
    expect(w.rec({ kind: 'FIRST_PRINT', device: 'CODER', job: 'J', approved: true, specimen: 'S-1' }).data).toStrictEqual({ device: 'CODER', job: 'J', approved: true, specimen: 'S-1', approvedBy: 'OP1' });
    expect(w.rec({ kind: 'FIRST_PRINT', device: 'CODER', job: 'J', approved: 'yes', specimen: 3 }).data).toStrictEqual({ device: 'CODER', job: 'J', approved: false, approvedBy: 'OP1' });
    const qa = new World({ ...CFG, firstPrintRole: undefined });
    expect(qa.rec({ kind: 'FIRST_PRINT', device: 'CODER', job: 'J' }).refused).toBe('The first print is approved by QA (G21-APPROVER; PR-36, IN-16)');
    qa.actor = { id: 'SYS', kind: 'SYSTEM', roles: [] };
    expect(qa.rec({ kind: 'FIRST_PRINT', device: 'CODER', job: 'J' }).refused).toBeUndefined();
  });

  it('[IN-22][DI-31] a gateway device\'s challenge names its result and when the device took it (not later than now, in order); a device without a link names neither', () => {
    const w = new World();
    const ev = '00000000-0000-4000-8000-000000000001';
    expect(w.rec(ch('CODER')).refused).toBe('CODER is not an inspection device of p (G21-DEVICE; IN-22)');
    expect(w.rec(ch('NONE')).refused).toMatch(/G21-DEVICE/);
    expect(w.rec(ch('CAM', { at: NOW.toString() })).refused).toBe("CAM reports through the gateway: its challenge names the gateway's result (G21-EVENT; IN-22, DI-31)");
    expect(w.rec(ch('CW', { event: ev })).refused).toBe('CW has no gateway link: its challenge names no gateway result (G21-EVENT; IN-22, DI-31)');
    expect(w.rec(ch('CW', { at: NOW.toString() })).refused).toMatch(/CW has no gateway link/);
    expect(w.rec(ch('CAM', { event: ev })).refused).toBe("CAM's challenge states when the device took it, never later than now (G21-EVENT; IN-22, DI-31)");
    expect(w.rec(ch('CAM', { event: ev, at: (NOW + 1n).toString() })).refused).toMatch(/never later than now/);
    expect(w.rec(ch('CAM', { event: ev, at: NOW.toString() })).data).toStrictEqual({ device: 'CAM', trigger: 'START', result: 'PASS', event: ev, at: NOW.toString(), missed: false, challengedBy: 'OP1' });
    expect(w.rec(ch('CAM', { event: ev, at: (NOW - 1n).toString() })).refused).toBe("CAM's challenges are recorded in the order the device took them (G21-EVENT-ORDER; IN-22, DI-31)");
    expect(w.rec(ch('CAM', { event: ev, at: NOW.toString(), trigger: 'END' })).refused).toBeUndefined();
    const cw = w.rec(ch('CW'));
    expect(cw.data).toStrictEqual({ device: 'CW', trigger: 'START', result: 'PASS', missed: false, challengedBy: 'OP1' });
    expect(cw.verificationRequired).toBe(true);
  });

  it('[IN-22][PR-37] a challenge later than the interval after the last pass is missed (exactly the interval is not); a failure stops the step; both can come together', () => {
    const w = new World();
    const ev = '00000000-0000-4000-8000-000000000001';
    const at = (m: bigint, plus = 0n) => (NOW + m * MIN + plus).toString();
    w.now = NOW + 200n * MIN;
    w.rec(ch('CAM', { event: ev, at: at(0n) }));
    expect(w.rec(ch('CAM', { event: ev, at: at(30n), result: 'FAIL', trigger: 'INTERVAL' })).exceptions?.map((x) => x['type'])).toEqual(['CHALLENGE_FAILED']);
    const both = w.rec(ch('CAM', { event: ev, at: at(30n, 1n), result: 'FAIL', trigger: 'INTERVAL' }));
    expect(both.data?.['missed']).toBe(true);
    expect(both.exceptions).toEqual([
      { type: 'CHALLENGE_MISSED', title: 'CAM at p@ was not challenged within its interval: the step stops and the output since the last good challenge is held until QA decides', controls: ['IN-22', 'PR-37'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'STEP_AND_DOWNSTREAM', until: 'DISPOSITION', item: 'CAM' },
      { type: 'CHALLENGE_FAILED', title: 'The challenge of CAM at p@ failed: the step stops and the output since the last good challenge is held until QA decides', controls: ['IN-22', 'PR-37'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'STEP_AND_DOWNSTREAM', until: 'DISPOSITION', item: 'CAM' },
    ].map((x) => expect.objectContaining(x)));
    expect(w.rec(ch('CAM', { event: ev, at: at(31n) })).data?.['missed']).toBe(true);
    expect(w.rec(ch('CAM', { event: ev, at: at(61n) })).data?.['missed']).toBe(false);
  });
});

describe('G-21 serialisation', () => {
  it('[PR-42] one pool per serialised market of the batch with the master\'s GTIN; its reconciliation closes only with zero unexplained and every serial accounted for', () => {
    const w = new World(CFG, ['IN', 'US']);
    const pool = (over: Json = {}) => ({ kind: 'SERIAL_POOL', poolId: 'P1', market: 'IN', gtin: GTIN, quantity: '100', ...over });
    expect(w.rec(pool({ market: 'US' })).refused).toBe('US is not a serialised market of p and this batch (G21-MARKET; PR-42)');
    expect(new World(CFG, ['US']).rec(pool()).refused).toMatch(/G21-MARKET/);
    expect(w.rec(pool({ gtin: '08901234567891' })).refused).toBe('The pool is for GTIN 08901234567891, not the master\'s for IN (G21-GTIN; PR-42)');
    expect(w.rec(pool()).data).toStrictEqual({ poolId: 'P1', market: 'IN', gtin: GTIN, quantity: '100', recordedBy: 'OP1' });
    expect(w.rec(pool({ poolId: 'P2' })).refused).toBe('IN has its pool at this step already (G21-POOL-TWICE; PR-42)');
    const two = new World({ ...CFG, markets: { IN: { gtin: GTIN }, US: { gtin: GTIN } }, serialisation: { markets: ['IN', 'US'] } }, ['IN', 'US']);
    two.rec(pool());
    expect(two.rec(pool({ market: 'US' })).refused).toMatch(/G21-POOL-TWICE/);
    expect(two.rec(pool({ market: 'US', poolId: 'P2' })).refused).toBeUndefined();
    const rc = (over: Json = {}) => ({ kind: 'SERIAL_RECONCILIATION', poolId: 'P1', commissioned: '90', decommissioned: '4', destroyed: '3', samples: '2', unusedReturned: '1', unexplained: '0', reportHash: 'h', ...over });
    expect(w.rec(rc({ poolId: 'P9' })).refused).toBe('P9 is no serial pool of this step (G21-POOL-UNKNOWN; PR-42)');
    const ok = w.rec(rc());
    expect(ok.data).toStrictEqual({ poolId: 'P1', commissioned: '90', decommissioned: '4', destroyed: '3', samples: '2', unusedReturned: '1', unexplained: '0', reportHash: 'h', quantity: '100', closed: true, reconciledBy: 'OP1' });
    expect(ok.exceptions).toBeUndefined();
    expect(w.rec(rc({ unusedReturned: '0' })).data?.['closed']).toBe(false);
    const open = w.rec(rc({ unexplained: '1' }));
    expect(open.data?.['closed']).toBe(false);
    expect(open.exceptions).toEqual([
      { type: 'SERIAL_RECONCILIATION_OPEN', title: 'Serial pool P1 at p@ does not close: 1 unexplained of 100; the packaging order cannot complete and release is blocked', controls: ['PR-42', 'PR-39'], severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'NONE', deviationRequired: true, releaseBlocking: true, item: 'P1' },
    ]);
  });
});

describe('G-21 PERFORMED and definition', () => {
  it('[INV-32][PR-36][IN-22][PR-42] every item reconciled, every printer\'s first print approved, start and end challenges passed and none due, every pool closed at its last reconciliation', () => {
    const w = new World();
    const ev = '00000000-0000-4000-8000-000000000001';
    expect(w.before()).toEqual([
      'Reconcile CARTON first: the reconciliation always runs (G21-NOT-RECONCILED; PR-39, IN-17, INV-32)',
      'The first print of CODER is not approved (G21-NO-FIRST-PRINT; PR-36, IN-16)',
      'CAM has no passing start challenge (G21-CHALLENGE-DUE; IN-22, PR-37)',
      'CAM has no passing end challenge (G21-CHALLENGE-DUE; IN-22, PR-37)',
      'CW has no passing start challenge (G21-CHALLENGE-DUE; IN-22, PR-37)',
      'IN has no serial pool (G21-NO-POOL; PR-42)',
    ]);
    w.rec(issue('1000'));
    w.rec(recon());
    w.rec({ kind: 'FIRST_PRINT', device: 'CODER', job: 'J', approved: false });
    w.rec(ch('CAM', { event: ev, at: NOW.toString() }));
    w.rec(ch('CAM', { event: ev, at: NOW.toString(), trigger: 'END', result: 'FAIL' }));
    w.rec(ch('CW', { trigger: 'END' }));
    w.rec({ kind: 'SERIAL_POOL', poolId: 'P1', market: 'IN', gtin: GTIN, quantity: '1' });
    w.rec({ kind: 'SERIAL_RECONCILIATION', poolId: 'P1', commissioned: '1', decommissioned: '0', destroyed: '0', samples: '0', unusedReturned: '0', unexplained: '0', reportHash: 'h' });
    w.rec({ kind: 'SERIAL_RECONCILIATION', poolId: 'P1', commissioned: '0', decommissioned: '0', destroyed: '0', samples: '0', unusedReturned: '0', unexplained: '1', reportHash: 'h' });
    expect(w.before()).toEqual([
      'The first print of CODER is not approved (G21-NO-FIRST-PRINT; PR-36, IN-16)',
      'CAM has no passing end challenge (G21-CHALLENGE-DUE; IN-22, PR-37)',
      'CW has no passing start challenge (G21-CHALLENGE-DUE; IN-22, PR-37)',
      'Serial pool P1 is not reconciled with zero unexplained (G21-SERIALS-OPEN; PR-42)',
    ]);
    w.rec({ kind: 'FIRST_PRINT', device: 'CODER', job: 'J', approved: true });
    w.rec(ch('CAM', { event: ev, at: NOW.toString(), trigger: 'END' }));
    w.rec(ch('CW'));
    w.rec({ kind: 'SERIAL_RECONCILIATION', poolId: 'P1', commissioned: '1', decommissioned: '0', destroyed: '0', samples: '0', unusedReturned: '0', unexplained: '0', reportHash: 'h' });
    expect(w.before()).toEqual([]);
    w.now = NOW + 30n * MIN;
    expect(w.before()).toEqual([]);
    w.now = NOW + 30n * MIN + 1n;
    expect(w.before()).toEqual(['CAM is due for a challenge (G21-CHALLENGE-DUE; IN-22, PR-37)']);
    expect(new World(CFG, ['US']).before()).not.toContain('IN has no serial pool (G21-NO-POOL; PR-42)');
  });

  it('[PR-33][PR-39][PR-32][PR-40][IN-22][PR-42] the definition: items and devices once, limits, artwork per market, a destruction step for coded items, whole-microsecond intervals, a plant unit, GTIN check digits', () => {
    const P = (config: Json, markets: string[] = ['IN']) => (G21.checkConfig as (p: PhaseNode, c: Json, m: MbrContent) => { code: string; message: string }[])({ id: 'p' } as PhaseNode, config, { header: { marketSet: markets } } as unknown as MbrContent).map((x) => `${x.code}: ${x.message}`);
    expect(P(CFG)).toEqual([]);
    expect(P({ ...CFG, items: [ITEM, ITEM, { ...ITEM, id: 'B' }, { ...ITEM, id: 'B' }] })).toEqual(['G21-DUPLICATE: p names printed item CARTON, B twice']);
    expect(P({ ...CFG, devices: [{ id: 'A', kind: 'VISION' }, { id: 'A', kind: 'READER' }] })).toEqual(['G21-DUPLICATE: p names device A twice']);
    expect(P({ ...CFG, items: [{ ...ITEM, limits: {} }] })).toEqual(['G21-NO-LIMITS: Printed item CARTON of p has no reconciliation limits: a packaging master is approved only with them']);
    expect(P({ ...CFG, items: [{ ...ITEM, limits: { maxUnexplainedPercent: '1' } }] })).toEqual([]);
    expect(P(CFG, ['IN', 'EU', 'UK'])).toEqual(['G21-ARTWORK-MARKET: Printed item CARTON of p names no artwork version for EU, UK: every market the pack covers names its artwork']);
    expect(P({ ...CFG, destructionStep: undefined })).toEqual(['G21-DESTRUCTION-STEP: p codes printed items on the line but names no G-23 step where coded surplus is destroyed']);
    expect(P({ ...CFG, destructionStep: undefined, items: [{ ...ITEM, coded: false }] })).toEqual([]);
    expect(P({ ...CFG, devices: [{ id: 'A', kind: 'VISION', every: { value: '0.0000001', unit: 's' } }] })).toEqual(['G21-INTERVAL: The challenge interval of A is not a whole number of microseconds']);
    expect(P({ ...CFG, devices: [{ id: 'A', kind: 'PRINTER', every: { value: '0.0000001', unit: 's' } }] })).toEqual([]);
    expect(P({ ...CFG, unit: undefined })).toEqual(['G21-NO-UNIT: p has printers or inspection devices but names no plant unit of the line, so a failed challenge or a batch-data change could hold nothing']);
    expect(P({ ...CFG, unit: undefined, devices: [] })).toEqual([]);
    expect(P({ ...CFG, markets: { IN: { gtin: '08901234567891' } } })).toEqual(['G21-GTIN-CHECK: The GTIN of IN at p has a wrong check digit']);
    expect(P({ ...CFG, markets: { IN: { gtin: 8901234567890 } } })).toEqual(['G21-SERIAL-GTIN: p serialises IN but names no GTIN for it']);
    expect(P({ ...CFG, markets: {}, serialisation: undefined })).toEqual([]);
  });

  it('[PR-42][IN-31] GTIN check digits, the configuration as read', () => {
    expect([gtinValid(GTIN), gtinValid('08901234567891'), gtinValid('0890123456789'), gtinValid('0890123456789X'), gtinValid('00000000000000')]).toEqual([true, false, false, false, true]);
    expect(gtinValid('10614141000415')).toBe(true);
    expect(gtinValid('10614141000416')).toBe(false);
    expect(lineDevices({ devices: [{ id: 'A', kind: 'VISION', every: { value: '1' } }, 'x'] })).toEqual([
      { id: 'A', kind: 'VISION', triggers: ['START', 'END'] },
      { id: 'undefined', kind: 'undefined', triggers: ['START', 'END'] },
    ]);
    expect(lineDevices({ devices: [{ id: 'A', kind: 'VISION', serial: 3, triggers: ['X', 1], every: { value: '1', unit: 'h' } }] })).toEqual([{ id: 'A', kind: 'VISION', triggers: ['X', '1'], every: { value: '1', unit: 'h' } }]);
    expect(printedItems({ items: [{ ...ITEM, artwork: { IN: 'A', US: 2 }, limits: { maxUnexplained: 5 }, coded: 'yes' }] })[0]).toEqual({ id: 'CARTON', material: 'MAT-C', artwork: { IN: 'A' }, unit: '1', need: '1000', allowancePercent: '2', counting: 'MANUAL_COUNT', coded: false });
    expect(printedItems({ items: 'x' })).toEqual([]);
    expect(serialisedMarkets({})).toEqual([]);
    expect(G21.handler?.acceptEntry?.(new World().view(), { kind: 'OTHER' })).toEqual({ ok: false, problems: [expect.objectContaining({ message: 'OTHER is not an entry of a printed-materials step (G21-ENTRY; PR-33)' })] });
  });
});
