/**
 * Support for the slice 6b builder-A tests of OPC UA data (recipe-core 0961, 0962; DI-20, DI-32, DI-31): an OPC UA
 * endpoint registered in the device registry (an INSTRUMENT whose key fingerprint is its certificate's SHA-256, in a
 * room or on a line), enrolled with the units it serves, and the session the gateway reports before its data. Other
 * suites that send OPC UA data (the 0960 interface tests) use `servedByEndpoint` to put a unit behind a VALID session.
 */
import { randomBytes } from 'node:crypto';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { registerDevice } from '../../../kernel/src/identity/admin.ts';
import { SEED_SITE, seedAdministration, withReason } from '../../../kernel/test/identity/seed.ts';
import { envelopeFor, nowUs, receive, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../kernel/test/support/db.ts';

export interface TestEndpoint {
  code: string;
  deviceId: string;
  thumbprint: string;
  url: string;
  areaCode: string;
  units: string[];
}

/**
 * A fresh endpoint code, 64 random bits. With the earlier 24 bits (`randomBytes(3)`) two registrations in one test
 * database could draw the same code, and the registry's unique code (iam.device, device_code_key) refused the second
 * registration before the enrolment command under test ran (CI shard 7, run 43266879234: the "[DI-20] enrolment" test
 * expected EBMR-EQD-032 and got the duplicate key).
 */
export const endpointCode = (): string => `OPC-${randomBytes(8).toString('hex').toUpperCase()}`;

/** Registers an INSTRUMENT for the endpoint in `area` and enrols it for `units` (Basic256Sha256). */
export async function enrolEndpoint(db: TestDatabase, area: { code: string; kind?: 'ROOM' | 'LINE' }, units: string[], opts: { code?: string; thumbprint?: string } = {}): Promise<TestEndpoint> {
  const ep = await registerEndpoint(db, area, units, opts);
  await enrol(db, ep.code, ep.url, units);
  return ep;
}

/** Registers an INSTRUMENT for the endpoint in `area` in the device registry only (no enrolment). */
export async function registerEndpoint(db: TestDatabase, area: { code: string; kind?: 'ROOM' | 'LINE' }, units: string[], opts: { code?: string; thumbprint?: string } = {}): Promise<TestEndpoint> {
  const { admin } = await seedAdministration(db);
  const code = opts.code ?? endpointCode();
  const thumbprint = opts.thumbprint ?? randomBytes(32).toString('hex');
  const url = `opc.tcp://${code.toLowerCase()}.plant.local:4840/ebmr`;
  const deviceId = await withCommand(db.app, withReason(admin), (c) =>
    registerDevice(c, {
      code, deviceClass: 'INSTRUMENT', site: SEED_SITE, ...(area.kind === 'LINE' ? { line: area.code } : { room: area.code }), fingerprint: thumbprint,
      description: `OPC UA endpoint ${code}`,
    }),
  );
  return { code, deviceId, thumbprint, url, areaCode: area.code, units };
}

export async function enrol(db: TestDatabase, code: string, url: string, units: string[], policy = 'Basic256Sha256'): Promise<number> {
  const { admin } = await seedAdministration(db);
  return withCommand(db.app, withReason(admin), async (c) =>
    (await c.query<{ v: number }>('select plant.enrol_opcua_endpoint($1, $2, $3, $4, $5) as v', [code, url, policy, units, 'commissioned (test)'])).rows[0]!.v,
  );
}

/** The session payload the gateway reports for `ep` (SignAndEncrypt, the registered certificate and location). */
export function sessionPayload(ep: TestEndpoint, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpointCode: ep.code, endpointUrl: ep.url, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: ep.thumbprint,
    reportedLocation: ep.areaCode, equipmentCodes: ep.units, openedAt: nowUs(), ...over,
  };
}

export function reportSession(db: TestDatabase, a: TestAdapter, ep: TestEndpoint, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return receive(db, a, 'plant.receive_opcua_endpoint_session', envelopeFor(a, 'opcua.endpoint_session', sessionPayload(ep, over)));
}

/** Puts `units` behind a newly enrolled endpoint in a new room with a VALID session on adapter `a`. */
export async function servedByEndpoint(db: TestDatabase, a: TestAdapter, room: { code: string }, units: string[]): Promise<TestEndpoint> {
  const ep = await enrolEndpoint(db, room, units);
  const r = await reportSession(db, a, ep);
  if (r['applied'] !== 'SESSION_VALID') throw new Error(`the endpoint session was not valid: ${JSON.stringify(r)}`);
  return ep;
}
