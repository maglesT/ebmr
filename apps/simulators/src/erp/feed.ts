/**
 * The message feed of the ERP and WMS simulators (Phase 6 slice 6a, builder A; ERP_WMS contract of
 * @ebmr/integration-sdk/adapter). The same protocol as the other system simulators: the eBMR adapter pulls the
 * envelopes after the last sequence number it handled, asks the heartbeat, and submits the reconciliation the feed
 * computes over what it published (counts and checksum per period of source time, DI-31 "no silent loss").
 *
 * Faults (outline: feed gap, stale value, malformed, duplicate, out-of-order, wrong batch, link cut mid-transfer, slow
 * answer, stale mirror), each switched on and off by the console or POST /api/fault:
 *   FEED_GAP      the feed delivers nothing while the data keeps changing (the head moves on; delivered when off)
 *   STALE_VALUE   a change is published with a source time older than the record's previous message
 *   MALFORMED     a published payload carries a field the contract does not know
 *   DUPLICATE     every page delivers the last message the adapter already has again (same key and hash)
 *   OUT_OF_ORDER  the messages of a page arrive in reverse order
 *   WRONG_BATCH   a published payload names a lot or material the eBMR does not hold
 *   LINK_CUT      the answer is cut off mid-transfer (half the body, then the connection is destroyed)
 *   SLOW          the answer comes after `slowMs`, past the adapter's timeout
 *   STALE_MIRROR  the heartbeat stops (503) while the feed still answers: the data stays, its freshness goes
 * SIMULATOR, DEMO-ONLY. No kernel or database import (dependency rule gateway-and-simulators-no-db).
 */
import { rawPayloadHash, reconciliationChecksum, type ReconciliationSubmission } from '@ebmr/integration-sdk/adapter';

export const FEED_FAULTS = ['FEED_GAP', 'STALE_VALUE', 'MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'WRONG_BATCH', 'LINK_CUT', 'SLOW', 'STALE_MIRROR'] as const;
export type FeedFault = (typeof FEED_FAULTS)[number];

export interface ErpWmsEnvelope {
  sourceSystem: 'ERP_WMS';
  messageType: string;
  sourceRecordId: string;
  sourceTimestamp: string;
  sequenceNo: string;
  idempotencyKey: string;
  schemaVersion: string;
  payloadHash: string;
  payload: Record<string, unknown>;
}

export interface FeedPage {
  messages: ErpWmsEnvelope[];
  head: string;
}

export interface FeedClock {
  nowUs(): bigint;
}

/** The system clock, strictly increasing (two messages never share a source time). */
export function systemClock(): FeedClock {
  let last = 0n;
  return {
    nowUs() {
      const t = BigInt(Date.now()) * 1000n;
      last = t > last ? t : last + 1n;
      return last;
    },
  };
}

/** The identity fields a WRONG_BATCH message names wrongly (lot, material, product). */
const IDENTITY_FIELDS = ['lotNumber', 'materialCode', 'productCode'] as const;

export class ErpWmsFeed {
  readonly faults = new Set<FeedFault>();
  slowMs = 3000;
  private readonly clock: FeedClock;
  private readonly name: string;
  private readonly messages: ErpWmsEnvelope[] = [];
  private readonly lastTimeOf = new Map<string, bigint>();

  /** `name` (ERP or WMS) prefixes the idempotency keys: the two feeds are two adapters with their own sequences. */
  constructor(name: string, clock: FeedClock = systemClock()) {
    this.name = name;
    this.clock = clock;
  }

  /** Publishes one message (the content faults apply while they are on). */
  publish(messageType: string, sourceRecordId: string, payload: Record<string, unknown>): ErpWmsEnvelope {
    const seq = this.messages.length + 1;
    let body = payload;
    if (this.faults.has('MALFORMED')) body = { ...body, simulatorExtra: 'not in the contract' };
    if (this.faults.has('WRONG_BATCH')) {
      body = { ...body };
      for (const f of IDENTITY_FIELDS) if (f in body) body[f] = `XX-UNKNOWN-${seq.toString()}`;
    }
    const recordKey = `${messageType}|${sourceRecordId}`;
    const previous = this.lastTimeOf.get(recordKey);
    let ts = this.clock.nowUs();
    if (this.faults.has('STALE_VALUE') && previous !== undefined) ts = previous - 1n;
    else this.lastTimeOf.set(recordKey, ts);
    const text = JSON.stringify(body);
    const env: ErpWmsEnvelope = {
      sourceSystem: 'ERP_WMS',
      messageType,
      sourceRecordId,
      sourceTimestamp: ts.toString(),
      sequenceNo: seq.toString(),
      idempotencyKey: `${this.name}-${seq.toString()}-${rawPayloadHash(text).slice(0, 12)}`,
      schemaVersion: '1',
      payloadHash: rawPayloadHash(text),
      payload: body,
    };
    this.messages.push(env);
    return env;
  }

  head(): bigint {
    return BigInt(this.messages.length);
  }

  published(): readonly ErpWmsEnvelope[] {
    return this.messages;
  }

  /** The messages after `after` (at most `limit`), with the delivery faults applied. */
  page(after: bigint, limit: number): FeedPage {
    const head = this.head().toString();
    if (this.faults.has('FEED_GAP')) return { messages: [], head };
    let out = this.messages.filter((m) => BigInt(m.sequenceNo) > after).slice(0, Math.max(1, Math.min(limit, 500)));
    if (this.faults.has('OUT_OF_ORDER')) out = [...out].reverse();
    if (this.faults.has('DUPLICATE') && after > 0n) {
      const again = this.messages[Number(after) - 1];
      if (again) out = [again, ...out];
    }
    return { messages: out, head };
  }

  heartbeatOk(): boolean {
    return !this.faults.has('STALE_MIRROR');
  }

  /** The source's own count and checksum of what it published in [fromUs, toUs) of source time. */
  reconciliation(fromUs: bigint, toUs: bigint): ReconciliationSubmission {
    const inPeriod = this.messages.filter((m) => BigInt(m.sourceTimestamp) >= fromUs && BigInt(m.sourceTimestamp) < toUs);
    const { count, checksum } = reconciliationChecksum(inPeriod.map((m) => ({ idempotencyKey: m.idempotencyKey, payloadHash: m.payloadHash })));
    return { periodFrom: fromUs.toString(), periodTo: toUs.toString(), sourceCount: count, sourceChecksum: checksum };
  }
}
