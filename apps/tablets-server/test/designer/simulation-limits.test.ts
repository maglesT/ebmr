/**
 * The simulation route is for the MBR roles and its cost is bounded (review P18; DI-05: the GMP server stays
 * available while simulations run). Each simulation first validates on the main thread and then runs in a fresh
 * worker thread with a 512 MB heap for up to the timeout; the route had no role check, no rate limit and no cap, so
 * any signed-in role could start any number at once.
 *
 * Now only an MBR author, checker or QA MBR approver may simulate (403 otherwise), at most
 * designerSettings.maxConcurrentSimulations run at once in the process (503 SIMULATION_BUSY beyond, retryable, nothing
 * started), and one session may start at most SIMULATION_RATE_LIMIT.max per minute (429).
 *
 * The validation route (POST /api/mbr/validate) runs the validator and the definition check on posted content on the
 * main thread too; it stays open to every signed-in role (anyone who may open a version sees its findings), but at
 * most designerSettings.maxConcurrentValidations run at once (503 VALIDATION_BUSY) and one session may ask for at most
 * VALIDATION_RATE_LIMIT.max per minute (429).
 *
 * Justify, start verification and export a test package analyse the saved content on the main thread too, and they
 * did so for any signed-in role before the database refused a role without MBR.AUTHOR. Now they are for the MBR
 * author only (403 before anything is analysed), each takes one of the same validation slots (503 VALIDATION_BUSY when
 * all are taken, nothing analysed) and one session may ask for at most DESIGNER_COMMAND_RATE_LIMIT.max of each per
 * minute (429).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes, type Result, type SimulationReportView, type ValidationReportView, type VersionView } from '@ebmr/api-contract';
import { DESIGNER_COMMAND_RATE_LIMIT, designerSettings, SIMULATION_RATE_LIMIT, VALIDATION_RATE_LIMIT } from '../../src/features/designer/index.ts';
import type * as Simulation from '../../src/features/designer/simulation.ts';
import type * as Validation from '../../src/features/designer/validation.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, refusalOf, startDesignerServer, valueOf } from './support.ts';

// The worker call can be held open (to have simulations "running") or answered at once without a worker.
const hold = vi.hoisted(() => ({ gate: null as Promise<void> | null, started: 0, instant: false, analyseGate: null as Promise<void> | null, analysing: 0 }));
// The validator's analysis can be held open too (to have validations "running").
vi.mock('../../src/features/designer/validation.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Validation>();
  return {
    ...actual,
    analyse: async (...args: Parameters<typeof actual.analyse>) => {
      hold.analysing += 1;
      if (hold.analyseGate) await hold.analyseGate;
      return actual.analyse(...args);
    },
  };
});
vi.mock('../../src/features/designer/simulation.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Simulation>();
  return {
    ...actual,
    simulateInWorker: async (...args: Parameters<typeof actual.simulateInWorker>) => {
      hold.started += 1;
      if (hold.instant) return { ok: false as const, message: 'not run (test)' };
      if (hold.gate) await hold.gate;
      return actual.simulateInWorker(...args);
    },
  };
});

let server: TestServer;
let author: TestBrowser;
let versionId: string;
let content: VersionView['content'];
let version: VersionView;
const savedMax = designerSettings.maxConcurrentSimulations;
const savedMaxValidations = designerSettings.maxConcurrentValidations;

const simulate = (b: TestBrowser): Promise<Result<SimulationReportView>> => b.call(routes.designer.simulate, { params: { versionId }, body: {} });
const validate = (b: TestBrowser, body: { content: VersionView['content']; versionId?: string } = { content, versionId }): Promise<Result<ValidationReportView>> =>
  b.call(routes.designer.validate, { body });
/** The three designer commands that analyse the saved content first, as `b` asks for them on version `id`. */
const commands = (b: TestBrowser, id = versionId): Record<'justify' | 'startVerification' | 'testPackage', () => Promise<Result<unknown>>> => ({
  justify: () =>
    b.call(routes.designer.justify, { params: { versionId: id }, body: { findingKey: 'G07-TOLERANCE-MISSING@p-disp-exc', text: 'Checked at reconciliation.', baseRevision: version.revision, contentHash: version.contentHash } }),
  startVerification: () => b.call(routes.designer.startVerification, { params: { versionId: id }, body: { baseRevision: version.revision } }),
  testPackage: () => b.call(routes.designer.testPackage, { params: { versionId: id }, body: {} }),
});
const statusOf = (r: Result<unknown>): number => (r.ok ? r.status : r.error.kind === 'REFUSAL' || r.error.kind === 'PROTOCOL' ? r.error.status : 0);

async function until(condition: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
  const v = await createFamily(author, { familyCode: 'PCM500-P18', batchSizes: [{ quantity: '18.000', unit: 'kg' }] });
  versionId = v.versionId;
  content = v.content;
  version = v;
});
beforeEach(() => {
  hold.gate = null;
  hold.started = 0;
  hold.instant = false;
  hold.analyseGate = null;
  hold.analysing = 0;
  designerSettings.maxConcurrentSimulations = savedMax;
  designerSettings.maxConcurrentValidations = savedMaxValidations;
});
afterAll(async () => {
  designerSettings.maxConcurrentSimulations = savedMax;
  designerSettings.maxConcurrentValidations = savedMaxValidations;
  await server?.close();
});

describe('simulation route: roles and bounded cost (DI-05)', () => {
  it('[DI-05] only the MBR roles may simulate; any other role is refused before anything runs', async () => {
    for (const persona of ['steward', 'regulatory']) {
      const other = await server.asPersona(persona);
      const r = refusalOf(await simulate(other));
      expect([persona, r.status, r.code]).toEqual([persona, 403, 'ROLE_NOT_ALLOWED']);
    }
    expect(hold.started).toBe(0);
    for (const persona of ['author', 'checker', 'approver']) {
      const mbrRole = await server.asPersona(persona);
      expect(valueOf(await simulate(mbrRole)).passed).toBe(true);
    }
  });

  it('[DI-05] at most the configured number of simulations run at once; one more is refused (503, retryable) and nothing is started for it', async () => {
    designerSettings.maxConcurrentSimulations = 2;
    let release: () => void = () => undefined;
    hold.gate = new Promise<void>((r) => (release = r));
    const [b1, b2, b3] = [await server.asPersona('author'), await server.asPersona('checker'), await server.asPersona('approver')];
    const p1 = simulate(b1);
    const p2 = simulate(b2);
    await until(() => hold.started === 2);
    const third = await Promise.race([simulate(b3), new Promise<'still running'>((r) => setTimeout(() => r('still running'), 5_000))]);
    release();
    expect(third, 'a third simulation was started while two were running').not.toBe('still running');
    if (third === 'still running') return;
    expect(third.ok).toBe(false);
    if (third.ok || third.error.kind !== 'REFUSAL') return;
    expect([third.error.status, third.error.envelope.refusal.code, third.error.envelope.retryable]).toEqual([503, 'SIMULATION_BUSY', true]);
    expect(hold.started).toBe(2);
    expect(valueOf(await p1).passed).toBe(true);
    expect(valueOf(await p2).passed).toBe(true);
    // The slots are free again once the running simulations finished.
    expect(valueOf(await simulate(b3)).passed).toBe(true);
  });

  it('[DI-05] one session may start only a limited number of simulations a minute (429)', async () => {
    hold.instant = true;
    const b = await server.asPersona('author');
    const seen: number[] = [];
    for (let i = 0; i <= SIMULATION_RATE_LIMIT.max; i += 1) {
      seen.push(statusOf(await simulate(b)));
    }
    expect(seen.slice(0, SIMULATION_RATE_LIMIT.max).every((s) => s !== 429)).toBe(true);
    expect(seen[SIMULATION_RATE_LIMIT.max]).toBe(429);
    // Another session is not affected.
    const other = await server.asPersona('author');
    expect(statusOf(await simulate(other))).not.toBe(429);
  });
  it('[DI-05] at most the configured number of validations run at once; one more is refused (503, retryable) before anything runs', async () => {
    designerSettings.maxConcurrentValidations = 2;
    let release: () => void = () => undefined;
    hold.analyseGate = new Promise<void>((r) => (release = r));
    const [b1, b2, b3] = [await server.asPersona('author'), await server.asPersona('checker'), await server.asPersona('regulatory')];
    const p1 = validate(b1);
    const p2 = validate(b2);
    await until(() => hold.analysing === 2);
    const third = await Promise.race([validate(b3), new Promise<'still running'>((r) => setTimeout(() => r('still running'), 5_000))]);
    release();
    expect(third, 'a third validation was started while two were running').not.toBe('still running');
    if (third === 'still running') return;
    expect(third.ok).toBe(false);
    if (third.ok || third.error.kind !== 'REFUSAL') return;
    expect([third.error.status, third.error.envelope.refusal.code, third.error.envelope.retryable]).toEqual([503, 'VALIDATION_BUSY', true]);
    expect(hold.analysing).toBe(2);
    expect(valueOf(await p1).gate.passed).toBe(true);
    expect(valueOf(await p2).gate.passed).toBe(true);
    // The slots are free again once the running validations finished (a role outside the MBR roles validates too).
    expect(valueOf(await validate(b3)).gate.passed).toBe(true);
  });

  it('[DI-05] one session may ask for only a limited number of validations a minute (429)', async () => {
    const b = await server.asPersona('author');
    const seen: number[] = [];
    // Content that does not parse is answered quickly; the rate counts every request.
    for (let i = 0; i <= VALIDATION_RATE_LIMIT.max; i += 1) {
      seen.push(statusOf(await validate(b, { content: { format: 'not-an-mbr', formatVersion: 0 } })));
    }
    expect(seen.slice(0, VALIDATION_RATE_LIMIT.max).every((s) => s !== 429)).toBe(true);
    expect(seen[VALIDATION_RATE_LIMIT.max]).toBe(429);
    // Another session is not affected.
    const other = await server.asPersona('author');
    expect(statusOf(await validate(other))).toBe(200);
  });
});

describe('designer commands that analyse the saved content: author only, bounded cost (DI-05)', () => {
  it('[DI-05][DI-17] justify, start verification and test package are for the MBR author only; any other role is refused before anything is analysed', async () => {
    const seen: string[][] = [];
    for (const persona of ['steward', 'regulatory', 'checker', 'approver']) {
      const other = await server.asPersona(persona);
      for (const [name, call] of Object.entries(commands(other))) {
        const r = refusalOf(await call());
        seen.push([persona, name, String(r.status), r.code]);
      }
    }
    expect(seen.every(([, , status, code]) => status === '403' && code === 'ROLE_NOT_ALLOWED'), JSON.stringify(seen)).toBe(true);
    expect(seen).toHaveLength(12);
    expect(hold.analysing).toBe(0);
    // The version is untouched: still the DRAFT at its first revision, with no justification.
    const after = valueOf(await author.call(routes.designer.version, { params: { versionId } }));
    expect([after.state, after.revision, after.justifications]).toEqual(['DRAFT', version.revision, []]);
  });

  it('[DI-05] each takes one of the validation slots: when all are taken it is refused (503, retryable) before anything is analysed', async () => {
    designerSettings.maxConcurrentValidations = 1;
    let release: () => void = () => undefined;
    hold.analyseGate = new Promise<void>((r) => (release = r));
    const running = validate(await server.asPersona('checker'));
    await until(() => hold.analysing === 1);
    const answers: [string, number, string, boolean][] = [];
    const sent: Promise<unknown>[] = [];
    for (const [name, call] of Object.entries(commands(author))) {
      const p = call();
      sent.push(p);
      const r = await Promise.race([p, new Promise<'still running'>((res) => setTimeout(() => res('still running'), 5_000))]);
      if (r === 'still running') answers.push([name, 0, 'analysing without a slot', false]);
      else if (r.ok || r.error.kind !== 'REFUSAL') answers.push([name, r.ok ? r.status : 0, 'not a refusal', false]);
      else answers.push([name, r.error.status, r.error.envelope.refusal.code, r.error.envelope.retryable]);
    }
    release();
    await Promise.allSettled(sent);
    expect(answers).toEqual([
      ['justify', 503, 'VALIDATION_BUSY', true],
      ['startVerification', 503, 'VALIDATION_BUSY', true],
      ['testPackage', 503, 'VALIDATION_BUSY', true],
    ]);
    expect(hold.analysing).toBe(1);
    expect(valueOf(await running).gate.passed).toBe(true);
  });

  it('[DI-05] one session may ask for only a limited number of each a minute (429)', async () => {
    // A version that does not exist is answered quickly; the rate counts every request.
    const missing = '00000000-0000-4000-8000-00000000f018';
    for (const name of ['justify', 'startVerification', 'testPackage'] as const) {
      const b = await server.asPersona('author');
      const seen: number[] = [];
      for (let i = 0; i <= DESIGNER_COMMAND_RATE_LIMIT.max; i += 1) seen.push(statusOf(await commands(b, missing)[name]()));
      expect([name, seen.slice(0, DESIGNER_COMMAND_RATE_LIMIT.max).every((st) => st !== 429)]).toEqual([name, true]);
      expect([name, seen[DESIGNER_COMMAND_RATE_LIMIT.max]]).toEqual([name, 429]);
      // Another session is not affected.
      const other = await server.asPersona('author');
      expect([name, statusOf(await commands(other, missing)[name]())]).toEqual([name, 404]);
    }
    expect(hold.analysing).toBe(0);
  });
});
