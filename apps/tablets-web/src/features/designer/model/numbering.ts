/**
 * The numbering of the designer document (module C2). flow.numberMbr refuses content it cannot number: a library
 * call of an element the master does not embed, an element that calls itself, two nodes with one id. Such content is
 * well formed (the parser takes it; the validator refuses it with FLOW-LIBRARY or FLOW-ID-UNIQUE), so the designer
 * must still show it (review F46): calls that cannot be expanded are numbered as if empty, and when even that fails
 * the document shows no numbers. `problem` says why, for the document to show.
 */
import { flow } from '@ebmr/recipe-core/pure';

export interface DocumentNumbering {
  numbering: flow.MbrNumbering;
  problem: string | null;
}

const EMPTY: flow.MbrNumbering = { stages: [], operations: [], steps: [], byId: new Map(), constructs: new Map(), totalSteps: 0 };

/** The tree with every library call replaced by an empty sequence of the same id. */
function withoutCalls(n: flow.FlowNode): flow.FlowNode {
  switch (n.kind) {
    case 'libraryCall':
      return { kind: 'sequence', id: n.id, children: [] };
    case 'sequence':
      return { ...n, children: n.children.map(withoutCalls) };
    case 'stage':
    case 'operation':
    case 'loop':
    case 'replicate':
      return { ...n, body: withoutCalls(n.body) };
    case 'parallel':
      return { ...n, branches: n.branches.map((b) => ({ ...b, body: withoutCalls(b.body) })) };
    case 'alternative':
      return { ...n, branches: n.branches.map((b) => (b.body ? { ...b, body: withoutCalls(b.body) } : b)) };
    case 'phase':
    case 'holdPoint':
      return n;
  }
}

export function documentNumbering(c: flow.MbrContent): DocumentNumbering {
  try {
    return { numbering: flow.numberMbr(c), problem: null };
  } catch (e) {
    if (!(e instanceof flow.NumberingError)) throw e;
    try {
      return { numbering: flow.numberFlow(withoutCalls(c.procedure.body)), problem: `${e.message}; the steps of its library calls are shown without numbers.` };
    } catch (again) {
      if (!(again instanceof flow.NumberingError)) throw again;
      return { numbering: EMPTY, problem: `${again.message}; the procedure is shown without numbers.` };
    }
  }
}
