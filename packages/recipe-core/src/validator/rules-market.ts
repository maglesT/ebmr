/**
 * Market-resolved content minima (outline 3.3.5, 6.3 "content minima for the market set"; IN-52).
 * The kernel market-profile engine resolves the rule keys for the MBR's market set through the
 * injected `MarketMinimaPort`; this rule checks the MBR against what came back. It fails closed:
 * no port, an unresolved key, a minimum nothing checks, or a bound key nothing in the MBR binds is
 * an error.
 */
import { compareDecimal, durationToMicros } from '../flow/decimal.ts';
import { childrenOf, type Edition, type FlowNode } from '../flow/model.ts';
import type { LimitSpec } from '../limits/model.ts';
import type { Analysis } from './analysis.ts';
import { defineRule, error, label, type Rule } from './rule-kit.ts';
import type { MinimaRequest, ResolvedMinimum, RuleFinding } from './types.ts';

/** Rule keys an MBR binds (what the market engine must resolve for it). */
export function boundRuleKeys(a: Pick<Analysis, 'mbr'>): string[] {
  const keys = new Set<string>();
  for (const p of a.mbr.parameters) if (p.marketRule) keys.add(p.marketRule.key);
  for (const t of a.mbr.timeConstraints) if (t.marketRule) keys.add(t.marketRule.key);
  for (const l of libraryLimits(a)) keys.add(l.rule.key);
  return [...keys].sort();
}

/**
 * Decision 0026 S9 (O-5): the limits of library steps that the formulation binds to a market rule (phase config
 * marketRules by limit slot), so a library limit looser than the registered value is refused like a parameter's.
 */
function libraryLimits(a: Pick<Analysis, 'mbr'>): { subject: string; slot: string; limits: LimitSpec; rule: { key: string; bound: 'LOW' | 'HIGH' } }[] {
  const out: { subject: string; slot: string; limits: LimitSpec; rule: { key: string; bound: 'LOW' | 'HIGH' } }[] = [];
  const visit = (n: FlowNode): void => {
    if (n.kind === 'phase' && n.block.type.startsWith('LIB-')) {
      const config = n.config as { marketRules?: Record<string, { key: string; bound: 'LOW' | 'HIGH' }>; limits?: Record<string, LimitSpec> };
      for (const [slot, rule] of Object.entries(config.marketRules ?? {})) {
        const limits = config.limits?.[slot];
        if (limits) out.push({ subject: n.id, slot, limits, rule });
      }
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(a.mbr.procedure.body);
  return out;
}

export function minimaRequest(a: Pick<Analysis, 'mbr' | 'ctx'>): MinimaRequest {
  const h = a.mbr.header;
  return { edition: h.edition, recordKind: h.recordKind, marketSet: [...h.marketSet], predicates: { ...h.predicates }, asOf: a.ctx.asOf, ruleKeys: boundRuleKeys(a) };
}

function checkLimit(a: Analysis, m: Extract<ResolvedMinimum, { kind: 'LIMIT' }>): RuleFinding[] {
  const out: RuleFinding[] = [];
  const governs = `${m.governingMarkets.join(', ')} (rule ${m.ruleKey}, table ${m.tableVersion})`;
  let bound = 0;
  for (const p of a.mbr.parameters) {
    if (p.marketRule?.key !== m.ruleKey) continue;
    bound++;
    if (p.marketRule.bound !== m.bound) {
      out.push(error(p.id, `${label(a, p.id)} binds ${m.ruleKey} as a ${p.marketRule.bound.toLowerCase()} bound, but the rule is a ${m.bound.toLowerCase()} bound`));
      continue;
    }
    if (!p.limits) {
      out.push(error(p.id, `${label(a, p.id)} has no limits, but ${governs} requires ${m.bound === 'HIGH' ? 'at most' : 'at least'} ${m.value} ${m.unit}`));
      continue;
    }
    const resolved = p.limits.unit === m.unit ? m.value : a.ctx.expressions.convert(m.value, m.unit, p.limits.unit);
    if (resolved === undefined) {
      out.push(error(p.id, `${label(a, p.id)} is in ${p.limits.unit}, which cannot be compared with ${m.ruleKey} in ${m.unit}`));
      continue;
    }
    for (const r of p.limits.ranges) {
      const b = m.bound === 'HIGH' ? r.high : r.low;
      const looser = !b || (m.bound === 'HIGH' ? compareDecimal(b.value, resolved) > 0 : compareDecimal(b.value, resolved) < 0);
      if (looser) {
        out.push(
          error(
            p.id,
            `The ${r.tier.toLowerCase().replace('_', ' ')} limit of ${label(a, p.id)} (${b ? b.value : 'none'} ${p.limits.unit}) is looser than ${m.bound === 'HIGH' ? 'the maximum' : 'the minimum'} of ${resolved} ${p.limits.unit} required by ${governs}`,
          ),
        );
      }
    }
  }
  for (const l of libraryLimits(a)) {
    if (l.rule.key !== m.ruleKey) continue;
    bound++;
    if (l.rule.bound !== m.bound) {
      out.push(error(l.subject, `${label(a, l.subject)} binds ${m.ruleKey} to ${l.slot} as a ${l.rule.bound.toLowerCase()} bound, but the rule is a ${m.bound.toLowerCase()} bound`));
      continue;
    }
    const resolved = l.limits.unit === m.unit ? m.value : a.ctx.expressions.convert(m.value, m.unit, l.limits.unit);
    if (resolved === undefined) {
      out.push(error(l.subject, `${label(a, l.subject)}: ${l.slot} is in ${l.limits.unit}, which cannot be compared with ${m.ruleKey} in ${m.unit}`));
      continue;
    }
    for (const r of l.limits.ranges) {
      const b = m.bound === 'HIGH' ? r.high : r.low;
      const looser = !b || (m.bound === 'HIGH' ? compareDecimal(b.value, resolved) > 0 : compareDecimal(b.value, resolved) < 0);
      if (looser) {
        out.push(error(l.subject, `The ${r.tier.toLowerCase().replace('_', ' ')} limit of ${label(a, l.subject)} for ${l.slot} (${b ? b.value : 'none'} ${l.limits.unit}) is looser than ${m.bound === 'HIGH' ? 'the maximum' : 'the minimum'} of ${resolved} ${l.limits.unit} required by ${governs} [PR-08; decision 0026 O-5]`));
      }
    }
  }
  for (const t of a.mbr.timeConstraints) {
    if (t.marketRule?.key !== m.ruleKey) continue;
    bound++;
    const q = m.bound === 'HIGH' ? t.max : t.min;
    const mine = q ? durationToMicros(q.value, q.unit) : undefined;
    const required = durationToMicros(m.value, m.unit);
    if (required === undefined) {
      out.push(error(t.id, `${m.ruleKey} resolved to ${m.value} ${m.unit}, which is not a duration`));
      continue;
    }
    if (mine === undefined || (m.bound === 'HIGH' ? mine > required : mine < required)) {
      out.push(error(t.id, `Time constraint ${label(a, t.id)} (${q ? `${q.value} ${q.unit}` : 'no limit'}) is looser than the ${m.bound === 'HIGH' ? 'maximum' : 'minimum'} of ${m.value} ${m.unit} required by ${governs}`));
    }
  }
  if (bound === 0) out.push(error('$', `The market set requires ${m.ruleKey} (${m.bound === 'HIGH' ? 'at most' : 'at least'} ${m.value} ${m.unit}, ${m.governingMarkets.join(', ')}), but no parameter or time constraint of the MBR is bound to it`));
  return out;
}

/** Builds the market rule; `covered` lists the content-minimum items some registered rule enforces. */
export function marketRule(covered: (edition: Edition) => ReadonlySet<string>): Rule {
  return defineRule('MKT-MINIMA', 'Content minima of the market set are met', ['PR-03', 'IN-52'], (a) => {
    if (!a.ctx.market) return [error('$', 'The content minima for the market set were not resolved (no market-profile engine was available); the MBR cannot pass until they are checked')];
    const out: RuleFinding[] = [];
    const minima = a.ctx.market.minima(minimaRequest(a));
    for (const m of minima) {
      if (m.kind === 'UNRESOLVED') out.push(error('$', `Market rule ${m.ruleKey} could not be resolved for this market set: ${m.problem}`));
      else if (m.kind === 'LIMIT') out.push(...checkLimit(a, m));
      else if (!covered(a.mbr.header.edition).has(m.item)) {
        out.push(error('$', `The market set (${m.governingMarkets.join(', ')}) requires content item ${m.item} (rule ${m.ruleKey}), which no rule of this validator version checks`));
      }
    }
    return out;
  });
}
