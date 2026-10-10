/**
 * Material lots, release routes, reservations (site services; build outline 5.2.9; ADR 0001; controls INV-13,
 * IN-24 (a)(c), PR-18). Thin wrappers over the database commands of sql/0712_material_lot_commands.sql: every rule
 * is enforced there, under the application role.
 *
 * Every function runs inside a command: the caller passes a client on which kernel.begin_command has been called
 * (the kernel's withCommand). Quantities are decimal strings, never JavaScript numbers; instants are ISO 8601 text
 * and are compared with the database clock, never the client's.
 *
 * Consumption is not here: a batch consumes a reservation through the edition's batch-side definer
 * (recipe.consume_lot, recipe-core sql/0430), which supplies the batch's own number and market set.
 */
import type { Queryable } from '../batch-numbers/register.ts';
import type { MaterialLotState } from './machine.ts';

export type MaterialKind = 'API' | 'EXCIPIENT' | 'PRIMARY_PACKAGING' | 'PRINTED_PACKAGING' | 'INTERMEDIATE' | 'FINISHED';
export type ReleaseRoute = 'IDENTITY_TESTED' | 'VENDOR_HISTORY';
export type LotStatusEvent = 'RELEASE' | 'RELEASE_FOR_FURTHER_PROCESSING' | 'REJECT' | 'HOLD' | 'UNHOLD' | 'RETURN' | 'RECALL';
export type LotEdition = 'TABLETS' | 'INJECTABLES';

export interface LotReceipt {
  lotCode: string;
  materialCode: string;
  materialName: string;
  materialKind: MaterialKind;
  /** Decimal string, e.g. "25.000". */
  quantity: string;
  /** UCUM unit code, e.g. "kg". */
  unit: string;
  /** ISO 8601 instant; omit when the material has no retest date. */
  retestAt?: string;
  /** ISO 8601 instant, in the future at receipt. */
  expiresAt: string;
  supplier?: string;
  supplierLot?: string;
}

export interface ReceivedLot {
  lotId: string;
  siteCode: string;
  state: MaterialLotState;
  stateVersion: string;
}

export interface StatusChangeResult {
  from: MaterialLotState;
  to: MaterialLotState;
  newVersion: string;
  revokedReservations: number;
}

async function one<T>(client: Queryable, text: string, values: unknown[]): Promise<T> {
  const { rows } = await client.query(text, values);
  return (rows[0] as { r: T }).r;
}

/** Receives a lot into QUARANTINE at the site of the command's session (MATERIAL.HANDLE). */
export async function receiveLot(client: Queryable, receipt: LotReceipt): Promise<ReceivedLot> {
  const r = await one<{ lot_id: string; site_code: string; state: MaterialLotState; state_version: number | string }>(
    client,
    'select site.receive_lot($1::jsonb) as r',
    [JSON.stringify(receipt)],
  );
  return { lotId: r.lot_id, siteCode: r.site_code, state: r.state, stateVersion: String(r.state_version) };
}

/** Records an identity test result for a lot (QC.RESULT_RECORD). */
export async function recordIdentityResult(client: Queryable, lotId: string, result: 'PASS' | 'FAIL', methodReference: string, testReference: string): Promise<string> {
  return one<string>(client, 'select site.record_identity_result($1, $2, $3, $4) as r', [lotId, result, methodReference, testReference]);
}

/** QA's statistical justification for releasing one excipient on supplier history (MATERIAL.QA_DISPOSITION); effective once signed. */
export async function proposeVendorRoute(client: Queryable, materialCode: string, justification: string, statisticalReference: string): Promise<string> {
  return one<string>(client, "select site.propose_vendor_route($1, 'EXCIPIENT', $2, $3) as r", [materialCode, justification, statisticalReference]);
}

/** Enables a proposed vendor-history route with QA's VENDOR_ROUTE_ENABLED signature. */
export async function enableVendorRoute(client: Queryable, routeId: string, signatureId: string): Promise<void> {
  await client.query('select site.enable_vendor_route($1, $2)', [routeId, signatureId]);
}

export async function disableVendorRoute(client: Queryable, routeId: string, reason: string): Promise<void> {
  await client.query('select site.disable_vendor_route($1, $2)', [routeId, reason]);
}

/**
 * A status decision on a lot. RELEASE needs `route` and the releaser's own MATERIAL_LOT_RELEASED signature, and the
 * route must be the one the lot's signed content shows (sql/0720: IDENTITY_TESTED once a passing identity result exists); the
 * QA decisions need a MATERIAL_LOT_STATUS_DECIDED (or MATERIAL_LOT_REJECTED) signature and a reason in the command.
 */
export async function changeLotStatus(
  client: Queryable,
  lotId: string,
  event: LotStatusEvent,
  expectedVersion: string,
  signatureId: string | null,
  route?: ReleaseRoute,
): Promise<StatusChangeResult> {
  const r = await one<{ from: MaterialLotState; to: MaterialLotState; new_version: number | string; revoked_reservations: number }>(
    client,
    'select site.change_lot_status($1, $2, $3::bigint, $4, $5) as r',
    [lotId, event, expectedVersion, signatureId, route ?? null],
  );
  return { from: r.from, to: r.to, newVersion: String(r.new_version), revokedReservations: r.revoked_reservations };
}

/** Records the destruction of a rejected, returned or recalled lot (the performer). */
export async function recordLotDestruction(client: Queryable, lotId: string, method: string, reason: string): Promise<string> {
  return one<string>(client, 'select site.record_lot_destruction($1, $2, $3) as r', [lotId, method, reason]);
}

/** DESTROY, by the performer of the destruction record, with the witness's MATERIAL_DESTRUCTION_WITNESSED signature. */
export async function destroyLot(client: Queryable, lotId: string, expectedVersion: string, witnessSignatureId: string): Promise<StatusChangeResult> {
  const r = await one<{ from: MaterialLotState; to: MaterialLotState; new_version: number | string; revoked_reservations: number }>(
    client,
    'select site.destroy_lot($1, $2::bigint, $3) as r',
    [lotId, expectedVersion, witnessSignatureId],
  );
  return { from: r.from, to: r.to, newVersion: String(r.new_version), revokedReservations: r.revoked_reservations };
}

export interface ReservationRequest {
  lotId: string;
  batchId: string;
  batchNumber: string;
  edition: LotEdition;
  /** Decimal string in the lot's unit. */
  quantity: string;
  unit: string;
  /** ISO 8601 instant, no later than the lot's retest or expiry instant. */
  expiresAt: string;
}

/** Reserves a quantity of a usable lot for one batch (MATERIAL.HANDLE). */
export async function reserveLot(client: Queryable, req: ReservationRequest): Promise<string> {
  return one<string>(client, 'select site.reserve_lot($1, $2, $3, $4, $5::numeric, $6, $7::timestamptz) as r', [
    req.lotId,
    req.batchId,
    req.batchNumber,
    req.edition,
    req.quantity,
    req.unit,
    req.expiresAt,
  ]);
}

export async function cancelReservation(client: Queryable, reservationId: string, reason: string): Promise<void> {
  await client.query('select site.cancel_reservation($1, $2)', [reservationId, reason]);
}

export interface LotUsage {
  lotId: string;
  lotCode: string;
  materialCode: string;
  state: MaterialLotState;
  stateVersion: string;
  /** The stored state, or EXPIRED / RETEST_DUE computed from the dates at database time. */
  usageStatus: MaterialLotState | 'EXPIRED' | 'RETEST_DUE';
  quantity: string;
  available: string;
  unit: string;
  releaseRoute: ReleaseRoute | null;
}

/** A lot's usage status as the database computes it now (IN-24 (a)). */
export async function lotUsage(client: Queryable, lotId: string): Promise<LotUsage | undefined> {
  const { rows } = await client.query(
    `select lot_id, lot_code, material_code, state, state_version::text, usage_status, quantity::text, available::text, unit, release_route
       from site.material_lot_usage where lot_id = $1`,
    [lotId],
  );
  const r = rows[0] as
    | { lot_id: string; lot_code: string; material_code: string; state: MaterialLotState; state_version: string; usage_status: LotUsage['usageStatus']; quantity: string; available: string; unit: string; release_route: ReleaseRoute | null }
    | undefined;
  if (!r) return undefined;
  return {
    lotId: r.lot_id,
    lotCode: r.lot_code,
    materialCode: r.material_code,
    state: r.state,
    stateVersion: r.state_version,
    usageStatus: r.usage_status,
    quantity: r.quantity,
    available: r.available,
    unit: r.unit,
    releaseRoute: r.release_route,
  };
}
