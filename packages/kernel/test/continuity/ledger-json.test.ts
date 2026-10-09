/**
 * The continuity ledger's JSON (continuity/ledger.ts canonicalJson): every line of the ledger and the hash chaining
 * it are written from it, so a value it cannot write faithfully is refused before anything reaches the file, never
 * stored as {} or left out without notice. No database.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, FileLedger, type LedgerEntry } from '../../src/continuity/ledger.ts';

const dir = mkdtempSync(join(tmpdir(), 'ebmr-ledger-json-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('continuity ledger JSON', () => {
  it('[DI-45] keys are sorted at every level, undefined members are left out, arrays keep their order', () => {
    expect(canonicalJson({ b: ['2', { d: null, c: true }], a: 1, z: undefined })).toBe('{"a":1,"b":["2",{"c":true,"d":null}]}');
    expect(canonicalJson(Object.assign(Object.create(null) as object, { b: '2', a: '1' }))).toBe('{"a":"1","b":"2"}');
  });

  it('[DI-45] what JSON cannot carry faithfully is refused: a Date, Map, Set or class instance, undefined, a function, a symbol, an array hole', () => {
    const holey = ['a'];
    holey[2] = 'c';
    class Ceiling {
      constructor(readonly value: string) {}
    }
    for (const [value, message] of [
      [new Date(0), 'canonicalJson: a Date has no JSON form'],
      [{ m: new Map() }, 'canonicalJson: a Map has no JSON form'],
      [[new Set()], 'canonicalJson: a Set has no JSON form'],
      [new Ceiling('9'), 'canonicalJson: a Ceiling has no JSON form'],
      [Object.create(Object.create(null) as object), 'canonicalJson: a object has no JSON form'],
      [undefined, 'canonicalJson: a undefined has no JSON form'],
      [['x', undefined], 'canonicalJson: a undefined has no JSON form'],
      [holey, 'canonicalJson: a undefined has no JSON form'],
      [{ f: () => 1 }, 'canonicalJson: a function has no JSON form'],
      [Symbol('s'), 'canonicalJson: a symbol has no JSON form'],
      [1n, 'canonicalJson: bigint values must be written as strings'],
      [Number.NaN, 'canonicalJson: non-finite number'],
    ] as const) {
      expect(() => canonicalJson(value), message).toThrow(new TypeError(message));
    }
  });

  it('[DI-45] an entry the ledger cannot write is a rejection and leaves the file untouched', async () => {
    const path = join(dir, 'refused.ledger.jsonl');
    const ledger = new FileLedger(path, { database: 'ebmr_x' });
    const good: LedgerEntry = { type: 'CEILING', database: 'ebmr_x', sequenceKey: 'batch', ceiling: '10', floor: '1' };
    await ledger.append(good);
    const before = readFileSync(path, 'utf8');
    const bad = { ...good, ceiling: new Date(0) } as unknown as LedgerEntry;
    await expect(ledger.append(bad)).rejects.toThrow('canonicalJson: a Date has no JSON form');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(await ledger.entries()).toEqual([good]);
    // Nothing was written for a ledger whose first entry is refused.
    const empty = join(dir, 'empty.ledger.jsonl');
    await expect(new FileLedger(empty, { database: 'ebmr_x' }).append(bad)).rejects.toThrow(TypeError);
    expect(existsSync(empty) ? readFileSync(empty, 'utf8') : '').toBe('');
  });
});
