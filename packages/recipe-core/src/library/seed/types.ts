/**
 * The ready-made catalogue (decision 0026, slices S7 and S8): library block definitions shipped as data, each with
 * example product values. The catalogue is never in force by itself: an author loads it into the library as drafts
 * and QA approves what the site uses (the same DRAFT -> APPROVED path as any library block). The example values serve
 * the tests (every item is well made, its example values pass the formulation checks, and a nominal batch runs it to
 * completion) and are shown to the author as a starting point; the product's own values are the formulation's.
 *
 * Invented values only; reference limits paraphrase common compendial values and quote no pharmacopoeia text.
 */
import type { BlockDefinition, BlockUse } from '../model.ts';

export interface SeedItem {
  definition: BlockDefinition;
  /** Example product values for the definition's slots (a formulation would set its own). */
  exampleUse: Omit<BlockUse, 'block'>;
  /** Example values of the definition's external inputs (formula line, batch size, lot assay, earlier step). */
  exampleInputs?: Record<string, { value: string; unit: string }>;
}
