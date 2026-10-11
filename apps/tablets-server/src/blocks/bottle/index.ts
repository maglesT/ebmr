/**
 * The packaging-line blocks of the Tablets edition, Phase 3 slice 4b (builder B): TB-23 bottle line and TB-24 secondary
 * and tertiary packaging with the finished-pack examination. Each version is released once and never changes (ADR
 * 0010); the database rows of their entry kinds and their rules are tablets 0985 to 0987.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { TB23 } from '../tb-23.ts';
import { TB24 } from '../tb-24.ts';
import type { BlockVersion } from './common.ts';

export { TB23, TB24 };

export const BOTTLE_BLOCK_VERSIONS: readonly BlockVersion[] = [TB23, TB24];

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
export const BOTTLE_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = [descriptor(TB23, ['IPC']), descriptor(TB24, ['IPC'])];
