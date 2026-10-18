/**
 * The validation pack generators (Phase 7 slice 7c; IN-12, PR-60, DI-06, DI-03; D-P7-13): every artefact from the
 * example bundle, as Markdown and self-contained HTML, with a manifest of SHA-256 hashes; byte-identical for the same
 * bundle; the AI feature inventory refusing a method that changes GMP data; the critical limits' boundary evidence in
 * the trace matrix; the fixed risk rules; the release notes' delta. A real bundle of a migrated database is generated in
 * tools/validation/test.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assessRisk,
  bundleSha256,
  criticalLimitEvidence,
  escapeHtml,
  generatePack,
  isDatabaseTest,
  PACK_ARTEFACTS,
  parseBundle,
  renderHtml,
  renderMarkdown,
  smfParagraphText,
  verdicts,
  type Bundle,
  type Control,
} from '../src/index.ts';

const EXAMPLE = JSON.parse(readFileSync(new URL('../fixtures/example-bundle.json', import.meta.url), 'utf8')) as Bundle;
const copy = (): Bundle => structuredClone(EXAMPLE);
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const fileOf = (pack: ReturnType<typeof generatePack>, path: string): string => {
  const f = pack.files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path} in the pack`);
  return f.content;
};

/** The same JSON with every object's keys in reverse order (the bundle is the same; its text is not). */
function reversedKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reversedKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversedKeys(x)]));
  return v;
}

describe('the validation package (IN-12)', () => {
  it('[IN-12] the validation package contains each listed artefact and the SMF paragraph', () => {
    const pack = generatePack(copy());
    expect(pack.manifest.documents.map((d) => d.id)).toEqual([...PACK_ARTEFACTS]);
    for (const id of PACK_ARTEFACTS) {
      const md = fileOf(pack, `${id}.md`);
      const html = fileOf(pack, `${id}.html`);
      const entry = pack.manifest.documents.find((d) => d.id === id);
      // Each file is listed with its own hash and size, and names the bundle it came from.
      expect(entry?.files).toEqual([
        { path: `${id}.md`, sha256: sha(md), bytes: Buffer.byteLength(md) },
        { path: `${id}.html`, sha256: sha(html), bytes: Buffer.byteLength(html) },
      ]);
      expect(md).toContain(`Generated from evidence bundle SHA-256 ${bundleSha256(EXAMPLE)}`);
      expect(html).toContain(bundleSha256(EXAMPLE));
      // Self-contained HTML: no script and nothing fetched from elsewhere.
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).not.toMatch(/<script|<link|<img|<iframe|\bsrc=|\bhref=/i);
    }
    expect(pack.manifest).toMatchObject({ packVersion: 1, product: 'Batchwright Tablets', version: '1.0.0-rc.1', edition: 'tablets', bundleSha256: bundleSha256(EXAMPLE), previousBundleSha256: null });
    expect(JSON.parse(fileOf(pack, 'manifest.json'))).toEqual(pack.manifest);
    // The SMF paragraph: the product, its maker and release, the database enforcement, the system description, the QA
    // approval of each release.
    const smf = smfParagraphText(EXAMPLE);
    expect(fileOf(pack, 'smf-paragraph.md')).toContain(smf);
    expect(smf).toMatch(/Batchwright Tablets \(version 1\.0\.0-rc\.1, supplied by Medhanta\)/);
    expect(smf).toMatch(/approved system description/);
    expect(smf).toMatch(/approved for GMP use by the site's QA on its validation summary/);
    // The URS has one requirement per control; drafts and pending decisions are marked.
    const urs = fileOf(pack, 'urs.md');
    for (const c of EXAMPLE.register.controls) expect(urs).toContain(`### UR-${c.id}: ${c.title}`);
    expect(urs).toContain('UR-PR-61: ');
    expect(urs).toMatch(/UR-PR-61: .*\(DRAFT\)/);
    // The IQ protocol names its checks; the PQ template is one per MBR and says why (DI-04).
    expect(fileOf(pack, 'iq.md')).toMatch(/IQ-01 \| release identity/);
    expect(fileOf(pack, 'pq-template.md')).toMatch(/does not prove that a given master batch record is right \(DI-04\)/);
  });

  it('[meta] the validation pack is byte-identical for the same bundle', () => {
    const a = generatePack(copy());
    const b = generatePack(copy());
    const c = generatePack(reversedKeys(copy()));
    expect(b.files).toEqual(a.files);
    expect(c.files).toEqual(a.files);
    expect(a.files.map((f) => f.path)).toEqual([...PACK_ARTEFACTS.flatMap((id) => [`${id}.md`, `${id}.html`]), 'manifest.json']);
    // Another bundle gives another pack (its hash is in every footer).
    const other = copy();
    other.release.commit = 'f'.repeat(40);
    expect(generatePack(other).manifest.bundleSha256).not.toBe(a.manifest.bundleSha256);
  });

  it('[meta] a bundle the kit does not know or that is out of order is refused before anything is generated', () => {
    expect(() => generatePack({ ...copy(), bundleVersion: 2 })).toThrow(/EBMR-VAL-002/);
    const out = copy();
    out.register.controls.reverse();
    expect(() => generatePack(out)).toThrow(/EBMR-VAL-008/);
  });

  it('[meta] Markdown and HTML escape what the bundle says', () => {
    const doc = { id: 'x', title: 'A <b> & "c"', status: 'DRAFT' as const, blocks: [{ kind: 'table' as const, head: ['a|b'], rows: [['<script>alert(1)</script>\nnext']] }] };
    const footer = { product: 'P', version: 'v', edition: 'tablets', commit: 'c', schemaRelease: 's', bundleSha256: 'h' };
    const html = renderHtml(doc, footer);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br>next');
    expect(html).toContain('<title>A &lt;b&gt; &amp; &quot;c&quot;</title>');
    expect(html).toContain('<p class="status">DRAFT</p>');
    expect(renderMarkdown(doc, footer)).toContain('| a\\|b |');
    expect(escapeHtml(`'`)).toBe('&#39;');
  });
});

describe('the AI feature inventory (PR-60)', () => {
  it('[PR-60] the AI feature inventory lists every analytics method and none changes GMP data without a human e-signature', () => {
    const b = copy();
    b.analytics.methods = [
      { id: 'capability.cpk', versions: ['1'], intendedUse: 'Process capability of a parameter for review.', changesGmpData: false },
      { id: 'trend.cusum', versions: ['1', '2'], intendedUse: 'Flags drift in a process value for review.', changesGmpData: false },
    ];
    const inv = fileOf(generatePack(b), 'ai-inventory.md');
    for (const m of b.analytics.methods) expect(inv).toContain(`| ${m.id} | ${m.versions.join(', ')} | ${m.intendedUse} | no | a person's act with a human e-signature |`);
    expect(inv).toContain('2 methods; none changes GMP data.');
    // A registered method that says it changes GMP data fails the pack, by name.
    b.analytics.methods[1] = { ...b.analytics.methods[1]!, changesGmpData: true };
    expect(() => generatePack(b)).toThrow(/^EBMR-VAL-009: .*trend\.cusum/);
  });
});

describe('the trace matrix (DI-06)', () => {
  it('[DI-06] every critical limit shows its boundary tests in the trace matrix', () => {
    const b = copy();
    const second = 'packages/kernel/test/inbound/inbound.test.ts > platform.accept_inbound (DI-31) > [DI-31] never run';
    b.criticalLimits = [
      ...b.criticalLimits,
      { key: 'yield.range', description: 'A yield outside its range raises an exception.', controls: ['PR-20'], boundaryTests: [second] },
      { key: 'zz.none', description: 'A limit with no boundary test listed.', controls: ['PR-20'], boundaryTests: [] },
    ];
    const md = fileOf(generatePack(b), 'trace-matrix.md');
    const ev = criticalLimitEvidence(b);
    expect(ev.map((l) => [l.key, l.evidenced])).toEqual([['weigh.tolerance', true], ['yield.range', false], ['zz.none', false]]);
    for (const l of b.criticalLimits) expect(md).toContain(`| ${l.key} | ${l.description} |`);
    expect(md).toContain(`| weigh.tolerance | A weighing outside tolerance is refused. | PR-20 | ${b.criticalLimits[0]!.boundaryTests[0]!} | PASSED (vitest-1) | EVIDENCED |`);
    expect(md).toContain(`| yield.range | A yield outside its range raises an exception. | PR-20 | ${second} | NOT RUN | NO EVIDENCE |`);
    expect(md).toContain('| zz.none | A limit with no boundary test listed. | PR-20 | none listed | - | NO EVIDENCE |');
    // Both ways: the clause reaches its test, and the test reaches its requirement.
    expect(md).toMatch(/\| Cut the link mid-transfer; no partial value lands\. \| DI-31 \| UR-DI-31 \|/);
    expect(md).toMatch(/\| packages\/kernel\/test\/inbound\/inbound\.test\.ts > platform\.accept_inbound \(DI-31\) > \[DI-31\] a message is committed whole or not at all \| DI-31 \| UR-DI-31 \| PASSED \|/);
  });
});

describe('the risk assessment and the release documents', () => {
  const control = (over: Partial<Control>): Control => ({ ...structuredClone(EXAMPLE.register.controls[0]!), ...over });
  const v = verdicts(EXAMPLE);
  const passing = 'packages/kernel/test/inbound/inbound.test.ts > platform.accept_inbound (DI-31) > [DI-31] a message is committed whole or not at all';

  it('[meta] the risk assessment follows its fixed rules: severity from the class and the high-risk functions, probability from database enforcement, detectability from the results', () => {
    const core = assessRisk(control({ clauses: [{ clause: 'x', tests: [passing] }] }), v);
    expect(core).toMatchObject({ severity: 'high', probability: 'low', detectability: 'high', riskClass: 'medium', databaseEnforced: true });
    const unrun = assessRisk(control({ clauses: [{ clause: 'x', tests: ['apps/tablets-server/test/x.test.ts > never run'] }] }), v);
    expect(unrun).toMatchObject({ severity: 'high', probability: 'medium', detectability: 'medium', riskClass: 'high', databaseEnforced: false });
    const other = assessRisk(control({ class: 'other', title: 'Help text', behaviour: 'Screens explain themselves.', catalogTest: 'Open the help.', type: ['DESIGN_CHOICE'], clauses: [{ clause: 'x', tests: [passing] }] }), v);
    expect(other).toMatchObject({ severity: 'low', probability: 'medium', riskClass: 'low' });
    const deferred = assessRisk(control({ clauses: [{ clause: 'x', tests: [], deferred: { phase: 9, reason: 'later' } }] }), v);
    expect(deferred).toMatchObject({ probability: 'high', detectability: 'low', riskClass: 'high' });
    expect(isDatabaseTest('apps/tablets-server/test/execution/db-guards-roles.test.ts > x > y')).toBe(true);
    expect(isDatabaseTest('apps/tablets-server/test/review/screens.test.ts > x > [DI-1] a bypass is refused')).toBe(true);
    expect(isDatabaseTest('apps/tablets-web/test/a.test.ts > x > shows a label')).toBe(false);
  });

  it('[meta] the release notes list the requirement-level delta against the previous bundle', () => {
    const prev = copy();
    prev.release.version = '0.9.0';
    prev.register.controls = prev.register.controls.filter((c) => c.id !== 'PR-61');
    prev.register.controls[0]!.implementedBy = {};
    const pack = generatePack(copy(), parseBundle(prev));
    const notes = fileOf(pack, 'release-notes.md');
    expect(notes).toContain('against 0.9.0');
    expect(notes).toMatch(/\| DI-31 \| Interface data integrity \| implementation changed \|/);
    expect(notes).toMatch(/\| PR-61 \| .* \| new requirement \|/);
    expect(notes).not.toMatch(/\| IN-12 \|/);
    expect(pack.manifest.previousBundleSha256).toBe(bundleSha256(parseBundle(prev)));
    expect(fileOf(generatePack(copy()), 'release-notes.md')).toContain('no requirement-level delta');
  });

  it('[DI-03] the validation summary template names the release, the runs, the deviations and the open expert decisions, and leaves the conclusion to QA', () => {
    const b = copy();
    b.results = b.results.map((r, i) => (i === 0 ? { ...r, status: 'failed' as const } : r));
    const md = fileOf(generatePack(b), 'validation-summary.md');
    expect(md).toContain(`Schema release:** ${b.release.schemaRelease}`);
    expect(md).toContain(`| ${b.results[0]!.test} | ${b.results[0]!.run} |`);
    expect(md).toMatch(/controls carry no expert decision yet \(PENDING\)/);
    expect(md).toMatch(/## Conclusion \(customer QA\)[\s\S]*\| QA approver \| \| \| \|/);
    expect(md.split('\n')[2]).toBe('**TEMPLATE**');
  });
});
