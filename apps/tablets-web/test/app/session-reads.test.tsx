/**
 * Reads belong to the person who is signed in: a switch of user on a kiosk drops every cached read, so the next
 * person's screens are fetched for them (the actions and reasons the server computes for the viewer).
 */
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResetReadsOnPersonChange } from '../../src/app/session-reads.tsx';

function Reader({ fetchFor }: { fetchFor: () => string }) {
  const q = useQuery({ queryKey: ['step'], queryFn: () => Promise.resolve(fetchFor()) });
  return <p>{q.data ?? 'loading'}</p>;
}

describe('reads are scoped to the signed-in person', () => {
  it('[DI-34][INV-03] after a switch of user the step view is fetched again for the new person; a re-render without a change keeps it', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    let viewer = 'operator';
    let fetches = 0;
    const fetchFor = () => {
      fetches += 1;
      return `actions for ${viewer}`;
    };
    const ui = (who: string) => (
      <QueryClientProvider client={qc}>
        <ResetReadsOnPersonChange who={who} />
        <Reader fetchFor={fetchFor} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui('p-operator|OPERATOR'));
    expect(await screen.findByText('actions for operator')).toBeTruthy();
    rerender(ui('p-operator|OPERATOR'));
    expect(fetches).toBe(1);
    viewer = 'verifier';
    rerender(ui('p-verifier|VERIFIER'));
    await waitFor(() => expect(screen.getByText('actions for verifier')).toBeTruthy());
    expect(fetches).toBe(2);
  });
});
