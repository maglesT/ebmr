/**
 * Test support for secret inputs (review P1 and CN2; DI-38, DI-19): finds every place a typed secret (password, PIN,
 * badge UID) is still kept once it has been handed over.
 *
 *  - `domTraces`: the input's value property, its value attribute (the default value React writes for a controlled
 *    input) and the serialised document.
 *  - `storageTraces`: localStorage and sessionStorage (decision D7: credentials never go to browser storage).
 *  - `reactTraces`: everything React keeps for the mounted trees: the props of every fiber (current and alternate),
 *    every hook's state (useState, useReducer, useRef, useMemo, effect dependencies), update queues and context
 *    values. Functions are skipped (a closure cannot be read), and so are DOM nodes (their value is what
 *    `domTraces` checks) and fibers reached from inside a value (they are walked as fibers).
 *
 * Both return the places where the secret was found, so a failing assertion names them; an empty list is a pass.
 * `reactTraces(secret, { allowRefs: true })` leaves out ref objects ({ current }): a ref is where a flow may keep a
 * secret between two steps on purpose (the badge until its PIN is typed, a change ticket until the new secret is
 * set); the strict default proves that nothing is left once the flow has handed the secret over.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const isFiber = (v: Obj): boolean => 'tag' in v && 'stateNode' in v && 'return' in v && 'child' in v && 'sibling' in v;
const isNode = (v: unknown): boolean => typeof Node !== 'undefined' && v instanceof Node;
/** A ref object from useRef or createRef: exactly one own property, `current`. */
const isRef = (v: Obj): boolean => {
  const keys = Object.getOwnPropertyNames(v);
  return keys.length === 1 && keys[0] === 'current';
};

interface Options {
  /** Leave out what refs hold (see above). */
  allowRefs?: boolean;
}

function fiberName(f: Obj): string {
  const type = f['type'];
  if (typeof type === 'string') return type;
  if (typeof type === 'function') return (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name ?? 'anonymous';
  if (isObj(type)) {
    const inner = type['render'] ?? type['type'];
    if (typeof inner === 'function') return (inner as { name?: string }).name ?? 'anonymous';
    if ('_context' in type || 'Provider' in type || 'Consumer' in type) return 'Context';
  }
  return `tag${String(f['tag'])}`;
}

/** Every place under `value` (not crossing into DOM nodes, fibers or functions) holding a string that contains the secret. */
function search(value: unknown, secret: string, path: string, seen: Set<object>, out: string[], depth: number, opts: Options): void {
  if (typeof value === 'string') {
    if (value.includes(secret)) out.push(path);
    return;
  }
  if (!isObj(value) || depth > 40 || seen.has(value) || isNode(value) || isFiber(value)) return;
  if (opts.allowRefs && isRef(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    for (const [k, v] of value) {
      search(k, secret, `${path}<key>`, seen, out, depth + 1, opts);
      search(v, secret, `${path}.get(${String(k)})`, seen, out, depth + 1, opts);
    }
    return;
  }
  if (value instanceof Set) {
    for (const v of value) search(v, secret, `${path}<item>`, seen, out, depth + 1, opts);
    return;
  }
  // Own properties, including non-enumerable ones and class-private-by-convention fields.
  for (const key of Object.getOwnPropertyNames(value)) {
    let v: unknown;
    try {
      v = value[key];
    } catch {
      continue;
    }
    search(v, secret, `${path}.${key}`, seen, out, depth + 1, opts);
  }
}

/** The HostRoot fibers of every React root rendered into the document (testing-library containers, portals included). */
function roots(): Obj[] {
  const found: Obj[] = [];
  for (const el of [document.body, ...Array.from(document.body.querySelectorAll('*'))]) {
    for (const key of Object.keys(el)) {
      if (!key.startsWith('__reactContainer$')) continue;
      const hostRoot = (el as unknown as Obj)[key];
      if (!isObj(hostRoot)) continue;
      const fiberRoot = hostRoot['stateNode'];
      const current = isObj(fiberRoot) && isObj(fiberRoot['current']) ? fiberRoot['current'] : hostRoot;
      found.push(current);
    }
  }
  return found;
}

/** Where React still keeps the secret for the mounted trees (current and alternate fibers). */
export function reactTraces(secret: string, opts: Options = {}): string[] {
  const out: string[] = [];
  const seenFibers = new Set<object>();
  const seenValues = new Set<object>();
  const stack = roots();
  if (stack.length === 0) throw new Error('reactTraces: no React root found in the document');
  while (stack.length > 0) {
    const f = stack.pop();
    if (!f || seenFibers.has(f)) continue;
    seenFibers.add(f);
    const name = fiberName(f);
    for (const field of ['memoizedProps', 'pendingProps', 'memoizedState', 'updateQueue', 'dependencies']) {
      search(f[field], secret, `<${name}>.${field}`, seenValues, out, 0, opts);
    }
    for (const next of ['child', 'sibling', 'alternate']) {
      const n = f[next];
      if (isObj(n)) stack.push(n);
    }
  }
  return out;
}

/** Where the DOM still shows the secret: the input's value, its value attribute, anywhere in the document. */
export function domTraces(input: HTMLInputElement, secret: string): string[] {
  const out: string[] = [];
  if (input.value.includes(secret)) out.push('input.value');
  if ((input.getAttribute('value') ?? '').includes(secret)) out.push('input[value] attribute');
  if (input.defaultValue.includes(secret)) out.push('input.defaultValue');
  if (document.documentElement.outerHTML.includes(secret)) out.push('document HTML');
  return out;
}

/** Which browser storage entries (localStorage, sessionStorage; keys or values) hold the secret (decision D7). */
export function storageTraces(secret: string): string[] {
  const out: string[] = [];
  for (const [name, store] of [
    ['localStorage', window.localStorage],
    ['sessionStorage', window.sessionStorage],
  ] as const) {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i) ?? '';
      if (key.includes(secret) || (store.getItem(key) ?? '').includes(secret)) out.push(`${name}[${key}]`);
    }
  }
  return out;
}
