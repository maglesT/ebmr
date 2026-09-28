/**
 * Guard normalisation for the validator's exhaustiveness check, and determinism of the core
 * (brief A1 item 8: identical results in Node and the browser; no Intl, no locale, no clock).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/lang/compile.ts';
import { toGuardFormula } from '../src/lang/guard.ts';
import type { InputDeclarations } from '../src/lang/types.ts';

const inputs: InputDeclarations = {
  lod: { unit: '%', tag: 'lod' },
  hardness: { unit: 'N' },
  coated: { kind: 'boolean' },
  coating: { kind: 'category', values: ['FILM', 'SUGAR'] },
  temp: { unit: 'Cel' },
  a: { unit: 'kg' },
  b: { unit: 'kg' },
};

function guard(source: string) {
  const r = compile(source, { inputs, role: 'condition' });
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return toGuardFormula(r.program);
}

describe('guard normalisation', () => {
  it('reduces conditions to input-vs-constant comparisons with the constant in the declared unit', () => {
    expect(guard('lod <= 2.0 [%]')).toEqual({ op: 'cmp', variable: 'lod', cmp: '<=', constant: '2' });
    expect(guard('5 [kgf] < hardness')).toEqual({ op: 'cmp', variable: 'hardness', cmp: '>', constant: '49.03325' });
    // 250 degF is 121.111... degC: not exact in the input's unit, so the validator cannot decide on it.
    expect(guard('temp >= 250 [[degF]]')).toEqual({ op: 'opaque', reason: 'the constant cannot be expressed exactly in Cel' });
    expect(guard('temp >= 212 [[degF]]')).toEqual({ op: 'cmp', variable: 'temp', cmp: '>=', constant: '100' });
    expect(guard('lod > -1 [%]')).toEqual({ op: 'cmp', variable: 'lod', cmp: '>', constant: '-1' });
  });

  it('keeps and/or/not structure and category/boolean tests; everything else is opaque', () => {
    expect(guard('coated && coating == "FILM" || !(lod > 3 [%])')).toEqual({
      op: 'or',
      args: [
        { op: 'and', args: [{ op: 'is', variable: 'coated', value: true }, { op: 'is', variable: 'coating', value: 'FILM' }] },
        { op: 'not', arg: { op: 'cmp', variable: 'lod', cmp: '>', constant: '3' } },
      ],
    });
    expect(guard('coating != "SUGAR"')).toEqual({ op: 'not', arg: { op: 'is', variable: 'coating', value: 'SUGAR' } });
    expect(guard('true')).toEqual({ op: 'const', value: true });
    expect(guard('a > b')).toMatchObject({ op: 'opaque' });
    expect(guard('a + b > 1 [kg]')).toMatchObject({ op: 'opaque' });
  });
});

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('determinism of the runtime core', () => {
  const runtime = files(SRC).filter((f) => !relative(SRC, f).startsWith('units/generator'));

  it('[DI-33] uses no clock, randomness, locale formatting, Intl, eval or host APIs (identical in Node and the browser)', () => {
    const banned = [/\bDate\b/, /Math\.random/, /toLocale/, /\bIntl\b/, /\beval\s*\(/, /new Function/, /from 'node:/, /\bprocess\./, /\brequire\(/, /setTimeout|setInterval/, /parseFloat|Number\.parseFloat/];
    const hits: string[] = [];
    for (const f of runtime) {
      const text = readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n');
      for (const b of banned) if (b.test(text)) hits.push(`${relative(SRC, f)}: ${String(b)}`);
    }
    expect(hits).toEqual([]);
  });

  it('[DI-33] the runtime reads the generated unit table and never loads ucum-lhc', () => {
    const importers = runtime.filter((f) => /from '@lhncbc\/ucum-lhc/.test(readFileSync(f, 'utf8')));
    expect(importers.map((f) => relative(SRC, f))).toEqual([]);
  });
});
