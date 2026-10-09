/**
 * Library-call expansion (outline 6.2 "library calls to pinned element versions"; 6.5).
 *
 * A library call names a reference (kind LIBRARY_ELEMENT, pinned by version and hash) and binds the
 * element's symbols to items of this MBR. The MBR embeds the element snapshot; expansion checks that
 * the snapshot's hash equals the pin, then inlines the body under a sequence node carrying the call's
 * id. Inlined node ids are prefixed with the call path ("call/inner"), id lists are renamed through
 * the binding, and expressions keep their local names with an identifier environment (local -> MBR
 * id), so every later gate sees library content exactly as if written in place.
 */
import { libraryElementHash } from './canonical.ts';
import type { FlowNode, LibraryCallNode, LibraryElement, MbrContent, PhaseNode } from './model.ts';

export interface ExpansionProblem {
  code: 'LIB_UNKNOWN' | 'LIB_NOT_PINNED' | 'LIB_HASH_MISMATCH' | 'LIB_UNBOUND_SYMBOL' | 'LIB_UNDECLARED_SYMBOL' | 'LIB_RECURSION' | 'LIB_DEPTH' | 'LIB_LEVEL';
  nodeId: string;
  message: string;
}

export interface LibraryScope {
  /** Id of the outermost call this node was inlined through. */
  callId: string;
  /** Reference id of the element whose body the node comes from. */
  element: string;
  /** Local identifier -> MBR identifier, for expressions written inside the element. */
  env: ReadonlyMap<string, string>;
}

export interface ExpandedFlow {
  root: FlowNode;
  /** Library scope of every inlined node, by expanded node id. */
  scopes: ReadonlyMap<string, LibraryScope>;
  problems: ExpansionProblem[];
}

const MAX_DEPTH = 8;

type Level = 'PROCEDURE' | 'STAGE' | 'OPERATION';

interface Frame {
  prefix: string;
  env: Map<string, string> | undefined;
  symbols: ReadonlySet<string> | undefined;
  element: string | undefined;
  callId: string | undefined;
  stack: string[];
}

export function expandLibraryCalls(mbr: MbrContent): ExpandedFlow {
  const problems: ExpansionProblem[] = [];
  const scopes = new Map<string, LibraryScope>();
  const snapshots = new Map<string, LibraryElement>(mbr.library.map((e) => [e.ref, e]));
  const refs = new Map(mbr.references.map((r) => [r.id, r]));

  const rename = (frame: Frame, id: string): string => (frame.prefix ? `${frame.prefix}/${id}` : id);

  /** Maps a symbol used inside an element to the MBR item it is bound to. Outside elements it is the identity. */
  const bindSymbol = (frame: Frame, symbol: string, nodeId: string): string => {
    if (!frame.env || !frame.symbols) return symbol;
    if (!frame.symbols.has(symbol)) {
      problems.push({
        code: 'LIB_UNDECLARED_SYMBOL',
        nodeId,
        message: `Library element ${frame.element ?? '?'} uses "${symbol}" without declaring it as a symbol`,
      });
      return symbol;
    }
    const bound = frame.env.get(symbol);
    if (bound === undefined) {
      problems.push({ code: 'LIB_UNBOUND_SYMBOL', nodeId, message: `Library call ${frame.callId ?? '?'} does not bind symbol "${symbol}"` });
      return symbol;
    }
    return bound;
  };

  const record = (frame: Frame, id: string): void => {
    if (frame.env && frame.element && frame.callId) scopes.set(id, { callId: frame.callId, element: frame.element, env: frame.env });
  };

  const expandPhase = (p: PhaseNode, frame: Frame): PhaseNode => {
    const id = rename(frame, p.id);
    record(frame, id);
    const b = (s: string): string => bindSymbol(frame, s, id);
    const out: PhaseNode = {
      ...p,
      id,
      records: p.records.map(b),
      computes: p.computes.map(b),
      reads: p.reads.map(b),
      consumes: p.consumes.map(b),
      produces: p.produces.map(b),
      uses: p.uses.map(b),
      equipment: p.equipment.map((e) => ({ ref: b(e.ref), use: e.use })),
    };
    if (p.yieldCheckpoint !== undefined) out.yieldCheckpoint = b(p.yieldCheckpoint);
    if (p.acceptanceScheme !== undefined) out.acceptanceScheme = b(p.acceptanceScheme);
    return out;
  };

  const expandCall = (call: LibraryCallNode, frame: Frame, level: Level): FlowNode => {
    const id = rename(frame, call.id);
    record(frame, id);
    const ref = refs.get(call.element);
    const snapshot = snapshots.get(call.element);
    const empty: FlowNode = { kind: 'sequence', id, children: [] };
    if (!ref || ref.kind !== 'LIBRARY_ELEMENT' || !snapshot) {
      problems.push({ code: 'LIB_UNKNOWN', nodeId: id, message: `Library call ${id} names element ${call.element}, which is not a pinned library reference with an embedded snapshot` });
      return empty;
    }
    if (ref.hash === undefined) {
      problems.push({ code: 'LIB_NOT_PINNED', nodeId: id, message: `Library element ${call.element} is not pinned by hash` });
      return empty;
    }
    const actual = libraryElementHash(snapshot);
    if (actual !== ref.hash) {
      problems.push({
        code: 'LIB_HASH_MISMATCH',
        nodeId: id,
        message: `Library element ${call.element} v${ref.version}: the embedded snapshot does not match its pinned hash`,
      });
      return empty;
    }
    if (frame.stack.includes(call.element)) {
      problems.push({ code: 'LIB_RECURSION', nodeId: id, message: `Library element ${call.element} calls itself (${[...frame.stack, call.element].join(' -> ')})` });
      return empty;
    }
    if (frame.stack.length >= MAX_DEPTH) {
      problems.push({ code: 'LIB_DEPTH', nodeId: id, message: `Library calls are nested more than ${MAX_DEPTH} deep at ${id}` });
      return empty;
    }
    if ((snapshot.level === 'STAGE' && level !== 'STAGE') || (snapshot.level === 'OPERATION' && level !== 'OPERATION')) {
      problems.push({
        code: 'LIB_LEVEL',
        nodeId: id,
        message: `Library element ${call.element} holds ${snapshot.level === 'STAGE' ? 'operations' : 'phases'} but is called at ${level.toLowerCase()} level`,
      });
      return empty;
    }
    // Compose the environment: element symbol -> (outer symbol ->) MBR id.
    const env = new Map<string, string>();
    for (const symbol of snapshot.symbols) {
      const local = call.bind[symbol];
      if (local === undefined) {
        problems.push({ code: 'LIB_UNBOUND_SYMBOL', nodeId: id, message: `Library call ${id} does not bind symbol "${symbol}" of element ${call.element}` });
        continue;
      }
      env.set(symbol, bindSymbol(frame, local, id));
    }
    for (const key of Object.keys(call.bind)) {
      if (!snapshot.symbols.includes(key)) {
        problems.push({ code: 'LIB_UNDECLARED_SYMBOL', nodeId: id, message: `Library call ${id} binds "${key}", which element ${call.element} does not declare` });
      }
    }
    const inner: Frame = {
      prefix: id,
      env,
      symbols: new Set(snapshot.symbols),
      element: call.element,
      callId: frame.callId ?? id,
      stack: [...frame.stack, call.element],
    };
    return { kind: 'sequence', id, children: [expand(snapshot.body, inner, level)] };
  };

  const expand = (node: FlowNode, frame: Frame, level: Level): FlowNode => {
    switch (node.kind) {
      case 'phase':
        return expandPhase(node, frame);
      case 'libraryCall':
        return expandCall(node, frame, level);
      case 'holdPoint': {
        const id = rename(frame, node.id);
        record(frame, id);
        return { ...node, id };
      }
      case 'stage': {
        const id = rename(frame, node.id);
        record(frame, id);
        return { ...node, id, body: expand(node.body, frame, 'STAGE') };
      }
      case 'operation': {
        const id = rename(frame, node.id);
        record(frame, id);
        return { ...node, id, body: expand(node.body, frame, 'OPERATION') };
      }
      case 'sequence': {
        const id = rename(frame, node.id);
        record(frame, id);
        return { ...node, id, children: node.children.map((c) => expand(c, frame, level)) };
      }
      case 'parallel': {
        const id = rename(frame, node.id);
        record(frame, id);
        return { ...node, id, branches: node.branches.map((b) => ({ id: rename(frame, b.id), name: b.name, body: expand(b.body, frame, level) })) };
      }
      case 'alternative': {
        const id = rename(frame, node.id);
        record(frame, id);
        const decision = node.decision.mode === 'ISSUE_VARIANT' ? { mode: 'ISSUE_VARIANT' as const, variant: bindSymbol(frame, node.decision.variant, id) } : node.decision;
        return {
          ...node,
          id,
          decision,
          branches: node.branches.map((b) => {
            const out = { ...b, id: rename(frame, b.id) };
            if (b.body) out.body = expand(b.body, frame, level);
            return out;
          }),
        };
      }
      case 'loop': {
        const id = rename(frame, node.id);
        record(frame, id);
        return { ...node, id, body: expand(node.body, frame, level), exit: { condition: node.exit.condition, endpoint: bindSymbol(frame, node.exit.endpoint, id) } };
      }
      case 'replicate': {
        const id = rename(frame, node.id);
        record(frame, id);
        return { ...node, id, body: expand(node.body, frame, level) };
      }
    }
  };

  const root = expand(mbr.procedure.body, { prefix: '', env: undefined, symbols: undefined, element: undefined, callId: undefined, stack: [] }, 'PROCEDURE');
  return { root, scopes, problems };
}

/** Resolves an identifier read by an expression written at `nodeId` to the MBR item it means. */
export function resolveIdentifier(expanded: ExpandedFlow, nodeId: string, identifier: string): string {
  return expanded.scopes.get(nodeId)?.env.get(identifier) ?? identifier;
}
