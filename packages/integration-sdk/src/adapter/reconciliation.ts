/**
 * The reconciliation report (Phase 6 slice 6a-0; DI-31 "no silent loss").
 *
 * For a period of source time, the source system states how many distinct messages it sent and a checksum over them;
 * `platform.record_reconciliation(report jsonb)` (kernel 1180) computes the same over what the eBMR received (accepted
 * messages plus recorded refusals that carried a key and a hash) and raises a RECONCILIATION_MISMATCH alarm when they
 * differ. A message the adapter lost, or a refusal it never recorded, therefore shows up as a mismatch.
 *
 * The checksum: one line `<idempotencyKey>|<payloadHash>` per distinct idempotency key, sorted by the key's bytes
 * (PostgreSQL collation "C"), joined with "\n" (no trailing newline), SHA-256 as lower-case hex. No messages: the
 * SHA-256 of the empty text.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EpochMicrosText, IdempotencyKey, Sha256Hex } from './envelope.ts';

const WholeText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'a whole number as decimal text');

/** What the adapter submits: the source system's own count and checksum for [periodFrom, periodTo) of source time. */
export const ReconciliationSubmission = z
  .strictObject({
    periodFrom: EpochMicrosText,
    periodTo: EpochMicrosText,
    sourceCount: WholeText,
    sourceChecksum: Sha256Hex,
  })
  .refine((r) => BigInt(r.periodFrom) < BigInt(r.periodTo), { message: 'the period ends after it starts', path: ['periodTo'] });
export type ReconciliationSubmission = z.infer<typeof ReconciliationSubmission>;

/** The stored report (`platform.reconciliation_report`), as the integrations namespace shows it. */
export const ReconciliationReport = z.strictObject({
  reportId: z.uuid(),
  adapterCode: z.string().min(1),
  periodFrom: EpochMicrosText,
  periodTo: EpochMicrosText,
  sourceCount: WholeText,
  sourceChecksum: Sha256Hex,
  receivedCount: WholeText,
  receivedChecksum: Sha256Hex,
  acceptedCount: WholeText,
  refusedCount: WholeText,
  matched: z.boolean(),
  alarmId: z.uuid().nullable(),
});
export type ReconciliationReport = z.infer<typeof ReconciliationReport>;

export interface ReconciliationEntry {
  idempotencyKey: string;
  payloadHash: string;
}

/** The checksum over distinct keys (the first hash seen for a key wins, as in the database). */
export function reconciliationChecksum(entries: readonly ReconciliationEntry[]): { count: string; checksum: string } {
  const byKey = new Map<string, string>();
  for (const e of entries) {
    IdempotencyKey.parse(e.idempotencyKey);
    Sha256Hex.parse(e.payloadHash);
    if (!byKey.has(e.idempotencyKey)) byKey.set(e.idempotencyKey, e.payloadHash);
  }
  const keys = [...byKey.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const text = keys.map((k) => `${k}|${byKey.get(k) ?? ''}`).join('\n');
  return { count: byKey.size.toString(), checksum: createHash('sha256').update(text, 'utf8').digest('hex') };
}
