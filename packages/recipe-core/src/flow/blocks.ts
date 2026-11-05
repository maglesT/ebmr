/**
 * What the validator needs to know about block types (outline 6.6).
 *
 * A phase is one configured instance of a block type version. The full block contract (schemas,
 * handler, renderers, simulator model, ...) belongs to the block registry; the static validator only
 * needs each version's roles (is it a clearance? a yield? a dispensing step?), whether it is a
 * significant step, and whether it may appear as a phase at all. Editions register their own blocks
 * (TB-xx, IB-xx) by extending the generic catalogue below.
 */
import type { Edition } from './model.ts';

export const BLOCK_ROLES = [
  'INSTRUCTION',
  'PARAMETER_RECORD',
  'OBSERVATION',
  'AUTOMATED_PHASE',
  'DISPENSING',
  'CHARGE_IN',
  'EQUIPMENT_STATUS_CHECK',
  'CLEARANCE',
  'ENVIRONMENT_CHECK',
  'SAMPLING',
  'IPC',
  'CALCULATION',
  'TIMER',
  'VERIFICATION',
  'YIELD_RECONCILIATION',
  'PRINTED_MATERIALS',
  'OUTPUT_CONTAINER',
  'RETURNS_DESTRUCTION',
  'REPROCESSING',
  'SIGN_OFF',
  'PAT',
] as const;
export type BlockRole = (typeof BLOCK_ROLES)[number];

export interface BlockDescriptor {
  /** Canonical type id: G-xx (generic), TB-xx (tablets), IB-xx (injectables). */
  type: string;
  /** Registered, non-retired versions. */
  versions: readonly string[];
  edition: 'generic' | Edition;
  title: string;
  roles: readonly BlockRole[];
  /** Significant by nature (PR-14): performer plus a different checker unless a declared reduction applies. */
  significant: boolean;
  /** False for blocks that are constructs or batch-level services rather than flow steps; the reason says what to use instead. */
  phase: { allowed: true } | { allowed: false; reason: string };
  /** Automated phases must name the computerised system and recipe version they rely on (DI-04). */
  requiresSystem: boolean;
}

export interface BlockCatalog {
  describe(type: string): BlockDescriptor | undefined;
  /** Every type the catalogue knows, for listings. */
  types(): readonly string[];
}

function g(
  type: string,
  title: string,
  roles: BlockRole[],
  options: { significant?: boolean; notPhase?: string; requiresSystem?: boolean; versions?: readonly string[] } = {},
): BlockDescriptor {
  return {
    type,
    versions: options.versions ?? ['1'],
    edition: 'generic',
    title,
    roles,
    significant: options.significant ?? false,
    phase: options.notPhase === undefined ? { allowed: true } : { allowed: false, reason: options.notPhase },
    requiresSystem: options.requiresSystem ?? false,
  };
}

/** The generic blocks G-01..G-25 (outline 6.6), version 1. Aliases: K-xx (tablets), KB-xx (injectables). */
export const GENERIC_BLOCKS: readonly BlockDescriptor[] = [
  g('G-01', 'Issuance and header', [], { notPhase: 'issuance happens when the batch is issued, before the flow starts' }),
  g('G-02', 'Stage frame and summary', [], { notPhase: 'every stage is a stage frame; declare a stage instead' }),
  g('G-03', 'Instruction and acknowledgement', ['INSTRUCTION']),
  g('G-04', 'Process parameter record', ['PARAMETER_RECORD']),
  g('G-05', 'Observation capture', ['OBSERVATION']),
  g('G-06', 'Automated equipment phase', ['AUTOMATED_PHASE'], { significant: true, requiresSystem: true }),
  g('G-07', 'Weighing and dispensing', ['DISPENSING'], { significant: true }),
  g('G-08', 'Identification and charge-in', ['CHARGE_IN'], { significant: true }),
  g('G-09', 'Equipment status, cleaning, logbook', ['EQUIPMENT_STATUS_CHECK'], { versions: ['1', '2'] }),
  g('G-10', 'Room/line status and clearance', ['CLEARANCE'], { significant: true, versions: ['1', '2'] }),
  g('G-11', 'Environmental condition check', ['ENVIRONMENT_CHECK']),
  g('G-12', 'Sampling', ['SAMPLING']),
  g('G-13', 'IPC with readings and statistics', ['IPC']),
  g('G-14', 'Calculation', ['CALCULATION']),
  g('G-15', 'Timer, hold time, transfer', ['TIMER']),
  g('G-16', 'Verification / witness', ['VERIFICATION']),
  g('G-17', 'QA hold point', [], { notPhase: 'use a hold point in the flow' }),
  g('G-18', 'Exception and deviation link', [], { notPhase: 'exceptions are raised by blocks and handled outside the flow; they are not steps' }),
  g('G-19', 'Flow control (incl. replicate)', [], { notPhase: 'use the flow constructs (parallel, alternative, loop, replicate)' }),
  g('G-20', 'Yield and reconciliation', ['YIELD_RECONCILIATION'], { significant: true }),
  g('G-21', 'Printed materials, coding, challenges, serialisation', ['PRINTED_MATERIALS'], { significant: true }),
  g('G-22', 'Output containers, holds, split/merge', ['OUTPUT_CONTAINER']),
  g('G-23', 'Returns, rejects, destruction', ['RETURNS_DESTRUCTION']),
  g('G-24', 'Reprocessing / rework gate', ['REPROCESSING'], { significant: true, versions: ['1', '2'] }),
  g('G-25', 'Sign-off, review, release and market disposition', ['SIGN_OFF']),
];

/** Edition aliases of the generic blocks (outline 6.6), for display. */
export const GENERIC_BLOCK_ALIASES: Readonly<Record<string, { tablets: string; injectables: string }>> = {
  'G-01': { tablets: 'K-01', injectables: 'KB-01' },
  'G-02': { tablets: 'K-02', injectables: '-' },
  'G-03': { tablets: 'K-03', injectables: 'KB-02' },
  'G-04': { tablets: 'K-04', injectables: 'KB-02' },
  'G-05': { tablets: 'K-05', injectables: 'KB-02' },
  'G-06': { tablets: 'K-06', injectables: 'KB-03' },
  'G-07': { tablets: 'K-07', injectables: 'KB-05' },
  'G-08': { tablets: 'K-08', injectables: 'KB-06' },
  'G-09': { tablets: 'K-09', injectables: 'KB-07' },
  'G-10': { tablets: 'K-10', injectables: 'KB-08' },
  'G-11': { tablets: 'K-11', injectables: 'IB-02/IB-05' },
  'G-12': { tablets: 'K-12', injectables: 'KB-09' },
  'G-13': { tablets: 'K-13', injectables: 'KB-09' },
  'G-14': { tablets: 'K-14', injectables: 'KB-04' },
  'G-15': { tablets: 'K-15', injectables: 'KB-10' },
  'G-16': { tablets: 'S-3', injectables: 'KB-11' },
  'G-17': { tablets: 'K-16', injectables: 'KB-12' },
  'G-18': { tablets: 'S-4', injectables: 'KB-13' },
  'G-19': { tablets: 'K-17/K-25', injectables: 'KB-14' },
  'G-20': { tablets: 'K-18', injectables: 'KB-15' },
  'G-21': { tablets: 'K-19..K-21', injectables: 'KB-17' },
  'G-22': { tablets: 'K-22/K-25', injectables: 'KB-16' },
  'G-23': { tablets: 'K-23', injectables: 'KB-18' },
  'G-24': { tablets: 'K-24', injectables: 'KB-18' },
  'G-25': { tablets: 'K-26', injectables: 'KB-19' },
};

/** Builds a catalogue; a type registered twice is a programming error. */
export function createBlockCatalog(...groups: readonly (readonly BlockDescriptor[])[]): BlockCatalog {
  const byType = new Map<string, BlockDescriptor>();
  for (const group of groups) {
    for (const d of group) {
      if (byType.has(d.type)) throw new Error(`block type ${d.type} is registered twice`);
      byType.set(d.type, d);
    }
  }
  const types = [...byType.keys()].sort();
  return {
    describe: (type) => byType.get(type),
    types: () => types,
  };
}

/** The generic catalogue alone (what recipe-core ships; editions extend it). */
export const genericBlockCatalog: BlockCatalog = createBlockCatalog(GENERIC_BLOCKS);
