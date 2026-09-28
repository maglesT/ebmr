/** Entry of the SPA. Fixture mode (VITE_EBMR_FIXTURES=1, for C4 before the sandbox server exists) swaps the transport. */
import '@ebmr/ui-kit/fonts';
import '@ebmr/ui-kit/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setTransport } from './api/client.ts';
import { App } from './app/App.tsx';

async function start(): Promise<void> {
  if (import.meta.env['VITE_EBMR_FIXTURES'] === '1') {
    const [{ createFixtureFetch }, { fixturesFromExamples }] = await Promise.all([import('./api/fixture-fetch.ts'), import('./api/examples.ts')]);
    const installation = import.meta.env['VITE_EBMR_INSTALLATION'] === 'GMP' ? 'GMP' : 'SANDBOX';
    setTransport(createFixtureFetch(fixturesFromExamples(installation), { installation }));
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('no #root element');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
