/**
 * A form empties as soon as its command committed, before the lists it refreshes are read again: emptied after the
 * reread, the new row showed while the old entry still filled the form, and a person who began the next entry at once
 * lost it when the late reset fired (route E2E own-demotab, 7 November 2026). The list's reread is held open here, so
 * the form must already be empty while the list still waits.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';

const { setTransport } = await import('../../src/api/client.ts');
const { useApiQuery } = await import('../../src/api/hooks.ts');
const { DefineForm } = await import('../../src/app/define-form.tsx');

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function Lots() {
  const q = useApiQuery(routes.execution.testLots, {});
  return <p data-testid="lots">{q.data ? `${String(q.data.lots.length)} lots` : 'loading'}</p>;
}

afterEach(() => {
  cleanup();
});

describe('a form empties when its command committed', () => {
  it('[DI-28] the fields are empty once the command answered, while the refreshed list is still being read again', async () => {
    let listReads = 0;
    let releaseReread: (() => void) | null = null;
    setTransport(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path === '/api/session') return json(EXAMPLES['session-office'].data);
      if (path === '/api/test-lots' && method === 'POST') return json(EXAMPLES['register-test-lot'].data);
      if (path === '/api/test-lots') {
        listReads += 1;
        if (listReads > 1) await new Promise<void>((done) => (releaseReread = done));
        return json(EXAMPLES['test-lots'].data);
      }
      return new Response('{}', { status: 404 });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Lots />
        <DefineForm
          title="Register a test lot"
          route={routes.execution.registerTestLot}
          refresh={[routes.execution.testLots.id]}
          submitLabel="Register the test lot"
          fields={[
            { name: 'lotCode', label: 'Lot code', kind: 'text' },
            { name: 'materialCode', label: 'Material code', kind: 'text' },
            { name: 'materialName', label: 'Material name', kind: 'text' },
            { name: 'expiresInDays', label: 'Expires in (days)', kind: 'int' },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('1 lots')).toBeTruthy();
    const user = userEvent.setup();
    const lotCode = screen.getByRole('textbox', { name: /Lot code/ });
    await user.type(lotCode, 'TEST-API-001');
    await user.type(screen.getByRole('textbox', { name: /Material code/ }), 'RM-001');
    await user.type(screen.getByRole('textbox', { name: /Material name/ }), 'Test material');
    await user.type(screen.getByRole('textbox', { name: /Expires in/ }), '365');
    await user.click(screen.getByRole('button', { name: 'Register the test lot' }));
    // The list is being read again and is held open; the form is already empty.
    await waitFor(() => expect(listReads).toBe(2));
    await waitFor(() => expect((lotCode as HTMLInputElement).value).toBe(''));
    expect(releaseReread).not.toBeNull();
    (releaseReread as unknown as () => void)();
  });

  it('[DI-28] a command that commits while the list is still on its first read reads the list again: the new row shows (E2E library-softgel, 8 November 2026)', async () => {
    // TanStack Query joins an invalidation to a first read already on its way (no data yet), so the list kept the answer
    // of a read sent before the command committed. useRefresh now cancels that read first, and the list is read afresh.
    const one = EXAMPLES['test-lots'].data;
    const first = one.lots[0];
    if (!first) throw new Error('SETUP: the example lists no lot');
    const two = { lots: [{ ...first, lotCode: 'TEST-API-002' }, ...one.lots] };
    let listReads = 0;
    let committed = false;
    let releaseFirst: (() => void) | null = null;
    setTransport(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path === '/api/session') return json(EXAMPLES['session-office'].data);
      if (path === '/api/test-lots' && method === 'POST') {
        committed = true;
        return json(EXAMPLES['register-test-lot'].data);
      }
      if (path === '/api/test-lots') {
        listReads += 1;
        const seen = committed;
        if (listReads === 1) await new Promise<void>((done) => (releaseFirst = done));
        return json(seen ? two : one);
      }
      return new Response('{}', { status: 404 });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Lots />
        <DefineForm
          title="Register a test lot"
          route={routes.execution.registerTestLot}
          refresh={[routes.execution.testLots.id]}
          submitLabel="Register the test lot"
          fields={[
            { name: 'lotCode', label: 'Lot code', kind: 'text' },
            { name: 'materialCode', label: 'Material code', kind: 'text' },
            { name: 'materialName', label: 'Material name', kind: 'text' },
            { name: 'expiresInDays', label: 'Expires in (days)', kind: 'int' },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('lots').textContent).toBe('loading');
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Lot code/ }), 'TEST-API-002');
    await user.type(screen.getByRole('textbox', { name: /Material code/ }), 'RM-001');
    await user.type(screen.getByRole('textbox', { name: /Material name/ }), 'Test material');
    await user.type(screen.getByRole('textbox', { name: /Expires in/ }), '365');
    await user.click(screen.getByRole('button', { name: 'Register the test lot' }));
    await waitFor(() => expect(committed).toBe(true));
    // The first read, sent before the command committed, answers only now, with the list as it was then.
    await waitFor(() => expect(releaseFirst).not.toBeNull());
    (releaseFirst as unknown as () => void)();
    expect(await screen.findByText('2 lots')).toBeTruthy();
    expect(listReads).toBe(2);
  });
});
