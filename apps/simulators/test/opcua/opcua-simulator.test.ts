/**
 * The OPC UA equipment simulator (slice 6b, builder A; D-P6b-1, D-P6b-2): a unit of every Tablets kind under the eBMR's
 * tag map, SignAndEncrypt only, and its faults, read with a plain node-opcua client.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttributeIds, MessageSecurityMode, OPCUACertificateManager, OPCUAClient, SecurityPolicy, type ClientSession } from 'node-opcua';
import { OPCUA_NAMESPACE_URI, RECIPE_VERSION_TAG } from '@ebmr/integration-sdk/adapter';
import { tagsOf } from '@ebmr/integration-sdk/process';
import { DEFAULT_UNITS, OpcuaSimulator } from '../../src/opcua/server.ts';

let sim: OpcuaSimulator;
const pki = mkdtempSync(join(tmpdir(), 'opcua-sim-test-'));

beforeAll(async () => {
  sim = new OpcuaSimulator({ port: 0, http: null, pkiDir: join(pki, 'server'), location: 'RM-COMP-1', tickMs: 100 });
  await sim.start();
}, 60_000);
afterAll(async () => {
  await sim.close();
});

async function open(mode = MessageSecurityMode.SignAndEncrypt, policy = SecurityPolicy.Basic256Sha256): Promise<{ client: OPCUAClient; session: ClientSession; ns: number; thumbprint: string }> {
  const clientCertificateManager = new OPCUACertificateManager({ rootFolder: join(pki, 'client'), automaticallyAcceptUnknownCertificate: true });
  await clientCertificateManager.initialize();
  const client = OPCUAClient.create({ securityMode: mode, securityPolicy: policy, endpointMustExist: false, connectionStrategy: { maxRetry: 0 }, clientCertificateManager });
  await client.connect(sim.endpointUrl);
  const session = await client.createSession();
  const ns = (await session.readNamespaceArray()).indexOf(OPCUA_NAMESPACE_URI);
  const cert = client.serverCertificate as Buffer | null;
  return { client, session, ns, thumbprint: cert ? createHash('sha256').update(cert).digest('hex') : '' };
}

async function closeAll(c: { client: OPCUAClient; session: ClientSession }): Promise<void> {
  await c.session.close().catch(() => undefined);
  await c.client.disconnect();
}

describe('the OPC UA equipment simulator', () => {
  it('publishes every Tablets kind under the released tag names, its setpoints, recipe version and location, over SignAndEncrypt with its certificate', async () => {
    expect(new Set(DEFAULT_UNITS.map((u) => u.kind))).toEqual(new Set(['PRESS', 'COATER', 'GRANULATOR', 'DRYER', 'BLENDER', 'ROLLER_COMPACTOR', 'BLISTER_MACHINE', 'BOTTLE_LINE', 'CARTONER']));
    await new Promise((r) => setTimeout(r, 400));
    const c = await open();
    try {
      expect(c.ns).toBeGreaterThan(0);
      expect(c.thumbprint).toBe(sim.thumbprint);
      for (const u of DEFAULT_UNITS) {
        for (const t of tagsOf(u.kind)) {
          const dv = await c.session.read({ nodeId: `ns=${c.ns.toString()};s=${u.code}/${t.tag}`, attributeId: AttributeIds.Value });
          expect(dv.statusCode.isGood(), `${u.code}/${t.tag}`).toBe(true);
          expect(typeof dv.value.value).toBe('number');
          if (t.setpoint) {
            const sp = await c.session.read({ nodeId: `ns=${c.ns.toString()};s=${u.code}/${t.tag}/setpoint`, attributeId: AttributeIds.Value });
            expect(sp.statusCode.isGood(), `${u.code}/${t.tag}/setpoint`).toBe(true);
          }
        }
        const rv = await c.session.read({ nodeId: `ns=${c.ns.toString()};s=${u.code}/${RECIPE_VERSION_TAG}`, attributeId: AttributeIds.Value });
        expect(rv.value.value).toBe('RCP-1');
      }
      const loc = await c.session.read({ nodeId: `ns=${c.ns.toString()};s=_endpoint/location`, attributeId: AttributeIds.Value });
      expect(loc.value.value).toBe('RM-COMP-1');
    } finally {
      await closeAll(c);
    }
  });

  it('[DI-20] a session without SignAndEncrypt is not served (D-P6b-2)', async () => {
    const endpoints = await (async () => {
      const client = OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 0 } });
      await client.connect(sim.endpointUrl);
      try {
        return await client.getEndpoints();
      } finally {
        await client.disconnect();
      }
    })();
    const sessionModes = endpoints.filter((e) => e.securityPolicyUri !== 'http://opcfoundation.org/UA/SecurityPolicy#None').map((e) => e.securityMode);
    expect(sessionModes.every((m) => m === MessageSecurityMode.SignAndEncrypt)).toBe(true);
    await expect(open(MessageSecurityMode.None, SecurityPolicy.None)).rejects.toThrow();
    await expect(open(MessageSecurityMode.Sign, SecurityPolicy.Basic256Sha256)).rejects.toThrow();
  });

  it('[DI-31] faults: a recipe mismatch, a relocation, a stale value with an UNCERTAIN status and its old source time, an excursion alarm', async () => {
    const c = await open();
    try {
      const read = (s: string) => c.session.read({ nodeId: `ns=${c.ns.toString()};s=${s}`, attributeId: AttributeIds.Value });
      await sim.setFault('RECIPE_MISMATCH', true);
      expect((await read(`PRESS-01/${RECIPE_VERSION_TAG}`)).value.value).toBe('RCP-1-OTHER');
      await sim.setFault('RECIPE_MISMATCH', false);
      await sim.setFault('RELOCATED', true);
      expect((await read('_endpoint/location')).value.value).toBe('RM-COMP-1-ELSEWHERE');
      await sim.setFault('RELOCATED', false);
      // The simulator's source times are strictly increasing (one ms per publication), so they may run a few ms ahead
      // of the wall clock and are compared with each other, not with Date.now(). A frozen value keeps its old source
      // time while the fault holds (two reads 300 ms apart agree), and the first good value after the fault is newer.
      await sim.setFault('STALE_VALUE', true);
      await new Promise((r) => setTimeout(r, 300));
      const stale = await read('PRESS-01/force.main_kN');
      expect(stale.statusCode.value.toString(16)).toBe('40900000');
      const frozenAt = stale.sourceTimestamp?.getTime();
      expect(frozenAt).toBeDefined();
      await new Promise((r) => setTimeout(r, 300));
      const still = await read('PRESS-01/force.main_kN');
      expect(still.statusCode.value.toString(16)).toBe('40900000');
      expect(still.sourceTimestamp?.getTime()).toBe(frozenAt);
      await sim.setFault('STALE_VALUE', false);
      await new Promise((r) => setTimeout(r, 400));
      const fresh = await read('PRESS-01/force.main_kN');
      expect(fresh.statusCode.isGood()).toBe(true);
      expect(fresh.sourceTimestamp?.getTime() ?? 0).toBeGreaterThan(frozenAt ?? Number.POSITIVE_INFINITY);
      await sim.setFault('EXCURSION', true);
      await new Promise((r) => setTimeout(r, 300));
      expect(String((await read('PRESS-01/_alarms/active')).value.value)).toMatch(/\|force\.main_kN/);
      await sim.setFault('EXCURSION', false);
    } finally {
      await closeAll(c);
    }
  });

  it('[DI-20] a certificate change restarts the server on the same address with another certificate', async () => {
    const before = sim.thumbprint;
    const url = sim.endpointUrl;
    await sim.setFault('CERTIFICATE_CHANGE', true);
    expect(sim.endpointUrl).toBe(url);
    expect(sim.thumbprint).not.toBe(before);
    const c = await open();
    try {
      expect(c.thumbprint).toBe(sim.thumbprint);
    } finally {
      await closeAll(c);
    }
  });
});
