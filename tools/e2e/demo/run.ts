/**
 * `pnpm demo:phase6-exit`: the Phase 6 exit demo as one re-runnable command (the demo list of
 * docs/build-plan/phase-6/phase-6-plan.md, "Exit criteria ... and demo").
 *
 *  1. Item 7, the lot transfer between two installations: vitest.demo.config.ts runs
 *     apps/tablets-server/test/demo/transfer.demo.ts (two GMP servers on HTTP), which writes what it observed.
 *  2. Items 1 to 6 under the real product: playwright.demo.config.ts starts the connected stack (demo/global-setup.ts:
 *     both servers, the gateways, the simulators, the adapters the servers start) and runs the @demo flows and the
 *     suite's mock recall, controlled dispensing and English step flows; the evidence reporter writes each step's
 *     measured facts and screenshot.
 *  3. The dated record: docs/build-plan/phase-6/exit-demo.md and its screenshots in docs/build-plan/phase-6/exit-demo/.
 *
 * `--record-only` writes the record again from the last run's outputs in .reports/ without running anything.
 * Every step runs even when an earlier one fails; an item without a passing run is recorded as FAIL with its error.
 * The exit code is non-zero when any item failed.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '@ebmr/demo';

const REPORTS = join(REPO_ROOT, '.reports');
const TRANSFER_OUT = join(REPORTS, 'demo-transfer.json');
const EVIDENCE = join(REPORTS, 'demo-evidence.json');
const EXITS = join(REPORTS, 'demo-exits.json');
const RECORD = join(REPO_ROOT, 'docs/build-plan/phase-6/exit-demo.md');
const SHOTS = join(REPO_ROOT, 'docs/build-plan/phase-6/exit-demo');

interface Step { title: string; expected: string; observed: Record<string, unknown> | null; started: string; finished: string; screenshot: string | null; actual: string }
interface EvTest { title: string; status: string; durationMs: number; startedAt: string; steps: { title: string; error: string | null }[]; evidence: Step[]; error: string | null }

const ITEMS: { n: number; title: string; files: string[] }[] = [
  { n: 1, title: 'ERP, QMS, LMS and CMMS exchanging data under injected faults; a stale LMS mirror refuses a step signature at the kiosk', files: ['demo/01-integrations.demo.ts'] },
  { n: 2, title: 'A press excursion over OPC UA acknowledged with a comment in the batch\'s alarm log', files: ['demo/02-press-alarm.demo.ts'] },
  { n: 3, title: 'A serial query (L3)', files: ['demo/03-serial-query.demo.ts'] },
  { n: 4, title: 'A mock recall from an API lot to every consignee, signed off by the authorised person', files: ['specs/phase6/genealogy-recall.spec.ts'] },
  { n: 5, title: 'Controlled dispensing under dual custody (IN-53 draft banner)', files: ['specs/phase6/controlled.spec.ts'] },
  { n: 6, title: 'English step screens', files: ['specs/phase6/english-step.spec.ts'] },
  { n: 7, title: 'A lot transferred between two sites (two installations) and accepted by local QA', files: [] },
];

/** Notes per item: how it was shown and what is arranged rather than done through a screen. */
const NOTES: Record<number, string> = {
  1: 'Faults: each system is its simulator process; each adapter is started by the GMP server itself from its service-keys file (MIRROR mode; the integrations feature and its adapter workers are GMP\'s) and pulls on its own 5 s timer. The demo only publishes on the simulators and switches their faults (POST /api/fault). Stale mirror: the step signature is on a TEST- batch at the sandbox kiosk (as in 6j-b); no adapter worker runs on the sandbox, so its LMS training arrives through the adapter\'s receiving command, called as the registered adapter identity. The staleness is real time: the LMS mirror bound is set to its minimum (60 s, a change-controlled setting) and no synchronisation follows until it has passed. Arranged in the database as the 6j-b flows do: the training coordinator\'s product requirement, the employee numbers, the change record. By design a same-key, same-hash resend is recorded as DEDUPLICATED without an alarm (an alarm is raised for a same key with a different hash), and a cut link is a TRANSPORT failure that is retried, not recorded as a refusal or alarm; the worker\'s error shows on the adapter page. The SEQUENCE_GAP alarms in the counts were raised by the adapters during the fault sequences (each listed per system).',
  2: 'Path used: the press\'s Alarms-and-Conditions REJECT_BURST on the OPC UA feed (OPC UA simulator -> GMP site gateway, its own process, holding the enrolled endpoint -> the GMP server\'s OPCUA adapter). Not shown: a tag-limit excursion over the gateway\'s process uplink: the GMP installation has no gateway uplink listener (only the sandbox server has one) and GB-T-03 does not start that path either (D-P6j-b-3); the alarm log and the acknowledgment are the same for both. Arranged: the press in use for the DEMO-ONLY review batch (an open equipment use after its verified cleaning), so the alarm binds to that batch.',
  3: 'The L3/L4 simulator is the GMP server\'s L3 system (EBMR_L3_URL); the server asks it live. Arranged as the L3 server test arranges it: the pool row of the review batch (tab.serial_pool).',
  4: 'The suite\'s 6j-b flow as it is: the lot chain (receipt, consumption, finished lot, two ERP distribution records) is arranged as the genealogy server tests arrange it; the explorer, the mock recall and the AP sign-off are the real screens. GB-T-03 shows the same recall with the shipments landed by the ERP adapter (golden job).',
  5: 'The suite\'s 6j-b flow as it is. IN-53 is a draft control (NDPS rules not verified; owner decision pending): every screen carries the draft banner.',
  6: 'The suite\'s 6j-b flow as it is (decision 0018: English only).',
  7: 'Two GMP servers (PUNE, GOA), each on its own database with its own installation key, listening on HTTP, as the 6i route tests run them; the exchange goes over HTTP between them. Arranged (deployment steps): the installation identities and proposed peers, the released intermediate lot at PUNE. Not through the browser: the transfer screens exist, but the two-installation browser stack is not built (the E2E stack has one GMP and one sandbox installation).',
};

function run(cmd: string, args: string[], env: Record<string, string>): number {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
  return r.status ?? 1;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const clean = (s: string): string => s.replace(ANSI, '');
const cell = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function main(): number {
  let startedAt = new Date().toISOString();
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  // --record-only: write the record again from the last run's outputs (no run).
  const recordOnly = process.argv.includes('--record-only');
  let transferExit: number;
  let browserExit: number;
  let finishedAt: string;
  if (recordOnly) {
    ({ startedAt, finishedAt, transferExit, browserExit } = JSON.parse(readFileSync(EXITS, 'utf8')) as { startedAt: string; finishedAt: string; transferExit: number; browserExit: number });
  } else {
    for (const f of [TRANSFER_OUT, EVIDENCE, EXITS]) rmSync(f, { force: true });
    transferExit = run('pnpm', ['vitest', 'run', '-c', 'vitest.demo.config.ts', '--reporter=dot'], { EBMR_DEMO_OUT: TRANSFER_OUT });
    browserExit = run('pnpm', ['--filter', '@ebmr/e2e', 'exec', 'playwright', 'test', '-c', 'playwright.demo.config.ts'], { EBMR_E2E_EVIDENCE_JPEG: '1', PLAYWRIGHT_BROWSERS_PATH: process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers' });
    finishedAt = new Date().toISOString();
    writeFileSync(EXITS, JSON.stringify({ startedAt, finishedAt, transferExit, browserExit }));
  }

  const tests: EvTest[] = existsSync(EVIDENCE) ? (JSON.parse(readFileSync(EVIDENCE, 'utf8')) as { tests: EvTest[] }).tests : [];
  const transfer = existsSync(TRANSFER_OUT) ? (JSON.parse(readFileSync(TRANSFER_OUT, 'utf8')) as { steps: { title: string; at: string; observed: Record<string, unknown> }[] }) : { steps: [] };

  mkdirSync(SHOTS, { recursive: true });
  for (const f of readdirSync(SHOTS)) if (/^item\d+-\d+\.(jpeg|png)$/.test(f)) rmSync(join(SHOTS, f));

  const lines: string[] = [];
  const verdicts: string[] = [];
  let failed = 0;
  lines.push('# Phase 6 exit demo, record', '');
  lines.push(`Run ${startedAt} to ${finishedAt} (UTC), commit ${commit}, by \`pnpm demo:phase6-exit\` (tools/e2e/demo/run.ts). Written by the run; re-running replaces this file and the screenshots.`, '');
  lines.push('The stack is the real product: the GMP and sandbox servers, the sandbox site gateway with its scale simulator, a GMP site gateway holding the OPC UA press endpoint, the ERP, QMS, LMS, CMMS, L3/L4 and OPC UA simulators each as its own process, the adapters started by the servers themselves, and Chromium (tools/e2e/demo/global-setup.ts). Item 7 runs two further GMP servers on HTTP (vitest.demo.config.ts). DEMO-ONLY data and credentials; every name is unique per run, so ids, hashes and times differ between runs while the outcomes do not.', '');
  lines.push('## Summary', '', '| Item | What | Result |', '|---|---|---|');
  const body: string[] = [];
  for (const item of ITEMS) {
    let pass: boolean;
    const out: string[] = [`## ${String(item.n)}. ${item.title}`, '', NOTES[item.n] ?? '', ''];
    if (item.n === 7) {
      pass = transferExit === 0 && transfer.steps.length >= 6;
      out.push(`Run by vitest (apps/tablets-server/test/demo/transfer.demo.ts): exit code ${String(transferExit)}.`, '');
      for (const s of transfer.steps) {
        out.push(`- **${s.title}** (${s.at})`);
        for (const [k, v] of Object.entries(s.observed)) out.push(`  - ${k}: \`${cell(v)}\``);
      }
      if (transfer.steps.length === 0) out.push('- Nothing observed: the run did not get past its set-up.');
    } else {
      const mine = tests.filter((t) => item.files.some((f) => t.title.includes(f)));
      pass = mine.length > 0 && mine.every((t) => t.status === 'passed');
      if (mine.length === 0) out.push(`Not run: no result for ${item.files.join(', ')} (the browser run exited with code ${String(browserExit)} before reaching it).`, '');
      let shot = 0;
      for (const t of mine) {
        const name = t.title.split(' > ').slice(-1)[0] ?? t.title;
        out.push(`### ${t.status === 'passed' ? 'Passed' : `**${t.status.toUpperCase()}**`}: ${cell(name)}`, '', `Started ${t.startedAt}, ${(t.durationMs / 1000).toFixed(1)} s.`, '');
        for (const e of t.evidence) {
          out.push(`- **${e.title}** (${e.started} to ${e.finished})`, `  - Expected: ${e.expected}`, `  - Actual: ${cell(e.actual.replace(/; observed: .*$/, ''))}`);
          for (const [k, v] of Object.entries(e.observed ?? {})) out.push(`  - ${k}: \`${cell(v)}\``);
          if (e.screenshot && existsSync(e.screenshot)) {
            shot += 1;
            const ext = e.screenshot.endsWith('.png') ? 'png' : 'jpeg';
            const dest = join(SHOTS, `item${String(item.n)}-${String(shot)}.${ext}`);
            copyFileSync(e.screenshot, dest);
            out.push(`  - Screenshot: [${relative(join(REPO_ROOT, 'docs/build-plan/phase-6'), dest)}](${relative(join(REPO_ROOT, 'docs/build-plan/phase-6'), dest)})`);
          }
        }
        if (t.error) out.push('', '```text', clean(t.error).split('\n').slice(0, 12).join('\n'), '```');
        out.push('');
      }
    }
    if (!pass) failed += 1;
    out.push(`**${pass ? 'PASS' : 'FAIL'}**`, '');
    verdicts.push(`| ${String(item.n)} | ${item.title} | ${pass ? 'PASS' : 'FAIL'} |`);
    body.push(...out);
  }
  lines.push(...verdicts, '');
  const size = readdirSync(SHOTS).reduce((a, f) => a + statSync(join(SHOTS, f)).size, 0);
  lines.push(`Screenshots: ${String(readdirSync(SHOTS).length)} files, ${(size / 1024).toFixed(0)} KiB in exit-demo/.`, '');
  lines.push(...body);
  writeFileSync(RECORD, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
  console.log(`\nPhase 6 exit demo: ${String(ITEMS.length - failed)} of ${String(ITEMS.length)} items PASS; record ${relative(REPO_ROOT, RECORD)}`);
  return failed === 0 ? 0 : 1;
}

process.exit(main());
