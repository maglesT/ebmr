/**
 * Library blocks in batches and masters (decision 0026, slice S4).
 *
 * A master record carries the library definitions it uses (`MbrContent.blockDefinitions`): a snapshot of each
 * `code@version` it pinned, so a batch builds its block versions from its own master and never from the library's
 * current state. Approving or retiring a library block later therefore never changes an issued batch or the registry
 * fingerprint of a batch in flight (ADR 0010, EBMR-EXE-062); a master without library blocks keeps the registry it had.
 * The database checks that a GMP batch's snapshots are approved library versions with the same content hash (recipe-
 * core 1810) and re-checks entered values against the formulation's limits (O-9 b).
 */
import type { BlockVersion } from '../blocks/contract.ts';
import type { BlockRegistry } from '../blocks/registry.ts';
import { EngineDefinitionError, type DefineOptions } from '../engine/definition.ts';
import { genericBlockCatalog, type BlockCatalog, type BlockDescriptor } from '../flow/blocks.ts';
import { createExprService } from '../flow/expr-adapter.ts';
import type { ExpressionService } from '../flow/expression-port.ts';
import type { MbrContent } from '../flow/model.ts';
import { libraryBlockType, libraryBlockVersion } from './block-version.ts';
import { checkBlockDefinition } from './check-definition.ts';
import type { BlockDefinition, LibraryProblem } from './model.ts';

/** The library definitions a master carries (none for a master without library blocks). */
export function definitionsOf(mbr: Pick<MbrContent, 'blockDefinitions'>): BlockDefinition[] {
  return (mbr.blockDefinitions ?? []) as unknown as BlockDefinition[];
}

/** Problems with the snapshots: a definition that is not well made, or a code@version carried twice. */
export function snapshotProblems(mbr: Pick<MbrContent, 'blockDefinitions'>, expr: ExpressionService): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  const seen = new Set<string>();
  definitionsOf(mbr).forEach((def, i) => {
    const key = `${String(def.code)}@${String(def.version)}`;
    if (seen.has(key)) out.push({ code: 'LIB-SNAPSHOT-DUPLICATE', severity: 'ERROR', path: `blockDefinitions[${i}]`, message: `${key} is carried twice`, controls: ['PR-05'] });
    seen.add(key);
    for (const p of checkBlockDefinition(def, expr)) out.push({ ...p, path: `blockDefinitions[${i}].${p.path}` });
  });
  return out;
}

/** The validator's description of a library block: its roles, and significant when it needs a checker or verifier. */
export function descriptorOf(def: BlockDefinition, versions: readonly string[]): BlockDescriptor {
  const roles = def.roles ?? (def.category === 'TEST_IPC' || def.category === 'TEST_RELEASE' ? ['IPC' as const] : ['PARAMETER_RECORD' as const]);
  return {
    type: libraryBlockType(def.code),
    versions,
    edition: 'generic',
    title: def.title,
    roles,
    significant: def.signatures.some((s) => s.meaning === 'CHECKED' || s.meaning === 'VERIFIED'),
    phase: { allowed: true },
    requiresSystem: false,
  };
}

/** The base catalogue plus the library blocks the master carries. */
export function catalogWithLibrary(base: BlockCatalog, mbr: Pick<MbrContent, 'blockDefinitions'>): BlockCatalog {
  const defs = definitionsOf(mbr);
  if (defs.length === 0) return base;
  const byType = new Map<string, BlockDescriptor>();
  for (const def of defs) {
    const type = libraryBlockType(def.code);
    const versions = [...(byType.get(type)?.versions ?? []), String(def.version)];
    byType.set(type, descriptorOf(def, versions));
  }
  const types = [...new Set([...base.types(), ...byType.keys()])].sort();
  return { describe: (type) => base.describe(type) ?? byType.get(type), types: () => types };
}

/** The base registry plus the block versions of the master's library snapshots. */
export function registryWithLibrary(base: BlockRegistry, mbr: Pick<MbrContent, 'blockDefinitions'>, expr: ExpressionService): BlockRegistry {
  const defs = definitionsOf(mbr);
  if (defs.length === 0) return base;
  const versions: BlockVersion[] = defs.map((d) => libraryBlockVersion(d, expr));
  return base.extend(...versions);
}

/**
 * Definition options for a master that may carry library blocks: the registry and catalogue extended with them. Throws
 * the engine's definition error when a snapshot is not well made (ENG-DEF-LIBRARY-BLOCK), so no batch runs on one.
 */
export function defineOptionsFor(mbr: MbrContent, options: DefineOptions): DefineOptions {
  if (definitionsOf(mbr).length === 0) return options;
  const expr = options.expressions ?? createExprService();
  const errors = snapshotProblems(mbr, expr).filter((p) => p.severity === 'ERROR');
  if (errors.length > 0) {
    throw new EngineDefinitionError(
      errors.map((p) => ({ code: 'ENG-DEF-LIBRARY-BLOCK', severity: 'ERROR' as const, subject: p.path, message: `${p.path}: ${p.message}`, controls: p.controls, key: `ENG-DEF-LIBRARY-BLOCK@${p.path}` })),
    );
  }
  return { ...options, expressions: expr, registry: registryWithLibrary(options.registry, mbr, expr), catalog: catalogWithLibrary(options.catalog ?? genericBlockCatalog, mbr) };
}
