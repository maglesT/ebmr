/**
 * Block contract, registry and the generic engine-level block versions (outline 6.6; ADR 0010). See
 * README.md in this folder.
 */
export * from './contract.ts';
export { validateSchema, describeSchema, type BooleanSchema, type SchemaProblem } from './schema.ts';
export { BlockRegistry, BlockRegistryError, blockKey, missingParts, type BlockVersionReport } from './registry.ts';
export * from './generic/index.ts';
