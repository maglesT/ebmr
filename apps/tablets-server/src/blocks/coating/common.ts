/**
 * Shared pieces of the coating and finishing blocks of Phase 3 slice 3d (builder A: TB-18 coating to weight gain, TB-19
 * printing with the QC gate, TB-20 inspection, sorting and AQL; tablets spec B.2). Tablet samples are weighed as a group
 * or one by one and kept as entered (DI-29); their totals and means are the block's own exact arithmetic (calc.ts), which
 * the database repeats (tablets 0911). Counts are whole-number text, never a JavaScript number.
 */
import type { FieldSchema, ObjectSchema } from '../compression/common.ts';
import { meanMg, sumText, toMg } from './calc.ts';

export * from '../compression/common.ts';

export const MASS_UNITS = ['mg', 'g'] as const;

/** A whole number of tablets, at least one, as text. */
export const POSITIVE_COUNT = /^[1-9][0-9]{0,17}$/;

export const positiveCount = (description: string): FieldSchema => ({ type: 'string', pattern: POSITIVE_COUNT, description });

/** The members of a tablet sample weighing (TB-18 cores and coated tablets). */
export const SAMPLE_FIELDS: Readonly<Record<string, FieldSchema>> = {
  instrument: { type: 'string', pattern: /^[A-Z0-9][A-Z0-9_-]{0,63}$/, description: 'Plant balance the sample was weighed on' },
  weighing: { type: 'string', enum: ['GROUP', 'INDIVIDUAL'], description: 'All tablets together (one total) or one by one (each weight kept)' },
  count: positiveCount('Number of tablets weighed'),
  total: { type: 'decimal', min: '0', minExclusive: true, optional: true, description: 'Weight of all tablets together (GROUP)' },
  weights: {
    type: 'array',
    optional: true,
    minItems: 1,
    maxItems: 200,
    items: { type: 'decimal', min: '0', minExclusive: true, description: 'One tablet weight' },
    description: 'Each tablet weight in order (INDIVIDUAL)',
  },
  unit: { type: 'string', enum: [...MASS_UNITS], description: 'mg or g' },
};

export const SAMPLE_ENTRY = (description: string): ObjectSchema => ({ type: 'object', description, fields: SAMPLE_FIELDS });

export interface Sample {
  instrument: string;
  weighing: 'GROUP' | 'INDIVIDUAL';
  count: string;
  totalMg: string;
  meanMg: string;
  weights?: string[];
  total?: string;
  unit: string;
}

/** The sample as the block keeps it, or why it is not one (`code` names the rule). */
export function sampleOf(entry: Readonly<Record<string, unknown>>, wantCount: string | undefined): { ok: true; sample: Sample } | { ok: false; message: string } {
  const count = String(entry['count']);
  const unit = String(entry['unit']);
  const weighing = entry['weighing'] === 'INDIVIDUAL' ? 'INDIVIDUAL' : 'GROUP';
  if (wantCount !== undefined && count !== wantCount) return { ok: false, message: `The sample is ${wantCount} tablets as the MBR sets it, not ${count}` };
  let total: string;
  if (weighing === 'GROUP') {
    if (typeof entry['total'] !== 'string' || entry['weights'] !== undefined) return { ok: false, message: 'A group weighing records one total and no single weights' };
    total = entry['total'];
  } else {
    const ws = Array.isArray(entry['weights']) ? entry['weights'].map(String) : undefined;
    if (!ws || entry['total'] !== undefined || BigInt(ws.length) !== BigInt(count)) return { ok: false, message: `Weighing one by one records each of the ${count} tablet weights and no total` };
    total = sumText(ws);
  }
  const totalMg = toMg(total, unit);
  return {
    ok: true,
    sample: {
      instrument: String(entry['instrument']),
      weighing,
      count,
      totalMg,
      meanMg: meanMg(totalMg, BigInt(count)),
      unit,
      ...(weighing === 'INDIVIDUAL' ? { weights: (entry['weights'] as unknown[]).map(String) } : { total }),
    },
  };
}

/** The stored members of a sample (the entered values and the computed total and mean). */
export function sampleData(s: Sample): Record<string, unknown> {
  return {
    instrument: s.instrument,
    weighing: s.weighing,
    count: s.count,
    unit: s.unit,
    ...(s.weights ? { weights: s.weights } : { total: s.total }),
    totalMg: s.totalMg,
    meanMg: s.meanMg,
  };
}
