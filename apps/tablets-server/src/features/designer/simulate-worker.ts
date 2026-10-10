/**
 * The designer's simulation worker (module C2; node:worker_threads). Runs recipe-core's simulator on one MBR content
 * with ports rebuilt from pre-loaded data (reference rows, resolved market minima, engine roles, the site date), so a large or
 * pathological record cannot block the server's event loop; the parent terminates it after the timeout.
 * No database, no clock, no writes: the output is a SIMULATION, never a GMP record (DI-05).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { flow, simulator, type validator } from '@ebmr/recipe-core/pure';
import { tabletsBlockCatalog } from '../edition-blocks.ts';
import { marketMinimaPortFrom } from './adapters/minima-port.ts';
import { referencePortFrom, type ReferenceRow } from './adapters/references.ts';

export interface SimulationJob {
  content: unknown;
  asOf: string;
  references: ReferenceRow[];
  minimaRequest: validator.MinimaRequest;
  minima: validator.ResolvedMinimum[];
  /** The installation's engine roles (FLOW-ROLES; review F49). */
  engineRoles: string[];
  /** Of them, those in which a person may give a witness and a later review (T12.DOC round 4). */
  checkers: flow.CheckerRoles;
}

export type SimulationResult = { ok: true; report: simulator.SimulationReport } | { ok: false; message: string };

export function runSimulationJob(job: SimulationJob): SimulationResult {
  const parsed = flow.parseMbr(job.content);
  if (!parsed.ok) return { ok: false, message: `the content does not parse: ${parsed.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}` };
  const context: validator.ValidationContext = {
    expressions: flow.createExprService(),
    blocks: tabletsBlockCatalog,
    references: referencePortFrom(job.references, job.asOf),
    market: marketMinimaPortFrom(job.minimaRequest, job.minima),
    roles: { engineRoles: job.engineRoles, checkers: job.checkers },
    asOf: job.asOf,
  };
  try {
    return { ok: true, report: simulator.simulate(parsed.mbr, context) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

const data = workerData as { job?: SimulationJob } | null;
if (parentPort && data?.job) parentPort.postMessage(runSimulationJob(data.job));
