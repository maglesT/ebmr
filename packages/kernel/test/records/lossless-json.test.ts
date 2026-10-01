/**
 * The lossless JSON reader of the offline true-copy verifier (lossless-json.ts): numbers keep their
 * exact text, objects keep their keys in order and refuse duplicates, and every input that is not one
 * JSON document is refused with the offset and the reason. jsonEquals is the value-by-value comparison
 * the verifier makes between a row and the audit trail; jsonText is its reading of PostgreSQL's ->>.
 * No database; true-copy-verifier.test.ts shows the verifier using them on whole bundles.
 */
import { describe, expect, it } from 'vitest';
import { field, jsonEquals, jsonText, JsonNumber, parseLossless, type JsonValue } from '../../src/records/lossless-json.ts';

const num = (raw: string) => new JsonNumber(raw);
const refused = (text: string, offset: number, what: string) => expect(() => parseLossless(text)).toThrow(new Error(`invalid JSON at offset ${offset}: ${what}`));
const obj = (text: string) => parseLossless(text) as Map<string, JsonValue>;

describe('parseLossless: values', () => {
  it('[INV-08] numbers keep their exact text: no rounding, and no rewriting of trailing zeros, exponents or negative zero', () => {
    expect(parseLossless('12.5030')).toStrictEqual(num('12.5030'));
    expect(parseLossless('10.0000000000000001')).toStrictEqual(num('10.0000000000000001'));
    expect(parseLossless('-0')).toStrictEqual(num('-0'));
    expect(parseLossless('1E+2')).toStrictEqual(num('1E+2'));
    expect(parseLossless('2.50e-7')).toStrictEqual(num('2.50e-7'));
    expect(parseLossless('6.02214076E+23')).toStrictEqual(num('6.02214076E+23'));
    expect(parseLossless('-1e-10')).toStrictEqual(num('-1e-10'));
    expect(parseLossless('[0,-2.50,3e2]')).toStrictEqual([num('0'), num('-2.50'), num('3e2')]);
  });

  it('[meta] a number written outside the JSON grammar is refused', () => {
    refused('+1', 0, 'unexpected token');
    refused('.5', 0, 'unexpected token');
    refused('-', 0, 'unexpected token');
    refused('01', 1, 'trailing content');
    refused('1.', 1, 'trailing content');
    refused('1e', 1, 'trailing content');
  });

  it('[meta] true, false and null are read as themselves, and only when spelt exactly', () => {
    expect(parseLossless('true')).toBe(true);
    expect(parseLossless('false')).toBe(false);
    expect(parseLossless('null')).toBeNull();
    expect(parseLossless(' [true,false,null] ')).toStrictEqual([true, false, null]);
    expect(parseLossless('{"t":true,"f":false}')).toStrictEqual(
      new Map<string, JsonValue>([
        ['t', true],
        ['f', false],
      ]),
    );
    refused('tru', 0, 'unexpected token');
    refused('True', 0, 'unexpected token');
    refused('fals', 0, 'unexpected token');
    refused('nul', 0, 'unexpected token');
    refused('truex', 4, 'trailing content');
    refused('falsey', 5, 'trailing content');
  });

  it('[meta] a document is exactly one value; JSON whitespace (space, tab, line feed, carriage return) may surround any token', () => {
    expect(parseLossless(' \t\n\r1 \t\n\r')).toStrictEqual(num('1'));
    expect(parseLossless(' \t\n\r{ \t\n\r"a" \t\n\r: \t\n\r[ \t\n\r1 \t\n\r, \t\n\r2 \t\n\r] \t\n\r} \t\n\r')).toStrictEqual(
      new Map([['a', [num('1'), num('2')]]]),
    );
    refused('', 0, 'unexpected token');
    refused('   ', 3, 'unexpected token');
    refused('x', 0, 'unexpected token');
    refused('1 2', 2, 'trailing content');
    refused('{} x', 3, 'trailing content');
    // Other white space is not JSON whitespace.
    refused('\u00a01', 0, 'unexpected token');
    refused('\v1', 0, 'unexpected token');
    refused('1\f', 1, 'trailing content');
  });
});

describe('parseLossless: strings', () => {
  it('[meta] characters are read as written, including spaces, DEL and characters outside ASCII', () => {
    expect(parseLossless('"plain text, with spaces"')).toBe('plain text, with spaces');
    expect(parseLossless('""')).toBe('');
    expect(parseLossless('"\u007f Ünïcødé ✓ 😀"')).toBe('\u007f Ünïcødé ✓ 😀');
  });

  it('[meta] each two-character escape stands for its character', () => {
    const escapes: [string, string][] = [
      ['\\"', '"'],
      ['\\\\', '\\'],
      ['\\/', '/'],
      ['\\b', '\b'],
      ['\\f', '\f'],
      ['\\n', '\n'],
      ['\\r', '\r'],
      ['\\t', '\t'],
    ];
    for (const [escape, char] of escapes) expect(parseLossless(`"a${escape}z"`)).toBe(`a${char}z`);
    expect(parseLossless(String.raw`"\"\\\/\b\f\n\r\t"`)).toBe('"\\/\b\f\n\r\t');
  });

  it('[meta] a \\u escape is four hex digits in either case and stands for that UTF-16 code unit', () => {
    expect(parseLossless(String.raw`"\u0041BC"`)).toBe('ABC');
    expect(parseLossless(String.raw`"\u00e9\u00E9\u20AC"`)).toBe('\u00e9\u00e9\u20ac');
    expect(parseLossless(String.raw`"\ud83d\ude00"`)).toBe('\ud83d\ude00');
    expect(parseLossless(String.raw`"\u0000"`)).toBe('\u0000');
    expect(parseLossless('["\\u0022",1]')).toStrictEqual(['"', num('1')]);
  });

  it('[meta] an unknown escape, a short or non-hex \\u escape, a raw control character or a missing closing quote is refused', () => {
    refused(String.raw`"\x"`, 3, 'bad escape');
    refused(String.raw`"\U0041"`, 3, 'bad escape');
    refused('"a\\', 4, 'bad escape');
    refused(String.raw`"\u12"`, 3, 'bad unicode escape');
    refused(String.raw`"\u00zz"`, 3, 'bad unicode escape');
    refused(String.raw`"\u-123"`, 3, 'bad unicode escape');
    refused(String.raw`"\u 123"`, 3, 'bad unicode escape');
    refused('"a\u0001b"', 3, 'control character in string');
    refused('"a\nb"', 3, 'control character in string');
    refused('"\t"', 2, 'control character in string');
    refused('"\u001f"', 2, 'control character in string');
    refused('"abc', 4, 'unterminated string');
    refused('"', 1, 'unterminated string');
    refused('["a]', 4, 'unterminated string');
  });
});

describe('parseLossless: objects and arrays', () => {
  it('[INV-08] an object keeps its keys in the order written', () => {
    const o = obj('{"b":1,"a":[2],"c":{"d":null}}');
    expect([...o.keys()]).toEqual(['b', 'a', 'c']);
    expect(o).toStrictEqual(
      new Map<string, JsonValue>([
        ['b', num('1')],
        ['a', [num('2')]],
        ['c', new Map([['d', null]])],
      ]),
    );
    expect(parseLossless('{}')).toStrictEqual(new Map());
    expect(parseLossless('{ }')).toStrictEqual(new Map());
    expect(parseLossless('{"a" :1 ,"b":2 }')).toStrictEqual(
      new Map([
        ['a', num('1')],
        ['b', num('2')],
      ]),
    );
  });

  it('[INV-08] an object with a key written twice is refused, naming the key', () => {
    refused('{"a":1,"a":2}', 10, 'duplicate key a');
    refused('{"lot":"L1","qty":5,"lot":"L2"}', 25, 'duplicate key lot');
  });

  it('[meta] an object key that is not a string, a missing colon or comma, a trailing comma or a missing brace is refused', () => {
    refused('{1:2}', 1, 'expected a string');
    refused('{', 1, 'expected a string');
    refused('{"a":1,}', 7, 'expected a string');
    refused('{"a" 1}', 5, 'expected :');
    refused('{"a"}', 4, 'expected :');
    refused('{"a":}', 5, 'unexpected token');
    refused('{"a":1 "b":2}', 7, 'expected , or }');
    refused('{"a":1]', 6, 'expected , or }');
    refused('{"a":1', 6, 'expected , or }');
    refused('{"a":1}}', 7, 'trailing content');
  });

  it('[meta] an array keeps its elements in order, nested values included', () => {
    expect(parseLossless('[]')).toStrictEqual([]);
    expect(parseLossless('[ ]')).toStrictEqual([]);
    expect(parseLossless('[1]')).toStrictEqual([num('1')]);
    expect(parseLossless('[ 3 , [ "x" , [] ] ,{} , "y" ]')).toStrictEqual([num('3'), ['x', []], new Map(), 'y']);
    expect(parseLossless('[[1,2],[3]]')).toStrictEqual([[num('1'), num('2')], [num('3')]]);
  });

  it('[meta] an array with a missing comma, a trailing or leading comma or a missing bracket is refused', () => {
    refused('[1 2]', 3, 'expected , or ]');
    refused('[1}', 2, 'expected , or ]');
    refused('[1', 2, 'expected , or ]');
    refused('[1,]', 3, 'unexpected token');
    refused('[,1]', 1, 'unexpected token');
    refused('[', 1, 'unexpected token');
    refused('[1]]', 3, 'trailing content');
  });
});

describe('jsonEquals', () => {
  const eq = (a: string, b: string) => jsonEquals(parseLossless(a), parseLossless(b));

  it('[INV-08] numbers are equal only when written the same: 1.0 is not 1, 12.5030 is not 12.503', () => {
    expect(jsonEquals(num('12.5030'), num('12.5030'))).toBe(true);
    expect(jsonEquals(num('1.0'), num('1'))).toBe(false);
    expect(jsonEquals(num('12.5030'), num('12.503'))).toBe(false);
    expect(jsonEquals(num('1'), num('2'))).toBe(false);
    expect(eq('1e2', '100')).toBe(false);
    // A number never equals the string, array or null of the same text.
    expect(jsonEquals(num('1'), '1')).toBe(false);
    expect(jsonEquals('1', num('1'))).toBe(false);
    expect(jsonEquals(num('0'), null)).toBe(false);
    expect(jsonEquals(null, num('0'))).toBe(false);
    expect(jsonEquals(num('1'), [num('1')])).toBe(false);
    expect(jsonEquals([num('1')], num('1'))).toBe(false);
  });

  it('[INV-08] arrays are equal when they have the same length and equal elements in the same order', () => {
    expect(eq('[]', '[]')).toBe(true);
    expect(eq('[1,[2,"x"],{"a":true}]', '[1, [2, "x"], {"a": true}]')).toBe(true);
    expect(eq('[1]', '[1,2]')).toBe(false);
    expect(eq('[1,2]', '[1]')).toBe(false);
    expect(eq('[1,2]', '[1,3]')).toBe(false);
    expect(eq('[1,2]', '[2,1]')).toBe(false);
    expect(eq('[[1]]', '[[1.0]]')).toBe(false);
    // An array never equals a non-array, even an empty one of the same length.
    expect(eq('[]', '""')).toBe(false);
    expect(eq('""', '[]')).toBe(false);
    expect(eq('[]', '{}')).toBe(false);
    expect(eq('{}', '[]')).toBe(false);
    expect(eq('[]', 'null')).toBe(false);
  });

  it('[INV-08] objects are equal when they have the same keys with equal values, in any order (as jsonb compares them)', () => {
    expect(eq('{}', '{}')).toBe(true);
    expect(eq('{"a":1,"b":[2]}', '{"b":[2],"a":1}')).toBe(true);
    expect(eq('{"a":{"b":{"c":"x"}}}', '{"a":{"b":{"c":"x"}}}')).toBe(true);
    expect(eq('{"a":1}', '{"a":1,"b":2}')).toBe(false);
    expect(eq('{"a":1,"b":2}', '{"a":1}')).toBe(false);
    expect(eq('{"a":1}', '{"b":1}')).toBe(false);
    expect(eq('{"a":null}', '{"b":null}')).toBe(false);
    expect(eq('{"a":1}', '{"a":2}')).toBe(false);
    expect(eq('{"a":1}', '{"a":"1"}')).toBe(false);
    expect(eq('{"a":{"b":{"c":"x"}}}', '{"a":{"b":{"c":"y"}}}')).toBe(false);
    expect(eq('{}', 'null')).toBe(false);
    expect(eq('null', '{}')).toBe(false);
    expect(eq('{}', '""')).toBe(false);
  });

  it('[INV-08] strings, true, false and null equal only themselves', () => {
    expect(eq('"x"', '"x"')).toBe(true);
    expect(eq('"x"', '"y"')).toBe(false);
    expect(eq('""', '"x"')).toBe(false);
    expect(eq('true', 'true')).toBe(true);
    expect(eq('true', 'false')).toBe(false);
    expect(eq('false', 'null')).toBe(false);
    expect(eq('null', 'null')).toBe(true);
    expect(eq('"true"', 'true')).toBe(false);
    expect(eq('""', 'null')).toBe(false);
  });
});

describe('jsonText and field', () => {
  it('[INV-08] jsonText gives what PostgreSQL ->> gives: the text of a string, boolean or number, and null for null, objects and arrays', () => {
    expect(jsonText('L-0042')).toBe('L-0042');
    expect(jsonText('')).toBe('');
    expect(jsonText(true)).toBe('true');
    expect(jsonText(false)).toBe('false');
    expect(jsonText(num('12.5030'))).toBe('12.5030');
    expect(jsonText(null)).toBeNull();
    expect(jsonText(undefined)).toBeNull();
    expect(jsonText([])).toBeNull();
    expect(jsonText(parseLossless('["x"]'))).toBeNull();
    expect(jsonText(new Map())).toBeNull();
    expect(jsonText(parseLossless('{"a":"x"}'))).toBeNull();
  });

  it('[INV-08] field reads a key of an object, and nothing of anything else', () => {
    const doc = parseLossless('{"body":{"row_hash":"ab12","n":1.50},"list":["x"]}');
    expect(field(field(doc, 'body'), 'row_hash')).toBe('ab12');
    expect(field(field(doc, 'body'), 'n')).toStrictEqual(num('1.50'));
    expect(field(doc, 'missing')).toBeUndefined();
    expect(field(field(doc, 'missing'), 'row_hash')).toBeUndefined();
    expect(field(field(doc, 'list'), '0')).toBeUndefined();
    expect(field('body', 'length')).toBeUndefined();
    expect(field(null, 'body')).toBeUndefined();
  });
});
