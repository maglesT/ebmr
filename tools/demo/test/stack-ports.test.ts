/**
 * Lead queue (E2E global set-up, EADDRINUSE): the ports of one stack are distinct, free and drawn from below the
 * kernel's ephemeral range, so no two of the stack's processes and no outgoing connection take the same port.
 */
import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { freeStackPorts } from '../src/stack.ts';

const listen = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
const close = (srv: Server): Promise<void> => new Promise((done) => srv.close(() => done()));

describe('the ports of one stack', () => {
  it('[meta] six distinct ports below the ephemeral range, each free to listen on afterwards', async () => {
    for (let round = 0; round < 20; round += 1) {
      const ports = Object.values(await freeStackPorts());
      expect(new Set(ports).size).toBe(6);
      for (const p of ports) expect(p >= 20_000 && p < 32_000).toBe(true);
      const servers = await Promise.all(ports.map(listen));
      await Promise.all(servers.map(close));
    }
  });

  it('[meta] a port already in use is never handed out, even in a range barely larger than the stack', async () => {
    const busy = await listen(31_990);
    try {
      for (let round = 0; round < 10; round += 1) {
        const ports = Object.values(await freeStackPorts(31_990, 31_997));
        expect(new Set(ports).size).toBe(6);
        expect(ports).not.toContain(31_990);
      }
    } finally {
      await close(busy);
    }
  });
});
