/**
 * Shared pieces of the forming blocks of Phase 3 slice 3d (builder B): TB-06 dry granulation by roller compaction and
 * TB-16 bilayer compression (tablets spec section B.2).
 *
 * Both run on interfaced process equipment and take G-06's configuration members and entry kinds unchanged (the
 * granulation common module), so their process values stand on the same rules as every other G-06 value. TB-16 also
 * runs the IPC scheduler of TB-11 once per layer (layerView): each layer is a stream with its own test plan and its own
 * test configurations (layer-only weight samples apart from the full tablets), judged by TB-12 to TB-15's modules, never
 * a copy. GMP values are decimal text; instants are epoch microseconds (bigint).
 */
import type { HandlerView } from '../granulation/common.ts';

export * from '../ipc/common.ts';

/** The view of a step as another block's handler sees it: the same entries and person, another phase and configuration. */
export function viewAs(view: HandlerView, blockType: string, config: Readonly<Record<string, unknown>>): HandlerView {
  return {
    phase: { ...view.phase, block: { type: blockType, version: '1' } },
    config: config as HandlerView['config'],
    stepKey: view.stepKey,
    frames: view.frames,
    subLot: view.subLot,
    nowUs: view.nowUs,
    actor: view.actor,
    batch: view.batch,
    mbr: view.mbr,
    expr: view.expr,
    entries: (kind?: string) => view.entries(kind),
    points: (item: string) => view.points(item),
    effective: (item: string) => view.effective(item),
    target: (item: string) => view.target(item),
    containers: () => view.containers(),
    parameter: (id: string) => view.parameter(id),
  };
}

/** A container stage code (plant.output_container.stage). */
export const STAGE = /^[A-Z][A-Z0-9_]{0,39}$/;
