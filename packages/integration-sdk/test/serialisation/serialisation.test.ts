import { describe, expect, it } from 'vitest';
import { Gtin } from '@ebmr/integration-sdk/printer';
import {
  GS,
  MARKET_PROFILES,
  PoolReport,
  PoolRequest,
  canonicalReportText,
  codeContentProblems,
  gs1Date,
  gtinCarriesNdc,
  h2CodeContent,
  ndcToGtin,
  parseGs1,
  poolReport,
  reportHashOf,
  reportReconciles,
  serialTransitionAllowed,
  unitCodeContent,
  type PoolSnapshot,
} from '@ebmr/integration-sdk/serialisation';

const EU_GTIN = '08901234567890';

describe('market code content (D-S4-1)', () => {
  it('holds EU FMD and US DSCSA as unit-level serialised markets and India Schedule H2 as a batch-level QR without serials', () => {
    expect(Object.keys(MARKET_PROFILES)).toEqual(['EU_FMD', 'US_DSCSA', 'IN_H2']);
    expect([MARKET_PROFILES.EU_FMD.level, MARKET_PROFILES.US_DSCSA.level, MARKET_PROFILES.IN_H2.level]).toEqual(['UNIT', 'UNIT', 'BATCH']);
    expect(MARKET_PROFILES.IN_H2.serialised).toBe(false);
    expect(MARKET_PROFILES.EU_FMD.antiTampering).toBe(true);
  });

  it('builds the EU unit identifier from the record values as GS1 element strings, fixed-length first, GS after a variable one', () => {
    const c = unitCodeContent('EU_FMD', { gtin: EU_GTIN, serial: 'K7Q2M9X4P1RA', batch: 'B2610-001', expiryDate: '2028-09' });
    expect(c.hri).toBe('(01)08901234567890(17)280900(10)B2610-001(21)K7Q2M9X4P1RA');
    expect(c.data).toBe(`01${EU_GTIN}17280900` + `10B2610-001${GS}21K7Q2M9X4P1RA`);
    expect(Object.fromEntries(parseGs1(c.data))).toEqual({ '01': EU_GTIN, '17': '280900', '10': 'B2610-001', '21': 'K7Q2M9X4P1RA' });
    expect(gs1Date('2028-09-30')).toBe('280930');
  });

  it('builds the US product identifier only from a GTIN that carries the NDC', () => {
    const gtin = ndcToGtin('1234-5678-90');
    expect(gtin.slice(0, 13)).toBe('0031234567890');
    expect(Gtin.safeParse(gtin).success).toBe(true);
    expect(gtinCarriesNdc(gtin)).toBe(true);
    expect(() => unitCodeContent('US_DSCSA', { gtin: EU_GTIN, serial: 'A1', batch: 'B1', expiryDate: '2028-09' })).toThrow(/NDC/);
    expect(() => ndcToGtin('123456-7890-12')).toThrow(/12-digit/);
    expect(unitCodeContent('US_DSCSA', { gtin, serial: 'A1', batch: 'B1', expiryDate: '2028-09-30' }).hri).toBe(`(01)${gtin}(17)280930(10)B1(21)A1`);
  });

  it('[PR-42] refuses a code whose encoded lot or expiry differs from the record, and accepts one that carries them', () => {
    const record = { batch: 'B2610-001', expiryDate: '2028-09', gtin: EU_GTIN };
    const good = unitCodeContent('EU_FMD', { gtin: EU_GTIN, serial: 'S1', batch: 'B2610-001', expiryDate: '2028-09' });
    expect(codeContentProblems(good, record)).toEqual([]);
    const wrongExpiry = unitCodeContent('EU_FMD', { gtin: EU_GTIN, serial: 'S1', batch: 'B2610-001', expiryDate: '2029-09' });
    expect(codeContentProblems(wrongExpiry, record)).toEqual(['the code carries expiry 290900, the record 280900']);
    const wrongLot = unitCodeContent('EU_FMD', { gtin: EU_GTIN, serial: 'S1', batch: 'B2610-002', expiryDate: '2028-09' });
    expect(codeContentProblems(wrongLot, record)).toHaveLength(1);
    expect(codeContentProblems({ market: 'EU_FMD', data: '99garbage' }, record)[0]).toMatch(/cannot be read/);
    const h2 = h2CodeContent({ upic: 'UPIC-1', genericName: 'Paracetamol Tablets IP 500 mg', brandName: 'Brand', manufacturer: 'Maker, Address', batch: 'B2610-001', mfgDate: '2026-10', expiryDate: '2028-09', licenceNumber: 'MFG/25/1' });
    expect(h2.data).toBe('UPIC=UPIC-1;GENERIC=Paracetamol Tablets IP 500 mg;BRAND=Brand;MFR=Maker, Address;BATCH=B2610-001;MFG=2026-10;EXP=2028-09;LIC=MFG/25/1');
    expect(codeContentProblems(h2, record)).toEqual([]);
    expect(codeContentProblems(h2, { ...record, expiryDate: '2028-10' })).toHaveLength(1);
  });
});

describe('L3 contract: pools, serial states and the hashed report', () => {
  const pool = (states: (null | 'COMMISSIONED' | 'DECOMMISSIONED' | 'DESTROYED' | 'SAMPLE' | 'UNUSED_RETURNED')[]): PoolSnapshot => ({
    poolId: 'POOL-000001',
    packagingOrder: 'PO-1',
    market: 'EU_FMD',
    gtin: EU_GTIN,
    serials: states.map((state, i) => ({ serial: `S${String(i).padStart(3, '0')}`, state })),
  });

  it('takes a pool request with the quantity as whole decimal text, never a number or zero', () => {
    expect(PoolRequest.safeParse({ packagingOrder: 'PO-1', market: 'EU_FMD', gtin: EU_GTIN, quantity: '100' }).success).toBe(true);
    expect(PoolRequest.safeParse({ packagingOrder: 'PO-1', market: 'EU_FMD', gtin: EU_GTIN, quantity: 100 }).success).toBe(false);
    expect(PoolRequest.safeParse({ packagingOrder: 'PO-1', market: 'EU_FMD', gtin: EU_GTIN, quantity: '0' }).success).toBe(false);
    expect(PoolRequest.safeParse({ packagingOrder: 'PO-1', market: 'DGFT', gtin: EU_GTIN, quantity: '1' }).success).toBe(false);
  });

  it('allows only the serial state changes of the contract', () => {
    expect(serialTransitionAllowed(null, 'COMMISSIONED')).toBe(true);
    expect(serialTransitionAllowed(null, 'SAMPLE')).toBe(false);
    expect(serialTransitionAllowed('COMMISSIONED', 'DECOMMISSIONED')).toBe(true);
    expect(serialTransitionAllowed('DECOMMISSIONED', 'COMMISSIONED')).toBe(false);
    expect(serialTransitionAllowed('DESTROYED', 'SAMPLE')).toBe(false);
  });

  it('[PR-42] reports zero unexplained only when every serial has a state, with counts that add up', () => {
    const open = poolReport(pool(['COMMISSIONED', null, 'SAMPLE']));
    expect(PoolReport.safeParse(open).success).toBe(true);
    expect(open.counts).toEqual({ issued: '3', COMMISSIONED: '1', DECOMMISSIONED: '0', DESTROYED: '0', SAMPLE: '1', UNUSED_RETURNED: '0' });
    expect(open.unexplained).toBe('1');
    expect(reportReconciles(open)).toBe(false);
    const closed = poolReport(pool(['COMMISSIONED', 'UNUSED_RETURNED', 'SAMPLE']));
    expect(closed.unexplained).toBe('0');
    expect(reportReconciles(closed)).toBe(true);
    expect(reportReconciles({ ...closed, counts: { ...closed.counts, issued: '4' } })).toBe(false);
  });

  it('hashes the canonical report text: stable for the same pool in any serial order, different when a state differs', () => {
    const a = pool(['COMMISSIONED', 'DESTROYED', 'SAMPLE']);
    const shuffled: PoolSnapshot = { ...a, serials: [...a.serials].reverse() };
    expect(canonicalReportText(a)).toBe(canonicalReportText(shuffled));
    expect(poolReport(a).reportHash).toBe(poolReport(shuffled).reportHash);
    expect(poolReport(a).reportHash).toBe(reportHashOf(canonicalReportText(a)));
    expect(canonicalReportText(a).split('\n').slice(0, 13)).toEqual([
      'ebmr.l3-report.v1',
      'poolId=POOL-000001',
      'packagingOrder=PO-1',
      'market=EU_FMD',
      `gtin=${EU_GTIN}`,
      'issued=3',
      'COMMISSIONED=1',
      'DECOMMISSIONED=0',
      'DESTROYED=1',
      'SAMPLE=1',
      'UNUSED_RETURNED=0',
      'unexplained=0',
      'S000 COMMISSIONED',
    ]);
    expect(poolReport(pool(['COMMISSIONED', 'DESTROYED', 'DESTROYED'])).reportHash).not.toBe(poolReport(a).reportHash);
    expect(poolReport(a).reportHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
