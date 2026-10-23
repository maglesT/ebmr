/**
 * Decision 0025 point 3, the second [meta] test (Phase 7 slice 7g-4): every command used to operate an installation, each
 * package.json script of the workspace and each command-line entry point (src/cli, the *cli.ts and main.ts files, the
 * ops scripts), has a screen of the web app that does the same, except the installer, which puts the software on a
 * server, and the developers' build, test and tooling commands, each listed here with why it is not an operation. A new
 * command fails the test until it is listed: with its screen and the routes that screen calls, or with its reason.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allRoutes, routes } from '@ebmr/api-contract';

/** The repository root: the nearest directory up from the working directory whose package.json is the workspace's (`ebmr`). */
function repoRoot(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'ebmr') return dir;
    if (dirname(dir) === dir) throw new Error('the repository root was not found');
  }
}
const ROOT = repoRoot();
const WEB = 'apps/tablets-web/src/features';

/** A command an installation is operated with, and the screen that does it now (its source file and the routes it calls). */
interface Screen {
  screen: string;
  calls: string[];
  does: string;
  /** A part of the command whose screen comes with a later slice (decision 0025: the drills with 7g-3). */
  pending?: string;
}

const SCREENS: Readonly<Record<string, Screen>> = {
  'ebmr#demo:setup': { screen: `${WEB}/operations/DemoDataPage.tsx`, calls: ['operations.demoLoad', 'operations.demoReset'], does: 'creates the demo databases with the personas, terminals and feature seeds: the demo data load (and reset) of the operations screen' },
  'tools/demo/src/cli.ts': { screen: `${WEB}/operations/DemoDataPage.tsx`, calls: ['operations.demoLoad'], does: 'setup: the demo data load; run: see ebmr#demo (a developer machine)' },
  'apps/tablets-server/src/cli/setup.ts': { screen: `${WEB}/operations/SetupWizard.tsx`, calls: ['operations.setupState', 'operations.setup'], does: 'bootstraps and seeds an installation: the first-run set-up (and the demo data load, DemoDataPage)' },
  'ebmr#openapi': { screen: `${WEB}/operations/ApiReferencePage.tsx`, calls: ['meta.openapi'], does: 'the OpenAPI document of the contract: the API reference page' },
  'apps/tablets-server/src/cli/openapi.ts': { screen: `${WEB}/operations/ApiReferencePage.tsx`, calls: ['meta.openapi'], does: 'the OpenAPI document: the API reference page' },
  'ops/backup/backup.sh': { screen: `${WEB}/operations/BackupsPage.tsx`, calls: ['operations.runBackup', 'operations.backups', 'operations.backupFile'], does: 'a backup job and its record: the backups page (operational backups; the retention-grade schedule stays the backup host\'s)' },
  // Slice 7g, work package 2: the drills and the hardening check (decision D-P7R-4: the upgrade drill runs on a sandbox or staging installation only).
  'packages/kernel/src/continuity/drill-cli.ts': { screen: `${WEB}/operations/DrillsPage.tsx`, calls: ['operations.runRestoreDrill', 'operations.drills'], does: 'drill: the restore drill and its record on the drills page; backup: the backups page (BackupsPage.tsx, operations.runBackup, as ops/backup/backup.sh)' },
  'ops/backup/drill.sh': { screen: `${WEB}/operations/DrillsPage.tsx`, calls: ['operations.runRestoreDrill', 'operations.drills'], does: 'the restore drill and its record: the drills page (the server runs the kernel\'s drill as a job; the backup service identity records it)' },
  'ebmr#drills': { screen: `${WEB}/operations/DrillsPage.tsx`, calls: ['operations.runRestoreDrill', 'operations.runUpgradeDrill', 'operations.drills'], does: 'the restore and upgrade drills and their records: the drills page (the upgrade drill on a sandbox or staging installation only)' },
  'tools/drills/src/cli.ts': { screen: `${WEB}/operations/DrillsPage.tsx`, calls: ['operations.runRestoreDrill', 'operations.runUpgradeDrill', 'operations.drills'], does: 'restore and upgrade: the drills page; the server runs the upgrade drill with this tool and records it' },
  'ebmr#security:hardening': { screen: `${WEB}/operations/DrillsPage.tsx`, calls: ['operations.runHardeningCheck', 'operations.drills'], does: 'the hardening check of an installation and its record: the drills page (the server runs the check with its own configuration)' },
  'tools/security/src/cli.ts': { screen: `${WEB}/operations/DrillsPage.tsx`, calls: ['operations.runHardeningCheck'], does: 'hardening: the drills page; licences, secrets, release and verify are the release\'s supply chain (see the ebmr#security scripts)' },
  'apps/simulators/src/erp/main.ts': { screen: `${WEB}/operations/DemoDataPage.tsx`, calls: ['operations.demoLoad'], does: 'the one-shot ERP catalogue import of the demo seed: part of the demo data load' },
  'apps/simulators/src/wms/main.ts': SIMULATORS('WMS'),
  'apps/simulators/src/qms/main.ts': SIMULATORS('QMS'),
  'apps/simulators/src/lims/main.ts': SIMULATORS('LIMS'),
  'apps/simulators/src/lms/main.ts': SIMULATORS('LMS'),
  'apps/simulators/src/cmms/main.ts': SIMULATORS('CMMS'),
  'apps/simulators/src/ems/main.ts': SIMULATORS('EMS'),
  'apps/simulators/src/serialisation/main.ts': SIMULATORS('L3'),
  'apps/simulators/src/opcua/main.ts': SIMULATORS('the OPC UA press and line'),
  // Slice 7g-3, WP1 (validation, export, records; D-P7R-2, D-P7R-5):
  'packages/kernel/src/records/records-cli.ts': { screen: `${WEB}/validation/ExportPages.tsx`, calls: ['validation.startFullExport', 'validation.fullExports', 'validation.runEvaluationPack'], does: 'full-export and evaluation-pack: the full export (a background job, each export with its SHA-256) and the periodic evaluation pages' },
  'ebmr#validation:iq': { screen: `${WEB}/validation/ValidationPages.tsx`, calls: ['validation.runIq', 'validation.iqRecords'], does: 'the IQ checks of an installation and their record: the IQ page (the same code, validation kit runIq; the record stored with its SHA-256)' },
  'ebmr#validation:bundle': { screen: `${WEB}/validation/ValidationPages.tsx`, calls: ['validation.evidence', 'validation.evidenceFile'], does: 'the evidence bundle of a release, built with the release: read and downloaded as shipped on the evidence page' },
  'ebmr#validation:generate': { screen: `${WEB}/validation/ValidationPages.tsx`, calls: ['validation.evidence', 'validation.evidenceFile'], does: 'the validation pack generated from the bundle: every document listed and downloaded on the evidence page (the same bytes, validation kit generatePack)' },
  'ebmr#validation:oq': { screen: `${WEB}/validation/ValidationPages.tsx`, calls: ['validation.evidence', 'validation.evidenceFile'], does: 'the OQ record of the release, from its regression, golden and browser suites: the OQ document of the validation pack on the evidence page' },
  'tools/validation/src/cli.ts': { screen: `${WEB}/validation/ValidationPages.tsx`, calls: ['validation.runIq', 'validation.evidence', 'validation.evidenceFile'], does: 'iq: the IQ page; bundle, generate and oq: the evidence bundle and the validation pack on the evidence page' },
};

function SIMULATORS(what: string): Screen {
  return { screen: `${WEB}/operations/SimulatorsPage.tsx`, calls: ['operations.controlSimulator', 'operations.simulatorFault', 'operations.simulators'], does: `the ${what} simulator and its faults: the simulators' test console` };
}

/** The installer (decision 0025 point 2: only putting the software on a server stays a script), and what it starts. */
const INSTALLER: Readonly<Record<string, string>> = {
  'ebmr#install:server': 'the one-command installer',
  'tools/install/src/cli.ts': 'the one-command installer',
  'tools/install/install.sh': 'the one-command installer',
  'apps/tablets-server/src/main.ts': 'the server process itself, started by the service the installer writes (systemd or docker compose)',
  'apps/site-gateway/src/main.ts': 'the site gateway, a device on the plant network with its own service on its own machine, installed like the server',
};

/** Not an operation of an installation: developers' build, test and tooling commands, and libraries of other commands. */
const NOT_OPERATIONS: Readonly<Record<string, string>> = {
  'ebmr#dev': 'a developer runs the stack with Vite dev servers on their machine',
  'ebmr#demo': 'a developer runs the demo stack (both servers, the gateway, the equipment simulators) on their machine; an installation runs as a service',
  'ebmr#demo:phase6-exit': 'records the owner\'s demo video of the Phase 6 exit through the browser suite',
  'ebmr#build:web': 'build of the web app (the installer builds it)',
  'ebmr#e2e': 'the browser suite',
  'ebmr#typecheck': 'build check', 'ebmr#lint': 'build check', 'ebmr#deps:check': 'build check', 'ebmr#pins:check': 'build check',
  'ebmr#test': 'the test suite', 'ebmr#test:json': 'the test suite', 'ebmr#ci': 'everything CI runs',
  'ebmr#register:import': 'the control register (development of the validation evidence)', 'ebmr#register:validate': 'the control register', 'ebmr#register:sync-tests': 'the control register',
  // D-P7R-2: register:status is a developer tool on the control register, not an operation of an installation.
  'ebmr#register:status': 'the control register',
  '@ebmr/record-viewer#build': 'the build of the stand-alone record viewer shipped with a full export',
  'apps/record-viewer/src/main.ts': 'the stand-alone record viewer: a page opened from the file system beside a full export, offline, with no installation behind it',
  'ebmr#trace': 'the traceability matrix', 'ebmr#trace:e2e': 'the traceability matrix',
  'ebmr#handbook': 'the generated handbook', 'ebmr#handbook:check': 'the generated handbook',
  'ebmr#mutation:ts': 'mutation testing', 'ebmr#mutation:sql': 'mutation testing',
  '@ebmr/tablets-web#dev': 'the Vite dev server', '@ebmr/tablets-web#build': 'the build of the web app (the installer runs it)', '@ebmr/tablets-web#preview': 'the Vite preview server',
  '@ebmr/e2e#test': 'the browser suite',
  'tools/register/src/cli.ts': 'the control register and the trace (see the ebmr#register and #trace scripts)',
  'tools/handbook/src/cli.ts': 'the generated handbook',
  'packages/expr/src/units/generator/cli.ts': 'build-time generator of the unit tables',
  'tools/dev-env/golden-clock/build.sh': 'development environment: builds the clock-shifted cluster of the golden batches',
  'tools/dev-env/runpod-setup.sh': 'development environment: prepares a CI-like pod for the heavy runs',
  'apps/tablets-server/src/cli/installation.ts': 'library of the set-up CLI and the demo data load (no entry point)',
  'apps/tablets-server/src/cli/review-batch.ts': 'library of the demo data load (the GMP review batch option); no route: each act it performs must have its own route and screen, which db-acts-have-routes checks without counting src/cli (slice 7h, D1)',
  'apps/tablets-server/src/cli/release-path.ts': 'library of the demo data load (the packaging-order option); no route: each act it performs must have its own route and screen, which db-acts-have-routes checks without counting src/cli (slice 7h, D1)',
  'apps/tablets-server/src/cli/line-completion.ts': 'library of the demo data load; no route: each act it performs must have its own route and screen, which db-acts-have-routes checks without counting src/cli (slice 7h, D1)',
  'apps/tablets-server/src/cli/demo-app.ts': 'library of the demo data load (the in-process server it drives); no route: each act it performs must have its own route and screen, which db-acts-have-routes checks without counting src/cli (slice 7h, D1)',
  'apps/tablets-server/src/cli/golden-gb-t-02.ts': 'library of the demo data load and the golden batches (masters)',
  'apps/tablets-server/src/cli/demo-routes.ts': 'library of the demo data load (the packaging-order option): the demo routes of R1, slice 7l; each act it performs has its own route and screen',
  'apps/tablets-server/src/cli/demo-sr-profile.ts': 'library of the demo data load (the packaging-order option): the SR product and its two finished lots of R4\'s third check, slice 7p; each act it performs has its own route and screen',
  'apps/tablets-server/src/cli/demo-route-masters.ts': 'library of the demo data load (masters of the demo routes, slice 7l)',
  'apps/tablets-server/src/cli/demo-route-beta-lactam.ts': 'library of the demo data load (the packaging-order option): demo route B, the beta-lactam suite of R7, slice 7n; each act it performs has its own route and screen',
  'apps/tablets-server/src/cli/demo-route-masters-b.ts': 'library of the demo data load (masters of demo route B, slice 7n)',
  'apps/tablets-server/src/cli/demo-route-masters-ds.ts': 'library of the demo data load (masters of demo routes D and S, slice 7m)',
  'apps/tablets-server/src/cli/golden-packaging.ts': 'library of the demo data load and the golden batches (masters)',
  'apps/simulators/src/scale/main.ts': 'an equipment simulator of the sandbox\'s site gateway (balances), started with the gateway in the demo stack; its faults are on its own web console',
  'apps/simulators/src/process/main.ts': 'an equipment simulator of the sandbox\'s site gateway (presses and coaters), started with the gateway in the demo stack; its own web console',
  // Slices 7d and 7e (merged on main after 7g-4 was built), classified when the 7g parts were integrated:
  'ebmr#guides:lists': 'the generated reference pages of the user guides (documentation build)',
  'ebmr#guides:build': 'the build of the user guides into HTML and PDF (documentation build)',
  'tools/guides/src/cli.ts': 'the user guides\' build (see the ebmr#guides scripts)',
  'ebmr#load': 'the load driver: a performance test of the release on a test cluster, not an operation of an installation',
  'tools/load/src/cli.ts': 'the load driver (see ebmr#load)',
  'ebmr#security:licences': 'the release\'s supply chain: the licence scan CI runs',
  'ebmr#security:secrets': 'the release\'s supply chain: the secret scan CI runs',
  'ebmr#security:release': 'the release\'s supply chain: the SBOM, manifest and signatures made when a release is built',
  'ebmr#security:verify': 'checks the signatures of a release\'s files before they are put on a server (with the installer, decision 0025 point 2)',
  'tools/drills/build-release-db.sh': 'development environment: builds a database with an earlier release\'s own code as the upgrade drill\'s starting point',
  'apps/simulators/src/printer/main.ts': 'an equipment simulator of the sandbox\'s site gateway (line printers), started with the gateway in the demo stack; its own web console',
};

/** Commands whose screen comes with a later slice of decision 0025 (each names the slice). */
const LATER: Readonly<Record<string, string>> = {
  // WP1 (validation, export, records): none (slice 7g-3 gave each its screen, SCREENS above)
  // WP2 (continuity, platform, access configuration): none (their screens: SCREENS above)
  // WP3 (master record, market and plant configuration): none
  // WP4 (floor, materials, batch numbers): none
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'fixtures' || name === 'dist' || name === 'test' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(relative(ROOT, p));
  }
  return out;
}

/** Every command of the workspace (header). */
function commands(): string[] {
  const out: string[] = [];
  const pkgs = ['package.json', ...['apps', 'packages', 'tools'].flatMap((d) => readdirSync(join(ROOT, d)).map((n) => `${d}/${n}/package.json`))].filter((p) => existsSync(join(ROOT, p)));
  for (const p of pkgs) {
    const pkg = JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as { name: string; scripts?: Record<string, string> };
    for (const s of Object.keys(pkg.scripts ?? {})) out.push(`${pkg.name}#${s}`);
  }
  const files = ['apps', 'packages', 'tools', 'ops'].flatMap((d) => walk(join(ROOT, d)));
  for (const f of files) {
    if (/\/src\/cli\/[^/]+\.ts$/.test(f) || /(^|\/)(cli|[a-z-]+-cli)\.ts$/.test(f) || /\/src\/(([a-z-]+)\/)?main\.ts$/.test(f) || /\.sh$/.test(f)) out.push(f);
  }
  return [...new Set(out)].sort();
}

describe('[meta] every command used to operate an installation has a screen (decision 0025 point 3)', () => {
  const found = commands();
  const listed = { ...SCREENS, ...INSTALLER, ...NOT_OPERATIONS, ...LATER };

  it('[meta] every package.json script and command-line entry point is listed: with its screen, as the installer, as no operation, or with the later slice of its screen', () => {
    expect(found.length).toBeGreaterThan(40);
    const unlisted = found.filter((c) => !(c in listed));
    expect(unlisted).toEqual([]);
    const lists = [SCREENS, INSTALLER, NOT_OPERATIONS, LATER].map((l) => Object.keys(l));
    const twice = found.filter((c) => lists.filter((l) => l.includes(c)).length > 1);
    expect(twice).toEqual([]);
  });

  it('[meta] nothing is listed that is no command any more (the lists stay true)', () => {
    expect(Object.keys(listed).filter((c) => !found.includes(c))).toEqual([]);
  });

  it('[meta] each command\'s screen exists and calls the routes that do what the command did', () => {
    const ids = new Set(allRoutes(routes).map((r) => r.id));
    const problems: string[] = [];
    for (const [command, s] of Object.entries(SCREENS)) {
      const file = join(ROOT, s.screen);
      if (!existsSync(file)) {
        problems.push(`${command}: no screen ${s.screen}`);
        continue;
      }
      const source = readFileSync(file, 'utf8');
      for (const id of s.calls) {
        if (!ids.has(id)) problems.push(`${command}: ${id} is no route of the contract`);
        const [ns, name] = id.split('.');
        if (!source.includes(`routes.${ns ?? ''}.${name ?? ''}`)) problems.push(`${command}: ${s.screen} does not call ${id}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
