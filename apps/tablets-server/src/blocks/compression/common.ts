/**
 * Shared pieces of the compression-side Tablets edition blocks of Phase 3 slice 3c (builder A: TB-09, TB-10, TB-17;
 * tablets spec section B.2). The registers these blocks record against (tooling, plant uses and charges, detector
 * challenges) are the database's (tablets 0870 to 0872, recipe-core 0420 to 0422 and 0540): a block entry names the
 * register row its command wrote and states its facts; the block raises the exceptions those facts call for, and the
 * database checks the entry against the row (tablets 0874). Counts are whole-number text, never a JavaScript number.
 */
import type { FieldSchema } from '../granulation/common.ts';

export * from '../granulation/common.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A plant equipment code (recipe-core 0400). */
export const EQUIPMENT_CODE = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
/** A whole number written as text (counts, strokes). */
export const COUNT = /^[0-9]{1,18}$/;

export const uuidField = (description: string): FieldSchema => ({ type: 'string', pattern: UUID, description });
export const countField = (description: string): FieldSchema => ({ type: 'string', pattern: COUNT, description });
