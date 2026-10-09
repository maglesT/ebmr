/**
 * Contract examples from the server's own answers (review F55, lead TODO T7): the answers of a test server are made
 * stable, so they can be compared with (or written as) the examples in packages/api-contract/fixtures. Ids become the
 * examples' own (people by login name, records as the caller names them, every other id a fixed example id in order
 * of appearance) and instants keep their order, one minute apart from a base instant, formatted in the site zone.
 * EBMR_WRITE_EXAMPLES=1 writes the examples again after a deliberate change of the server's answers.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';
import { formatInstant } from '../../src/platform/ports.ts';

export const FIXTURES = new URL('../../../../packages/api-contract/fixtures/', import.meta.url);
export const WRITE_EXAMPLES = process.env['EBMR_WRITE_EXAMPLES'] === '1';

/** The ids the existing examples give the demo people (the session examples' author and the run examples' crew). */
export const EXAMPLE_PERSONS: Readonly<Record<string, string>> = {
  'asha.rao': '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11',
  'test-operator-1': '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e51',
  'test-operator-2': '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e52',
  'test-verifier-1': '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61',
  'test-supervisor-1': '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e71',
  'test-qa-1': '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e81',
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const STEP_US = 60_000_000n;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isInstant = (o: Record<string, unknown>): boolean => typeof o['us'] === 'string' && typeof o['text'] === 'string' && Object.keys(o).length === 2;

/** Makes the database-specific values of a set of answers stable (ids and instants), keeping their order and links. */
export class Stabiliser {
  private readonly ids = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private readonly instants = new Set<bigint>();
  private next = 1;

  /**
   * `known` maps ids (or other exact texts, such as a package hash) to the examples' own; `base` is the first instant
   * (microseconds since the epoch) of the examples.
   */
  constructor(
    private readonly zone: string,
    private readonly base: bigint,
    known: Readonly<Record<string, string>> = {},
  ) {
    for (const [from, to] of Object.entries(known)) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(from)) this.ids.set(from, to);
      else this.texts.set(from, to);
    }
  }

  /** Learns the ids of people (by login name) and the instants of an answer, before any is rewritten. */
  learn(value: unknown): void {
    if (Array.isArray(value)) value.forEach((v) => this.learn(v));
    else if (value !== null && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      if (typeof o['personId'] === 'string' && typeof o['loginName'] === 'string') {
        const id = EXAMPLE_PERSONS[o['loginName']];
        if (id && !this.ids.has(o['personId'])) this.ids.set(o['personId'], id);
      }
      if (isInstant(o)) this.instants.add(BigInt(o['us'] as string));
      for (const v of Object.values(o)) this.learn(v);
    }
  }

  private id(raw: string): string {
    let id = this.ids.get(raw);
    if (!id) {
      id = `e0000000-0000-4000-8000-${(this.next++).toString(16).padStart(12, '0')}`;
      this.ids.set(raw, id);
    }
    return id;
  }

  private text(s: string): string {
    let out = s;
    for (const [from, to] of this.texts) out = out.split(from).join(to);
    return out.replace(UUID, (m) => this.id(m));
  }

  /** The answer with stable ids and instants. */
  apply(value: unknown): Json {
    const order = [...this.instants].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const rank = new Map(order.map((us, i) => [us, i]));
    const walk = (v: unknown): Json => {
      if (typeof v === 'string') return this.text(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (isInstant(o)) return formatInstant(this.base + BigInt(rank.get(BigInt(o['us'] as string)) ?? 0) * STEP_US, this.zone);
        return Object.fromEntries(Object.entries(o).map(([k, x]) => [this.text(k), walk(x)]));
      }
      return v as Json;
    };
    return walk(value);
  }
}

/** Compares an example with the server's (stable) answer, or writes it when asked to. */
export function matchesExample(file: string, actual: Json): void {
  const url = new URL(file, FIXTURES);
  if (WRITE_EXAMPLES) writeFileSync(url, `${JSON.stringify(actual, null, 2)}\n`);
  expect(JSON.parse(readFileSync(url, 'utf8')), `${file} is not the server's answer (EBMR_WRITE_EXAMPLES=1 writes it again)`).toEqual(actual);
}

/** An example as JSON. */
export function exampleJson(file: string): Json {
  return JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')) as Json;
}
