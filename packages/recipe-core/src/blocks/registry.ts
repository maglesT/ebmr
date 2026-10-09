/**
 * Block registry (outline 6.6; ADR 0010): block versions by `type@version`, with a completeness
 * report of the contract parts each version still lacks.
 *
 * The engine refuses to define a batch whose MBR uses a phase block version without an execution
 * handler, so an MBR can never run on a block that the registry cannot execute. Rendering parts are
 * reported now and become mandatory when the UI and renderer work lands (CI will then refuse an
 * incomplete version, outline 6.6).
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import type { BlockCatalog } from '../flow/blocks.ts';
import { CONTRACT_PARTS, RENDERING_PARTS, type BlockVersion, type ContractPart } from './contract.ts';
import { describeSchema } from './schema.ts';

export interface BlockVersionReport {
  key: string;
  type: string;
  version: string;
  title: string;
  level: BlockVersion['level'];
  /** 'SANDBOX_ONLY' versions are refused by defineBatch for a GMP installation (ENG-DEF-SANDBOX-ONLY). */
  availability: NonNullable<BlockVersion['availability']>;
  controls: string[];
  missing: ContractPart[];
  /** Missing parts other than the rendering parts (these block registration once CI enforces the contract). */
  missingExecutionParts: ContractPart[];
}

export class BlockRegistryError extends Error {}

export function blockKey(type: string, version: string): string {
  return `${type}@${version}`;
}

/** Contract parts a block version lacks. */
export function missingParts(b: BlockVersion): ContractPart[] {
  const has: Record<ContractPart, boolean> = {
    configSchema: b.configSchema !== undefined,
    dataSchema: b.dataSchema !== undefined,
    handler: b.level === 'PHASE' ? b.handler !== undefined : (b.engineImplementation?.length ?? 0) > 0,
    exceptionRules: b.exceptionRules !== undefined,
    simulatorModel: b.simulatorModel !== undefined,
    goldenFixture: b.goldenFixture !== undefined || (b.level !== 'PHASE' && (b.tests?.length ?? 0) > 0),
    tests: (b.tests?.length ?? 0) > 0,
    shopFloorUi: b.rendering?.shopFloorUi !== undefined,
    reviewRenderer: b.rendering?.reviewRenderer !== undefined,
    trueCopyRenderer: b.rendering?.trueCopyRenderer !== undefined,
    paperRendering: b.rendering?.paperRendering !== undefined,
    translations: (b.rendering?.translations?.length ?? 0) > 0,
  };
  return CONTRACT_PARTS.filter((p) => !has[p]);
}

export class BlockRegistry {
  private readonly versions = new Map<string, BlockVersion>();

  constructor(versions: readonly BlockVersion[] = []) {
    for (const v of versions) this.register(v);
  }

  /** Registers a version. A type@version registered twice, or a PHASE block without a handler, is a programming error. */
  register(v: BlockVersion): this {
    const key = blockKey(v.type, v.version);
    if (this.versions.has(key)) throw new BlockRegistryError(`block version ${key} is registered twice`);
    if (v.level === 'PHASE' && !v.handler) throw new BlockRegistryError(`block version ${key} is a phase block without an execution handler`);
    if (v.level === 'PHASE' && (!v.configSchema || !v.dataSchema || !v.exceptionRules || !v.simulatorModel)) {
      throw new BlockRegistryError(`block version ${key} lacks its configuration schema, data schema, exception rules or simulator model`);
    }
    this.versions.set(key, v);
    return this;
  }

  get(type: string, version: string): BlockVersion | undefined {
    return this.versions.get(blockKey(type, version));
  }

  all(): BlockVersion[] {
    return [...this.versions.values()].sort((a, b) => (blockKey(a.type, a.version) < blockKey(b.type, b.version) ? -1 : 1));
  }

  /** Completeness of every registered version (sorted by key). */
  report(): BlockVersionReport[] {
    return this.all().map((b) => {
      const missing = missingParts(b);
      return {
        key: blockKey(b.type, b.version),
        type: b.type,
        version: b.version,
        title: b.title,
        level: b.level,
        availability: b.availability ?? 'ALL',
        controls: [...b.controls],
        missing,
        missingExecutionParts: missing.filter((p) => !RENDERING_PARTS.includes(p)),
      };
    });
  }

  /** Block types and versions of a validator catalogue that have no registered version here. */
  unregistered(catalog: BlockCatalog): string[] {
    const out: string[] = [];
    for (const type of catalog.types()) {
      for (const version of catalog.describe(type)?.versions ?? []) if (!this.versions.has(blockKey(type, version))) out.push(blockKey(type, version));
    }
    return out.sort();
  }

  /**
   * Fingerprint of the registered block versions (ADR 0010: a batch runs, and is replayed, on the block
   * versions it was issued with): SHA-256 over each version's key, title, availability, controls,
   * configuration and data schemas (as text), exception types and signature meanings.
   */
  fingerprint(): string {
    return sha256Hex(
      canonicalJson(
        this.all().map((b) => ({
          key: blockKey(b.type, b.version),
          title: b.title,
          level: b.level,
          availability: b.availability ?? 'ALL',
          controls: [...b.controls],
          config: b.configSchema ? describeSchema(b.configSchema) : null,
          data: b.dataSchema ? Object.entries(b.dataSchema.entries).map(([kind, sc]) => ({ kind, schema: describeSchema(sc) })) : null,
          exceptions: (b.exceptionRules ?? []).map((r) => r.type).sort(),
          meanings: { perform: [...(b.handler?.meanings?.perform ?? [])], check: [...(b.handler?.meanings?.check ?? [])] },
        })),
      ),
    );
  }

  /** Keys (`type@version`) of the versions that may run only in the sandbox (sorted). */
  sandboxOnly(): string[] {
    return this.all()
      .filter((b) => b.availability === 'SANDBOX_ONLY')
      .map((b) => blockKey(b.type, b.version));
  }

  /** A new registry with more versions (e.g. an edition's TB-xx blocks, or test stand-ins). */
  extend(...versions: readonly BlockVersion[]): BlockRegistry {
    return new BlockRegistry([...this.all(), ...versions]);
  }
}
