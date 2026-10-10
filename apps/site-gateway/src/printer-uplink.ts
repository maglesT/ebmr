/**
 * Printers on the site gateway (Phase 3 slice 4a, G-21, K-20; DI-20, DI-28, DI-31): the line printers behind the
 * ebmr.sim-printer.v1 driver, the print jobs the server releases for them, and their events journalled and forwarded.
 *
 * Jobs: GET /gw/v1/print-jobs lists the jobs released for this gateway's printers. Each is checked (the contract's
 * form, a printer of this gateway), loaded on its printer exactly as given (the variable data always comes from the
 * record; the gateway never makes or changes a value) and the printer's echo compared with the job: LOADED when the
 * echo equals it (job id, layout and every field), MISMATCH when anything differs (the printer is cleared at once, so
 * it never prints a job it holds wrongly), FAILED when it could not be loaded. POST /gw/v1/print-jobs/:id/ack carries
 * the outcome, the echoed fields and the gateway's clock when the echo arrived; an acknowledgement that does not reach
 * the server is sent again (the printer is not loaded twice for one job in this process).
 *
 * Events: every poll reads each printer's status and the events it logged since the last one journalled (its boot
 * and event number, rebuilt from the journal at start, so none is taken twice or lost across a gateway restart), and
 * journals in one synced append: the printer's reader, vision and challenge results and its faults; a PRINTED_COUNT
 * when the count on the job moved (cumulative); a FAULT OFFLINE / STALE when the gateway loses the printer or its
 * scan counter stops moving for staleAfterMs, and OFFLINE_CLEARED / STALE_CLEARED when it is back. Each carries the
 * serial verified at connect (the configured one for OFFLINE), the job, the gateway's clock and the printer's next
 * sequence number (print-journal.ts).
 *
 * Forwarding (store and forward, as the process uplink): oldest first to POST /gw/v1/print-events under the gateway's
 * session, in batches of one capture session; the delivered mark moves only on a 2xx answer; an outage loses
 * nothing; a refused batch (4xx) is offered again after 30 s; a relogin answer ends the session and a login follows.
 */
import { randomUUID } from 'node:crypto';
import {
  PRINT_EVENTS_BATCH_MAX,
  PRINT_EVENTS_PATH,
  PRINT_JOBS_PATH,
  PrintJob,
  PrintJobsResponse,
  PrintWireResponse,
  echoMismatches,
  printEventProblems,
  printJobAckPath,
  type PrintEventsRequest,
  type PrintJobAckRequest,
} from '@ebmr/integration-sdk/printer';
import { GatewayWireError } from '@ebmr/integration-sdk/scale';
import type { GatewayClock } from './clock.ts';
import type { PrinterDeviceConfig } from './config.ts';
import { PrinterSimDriver } from './drivers/printer-sim.ts';
import { PrintJournal, type PrintJournalInput, type PrintOrigin } from './print-journal.ts';
import type { GatewaySession } from './process-uplink.ts';
import { UplinkError } from './uplink.ts';

export interface PrinterAlarm {
  kind: 'EVENT_REFUSED' | 'PRINTER_STALE' | 'PRINTER_FRESH' | 'UPLINK_FAILED' | 'UPLINK_RESTORED' | 'EVENTS_REFUSED' | 'JOURNAL_FAILED' | 'JOB_FAILED' | 'JOB_MISMATCH' | 'ACK_FAILED';
  deviceCode: string | null;
  message: string;
  details: Record<string, string>;
}

export interface PrinterGatewayOptions {
  uplink: string;
  journalDir: string;
  printers: PrinterDeviceConfig[];
  session: GatewaySession;
  clock: GatewayClock;
  pollMs: number;
  staleAfterMs: number;
  jobPollMs: number;
  /** Do not start the loops (tests drive pollOnce, flush and pollJobs themselves). */
  manual?: boolean;
  driver?: { requestTimeoutMs?: number; backoffInitialMs?: number; backoffMaxMs?: number; connectTimeoutMs?: number };
  onAlarm?: (alarm: PrinterAlarm) => void;
  onDriverAlarm?: (alarm: { kind: string; deviceCode: string; message: string; details: Record<string, string> }) => void;
  log?: (message: string) => void;
}

interface Printer {
  config: PrinterDeviceConfig;
  driver: PrinterSimDriver;
  scan: string | null;
  scanMovedAtUs: bigint;
  stale: boolean;
  /** An OFFLINE fault is reported and not yet cleared. */
  offline: boolean;
  /** The job the printer held at the last read (or loaded since). */
  jobId: string | null;
  /** The last printer event taken (journalled, or refused and alarmed). */
  cursor: PrintOrigin | null;
}

/** A refused batch is offered again after this long (the alarm is raised once; no alarm storm). */
const REFUSAL_HOLD_US = 30_000_000n;
/** At most this many pages of printer events are taken in one poll (the rest at the next). */
const EVENT_PAGES_PER_POLL = 25;

export class PrinterGateway {
  /** The gateway's capture session: drawn at each start, carried by every event taken in this process. */
  readonly sessionId = randomUUID();
  readonly printers = new Map<string, Printer>();
  journal!: PrintJournal;
  uploadFailure: string | null = null;
  private refusedAtUs: bigint | null = null;
  /** Jobs handled in this process: the acknowledgement, and whether the server has it. */
  private readonly acks = new Map<string, { body: PrintJobAckRequest; sent: boolean }>();
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private polling = false;
  private jobPolling: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  private constructor(private readonly options: PrinterGatewayOptions) {}

  static async start(options: PrinterGatewayOptions): Promise<PrinterGateway> {
    const g = new PrinterGateway(options);
    g.journal = await PrintJournal.open({ dir: options.journalDir, onAlarm: (a) => g.alarm({ kind: 'JOURNAL_FAILED', deviceCode: null, message: a.message, details: { ...a.details, journalAlarm: a.kind } }) });
    for (const config of options.printers) {
      const driver = new PrinterSimDriver({ code: config.code, host: config.host, port: config.port, expectedSerial: config.expectedSerial, clock: options.clock, ...(options.driver ?? {}) });
      const printer: Printer = { config, driver, scan: null, scanMovedAtUs: options.clock.monoUs(), stale: false, offline: false, jobId: g.journal.lastPrintedCount(config.expectedSerial)?.jobId ?? null, cursor: g.journal.lastOrigin(config.expectedSerial) };
      driver.on('alarm', (a: { kind: string; deviceCode: string; message: string; details: Record<string, string> }) => options.onDriverAlarm?.(a));
      driver.on('state', (s: string) => {
        options.log?.(`${config.code}: ${s}`);
        if (s !== 'ONLINE') printer.scan = null;
      });
      g.printers.set(config.code, printer);
      driver.start();
    }
    if (!options.manual) {
      g.timers.push(setInterval(() => void g.pollOnce(), options.pollMs));
      g.timers.push(setInterval(() => void g.pollJobs(), options.jobPollMs));
    }
    return g;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    await this.flushing?.catch(() => undefined);
    await this.jobPolling?.catch(() => undefined);
    for (const p of this.printers.values()) await p.driver.stop();
    await this.journal.close();
  }

  private alarm(a: PrinterAlarm): void {
    this.options.onAlarm?.(a);
  }

  /** Reads every printer once, journals its events, then forwards. Never rejects. */
  async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const p of this.printers.values()) await this.pollPrinter(p);
    } finally {
      this.polling = false;
    }
    await this.flush();
  }

  private fault(p: Printer, code: string, serial: string): PrintJournalInput {
    return { origin: null, event: { deviceSerial: serial, jobId: p.jobId, kind: 'FAULT', value: code, sourceTime: this.options.clock.wallUs().toString() } };
  }

  /** A printer event in the contract's form; null (alarmed) otherwise. */
  private checked(p: Printer, input: PrintJournalInput): PrintJournalInput | null {
    const problems = printEventProblems(input.event).map((x) => x.message);
    if (problems.length === 0) return input;
    this.alarm({ kind: 'EVENT_REFUSED', deviceCode: p.config.code, message: `${p.config.code}: ${input.event.kind} ${input.event.value} refused: ${problems.join('; ')}`, details: { kind: input.event.kind, value: input.event.value } });
    return null;
  }

  private async pollPrinter(p: Printer): Promise<void> {
    const serial = p.config.expectedSerial;
    const out: PrintJournalInput[] = [];
    let cursor = p.cursor;
    let offline = p.offline;
    let stale = p.stale;
    if (p.driver.state === 'OFFLINE') {
      if (!offline) out.push(this.fault(p, 'OFFLINE', serial));
      offline = true;
    } else if (p.driver.state === 'ONLINE') {
      const r = await p.driver.read();
      if (r.ok) {
        if (offline) out.push(this.fault(p, 'OFFLINE_CLEARED', r.serial));
        offline = false;
        const now = this.options.clock.monoUs();
        if (p.scan !== r.status.scan) {
          p.scan = r.status.scan;
          p.scanMovedAtUs = now;
          if (stale) {
            out.push(this.fault(p, 'STALE_CLEARED', r.serial));
            this.alarm({ kind: 'PRINTER_FRESH', deviceCode: p.config.code, message: `${p.config.code}: the printer's status updates again`, details: { scan: r.status.scan } });
          }
          stale = false;
        } else if (!stale && now - p.scanMovedAtUs >= BigInt(this.options.staleAfterMs) * 1000n) {
          stale = true;
          out.push(this.fault(p, 'STALE', r.serial));
          this.alarm({ kind: 'PRINTER_STALE', deviceCode: p.config.code, message: `${p.config.code}: the printer's status has not updated for ${this.options.staleAfterMs} ms`, details: { scan: r.status.scan } });
        }
        p.jobId = r.status.jobId;
        // The printer's own events since the last one taken in this boot (from 0 in a new boot).
        let after = cursor && cursor.boot === r.boot ? BigInt(cursor.no) : 0n;
        for (let page = 0; page < EVENT_PAGES_PER_POLL; page += 1) {
          const e = await p.driver.events(after);
          if (!e.ok) break;
          for (const ev of e.events) {
            const input = this.checked(p, { origin: { boot: e.boot, no: ev.no }, event: { deviceSerial: e.serial, jobId: ev.jobId, kind: ev.kind, value: ev.value, sourceTime: e.receivedWallUs.toString() } });
            if (input) out.push(input);
            cursor = { boot: e.boot, no: ev.no };
            after = BigInt(ev.no);
          }
          if (!e.more) break;
        }
        const last = this.journal.lastPrintedCount(r.serial);
        if (r.status.jobId !== null && !stale && (last === null || last.jobId !== r.status.jobId || last.value !== r.status.printed)) {
          out.push({ origin: null, event: { deviceSerial: r.serial, jobId: r.status.jobId, kind: 'PRINTED_COUNT', value: r.status.printed, sourceTime: r.receivedWallUs.toString() } });
        }
      }
    }
    try {
      await this.journal.append(this.sessionId, out);
    } catch {
      return; // alarmed by the journal; nothing is remembered as taken, so the next poll takes it again
    }
    p.cursor = cursor;
    p.offline = offline;
    p.stale = stale;
  }

  /** Forwards what the journal holds, oldest first; one flush at a time (a request during one runs one more). Never rejects. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.flushAgain = false;
          await this.deliver();
        } while (this.flushAgain && !this.stopped);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    for (;;) {
      const pending = this.journal.undelivered(PRINT_EVENTS_BATCH_MAX);
      const first = pending[0];
      if (!first) return;
      if (this.refusedAtUs !== null && this.options.clock.monoUs() - this.refusedAtUs < REFUSAL_HOLD_US) return;
      const other = pending.findIndex((e) => e.sessionId !== first.sessionId);
      const batch = other < 0 ? pending : pending.slice(0, other);
      const body: PrintEventsRequest = { sessionId: first.sessionId, events: batch.map((e) => e.event) };
      try {
        await this.call('POST', PRINT_EVENTS_PATH, body, PrintWireResponse);
      } catch (error) {
        const e = error instanceof UplinkError ? error : null;
        const message = error instanceof Error ? error.message : String(error);
        if (e && e.status >= 400 && e.status < 500 && !e.relogin) {
          this.refusedAtUs = this.options.clock.monoUs();
          this.alarm({ kind: 'EVENTS_REFUSED', deviceCode: null, message: `the server refused ${batch.length} print events: ${e.code} ${message}; offered again in 30 s`, details: { code: e.code, firstSequence: first.event.sequence, deviceSerial: first.event.deviceSerial } });
        } else if (this.uploadFailure === null) {
          this.alarm({ kind: 'UPLINK_FAILED', deviceCode: null, message: `print events not uploaded (kept in the journal): ${message}`, details: { waiting: String(pending.length) } });
        }
        this.uploadFailure = message;
        return;
      }
      this.refusedAtUs = null;
      if (this.uploadFailure !== null) this.alarm({ kind: 'UPLINK_RESTORED', deviceCode: null, message: 'print events are uploaded again', details: {} });
      this.uploadFailure = null;
      await this.journal.acknowledge(batch.length);
    }
  }

  /** Fetches the released print jobs and loads each on its printer; one run at a time. Never rejects. */
  pollJobs(): Promise<void> {
    this.jobPolling ??= this.loadJobs()
      .catch(() => undefined)
      .finally(() => {
        this.jobPolling = null;
      });
    return this.jobPolling;
  }

  private async loadJobs(): Promise<void> {
    if (this.stopped) return;
    let jobs: PrintJobsResponse['jobs'];
    try {
      jobs = (await this.call('GET', PRINT_JOBS_PATH, null, PrintJobsResponse)).jobs;
    } catch {
      return; // the next poll asks again; an outage is alarmed by the events' upload
    }
    for (const raw of jobs) {
      let ack = this.acks.get(raw.id);
      if (!ack) {
        ack = { body: await this.load(raw), sent: false };
        this.acks.set(raw.id, ack);
      }
      try {
        await this.call('POST', printJobAckPath(raw.id), ack.body, PrintWireResponse);
        ack.sent = true;
      } catch (error) {
        this.alarm({ kind: 'ACK_FAILED', deviceCode: null, message: `the acknowledgement of print job ${raw.id} did not reach the server (${error instanceof Error ? error.message : String(error)}); sent again later`, details: { id: raw.id } });
      }
    }
  }

  private async load(raw: { id: string }): Promise<PrintJobAckRequest> {
    const failed = (message: string, printer: Printer | null = null): PrintJobAckRequest => {
      this.alarm({ kind: 'JOB_FAILED', deviceCode: printer?.config.code ?? null, message: `print job ${raw.id} was not loaded: ${message}`, details: { id: raw.id } });
      return { sessionId: this.sessionId, outcome: 'FAILED', echoedFields: null, sourceTime: this.options.clock.wallUs().toString(), message: message.slice(0, 500) };
    };
    const parsed = PrintJob.safeParse(raw);
    if (!parsed.success) return failed(`not a print job of the contract (${parsed.error.issues.map((i) => i.path.map(String).join('.')).join(', ')})`);
    const job = parsed.data;
    const printer = [...this.printers.values()].find((p) => p.config.expectedSerial === job.deviceSerial);
    if (!printer) return failed(`no printer with serial ${job.deviceSerial} on this gateway`);
    const r = await printer.driver.load({ jobId: job.id, layoutRef: job.layoutRef, fields: job.fields });
    if (!r.ok) return failed(r.message, printer);
    const differs: string[] = [...(r.echo.jobId !== job.id ? ['jobId'] : []), ...(r.echo.layoutRef !== job.layoutRef ? ['layoutRef'] : []), ...echoMismatches(job.fields, r.echo.fields)];
    if (differs.length === 0) {
      printer.jobId = job.id;
      return { sessionId: this.sessionId, outcome: 'LOADED', echoedFields: r.echo.fields, sourceTime: r.receivedWallUs.toString(), message: null };
    }
    // The printer holds something else than the record's job: it must not print it.
    const cleared = await printer.driver.clear();
    printer.jobId = cleared.ok ? null : r.echo.jobId;
    const message = `the printer echoes ${differs.join(', ')} differently from the job${cleared.ok ? '; the printer was cleared' : `; the printer could not be cleared (${cleared.message})`}`;
    this.alarm({ kind: 'JOB_MISMATCH', deviceCode: printer.config.code, message: `print job ${job.id}: ${message}`, details: { id: job.id, fields: differs.join(',') } });
    return { sessionId: this.sessionId, outcome: 'MISMATCH', echoedFields: r.echo.fields, sourceTime: r.receivedWallUs.toString(), message };
  }

  /** One request under the gateway session; a relogin answer ends the session (a login follows). */
  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown, parse: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Promise<T> {
    const token = await this.options.session.sessionToken();
    if (token === null) throw new UplinkError(0, 'NO_SESSION', 'the gateway has no session with the server', false);
    let res: Response;
    try {
      res = await fetch(`${this.options.uplink}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new UplinkError(0, 'UNREACHABLE', `the server's gateway listener cannot be reached: ${error instanceof Error ? error.message : String(error)}`, false);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new UplinkError(res.status, 'PROTOCOL', `the listener answered ${res.status} without JSON`, false);
    }
    if (!res.ok) {
      const e = GatewayWireError.safeParse(json);
      const err = e.success ? new UplinkError(res.status, e.data.error.code, e.data.error.message, e.data.error.relogin) : new UplinkError(res.status, 'PROTOCOL', `the listener answered ${res.status}`, res.status === 401);
      if (err.relogin) this.options.session.sessionEnded(token);
      throw err;
    }
    const parsed = parse.safeParse(json);
    if (!parsed.success) throw new UplinkError(res.status, 'PROTOCOL', `the listener's answer to ${path} is not in the expected form`, false);
    return parsed.data;
  }
}
