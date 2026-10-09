/**
 * Helpers shared by the rule files.
 */
import type { FlowNode } from '../flow/model.ts';
import type { Analysis } from './analysis.ts';
import type { RuleEdition, RuleFinding, ValidationRule } from './types.ts';

export type Rule = ValidationRule<Analysis> & {
  /** Content-minimum items (market hook) this rule enforces, so the hook knows they are covered. */
  covers?: readonly string[];
};

export function defineRule(
  id: string,
  title: string,
  controls: readonly string[],
  check: (a: Analysis) => RuleFinding[],
  options: { edition?: RuleEdition; covers?: readonly string[] } = {},
): Rule {
  const rule: Rule = { id, title, controls, edition: options.edition ?? 'generic', check };
  if (options.covers) rule.covers = options.covers;
  return rule;
}

export const error = (subject: string, text: string): RuleFinding => ({ severity: 'ERROR', subject, text });
export const warning = (subject: string, text: string): RuleFinding => ({ severity: 'WARNING', subject, text });

/** "Name" (id) of a tree node or item for messages. */
export function label(a: Analysis, id: string): string {
  const info = a.nodes.get(id);
  if (info) {
    const n: FlowNode = info.node;
    const name = 'name' in n && typeof n.name === 'string' ? n.name : undefined;
    return name ? `"${name}" (${id})` : id;
  }
  const item = a.parameters.get(id) ?? a.calculations.get(id) ?? a.inputs.get(id) ?? a.intermediates.get(id) ?? a.yields.get(id) ?? a.timeConstraints.get(id);
  if (item && 'name' in item) return `"${item.name}" (${id})`;
  return id;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
