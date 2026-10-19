/**
 * Slice 6c (D-S6-8): the demo gateway's configuration names a press, a coater, a line printer and the packaging-line
 * devices behind their simulators, and the gateway accepts it; the E2E stack's configuration keeps the scale alone.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GatewayConfigFile } from '../../../apps/site-gateway/src/config.ts';
import { SITE_CODE } from '@ebmr/test-kit';
import { DEMO_PROCESS_DEVICES, DEMO_SITE } from '../../../apps/tablets-server/src/features/devices/enrol.ts';
import { DEMO_DEVICES, DEMO_PORTS } from '../src/paths.ts';
import { writeGatewayConfig } from '../src/stack.ts';

const dir = mkdtempSync(join(tmpdir(), 'ebmr-demo-devices-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const written = (demoDevices: boolean): Record<string, unknown> =>
  JSON.parse(readFileSync(writeGatewayConfig({ databases: { GMP: 'g', SANDBOX: 's' }, keysDir: dir, ports: DEMO_PORTS, demoDevices }), 'utf8')) as Record<string, unknown>;

describe('the demo gateway configuration (slice 6c, D-S6-8)', () => {
  it('names a press, a coater, a printer, a bottle line and a cartoner on their own ports, and the gateway accepts it', () => {
    const config = written(true);
    expect(GatewayConfigFile.safeParse(config).success).toBe(true);
    const processDevices = config['processDevices'] as { equipment: string; port: number }[];
    expect(processDevices.map((d) => d.equipment)).toEqual(['PRESS', 'COATER', 'BOTTLE_LINE', 'CARTONER']);
    expect((config['printers'] as unknown[]).length).toBe(1);
    const ports: number[] = [...DEMO_DEVICES.flatMap((d): number[] => [d.tcp, d.http]), ...(Object.values(DEMO_PORTS) as number[])];
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('without the demo devices only the scale is configured (the E2E stack)', () => {
    const config = written(false);
    expect(GatewayConfigFile.safeParse(config).success).toBe(true);
    expect(config['processDevices']).toBeUndefined();
    expect(config['printers']).toBeUndefined();
  });
});

describe('the demo machines the hosted demo binds to its gateway (set-up --demo-process-devices)', () => {
  it('[meta] the server binds the machines the gateway is configured with (same kinds and serials, sandbox TEST- labels) at the demo site', () => {
    const shape = (xs: readonly { kind: string; serial: string }[]) => xs.map((d) => `${d.kind} ${d.serial}`).sort();
    expect(shape(DEMO_PROCESS_DEVICES)).toEqual(shape(DEMO_DEVICES));
    expect(DEMO_PROCESS_DEVICES.filter((d) => d.binding === 'PRINT').map((d) => d.kind)).toEqual(['PRINTER']);
    expect(DEMO_PROCESS_DEVICES.every((d) => d.code.startsWith('TEST-'))).toBe(true);
    expect(DEMO_SITE).toBe(SITE_CODE);
  });
});
