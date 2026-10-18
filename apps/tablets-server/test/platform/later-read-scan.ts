/**
 * The routes whose handler commits a command with withIdempotentActorCommand and then reads its answer outside it
 * (owner observation O-T13-1), found in the server's source with the TypeScript parser: for each call of
 * withIdempotentActorCommand, the handler it is in (a property of the object of handlers a feature binds) and whether a
 * statement after the call does more work (a later read). Also the command calls after it that the request's command
 * scope does not see (withCommand, withGuardedCommand straight from the kernel).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export interface LaterRead {
  /** `<file relative to src>#<handler>` */
  route: string;
  /** Commands after the idempotent one that bypass the command scope. */
  untracked: string[];
  /** The handler is a property of an object literal passed to bindRoutes (directly or through a variable). */
  bound: boolean;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const calleeName = (c: ts.CallExpression): string => {
  const e = c.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
};

function callsIn(node: ts.Node, out: ts.CallExpression[] = []): ts.CallExpression[] {
  if (ts.isCallExpression(node)) out.push(node);
  ts.forEachChild(node, (n) => void callsIn(n, out));
  return out;
}

/** The handler (a property assignment or method of an object literal) a node is in, outermost function first. */
function handlerOf(node: ts.Node): { name: string; fn: ts.FunctionLikeDeclaration } | null {
  let found: { name: string; fn: ts.FunctionLikeDeclaration } | null = null;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isPropertyAssignment(n.parent) && ts.isObjectLiteralExpression(n.parent.parent)) {
      found = { name: n.parent.name.getText(), fn: n };
    } else if (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent)) {
      found = { name: n.name.getText(), fn: n };
    }
  }
  return found;
}

/** The statement of `fn`'s body that contains `node`. */
function topStatement(fn: ts.FunctionLikeDeclaration, node: ts.Node): ts.Statement | null {
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return null;
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (n.parent === body) return n as ts.Statement;
  return null;
}

export function laterReads(srcDir: string): LaterRead[] {
  const out = new Map<string, LaterRead>();
  for (const f of files(srcDir)) {
    const text = readFileSync(f, 'utf8');
    if (!text.includes('withIdempotentActorCommand(')) continue;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const call of callsIn(sf)) {
      if (calleeName(call) !== 'withIdempotentActorCommand' || call.getSourceFile() !== sf) continue;
      if (relative(srcDir, f) === join('platform', 'db', 'commands.ts')) continue;
      const h = handlerOf(call);
      if (!h || !h.fn.body || !ts.isBlock(h.fn.body)) continue;
      const stmt = topStatement(h.fn, call);
      if (!stmt) continue;
      const after = h.fn.body.statements.slice(h.fn.body.statements.indexOf(stmt) + 1);
      // A later read: any statement after the command that calls something (a return of a plain value is not one).
      const laterCalls = after.flatMap((s) => callsIn(s));
      if (laterCalls.length === 0) continue;
      const untracked = laterCalls.map(calleeName).filter((n) => n === 'withCommand' || n === 'withGuardedCommand');
      const objectLiteral = h.fn.parent.parent;
      const bound = isBound(sf, objectLiteral);
      const route = `${relative(srcDir, f)}#${h.name}`;
      const prev = out.get(route);
      out.set(route, { route, untracked: [...(prev?.untracked ?? []), ...untracked], bound: (prev?.bound ?? true) && bound });
    }
  }
  return [...out.values()].sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
}

/** Whether an object literal of handlers reaches bindRoutes: as its argument, or as a variable or function result passed to it. */
function isBound(sf: ts.SourceFile, obj: ts.Node): boolean {
  for (let n: ts.Node | undefined = obj; n; n = n.parent) {
    if (ts.isCallExpression(n) && calleeName(n) === 'bindRoutes') return true;
  }
  // `const handlers = {...}` / `function handlers() { return {...} }` passed to bindRoutes in the same file.
  return sf.text.includes('bindRoutes(');
}
