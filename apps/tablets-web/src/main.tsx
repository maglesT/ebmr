/** Entry of the SPA. Fixture mode (VITE_EBMR_FIXTURES=1, for C4 before the sandbox server exists) swaps the transport. */
// First: zod must run jitless under the strict CSP (no eval), before any schema is built.
import '@ebmr/api-contract/strict-csp';
import '@ebmr/ui-kit/fonts';
import '@ebmr/ui-kit/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setTransport } from './api/client.ts';
import { App } from './app/App.tsx';
import { takeSignonFragment } from './app/platform-signon.ts';

async function start(): Promise<void> {
  if (import.meta.env['VITE_EBMR_FIXTURES'] === '1') {
    const [{ createFixtureFetch }, { fixturesFromExamples }] = await Promise.all([import('./api/fixture-fetch.ts'), import('./api/examples.ts')]);
    const installation = import.meta.env['VITE_EBMR_INSTALLATION'] === 'GMP' ? 'GMP' : 'SANDBOX';
    setTransport(createFixtureFetch(fixturesFromExamples(installation), { installation }));
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('no #root element');
  // Phase B slice 2: the window core's re-authentication came back to only hands the proof to its signature dialog.
  if (takeSignonFragment()) {
    root.textContent = 'Confirmed. You can close this window.';
    return;
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
