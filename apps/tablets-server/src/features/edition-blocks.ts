/**
 * The block registry of the Tablets edition (outline 6.6; ADR 0010): every generic block version (G-xx, including
 * G-06@1 and the database-backed G-09@2 and G-10@2 since Phase 3 slice 3a) extended with the edition's own TB-xx
 * versions. The TB blocks arrive with Phase 3 slices 3b to 3d and are added to TABLETS_BLOCK_VERSIONS; a block version
 * never changes once released. The designer's definition check and the execution runs use this one registry, so the
 * fingerprint every run pins is the edition's.
 */
import { blocks, flow } from '@ebmr/recipe-core/pure';
import { DISPENSING_BLOCK_DESCRIPTORS, DISPENSING_BLOCK_VERSIONS } from '../blocks/dispensing/index.ts';
import { COMPRESSION_BLOCK_DESCRIPTORS, COMPRESSION_BLOCK_VERSIONS } from '../blocks/compression/index.ts';
import { GRANULATION_BLOCK_DESCRIPTORS, GRANULATION_BLOCK_VERSIONS } from '../blocks/granulation/index.ts';
import { IPC_BLOCK_DESCRIPTORS, IPC_BLOCK_VERSIONS } from '../blocks/ipc/index.ts';

/** The Tablets edition's own block versions (TB-01 to TB-24, from slice 3b on). */
export const TABLETS_BLOCK_VERSIONS: readonly blocks.BlockVersion[] = [
  ...DISPENSING_BLOCK_VERSIONS,
  ...GRANULATION_BLOCK_VERSIONS,
  ...COMPRESSION_BLOCK_VERSIONS,
  ...IPC_BLOCK_VERSIONS,
];

/** The validator's descriptors of the edition's own block types (roles, significance), one per TB type. */
export const TABLETS_BLOCK_DESCRIPTORS: readonly flow.BlockDescriptor[] = [
  ...DISPENSING_BLOCK_DESCRIPTORS,
  ...GRANULATION_BLOCK_DESCRIPTORS,
  ...COMPRESSION_BLOCK_DESCRIPTORS,
  ...IPC_BLOCK_DESCRIPTORS,
];

/** The generic registry extended with the edition's versions. */
export function tabletsBlockRegistry(): blocks.BlockRegistry {
  return blocks.genericBlockRegistry().extend(...TABLETS_BLOCK_VERSIONS);
}

/**
 * The validator's catalogue of the edition: the generic blocks and the edition's own types, so that a TB step is known
 * (its roles: dispensing, calculation; significant) to the analysis the engine defines a batch with and to the designer.
 */
export const tabletsBlockCatalog: flow.BlockCatalog = flow.createBlockCatalog(flow.GENERIC_BLOCKS, TABLETS_BLOCK_DESCRIPTORS);
