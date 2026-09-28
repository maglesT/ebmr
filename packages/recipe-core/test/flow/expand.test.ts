import { describe, expect, it } from 'vitest';
import { libraryElementHash } from '../../src/flow/canonical.ts';
import { expandLibraryCalls } from '../../src/flow/expand.ts';
import type { LibraryElement, MbrContent } from '../../src/flow/model.ts';
import { clone, loadFixture } from './support.ts';

const base = loadFixture('tablet-granulation-compression');

function codes(mbr: MbrContent): string[] {
  return expandLibraryCalls(mbr).problems.map((p) => p.code);
}

function element(mbr: MbrContent): LibraryElement {
  const e = mbr.library[0];
  if (!e) throw new Error('fixture changed');
  return e;
}

describe('library calls to pinned element versions (outline 6.2, 6.5)', () => {
  it('[DI-04] the fixture expands without problems', () => {
    expect(codes(base)).toEqual([]);
  });

  it('[DI-04] an embedded snapshot that does not match its pinned hash is refused', () => {
    const m = clone(base);
    const body = element(m).body;
    if (body.kind === 'phase') body.name = 'Tampered';
    expect(codes(m)).toEqual(['LIB_HASH_MISMATCH']);
  });

  it('[DI-04] a call to an element that is not pinned by hash, or not embedded, is refused', () => {
    const m = clone(base);
    const ref = m.references.find((r) => r.id === 'LIB-LOD');
    if (ref) delete ref.hash;
    expect(codes(m)).toEqual(['LIB_NOT_PINNED']);
    const m2 = clone(base);
    m2.library = [];
    expect(codes(m2)).toEqual(['LIB_UNKNOWN']);
  });

  it('[DI-04] every element symbol must be bound by the call, and only declared symbols may be bound', () => {
    const m = clone(base);
    const text = JSON.stringify(m).replace('"bind":{"lodValue":"lod","analyser":"MA"}', '"bind":{"lodValue":"lod","extra":"X"}');
    expect(codes(JSON.parse(text) as MbrContent)).toEqual(expect.arrayContaining(['LIB_UNBOUND_SYMBOL', 'LIB_UNDECLARED_SYMBOL']));
  });

  it('[DI-04] an element that uses an undeclared symbol is refused', () => {
    const m = clone(base);
    const e = element(m);
    e.symbols = ['lodValue'];
    const ref = m.references.find((r) => r.id === 'LIB-LOD');
    if (ref) ref.hash = libraryElementHash(e);
    m.procedure = JSON.parse(JSON.stringify(m.procedure).replace('"bind":{"lodValue":"lod","analyser":"MA"}', '"bind":{"lodValue":"lod"}')) as MbrContent['procedure'];
    expect(codes(m)).toEqual(['LIB_UNDECLARED_SYMBOL']);
  });

  it('[DI-04] an operation-level element called at stage level is refused', () => {
    const m = clone(base);
    const e = element(m);
    e.level = 'STAGE';
    const ref = m.references.find((r) => r.id === 'LIB-LOD');
    if (ref) ref.hash = libraryElementHash(e);
    expect(codes(m)).toEqual(['LIB_LEVEL']);
  });

  it('[DI-04] an element that calls itself is refused', () => {
    const m = clone(base);
    const e = element(m);
    e.body = { kind: 'sequence', id: 'rec', children: [e.body, { kind: 'libraryCall', id: 'again', element: 'LIB-LOD', bind: { lodValue: 'lodValue', analyser: 'analyser' } }] };
    const ref = m.references.find((r) => r.id === 'LIB-LOD');
    if (ref) ref.hash = libraryElementHash(e);
    expect(codes(m)).toContain('LIB_RECURSION');
  });
});
