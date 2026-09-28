/**
 * The expression language (packages/expr) may not import the kernel, so it carries its own canonical JSON and
 * SHA-256. Evaluation records hashed by expr and signatures hashed by the kernel must agree byte for byte, or a
 * signed calculation could not be re-verified. recipe-core may import both, so the cross-check lives here.
 */
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { esig } from '@ebmr/kernel';
import { canonicalJson as exprCanonical, sha256Hex as exprSha } from '@ebmr/expr';

// JSON values as they occur in records: strings (decimals are strings), booleans, null, nested objects and arrays.
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.string({ unit: 'binary' }),
    fc.boolean(),
    fc.constant(null),
    fc.integer({ min: -1000, max: 1000 }).map((n) => String(n)),
    fc.array(tie('value'), { maxLength: 5 }),
    fc.dictionary(fc.string({ unit: 'binary', maxLength: 8 }), tie('value'), { maxKeys: 5 }),
  ),
})).value;

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
});
