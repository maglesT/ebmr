/**
 * The tests a source file declares, read statically (TypeScript syntax tree, nothing is run), so that the register
 * can check that every test a control lists exists (review F15) before any test has run.
 *
 * A control lists a test as `<file from the repository root> > <describe> > ... > <title>`: the file, the enclosing
 * describe blocks (Vitest describe or suite, Playwright test.describe) in order, then the title, each exactly as
 * written; a describe may be left out (`<file> > <title>` names a test in a describe block too). A title built from
 * data (a template literal, a variable, an it.each placeholder) becomes a pattern here, so this check can only say
 * such an entry is possible; the trace checks every entry exactly against the names the run reported (trace.ts).
 *
 * Whether a test runs is read from the same source: `never` when it, or a describe around it, is skip, todo or fixme;
 * `conditionally` when it may be skipped while the run goes on (skipIf or runIf, or a skip at run time: the test
 * context's skip in its body, in a function of the file it hands the context to, or in a beforeEach around it;
 * Playwright's testInfo.skip/fixme and test.skip/fixme annotations); `always` otherwise. A listed test that runs
 * conditionally may be reported skipped without failing the trace (review F15, round 3): on 29 February the DI-47
 * retain-until test has nothing to prove, and it must stay listed for the days it passes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** A test's place: its file, its describe blocks (outermost first) and its title, as regular-expression sources. */
export interface TestPath {
  file: string;
  describes: readonly string[];
  title: string;
}

/** Whether a declared test runs in a run of its file (see the header). */
export type Runs = 'always' | 'conditionally' | 'never';

/**
 * One test a file declares; `exact` when no part of its name is built from data, and then `entry` is the test as a
 * control lists it and `name` its full name (describes and title, as a report gives it); `runs` whether it always
 * runs, may be skipped while the run goes on, or never runs.
 */
export interface DeclaredTest extends TestPath {
  exact: boolean;
  entry: string | null;
  name: string | null;
  runs: Runs;
}

export const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = ' > ';
/** A part of a title built from data: anything but the ' > ' that separates the parts of a listed test. */
const ANY = '(?:(?! > )[\\s\\S])+?';

/** A test as a control lists it: its file from the repository root, all its describes in order, its title. */
export const entryOf = (file: string, describes: readonly string[], title: string): string => [file, ...describes, title].join(SEP);

/** The place of a reported test (plain text), as a TestPath of regular-expression sources. */
export function reportedPath(file: string, describes: readonly string[], title: string): TestPath {
  return { file, describes: describes.map(escape), title: escape(title) };
}

/**
 * Whether a listed test names the test at `path`: the file, then some of its describes in their order, then its
 * title (which may itself hold ' > ').
 */
export function names(entry: string, path: TestPath): boolean {
  if (!entry.startsWith(path.file + SEP)) return false;
  const parts = entry.slice(path.file.length + SEP.length).split(SEP);
  const title = new RegExp(`^${path.title}$`);
  const describes = path.describes.map((d) => new RegExp(`^${d}$`));
  // A title spans several parts only where its own text holds the separator.
  const most = path.title.includes(SEP) ? parts.length : 1;
  for (let span = 1; span <= most; span++) {
    if (!title.test(parts.slice(parts.length - span).join(SEP))) continue;
    const given = parts.slice(0, parts.length - span);
    let at = 0;
    for (const d of describes) if (at < given.length && d.test(given[at] ?? '')) at++;
    if (at === given.length) return true;
  }
  return false;
}

const MODIFIERS = new Set(['skip', 'only', 'todo', 'concurrent', 'sequential', 'fails', 'serial', 'parallel', 'fixme', 'shuffle']);
/** Modifiers under which a test never runs. */
const NEVER = new Set(['skip', 'todo', 'fixme']);
/** Modifiers under which a test runs only when a condition holds. */
const CONDITIONAL = new Set(['skipIf', 'runIf']);
/** What skips the running test: the test context's skip (Vitest), testInfo.skip or fixme (Playwright). */
const SKIPS = new Set(['skip', 'fixme']);

const RANK: Record<Runs, number> = { always: 0, conditionally: 1, never: 2 };
/** The less certain of two: a test runs only as surely as the least certain of it and the describes around it. */
const least = (a: Runs, b: Runs): Runs => (RANK[a] >= RANK[b] ? a : b);

type Kind = 'describe' | 'test';
type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
const isFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/**
 * Whether a call declares a describe block or a test, whether its title takes .each placeholders, and whether it
 * runs (skipped or todo: never; skipIf or runIf: conditionally).
 */
function classify(callee: ts.Expression): { kind: Kind; each: boolean; runs: Runs } | null {
  if (ts.isCallExpression(callee)) {
    // describe.each(table)(title, fn), it.skipIf(cond)(title, fn)
    const inner = callee.expression;
    if (!ts.isPropertyAccessExpression(inner)) return null;
    const name = inner.name.text;
    if (name !== 'each' && !CONDITIONAL.has(name)) return null;
    const base = classify(inner.expression);
    return base ? { kind: base.kind, each: base.each || name === 'each', runs: CONDITIONAL.has(name) ? least(base.runs, 'conditionally') : base.runs } : null;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    if (MODIFIERS.has(name)) {
      const base = classify(callee.expression);
      return base ? { ...base, runs: NEVER.has(name) ? 'never' : base.runs } : null;
    }
    // Playwright: test.describe(...)
    if (name === 'describe' && ts.isIdentifier(callee.expression) && callee.expression.text === 'test') return { kind: 'describe', each: false, runs: 'always' };
    return null;
  }
  if (ts.isIdentifier(callee)) {
    if (callee.text === 'describe' || callee.text === 'suite') return { kind: 'describe', each: false, runs: 'always' };
    if (callee.text === 'it' || callee.text === 'test') return { kind: 'test', each: false, runs: 'always' };
  }
  return null;
}

/**
 * Whether a call is a Playwright annotation `test.skip(...)` or `test.fixme(...)` (it skips the running test, or the
 * tests of its group) rather than a test declared skipped: no test body follows a title.
 */
function isSkipAnnotation(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !SKIPS.has(callee.name.text) || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'test') return false;
  const [first, ...rest] = node.arguments;
  return first === undefined || isFn(first) || !rest.some(isFn);
}

/** The function this file declares under a name (`function f` or `const f = (...) => ...`), if any. */
function functionNamed(sf: ts.SourceFile, name: string): Fn | null {
  let found: Fn | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) found = node;
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && isFn(node.initializer)) found = node.initializer;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Whether a destructuring takes the skip (or fixme) of what it destructures. */
const takesSkip = (pattern: ts.ObjectBindingPattern): ts.BindingElement[] =>
  pattern.elements.filter((e) => {
    const key = e.propertyName ?? e.name;
    return ts.isIdentifier(key) && SKIPS.has(key.text);
  });

/**
 * Whether a function may skip the running test through its parameters at `params` (every one for a test or a
 * beforeEach): a parameter's skip or fixme (Vitest's test context, Playwright's testInfo), a skip destructured from
 * one, a function of this file it hands one to that does so; or a Playwright test.skip/fixme annotation in its body.
 */
function skipsAtRunTime(sf: ts.SourceFile, fn: Fn, params: readonly number[] | 'all', seen = new Set<Fn>()): boolean {
  seen.add(fn);
  const contexts = new Set<string>();
  const skips = new Set<string>();
  fn.parameters.forEach((p, i) => {
    if (params !== 'all' && !params.includes(i)) return;
    if (ts.isIdentifier(p.name)) contexts.add(p.name.text);
    else if (ts.isObjectBindingPattern(p.name)) for (const e of takesSkip(p.name)) if (ts.isIdentifier(e.name)) skips.add(e.name.text);
  });
  const isContext = (n: ts.Node): boolean => ts.isIdentifier(n) && contexts.has(n.text);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && isContext(n.expression) && SKIPS.has(n.name.text)) found = true;
    else if (ts.isIdentifier(n) && skips.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) found = true;
    else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isContext(n.initializer) && takesSkip(n.name).length > 0) found = true;
    else if (ts.isCallExpression(n) && isSkipAnnotation(n)) found = true;
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const handed = n.arguments.flatMap((a, i) => (isContext(a) ? [i] : []));
      const callee = handed.length > 0 ? functionNamed(sf, n.expression.text) : null;
      if (callee && !seen.has(callee) && skipsAtRunTime(sf, callee, handed, seen)) found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

/**
 * Whether the statements of a describe body (or of the file) skip its tests: a Playwright test.skip/fixme annotation
 * (with no argument it skips them all), or a beforeEach whose context skips the test (Vitest beforeEach, Playwright
 * test.beforeEach).
 */
function groupRuns(sf: ts.SourceFile, statements: readonly ts.Statement[]): Runs {
  let runs: Runs = 'always';
  for (const st of statements) {
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) continue;
    const call = st.expression;
    const callee = call.expression;
    const beforeEach =
      (ts.isIdentifier(callee) && callee.text === 'beforeEach') ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === 'beforeEach' && ts.isIdentifier(callee.expression) && callee.expression.text === 'test');
    const hook = beforeEach ? call.arguments.find(isFn) : undefined;
    if (isSkipAnnotation(call)) runs = least(runs, call.arguments.length === 0 ? 'never' : 'conditionally');
    else if (hook && skipsAtRunTime(sf, hook, 'all')) runs = least(runs, 'conditionally');
  }
  return runs;
}

/** The string a `const NAME = '...'` of this file holds, if that is what the identifier names. */
function constantText(sf: ts.SourceFile, name: string): string | null {
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) found = init.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** A title as a regular-expression source, whether it is written out in full, and then its text. */
interface Title {
  source: string;
  exact: boolean;
  text: string;
  runs: Runs;
}

function titleSource(sf: ts.SourceFile, arg: ts.Expression | undefined, each: boolean): Omit<Title, 'runs'> {
  const literal = (text: string): Omit<Title, 'runs'> => {
    if (!each) return { source: escape(text), exact: true, text };
    // it.each placeholders: printf forms and $name / $0 (Vitest), %% is a literal percent.
    const parts = text.split(/(%%|%[sdifjo#]|\$[A-Za-z_][\w.]*|\$\d+)/);
    return { source: parts.map((p, i) => (i % 2 === 0 ? escape(p) : p === '%%' ? '%' : ANY)).join(''), exact: parts.length === 1, text };
  };
  if (!arg) return { source: ANY, exact: false, text: '' };
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return literal(arg.text);
  if (ts.isTemplateExpression(arg)) {
    const parts = [escape(arg.head.text), ...arg.templateSpans.map((s) => `${ANY}${escape(s.literal.text)}`)];
    return { source: parts.join(''), exact: false, text: '' };
  }
  if (ts.isIdentifier(arg)) {
    const text = constantText(sf, arg.text);
    if (text !== null) return literal(text);
  }
  return { source: ANY, exact: false, text: '' };
}

/** The tests a file declares (describe chains included), from its source text. */
export function declaredTests(file: string, source: string): DeclaredTest[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: DeclaredTest[] = [];
  const fileRuns = groupRuns(sf, sf.statements);
  const visit = (node: ts.Node, chain: Title[]): void => {
    if (ts.isCallExpression(node) && !isSkipAnnotation(node)) {
      const c = classify(node.expression);
      if (c) {
        const fn = node.arguments.slice(1).find(isFn);
        // A test's own function may skip it at run time (not an .each test's: its parameters are the table's row);
        // a describe's hooks and annotations may skip its tests.
        const runs =
          c.kind === 'test'
            ? fn && !c.each && skipsAtRunTime(sf, fn, 'all') ? least(c.runs, 'conditionally') : c.runs
            : fn && ts.isBlock(fn.body) ? least(c.runs, groupRuns(sf, fn.body.statements)) : c.runs;
        const title: Title = { ...titleSource(sf, node.arguments[0], c.each), runs };
        if (c.kind === 'test') {
          const exact = title.exact && chain.every((d) => d.exact);
          const texts = chain.map((d) => d.text);
          out.push({
            file,
            describes: chain.map((d) => d.source),
            title: title.source,
            exact,
            entry: exact ? entryOf(file, texts, title.text) : null,
            name: exact ? [...texts, title.text].join(' ') : null,
            runs: chain.reduce((r, d) => least(r, d.runs), least(fileRuns, title.runs)),
          });
        }
        const inner = c.kind === 'describe' ? [...chain, title] : chain;
        for (const a of node.arguments.slice(1)) {
          if (isFn(a)) ts.forEachChild(a, (n) => visit(n, inner));
        }
        return;
      }
    }
    ts.forEachChild(node, (n) => visit(n, chain));
  };
  visit(sf, []);
  return out;
}

/** The file part of a listed test (`<file> > ...`). */
export function fileOfEntry(entry: string): string {
  const at = entry.indexOf(SEP);
  return at < 0 ? entry : entry.slice(0, at);
}

/** The tests each file under `root` declares, read once per file; null when there is no such file. */
export function declaredIn(root: string, cache = new Map<string, DeclaredTest[] | null>()): (file: string) => DeclaredTest[] | null {
  return (file) => {
    if (!cache.has(file)) {
      const path = join(root, file);
      cache.set(file, existsSync(path) ? declaredTests(file, readFileSync(path, 'utf8')) : null);
    }
    return cache.get(file) ?? null;
  };
}

/**
 * Listed tests that their file does not declare, or whose file does not exist, with the reason. `root` is the
 * repository root the files are named from.
 */
export function missingListedTests(entries: readonly string[], root: string, cache = new Map<string, DeclaredTest[] | null>()): { entry: string; reason: string }[] {
  const declared = declaredIn(root, cache);
  const out: { entry: string; reason: string }[] = [];
  for (const entry of entries) {
    const file = fileOfEntry(entry);
    const tests = file !== entry ? declared(file) : null;
    if (!tests) out.push({ entry, reason: file === entry ? 'not of the form "<file> > <describe> > <title>"' : `no such file ${file}` });
    else if (!tests.some((t) => names(entry, t))) out.push({ entry, reason: `${file} declares no test of that name (its describes in order, then the title)` });
  }
  return out;
}
