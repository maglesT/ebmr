/**
 * TB-24@1 Secondary and tertiary packaging and finished-pack examination (tablets spec B.2 TB-24; Phase 3 slice 4b,
 * builder B). Controls PR-37, PR-41, PR-42, IN-22.
 *
 * Cartoning with leaflets and overprint, checkweighing, the anti-tampering device, shippers; label examination during
 * finishing and at the end of the run; unusual events. The line is one plant PROCESS unit (config `unit`, of no other
 * packaging step); its cartons and leaflets are issued, coded and reconciled at the MBR's G-21 step (`printedStep`, whose
 * serial pools the shippers aggregate). Entries:
 *   CHALLENGE      a checkweigher, leaflet detector, vision or reader challenge by G-21@1's own rule (two persons): a
 *                  failed or late one stops the step until QA decides and holds the line's output since the device's
 *                  last passing challenge; while it is failed, no output is counted (PACKS_MADE, SHIPPER refused);
 *   ATD_CHECK      the anti-tampering device (or US OTC tamper-evident feature) on the packs examined, on the MBR's
 *                  schedule; PASS with no defect (PR-41, K-21); required where the market set includes EU or the pack is
 *                  US OTC retail;
 *   EXAMINATION    finished packs examined for correct labelling: IN_RUN during finishing on the MBR's schedule, END once
 *                  as the representative sample at completion (211.134; PR-37); each of at least the MBR's sample size;
 *                  PASS only with the labelling correct and no defect;
 *                  a failing ATD check or examination raises LINE_CHECK_FAILED, a late one LINE_CHECK_MISSED, and the
 *                  database holds the unit's containers since that stream's last passing check;
 *   PACKS_MADE     packs made by the cartonator (added up);
 *   REJECTS        packs rejected, by reason (destroyed);
 *   PACK_SAMPLE    packs taken off the line, by purpose: they never return to good output (no entry takes them back);
 *   SET_ASIDE      packs of an unusual event (jam, drop, suspected mix-up) under an event code: UNUSUAL_EVENT, which needs
 *                  a deviation and QA's disposition before the step completes (IN-22 (e), PR-37);
 *   RE_ENTRY       packs of a set-aside event returned to good output only after a passing special inspection, with
 *                  the investigation's reference, checked by a second person; the database also requires the event's
 *                  exception to carry that deviation and QA's disposition (authorised approval);
 *   SHIPPER        a shipper of the MBR's packs under an SSCC the database issued for this batch and step
 *                  (tab.issue_sscc): 18 digits, the MBR's GS1 prefix, a valid check digit; its label content is the
 *                  record's (batch, product, packs); one marked part shipper per batch (D);
 *   RECONCILIATION once, last: computed, never typed: unexplained = made - shipped - rejects - samples - (set aside -
 *                  re-entered); outside the MBR's limit (D 0) PACK_RECONCILIATION (release blocked, deviation).
 * Before PERFORMED: each device's START and END challenge (G-21); the last ATD check passing; an in-run examination and a
 * passing END examination; the reconciliation. The database adds: the shippers' packs equal the commissioned serials of
 * the G-21 step's pools where it serialises (PR-42).
 */
import {
  acceptChallenge,
  big,
  CHALLENGE_RULES,
  CHECK_RULES,
  checkExceptions,
  challengeProblems,
  configError,
  COUNT,
  countField,
  deviceConfigProblems,
  deviceSchema,
  g21Phase,
  INTERVAL,
  intervalOf,
  isRecord,
  missedNow,
  phasesOf,
  positiveCountField,
  problem,
  refuse,
  sharedUnitProblem,
  stoppedDevices,
  streamProblems,
  text,
  UNIT_CODE,
  usOtcRetail,
  CODE,
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
} from './bottle/common.ts';
import { G21_CHALLENGE } from './tb-23.ts';
import { blocks } from '@ebmr/recipe-core/pure';
import { CHALLENGE_SUMMARY, checkSentence, S } from './summaries.ts';

const CONTROLS = ['PR-37', 'PR-41', 'PR-42', 'IN-22'];
export const PACK_DEVICE_KINDS = ['CHECKWEIGHER', 'LEAFLET_DETECTOR', 'VISION', 'READER'] as const;
export const PACK_REJECT_REASONS = ['CHECKWEIGHER', 'LEAFLET', 'ATD', 'VISION', 'EXAMINATION', 'OTHER'] as const;
export const SAMPLE_PURPOSES = ['QC', 'RETENTION', 'STABILITY', 'EXAMINATION'] as const;
const SSCC = /^[0-9]{18}$/;
const COUNTING = ['PACKS_MADE', 'REJECTS', 'PACK_SAMPLE', 'SET_ASIDE', 'RE_ENTRY', 'SHIPPER'];

/** Whether GS1 key `code` (digits) carries its check digit: mod 10, weights 3 and 1 from the right of the data digits. */
export function gs1CheckDigitOk(code: string): boolean {
  if (!/^[0-9]{2,}$/.test(code)) return false;
  const data = code.slice(0, -1);
  let sum = 0n;
  for (let i = 0; i < data.length; i += 1) sum += BigInt(data.charCodeAt(data.length - 1 - i) - 48) * (i % 2 === 0 ? 3n : 1n);
  return (10n - (sum % 10n)) % 10n === BigInt(code.charCodeAt(code.length - 1) - 48);
}

const sumOf = (view: HandlerView, kind: string, member: string, where: (d: Record<string, unknown>) => boolean = () => true): bigint =>
  view.entries(kind).filter((e) => where(e.data)).reduce((a, e) => a + big(e.data[member]), 0n);

/** Packs of set-aside event `event` not re-entered. */
export function setAsideLeft(view: HandlerView, event: string): bigint {
  return sumOf(view, 'SET_ASIDE', 'packs', (d) => d['event'] === event) - sumOf(view, 'RE_ENTRY', 'packs', (d) => d['event'] === event);
}

/** The pack reconciliation of the step: every part, the unexplained difference and whether it is within the limit (exact). */
export function packBalance(view: HandlerView): Record<string, string | boolean> {
  const made = sumOf(view, 'PACKS_MADE', 'packs');
  const shipped = sumOf(view, 'SHIPPER', 'packs');
  const rejects = sumOf(view, 'REJECTS', 'packs');
  const samples = sumOf(view, 'PACK_SAMPLE', 'packs');
  const setAside = sumOf(view, 'SET_ASIDE', 'packs');
  const reEntered = sumOf(view, 'RE_ENTRY', 'packs');
  const unexplained = made - shipped - rejects - samples - (setAside - reEntered);
  const limit = big(text(view.config['maxUnexplained']) ?? '0');
  const abs = unexplained < 0n ? -unexplained : unexplained;
  return {
    made: made.toString(), shipped: shipped.toString(), rejects: rejects.toString(), samples: samples.toString(), setAside: setAside.toString(), reEntered: reEntered.toString(),
    unexplained: unexplained.toString(), withinLimits: abs <= limit,
  };
}

const exam = (config: Config): Record<string, unknown> => (isRecord(config['examination']) ? config['examination'] : {});

function check(view: HandlerView, stream: string, what: string, every: bigint | undefined, pass: boolean, data: Record<string, unknown>, controls: string[]): EntryResult {
  const missed = missedNow(view, stream, every);
  const exceptions = checkExceptions(view, stream, what, missed, pass, controls);
  return { ok: true, data: { stream, ...data, result: pass ? 'PASS' : 'FAIL', missed, checkedBy: view.actor.id }, ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function acceptEntry(view: HandlerView, entry: Entry): EntryResult {
  const cfg = view.config;
  if (COUNTING.includes(entry.kind) && view.entries('RECONCILIATION').length > 0) {
    return refuse('TB24-RECONCILED', `${view.stepKey} is reconciled: nothing more is counted`, ['PR-37', 'IN-17']);
  }
  if ((entry.kind === 'PACKS_MADE' || entry.kind === 'SHIPPER') && stoppedDevices(view).length > 0) {
    return refuse('TB24-STOPPED', `The line of ${view.stepKey} is stopped: ${stoppedDevices(view).join(', ')} failed its last challenge`, ['IN-22', 'PR-37']);
  }
  switch (entry.kind) {
    case 'CHALLENGE':
      return acceptChallenge(view, entry);
    case 'ATD_CHECK': {
      if (!isRecord(cfg['atd'])) return refuse('TB24-NO-ATD', `The MBR configures no anti-tampering check for ${view.phase.id}`, ['PR-41', 'PR-42']);
      const examined = big(entry['examined']);
      const defective = big(entry['defective']);
      if (defective > examined) return refuse('TB24-COUNTS', `More defective (${defective}) than examined (${examined})`, ['PR-41']);
      return check(view, 'ATD', 'anti-tampering check', intervalOf(cfg['atd']['every']), defective === 0n, { examined: entry['examined'], defective: entry['defective'] }, ['PR-41', 'PR-37']);
    }
    case 'EXAMINATION': {
      const e = exam(cfg);
      const timing = String(entry['timing']);
      const prior = view.entries('EXAMINATION');
      if (prior.some((x) => x.data['timing'] === 'END')) return refuse('TB24-ENDED', `${view.stepKey} had its end-of-run examination`, ['PR-37']);
      if (timing === 'END' && !prior.some((x) => x.data['timing'] === 'IN_RUN')) return refuse('TB24-NO-IN-RUN', 'The packs are examined during finishing before the end-of-run sample', ['PR-37']);
      const examined = big(entry['examined']);
      const defective = big(entry['defective']);
      const want = big(text(timing === 'END' ? e['endSample'] : e['inRunSample']) ?? '0');
      if (examined < want) return refuse('TB24-SAMPLE', `A ${timing === 'END' ? 'end-of-run' : 'in-run'} examination takes at least ${want} packs, not ${examined}`, ['PR-37']);
      if (defective > examined) return refuse('TB24-COUNTS', `More defective (${defective}) than examined (${examined})`, ['PR-37']);
      const pass = defective === 0n && entry['labelCorrect'] === true;
      return check(view, 'EXAM', timing === 'END' ? 'end-of-run examination' : 'in-run examination', timing === 'END' ? undefined : intervalOf(e['every']), pass,
        { timing, examined: entry['examined'], defective: entry['defective'], labelCorrect: entry['labelCorrect'] === true }, ['PR-37', 'IN-22']);
    }
    case 'PACKS_MADE':
      return { ok: true, data: { packs: entry['packs'], recordedBy: view.actor.id } };
    case 'REJECTS':
      return { ok: true, data: { reason: entry['reason'], packs: entry['packs'], disposition: 'DESTRUCTION', recordedBy: view.actor.id } };
    case 'PACK_SAMPLE':
      return { ok: true, data: { purpose: entry['purpose'], packs: entry['packs'], takenBy: view.actor.id } };
    case 'SET_ASIDE': {
      const event = String(entry['event']);
      if (view.entries('SET_ASIDE').some((x) => x.data['event'] === event)) return refuse('TB24-EVENT-TWICE', `Event ${event} has its set-aside already`, ['PR-37', 'IN-22']);
      const ex: ExceptionDraft = {
        type: 'UNUSUAL_EVENT',
        title: `${String(entry['packs'])} packs of ${view.stepKey} are set aside after unusual event ${event} (${String(entry['description'])}): they re-enter only after a special inspection, an investigation and QA's approval`,
        controls: ['PR-37', 'IN-22'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'STEP', until: 'DISPOSITION', deviationRequired: true, qaOnly: true, item: event,
      };
      return { ok: true, data: { event, description: entry['description'], packs: entry['packs'], setAsideBy: view.actor.id }, exceptions: [ex] };
    }
    case 'RE_ENTRY': {
      const event = String(entry['event']);
      if (!view.entries('SET_ASIDE').some((x) => x.data['event'] === event)) return refuse('TB24-EVENT', `${event} is no set-aside event of ${view.stepKey}: only units of an unusual event re-enter (samples never do)`, ['PR-37', 'IN-22']);
      if (entry['inspection'] !== 'PASS') return refuse('TB24-INSPECTION', `Packs of event ${event} re-enter only after a passing special inspection`, ['PR-37', 'IN-22']);
      if (big(entry['packs']) > setAsideLeft(view, event)) return refuse('TB24-RE-ENTRY-QUANTITY', `Only ${setAsideLeft(view, event)} packs of event ${event} are set aside`, ['PR-37']);
      return { ok: true, data: { event, packs: entry['packs'], inspection: 'PASS', investigation: entry['investigation'], approvedBy: view.actor.id }, verificationRequired: true };
    }
    case 'SHIPPER': {
      const sscc = String(entry['sscc']);
      const prefix = text(cfg['ssccPrefix']) ?? '';
      if (!SSCC.test(sscc) || !sscc.startsWith(prefix) || !gs1CheckDigitOk(sscc)) return refuse('TB24-SSCC', `${sscc} is no SSCC of the MBR's GS1 prefix with a valid check digit`, ['PR-42']);
      if (view.entries('SHIPPER').some((x) => x.data['sscc'] === sscc)) return refuse('TB24-SSCC-TWICE', `SSCC ${sscc} labels a shipper already`, ['PR-42']);
      const per = big(text(cfg['cartonsPerShipper']) ?? '0');
      const packs = big(entry['packs']);
      const part = entry['part'] === true;
      if (!part && packs !== per) return refuse('TB24-SHIPPER-COUNT', `A full shipper holds ${per} packs, not ${packs}`, ['PR-37']);
      if (part && (packs >= per || view.entries('SHIPPER').some((x) => x.data['part'] === true))) return refuse('TB24-PART-SHIPPER', `A batch has one marked part shipper of fewer than ${per} packs`, ['PR-37']);
      const p = view.mbr.header.product;
      return { ok: true, data: { sscc, packs: entry['packs'], part, label: { sscc, batch: view.batch.batchNumber, product: p.code, name: p.name, strength: p.strength, packs: entry['packs'] }, labelledBy: view.actor.id } };
    }
    case 'RECONCILIATION': {
      if (view.entries('RECONCILIATION').length > 0) return refuse('TB24-RECONCILED', `${view.stepKey} is reconciled already`, ['PR-37', 'IN-17']);
      const b = packBalance(view);
      const exceptions: ExceptionDraft[] = b['withinLimits'] === true ? [] : [{
        type: 'PACK_RECONCILIATION',
        title: `The pack reconciliation of ${view.stepKey} leaves ${String(b['unexplained'])} packs unexplained of ${String(b['made'])} made, outside its limit: an investigation is needed and release is blocked`,
        controls: ['PR-37', 'IN-17'], severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, releaseBlocking: true, item: 'PACKS',
      }];
      return { ok: true, data: { ...b, reconciledBy: view.actor.id }, ...(exceptions.length > 0 ? { exceptions } : {}) };
    }
    default:
      return refuse('TB24-ENTRY', `${entry.kind} is not an entry of a secondary packaging step`, ['PR-37']);
  }
}

/** The scheduled streams of a TB-24 configuration: ATD (when configured) and the in-run examination. */
export function packStreams(config: Config): { stream: string; every: bigint | undefined; what: string }[] {
  return isRecord(config['atd']) ? [{ stream: 'ATD', every: intervalOf(config['atd']['every']), what: 'anti-tampering check' }] : [];
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out = [...streamProblems(view, packStreams(view.config), 'TB24', ['PR-41', 'PR-37']), ...challengeProblems(view)];
  const exams = view.entries('EXAMINATION');
  if (!exams.some((e) => e.data['timing'] === 'IN_RUN')) out.push(problem('TB24-NO-IN-RUN', `${view.stepKey} has no examination of the packs during finishing`, ['PR-37']));
  const end = exams.find((e) => e.data['timing'] === 'END');
  if (!end) out.push(problem('TB24-NO-END-EXAM', `${view.stepKey} has no end-of-run examination of a representative sample`, ['PR-37']));
  else if (end.data['result'] !== 'PASS') out.push(problem('TB24-END-EXAM-FAILED', `The end-of-run examination of ${view.stepKey} failed`, ['PR-37']));
  if (view.entries('RECONCILIATION').length === 0) out.push(problem('TB24-NOT-RECONCILED', `Reconcile the packs of ${view.stepKey}: the reconciliation always runs`, ['PR-37', 'IN-17']));
  return out;
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out: ConfigProblem[] = [...sharedUnitProblem(mbr, phase, text(config['unit']), 'TB24-UNIT'), ...deviceConfigProblems(phase, config, 'TB24-DEVICE')];
  if (!g21Phase(mbr, text(config['printedStep']))) out.push(configError('TB24-PRINTED-STEP', `The cartons and leaflets of ${phase.id} are issued, coded and reconciled at a G-21 step: ${text(config['printedStep']) ?? '(none)'} is none`, ['IN-17', 'PR-42']));
  if (mbr.header.marketSet.includes('EU') && !isRecord(config['atd'])) out.push(configError('TB24-ATD-REQUIRED', `${phase.id} packs for the EU and checks no anti-tampering device`, ['PR-42', 'PR-41']));
  if (usOtcRetail(mbr) && !isRecord(config['atd']) && !phasesOf(mbr, 'TB-23').some((p) => p.config['tamperEvident'] === true)) {
    out.push(configError('TB24-ATD-REQUIRED', `${phase.id} packs for US OTC retail and no packaging step checks the tamper-evident feature`, ['PR-41']));
  }
  if (isRecord(config['atd']) && intervalOf(config['atd']['every']) === undefined) out.push(configError('TB24-INTERVAL', `The anti-tampering check interval of ${phase.id} is not a whole number of microseconds`, ['PR-41']));
  if (intervalOf(exam(config)['every']) === undefined) out.push(configError('TB24-INTERVAL', `The in-run examination interval of ${phase.id} is not a whole number of microseconds`, ['PR-37']));
  return out;
}

export const TB24: BlockVersion = {
  type: 'TB-24',
  version: '1',
  title: 'Secondary and tertiary packaging and finished-pack examination',
  edition: 'tablets',
  aliases: { tablets: 'TB-24' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'The cartoning line: its unit, devices, anti-tampering check, examinations, shippers, reconciliation limit and printed-materials step',
    fields: {
      unit: { type: 'string', pattern: UNIT_CODE, description: 'Plant PROCESS unit of the cartoning line' },
      devices: { type: 'array', items: deviceSchema(PACK_DEVICE_KINDS), optional: true, description: 'Checkweigher, leaflet detector, vision, readers (G-21\'s challenge rule)' },
      atd: { type: 'object', optional: true, description: 'Anti-tampering device check (EU) or the US OTC tamper-evident feature', fields: { every: { ...INTERVAL, description: 'Check interval' } } },
      examination: {
        type: 'object', description: 'Finished-pack examination for correct labelling (211.134)',
        fields: { every: { ...INTERVAL, description: 'In-run examination interval' }, inRunSample: positiveCountField('Packs examined in each in-run examination'), endSample: positiveCountField('Representative sample examined at completion (SOP)') },
      },
      cartonsPerShipper: positiveCountField('Packs in a full shipper'),
      ssccPrefix: { type: 'string', pattern: /^[0-9]{8,12}$/, description: 'Extension digit and GS1 company prefix of the shippers\' SSCCs' },
      maxUnexplained: { type: 'string', pattern: COUNT, optional: true, description: 'Packs the reconciliation may leave unexplained (D 0)' },
      printedStep: { type: 'string', description: 'The G-21 step that issues, codes and reconciles the cartons and leaflets and holds the serial pools' },
    },
  },
  entrySummaries: {
    CHALLENGE: CHALLENGE_SUMMARY,
    ATD_CHECK: (d) => checkSentence(`Anti-tampering check: ${S.val(d['defective'])} of ${S.count(d['examined'], 'pack')} with a defective device`, d),
    EXAMINATION: (d) =>
      checkSentence(`${d['timing'] === 'END' ? 'End-of-run' : 'In-run'} examination: ${S.val(d['defective'])} of ${S.count(d['examined'], 'pack')} defective, ${d['labelCorrect'] === true ? 'labels correct' : 'labels not correct'}`, d),
    PACKS_MADE: (d) => `${S.cap(S.count(d['packs'], 'pack'))} made`,
    REJECTS: (d) => `${S.cap(S.count(d['packs'], 'pack'))} rejected (${S.words(d['reason'])})`,
    PACK_SAMPLE: (d) => `${S.cap(S.count(d['packs'], 'pack'))} taken for ${S.words(d['purpose'])}`,
    SET_ASIDE: (d) => `${S.cap(S.count(d['packs'], 'pack'))} set aside: ${S.val(d['description'])}`,
    RE_ENTRY: (d) => `${S.cap(S.count(d['packs'], 'pack'))} re-entered after a special inspection that ${S.verdict(d['inspection'])} (investigation ${S.val(d['investigation'])})`,
    SHIPPER: (d) => `Shipper ${S.val(d['sscc'])}: ${S.count(d['packs'], 'pack')}${d['part'] === true ? ', the part shipper' : ''}`,
    RECONCILIATION: (d) =>
      `Packs reconciled: ${S.val(d['made'])} made, ${S.val(d['shipped'])} shipped, ${S.val(d['rejects'])} rejected, ${S.val(d['samples'])} samples, ${S.val(d['setAside'])} set aside and ${S.val(d['reEntered'])} re-entered; ${S.val(d['unexplained'])} unexplained${S.str(d['withinLimits']) !== '' ? `, ${S.inRange(d['withinLimits'], 'within limits', 'outside limits')}` : ''}`,
  },
  dataSchema: {
    entries: {
      CHALLENGE: G21_CHALLENGE,
      ATD_CHECK: { type: 'object', description: 'Anti-tampering device check', fields: { examined: positiveCountField('Packs examined'), defective: countField('Packs with a defective device') } },
      EXAMINATION: {
        type: 'object', description: 'Finished packs examined for correct labelling',
        fields: { timing: { type: 'string', enum: ['IN_RUN', 'END'], description: 'During finishing or the representative sample at completion' }, examined: positiveCountField('Packs examined'), defective: countField('Packs with a defect'), labelCorrect: { type: 'boolean', description: 'Every pack examined is correctly labelled' } },
      },
      PACKS_MADE: { type: 'object', description: 'Packs made', fields: { packs: positiveCountField('Packs') } },
      REJECTS: { type: 'object', description: 'Packs rejected (destroyed)', fields: { reason: { type: 'string', enum: PACK_REJECT_REASONS, description: 'Why' }, packs: positiveCountField('Packs') } },
      PACK_SAMPLE: { type: 'object', description: 'Packs taken off the line (never returned)', fields: { purpose: { type: 'string', enum: SAMPLE_PURPOSES, description: 'Purpose' }, packs: positiveCountField('Packs') } },
      SET_ASIDE: {
        type: 'object', description: 'Packs of an unusual event set aside',
        fields: { event: { type: 'string', pattern: CODE, description: 'Event code' }, description: { type: 'string', description: 'What happened' }, packs: positiveCountField('Packs') },
      },
      RE_ENTRY: {
        type: 'object', description: 'Set-aside packs returned to good output after special inspection and approval',
        fields: { event: { type: 'string', pattern: CODE, description: 'Event code' }, packs: positiveCountField('Packs'), inspection: { type: 'string', enum: ['PASS', 'FAIL'], description: 'Special inspection result' }, investigation: { type: 'string', pattern: /^[!-~]{1,64}$/, description: 'The investigation (deviation) reference' } },
      },
      SHIPPER: {
        type: 'object', description: 'A shipper and its SSCC',
        fields: { sscc: { type: 'string', pattern: SSCC, description: 'SSCC issued by the database' }, packs: positiveCountField('Packs in the shipper'), part: { type: 'boolean', description: 'The marked part shipper' } },
      },
      RECONCILIATION: { type: 'object', description: 'The pack reconciliation (computed)', fields: {} },
    },
  },
  checkConfig,
  handler: { acceptEntry, beforePerform },
  exceptionRules: [
    ...CHECK_RULES,
    ...CHALLENGE_RULES,
    { type: 'UNUSUAL_EVENT', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'Packs of an unusual event set aside (re-entry after inspection, investigation and QA approval)', controls: ['PR-37', 'IN-22'] },
    { type: 'PACK_RECONCILIATION', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A pack reconciliation outside its limit (investigation; release blocked)', controls: ['PR-37', 'IN-17'] },
  ],
  simulatorModel: {
    exceptionTypes: () => ['LINE_CHECK_FAILED', 'LINE_CHECK_MISSED', 'CHALLENGE_FAILED', 'CHALLENGE_MISSED', 'UNUSUAL_EVENT', 'PACK_RECONCILIATION'],
    // Nominal: devices at START, ATD check, an in-run examination, the packs made into full shippers (SSCCs are the
    // database's: the simulator names valid ones of the MBR's prefix), the end examination, devices at END, reconciled.
    nominalEntries: ({ config }) => {
      const devices = blocks.lineDevices(config);
      const per = text(config['cartonsPerShipper']) ?? '1';
      const e = exam(config);
      const prefix = text(config['ssccPrefix']) ?? '0000000';
      return [
        ...devices.map((d) => ({ kind: 'CHALLENGE', device: d.id, trigger: 'START', result: 'PASS' })),
        ...(isRecord(config['atd']) ? [{ kind: 'ATD_CHECK', examined: '10', defective: '0' }] : []),
        { kind: 'EXAMINATION', timing: 'IN_RUN', examined: text(e['inRunSample']) ?? '1', defective: '0', labelCorrect: true },
        { kind: 'PACKS_MADE', packs: (BigInt(per) * 2n).toString() },
        { kind: 'SHIPPER', sscc: ssccOf(prefix, 1n), packs: per, part: false },
        { kind: 'SHIPPER', sscc: ssccOf(prefix, 2n), packs: per, part: false },
        { kind: 'EXAMINATION', timing: 'END', examined: text(e['endSample']) ?? '1', defective: '0', labelCorrect: true },
        ...devices.map((d) => ({ kind: 'CHALLENGE', device: d.id, trigger: 'END', result: 'PASS' })),
        { kind: 'RECONCILIATION' },
      ];
    },
  },
  goldenFixture: {
    description:
      'Cartons of 10 packed into shippers of 20: a checkweigher challenged at start and end; an in-run examination finds a mislabelled pack (LINE_CHECK_FAILED), the next passes; 8 packs of a jam set aside (UNUSUAL_EVENT, step waits for QA); samples taken off; one full and one part shipper; end-of-run sample passes; reconciled with 0 unexplained',
    controls: ['PR-37', 'IN-22'],
    phase: {
      block: { type: 'TB-24', version: '1' },
      config: {
        unit: 'CTN-LINE-1', devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], atd: { every: { value: '1', unit: 'h' } },
        examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' }, cartonsPerShipper: '20', ssccPrefix: '089012345', printedStep: 'prt',
      },
    },
    script: [
      { entry: { kind: 'CHALLENGE', device: 'CW', trigger: 'START', result: 'PASS' } },
      { entry: { kind: 'ATD_CHECK', examined: '10', defective: '0' } },
      { entry: { kind: 'EXAMINATION', timing: 'IN_RUN', examined: '5', defective: '1', labelCorrect: false } },
      { entry: { kind: 'EXAMINATION', timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true } },
      { entry: { kind: 'PACKS_MADE', packs: '50' } },
      { entry: { kind: 'SET_ASIDE', event: 'JAM-1', description: 'Carton jam at the infeed', packs: '8' } },
      { entry: { kind: 'PACK_SAMPLE', purpose: 'RETENTION', packs: '4' } },
      { entry: { kind: 'REJECTS', reason: 'CHECKWEIGHER', packs: '2' } },
      { entry: { kind: 'SHIPPER', sscc: '089012345000000019', packs: '20', part: false } },
      { entry: { kind: 'SHIPPER', sscc: '089012345000000026', packs: '16', part: true } },
      { entry: { kind: 'EXAMINATION', timing: 'END', examined: '20', defective: '0', labelCorrect: true } },
      { entry: { kind: 'CHALLENGE', device: 'CW', trigger: 'END', result: 'PASS' } },
      { entry: { kind: 'RECONCILIATION' } },
    ],
    expect: { exceptions: ['LINE_CHECK_FAILED', 'UNUSUAL_EVENT'], status: 'IN_PROGRESS', performRefusal: 'ENG-BLOCKED' },
  },
  tests: ['apps/tablets-server/test/blocks/bottle/blocks.test.ts', 'apps/tablets-server/test/blocks/bottle/db-guards.test.ts'],
};

/** The SSCC of serial reference `n` under `prefix` (extension digit and company prefix), with its check digit. */
export function ssccOf(prefix: string, n: bigint): string {
  const body = prefix + n.toString().padStart(17 - prefix.length, '0');
  for (let d = 0; d < 10; d += 1) if (gs1CheckDigitOk(body + String(d))) return body + String(d);
  return `${body}0`;
}
