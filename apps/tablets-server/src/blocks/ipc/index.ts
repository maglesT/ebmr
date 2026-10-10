/**
 * The IPC blocks of the Tablets edition, Phase 3 slice 3c (builder B): TB-11 periodic IPC scheduler with streams and
 * the bracketing hold, TB-12 weight, TB-13 breaking force, thickness, diameter and appearance, TB-14 friability, TB-15
 * disintegration. Each version is released once and never changes (ADR 0010); the database rows of their entry kinds,
 * the compendial rule sets and their rules are tablets 0890 to 0893.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { TB11 } from '../tb-11.ts';
import { TB12 } from '../tb-12.ts';
import { TB13 } from '../tb-13.ts';
import { TB14 } from '../tb-14.ts';
import { TB15 } from '../tb-15.ts';
import type { BlockVersion } from './common.ts';

export { TB11, TB12, TB13, TB14, TB15 };

export const IPC_BLOCK_VERSIONS: readonly BlockVersion[] = [TB11, TB12, TB13, TB14, TB15];

const descriptor = (b: BlockVersion): flow.BlockDescriptor => ({
  type: b.type,
  versions: [b.version],
  edition: 'tablets',
  title: b.title,
  roles: ['IPC'],
  significant: true,
  phase: { allowed: true },
  requiresSystem: false,
});

/** What the validator needs to know about them (an IPC role, significant steps). */
export const IPC_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = IPC_BLOCK_VERSIONS.map(descriptor);
