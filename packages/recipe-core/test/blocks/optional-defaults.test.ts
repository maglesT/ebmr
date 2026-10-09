/**
 * What an absent optional yes/no member of a block configuration means (review F52; PR-02, PR-03). Every optional
 * boolean of every registered configuration schema declares it (`default`, or `defaultText` when it depends on where
 * the step stands), and the block handlers apply exactly that when the member is absent, so the designer can show the
 * effective value and record an explicit "no". The declaration is not part of the registry fingerprint (batches issued
 * before it still run, ADR 0010).
 */
import { describe, expect, it } from 'vitest';
import type { BlockVersion, FieldSchema, HandlerView } from '../../src/blocks/contract.ts';
import { genericBlockRegistry } from '../../src/blocks/generic/index.ts';
import { BlockRegistry } from '../../src/blocks/registry.ts';

type View = HandlerView;

function block(type: string): BlockVersion {
  const b = genericBlockRegistry().get(type, '1');
  if (!b) throw new Error(`no block ${type}`);
  return b;
}

function handler(type: string): NonNullable<BlockVersion['handler']> {
  const h = block(type).handler;
  if (!h) throw new Error(`no handler for ${type}`);
  return h;
}

/** Every optional boolean of a schema, with its path. */
function optionalBooleans(schema: FieldSchema, path: string): { path: string; schema: Extract<FieldSchema, { type: 'boolean' }> }[] {
  if (schema.type === 'boolean') return schema.optional === true ? [{ path, schema }] : [];
  if (schema.type === 'object') return Object.entries(schema.fields).flatMap(([k, f]) => optionalBooleans(f, `${path}.${k}`));
  if (schema.type === 'array') return optionalBooleans(schema.items, `${path}[]`);
  if (schema.type === 'record') return optionalBooleans(schema.values, `${path}.*`);
  return [];
}

describe('optional yes/no members of block configurations (review F52)', () => {
  it('[PR-02][PR-03] every optional boolean of every registered configuration schema declares what its absence means, one way only', () => {
    const declared: Record<string, string> = {};
    for (const b of genericBlockRegistry().all()) {
      if (!b.configSchema) continue;
      for (const f of optionalBooleans(b.configSchema, `${b.type}@${b.version}`)) {
        const hasDefault = f.schema.default !== undefined;
        const hasText = f.schema.defaultText !== undefined && f.schema.defaultText.trim() !== '';
        expect(hasDefault !== hasText, `${f.path} declares exactly one of default and defaultText`).toBe(true);
        declared[f.path] = hasDefault ? String(f.schema.default) : `"${f.schema.defaultText ?? ''}"`;
      }
    }
    // The members whose absence means yes: they are the ones an unticked box used to misstate.
    expect(Object.fromEntries(Object.entries(declared).filter(([, v]) => v !== 'false'))).toEqual({
      'G-05@1.blockOnUnexpected': 'true',
      'G-08@1.chargeAll': '"yes outside a sub-lot section, no inside one"',
      'G-14@1.showFormula': 'true',
      'G-23@1.witness': 'true',
    });
  });

  it('[PR-02] G-05: an absent blockOnUnexpected blocks the steps after an unexpected answer (declared default yes); only an explicit no does not', () => {
    expect(block('G-05').configSchema?.fields['blockOnUnexpected']).toMatchObject({ type: 'boolean', default: true });
    const view = (config: Record<string, unknown>) => ({ config, parameter: () => ({ id: 'check', valueType: 'CATEGORY', categories: ['CONFIRMED', 'NOT_CONFIRMED'] }) }) as unknown as View;
    const blocks = (config: Record<string, unknown>) => {
      const out = handler('G-05').onValue?.(view(config), 'check', { kind: 'CATEGORY', value: 'NOT_CONFIRMED' } as never, {} as never) as { exceptions?: { blocks: string }[] };
      return out.exceptions?.[0]?.blocks;
    };
    expect(blocks({})).toBe('DOWNSTREAM');
    expect(blocks({ blockOnUnexpected: true })).toBe('DOWNSTREAM');
    expect(blocks({ blockOnUnexpected: false })).toBe('NONE');
  });

  it('[PR-02] G-23: an absent witness refuses a destruction on a step that is not witnessed (declared default yes); only an explicit no accepts it', () => {
    expect(block('G-23').configSchema?.fields['witness']).toMatchObject({ type: 'boolean', default: true });
    const view = (config: Record<string, unknown>) => ({ config, phase: { id: 'p', signatures: { check: { meaning: 'VERIFIED' } } } }) as unknown as View;
    const entry = { kind: 'DISPOSAL', category: 'DESTRUCTION', material: 'Carton', quantity: { value: '1', unit: '1' }, method: 'Shredding' };
    const accept = (config: Record<string, unknown>) => handler('G-23').acceptEntry?.(view(config), entry) as { ok: boolean; problems?: { code: string }[] };
    expect(accept({})).toMatchObject({ ok: false, problems: [{ code: 'G23-WITNESS' }] });
    expect(accept({ witness: true })).toMatchObject({ ok: false, problems: [{ code: 'G23-WITNESS' }] });
    expect(accept({ witness: false }).ok).toBe(true);
  });

  it('[PR-02] G-08: an absent chargeAll requires every container outside a sub-lot section and not inside one (as declared); an explicit value applies in both', () => {
    const containers = [
      { id: 'C1', holds: 'GRAN', holdsKind: 'INTERMEDIATE', status: 'CONSUMED' },
      { id: 'C2', holds: 'GRAN', holdsKind: 'INTERMEDIATE', status: 'OPEN' },
    ];
    const view = (config: Record<string, unknown>, subLot: unknown) =>
      ({ config, subLot, phase: { id: 'p', uses: ['GRAN'], consumes: [] }, containers: () => containers, entries: (k: string) => (k === 'CHARGE_CONTAINER' ? [{ data: { container: 'C1' } }] : []) }) as unknown as View;
    const codes = (config: Record<string, unknown>, subLot: unknown) => (handler('G-08').beforePerform?.(view(config, subLot)) ?? []).map((p) => p.code);
    const SUB_LOT = { construct: 'R-SUBLOT', index: 1 };
    expect(codes({}, undefined)).toEqual(['G08-MISSING-CONTAINER']);
    expect(codes({}, SUB_LOT)).toEqual([]);
    expect(codes({ chargeAll: true }, SUB_LOT)).toEqual(['G08-MISSING-CONTAINER']);
    expect(codes({ chargeAll: false }, undefined)).toEqual([]);
  });

  it('[PR-02] G-15: an absent transfer records no transfer (declared default no); only an explicit yes requires issued-by and received-by', () => {
    expect(block('G-15').configSchema?.fields['transfer']).toMatchObject({ type: 'boolean', default: false });
    const view = (config: Record<string, unknown>) => ({ config, entries: () => [] }) as unknown as View;
    const codes = (config: Record<string, unknown>) => (handler('G-15').beforePerform?.(view(config)) ?? []).map((p) => p.code);
    expect(codes({})).toEqual([]);
    expect(codes({ transfer: true })).toEqual(['G15-TRANSFER']);
  });

  it('[PR-02] skippable is declared default no: an absent member refuses a skip (engine: test/engine/exceptions.test.ts, ENG-SKIP-FORBIDDEN)', () => {
    for (const b of genericBlockRegistry().all()) {
      const f = b.configSchema?.fields['skippable'];
      if (f) expect(f, `${b.type}@${b.version}`).toMatchObject({ type: 'boolean', optional: true, default: false });
    }
  });

  it('[PR-02] the declarations leave the registry fingerprint as it was (batches issued before them still run; ADR 0010)', () => {
    const r = genericBlockRegistry();
    const stripped = r.all().map((b) => {
      if (!b.configSchema) return b;
      const strip = (s: FieldSchema): FieldSchema => {
        if (s.type === 'boolean') return { type: 'boolean', description: s.description, ...(s.optional !== undefined ? { optional: s.optional } : {}) };
        if (s.type === 'object') return { ...s, fields: Object.fromEntries(Object.entries(s.fields).map(([k, f]) => [k, strip(f)])) };
        return s;
      };
      return { ...b, configSchema: strip(b.configSchema) as typeof b.configSchema };
    });
    expect(new BlockRegistry(stripped).fingerprint()).toBe(r.fingerprint());
  });
});
