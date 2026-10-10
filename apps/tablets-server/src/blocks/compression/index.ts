/**
 * The compression-side Tablets edition blocks of Phase 3 slice 3c (builder A): TB-09 tooling custody and inspection,
 * TB-10 compression set-up and first-off approval, TB-17 reject and detection devices. Each version is released once and
 * never changes (ADR 0010); the database's registers and rules are tablets 0870 to 0874.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { TB09 } from '../tb-09.ts';
import { TB10 } from '../tb-10.ts';
import { TB17 } from '../tb-17.ts';
import type { BlockVersion } from './common.ts';

export { TB09, TB10, TB17 };

export const COMPRESSION_BLOCK_VERSIONS: readonly BlockVersion[] = [TB09, TB10, TB17];

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
export const COMPRESSION_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = [
  descriptor(TB09, ['OBSERVATION']),
  descriptor(TB10, ['PARAMETER_RECORD']),
  descriptor(TB17, ['OBSERVATION']),
];
