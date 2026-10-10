/**
 * The block registry of the Tablets edition (outline 6.6; ADR 0010): every generic block version (G-xx, including
 * G-06@1 and the database-backed G-09@2 and G-10@2 since Phase 3 slice 3a) extended with the edition's own TB-xx
 * versions. The TB blocks arrive with Phase 3 slices 3b to 3d and are added to TABLETS_BLOCK_VERSIONS; a block version
 * never changes once released. The designer's definition check and the execution runs use this one registry, so the
 * fingerprint every run pins is the edition's.
 */
import { blocks } from '@ebmr/recipe-core/pure';

/** The Tablets edition's own block versions (TB-01 to TB-24, from slice 3b on). */
export const TABLETS_BLOCK_VERSIONS: readonly blocks.BlockVersion[] = [];

/** The generic registry extended with the edition's versions. */
export function tabletsBlockRegistry(): blocks.BlockRegistry {
  return blocks.genericBlockRegistry().extend(...TABLETS_BLOCK_VERSIONS);
}
