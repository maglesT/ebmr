/**
 * TB-17@1 Compression-line reject and detection devices: weight-control reject gate, de-duster, metal detector (tablets
 * spec B.2 TB-17; Phase 3 slice 3c). Controls IN-36 (e), IN-35 (e) (f), DI-49, PR-29.
 *
 * The weight-control limits are G-06 setpoints (downloaded and read back; common.ts), the reject counts and force alarms
 * G-06 values and alarms of the press. The challenge records are the database's (tablets 0872): each names its test
 * pieces from the certified register (refused when a certificate has expired at database time), and a failed challenge
 * holds the press output since that device's last passing challenge. Entries:
 *   CHALLENGE      a challenge of a configured device (METAL_DETECTOR, REJECT_GATE) as the register holds it: the first
 *                  is at START, none after END; a challenge later than the MBR's interval after the device's previous one
 *                  raises CHALLENGE_OVERDUE, a failed one DETECTOR_CHALLENGE_FAILED (both wait for a deviation). The
 *                  metal detector is challenged with a piece of every kind and size the MBR names (database).
 *   REJECT_COUNT   the tablets a device (or the set-up) rejected and their disposition; rejected tablets are destroyed,
 *                  never returned to the good stream (the schema has no such disposition).
 *   DEDUSTING      the de-duster the MBR names, in use.
 * Before PERFORMED: G-06's completeness; every configured device's last challenge is a passing END challenge; a reject
 * count for every configured device; the de-duster recorded in use where the MBR names one.
 */
import { Dec } from '@ebmr/expr';
import {
  acceptProcessEntry,
  CODE,
  configError,
  isProcessKind,
  isRecord,
  problem,
  PROCESS_CONFIG_FIELDS,
  PROCESS_ENTRIES,
  PROCESS_EXCEPTION_RULES,
  processBeforePerform,
  processConfigProblems,
  processNominalEntries,
  refuse,
  uuidField,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type ExceptionDraft,
  type HandlerProblem,
  type HandlerView,
  type JsonValue,
  type MbrContent,
  type PhaseNode,
} from './compression/common.ts';

const CONTROLS = ['IN-36', 'IN-35', 'DI-49', 'PR-29'];
/** Default challenge interval (tablets spec TB-17: start, every 2 h, end; a shorter one may be configured). */
export const DEFAULT_INTERVAL_MINUTES = 120;

export type DetectorDevice = 'METAL_DETECTOR' | 'REJECT_GATE';

export interface DeviceConfig {
  device: DetectorDevice;
  code: string;
  intervalUs: bigint;
  pieces: { kind: string; size: { value: string; unit: string } }[];
}

export function devicesOf(config: Config): DeviceConfig[] {
  const out: DeviceConfig[] = [];
  for (const device of ['METAL_DETECTOR', 'REJECT_GATE'] as const) {
    const c = config[device === 'METAL_DETECTOR' ? 'metalDetector' : 'rejectGate'];
    if (!isRecord(c)) continue;
    const minutes = typeof c['intervalMinutes'] === 'number' ? BigInt(c['intervalMinutes']) : BigInt(DEFAULT_INTERVAL_MINUTES);
    const pieces = Array.isArray(c['pieces'])
      ? c['pieces'].filter(isRecord).map((p) => ({ kind: String(p['kind']), size: isRecord(p['size']) ? { value: String(p['size']['value']), unit: String(p['size']['unit']) } : { value: '', unit: '' } }))
      : [];
    out.push({ device, code: String(c['device']), intervalUs: minutes * 60_000_000n, pieces });
  }
  return out;
}

const deDusterOf = (config: Config): string | undefined => (typeof config['deDuster'] === 'string' ? config['deDuster'] : undefined);

const held = (type: string, title: string, item: string): ExceptionDraft => ({
  type,
  title,
  controls: ['IN-36', 'IN-35', 'PR-29'],
  severity: 'ACTION',
  category: 'DEVIATION_OR_OVERRIDE',
  blocks: 'DOWNSTREAM',
  until: 'DEVIATION',
  deviationRequired: true,
  item,
});

function acceptChallenge(view: HandlerView, entry: Entry): EntryResult {
  const device = String(entry['device']);
  const cfg = devicesOf(view.config).find((d) => d.device === device);
  if (!cfg) return refuse('TB17-DEVICE', `The MBR configures no ${device} for ${view.phase.id}`, ['IN-36']);
  const prior = view.entries('CHALLENGE').filter((e) => e.data['device'] === device);
  const last = prior.at(-1);
  const timing = String(entry['timing']);
  if (!last && timing !== 'START') return refuse('TB17-START-FIRST', `The first challenge of the ${device} is the START challenge`, ['IN-36', 'IN-35']);
  if (last && timing === 'START') return refuse('TB17-START-FIRST', `The ${device} had its START challenge already`, ['IN-36']);
  if (last?.data['timing'] === 'END') return refuse('TB17-AFTER-END', `The ${device} had its END challenge`, ['IN-36']);
  const exceptions: ExceptionDraft[] = [];
  if (last && view.nowUs - last.recordedAt > cfg.intervalUs) {
    exceptions.push(held('CHALLENGE_OVERDUE', `The ${device} ${cfg.code} at ${view.stepKey} was challenged later than its interval after its previous challenge: the steps after it wait for a deviation`, device));
  }
  if (entry['passed'] !== true) {
    exceptions.push(held('DETECTOR_CHALLENGE_FAILED', `The ${device} ${cfg.code} at ${view.stepKey} failed its ${timing} challenge: the tablets since its last passing challenge are held and the steps after it wait for a deviation`, device));
  }
  return {
    ok: true,
    data: { challengeId: entry['challengeId'], device, timing, passed: entry['passed'], recordedBy: view.actor.id },
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

function acceptEntry(view: HandlerView, entry: Entry): EntryResult {
  if (isProcessKind(entry.kind)) return acceptProcessEntry(view, entry);
  switch (entry.kind) {
    case 'CHALLENGE':
      return acceptChallenge(view, entry);
    case 'REJECT_COUNT': {
      const device = String(entry['device']);
      const known = device === 'SETUP' || (device === 'DEDUSTER' ? deDusterOf(view.config) !== undefined : devicesOf(view.config).some((d) => d.device === device));
      if (!known) return refuse('TB17-DEVICE', `The MBR configures no ${device} for ${view.phase.id}`, ['IN-35']);
      return { ok: true, data: { device, count: entry['count'], disposition: entry['disposition'], recordedBy: view.actor.id } };
    }
    case 'DEDUSTING':
      if (entry['deDuster'] !== deDusterOf(view.config)) return refuse('TB17-DEDUSTER', `${String(entry['deDuster'])} is not the de-duster the MBR names`, ['IN-35']);
      return { ok: true, data: { deDuster: entry['deDuster'], inUse: entry['inUse'], recordedBy: view.actor.id } };
    default:
      return refuse('TB17-ENTRY', `${entry.kind} is not an entry of a reject and detection step`, ['IN-36']);
  }
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out = processBeforePerform(view);
  for (const d of devicesOf(view.config)) {
    const last = view.entries('CHALLENGE').filter((e) => e.data['device'] === d.device).at(-1);
    if (last?.data['timing'] !== 'END' || last.data['passed'] !== true) out.push(problem('TB17-END-CHALLENGE', `The ${d.device} ${d.code} has no passing END challenge`, ['IN-36', 'IN-35']));
    if (!view.entries('REJECT_COUNT').some((e) => e.data['device'] === d.device)) out.push(problem('TB17-NO-REJECT-COUNT', `Record the rejects of the ${d.device}`, ['IN-35']));
  }
  if (deDusterOf(view.config) !== undefined && !view.entries('DEDUSTING').some((e) => e.data['inUse'] === true)) {
    out.push(problem('TB17-NO-DEDUSTING', 'Record the de-duster in use', ['IN-35']));
  }
  return out;
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out = processConfigProblems(phase, config, mbr);
  const devices = devicesOf(config);
  if (devices.length === 0) out.push(configError('TB17-NO-DEVICE', `Reject and detection step ${phase.id} configures neither a metal detector nor a reject gate`, ['IN-36', 'IN-35']));
  const md = devices.find((d) => d.device === 'METAL_DETECTOR');
  if (md && (md.pieces.length === 0 || md.pieces.some((p) => !Dec.isValid(p.size.value)))) {
    out.push(configError('TB17-NO-PIECES', `The metal detector of ${phase.id} names the test pieces it is challenged with (product- and site-specific; no default)`, ['IN-36']));
  }
  return out;
}

const DEVICE_CONFIG = (withPieces: boolean) => ({
  type: 'object' as const,
  optional: true,
  description: withPieces ? 'The metal detector, its test pieces and challenge interval' : 'The weight-control reject gate and its challenge interval',
  fields: {
    device: { type: 'string' as const, pattern: CODE, description: 'Device code' },
    intervalMinutes: { type: 'integer' as const, min: 1, max: DEFAULT_INTERVAL_MINUTES, optional: true, description: `Challenge interval (default ${DEFAULT_INTERVAL_MINUTES} min; never longer)` },
    ...(withPieces
      ? {
          pieces: {
            type: 'array' as const,
            minItems: 1,
            maxItems: 6,
            description: 'Test pieces: kind and size',
            items: {
              type: 'object' as const,
              description: 'One test piece',
              fields: {
                kind: { type: 'string' as const, enum: ['FERROUS', 'NON_FERROUS', 'STAINLESS'], description: 'Metal' },
                size: { type: 'object' as const, description: 'Diameter', fields: { value: { type: 'decimal' as const, min: '0', minExclusive: true, description: 'Size' }, unit: { type: 'string' as const, enum: ['mm'], description: 'mm' } } },
              },
            },
          },
        }
      : {}),
  },
});

export const TB17: BlockVersion = {
  type: 'TB-17',
  version: '1',
  title: 'Compression-line reject and detection devices',
  edition: 'tablets',
  aliases: { tablets: 'TB-17' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Weight-control settings through G-06, the metal detector and reject gate with their challenges, and the de-duster',
    fields: {
      ...PROCESS_CONFIG_FIELDS,
      metalDetector: DEVICE_CONFIG(true),
      rejectGate: DEVICE_CONFIG(false),
      deDuster: { type: 'string', pattern: CODE, optional: true, description: 'De-duster code' },
    },
  },
  dataSchema: {
    entries: {
      ...PROCESS_ENTRIES,
      CHALLENGE: {
        type: 'object',
        description: 'A challenge of a device as the challenge register holds it',
        fields: {
          challengeId: uuidField('The challenge in the register'),
          device: { type: 'string', enum: ['METAL_DETECTOR', 'REJECT_GATE'], description: 'Device challenged' },
          timing: { type: 'string', enum: ['START', 'INTERVAL', 'AFTER_STOPPAGE', 'END'], description: 'When' },
          passed: { type: 'boolean', description: 'Every test piece detected and rejected' },
        },
      },
      REJECT_COUNT: {
        type: 'object',
        description: 'Tablets rejected by a device and their disposition',
        fields: {
          device: { type: 'string', enum: ['METAL_DETECTOR', 'REJECT_GATE', 'DEDUSTER', 'SETUP'], description: 'Where they were rejected' },
          count: { type: 'string', pattern: /^[0-9]{1,9}$/, description: 'Number of tablets (whole-number text)' },
          disposition: { type: 'string', enum: ['DESTRUCTION', 'INSPECTION_THEN_DESTRUCTION'], description: 'Never returned to the good stream' },
        },
      },
      DEDUSTING: {
        type: 'object',
        description: 'The de-duster in use',
        fields: { deDuster: { type: 'string', pattern: CODE, description: 'De-duster code' }, inUse: { type: 'boolean', description: 'In use' } },
      },
    },
  },
  checkConfig,
  handler: { acceptEntry, beforePerform },
  exceptionRules: [
    ...PROCESS_EXCEPTION_RULES,
    { type: 'DETECTOR_CHALLENGE_FAILED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A detector or reject-gate challenge failed; the tablets since its last passing challenge are held', controls: ['IN-36', 'IN-35', 'PR-29'] },
    { type: 'CHALLENGE_OVERDUE', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A device was challenged later than its interval', controls: ['IN-36', 'IN-35', 'PR-29'] },
  ],
  simulatorModel: {
    exceptionTypes: () => [...PROCESS_EXCEPTION_RULES.map((r) => r.type), 'DETECTOR_CHALLENGE_FAILED', 'CHALLENGE_OVERDUE'],
    // Nominal: G-06's values; per device a passing START and END challenge (simulator register ids) and its rejects; the
    // de-duster in use.
    nominalEntries: (input) => {
      const out = processNominalEntries(input);
      devicesOf(input.config).forEach((d, i) => {
        out.push({ kind: 'CHALLENGE', challengeId: `00000000-0000-4000-8000-00000000170${2 * i}`, device: d.device, timing: 'START', passed: true });
        out.push({ kind: 'REJECT_COUNT', device: d.device, count: '12', disposition: 'DESTRUCTION' });
        out.push({ kind: 'CHALLENGE', challengeId: `00000000-0000-4000-8000-00000000170${2 * i + 1}`, device: d.device, timing: 'END', passed: true });
      });
      const dd = deDusterOf(input.config);
      if (dd) out.push({ kind: 'DEDUSTING', deDuster: dd, inUse: true });
      return out;
    },
  },
  goldenFixture: {
    description:
      'A metal detector challenged with ferrous, non-ferrous and stainless pieces: START passes, an interval challenge three hours later is overdue and fails (CHALLENGE_OVERDUE, DETECTOR_CHALLENGE_FAILED), END passes; rejects destroyed; de-duster in use; performed and verified',
    controls: ['IN-36', 'IN-35'],
    phase: {
      block: { type: 'TB-17', version: '1' },
      config: {
        metalDetector: {
          device: 'MD-01',
          intervalMinutes: 120,
          pieces: [
            { kind: 'FERROUS', size: { value: '0.8', unit: 'mm' } },
            { kind: 'NON_FERROUS', size: { value: '1.0', unit: 'mm' } },
            { kind: 'STAINLESS', size: { value: '1.2', unit: 'mm' } },
          ],
        },
        deDuster: 'DD-01',
      },
    },
    script: [
      { entry: { kind: 'CHALLENGE', challengeId: '00000000-0000-4000-8000-000000001701', device: 'METAL_DETECTOR', timing: 'START', passed: true } },
      { entry: { kind: 'DEDUSTING', deDuster: 'DD-01', inUse: true } },
      { advanceUs: 10_800_000_000n },
      { entry: { kind: 'CHALLENGE', challengeId: '00000000-0000-4000-8000-000000001702', device: 'METAL_DETECTOR', timing: 'INTERVAL', passed: false } },
      { entry: { kind: 'REJECT_COUNT', device: 'METAL_DETECTOR', count: '37', disposition: 'INSPECTION_THEN_DESTRUCTION' } },
      { entry: { kind: 'CHALLENGE', challengeId: '00000000-0000-4000-8000-000000001703', device: 'METAL_DETECTOR', timing: 'END', passed: true } },
    ],
    expect: { exceptions: ['CHALLENGE_OVERDUE', 'DETECTOR_CHALLENGE_FAILED'], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/compression/blocks.test.ts', 'apps/tablets-server/test/blocks/compression/db-guards.test.ts'],
};
