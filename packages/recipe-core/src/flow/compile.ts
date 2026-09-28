/**
 * Compiler: expanded MBR flow tree -> execution graph (ADR 0004 decision 1).
 *
 * Each construct compiles to one single-entry single-exit fragment between its opener and closer, so
 * the graph is block-structured by construction. The validator still checks the compiled graph
 * independently (structure gates), which also guards against compiler defects.
 * Deterministic: node and edge ids and their order depend only on the tree.
 */
import { expandLibraryCalls, type ExpandedFlow } from './expand.ts';
import type { ExecutionGraph, GraphEdge, GraphNode, GraphNodeKind, GraphRegion, JoinRule, RegionKind } from './graph.ts';
import type { FlowNode, MbrContent } from './model.ts';

interface Fragment {
  first: string;
  last: string;
}

class Builder {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  readonly regions: GraphRegion[] = [];
  private readonly kinds = new Map<string, GraphNodeKind>();
  private edgeSeq = 0;

  node(id: string, kind: GraphNodeKind, source: string, regions: readonly string[], join: JoinRule): string {
    let unique = id;
    for (let n = 2; this.kinds.has(unique); n++) unique = `${id}#${n}`;
    this.nodes.push({ id: unique, kind, source, regions: [...regions], join });
    this.kinds.set(unique, kind);
    return unique;
  }

  pair(opener: string, closer: string): void {
    const a = this.nodes.find((n) => n.id === opener);
    const b = this.nodes.find((n) => n.id === closer);
    if (a) a.partner = closer;
    if (b) b.partner = opener;
  }

  edge(from: string, to: string, options: { back?: boolean; branch?: string } = {}): void {
    const fromKind = this.kinds.get(from);
    const kind: GraphEdge['kind'] = options.back ? 'LOOP_BACK' : fromKind === 'LOOP_TEST' ? 'LOOP_EXIT' : options.branch !== undefined ? 'BRANCH' : 'FLOW';
    const e: GraphEdge = { id: `e${++this.edgeSeq}`, from, to, kind };
    if (options.branch !== undefined) e.branch = options.branch;
    this.edges.push(e);
  }

  region(key: string, kind: RegionKind, construct: string, opener: string, closer: string, branch?: string): void {
    const r: GraphRegion = { key, kind, construct, opener, closer };
    if (branch !== undefined) r.branch = branch;
    this.regions.push(r);
  }
}

function compileNode(b: Builder, node: FlowNode, regions: readonly string[]): Fragment | undefined {
  switch (node.kind) {
    case 'phase': {
      const id = b.node(`task:${node.id}`, 'TASK', node.id, regions, 'SINGLE');
      return { first: id, last: id };
    }
    case 'holdPoint': {
      const id = b.node(`hold:${node.id}`, 'HOLD', node.id, regions, 'SINGLE');
      return { first: id, last: id };
    }
    case 'libraryCall':
      // Expansion replaces every call; an unexpanded call contributes nothing (the validator reports why).
      return undefined;
    case 'sequence': {
      const parts = node.children.map((c) => compileNode(b, c, regions)).filter((f): f is Fragment => f !== undefined);
      if (parts.length === 0) return undefined;
      for (let i = 0; i + 1 < parts.length; i++) b.edge((parts[i] as Fragment).last, (parts[i + 1] as Fragment).first);
      return { first: (parts[0] as Fragment).first, last: (parts[parts.length - 1] as Fragment).last };
    }
    case 'stage':
    case 'operation': {
      const kind: RegionKind = node.kind === 'stage' ? 'STAGE' : 'OPERATION';
      const key = `${node.kind}:${node.id}`;
      const open = b.node(`scope-start:${node.id}`, 'SCOPE_START', node.id, regions, 'SINGLE');
      const body = compileNode(b, node.body, [...regions, key]);
      const close = b.node(`scope-end:${node.id}`, 'SCOPE_END', node.id, regions, 'SINGLE');
      b.pair(open, close);
      b.region(key, kind, node.id, open, close);
      if (body) {
        b.edge(open, body.first);
        b.edge(body.last, close);
      } else b.edge(open, close);
      return { first: open, last: close };
    }
    case 'parallel':
    case 'alternative': {
      const parallel = node.kind === 'parallel';
      const split = b.node(`${parallel ? 'and' : 'xor'}-split:${node.id}`, parallel ? 'AND_SPLIT' : 'XOR_SPLIT', node.id, regions, 'SINGLE');
      const bodies: { branch: string; key: string; frag: Fragment | undefined }[] = [];
      for (const branch of node.branches) {
        const key = `${parallel ? 'branch' : 'alt'}:${node.id}#${branch.id}`;
        const frag = branch.body ? compileNode(b, branch.body, [...regions, key]) : undefined;
        bodies.push({ branch: branch.id, key, frag });
      }
      const join = b.node(`${parallel ? 'and' : 'xor'}-join:${node.id}`, parallel ? 'AND_JOIN' : 'XOR_JOIN', node.id, regions, parallel ? 'ALL' : 'ANY');
      b.pair(split, join);
      for (const { branch, key, frag } of bodies) {
        b.region(key, parallel ? 'PARALLEL_BRANCH' : 'ALTERNATIVE_BRANCH', node.id, split, join, branch);
        if (frag) {
          b.edge(split, frag.first, { branch });
          b.edge(frag.last, join);
        } else b.edge(split, join, { branch });
      }
      return { first: split, last: join };
    }
    case 'loop': {
      const key = `loop:${node.id}`;
      const entry = b.node(`loop-entry:${node.id}`, 'LOOP_ENTRY', node.id, regions, 'ENTRY_OR_BACK');
      const body = compileNode(b, node.body, [...regions, key]);
      const test = b.node(`loop-test:${node.id}`, 'LOOP_TEST', node.id, regions, 'SINGLE');
      b.pair(entry, test);
      b.region(key, 'LOOP_BODY', node.id, entry, test);
      if (body) {
        b.edge(entry, body.first);
        b.edge(body.last, test);
      } else b.edge(entry, test);
      b.edge(test, entry, { back: true });
      return { first: entry, last: test };
    }
    case 'replicate': {
      const key = `rep:${node.id}`;
      const split = b.node(`rep-split:${node.id}`, 'REP_SPLIT', node.id, regions, 'SINGLE');
      const body = compileNode(b, node.body, [...regions, key]);
      const join = b.node(`rep-join:${node.id}`, 'REP_JOIN', node.id, regions, 'ALL_INSTANCES');
      b.pair(split, join);
      b.region(key, 'REPLICATE_BODY', node.id, split, join);
      if (body) {
        b.edge(split, body.first);
        b.edge(body.last, join);
      } else b.edge(split, join);
      return { first: split, last: join };
    }
  }
}

/** Compiles an (already expanded) flow tree rooted at the procedure body. */
export function compileFlow(procedureId: string, root: FlowNode): ExecutionGraph {
  const b = new Builder();
  const start = b.node('start', 'START', procedureId, [], 'SINGLE');
  const body = compileNode(b, root, []);
  const end = b.node('end', 'END', procedureId, [], 'SINGLE');
  if (body) {
    b.edge(start, body.first);
    b.edge(body.last, end);
  } else b.edge(start, end);
  return { start, end, nodes: b.nodes, edges: b.edges, regions: b.regions };
}

export interface CompiledMbr {
  expanded: ExpandedFlow;
  graph: ExecutionGraph;
}

/** Expands library calls and compiles the procedure. */
export function compileMbr(mbr: MbrContent): CompiledMbr {
  const expanded = expandLibraryCalls(mbr);
  return { expanded, graph: compileFlow(mbr.procedure.id, expanded.root) };
}
