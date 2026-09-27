/**
 * GMP state machines are defined once, as XState 5 machines (build outline 5.2; ADR 0012).
 *
 * A machine used for GMP records is flat (no nested, parallel or history states), has one
 * target per event and state, and no actions, delays or eventless transitions: its only job is
 * to describe the allowed moves. The database is the authority that enforces them; the
 * transition table is generated from this definition (see seed.ts) and a test proves both agree.
 *
 * Guards, the required signature meaning and the required permission are data on each
 * transition (`meta`), written with `gmp()`. Guard codes name SQL guard functions registered in
 * platform.state_guard; they run on the server inside the transition.
 */
import type { AnyStateMachine } from 'xstate';

export interface GmpTransitionMeta {
  /** Codes of registered SQL guards, evaluated in this order. */
  guards: string[];
  /** Signature meaning required for the transition (e.g. APPROVED), or null. */
  signature: string | null;
  /** Permission the actor must hold (e.g. sample_record.approve), or null. */
  permission: string | null;
}

export interface GmpTransitionOptions {
  guards?: readonly string[];
  signature?: string;
  permission?: string;
}

/** An XState transition config carrying the GMP metadata. */
export function gmp(target: string, options: GmpTransitionOptions = {}): { target: string; meta: GmpTransitionMeta } {
  return {
    target,
    meta: {
      guards: [...(options.guards ?? [])],
      signature: options.signature ?? null,
      permission: options.permission ?? null,
    },
  };
}

export interface MachineDescriptor {
  /** Machine code in the database (platform.machine.code); equals the XState machine id. */
  code: string;
  /** Published version. A published version is immutable: a change gets a new version. */
  version: number;
  /** Aggregate type whose records follow this machine (e.g. sample_record, batch). */
  aggregateType: string;
  description: string;
  machine: AnyStateMachine;
  /** File name of the generated migration that publishes this version, e.g. 0552_machine_sample_record_v1.sql. */
  seedFile: string;
}
