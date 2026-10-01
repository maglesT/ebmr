/**
 * The site's time zone while the server runs (DI-27). The server reads the site policy site.zone at start-up
 * (installation.ts, siteZoneFromPolicy) and declares that zone in every actor context it builds and every GMP
 * time it shows. The policy can change while the server runs: the kernel then refuses every command whose
 * context still declares the old zone (EBMR-IAM-118), but reads would go on showing times in the old zone.
 *
 * SiteZoneGuard closes that gap. Every part of the server that declares or shows the zone takes it from
 * current(), and every entry point re-reads the policy (check()) before it works:
 *  - the browser port: buildApp checks before every /api/ request (static SPA files carry no time and are
 *    served as before); request actor contexts (bind.ts) and formatted instants (AppContext.formatInstant);
 *  - the gateway listener (features/devices/listener.ts): before every /gw/ request (a heartbeat reads the policy in
 *    its receipt statement and hands it to observe() before anything else is done with it), and its INTEGRATION
 *    contexts;
 *  - the sweeper (features/execution/sweeper.ts): before every sweep, and its SYSTEM context;
 *  - an interval (watch()), so a change is noticed even while nothing else runs.
 * On a change it latches: from then on every API and gateway request is refused and no instant is formatted
 * and no actor context built (SITE_ZONE_CHANGED, 503); the sweeper sweeps nothing; the live displays already
 * streaming (devices.live, display-only samples without a GMP time) are ended through onChange(), and the
 * browser's reconnect is refused like any API request. This holds until the server restarts and reads the new
 * zone, even if the policy is changed back meanwhile (what was shown in between cannot be known). The change
 * is reported once, at error level, as an operations alert naming both zones.
 * The change itself is recorded by the kernel (iam.set_policy is an audited, attributed action).
 */
import type pg from 'pg';
import { refusal, type HttpRefusal } from './http/refusal.ts';

/** How often the running server re-reads the site policy site.zone when no request does it. */
export const SITE_ZONE_CHECK_INTERVAL_MS = 30_000;

/** The refusal code of every API and gateway request after the site policy site.zone changed while the server was running. */
export const SITE_ZONE_CHANGED = 'SITE_ZONE_CHANGED';

/** The site policy site.zone as the database holds it now (null: no value). */
export async function readPolicySiteZone(pool: Pick<pg.Pool, 'query'>): Promise<string | null> {
  const { rows } = await pool.query<{ zone: string | null }>("select iam.policy_text('site.zone') as zone");
  return rows[0]?.zone ?? null;
}

export interface SiteZoneAlertLog {
  error(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

function siteZoneChanged(serverZone: string, policyZone: string | null): HttpRefusal {
  return refusal(503, {
    code: SITE_ZONE_CHANGED,
    kind: 'STALE',
    whatHappened: 'The site’s time zone was changed while this server was running. Nothing was shown or saved: the server must restart before it can show or record times.',
    why: `This server started with the site time zone ${serverZone}; the site policy site.zone now names ${policyZone ?? 'no zone'}.`,
    controls: ['DI-27'],
    whatYouCanDo: ['Ask the system administrator to restart the server, then try again.'],
    whoCanHelp: ['The system administrator'],
    details: { serverZone, policyZone: policyZone ?? '' },
  });
}

export class SiteZoneGuard {
  #changedTo: { policyZone: string | null } | null = null;
  readonly #onChange = new Set<() => void>();

  /**
   * @param pool reads the site policy
   * @param zone the site policy site.zone as the server read it at start-up (ServerConfig.siteZone)
   * @param log receives the operations alert
   */
  constructor(
    private readonly pool: Pick<pg.Pool, 'query'>,
    readonly zone: string,
    private readonly log: SiteZoneAlertLog,
  ) {}

  /** The zone the policy was found to hold instead of the server's, or null while the two agree. */
  get changedTo(): { policyZone: string | null } | null {
    return this.#changedTo;
  }

  /** The site's time zone to declare or show; refuses once the policy was found to differ. */
  current(): string {
    if (this.#changedTo) throw siteZoneChanged(this.zone, this.#changedTo.policyZone);
    return this.zone;
  }

  /**
   * Calls `listener` once when the latch trips, or at once when it already has (work that outlives a request,
   * such as an open live display, ends then). Returns the function that unsubscribes it.
   */
  onChange(listener: () => void): () => void {
    if (this.#changedTo) {
      listener();
      return () => undefined;
    }
    this.#onChange.add(listener);
    return () => {
      this.#onChange.delete(listener);
    };
  }

  /** Re-reads the site policy; on a change latches, raises the operations alert once and refuses. */
  async check(): Promise<void> {
    if (!this.#changedTo) this.observe(await readPolicySiteZone(this.pool));
    this.current();
  }

  /**
   * As check(), for the site policy site.zone `policyZone` just read by the caller in a statement of its own (the
   * gateway listener reads it in each heartbeat's receipt statement, so a heartbeat makes no other query before its
   * token is known; tablets 0350): on a change latches, raises the operations alert once and refuses.
   */
  observe(policyZone: string | null): void {
    if (!this.#changedTo && policyZone !== this.zone) {
      this.#changedTo = { policyZone };
      this.log.error(
        { alert: SITE_ZONE_CHANGED, controls: ['DI-27'], serverZone: this.zone, policyZone },
        `OPERATIONS ALERT: the site policy site.zone changed from ${this.zone} to ${policyZone ?? 'no value'} while the server was running; every API and gateway request is refused, open live displays end and the sweeper stops until the server restarts (DI-27)`,
      );
      const listeners = [...this.#onChange];
      this.#onChange.clear();
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          this.log.warn({ err: error instanceof Error ? error.message : String(error) }, 'a site time zone change listener failed');
        }
      }
    }
    this.current();
  }

  /** Runs check() every `intervalMs` (unref'd); stop() ends it and waits for a check in flight. */
  watch(intervalMs: number = SITE_ZONE_CHECK_INTERVAL_MS): { stop(): Promise<void> } {
    let running: Promise<void> | null = null;
    let stopped = false;
    const timer = setInterval(() => {
      if (running || stopped || this.#changedTo) return;
      running = this.check()
        .catch((error: unknown) => {
          if (this.#changedTo) return; // already alerted
          this.log.warn({ err: error instanceof Error ? error.message : String(error) }, 'the site time zone check could not read the site policy; it retries at the next interval');
        })
        .finally(() => {
          running = null;
        });
    }, intervalMs);
    timer.unref();
    return {
      async stop() {
        stopped = true;
        clearInterval(timer);
        if (running) await running;
      },
    };
  }
}
