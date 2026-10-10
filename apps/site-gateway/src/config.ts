/**
 * Site gateway configuration (EBMR_GW_CONFIG, a JSON file written by tools/demo for the demo and E2E stacks):
 * gateway code (its registered SERVER device), installation kind, listen address, uplink (the server's gateway
 * listener), the DEMO-ONLY Ed25519 key file, the service keys file (its SERVICE_KEY login), the journal
 * directory, and the instruments with driver, address, expected serial (I4), resolution, unit and room; optionally
 * the process equipment (Phase 3 slice 3a: presses and coaters behind the ebmr.sim-process.v1 driver) with its
 * polling, staleness and setpoint polling periods; optionally the line printers (Phase 3 slice 4a, ebmr.sim-printer.v1)
 * with their polling, staleness and print-job polling periods.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DeviceSerial, EQUIPMENT_KINDS } from '@ebmr/integration-sdk/process';
import { DecimalText, DeviceCode, InstallationKind, SERIAL_PATTERN, UNIT_PATTERN, ed25519PrivateKey, ed25519PublicKey } from '@ebmr/integration-sdk/scale';
import type { KeyObject } from 'node:crypto';

const HostPort = z.string().regex(/^[^:]+:\d+$/, 'host:port');

export const DeviceConfig = z.object({
  code: DeviceCode,
  driver: z.literal('mt-sics'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  expectedSerial: z.string().regex(SERIAL_PATTERN),
  resolution: DecimalText,
  unit: z.string().regex(UNIT_PATTERN),
  room: z.string().nullable().optional(),
});
export type DeviceConfig = z.infer<typeof DeviceConfig>;

/** A press or coater (Phase 3 slice 3a, G-06): the serial and kind its hello must report (DI-20). */
export const ProcessDeviceConfig = z.object({
  code: DeviceCode,
  driver: z.literal('process-sim'),
  equipment: z.enum(EQUIPMENT_KINDS),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  expectedSerial: DeviceSerial,
});
export type ProcessDeviceConfig = z.infer<typeof ProcessDeviceConfig>;

/** A line printer (Phase 3 slice 4a, G-21): the serial its hello must report (DI-20). */
export const PrinterDeviceConfig = z.object({
  code: DeviceCode,
  driver: z.literal('printer-sim'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  expectedSerial: DeviceSerial,
});
export type PrinterDeviceConfig = z.infer<typeof PrinterDeviceConfig>;

export const GatewayConfigFile = z.object({
  gatewayCode: DeviceCode,
  installation: InstallationKind,
  listen: HostPort,
  uplink: z.url(),
  keyFile: z.string().min(1),
  serviceKeysFile: z.string().min(1),
  journalDir: z.string().min(1),
  devices: z.array(DeviceConfig).min(1),
  /**
   * Heartbeat period (default 5 s). At most half of the server's 10 s freshness window (tab.scale_status), so one
   * late heartbeat does not show a working scale OFFLINE; a change of readiness is sent at once anyway.
   */
  heartbeatMs: z.number().int().min(500).max(5000).optional(),
  /** How long a capture waits for a stable weight (default 10 s). */
  captureTimeoutMs: z.number().int().min(500).max(30_000).optional(),
  /** Live display polling period (default 250 ms = 4 Hz). */
  livePollMs: z.number().int().min(100).max(5000).optional(),
  /** True only when the host clock is known to be synchronised to the site time source (default false). */
  clockSynchronised: z.boolean().optional(),
  /** Process equipment (default none). */
  processDevices: z.array(ProcessDeviceConfig).optional(),
  /** How often each press and coater is read (default 1 s). */
  processPollMs: z.number().int().min(200).max(60_000).optional(),
  /** A device whose scan counter has not moved for this long reports its values STALE (default 5 s). */
  processStaleAfterMs: z.number().int().min(500).max(300_000).optional(),
  /** How often the gateway asks the server for setpoint downloads (default 2 s). */
  setpointPollMs: z.number().int().min(200).max(60_000).optional(),
  /** Line printers (default none). */
  printers: z.array(PrinterDeviceConfig).optional(),
  /** How often each printer is read (default 1 s). */
  printerPollMs: z.number().int().min(200).max(60_000).optional(),
  /** A printer whose scan counter has not moved for this long is reported STALE (default 5 s). */
  printerStaleAfterMs: z.number().int().min(500).max(300_000).optional(),
  /** How often the gateway asks the server for print jobs (default 2 s). */
  printJobPollMs: z.number().int().min(200).max(60_000).optional(),
});
export type GatewayConfigFile = z.infer<typeof GatewayConfigFile>;

const KeyFile = z.object({ privateKeyPkcs8: z.string().min(1), publicKeySpki: z.string().min(1) });
/** sandbox-service-keys.json (tools/demo set-up): the gateway's entry is the one on the gateway's own terminal. */
const ServiceKeysFile = z.object({
  services: z.array(z.object({ terminal: z.string(), loginName: z.string().min(1), serviceKey: z.string().min(1) })),
});

export interface GatewayConfig {
  gatewayCode: string;
  installation: 'GMP' | 'SANDBOX';
  listen: { host: string; port: number };
  uplink: string;
  journalDir: string;
  devices: DeviceConfig[];
  heartbeatMs: number;
  captureTimeoutMs: number;
  livePollMs: number;
  clockSynchronised: boolean;
  processDevices: ProcessDeviceConfig[];
  processPollMs: number;
  processStaleAfterMs: number;
  setpointPollMs: number;
  printers: PrinterDeviceConfig[];
  printerPollMs: number;
  printerStaleAfterMs: number;
  printJobPollMs: number;
  /** DEMO-ONLY Ed25519 key (a KMS or HSM in production). */
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeySpki: string;
  loginName: string;
  serviceKey: string;
}

export function hostPort(text: string): { host: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(text);
  if (!m) throw new Error(`not a host:port address: ${text}`);
  return { host: m[1] ?? '127.0.0.1', port: Number(m[2]) };
}

export function parseGatewayConfig(file: GatewayConfigFile, keyFileText: string, serviceKeysText: string): GatewayConfig {
  const key = KeyFile.parse(JSON.parse(keyFileText));
  const services = ServiceKeysFile.parse(JSON.parse(serviceKeysText));
  const service = services.services.find((s) => s.terminal === file.gatewayCode);
  if (!service) throw new Error(`the service keys file has no service identity on terminal ${file.gatewayCode}`);
  const processDevices = file.processDevices ?? [];
  const printers = file.printers ?? [];
  const codes = new Set([...file.devices, ...processDevices, ...printers].map((d) => d.code));
  if (codes.size !== file.devices.length + processDevices.length + printers.length) throw new Error('a device code appears twice in the gateway configuration');
  if (new Set(printers.map((d) => d.expectedSerial)).size !== printers.length) throw new Error('a printer serial appears twice in the gateway configuration');
  if (new Set(processDevices.map((d) => d.expectedSerial)).size !== processDevices.length) throw new Error('a process device serial appears twice in the gateway configuration');
  return {
    gatewayCode: file.gatewayCode,
    installation: file.installation,
    listen: hostPort(file.listen),
    uplink: file.uplink.replace(/\/+$/, ''),
    journalDir: file.journalDir,
    devices: file.devices,
    heartbeatMs: file.heartbeatMs ?? 5000,
    captureTimeoutMs: file.captureTimeoutMs ?? 10_000,
    livePollMs: file.livePollMs ?? 250,
    clockSynchronised: file.clockSynchronised ?? false,
    processDevices,
    processPollMs: file.processPollMs ?? 1000,
    processStaleAfterMs: file.processStaleAfterMs ?? 5000,
    setpointPollMs: file.setpointPollMs ?? 2000,
    printers,
    printerPollMs: file.printerPollMs ?? 1000,
    printerStaleAfterMs: file.printerStaleAfterMs ?? 5000,
    printJobPollMs: file.printJobPollMs ?? 2000,
    privateKey: ed25519PrivateKey(key.privateKeyPkcs8),
    publicKey: ed25519PublicKey(key.publicKeySpki),
    publicKeySpki: key.publicKeySpki,
    loginName: service.loginName,
    serviceKey: service.serviceKey,
  };
}

/** Reads EBMR_GW_CONFIG and the files it names. */
export function loadGatewayConfig(path: string): GatewayConfig {
  const parsed = GatewayConfigFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`invalid gateway configuration ${path}: ${z.prettifyError(parsed.error)}`);
  return parseGatewayConfig(parsed.data, readFileSync(parsed.data.keyFile, 'utf8'), readFileSync(parsed.data.serviceKeysFile, 'utf8'));
}
