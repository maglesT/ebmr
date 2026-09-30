/**
 * Where a server step view is put in place after a command or a signature (module C4; INV-40; DI-34; DI-28; review
 * P44). The view in an answer was computed for the person who sent it: their "You" line and the actions open to them.
 * applyStepView puts it in place only while that person, working in that role, is the one signed in, checked when the
 * answer arrives and again right before it is put; otherwise nothing in the cache changes and the caller reads the
 * step again. useSignedInNow gives the person signed in at the moment of the call, and nobody once the screen that
 * started the work is gone.
 */
import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StepScreenView } from '@ebmr/api-contract';
import { applyStepView, stepQueryKey } from '../../src/features/floor/queries.ts';
import { FloorSessionContext, useSignedInNow, type FloorSession, type Viewer } from '../../src/features/floor/session.tsx';
import { OPERATOR, RUN_ID, stepVariant } from './support.tsx';

const VERIFIER: FloorSession = { ...OPERATOR, personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', role: 'VERIFIER' };
const KEY = stepQueryKey(RUN_ID, 'p-blend@');

/** G-04 at a run version, as the server computes it for `who` (null: a view naming nobody). */
function viewFor(who: (Viewer & Partial<FloorSession>) | null, version = 8): StepScreenView {
  return stepVariant('step-g04-parameters', (v) => {
    v.run.version = version;
    v.run.identity = who ? { personId: who.personId ?? '', legalName: who.legalName ?? 'TEST-Someone', loginName: who.loginName ?? 'test-someone', role: who.role ?? '' } : null;
  });
}

function cacheWith(view: StepScreenView): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(KEY, view);
  return qc;
}

describe('applyStepView', () => {
  it('[INV-40][DI-34] puts the view in place when it was computed for the person and role signed in now', async () => {
    const before = viewFor(OPERATOR, 7);
    const qc = cacheWith(before);
    const after = viewFor(OPERATOR, 8);
    expect(await applyStepView(qc, after, () => OPERATOR)).toBe(true);
    expect(qc.getQueryData(KEY)).toEqual(after);
  });

  it('[INV-40][DI-34] never puts a view computed for someone else in place: another person, the same person in another role, a view naming nobody, or nobody known to be signed in', async () => {
    const cases: { name: string; view: StepScreenView; now: Viewer | null }[] = [
      { name: 'another person', view: viewFor(OPERATOR), now: VERIFIER },
      { name: 'the same person in another role', view: viewFor(OPERATOR), now: { ...OPERATOR, role: 'SHIFT_SUPERVISOR' } },
      { name: 'a view naming nobody', view: viewFor(null), now: OPERATOR },
      { name: 'nobody known to be signed in (the screen is gone)', view: viewFor(OPERATOR), now: null },
      { name: 'no person in the session', view: viewFor({ personId: '', role: OPERATOR.role }), now: { personId: null, role: OPERATOR.role } },
    ];
    for (const c of cases) {
      // An older view on show: only who the view is for can keep the answer out.
      const before = viewFor(OPERATOR, 7);
      const qc = cacheWith(before);
      expect(await applyStepView(qc, c.view, () => c.now), c.name).toBe(false);
      expect(qc.getQueryData(KEY), c.name).toBe(before);
    }
  });

  it('[INV-40][DI-34] a view refused because it is another person\'s does not cancel the step read already on its way for the person signed in', async () => {
    const qc = cacheWith(viewFor(VERIFIER, 7));
    const theirs = viewFor(VERIFIER, 8);
    let answer: (v: StepScreenView) => void = () => undefined;
    const read = qc.fetchQuery({ queryKey: KEY, queryFn: () => new Promise<StepScreenView>((resolve) => (answer = resolve)) });
    expect(await applyStepView(qc, viewFor(OPERATOR, 8), () => VERIFIER)).toBe(false);
    answer(theirs);
    await expect(read).resolves.toEqual(theirs);
    expect(qc.getQueryData(KEY)).toEqual(theirs);
  });

  it('[INV-40][DI-34] the person signed in is checked again right before the view is put: a switch while the step read is being cancelled leaves the cache alone', async () => {
    const before = viewFor(OPERATOR, 7);
    const qc = cacheWith(before);
    let now: FloorSession = OPERATOR;
    const cancel = qc.cancelQueries.bind(qc);
    vi.spyOn(qc, 'cancelQueries').mockImplementation(async (...args) => {
      // The verifier takes over the terminal while the read is being cancelled.
      now = VERIFIER;
      await cancel(...args);
    });
    expect(await applyStepView(qc, viewFor(OPERATOR, 8), () => now)).toBe(false);
    expect(qc.getQueryData(KEY)).toBe(before);
  });

  it('[DI-28] a view older than the one on show is not put back, even for the person signed in', async () => {
    const newer = viewFor(OPERATOR, 9);
    const qc = cacheWith(newer);
    expect(await applyStepView(qc, viewFor(OPERATOR, 8), () => OPERATOR)).toBe(false);
    expect(qc.getQueryData(KEY)).toBe(newer);
  });
});

describe('useSignedInNow', () => {
  it('[INV-40][DI-34] answers the person signed in at the moment of the call (not the one of the render that started the work), and nobody once the component is gone', () => {
    let session: FloorSession = OPERATOR;
    const wrapper = ({ children }: { children: ReactNode }) => <FloorSessionContext.Provider value={session}>{children}</FloorSessionContext.Provider>;
    const { result, rerender, unmount } = renderHook(() => useSignedInNow(), { wrapper });
    const signedInNow = result.current;
    expect(signedInNow()?.personId).toBe(OPERATOR.personId);
    session = VERIFIER;
    rerender();
    expect(signedInNow()?.personId, 'the getter taken before the switch reads the person signed in now').toBe(VERIFIER.personId);
    expect(signedInNow()?.role).toBe('VERIFIER');
    unmount();
    expect(signedInNow()).toBeNull();
  });
});
