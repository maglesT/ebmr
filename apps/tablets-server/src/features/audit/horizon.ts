/**
 * The settled horizon of the audit trail (review P11; DI-22): the highest audit entry id up to which every entry is
 * final, so paging across chains never steps past an entry that a transaction still in progress may yet commit.
 *
 * Why it is needed: kernel.audit_event.id is handed out when a row is inserted (an identity with a cache of 1, so ids
 * follow the order in which rows are inserted, across sessions), not when its transaction commits. Within one chain
 * the chain-head row lock (held to commit) makes commit order follow id order, so a chain's pages need no horizon.
 * Across chains, a later id can commit first: a page ending at that id would make the earlier entry unreachable.
 *
 * How it is found: one statement reads the highest visible id H and, in the same statement (so after its snapshot),
 * the transactions that hold a write lock on kernel.audit_event. PostgreSQL takes that lock before an INSERT draws
 * its id and keeps it until the transaction ends, so an entry with an id up to H that is not visible yet belongs to
 * one of those transactions: once all of them have ended, every entry up to H is final. Transactions that have not
 * written an audit entry (an idle psql session, a long read, a job on other tables) do not hold the horizon back. The
 * request waits a short while for the writers to end; if one keeps running, the horizon stays at the last one proven
 * (a page then ends early and says there is more). The kernel assumptions this relies on (an identity with cache 1,
 * no id drawn outside an INSERT, the write lock taken before the id is drawn and held to the end) are pinned by
 * test/audit/horizon-assumptions.test.ts here and by packages/kernel/test/audit/horizon-assumptions.test.ts.
 */
import { sql } from 'kysely';
import type { AuditDb } from './read-model.ts';

export interface HorizonOptions {
  /** How long one request waits for running audit writers to end. */
  waitMs: number;
  /** How often it looks. */
  pollMs: number;
}

export const DEFAULT_HORIZON_OPTIONS: HorizonOptions = { waitMs: 1_000, pollMs: 20 };

export interface Horizon {
  /** Every entry with an id up to this one is final (0: none proven yet). */
  upTo: bigint;
  /** False when entries beyond `upTo` may exist that are not yet final or not yet proven final. */
  complete: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The transactions (by virtual transaction id, which is unique per transaction, prepared ones included) other than this
 * session that hold a lock on kernel.audit_event in a mode that lets them write to it.
 */
const WRITERS = sql`select distinct l.virtualtransaction as vxid
      from pg_catalog.pg_locks l
     where l.locktype = 'relation' and l.granted
       and l.database = (select d.oid from pg_catalog.pg_database d where d.datname = current_database())
       and l.relation = 'kernel.audit_event'::regclass
       and l.mode in ('RowExclusiveLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and l.pid is distinct from pg_catalog.pg_backend_pid()`;

export class SettledHorizon {
  #settled = 0n;
  readonly #db: AuditDb;
  readonly #opts: HorizonOptions;

  constructor(db: AuditDb, opts: HorizonOptions = DEFAULT_HORIZON_OPTIONS) {
    this.#db = db;
    this.#opts = opts;
  }

  async current(): Promise<Horizon> {
    const { rows } = await sql<{ h: string | null; writers: string[] }>`
      select tab.audit_horizon_max()::text as h,
             array(${WRITERS}) as writers`.execute(this.#db);
    const sample = rows[0];
    if (!sample?.h) return { upTo: this.#settled, complete: true };
    const h = BigInt(sample.h);
    let waiting = sample.writers;
    for (let polls = Math.ceil(this.#opts.waitMs / this.#opts.pollMs); waiting.length > 0 && polls > 0; polls -= 1) {
      await sleep(this.#opts.pollMs);
      const still = await sql<{ vxid: string }>`select w.vxid from (${WRITERS}) w where w.vxid = any(${waiting}::text[])`.execute(this.#db);
      waiting = still.rows.map((r) => r.vxid);
    }
    if (waiting.length === 0 && h > this.#settled) this.#settled = h;
    return { upTo: this.#settled, complete: this.#settled >= h };
  }
}
