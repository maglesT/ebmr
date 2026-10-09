/**
 * A new MBR family and its first DRAFT content from a template (module C2; PR-01 discrete batch sizes; INV-28).
 *
 * The author names the family code, the product (code, name, strength), the discrete batch sizes and the market
 * set. The rules (all refusals are plain language, nothing is added silently):
 *  - India (IN) must be in the market set (INV-28); markets are two-letter codes the market engine knows, once each;
 *  - batch sizes are discrete, positive decimal masses (kg or g), each listed once (PR-01: a batch can later be
 *    made only at one of these sizes; there is no free scaling at batch creation);
 *  - a size equal to one of the template's keeps the template's id; any other gets an id from its value and unit;
 *  - the first size is the reference batch size: the BOM's standard quantities are scaled exactly from the
 *    template's reference size to it and written to the template's decimals (half up). The formula itself (per
 *    tablet quantities, targets, limits) is the template's and the author edits it in the designer;
 *  - the dosage form, edition, record kind, predicates and variants are the template's.
 * No JavaScript number ever holds a quantity: everything is scaled bigint arithmetic on decimal strings.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { flow as flowNs } from '@ebmr/recipe-core/pure';
import { EXPRESSIONS } from './adapters/expressions.ts';
import type { MbrTemplate } from './templates/index.ts';

export const KNOWN_MARKETS = ['IN', 'US', 'EU'] as const;
const MASS_UNITS = ['kg', 'g'] as const;

export class FamilyInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly controls: string[] = [],
  ) {
    super(message);
    this.name = 'FamilyInputError';
  }
}

export interface FamilyRequest {
  familyCode: string;
  product: { code: string; name: string; strength: string };
  batchSizes: { quantity: string; unit: string }[];
  markets: string[];
}

/** q * num / den, rounded half up (away from zero for halves) to `decimals` places; exact bigint arithmetic. */
export function scaleDecimal(q: string, num: string, den: string, decimals: number): string {
  const a = flowNs.parseDecimal(q);
  const n = flowNs.parseDecimal(num);
  const d = flowNs.parseDecimal(den);
  if (d.digits === 0n) throw new RangeError('division by zero');
  // value = (a.digits / 10^a.scale) * (n.digits / 10^n.scale) / (d.digits / 10^d.scale)
  let top = a.digits * n.digits * 10n ** BigInt(d.scale) * 10n ** BigInt(decimals);
  let bottom = d.digits * 10n ** BigInt(a.scale + n.scale);
  if (bottom < 0n) {
    top = -top;
    bottom = -bottom;
  }
  const negative = top < 0n;
  const abs = negative ? -top : top;
  let quotient = abs / bottom;
  if ((abs % bottom) * 2n >= bottom) quotient += 1n;
  let text = quotient.toString();
  if (decimals > 0) {
    text = text.padStart(decimals + 1, '0');
    text = `${text.slice(0, text.length - decimals)}.${text.slice(text.length - decimals)}`;
  }
  return negative && quotient !== 0n ? `-${text}` : text;
}

function sizeId(value: string, unit: string): string {
  return `BS-${flowNs.canonicalDecimal(value)}${unit.toUpperCase()}`;
}

/** The value of a mass in the template's unit (exact), or undefined when the unit is not a mass unit. */
function inUnit(value: string, from: string, to: string): string | undefined {
  if (from === to) return value;
  if (!(MASS_UNITS as readonly string[]).includes(from)) return undefined;
  return EXPRESSIONS.convert(value, from, to);
}

/** The DRAFT content of a new family made from `template` (throws FamilyInputError with a plain message). */
export function contentFromTemplate(template: MbrTemplate, req: FamilyRequest): flow.MbrContent {
  const content = structuredClone(template.content);
  const h = content.header;

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(req.familyCode)) {
    throw new FamilyInputError('DESIGNER_FAMILY_CODE', 'A family code is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.', ['PR-01']);
  }
  for (const [what, v] of [
    ['product code', req.product.code],
    ['product name', req.product.name],
    ['strength', req.product.strength],
  ] as const) {
    if (v.trim() === '' || v !== v.trim() || v.length > 200) throw new FamilyInputError('DESIGNER_PRODUCT', `The ${what} must be filled in, without leading or trailing spaces (at most 200 characters).`, ['PR-01']);
  }

  // Markets (INV-28: India always; never added silently).
  if (new Set(req.markets).size !== req.markets.length) throw new FamilyInputError('DESIGNER_MARKETS', 'A market is listed twice.', ['IN-52']);
  const unknown = req.markets.filter((m) => !(KNOWN_MARKETS as readonly string[]).includes(m));
  if (unknown.length > 0) throw new FamilyInputError('DESIGNER_MARKETS', `Unknown market ${unknown.join(', ')}; the markets are ${KNOWN_MARKETS.join(', ')}.`, ['IN-52']);
  if (!req.markets.includes('IN')) {
    throw new FamilyInputError('DESIGNER_MARKETS', 'India (IN) must be in every market set: every batch is made under an Indian licence, so Revised Schedule M always applies.', ['INV-28', 'IN-52']);
  }
  const markets = ['IN', ...KNOWN_MARKETS.filter((m) => m !== 'IN' && req.markets.includes(m))];

  // Discrete batch sizes (PR-01).
  const templateRef = h.batchSizes[0];
  if (!templateRef) throw new Error('the template lists no batch size');
  const refUnit = templateRef.quantity.unit;
  if (req.batchSizes.length === 0) throw new FamilyInputError('DESIGNER_BATCH_SIZE', 'List at least one approved batch size.', ['PR-01']);
  const seen = new Set<string>();
  const sizes: flow.MbrHeader['batchSizes'] = [];
  for (const s of req.batchSizes) {
    if (!flowNs.isDecimalLiteral(s.quantity) || flowNs.compareDecimal(s.quantity, '0') <= 0) {
      throw new FamilyInputError('DESIGNER_BATCH_SIZE', `Batch size ${s.quantity} ${s.unit} is not a positive decimal quantity.`, ['PR-01']);
    }
    const inRef = inUnit(s.quantity, s.unit, refUnit);
    if (inRef === undefined) throw new FamilyInputError('DESIGNER_BATCH_SIZE', `Batch size unit ${s.unit} is not a mass unit (kg or g).`, ['PR-01']);
    const key = flowNs.canonicalDecimal(inRef);
    if (seen.has(key)) throw new FamilyInputError('DESIGNER_BATCH_SIZE', `Batch size ${s.quantity} ${s.unit} is listed twice.`, ['PR-01']);
    seen.add(key);
    const same = h.batchSizes.find((t) => t.quantity.unit === s.unit && flowNs.compareDecimal(t.quantity.value, s.quantity) === 0);
    const id = same ? same.id : sizeId(s.quantity, s.unit);
    if (sizes.some((x) => x.id === id)) throw new FamilyInputError('DESIGNER_BATCH_SIZE', `Batch size ${s.quantity} ${s.unit} is listed twice.`, ['PR-01']);
    sizes.push({ id, quantity: { value: s.quantity, unit: s.unit } });
  }
  const first = sizes[0] as (typeof sizes)[number];
  const newRef = inUnit(first.quantity.value, first.quantity.unit, refUnit) as string;
  if (flowNs.compareDecimal(newRef, templateRef.quantity.value) !== 0) {
    for (const b of content.bom) {
      b.quantity = { value: scaleDecimal(b.quantity.value, newRef, templateRef.quantity.value, flowNs.decimalsOf(b.quantity.value)), unit: b.quantity.unit };
    }
  }

  h.family = req.familyCode;
  h.product = { code: req.product.code, name: req.product.name, strength: req.product.strength, dosageForm: h.product.dosageForm };
  const colon = h.title.indexOf(': ');
  h.title = `${req.product.name} ${req.product.strength}: ${colon >= 0 ? h.title.slice(colon + 2) : h.title}`;
  h.batchSizes = sizes;
  h.marketSet = markets;
  const check = flowNs.parseMbr(JSON.parse(JSON.stringify(content)));
  if (!check.ok) throw new FamilyInputError('DESIGNER_CONTENT', `The new content does not parse: ${check.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`, ['PR-03']);
  return check.mbr;
}
