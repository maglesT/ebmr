/**
 * D-5 (owner's MGL-SR-BL report, item 13): the author names an intermediate, so a skeleton's "Final blend" or a copied
 * source's "Printed tablets" does not survive into the product. The id never changes; a refusal leaves the content as it
 * was; undo restores the name.
 */
import { describe, expect, it } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import { applyOp, initHistory, OpError, perform, undo, type Content } from '../../src/features/designer/model/ops.ts';

function base(): Content {
  const r = flow.parseMbr(granulation);
  if (!r.ok) throw new Error('fixture does not parse');
  return r.mbr;
}

describe('D-5: the author names an intermediate', () => {
  it('[PR-03] an intermediate takes a new name (trimmed), its id and every step that produces or uses it unchanged; an unknown id or an empty name is refused; undo restores', () => {
    const before = JSON.stringify(base());
    const c = applyOp(base(), { kind: 'UPDATE_INTERMEDIATE_NAME', intermediateId: 'I-BLEND', name: ' Lubricated bilayer blend, layer 1 ' });
    expect(c.intermediates.find((i) => i.id === 'I-BLEND')?.name).toBe('Lubricated bilayer blend, layer 1');
    expect(c.intermediates.map((i) => i.id)).toEqual(base().intermediates.map((i) => i.id));
    expect(JSON.stringify(c.procedure)).toBe(JSON.stringify(base().procedure));
    expect(() => applyOp(base(), { kind: 'UPDATE_INTERMEDIATE_NAME', intermediateId: 'I-NONE', name: 'x' })).toThrow(OpError);
    expect(() => applyOp(base(), { kind: 'UPDATE_INTERMEDIATE_NAME', intermediateId: 'I-BLEND', name: '   ' })).toThrow(/cannot be empty/);
    expect(JSON.stringify(base())).toBe(before);
    const h = undo(perform(initHistory(base()), { kind: 'UPDATE_INTERMEDIATE_NAME', intermediateId: 'I-BLEND', name: 'Renamed' }));
    expect(h.present.intermediates.find((i) => i.id === 'I-BLEND')?.name).toBe('Lubricated blend');
  });
});
