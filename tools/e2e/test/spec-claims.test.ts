/**
 * What two E2E specs claim, held to what their bodies check (reviews F26 and F27). The specs need the whole stack, so
 * this reads their source (TypeScript syntax tree): a step that says the server "records nothing" must compare the
 * database before and after on an entry that exists, and a [DI-20] room test must ask the server itself, from the
 * other room's session, for the scale it may not use. The specs themselves run under Playwright (pnpm e2e).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SPECS = fileURLToPath(new URL('../specs/', import.meta.url));

function sourceOf(spec: string): ts.SourceFile {
  return ts.createSourceFile(spec, readFileSync(`${SPECS}${spec}`, 'utf8'), ts.ScriptTarget.Latest, true);
}

const textOf = (sf: ts.SourceFile, n: ts.Node): string => n.getText(sf);

/** The calls of a file whose callee reads `name` (e.g. `evidence.step`, `test`), in source order. */
function callsOf(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && textOf(sf, n.expression) === name) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const literal = (n: ts.Node | undefined): string => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : '');

/** The test of a spec whose title starts with `prefix`, and its body. */
function testBody(sf: ts.SourceFile, prefix: string): ts.Node {
  const t = callsOf(sf, 'test').find((c) => literal(c.arguments[0]).startsWith(prefix));
  const body = t?.arguments.at(-1);
  if (!t || !body) throw new Error(`no test titled "${prefix}..." in ${sf.fileName}`);
  return body;
}

/** The body of the evidence step in `scope` whose expected text contains `claim`. */
function stepBody(sf: ts.SourceFile, scope: ts.Node, claim: string): ts.Node {
  const steps: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && textOf(sf, n.expression) === 'evidence.step' && literal(n.arguments[1]).includes(claim)) steps.push(n);
    ts.forEachChild(n, visit);
  };
  visit(scope);
  const fn = steps[0]?.arguments[2];
  if (steps.length !== 1 || !fn) throw new Error(`expected one evidence step claiming "${claim}" in ${sf.fileName}, found ${steps.length}`);
  return fn;
}

/** Source positions of the calls in `scope` whose callee text matches. */
function positions(sf: ts.SourceFile, scope: ts.Node, callee: RegExp): number[] {
  const out: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && callee.test(textOf(sf, n.expression))) out.push(n.getStart(sf));
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

describe('E2E spec claims', () => {
  it('[meta] access.spec: the kiosk no-tap step that says "records nothing" works on an entry that exists and compares the database before and after (review F26; INV-40, DI-14)', () => {
    const sf = sourceOf('access/access.spec.ts');
    const t = testBody(sf, '[INV-40][DI-14] ');
    const step = stepBody(sf, t, 'records nothing');
    const body = textOf(sf, step);
    const test = textOf(sf, t);
    // The entry exists (a created stub with its served content version and hash), not a random id.
    expect(test).toMatch(/const stub = await createStub\(/);
    expect(body).not.toMatch(/randomUUID\(\)\s*;/);
    expect(body).toMatch(/aggregateId: stub/);
    expect(body).toMatch(/\/api\/esig\/content\?/);
    // The challenges on the entry and the person's audit entries and authentication events, before and after.
    const reads = positions(sf, step, /^stubRecords$/);
    const [post] = positions(sf, step, /^page\.request\.post$/);
    expect(post).toBeDefined();
    expect(reads.filter((p) => p < (post ?? 0))).toHaveLength(1);
    expect(reads.filter((p) => p > (post ?? 0))).toHaveLength(1);
    expect(body).toMatch(/expect\(after\)\.toEqual\(before\)/);
    expect(body).toMatch(/expect\(after\.challenges\)\.toBe\(0\)/);
    expect(body).toMatch(/expect\(r\.status\(\)\)\.toBe\(428\)/);
    expect(body).toMatch(/toBe\('TAP_REQUIRED'\)/);
  });

  it('[meta] devices.spec: the [DI-20] room test asks the server, from the other room\'s own session, for a capture from and the live view of TEST-BAL-01 and counts its readings (review F27; DI-20)', () => {
    const sf = sourceOf('devices/devices.spec.ts');
    const t = callsOf(sf, 'test').find((c) => literal(c.arguments[0]).startsWith('[DI-20] ') && textOf(sf, c).includes("'TEST-KIOSK-BLEND-1'"));
    const fn = t?.arguments.at(-1);
    if (!t || !fn) throw new Error('no [DI-20] test on the BLEND-1 kiosk in devices.spec');
    const body = textOf(sf, fn);
    // The session of the BLEND-1 page (page.request carries its cookie), not an anonymous client.
    expect(body).toMatch(/page\.request\.post\(`\$\{base\}\/api\/devices\/scales\/TEST-BAL-01\/capture`/);
    expect(body).toMatch(/page\.request\.get\(`\$\{base\}\/api\/devices\/scales\/TEST-BAL-01\/live`/);
    expect(body).toMatch(/expect\(r\.status\(\)\)\.toBe\(403\)/);
    expect(body).toMatch(/toBe\('SCALE_NOT_IN_ROOM'\)/);
    expect(body).toMatch(/expect\(live\.status\(\)\)\.toBe\(403\)/);
    const reads = positions(sf, fn, /^readingsOf$/);
    const [post] = positions(sf, fn, /^page\.request\.post$/);
    expect(reads.filter((p) => p < (post ?? 0))).toHaveLength(1);
    expect(reads.filter((p) => p > (post ?? 0))).toHaveLength(1);
    expect(body).toMatch(/expect\(after\)\.toBe\(before\)/);
    // No other spec captures from the scale meanwhile (the readings count is the room gate's alone).
    expect(textOf(sf, t)).toMatch(/withSimulator\(e2e\.state/);
  });

  it('[meta] the steps that send a test package claim only what they check: the file in the inbox and its GMP stamp, not that it is write-once (review F28; DI-05)', () => {
    for (const spec of ['designer/designer.spec.ts', 'journey/fcv.spec.ts']) {
      const sf = sourceOf(spec);
      const step = stepBody(sf, sf, 'in the sandbox inbox');
      const expected = callsOf(sf, 'evidence.step').map((c) => literal(c.arguments[1])).find((e) => e.includes('in the sandbox inbox')) ?? '';
      expect(expected, spec).not.toMatch(/write-once/i);
      expect(textOf(sf, step), spec).toMatch(/readFileSync\(join\(e2e\.state\.exchangeDir, 'to-sandbox', `\$\{packageHash\}\.json`\)/);
      expect(textOf(sf, step), spec).toMatch(/\.source\)\.toEqual\(\{ installationKind: 'GMP', watermark: null \}\)/);
    }
  });
});
