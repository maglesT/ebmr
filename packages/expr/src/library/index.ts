/**
 * The closed function library (ADR 0005 decision 6). An expression can call only these; there are
 * no user-defined functions. Adding or changing one is a platform release and a new
 * EXPR_LANGUAGE_VERSION.
 *
 * Deferred with the Injectables edition (owner decision 2026-09-28): F0 / lethality, fill volume and
 * fill weight (injectables C-05) and the theoretical number of filled units (injectables C-06).
 */
import { abs, convert, max, min, minusPercent, plusPercent } from './basic.ts';
import type { LibraryFunction } from './contract.ts';
import {
  adjustedQuantity,
  asIsFromDry,
  assayAsIsAnhydrous,
  assayAsIsAnhydrousSolventFree,
  assayAsIsDried,
  baseEquivalent,
  compensatingExcipient,
  massFromVolume,
  potencyAdjustedQuantity,
  quantityForBase,
  saltFactor,
  standardQuantity,
  volumeFromMass,
} from './potency.ts';
import { count, mean, rsd, sd, sum } from './stats.ts';
import { duration, tableLookup } from './time-and-tables.ts';
import { accountability, percentGain, percentLoss, unaccounted, yieldFn } from './yield.ts';

const ALL: readonly LibraryFunction[] = [
  abs,
  min,
  max,
  convert,
  plusPercent,
  minusPercent,
  sum,
  count,
  mean,
  sd,
  rsd,
  yieldFn,
  accountability,
  unaccounted,
  percentGain,
  percentLoss,
  assayAsIsAnhydrous,
  assayAsIsDried,
  assayAsIsAnhydrousSolventFree,
  saltFactor,
  standardQuantity,
  adjustedQuantity,
  potencyAdjustedQuantity,
  baseEquivalent,
  quantityForBase,
  compensatingExcipient,
  asIsFromDry,
  massFromVolume,
  volumeFromMass,
  duration,
  tableLookup,
];

export const LIBRARY: ReadonlyMap<string, LibraryFunction> = new Map(ALL.map((f) => [f.name, f]));

/** Name, signature, summary and design reference of every library function (for the designer help). */
export function libraryCatalogue(): { name: string; signature: string; summary: string; reference: string }[] {
  return ALL.map((f) => ({ name: f.name, signature: f.signature, summary: f.summary, reference: f.reference }));
}
