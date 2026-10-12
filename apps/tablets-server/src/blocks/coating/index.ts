/**
 * The coating and finishing Tablets edition blocks of Phase 3 slice 3d (builder A): TB-18 coating to weight gain on the
 * coater, TB-19 printing with the QC approval gate, TB-20 inspection, sorting and AQL. Each version is released once and
 * never changes (ADR 0010); the database's registers and rules are tablets 0910 to 0912.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { TB18 } from '../tb-18.ts';
import { TB19 } from '../tb-19.ts';
import { TB20, TB20_V2 } from '../tb-20.ts';
import type { BlockVersion } from './common.ts';

export { TB18, TB19, TB20, TB20_V2 };

/** TB-20@2 (Phase 4 slice 1b, D-P4-11): the NO_PLAN outcome through a linked deviation; TB-20@1 stays for open batches. */
export const COATING_BLOCK_VERSIONS: readonly BlockVersion[] = [TB18, TB19, TB20, TB20_V2];

const descriptor = (b: BlockVersion, roles: flow.BlockRole[], versions: string[] = [b.version]): flow.BlockDescriptor => ({
  type: b.type,
  versions,
  edition: 'tablets',
  title: b.title,
  roles,
  significant: true,
  phase: { allowed: true },
  requiresSystem: false,
});

/** What the validator needs to know about them (roles, significant steps). */
export const COATING_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = [
  descriptor(TB18, ['PARAMETER_RECORD']),
  descriptor(TB19, ['OBSERVATION']),
  descriptor(TB20, ['OBSERVATION'], [TB20.version, TB20_V2.version]),
];
