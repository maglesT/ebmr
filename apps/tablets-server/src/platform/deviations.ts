/**
 * MEDHANTA slice 2 (owner ruling, 9 November 2026; replaces declutter residual D4-R5): deviations through the Deviations
 * product. Where the server has a Deviations link (DEVIATIONS_DATABASE_URL), a batch's deviation is stored only as its
 * Deviations number (dv.batch_number_link, sql/1907), and its status is read, on this small pool and its own login,
 * from the view Deviations publishes, report.deviation_v1 (one row per linked batch; status classification, approval,
 * investigation, closure, closed or rejected). No copy of Deviations' tables, no call to its server.
 *
 * Release: the database refuses a release of a lot or container whose batch has a linked number without a status read
 * in the releasing transaction (dv.release_problem raises EBM01); this reader is the kernel's fact resolver for kind
 * 'deviation' and records the read (dv.record_status). Closed and rejected (reachable only by QA's signed reject in
 * Deviations) are resolved; anything else, or a number the view does not have, keeps release blocked.
 *
 * Connection off: when the view cannot be read (any error), the release stops with DEVIATIONS_OFF. It is never allowed
 * silently, and nothing is served from a copy.
 */
import pg from 'pg';
import type { FactRecorder, FactResolver } from '@ebmr/kernel';
import { refusal } from './http/refusal.ts';

export const DEVIATION_VIEW = 'report.deviation_v1';
export const DEVIATION_STATUSES = ['classification', 'approval', 'investigation', 'closure', 'closed', 'rejected'] as const;
export type DeviationStatus = (typeof DEVIATION_STATUSES)[number];
const RESOLVED: ReadonlySet<string> = new Set(['closed', 'rejected']);

export interface DeviationRead {
  number: string;
  /** null: the view has no row for this number. */
  status: DeviationStatus | null;
  classification: string | null;
  dataAsOf: string | null;
}

export function isResolved(status: string | null): boolean {
  return status !== null && RESOLVED.has(status);
}

export function deviationsOff() {
  return refusal(503, {
    code: 'DEVIATIONS_OFF',
    kind: 'NOT_SAVED',
    whatHappened: 'Connection to Deviations is off. Release is blocked. Ask your administrator.',
    why: 'The deviations of this batch are read from the Deviations product, and it cannot be read now. Nothing was saved or released.',
    controls: ['PL-08'],
    whatYouCanDo: ['Try again once the administrator has restored the connection to Deviations.'],
    whoCanHelp: ['Your administrator'],
  }, true);
}

/** The refusal of a batch deviation's management where the server has a Deviations link (lead ruling, subject-scoped). */
export function batchDeviationInDeviations(): Error {
  return refusal(410, {
    code: 'DISCONNECTED',
    kind: 'NOT_ENABLED',
    whatHappened: 'Batch deviations are managed in Deviations; link its number.',
    why: 'In this installation a deviation of a batch is investigated, classified and closed in the Deviations product, and the batch keeps only its Deviations number. Nothing was saved.',
    controls: ['DI-17'],
    whatYouCanDo: ['Raise or open the deviation in the Deviations product, then link its number to the batch.'],
    whoCanHelp: ['QA'],
  });
}

/**
 * Is deviation record `deviationId` a batch deviation (kind DEVIATION, linked to a batch or an output container), or would
 * linking it to `subjectKind` make it one? OOS and investigation records, and records of lots only, are not.
 */
export async function isBatchDeviation(db: Pick<pg.Pool, 'query'>, deviationId: string, subjectKind?: string): Promise<boolean> {
  const { rows } = await db.query<{ batch: boolean }>(
    `select d.kind = 'DEVIATION' and ($2::text in ('BATCH', 'CONTAINER')
              or exists (select 1 from site.deviation_link l where l.deviation_id = d.id and l.subject_kind in ('BATCH', 'CONTAINER'))) as batch
       from site.deviation d where d.id = $1`,
    [deviationId, subjectKind ?? null],
  );
  return rows[0]?.batch === true;
}

export class Deviations {
  constructor(private readonly pool: pg.Pool) {}

  static open(url: string): Deviations {
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    pool.on('error', () => undefined);
    return new Deviations(pool);
  }

  /** The number's status in Deviations. One row per linked batch: resolved only when every row is closed or rejected. */
  async read(number: string): Promise<DeviationRead> {
    try {
      const { rows } = await this.pool.query<{ status: DeviationStatus; classification: string | null; data_as_of: Date | null }>(
        `select status, classification, data_as_of from ${DEVIATION_VIEW} where number = $1`,
        [number],
      );
      if (rows.length === 0) return { number, status: null, classification: null, dataAsOf: null };
      const open = rows.find((r) => !isResolved(r.status)) ?? rows[0];
      return { number, status: open?.status ?? null, classification: open?.classification ?? null, dataAsOf: open?.data_as_of ? open.data_as_of.toISOString() : null };
    } catch {
      throw deviationsOff();
    }
  }

  /** The statement that records `read` in the writing transaction. */
  static recorder(read: DeviationRead): FactRecorder {
    return async (client) => {
      await client.query('select dv.record_status($1, $2, $3, $4)', [read.number, read.status, read.classification, read.dataAsOf]);
    };
  }

  /** Resolves kind 'deviation' here; every other kind goes to `next` (master data on the platform build), if any. */
  resolver(next: FactResolver | null): FactResolver {
    return async (detail: string): Promise<FactRecorder> => {
      const need = JSON.parse(detail) as { kind: string; code: string };
      if (need.kind === 'deviation') return Deviations.recorder(await this.read(need.code));
      if (next) return next(detail);
      throw new Error(`no fact resolver for kind ${need.kind}`);
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
