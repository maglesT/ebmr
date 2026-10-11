/**
 * The reprocessing and recovery Tablets edition block of Phase 3 slice 5b: TB-08 rework or recovered-material addition
 * across batches (outline 5.2.9 cases 2 and 3). Released once and never changed (ADR 0010); the database's registers
 * and rules are recipe-core 0620 to 0622 and tablets 1020 and 1021.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { TB08 } from '../tb-08.ts';
import type { BlockVersion } from '../granulation/common.ts';

export { TB08 };

export const REPROCESSING_BLOCK_VERSIONS: readonly BlockVersion[] = [TB08];

/** What the validator needs to know about it: a reprocessing step (never skipped; its case and limits declared). */
export const REPROCESSING_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = [
  {
    type: TB08.type,
    versions: [TB08.version],
    edition: 'tablets',
    title: TB08.title,
    roles: ['REPROCESSING'],
    significant: true,
    phase: { allowed: true },
    requiresSystem: false,
  },
];
