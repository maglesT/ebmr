/**
 * Gateway enrolment (configuration by the system administrator, IAM.DEVICE_MANAGE): the gateway's Ed25519 key,
 * whose SHA-256 SPKI fingerprint is the registered fingerprint of its SERVER device, and the instruments it serves
 * with the serial it must read from each (DI-20). Used by the demo seed and the tests.
 *
 * The database takes only the 44-byte Ed25519 SubjectPublicKeyInfo of a curve point of large order (tablets 0702, D16):
 * EBMR-DEV-016 another form, EBMR-DEV-017 no curve point, EBMR-DEV-018 a key of small order, under which anyone could
 * build a signature that verifies. Each refusal's message says what to do; nothing here maps the codes, the set-up's
 * seed fails with the database's message as it is.
 */
import type pg from 'pg';
import { identity, type ActorContext } from '@ebmr/kernel';

export interface InstrumentBinding {
  deviceCode: string;
  serial: string;
  unit: string;
  resolution: string;
}

export interface GatewayEnrolment {
  gatewayCode: string;
  /** The gateway's Ed25519 public key, SPKI DER as base64. */
  spki: string;
  /** The INTEGRATION account that logs in with this key. */
  loginName: string;
  instruments: readonly InstrumentBinding[];
}

/** DEMO-ONLY identities of the demo site (test-kit personas.ts: terminal TEST-GW-01, service login test-gw). */
export const DEMO_GATEWAY = { gatewayCode: 'TEST-GW-01', loginName: 'test-gw' } as const;

/** The demo site's scales behind the gateway (sandbox; TEST-BAL-01 is the simulated MT-SICS balance in DISP-1). */
export const DEMO_INSTRUMENTS: readonly InstrumentBinding[] = [{ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', unit: 'kg', resolution: '0.001' }];

/** Enrols the key and binds the instruments in one command; returns the enrolment (= chain) id. */
export async function enrolGateway(pool: pg.Pool, admin: ActorContext, enrolment: GatewayEnrolment): Promise<string> {
  return identity.withGuardedCommand(pool, admin, async (client) => {
    const { rows } = await client.query<{ id: string }>('select tab.enrol_gateway_key($1, $2, $3) as id', [enrolment.gatewayCode, enrolment.spki, enrolment.loginName]);
    const id = rows[0]?.id;
    if (!id) throw new Error('no gateway enrolment was returned');
    for (const i of enrolment.instruments) {
      await client.query('select tab.bind_instrument($1, $2, $3, $4, $5)', [id, i.deviceCode, i.serial, i.unit, i.resolution]);
    }
    return id;
  });
}
