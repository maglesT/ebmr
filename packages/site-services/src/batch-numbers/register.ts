/**
 * Batch-number allocation register (site services; build outline 4.2, 5.2.2; ADR 0001; IN-18 context;
 * INV-27). One register per site for both editions; numbers are never reissued.
 *
 * Every function runs inside a command: the caller passes a client on which kernel.begin_command has
 * been called (the kernel's withCommand). Allocation draws from a protected, write-ahead counter; when the
 * counter has no reserved ceiling left the database raises EBMR-CONT-011 with the counter key in the
 * error detail, and the kernel's withProtectedNumbers reserves a block in the external ledger and retries.
 *
 * Quantities (batch size) are decimal strings, never JavaScript numbers.
 */

/** Minimal query interface satisfied by pg.PoolClient and pg.Pool. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The register's edition codes (kernel.edition_codes(); API plan A1a added SUBSTANCE). */
export type Edition = 'TABLETS' | 'INJECTABLES' | 'SUBSTANCE';
export type BatchKind = 'PROCESSING' | 'PACKAGING';

export interface BatchNumberRuleInput {
  /** Stable identifier of the rule, e.g. "ATV-TAB-2026" (upper case, digits, _ and -). */
  ruleCode: string;
  siteCode: string;
  /** Omit for a site-wide rule used by products without their own rule. */
  productCode?: string;
  batchKind: BatchKind;
  /** e.g. "AT{YY}{SEQ:4}", "{SITE}/{PRODUCT}/{YYYY}/{SEQ:5}", packaging "{PARENT}-P{SEQ:2}". */
  format: string;
  /** The site's IANA zone, exactly the site policy site.zone (any other is refused, EBMR-SITE-002); {YYYY}/{YY}/{MM} use the site-local calendar. */
  siteZone: string;
  /** ISO 8601; defaults to now. A rule never takes effect in the past. */
  effectiveFrom?: string;
  reason: string;
  /** Values reserved per write-ahead block (default 50). */
  blockSize?: number;
  /**
   * What {SEQ:n} counts: RULE, one serial across the rule; PARENT, a serial per processing batch (needs {PARENT}).
   * Omitted: a packaging rule with {PARENT} counts per parent, any other rule across the rule (recipe-core 1790).
   */
  serialScope?: 'RULE' | 'PARENT';
}

export interface AllocationRequest {
  siteCode: string;
  productCode: string;
  productName: string;
  edition: Edition;
  batchKind?: BatchKind;
  /** Decimal string, e.g. "200000" or "150.5". */
  batchSize: string;
  /** UCUM unit code, e.g. "{tbl}", "kg", "L". */
  batchSizeUnit: string;
  /** Required for PACKAGING: the processing batch number it belongs to. */
  parentBatchNumber?: string;
  /** e.g. the ERP production order. */
  externalReference?: string;
}

export interface Allocation {
  allocationId: string;
  batchNumber: string;
  serial: string | null;
}

export interface ExternalRegistration extends AllocationRequest {
  batchNumber: string;
  siteZone: string;
}

export interface RecoveryRequest {
  restoreEventId: string;
  ruleCode: string;
  serial: string;
  /** A per-parent packaging number: the serial its {SEQ:n} shows (the rule's serial stays in `serial`). */
  parentSerial?: string;
  batchNumber: string;
  productCode: string;
  productName: string;
  edition: Edition;
  batchSize: string;
  batchSizeUnit: string;
  parentBatchNumber?: string;
  /** Paper record, ERP document or label that proves the number was issued in the lost window. */
  evidenceReference: string;
}

export interface RegisterRow {
  allocationId: string;
  batchNumber: string;
  siteCode: string;
  edition: Edition;
  batchKind: BatchKind;
  parentBatchNumber: string | null;
  productCode: string;
  productName: string;
  batchSize: string;
  batchSizeUnit: string;
  /** UTC instant from the database clock. */
  allocatedAt: string;
  /** Site-local calendar date of the allocation (YYYY-MM-DD). */
  allocationDate: string;
  source: 'GENERATED' | 'EXTERNAL' | 'RECOVERED_AFTER_RESTORE';
  ruleCode: string | null;
  serial: string | null;
  externalReference: string | null;
  status: 'ALLOCATED' | 'VOIDED';
  voidReasonCode: string | null;
  voidReasonText: string | null;
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const BATCH_NUMBER = /^[A-Z0-9][A-Z0-9/.-]{0,31}$/;

export function isValidBatchNumber(value: string): boolean {
  return BATCH_NUMBER.test(value);
}

function assertDecimal(value: string, field: string): void {
  if (!DECIMAL.test(value)) throw new Error(`EBMR-SITE-002 ${field} must be a positive decimal string, got ${JSON.stringify(value)}`);
}

function firstRow<T>(rows: unknown[]): T {
  const r = rows[0];
  if (r === undefined) throw new Error('the database returned no row');
  return r as T;
}

export async function defineBatchNumberRule(db: Queryable, input: BatchNumberRuleInput): Promise<string> {
  const { rows } = await db.query('select site.define_batch_number_rule($1::jsonb)::text as id', [
    JSON.stringify({
      rule_code: input.ruleCode,
      site_code: input.siteCode,
      product_code: input.productCode ?? null,
      batch_kind: input.batchKind,
      format: input.format,
      site_zone: input.siteZone,
      effective_from: input.effectiveFrom ?? null,
      reason: input.reason,
      block_size: input.blockSize ?? null,
      serial_scope: input.serialScope ?? null,
    }),
  ]);
  return firstRow<{ id: string }>(rows).id;
}

function requestJson(req: AllocationRequest): Record<string, unknown> {
  assertDecimal(req.batchSize, 'batchSize');
  return {
    site_code: req.siteCode,
    product_code: req.productCode,
    product_name: req.productName,
    edition: req.edition,
    batch_kind: req.batchKind ?? 'PROCESSING',
    batch_size: req.batchSize,
    batch_size_unit: req.batchSizeUnit,
    parent_batch_number: req.parentBatchNumber ?? null,
    external_reference: req.externalReference ?? null,
  };
}

/** Allocate the next number of the rule in force for this site, product and kind. */
export async function allocateBatchNumber(db: Queryable, req: AllocationRequest): Promise<Allocation> {
  const { rows } = await db.query('select allocation_id::text, batch_number, serial::text from site.allocate_batch_number($1::jsonb)', [JSON.stringify(requestJson(req))]);
  const r = firstRow<{ allocation_id: string; batch_number: string; serial: string | null }>(rows);
  return { allocationId: r.allocation_id, batchNumber: r.batch_number, serial: r.serial };
}

/** Register a number issued by an external system; an existing number (voided included) is refused. */
export async function registerExternalBatchNumber(db: Queryable, req: ExternalRegistration): Promise<string> {
  const { rows } = await db.query('select site.register_external_batch_number($1::jsonb)::text as id', [
    JSON.stringify({ ...requestJson(req), batch_number: req.batchNumber, site_zone: req.siteZone }),
  ]);
  return firstRow<{ id: string }>(rows).id;
}

export async function voidBatchNumber(db: Queryable, allocationId: string, reasonCode: string, reasonText: string): Promise<void> {
  await db.query('select site.void_batch_number($1, $2, $3)', [allocationId, reasonCode, reasonText]);
}

/** Re-enter a number issued in the lost window of a completed restore (serial must lie in the skipped range). */
export async function recoverBatchNumber(db: Queryable, req: RecoveryRequest): Promise<string> {
  assertDecimal(req.batchSize, 'batchSize');
  const { rows } = await db.query('select site.recover_batch_number($1::jsonb)::text as id', [
    JSON.stringify({
      restore_event_id: req.restoreEventId,
      rule_code: req.ruleCode,
      serial: req.serial,
      parent_serial: req.parentSerial ?? null,
      batch_number: req.batchNumber,
      product_code: req.productCode,
      product_name: req.productName,
      edition: req.edition,
      batch_size: req.batchSize,
      batch_size_unit: req.batchSizeUnit,
      parent_batch_number: req.parentBatchNumber ?? null,
      evidence_reference: req.evidenceReference,
    }),
  ]);
  return firstRow<{ id: string }>(rows).id;
}

export interface RegisterFilter {
  siteCode?: string;
  /** Inclusive site-local dates (YYYY-MM-DD). */
  fromDate?: string;
  toDate?: string;
}

/** The register as exported for inspection (allocation date, product identity, batch size, status). */
export async function exportBatchNumberRegister(db: Queryable, filter: RegisterFilter = {}): Promise<RegisterRow[]> {
  const { rows } = await db.query(
    `select allocation_id::text, batch_number, site_code, edition, batch_kind, parent_batch_number, product_code, product_name,
            batch_size::text, batch_size_unit, to_char(allocated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as allocated_at,
            allocation_date::text, source, rule_code, serial::text, external_reference, status, void_reason_code, void_reason_text
       from site.batch_number_register
      where ($1::text is null or site_code = $1) and ($2::date is null or allocation_date >= $2::date) and ($3::date is null or allocation_date <= $3::date)
      order by allocated_at, batch_number`,
    [filter.siteCode ?? null, filter.fromDate ?? null, filter.toDate ?? null],
  );
  return (rows as Record<string, string | null>[]).map((r) => ({
    allocationId: r['allocation_id'] ?? '',
    batchNumber: r['batch_number'] ?? '',
    siteCode: r['site_code'] ?? '',
    edition: r['edition'] as Edition,
    batchKind: r['batch_kind'] as BatchKind,
    parentBatchNumber: r['parent_batch_number'] ?? null,
    productCode: r['product_code'] ?? '',
    productName: r['product_name'] ?? '',
    batchSize: r['batch_size'] ?? '',
    batchSizeUnit: r['batch_size_unit'] ?? '',
    allocatedAt: r['allocated_at'] ?? '',
    allocationDate: r['allocation_date'] ?? '',
    source: r['source'] as RegisterRow['source'],
    ruleCode: r['rule_code'] ?? null,
    serial: r['serial'] ?? null,
    externalReference: r['external_reference'] ?? null,
    status: r['status'] as RegisterRow['status'],
    voidReasonCode: r['void_reason_code'] ?? null,
    voidReasonText: r['void_reason_text'] ?? null,
  }));
}

const CSV_COLUMNS: [keyof RegisterRow, string][] = [
  ['batchNumber', 'Batch number'],
  ['allocationDate', 'Allocation date'],
  ['allocatedAt', 'Allocated at (UTC)'],
  ['productCode', 'Product code'],
  ['productName', 'Product name'],
  ['batchSize', 'Batch size'],
  ['batchSizeUnit', 'Batch size unit'],
  ['edition', 'Edition'],
  ['batchKind', 'Kind'],
  ['parentBatchNumber', 'Processing batch number'],
  ['source', 'Source'],
  ['ruleCode', 'Numbering rule'],
  ['serial', 'Serial'],
  ['externalReference', 'External reference'],
  ['status', 'Status'],
  ['voidReasonCode', 'Void reason code'],
  ['voidReasonText', 'Void reason'],
];

function csvCell(v: string | null): string {
  const s = v ?? '';
  // Neutralise spreadsheet formula injection and quote every cell.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function registerToCsv(rows: RegisterRow[]): string {
  const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map((r) => CSV_COLUMNS.map(([key]) => csvCell(r[key])).join(','));
  return `${[header, ...body].join('\r\n')}\r\n`;
}

/** Invariant query (INV-27, IN-18); must return no problems. */
export async function batchNumberInvariantViolations(db: Queryable): Promise<string[]> {
  const { rows } = await db.query('select problem from site.batch_number_invariant_violations()');
  return (rows as { problem: string }[]).map((r) => r.problem);
}
