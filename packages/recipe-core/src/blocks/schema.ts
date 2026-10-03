/**
 * A small declarative schema language for block configuration and block data (block contract,
 * outline 6.6; ADR 0010 decision 3). Schemas are data, so the designer, the engine, the renderers and
 * the registry report all read the same definition. Unknown fields are refused, decimals are
 * decimal-literal strings (never numbers) and counts are integers.
 */
import { isDecimalLiteral, compareDecimal } from '../flow/decimal.ts';

export type FieldSchema =
  | { readonly type: 'string'; readonly description: string; readonly enum?: readonly string[]; readonly pattern?: RegExp; readonly optional?: boolean }
  | { readonly type: 'decimal'; readonly description: string; readonly min?: string; readonly minExclusive?: boolean; readonly optional?: boolean }
  | { readonly type: 'integer'; readonly description: string; readonly min?: number; readonly max?: number; readonly optional?: boolean }
  | BooleanSchema
  | ObjectSchema
  | { readonly type: 'array'; readonly description: string; readonly items: FieldSchema; readonly minItems?: number; readonly maxItems?: number; readonly optional?: boolean }
  | { readonly type: 'record'; readonly description: string; readonly values: FieldSchema; readonly optional?: boolean };

/**
 * A yes/no member. An optional one says what an absent member means (review F52; PR-02, PR-03): `default` when it is
 * one value wherever the step stands, else `defaultText` in plain words (e.g. it depends on a sub-lot section). The
 * engine reads an absent member that way (a test drives each block's handler to prove it), and the designer shows and
 * records it that way: absent ("block default"), yes or no. The declaration describes the block version's behaviour
 * and does not change it, so it is not part of the plain-text rendering (describeSchema) that the registry
 * fingerprint covers: batches issued before it still run (ADR 0010).
 */
export interface BooleanSchema {
  readonly type: 'boolean';
  readonly description: string;
  readonly optional?: boolean;
  readonly default?: boolean;
  readonly defaultText?: string;
}

export interface ObjectSchema {
  readonly type: 'object';
  readonly description: string;
  readonly fields: Readonly<Record<string, FieldSchema>>;
  readonly optional?: boolean;
}

export interface SchemaProblem {
  path: string;
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates a value against a schema; returns every problem with its path (empty = valid). */
export function validateSchema(schema: FieldSchema, value: unknown, path = '$'): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string' || value.length === 0) out.push({ path, message: 'must be a non-empty text' });
      else {
        if (schema.enum && !schema.enum.includes(value)) out.push({ path, message: `must be one of ${schema.enum.join(', ')}` });
        if (schema.pattern && !schema.pattern.test(value)) out.push({ path, message: `has an invalid format` });
      }
      break;
    case 'decimal':
      if (!isDecimalLiteral(value)) out.push({ path, message: 'must be a decimal written as text (e.g. "0.5"), never a number' });
      else if (schema.min !== undefined) {
        const c = compareDecimal(value, schema.min);
        if (c < 0 || (c === 0 && schema.minExclusive === true)) out.push({ path, message: `must be ${schema.minExclusive === true ? 'greater than' : 'at least'} ${schema.min}` });
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) out.push({ path, message: 'must be a whole number' });
      else {
        if (schema.min !== undefined && value < schema.min) out.push({ path, message: `must be at least ${schema.min}` });
        if (schema.max !== undefined && value > schema.max) out.push({ path, message: `must be at most ${schema.max}` });
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') out.push({ path, message: 'must be true or false' });
      break;
    case 'object': {
      if (!isRecord(value)) {
        out.push({ path, message: 'must be an object' });
        break;
      }
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.fields, key)) out.push({ path: `${path}.${key}`, message: 'is not a field of this block (unknown fields are refused)' });
      for (const [key, field] of Object.entries(schema.fields)) {
        const v = value[key];
        if (v === undefined) {
          if (field.optional !== true) out.push({ path: `${path}.${key}`, message: 'is required' });
          continue;
        }
        out.push(...validateSchema(field, v, `${path}.${key}`));
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) out.push({ path, message: 'must be a list' });
      else {
        if (schema.minItems !== undefined && value.length < schema.minItems) out.push({ path, message: `needs at least ${schema.minItems} items` });
        if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push({ path, message: `allows at most ${schema.maxItems} items` });
        value.forEach((v, i) => out.push(...validateSchema(schema.items, v, `${path}[${i}]`)));
      }
      break;
    case 'record':
      if (!isRecord(value)) out.push({ path, message: 'must be an object' });
      else for (const [k, v] of Object.entries(value)) out.push(...validateSchema(schema.values, v, `${path}.${k}`));
      break;
  }
  return out;
}

/** Plain-text rendering of a schema (for reviewers and the registry report). */
export function describeSchema(schema: FieldSchema, indent = ''): string[] {
  const opt = schema.optional === true ? ' (optional)' : '';
  switch (schema.type) {
    case 'object':
      return [`${indent}object${opt}: ${schema.description}`, ...Object.entries(schema.fields).flatMap(([k, f]) => [`${indent}  ${k}:`, ...describeSchema(f, `${indent}    `)])];
    case 'array':
      return [`${indent}list${opt}: ${schema.description}`, ...describeSchema(schema.items, `${indent}  `)];
    case 'record':
      return [`${indent}map${opt}: ${schema.description}`, ...describeSchema(schema.values, `${indent}  `)];
    case 'string':
      return [`${indent}text${opt}${schema.enum ? ` (${schema.enum.join(' | ')})` : ''}: ${schema.description}`];
    default:
      return [`${indent}${schema.type}${opt}: ${schema.description}`];
  }
}
