/**
 * Shared shapes of the system contracts (Phase 6 slice 6a-0). A system contract lists its inbound message types, each
 * with its payload schema per schema version, and the EBMR codes its receiving commands raise with their error class.
 * The database keeps the same list of (system, message type, schema version) in `platform.inbound_schema`; a message
 * type the database does not list is refused as MALFORMED (EBMR-INT-004).
 */
import { z } from 'zod';
import type { ErrorClass } from './errors.ts';
import type { InboundEnvelope, SourceSystem } from './envelope.ts';

/** A measured or counted value exactly as the source sent it: decimal text and the source's unit (DI-31). */
export const SourceValue = z.strictObject({
  value: z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'decimal text such as 12.503'),
  unit: z.string().regex(/^[\x21-\x7E]{1,16}$/, 'the unit as the source writes it'),
});
export type SourceValue = z.infer<typeof SourceValue>;

/** A calendar date YYYY-MM-DD (due dates, expiry dates). */
export const CalendarDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'a date YYYY-MM-DD');
/** A code in the source system (material, product, equipment, person number, ...). */
export const SourceCode = z.string().regex(/^[\x21-\x7E]{1,64}$/, 'printable ASCII without spaces, at most 64');
export const SourceText = z.string().min(1).max(500);

export interface MessageContract {
  /** The payload schema per schema version ('1', '2', ...). */
  readonly versions: Readonly<Record<string, z.ZodType>>;
  readonly summary: string;
}

export interface SystemContract {
  readonly system: SourceSystem;
  /** Inbound message types, `<prefix>.<name>`. */
  readonly inbound: Readonly<Record<string, MessageContract>>;
  /** Outbound event topics the eBMR sends to this system through the outbox (documented; shapes owned by the builder). */
  readonly outbound: readonly string[];
  /** EBMR codes of the receiving commands and their error class (filled by the slice that builds the command). */
  readonly refusalCodes: Readonly<Record<string, ErrorClass>>;
}

/** The payload schema for an envelope, or undefined when the contract does not know its type or version. */
export function payloadSchema(contract: SystemContract, envelope: Pick<InboundEnvelope, 'messageType' | 'schemaVersion' | 'sourceSystem'>): z.ZodType | undefined {
  if (envelope.sourceSystem !== contract.system) return undefined;
  return contract.inbound[envelope.messageType]?.versions[envelope.schemaVersion];
}

/** Every (message type, schema version) pair of a contract, as the database's inbound_schema rows list them. */
export function schemaRows(contract: SystemContract): { sourceSystem: SourceSystem; messageType: string; schemaVersion: string }[] {
  return Object.entries(contract.inbound).flatMap(([messageType, m]) =>
    Object.keys(m.versions).map((schemaVersion) => ({ sourceSystem: contract.system, messageType, schemaVersion })),
  );
}
