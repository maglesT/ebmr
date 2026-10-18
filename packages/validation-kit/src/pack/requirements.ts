/**
 * The user requirements specification and the risk assessment (Phase 7 slice 7c; IN-12, DI-03, DI-06).
 *
 * URS: one user requirement per control (UR-<control id>), written from the control's paraphrased behaviour, with its
 * sources as citations, its type and editions, and the requirement rows (n-numbers) it is built from. A draft control
 * (status U) and every control whose expert decision is PENDING is marked so.
 * Risk assessment: per requirement the harm, severity, probability, detectability, risk class and test rigour, from
 * the fixed rules of ./facts.ts (printed first, so the customer can review them).
 */
import type { Bundle } from '../bundle/types.ts';
import { heading, list, para, table, type Doc } from './doc.ts';
import { assessRisk, isDeferred, RISK_RULES, urOf, verdicts } from './facts.ts';

export function urs(b: Bundle): Doc {
  const rows = new Map(b.register.requirements.map((r) => [r.n, r]));
  const blocks: Doc['blocks'] = [
    para(
      `The user requirements of ${b.release.product} ${b.release.version} (${b.edition} edition): one requirement per control of the control register, written from the control's paraphrased behaviour. Regulations are paraphrased, never quoted; the sources are citations. A requirement marked DRAFT comes from a control whose regulatory text is not yet checked; PENDING means the expert's decision on the control is not yet recorded.`,
    ),
    table(
      ['Requirement', 'Control', 'Title', 'Type', 'Editions', 'Class', 'Expert decision', 'Marks'],
      b.register.controls.map((c) => [
        urOf(c.id),
        c.id,
        c.title,
        c.type.join(', '),
        c.editions.join(', '),
        c.class,
        c.expertDecision.status,
        [c.draft ? 'DRAFT' : null, c.expertDecision.status === 'PENDING' ? 'PENDING' : null, isDeferred(c) ? 'PART DEFERRED' : null].filter(Boolean).join(' ') || '-',
      ]),
    ),
  ];
  for (const c of b.register.controls) {
    blocks.push(heading(`${urOf(c.id)}: ${c.title}${c.draft ? ' (DRAFT)' : ''}${c.expertDecision.status === 'PENDING' ? ' (PENDING)' : ''}`, 3));
    blocks.push(para(c.behaviour));
    blocks.push(list([`Acceptance (catalog test): ${c.catalogTest}`, `Sources: ${c.sources}`, `Target phase: ${String(c.targetPhase)}; build status: ${c.buildStatus}`]));
    const req = c.requirementRows.map((n) => rows.get(n)).filter((r) => r !== undefined);
    if (req.length > 0) {
      blocks.push(table(['Row', 'Source', 'Verification', 'Paraphrase'], req.map((r) => [`n${String(r.n)}`, r.source, r.verification, r.paraphrase])));
    }
  }
  return { id: 'urs', title: 'User requirements specification', status: b.register.controls.some((c) => c.draft) ? 'DRAFT' : 'RELEASED', blocks };
}

export function riskAssessment(b: Bundle): Doc {
  const v = verdicts(b);
  const risks = b.register.controls.map((c) => assessRisk(c, v));
  const count = (k: 'high' | 'medium' | 'low') => String(risks.filter((r) => r.riskClass === k).length);
  return {
    id: 'risk-assessment',
    title: 'Risk assessment (in the manner of ICH Q9(R1))',
    status: 'RELEASED',
    blocks: [
      para('Each user requirement is assessed with fixed rules, so the same register always gives the same assessment. The rules:'),
      list([...RISK_RULES], true),
      heading('Summary'),
      table(['Risk class', 'Requirements'], [['high', count('high')], ['medium', count('medium')], ['low', count('low')]]),
      heading('Per requirement'),
      table(
        ['Requirement', 'Harm', 'Severity', 'Probability', 'Detectability', 'Database-enforced', 'Risk class', 'Test rigour'],
        risks.map((r) => [urOf(r.control), r.harm, r.severity, r.probability, r.detectability, r.databaseEnforced ? 'yes' : 'no', r.riskClass, r.rigour]),
      ),
    ],
  };
}
