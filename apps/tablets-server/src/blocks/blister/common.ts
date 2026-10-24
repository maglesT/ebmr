/**
 * Shared pieces of the blister blocks of Phase 3 slice 4b (builder A): TB-21 blister or strip line set-up, independent
 * line check and sealing, and TB-22 blister leak test (tablets spec B.2 TB-21, TB-22).
 *
 * TB-21's run takes G-06's configuration members and entry kinds unchanged (the granulation common module), so its
 * sealing values stand on the same rules as every other G-06 value. GMP counts are decimal text, never numbers;
 * instants are epoch microseconds (bigint).
 */
export * from '../coating/common.ts';
export { STREAM } from '../ipc/common.ts';

/** A material or lot code as scanned at the line. */
export const SCAN_CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

/** The roles a web of the pack takes on a blister or strip machine. */
export const MATERIAL_ROLES = ['FORMING_FILM', 'LIDDING_FOIL', 'STRIP_FOIL'] as const;
export type MaterialRole = (typeof MATERIAL_ROLES)[number];

/** The forms a pack takes. */
export const PACK_FORMS = ['THERMOFORM', 'COLD_FORM', 'STRIP'] as const;

/**
 * How the patient opens a blister (slice 7q, C8; decision D-7q-3): the tablet is pushed through the lidding foil (the
 * default when the format states nothing), the lidding foil is peeled off (a peelable lidding laminate, e.g. for an
 * orally disintegrating tablet that a push would break), or peeled and then pushed. A peelable opening is a property of
 * the lidding foil, so a strip pack (no lidding foil) has none.
 */
export const BLISTER_OPENINGS = ['PUSH_THROUGH', 'PEEL_OFF', 'PEEL_PUSH'] as const;

/** The machine's line check series in the slice 1 container hold (defect checks and sealing values). */
export const LINE_STREAM = 'LINE';

/** Exact sum of decimal-text counts (BigInt; counts are whole). */
export function countSum(values: readonly unknown[]): bigint {
  return values.reduce<bigint>((a, v) => a + (typeof v === 'string' && /^[0-9]{1,18}$/.test(v) ? BigInt(v) : 0n), 0n);
}
