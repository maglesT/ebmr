/**
 * The tests a source file declares, read statically (TypeScript syntax tree, nothing is run), so that the register
 * can check that every test a control lists exists (review F15) before any test has run.
 *
 * A control lists a test as `<file from the repository root> > <describe> > ... > <title>`: the file, the enclosing
 * describe blocks (Vitest describe or suite, Playwright test.describe) in order, then the title, each exactly as
 * written; a describe may be left out (`<file> > <title>` names a test in a describe block too). A title built from
 * data (a template literal, a variable, an it.each placeholder) becomes a pattern here, so this check can only say
 * such an entry is possible; the trace checks every entry exactly against the names the run reported (trace.ts).
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

/**
 * One test a file declares; `exact` when no part of its name is built from data, and then `entry` is the test as a
 * control lists it and `name` its full name (describes and title, as a report gives it); `mayNotRun` when it or a
 * describe around it is skipped, todo or run only under a condition.
 */
export interface DeclaredTest extends TestPath {
  exact: boolean;
  entry: string | null;
  name: string | null;
  mayNotRun: boolean;
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
/** Modifiers under which a test does not run, or runs only when a condition holds. */
const NOT_RUN = new Set(['skip', 'todo', 'fixme', 'skipIf', 'runIf']);
const CONDITIONAL = new Set(['skipIf', 'runIf']);

type Kind = 'describe' | 'test';

/**
 * Whether a call declares a describe block or a test, whether its title takes .each placeholders, and whether it
 * may not run (skipped, todo or conditional).
 */
function classify(callee: ts.Expression): { kind: Kind; each: boolean; mayNotRun: boolean } | null {
  if (ts.isCallExpression(callee)) {
    // describe.each(table)(title, fn), it.skipIf(cond)(title, fn)
    const inner = callee.expression;
    if (!ts.isPropertyAccessExpression(inner)) return null;
    const name = inner.name.text;
    if (name !== 'each' && !CONDITIONAL.has(name)) return null;
    const base = classify(inner.expression);
    return base ? { kind: base.kind, each: base.each || name === 'each', mayNotRun: base.mayNotRun || NOT_RUN.has(name) } : null;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    if (MODIFIERS.has(name)) {
      const base = classify(callee.expression);
      return base ? { ...base, mayNotRun: base.mayNotRun || NOT_RUN.has(name) } : null;
    }
    // Playwright: test.describe(...)
    if (name === 'describe' && ts.isIdentifier(callee.expression) && callee.expression.text === 'test') return { kind: 'describe', each: false, mayNotRun: false };
    return null;
  }
  if (ts.isIdentifier(callee)) {
    if (callee.text === 'describe' || callee.text === 'suite') return { kind: 'describe', each: false, mayNotRun: false };
    if (callee.text === 'it' || callee.text === 'test') return { kind: 'test', each: false, mayNotRun: false };
  }
  return null;
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
  mayNotRun: boolean;
}

function titleSource(sf: ts.SourceFile, arg: ts.Expression | undefined, each: boolean): Omit<Title, 'mayNotRun'> {
  const literal = (text: string): Omit<Title, 'mayNotRun'> => {
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
  const visit = (node: ts.Node, chain: Title[]): void => {
    if (ts.isCallExpression(node)) {
      const c = classify(node.expression);
      if (c) {
        const title: Title = { ...titleSource(sf, node.arguments[0], c.each), mayNotRun: c.mayNotRun };
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
            mayNotRun: title.mayNotRun || chain.some((d) => d.mayNotRun),
          });
        }
        const inner = c.kind === 'describe' ? [...chain, title] : chain;
        for (const a of node.arguments.slice(1)) {
          if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) ts.forEachChild(a, (n) => visit(n, inner));
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

/**
 * Listed tests that their file does not declare, or whose file does not exist, with the reason. `root` is the
 * repository root the files are named from.
 */
export function missingListedTests(entries: readonly string[], root: string, cache = new Map<string, DeclaredTest[] | null>()): { entry: string; reason: string }[] {
  const out: { entry: string; reason: string }[] = [];
  for (const entry of entries) {
    const file = fileOfEntry(entry);
    if (!cache.has(file)) {
      const path = join(root, file);
      cache.set(file, file !== entry && existsSync(path) ? declaredTests(file, readFileSync(path, 'utf8')) : null);
    }
    const tests = cache.get(file);
    if (!tests) out.push({ entry, reason: file === entry ? 'not of the form "<file> > <describe> > <title>"' : `no such file ${file}` });
    else if (!tests.some((t) => names(entry, t))) out.push({ entry, reason: `${file} declares no test of that name (its describes in order, then the title)` });
  }
  return out;
}
