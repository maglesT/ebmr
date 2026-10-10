/**
 * The granulation-side Tablets edition blocks of Phase 3 slice 3b (builder B): TB-02 sifting and milling, TB-03
 * solutions with use-by, TB-04 wet granulation end point, TB-05 drying with the LOD loop, TB-07 blending, lubrication
 * and blend uniformity. Each version is released once and never changes (ADR 0010); the database rows of their entry
 * kinds and their rules are tablets 0850 to 0852.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { TB02 } from '../tb-02.ts';
import { TB03 } from '../tb-03.ts';
import { TB04 } from '../tb-04.ts';
import { TB05 } from '../tb-05.ts';
import { TB07 } from '../tb-07.ts';
import type { BlockVersion } from './common.ts';

export { TB02, TB03, TB04, TB05, TB07 };

export const GRANULATION_BLOCK_VERSIONS: readonly BlockVersion[] = [TB02, TB03, TB04, TB05, TB07];

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
export const GRANULATION_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = [
  descriptor(TB02, ['OBSERVATION']),
  descriptor(TB03, ['PARAMETER_RECORD']),
  descriptor(TB04, ['PARAMETER_RECORD']),
  descriptor(TB05, ['PARAMETER_RECORD']),
  descriptor(TB07, ['PARAMETER_RECORD']),
];
