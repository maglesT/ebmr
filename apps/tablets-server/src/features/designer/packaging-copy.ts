/**
 * A packaging master for a product as a copy of an approved packaging master of another product (Phase 7 slice 7o; R4,
 * R8; decision D-7o-3). The pack (pack type, packaging batch sizes, line, blocks and their settings) is the source's; the
 * header names the new product (its name and dosage form from the product master in effect); and every printed packaging
 * item of the source's printed-materials steps (G-21) is replaced by the new product's own printed material and artwork
 * version, for each market of the copy, wherever the source names the old material (a TB-21 web, the bill of
 * materials). A printed item left with another product's material is refused: a pack never carries another product's
 * print. The new materials are pinned as the formula start pins its materials (material-refs.ts). No JavaScript number
 * holds a quantity.
 */
import { flow as flowNs, type flow } from '@ebmr/recipe-core/pure';
import { FamilyInputError, KNOWN_MARKETS } from './family.ts';
import { materialReference, type MaterialMaster } from './material-refs.ts';

type Json = Record<string, unknown>;

export interface PrintedReplacement {
  /** The G-21 item id of the source (e.g. FOIL, CARTON). */
  item: string;
  /** The new product's printed packaging material (its code in the material master). */
  material: string;
  /** The artwork version that material is printed with, for every market of the copy. */
  artwork: string;
}

export interface PackagingCopyRequest {
  familyCode: string;
  markets: string[];
  product: { code: string; strength: string; name: string; dosageForm: string };
  printed: readonly PrintedReplacement[];
}

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function walk(n: unknown, visit: (o: Json) => void): void {
  if (Array.isArray(n)) for (const x of n) walk(x, visit);
  else if (isRecord(n)) {
    visit(n);
    for (const v of Object.values(n)) walk(v, visit);
  }
}

/** Every string equal to `from` inside `n` replaced by `to` (a material code in a block's settings). */
function replaceValue(n: unknown, from: string, to: string): unknown {
  if (n === from) return to;
  if (Array.isArray(n)) return n.map((x) => replaceValue(x, from, to));
  if (isRecord(n)) return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, replaceValue(v, from, to)]));
  return n;
}

/** The printed items of the source's G-21 steps: item id and material. */
export function printedItems(source: flow.MbrContent): { item: string; material: string }[] {
  const out: { item: string; material: string }[] = [];
  walk(source.procedure, (o) => {
    if (o['kind'] === 'phase' && isRecord(o['block']) && o['block']['type'] === 'G-21' && isRecord(o['config']) && Array.isArray(o['config']['items'])) {
      for (const i of o['config']['items'] as unknown[]) if (isRecord(i) && typeof i['id'] === 'string' && typeof i['material'] === 'string') out.push({ item: i['id'], material: i['material'] });
    }
  });
  return out;
}

export function packagingCopy(source: flow.MbrContent, req: PackagingCopyRequest, materials: readonly MaterialMaster[]): flow.MbrContent {
  if (source.header.recordKind !== 'PACKAGING') throw new FamilyInputError('DESIGNER_COPY_PACKAGING', 'Choose an approved packaging master to copy.', ['PR-01']);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(req.familyCode)) {
    throw new FamilyInputError('DESIGNER_FAMILY_CODE', 'A family code is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.', ['PR-01']);
  }
  const markets = req.markets.includes('IN') ? req.markets : ['IN', ...req.markets];
  const unknown = markets.filter((m) => !(KNOWN_MARKETS as readonly string[]).includes(m));
  if (unknown.length > 0) throw new FamilyInputError('DESIGNER_MARKETS', `Unknown market ${unknown.join(', ')}; the markets are ${KNOWN_MARKETS.join(', ')}.`, ['IN-52']);
  if (source.header.product.code === req.product.code && source.header.product.strength === req.product.strength) {
    throw new FamilyInputError('DESIGNER_COPY_PACKAGING', 'The copy is for another product; a new version of the same product\'s packaging master is made from that master.', ['PR-06']);
  }
  const items = printedItems(source);
  const byItem = new Map(req.printed.map((p) => [p.item, p]));
  const missing = items.filter((i) => !byItem.has(i.item)).map((i) => i.item);
  if (missing.length > 0) {
    throw new FamilyInputError('DESIGNER_PRINTED_ITEMS', `Name the product's own printed material and artwork version for ${missing.join(', ')}: a pack never carries another product's print.`, ['PR-32', 'IN-38']);
  }
  const extra = req.printed.filter((p) => !items.some((i) => i.item === p.item)).map((p) => p.item);
  if (extra.length > 0) throw new FamilyInputError('DESIGNER_PRINTED_ITEMS', `The master has no printed item ${extra.join(', ')}.`, ['PR-32']);
  for (const p of req.printed) {
    if (!/^[!-~]{1,64}$/.test(p.artwork)) throw new FamilyInputError('DESIGNER_PRINTED_ITEMS', `The artwork version of ${p.item} is printable text of 1 to 64 characters without spaces.`, ['PR-32']);
    // A replacement equal to a source item's material would leave that product's print on the new pack (P7O-1).
    const sourceOwn = items.find((i) => i.item === p.item)?.material;
    if (p.material === sourceOwn) throw new FamilyInputError('DESIGNER_PRINTED_ITEMS', `Material ${p.material} is the source's own printed material for ${p.item}: name the new product's own, a pack never carries another product's print.`, ['PR-32', 'IN-38']);
    const otherItem = items.find((i) => i.material === p.material);
    if (otherItem) throw new FamilyInputError('DESIGNER_PRINTED_ITEMS', `Material ${p.material} is the source's printed material for ${otherItem.item}, another product's print: name the new product's own for ${p.item}.`, ['PR-32', 'IN-38']);
    const m = materials.find((x) => x.code === p.material);
    if (!m) throw new FamilyInputError('DESIGNER_PRINTED_ITEMS', `Material ${p.material} is not in the material master in effect.`, ['PR-32']);
    if (m.kind !== 'PRINTED_PACKAGING') throw new FamilyInputError('DESIGNER_PRINTED_ITEMS', `Material ${p.material} is ${m.kind}, not printed packaging.`, ['PR-32']);
  }
  let t = structuredClone(source) as unknown as Json;
  // The printed items: the new material and its artwork version for every market of the copy.
  walk(t['procedure'], (o) => {
    if (o['kind'] === 'phase' && isRecord(o['block']) && o['block']['type'] === 'G-21' && isRecord(o['config']) && Array.isArray(o['config']['items'])) {
      for (const i of o['config']['items'] as Json[]) {
        const p = byItem.get(String(i['id']));
        if (p) Object.assign(i, { material: p.material, artwork: Object.fromEntries(markets.map((mk) => [mk, p.artwork])) });
      }
    }
  });
  // Wherever else the source names an old printed material (a TB-21 web, a bill-of-materials line), the new one.
  for (const i of items) {
    const to = byItem.get(i.item)?.material ?? i.material;
    t['procedure'] = replaceValue(t['procedure'], i.material, to);
    t['bom'] = replaceValue(t['bom'], i.material, to);
  }
  const old = new Set(items.map((i) => i.material));
  const refs = (t['references'] as Json[]).filter((r) => !(r['kind'] === 'MATERIAL' && old.has(String(r['id']))));
  for (const p of req.printed) {
    const m = materials.find((x) => x.code === p.material);
    if (m && !refs.some((r) => r['id'] === m.code)) refs.push(materialReference(m) as unknown as Json);
  }
  t['references'] = refs;
  const header = t['header'] as Json;
  t['header'] = {
    ...header,
    family: req.familyCode,
    title: `${req.product.name} ${req.product.strength}: ${typeof header['packType'] === 'string' ? header['packType'] : 'pack'} packaging order (a copy of packaging master ${source.header.family})`,
    product: { code: req.product.code, name: req.product.name, strength: req.product.strength, dosageForm: req.product.dosageForm },
    marketSet: KNOWN_MARKETS.filter((m) => markets.includes(m)),
  };
  t = JSON.parse(JSON.stringify(t)) as Json;
  const parsed = flowNs.parseMbr(t);
  if (!parsed.ok) throw new FamilyInputError('DESIGNER_COPY_PACKAGING', `The copy is not well formed: ${parsed.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`, ['PR-01']);
  return parsed.mbr;
}
