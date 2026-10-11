/**
 * Block entries over HTTP (Phase 3 slice 6, D-S6-2): the BLOCK_ENTRY forms a step offers, with the block's own schema
 * as JSON, and the server's part of a BLOCK_ENTRY: the members it fills, never the browser.
 *
 * A member a block marks `serverFilled` is a fact the server reads: the browser's form leaves it out, and a BLOCK_ENTRY
 * that names one is refused (nothing is written). The server then fills the ones it reads from the database for a
 * person's entry (SERVER_FILLED: DATABASE); the device path's members (DEVICE) arrive only with the gateway's readings;
 * the typed path's (TYPED) only with their own typed entry. The engine's schema and the database's guards still decide.
 */
import type pg from 'pg';
import { TABLET_ENTRY_KINDS_BY_BLOCK, TabletEntryKind, TYPED_ENTRY_KINDS, type BlockEntryFormView, type BlockFieldSchemaWire, type BlockObjectSchemaWire } from '@ebmr/api-contract';
import type { blocks } from '@ebmr/recipe-core';
import { refusal } from '../../platform/http/refusal.ts';

type FieldSchema = blocks.FieldSchema;
type ObjectSchema = blocks.ObjectSchema;

/** Who fills each server-filled member, by entry kind and member (every block marking it the same way). */
export const SERVER_FILLED: Readonly<Record<string, Readonly<Record<string, 'DATABASE' | 'DEVICE' | 'TYPED'>>>> = {
  // TB-08@1 and G-24@2: the source container's facts and the authorisation's signer, read at the moment of use.
  ADDITION: { source: 'DATABASE', authorisedBy: 'DATABASE' },
  // G-21@1: the job the server released for the step's printer and the printer loaded (tab.print_job, 0951).
  FIRST_PRINT: { job: 'DATABASE' },
  // G-06@1 (and the blocks built on it): a reading's provenance comes from the gateway path only.
  SETPOINT_READBACK: { readingId: 'DEVICE', quality: 'DEVICE', receivedAtUs: 'DEVICE' },
  ACTUAL: { readingId: 'DEVICE', quality: 'DEVICE', receivedAtUs: 'DEVICE' },
  ALARM: { readingId: 'DEVICE', quality: 'DEVICE', receivedAtUs: 'DEVICE' },
  // TB-01@1: the lot consumption the server makes for a container on GMP (typed CONTAINER_WEIGHING only).
  CONTAINER_WEIGHING: { consumption: 'TYPED' },
};

/** The top-level members of an entry schema marked serverFilled. */
export function serverFilledMembers(schema: ObjectSchema): string[] {
  return Object.entries(schema.fields)
    .filter(([, f]) => f.serverFilled === true)
    .map(([k]) => k);
}

function wireOf(f: FieldSchema): BlockFieldSchemaWire {
  const common = { description: f.description, ...(f.optional !== undefined ? { optional: f.optional } : {}), ...(f.serverFilled ? { serverFilled: true } : {}) };
  switch (f.type) {
    case 'string':
      return { type: 'string', ...common, ...(f.enum ? { enum: [...f.enum] } : {}), ...(f.pattern ? { pattern: f.pattern.source } : {}) };
    case 'decimal':
      return { type: 'decimal', ...common, ...(f.min !== undefined ? { min: f.min } : {}), ...(f.minExclusive !== undefined ? { minExclusive: f.minExclusive } : {}) };
    case 'integer':
      return { type: 'integer', ...common, ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}) };
    case 'boolean':
      return { type: 'boolean', ...common, ...(f.default !== undefined ? { default: f.default } : {}), ...(f.defaultText !== undefined ? { defaultText: f.defaultText } : {}) };
    case 'object':
      return objectWire(f);
    case 'array':
      return { type: 'array', ...common, items: wireOf(f.items), ...(f.minItems !== undefined ? { minItems: f.minItems } : {}), ...(f.maxItems !== undefined ? { maxItems: f.maxItems } : {}) };
    case 'record':
      return { type: 'record', ...common, values: wireOf(f.values) };
  }
}

/** A block's object schema as JSON (patterns as their source text). */
export function objectWire(s: ObjectSchema): BlockObjectSchemaWire {
  return {
    type: 'object',
    description: s.description,
    fields: Object.fromEntries(Object.entries(s.fields).map(([k, f]) => [k, wireOf(f)])),
    ...(s.optional !== undefined ? { optional: s.optional } : {}),
    ...(s.serverFilled ? { serverFilled: true } : {}),
  };
}

const KIND_SET: ReadonlySet<string> = new Set(TabletEntryKind.options);

const titleOf = (kind: string): string => {
  const words = kind.toLowerCase().split('_');
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
};

/** The BLOCK_ENTRY forms of a step's block: none for a block outside the slice 6 list, never the typed kinds. */
export function blockEntryForms(block: blocks.BlockVersion | undefined): BlockEntryFormView[] {
  if (!block || !(`${block.type}@${block.version}` in TABLET_ENTRY_KINDS_BY_BLOCK)) return [];
  const out: BlockEntryFormView[] = [];
  for (const [kind, schema] of Object.entries(block.dataSchema?.entries ?? {})) {
    if (!KIND_SET.has(kind) || TYPED_ENTRY_KINDS.includes(kind as TabletEntryKind)) continue;
    out.push({ kind: kind as TabletEntryKind, title: titleOf(kind), description: schema.description, schema: objectWire(schema) });
  }
  return out;
}

function refuse(code: string, whatHappened: string, why: string, whatYouCanDo: string[]): Error {
  return refusal(422, { code, kind: 'INVALID_INPUT', whatHappened, why, controls: ['DI-31', 'DI-32'], whatYouCanDo, whoCanHelp: ['The shift supervisor'] });
}

export interface BlockEntryContext {
  client: pg.PoolClient;
  batchId: string;
  stepKey: string;
  block: blocks.BlockVersion | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidOf = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

async function one<T>(client: pg.PoolClient, sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await client.query<{ r: T | null }>(sql, params);
  return rows[0]?.r ?? null;
}

/** The engine entry of a BLOCK_ENTRY: the person's members, and the members the server reads from the database. */
export async function resolveBlockEntry(ctx: BlockEntryContext, entryKind: TabletEntryKind, data: Readonly<Record<string, unknown>>): Promise<Record<string, unknown> & { kind: string }> {
  if (TYPED_ENTRY_KINDS.includes(entryKind)) {
    throw refuse(
      'EBMR-API-BLOCK-ENTRY-TYPED',
      `A ${entryKind} entry is sent in its own form, not as a block entry.`,
      'The server reads the lots and scale readings of this entry kind itself; the browser does not supply them.',
      [`Record the ${entryKind} entry from the step screen's own form.`],
    );
  }
  const schema = ctx.block?.dataSchema?.entries[entryKind];
  const filled = schema ? serverFilledMembers(schema) : [];
  const sent = filled.filter((m) => m in data);
  if (sent.length > 0) {
    throw refuse(
      'EBMR-API-SERVER-FILLED',
      `The entry names ${sent.join(', ')}, which the system fills itself. Nothing was saved.`,
      `${sent.join(', ')} of a ${entryKind} entry ${sent.length > 1 ? 'are facts' : 'is a fact'} the server reads from the record or the equipment, never typed (DI-31, DI-32).`,
      ['Send the entry without these members.'],
    );
  }
  const entry: Record<string, unknown> = { ...data, kind: entryKind };
  if (entryKind === 'ADDITION' && filled.includes('source')) {
    const container = uuidOf(data['container']);
    const facts = container ? await one<Record<string, unknown>>(ctx.client, 'select recipe.source_container_facts($1::uuid, $2) as r', [container, ctx.batchId]) : null;
    if (facts) entry['source'] = facts;
    const authorisation = uuidOf(data['authorisation']);
    if (authorisation && filled.includes('authorisedBy')) {
      const a = await one<{ signedBy?: string }>(ctx.client, 'select recipe.reprocessing_authorisation_facts($1::uuid) as r', [authorisation]);
      if (a?.signedBy) entry['authorisedBy'] = a.signedBy;
    }
  }
  if (entryKind === 'FIRST_PRINT' && filled.includes('job') && typeof data['device'] === 'string') {
    const job = await one<string>(
      ctx.client,
      `select j.id as r from tab.print_job j join tab.print_job_ack a on a.job_id = j.id and a.result = 'LOADED'
        where j.batch_id = $1 and j.step_key = $2 and j.config_device = $3
          and not exists (select 1 from tab.print_job_void v where v.job_id = j.id)
        order by j.released_at desc, j.id desc limit 1`,
      [ctx.batchId, ctx.stepKey, data['device']],
    );
    if (job) entry['job'] = job;
  }
  return entry as Record<string, unknown> & { kind: string };
}
