/**
 * The step palette of the designer (module C2; plan section 8): what an author may insert into a sequence, from
 * the recipe-core block registry (executable versions, their configuration schemas and availability) joined with
 * the validator's catalogue (roles, significant flag). Plain names first.
 *
 * Offered: phase blocks the catalogue allows as steps, and the QA hold point (G-17). Hidden: the batch, stage,
 * construct and service blocks (G-01, G-02, G-18, G-19: they are not steps). SANDBOX_ONLY versions (G-09@1, G-10@1)
 * are badged: a GMP batch refuses them (ENG-DEF-SANDBOX-ONLY); their database-backed versions (@2) are offered beside them.
 *
 * Slice 7j (R4, D-7j-7): the palette is the Tablets edition's registry: every generic block, G-06 (device readings) and
 * G-21 (labels and printing) included since their interfaces exist, and every tablet block TB-01 to TB-24 with its
 * configuration schema, so a master can be built without a template.
 *
 * Decision 0026 O-6 (after S11 passed): a new product's own steps are library blocks, so the tablet blocks TB-01 to
 * TB-24 are no longer offered for a new step (`insertable` false, badged). They stay described, with their schemas, so
 * existing masters and copies of them keep their steps' configuration forms; their batches run as before. Nothing is
 * deleted.
 */
import type { PaletteBlock } from './wire.ts';
import type { flow } from '@ebmr/recipe-core/pure';
import { blocks } from '@ebmr/recipe-core/pure';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../edition-blocks.ts';

const HIDDEN = new Set<string>();

/** Decision 0026 O-6: a block an author no longer inserts (the tablet blocks; the library replaces them). */
export const retiredFromPalette = (type: string): boolean => /^TB-\d{2}$/.test(type);
export const RETIRED_BADGE = 'existing masters only (library replaces it)';
/** D-4: the library block that replaces a retired tablet block, where the catalogue has one (decision 0026 O-6). */
export const LIBRARY_REPLACEMENT: Readonly<Record<string, string>> = { 'TB-04': 'PROC-RMG', 'TB-05': 'PROC-FBD', 'TB-18': 'COAT- blocks' };
/** The badge of a retired block: naming its library replacement when there is one. */
export const retiredBadge = (type: string): string => (LIBRARY_REPLACEMENT[type] ? `existing masters only (use the library's ${LIBRARY_REPLACEMENT[type]})` : RETIRED_BADGE);

/** Plain names an author recognises from a paper batch record. */
export const PLAIN_NAMES: Readonly<Record<string, string>> = {
  'G-03': 'Instruction to read or confirm',
  'G-04': 'Record process parameters',
  'G-05': 'Record an observation',
  'G-07': 'Weigh and dispense',
  'G-08': 'Charge materials into equipment',
  'G-09': 'Check equipment status',
  'G-10': 'Clear the room or line',
  'G-11': 'Check room conditions',
  'G-12': 'Take samples',
  'G-13': 'In-process checks',
  'G-14': 'Calculate',
  'G-15': 'Timer, hold time or transfer',
  'G-16': 'Second-person check',
  'G-17': 'QA hold point',
  'G-20': 'Yield or reconciliation',
  'G-22': 'Output containers',
  'G-23': 'Returns, rejects or destruction',
  'G-24': 'Reprocessing or rework gate',
};

type Json = null | boolean | string | number | Json[] | { [k: string]: Json };

/** A block schema as plain JSON (patterns as their source text). */
export function schemaJson(schema: blocks.FieldSchema): { [k: string]: Json } {
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(schema)) {
    if (v === undefined) continue;
    if (v instanceof RegExp) out[k] = v.source;
    else if (k === 'fields' || k === 'values' || k === 'items') {
      if (k === 'fields') out[k] = Object.fromEntries(Object.entries(v as Record<string, blocks.FieldSchema>).map(([f, s]) => [f, schemaJson(s)]));
      else out[k] = schemaJson(v as blocks.FieldSchema);
    } else out[k] = v as Json;
  }
  return out;
}

/** The smallest configuration the schema accepts: required fields only, with neutral values. */
export function defaultConfig(schema: blocks.FieldSchema): Json {
  switch (schema.type) {
    case 'object': {
      const out: { [k: string]: Json } = {};
      for (const [k, f] of Object.entries(schema.fields)) if (!f.optional) out[k] = defaultConfig(f);
      return out;
    }
    case 'string':
      return schema.enum?.[0] ?? '';
    case 'decimal':
      return schema.min ?? '0';
    case 'integer':
      return schema.min ?? 0;
    case 'boolean':
      return false;
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () => defaultConfig(schema.items));
    case 'record':
      return {};
  }
}

export function paletteBlocks(registry: blocks.BlockRegistry = tabletsBlockRegistry(), catalog: flow.BlockCatalog = tabletsBlockCatalog): PaletteBlock[] {
  const out: PaletteBlock[] = [];
  for (const b of registry.all()) {
    if (HIDDEN.has(b.type)) continue;
    const d = catalog.describe(b.type);
    const insertable = b.level === 'HOLD_POINT' || (b.level === 'PHASE' && d?.phase.allowed === true);
    if (!insertable) continue;
    const availability = b.availability ?? 'ALL';
    const schema = b.configSchema ?? { type: 'object' as const, description: 'No configuration', fields: {} };
    out.push({
      key: blocks.blockKey(b.type, b.version),
      type: b.type,
      version: b.version,
      title: b.title,
      plainName: PLAIN_NAMES[b.type] ?? b.title,
      level: b.level,
      roles: [...(d?.roles ?? [])],
      significant: d?.significant ?? false,
      availability,
      badge: retiredFromPalette(b.type) ? retiredBadge(b.type) : availability === 'SANDBOX_ONLY' ? 'sandbox only' : null,
      insertable: !retiredFromPalette(b.type),
      configSchema: schemaJson(schema),
      defaultConfig: b.level === 'HOLD_POINT' ? {} : (defaultConfig(schema) as Record<string, Json>),
      controls: [...b.controls],
    });
  }
  return out;
}
