/**
 * TB-21@1 Blister or strip line set-up, independent line check and sealing control (tablets spec B.2 TB-21; Phase 3
 * slice 4b, builder A). Controls IN-38, PR-33, PR-34, PR-35, PR-37.
 *
 * Two parts (configuration `part`), each its own step, on the same pack format (forming film, lidding or strip foil,
 * change parts, tablets per blister):
 *   LINE_CHECK  before a new packaging order: LINE_SETUP scans the machine, the artwork set the line was cleared for, the
 *               change parts (exactly the pack format's) and one reel of every web the pack takes (its role and material
 *               the pack format's; the entry keeps what was scanned and adds the reels in the format's order, a printed
 *               web's with its G-21 item); EQUIPMENT_CHECK records the independent check of the machine (rogue tablets,
 *               capsules and foils of the previous order removed, change parts fitted, empty-pocket detector
 *               challenged). The step needs a check signature in the MBR (TB21-INDEPENDENT) and always a second person:
 *               the engine never lets the performer verify (INV-03), so the check has a performer and a different
 *               verifier (Sched M VIII 7.1; IN-38 (a)). Before PERFORMED: the set-up and a passing check.
 *   RUN         the sealing run. The machine runs through G-06 (the forming and sealing values with their validated
 *               ranges; the MBR collects at least the sealing temperature, pressure and dwell, each with lower and upper
 *               limits, TB21-SEALING; a thermoform pack also the forming temperature, TB21-FORMING). A value outside its
 *               range raises G-06's PROCESS_VALUE_OUT_OF_LIMITS; in the database it holds the machine's output since the
 *               last passing defect check (the slice 1 container hold, stream LINE). Entries besides:
 *                 RUN_START     the machine;
 *                 REEL_CHANGE   a new reel of a web of the pack format (its material the format's), verified by a
 *                               second person;
 *                 DEFECT_CHECK  the MBR's number of blisters examined for misprint, foil cuts, missing tablets and
 *                               improper sealing (Sched M VIII 7.3); more defects than the MBR allows (D 0) fail it:
 *                               DEFECT_CHECK_FAILED, the steps after it wait for a deviation, and in the database FAIL on
 *                               stream LINE; a pass is the only PASS on it;
 *                 REJECTS       empty, broken pocket and vision rejects (blisters), which feed the count reconciliation;
 *                 RUN_END       the run ends; its form warns while G-06 still misses something the step needs (R10 #3);
 *                 LATE_REASON   after the end: why a G-06 entry the step needs (read-back, value, alarm acknowledgement,
 *                               recipe check) was not recorded during the run; it raises RUN_ENTRY_LATE (QA reviews it)
 *                               and lets exactly one such entry follow, so a forgotten check never traps the step;
 *                 COUNT         after the run, once: blisters formed (machine counter), good, set-up waste and samples;
 *                               the rejects are the step's REJECTS; unexplained = formed - (good + rejects + set-up waste
 *                               + samples), any difference BLISTER_COUNT_UNEXPLAINED (a deviation); the good units are
 *                               good blisters x tablets per blister.
 *               Before PERFORMED: G-06's completeness, the run ended, the count, and a last defect check that passes.
 * A web named with a G-21 item (printedStep, PR-33) is printed material: the MBR's G-21 step lists the item with the same
 * material, and the database takes a reel of it only from a lot issued at that step (G-21's issue, never a copy).
 *
 * What the database adds (tablets 0970 to 0972): the machine is a plant PROCESS unit in use for the batch whose area is a
 * line occupied now by this packaging order, cleared for it and for the artwork set scanned (PR-34, PR-35, TB21-LINE);
 * a potent or beta-lactam uncoated product runs only on a line flagged isolated (Sched M VIII 7.2, IN-38 (d),
 * TB21-ISOLATION); every reel is a released lot of its material in the register (TB21-LOT); the run starts only after a
 * completed line check of the same machine in this batch (TB21-NO-LINE-CHECK); and the holds above.
 */
import {
  configError,
  COUNT,
  EQUIPMENT_CODE,
  isProcessKind,
  isRecord,
  MATERIAL_ROLES,
  PACK_FORMS,
  BLISTER_OPENINGS,
  POSITIVE_COUNT,
  positiveCount,
  problem,
  PROCESS_CONFIG_FIELDS,
  PROCESS_ENTRIES,
  PROCESS_EXCEPTION_RULES,
  acceptProcessEntry,
  processBeforePerform,
  processConfigProblems,
  processNominalEntries,
  refuse,
  SCAN_CODE,
  text,
  phasesOf,
  CODE,
  countSum,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type ExceptionDraft,
  type FieldSchema,
  type HandlerProblem,
  type HandlerView,
  type JsonValue,
  type MbrContent,
  type PhaseNode,
} from './blister/common.ts';

const CONTROLS = ['IN-38', 'PR-33', 'PR-34', 'PR-35', 'PR-37'];
export const DEFECT_KINDS = ['MISPRINT', 'FOIL_CUT', 'MISSING_TABLET', 'IMPROPER_SEAL'] as const;
export const REJECT_KINDS = ['emptyPocket', 'brokenPocket', 'vision'] as const;
/** The sealing values every run collects with a validated range (integration-sdk BLISTER_TAGS). */
export const SEALING_TAGS = ['blister.seal_temp_C', 'blister.seal_pressure_bar', 'blister.seal_dwell_s'] as const;
export const FORMING_TAG = 'blister.form_temp_C';

export interface Material {
  role: string;
  material: string;
  item?: string;
}

const part = (config: Config): 'LINE_CHECK' | 'RUN' => (config['part'] === 'RUN' ? 'RUN' : 'LINE_CHECK');
const formatOf = (config: Config): Record<string, unknown> => (isRecord(config['packFormat']) ? config['packFormat'] : {});

/** The pack format's change parts, in its order. */
export function changePartsOf(config: Config): string[] {
  const c = formatOf(config)['changeParts'];
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : [];
}

/** The pack format's webs, in its order. */
export function materialsOf(config: Config): Material[] {
  const m = config['materials'];
  return Array.isArray(m)
    ? m.filter(isRecord).map((x) => ({ role: String(x['role']), material: String(x['material']), ...(typeof x['item'] === 'string' ? { item: x['item'] } : {}) }))
    : [];
}

const maxDefects = (config: Config): bigint => {
  const d = isRecord(config['defectCheck']) ? config['defectCheck'] : {};
  return BigInt(text(d['maxDefects']) ?? '0');
};
const sampleOf = (config: Config): string | undefined => {
  const d = isRecord(config['defectCheck']) ? config['defectCheck'] : {};
  return text(d['examined']);
};

function held(view: HandlerView, type: string, title: string, controls: string[]): ExceptionDraft {
  return { type, title: `${title} at ${view.stepKey}: the steps after it wait for a deviation`, controls, severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true };
}

/** A scanned reel `scan` of a web of the pack format, or a refusal. */
function reelOf(config: Config, scan: unknown): { ok: true; reel: Record<string, unknown> } | { ok: false; problems: HandlerProblem[] } {
  if (!isRecord(scan)) return refuse('TB21-MATERIAL', 'A reel names its web, its material and its lot', ['PR-33']);
  const web = materialsOf(config).find((m) => m.role === scan['role']);
  if (!web) return refuse('TB21-MATERIAL', `${String(scan['role'])} is not a web of the pack format`, ['PR-33']);
  if (scan['material'] !== web.material) return refuse('TB21-MATERIAL', `The ${web.role.toLowerCase().replace('_', ' ')} of the pack format is ${web.material}, not ${String(scan['material'])}`, ['PR-33']);
  return { ok: true, reel: { role: web.role, material: web.material, lot: scan['lot'], ...(web.item !== undefined ? { item: web.item } : {}) } };
}

// ---------------------------------------------------------------------------------------------
// LINE_CHECK

function acceptLineCheck(view: HandlerView, entry: Entry): EntryResult {
  const c = view.config;
  switch (entry.kind) {
    case 'LINE_SETUP': {
      if (view.entries('LINE_SETUP').length > 0) return refuse('TB21-SETUP-TWICE', `${view.stepKey} already records its line set-up`, ['IN-38']);
      const want = changePartsOf(c);
      const got = Array.isArray(entry['changeParts']) ? entry['changeParts'].map(String) : [];
      const missing = want.filter((p) => !got.includes(p));
      const extra = got.filter((p) => !want.includes(p));
      if (missing.length > 0 || extra.length > 0 || new Set(got).size !== got.length) {
        return refuse('TB21-CHANGE-PART', `The change parts scanned are not the pack format's (${[...missing.map((p) => `missing ${p}`), ...extra.map((p) => `not of the format ${p}`)].join(', ') || 'one scanned twice'})`, ['IN-38', 'PR-33']);
      }
      const scans = Array.isArray(entry['materials']) ? entry['materials'] : [];
      const reels: Record<string, unknown>[] = [];
      for (const web of materialsOf(c)) {
        const mine = scans.filter((s) => isRecord(s) && s['role'] === web.role);
        if (mine.length !== 1) return refuse('TB21-MATERIAL', `One reel of the ${web.role.toLowerCase().replace('_', ' ')} is scanned at the set-up`, ['PR-33']);
        const r = reelOf(c, mine[0]);
        if (!r.ok) return r;
        reels.push(r.reel);
      }
      if (scans.length !== reels.length) return refuse('TB21-MATERIAL', 'A reel scanned is not a web of the pack format', ['PR-33']);
      return { ok: true, data: { machine: entry['machine'], artworkSet: entry['artworkSet'], changeParts: entry['changeParts'], materials: entry['materials'], reels, setUpBy: view.actor.id } };
    }
    case 'EQUIPMENT_CHECK': {
      if (view.entries('LINE_SETUP').length === 0) return refuse('TB21-NO-SETUP', `Set up the line of ${view.stepKey} first`, ['IN-38']);
      const pass = entry['rogueRemoved'] === true && entry['changePartsFitted'] === true && entry['emptyPocketDetector'] === 'PASS';
      return {
        ok: true,
        data: { rogueRemoved: entry['rogueRemoved'], changePartsFitted: entry['changePartsFitted'], emptyPocketDetector: entry['emptyPocketDetector'], result: pass ? 'PASS' : 'FAIL', checkedBy: view.actor.id },
        verificationRequired: true,
      };
    }
    default:
      return refuse('TB21-PART', `${entry.kind} is not an entry of the line check part of a blister step`, ['IN-38']);
  }
}

// ---------------------------------------------------------------------------------------------
// RUN

/**
 * G-06's entries the step needs at PERFORMED (read-backs, collected values, alarm acknowledgements, the recipe check).
 * After the run's end each is still taken as a late entry, one per LATE_REASON recorded before it (R10 #3).
 */
export const LATE_KINDS: readonly string[] = ['SETPOINT_READBACK', 'ACTUAL', 'ALARM_ACK', 'RECIPE_CHECK'];

/** Whether a LATE_REASON of the ended run still waits for its late entry. */
function lateOpen(view: HandlerView): boolean {
  const all = view.entries();
  const after = all.slice(all.findIndex((e) => e.kind === 'RUN_END') + 1);
  return after.filter((e) => e.kind === 'LATE_REASON').length > after.filter((e) => LATE_KINDS.includes(e.kind)).length;
}

function acceptLateReason(view: HandlerView, entry: Entry, ended: boolean): EntryResult {
  if (!ended) return refuse('TB21-RUNNING', `The run of ${view.stepKey} has not ended: record the entry itself while it runs`, ['DI-28', 'PR-37']);
  const reason = entry['reason'];
  if (typeof reason !== 'string' || !/\S/.test(reason)) return refuse('TB21-LATE-REASON', 'A late entry needs the reason it was not recorded during the run', ['DI-28', 'PR-11']);
  if (lateOpen(view)) return refuse('TB21-LATE-REASON', `The late entry of the reason given last at ${view.stepKey} is not recorded yet: record it first`, ['DI-28', 'PR-11']);
  return {
    ok: true,
    data: { reason, recordedBy: view.actor.id },
    exceptions: [
      {
        type: 'RUN_ENTRY_LATE',
        title: `An entry of ${view.stepKey} is recorded after its run ended, as a late entry; reason: ${reason}`,
        controls: ['DI-28', 'PR-11', 'PR-37'],
        severity: 'ALERT',
        category: 'LATE_ENTRY',
        blocks: 'NONE',
        qaOnly: true,
      },
    ],
  };
}

function acceptRun(view: HandlerView, entry: Entry): EntryResult {
  const c = view.config;
  const started = view.entries('RUN_START').length > 0;
  const ended = view.entries('RUN_END').length > 0;
  if (entry.kind === 'RUN_START') {
    if (started) return refuse('TB21-TWICE', `${view.stepKey} has started its run already; a new run is a new step`, ['PR-37']);
    return { ok: true, data: { machine: entry['machine'], startedBy: view.actor.id } };
  }
  if (!isProcessKind(entry.kind) && !['REEL_CHANGE', 'DEFECT_CHECK', 'REJECTS', 'RUN_END', 'COUNT', 'LATE_REASON'].includes(entry.kind)) {
    return refuse('TB21-ENTRY', `${entry.kind} is not an entry of a blister run`, ['PR-37']);
  }
  if (!started) return refuse('TB21-NOT-STARTED', `${view.stepKey} has not started its run`, ['PR-37']);
  if (entry.kind === 'LATE_REASON') return acceptLateReason(view, entry, ended);
  const late = ended && LATE_KINDS.includes(entry.kind) && lateOpen(view);
  if (ended && entry.kind !== 'COUNT' && entry.kind !== 'DEFECT_CHECK' && !late) {
    return refuse('TB21-ENDED', `The run of ${view.stepKey} has ended${LATE_KINDS.includes(entry.kind) ? ': record the reason it is late first (a late entry)' : ''}`, ['PR-37']);
  }
  if (isProcessKind(entry.kind)) return acceptProcessEntry(view, entry);
  switch (entry.kind) {
    case 'REEL_CHANGE': {
      const r = reelOf(c, entry);
      if (!r.ok) return r;
      return { ok: true, data: { ...r.reel, changedBy: view.actor.id }, verificationRequired: true };
    }
    case 'DEFECT_CHECK': {
      const n = String(entry['examined']);
      if (n !== sampleOf(c)) return refuse('TB21-SAMPLE', `A defect check examines the ${sampleOf(c) ?? '-'} blisters the MBR sets, not ${n}`, ['PR-37']);
      const d = isRecord(entry['defects']) ? entry['defects'] : {};
      const counts = DEFECT_KINDS.map((k) => (typeof d[k] === 'string' ? d[k] : '0'));
      const total = countSum(counts);
      if (total > BigInt(n)) return refuse('TB21-DEFECTS', `More defects (${total}) than blisters examined (${n})`, ['PR-37']);
      const pass = total <= maxDefects(c);
      return {
        ok: true,
        data: { examined: n, defectCounts: Object.fromEntries(DEFECT_KINDS.map((k, i) => [k, counts[i] ?? '0'])), defectTotal: total.toString(), result: pass ? 'PASS' : 'FAIL', checkedBy: view.actor.id },
        ...(pass ? {} : { exceptions: [held(view, 'DEFECT_CHECK_FAILED', `A defect check failed (${total} defects in ${n} blisters); the machine's output since the last passing check is held`, ['IN-38', 'PR-37'])] }),
      };
    }
    case 'REJECTS': {
      if (view.entries('COUNT').length > 0) return refuse('TB21-COUNTED', `The count of ${view.stepKey} is recorded`, ['PR-37']);
      const vals = REJECT_KINDS.map((k) => (typeof entry[k] === 'string' ? (entry[k]) : '0'));
      return { ok: true, data: { ...Object.fromEntries(REJECT_KINDS.map((k, i) => [k, vals[i] ?? '0'])), total: countSum(vals).toString(), recordedBy: view.actor.id } };
    }
    case 'RUN_END':
      return { ok: true, data: { endedBy: view.actor.id } };
    default: {
      if (!ended) return refuse('TB21-RUNNING', `The run of ${view.stepKey} has not ended: the count comes after it`, ['PR-37']);
      if (view.entries('COUNT').length > 0) return refuse('TB21-COUNT-TWICE', `${view.stepKey} already records its count`, ['PR-37']);
      const formed = BigInt(String(entry['formed']));
      const rejects = countSum(view.entries('REJECTS').map((e) => e.data['total']));
      const parts = ['good', 'setupWaste', 'samples'].map((k) => BigInt(String(entry[k])));
      const unexplained = formed - (rejects + parts.reduce((a, b) => a + b, 0n));
      const perBlister = BigInt(text(formatOf(c)['unitsPerBlister']) ?? '1');
      return {
        ok: true,
        data: {
          formed: String(entry['formed']),
          good: String(entry['good']),
          rejects: rejects.toString(),
          setupWaste: String(entry['setupWaste']),
          samples: String(entry['samples']),
          unexplained: unexplained.toString(),
          goodUnits: ((parts[0] ?? 0n) * perBlister).toString(),
          recordedBy: view.actor.id,
        },
        ...(unexplained === 0n
          ? {}
          : { exceptions: [held(view, 'BLISTER_COUNT_UNEXPLAINED', `${unexplained} blisters of the run are not explained by good output, rejects, set-up waste and samples`, ['PR-37'])] }),
      };
    }
  }
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  if (part(view.config) === 'LINE_CHECK') {
    const out: HandlerProblem[] = [];
    if (view.entries('LINE_SETUP').length === 0) out.push(problem('TB21-NO-SETUP', `${view.stepKey} has no line set-up`, ['IN-38']));
    if (view.entries('EQUIPMENT_CHECK').at(-1)?.data['result'] !== 'PASS') out.push(problem('TB21-CHECK', `${view.stepKey} has no passing independent equipment check`, ['IN-38']));
    return out;
  }
  const out = processBeforePerform(view);
  if (view.entries('RUN_END').length === 0) return [...out, problem('TB21-RUNNING', `The run of ${view.stepKey} has not ended`, ['PR-37'])];
  if (view.entries('COUNT').length === 0) out.push(problem('TB21-NO-COUNT', `Record the count of ${view.stepKey} first`, ['PR-37']));
  const last = view.entries('DEFECT_CHECK').at(-1);
  if (!last) out.push(problem('TB21-NO-CHECK', `${view.stepKey} has no defect check`, ['PR-37']));
  else if (last.data['result'] !== 'PASS') out.push(problem('TB21-LAST-CHECK', `The last defect check of ${view.stepKey} failed: a passing check comes after it`, ['PR-37']));
  return out;
}

/** R10 #3: before RUN_END, what G-06 still misses (after the end each is only a late entry with a reason, for QA). */
function entryWarnings(view: HandlerView): Record<string, string> {
  if (part(view.config) !== 'RUN' || view.entries('RUN_START').length === 0 || view.entries('RUN_END').length > 0) return {};
  const missing = processBeforePerform(view).map((p) => p.message);
  if (missing.length === 0) return {};
  return { RUN_END: `${missing.join('; ')}. After the run ends, each of these is recorded only as a late entry with a reason, which QA reviews.` };
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const where = `Blister step ${phase.id}`;
  const out: ConfigProblem[] = [];
  const parts = changePartsOf(config);
  if (new Set(parts).size !== parts.length) out.push(configError('TB21-FORMAT', `${where} lists a change part twice`, ['IN-38']));
  const webs = materialsOf(config);
  const roles = webs.map((w) => w.role);
  const form = text(formatOf(config)['form']);
  const need = form === 'STRIP' ? ['STRIP_FOIL'] : ['FORMING_FILM', 'LIDDING_FOIL'];
  if (new Set(roles).size !== roles.length || need.some((r) => !roles.includes(r)) || roles.some((r) => !need.includes(r))) {
    out.push(configError('TB21-MATERIALS', `${where}: a ${form?.toLowerCase().replace('_', ' ') ?? ''} pack takes ${need.join(' and ')}, each once`, ['PR-33']));
  }
  const opening = text(formatOf(config)['opening']);
  if (opening !== undefined && opening !== 'PUSH_THROUGH' && form === 'STRIP') {
    out.push(configError('TB21-OPENING', `${where}: a strip pack has no lidding foil to peel; a ${opening === 'PEEL_OFF' ? 'peel-off' : 'peel-push'} opening is a blister's (THERMOFORM or COLD_FORM)`, ['PR-33']));
  }
  const printed = webs.filter((w) => w.item !== undefined);
  if (printed.length > 0) {
    const g21 = phasesOf(mbr).find((p) => p.id === text(config['printedStep']));
    if (!g21 || g21.block.type !== 'G-21') out.push(configError('TB21-PRINTED', `${where} names no G-21 step of the MBR for its printed webs`, ['PR-33']));
    else {
      const items = Array.isArray(g21.config['items']) ? g21.config['items'].filter((x): x is Record<string, JsonValue> => isRecord(x)) : [];
      for (const w of printed) {
        if (!items.some((i) => i['id'] === w.item && i['material'] === w.material)) out.push(configError('TB21-PRINTED', `G-21 step ${g21.id} has no item ${w.item ?? ''} of material ${w.material}`, ['PR-33']));
      }
    }
  } else if (config['printedStep'] !== undefined) out.push(configError('TB21-PRINTED', `${where} names a G-21 step but no printed web`, ['PR-33']));
  if (part(config) === 'LINE_CHECK') {
    if (!phase.signatures.check) out.push(configError('TB21-INDEPENDENT', `${where}: the independent line check has a verifier besides the performer`, ['IN-38']));
    for (const k of ['setpoints', 'actuals', 'criticalAlarms', 'defectCheck']) if (config[k] !== undefined) out.push(configError('TB21-PART', `${where}: ${k} belongs to the run part`, ['IN-38']));
    return out;
  }
  out.push(...processConfigProblems(phase, config, mbr));
  if (!phase.equipment.some((q) => q.use === 'USE')) out.push(configError('TB21-NO-EQUIPMENT', `${where} names no blister machine it uses`, ['PR-37']));
  const actuals = Array.isArray(config['actuals']) ? config['actuals'].filter((x): x is Record<string, JsonValue> => isRecord(x)) : [];
  const ranged = (tag: string): boolean => actuals.some((a) => a['tag'] === tag && typeof a['min'] === 'string' && typeof a['max'] === 'string');
  for (const t of SEALING_TAGS) if (!ranged(t)) out.push(configError('TB21-SEALING', `${where} collects ${t} with its validated range (lower and upper limit)`, ['PR-37']));
  if (form === 'THERMOFORM' && !ranged(FORMING_TAG)) out.push(configError('TB21-FORMING', `${where} collects ${FORMING_TAG} with its validated range`, ['PR-37']));
  if (sampleOf(config) === undefined) out.push(configError('TB21-SAMPLE', `${where} sets the blisters a defect check examines`, ['PR-37']));
  return out;
}

const REEL_ROLE: FieldSchema = { type: 'string', enum: [...MATERIAL_ROLES], description: 'The web the reel is' };
const REEL_MATERIAL: FieldSchema = { type: 'string', pattern: SCAN_CODE, description: 'Material code read from the reel label' };
const REEL: Record<string, FieldSchema> = {
  role: REEL_ROLE,
  material: REEL_MATERIAL,
  lot: { type: 'string', pattern: SCAN_CODE, description: 'Lot read from the reel label' },
};

export const TB21: BlockVersion = {
  type: 'TB-21',
  version: '1',
  title: 'Blister line set-up, independent check and sealing',
  edition: 'tablets',
  aliases: { tablets: 'TB-21' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'The part, the pack format and its webs, the product\'s line eligibility, the defect check and the sealing values through G-06',
    fields: {
      part: { type: 'string', enum: ['LINE_CHECK', 'RUN'], description: 'The independent line check before the order, or the sealing run' },
      packFormat: {
        type: 'object',
        description: 'The pack format',
        fields: {
          form: { type: 'string', enum: [...PACK_FORMS], description: 'Thermoform, cold form or strip' },
          opening: { type: 'string', enum: [...BLISTER_OPENINGS], optional: true, description: 'How the blister is opened: push through the lidding foil (default), peel the lidding foil off, or peel then push (slice 7q, C8)' },
          unitsPerBlister: positiveCount('Tablets per blister or strip'),
          blistersPerCarton: { ...positiveCount('Blisters per carton'), optional: true },
          changeParts: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', pattern: CODE, description: 'Change part' }, description: 'The change-part set of the format' },
        },
      },
      materials: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        description: 'The webs of the pack',
        items: {
          type: 'object',
          description: 'One web',
          fields: {
            role: REEL_ROLE,
            material: REEL_MATERIAL,
            item: { type: 'string', pattern: CODE, optional: true, description: 'The item of the G-21 step when the web is printed' },
          },
        },
      },
      printedStep: { type: 'string', optional: true, description: 'The G-21 step that issues and reconciles the printed webs' },
      product: {
        type: 'object',
        description: 'Line eligibility of the product (Sched M VIII 7.2)',
        fields: {
          uncoated: { type: 'boolean', description: 'The tablets are uncoated' },
          potent: { type: 'boolean', description: 'A potent product (also when the plant product list flags it highly potent)' },
          betaLactam: { type: 'boolean', description: 'A beta-lactam product' },
        },
      },
      defectCheck: {
        type: 'object',
        optional: true,
        description: 'The periodic defect check of the run',
        fields: {
          examined: positiveCount('Blisters examined per check'),
          maxDefects: { type: 'string', pattern: COUNT, optional: true, description: 'Defects a check may find and still pass (D 0)' },
        },
      },
      ...PROCESS_CONFIG_FIELDS,
    },
  },
  dataSchema: {
    entries: {
      ...PROCESS_ENTRIES,
      LINE_SETUP: {
        type: 'object',
        description: 'The machine, the artwork set the line was cleared for, the change parts and one reel of every web, scanned',
        fields: {
          machine: { type: 'string', pattern: EQUIPMENT_CODE, description: 'Blister machine (a PROCESS unit of the plant on the line)' },
          artworkSet: { type: 'string', pattern: /^[!-~]{1,128}$/, description: 'The artwork set of the line clearance' },
          changeParts: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', pattern: CODE, description: 'Change part scanned' }, description: 'Change parts scanned' },
          materials: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', description: 'A reel scanned', fields: REEL }, description: 'Reels scanned' },
        },
      },
      EQUIPMENT_CHECK: {
        type: 'object',
        description: 'The independent check of the machine before the order',
        fields: {
          rogueRemoved: { type: 'boolean', description: 'Tablets, capsules and foils of the previous order removed' },
          changePartsFitted: { type: 'boolean', description: 'The format\'s change parts fitted' },
          emptyPocketDetector: { type: 'string', enum: ['PASS', 'FAIL'], description: 'Empty-pocket detector challenge' },
        },
      },
      RUN_START: { type: 'object', description: 'The run starts on the machine', fields: { machine: { type: 'string', pattern: EQUIPMENT_CODE, description: 'Blister machine' } } },
      REEL_CHANGE: { type: 'object', description: 'A new reel, verified by a second person', fields: REEL },
      DEFECT_CHECK: {
        type: 'object',
        description: 'A periodic defect check of the blisters',
        fields: {
          examined: { type: 'string', pattern: POSITIVE_COUNT, description: 'Blisters examined' },
          defects: {
            type: 'object',
            description: 'Defects by kind',
            fields: Object.fromEntries(DEFECT_KINDS.map((k) => [k, { type: 'string', pattern: COUNT, optional: true, description: `${k.toLowerCase()} blisters` }])),
          },
        },
      },
      REJECTS: {
        type: 'object',
        description: 'Pocket and vision rejects (blisters)',
        fields: Object.fromEntries(REJECT_KINDS.map((k) => [k, { type: 'string', pattern: COUNT, optional: true, description: `${k} rejects` }])),
      },
      RUN_END: { type: 'object', description: 'The run ends', fields: {} },
      COUNT: {
        type: 'object',
        description: 'The blister count of the run',
        fields: {
          formed: { type: 'string', pattern: COUNT, description: 'Blisters formed (machine counter)' },
          good: { type: 'string', pattern: COUNT, description: 'Good blisters' },
          setupWaste: { type: 'string', pattern: COUNT, description: 'Set-up waste' },
          samples: { type: 'string', pattern: COUNT, description: 'Samples taken' },
        },
      },
      LATE_REASON: {
        type: 'object',
        description: 'After the run ended: why a recipe check, read-back, value or alarm acknowledgement was not recorded during it (the late entry follows; QA reviews it)',
        fields: { reason: { type: 'string', description: 'Why it was not recorded during the run' } },
      },
    },
  },
  checkConfig,
  handler: {
    acceptEntry: (view, entry) => (part(view.config) === 'LINE_CHECK' ? acceptLineCheck(view, entry) : acceptRun(view, entry)),
    beforePerform,
    entryWarnings,
  },
  exceptionRules: [
    ...PROCESS_EXCEPTION_RULES,
    { type: 'RUN_ENTRY_LATE', category: 'LATE_ENTRY', severity: 'ALERT', summary: 'An entry the run needed recorded after its end, with the reason (QA reviews it)', controls: ['DI-28', 'PR-11', 'PR-37'] },
    { type: 'DEFECT_CHECK_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A failed defect check (output since the last passing check held)', controls: ['IN-38', 'PR-37'] },
    { type: 'BLISTER_COUNT_UNEXPLAINED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'Blisters of the run not explained by output, rejects, waste and samples', controls: ['PR-37'] },
  ],
  simulatorModel: {
    exceptionTypes: (input) => (part(input.config) === 'RUN' ? ['PROCESS_VALUE_OUT_OF_LIMITS', 'DEFECT_CHECK_FAILED', 'BLISTER_COUNT_UNEXPLAINED'] : []),
    nominalEntries: (input) => {
      const c = input.config;
      if (part(c) === 'LINE_CHECK') {
        return [
          { kind: 'LINE_SETUP', machine: 'TEST-BLISTER-01', artworkSet: 'FOIL:ART-1', changeParts: changePartsOf(c), materials: materialsOf(c).map((m) => ({ role: m.role, material: m.material, lot: `LOT-${m.role}` })) },
          { kind: 'EQUIPMENT_CHECK', rogueRemoved: true, changePartsFitted: true, emptyPocketDetector: 'PASS' },
        ];
      }
      return [
        { kind: 'RUN_START', machine: 'TEST-BLISTER-01' },
        ...processNominalEntries(input),
        { kind: 'DEFECT_CHECK', examined: sampleOf(c) ?? '1', defects: {} },
        { kind: 'RUN_END' },
        { kind: 'COUNT', formed: '100', good: '100', setupWaste: '0', samples: '0' },
      ];
    },
  },
  goldenFixture: {
    description:
      'A thermoform run of 10-tablet blisters: forming and sealing values collected inside their validated ranges, then a sealing temperature of 182.0 degC above its 170.0 to 180.0 range (PROCESS_VALUE_OUT_OF_LIMITS); a defect check of 20 blisters with one improper seal fails (DEFECT_CHECK_FAILED), the next passes; 30 pocket rejects; 10000 formed = 9900 good + 30 rejects + 60 set-up waste + 10 samples, nothing unexplained; 99000 tablets packed',
    controls: ['PR-37', 'IN-38'],
    phase: {
      block: { type: 'TB-21', version: '1' },
      config: {
        part: 'RUN',
        packFormat: { form: 'THERMOFORM', unitsPerBlister: '10', changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-10'] },
        materials: [
          { role: 'FORMING_FILM', material: 'PVC-250' },
          { role: 'LIDDING_FOIL', material: 'ALU-20' },
        ],
        product: { uncoated: false, potent: false, betaLactam: false },
        defectCheck: { examined: '20' },
        actuals: [
          { tag: 'blister.form_temp_C', unit: 'degC', min: '120.0', max: '140.0' },
          { tag: 'blister.seal_temp_C', unit: 'degC', min: '170.0', max: '180.0' },
          { tag: 'blister.seal_pressure_bar', unit: 'bar', min: '3.00', max: '5.00' },
          { tag: 'blister.seal_dwell_s', unit: 's', min: '0.80', max: '1.20' },
        ],
        manualFallback: true,
        maxAgeSeconds: 3600,
      },
      equipment: [{ ref: 'LINE', use: 'USE' }],
      system: { kind: 'PLC', ref: 'SYS-BL', recipe: 'RCP-BL-10', recipeVersion: '3' },
    },
    script: [
      { entry: { kind: 'RUN_START', machine: 'TEST-BLISTER-01' } },
      { entry: { kind: 'RECIPE_CHECK', recipe: 'RCP-BL-10', recipeVersion: '3' } },
      { entry: { kind: 'ACTUAL', tag: 'blister.form_temp_C', value: '130.0', unit: 'degC', source: 'MANUAL' } },
      { entry: { kind: 'ACTUAL', tag: 'blister.seal_temp_C', value: '175.0', unit: 'degC', source: 'MANUAL' } },
      { entry: { kind: 'ACTUAL', tag: 'blister.seal_pressure_bar', value: '4.00', unit: 'bar', source: 'MANUAL' } },
      { entry: { kind: 'ACTUAL', tag: 'blister.seal_dwell_s', value: '1.00', unit: 's', source: 'MANUAL' } },
      { entry: { kind: 'ACTUAL', tag: 'blister.seal_temp_C', value: '182.0', unit: 'degC', source: 'MANUAL' } },
      { entry: { kind: 'DEFECT_CHECK', examined: '20', defects: { IMPROPER_SEAL: '1' } } },
      { advanceUs: 600_000_000n },
      { entry: { kind: 'ACTUAL', tag: 'blister.seal_temp_C', value: '176.0', unit: 'degC', source: 'MANUAL' } },
      { entry: { kind: 'DEFECT_CHECK', examined: '20', defects: {} } },
      { entry: { kind: 'REJECTS', emptyPocket: '18', brokenPocket: '4', vision: '8' } },
      { entry: { kind: 'RUN_END' } },
      { entry: { kind: 'COUNT', formed: '10000', good: '9900', setupWaste: '60', samples: '10' } },
    ],
    expect: { exceptions: ['DEFECT_CHECK_FAILED', 'PROCESS_MANUAL_FALLBACK', 'PROCESS_MANUAL_FALLBACK', 'PROCESS_MANUAL_FALLBACK', 'PROCESS_MANUAL_FALLBACK', 'PROCESS_MANUAL_FALLBACK', 'PROCESS_MANUAL_FALLBACK', 'PROCESS_VALUE_OUT_OF_LIMITS'], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/blister/blocks.test.ts', 'apps/tablets-server/test/blocks/blister/db-guards.test.ts'],
};
