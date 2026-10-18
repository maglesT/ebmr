/**
 * The release documents of the pack (Phase 7 slice 7c; IN-12, DI-03, PR-60): the validation summary report template
 * (filled from the run; its conclusion is the customer's QA's), the release notes with requirement-level impact (the
 * delta against the previous release's bundle), the SBOM reference, the known issues, the site master file paragraph
 * (IN-12 clause 1) and the AI feature inventory (PR-60 clause 1; refused when a method could change GMP data).
 */
import { compareText } from '../bundle/validate.ts';
import type { Bundle, Control } from '../bundle/types.ts';
import { fields, heading, list, para, signature, table, type Doc } from './doc.ts';
import { listedTests, verdictOf, verdicts } from './facts.ts';
import { recordKinds } from './qualification.ts';

/** A refused pack: the AI feature inventory found a method that changes GMP data (PR-60). */
export class PackError extends Error {
  readonly code: 'EBMR-VAL-009';
  constructor(detail: string) {
    super(`EBMR-VAL-009: ${detail}`);
    this.name = 'PackError';
    this.code = 'EBMR-VAL-009';
  }
}

export function validationSummary(b: Bundle): Doc {
  const v = verdicts(b);
  const failed = b.results.filter((r) => r.status === 'failed');
  const pending = b.register.controls.filter((c) => c.expertDecision.status === 'PENDING');
  const byStatus = (s: string) => String(b.register.controls.filter((c) => c.buildStatus === s).length);
  return {
    id: 'validation-summary',
    title: 'Validation summary report',
    status: 'TEMPLATE',
    blocks: [
      para('Filled from the evidence bundle of the run. The conclusion is left for the customer\'s QA, who approves this report in the system with a VALIDATION_SUMMARY_APPROVED signature bound to its SHA-256 and the running release (DI-03): until then no GMP batch is issued on the release.'),
      heading('Scope'),
      fields([
        ['Product', `${b.release.product} ${b.release.version}, ${b.edition} edition, by ${b.release.maker}`],
        ['Commit', `${b.release.commit} (${b.release.commitTime})`],
        ['Schema release', b.release.schemaRelease],
        ['Controls', `${String(b.register.controls.length)} (VERIFIED ${byStatus('VERIFIED')}, IMPLEMENTED ${byStatus('IMPLEMENTED')}, SPECIFIED ${byStatus('SPECIFIED')})`],
        ['Trace', `phase ${String(b.trace.phase)}, ${b.trace.ok ? 'ok' : 'NOT OK'}`],
      ]),
      heading('What was run'),
      table(['Run', 'Kind', 'Started', 'Finished', 'Report SHA-256'], b.runs.map((r) => [r.id, r.kind, r.startedAt, r.finishedAt, r.reportSha256])),
      table(['Record', 'Result', 'Summary'], b.records.map((r) => [r.kind, r.passed ? 'PASSED' : 'FAILED', r.summary])),
      para(`Records in this bundle: ${recordKinds(b).join(', ') || 'none'}. Tests reported: ${String(v.size)}.`),
      heading('Deviations (failed tests)'),
      table(['Test', 'Run', 'Controls'], failed.map((r) => [r.test, r.run, r.controls.join(', ') || '-'])),
      heading('Residuals and known issues'),
      table(['Id', 'Severity', 'Controls', 'Text'], b.knownIssues.map((k) => [k.id, k.severity, k.controls.join(', ') || '-', k.text])),
      heading('Open expert decisions'),
      para(`${String(pending.length)} of ${String(b.register.controls.length)} controls carry no expert decision yet (PENDING): the build treats them as followed as written.`),
      list(pending.map((c) => `${c.id} ${c.title}`)),
      heading('Conclusion (customer QA)'),
      para('The system is / is not fit for its intended use at this site, with these conditions:'),
      signature(['QA approver']),
    ],
  };
}

/** What changed for one control between two bundles (empty when nothing did). */
export function controlDelta(prev: Control | undefined, cur: Control, pv: ReturnType<typeof verdicts>, cv: ReturnType<typeof verdicts>): string[] {
  if (!prev) return ['new requirement'];
  const out: string[] = [];
  const implA = JSON.stringify(prev.implementedBy);
  const implB = JSON.stringify(cur.implementedBy);
  if (implA !== implB) out.push('implementation changed');
  const ta = listedTests(prev);
  const tb = listedTests(cur);
  const added = tb.filter((t) => !ta.includes(t));
  const removed = ta.filter((t) => !tb.includes(t));
  if (added.length > 0) out.push(`tests added: ${String(added.length)}`);
  if (removed.length > 0) out.push(`tests removed: ${String(removed.length)}`);
  const changed = tb.filter((t) => ta.includes(t) && verdictOf(pv, t).verdict !== verdictOf(cv, t).verdict);
  if (changed.length > 0) out.push(`results changed: ${changed.map((t) => `${t.split(' > ').at(-1) ?? t} (${verdictOf(pv, t).verdict} to ${verdictOf(cv, t).verdict})`).join('; ')}`);
  if (prev.buildStatus !== cur.buildStatus) out.push(`build status ${prev.buildStatus} to ${cur.buildStatus}`);
  if (prev.behaviour !== cur.behaviour || prev.catalogTest !== cur.catalogTest) out.push('requirement text changed');
  return out;
}

export function releaseNotes(b: Bundle, previous?: Bundle): Doc {
  const cv = verdicts(b);
  if (!previous) {
    return {
      id: 'release-notes',
      title: `Release notes ${b.release.version}`,
      status: 'RELEASED',
      blocks: [
        para(`${b.release.product} ${b.release.version}: the first release with an evidence bundle; every requirement is new. No previous bundle was given, so there is no requirement-level delta.`),
        table(['Requirement', 'Title', 'Build status'], b.register.controls.map((c) => [c.id, c.title, c.buildStatus])),
      ],
    };
  }
  const pv = verdicts(previous);
  const prev = new Map(previous.register.controls.map((c) => [c.id, c]));
  const rows = b.register.controls
    .map((c) => [c.id, c.title, controlDelta(prev.get(c.id), c, pv, cv).join('; ')])
    .filter((r) => r[2] !== '');
  const gone = previous.register.controls.filter((c) => !b.register.controls.some((x) => x.id === c.id)).map((c) => [c.id, c.title, 'requirement removed']);
  return {
    id: 'release-notes',
    title: `Release notes ${b.release.version}`,
    status: 'RELEASED',
    blocks: [
      para(`${b.release.product} ${b.release.version} against ${previous.release.version} (commit ${previous.release.commit} to ${b.release.commit}; schema release ${previous.release.schemaRelease} to ${b.release.schemaRelease}). Requirement-level impact: every control whose implementation, tests or results changed.`),
      table(['Requirement', 'Title', 'Impact'], [...rows, ...gone].sort((a, z) => compareText(a[0] ?? '', z[0] ?? ''))),
      heading('Migrations added'),
      list(b.inventory.migrations.filter((m) => !previous.inventory.migrations.some((p) => p.namespace === m.namespace && p.name === m.name)).map((m) => `${m.namespace}/${m.name}`)),
    ],
  };
}

export function sbomReference(b: Bundle): Doc {
  return {
    id: 'sbom',
    title: 'Software bill of materials',
    status: 'RELEASED',
    blocks: [
      para(`The software bill of materials of ${b.release.product} ${b.release.version} is delivered as a ${b.sbom.format} file beside this pack. Its hash binds it to this release.`),
      fields([
        ['File', b.sbom.file],
        ['Format', b.sbom.format],
        ['SHA-256', b.sbom.sha256],
      ]),
    ],
  };
}

export function knownIssues(b: Bundle): Doc {
  return {
    id: 'known-issues',
    title: 'Known issues',
    status: 'RELEASED',
    blocks: [
      para('The residuals of the reviews that are not fixed in this release, from the backlogs, with the controls they touch. Open findings of the reviews are listed after them.'),
      table(['Id', 'Severity', 'Controls', 'Issue'], b.knownIssues.map((k) => [k.id, k.severity, k.controls.join(', ') || '-', k.text])),
      heading('Open review findings'),
      table(['Id', 'Severity', 'Controls', 'Summary', 'Source'], b.openFindings.map((f) => [f.id, f.severity, f.controls.join(', ') || '-', f.summary, f.source])),
    ],
  };
}

/** The site master file paragraph (IN-12 clause 1): short, accurate, for the "computerised systems" item of the SMF. */
export function smfParagraphText(b: Bundle): string {
  const interfaces = b.inventory.routes.length > 0 ? `${String(new Set(b.inventory.routes.map((r) => r.namespace)).size)} functional areas` : 'its functional areas';
  return [
    `The site uses ${b.release.product} (version ${b.release.version}, supplied by ${b.release.maker}) as its electronic batch manufacturing record system for ${b.edition === 'tablets' ? 'oral solid dosage forms' : 'sterile injectables'}.`,
    `It holds the master batch records, the executed batch records with their electronic signatures and audit trail, and the batch review and release; it covers ${interfaces}.`,
    'It runs on a PostgreSQL database on the site\'s own servers, which enforces the GMP rules (access, signatures, audit trail, limits and status interlocks) under the application\'s own credentials.',
    'Connected systems are listed in the approved system description, under change control; an interface missing from it is refused and alarmed.',
    `The system is validated by the supplier's validation package (requirements, risk assessment, specifications, IQ, OQ, trace matrix) and the site's own PQ of each master batch record; each release is approved for GMP use by the site's QA on its validation summary before any GMP batch is issued (schema release ${b.release.schemaRelease.slice(0, 12)}).`,
  ].join(' ');
}

export function smfParagraph(b: Bundle): Doc {
  return {
    id: 'smf-paragraph',
    title: 'Site master file: computerised systems paragraph',
    status: 'RELEASED',
    blocks: [para('For the computerised systems item of the customer\'s site master file. Adapt it where the installation differs from the supplier\'s description.'), para(smfParagraphText(b))],
  };
}

/** The AI feature inventory (PR-60 clause 1). Throws EBMR-VAL-009 when a registered method says it changes GMP data. */
export function aiInventory(b: Bundle): Doc {
  const bad = b.analytics.methods.filter((m) => m.changesGmpData);
  if (bad.length > 0) {
    throw new PackError(`the AI feature inventory refuses methods that change GMP data: ${bad.map((m) => m.id).join(', ')} (PR-60: no AI or statistical output changes GMP data or status without a human e-signature)`);
  }
  return {
    id: 'ai-inventory',
    title: 'AI and analytics feature inventory',
    status: 'RELEASED',
    blocks: [
      para('Every analytics method of the method registry (ADR 0020). Each is advisory: it reads GMP data through its own read-only role and writes only to the non-GMP analytics schema. No output changes GMP data or status; every disposition a person takes on an output is that person\'s own act with a human e-signature, and the method\'s version is recorded with the output.'),
      table(['Method', 'Versions', 'Intended use', 'Changes GMP data', 'Disposition'], b.analytics.methods.map((m) => [m.id, m.versions.join(', '), m.intendedUse, m.changesGmpData ? 'YES' : 'no', 'a person\'s act with a human e-signature'])),
      para(`${String(b.analytics.methods.length)} methods; none changes GMP data.`),
    ],
  };
}
