/**
 * Thin, typed callers of the output-container commands in schema plant (sql/0420-0422). Every writer runs inside a
 * command the caller started (kernel withCommand); the database decides and refuses with a code (EBMR-CNT-NNN, or the
 * kernel's EBMR-PLAT / EBMR-IAM / EBMR-ESIG codes), raised here as KernelError.
 *
 * Quantities travel as decimal strings and are numeric in the database; times are the database's.
 */
import type pg from 'pg';
import { commands } from '@ebmr/kernel';
import { isDecimalLiteral } from '../flow/decimal.ts';
import type { OutputContainerState } from './machine.ts';

type Db = pg.Pool | pg.PoolClient;

async function one<T>(db: Db, sql: string, params: unknown[]): Promise<T> {
  try {
    const { rows } = await db.query<{ r: T }>(sql, params);
    if (rows.length === 0) throw new Error(`no result from ${sql}`);
    return (rows[0] as { r: T }).r;
  } catch (error) {
    throw commands.asKernelError(error);
  }
}

export type QuantityUnit = 'kg' | 'g' | 'units';
export type IpcResult = 'PASS' | 'FAIL' | 'MISSED';
export type ChargePurpose = 'CHARGE' | 'PACK';

export interface OpenContainerInput {
  batchId: string;
  /** Stage code, e.g. COMPRESSION. */
  stage: string;
  unit: QuantityUnit;
  pressCode?: string;
  stream?: string;
}

export interface ContainerRef {
  containerId: string;
  labelCode: string;
  state: OutputContainerState;
  version: number;
}

const ref = (r: { container_id: string; label_code: string; state: string; version: number | string }): ContainerRef => ({
  containerId: r.container_id,
  labelCode: r.label_code,
  state: r.state as OutputContainerState,
  version: Number(r.version),
});

/** Whether a press's streams discharge into separate containers (MASTERDATA.CHANGE); a new configuration version. */
export async function configurePressDischarge(db: Db, pressCode: string, separateStreams: boolean): Promise<{ version: number }> {
  const r = await one<{ version: number }>(db, 'select plant.configure_press_discharge($1, $2) as r', [pressCode, separateStreams]);
  return { version: Number(r.version) };
}

/** A new container of the batch and stage; its label is generated and its product and strength come from the batch. */
export async function openContainer(db: Db, input: OpenContainerInput): Promise<ContainerRef> {
  return ref(
    await one(db, 'select plant.open_container($1, $2, $3, $4, $5) as r', [input.batchId, input.stage, input.unit, input.pressCode ?? null, input.stream ?? null]),
  );
}

/** Closes the container with its net quantity (decimal string); HELD at once when a check failed while it was open. */
export async function closeContainer(db: Db, containerId: string, netQuantity: string, expectedVersion: number): Promise<ContainerRef> {
  if (!isDecimalLiteral(netQuantity)) throw new RangeError(`${JSON.stringify(netQuantity)} is not a decimal literal`);
  return ref(await one(db, 'select plant.close_container($1, $2::numeric, $3) as r', [containerId, netQuantity, expectedVersion]));
}

export interface IpcCheckInput {
  batchId: string;
  pressCode: string;
  /** Null for a whole-press check. */
  stream?: string | null;
  result: IpcResult;
  /** The IPC record this result comes from (step or reading reference). */
  reference: string;
}

export interface IpcCheckOutcome {
  ipcCheckId: string;
  result: IpcResult;
  /** Database time of the last passing check the hold interval starts after, or null (from the first container). */
  lastPassingCheckAt: string | null;
  /** Labels held now. */
  held: string[];
  /** Labels of open containers, held when they are closed. */
  pending: string[];
  /** Labels of held containers already charged or packed (their consumers need assessment). */
  alreadyCharged: string[];
}

/** Records an in-process check; a FAIL or MISSED holds the containers whose open interval overlaps the bracket. */
export async function recordIpcCheck(db: Db, input: IpcCheckInput): Promise<IpcCheckOutcome> {
  const r = await one<{ ipc_check_id: string; result: IpcResult; last_passing_check_at?: string | null; held: string[]; pending: string[]; already_charged: string[] }>(
    db,
    'select plant.record_ipc_check($1, $2, $3, $4, $5) as r',
    [input.batchId, input.pressCode, input.stream ?? null, input.result, input.reference],
  );
  return {
    ipcCheckId: r.ipc_check_id,
    result: r.result,
    lastPassingCheckAt: r.last_passing_check_at ?? null,
    held: r.held,
    pending: r.pending,
    alreadyCharged: r.already_charged,
  };
}

interface TransitionResult {
  to: OutputContainerState;
  new_version: number | string;
}

const moved = (r: TransitionResult): { state: OutputContainerState; version: number } => ({ state: r.to, version: Number(r.new_version) });

/** HELD -> SORTED; the command carries the person's reason. */
export async function sortContainer(db: Db, containerId: string, expectedVersion: number): Promise<{ state: OutputContainerState; version: number }> {
  return moved(await one(db, 'select plant.sort_container($1, $2) as r', [containerId, expectedVersion]));
}

/** HELD or SORTED -> REJECTED by QA; the command carries the reason. */
export async function rejectContainer(db: Db, containerId: string, expectedVersion: number): Promise<{ state: OutputContainerState; version: number }> {
  return moved(await one(db, 'select plant.reject_container($1, $2) as r', [containerId, expectedVersion]));
}

/** The signature meaning of the second person's check of a typed net quantity (sql/0740, DI-30). */
export const CONTAINER_NET_VERIFY_MEANING = 'VERIFIED';

/**
 * A second person verifies the typed net quantity of a closed container with their VERIFIED signature on it (sql/0740,
 * DI-30): never the person who closed or opened it. Until then the container is not usable and cannot be released.
 */
export async function verifyContainerClose(db: Db, containerId: string, signatureId: string): Promise<{ labelCode: string; netQuantity: string; unit: QuantityUnit; verifiedBy: string }> {
  const r = await one<{ label_code: string; net_quantity: string; quantity_unit: QuantityUnit; verified_by: string }>(db, 'select plant.verify_container_close($1, $2) as r', [containerId, signatureId]);
  return { labelCode: r.label_code, netQuantity: r.net_quantity, unit: r.quantity_unit, verifiedBy: r.verified_by };
}

/** Why QA cannot release the container now (its hold's exception or deviation open, a typed net unverified), or null (sql/0741). */
export async function containerReleaseProblem(db: Db, containerId: string): Promise<string | null> {
  return one<string | null>(db, 'select plant.container_release_problem($1) as r', [containerId]);
}

/** HELD or SORTED -> RELEASED_BY_QA with the QA signature OUTPUT_CONTAINER_RELEASED. */
export async function releaseContainer(db: Db, containerId: string, expectedVersion: number, signatureId: string): Promise<{ state: OutputContainerState; version: number }> {
  return moved(await one(db, 'select plant.release_container($1, $2, $3) as r', [containerId, expectedVersion, signatureId]));
}

/** The charge (or pack) scan: refused for a label of another batch and for a container that is not usable. */
export async function chargeContainer(db: Db, batchId: string, stage: string, scannedLabel: string, purpose: ChargePurpose = 'CHARGE'): Promise<{ chargeId: string; containerId: string; netQuantity: string; unit: QuantityUnit }> {
  const r = await one<{ charge_id: string; container_id: string; net_quantity: string; quantity_unit: QuantityUnit }>(
    db,
    'select plant.charge_container($1, $2, $3, $4) as r',
    [batchId, stage, scannedLabel, purpose],
  );
  return { chargeId: r.charge_id, containerId: r.container_id, netQuantity: r.net_quantity, unit: r.quantity_unit };
}

export type BulkIssue = {
  batchId: string;
  parentBatchId: string;
  containers: { label: string; containerId: string; quantity: string; unit: QuantityUnit }[];
};

/**
 * Issues the processing batch's usable containers (by label) to the packaging order that packs it, once QA released
 * the batch for packing (H-PACK); each with its net quantity (sql/0701, exit review HIGH-3). All or nothing.
 */
export async function issuePackagingBulk(db: Db, orderBatchId: string, labels: readonly string[]): Promise<BulkIssue> {
  return one<BulkIssue>(db, 'select recipe.issue_packaging_bulk($1, $2::text[]) as r', [orderBatchId, labels]);
}

/** Pours a usable container into an open one of the same batch and stage (both scanned). */
export async function mergeContainer(db: Db, sourceLabel: string, targetLabel: string): Promise<{ mergeId: string }> {
  const r = await one<{ merge_id: string }>(db, 'select plant.merge_container($1, $2) as r', [sourceLabel, targetLabel]);
  return { mergeId: r.merge_id };
}

export interface ContainerStatus {
  containerId: string;
  labelCode: string;
  batchNumber: string;
  productCode: string;
  strength: string;
  stage: string;
  pressCode: string | null;
  stream: string | null;
  netQuantity: string | null;
  unit: QuantityUnit;
  state: OutputContainerState;
  version: number;
  /** Why it cannot be merged, charged or packed now; null when it can. */
  usableProblem: string | null;
}

export async function containerStatus(db: Db, containerId: string): Promise<ContainerStatus | null> {
  const { rows } = await db.query<Record<string, string | null>>(
    `select id, label_code, batch_number, product_code, strength, stage, press_code, stream, net_quantity::text as net_quantity, quantity_unit,
            state, version::text as version, usable_problem
       from plant.output_container_status where id = $1`,
    [containerId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    containerId: String(r['id']),
    labelCode: String(r['label_code']),
    batchNumber: String(r['batch_number']),
    productCode: String(r['product_code']),
    strength: String(r['strength']),
    stage: String(r['stage']),
    pressCode: r['press_code'] ?? null,
    stream: r['stream'] ?? null,
    netQuantity: r['net_quantity'] ?? null,
    unit: r['quantity_unit'] as QuantityUnit,
    state: r['state'] as OutputContainerState,
    version: Number(r['version']),
    usableProblem: r['usable_problem'] ?? null,
  };
}
