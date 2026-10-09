/**
 * One group's SQL mutation report as a GitHub check run, so the result can be read through the GitHub API (GET
 * repos/{owner}/{repo}/commits/{sha}/check-runs) where the workflow's artifacts cannot be downloaded. The weekly workflow
 * (.github/workflows/mutation.yml, job `sql`) runs this after each group's run and POSTs the payload to
 * repos/{owner}/{repo}/check-runs.
 *
 * The check run is never a failure, so it never marks a commit or a pull request red: `success` when the group met its
 * threshold, `neutral` otherwise or when there is no report (the run died before the group finished); the job's own
 * result is the run's. Its output: the title is the group's score line, the summary the group's row of summary.md and
 * the counts by status, the text every mutant not killed (one JSON object per line, survivors first), cut to GitHub's
 * limit with a note in the summary.
 *
 * Usage: tsx tools/sql-mutation/src/check-run.ts <group> <report directory> <head sha>   (the payload, as JSON, on stdout)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, type Result, type Status } from './run.ts';
import { TARGETS } from './targets.ts';

/** GitHub takes at most 65,535 characters in output.text and output.summary; the text is kept to this. */
export const TEXT_LIMIT = 65_000;

export interface CheckRunPayload {
  name: string;
  head_sha: string;
  status: 'completed';
  conclusion: 'success' | 'neutral';
  /** text is left out when every mutant was killed or there is no report. */
  output: { title: string; summary: string; text?: string };
}

const STATUSES: Status[] = ['KILLED', 'SURVIVED', 'TIMEOUT', 'INVALID', 'EQUIVALENT'];
/** The order of the mutants not killed in the text: survivors first, then what the score counts, then what it leaves out. */
const ORDER: Record<Status, number> = { SURVIVED: 0, TIMEOUT: 1, INVALID: 2, EQUIVALENT: 3, KILLED: 4 };

/**
 * The check run of group `group` at commit `headSha`, from the run's report.json (`report`; undefined when it could not
 * be read, `problem` saying why) and summary.md (`summary`, undefined when missing).
 */
export function checkRunPayload(group: string, headSha: string, report: Result[] | undefined, summary: string | undefined, problem?: string): CheckRunPayload {
  const target = TARGETS.find((t) => t.group === group);
  if (!target) throw new Error(`unknown group: ${group}`);
  const base = { name: `SQL mutation report (${group})`, head_sha: headSha, status: 'completed' as const };
  const results = (report ?? []).filter((r) => r.group === group);
  if (results.length === 0) {
    const why = report === undefined ? (problem ?? 'report.json is missing') : `report.json holds no result of ${group}`;
    return {
      ...base,
      conclusion: 'neutral',
      output: {
        title: `${group}: no report`,
        summary: `${why}: the mutation run ended before the group finished (see the job's log). No score; the target is ${target.threshold} %.`,
      },
    };
  }

  const s = score(results);
  // As the run decides a group's verdict (run.ts main): a group with results fails below its threshold.
  const met = s.score >= target.threshold;
  const counts = STATUSES.map((st) => `${st} ${results.filter((r) => r.status === st).length}`).join(', ');
  const notKilled = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status !== 'KILLED')
    .sort((a, b) => ORDER[a.r.status] - ORDER[b.r.status] || a.i - b.i)
    .map(({ r }) =>
      JSON.stringify({ id: r.id, status: r.status, function: r.function, file: r.file, line: r.line, operator: r.operator, original: r.original, replacement: r.replacement }),
    );
  let text = '';
  let kept = 0;
  for (const line of notKilled) {
    if (text.length + line.length + 1 > TEXT_LIMIT) break;
    text += `${line}\n`;
    kept++;
  }

  const table = (summary ?? '').split('\n');
  const header = table.findIndex((l) => l.startsWith('| Group |'));
  const row = table.find((l) => l.startsWith(`| ${group} |`));
  const lines = [
    ...(header >= 0 && row ? [table[header] ?? '', table[header + 1] ?? '', row] : ['summary.md has no row for this group (the run ended before writing it).']),
    '',
    `Score ${s.score.toFixed(1)} % against a target of ${target.threshold} %: ${met ? 'met' : 'not met'}.`,
    `${results.length} mutants: ${counts}.`,
    notKilled.length === 0
      ? 'Every mutant was killed.'
      : kept === notKilled.length
        ? `The text lists the ${notKilled.length} mutants not killed, survivors first, one JSON object per line.`
        : `The text lists ${kept} of the ${notKilled.length} mutants not killed, survivors first, one JSON object per line; the other ${notKilled.length - kept} were cut at ${TEXT_LIMIT} characters (all are in the artifact's report.json).`,
  ];
  return {
    ...base,
    conclusion: met ? 'success' : 'neutral',
    output: { title: `${group}: ${s.score.toFixed(1)} % (${s.detected}/${s.valid} detected, ${s.invalid} invalid)`, summary: lines.join('\n'), ...(text ? { text } : {}) },
  };
}

function main(): void {
  const [group, dir, sha] = process.argv.slice(2);
  if (!group || !dir || !sha) throw new Error('usage: check-run.ts <group> <report directory> <head sha>');
  const reportFile = join(dir, 'report.json');
  const summaryFile = join(dir, 'summary.md');
  let report: Result[] | undefined;
  let problem: string | undefined;
  if (!existsSync(reportFile)) problem = 'report.json is missing';
  else {
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8')) as Result[];
      if (!Array.isArray(report)) throw new Error('not a list');
    } catch (e) {
      report = undefined;
      problem = `report.json is unreadable (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  const summary = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : undefined;
  process.stdout.write(`${JSON.stringify(checkRunPayload(group, sha, report, summary, problem))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
