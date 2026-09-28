/**
 * Plain words for what a person is sending (the NOT SAVED notice repeats it) and for what changed on a step
 * when an entry arrived stale (module C4). Pure: only arranges what the person typed and what the server sent.
 */
import type { ClientIntent, StepScreenView } from '@ebmr/api-contract';
import { floor } from '@ebmr/ui-kit';

type Fields = StepScreenView['fields'];

function fieldName(fields: Fields | undefined, item: string): string {
  return fields?.find((f) => f.item === item)?.name ?? item;
}

/** One line for an intent, e.g. "Blend time: 15 min" or "Charge container TEST-B26-0001/C-2". */
export function describeIntent(intent: ClientIntent, view?: StepScreenView): string {
  switch (intent.type) {
    case 'START_STEP':
      return view ? `Start step ${view.step.number} ${view.step.title}` : 'Start the step';
    case 'RECORD_DATA':
      return `${fieldName(view?.fields, intent.item)}: ${floor.valueText(intent.value, '')}${intent.source.mode === 'SCAN' ? ' (scanned)' : ''}`;
    case 'RECORD_ENTRY': {
      const e = intent.entry;
      switch (e.kind) {
        case 'CONTAINER_WEIGHING':
          return `Container weighing: lot ${e.lotCode}, ${e.manual ? `tare ${e.manual.tare} ${e.manual.unit}, gross ${e.manual.gross} ${e.manual.unit} (typed by hand)` : 'tare and gross from the scale'}`;
        case 'CHARGE_CONTAINER':
          return `Charge container ${e.containerCode}`;
        case 'CLEARANCE_CHECK': {
          const no = e.answers.filter((a) => a.answer === 'NOT_CONFIRMED').length;
          return `Clearance checklist: ${e.answers.length} answers${no > 0 ? `, ${no} not confirmed` : ''}`;
        }
        case 'PREVIOUS_BATCH':
          return `Previous batch: ${e.product}, batch ${e.batchNumber}`;
        case 'EQUIPMENT_STATUS': {
          const no = e.answers.filter((a) => a.answer === 'NO').length;
          return `Equipment status of ${e.equipmentRef}: label ${e.labelId}, ${e.answers.length} checks${no > 0 ? `, ${no} answered no` : ''}`;
        }
        case 'ACKNOWLEDGE':
          return e.mode === 'READ' ? 'Acknowledgement: I have read the instruction' : 'Acknowledgement: I confirm the work was done';
        case 'OUTPUT_CONTAINER':
          return `Output container of ${e.intermediate}: ${e.manual ? `tare ${e.manual.tare} ${e.manual.unit}, gross ${e.manual.gross} ${e.manual.unit} (typed by hand)` : 'tare and gross from the scale'}`;
      }
      return 'Entry';
    }
    case 'RAISE_EXCEPTION':
      return `Exception (${intent.severity === 'ACTION' ? 'action' : 'alert'}): ${intent.description}`;
    case 'ATTACH_DEVIATION':
      return `Link deviation ${intent.deviationRef} to exception ${intent.exception}`;
    case 'HOLD_BATCH':
      return `Hold the batch (${intent.holdType === 'QA' ? 'QA' : 'supervisor'}): ${intent.reason}`;
    case 'RELEASE_HOLD':
      return `Release hold ${intent.hold}: ${intent.reason}`;
  }
}

const attemptKey = (a: Fields[number]['attempts'][number]) => `${a.pointId}/${a.attempt}/${a.version}`;

/** What changed between the step as the person saw it and as the server now holds it. */
export function describeChanges(before: StepScreenView | undefined, after: StepScreenView): string[] {
  const out: string[] = [];
  if (!before) return ['The step was reloaded from the server.'];
  if (before.run.version !== after.run.version) out.push(`The run moved on (version ${before.run.version} to ${after.run.version}).`);
  if (before.run.status !== after.run.status) out.push(`Batch status: ${before.run.statusText} → ${after.run.statusText}.`);
  if (before.step.status !== after.step.status) out.push(`Step status: ${before.step.statusText} → ${after.step.statusText}.`);
  for (const field of after.fields) {
    const seen = new Set(before.fields.find((f) => f.item === field.item)?.attempts.map(attemptKey) ?? []);
    for (const a of field.attempts) {
      if (!seen.has(attemptKey(a))) out.push(`${field.name}: ${floor.valueText(a.value, a.echo)} recorded by ${a.by.legalName} at ${a.at.text}.`);
    }
  }
  const entries = new Set(before.entries.map((e) => e.entryId));
  for (const e of after.entries) if (!entries.has(e.entryId)) out.push(`New entry: ${e.summary} (${e.by.legalName}, ${e.at.text}).`);
  const exceptions = new Map(before.exceptions.map((e) => [e.exceptionId, e]));
  for (const e of after.exceptions) {
    const old = exceptions.get(e.exceptionId);
    if (!old) out.push(`New exception: ${e.title}.`);
    else if (old.status !== e.status || old.deviationRef !== e.deviationRef) out.push(`Exception ${e.title}: ${e.deviationRef ? `deviation ${e.deviationRef} linked` : e.status.toLowerCase()}.`);
  }
  const signatures = new Set(before.signatures.map((s) => s.signatureId));
  for (const s of after.signatures) if (!signatures.has(s.signatureId)) out.push(`New signature: ${s.meaningText} ${s.signer.legalName} at ${s.signedAt.text}.`);
  if (out.length === 0) out.push('Nothing changed on this step; the run changed elsewhere (for example a timer or another step).');
  return out;
}
