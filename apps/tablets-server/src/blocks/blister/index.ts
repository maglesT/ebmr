/**
 * The blister blocks of the Tablets edition, Phase 3 slice 4b (builder A): TB-21 blister or strip line set-up,
 * independent line check and sealing, and TB-22 blister leak test. Each version is released once and never changes
 * (ADR 0010); the database rows of their entry kinds and their rules are tablets 0970 to 0972.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { TB21 } from '../tb-21.ts';
import { TB22 } from '../tb-22.ts';
import type { BlockVersion } from './common.ts';

export { TB21, TB22 };

export const BLISTER_BLOCK_VERSIONS: readonly BlockVersion[] = [TB21, TB22];

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
export const BLISTER_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = [descriptor(TB21, ['PARAMETER_RECORD']), descriptor(TB22, ['IPC'])];
