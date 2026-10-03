/**
 * The contract examples are answers the server can give (review F55; DI-04, DI-05), and fixture mode answers what
 * the screens ask (lead TODO T7). The designer examples are the server's own answers for the dc-mini template
 * (compared with the server by apps/tablets-server/test/designer/contract-examples.test.ts); here they are checked
 * from the browser's side, with the review's reproducer (designer-ui-contract-examples) ported: the version content
 * is MBR content the designer opens and its hash is that content's, finding keys are `${rule}@${subject}`, valid
 * evidence agrees with the report of the same content, the simulation lists one run per path in the server's words,
 * no step or run example shows a moment after its own asOf, the step examples' limits are the template's, and the
 * designer page opens in fixture mode instead of waiting for a palette that never comes.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { allRoutes, routes, type SimulationReportView, type StepScreenView, type ValidationReportView, type VersionView } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import { flow } from '@ebmr/recipe-core/pure';
import dcMini from '../../../../packages/recipe-core/test/fixtures/dc-mini.mbr.json' with { type: 'json' };

const holder = vi.hoisted(() => ({ key: null as null | { privateKey: CryptoKey; publicKeySpki: string; label: string } }));
vi.mock('../../src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => Promise.resolve(),
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
}));

const { setTransport } = await import('../../src/api/client.ts');
const { createFixtureFetch } = await import('../../src/api/fixture-fetch.ts');
const { fixturesFromExamples } = await import('../../src/api/examples.ts');
const { fromWire } = await import('../../src/features/designer/model/wire.ts');
const { App } = await import('../../src/app/App.tsx');

const versions = [EXAMPLES.version.data, EXAMPLES['version-in-verification'].data] as unknown as VersionView[];
const reports = [EXAMPLES['validation-report'].data, EXAMPLES['validation-report-findings'].data] as unknown as ValidationReportView[];
const simulation = EXAMPLES['simulation-report'].data as unknown as SimulationReportView;
const STEP_NAMES = Object.keys(EXAMPLES).filter((n) => n.startsWith('step-'));

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'PC-DESIGN-01' };
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
});

describe('the designer examples are answers the server could give (review F55)', () => {
  it('[DI-04] each version example carries MBR content the designer opens, and its contentHash is the hash of that content', () => {
    for (const v of versions) {
      expect(() => fromWire(v.content), v.state).not.toThrow();
      expect(v.contentHash, v.state).toBe(flow.mbrContentHash(fromWire(v.content)));
      expect(v.number, 'the server labels versions 1, 2, ...').toMatch(/^[1-9][0-9]*$/);
      expect(v.auditChain).toBe(`mbr_version:${v.versionId}`);
    }
  });

  it('[DI-04][PR-03] finding keys are `${rule}@${subject}`, the key a justification names; each justification names a finding of its content', () => {
    for (const r of reports) for (const f of r.findings) expect(f.key, f.key).toMatch(new RegExp(`^${f.rule}@.`));
    const v = versions[0] as VersionView;
    const sameContent = reports.find((r) => r.contentHash === v.contentHash);
    expect(sameContent).toBeDefined();
    for (const j of v.justifications) {
      const f = sameContent?.findings.find((x) => x.key === j.findingKey);
      expect(f?.severity, j.findingKey).toBe('WARNING');
      expect(f?.justification?.text).toBe(j.text);
    }
  });

  it('[DI-04] the valid evidence of a version agrees with the validation report of the same content; the evidence kind is VALIDATOR', () => {
    let pairs = 0;
    for (const v of versions) {
      for (const e of v.evidence.filter((x) => x.valid)) {
        expect(e.contentHash).toBe(v.contentHash);
        expect(e.kind).toBe('VALIDATOR');
        expect(e.summary).toMatch(/^Passed: \d+ errors, \d+ warnings \(\d+ justifications recorded\)$/);
        for (const r of reports.filter((x) => x.contentHash === e.contentHash)) {
          pairs += 1;
          expect(r.gate.passed, `evidence "${e.summary}" for a report with ${r.gate.errors} errors`).toBe(true);
        }
      }
    }
    expect(pairs).toBeGreaterThan(0);
    // The report with the deleted clearance step is of other content than any saved version.
    const failing = reports.find((r) => !r.gate.passed);
    expect(failing?.findings.map((f) => f.key)).toContain('GMP-STAGE-CLEARANCE@S-BLEND');
    expect(versions.map((v) => v.contentHash)).not.toContain(failing?.contentHash);
  });

  it('[DI-04][DI-05] the simulation example lists one run per counted path, in the server\'s words, for the version\'s content', () => {
    expect(simulation.contentHash).toBe(versions[0]?.contentHash);
    expect(simulation.runs).toHaveLength(simulation.paths);
    for (const r of simulation.runs) {
      expect(r.outcome).toMatch(/^(COMPLETED|COMPLETED WITH EXCEPTION|DID NOT COMPLETE)(, TARGETED: .+)?$/);
      expect(r.exceptions.length > 0, r.pathId).toBe(r.outcome.startsWith('COMPLETED WITH EXCEPTION'));
    }
    expect(simulation.watermark.source).toBe('SIMULATION');
  });

  it('[DI-05] fixture mode answers every route of the designer screens, and every fixed answer parses with its route\'s response', () => {
    for (const installation of ['GMP', 'SANDBOX'] as const) {
      const map = fixturesFromExamples(installation);
      if (installation === 'GMP') for (const id of ['designer.templates', 'designer.families', 'designer.palette', 'designer.version', 'designer.validate', 'designer.simulate']) expect(Object.keys(map), id).toContain(id);
      for (const [id, answer] of Object.entries(map)) {
        if (typeof answer === 'function') continue;
        const route = allRoutes(routes).find((r) => r.id === id);
        expect(route, id).toBeDefined();
        const parsed = route?.response.safeParse(answer);
        expect(parsed?.success, `${installation} ${id}: ${parsed?.success ? '' : JSON.stringify(parsed?.error.issues.slice(0, 2))}`).toBe(true);
      }
    }
  });
});

/** Every {us, text} instant of a value, with its path. */
function instants(x: unknown, path = '$'): { path: string; us: bigint; text: string }[] {
  if (Array.isArray(x)) return x.flatMap((v, i) => instants(v, `${path}[${i}]`));
  if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    const own = typeof o['us'] === 'string' && typeof o['text'] === 'string' ? [{ path, us: BigInt(o['us']), text: o['text'] }] : [];
    return [...own, ...Object.entries(o).flatMap(([k, v]) => instants(v, `${path}.${k}`))];
  }
  return [];
}

const refs = new Map(dcMini.references.map((r) => [r.id, r]));
/** The limits of an item of the template as the server shows them (execution views.ts limitViews). */
function templateLimits(item: string): unknown[] | undefined {
  const spec = dcMini.parameters.find((p) => p.id === item && 'limits' in p)?.limits ?? dcMini.yieldCheckpoints.find((y) => y.result === item)?.limits;
  return spec?.ranges.map((r) => {
    const ref = refs.get(r.source.ref);
    return {
      tier: r.tier,
      low: 'low' in r && r.low ? { value: r.low.value, inclusive: r.low.inclusive } : null,
      high: 'high' in r && r.high ? { value: r.high.value, inclusive: r.high.inclusive } : null,
      source: { kind: r.source.kind, ref: r.source.ref, text: ref ? `${ref.code} v${ref.version}: ${ref.title}` : r.source.ref },
      rounding: r.rounding,
    };
  });
}

describe('the step and run examples (review F55)', () => {
  it('[DI-05] no step or run example shows a moment after its own asOf', () => {
    const late: string[] = [];
    for (const [name, e] of Object.entries(EXAMPLES)) {
      const d = e.data as { asOf?: { us: string } };
      if (!d.asOf) continue;
      const asOf = BigInt(d.asOf.us);
      for (const i of instants(d)) if (i.us > asOf) late.push(`${name} ${i.path} ${i.text}`);
    }
    expect(late).toEqual([]);
  });

  it('[PR-08][DI-05] a field\'s limits are the template\'s limits of that item, or the block\'s tolerance band around the target the step reads', () => {
    let checked = 0;
    for (const name of STEP_NAMES) {
      const v = EXAMPLES[name as keyof typeof EXAMPLES].data as unknown as StepScreenView;
      for (const f of v.fields.filter((x) => x.limits.length > 0)) {
        checked += 1;
        if (f.limits.every((l) => l.source.kind === 'MBR_BLOCK_CONFIGURATION')) {
          expect(f.limits.map((l) => [l.tier, l.source.ref, l.rounding]), `${name} ${f.item}`).toEqual(f.limits.map(() => ['INTERNAL_ACTION', v.step.stepId, 'NONE (exact comparison)']));
          expect(f.target, `${name} ${f.item}`).not.toBeNull();
        } else {
          expect(f.limits, `${name} ${f.item}`).toEqual(templateLimits(f.item));
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
    // The blend step records the template's two parameters, with their targets.
    const g04 = EXAMPLES['step-g04-parameters'].data as unknown as StepScreenView;
    expect(g04.fields.map((f) => [f.item, f.target?.value])).toEqual(
      dcMini.parameters.filter((p) => p.id === 'blendTime' || p.id === 'blenderSpeed').map((p) => [p.id, { kind: 'DECIMAL', value: 'target' in p ? p.target : null, unit: p.unit }]),
    );
  });

  it('[DI-05] the run and step examples run the MBR of the version example, labelled as the server labels it', () => {
    const v = versions[0] as VersionView;
    for (const [name, e] of Object.entries(EXAMPLES)) {
      const d = e.data as { run?: { mbr?: unknown }; header?: { mbr?: unknown } };
      const mbr = d.run?.mbr ?? d.header?.mbr;
      if (!mbr) continue;
      expect(mbr, name).toEqual({ familyCode: v.familyCode, versionNumber: v.number, revision: v.revision, contentHash: v.contentHash });
    }
  });
});

describe('the sandbox examples (lead TODO T7)', () => {
  const run = EXAMPLES.run.data as { header: { runId: string; batchNumber: string; mbr: unknown } };
  const pkg = (EXAMPLES['test-packages'].data as { packages: { packageId: string }[] }).packages[0];

  it('[DI-05][INV-18] issue form, command answer, timeline, replay and lot belong to the run and package examples, under TEST- numbers', () => {
    const form = EXAMPLES['issue-form'].data;
    expect(form.packageId).toBe(pkg?.packageId);
    expect(form.batchSizes.map((b) => b.id)).toEqual(['BS-100K', 'BS-50K']);
    expect(form.markets).toContainEqual({ code: 'IN', locked: true });
    const result = EXAMPLES['command-result'].data as unknown as { accepted: true; step: StepScreenView };
    expect(result.step.run.runId).toBe(run.header.runId);
    expect(result.step.run.batchNumber).toBe(run.header.batchNumber);
    expect(result.step.run.batchNumber).toMatch(/^TEST-B\d{2}-\d{4}$/);
    expect(result.step.run.watermark.text).toBe('TEST, NOT GMP');
    expect(result.step.run.mbr).toEqual(run.header.mbr);
    expect(EXAMPLES.replay.data.runId).toBe(run.header.runId);
    expect(EXAMPLES.replay.data).toMatchObject({ identical: true, firstDifference: null, invariantViolations: [] });
    const entries = EXAMPLES.timeline.data.entries;
    expect(entries[0]?.kind).toBe('ISSUE');
    expect(entries.filter((e) => !e.accepted).map((e) => e.refusal)).toEqual([expect.stringContaining('ENG-NOT-ENABLED')]);
    expect(entries.map((e) => BigInt(e.at.us))).toEqual([...entries.map((e) => BigInt(e.at.us))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(EXAMPLES.lot.data.lotCode).toMatch(/^TEST-/);
  });

  it('[DI-05] fixture mode answers a command as the server answers an accepted one, and an unknown lot as the server refuses it', async () => {
    const fetch = createFixtureFetch(fixturesFromExamples('SANDBOX'), { installation: 'SANDBOX' });
    const post = async (path: string, body: unknown) => JSON.parse(await (await fetch(path, { method: 'POST', headers: {}, body: JSON.stringify(body) })).text()) as unknown;
    const runId = run.header.runId;
    const start = await post(`/api/test-runs/${runId}/commands`, { expectedVersion: 0, intent: { type: 'START_STEP', stepKey: 'p-disp-clear@' } });
    expect(start).toEqual(EXAMPLES['command-result'].data);
    const other = (await post(`/api/test-runs/${runId}/commands`, { expectedVersion: 7, intent: { type: 'SIGN_PERFORMED', stepKey: 'p-blend@' } })) as { version: number; step: StepScreenView };
    expect(routes.execution.command.response.safeParse(other).success).toBe(true);
    expect([other.version, other.step.step.stepKey]).toEqual([8, 'p-blend@']);
    const unknown = await fetch('/api/lots/TEST-L26-9999', { method: 'GET', headers: {} });
    expect(unknown.status).toBe(404);
    expect(JSON.parse(await unknown.text())).toMatchObject({ refusal: { code: 'EXE_NOT_FOUND', whatHappened: 'The lot was not found.' } });
    const known = await fetch(`/api/lots/${EXAMPLES.lot.data.lotCode}`, { method: 'GET', headers: {} });
    expect(JSON.parse(await known.text())).toEqual(EXAMPLES.lot.data);
  });

  it('[DI-05][PR-01] a fixture-mode kiosk page starts on the example session and shows the issue form of the example package', async () => {
    setTransport(createFixtureFetch(fixturesFromExamples('SANDBOX'), { installation: 'SANDBOX' }));
    window.history.replaceState(null, '', `/packages/${pkg?.packageId ?? ''}/issue`);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Issue a test batch' }, { timeout: 10000 })).toBeTruthy();
    const sizes = await screen.findByRole('radiogroup', { name: 'Batch size (approved sizes only)' });
    expect(within(sizes).getAllByRole('radio').map((r) => r.closest('label')?.textContent ?? r.getAttribute('aria-label') ?? '')).toEqual([expect.stringContaining('60.000 kg'), expect.stringContaining('30.000 kg')]);
  });
});

describe('fixture mode (lead TODO T7; review F55)', () => {
  it('[DI-05] a page with a terminal key starts on the example session and opens the example version in the designer', async () => {
    setTransport(createFixtureFetch(fixturesFromExamples('GMP'), { installation: 'GMP' }));
    const v = versions[0] as VersionView;
    window.history.replaceState(null, '', `/mbr/versions/${v.versionId}`);
    render(<App />);
    const heading = await screen.findByRole('heading', { level: 1, name: new RegExp(fromWire(v.content).header.title.replace(/[()]/g, '.')) }, { timeout: 10000 });
    expect(heading.textContent).toContain(`MBR-${v.familyCode}-v${v.number}`);
    expect(screen.queryByText('Loading the master record…')).toBeNull();
  });

  it('[DI-05] without a palette the designer says so instead of waiting for good', async () => {
    const rest = Object.fromEntries(Object.entries(fixturesFromExamples('GMP')).filter(([id]) => id !== 'designer.palette'));
    setTransport(createFixtureFetch(rest, { installation: 'GMP' }));
    window.history.replaceState(null, '', `/mbr/versions/${(versions[0] as VersionView).versionId}`);
    render(<App />);
    const main = await screen.findByRole('main', {}, { timeout: 10000 });
    expect(await within(main).findByText(/No fixture for GET \/api\/mbr\/palette/, {}, { timeout: 10000 })).toBeTruthy();
    expect(screen.queryByText('Loading the master record…')).toBeNull();
  });
});
