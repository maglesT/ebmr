/**
 * The pull worker of the feed adapters (QMS, LIMS, LMS, CMMS; Phase 6 slice 6a, builder B; DI-31, DI-14, DI-20;
 * D-P6a-0-5, D-P6a-B-1). One worker per adapter instance:
 *
 *   cycle        GET <base>/<prefix>/v1/feed?after=N; each envelope goes to its system's receiving command (a SECURITY
 *                DEFINER of the database that calls platform.accept_inbound_detail and applies the payload in the same
 *                transaction) as the adapter's own INTEGRATION identity, with the source's reason (D-P6a-B-7).
 *                A refusal of the database is classified (classifyFailure: kernel codes and the system contract's
 *                refusalCodes) and recorded in its own command with platform.record_inbound_refusal (an alarm), then the
 *                message counts as handled. A TRANSPORT failure (the feed, the database link) or an unclassified one
 *                stops the cycle without moving the pointer: everything is fetched again (the accepted ones come back as
 *                DUPLICATE), never dropped. The pointer moves to the highest sequence number of a page only when every
 *                message of the page was handled.
 *   heartbeat    when the cycle is caught up (pointer = the source's head) and the source's heartbeat answers, every
 *                mirror data class of the system is synchronised (platform.record_mirror_sync). A feed gap (the head
 *                moves, nothing is delivered) or a stopped heartbeat therefore lets the mirror go stale, and the GMP
 *                guards that read it fail closed (EBMR-INT-010).
 *   reconcile    the source's count and checksum of a period of source time to platform.record_reconciliation; a
 *                mismatch raises RECONCILIATION_MISMATCH (no silent loss).
 * Retries back off as retryDelayMs says (1 s doubling to 5 min). The worker never signs and holds no SIGN permission.
 */
import { classifyFailure, retryDelayMs, type ErrorClass, type ReconciliationSubmission } from '@ebmr/integration-sdk/adapter';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import type pg from 'pg';

export type FeedSystem = 'QMS' | 'LIMS' | 'LMS' | 'CMMS';

export interface FeedAdapterSpec {
  system: FeedSystem;
  /** The simulator's or system's path prefix, e.g. 'qms'. */
  prefix: string;
  /** Receiving command per message type (the database functions of the builders' migrations). */
  receive: Readonly<Record<string, string>>;
  /** Mirror data classes the system feeds (kernel 1180 platform.mirror_data_class). */
  mirrorClasses: readonly string[];
  /** The system contract's refusal codes and their classes. */
  refusalCodes: Readonly<Record<string, ErrorClass>>;
}

/** The adapter's identity for one cycle: an actor context of its INTEGRATION account and a way to end the session. */
export interface AdapterSession {
  actor: ActorContext;
  close(): Promise<void>;
}

export interface FeedWorkerOptions {
  pool: pg.Pool;
  baseUrl: string;
  openSession(): Promise<AdapterSession>;
  /** Timeout of one HTTP answer (a SLOW source counts as a TRANSPORT failure). Default 2000 ms. */
  timeoutMs?: number;
  pageSize?: number;
  fetchImpl?: typeof fetch;
}

export interface Envelope {
  sourceSystem: string;
  messageType: string;
  sourceRecordId: string;
  sourceTimestamp: string;
  sequenceNo: string;
  idempotencyKey: string;
  payload: unknown;
  [k: string]: unknown;
}

export interface CycleReport {
  fetched: number;
  accepted: number;
  duplicates: number;
  refused: Partial<Record<ErrorClass, number>>;
  /** Why the cycle stopped early (a TRANSPORT or unclassified failure), else null. */
  stopped: string | null;
  caughtUp: boolean;
  synced: boolean;
  after: string;
}

class TransportFailure extends Error {}

export const ebmrCodeOf = (message: string): string | undefined => /^EBMR-[A-Z]+-\d{3}/.exec(message)?.[0] ?? /EBMR-[A-Z]+-\d{3}/.exec(message)?.[0];

export class FeedPullWorker {
  private after = 0n;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    readonly spec: FeedAdapterSpec,
    private readonly o: FeedWorkerOptions,
  ) {}

  /** The pointer: the highest sequence number handled. Read from the database once (a restart resumes there). */
  async resume(adapterCode: string): Promise<bigint> {
    const { rows } = await this.o.pool.query<{ n: string | null }>(
      `select greatest((select max(sequence_no) from platform.inbound_message where adapter_code = $1),
                       (select max(sequence_no) from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'))::text as n`,
      [adapterCode],
    );
    this.after = BigInt(rows[0]?.n ?? '0');
    return this.after;
  }

  pointer(): bigint {
    return this.after;
  }

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const f = this.o.fetchImpl ?? fetch;
    try {
      const r = await f(`${this.o.baseUrl}/${this.spec.prefix}/v1/${path}`, { signal: AbortSignal.timeout(this.o.timeoutMs ?? 2000) });
      const text = await r.text();
      return { status: r.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
    } catch (error) {
      throw new TransportFailure(`${this.spec.system} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private reasonOf(e: Envelope): { reasonCode: string; reasonText: string } {
    return { reasonCode: 'INBOUND_MESSAGE', reasonText: `${e.messageType} ${e.sourceRecordId} from the ${e.sourceSystem}` };
  }

  /** One message through its receiving command; a refusal is recorded in its own command. */
  private async handle(session: AdapterSession, e: Envelope, report: CycleReport): Promise<void> {
    const fn = this.spec.receive[e.messageType];
    const actor = { ...session.actor, correlationId: crypto.randomUUID(), ...this.reasonOf(e) };
    try {
      if (!fn) throw Object.assign(new Error(`EBMR-INT-004 ${this.spec.system} message type ${String(e.messageType)} has no receiving command here`), { code: 'P0001' });
      const out = await withCommand(this.o.pool, actor, async (c) => (await c.query<{ r: { outcome?: string } }>(`select ${fn}($1::jsonb) as r`, [JSON.stringify(e)])).rows[0]?.r);
      if (out?.outcome === 'DUPLICATE') report.duplicates += 1;
      else report.accepted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sqlState = (error as { code?: string }).code;
      const cls = classifyFailure({ ebmrCode: ebmrCodeOf(message), sqlState, network: !sqlState && !ebmrCodeOf(message) }, this.spec.refusalCodes);
      if (!cls || cls === 'TRANSPORT') throw new TransportFailure(`${e.messageType} ${e.sequenceNo}: ${message}`);
      await withCommand(this.o.pool, { ...session.actor, correlationId: crypto.randomUUID() }, (c) =>
        c.query('select platform.record_inbound_refusal($1::jsonb, $2, $3)', [JSON.stringify(e), cls, message.slice(0, 2000)]),
      );
      report.refused[cls] = (report.refused[cls] ?? 0) + 1;
    }
  }

  /** One pull of the feed, the heartbeat and the mirror synchronisation (see the header). */
  async cycle(): Promise<CycleReport> {
    const report: CycleReport = { fetched: 0, accepted: 0, duplicates: 0, refused: {}, stopped: null, caughtUp: false, synced: false, after: this.after.toString() };
    let session: AdapterSession | null = null;
    try {
      session = await this.o.openSession();
      let head = this.after;
      for (;;) {
        const page = await this.get(`feed?after=${this.after.toString()}&limit=${(this.o.pageSize ?? 100).toString()}`);
        const body = page.body as { messages?: Envelope[]; head?: string } | null;
        if (page.status !== 200 || !body || !Array.isArray(body.messages) || typeof body.head !== 'string') throw new TransportFailure(`${this.spec.system} feed answered ${page.status.toString()}`);
        head = BigInt(body.head);
        const fresh = body.messages.filter((m) => /^[1-9][0-9]*$/.test(String(m.sequenceNo)));
        if (fresh.length === 0) break;
        report.fetched += fresh.length;
        let top = this.after;
        for (const m of fresh) {
          await this.handle(session, m, report);
          const n = BigInt(m.sequenceNo);
          if (n > top) top = n;
        }
        if (top <= this.after) break;
        this.after = top;
      }
      report.caughtUp = this.after >= head;
      if (report.caughtUp) {
        const hb = await this.get('heartbeat').catch(() => ({ status: 0, body: null }));
        if (hb.status === 200) {
          for (const cls of this.spec.mirrorClasses) {
            await withCommand(this.o.pool, { ...session.actor, correlationId: crypto.randomUUID() }, (c) => c.query('select platform.record_mirror_sync($1)', [cls]));
          }
          report.synced = this.spec.mirrorClasses.length > 0;
        }
      }
      this.failures = 0;
    } catch (error) {
      if (!(error instanceof TransportFailure)) throw error;
      report.stopped = error.message;
      this.failures += 1;
    } finally {
      await session?.close();
    }
    report.after = this.after.toString();
    return report;
  }

  /** The source's report of [fromUs, toUs) of source time, recorded (a mismatch raises its alarm). */
  async reconcile(fromUs: bigint, toUs: bigint): Promise<{ matched: boolean; reportId: string }> {
    const r = await this.get(`reconciliation?from=${fromUs.toString()}&to=${toUs.toString()}`);
    if (r.status !== 200) throw new TransportFailure(`${this.spec.system} reconciliation answered ${r.status.toString()}`);
    const sub = r.body as ReconciliationSubmission;
    const session = await this.o.openSession();
    try {
      const id = await withCommand(this.o.pool, { ...session.actor, correlationId: crypto.randomUUID() }, async (c) =>
        (await c.query<{ id: string }>('select platform.record_reconciliation($1::jsonb) as id', [JSON.stringify(sub)])).rows[0]!.id,
      );
      const { rows } = await this.o.pool.query<{ matched: boolean }>('select matched from platform.reconciliation_report where id = $1', [id]);
      return { matched: rows[0]?.matched ?? false, reportId: id };
    } finally {
      await session.close();
    }
  }

  /** Runs cycles every `intervalMs`, backing off after failures (retryDelayMs); never drops a message. */
  start(intervalMs: number, onReport?: (r: CycleReport) => void, onError?: (e: unknown) => void): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.cycle()
        .then((r) => onReport?.(r))
        .catch((e: unknown) => onError?.(e))
        .finally(() => {
          this.running = false;
          if (this.timer) this.timer = setTimeout(tick, this.failures > 0 ? retryDelayMs(this.failures) : intervalMs);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
