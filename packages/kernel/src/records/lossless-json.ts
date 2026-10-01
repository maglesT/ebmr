/**
 * A small JSON parser that keeps numbers as their exact text (JavaScript numbers would silently round
 * GMP values such as 12.5030 or 10.0000000000000001) and objects as ordered maps. Used by the offline
 * true-copy verifier to compare record content with the audit chain value by value.
 */

export class JsonNumber {
  constructor(readonly raw: string) {}
}

export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;
export type JsonObject = Map<string, JsonValue>;

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export function parseLossless(text: string): JsonValue {
  let pos = 0;
  const fail = (what: string): never => {
    throw new Error(`invalid JSON at offset ${pos}: ${what}`);
  };
  const ws = () => {
    while (pos < text.length && ' \t\n\r'.includes(text.charAt(pos))) pos++;
  };
  const str = (): string => {
    if (text[pos] !== '"') fail('expected a string');
    pos++;
    let out = '';
    for (;;) {
      if (pos >= text.length) fail('unterminated string');
      const c = text.charAt(pos++);
      if (c === '"') return out;
      if (c === '\\') {
        const e = text.charAt(pos++);
        if (e === 'u') {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          pos += 4;
        } else {
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          const v = map[e];
          if (v === undefined) fail('bad escape');
          out += v;
        }
      } else if (c < ' ') {
        fail('control character in string');
      } else {
        out += c;
      }
    }
  };
  const value = (): JsonValue => {
    ws();
    const c = text[pos];
    if (c === '{') {
      pos++;
      const obj: JsonObject = new Map();
      ws();
      if (text[pos] === '}') {
        pos++;
        return obj;
      }
      for (;;) {
        ws();
        const key = str();
        if (obj.has(key)) fail(`duplicate key ${key}`);
        ws();
        if (text[pos] !== ':') fail('expected :');
        pos++;
        obj.set(key, value());
        ws();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return obj;
        }
        fail('expected , or }');
      }
    }
    if (c === '[') {
      pos++;
      const arr: JsonValue[] = [];
      ws();
      if (text[pos] === ']') {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return arr;
        }
        fail('expected , or ]');
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    NUMBER_RE.lastIndex = pos;
    const m = NUMBER_RE.exec(text);
    if (!m) return fail('unexpected token');
    pos += m[0].length;
    return new JsonNumber(m[0]);
  };
  const result = value();
  ws();
  if (pos !== text.length) fail('trailing content');
  return result;
}

export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a instanceof JsonNumber || b instanceof JsonNumber) return a instanceof JsonNumber && b instanceof JsonNumber && a.raw === b.raw;
  // Stryker disable next-line LogicalOperator: equivalent; with && an array compared with a non-array skips this branch and reaches the Map test, which also returns false (an array is never a Map), so no result changes.
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEquals(x, b[i] as JsonValue));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !jsonEquals(v, b.get(k) as JsonValue)) return false;
    }
    return true;
  }
  return false;
}

/** The text PostgreSQL's ->> operator gives for a scalar (null for null, objects and arrays). */
export function jsonText(v: JsonValue | undefined): string | null {
  // Stryker disable next-line LogicalOperator: equivalent; undefined and null also pass every later test (neither is a string, a boolean or a JsonNumber) and reach the final return null, so a condition that is never true gives the same result.
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof JsonNumber) return v.raw;
  return null;
}

export function field(v: JsonValue | undefined, key: string): JsonValue | undefined {
  return v instanceof Map ? v.get(key) : undefined;
}
