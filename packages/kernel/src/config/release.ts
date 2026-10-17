/**
 * The release identity, the validation-summary approval and the approved system description (DI-03, DI-06; kernel
 * 1300; interfaces slice-7-0-interfaces.md section 4; D-P7-0-5).
 *
 * The release is the SHA-256 over the migration ledger (`namespace/name/checksum` lines in byte order of namespace then
 * name, joined by a line feed); `releaseOfLedger` computes the same value from the files, so the IQ compares the
 * bundle's release with the database's. A validation summary is approved by a QA person's own signature
 * (VALIDATION_SUMMARY_APPROVED) bound to the running release and the summary's SHA-256. Interfaces of the system
 * description are configuration (area SYSTEM_DESCRIPTION): written under an approved change record.
 *
 * The functions here are thin callers of the kernel functions; call the writers inside `withCommand`.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';

type Db = Pick<pg.PoolClient, 'query'>;

export const VALIDATION_SUMMARY_MEANING = 'VALIDATION_SUMMARY_APPROVED';
export const VALIDATION_SUMMARY_AGGREGATE = 'validation_summary';
export const SYSTEM_DESCRIPTION_AREA = 'SYSTEM_DESCRIPTION';

/** Error codes of the release identity and the system description. */
export const VAL_NO_APPROVED_SUMMARY = 'EBMR-VAL-001';
export const VAL_UNKNOWN_BUNDLE_VERSION = 'EBMR-VAL-002';
export const VAL_MALFORMED_APPROVAL = 'EBMR-VAL-003';
export const VAL_NOT_RUNNING_RELEASE = 'EBMR-VAL-004';
export const VAL_ALREADY_APPROVED = 'EBMR-VAL-005';
export const VAL_SIGNATURE = 'EBMR-VAL-006';
export const INT_MALFORMED_INTERFACE = 'EBMR-INT-036';

export interface LedgerRow {
  namespace: string;
  name: string;
  /** Lowercase hex SHA-256 of the migration file. */
  checksum: string;
}

/** The release of a migration ledger, as platform.schema_release() computes it. */
export function releaseOfLedger(rows: readonly LedgerRow[]): string {
  const lines = rows.map((r) => `${r.namespace}/${r.name}/${r.checksum}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/** The aggregate id a validation summary's signature is bound to. */
export function validationSummaryAggregateId(schemaRelease: string, summarySha256: string): string {
  return `${schemaRelease}@${summarySha256}`;
}

export async function schemaRelease(db: Db): Promise<string> {
  const { rows } = await db.query<{ r: string }>('select platform.schema_release() as r');
  return rows[0]!.r;
}

/** EBMR-VAL-001 text when the running release has no approved summary on a GMP installation, else null. */
export async function validationSummaryProblem(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ p: string | null }>('select platform.validation_summary_problem() as p');
  return rows[0]!.p;
}

/** Record the caller's own VALIDATION_SUMMARY_APPROVED signature as the approval (VALIDATION.APPROVE_SUMMARY). */
export async function approveValidationSummary(db: Db, a: { schemaRelease: string; summarySha256: string; title: string; signatureId: string }): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select platform.approve_validation_summary($1, $2, $3, $4::uuid) as id', [
    a.schemaRelease,
    a.summarySha256,
    a.title,
    a.signatureId,
  ]);
  return rows[0]!.id;
}

export interface SystemInterface {
  /** The adapter's code (iam.integration_adapter). */
  adapterCode: string;
  sourceSystem: 'ERP_WMS' | 'QMS' | 'LIMS' | 'LMS' | 'CMMS' | 'EMS' | 'OPCUA' | 'L3';
  endpointHost: string;
  transport: 'LOOPBACK' | 'MTLS';
  signedFeed: boolean;
  status: 'DESCRIBED' | 'WITHDRAWN';
}

/** Record a version of an interface (CONFIG.SYSTEM_DESCRIPTION, under an approved change record naming SYSTEM_DESCRIPTION). */
export async function describeInterface(db: Db, def: SystemInterface): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select platform.describe_interface($1::jsonb) as id', [JSON.stringify(def)]);
  return rows[0]!.id;
}

/** Every interface's version in force. */
export async function systemDescription(db: Db): Promise<(SystemInterface & { validFrom: string })[]> {
  const { rows } = await db.query<{ adapter_code: string; source_system: SystemInterface['sourceSystem']; endpoint_host: string; transport: SystemInterface['transport']; signed_feed: boolean; status: SystemInterface['status']; valid_from: string }>(
    `select adapter_code, source_system, endpoint_host, transport, signed_feed, status,
            to_char(valid_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as valid_from
       from platform.system_description() order by adapter_code`,
  );
  return rows.map((r) => ({
    adapterCode: r.adapter_code,
    sourceSystem: r.source_system,
    endpointHost: r.endpoint_host,
    transport: r.transport,
    signedFeed: r.signed_feed,
    status: r.status,
    validFrom: r.valid_from,
  }));
}

export async function interfaceDescribed(db: Db, adapterCode: string): Promise<boolean> {
  const { rows } = await db.query<{ d: boolean }>('select platform.interface_described($1) as d', [adapterCode]);
  return rows[0]!.d;
}
