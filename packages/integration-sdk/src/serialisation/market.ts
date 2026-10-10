/**
 * Market code content (Phase 3 slice 4a, K-21, PR-42; default D-S4-1): one L3 system per site, the markets differing
 * only in code content and pool rules, held here as data. EU FMD and US DSCSA carry a unit-level identifier in a GS1
 * DataMatrix; India Schedule H2 a batch-level QR payload (no serials). DGFT export barcoding and iVEDA are out
 * (withdrawn, A39). Requirements paraphrased from the design document K-21 (secondary sources, see the catalogs);
 * the Schedule H2 data elements are on the watch list, so its payload layout is a stub until confirmed.
 *
 * Content is always built from the record's values, never typed; codeContentProblems() checks that the lot and
 * expiry a code carries equal the record's (PR-42: an encoded lot or expiry that differs is refused). Pure.
 */
import { gs1CheckDigit } from '../printer/wire.ts';

export const MARKETS = ['EU_FMD', 'US_DSCSA', 'IN_H2'] as const;
export type Market = (typeof MARKETS)[number];

export interface MarketProfile {
  market: Market;
  name: string;
  /** UNIT: one identifier per saleable pack; BATCH: one code per batch, printed on every pack. */
  level: 'UNIT' | 'BATCH';
  /** Whether the market takes serials from an L3 pool. */
  serialised: boolean;
  carrier: string;
  /** The data the code carries, in order. */
  elements: readonly string[];
  /** The longest serial the market allows (null when there are none). */
  serialMaxLength: number | null;
  antiTampering: boolean;
  /** Pool rule on the GTIN: US packs carry the NDC inside the GTIN (indicator digit, then 03). */
  gtinMustCarryNdc: boolean;
}

export const MARKET_PROFILES: Record<Market, MarketProfile> = {
  EU_FMD: {
    market: 'EU_FMD',
    name: 'EU falsified medicines (unique identifier and anti-tampering device)',
    level: 'UNIT',
    serialised: true,
    carrier: 'GS1 DataMatrix',
    elements: ['GTIN (01)', 'EXPIRY (17)', 'BATCH (10)', 'SERIAL (21)', 'NATIONAL REIMBURSEMENT NUMBER (710-714) where required'],
    serialMaxLength: 20,
    antiTampering: true,
    gtinMustCarryNdc: false,
  },
  US_DSCSA: {
    market: 'US_DSCSA',
    name: 'US DSCSA product identifier',
    level: 'UNIT',
    serialised: true,
    carrier: 'GS1 DataMatrix on packages; linear or 2D on homogeneous cases',
    elements: ['GTIN carrying the NDC (01)', 'EXPIRY (17)', 'LOT (10)', 'SERIAL (21)'],
    serialMaxLength: 20,
    antiTampering: false,
    gtinMustCarryNdc: true,
  },
  IN_H2: {
    market: 'IN_H2',
    name: 'India Schedule H2 batch-level QR',
    level: 'BATCH',
    serialised: false,
    carrier: 'QR or barcode on the primary pack (secondary when space is short)',
    elements: ['UNIQUE PRODUCT IDENTIFICATION CODE', 'PROPER AND GENERIC NAME', 'BRAND NAME', 'MANUFACTURER NAME AND ADDRESS', 'BATCH', 'MFG DATE', 'EXPIRY', 'MANUFACTURING LICENCE NUMBER'],
    serialMaxLength: null,
    antiTampering: false,
    gtinMustCarryNdc: false,
  },
};

/** The GS1 group separator, ending a variable-length element string that is not the last. */
export const GS = '\x1d';

/** GS1 AI 17 (YYMMDD) from a record date; a month-precision date gives day 00. */
export function gs1Date(recordDate: string): string {
  const m = /^[0-9]{2}([0-9]{2})-([0-9]{2})(?:-([0-9]{2}))?$/.exec(recordDate);
  if (!m) throw new Error(`${recordDate} is not a record date`);
  return `${m[1] ?? ''}${m[2] ?? ''}${m[3] ?? '00'}`;
}

/** GS1 AI 21 and 10 characters accepted here: a safe subset of GS1 character set 82. */
const GS1_VAR = /^[A-Za-z0-9/.-]{1,20}$/;

/** The GTIN-14 that carries a 10-digit NDC (indicator 0, prefix 03). The 12-digit NDC's GTIN form is not settled: refused. */
export function ndcToGtin(ndc: string): string {
  const digits = ndc.replace(/-/g, '');
  if (!/^[0-9]{10}$/.test(digits)) throw new Error(`${ndc} is not a 10-digit NDC; the 12-digit NDC's GTIN form is not settled`);
  const body = `003${digits}`;
  return `${body}${gs1CheckDigit(body)}`;
}

/** Whether a GTIN carries an NDC (US packs). */
export function gtinCarriesNdc(gtin: string): boolean {
  return /^[0-9]03[0-9]{11}$/.test(gtin);
}

export interface UnitCodeData {
  gtin: string;
  serial: string;
  batch: string;
  expiryDate: string;
  /** EU only, where a member state requires it: AI 710-714 and the number. */
  nhrn?: { ai: '710' | '711' | '712' | '713' | '714'; value: string };
}

export interface CodeContent {
  market: Market;
  /** What the symbol encodes (GS1: element strings, GS after a variable-length one that is not last). */
  data: string;
  /** The human-readable interpretation printed beside it. */
  hri: string;
}

/** EU FMD or US DSCSA unit identifier: GTIN, expiry, batch, serial (and the EU national number where required). */
export function unitCodeContent(market: 'EU_FMD' | 'US_DSCSA', d: UnitCodeData): CodeContent {
  const profile = MARKET_PROFILES[market];
  if (!/^[0-9]{14}$/.test(d.gtin) || gs1CheckDigit(d.gtin.slice(0, 13)) !== Number(d.gtin.slice(13))) throw new Error(`${d.gtin} is not a GTIN-14`);
  if (profile.gtinMustCarryNdc && !gtinCarriesNdc(d.gtin)) throw new Error(`${d.gtin} does not carry an NDC`);
  if (!GS1_VAR.test(d.serial) || d.serial.length > (profile.serialMaxLength ?? 0)) throw new Error(`${d.serial} is not a serial of ${market}`);
  if (!GS1_VAR.test(d.batch)) throw new Error(`${d.batch} cannot be encoded as a batch`);
  if (d.nhrn && (market !== 'EU_FMD' || !GS1_VAR.test(d.nhrn.value))) throw new Error('a national reimbursement number is EU only and encodable');
  const parts: [string, string, boolean][] = [
    ['01', d.gtin, false],
    ['17', gs1Date(d.expiryDate), false],
    ['10', d.batch, true],
    ['21', d.serial, true],
    ...(d.nhrn ? [[d.nhrn.ai, d.nhrn.value, true] as [string, string, boolean]] : []),
  ];
  const data = parts.map(([ai, v, variable], i) => `${ai}${v}${variable && i < parts.length - 1 ? GS : ''}`).join('');
  const hri = parts.map(([ai, v]) => `(${ai})${v}`).join('');
  return { market, data, hri };
}

export interface H2Data {
  upic: string;
  genericName: string;
  brandName: string;
  manufacturer: string;
  batch: string;
  mfgDate: string;
  expiryDate: string;
  licenceNumber: string;
}

const H2_KEYS: [keyof H2Data, string][] = [
  ['upic', 'UPIC'],
  ['genericName', 'GENERIC'],
  ['brandName', 'BRAND'],
  ['manufacturer', 'MFR'],
  ['batch', 'BATCH'],
  ['mfgDate', 'MFG'],
  ['expiryDate', 'EXP'],
  ['licenceNumber', 'LIC'],
];

/** India Schedule H2 batch-level QR payload (stub layout: KEY=value;... in a fixed order, dates as the record holds them). */
export function h2CodeContent(d: H2Data): CodeContent {
  for (const [k, key] of H2_KEYS) {
    const v = d[k];
    if (!/^[\x20-\x7E]{1,200}$/.test(v) || /[;=]/.test(v)) throw new Error(`${key} must be printable text without ; or =`);
  }
  const data = H2_KEYS.map(([k, key]) => `${key}=${d[k]}`).join(';');
  return { market: 'IN_H2', data, hri: `B.No. ${d.batch} MFG ${d.mfgDate} EXP ${d.expiryDate}` };
}

const FIXED: Record<string, number> = { '01': 14, '17': 6 };
const VARIABLE = new Set(['10', '21', '710', '711', '712', '713', '714']);

/** Reads GS1 element strings (the AIs above) into AI -> value; throws on anything it does not know. */
export function parseGs1(data: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const two = data.slice(i, i + 2);
    const three = data.slice(i, i + 3);
    const ai = VARIABLE.has(three) ? three : two;
    if (out.has(ai)) throw new Error(`AI ${ai} appears twice`);
    i += ai.length;
    const fixed = FIXED[ai];
    if (fixed !== undefined) {
      const v = data.slice(i, i + fixed);
      if (!/^[0-9]+$/.test(v) || v.length !== fixed) throw new Error(`AI ${ai} needs ${fixed} digits`);
      out.set(ai, v);
      i += fixed;
      continue;
    }
    if (!VARIABLE.has(ai)) throw new Error(`unknown AI at ${i - ai.length}`);
    const end = data.indexOf(GS, i);
    const v = data.slice(i, end < 0 ? data.length : end);
    if (!GS1_VAR.test(v)) throw new Error(`AI ${ai} holds ${v}`);
    out.set(ai, v);
    i = end < 0 ? data.length : end + 1;
  }
  return out;
}

/**
 * Whether a code's content carries the record's lot and expiry (and, for a unit code, the GTIN). Pure; empty when it
 * does. A content that cannot be read is one problem.
 */
export function codeContentProblems(content: Pick<CodeContent, 'market' | 'data'>, record: { batch: string; expiryDate: string; gtin?: string }): string[] {
  if (content.market === 'IN_H2') {
    const fields = new Map(content.data.split(';').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as const));
    const out: string[] = [];
    if (fields.get('BATCH') !== record.batch) out.push(`the code carries batch ${fields.get('BATCH') ?? 'none'}, the record ${record.batch}`);
    if (fields.get('EXP') !== record.expiryDate) out.push(`the code carries expiry ${fields.get('EXP') ?? 'none'}, the record ${record.expiryDate}`);
    return out;
  }
  let ais: Map<string, string>;
  try {
    ais = parseGs1(content.data);
  } catch (error) {
    return [`the code cannot be read: ${error instanceof Error ? error.message : String(error)}`];
  }
  const out: string[] = [];
  if (ais.get('10') !== record.batch) out.push(`the code carries batch ${ais.get('10') ?? 'none'}, the record ${record.batch}`);
  if (ais.get('17') !== gs1Date(record.expiryDate)) out.push(`the code carries expiry ${ais.get('17') ?? 'none'}, the record ${gs1Date(record.expiryDate)}`);
  if (record.gtin !== undefined && ais.get('01') !== record.gtin) out.push(`the code carries GTIN ${ais.get('01') ?? 'none'}, the record ${record.gtin}`);
  if (!ais.has('21')) out.push('a unit code carries a serial');
  return out;
}
