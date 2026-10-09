/**
 * The market authorisation of an MBR version and what batch issue needs from it, rule by rule (SQL mutation group
 * "market-authorisation-and-issue", tools/sql-mutation/src/targets.ts): the scope cells, the proposal, the activation and
 * the withdrawal of a market-authorisation record, retirement, and the guards on authorisation cells (recipe-core 0160,
 * 0290); the selection at issue, the pin, the control recipe, the stub batch, its status and in-flight dispositions (0170,
 * 0250); the approval guard mbr_version.in_flight_dispositioned (0130); the state of a version at an instant (0110); and
 * periodic review, the overdue list and the INV-17 query (0180). These tests close the gaps the SQL mutation run found in
 * the module tests of test/lifecycle: every refusal is asserted by its stable EBMR code and its whole message (the rule
 * that refused, not a later one with the same code), every boundary is proven from the side the rule lets through as well,
 * and nothing is written after a refusal.
 *
 * Controls: PR-04 (market validity of masters), PR-05 (supersession, retirement, periodic review, batches in flight),
 * PR-02 (effective date), PR-01 (approved batch sizes), DI-04 (a complete verification record before use), DI-37 (the two
 * signatures of the record); invariants INV-01 (one pin per batch: what the selection gives at the issue instant), INV-02
 * (the control recipe), INV-17 (CURRENT and BRIDGING only through a signed record; one open CURRENT; no overlap) and INV-28
 * (India in every market set).
 *
 * The table guards act on every writer, owner-level code included: owner-level writers are played by the superuser pool
 * inside a validated command, triggers on (asOwner). States the product never produces by itself (a cell of a record whose
 * signature is not valid, rewritten content, a rewritten control recipe) are arranged by the superuser with every trigger
 * off (asTimeTraveller), only to show that the invariant queries and the verify functions find them. A race holds the first
 * command open on its own connection, as test/lifecycle/concurrency.test.ts does.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCode } from '../../../kernel/src/commands/errors.ts';
import { toDbContext, withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { asTimeTraveller, pause } from '../../../kernel/test/identity/helpers.ts';
import { seedAdministration, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { cell, reason, scope, seedCast, uniqueContent, withSecondRole, World, type PrepareOptions } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

/** A test builds (or reuses) approved versions and signed records: well beyond Vitest's default 30 s. */
const LONG = 240_000;
const BS = 'PO-20K';
const S1 = scope('S1', 'L1', BS);
const NIL = '00000000-0000-0000-0000-000000000000';

const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const rows = await q<T>(sql, params);
  if (rows.length !== 1) throw new Error(`expected one row from ${sql}, got ${rows.length}`);
  return rows[0] as T;
}

/** Builds a value once, on first use, for the tests that share it. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The whole message, word for word. */
const exactly = (message: string): RegExp => new RegExp(`^${escape(message)}$`);

/** The SQLSTATE of a database error, also when it is wrapped as a KernelError. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  return typeof e.cause?.code === 'string' ? e.cause.code : undefined;
}

/** `p` is refused by the rule that raises `code`, with this message (a guard's refusal: SQLSTATE P0001). */
async function refused(p: Promise<unknown>, code: string, message: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected the refusal ${code}`).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(message);
  expect(errorCode(caught)).toBe(code);
  expect(sqlState(caught)).toBe('P0001');
}

/** An owner-level writer: the superuser pool inside a validated command of `actor` (with a reason), triggers on. */
async function asOwner<T>(actor: SeededActor, work: (c: pg.PoolClient) => Promise<T>, why = 'owner-level write under test'): Promise<T> {
  return withCommand(db.admin, await cmd(db, actor, reason(why)), work);
}

/** A command left open on its own application connection: the first side of a race. */
async function open(actor: SeededActor, extra: Partial<ActorContext>): Promise<pg.PoolClient> {
  const c = await db.app.connect();
  await c.query('begin');
  const { seed: _seed, ...ctx } = actor;
  void _seed;
  await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...ctx, correlationId: randomUUID(), ...extra }))]);
  return c;
}

/** Ends whatever a racing connection still has open and gives it back to the pool. */
async function close(...clients: pg.PoolClient[]): Promise<void> {
  for (const c of clients) {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };
async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The database clock `seconds` from now, as UTC text with microseconds. */
async function dbIn(seconds: number): Promise<string> {
  return (await one<{ t: string }>(`select to_char((clock_timestamp() + make_interval(secs => $1)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`, [seconds])).t;
}

/** Waits until the database clock has passed `instant`. */
async function until(instant: string): Promise<void> {
  for (;;) {
    if ((await one<{ past: boolean }>('select clock_timestamp() > $1::timestamptz as past', [instant])).past) return;
    await pause(200);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Records, cells and families
// ---------------------------------------------------------------------------------------------------------------------

const current = (versionId: string, market: string, cells: lc.ScopeCell[], extra: Partial<lc.MarketAuthorisationDefinition> = {}): lc.MarketAuthorisationDefinition => ({
  versionId,
  market,
  kind: 'CURRENT',
  cells,
  regulatoryBasis: `${market}: registration on file`,
  ...extra,
});

const bridging = (versionId: string, successorVersionId: string, cells: lc.ScopeCell[], effectiveTo: string, extra: Partial<lc.MarketAuthorisationDefinition> = {}): lc.MarketAuthorisationDefinition => ({
  versionId,
  market: 'IN',
  kind: 'BRIDGING',
  cells,
  successorVersionId,
  effectiveTo,
  regulatoryBasis: 'US supplement pending; the process stays within the Indian licence',
  ...extra,
});

/** recipe.propose_market_authorisation with the definition exactly as given (malformed ones included), by QA. */
async function propose(def: object, actor: SeededActor = w.cast.qa): Promise<string> {
  return w.run(actor, async (c) => (await c.query<{ r: string }>('select recipe.propose_market_authorisation($1::jsonb) as r', [JSON.stringify(def)])).rows[0]?.r ?? '');
}

interface Signatures {
  qaSig: string;
  regSig: string;
}

/** The QA and the regulatory-conformity signatures of a proposed record (two persons). */
async function signRecord(id: string): Promise<Signatures> {
  const qaSig = await w.sign(w.cast.qa, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
  const regSig = await w.sign(w.cast.regulatory, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'REGULATORY_CONFIRMED', 'PROPOSED');
  return { qaSig, regSig };
}

const activate = (id: string, s: Signatures): Promise<lc.ActivationResult> =>
  w.run(w.cast.qa, (c) => lc.activateMarketAuthorisation(c, id, s.qaSig, s.regSig), reason('market authorised for the test'));
const withdraw = (id: string, stated: string): Promise<{ cellsEnded: number }> =>
  w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, id, stated), reason(stated));
const recordState = async (id: string): Promise<string | null> =>
  (await db.app.query<{ s: string | null }>('select recipe.market_authorisation_state($1) as s', [id])).rows[0]?.s ?? null;
const recordsOf = async (versionId: string): Promise<number> =>
  Number((await one<{ n: string }>('select count(*)::text as n from recipe.market_authorisation where version_id = $1', [versionId])).n);

interface CellState {
  id: string;
  status: string;
  effective_from: string;
  valid_until: string | null;
}
const cellsOfRecord = (id: string): Promise<CellState[]> =>
  q<CellState>(
    `select id, status, recipe.utc_text(effective_from) as effective_from, recipe.utc_text(valid_until) as valid_until
       from recipe.authorisation_cell where authorisation_id = $1 order by site, line, batch_size`,
    [id],
  );

const select = (familyId: string, markets: string[], s: lc.IssueScope = S1, at?: string): Promise<lc.SelectionResult> =>
  lc.selectVersionForIssue(db.app, { familyId, markets, scope: s, ...(at ? { at } : {}) });

interface OneVersion {
  familyId: string;
  code: string;
  v1: string;
  contentHash: string;
}
interface TwoVersions extends OneVersion {
  v2: string;
}

async function oneVersion(opts: PrepareOptions = {}): Promise<OneVersion> {
  const content = uniqueContent();
  const v1 = await w.approvedVersion(content, opts);
  return { familyId: v1.familyId, code: content.header.family, v1: v1.versionId, contentHash: v1.contentHash };
}

async function twoVersions(v1Opts: PrepareOptions = {}, v2Opts: PrepareOptions = {}): Promise<TwoVersions> {
  const f = await oneVersion(v1Opts);
  const v2 = await w.approvedSuccessor(f.v1, (m) => (m.header.title = `${m.header.title} v2`), v2Opts);
  return { ...f, v2: v2.versionId };
}

/** A: v1 and v2 approved; the records, cells and BRIDGING validities of v1 under test. */
const familyA = once(() => twoVersions());
/** A draft v3 of A: a later version of the same family that is not approved. */
const draftA3 = once(async () => {
  const a = await familyA();
  return (await w.run(w.cast.author, (c) => lc.deriveVersion(c, a.v2, 'next revision'))).versionId;
});
/** B: another family whose v2 is approved (a later version number than A's v1). */
const familyB = once(() => twoVersions());
/** F: v1 effective from 2030-01-01, v2 from 2030-06-01: validity at exact instants. */
const familyF = once(() =>
  twoVersions({ effectiveFrom: '2030-01-01T00:00:00Z', reviewDue: '2031-01-01' }, { effectiveFrom: '2030-06-01T00:00:00Z', reviewDue: '2031-06-01' }),
);
/** O: v1 approved with its periodic review overdue since 2026-02-01, never authorised for a market. */
const familyO = once(() => oneVersion({ reviewDue: '2026-02-01' }));
/** P: v1 approved and CURRENT for IN and US at S1/L1: batches, pins and control recipes. */
const familyP = once(async () => {
  const p = await oneVersion();
  await w.authorise(current(p.v1, 'IN', [cell('S1', 'L1', BS)]));
  await w.authorise(current(p.v1, 'US', [cell('S1', 'L1', BS)]));
  return p;
});

// ---------------------------------------------------------------------------------------------------------------------
// The proposal (recipe.canonical_cells, recipe.propose_market_authorisation)
// ---------------------------------------------------------------------------------------------------------------------

describe('the scope cells of a proposal (recipe.canonical_cells through recipe.propose_market_authorisation)', () => {
  it('[PR-04][INV-17] a proposal names at least one scope cell: no cells, an empty list or anything but a list is refused, and nothing is recorded', async () => {
    const a = await familyA();
    const before = await recordsOf(a.v1);
    const base = { versionId: a.v1, market: 'IN', kind: 'CURRENT', regulatoryBasis: 'IN: registration on file' };
    const NONE = exactly('An authorisation names at least one scope cell {site, line, batch_size} (ADR 0014; EBMR-RCP-080)');
    await refused(propose(base), 'EBMR-RCP-080', NONE);
    for (const cells of [null, [], {}, 'S1/L1/PO-20K', 3, { site: 'S1', line: 'L1', batch_size: BS }]) {
      await refused(propose({ ...base, cells }), 'EBMR-RCP-080', NONE);
    }
    expect(await recordsOf(a.v1)).toBe(before);
  }, LONG);

  it('[PR-04][INV-17][PR-01] every scope cell is exactly {site, line, batch_size}, none blank, with a batch size of the family, and no cell twice; the record keeps them in canonical order', async () => {
    const a = await familyA();
    const before = await recordsOf(a.v1);
    const def = (cells: unknown[]) => ({ versionId: a.v1, market: 'IN', kind: 'CURRENT', cells, regulatoryBasis: 'IN: registration on file' });
    const good = cell('S1', 'L1', BS);
    const SHAPE = /^Scope cell .+ is not \{site, line, batch_size\} \(ADR 0014; EBMR-RCP-080\)$/;
    for (const bad of [
      { site: '', line: 'L1', batch_size: BS },
      { site: '   ', line: 'L1', batch_size: BS },
      { line: 'L1', batch_size: BS },
      { site: 'S1', line: '', batch_size: BS },
      { site: 'S1', line: '  ', batch_size: BS },
      { site: 'S1', line: 'L1', batch_size: '' },
      { site: 'S1', line: 'L1', batch_size: ' ' },
      { site: 'S1', line: 'L1' },
      { site: 'S1', line: 'L1', batch_size: BS, room: 'R-101' },
      'S1/L1/PO-20K',
      ['S1', 'L1', BS],
    ]) {
      await refused(propose(def([good, bad])), 'EBMR-RCP-080', SHAPE);
    }
    await refused(
      propose(def([good, cell('S1', 'L1', 'PO-99K')])),
      'EBMR-RCP-080',
      exactly(`Batch size PO-99K is not an approved batch size of family ${a.code} (PR-01; EBMR-RCP-080)`),
    );
    await refused(propose(def([good, cell('S2', 'L1', BS), { batch_size: BS, line: 'L1', site: 'S1' }])), 'EBMR-RCP-080', exactly('Scope cells must be distinct (EBMR-RCP-080)'));
    expect(await recordsOf(a.v1)).toBe(before);
    const id = await propose(def([cell('S2', 'L1', BS), cell('S1', 'L2', BS), good]));
    expect((await one<{ cells: unknown }>('select cells from recipe.market_authorisation where id = $1', [id])).cells).toEqual([good, cell('S1', 'L2', BS), cell('S2', 'L1', BS)]);
    expect(await recordsOf(a.v1)).toBe(before + 1);
  }, LONG);
});

describe('the proposal of a market authorisation (recipe.propose_market_authorisation)', () => {
  it('[PR-04] a proposal names a known version and a kind, CURRENT or BRIDGING; otherwise nothing is recorded', async () => {
    const a = await familyA();
    const before = await recordsOf(a.v1);
    const unknown = randomUUID();
    await refused(propose(current(unknown, 'IN', [cell('S1', 'L1', BS)])), 'EBMR-RCP-020', exactly(`Unknown MBR version ${unknown} (EBMR-RCP-020)`));
    const KIND = exactly('An authorisation is CURRENT or BRIDGING (ADR 0014; EBMR-RCP-082)');
    const { kind: _kind, ...noKind } = current(a.v1, 'IN', [cell('S1', 'L1', BS)]);
    void _kind;
    await refused(propose(noKind), 'EBMR-RCP-082', KIND);
    for (const kind of [null, '', 'OTHER', 'current']) await refused(propose({ ...noKind, kind }), 'EBMR-RCP-082', KIND);
    expect(await recordsOf(a.v1)).toBe(before);
  }, LONG);

  it('[PR-04][INV-17] a BRIDGING names, as its successor, an approved later version of the same family', async () => {
    const a = await familyA();
    const b = await familyB();
    const v3 = await draftA3();
    const before = await recordsOf(a.v1);
    const S = [cell('S1', 'L1', BS)];
    const end = '2033-06-30T00:00:00Z';
    const SUCCESSOR = exactly('A BRIDGING validity names the approved successor of the same family that superseded this version (ADR 0014; EBMR-RCP-082)');
    // Itself; an approved later version of another family; a later version of the family that is not approved; none known.
    for (const successor of [a.v1, b.v2, v3, randomUUID()]) {
      await refused(propose(bridging(a.v1, successor, S, end)), 'EBMR-RCP-082', SUCCESSOR);
    }
    const { successorVersionId: _successor, ...noSuccessor } = bridging(a.v1, a.v2, S, end);
    void _successor;
    await refused(propose(noSuccessor), 'EBMR-RCP-082', SUCCESSOR);
    // An earlier version is never the successor.
    await refused(propose(bridging(a.v2, a.v1, S, end)), 'EBMR-RCP-082', SUCCESSOR);
    expect(await recordsOf(a.v1)).toBe(before);
    const id = await propose(bridging(a.v1, a.v2, S, end));
    expect(await one('select kind, successor_version_id, recipe.utc_text(effective_to) as effective_to from recipe.market_authorisation where id = $1', [id])).toEqual({
      kind: 'BRIDGING',
      successor_version_id: a.v2,
      effective_to: '2033-06-30T00:00:00.000000Z',
    });
  }, LONG);

  it('[INV-17] a BRIDGING validity ends after it starts; a CURRENT authorisation has neither an end nor a successor', async () => {
    const a = await familyA();
    const S = [cell('S1', 'L1', BS)];
    const before = await recordsOf(a.v1);
    await refused(
      propose(bridging(a.v1, a.v2, S, '2031-01-01T00:00:00Z', { effectiveFrom: '2031-01-01T00:00:00Z' })),
      'EBMR-RCP-082',
      exactly('A BRIDGING validity is time-limited: its end must lie after its start (INV-17; EBMR-RCP-082)'),
    );
    const NO_END = exactly('A CURRENT authorisation has no end date and no successor (ADR 0014; EBMR-RCP-082)');
    await refused(propose(current(a.v1, 'IN', S, { effectiveTo: '2033-06-30T00:00:00Z' })), 'EBMR-RCP-082', NO_END);
    await refused(propose(current(a.v1, 'IN', S, { successorVersionId: a.v2 })), 'EBMR-RCP-082', NO_END);
    await refused(propose(current(a.v1, 'IN', S, { effectiveTo: '2033-06-30T00:00:00Z', successorVersionId: a.v2 })), 'EBMR-RCP-082', NO_END);
    expect(await recordsOf(a.v1)).toBe(before);
    // What the rules let through: an end one microsecond after the start; a CURRENT that states no end and no successor.
    const short = await propose(bridging(a.v1, a.v2, S, '2031-01-01T00:00:00.000001Z', { effectiveFrom: '2031-01-01T00:00:00Z' }));
    const plain = await propose({ ...current(a.v1, 'IN', S), effectiveTo: null, successorVersionId: null });
    expect(
      await q(
        `select kind, recipe.utc_text(effective_from) as effective_from, recipe.utc_text(effective_to) as effective_to, successor_version_id
           from recipe.market_authorisation where id in ($1, $2) order by kind`,
        [short, plain],
      ),
    ).toEqual([
      { kind: 'BRIDGING', effective_from: '2031-01-01T00:00:00.000000Z', effective_to: '2031-01-01T00:00:00.000001Z', successor_version_id: a.v2 },
      { kind: 'CURRENT', effective_from: null, effective_to: null, successor_version_id: null },
    ]);
  }, LONG);
});

// ---------------------------------------------------------------------------------------------------------------------
// Activation and withdrawal (recipe.activate_market_authorisation, recipe.withdraw_market_authorisation)
// ---------------------------------------------------------------------------------------------------------------------

describe('the activation and withdrawal of a market authorisation', () => {
  it('[INV-17] only a known record is activated or withdrawn', async () => {
    const unknown = randomUUID();
    await refused(activate(unknown, { qaSig: randomUUID(), regSig: randomUUID() }), 'EBMR-RCP-083', exactly(`Unknown market authorisation ${unknown} (EBMR-RCP-083)`));
    await refused(withdraw(unknown, 'no such record'), 'EBMR-RCP-083', exactly(`Unknown market authorisation ${unknown} (EBMR-RCP-083)`));
  }, LONG);

  it('[DI-04][INV-17] a version whose verification record is no longer complete does not become effective for a market, and nothing is activated', async () => {
    const o = await familyO();
    const id = await propose(current(o.v1, 'IN', [cell('S1', 'L1', BS)]));
    const s = await signRecord(id);
    // An owner-level writer voids the version's passing static validation after its approval.
    await asOwner(w.cast.qa, (c) =>
      c.query(
        `insert into recipe.mbr_evidence_void (evidence_id, version_id, content_id, person_id, account_id)
         select e.id, e.version_id, (select x.id from recipe.mbr_content x where x.version_id = e.version_id order by x.revision desc limit 1), $2, $2
           from recipe.mbr_evidence e
          where e.version_id = $1 and e.kind = 'VALIDATOR' and not exists (select 1 from recipe.mbr_evidence_void v where v.evidence_id = e.id)`,
        [o.v1, NIL],
      ),
    );
    expect((await lc.evidenceStatus(db.app, o.v1)).complete).toBe(false);
    await refused(
      activate(id, s),
      'EBMR-RCP-087',
      exactly('The version has no complete verification record for its content (a passing static validation (VALIDATOR)); it cannot become effective for a market (DI-04; EBMR-RCP-087)'),
    );
    expect(await recordState(id)).toBe('PROPOSED');
    expect(await cellsOfRecord(id)).toEqual([]);
  }, LONG);

  it('[INV-17][PR-02] a BRIDGING whose window has ended by the instant it would take effect is refused, and nothing is activated', async () => {
    const f = await familyF();
    // v1 takes effect from 2030-01-01: a bridging that ends then, or before, would never be valid.
    for (const end of ['2030-01-01T00:00:00Z', '2029-12-31T00:00:00Z']) {
      const id = await propose(bridging(f.v1, f.v2, [cell('S1', 'L1', BS)], end));
      await refused(activate(id, await signRecord(id)), 'EBMR-RCP-082', exactly('The bridging window has already ended (INV-17; EBMR-RCP-082)'));
      expect(await recordState(id)).toBe('PROPOSED');
      expect(await cellsOfRecord(id)).toEqual([]);
    }
  }, LONG);

  it('[INV-17][PR-02][PR-05] validity starts at the effective instant: a version serves from exactly then, an authorisation withdrawn before it starts never does, a record is withdrawn once', async () => {
    const f = await familyF();
    const first = await w.authorise(current(f.v1, 'IN', [cell('S1', 'L1', BS)]));
    expect(first.effectiveFrom).toBe('2030-01-01T00:00:00.000000Z');
    expect(await select(f.familyId, ['IN'], S1, '2030-01-01T00:00:00Z')).toMatchObject({ ok: true, rule: 'CURRENT_FOR_EVERY_MARKET', version_id: f.v1 });
    expect((await select(f.familyId, ['IN'], S1, '2029-12-31T23:59:59.999999Z')).ok).toBe(false);
    expect(await withdraw(first.authorisationId, 'registration suspended before launch')).toEqual({ cellsEnded: 1 });
    expect(await cellsOfRecord(first.authorisationId)).toEqual([
      expect.objectContaining({ status: 'WITHDRAWN', effective_from: '2030-01-01T00:00:00.000000Z', valid_until: '2030-01-01T00:00:00.000000Z' }),
    ]);
    expect((await select(f.familyId, ['IN'], S1, '2030-01-01T00:00:00Z')).ok).toBe(false);
    await refused(withdraw(first.authorisationId, 'registration suspended again'), 'EBMR-RCP-084', exactly('This authorisation is already withdrawn (EBMR-RCP-084)'));
    expect(Number((await one<{ n: string }>('select count(*)::text as n from recipe.market_authorisation_withdrawal where authorisation_id = $1', [first.authorisationId])).n)).toBe(1);
  }, LONG);

  it('[INV-17][PR-05] a version is CURRENT once per market and scope; its successor may take effect at the predecessor\'s start but never before it', async () => {
    const f = await familyF();
    const S = scope('S2', 'L2', BS);
    const cells = [cell('S2', 'L2', BS)];
    const v1 = await w.authorise(current(f.v1, 'IN', cells, { effectiveFrom: '2031-01-01T00:00:00Z' }));
    const again = await propose(current(f.v1, 'IN', cells));
    await refused(activate(again, await signRecord(again)), 'EBMR-RCP-088', /^Version 1 is already CURRENT for IN at \{[^}]*"site": "S2"[^}]*\} \(INV-17; EBMR-RCP-088\)$/);
    const early = await propose(current(f.v2, 'IN', cells, { effectiveFrom: '2030-06-01T00:00:00Z' }));
    await refused(
      activate(early, await signRecord(early)),
      'EBMR-RCP-089',
      /^Version 1 takes effect for IN at \{[^}]*\} only from 2031-01-01T00:00:00\.000000Z; its successor cannot take effect before it \(INV-17; EBMR-RCP-089\)$/,
    );
    expect([await recordState(again), await recordState(early)]).toEqual(['PROPOSED', 'PROPOSED']);
    expect(await cellsOfRecord(v1.authorisationId)).toEqual([expect.objectContaining({ status: 'CURRENT', valid_until: null })]);
    // At the same instant as its predecessor's start: the predecessor's validity becomes empty, the successor serves.
    const same = await w.authorise(current(f.v2, 'IN', cells, { effectiveFrom: '2031-01-01T00:00:00Z' }));
    expect(same.cells).toEqual([expect.objectContaining({ site: 'S2', line: 'L2', superseded_cell_id: v1.cells[0]?.cell_id })]);
    expect(await cellsOfRecord(v1.authorisationId)).toEqual([
      expect.objectContaining({ status: 'SUPERSEDED', effective_from: '2031-01-01T00:00:00.000000Z', valid_until: '2031-01-01T00:00:00.000000Z' }),
    ]);
    expect(await select(f.familyId, ['IN'], S, '2031-01-01T00:00:00Z')).toMatchObject({ ok: true, version_id: f.v2 });
  }, LONG);

  it('[INV-17][PR-04] a BRIDGING serves only a market set with a market where its successor is not CURRENT; one that has run out is withdrawn as it ran out', async () => {
    const a = await familyA();
    const S = [cell('S1', 'L1', BS)];
    const T = [cell('S2', 'L1', BS)];
    await w.authorise(current(a.v1, 'IN', [...S, ...T]));
    await w.authorise(current(a.v1, 'US', S));
    await w.authorise(current(a.v2, 'IN', [...S, ...T]));
    await w.authorise(bridging(a.v1, a.v2, S, '2033-06-30T00:00:00Z'));
    const valid = async (markets: string[], site: string) =>
      (
        await db.app.query<{ version_number: number; market: string; validity: string }>(
          'select version_number, market, validity from recipe.valid_cells($1, $2::text[], $3, $4, $5, clock_timestamp()) order by market, version_number, validity',
          [a.familyId, markets, site, 'L1', BS],
        )
      ).rows;
    // India alone: v2 is CURRENT there, so the bridging of v1 is not for this set.
    expect(await valid(['IN'], 'S1')).toEqual([{ version_number: 2, market: 'IN', validity: 'CURRENT' }]);
    expect(await valid(['IN', 'US'], 'S1')).toEqual([
      { version_number: 1, market: 'IN', validity: 'BRIDGING' },
      { version_number: 2, market: 'IN', validity: 'CURRENT' },
      { version_number: 1, market: 'US', validity: 'CURRENT' },
    ]);
    // A bridging that runs out ...
    const end = await dbIn(8);
    const short = await w.authorise(bridging(a.v1, a.v2, T, end));
    expect(await valid(['IN', 'US'], 'S2')).toEqual([
      { version_number: 1, market: 'IN', validity: 'BRIDGING' },
      { version_number: 2, market: 'IN', validity: 'CURRENT' },
    ]);
    await until(end);
    expect(await valid(['IN', 'US'], 'S2')).toEqual([{ version_number: 2, market: 'IN', validity: 'CURRENT' }]);
    // ... and is withdrawn afterwards keeps its end where it ran out.
    expect(await withdraw(short.authorisationId, 'US supplement approved; the bridging is no longer needed')).toEqual({ cellsEnded: 1 });
    expect(await cellsOfRecord(short.authorisationId)).toEqual([expect.objectContaining({ status: 'WITHDRAWN', valid_until: end })]);
  }, LONG);
});

// ---------------------------------------------------------------------------------------------------------------------
// The guard on the record, whoever writes it (recipe-core 0371)
// ---------------------------------------------------------------------------------------------------------------------

describe('the market-authorisation record, whoever writes it (recipe.market_authorisation_guard)', () => {
  interface RecordRow {
    familyId: string;
    versionId: string;
    kind: 'CURRENT' | 'BRIDGING';
    successorVersionId?: string;
    effectiveTo?: string;
  }
  /** An owner-level writer records a market authorisation for IN at S1/L1 directly; the guard stamps the proposer. */
  const insertRecord = (r: RecordRow): Promise<{ id: string; proposer: string }> =>
    asOwner(w.cast.qa, async (c) => {
      const { rows } = await c.query<{ id: string; proposer: string }>(
        `insert into recipe.market_authorisation (family_id, version_id, market, kind, cells, effective_to, successor_version_id, regulatory_basis,
                                                  proposed_by_person, proposed_by_account)
         values ($1, $2, 'IN', $3, $4::jsonb, $5, $6, 'IN: registration on file', $7, $7) returning id, proposed_by_person::text as proposer`,
        [r.familyId, r.versionId, r.kind, JSON.stringify([cell('S1', 'L1', BS)]), r.effectiveTo ?? null, r.successorVersionId ?? null, NIL],
      );
      if (!rows[0]) throw new Error('no record inserted');
      return rows[0];
    });

  /**
   * The INV-17 constraints (one open CURRENT, no overlap) and the selection at issue hold per family and trust the family
   * a cell repeats from its record. A record filed under another family than its version's would put that version
   * CURRENT for the other family's batches, outside the constraints of its own family, with nothing reported.
   */
  it("[INV-17][PR-04] a record is filed under its version's own family, and a BRIDGING names a successor of that family: whoever writes it, any other record is refused and nothing is recorded", async () => {
    const a = await familyA();
    const b = await familyB();
    const E = '2033-06-30T00:00:00Z';
    const FAMILY = exactly("A market authorisation is recorded under its version's own family (INV-17; EBMR-RCP-094)");
    const SUCCESSOR = exactly("A BRIDGING validity names a successor of its version's own family (INV-17; EBMR-RCP-094)");
    const counts = async () => [await recordsOf(a.v1), await recordsOf(b.v1), await recordsOf(b.v2)];
    const before = await counts();
    // Another family's approved version filed under A, and A's under B.
    await refused(insertRecord({ familyId: a.familyId, versionId: b.v1, kind: 'CURRENT' }), 'EBMR-RCP-094', FAMILY);
    await refused(insertRecord({ familyId: b.familyId, versionId: a.v1, kind: 'CURRENT' }), 'EBMR-RCP-094', FAMILY);
    await refused(insertRecord({ familyId: b.familyId, versionId: a.v1, kind: 'BRIDGING', successorVersionId: b.v2, effectiveTo: E }), 'EBMR-RCP-094', FAMILY);
    // A's v1 bridged until another family's approved later version takes over.
    await refused(insertRecord({ familyId: a.familyId, versionId: a.v1, kind: 'BRIDGING', successorVersionId: b.v2, effectiveTo: E }), 'EBMR-RCP-094', SUCCESSOR);
    expect(await counts()).toEqual(before);
    // The same writer's records of A's own versions are recorded, the proposer stamped.
    const cur = await insertRecord({ familyId: a.familyId, versionId: a.v1, kind: 'CURRENT' });
    const bri = await insertRecord({ familyId: a.familyId, versionId: a.v1, kind: 'BRIDGING', successorVersionId: a.v2, effectiveTo: E });
    expect([cur.proposer, bri.proposer]).toEqual([w.cast.qa.personId, w.cast.qa.personId]);
    expect(await counts()).toEqual([(before[0] ?? 0) + 2, before[1], before[2]]);
  }, LONG);
});

// ---------------------------------------------------------------------------------------------------------------------
// The guards on authorisation cells, whoever writes them
// ---------------------------------------------------------------------------------------------------------------------

describe('authorisation cells, whoever writes them (recipe.authorisation_cell_insert_guard, recipe.authorisation_cell_update_guard)', () => {
  const T = '2032-01-01T00:00:00.000000Z';
  const E = '2033-06-30T00:00:00.000000Z';

  interface CellRow {
    authorisation_id: string;
    family_id: string;
    version_id: string;
    market: string;
    site: string;
    line: string;
    batch_size: string;
    kind: string;
    status: string;
    effective_from: string;
    valid_until: string | null;
    successor_version_id: string | null;
    superseded_by: string | null;
  }

  /** An owner-level writer inserts a cell; the guard sets its version number. */
  const insertCell = (row: CellRow): Promise<{ id: string; version_number: number }> =>
    asOwner(w.cast.qa, async (c) => {
      const { rows } = await c.query<{ id: string; version_number: number }>(
        `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status,
                                                effective_from, valid_until, successor_version_id, superseded_by)
         values ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id, version_number`,
        [row.authorisation_id, row.family_id, row.version_id, row.market, row.site, row.line, row.batch_size, row.kind, row.status, row.effective_from, row.valid_until, row.successor_version_id, row.superseded_by],
      );
      if (!rows[0]) throw new Error('no cell inserted');
      return rows[0];
    });

  /**
   * A record of A's v1 for IN at one scope cell, its activation from T with the signatures asked for, and the cell that
   * repeats it exactly. Since recipe-core 0383 (D10) no writer with the triggers on records an activation the command
   * would not (from T, or with a signature that is not valid), so the superuser arranges it with every trigger off, the
   * cell guards under test then judging the cell with every trigger on; for a BRIDGING, v2 has superseded v1 at that
   * scope first, through the command (where a BRIDGING is given at all).
   */
  async function forged(kind: 'CURRENT' | 'BRIDGING', site: string, line: string, signatures: 'valid' | 'qa-invalid' | 'regulatory-invalid' | 'none' = 'valid'): Promise<{ id: string; exact: CellRow }> {
    const a = await familyA();
    const cells = [cell(site, line, BS)];
    if (kind === 'BRIDGING') {
      await w.authorise(current(a.v1, 'IN', cells));
      await w.authorise(current(a.v2, 'IN', cells));
    }
    const id = await propose(kind === 'CURRENT' ? current(a.v1, 'IN', cells) : bridging(a.v1, a.v2, cells, E));
    if (signatures !== 'none') {
      const s = await signRecord(id);
      await asTimeTraveller(
        db,
        `insert into recipe.market_authorisation_activation (authorisation_id, qa_signature_id, regulatory_signature_id, effective_from, person_id, account_id)
         values ($1, $2, $3, $4, $5, $5)`,
        [id, signatures === 'qa-invalid' ? randomUUID() : s.qaSig, signatures === 'regulatory-invalid' ? randomUUID() : s.regSig, T, NIL],
      );
    }
    return {
      id,
      exact: {
        authorisation_id: id,
        family_id: a.familyId,
        version_id: a.v1,
        market: 'IN',
        site,
        line,
        batch_size: BS,
        kind,
        status: kind,
        effective_from: T,
        valid_until: kind === 'BRIDGING' ? E : null,
        successor_version_id: kind === 'BRIDGING' ? a.v2 : null,
        superseded_by: null,
      },
    };
  }

  it('[INV-17][DI-37] a cell exists only for an activated record whose QA and regulatory signatures are both valid; a cell slipped in past the guard is found by the INV-17 query', async () => {
    const SIGNED = exactly(
      'A version becomes CURRENT or BRIDGING for a market only through an activated authorisation record with valid QA and regulatory signatures (INV-17; EBMR-RCP-092)',
    );
    const records = [await forged('CURRENT', 'S6', 'L6', 'qa-invalid'), await forged('CURRENT', 'S5', 'L5', 'regulatory-invalid'), await forged('CURRENT', 'S9', 'L9', 'none')];
    for (const r of records) {
      await refused(insertCell(r.exact), 'EBMR-RCP-092', SIGNED);
      expect(await cellsOfRecord(r.id)).toEqual([]);
    }
    // Detected: the superuser inserts the same cells with every trigger off.
    const slipped: string[] = [];
    for (const { exact: x } of records) {
      const id = randomUUID();
      slipped.push(id);
      await asTimeTraveller(
        db,
        `insert into recipe.authorisation_cell (id, authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from)
         values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11)`,
        [id, x.authorisation_id, x.family_id, x.version_id, x.market, x.site, x.line, x.batch_size, x.kind, x.status, x.effective_from],
      );
    }
    const found = (await w.violations()).filter((v) => slipped.includes(v.subject));
    expect(found.map((v) => [v.subject, v.invariant, v.detail]).sort()).toEqual(slipped.map((id) => [id, 'INV-17', 'cell without an activated, validly signed authorisation record']).sort());
  }, LONG);

  it('[INV-17] a cell repeats its signed record exactly: family, version, market, kind, successor, scope cell, status, start and end, and it supersedes nothing', async () => {
    const a = await familyA();
    const b = await familyB();
    const EXACT = exactly('An authorisation cell repeats its signed record exactly (INV-17; EBMR-RCP-092)');
    const cur = await forged('CURRENT', 'S8', 'L8');
    const changes: Partial<CellRow>[] = [
      { family_id: b.familyId },
      { version_id: a.v2 },
      { market: 'US' },
      { kind: 'BRIDGING', status: 'BRIDGING' },
      { successor_version_id: a.v2 },
      { site: 'SX' },
      { line: 'LX' },
      { batch_size: 'PO-99K' },
      { status: 'WITHDRAWN' },
      { effective_from: '2032-06-01T00:00:00Z' },
      { valid_until: '2033-01-01T00:00:00Z' },
      { superseded_by: randomUUID() },
    ];
    for (const change of changes) await refused(insertCell({ ...cur.exact, ...change }), 'EBMR-RCP-092', EXACT);
    expect(await cellsOfRecord(cur.id)).toEqual([]);
    expect((await insertCell(cur.exact)).version_number).toBe(1);
    expect(await cellsOfRecord(cur.id)).toEqual([expect.objectContaining({ status: 'CURRENT', effective_from: T, valid_until: null })]);
    // A BRIDGING cell: the record's successor and exactly the record's end.
    const br = await forged('BRIDGING', 'S7', 'L7');
    const bridgingChanges: Partial<CellRow>[] = [
      { valid_until: '2033-01-01T00:00:00Z' },
      { valid_until: '2034-01-01T00:00:00Z' },
      { valid_until: null },
      { successor_version_id: b.v2 },
      { successor_version_id: null },
      { kind: 'CURRENT', status: 'CURRENT', valid_until: null, successor_version_id: null },
    ];
    for (const change of bridgingChanges) await refused(insertCell({ ...br.exact, ...change }), 'EBMR-RCP-092', EXACT);
    expect(await cellsOfRecord(br.id)).toEqual([]);
    expect((await insertCell(br.exact)).version_number).toBe(1);
    expect(await cellsOfRecord(br.id)).toEqual([expect.objectContaining({ status: 'BRIDGING', effective_from: T, valid_until: E })]);
  }, LONG);

  it('[INV-17] a cell changes only by ending: CURRENT as SUPERSEDED (by a cell, with an end) or WITHDRAWN (with an end), BRIDGING as WITHDRAWN no later than its end; nothing else of it changes and it is never deleted', async () => {
    const a = await familyA();
    const b = await familyB();
    const cur = await forged('CURRENT', 'S4', 'L4');
    const br = await forged('BRIDGING', 'S3', 'L3');
    const x = (await insertCell(cur.exact)).id;
    const y = (await insertCell(br.exact)).id;
    const update = (id: string, set: string, params: unknown[] = []) =>
      asOwner(w.cast.qa, (c) => c.query(`update recipe.authorisation_cell set ${set} where id = $1`, [id, ...params]), 'owner-level change of an authorisation cell');
    const FIELDS = exactly('Only the status and end of an authorisation cell can change (INV-17; EBMR-RCP-091)');
    const fieldChanges: [string, unknown[]][] = [
      ['id = $2', [randomUUID()]],
      ['authorisation_id = $2', [br.id]],
      ['family_id = $2', [b.familyId]],
      ['version_id = $2', [a.v2]],
      ['version_number = 2', []],
      ['market = $2', ['US']],
      ['site = $2', ['S0']],
      ['line = $2', ['L0']],
      ['batch_size = $2', ['PO-99K']],
      ['kind = $2', ['BRIDGING']],
      ['effective_from = $2', ['2032-02-01T00:00:00Z']],
      ['successor_version_id = $2', [a.v2]],
    ];
    for (const [set, params] of fieldChanges) await refused(update(x, set, params), 'EBMR-RCP-091', FIELDS);
    const MOVE = (from: string, to: string) =>
      exactly(`An authorisation cell cannot go from ${from} to ${to}: CURRENT ends as SUPERSEDED or WITHDRAWN, BRIDGING as WITHDRAWN (INV-17; EBMR-RCP-091)`);
    // CURRENT: unchanged, ended without an end, superseded without an end or without the superseding cell, withdrawn by a cell.
    await refused(update(x, "status = 'CURRENT'"), 'EBMR-RCP-091', MOVE('CURRENT', 'CURRENT'));
    await refused(update(x, "status = 'WITHDRAWN'"), 'EBMR-RCP-091', MOVE('CURRENT', 'WITHDRAWN'));
    await refused(update(x, "status = 'SUPERSEDED', superseded_by = $2", [y]), 'EBMR-RCP-091', MOVE('CURRENT', 'SUPERSEDED'));
    await refused(update(x, "status = 'SUPERSEDED', valid_until = $2", ['2033-01-01T00:00:00Z']), 'EBMR-RCP-091', MOVE('CURRENT', 'SUPERSEDED'));
    await refused(update(x, "status = 'WITHDRAWN', valid_until = $2, superseded_by = $3", ['2033-01-01T00:00:00Z', y]), 'EBMR-RCP-091', MOVE('CURRENT', 'WITHDRAWN'));
    await refused(update(x, "status = 'BRIDGING', valid_until = $2", ['2033-01-01T00:00:00Z']), 'EBMR-RCP-091', MOVE('CURRENT', 'BRIDGING'));
    // BRIDGING: unchanged, ended later than its end, superseded.
    await refused(update(y, "status = 'BRIDGING'"), 'EBMR-RCP-091', MOVE('BRIDGING', 'BRIDGING'));
    await refused(update(y, "status = 'WITHDRAWN', valid_until = $2", ['2034-01-01T00:00:00Z']), 'EBMR-RCP-091', MOVE('BRIDGING', 'WITHDRAWN'));
    await refused(update(y, "status = 'SUPERSEDED', valid_until = $2, superseded_by = $3", [E, x]), 'EBMR-RCP-091', MOVE('BRIDGING', 'SUPERSEDED'));
    const NEVER = exactly('Authorisation cells are never deleted (INV-17; EBMR-RCP-091)');
    for (const id of [x, y]) await refused(asOwner(w.cast.qa, (c) => c.query('delete from recipe.authorisation_cell where id = $1', [id])), 'EBMR-RCP-091', NEVER);
    expect(await cellsOfRecord(cur.id)).toEqual([expect.objectContaining({ id: x, status: 'CURRENT', effective_from: T, valid_until: null })]);
    expect(await cellsOfRecord(br.id)).toEqual([expect.objectContaining({ id: y, status: 'BRIDGING', effective_from: T, valid_until: E })]);
    // What the rule lets through: a BRIDGING withdrawn at exactly its end; a CURRENT withdrawn with an end.
    await update(y, "status = 'WITHDRAWN', valid_until = $2", [E]);
    await update(x, "status = 'WITHDRAWN', valid_until = $2", ['2032-06-01T00:00:00Z']);
    expect(await cellsOfRecord(br.id)).toEqual([expect.objectContaining({ id: y, status: 'WITHDRAWN', valid_until: E })]);
    expect(await cellsOfRecord(cur.id)).toEqual([expect.objectContaining({ id: x, status: 'WITHDRAWN', valid_until: '2032-06-01T00:00:00.000000Z' })]);
  }, LONG);
});

// ---------------------------------------------------------------------------------------------------------------------
// D10: the activation and its cells, whoever writes them (recipe-core 0383; decision D10.1)
// ---------------------------------------------------------------------------------------------------------------------

describe('D10: an activation and its cells are written only as the activation command writes them, whoever writes them (recipe.market_authorisation_activation_guard, recipe.authorisation_cell_activation_guard)', () => {
  const T = '2032-01-01T00:00:00.000000Z';
  const E = '2033-06-30T00:00:00.000000Z';
  const ACTIVATION_INSERT = `insert into recipe.market_authorisation_activation (authorisation_id, qa_signature_id, regulatory_signature_id, effective_from, person_id, account_id)
                             values ($1, $2, $3, coalesce($4::timestamptz, clock_timestamp()), $5, $5)`;
  /**
   * An owner-level writer (the superuser inside a validated command of `actor`, every trigger on) inserts the activation
   * of record `id`: from `from`, or (null) from the database clock as the row is written; with a reason, or (null) none.
   */
  async function insertActivation(id: string, sg: Signatures, from: string | null, actor: SeededActor = w.cast.qa, why: string | null = 'owner-level activation under test'): Promise<unknown> {
    return withCommand(db.admin, await cmd(db, actor, why === null ? {} : reason(why)), (c) => c.query(ACTIVATION_INSERT, [id, sg.qaSig, sg.regSig, from, NIL]));
  }
  const activationsOf = async (id: string): Promise<number> =>
    Number((await one<{ n: string }>('select count(*)::text as n from recipe.market_authorisation_activation where authorisation_id = $1', [id])).n);
  const activationFrom = async (id: string): Promise<string> =>
    (await one<{ t: string }>('select recipe.utc_text(effective_from) as t from recipe.market_authorisation_activation where authorisation_id = $1', [id])).t;

  /** A version of a new family taken to CHECKED, and a record of it for IN at S1/L1 an owner-level writer files, signed by QA and the regulatory signer. */
  async function checkedRecord(): Promise<{ versionId: string; familyId: string; record: string; sg: Signatures }> {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    await w.prepare(v.versionId, content);
    await w.startVerification(v.versionId);
    await w.submit(v.versionId);
    await w.check(v.versionId);
    await w.regulatoryConfirm(v.versionId);
    expect((await w.state(v.versionId)).state, 'SETUP: the version waits for its approval').toBe('CHECKED');
    const record = await asOwner(w.cast.qa, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into recipe.market_authorisation (family_id, version_id, market, kind, cells, regulatory_basis, proposed_by_person, proposed_by_account)
         values ($1, $2, 'IN', 'CURRENT', $3::jsonb, 'IN: registration on file', $4, $4) returning id`,
        [v.familyId, v.versionId, JSON.stringify([cell('S1', 'L1', BS)]), NIL],
      );
      return rows[0]?.id ?? '';
    });
    return { versionId: v.versionId, familyId: v.familyId, record, sg: await signRecord(record) };
  }

  it('[INV-17][PR-02][DI-04][DI-37][PR-04] an activation row is refused unless the command would have written it: a known PROPOSED record, an approver with the QA permission and a reason of their own, both signatures valid, the QA signer activating, two persons, an APPROVED version with a complete verification record, the effective date the command computes and a bridging window still open; such a row is accepted', async () => {
    const a = await familyA();
    const f = await familyF();
    // A record of A's v1 for IN at S2/L6 with both signatures: every condition of the command holds for it.
    const id = await propose(current(a.v1, 'IN', [cell('S2', 'L6', BS)]));
    const sg = await signRecord(id);
    const unknown = randomUUID();
    await refused(insertActivation(unknown, sg, null), 'EBMR-RCP-083', exactly(`Unknown market authorisation ${unknown} (EBMR-RCP-083)`));
    const { admin } = await seedAdministration(db);
    await refused(insertActivation(id, sg, null, admin), 'EBMR-IAM-042', /^EBMR-IAM-042 DI-18: administrator role \S+ never creates or changes GMP data$/);
    await refused(insertActivation(id, sg, null, w.cast.author), 'EBMR-IAM-040', /^EBMR-IAM-040 .* lacks permission MBR\.APPROVE /);
    await refused(
      insertActivation(id, sg, null, w.cast.qa, null),
      'EBMR-AUDIT-002',
      exactly('EBMR-AUDIT-002 the activation of a market authorisation needs the reason of the person who gives it: a reason code and a reason text, neither blank. The system writes no part of it (DI-22, DI-24)'),
    );
    await refused(insertActivation(id, { qaSig: randomUUID(), regSig: sg.regSig }, null), 'EBMR-ESIG-070', /^EBMR-ESIG-070 /);
    await refused(insertActivation(id, { qaSig: sg.qaSig, regSig: sg.qaSig }, null), 'EBMR-ESIG-070', /^EBMR-ESIG-070 /);
    await refused(insertActivation(id, sg, null, w.cast.qa2), 'EBMR-RCP-085', exactly('The QA person who signed the authorisation activates it (DI-37; EBMR-RCP-085)'));
    // The effective date: before the activation, later than now without being the record's or the version's date.
    await refused(insertActivation(id, sg, '2026-01-01T00:00:00Z'), 'EBMR-RCP-095', /^An activation takes effect at the latest of the requested date \(none\), the version's effective date \(\S+\) and the moment it is activated, not at 2026-01-01T00:00:00\.000000Z \(PR-02; INV-17; EBMR-RCP-095\)$/);
    await refused(insertActivation(id, sg, T), 'EBMR-RCP-095', /not at 2032-01-01T00:00:00\.000000Z \(PR-02; INV-17; EBMR-RCP-095\)$/);
    expect(await activationsOf(id)).toBe(0);
    // QA signs as the regulatory signer too (a second role of the same person).
    const same = await propose(current(a.v1, 'IN', [cell('S2', 'L5', BS)]), w.cast.qa2);
    const qa2AsRegulatory = await withSecondRole(db, w.cast.qa2, 'REGULATORY_SIGNER');
    const selfSigned = {
      qaSig: await w.sign(w.cast.qa2, lc.MARKET_AUTHORISATION_AGGREGATE, same, 'MBR_MARKET_AUTHORISED', 'PROPOSED'),
      regSig: await w.sign(qa2AsRegulatory, lc.MARKET_AUTHORISATION_AGGREGATE, same, 'REGULATORY_CONFIRMED', 'PROPOSED'),
    };
    await refused(insertActivation(same, selfSigned, null, w.cast.qa2), 'EBMR-RCP-085', exactly('QA and the regulatory-conformity signer are two different persons (ADR 0014; EBMR-RCP-085)'));
    // A version only CHECKED.
    const checked = await checkedRecord();
    await refused(insertActivation(checked.record, checked.sg, null), 'EBMR-RCP-086', exactly('Version 1 is CHECKED: only an APPROVED version becomes CURRENT or BRIDGING (ADR 0014; EBMR-RCP-086)'));
    // An approved version whose verification record an owner-level writer voided.
    const o = await oneVersion();
    const oid = await propose(current(o.v1, 'IN', [cell('S1', 'L1', BS)]));
    const osg = await signRecord(oid);
    await asOwner(w.cast.qa, (c) =>
      c.query(
        `insert into recipe.mbr_evidence_void (evidence_id, version_id, content_id, person_id, account_id)
         select e.id, e.version_id, (select x.id from recipe.mbr_content x where x.version_id = e.version_id order by x.revision desc limit 1), $2, $2
           from recipe.mbr_evidence e where e.version_id = $1 and e.kind = 'VALIDATOR'`,
        [o.v1, NIL],
      ),
    );
    await refused(
      insertActivation(oid, osg, null),
      'EBMR-RCP-087',
      exactly('The version has no complete verification record for its content (a passing static validation (VALIDATOR)); it cannot become effective for a market (DI-04; EBMR-RCP-087)'),
    );
    // F's v1 takes effect from 2030-01-01: not from now; a BRIDGING ending then is over before it starts.
    const fid = await propose(current(f.v1, 'IN', [cell('S5', 'L5', BS)]));
    const fsg = await signRecord(fid);
    await refused(insertActivation(fid, fsg, null), 'EBMR-RCP-095', /the version's effective date \(2030-01-01T00:00:00\.000000Z\) and the moment it is activated, not at \S+ \(PR-02; INV-17; EBMR-RCP-095\)$/);
    const fbr = await propose(bridging(f.v1, f.v2, [cell('S5', 'L6', BS)], '2030-01-01T00:00:00Z'));
    await refused(insertActivation(fbr, await signRecord(fbr), '2030-01-01T00:00:00Z'), 'EBMR-RCP-082', exactly('The bridging window has already ended (INV-17; EBMR-RCP-082)'));
    expect([await activationsOf(same), await activationsOf(checked.record), await activationsOf(oid), await activationsOf(fid), await activationsOf(fbr)]).toEqual([0, 0, 0, 0, 0]);
    // Rows the command would write: from the moment of the activation, and from exactly the version's date.
    await insertActivation(id, sg, null);
    await insertActivation(fid, fsg, '2030-01-01T00:00:00Z');
    expect([await recordState(id), await recordState(fid), await activationFrom(fid)]).toEqual(['ACTIVE', 'ACTIVE', '2030-01-01T00:00:00.000000Z']);
    expect((await one<{ p: string }>('select person_id::text as p from recipe.market_authorisation_activation where authorisation_id = $1', [id])).p).toBe(w.cast.qa.personId);
    // A record activated, or withdrawn, is no longer PROPOSED.
    await refused(insertActivation(id, sg, null), 'EBMR-RCP-083', exactly('This authorisation is ACTIVE; only a PROPOSED record is activated (EBMR-RCP-083)'));
    const gone = await propose(current(a.v1, 'IN', [cell('S2', 'L4', BS)]));
    const gsg = await signRecord(gone);
    await withdraw(gone, 'registration lapsed before activation');
    await refused(insertActivation(gone, gsg, null), 'EBMR-RCP-083', exactly('This authorisation is WITHDRAWN; only a PROPOSED record is activated (EBMR-RCP-083)'));
  }, LONG);

  it('[INV-17][PR-05][PR-04] a cell is refused for a version that is not APPROVED, for a withdrawn record, when it supersedes anything but its predecessor ending where it begins, when its predecessor names a cell written before it, and for a BRIDGING the successor did not supersede; the command\'s own supersession, written by an owner-level writer, is accepted', async () => {
    type Row = Omit<CellRowD10, 'id'> & { id?: string };
    const insert = (c: pg.PoolClient, r: Row) =>
      c.query(
        `insert into recipe.authorisation_cell (id, authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from, valid_until, successor_version_id)
         values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, 0, 'IN', $5, $6, $7, $8, $8, $9, $10, $11)`,
        [r.id ?? null, r.authorisation_id, r.family_id, r.version_id, r.site, r.line, BS, r.kind, r.effective_from, r.valid_until, r.successor_version_id],
      );
    // A cell of a CHECKED version, for a record whose activation the superuser slipped in with every trigger off.
    const checked = await checkedRecord();
    await asTimeTraveller(db, ACTIVATION_INSERT.replace('coalesce($4::timestamptz, clock_timestamp())', '$4::timestamptz'), [checked.record, checked.sg.qaSig, checked.sg.regSig, T, NIL]);
    const ofChecked: Row = { authorisation_id: checked.record, family_id: checked.familyId, version_id: checked.versionId, site: 'S1', line: 'L1', kind: 'CURRENT', effective_from: T, valid_until: null, successor_version_id: null };
    await refused(asOwner(w.cast.qa, (c) => insert(c, ofChecked)), 'EBMR-RCP-086', exactly('Version 1 is CHECKED: only an APPROVED version becomes CURRENT or BRIDGING (ADR 0014; EBMR-RCP-086)'));
    // G: v1 CURRENT for IN at S1/L1 and S2/L1 through the command; v2's record for S1/L1 activated by an owner-level writer
    // as the command would, its cell not written yet.
    const g = await twoVersions();
    const c1 = (await w.authorise(current(g.v1, 'IN', [cell('S1', 'L1', BS), cell('S2', 'L1', BS)]))).cells;
    const [atS1, atS2] = [c1.find((x) => x.site === 'S1')?.cell_id ?? '', c1.find((x) => x.site === 'S2')?.cell_id ?? ''];
    const r2 = await propose(current(g.v2, 'IN', [cell('S1', 'L1', BS)]));
    await insertActivation(r2, await signRecord(r2), null);
    const from2 = await activationFrom(r2);
    const v1From = (await one<{ t: string }>('select recipe.utc_text(effective_from) as t from recipe.authorisation_cell where id = $1', [atS1])).t;
    const successor: Row = { id: randomUUID(), authorisation_id: r2, family_id: g.familyId, version_id: g.v2, site: 'S1', line: 'L1', kind: 'CURRENT', effective_from: from2, valid_until: null, successor_version_id: null };
    const supersede = (cellId: string, until: string) => (c: pg.PoolClient) =>
      c.query("update recipe.authorisation_cell set status = 'SUPERSEDED', valid_until = $2, superseded_by = $3 where id = $1", [cellId, until, successor.id]);
    const SUPERSEDES = (cellId: string, n: number) =>
      exactly(`A cell supersedes only the CURRENT cell of an earlier version of the same family, market and scope, which ends where it begins: not cell ${cellId} of version ${n} (PR-05; INV-17; EBMR-RCP-089)`);
    // The predecessor ended elsewhere than where its successor begins; a cell of another scope superseded.
    await refused(asOwner(w.cast.qa, async (c) => (await supersede(atS1, v1From)(c), await insert(c, successor))), 'EBMR-RCP-089', SUPERSEDES(atS1, 1));
    await refused(asOwner(w.cast.qa, async (c) => (await supersede(atS2, from2)(c), await insert(c, successor))), 'EBMR-RCP-089', SUPERSEDES(atS2, 1));
    // The predecessor superseded by a cell written before it (S2/L1's), so that the successor's insert finds no predecessor.
    await refused(
      asOwner(w.cast.qa, async (c) => (
        await c.query("update recipe.authorisation_cell set status = 'SUPERSEDED', valid_until = $2, superseded_by = $3 where id = $1", [atS1, from2, atS2]),
        await insert(c, successor)
      )),
      'EBMR-RCP-089',
      exactly(`A cell is superseded only by its successor written after it in the same transaction, not by cell ${atS2}, which exists already (PR-05; INV-17; EBMR-RCP-089)`),
    );
    expect((await q<{ status: string }>('select status from recipe.authorisation_cell where id = any($1::uuid[]) order by site', [[atS1, atS2]])).map((x) => x.status)).toEqual(['CURRENT', 'CURRENT']);
    // Superseded exactly as the command does it: accepted.
    await asOwner(w.cast.qa, async (c) => (await supersede(atS1, from2)(c), await insert(c, successor)));
    expect(await cellsOfRecord(r2)).toEqual([expect.objectContaining({ id: successor.id, status: 'CURRENT', effective_from: from2 })]);
    // An older version does not supersede a newer one: v1's record for S1/L1 again, activated as the command would.
    const back = await propose(current(g.v1, 'IN', [cell('S1', 'L1', BS)]));
    await insertActivation(back, await signRecord(back), null);
    const fromBack = await activationFrom(back);
    const older: Row = { id: randomUUID(), authorisation_id: back, family_id: g.familyId, version_id: g.v1, site: 'S1', line: 'L1', kind: 'CURRENT', effective_from: fromBack, valid_until: null, successor_version_id: null };
    await refused(
      asOwner(w.cast.qa, async (c) => (
        await c.query("update recipe.authorisation_cell set status = 'SUPERSEDED', valid_until = $2, superseded_by = $3 where id = $1", [successor.id, fromBack, older.id]),
        await insert(c, older)
      )),
      'EBMR-RCP-089',
      SUPERSEDES(successor.id ?? '', 2),
    );
    // A BRIDGING where the successor superseded nothing (S2/L1 is still v1's CURRENT), and where it did (S1/L1).
    const nowhere = await propose(bridging(g.v1, g.v2, [cell('S2', 'L1', BS)], E));
    await insertActivation(nowhere, await signRecord(nowhere), null);
    const bridge = (record: string, site: string, from: string): Row => ({ authorisation_id: record, family_id: g.familyId, version_id: g.v1, site, line: 'L1', kind: 'BRIDGING', effective_from: from, valid_until: E, successor_version_id: g.v2 });
    await refused(
      asOwner(w.cast.qa, async (c) => insert(c, bridge(nowhere, 'S2', await activationFrom(nowhere)))),
      'EBMR-RCP-090',
      exactly('BRIDGING is given only where the named successor superseded this version: not the case for IN at {"line": "L1", "site": "S2", "batch_size": "PO-20K"} (ADR 0014; EBMR-RCP-090)'),
    );
    const there = await propose(bridging(g.v1, g.v2, [cell('S1', 'L1', BS)], E));
    await insertActivation(there, await signRecord(there), null);
    await asOwner(w.cast.qa, async (c) => insert(c, bridge(there, 'S1', await activationFrom(there))));
    expect(await cellsOfRecord(there)).toEqual([expect.objectContaining({ status: 'BRIDGING', valid_until: E })]);
    // A withdrawn record gives no cell, even one that would repeat it.
    const w3 = await w.authorise(current(g.v2, 'IN', [cell('S3', 'L1', BS)]));
    await withdraw(w3.authorisationId, 'registration withdrawn');
    const again: Row = { authorisation_id: w3.authorisationId, family_id: g.familyId, version_id: g.v2, site: 'S3', line: 'L1', kind: 'CURRENT', effective_from: w3.effectiveFrom, valid_until: null, successor_version_id: null };
    await refused(
      asOwner(w.cast.qa, (c) => insert(c, again)),
      'EBMR-RCP-092',
      exactly('A version becomes CURRENT or BRIDGING for a market only through an activated authorisation record with valid QA and regulatory signatures (INV-17; EBMR-RCP-092)'),
    );
    expect((await cellsOfRecord(w3.authorisationId)).map((x) => x.status)).toEqual(['WITHDRAWN']);
    const ofG = (await q<{ id: string }>('select id::text as id from recipe.authorisation_cell where family_id = $1', [g.familyId])).map((x) => x.id);
    expect((await w.violations()).filter((x) => x.invariant === 'INV-17' && ofG.includes(x.subject))).toEqual([]);
  }, LONG);

  it('[INV-17][PR-02] an activation takes effect no earlier than the instant its transaction began: a row from that very instant is accepted, one a microsecond before it is refused', async () => {
    const a = await familyA();
    const id = await propose(current(a.v1, 'IN', [cell('S2', 'L7', BS)]));
    const sg = await signRecord(id);
    // The owner-level writer names the start of its own transaction (now()), or a microsecond before it.
    const insertAt = async (from: string): Promise<{ at_start: boolean }[]> =>
      withCommand(db.admin, await cmd(db, w.cast.qa, reason('owner-level activation under test')), async (c) =>
        (
          await c.query<{ at_start: boolean }>(
            `insert into recipe.market_authorisation_activation (authorisation_id, qa_signature_id, regulatory_signature_id, effective_from, person_id, account_id)
             values ($1, $2, $3, ${from}, $4, $4) returning effective_from = now() as at_start`,
            [id, sg.qaSig, sg.regSig, NIL],
          )
        ).rows,
      );
    await refused(
      insertAt("now() - interval '1 microsecond'"),
      'EBMR-RCP-095',
      /^An activation takes effect at the latest of the requested date \(none\), the version's effective date \(\S+\) and the moment it is activated, not at \S+ \(PR-02; INV-17; EBMR-RCP-095\)$/,
    );
    expect(await activationsOf(id)).toBe(0);
    expect(await insertAt('now()')).toEqual([{ at_start: true }]);
    expect(await recordState(id)).toBe('ACTIVE');
  }, LONG);

  it('[INV-17][PR-05][PR-04] a cell supersedes only the CURRENT cell of an earlier version of its own family, market, site, line and batch size, and only as a CURRENT cell: a predecessor of another family, market, line or batch size, one of its own version, and a BRIDGING written as the successor are each refused; the predecessor the command supersedes is accepted', async () => {
    const PO40 = 'PO-40K';
    // K: v1, v2 and v3 approved, with two batch sizes; another family X, CURRENT for IN at S1/L1 with PO-20K too.
    const content = uniqueContent();
    content.header.batchSizes = [...content.header.batchSizes, { id: PO40, quantity: { value: '40000', unit: '{tbl}' } }];
    const k1 = await w.approvedVersion(content);
    const k2 = await w.approvedSuccessor(k1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
    const k3 = await w.approvedSuccessor(k2.versionId, (m) => (m.header.title = `${m.header.title} v3`));
    const x = await oneVersion();
    const cellOf = (r: lc.ActivationResult, site: string, line: string, bs = BS): string =>
      r.cells.find((c) => c.site === site && c.line === line && c.batch_size === bs)?.cell_id ?? '';
    // Through the command: K's v1 CURRENT for IN at S1/L1, S1/L2 and S1/L1 with PO-40K, and for US at S1/L1; X's v1 for IN at S1/L1.
    const k1In = await w.authorise(current(k1.versionId, 'IN', [cell('S1', 'L1', BS), cell('S1', 'L2', BS), cell('S1', 'L1', PO40)]));
    const k1Us = await w.authorise(current(k1.versionId, 'US', [cell('S1', 'L1', BS)]));
    const xIn = await w.authorise(current(x.v1, 'IN', [cell('S1', 'L1', BS)]));
    const predecessor = cellOf(k1In, 'S1', 'L1');

    interface Row {
      id: string;
      authorisation_id: string;
      version_id: string;
      site: string;
      kind: 'CURRENT' | 'BRIDGING';
      effective_from: string;
      valid_until: string | null;
      successor_version_id: string | null;
    }
    // An owner-level writer supersedes `pred` until `until` by the cell `row` (family K, market IN, line L1, PO-20K), then inserts that cell.
    const supersededBy = (pred: string, until: string, row: Row) =>
      asOwner(w.cast.qa, async (c) => {
        await c.query("update recipe.authorisation_cell set status = 'SUPERSEDED', valid_until = $2, superseded_by = $3 where id = $1", [pred, until, row.id]);
        await c.query(
          `insert into recipe.authorisation_cell (id, authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from, valid_until, successor_version_id)
           values ($1, $2, $3, $4, 0, 'IN', $5, 'L1', $6, $7, $7, $8, $9, $10)`,
          [row.id, row.authorisation_id, k1.familyId, row.version_id, row.site, BS, row.kind, row.effective_from, row.valid_until, row.successor_version_id],
        );
      });
    const SUPERSEDES = (cellId: string, n: number) =>
      exactly(`A cell supersedes only the CURRENT cell of an earlier version of the same family, market and scope, which ends where it begins: not cell ${cellId} of version ${n} (PR-05; INV-17; EBMR-RCP-089)`);
    const cellStatuses = async (ids: string[]): Promise<string[]> =>
      (await q<{ status: string }>('select status from recipe.authorisation_cell where id = any($1::uuid[])', [ids])).map((r) => r.status);

    // v2's record for IN at S1/L1 with PO-20K, activated by an owner-level writer as the command would; its cell not written yet.
    const r2 = await propose(current(k2.versionId, 'IN', [cell('S1', 'L1', BS)]));
    await insertActivation(r2, await signRecord(r2), null);
    const from2 = await activationFrom(r2);
    const successor: Row = { id: randomUUID(), authorisation_id: r2, version_id: k2.versionId, site: 'S1', kind: 'CURRENT', effective_from: from2, valid_until: null, successor_version_id: null };
    // A predecessor that differs from v2's cell in one thing only, each ending where v2's cell begins: another family,
    // another market, another line, another batch size.
    const others = [cellOf(xIn, 'S1', 'L1'), cellOf(k1Us, 'S1', 'L1'), cellOf(k1In, 'S1', 'L2'), cellOf(k1In, 'S1', 'L1', PO40)];
    for (const other of others) await refused(supersededBy(other, from2, successor), 'EBMR-RCP-089', SUPERSEDES(other, 1));
    // A cell of v1 itself (a second record of v1 for the same scope, activated as the command would) superseding v1's cell.
    const again = await propose(current(k1.versionId, 'IN', [cell('S1', 'L1', BS)]));
    await insertActivation(again, await signRecord(again), null);
    const fromAgain = await activationFrom(again);
    const sameVersion: Row = { id: randomUUID(), authorisation_id: again, version_id: k1.versionId, site: 'S1', kind: 'CURRENT', effective_from: fromAgain, valid_until: null, successor_version_id: null };
    await refused(supersededBy(predecessor, fromAgain, sameVersion), 'EBMR-RCP-089', SUPERSEDES(predecessor, 1));
    // A BRIDGING as the successor of a CURRENT cell. At S3/L1: v2 CURRENT, superseded by v3, v3 withdrawn, then v1 CURRENT
    // (all through the command); a BRIDGING of v2 with successor v3 (v3 did supersede v2 there), activated as the command
    // would, written as the successor of v1's cell.
    await w.authorise(current(k2.versionId, 'IN', [cell('S3', 'L1', BS)]));
    const k3At3 = await w.authorise(current(k3.versionId, 'IN', [cell('S3', 'L1', BS)]));
    await withdraw(k3At3.authorisationId, 'registration of the third version withdrawn at S3');
    const k1At3 = cellOf(await w.authorise(current(k1.versionId, 'IN', [cell('S3', 'L1', BS)])), 'S3', 'L1');
    const br = await propose(bridging(k2.versionId, k3.versionId, [cell('S3', 'L1', BS)], E));
    await insertActivation(br, await signRecord(br), null);
    const fromBr = await activationFrom(br);
    const asBridging: Row = { id: randomUUID(), authorisation_id: br, version_id: k2.versionId, site: 'S3', kind: 'BRIDGING', effective_from: fromBr, valid_until: E, successor_version_id: k3.versionId };
    await refused(supersededBy(k1At3, fromBr, asBridging), 'EBMR-RCP-089', SUPERSEDES(k1At3, 1));
    // Nothing was written: every predecessor is still CURRENT, and no record under test has a cell.
    expect(await cellStatuses([...others, predecessor, k1At3])).toEqual(Array(6).fill('CURRENT'));
    expect([await cellsOfRecord(r2), await cellsOfRecord(again), await cellsOfRecord(br)]).toEqual([[], [], []]);
    // The predecessor the command supersedes, superseded as the command does it: accepted.
    await supersededBy(predecessor, from2, successor);
    expect(await cellsOfRecord(r2)).toEqual([expect.objectContaining({ id: successor.id, status: 'CURRENT', effective_from: from2 })]);
    expect(await cellStatuses([predecessor])).toEqual(['SUPERSEDED']);
    const ofK = (await q<{ id: string }>('select id::text as id from recipe.authorisation_cell where family_id = $1', [k1.familyId])).map((r) => r.id);
    expect((await w.violations()).filter((v) => v.invariant === 'INV-17' && ofK.includes(v.subject))).toEqual([]);
  }, LONG);
});

interface CellRowD10 {
  id: string;
  authorisation_id: string;
  family_id: string;
  version_id: string;
  site: string;
  line: string;
  kind: 'CURRENT' | 'BRIDGING';
  effective_from: string;
  valid_until: string | null;
  successor_version_id: string | null;
}

describe('the INV-17 query (recipe.inv17_violations)', () => {
  it('[INV-17] open CURRENT cells of one family and market at other sites or batch sizes are neither "more than one open CURRENT" nor overlapping', async () => {
    const content = uniqueContent();
    content.header.batchSizes = [...content.header.batchSizes, { id: 'PO-40K', quantity: { value: '40000', unit: '{tbl}' } }];
    const v = await w.approvedVersion(content);
    const act = await w.authorise(current(v.versionId, 'IN', [cell('S1', 'L1', BS), cell('S2', 'L1', BS), cell('S1', 'L1', 'PO-40K')]));
    const ids = act.cells.map((c) => c.cell_id);
    expect(ids).toHaveLength(3);
    expect((await q<{ n: string }>("select count(*)::text as n from recipe.authorisation_cell where id = any ($1::uuid[]) and status = 'CURRENT'", [ids]))[0]?.n).toBe('3');
    expect((await w.violations()).filter((x) => ids.includes(x.subject))).toEqual([]);
  }, LONG);
});

// ---------------------------------------------------------------------------------------------------------------------
// Selection, issue, pin, control recipe (INV-01, INV-02)
// ---------------------------------------------------------------------------------------------------------------------

const PIN_INSERT = `insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions, person_id, account_id)
                    values ($1, $2, null, 0, repeat('0', 64), '{}', '{}', '{}', '{}', '${NIL}', '${NIL}')`;
const numberOf = async (batchId: string): Promise<string> => (await one<{ n: string }>('select batch_number as n from recipe.stub_batch where id = $1', [batchId])).n;
const statusOf = async (batchId: string): Promise<string> => (await one<{ s: string }>('select status as s from recipe.stub_batch where id = $1', [batchId])).s;
const pinsOf = async (batchId: string): Promise<number> => Number((await one<{ n: string }>('select count(*)::text as n from recipe.batch_mbr_pin where batch_id = $1', [batchId])).n);
const issueBatch = (batchId: string): Promise<lc.IssueResult> => w.run(w.cast.issuer, (c) => lc.issueStubBatch(c, batchId), reason('batch issued for the test'));
/** recipe.set_stub_batch_status with any status (ISSUED included), with the issuer's own reason. */
const setStatus = (batchId: string, status: string): Promise<unknown> =>
  w.run(w.cast.issuer, (c) => c.query('select recipe.set_stub_batch_status($1, $2)', [batchId, status]), reason(`batch status set to ${status} for the test`));

describe('the selection at issue (recipe.select_version_for_issue, recipe.valid_cells, recipe.version_state_at)', () => {
  it('[INV-01][INV-28] the selection refuses, in words, an unknown family, a market set that is not two-letter codes and a scope with a blank part', async () => {
    const p = await familyP();
    const unknown = randomUUID();
    expect(await select(unknown, ['IN'])).toMatchObject({ ok: false, explanation: `Unknown MBR family ${unknown} (INV-01)` });
    for (const markets of [[], ['in'], ['IN', 'USA'], ['IN', 'U5']]) {
      expect(await select(p.familyId, markets)).toMatchObject({ ok: false, explanation: 'A batch names its market set as two-letter market codes (INV-01)' });
    }
    for (const s of [scope('', 'L1', BS), scope('  ', 'L1', BS), scope('S1', '', BS), scope('S1', ' ', BS), scope('S1', 'L1', ''), scope('S1', 'L1', '  ')]) {
      expect(await select(p.familyId, ['IN'], s)).toMatchObject({ ok: false, explanation: 'A batch names its scope: site, line and batch size (INV-01)' });
    }
    expect(await select(p.familyId, ['IN', 'US'])).toMatchObject({ ok: true, rule: 'CURRENT_FOR_EVERY_MARKET', version_id: p.v1 });
  }, LONG);

  it('[INV-01][PR-05] the state of a version at an instant counts a transition made at exactly that instant', async () => {
    const p = await familyP();
    const fmt = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
    const h = await one<{ at: string; before: string }>(
      `select to_char(h.recorded_at at time zone 'UTC', ${fmt}) as at, to_char((h.recorded_at - interval '1 microsecond') at time zone 'UTC', ${fmt}) as before
         from platform.state_history h where h.aggregate_type = 'mbr_version' and h.aggregate_id = $1 and h.to_state = 'APPROVED'`,
      [p.v1],
    );
    const stateAt = async (at: string) => (await db.app.query<{ s: string | null }>('select recipe.version_state_at($1, $2::timestamptz) as s', [p.v1, at])).rows[0]?.s;
    expect(await stateAt(h.at)).toBe('APPROVED');
    expect(await stateAt(h.before)).toBe('CHECKED');
  }, LONG);
});

describe('batch issue and the stub batch (recipe.issue_stub_batch, recipe.set_stub_batch_status, recipe.stub_batch_guard, recipe.batch_mbr_pin_guard)', () => {
  it('[INV-01] only a known batch that is still PLANNED is issued; a second issue writes no second pin', async () => {
    const p = await familyP();
    const unknown = randomUUID();
    await refused(issueBatch(unknown), 'EBMR-RCP-120', exactly(`Unknown batch ${unknown} (EBMR-RCP-120)`));
    const issued = await w.issue(p.familyId, ['IN'], S1);
    await refused(issueBatch(issued.batchId), 'EBMR-RCP-102', exactly(`Batch ${issued.batchNumber} is ISSUED; only a PLANNED batch is issued (EBMR-RCP-102)`));
    const cancelled = await w.planBatch(p.familyId, ['IN'], S1);
    await setStatus(cancelled, 'CANCELLED');
    await refused(issueBatch(cancelled), 'EBMR-RCP-102', exactly(`Batch ${await numberOf(cancelled)} is CANCELLED; only a PLANNED batch is issued (EBMR-RCP-102)`));
    expect([await pinsOf(issued.batchId), await pinsOf(cancelled)]).toEqual([1, 0]);
  }, LONG);

  it('[INV-01] a batch goes PLANNED -> ISSUED -> IN_PROGRESS -> COMPLETED, or to CANCELLED before it runs, and is ISSUED only by the issue command; every other move is refused and changes nothing', async () => {
    const p = await familyP();
    const MOVE = (from: string, to: string) => exactly(`A batch cannot go from ${from} to ${to} (EBMR-RCP-121)`);
    const BY_ISSUE = exactly('A batch is issued through recipe.issue_stub_batch (INV-01; EBMR-RCP-122)');
    const planned = await w.planBatch(p.familyId, ['IN'], S1);
    await refused(setStatus(planned, 'IN_PROGRESS'), 'EBMR-RCP-121', MOVE('PLANNED', 'IN_PROGRESS'));
    await refused(setStatus(planned, 'COMPLETED'), 'EBMR-RCP-121', MOVE('PLANNED', 'COMPLETED'));
    await refused(setStatus(planned, 'ISSUED'), 'EBMR-RCP-122', BY_ISSUE);
    expect(await statusOf(planned)).toBe('PLANNED');
    const b = (await w.issue(p.familyId, ['IN'], S1)).batchId;
    await refused(setStatus(b, 'COMPLETED'), 'EBMR-RCP-121', MOVE('ISSUED', 'COMPLETED'));
    await refused(setStatus(b, 'PLANNED'), 'EBMR-RCP-121', MOVE('ISSUED', 'PLANNED'));
    await refused(setStatus(b, 'ISSUED'), 'EBMR-RCP-122', BY_ISSUE);
    expect(await statusOf(b)).toBe('ISSUED');
    await setStatus(b, 'IN_PROGRESS');
    await refused(setStatus(b, 'CANCELLED'), 'EBMR-RCP-121', MOVE('IN_PROGRESS', 'CANCELLED'));
    await refused(setStatus(b, 'PLANNED'), 'EBMR-RCP-121', MOVE('IN_PROGRESS', 'PLANNED'));
    expect(await statusOf(b)).toBe('IN_PROGRESS');
    await setStatus(b, 'COMPLETED');
    await refused(setStatus(b, 'IN_PROGRESS'), 'EBMR-RCP-121', MOVE('COMPLETED', 'IN_PROGRESS'));
    await setStatus(planned, 'CANCELLED');
    await refused(setStatus(planned, 'PLANNED'), 'EBMR-RCP-121', MOVE('CANCELLED', 'PLANNED'));
    expect([await statusOf(b), await statusOf(planned)]).toEqual(['COMPLETED', 'CANCELLED']);
    const unknown = randomUUID();
    await refused(setStatus(unknown, 'CANCELLED'), 'EBMR-RCP-120', exactly(`Unknown batch ${unknown} (EBMR-RCP-120)`));
  }, LONG);

  it('[INV-01][INV-02] whoever writes it, a batch is never deleted, nothing but its status changes, and it is ISSUED only with its pin and its control recipe', async () => {
    const p = await familyP();
    const b = await w.planBatch(p.familyId, ['IN'], S1);
    await refused(asOwner(w.cast.issuer, (c) => c.query('delete from recipe.stub_batch where id = $1', [b])), 'EBMR-RCP-120', exactly('Batches are never deleted (EBMR-RCP-120)'));
    const ONLY_STATUS = exactly('Only the status of a batch changes (EBMR-RCP-120)');
    for (const set of ["batch_number = batch_number || 'X'", "line = 'L9'", "markets = '{IN,US}'", "status = 'CANCELLED', site = 'S9'"]) {
      await refused(asOwner(w.cast.issuer, (c) => c.query(`update recipe.stub_batch set ${set} where id = $1`, [b])), 'EBMR-RCP-120', ONLY_STATUS);
    }
    // A pin but no control recipe.
    await refused(
      asOwner(w.cast.issuer, async (c) => {
        await c.query(PIN_INSERT, [b, p.familyId]);
        await c.query("update recipe.stub_batch set status = 'ISSUED' where id = $1", [b]);
      }),
      'EBMR-RCP-122',
      exactly('A batch is ISSUED only with its pinned MBR version and control-recipe snapshot (INV-01; INV-02; EBMR-RCP-122)'),
    );
    expect([await statusOf(b), await pinsOf(b)]).toEqual(['PLANNED', 0]);
  }, LONG);

  it('[INV-01][PR-04] whoever writes it, a pin is written only for a known batch that is still PLANNED, and only when the selection at that instant gives a version', async () => {
    const p = await familyP();
    const pin = (batchId: string) => asOwner(w.cast.issuer, (c) => c.query(PIN_INSERT, [batchId, p.familyId]));
    const unknown = randomUUID();
    await refused(pin(unknown), 'EBMR-RCP-120', exactly(`Unknown batch ${unknown} (EBMR-RCP-120)`));
    const cancelled = await w.planBatch(p.familyId, ['IN'], S1);
    await setStatus(cancelled, 'CANCELLED');
    await refused(pin(cancelled), 'EBMR-RCP-102', exactly(`Batch ${await numberOf(cancelled)} is CANCELLED; a batch is pinned once, at issue (INV-01; EBMR-RCP-102)`));
    const notLinked = await w.planBatch(p.familyId, ['IN', 'EU'], S1);
    await refused(
      pin(notLinked),
      'EBMR-RCP-100',
      exactly(
        `Batch ${await numberOf(notLinked)} cannot be issued. No single version of MBR family ${p.code} is CURRENT or BRIDGING for every market in {EU, IN} at site S1, line L1, ` +
          `batch size ${BS}: EU: the master is not linked to this market (no approved version lists it); IN: version 1 CURRENT (INV-01; PR-04) (EBMR-RCP-100)`,
      ),
    );
    expect([await pinsOf(cancelled), await pinsOf(notLinked)]).toEqual([0, 0]);
  }, LONG);

  it('[INV-01] the issue decides on the selection at its own instant: refused then, it is refused at once and writes nothing, even when a version takes effect while the pin table is busy', async () => {
    const r = await oneVersion();
    const from = await dbIn(10);
    expect((await w.authorise(current(r.v1, 'IN', [cell('S1', 'L1', BS)], { effectiveFrom: from }))).effectiveFrom).toBe(from);
    const batch = await w.planBatch(r.familyId, ['IN'], S1);
    // Another session holds the pin table (every pin insert waits for it) until the authorisation is in effect.
    const holder = await db.admin.connect();
    let attempt: Promise<Settled<lc.IssueResult>> | undefined;
    try {
      await holder.query('begin');
      await holder.query('lock table recipe.batch_mbr_pin in share mode');
      expect((await one<{ before: boolean }>('select clock_timestamp() < $1::timestamptz as before', [from])).before).toBe(true);
      attempt = settle(issueBatch(batch));
      await until(from);
      await pause(200);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    const result = await attempt;
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error).toBe(
        `Batch ${await numberOf(batch)} cannot be issued. No single version of MBR family ${r.code} is CURRENT or BRIDGING for every market in {IN} at site S1, line L1, ` +
          `batch size ${BS}: IN: no version is CURRENT or BRIDGING for this market and scope (INV-01; PR-04) (EBMR-RCP-100)`,
      );
    }
    expect([await statusOf(batch), await pinsOf(batch)]).toEqual(['PLANNED', 0]);
    // Now that the authorisation is in effect, the batch is issued on v1.
    expect((await issueBatch(batch)).versionId).toBe(r.v1);
  }, LONG);
});

describe('the control recipe (recipe.build_control_recipe, recipe.control_recipe_guard, recipe.verify_control_recipe)', () => {
  const BELONGS = exactly("A control recipe belongs to its batch's pin (INV-02; EBMR-RCP-104)");
  const CR_INSERT = `insert into recipe.control_recipe (batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
                     values ($1, $2, $3, repeat('0', 64), '{}', repeat('0', 64), '${NIL}', '${NIL}')`;
  const build = async (pin: string): Promise<unknown> => (await db.app.query<{ r: unknown }>('select recipe.build_control_recipe($1) as r', [pin])).rows[0]?.r;
  const snapshotOf = async (batchId: string): Promise<Record<string, unknown>> =>
    (await one<{ snapshot: Record<string, unknown> }>('select snapshot from recipe.control_recipe where batch_id = $1', [batchId])).snapshot;

  it('[INV-02] the control recipe is built by the database for its own batch\'s pin: that batch, that family, the pinned content; whoever writes it, never for another pin', async () => {
    const p = await familyP();
    const other = await w.planBatch(p.familyId, ['IN'], S1);
    const r = await w.issue(p.familyId, ['IN', 'US'], S1);
    const stored = await snapshotOf(r.batchId);
    expect(stored).toMatchObject({
      format: 'ebmr.control-recipe',
      batch: { id: r.batchId, batch_number: r.batchNumber, markets: ['IN', 'US'], site: 'S1', line: 'L1', purpose: 'GMP', batch_size: { id: BS } },
      mbr: { family: p.code, version_id: p.v1, version_number: 1, content_hash: p.contentHash },
      pin: { pin_id: r.pinId, rule: 'CURRENT_FOR_EVERY_MARKET' },
    });
    expect(await build(r.pinId)).toEqual(stored);
    const unknown = randomUUID();
    await refused(build(unknown), 'EBMR-RCP-103', exactly(`Unknown pin ${unknown} (EBMR-RCP-103)`));
    const recipeFor = (batchId: string, pinId: string) => asOwner(w.cast.issuer, (c) => c.query(CR_INSERT, [batchId, pinId, p.v1]));
    await refused(recipeFor(other, randomUUID()), 'EBMR-RCP-104', BELONGS);
    await refused(recipeFor(other, r.pinId), 'EBMR-RCP-104', BELONGS);
    expect(Number((await one<{ n: string }>('select count(*)::text as n from recipe.control_recipe where batch_id = $1', [other])).n)).toBe(0);
  }, LONG);

  it('[INV-01][INV-02] no control recipe is built from pinned content that no longer has the pinned hash', async () => {
    const p = await familyP();
    const r = await w.issue(p.familyId, ['IN'], S1);
    const stored = await snapshotOf(r.batchId);
    const row = await one<{ id: string; content: string; content_hash: string }>(
      'select id, content::text as content, content_hash from recipe.mbr_content where version_id = $1 order by revision desc limit 1',
      [p.v1],
    );
    const CHANGED = exactly("The pinned version's content no longer has the pinned hash (INV-01; INV-02; EBMR-RCP-103)");
    // A break-glass rewrite of the stored content (superuser, every trigger off; never a product path), undone at the end.
    try {
      await asTimeTraveller(db, `update recipe.mbr_content set content = jsonb_set(content, '{header,title}', '"rewritten"') where id = $1`, [row.id]);
      await refused(build(r.pinId), 'EBMR-RCP-103', CHANGED);
      await asTimeTraveller(db, 'update recipe.mbr_content set content = $2::jsonb where id = $1', [row.id, row.content]);
      expect(await build(r.pinId)).toEqual(stored);
      await asTimeTraveller(db, "update recipe.mbr_content set content_hash = repeat('a', 64) where id = $1", [row.id]);
      await refused(build(r.pinId), 'EBMR-RCP-103', CHANGED);
    } finally {
      await asTimeTraveller(db, 'update recipe.mbr_content set content = $2::jsonb, content_hash = $3 where id = $1', [row.id, row.content, row.content_hash]);
    }
    expect(await build(r.pinId)).toEqual(stored);
  }, LONG);

  it('[INV-02] verification: a batch without a control recipe is not verified; a control recipe that does not carry the pinned content hash is found', async () => {
    const p = await familyP();
    const verify = async (batchId: string) => (await db.app.query<{ r: Record<string, unknown> }>('select recipe.verify_control_recipe($1) as r', [batchId])).rows[0]?.r;
    const planned = await w.planBatch(p.familyId, ['IN'], S1);
    expect(await verify(planned)).toEqual({ batch_id: planned, ok: false, problems: ['the batch has no control recipe'] });
    const r = await w.issue(p.familyId, ['IN'], S1);
    expect(await verify(r.batchId)).toMatchObject({ ok: true, problems: [] });
    // The superuser rewrites the stored content hash of the control recipe, every trigger off.
    await asTimeTraveller(db, "update recipe.control_recipe set mbr_content_hash = repeat('b', 64) where batch_id = $1", [r.batchId]);
    expect(await verify(r.batchId)).toMatchObject({
      ok: false,
      stored_hash: r.snapshotHash,
      computed_hash: r.snapshotHash,
      problems: ['the snapshot does not carry the pinned MBR content'],
    });
    expect((await w.violations()).filter((x) => x.subject === r.batchId)).toEqual([
      { invariant: 'INV-02', subject: r.batchId, detail: '["the snapshot does not carry the pinned MBR content"]' },
    ]);
  }, LONG);
});

// ---------------------------------------------------------------------------------------------------------------------
// Issue racing the commands that change what is valid for the family (the family lock)
// ---------------------------------------------------------------------------------------------------------------------

describe('an issue racing the market authorisation or the retirement of its family', () => {
  /** J: v1 CURRENT for IN at S1/L1; v2 approved. */
  const familyJ = once(async () => {
    const j = await twoVersions();
    await w.authorise(current(j.v1, 'IN', [cell('S1', 'L1', BS)]));
    return j;
  });
  const NOTHING_FOR_IN = /^Batch \S+ cannot be issued\. No single version of MBR family \S+ is CURRENT or BRIDGING for every market in \{IN\} at site S1, line L1, batch size PO-20K: IN: no version is CURRENT or BRIDGING for this market and scope \(INV-01; PR-04\) \(EBMR-RCP-100\)$/;

  it('[INV-01][INV-17] an issue racing the activation of a successor waits for it and pins the successor; one racing the withdrawal of that authorisation waits for it and is refused', async () => {
    const j = await familyJ();
    const id = await propose(current(j.v2, 'IN', [cell('S1', 'L1', BS)]));
    const s = await signRecord(id);
    const first = await w.planBatch(j.familyId, ['IN'], S1);
    let c1 = await open(w.cast.qa, reason('v2 authorised for IN'));
    let c2 = await open(w.cast.issuer, reason('batch issued while v2 is being authorised'));
    try {
      await lc.activateMarketAuthorisation(c1, id, s.qaSig, s.regSig);
      const second = settle(lc.issueStubBatch(c2, first));
      await pause(1000);
      await c1.query('commit');
      const r = await second;
      expect(r).toMatchObject({ ok: true, value: { versionId: j.v2, versionNumber: 2 } });
      await c2.query('commit');
    } finally {
      await close(c1, c2);
    }
    const next = await w.planBatch(j.familyId, ['IN'], S1);
    c1 = await open(w.cast.qa, reason('registration lapsed'));
    c2 = await open(w.cast.issuer, reason('batch issued while the authorisation is withdrawn'));
    try {
      await lc.withdrawMarketAuthorisation(c1, id, 'registration lapsed');
      const second = settle(lc.issueStubBatch(c2, next));
      await pause(1000);
      await c1.query('commit');
      const r = await second;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(NOTHING_FOR_IN);
    } finally {
      await close(c1, c2);
    }
    expect([await pinsOf(first), await pinsOf(next), await statusOf(next)]).toEqual([1, 0, 'PLANNED']);
    expect((await w.violations()).filter((x) => x.subject === first || x.subject === next)).toEqual([]);
  }, LONG);

  it('[INV-01][PR-05] an issue racing the retirement of its version waits for it and is refused', async () => {
    // A family with a single version: the retirement locks this family and no other.
    const l = await oneVersion();
    await w.authorise(current(l.v1, 'IN', [cell('S1', 'L1', BS)]));
    const batch = await w.planBatch(l.familyId, ['IN'], S1);
    const s = await w.state(l.v1);
    const c1 = await open(w.cast.qa, reason('product discontinued'));
    const c2 = await open(w.cast.issuer, reason('batch issued while the version is retired'));
    try {
      await lc.retireVersion(c1, l.v1, s.version);
      const second = settle(lc.issueStubBatch(c2, batch));
      await pause(1000);
      await c1.query('commit');
      const r = await second;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(NOTHING_FOR_IN);
    } finally {
      await close(c1, c2);
    }
    expect((await w.state(l.v1)).state).toBe('RETIRED');
    expect([await pinsOf(batch), await statusOf(batch)]).toEqual([0, 'PLANNED']);
  }, LONG);
});

// ---------------------------------------------------------------------------------------------------------------------
// In-flight dispositions (ADR 0014 item 7, L-24)
// ---------------------------------------------------------------------------------------------------------------------

describe("in-flight dispositions of an earlier version's batches (recipe.record_in_flight_disposition, recipe.in_flight_disposition_guard, mbr_version.in_flight_dispositioned)", () => {
  /** M: v1 CURRENT for IN with an ISSUED, an IN_PROGRESS and a PLANNED batch; v2 derived and CHECKED. */
  const familyM = once(async () => {
    const m = await oneVersion();
    await w.authorise(current(m.v1, 'IN', [cell('S1', 'L1', BS)]));
    const issued = await w.issue(m.familyId, ['IN'], S1);
    const running = await w.issue(m.familyId, ['IN'], S1);
    await w.run(w.cast.issuer, (c) => lc.setStubBatchStatus(c, running.batchId, 'IN_PROGRESS'), reason('line clearance done'));
    const planned = await w.planBatch(m.familyId, ['IN'], S1);
    const v2 = await w.run(w.cast.author, (c) => lc.deriveVersion(c, m.v1, 'improvement'));
    const content = (await lc.loadContent(db.app, v2.versionId)).content;
    content.header.title = `${content.header.title} v2`;
    await w.run(w.cast.author, (c) => lc.saveContent(c, v2.versionId, content));
    await w.prepare(v2.versionId, content);
    await w.startVerification(v2.versionId);
    await w.submit(v2.versionId);
    await w.check(v2.versionId);
    return { ...m, v2: v2.versionId, issued, running, planned };
  });
  const dispose = (successor: string, batchId: string, disposition: lc.InFlightDisposition = 'CONTINUE') =>
    w.run(w.cast.qa, (c) => lc.recordInFlightDisposition(c, successor, batchId, disposition, 'finish on the issued version'));
  const EARLIER = exactly('An in-flight disposition is recorded for a batch of an earlier version of the same family (ADR 0014; EBMR-RCP-070)');
  const dispositions = async (batchIds: string[]): Promise<number> =>
    Number((await one<{ n: string }>('select count(*)::text as n from recipe.in_flight_disposition where batch_id = any ($1::uuid[])', [batchIds])).n);

  it('[PR-05][INV-01] a disposition names a known successor and an issued or running batch pinned to an earlier version of the same family', async () => {
    const m = await familyM();
    const b = await familyB();
    const unknown = randomUUID();
    await refused(dispose(unknown, m.issued.batchId), 'EBMR-RCP-020', exactly(`Unknown MBR version ${unknown} (EBMR-RCP-020)`));
    // A batch never issued has no pin; the batch's own version is no successor; nor is a later version of another family.
    await refused(dispose(m.v2, m.planned), 'EBMR-RCP-070', EARLIER);
    await refused(dispose(m.v1, m.issued.batchId), 'EBMR-RCP-070', EARLIER);
    await refused(dispose(b.v2, m.issued.batchId), 'EBMR-RCP-070', EARLIER);
    // Whoever writes it: an owner-level writer naming a successor that does not exist.
    await refused(
      asOwner(w.cast.qa, (c) =>
        c.query(
          `insert into recipe.in_flight_disposition (successor_version_id, batch_id, pinned_version_id, batch_status, disposition, reason, person_id, account_id)
           values ($1, $2, $3, 'ISSUED', 'CONTINUE', 'finish on the issued version', $4, $4)`,
          [randomUUID(), m.issued.batchId, m.v1, NIL],
        ),
      ),
      'EBMR-RCP-070',
      EARLIER,
    );
    expect(await dispositions([m.issued.batchId, m.running.batchId, m.planned])).toBe(0);
  }, LONG);

  it('[PR-05][INV-01] the successor is approved only once every issued or running batch of an earlier version has a disposition of its own; a withdrawn successor takes none', async () => {
    const m = await familyM();
    await w.regulatoryConfirm(m.v2);
    const sig = await w.signVersion(w.cast.qa, m.v2, 'APPROVED', 'CHECKED');
    const approve = async () => {
      const s = await w.state(m.v2);
      return w.run(w.cast.qa, (c) => lc.approveVersion(c, m.v2, s.version, sig));
    };
    await dispose(m.v2, m.running.batchId, 'CONTINUE');
    await refused(
      approve(),
      'EBMR-PLAT-068',
      exactly(
        `EBMR-PLAT-068 APPROVE refused in state CHECKED: mbr_version.in_flight_dispositioned: batches ${m.issued.batchNumber} of an earlier version are issued or running ` +
          'without an in-flight disposition for this version (CONTINUE, HOLD_FOR_ASSESSMENT or CANCEL_UNSTARTED) (ADR 0014; PR-05)',
      ),
    );
    expect((await w.state(m.v2)).state).toBe('CHECKED');
    await dispose(m.v2, m.issued.batchId, 'HOLD_FOR_ASSESSMENT');
    await approve();
    expect((await w.state(m.v2)).state).toBe('APPROVED');
    const v3 = await w.run(w.cast.author, (c) => lc.deriveVersion(c, m.v2, 'next revision'));
    const s3 = await w.state(v3.versionId);
    await w.run(w.cast.author, (c) => lc.withdrawVersion(c, v3.versionId, s3.version), reason('revision abandoned'));
    await refused(dispose(v3.versionId, m.issued.batchId), 'EBMR-RCP-070', exactly('Version 3 is WITHDRAWN (EBMR-RCP-070)'));
    expect(await dispositions([m.issued.batchId, m.running.batchId])).toBe(2);
  }, LONG);

  /**
   * The guard counts the batches of EARLIER versions only, and the product never pins a batch to a version before its
   * approval. Owner-level code once could, every trigger on: it set the engine flag and wrote an APPROVED history row
   * for the CHECKED version, recorded a market authorisation, its activation and its cell directly, and the issue command
   * then pinned a batch to the version; that batch took no in-flight disposition (EBMR-RCP-070) and the approval did not
   * wait for one. This test is the kill test of recipe.guard_in_flight_dispositioned#3 (`<` made `<=`). Now each step is
   * refused: the forged history row since kernel 1110 (D11, EBMR-PLAT-077), and the activation and the cell since
   * recipe-core 0383 (D10, decision D10.1: they read the version's own state row), so the issue finds no version. The
   * guard's rule is then still proven on the state the superuser plants with every trigger off (the history row, the
   * activation and the cell), the issue command pinning the batch; the arranged history row is taken away again so the
   * engine can approve the version. No writer with the triggers on reaches that state, so the mutant is equivalent for
   * them (the kill-results page, D10); the test keeps the rule all the same.
   */
  it('[PR-05][INV-01][INV-17] no batch is pinned to the version under approval: with a forged APPROVED history row, the activation and the cell written around the command for it are refused and the issue finds no version; a batch of that version, on the state planted with every trigger off, is no batch of an earlier version: it takes no in-flight disposition and the approval does not wait for one', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    await w.prepare(v.versionId, content);
    await w.startVerification(v.versionId);
    await w.submit(v.versionId);
    await w.check(v.versionId);
    await w.regulatoryConfirm(v.versionId);
    const checked = await w.state(v.versionId);
    expect(checked.state).toBe('CHECKED');
    const FROM = '2026-01-02T00:00:00.000000Z';
    const APPROVED_AT_100 = `insert into platform.state_history (aggregate_type, aggregate_id, machine_code, machine_version, from_state, event, to_state, from_version,
                                                                  to_version, permission_code, signature_meaning, signature_id, person_id, account_id, role_code, correlation_id)
                             values ('mbr_version', $1, 'mbr_version', 1, 'CHECKED', 'APPROVE', 'APPROVED', 99, 100, 'mbr.approve', 'APPROVED', gen_random_uuid(),
                                     'p', 'a', 'r', gen_random_uuid())`;
    // Owner-level code with the engine flag forged can no longer write it (kernel 1110, D11).
    await refused(
      asOwner(w.cast.qa, async (c) => {
        await c.query("select set_config('platform.state_engine', 'on', true)");
        await c.query(APPROVED_AT_100, [v.versionId]);
      }),
      'EBMR-PLAT-077',
      exactly(
        `EBMR-PLAT-077 the history row of mbr_version:${v.versionId} CHECKED -APPROVE-> APPROVED at version 100 does not continue its latest history row (CHECKED at version ${checked.version})`,
      ),
    );
    await asTimeTraveller(db, APPROVED_AT_100, [v.versionId]);
    const record = await asOwner(w.cast.qa, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into recipe.market_authorisation (family_id, version_id, market, kind, cells, regulatory_basis, proposed_by_person, proposed_by_account)
         values ($1, $2, 'IN', 'CURRENT', $3::jsonb, 'IN: registration on file', $4, $4) returning id`,
        [v.familyId, v.versionId, JSON.stringify([cell('S1', 'L1', BS)]), NIL],
      );
      return rows[0]?.id ?? '';
    });
    const s = await signRecord(record);
    await refused(
      asOwner(w.cast.qa, (c) =>
        c.query(
          `insert into recipe.market_authorisation_activation (authorisation_id, qa_signature_id, regulatory_signature_id, effective_from, person_id, account_id)
           values ($1, $2, $3, $4, $5, $5)`,
          [record, s.qaSig, s.regSig, FROM, NIL],
        ),
      ),
      'EBMR-RCP-086',
      exactly('Version 1 is CHECKED: only an APPROVED version becomes CURRENT or BRIDGING (ADR 0014; EBMR-RCP-086)'),
    );
    await refused(
      asOwner(w.cast.qa, (c) =>
        c.query(
          `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from)
           values ($1, $2, $3, 0, 'IN', 'S1', 'L1', $4, 'CURRENT', 'CURRENT', $5)`,
          [record, v.familyId, v.versionId, BS, FROM],
        ),
      ),
      'EBMR-RCP-092',
      exactly('A version becomes CURRENT or BRIDGING for a market only through an activated authorisation record with valid QA and regulatory signatures (INV-17; EBMR-RCP-092)'),
    );
    expect(await cellsOfRecord(record)).toEqual([]);
    await refused(
      w.issue(v.familyId, ['IN'], S1),
      'EBMR-RCP-100',
      new RegExp(`^Batch B[0-9A-F]{8} cannot be issued\\. .*batch size ${BS}: IN: no version is CURRENT or BRIDGING for this market and scope \\(INV-01; PR-04\\) \\(EBMR-RCP-100\\)$`),
    );
    expect(Number((await one<{ n: string }>('select count(*)::text as n from recipe.batch_mbr_pin where version_id = $1', [v.versionId])).n)).toBe(0);
    // The guard's own rule, on the state no writer reaches since 0383: the superuser, every trigger off, plants the
    // activation and the cell, and the issue command (every trigger on) pins a batch to the CHECKED version.
    await asTimeTraveller(
      db,
      `insert into recipe.market_authorisation_activation (authorisation_id, qa_signature_id, regulatory_signature_id, effective_from, person_id, account_id)
       values ($1, $2, $3, $4, $5, $5)`,
      [record, s.qaSig, s.regSig, FROM, w.cast.qa.personId],
    );
    await asTimeTraveller(
      db,
      `insert into recipe.authorisation_cell (authorisation_id, family_id, version_id, version_number, market, site, line, batch_size, kind, status, effective_from)
       select $1, $2, v.id, v.version_number, 'IN', 'S1', 'L1', $4, 'CURRENT', 'CURRENT', $5 from recipe.mbr_version v where v.id = $3`,
      [record, v.familyId, v.versionId, BS, FROM],
    );
    const own = await w.issue(v.familyId, ['IN'], S1);
    expect(own.versionId).toBe(v.versionId);
    expect(await statusOf(own.batchId)).toBe('ISSUED');
    // The arranged row found by the kernel's state query, then taken away again.
    expect((await q<{ problem: string }>('select problem from platform.state_violations() where aggregate_id = $1 order by problem', [v.versionId])).map((x) => x.problem)).toEqual([
      'history version 100 has no predecessor',
      `state row (CHECKED, version ${checked.version}) differs from the latest history row (APPROVED, version 100)`,
    ]);
    await asTimeTraveller(db, "delete from platform.state_history where aggregate_type = 'mbr_version' and aggregate_id = $1 and to_version = 100", [v.versionId]);
    await refused(dispose(v.versionId, own.batchId), 'EBMR-RCP-070', EARLIER);
    const sig = await w.signVersion(w.cast.qa, v.versionId, 'APPROVED', 'CHECKED');
    await w.run(w.cast.qa, (c) => lc.approveVersion(c, v.versionId, checked.version, sig));
    expect(await w.state(v.versionId)).toEqual({ state: 'APPROVED', version: checked.version + 1 });
    expect(await dispositions([own.batchId])).toBe(0);
    expect(await q('select problem from platform.state_violations() where aggregate_id = $1', [v.versionId])).toEqual([]);
  }, LONG);
});

// ---------------------------------------------------------------------------------------------------------------------
// Periodic review and the overdue list (PR-05)
// ---------------------------------------------------------------------------------------------------------------------

describe('periodic review and the overdue list (recipe.record_periodic_review, recipe.overdue_reviews)', () => {
  it('[PR-05] a review names a known version and a next due date after today; the overdue list shows whether a version is in use and when it was last reviewed', async () => {
    const o = await familyO();
    const p = await familyP();
    const today = (await one<{ d: string }>("select to_char(recipe.site_today(), 'YYYY-MM-DD') as d")).d;
    expect((await lc.overdueReviews(db.app)).find((x) => x.versionId === o.v1)).toMatchObject({ reviewDue: '2026-02-01', inUse: false, lastReviewAt: null });
    expect((await lc.overdueReviews(db.app, '2028-01-01')).find((x) => x.versionId === p.v1)).toMatchObject({ reviewDue: '2027-12-31', inUse: true });
    const review = (versionId: string, nextDue: string) =>
      w.run(w.cast.qa, (c) => lc.recordPeriodicReview(c, versionId, 'NO_CHANGE', 'reviewed against the dossier; no change needed', nextDue));
    await refused(review(o.v1, today), 'EBMR-RCP-072', exactly('The next review due date lies in the future (PR-05; EBMR-RCP-072)'));
    const unknown = randomUUID();
    await refused(review(unknown, '2028-06-30'), 'EBMR-RCP-020', exactly(`Unknown MBR version ${unknown} (EBMR-RCP-020)`));
    expect(Number((await one<{ n: string }>('select count(*)::text as n from recipe.periodic_review where version_id = $1', [o.v1])).n)).toBe(0);
    await review(o.v1, '2028-06-30');
    // A later review of another version.
    await review(p.v1, '2028-03-31');
    const lastReview = async (versionId: string) =>
      (await one<{ at: string }>('select recipe.utc_text(max(recorded_at)) as at from recipe.periodic_review where version_id = $1', [versionId])).at;
    const list = await lc.overdueReviews(db.app, '2028-07-01');
    expect(list.find((x) => x.versionId === o.v1)).toMatchObject({ reviewDue: '2028-06-30', daysOverdue: 1, inUse: false, lastReviewAt: await lastReview(o.v1) });
    expect(list.find((x) => x.versionId === p.v1)).toMatchObject({ reviewDue: '2028-03-31', inUse: true, lastReviewAt: await lastReview(p.v1) });
  }, LONG);
});
