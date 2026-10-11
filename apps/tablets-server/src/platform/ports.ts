/**
 * Ports between the platform and the feature modules (Phase 2 apps plan sections 5, 6, 10):
 *  - SignableActionRegistry: C1's e-signature endpoints find the handler of a signable action here
 *    (C3 registers ENGINE_COMMAND; C2 registers MBR_TRANSITION in A2; C1's tests register ESIG_STUB).
 *  - DeviceReadingPort: C3's command claims scale readings by id inside its transaction (C5 implements it;
 *    the default refuses, so the G-07 manual two-person path works without it).
 *  - SealKeyProvider: the DEMO-ONLY HMAC seal key from EBMR_SEAL_KEY_FILE (a KMS or HSM in production).
 *  - formatInstant: the {us, text} wire form of a GMP instant, formatted with the kernel's site time.
 */
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { z } from 'zod';
import { esig, time, type ActorContext } from '@ebmr/kernel';
import type { Instant, ScaleStatusView, SignableAction, SignableContentView, SignableKind, Refusal } from '@ebmr/api-contract';
import { refusal } from './http/refusal.ts';

// ---------------------------------------------------------------------------------------------
// Time

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** `{us, text}` with text like "28-SEP-2026 14:05:03 +05:30 (Asia/Kolkata)"; the browser never formats GMP time. */
export function formatInstant(us: bigint | string, zone: string): Instant {
  const micros = typeof us === 'bigint' ? us : BigInt(us);
  const st = time.siteTime(time.Instant.fromEpochMicros(micros), zone);
  const [y, m, d] = st.date.split('-');
  return { us: micros.toString(), text: `${d}-${MONTHS[Number(m) - 1] ?? '???'}-${y} ${st.time} ${st.offset} (${zone})` };
}

// ---------------------------------------------------------------------------------------------
// E-signatures (plan section 6)

/** The request context a signable handler works in. */
export interface SignableContext {
  actor: ActorContext;
  /** Room of the session's terminal (point-of-work checks). */
  room: string | null;
  deviceClass: string;
}

export type DryRunOutcome =
  | { accepted: true; contentHash: string; contentVersion: string }
  | { accepted: false; refusal: Refusal; status: number };

export interface SignableActionHandler<A extends SignableAction = SignableAction> {
  kind: A['kind'];
  /** Aggregate types whose content this handler previews (e.g. batch_step, batch_stage). */
  aggregateTypes: readonly string[];
  /** The aggregate, meaning and expected state the challenge names. */
  describe(action: A): { aggregateType: string; aggregateId: string; meaning: string; expectedState?: string };
  /**
   * Phase 3 slice 6: the same, when it depends on the record's state (e.g. the meaning of a lot rejection), read now for
   * POST /api/esig/describe. Absent: describe() answers.
   */
  describeNow?(db: pg.Pool | pg.PoolClient, action: A): Promise<{ aggregateType: string; aggregateId: string; meaning: string; expectedState?: string }>;
  /**
   * The signer's own reason the sign command carries, both halves, for an action whose change needs one (the kernel
   * refuses such a change without it, EBMR-AUDIT-002): taken from the action the person sent, never written by the
   * system (DI-22, DI-24). Absent: the command carries no reason.
   */
  reasonOf?(action: A): { reasonCode: string; reasonText: string } | undefined;
  /** GET /api/esig/content: the exact text to sign (a pure preview for engine actions). */
  previewContent(ctx: SignableContext, query: { aggregateType: string; aggregateId: string; intent: string }): Promise<SignableContentView>;
  /** Inside the challenge command: prepare the record at database time (PREPARE row when it changed). */
  prepareForChallenge(client: pg.PoolClient, ctx: SignableContext, action: A): Promise<{ contentVersion: string; contentHash: string; changed: boolean }>;
  /**
   * Inside the sign command, before sealing: run the action with a placeholder signature; refusals sign nothing.
   * It runs once per attempt. After a refusal C1 logs it with the attempt's authentication in the same command,
   * which then commits what this recorded on purpose (its refusal record) and never signs (features/esig).
   */
  dryRun(client: pg.PoolClient, ctx: SignableContext, action: A): Promise<DryRunOutcome>;
  /** After sealing, in the same transaction: apply with the real signature; asserts the content hash is unchanged. */
  apply(client: pg.PoolClient, ctx: SignableContext, action: A, signature: { signatureId: string; meaning: string; signer: string }): Promise<Record<string, unknown> | null>;
}

export class SignableActionRegistry {
  private readonly byKind = new Map<SignableKind, SignableActionHandler>();

  register<A extends SignableAction>(handler: SignableActionHandler<A>): void {
    if (this.byKind.has(handler.kind)) throw new Error(`a signable handler for ${handler.kind} is already registered`);
    this.byKind.set(handler.kind, handler);
  }

  forKind(kind: SignableKind): SignableActionHandler | undefined {
    return this.byKind.get(kind);
  }

  forAggregateType(aggregateType: string): SignableActionHandler | undefined {
    return [...this.byKind.values()].find((h) => h.aggregateTypes.includes(aggregateType));
  }

  kinds(): SignableKind[] {
    return [...this.byKind.keys()];
  }
}

// ---------------------------------------------------------------------------------------------
// Scale readings (plan section 10)

export interface ReadingClaim {
  readingIds: readonly string[];
  /** Room of the kiosk (DI-20): readings from an instrument in another room are refused. */
  room: string | null;
  /** Policy maximum age at database time (default 120 s). */
  maxAgeUs: bigint;
  purpose: string;
}

/** The tare and gross readings one weighing names, for the checks of its claims (Phase 2 exit follow-up F58.1). */
export interface WeighingReadings {
  tareReadingId: string;
  grossReadingId: string;
  /** Room of the kiosk (DI-20), as for a claim. */
  room: string | null;
  /** Policy maximum age at database time (default 120 s), as for a claim. */
  maxAgeUs: bigint;
}

export interface ClaimedReading {
  readingId: string;
  value: string;
  unit: string;
  raw: string;
  deviceCode: string;
  sourceTimeUs: bigint | null;
  trust: 'DEVICE_SYNCED' | 'DEVICE_UNSYNCED';
}

export interface DeviceReadingPort {
  /** Claims readings once, inside the caller's command transaction (inserts tab.reading_use). */
  claim(client: pg.PoolClient, claim: ReadingClaim): Promise<ClaimedReading[]>;
  /**
   * The facts the claims of a weighing would give, tare then gross, with every check of those claims made as the
   * command makes them (together, so one reading named as both is refused as the gross claim refuses it), without using
   * the readings (nothing stays inserted): for a command refused as stale, which names its readings and uses none
   * (Phase 2 exit review F58.1; tablets 0510).
   */
  peekWeighing(client: pg.PoolClient, readings: WeighingReadings): Promise<ClaimedReading[]>;
  /** The scale status of a room, for the step screen header; null when the room has no scale. */
  scaleStatus(room: string | null): Promise<ScaleStatusView | null>;
  /**
   * Every scale of `room` with its status, for the manual two-person path: the balance a hand-keyed weighing may name
   * and the statuses that justified the fallback (stored with the row). The database checks the same again inside the
   * command (tablets 0310, EBMR-EXE-074).
   */
  scales(room: string): Promise<ScaleStatusView[]>;
}

/** Until C5 lands: every claim (and peekWeighing) is refused (the manual two-person path still works), and no scale is shown. */
const readingsNotEnabled = (): Promise<never> =>
  Promise.reject(
    refusal(422, {
      code: 'DEVICE_READINGS_NOT_ENABLED',
      kind: 'NOT_ENABLED',
      whatHappened: 'Scale readings cannot be used on this installation yet.',
      why: 'The scale connection (site gateway) is not installed.',
      controls: ['DI-32'],
      whatYouCanDo: ['Use manual entry; a second person must then verify the step.'],
      whoCanHelp: ['The system administrator'],
    }),
  );

export const REFUSING_DEVICE_READING_PORT: DeviceReadingPort = {
  claim: readingsNotEnabled,
  peekWeighing: readingsNotEnabled,
  scaleStatus: () => Promise.resolve(null),
  scales: () => Promise.resolve([]),
};

// ---------------------------------------------------------------------------------------------
// Seal key (DEMO-ONLY file; ADR 0012 decision 3)

const SealKeyFile = z.object({
  keyId: z.string(),
  algorithm: z.literal('HMAC-SHA256'),
  /** base64, at least 32 bytes. */
  secret: z.string(),
  label: z.string().optional(),
});

/** Reads the DEMO-ONLY HMAC seal key; null when no file is configured. */
export function sealKeyFromFile(file: string | null): esig.SealKeyProvider | null {
  if (!file) return null;
  const parsed = SealKeyFile.parse(JSON.parse(readFileSync(file, 'utf8')));
  return esig.hmacSealKey(parsed.keyId, Buffer.from(parsed.secret, 'base64'));
}
