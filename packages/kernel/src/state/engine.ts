/**
 * TypeScript access to the state-machine engine (platform.create_aggregate_state,
 * platform.transition). Call these inside a command (withCommand / withIdempotentCommand) so the
 * transition commits together with the business change it belongs to. The database decides:
 * a stale version (EBMR-PLAT-066), an event not allowed in the current state (067), a failed
 * guard (068), a missing permission (005/006) or signature (007/008) refuses the whole command.
 */
import type pg from 'pg';
import { asKernelError } from '../commands/errors.ts';
import type { JsonValue } from '../commands/json.ts';

export interface AggregateRef {
  aggregateType: string;
  aggregateId: string;
}

export interface AggregateState extends AggregateRef {
  machine: string;
  machineVersion: number;
  state: string;
  /** Optimistic-lock version; pass it as expectedVersion to the next transition. */
  version: number;
}

export interface GuardResult {
  guard: string;
  passed: boolean;
  reason: string | null;
}

export interface TransitionResult extends AggregateRef {
  machine: string;
  machineVersion: number;
  from: string;
  event: string;
  to: string;
  newVersion: number;
  historyId: string;
  messageId: string;
  guardResults: GuardResult[];
}

export interface TransitionRequest extends AggregateRef {
  machine: string;
  event: string;
  expectedVersion: number;
  /** Command data kept in the history row; `signature_id` when the transition needs a signature. */
  payload?: { [key: string]: JsonValue };
}

type Db = pg.Pool | pg.PoolClient;

export async function createAggregateState(client: pg.PoolClient, machine: string, ref: AggregateRef, machineVersion?: number): Promise<AggregateState> {
  try {
    const { rows } = await client.query<{ r: { machine: string; machine_version: number; state: string; version: number } }>(
      'select platform.create_aggregate_state($1, $2, $3, $4) as r',
      [machine, ref.aggregateType, ref.aggregateId, machineVersion ?? null],
    );
    const r = rows[0]?.r;
    if (!r) throw new Error('platform.create_aggregate_state returned nothing');
    return { ...ref, machine: r.machine, machineVersion: r.machine_version, state: r.state, version: r.version };
  } catch (error) {
    throw asKernelError(error);
  }
}

export async function transition(client: pg.PoolClient, request: TransitionRequest): Promise<TransitionResult> {
  try {
    const { rows } = await client.query<{ r: Record<string, unknown> }>('select platform.transition($1, $2, $3, $4, $5, $6::jsonb) as r', [
      request.machine,
      request.aggregateType,
      request.aggregateId,
      request.event,
      request.expectedVersion,
      JSON.stringify(request.payload ?? {}),
    ]);
    const r = rows[0]?.r;
    if (!r) throw new Error('platform.transition returned nothing');
    return {
      aggregateType: String(r['aggregate_type']),
      aggregateId: String(r['aggregate_id']),
      machine: String(r['machine']),
      machineVersion: Number(r['machine_version']),
      from: String(r['from']),
      event: String(r['event']),
      to: String(r['to']),
      newVersion: Number(r['new_version']),
      historyId: String(r['history_id']),
      messageId: String(r['message_id']),
      guardResults: (r['guard_results'] as GuardResult[] | undefined) ?? [],
    };
  } catch (error) {
    throw asKernelError(error);
  }
}

export async function getAggregateState(db: Db, ref: AggregateRef): Promise<AggregateState | undefined> {
  const { rows } = await db.query<{ machine_code: string; machine_version: number; state: string; version: string }>(
    'select machine_code, machine_version, state, version::text from platform.aggregate_state where aggregate_type = $1 and aggregate_id = $2',
    [ref.aggregateType, ref.aggregateId],
  );
  const r = rows[0];
  return r ? { ...ref, machine: r.machine_code, machineVersion: r.machine_version, state: r.state, version: Number(r.version) } : undefined;
}
