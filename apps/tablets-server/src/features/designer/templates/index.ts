/**
 * MBR templates the designer starts from (module C2). A1 ships one: dc-mini, "Paracetamol 500 mg tablets, direct
 * compression (mini)" (Phase 2 apps plan section 8), which passes every validator gate against the real reference
 * and market adapters, simulates with full coverage and defines as a sandbox batch (test/designer/template.test.ts).
 *
 * A template is only a starting point: the family and DRAFT version created from it are the author's master, which
 * goes through validation, verification and approval like any other.
 */
import { flow } from '@ebmr/recipe-core/pure';
import dcMini from './dc-mini.mbr.json' with { type: 'json' };

export interface MbrTemplate {
  templateId: string;
  title: string;
  description: string;
  content: flow.MbrContent;
}

function parsed(json: unknown, id: string): flow.MbrContent {
  const r = flow.parseMbr(json);
  if (!r.ok) throw new Error(`template ${id} does not parse: ${r.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return r.mbr;
}

export const TEMPLATES: ReadonlyMap<string, MbrTemplate> = new Map(
  [
    {
      templateId: 'dc-mini',
      title: 'Paracetamol 500 mg tablets, direct compression (mini)',
      description:
        'Two stages (dispensing, blending) and 14 steps: clearances, equipment status, SOP acknowledgement, dispensing quantities, weighing on the balance, charge-in, blend time and speed with alert, internal action and registered limits, QA hold point, output containers, reconciliation and yield. Reference batch 60.000 kg (1,00,000 tablets); also 30.000 kg.',
      content: parsed(dcMini, 'dc-mini'),
    },
  ].map((t) => [t.templateId, t]),
);

/** Number of steps (phases and hold points) of a content. */
export function stepCount(content: flow.MbrContent): number {
  return flow.numberMbr(content).totalSteps;
}
