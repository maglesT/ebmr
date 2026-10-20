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

/**
 * The hosted demo's simulated machines behind the gateway (DEMO-ONLY): the kinds and serials of DEMO_DEVICES in tools/demo,
 * which starts their simulators and names them in the gateway's configuration, under sandbox labels (every sandbox device
 * label starts with TEST-, DI-05). Registered and bound only by the demo's set-up (`--demo-process-devices`), never by the
 * E2E stack.
 */
/** The demo site's code (test-kit personas.ts, SITE_CODE). */
export const DEMO_SITE = 'SITE-1';

export const DEMO_PROCESS_DEVICES = [
  { code: 'TEST-PRESS-01', kind: 'PRESS', serial: 'PRESS-0001', binding: 'PROCESS', room: 'COMP-1', description: 'Tablet press (simulated, DEMO-ONLY)' },
  { code: 'TEST-COATER-01', kind: 'COATER', serial: 'COATER-0001', binding: 'PROCESS', room: 'COAT-1', description: 'Coater (simulated, DEMO-ONLY)' },
  { code: 'TEST-PRN-01', kind: 'PRINTER', serial: 'PRN-0001', binding: 'PRINT', room: 'PL-1', description: 'Label printer (simulated, DEMO-ONLY)' },
  { code: 'TEST-BOTTLE-01', kind: 'BOTTLE_LINE', serial: 'BOTTLE-LINE-0001', binding: 'PROCESS', room: 'PL-1', description: 'Bottle line (simulated, DEMO-ONLY)' },
  { code: 'TEST-CARTONER-01', kind: 'CARTONER', serial: 'CARTONER-0001', binding: 'PROCESS', room: 'PL-1', description: 'Cartoner (simulated, DEMO-ONLY)' },
] as const;

/**
 * Registers the demo machines as instruments of `site` and binds them to the enrolled gateway (process devices and the
 * printer), in one command of the system administrator (IAM.DEVICE_MANAGE). DEMO-ONLY.
 */
export async function bindDemoProcessDevices(pool: pg.Pool, admin: ActorContext, gatewayKeyId: string, site: string): Promise<void> {
  await identity.withGuardedCommand(pool, admin, async (client) => {
    for (const d of DEMO_PROCESS_DEVICES) {
      await identity.registerDevice(client, {
        code: d.code,
        deviceClass: 'INSTRUMENT',
        site,
        room: d.room,
        fingerprint: identity.deviceFingerprint(new TextEncoder().encode(`instrument:${site}:${d.code}`)),
        description: d.description,
      });
      const fn = d.binding === 'PRINT' ? 'tab.bind_print_device' : 'tab.bind_process_device';
      await client.query(`select ${fn}($1, $2, $3, $4)`, [gatewayKeyId, d.code, d.serial, d.kind]);
    }
  });
}

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
