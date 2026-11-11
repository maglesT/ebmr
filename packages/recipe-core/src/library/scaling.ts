/**
 * Batch generation with scaling (decision 0026, slice S10; owner decision O-8): a master lists its approved batch sizes
 * and every quantity of its bill of materials is written for the reference size, the first one listed (IN-13: the sizes
 * are approved together with the master; there is no free scaling). The quantity of a formula line for a batch is the
 * line's quantity times the batch size over the reference size, in exact decimals, never a JavaScript number.
 *
 * A library calculation's FORMULA_LINE input reads that quantity for the batch's own size, and its BATCH_SIZE input the
 * batch's size, so one approved master runs any of its listed sizes with the right quantities.
 */
import { Dec } from '@ebmr/expr';
import type { ExpressionService } from '../flow/expression-port.ts';
import type { MbrContent } from '../flow/model.ts';
import type { BlockDefinition } from './model.ts';

export interface ScaledQuantity {
  value: string;
  unit: string;
}

/** The size of batch size `sizeId`, or undefined when the master does not list it. */
export function batchSizeOf(mbr: Pick<MbrContent, 'header'>, sizeId: string | undefined): ScaledQuantity | undefined {
  const s = mbr.header.batchSizes.find((b) => b.id === sizeId);
  return s ? { value: s.quantity.value, unit: s.quantity.unit } : undefined;
}

/**
 * The quantity of BOM line `lineId` for a batch of size `sizeId`, in the line's unit: line quantity x size / reference
 * size (the first listed). Undefined when the line or the size is unknown, or the two sizes do not convert.
 */
export function scaledLine(mbr: Pick<MbrContent, 'header' | 'bom'>, lineId: string | undefined, sizeId: string | undefined, expr: ExpressionService): ScaledQuantity | undefined {
  const line = mbr.bom.find((b) => b.id === lineId);
  const size = mbr.header.batchSizes.find((b) => b.id === sizeId);
  const reference = mbr.header.batchSizes[0];
  if (!line || !size || !reference) return undefined;
  const sizeInRef = size.quantity.unit === reference.quantity.unit ? size.quantity.value : expr.convert(size.quantity.value, size.quantity.unit, reference.quantity.unit);
  if (sizeInRef === undefined) return undefined;
  const ref = Dec.parse(reference.quantity.value);
  if (ref.isZero()) return undefined;
  return { value: Dec.parse(line.quantity.value).times(Dec.parse(sizeInRef)).div(ref).toString(), unit: line.quantity.unit };
}

/**
 * The theoretical quantity of formula lines `lineIds` for a batch of size `sizeId`, in `unit`: the sum of each line
 * scaled for the batch and converted to `unit` (owner retest N-3: a stage's yield against the material it processes when
 * the batch size, e.g. in tablets, does not convert to the yield's unit). Undefined when a line is unknown or does not
 * convert, or no line is named.
 */
export function summedLines(mbr: Pick<MbrContent, 'header' | 'bom'>, lineIds: readonly string[] | undefined, sizeId: string | undefined, unit: string, expr: ExpressionService): ScaledQuantity | undefined {
  if (!lineIds || lineIds.length === 0) return undefined;
  let total = Dec.parse('0');
  for (const id of lineIds) {
    const q = scaledLine(mbr, id, sizeId, expr);
    if (!q) return undefined;
    const v = q.unit === unit ? q.value : expr.convert(q.value, q.unit, unit);
    if (v === undefined) return undefined;
    total = total.plus(Dec.parse(v));
  }
  return { value: total.toString(), unit };
}

/**
 * The values of a library step's formula-line and batch-size inputs for a batch of size `sizeId`, by input id, each in
 * the input's declared unit (shown on the step screen; the handler computes the same). A BATCH_SIZE input the use binds
 * to formula lines (`inputLines`, N-3) reads their scaled sum instead of the batch size.
 */
export function scaledInputs(
  def: BlockDefinition,
  config: { bomLines?: Record<string, string>; inputLines?: Record<string, string[]> },
  mbr: Pick<MbrContent, 'header' | 'bom'>,
  sizeId: string | undefined,
  expr: ExpressionService,
): Record<string, ScaledQuantity> {
  const out: Record<string, ScaledQuantity> = {};
  for (const i of def.inputs ?? []) {
    if (i.kind === 'BATCH_SIZE' && config.inputLines?.[i.id] !== undefined) {
      const sum = summedLines(mbr, config.inputLines[i.id], sizeId, i.unit, expr);
      if (sum) out[i.id] = sum;
      continue;
    }
    const q = i.kind === 'FORMULA_LINE' ? scaledLine(mbr, config.bomLines?.[i.slot], sizeId, expr) : i.kind === 'BATCH_SIZE' ? batchSizeOf(mbr, sizeId) : undefined;
    if (!q) continue;
    const value = q.unit === i.unit ? q.value : expr.convert(q.value, q.unit, i.unit);
    if (value !== undefined) out[i.id] = { value, unit: i.unit };
  }
  return out;
}
