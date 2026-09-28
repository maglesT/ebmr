/**
 * The expression language (packages/expr) may not import the kernel, so it carries its own canonical JSON and
 * SHA-256. Evaluation records hashed by expr and signatures hashed by the kernel must agree byte for byte, or a
 * signed calculation could not be re-verified. recipe-core may import both, so the cross-check lives here.
 *
 * flow/canonical.ts (MBR content hashes) uses expr's implementation so that the browser-safe `./pure` subpath
 * never reaches the kernel (Phase 2 apps plan section 3). This test was extended before that switch: numbers,
 * the refusals of both implementations, and the canonical text of the real fixture MBRs.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { esig } from '@ebmr/kernel';
import { canonicalJson as exprCanonical, sha256Hex as exprSha } from '@ebmr/expr';
import { canonicalJson as flowCanonical, mbrContentHash, sha256Hex as flowSha } from '../../src/flow/canonical.ts';
import type { MbrContent } from '../../src/flow/model.ts';

// JSON values as they occur in records: strings (decimals are strings), booleans, null, safe integers
// (counts, indices, content versions; negative numbers and zero included), nested objects and arrays.
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.string({ unit: 'binary' }),
    fc.boolean(),
    fc.constant(null),
    fc.integer({ min: -1000, max: 1000 }).map((n) => String(n)),
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    fc.constantFrom(0, -0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER),
    fc.array(tie('value'), { maxLength: 5 }),
    fc.dictionary(fc.string({ unit: 'binary', maxLength: 8 }), tie('value'), { maxKeys: 5 }),
  ),
})).value;

/** The outcome of one implementation: its text, or the fact that it refused. */
function outcome(f: (v: unknown) => string, v: unknown): { text: string } | { refused: true } {
  try {
    return { text: f(v) };
  } catch {
    return { refused: true };
  }
}

const FIXTURES = ['tablet-granulation-compression.mbr.json', 'tablet-blister-packaging.mbr.json'].map((name) => ({
  name,
  mbr: JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as MbrContent,
}));

describe('canonical JSON and hashing agree between expr and the kernel', () => {
  it('[DI-33][DI-37] expr and kernel canonical JSON are identical for any record value', () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        expect(exprCanonical(v)).toBe(esig.canonicalJson(v));
      }),
      { numRuns: 2000 },
    );
  });

  it('[DI-33][DI-37] expr SHA-256 equals node:crypto SHA-256 of the same canonical text', () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const text = esig.canonicalJson(v);
        expect(exprSha(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
      }),
      { numRuns: 1000 },
    );
  });

  it('[DI-33][DI-37] safe integers, including zero and negative numbers, serialise identically', () => {
    fc.assert(
      fc.property(fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }), (n) => {
        expect(exprCanonical({ n, list: [n, -n] })).toBe(esig.canonicalJson({ n, list: [n, -n] }));
      }),
      { numRuns: 2000 },
    );
    for (const n of [0, -0, 1, -1, 42, -42, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      expect(exprCanonical(n)).toBe(esig.canonicalJson(n));
    }
    expect(exprCanonical(-0)).toBe('0');
  });

  it('[DI-33][DI-37] both refuse unsafe integers, fractions and non-finite numbers alike, anywhere in a value', () => {
    const refused = [
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
      2 ** 60,
      1.5,
      -0.1,
      1e-7,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      () => 1,
      Symbol('x'),
    ];
    for (const bad of refused) {
      for (const v of [bad, [1, bad], { a: { b: [bad] } }]) {
        // An object member that is undefined is omitted by both, not refused.
        if (bad === undefined && !Array.isArray(v) && typeof v === 'object') continue;
        expect(outcome(exprCanonical, v), String(bad)).toEqual({ refused: true });
        expect(outcome(esig.canonicalJson, v), String(bad)).toEqual({ refused: true });
      }
    }
    fc.assert(
      fc.property(
        fc.oneof(fc.double({ noInteger: true }), fc.integer({ min: 2 ** 53, max: 2 ** 60 }).map((n) => n * 2), fc.constantFrom(Number.NaN, Infinity, -Infinity)),
        (x) => {
          expect(outcome(exprCanonical, { x })).toEqual(outcome(esig.canonicalJson, { x }));
          expect(outcome(exprCanonical, { x })).toEqual({ refused: true });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('[DI-33][DI-37] bigints are treated alike by both (written as integers, never refused differently)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }), (b) => {
        expect(outcome(exprCanonical, { b, list: [b] })).toEqual(outcome(esig.canonicalJson, { b, list: [b] }));
      }),
      { numRuns: 500 },
    );
  });

  it('[DI-04][DI-37] the canonical text and content hash of both fixture MBRs are byte for byte equal in expr, the kernel and flow', () => {
    for (const { name, mbr } of FIXTURES) {
      const kernelText = esig.canonicalJson(mbr);
      expect(exprCanonical(mbr), name).toBe(kernelText);
      expect(flowCanonical(mbr), name).toBe(kernelText);
      const kernelHash = esig.sha256Hex(kernelText);
      expect(exprSha(kernelText), name).toBe(kernelHash);
      expect(flowSha(kernelText), name).toBe(kernelHash);
      expect(mbrContentHash(mbr), name).toBe(kernelHash);
      expect(Buffer.from(exprCanonical(mbr), 'utf8').equals(Buffer.from(kernelText, 'utf8')), name).toBe(true);
    }
  });
});
