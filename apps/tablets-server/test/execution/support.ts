/**
 * Test support for module C3 (sandbox test runs): a sandbox server with a registered DEMO-ONLY seal key, its own
 * exchange directory and the TEST- lots of the demo seed; test packages built from the dc-mini template (or a
 * variant of it); and a driver that runs a test batch over HTTP as the seeded personas (badge taps and PINs on
 * the kiosks, user ID and password in the office), through C1's e-signature ceremony.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@ebmr/expr';
import { engine, execution, flow } from '@ebmr/recipe-core';
import { routes, type ActionView, type ClientIntent, type Result, type SignedIntent, type SignatureCredentials } from '@ebmr/api-contract';
import { openPersonaSession } from '@ebmr/test-kit';
import { DEMO_LOTS, registerLots } from '../../src/features/execution/seed.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { personaIn, refusalOf, startSigningServer, tapFor, valueOf } from '../esig/support.ts';

export { personaIn, refusalOf, valueOf } from '../esig/support.ts';

export interface ExecServer extends TestServer {
  exchangeDir: string;
}

/** A sandbox server for execution tests: seal key, exchange directory, demo lots. */
export async function startExecServer(env: Record<string, string> = {}): Promise<ExecServer> {
  const exchangeDir = mkdtempSync(join(tmpdir(), 'ebmr-c3-'));
  mkdirSync(join(exchangeDir, 'to-sandbox'), { recursive: true });
  const server = await startSigningServer('SANDBOX', { stub: false, env: { ...env, EBMR_EXCHANGE_DIR: exchangeDir } });
  const steward = await openPersonaSession(server.db, server.seed, 'steward');
  await registerLots(server.db.app, { ...steward, correlationId: randomUUID() }, DEMO_LOTS);
  return Object.assign(server, { exchangeDir });
}

const TEMPLATE = new URL('../../src/features/designer/templates/dc-mini.mbr.json', import.meta.url).pathname;

/** The dc-mini MBR content (parsed, canonical). */
export function dcMini(): flow.MbrContent {
  const parsed = flow.parseMbr(JSON.parse(readFileSync(TEMPLATE, 'utf8')));
  if (!parsed.ok) throw new Error(`dc-mini does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

type Json = Record<string, unknown>;

/** A variant of dc-mini: `edit` receives the children of the dispensing preparation (O-DISP-PREP) and the content. */
export function dcMiniVariant(edit: (prep: Json[], content: Json) => Json[]): flow.MbrContent {
  const content = JSON.parse(JSON.stringify(dcMini())) as Json;
  const stage = ((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
  const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
  prep['children'] = edit(prep['children'] as Json[], content);
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`the dc-mini variant does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

/** A QA hold point right after the booth clearance (APPROVED or NOT_APPROVED). */
export const withEarlyHoldPoint = (): flow.MbrContent =>
  dcMiniVariant(([clear, ...rest]) => [clear as Json, { kind: 'holdPoint', id: 'H-TEST', name: 'QA release of the dispensing booth', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, ...rest]);

/** The booth clearance is witnessed (check meaning WITNESSED) and runs in parallel with the balance check. */
export const withWitnessedClearance = (): flow.MbrContent =>
  dcMiniVariant((prep) => {
    const [clear, bal, ...rest] = prep as [Json, Json, ...Json[]];
    const witnessed = { ...clear, signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } };
    return [{ kind: 'parallel', id: 'par-prep', branches: [{ id: 'br-clear', name: 'Clearance', body: witnessed }, { id: 'br-bal', name: 'Balance', body: bal }] }, ...rest];
  });

/** A process-window of 1 s from the start to the end of the booth clearance (a breach is quick to provoke). */
export const withShortWindow = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    (content['timeConstraints'] as Json[]).push({
      id: 'TC-CLEAR-WINDOW', name: 'Booth clearance window', kind: 'PROCESS_WINDOW', from: { node: 'p-disp-clear', event: 'START' }, to: { node: 'p-disp-clear', event: 'END' },
      max: { value: '1', unit: 's' }, source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' }, breach: 'EXCEPTION', pauses: 'INCLUDED',
    });
    return prep;
  });

/** Blend time recorded first in the dispensing stage (its internal-action limits make a PR-08 breach easy). */
export const withEarlyParameter = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
    const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
    const p = mix.find((x) => x['id'] === 'p-blend') as Json;
    p['records'] = ['blenderSpeed'];
    const early = { ...p, id: 'p-early-time', name: 'Record the blend time', records: ['blendTime'], equipment: [] };
    return [early, ...prep];
  });

/** A package of `content` as the GMP designer exports it (unless overridden), written into the inbox. */
export function writePackage(server: ExecServer, content: flow.MbrContent, overrides: Partial<execution.TestPackageInput> = {}, fileName?: string): execution.TestPackageV1 {
  const pkg = execution.buildTestPackage({
    source: { installationKind: 'GMP', watermark: null },
    family: { familyId: randomUUID(), familyCode: content.header.family, product: { code: content.header.product.code, name: content.header.product.name, strength: content.header.product.strength } },
    version: { versionId: randomUUID(), number: '1', revision: 1, state: 'APPROVED' },
    content,
    justifications: [],
    exporter: { personId: randomUUID(), legalName: 'Asha Rao', loginName: 'asha.rao' },
    exportedAtUs: '1790581503000000',
    ...overrides,
  });
  writeFileSync(join(server.exchangeDir, 'to-sandbox', fileName ?? `${pkg.packageHash}.json`), JSON.stringify(pkg));
  return pkg;
}

/** Imports a package and issues a test batch of it as the issuer (office PC), with the issue variants given; returns the run id. */
export async function importAndIssue(
  server: ExecServer,
  issuer: TestBrowser,
  pkg: execution.TestPackageV1,
  inputs: Record<string, { kind: 'COUNT'; value: string }> = { tabletsPerBatch: { kind: 'COUNT', value: '100000' } },
  variants: Record<string, string> = {},
): Promise<string> {
  const listed = valueOf(await issuer.call(routes.execution.testPackages));
  if (!listed.packages.some((p) => p.packageHash === pkg.packageHash && p.imported)) valueOf(await issuer.call(routes.execution.importPackage, { params: { packageId: pkg.packageHash }, body: {} }));
  const size = pkg.content.header.batchSizes[0]?.id ?? '';
  const run = valueOf(await issuer.call(routes.execution.issue, { body: { packageId: pkg.packageHash, batchSize: size, markets: ['IN'], variants, inputs } }));
  return run.header.runId;
}

export const pinOf = (server: TestServer, key: string): SignatureCredentials => ({ kind: 'PIN', pin: personaIn(server, key).pin ?? '' });
export const passwordOf = (server: TestServer, key: string): SignatureCredentials => ({ kind: 'PASSWORD', loginName: personaIn(server, key).loginName, password: personaIn(server, key).password });

const kiosk = (b: TestBrowser): boolean => b.terminal.includes('KIOSK');

/** Drives one run over HTTP as the personas of the seed. */
export class RunDriver {
  signatures = 0;
  /** Called before every badge tap (a long test run advances the tap limiter's monotonic clock here). */
  beforeTap: () => void = () => undefined;

  constructor(
    readonly server: ExecServer,
    readonly runId: string,
    readonly browsers: Readonly<Record<string, TestBrowser>>,
  ) {}

  private async tap(b: TestBrowser, persona: string, path: string, body: Record<string, unknown>) {
    this.beforeTap();
    return tapFor(b, personaIn(this.server, persona), 'POST', path, body);
  }

  browser(persona: string): TestBrowser {
    const b = this.browsers[persona];
    if (!b) throw new Error(`no browser for ${persona}`);
    return b;
  }

  async version(persona = Object.keys(this.browsers)[0] ?? ''): Promise<number> {
    return valueOf(await this.browser(persona).call(routes.execution.run, { params: { runId: this.runId } })).header.version;
  }

  async stepView(persona: string, stepKey: string) {
    return valueOf(await this.browser(persona).call(routes.execution.step, { params: { runId: this.runId, stepKey } }));
  }

  async runView(persona: string) {
    return valueOf(await this.browser(persona).call(routes.execution.run, { params: { runId: this.runId } }));
  }

  /** A plain intent (tap on a kiosk). */
  async command(persona: string, intent: ClientIntent, opts: { expectedVersion?: number; idempotencyKey?: string; viewStepKey?: string } = {}) {
    const b = this.browser(persona);
    const body = { expectedVersion: opts.expectedVersion ?? (await this.version(persona)), intent, ...(opts.viewStepKey ? { viewStepKey: opts.viewStepKey } : {}) };
    const path = `/api/test-runs/${this.runId}/commands`;
    return b.call(routes.execution.command, {
      params: { runId: this.runId },
      body,
      ...(kiosk(b) ? { attribution: await this.tap(b, persona, path, body) } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
  }

  async ok(persona: string, intent: ClientIntent) {
    const r = await this.command(persona, intent);
    if (!r.ok) throw new Error(`${persona} ${intent.type} was refused: ${JSON.stringify(r.error.kind === 'REFUSAL' ? r.error.envelope.refusal : r.error)}`);
    return r.value;
  }

  /** The aggregate and meaning of a signed intent, as the screens offer them to `persona`. */
  async signing(persona: string, intent: SignedIntent): Promise<{ aggregateType: string; aggregateId: string; meaning: string; action: ActionView | undefined }> {
    if (intent.type === 'SIGN_OFF_STAGE') {
      const a = (await this.runView(persona)).actions.find((x) => x.action === 'SIGN_OFF_STAGE' && x.target === intent.stageKey);
      return { aggregateType: 'batch_stage', aggregateId: `${this.runId}:${intent.stageKey}`, meaning: a?.meaning ?? 'STAGE_SIGNED_OFF', action: a };
    }
    if (intent.type === 'DISPOSITION_EXCEPTION') {
      return { aggregateType: 'batch_exception', aggregateId: `${this.runId}:${intent.exception}`, meaning: 'EXCEPTION_DISPOSITIONED', action: undefined };
    }
    const view = await this.stepView(persona, intent.stepKey);
    const kind = intent.type === 'VERIFY' ? (intent.meaning === 'WITNESSED' ? 'WITNESS' : 'VERIFY') : intent.type;
    const a = view.actions.find((x) => (x.action === kind || (kind === 'VERIFY' && x.action === 'WITNESS') || (kind === 'WITNESS' && x.action === 'VERIFY')) && (intent.type !== 'DISPOSITION_HOLD_POINT' || x.target === intent.disposition));
    const meaning = intent.type === 'VERIFY' && intent.meaning === 'WITNESSED' ? 'WITNESSED' : (a?.meaning ?? '');
    return { aggregateType: 'batch_step', aggregateId: `${this.runId}:${intent.stepKey}`, meaning, action: a };
  }

  /** The full ceremony: content preview, challenge (tapped on a kiosk), PIN or password, sign. */
  async sign(persona: string, intent: SignedIntent, opts: { meaning?: string; expectedVersion?: number; credentials?: SignatureCredentials; proposal?: { outcome: 'NO_IMPACT' | 'DEVIATION_RAISED'; justification: string }; signAction?: SignedIntent } = {}) {
    const b = this.browser(persona);
    const s = await this.signing(persona, intent);
    const meaning = opts.meaning ?? s.meaning;
    // An exception disposition previews the proposal it signs, a hold point the decision it signs (disposition and
    // comment, under the meaning of the decision's class): both are part of the signed content (recipe-core 0295).
    const previewIntent =
      intent.type === 'DISPOSITION_EXCEPTION'
        ? `${meaning}|${Buffer.from(JSON.stringify({ outcome: opts.proposal?.outcome ?? intent.outcome, justification: opts.proposal?.justification ?? intent.justification }), 'utf8').toString('base64url')}`
        : intent.type === 'DISPOSITION_HOLD_POINT'
          ? `${engine.holdPointMeaning(intent.disposition)}|${Buffer.from(JSON.stringify({ disposition: intent.disposition, comment: intent.comment ?? null }), 'utf8').toString('base64url')}`
          : meaning;
    const content = await b.call(routes.esig.content, { query: { aggregateType: s.aggregateType, aggregateId: s.aggregateId, intent: previewIntent } });
    if (!content.ok) return { stage: 'content' as const, content, challenge: undefined, result: content as Result<never> };
    const action = { kind: 'ENGINE_COMMAND' as const, runId: this.runId, expectedVersion: opts.expectedVersion ?? (await this.version(persona)), intent };
    const body = { aggregateType: s.aggregateType, aggregateId: s.aggregateId, contentVersion: content.value.contentVersion, meaning, clientContentHash: sha256Hex(content.value.canonicalText), action };
    const challenge = await b.call(routes.esig.createChallenge, { body, ...(kiosk(b) ? { attribution: await this.tap(b, persona, '/api/esig/challenges', body) } : {}) });
    if (!challenge.ok) return { stage: 'challenge' as const, content, challenge, result: challenge as Result<never> };
    const signAction = opts.signAction ? { ...action, intent: opts.signAction } : action;
    const signBody = { challengeId: challenge.value.challengeId, credentials: opts.credentials ?? (kiosk(b) ? pinOf(this.server, persona) : passwordOf(this.server, persona)), action: signAction };
    const proof = await b.proof('POST', '/api/esig/sign', signBody);
    const result = await b.call(routes.esig.sign, { body: { ...signBody, proof } });
    if (result.ok) this.signatures += 1;
    return { stage: 'sign' as const, content, challenge, result };
  }

  async signed(persona: string, intent: SignedIntent, opts: { meaning?: string } = {}) {
    const r = await this.sign(persona, intent, opts);
    if (!r.result.ok) throw new Error(`${persona} ${intent.type} (${r.stage}) was refused: ${JSON.stringify(r.result.error.kind === 'REFUSAL' ? r.result.error.envelope.refusal : r.result.error)}`);
    return r.result.value;
  }
}

/** `status:code` of a refused call, or 'ok'. */
export function outcomeOf(r: Result<unknown>): string {
  if (r.ok) return 'ok';
  return r.error.kind === 'REFUSAL' ? `${r.error.status}:${r.error.envelope.refusal.code}` : r.error.kind;
}

export { refusalOf as refusal };

/** Rows of a run as the database stores them (superuser read). */
export async function rowsOf(server: TestServer, runId: string) {
  const { rows } = await server.db.admin.query<{ seq: string; kind: string; command_type: string; accepted: boolean; refusal: { code: string } | null; signature_ids: string[]; auth_event_id: string | null; device_class: string }>(
    'select c.seq::text as seq, c.kind, c.command_type, c.accepted, c.refusal, c.signature_ids::text[] as signature_ids, c.auth_event_id, c.device_class from recipe.execution_command c where c.batch_id = $1 order by c.seq',
    [runId],
  );
  return rows;
}

export async function violations(server: TestServer): Promise<{ batchId: string | null; problem: string }[]> {
  return execution.executionViolations(server.db.admin);
}
