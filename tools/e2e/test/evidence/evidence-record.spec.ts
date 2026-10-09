/**
 * Steps for test/evidence-record.test.ts (review F28): what the evidence record says a step showed. No browser and
 * no stack: a stand-in server answers 428 TAP_REQUIRED but records the request, as a careless server could.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../../fixtures/index.ts';

test('status only: the step checks the answer, not that nothing was recorded', async ({ evidence }) => {
  const recorded: string[] = [];
  const server = createServer((req, res) => {
    recorded.push(`${req.method ?? ''} ${req.url ?? ''}`);
    res.writeHead(428, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ refusal: { code: 'TAP_REQUIRED' } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  try {
    await evidence.step('Send a request without a tap', 'The server answers 428 TAP_REQUIRED and records nothing', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/esig/challenges`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(428);
      expect(((await r.json()) as { refusal: { code: string } }).refusal.code).toBe('TAP_REQUIRED');
    });
  } finally {
    server.close();
  }
  expect(recorded).toEqual(['POST /api/esig/challenges']);
});

test('observed facts: the step returns what it measured', async ({ evidence }) => {
  await evidence.step('Count the rows', 'No row is added', async () => {
    const before = await Promise.resolve(3);
    const after = await Promise.resolve(3);
    expect(after).toBe(before);
    return { status: 428, code: 'TAP_REQUIRED', rowsBefore: before, rowsAfter: after };
  });
});

test('no assertion: the step checks nothing', async ({ evidence }) => {
  await evidence.step('Look at the screen', 'The screen shows the right thing', async () => {
    await Promise.resolve();
  });
});

test('a failed soft assertion and a nested step', async ({ evidence }) => {
  await test.step('outer', async () => {
    await evidence.step('Nested step', 'Two things hold', async () => {
      expect(await Promise.resolve(1 + 1)).toBe(2);
      expect.soft('abc', 'the text names d').toContain('d');
    });
  });
});
