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
import gbT01 from './gb-t-01.mbr.json' with { type: 'json' };

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
    {
      templateId: 'gb-t-01',
      title: 'Exemplazine tablets 250 mg, film-coated: wet granulation to release for packing (golden batch GB-T-01, invented formula)',
      description:
        'Six stages from dispensing to the release for packing: salt-to-base dispensing with a compensating excipient, split granulation in two sub-lots with fluid-bed drying to the LOD range and an optional extra-IPA branch, a case 2 reprocessing addition of milled rejects (at most 3 % and 90 days), blending, compression with left and right weight checks, the approval for coating, film coating to the weight gain, inspection with witnessed destruction and the release for packing. Reference batch 81.659 kg (2,00,000 tablets).',
      content: parsed(gbT01, 'gb-t-01'),
    },
  ].map((t) => [t.templateId, t]),
);

/** Number of steps (phases and hold points) of a content. */
export function stepCount(content: flow.MbrContent): number {
  return flow.numberMbr(content).totalSteps;
}
