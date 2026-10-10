/**
 * Runs (module C3; Phase 2 apps plan section 7; Phase 3 slice 2b): the MBR a run executes and its engine definition, the
 * facts the views need about the stored rows (who did what, when), and the run cache that the signable handler's
 * synchronous describe() reads.
 *
 * A sandbox test run executes an imported test package, defined for the SANDBOX installation with the package's own
 * justifications; a GMP batch executes the control recipe of the effective MBR version it was issued from (recipe-core
 * 0500), defined for the GMP installation with the justifications in force for that version's content (the designer's
 * rule: the latest per finding key recorded against exactly that revision and content hash). The installation of a
 * definition is always the batch's own (recipe-core assertDefinitionFits; DI-05, INV-18): G-09@1 and G-10@1 stay
 * SANDBOX_ONLY. Definitions are cached by their source (package hash or control recipe) and the block-registry
 * fingerprint (LRU). The run
 * cache holds the latest state seen per run; it is a convenience for describe() only. Every command and
 * signature re-reads the locked state in its own transaction, and a run the cache does not know makes
 * describe() leave the meaning to be checked there (fail closed, never guessed).
 */
import type pg from 'pg';
import { engine, execution, flow } from '@ebmr/recipe-core';
import type { PersonRef } from '@ebmr/api-contract';
import { refusal } from '../../platform/http/refusal.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../edition-blocks.ts';

export type Db = pg.Pool | pg.PoolClient;

/** The block versions of this server (one registry: its fingerprint is pinned by every run). */
export const REGISTRY = tabletsBlockRegistry();

export interface ProductRef {
  code: string;
  name: string;
  strength: string;
}

export interface PackageRecord {
  packageHash: string;
  fileName: string;
  contentHash: string;
  familyCode: string;
  product: ProductRef;
  versionNumber: string;
  revision: number;
  versionState: string;
  exporter: { personId: string; legalName: string; loginName: string };
  exportedAtUs: bigint;
  sourceInstallation: 'GMP' | 'SANDBOX';
  importedAtUs: bigint;
  content: unknown;
  justifications: { key: string; text: string; by: string }[];
}

/** The MBR version a run executes, as its views name it. */
export interface RunMbr {
  versionNumber: string;
  revision: number;
}

export interface RunContext {
  batch: execution.BatchExecutionRecord;
  /** The imported test package of a sandbox test run; null for a GMP batch. */
  pkg: PackageRecord | null;
  mbr: RunMbr;
  def: engine.BatchDefinition;
}

// ---------------------------------------------------------------------------------------------
// LRU

export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Packages and definitions

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' ? String(v) : '');

function productOf(v: unknown): ProductRef {
  const p = (v ?? {}) as Record<string, unknown>;
  return { code: str(p['code']), name: str(p['name']), strength: str(p['strength']) };
}

export function packageRecord(r: Record<string, unknown>): PackageRecord {
  const pkg = (r['package'] ?? {}) as Record<string, unknown>;
  const exporter = (r['exporter'] ?? {}) as Record<string, unknown>;
  const source = (r['source'] ?? {}) as Record<string, unknown>;
  const justifications = Array.isArray(pkg['justifications']) ? (pkg['justifications'] as Record<string, unknown>[]) : [];
  return {
    packageHash: str(r['package_hash']),
    fileName: str(r['file_name']),
    contentHash: str(r['content_hash']),
    familyCode: str(r['family_code']),
    product: productOf(r['product']),
    versionNumber: str(r['version_number']),
    revision: Number(r['revision'] ?? 0),
    versionState: str(r['version_state']),
    exporter: { personId: str(exporter['personId']), legalName: str(exporter['legalName']), loginName: str(exporter['loginName']) },
    exportedAtUs: BigInt(str(r['exported_at_us']) || '0'),
    sourceInstallation: source['installationKind'] === 'SANDBOX' ? 'SANDBOX' : 'GMP',
    importedAtUs: BigInt(str(r['imported_at_us']) || '0'),
    content: r['content'],
    justifications: justifications.map((j) => ({ key: str(j['key']), text: str(j['text']), by: str(j['by']) })),
  };
}

const PACKAGE_COLUMNS = `package_hash, file_name, package, content, content_hash, family_code, product, version_number, revision, version_state,
  exporter, exported_at_us::text as exported_at_us, source, platform.epoch_micros(imported_at)::text as imported_at_us`;

export async function loadPackage(db: Db, packageHash: string): Promise<PackageRecord | undefined> {
  const { rows } = await db.query<Record<string, unknown>>(`select ${PACKAGE_COLUMNS} from recipe.test_package where package_hash = $1`, [packageHash]);
  return rows[0] ? packageRecord(rows[0]) : undefined;
}

export async function importedPackages(db: Db): Promise<PackageRecord[]> {
  const { rows } = await db.query<Record<string, unknown>>(`select ${PACKAGE_COLUMNS} from recipe.test_package order by imported_at desc`);
  return rows.map(packageRecord);
}

const definitions = new Lru<string, engine.BatchDefinition>(32);

/**
 * The SANDBOX definition of MBR content with the package's justifications (cached by package hash and the
 * registry fingerprint). Throws engine.EngineDefinitionError when the content is not executable.
 */
export function defineForSandbox(packageHash: string, content: unknown, justifications: readonly { key: string; text: string; by: string }[]): engine.BatchDefinition {
  return defineCached(`pkg:${packageHash}`, content, 'SANDBOX', justifications);
}

function defineCached(source: string, content: unknown, installation: 'GMP' | 'SANDBOX', justifications: readonly { key: string; text: string; by: string }[]): engine.BatchDefinition {
  const key = `${installation}|${source}|${REGISTRY.fingerprint()}`;
  const hit = definitions.get(key);
  if (hit) return hit;
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new engine.EngineDefinitionError(parsed.problems.map((p) => ({ code: 'ENG-DEF-PARSE', severity: 'ERROR' as const, subject: p.path, message: `${p.path}: ${p.message}`, controls: ['DI-34'], key: `ENG-DEF-PARSE@${p.path}` })));
  const def = engine.defineBatch(parsed.mbr, { registry: REGISTRY, catalog: tabletsBlockCatalog, installation, justifications });
  definitions.set(key, def);
  return def;
}

export function notFound(what: string): Error {
  return refusal(404, {
    code: 'EXE_NOT_FOUND',
    kind: 'STALE',
    whatHappened: `The ${what} was not found.`,
    why: `There is no ${what} with this id on this installation.`,
    controls: ['DI-34'],
    whatYouCanDo: ['Reload the list and open it again.'],
  });
}

/** What a GMP batch executes: its control recipe's MBR content, version and the justifications in force for it. */
export interface ControlRecipeSource {
  controlRecipeId: string;
  versionId: string;
  versionNumber: string;
  revision: number;
  contentHash: string;
  content: unknown;
  justifications: { key: string; text: string; by: string }[];
}

/**
 * The control recipe of a GMP batch (planned or issued): the MBR content its snapshot holds (INV-02), the version and the
 * revision of that content, and the warning justifications in force for exactly that revision and content hash.
 */
export async function loadControlRecipe(db: Db, controlRecipeId: string): Promise<ControlRecipeSource | undefined> {
  const { rows } = await db.query<{ version_id: string; version_number: string; content_hash: string; content: unknown; revision: number | null }>(
    `select cr.version_id, (cr.snapshot -> 'mbr' ->> 'version_number') as version_number, cr.mbr_content_hash as content_hash,
            cr.snapshot -> 'mbr' -> 'content' as content,
            (select max(c.revision) from recipe.mbr_content c where c.version_id = cr.version_id and c.content_hash = cr.mbr_content_hash) as revision
       from recipe.control_recipe cr where cr.id = $1`,
    [controlRecipeId],
  );
  const r = rows[0];
  if (!r || r.revision === null) return undefined;
  const { rows: js } = await db.query<{ finding_key: string; text: string; person_id: string }>(
    `select distinct on (j.finding_key) j.finding_key, j.text, j.person_id
       from tab.designer_justification j
      where j.version_id = $1 and j.content_revision = $2 and j.content_hash = $3
      order by j.finding_key, j.recorded_at desc, j.id desc`,
    [r.version_id, r.revision, r.content_hash],
  );
  return {
    controlRecipeId,
    versionId: r.version_id,
    versionNumber: str(r.version_number),
    revision: r.revision,
    contentHash: r.content_hash,
    content: r.content,
    justifications: js.map((j) => ({ key: j.finding_key, text: j.text, by: j.person_id })),
  };
}

/**
 * The GMP definition of a control recipe's MBR content (cached by control recipe and registry fingerprint). Throws
 * engine.EngineDefinitionError when the content is not executable on GMP (a SANDBOX_ONLY block among them).
 */
export function defineForGmp(source: ControlRecipeSource): engine.BatchDefinition {
  return defineCached(`cr:${source.controlRecipeId}`, source.content, 'GMP', source.justifications);
}

/** The run's MBR, definition and batch record (404 when there is no such run). */
export async function runContext(db: Db, runId: string): Promise<RunContext> {
  const batch = await execution.loadBatch(db, runId);
  if (!batch) throw notFound('batch');
  if (batch.installation === 'GMP') {
    const cr = batch.controlRecipeId ? await loadControlRecipe(db, batch.controlRecipeId) : undefined;
    if (!cr) throw notFound('control recipe of this batch');
    return { batch, pkg: null, mbr: { versionNumber: cr.versionNumber, revision: cr.revision }, def: defineForGmp(cr) };
  }
  const pkg = await loadPackage(db, batch.packageHash);
  if (!pkg) throw notFound('test package of this run');
  const def = defineForSandbox(pkg.packageHash, pkg.content, pkg.justifications);
  return { batch, pkg, mbr: { versionNumber: pkg.versionNumber, revision: pkg.revision }, def };
}

// ---------------------------------------------------------------------------------------------
// Run cache (describe() is synchronous)

export interface CachedRun {
  def: engine.BatchDefinition;
  state: engine.BatchState;
}

const runCaches = new WeakMap<object, Lru<string, CachedRun>>();

/** The run cache of one server (keyed by its AppContext). */
export function runCache(owner: object): Lru<string, CachedRun> {
  let c = runCaches.get(owner);
  if (!c) {
    c = new Lru<string, CachedRun>(256);
    runCaches.set(owner, c);
  }
  return c;
}

/** Loads every run that is not finished into the cache (plugin start). */
export async function preloadRuns(owner: object, db: Db): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    "select b.id from recipe.batch_execution b join recipe.execution_state s on s.batch_id = b.id where s.status in ('ISSUED', 'IN_PROGRESS', 'ON_HOLD') order by b.issued_at desc limit 256",
  );
  let n = 0;
  for (const r of rows) {
    try {
      const ctx = await runContext(db, r.id);
      const st = await execution.loadState(db, r.id);
      if (st) {
        runCache(owner).set(r.id, { def: ctx.def, state: st.state });
        n += 1;
      }
    } catch {
      // A run whose package no longer defines on this server is left out; describe() then fails closed.
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Rows: who did what, when (for views and the timeline)

export interface RowFacts {
  seq: bigint;
  kind: 'ISSUE' | 'COMMAND' | 'PREPARE' | 'SWEEP';
  commandType: string;
  command: Record<string, unknown>;
  accepted: boolean;
  refusal: { code: string; message: string } | null;
  nowUs: bigint;
  actor: PersonRef;
  signatureIds: string[];
  firstEvent: number | null;
  lastEvent: number | null;
}

export class RunRows {
  constructor(readonly rows: readonly RowFacts[]) {}

  /** The row whose events include engine event `seq` (the command that produced it). */
  atEvent(seq: number): RowFacts | undefined {
    return this.rows.find((r) => r.firstEvent !== null && r.lastEvent !== null && seq >= r.firstEvent && seq <= r.lastEvent);
  }

  /** The person of the row that produced engine event `seq`, else the latest row of `personId`. */
  person(personId: string, seq?: number): PersonRef | null {
    if (seq !== undefined) {
      const r = this.atEvent(seq);
      if (r && r.actor.personId === personId) return r.actor;
    }
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const r = this.rows[i];
      if (r && r.actor.personId === personId) return r.actor;
    }
    return null;
  }

  get last(): RowFacts | undefined {
    return this.rows[this.rows.length - 1];
  }
}

export async function loadRowFacts(db: Db, runId: string): Promise<RunRows> {
  const { rows } = await db.query<{
    seq: string;
    kind: RowFacts['kind'];
    command_type: string;
    command: Record<string, unknown>;
    accepted: boolean;
    refusal: { code?: string; message?: string } | null;
    now_us: string;
    actor_person: string;
    actor_legal_name: string | null;
    actor_role: string;
    login_name: string | null;
    person_name: string | null;
    signature_ids: string[];
    first_event: number | null;
    last_event: number | null;
  }>(
    `select c.seq::text as seq, c.kind, c.command_type, c.command, c.accepted, c.refusal, c.now_us::text as now_us, c.actor_person,
            c.actor_legal_name, c.actor_role, a.login_name, p.legal_name as person_name, c.signature_ids::text[] as signature_ids,
            (select min((e.event ->> 'seq')::integer) from recipe.execution_event e where e.batch_id = c.batch_id and e.row_seq = c.seq) as first_event,
            (select max((e.event ->> 'seq')::integer) from recipe.execution_event e where e.batch_id = c.batch_id and e.row_seq = c.seq) as last_event
       from recipe.execution_command c
       left join iam.account a on a.id = c.actor_account
       left join iam.person p on p.id = c.actor_person
      where c.batch_id = $1
      order by c.seq`,
    [runId],
  );
  return new RunRows(
    rows.map((r) => ({
      seq: BigInt(r.seq),
      kind: r.kind,
      commandType: r.command_type,
      command: r.command,
      accepted: r.accepted,
      refusal: r.refusal ? { code: str(r.refusal.code), message: str(r.refusal.message) } : null,
      nowUs: BigInt(r.now_us),
      actor: { personId: r.actor_person, legalName: r.actor_legal_name ?? r.person_name ?? r.actor_person, loginName: r.login_name ?? r.actor_person, role: r.actor_role },
      signatureIds: r.signature_ids ?? [],
      firstEvent: r.first_event,
      lastEvent: r.last_event,
    })),
  );
}
