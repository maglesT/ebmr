/**
 * The page's write signal (apiState.onWrite) moves the idle estimate of the session out (DI-17). A request to a route
 * without a session (auth NONE: the device nonce, identification) is no activity of the session, so it never fires the
 * signal (review P7G-2); a successful write in the session does, and a refused write does not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { api, apiState, setTransport } from '../../src/api/client.ts';

const answering = (status: number) => () => Promise.resolve({ status, headers: { get: () => null }, text: () => Promise.resolve('{}') });
let writes = 0;
const count = (): void => {
  writes += 1;
};

afterEach(() => {
  apiState.onWrite.delete(count);
  writes = 0;
});

describe('the write signal of the page', () => {
  it('[DI-17] a POST to an auth-NONE route (device nonce, identify) does not push the idle estimate out; a session write does', async () => {
    apiState.onWrite.add(count);
    setTransport(answering(200));
    await api.call(routes.session.deviceNonce, { body: {} as never });
    await api.call(routes.session.identify, { body: {} as never });
    expect(writes).toBe(0);
    await api.call(routes.designer.saveContent, { params: { versionId: '00000000-0000-4000-8000-000000000001' }, body: {} as never, idempotencyKey: 'k-1' });
    expect(writes).toBe(1);
    setTransport(answering(409));
    await api.call(routes.designer.saveContent, { params: { versionId: '00000000-0000-4000-8000-000000000001' }, body: {} as never, idempotencyKey: 'k-2' });
    expect(writes).toBe(1);
  });
});
