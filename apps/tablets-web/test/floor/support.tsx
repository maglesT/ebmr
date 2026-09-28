/**
 * Test harness for the floor screens (module C4): the floor routes in a memory router, the contract examples
 * through the fixture fetch (extended locally), a recording transport, and fake ports (badge tap, ceremony,
 * scale slot). No server: every answer is a contract example or a test's own.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ComponentType } from 'react';
import { vi } from 'vitest';
import { IDEMPOTENCY_HEADER, type Attribution, type FetchLike, type ReadingView, type RefusalEnvelope, type StepScreenView } from '@ebmr/api-contract';
import { EXAMPLES, example } from '@ebmr/api-contract/examples';
import { setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import { BadgeTapPortProvider, CeremonyPortProvider, ScaleSlotProvider, StubScaleCaptureSlot, type BadgeTapPort, type ScaleCaptureSlotProps, type SignatureCeremonyPort } from '../../src/app/ports.tsx';
import * as floorFeature from '../../src/features/floor/index.tsx';
import { FloorSessionContext, type FloorSession } from '../../src/features/floor/session.tsx';

export const RUN_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

export const OPERATOR: FloorSession = {
  personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e52',
  legalName: 'TEST-Arjun Das',
  loginName: 'test-operator-2',
  role: 'OPERATOR',
  attribution: 'TAP',
  deviceCode: 'TEST-KIOSK-BLEND-1',
  roomCode: 'BLEND-1',
};

export const ATTRIBUTION: Attribution = { method: 'BADGE_TAP', badgeUid: 'TEST-BADGE-OP2', proof: { spki: 'AAAA', nonce: 'nonce-0123456789abcdef', sig: 'AAAA' } };

export interface Recorded {
  method: string;
  path: string;
  idempotencyKey: string | null;
  body: Record<string, unknown> | undefined;
}

export type Answer = { status: number; body: unknown } | 'NETWORK_ERROR';
/** A test's own server for some requests; undefined falls through to the fixtures. */
export type Intercept = (req: Recorded) => Answer | undefined | Promise<Answer | undefined>;

export function envelope(kind: RefusalEnvelope['refusal']['kind'], code: string, extra: Partial<RefusalEnvelope['refusal']> = {}, retryable = false): RefusalEnvelope {
  return {
    refusal: { code, kind, whatHappened: extra.whatHappened ?? `Refused: ${code}`, why: extra.why ?? '', controls: extra.controls ?? [], whatYouCanDo: extra.whatYouCanDo ?? [], whoCanHelp: extra.whoCanHelp ?? [], ...(extra.details ? { details: extra.details } : {}) },
    correlationId: 'test-correlation',
    retryable,
  };
}

export function fakeTap(result: Attribution | null = ATTRIBUTION, switched = false) {
  return {
    requestTap: vi.fn((reason: string, request: { method: string; path: string; body: Record<string, unknown> }) => {
      void reason;
      void request;
      return Promise.resolve(result);
    }),
    offerSwitch: vi.fn((refusal: RefusalEnvelope) => {
      void refusal;
      return Promise.resolve(switched);
    }),
  } satisfies BadgeTapPort;
}

export function fakeCeremony(outcome: Awaited<ReturnType<SignatureCeremonyPort['sign']>> = { status: 'CANCELLED' }) {
  return { sign: vi.fn((req: Parameters<SignatureCeremonyPort['sign']>[0]) => {
    void req;
    return Promise.resolve(outcome);
  }) } satisfies SignatureCeremonyPort;
}

/** A scale slot that "captures" the given readings, one per purpose, when its button is pressed. */
export function fakeScaleSlot(readings: Partial<Record<'TARE' | 'GROSS' | 'CHECK', ReadingView>>, seen: ScaleCaptureSlotProps[] = []): ComponentType<ScaleCaptureSlotProps> {
  return function FakeSlot(props: ScaleCaptureSlotProps) {
    seen.push(props);
    const r = readings[props.purpose];
    return (
      <button type="button" disabled={props.disabled ?? false} onClick={() => r && props.onCaptured(r)}>
        Capture {props.purpose.toLowerCase()} on {props.deviceCodes.join(', ')}
      </button>
    );
  };
}

export const reading = (purpose: 'TARE' | 'GROSS', readingId: string, value: string): ReadingView => ({ ...example('reading'), readingId, value, purpose, raw: `S S      ${value} kg` });

/** A step example changed for a test (deep copy). */
export function stepVariant(name: Parameters<typeof example>[0], change: (v: StepScreenView) => void): StepScreenView {
  const v = structuredClone(example(name)) as StepScreenView;
  change(v);
  return v;
}

export type FakeTap = ReturnType<typeof fakeTap>;
export type FakeCeremony = ReturnType<typeof fakeCeremony>;

export interface RenderOptions {
  fixtures?: FixtureMap;
  intercept?: Intercept;
  session?: Partial<FloorSession>;
  tap?: FakeTap;
  ceremony?: SignatureCeremonyPort;
  scaleSlot?: ComponentType<ScaleCaptureSlotProps>;
}

const headers = { get: (n: string) => (n.toLowerCase() === 'x-ebmr-installation' ? 'SANDBOX' : null) };

export function renderFloor(path: string, opts: RenderOptions = {}) {
  const requests: Recorded[] = [];
  const fixtures = createFixtureFetch({ ...fixturesFromExamples('SANDBOX'), 'execution.lot': { status: 404, body: envelope('NOT_ALLOWED', 'LOT-UNKNOWN') }, ...(opts.fixtures ?? {}) }, { installation: 'SANDBOX' });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    const rec: Recorded = { method: init.method, path: u.pathname, idempotencyKey: init.headers[IDEMPOTENCY_HEADER] ?? null, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
    requests.push(rec);
    const answer = await opts.intercept?.(rec);
    if (answer === 'NETWORK_ERROR') throw new TypeError('Failed to fetch');
    if (answer) return { status: answer.status, headers, text: () => Promise.resolve(JSON.stringify(answer.body)) };
    return fixtures(url, init);
  };
  setTransport(transport);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({ routeTree: root.addChildren(floorFeature.routes(root)), history: createMemoryHistory({ initialEntries: [path] }) });
  const session: FloorSession = { ...OPERATOR, ...(opts.session ?? {}) };
  const tap = opts.tap ?? fakeTap();
  const ceremony = opts.ceremony ?? fakeCeremony();
  const utils = render(
    <QueryClientProvider client={qc}>
      <FloorSessionContext.Provider value={session}>
        <CeremonyPortProvider value={ceremony}>
          <BadgeTapPortProvider value={tap}>
            <ScaleSlotProvider value={opts.scaleSlot ?? StubScaleCaptureSlot}>
              <RouterProvider router={router} />
            </ScaleSlotProvider>
          </BadgeTapPortProvider>
        </CeremonyPortProvider>
      </FloorSessionContext.Provider>
    </QueryClientProvider>,
  );
  return { ...utils, requests, router, qc, tap, ceremony, commands: () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/commands')) };
}

/** Step fixtures by step key, including test variants (the fixture fetch answers step views from this map). */
export function stepFixtures(...views: StepScreenView[]): FixtureMap {
  const base = Object.values(EXAMPLES)
    .filter((e) => 'routeId' in e && e.routeId === 'execution.step')
    .map((e) => e.data as StepScreenView);
  return {
    'execution.step': ({ params }: { params: Record<string, string> }) => views.find((v) => v.step.stepKey === params['stepKey']) ?? base.find((v) => v.step.stepKey === params['stepKey']) ?? { status: 404, body: envelope('NOT_ALLOWED', 'STEP-UNKNOWN') },
  };
}

export const stepPath = (stepKey: string) => `/runs/${RUN_ID}/steps/${encodeURIComponent(stepKey)}`;
