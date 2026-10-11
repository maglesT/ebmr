/**
 * Phase 3 slice 6c (D-S6-8): the gateway's device configuration takes every kind of process equipment a simulator
 * speaks, and the IPC and packaging instruments on the scale protocol, each in a unit of its kind.
 */
import { describe, expect, it } from 'vitest';
import { PROCESS_EQUIPMENT_KINDS } from '@ebmr/integration-sdk/process';
import { INSTRUMENT_KINDS, INSTRUMENT_PROFILES } from '@ebmr/integration-sdk/scale';
import { GatewayConfigFile } from '../src/config.ts';

const base = { gatewayCode: 'TEST-GW-01', installation: 'SANDBOX', listen: '127.0.0.1:0', uplink: 'http://127.0.0.1:1', keyFile: 'k', serviceKeysFile: 's', journalDir: 'j' };
const balance = { code: 'TEST-BAL-01', driver: 'mt-sics', host: '127.0.0.1', port: 1, expectedSerial: 'SIM-0001', resolution: '0.001', unit: 'kg' };

describe('gateway device configuration (slice 6c, D-S6-8)', () => {
  it('[DI-31] every kind of process equipment is accepted behind the simulator driver; an unknown kind is refused', () => {
    const processDevices = PROCESS_EQUIPMENT_KINDS.map((equipment, i) => ({
      code: `TEST-${equipment.replace(/_/g, '-')}-01`,
      driver: 'process-sim',
      equipment,
      host: '127.0.0.1',
      port: 4100 + i,
      expectedSerial: `${equipment.replace(/_/g, '-')}-0001`,
    }));
    expect(GatewayConfigFile.safeParse({ ...base, devices: [balance], processDevices }).success).toBe(true);
    expect(GatewayConfigFile.safeParse({ ...base, devices: [balance], processDevices: [{ ...processDevices[0], equipment: 'TOASTER' }] }).success).toBe(false);
  });

  it('[DI-31][PR-20] the IPC and packaging instruments are accepted on the scale protocol in a unit of their kind; another unit is refused, naming the device', () => {
    const devices = INSTRUMENT_KINDS.map((instrument, i) => ({
      ...balance,
      code: `TEST-${instrument.replace(/_/g, '-')}-01`,
      instrument,
      port: 4200 + i,
      expectedSerial: `SIM-${String(100 + i)}`,
      resolution: INSTRUMENT_PROFILES[instrument].resolution,
      unit: INSTRUMENT_PROFILES[instrument].units[0],
    }));
    expect(GatewayConfigFile.safeParse({ ...base, devices }).success).toBe(true);
    // A device without a kind is a balance, as before slice 6c.
    expect(GatewayConfigFile.safeParse({ ...base, devices: [balance] }).success).toBe(true);
    const wrong = GatewayConfigFile.safeParse({ ...base, devices: [{ ...balance, code: 'TEST-HT-01', instrument: 'HARDNESS_TESTER', unit: 'kg' }] });
    expect(wrong.success).toBe(false);
    expect(JSON.stringify(wrong.error?.issues)).toMatch(/TEST-HT-01: a hardness tester reports breaking force of one tablet in N or kp, not in kg/);
    expect(GatewayConfigFile.safeParse({ ...base, devices: [{ ...balance, unit: 'pct' }] }).success).toBe(false);
  });
});
