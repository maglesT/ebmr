/**
 * Document numbering of an MBR procedure (Phase 2 apps plan sections 4 and 8): stage `2`, operation
 * `2.1`, step `2.1.3`, like the numbered procedure table of a paper batch record. Pure; used by the
 * designer's document view and by the step screen ("Step 2.1.3 of 13").
 *
 * Rules:
 *  - Stages, operations and steps (phases and hold points) are numbered in document order, one
 *    counter per enclosing numbered element: a stage's children (operations, or steps placed directly
 *    in the stage) share one counter, and so do the procedure's top-level children (stages, or a
 *    final hold point placed outside any stage). Every number therefore names exactly one element.
 *  - Constructs (sequence, parallel, alternative, loop, replicate) and library calls take no number of
 *    their own: their contents are numbered in document order within the enclosing element. Every
 *    branch of an alternative is numbered, taken or not.
 *  - Library content is numbered under its expanded id (`call/inner`, as the engine names it).
 *  - A step instance inside a loop or a replicate section gets a suffix from its frames:
 *    `2.1.3 (sub-lot 2, iteration 3)`. The number itself never changes between instances.
 */
import { childrenOf, type FlowNode, type LibraryElement, type MbrContent } from './model.ts';
import type { Frame } from './tokens.ts';

export type NumberedKind = 'STAGE' | 'OPERATION' | 'PHASE' | 'HOLD';

export interface NumberedNode {
  /** Node id (expanded id `call/inner` for library content). */
  id: string;
  kind: NumberedKind;
  /** Document number, e.g. `2`, `2.1`, `2.1.3`. */
  number: string;
  name: string;
  /** Enclosing stage and operation ids, when there are any. */
  stage?: string;
  operation?: string;
  /** Position of a step among all steps of the procedure (1-based, document order). */
  ordinal?: number;
  /** Block type@version of a phase (e.g. `G-04@1`). */
  block?: string;
}

export interface MbrNumbering {
  stages: readonly NumberedNode[];
  operations: readonly NumberedNode[];
  /** Phases and hold points in document order. */
  steps: readonly NumberedNode[];
  byId: ReadonlyMap<string, NumberedNode>;
  /** Loop and replicate constructs by (expanded) id, for instance suffixes. */
  constructs: ReadonlyMap<string, 'LOOP' | 'REPLICATE'>;
  totalSteps: number;
}

export interface InstanceNumber {
  /** The step's document number, e.g. `2.1.3`. */
  number: string;
  /** Loop iteration and sub-lot of this instance, e.g. `sub-lot 2, iteration 3` (empty at the top level). */
  suffix: string;
  /** Number and suffix, e.g. `2.1.3 (sub-lot 2, iteration 3)`. */
  text: string;
}

export class NumberingError extends Error {}

interface Scope {
  number: string;
  counter: { n: number };
  stage?: string;
  operation?: string;
  idPrefix: string;
  /** Library element refs being expanded (a recursive call is refused, as the parser does). */
  calls: readonly string[];
}

/** Numbers the procedure of an MBR. */
export function numberMbr(mbr: Pick<MbrContent, 'procedure' | 'library'>): MbrNumbering {
  return numberFlow(mbr.procedure.body, mbr.library);
}

/** Numbers a flow tree; `library` resolves library calls (their contents are numbered in place). */
export function numberFlow(body: FlowNode, library: readonly LibraryElement[] = []): MbrNumbering {
  const stages: NumberedNode[] = [];
  const operations: NumberedNode[] = [];
  const steps: NumberedNode[] = [];
  const byId = new Map<string, NumberedNode>();
  const constructs = new Map<string, 'LOOP' | 'REPLICATE'>();
  const libraryByRef = new Map(library.map((l) => [l.ref, l]));

  const add = (node: NumberedNode, list: NumberedNode[]): void => {
    if (byId.has(node.id)) throw new NumberingError(`node id ${node.id} occurs twice; numbering needs unique ids`);
    byId.set(node.id, node);
    list.push(node);
  };
  const next = (scope: Scope): string => {
    scope.counter.n += 1;
    return scope.number ? `${scope.number}.${scope.counter.n}` : String(scope.counter.n);
  };
  const where = (scope: Scope): Pick<NumberedNode, 'stage' | 'operation'> => ({
    ...(scope.stage !== undefined ? { stage: scope.stage } : {}),
    ...(scope.operation !== undefined ? { operation: scope.operation } : {}),
  });

  const visit = (node: FlowNode, scope: Scope): void => {
    const id = `${scope.idPrefix}${node.id}`;
    switch (node.kind) {
      case 'stage': {
        const number = next(scope);
        add({ id, kind: 'STAGE', number, name: node.name, ...where(scope) }, stages);
        visit(node.body, { number, counter: { n: 0 }, stage: id, idPrefix: scope.idPrefix, calls: scope.calls });
        return;
      }
      case 'operation': {
        const number = next(scope);
        add({ id, kind: 'OPERATION', number, name: node.name, ...where(scope) }, operations);
        visit(node.body, { ...scope, number, counter: { n: 0 }, operation: id });
        return;
      }
      case 'phase':
        add({ id, kind: 'PHASE', number: next(scope), name: node.name, ...where(scope), ordinal: steps.length + 1, block: `${node.block.type}@${node.block.version}` }, steps);
        return;
      case 'holdPoint':
        add({ id, kind: 'HOLD', number: next(scope), name: node.name, ...where(scope), ordinal: steps.length + 1 }, steps);
        return;
      case 'libraryCall': {
        const element = libraryByRef.get(node.element);
        if (!element) throw new NumberingError(`library call ${id} names ${node.element}, which the MBR does not embed`);
        if (scope.calls.includes(node.element)) throw new NumberingError(`library element ${node.element} calls itself`);
        visit(element.body, { ...scope, idPrefix: `${id}/`, calls: [...scope.calls, node.element] });
        return;
      }
      case 'loop':
      case 'replicate':
        constructs.set(id, node.kind === 'loop' ? 'LOOP' : 'REPLICATE');
        for (const child of childrenOf(node)) visit(child, scope);
        return;
      case 'sequence':
      case 'parallel':
      case 'alternative':
        for (const child of childrenOf(node)) visit(child, scope);
        return;
    }
  };

  visit(body, { number: '', counter: { n: 0 }, idPrefix: '', calls: [] });
  return { stages, operations, steps, byId, constructs, totalSteps: steps.length };
}

/** The number of one step instance, with its loop iteration and sub-lot suffix. */
export function instanceNumber(numbering: MbrNumbering, stepId: string, frames: readonly Frame[] = []): InstanceNumber {
  const node = numbering.byId.get(stepId);
  if (!node || (node.kind !== 'PHASE' && node.kind !== 'HOLD')) throw new NumberingError(`${stepId} is not a step of this MBR`);
  const parts = frames.map((f) => {
    const kind = numbering.constructs.get(f.construct);
    if (kind === 'REPLICATE') return `sub-lot ${f.index}`;
    if (kind === 'LOOP') return `iteration ${f.index}`;
    return `${f.construct} ${f.index}`;
  });
  const suffix = parts.join(', ');
  return { number: node.number, suffix, text: suffix ? `${node.number} (${suffix})` : node.number };
}
