/**
 * The forming blocks of the Tablets edition, Phase 3 slice 3d (builder B): TB-06 dry granulation by roller compaction
 * and TB-16 bilayer compression. Each version is released once and never changes (ADR 0010); the database rows of their
 * entry kinds and their rules are tablets 0930 to 0932.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { TB06 } from '../tb-06.ts';
import { TB16 } from '../tb-16.ts';
import type { BlockVersion } from './common.ts';

export { TB06, TB16 };

export const FORMING_BLOCK_VERSIONS: readonly BlockVersion[] = [TB06, TB16];

const descriptor = (b: BlockVersion, roles: flow.BlockRole[]): flow.BlockDescriptor => ({
  type: b.type,
  versions: [b.version],
  edition: 'tablets',
  title: b.title,
  roles,
  significant: true,
  phase: { allowed: true },
  requiresSystem: false,
});

/** What the validator needs to know about them (roles, significant steps). */
export const FORMING_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = [descriptor(TB06, ['PARAMETER_RECORD']), descriptor(TB16, ['IPC'])];
