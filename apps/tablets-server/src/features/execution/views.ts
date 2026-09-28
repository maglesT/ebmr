/**
 * View composers of the sandbox test runs (module C3; Phase 2 apps plan sections 7 and 9): StepScreenView,
 * RunView, RunSummaryView, WorkQueueItem, TimelineEntryView. Everything shown comes from the stored state,
 * the stored rows and the kernel's stored signatures:
 *  - values with their unit, source, limit verdict (the engine's stored evaluation, never computed here) and
 *    the person and time of the row that recorded them; computed items are shown, never offered for typing
 *    (INV-25);
 *  - limits with their tier and source reference; targets with their source;
 *  - exceptions with what to do and who decides; signatures as their stored manifestations (DI-36);
 *  - actions from availableActions, i.e. a dry run through the engine for the viewer (display roles only;
 *    the command itself evaluates authority).
 * Instants carry the site-time text the server formats; the browser never formats GMP time.
 */
import { esig, sandbox } from '@ebmr/kernel';
import { Dec } from '@ebmr/expr';
import { blocks, engine, flow } from '@ebmr/recipe-core';
import type {
  ActionView,
  AttemptView,
  EntryFormView,
  EntryView,
  ExceptionView,
  FieldView,
  HoldView,
  Instant,
  LimitView,
  ManifestationView,
  PersonRef,
  RunHeaderView,
  RunSummaryView,
  RunView,
  StageView,
  StepScreenView,
  StepSummaryView,
  TimelineEntryView,
  TimerView,
  Watermark,
  WorkQueueItem,
} from '@ebmr/api-contract';
import type { z } from 'zod';
import type { AppContext } from '../../platform/context.ts';
import { manifestationView } from '../esig/views.ts';
import { wireOf } from './intents.ts';
import { notFound, type Db, type RunContext, type RunRows } from './runs.ts';

type Attempt = z.infer<typeof AttemptView>;
type EntryFormT = z.infer<typeof EntryFormView>;
type Limit = z.infer<typeof LimitView>;
type Timer = z.infer<typeof TimerView>;
type Stage = z.infer<typeof StageView>;
type StepSummary = z.infer<typeof StepSummaryView>;
type Hold = z.infer<typeof HoldView>;
type TimelineEntry = z.infer<typeof TimelineEntryView>;
type Entry = z.infer<typeof EntryView>;

// ---------------------------------------------------------------------------------------------
// Texts

export const BATCH_STATUS_TEXT: Readonly<Record<engine.BatchStatus, string>> = {
  ISSUED: 'Issued',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  EXECUTION_COMPLETE: 'Execution complete',
  ABORTED: 'Aborted',
  CANCELLED: 'Cancelled',
};

export const STEP_STATUS_TEXT: Readonly<Record<engine.StepStatus, string>> = {
  PENDING: 'Not yet available',
  ENABLED: 'Ready to start',
  IN_PROGRESS: 'In progress',
  AWAITING_VERIFICATION: 'Performed, waiting for verification',
  COMPLETED: 'Completed',
  NOT_APPLICABLE: 'Not applicable',
  SKIPPED: 'Skipped',
};

function stepStatusText(inst: engine.StepInstance | undefined, def: engine.BatchDefinition, stepId: string): string {
  if (!inst) return STEP_STATUS_TEXT.PENDING;
  const node = def.steps.get(stepId)?.node;
  if (inst.kind === 'HOLD' && inst.status === 'ENABLED' && node?.kind === 'holdPoint') return `Waiting for ${node.role === 'QA' ? 'QA' : node.role.toLowerCase().replace(/_/g, ' ')}`;
  return STEP_STATUS_TEXT[inst.status];
}

export function watermark(): Watermark {
  const w = sandbox.watermarkFor('SANDBOX_TEST_RUN');
  if (!w) throw new Error('the sandbox test-run watermark is missing (DI-05)');
  return { text: 'TEST, NOT GMP', source: 'SANDBOX_TEST_RUN', notice: w.notice, control: 'DI-05' };
}

// ---------------------------------------------------------------------------------------------
// Context

/** Who is looking, from the session (or the signing context). */
export interface ViewerInfo {
  personId: string;
  legalName: string;
  loginName: string | null;
  roleCode: string | null;
  deviceClass: string;
  roomCode: string | null;
}

export interface ViewContext {
  app: AppContext;
  db: Db;
  run: RunContext;
  state: engine.BatchState;
  /** Database time of this view. */
  nowUs: bigint;
  rows: RunRows;
  session: ViewerInfo | null;
  /** The viewer as the engine sees them for display (mapped roles, no authority evaluated). */
  viewer: engine.Actor;
}

const fmt = (ctx: ViewContext, us: bigint): Instant => ctx.app.formatInstant(us);

const whoOf = (ctx: ViewContext): { id: string; name: string } | undefined => (ctx.session ? { id: ctx.session.personId, name: ctx.session.legalName } : undefined);

function personRef(ctx: ViewContext, personId: string, seq?: number): PersonRef | null {
  if (personId === 'SYSTEM') return null;
  return ctx.rows.person(personId, seq);
}

/** A person for a required PersonRef: the row's person, else the id itself (never invented). */
function personOrId(ctx: ViewContext, personId: string, seq?: number): PersonRef {
  return personRef(ctx, personId, seq) ?? { personId: /^[0-9a-f-]{36}$/i.test(personId) ? personId : '00000000-0000-0000-0000-000000000000', legalName: personId === 'SYSTEM' ? 'System' : personId, loginName: personId, role: '' };
}

function numbering(def: engine.BatchDefinition): flow.MbrNumbering {
  return engine.numberingOf(def);
}

function productOf(ctx: ViewContext): { code: string; name: string; strength: string } {
  const p = ctx.run.def.mbr.header.product;
  return { code: p.code, name: ctx.run.pkg.product.name || p.name, strength: p.strength };
}

// ---------------------------------------------------------------------------------------------
// Signatures (stored manifestations, DI-36)

export async function signaturesOf(db: Db, aggregateType: string, aggregateId: string): Promise<ManifestationView[]> {
  const out: ManifestationView[] = [];
  for (const r of await esig.recordSignatures(db, aggregateType, aggregateId)) {
    const stored = await esig.getManifestation(db, r.signatureId);
    out.push(manifestationView(stored.manifestation, r.signerPerson, stored.valid));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Actions

const PRIMARY_ORDER: readonly ActionView['action'][] = [
  'DISPOSITION_HOLD_POINT',
  'START_STEP',
  'RECORD_ENTRY',
  'RECORD_DATA',
  'SIGN_PERFORMED',
  'VERIFY',
  'WITNESS',
  'SIGN_OFF_STAGE',
  'ATTACH_DEVIATION',
  'DISPOSITION_EXCEPTION',
  'RELEASE_HOLD',
];

/**
 * ActionViews with exactly one primary action: the first available in the order of the work. The engine's
 * reasons name persons by id; the viewer's own id is shown as their name.
 */
export function actionViews(actions: readonly engine.AvailableAction[], shopFloor: boolean, who?: { id: string; name: string }): ActionView[] {
  let primary = -1;
  for (const kind of PRIMARY_ORDER) {
    primary = actions.findIndex((a) => a.action === kind && a.available);
    if (primary >= 0) break;
  }
  return actions.map((a, i) => ({
    action: a.action,
    available: a.available,
    primary: i === primary,
    requires: a.signed ? 'SIGNATURE' : shopFloor ? 'TAP' : 'NONE',
    meaning: a.meaning,
    reason: a.refusal ? (who ? a.refusal.message.split(who.id).join(who.name) : a.refusal.message) : null,
    target: a.target,
  }));
}

/** The actions a step's screen offers for its status (the engine decides each one). */
function stepActions(ctx: ViewContext, inst: engine.StepInstance | undefined, stepKey: string): engine.AvailableAction[] {
  const all = engine.availableActions(ctx.run.def, ctx.state, ctx.viewer, { nowUs: ctx.nowUs }, { stepKey });
  const status = inst?.status ?? 'PENDING';
  const relevant = (a: engine.AvailableAction): boolean => {
    switch (a.action) {
      case 'START_STEP':
        return status === 'ENABLED' || status === 'PENDING';
      case 'RECORD_DATA':
      case 'RECORD_ENTRY':
      case 'SIGN_PERFORMED':
        return status === 'IN_PROGRESS';
      case 'VERIFY':
      case 'WITNESS':
        return status === 'AWAITING_VERIFICATION';
      case 'DISPOSITION_HOLD_POINT':
        return status === 'ENABLED';
      default:
        return true;
    }
  };
  const run = engine.availableActions(ctx.run.def, ctx.state, ctx.viewer, { nowUs: ctx.nowUs }).filter((a) => a.action === 'HOLD_BATCH');
  return [...all.filter(relevant), ...run];
}

// ---------------------------------------------------------------------------------------------
// Values

function verdictText(ev: engine.StoredEvaluation | undefined, failed: boolean): string {
  if (!ev) return failed ? 'Failed' : 'No limit applies';
  if (ev.requirement === 'ENDPOINT_IN_PROGRESS') return 'Judged when the loop ends';
  if (ev.breached) return `Outside the ${ev.breached.toLowerCase().replace(/_/g, ' ')} limit: ${ev.detail.join('; ')}`;
  if (ev.requirement === 'UNEXPECTED_ANSWER') return 'Not the expected answer';
  return `Within limits (${ev.detail.join('; ')})`;
}

function echoOf(v: engine.DataValue | undefined, source: engine.DataSource): string {
  if (!v) return 'No value (attempt voided)';
  const shown = engine.showValue(v);
  switch (source.mode) {
    case 'MANUAL':
      return `You entered ${shown}`;
    case 'SCAN':
      return `Scanned ${shown}`;
    case 'BLOCK':
      return `Computed ${shown}`;
    case 'DEVICE':
      return `Captured ${shown} from ${source.device}`;
    default:
      return `Received ${shown}`;
  }
}

function attemptOfPoint(ctx: ViewContext, p: engine.DataPoint): Attempt {
  const s = p.source;
  return {
    pointId: p.id,
    attempt: p.attempt,
    version: p.version,
    value: p.value ? wireOf(p.value) : null,
    echo: echoOf(p.value, s),
    by: personOrId(ctx, p.enteredBy, p.recordedSeq),
    at: fmt(ctx, p.recordedAt),
    source: {
      mode: s.mode,
      deviceCode: s.mode === 'DEVICE' ? s.device : null,
      raw: s.mode === 'DEVICE' ? (s.raw ?? null) : null,
      code: s.mode === 'SCAN' ? s.code : null,
    },
    verdict: p.evaluation || p.failed ? { tier: p.evaluation?.breached ?? null, failed: p.failed, text: verdictText(p.evaluation, p.failed) } : null,
    flags: [...p.flags],
    status: p.status,
  };
}

function attemptOfDerived(ctx: ViewContext, d: engine.DerivedValue): Attempt {
  const row = ctx.rows.atEvent(d.computedSeq);
  return {
    pointId: d.id,
    attempt: 1,
    version: d.version,
    value: wireOf(d.value),
    echo: `Computed ${engine.showValue(d.value)}`,
    by: row?.actor ?? personOrId(ctx, 'SYSTEM'),
    at: fmt(ctx, d.computedAt),
    source: { mode: 'BLOCK', deviceCode: null, raw: null, code: null },
    verdict: d.evaluation || d.failed ? { tier: d.evaluation?.breached ?? null, failed: d.failed, text: verdictText(d.evaluation, d.failed) } : null,
    flags: d.reason ? ['RECOMPUTED'] : [],
    status: d.status === 'CURRENT' ? 'VALID' : 'SUPERSEDED',
  };
}

function refTitle(def: engine.BatchDefinition, id: string): string {
  const r = def.mbr.references.find((x) => x.id === id);
  return r ? `${r.code} v${r.version}: ${r.title}` : id;
}

export function limitViews(def: engine.BatchDefinition, spec: flow.LimitSpec | undefined): Limit[] {
  if (!spec) return [];
  return spec.ranges.map((r) => ({
    tier: r.tier,
    low: r.low ? { value: r.low.value, inclusive: r.low.inclusive } : null,
    high: r.high ? { value: r.high.value, inclusive: r.high.inclusive } : null,
    source: { kind: r.source.kind, ref: r.source.ref, text: refTitle(def, r.source.ref) },
    rounding: r.rounding,
  }));
}

/** The G-07 tolerance band around the dispensing target (display; the block judges the total at PERFORMED). */
function toleranceBand(def: engine.BatchDefinition, stepDef: engine.StepDef, target: { value: engine.DataValue; name: string } | null, unit: string | undefined): Limit[] {
  const tol = stepDef.block?.handler?.targetTolerance?.(stepDef.node as flow.PhaseNode, stepDef.config);
  if (!tol || !target || target.value.kind !== 'DECIMAL' || !unit) return [];
  const t = target.value.unit === unit ? target.value.value : def.expr.convert(target.value.value, target.value.unit, unit);
  if (t === undefined) return [];
  let delta: Dec;
  let text: string;
  if ('percent' in tol) {
    delta = Dec.parse(t).abs().times(Dec.parse(tol.percent)).div(Dec.HUNDRED);
    text = `Dispensing tolerance +/- ${tol.percent} % of ${target.name}`;
  } else {
    const abs = tol.absolute.unit === unit ? tol.absolute.value : def.expr.convert(tol.absolute.value, tol.absolute.unit, unit);
    if (abs === undefined) return [];
    delta = Dec.parse(abs);
    text = `Dispensing tolerance +/- ${tol.absolute.value} ${tol.absolute.unit} of ${target.name}`;
  }
  return [
    {
      tier: 'INTERNAL_ACTION',
      low: { value: Dec.parse(t).minus(delta).toString(), inclusive: true },
      high: { value: Dec.parse(t).plus(delta).toString(), inclusive: true },
      source: { kind: 'MBR_BLOCK_CONFIGURATION', ref: stepDef.id, text },
      rounding: 'NONE (exact comparison)',
    },
  ];
}

export function fieldsOf(ctx: ViewContext, stepDef: engine.StepDef, inst: engine.StepInstance | undefined, stepKey: string): FieldView[] {
  const def = ctx.run.def;
  if (stepDef.node.kind !== 'phase') return [];
  const phase = stepDef.node;
  const out: FieldView[] = [];
  const readTarget = (): { value: engine.DataValue; name: string } | null => {
    for (const r of phase.reads) {
      const t = inst?.targets[r];
      if (t?.value.kind === 'DECIMAL') {
        const name = def.mbr.calculations.find((c) => c.id === r)?.name ?? def.mbr.inputs.find((i) => i.id === r)?.name ?? r;
        return { value: t.value, name };
      }
    }
    return null;
  };
  for (const item of [...phase.records, ...phase.computes]) {
    const param = def.mbr.parameters.find((p) => p.id === item);
    const calc = def.mbr.calculations.find((c) => c.id === item);
    const computed = calc !== undefined || stepDef.computedItems.has(item);
    const unit = param?.unit ?? calc?.output.unit;
    const valueType: FieldView['valueType'] = param?.valueType ?? calc?.output.valueType ?? 'DECIMAL';
    let target: FieldView['target'] = null;
    let band: Limit[] = [];
    if (param?.target !== undefined && param.valueType === 'DECIMAL' && unit) {
      target = { value: { kind: 'DECIMAL', value: param.target, unit }, source: `MBR parameter ${param.name} (${param.id})` };
    } else if (stepDef.computedItems.has(item)) {
      const t = readTarget();
      if (t) {
        target = { value: wireOf(t.value), source: t.name };
        band = toleranceBand(def, stepDef, t, unit);
      }
    }
    const spec = param?.limits ?? calc?.limits ?? def.mbr.yieldCheckpoints.find((y) => y.result === item)?.limits;
    const attempts: Attempt[] = calc
      ? Object.values(ctx.state.derived)
          .filter((d) => d.stepKey === stepKey && d.calculation === item)
          .sort((a, b) => a.computedSeq - b.computedSeq)
          .map((d) => attemptOfDerived(ctx, d))
      : Object.values(ctx.state.points)
          .filter((p) => p.stepKey === stepKey && p.item === item)
          .sort((a, b) => a.attempt - b.attempt || a.version - b.version || a.recordedSeq - b.recordedSeq)
          .map((p) => attemptOfPoint(ctx, p));
    out.push({
      item,
      name: param?.name ?? calc?.name ?? item,
      valueType,
      unit: unit ?? null,
      precision: param?.precision ? { kind: param.precision.kind, digits: param.precision.digits } : null,
      categories: param?.categories ? [...param.categories] : null,
      capture: param ? param.capture : 'MANUAL',
      target,
      limits: [...limitViews(def, spec), ...band],
      attempts,
      computed,
      required: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Entries and entry forms

/** Plain text of a scalar entry member ('' for anything else). */
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '');

function summaryOf(e: engine.EntryRecord): string {
  const d = e.data;
  const s = (k: string): string => text(d[k]);
  switch (e.kind) {
    case 'CONTAINER_WEIGHING': {
      const lot = (d['lot'] ?? {}) as Record<string, unknown>;
      return `Container ${s('container')}: lot ${text(lot['id'])}, net ${s('net')} ${s('unit')} (gross ${s('gross')} ${s('unit')}, tare ${s('tare')} ${s('unit')}) on ${s('balance')}${s('source') === 'MANUAL' ? ', keyed by hand' : ''}`;
    }
    case 'OUTPUT_CONTAINER':
      return `Container ${s('container')} of ${s('intermediate')}: net ${s('net')} ${s('unit')} (gross ${s('gross')} ${s('unit')}, tare ${s('tare')} ${s('unit')}) on ${s('balance')}${s('source') === 'MANUAL' ? ', keyed by hand' : ''}`;
    case 'CHARGE_CONTAINER':
      return `Charged ${s('container')} (${s('holds')})`;
    case 'CHARGE_LOT':
      return `Charged lot ${text(((d['lot'] ?? {}) as Record<string, unknown>)['id'])} for ${s('bomLine')}`;
    case 'CLEARANCE_CHECK':
    case 'EQUIPMENT_STATUS': {
      const answers = Array.isArray(d['answers']) ? (d['answers'] as { id: string; answer: string }[]) : [];
      const tally = new Map<string, number>();
      for (const a of answers) tally.set(a.answer, (tally.get(a.answer) ?? 0) + 1);
      const parts = [...tally].map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ');
      return e.kind === 'EQUIPMENT_STATUS' ? `${s('equipmentRef')} (label ${s('labelId')}): ${parts}` : `Checklist: ${parts}`;
    }
    case 'PREVIOUS_BATCH':
      return `Previous batch: ${s('product')} ${s('batchNumber')}`;
    case 'ACKNOWLEDGE':
      return `${s('mode') === 'CONFIRM_PERFORMED' ? 'Confirmed performed' : 'Read'}${d['sop'] ? `: ${s('sop')} version ${s('sopVersion')}` : ''}`;
    default:
      return e.kind.toLowerCase().replace(/_/g, ' ');
  }
}

export function entriesOf(ctx: ViewContext, stepKey: string): Entry[] {
  return Object.values(ctx.state.entries)
    .filter((e) => e.stepKey === stepKey)
    .sort((a, b) => a.recordedSeq - b.recordedSeq)
    .map((e) => ({ entryId: e.id, kind: e.kind, summary: summaryOf(e), data: JSON.parse(JSON.stringify(e.data)) as Record<string, unknown>, by: personOrId(ctx, e.enteredBy, e.recordedSeq), at: fmt(ctx, e.recordedAt) }));
}

type FormField = EntryFormT['fields'][number];
const field = (name: string, label: string, type: FormField['type'], description: string, extra: Partial<FormField> = {}): FormField => ({
  name,
  label,
  type,
  unit: null,
  options: null,
  required: true,
  description,
  ...extra,
});

function equipmentLabel(def: engine.BatchDefinition, stepDef: engine.StepDef, ref: string): string {
  const stage = stepDef.stage ? def.stages.get(stepDef.stage) : undefined;
  const eq = stage?.binding.equipment.find((e) => e.ref === ref);
  const cls = eq ? def.mbr.references.find((r) => r.id === eq.equipmentClass) : undefined;
  return cls ? `${ref}: ${cls.title}` : ref;
}

/** Forms of the entry kinds the browser can send for this step's block (the client entry variants). */
function entryFormsOf(def: engine.BatchDefinition, stepDef: engine.StepDef): EntryFormT[] {
  if (stepDef.node.kind !== 'phase' || !stepDef.block) return [];
  const phase = stepDef.node;
  const kinds = Object.keys(stepDef.block.dataSchema?.entries ?? {});
  const massItems = blocks.massItems(phase, def.mbr);
  const unit = massItems[0] ? def.mbr.parameters.find((p) => p.id === massItems[0])?.unit ?? null : null;
  const readings = (): FormField[] => [
    field('tareReadingId', 'Tare', 'reading', 'Capture the tare from the scale', { unit }),
    field('grossReadingId', 'Gross', 'reading', 'Capture the gross from the scale', { unit }),
  ];
  const out: EntryFormT[] = [];
  for (const kind of kinds) {
    switch (kind) {
      case 'CONTAINER_WEIGHING': {
        const bom = phase.consumes.map((b) => {
          const line = def.mbr.bom.find((x) => x.id === b);
          const ref = line ? def.mbr.references.find((r) => r.id === line.material) : undefined;
          return { value: b, label: ref ? `${ref.title} (${ref.code})` : (line?.material ?? b) };
        });
        out.push({
          kind,
          title: 'Weigh one container',
          description: 'Scan the lot, capture tare and gross from the scale; the net is computed. Keying by hand (scale offline) needs a second person.',
          fields: [
            ...(massItems.length > 1
              ? [field('item', 'Quantity', 'enum', 'The dispensed quantity this container counts towards', { options: massItems.map((i) => ({ value: i, label: def.mbr.parameters.find((p) => p.id === i)?.name ?? i })) })]
              : []),
            field('bomLine', 'Material', 'enum', 'The BOM line dispensed into this container', { options: bom }),
            field('lotCode', 'Lot', 'lot', 'Scan the lot label (TEST- lots only)'),
            ...readings(),
          ],
        });
        break;
      }
      case 'OUTPUT_CONTAINER':
        out.push({
          kind,
          title: 'Weigh one output container',
          description: 'Capture tare and gross; the container id is given by the system.',
          fields: [
            field('intermediate', 'Intermediate', 'enum', 'What the container holds', { options: phase.produces.map((i) => ({ value: i, label: def.mbr.intermediates.find((x) => x.id === i)?.name ?? i })) }),
            ...readings(),
          ],
        });
        break;
      case 'CHARGE_CONTAINER':
        out.push({ kind, title: 'Charge a container', description: 'Only containers of this batch planned for this step are accepted, once each.', fields: [field('containerCode', 'Container label', 'container', 'Scan the container label')] });
        break;
      case 'CLEARANCE_CHECK':
        out.push({
          kind,
          title: 'Clearance checklist',
          description: 'Answer every item; NOT CONFIRMED stops the step until QA decides.',
          fields: [field('answers', 'Checklist', 'checklist', 'CONFIRMED, NOT CONFIRMED or NOT APPLICABLE (where allowed) for each item', { options: blocks.clearanceChecklist(stepDef.config).map((c) => ({ value: c.id, label: c.text })) })],
        });
        break;
      case 'PREVIOUS_BATCH':
        out.push({
          kind,
          title: 'Previous batch',
          description: 'Product and batch number last processed in this area.',
          fields: [field('product', 'Previous product', 'string', 'As shown on the previous batch record'), field('batchNumber', 'Previous batch number', 'string', 'As shown on the previous batch record')],
        });
        break;
      case 'EQUIPMENT_STATUS': {
        const refs = blocks.checkedEquipment(phase);
        out.push({
          kind,
          title: 'Equipment status',
          description: 'Any NO raises a blocking exception (sandbox only until Phase 3).',
          fields: [
            field('equipmentRef', 'Equipment', 'enum', 'Equipment checked', { options: refs.map((r) => ({ value: r, label: equipmentLabel(def, stepDef, r) })) }),
            field('labelId', 'Status label', 'string', 'Scan the status label'),
            field('answers', 'Checks', 'checklist', 'YES or NO for each check', { options: blocks.statusChecks(stepDef.config).map((c) => ({ value: c.id, label: c.text })) }),
          ],
        });
        break;
      }
      case 'ACKNOWLEDGE': {
        const mode = stepDef.config['acknowledgement'] === 'CONFIRM_PERFORMED' ? 'CONFIRM_PERFORMED' : 'READ';
        out.push({
          kind,
          title: 'Acknowledge the instruction',
          description: 'Confirms you read the instruction and the SOP version shown.',
          fields: [field('mode', 'I confirm', 'enum', 'Acknowledgement', { options: [{ value: mode, label: mode === 'READ' ? 'I have read the instruction' : 'I performed the instruction' }] })],
        });
        break;
      }
      default:
        // Entry kinds the browser cannot send in this release (they arrive with later increments).
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Exceptions

function limitText(spec: flow.LimitSpec | undefined, tier: string | undefined): string | null {
  const r = spec?.ranges.find((x) => x.tier === tier) ?? spec?.ranges[0];
  if (!r || !spec) return null;
  if (r.low && r.high) return `${r.low.value} - ${r.high.value} ${spec.unit}`;
  if (r.low) return `${r.low.inclusive ? 'at least' : 'more than'} ${r.low.value} ${spec.unit}`;
  if (r.high) return `${r.high.inclusive ? 'at most' : 'less than'} ${r.high.value} ${spec.unit}`;
  return null;
}

export function specOf(def: engine.BatchDefinition, item: string | undefined): flow.LimitSpec | undefined {
  if (!item) return undefined;
  return def.mbr.parameters.find((p) => p.id === item)?.limits ?? def.mbr.calculations.find((c) => c.id === item)?.limits ?? def.mbr.yieldCheckpoints.find((y) => y.result === item)?.limits;
}

function whatToDo(e: engine.ExceptionRecord, blocking: boolean): string {
  if (e.status === 'DISPOSITIONED') return 'Dispositioned; nothing more to do.';
  if (blocking && e.block?.until === 'DEVIATION' && !e.deviation) return 'Stop. The supervisor links a deviation; the affected steps wait until then.';
  if (blocking && e.qaOnly) return 'Stop. QA decides this exception; the affected steps wait for the decision.';
  if (blocking) return 'Stop. The affected steps wait until the exception is dispositioned.';
  if (e.severity === 'ALERT') return 'Continue; the supervisor reviews the alert. If the value is wrong, raise it with the supervisor.';
  return e.deviationRequired ? 'Continue with this step; a deviation must be linked and QA decides before the stage sign-off.' : 'Continue; the exception is decided before the stage sign-off.';
}

export function exceptionView(ctx: ViewContext, e: engine.ExceptionRecord): ExceptionView {
  const blocking = engine.blockActive(e);
  const point = e.source.point !== undefined ? ctx.state.points[e.source.point] : undefined;
  const derived = e.source.derived !== undefined ? ctx.state.derived[e.source.derived] : undefined;
  const item = point?.item ?? derived?.calculation ?? e.source.item;
  const routedTo = e.qaOnly || e.registrationRelevant ? ['QA'] : e.deviationRequired ? [...ctx.run.def.policy.supervisorRoles, ...ctx.run.def.policy.qaRoles] : [...ctx.run.def.policy.supervisorRoles];
  return {
    exceptionId: e.id,
    type: e.type,
    title: e.title,
    category: e.category,
    severity: e.severity,
    tier: e.tier ?? null,
    expected: limitText(specOf(ctx.run.def, item), e.tier),
    actual: point?.value ? engine.showValue(point.value) : derived ? engine.showValue(derived.value) : null,
    blocking,
    whatToDo: whatToDo(e, blocking),
    routedTo: [...new Set(routedTo)],
    status: e.status,
    deviationRef: e.deviation?.ref ?? null,
    raisedAt: fmt(ctx, e.raisedAt),
    raisedBy: personRef(ctx, e.raisedBy, e.raisedSeq),
    controls: [...e.controls],
  };
}

export function exceptionsOfStep(ctx: ViewContext, inst: engine.StepInstance | undefined, stepKey: string, stepId: string): engine.ExceptionRecord[] {
  return Object.values(ctx.state.exceptions)
    .filter((x) => x.source.stepKey === stepKey || (x.source.stepKey === undefined && x.source.step === stepId && engine.stepKey(stepId, x.source.frames) === (inst?.key ?? stepKey)))
    .sort((a, b) => a.raisedSeq - b.raisedSeq);
}

// ---------------------------------------------------------------------------------------------
// Header, timers

function timersOf(ctx: ViewContext): Timer[] {
  const out: Timer[] = [];
  for (const ti of Object.values(ctx.state.timeInstances)) {
    const rc = ctx.run.def.constraints.find((c) => c.tc.id === ti.constraint);
    if (!rc) continue;
    const inInstance = (frames: readonly flow.Frame[]): boolean => frames.every((f) => !rc.shared.includes(f.construct) || ti.frames.some((x) => x.construct === f.construct && x.index === f.index));
    const froms = Object.values(ctx.state.nodeEvents).filter((e) => e.node === rc.from.node && e.event === rc.from.event && inInstance(e.frames));
    const start = froms.length === 0 ? undefined : froms.map((f) => f.at).reduce((a, b) => (rc.from.event === 'START' ? (b < a ? b : a) : b > a ? b : a));
    const met = start !== undefined && Object.values(ctx.state.nodeEvents).some((e) => e.node === rc.to.node && e.event === rc.to.event && inInstance(e.frames) && e.at >= start);
    const status: Timer['status'] = ti.voided ? 'VOIDED' : ti.maxBreachException || ti.minBreachException ? 'BREACHED' : met ? 'MET' : ti.warned ? 'WARNING' : 'RUNNING';
    const min = rc.tc.min ? flow.durationToMicros(rc.tc.min.value, rc.tc.min.unit) : undefined;
    const max = rc.tc.max ? flow.durationToMicros(rc.tc.max.value, rc.tc.max.unit) : undefined;
    out.push({
      constraint: rc.tc.id,
      name: rc.tc.name,
      kind: rc.tc.kind,
      status,
      startedAt: start !== undefined ? fmt(ctx, start) : null,
      minAt: start !== undefined && min !== undefined ? fmt(ctx, start + min) : null,
      maxAt: start !== undefined && max !== undefined ? fmt(ctx, start + max) : null,
    });
  }
  return out.filter((t) => t.status !== 'MET' && t.status !== 'VOIDED');
}

export function stageRef(ctx: ViewContext, stageId: string | undefined): RunHeaderView['stage'] {
  if (!stageId) return null;
  const node = ctx.run.def.stages.get(stageId);
  const n = numbering(ctx.run.def).byId.get(stageId);
  const frame = Object.values(ctx.state.stages).find((f) => f.stage === stageId);
  return { stageKey: frame?.key ?? `${stageId}@`, number: n?.number ?? '', name: node?.name ?? stageId };
}

/** The stage the run is in: the first stage frame not signed off, else the last one. */
function currentStage(ctx: ViewContext): string | undefined {
  const frames = Object.values(ctx.state.stages).sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return (frames.find((f) => f.signOff?.valid !== true) ?? frames[frames.length - 1])?.stage;
}

async function header(ctx: ViewContext, stageId: string | undefined, withScale: boolean): Promise<RunHeaderView> {
  const def = ctx.run.def;
  const stage = stageId ? def.stages.get(stageId) : undefined;
  const room = stage?.binding.rooms[0] ?? ctx.run.batch.roomCode ?? null;
  const scale = withScale ? await ctx.app.deviceReadings.scaleStatus(ctx.session?.roomCode ?? null) : null;
  const s = ctx.session;
  const last = ctx.rows.last;
  return {
    runId: ctx.run.batch.id,
    batchNumber: ctx.state.header.batchNumber,
    product: productOf(ctx),
    markets: [...ctx.state.header.marketSet],
    status: ctx.state.status,
    statusText: BATCH_STATUS_TEXT[ctx.state.status],
    watermark: watermark(),
    version: ctx.state.version,
    mbr: { familyCode: ctx.run.pkg.familyCode, versionNumber: ctx.run.pkg.versionNumber, revision: ctx.run.pkg.revision, contentHash: ctx.run.def.contentHash },
    stage: stageRef(ctx, stageId),
    room,
    equipment: (stage?.binding.equipment ?? []).map((e) => {
      const cls = def.mbr.references.find((r) => r.id === e.equipmentClass);
      const code = e.kind === 'INSTRUMENT' && scale && scale.roomCode === room ? scale.deviceCode : (cls?.code ?? e.equipmentClass);
      return { ref: e.ref, code, name: cls?.title ?? e.equipmentClass };
    }),
    timers: timersOf(ctx),
    scale,
    identity: s && s.roleCode && s.loginName ? { personId: s.personId, legalName: s.legalName, loginName: s.loginName, role: s.roleCode } : null,
    lastSavedAt: last ? fmt(ctx, last.nowUs) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Step screen

const WEIGHING_KINDS = new Set(['CONTAINER_WEIGHING', 'OUTPUT_CONTAINER']);

export async function stepScreen(ctx: ViewContext, stepKey: string): Promise<StepScreenView> {
  const def = ctx.run.def;
  const inst = ctx.state.steps[stepKey];
  const stepId = inst?.step ?? stepKey.slice(0, Math.max(0, stepKey.indexOf('@')));
  const stepDef = def.steps.get(stepId);
  if (!stepDef) throw notFound('step');
  const node = stepDef.node;
  const n = numbering(def);
  const numbered = n.byId.get(stepId);
  const ordinal = numbered?.ordinal ?? Math.max(1, n.steps.findIndex((x) => x.id === stepId) + 1);
  const sopId = node.kind === 'phase' && typeof node.config['sop'] === 'string' ? node.config['sop'] : undefined;
  const sop = sopId ? def.mbr.references.find((r) => r.id === sopId) : undefined;
  const text =
    node.kind === 'phase' && typeof node.config['text'] === 'string'
      ? node.config['text']
      : sop
        ? `${node.name}: follow ${sop.code} version ${sop.version} (${sop.title}).`
        : node.kind === 'holdPoint'
          ? `${node.name}: ${node.role === 'QA' ? 'QA' : node.role} decides (${node.dispositions.join(' or ')}).`
          : node.name;
  const kinds = stepDef.block?.dataSchema ? Object.keys(stepDef.block.dataSchema.entries) : [];
  const withScale = kinds.some((k) => WEIGHING_KINDS.has(k));
  const shopFloor = ctx.session?.deviceClass === 'SHARED' || ctx.session?.deviceClass === 'GRADE_A_B';
  const exceptions = exceptionsOfStep(ctx, inst, stepKey, stepId);
  const aggregateId = `${ctx.run.batch.id}:${stepKey}`;
  return {
    asOf: fmt(ctx, ctx.nowUs),
    run: await header(ctx, stepDef.stage, withScale),
    step: {
      stepKey,
      stepId,
      number: inst ? flow.instanceNumber(n, stepId, inst.frames).text : (numbered?.number ?? ''),
      ordinal,
      of: Math.max(ordinal, n.totalSteps),
      title: node.name,
      kind: node.kind === 'holdPoint' ? 'HOLD' : 'PHASE',
      block: node.kind === 'phase' ? `${node.block.type}@${node.block.version}` : null,
      blockTitle: stepDef.block?.title ?? null,
      status: inst?.status ?? 'PENDING',
      statusText: stepStatusText(inst, def, stepId),
      instruction: { text, sop: sop ? { refId: sop.id, code: sop.code, title: sop.title ?? sop.code, version: sop.version, hash: sop.hash ?? '' } : null },
      dispositions: node.kind === 'holdPoint' ? [...node.dispositions] : [],
    },
    fields: fieldsOf(ctx, stepDef, inst, stepKey),
    entries: entriesOf(ctx, stepKey),
    entryForms: entryFormsOf(def, stepDef),
    exceptions: exceptions.map((e) => exceptionView(ctx, e)),
    signatures: inst ? await signaturesOf(ctx.db, 'batch_step', aggregateId) : [],
    actions: actionViews(stepActions(ctx, inst, stepKey), shopFloor, whoOf(ctx)),
    // A phase's signable content exists once someone has worked on it (storedOnCreation); a hold point's at once.
    signable: inst && (inst.kind === 'HOLD' || !['PENDING', 'ENABLED'].includes(inst.status)) ? { aggregateType: 'batch_step', aggregateId } : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Run overview

export function stepSummary(ctx: ViewContext, inst: engine.StepInstance | undefined, stepId: string, key: string): StepSummary {
  const def = ctx.run.def;
  const node = def.steps.get(stepId)?.node;
  const n = numbering(def);
  return {
    stepKey: key,
    stepId,
    number: inst ? flow.instanceNumber(n, stepId, inst.frames).text : (n.byId.get(stepId)?.number ?? ''),
    title: node?.name ?? stepId,
    block: node?.kind === 'phase' ? `${node.block.type}@${node.block.version}` : null,
    status: inst?.status ?? 'PENDING',
    statusText: stepStatusText(inst, def, stepId),
    openExceptions: Object.values(ctx.state.exceptions).filter((e) => e.status === 'OPEN' && e.source.stepKey === key).length,
  };
}

async function stagesOf(ctx: ViewContext): Promise<Stage[]> {
  const def = ctx.run.def;
  const n = numbering(def);
  const out: Stage[] = [];
  for (const numbered of n.stages) {
    const node = def.stages.get(numbered.id);
    const frames = Object.values(ctx.state.stages).filter((f) => f.stage === numbered.id);
    const stepIds = n.steps.filter((s) => s.stage === numbered.id).map((s) => s.id);
    if (frames.length === 0) {
      out.push({
        stageKey: `${numbered.id}@`,
        stageId: numbered.id,
        number: numbered.number,
        name: node?.name ?? numbered.name,
        status: 'NOT_STARTED',
        summary: null,
        signOff: null,
        signable: null,
        steps: stepIds.map((id) => stepSummary(ctx, undefined, id, `${id}@`)),
      });
      continue;
    }
    for (const frame of frames) {
      const insts = engine.stageSteps(def, ctx.state, frame);
      const steps: StepSummary[] = [];
      for (const id of stepIds) {
        const mine = insts.filter((i) => i.step === id);
        if (mine.length === 0) steps.push(stepSummary(ctx, undefined, id, engine.stepKey(id, frame.frames)));
        for (const i of mine) steps.push(stepSummary(ctx, i, id, i.key));
      }
      const aggregateId = `${ctx.run.batch.id}:${frame.key}`;
      const signatures = await signaturesOf(ctx.db, 'batch_stage', aggregateId);
      const signOff = frame.signOff ? (signatures.find((s) => s.signatureId === frame.signOff?.signature) ?? null) : null;
      const st = engine.stageState(frame);
      out.push({
        stageKey: frame.key,
        stageId: frame.stage,
        number: numbered.number,
        name: node?.name ?? numbered.name,
        status: st === 'SIGNED_OFF' ? 'SIGNED_OFF' : st === 'AWAITING_SIGN_OFF' ? 'AWAITING_SIGN_OFF' : 'IN_PROGRESS',
        summary: frame.signOff ? { statement: frame.signOff.summary.statement, exceptions: [...frame.signOff.summary.exceptions], deviations: [...frame.signOff.summary.deviations] } : null,
        signOff,
        signable: { aggregateType: 'batch_stage', aggregateId },
        steps,
      });
    }
  }
  return out;
}

function holdView(ctx: ViewContext, h: engine.HoldRecord): Hold {
  return {
    holdId: h.id,
    type: h.type,
    reason: h.reason,
    placedBy: h.automatic ? null : personRef(ctx, h.placedBy),
    at: fmt(ctx, h.at),
    automatic: h.automatic,
    released: h.released ? { by: personOrId(ctx, h.released.by), reason: h.released.reason, at: fmt(ctx, h.released.at) } : null,
  };
}

export async function runView(ctx: ViewContext): Promise<RunView> {
  const shopFloor = ctx.session?.deviceClass === 'SHARED' || ctx.session?.deviceClass === 'GRADE_A_B';
  return {
    asOf: fmt(ctx, ctx.nowUs),
    header: await header(ctx, currentStage(ctx), false),
    stages: await stagesOf(ctx),
    exceptions: Object.values(ctx.state.exceptions)
      .sort((a, b) => a.raisedSeq - b.raisedSeq)
      .map((e) => exceptionView(ctx, e)),
    holds: Object.values(ctx.state.holds).map((h) => holdView(ctx, h)),
    actions: actionViews(engine.availableActions(ctx.run.def, ctx.state, ctx.viewer, { nowUs: ctx.nowUs }), shopFloor, whoOf(ctx)),
    auditChain: `batch:${ctx.run.batch.id}`,
  };
}

export function runSummary(ctx: Pick<ViewContext, 'app' | 'run' | 'state'>): z.infer<typeof RunSummaryView> {
  const p = ctx.run.def.mbr.header.product;
  return {
    runId: ctx.run.batch.id,
    batchNumber: ctx.state.header.batchNumber,
    product: { code: p.code, name: ctx.run.pkg.product.name || p.name, strength: p.strength },
    markets: [...ctx.state.header.marketSet],
    status: ctx.state.status,
    statusText: BATCH_STATUS_TEXT[ctx.state.status],
    issuedAt: ctx.app.formatInstant(ctx.state.header.issuedAt),
    version: ctx.state.version,
    openExceptions: Object.values(ctx.state.exceptions).filter((e) => e.status === 'OPEN').length,
  };
}

/** Work-queue items of one run: every step instance not finished whose stage is bound to `room` (all rooms when null). */
export function workQueueItems(ctx: ViewContext, room: string | null): WorkQueueItem[] {
  const def = ctx.run.def;
  const n = numbering(def);
  const shopFloor = ctx.session?.deviceClass === 'SHARED' || ctx.session?.deviceClass === 'GRADE_A_B';
  const out: WorkQueueItem[] = [];
  const insts = Object.values(ctx.state.steps)
    .filter((i) => !engine.TERMINAL_STEP_STATUSES.includes(i.status))
    .sort((a, b) => (n.byId.get(a.step)?.ordinal ?? 0) - (n.byId.get(b.step)?.ordinal ?? 0) || (a.key < b.key ? -1 : 1));
  for (const inst of insts) {
    const stepDef = def.steps.get(inst.step);
    if (!stepDef) continue;
    const stage = stepDef.stage ? def.stages.get(stepDef.stage) : undefined;
    const rooms = stage?.binding.rooms ?? [];
    if (room !== null && rooms.length > 0 && !rooms.includes(room)) continue;
    const views = actionViews(stepActions(ctx, inst, inst.key), shopFloor, whoOf(ctx));
    const action = views.find((v) => v.primary) ?? views.find((v) => v.action !== 'RAISE_EXCEPTION' && v.action !== 'HOLD_BATCH') ?? views[0];
    if (!action) continue;
    const sn = stepDef.stage ? n.byId.get(stepDef.stage) : undefined;
    out.push({
      runId: ctx.run.batch.id,
      batchNumber: ctx.state.header.batchNumber,
      product: runSummary(ctx).product,
      stepKey: inst.key,
      number: flow.instanceNumber(n, inst.step, inst.frames).text,
      title: stepDef.node.name,
      stage: sn ? `${sn.number} ${stage?.name ?? sn.name}` : '',
      room: rooms[0] ?? null,
      status: inst.status,
      statusText: stepStatusText(inst, def, inst.step),
      action,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Timeline

function rowSummary(r: RunRows['rows'][number]): string {
  const c = r.command;
  const at = (step: unknown, context: unknown): string => {
    if (typeof step !== 'string') return '';
    const frames = Array.isArray(context) ? (context as flow.Frame[]) : [];
    return ` ${engine.stepKey(step, frames)}`;
  };
  switch (r.kind) {
    case 'ISSUE':
      return 'Batch issued (test run)';
    case 'SWEEP':
      return 'Time sweep by the system: time limits evaluated';
    case 'PREPARE': {
      const t = (c['target'] ?? {}) as Record<string, unknown>;
      return `Prepared for signing (${text(t['type']) || '?'}${at(t['step'], t['context'])})`;
    }
    default: {
      const what = at(c['step'] ?? c['stage'], c['context']) || (typeof c['exception'] === 'string' ? ` ${c['exception']}` : typeof c['hold'] === 'string' ? ` ${c['hold']}` : '');
      const sig = (c['signature'] ?? null) as Record<string, unknown> | null;
      return `${r.commandType}${what}${sig && typeof sig['meaning'] === 'string' ? ` (signed ${sig['meaning']})` : ''}`;
    }
  }
}

export function timeline(app: AppContext, rows: RunRows): TimelineEntry[] {
  return rows.rows.map((r) => ({
    seq: r.seq.toString(),
    kind: r.kind,
    at: app.formatInstant(r.nowUs),
    actor: r.actor,
    summary: rowSummary(r),
    accepted: r.accepted,
    refusal: r.refusal ? r.refusal.message || r.refusal.code : null,
  }));
}
