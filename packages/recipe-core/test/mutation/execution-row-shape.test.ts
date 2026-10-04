/**
 * The functions behind the execution store's row-shape triggers, rule by rule (SQL mutation group
 * "execution-row-shape": recipe-core 0335, 0336 and 0337). These tests close the gaps the SQL mutation run
 * (tools/sql-mutation, batch 2) found in test/execution/entry-data-sql.test.ts (round 7) and in the server's
 * db-guards-row-shape.test.ts:
 *   - recipe.command_member_problem: a whole number is one the engine's codec reads (a safe integer), a microsecond
 *     count is exactly {"$u": digits}, a value or a source names one of its kinds or modes (the refusal says which),
 *     and a shape that declares no members admits none;
 *   - recipe.block_schema_container_problem: a map a block schema declares (record) is read value by value, and only
 *     the members a schema declares are read (0332's walk refuses the others);
 *   - recipe.row_evidence_problem: the evidence a row may carry is set by its kind, its command type and its entry's
 *     kind: no signature evidence on a command the server does not sign through the signature ceremony, an entry read
 *     only on a RECORD_ENTRY, and the evidence of an entry of a kind no block version records left to 0332;
 *   - recipe.execution_row_problem: a command whose type is no text names none, a row with no command id is refused,
 *     and every approval's signature of an ABORT_BATCH is read;
 *   - recipe.issue_request_problem: every input of the MBR is given as its declared type (each of the six value
 *     types, as the engine reads it at issue), and a variant or an input that declares no list of values or categories
 *     accepts none.
 *
 * Controls: DI-05, DI-10, DI-30, DI-34, DI-35, DI-37, PR-18, PR-19, PR-20. The functions are private to the owner; the
 * tests call them as the superuser, as the module tests do, with the row arguments the trigger passes (a sandbox batch of
 * package PKG, room DISP-1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { validateSchema, type FieldSchema } from '../../src/blocks/schema.ts';
import { decode, encode, IssueRefusedError, issue, type IssueRequest } from '../../src/engine/index.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { define, SUP1, T0 } from '../engine/support.ts';
import { mbrWith, phase } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

/** The single value `sql` selects (as `p`), with its parameters. */
async function value<T>(sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await db.admin.query<{ p: T | null }>(sql, params);
  return rows[0]?.p ?? null;
}

const PKG = 'a'.repeat(64);
const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** recipe.execution_row_problem (0335) of a row of a sandbox batch of package PKG in room DISP-1, as zz_execution_row_shape asks it. */
const rowProblem = (kind: string, commandId: string | null, command: unknown, accepted: boolean, evidence: unknown = {}) =>
  value<string>("select recipe.execution_row_problem($1, $2, $3::jsonb, $4, $5::jsonb, 'DISP-1', $6, 'SANDBOX') as p", [kind, commandId, JSON.stringify(command), accepted, JSON.stringify(evidence), PKG]);
/** recipe.row_evidence_problem (0335) of the same row. */
const evidenceProblem = (kind: string, command: unknown, accepted: boolean, evidence: unknown) =>
  value<string>("select recipe.row_evidence_problem($1, $2::jsonb, $3, $4::jsonb, 'DISP-1', $5, 'SANDBOX') as p", [kind, JSON.stringify(command), accepted, JSON.stringify(evidence), PKG]);
/** recipe.command_member_problem (0335): value `v` at `path` against command shape `shape`. */
const memberProblem = (shape: unknown, v: unknown, path: string) =>
  value<string>('select recipe.command_member_problem($1::jsonb, $2::jsonb, $3, false) as p', [JSON.stringify(shape), JSON.stringify(v), path]);
/** recipe.block_schema_container_problem (0335) and recipe.block_schema_unknown_member (0332): value `v` at `path` against block schema `schema`. */
const containerProblem = (schema: unknown, v: unknown, path: string) =>
  value<string>('select recipe.block_schema_container_problem($1::jsonb, $2::jsonb, $3) as p', [JSON.stringify(schema), JSON.stringify(v), path]);
const unknownMember = (schema: unknown, v: unknown, path: string) =>
  value<string>('select recipe.block_schema_unknown_member($1::jsonb, $2::jsonb, $3) as p', [JSON.stringify(schema), JSON.stringify(v), path]);
/** recipe.issue_request_problem (0337): request `request` against MBR content `content`. */
const issueProblem = (content: unknown, request: unknown) =>
  value<string>('select recipe.issue_request_problem($1::jsonb, $2::jsonb) as p', [JSON.stringify(content), JSON.stringify(request)]);

/** A block schema as recipe.block_data_schema stores it (0332: descriptions left out). */
const stored = (s: FieldSchema): Json => JSON.parse(JSON.stringify(s, (k, v: unknown) => (k === 'description' ? undefined : v))) as Json;

const actor = { id: UUID(1), kind: 'PERSON', roles: ['PRODUCTION_OPERATOR'] };
const approver = { id: UUID(5), kind: 'PERSON', roles: ['PRODUCTION_SUPERVISOR'] };
const qa = { id: UUID(6), kind: 'PERSON', roles: ['QA'] };
const base = { commandId: UUID(3), actor, expectedVersion: 4 };
const key = { idempotencyKey: UUID(30) };
const clearance = { ...base, type: 'RECORD_ENTRY', step: 'p-disp-clear', context: [], entry: { kind: 'CLEARANCE_CHECK', answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'CONFIRMED' }] } };
const prepare = { type: 'PREPARE', target: { type: 'SIGN_PERFORMED', step: 'p-disp-pcm', context: [] }, actor, meaning: 'PERFORMED' };
const issueCommand = { type: 'ISSUE', request: encode({ batchId: UUID(2), batchNumber: 'TEST-B26-0001', batchSize: 'BS-1', marketSet: ['IN'], inputs: {}, issuedBy: actor }) };

describe('the command shape reader (recipe.command_member_problem, 0335)', () => {
  it('[DI-05][DI-30] a whole number is a JSON number the engine\'s codec reads as one, a safe integer: a fraction, or a number beyond 9007199254740991 either way, is refused; the bounds themselves are recorded', async () => {
    const choose = (count: number, expectedVersion = 4) => ({ ...base, expectedVersion, type: 'CHOOSE_REPLICATE_COUNT', construct: 'rep', context: [], count, reason: 'r' });
    const numbers = [0, 2, -3, 9007199254740991, -9007199254740991, 1.5, 0.5, -2.25, 9007199254740992, -9007199254740992, 1e21];
    const codec = (n: number): string | null => {
      try {
        decode(n);
        return null;
      } catch {
        return 'refused';
      }
    };
    const got: Record<string, [string | null, string | null]> = {};
    const want: Record<string, [string | null, string | null]> = {};
    for (const n of numbers) {
      got[String(n)] = [await rowProblem('COMMAND', UUID(3), choose(n), true), await rowProblem('COMMAND', UUID(3), choose(n), false)];
      const verdict = Number.isSafeInteger(n) ? null : 'command.count must be a whole number';
      want[String(n)] = [verdict, verdict];
      // The codec the engine decodes a row's command with reads the same numbers as whole.
      expect(codec(n) === null, String(n)).toBe(verdict === null);
    }
    expect(got).toEqual(want);
    // The version a command was sent at, read the same way.
    expect([await rowProblem('COMMAND', UUID(3), choose(2, 9007199254740991), true), await rowProblem('COMMAND', UUID(3), choose(2, 9007199254740992), true), await rowProblem('COMMAND', UUID(3), choose(2, 4.5), true)]).toEqual([
      null,
      'command.expectedVersion must be a whole number',
      'command.expectedVersion must be a whole number',
    ]);
  });

  it('[DI-05][DI-30] a microsecond count is exactly the codec\'s {"$u": "<digits>"}: digits with a letter, a fraction, a sign other than minus, a blank, a space, a leading zero or an exponent are refused, as the codec refuses them', async () => {
    const recorded = (us: unknown) => ({ ...base, type: 'RECORD_DATA', step: 's', context: [], item: 'x', value: { kind: 'TEXT', value: 't' }, source: { mode: 'MANUAL' }, occurredAt: { us, trust: 'DEVICE_SYNCED' } });
    const texts = ['1800000000000000', '0', '-5', '-0', '12a', '1.5', '+1', '', '007', ' 1', '1e3', '0x10'];
    const codec = (t: string): string | null => {
      try {
        decode({ $u: t });
        return null;
      } catch {
        return 'refused';
      }
    };
    const got: Record<string, string | null> = {};
    const want: Record<string, string | null> = {};
    for (const t of texts) {
      got[t] = await rowProblem('COMMAND', UUID(3), recorded({ $u: t }), true);
      want[t] = codec(t) === null ? null : 'command.occurredAt.us must be a microsecond count ({"$u": "<digits>"})';
    }
    expect(got).toEqual(want);
    expect(Object.values(want).filter((p) => p === null)).toHaveLength(4);
  });

  it('[DI-05][DI-30] a value names one of the engine\'s value kinds and a source one of its modes; a value or a source naming none, another one or one that is no text is refused with the kinds or modes it may name, accepted or refused, in a correction and in an issue request\'s input as well', async () => {
    const data = (v: unknown, source: unknown = { mode: 'MANUAL' }) => ({ ...base, type: 'RECORD_DATA', step: 's', context: [], item: 'x', value: v, source });
    const correction = (v: unknown) => ({
      ...base, commandId: UUID(6), type: 'CORRECT_ENTRY', point: 'DP-1', value: v, reason: 'typing error', signature: { id: UUID(22), meaning: 'CORRECTED', signer: actor.id },
      approval: { approver, signature: { id: UUID(23), meaning: 'CORRECTION_APPROVED', signer: approver.id } },
    });
    const issued = (v: unknown) => ({ ...issueCommand, request: { ...(issueCommand.request as Json), inputs: { n: { value: v, source: 'Batch header, entered at issue by TEST-ISSUER' } } } });
    const kinds = 'must be one of BOOLEAN, CATEGORY, COUNT, DECIMAL, INSTANT, SERIES, TEXT';
    const modes = 'must be one of AUTOMATION, BLOCK, DEVICE, LIMS, MANUAL, SCAN';
    const cases: Record<string, [string, string, unknown, Json, string | null]> = {
      text: ['COMMAND', UUID(3), data({ kind: 'TEXT', value: 't' }), {}, null],
      noKind: ['COMMAND', UUID(3), data({ value: '1' }), {}, `command.value.kind ${kinds}`],
      otherKind: ['COMMAND', UUID(3), data({ kind: 'L2409-0017', value: '1' }), {}, `command.value.kind ${kinds}`],
      kindNumber: ['COMMAND', UUID(3), data({ kind: 5, value: '1' }), {}, `command.value.kind ${kinds}`],
      noMode: ['COMMAND', UUID(3), data({ kind: 'TEXT', value: 't' }, { code: 'TEST-PUNCH-01' }), {}, `command.source.mode ${modes}`],
      otherMode: ['COMMAND', UUID(3), data({ kind: 'TEXT', value: 't' }, { mode: 'L2409-0017' }), {}, `command.source.mode ${modes}`],
      modeList: ['COMMAND', UUID(3), data({ kind: 'TEXT', value: 't' }, { mode: ['MANUAL'] }), {}, `command.source.mode ${modes}`],
      correction: ['COMMAND', UUID(6), correction({ kind: 'DECIMAL', value: '15', unit: 'min' }), {}, null],
      correctionKind: ['COMMAND', UUID(6), correction({ kind: 'L2409-0017', value: '15' }), {}, `command.value.kind ${kinds}`],
      issue: ['ISSUE', `ISSUE:${UUID(2)}`, issued({ kind: 'COUNT', value: '100000' }), { packageHash: PKG }, null],
      issueKind: ['ISSUE', `ISSUE:${UUID(2)}`, issued({ value: '100000' }), { packageHash: PKG }, `command.request.inputs.n.value.kind ${kinds}`],
    };
    const got: Record<string, [string | null, string | null]> = {};
    for (const [n, [kind, id, command, evidence]] of Object.entries(cases)) got[n] = [await rowProblem(kind, id, command, true, evidence), kind === 'COMMAND' ? await rowProblem(kind, id, command, false, evidence) : null];
    expect(got).toEqual(Object.fromEntries(Object.entries(cases).map(([n, c]) => [n, [c[4], c[0] === 'COMMAND' ? c[4] : null]])));
  });

  it('[DI-05][DI-30] an object a shape declares without members admits none, at the top or nested: every member it holds is refused by name, and an empty one passes', async () => {
    expect([
      await memberProblem({ t: 'object', of: 'a probe' }, { lotNumber: 'L2409-0017' }, 'probe'),
      await memberProblem({ t: 'object', of: 'a probe' }, { b: 1, a: 2 }, 'probe'),
      await memberProblem({ t: 'object', of: 'a probe', fields: { inner: { t: 'object' } } }, { inner: { lot: 'L2409-0017' } }, 'command'),
      await memberProblem({ t: 'object', of: 'a probe' }, {}, 'probe'),
      await memberProblem({ t: 'object', of: 'a probe', fields: { inner: { t: 'object' } } }, { inner: {} }, 'command'),
    ]).toEqual(['probe.lotNumber is a member a probe does not declare', 'probe.a is a member a probe does not declare', 'command.inner.lot is a member command.inner does not declare', null, null]);
  });
});

describe('a refused row\'s entry and start data against block schemas (recipe.block_schema_container_problem, 0335)', () => {
  it('[DI-05][DI-30] a map a block schema declares (record) has every one of its values read, whatever its place: a list or an object where a single value is declared, or a text where an object is, is refused at its own key, as the engine\'s validateSchema finds it; a map of the declared kinds passes', async () => {
    const text = (d: string): FieldSchema => ({ type: 'string', description: d });
    const schema: FieldSchema = {
      type: 'object',
      description: 'an entry with maps',
      fields: {
        expected: { type: 'record', optional: true, description: 'expected answer per item', values: text('answer') },
        items: { type: 'record', optional: true, description: 'items by id', values: { type: 'object', description: 'item', fields: { v: text('v') } } },
      },
    };
    const cases: Record<string, [unknown, string | null]> = {
      honest: [{ expected: { A: 'PASS', B: 'FAIL' }, items: { a: { v: 'x' }, b: { v: 'y' } } }, null],
      lastValueList: [{ expected: { A: 'PASS', B: ['L2409-0017'] } }, 'command.entry.expected.B must be a single value (a text, a number, true or false), not a list'],
      firstValueList: [{ expected: { A: ['L2409-0017'], B: 'PASS' } }, 'command.entry.expected.A must be a single value (a text, a number, true or false), not a list'],
      middleValueObject: [{ expected: { A: 'PASS', B: { lot: 'L2409-0017' }, C: 'PASS' } }, 'command.entry.expected.B must be a single value (a text, a number, true or false), not an object'],
      mapText: [{ expected: 'L2409-0017' }, 'command.entry.expected must be an object'],
      itemText: [{ items: { a: { v: 'x' }, b: 'L2409-0017' } }, 'command.entry.items.b must be an object'],
      itemMemberList: [{ items: { a: { v: 'x' }, b: { v: ['L2409-0017'] } } }, 'command.entry.items.b.v must be a single value (a text, a number, true or false), not a list'],
    };
    const got: Record<string, string | null> = {};
    for (const [n, [v]] of Object.entries(cases)) {
      got[n] = await containerProblem(stored(schema), v, 'command.entry');
      // The engine refuses the same place (with its own words) and passes the honest map.
      const engine = validateSchema(schema, v, 'command.entry').map((p) => p.path);
      const at = got[n]?.split(' must ')[0];
      expect(at === undefined ? engine : engine.includes(at), n).toEqual(at === undefined ? [] : true);
    }
    expect(got).toEqual(Object.fromEntries(Object.entries(cases).map(([n, c]) => [n, c[1]])));
  });

  it('[DI-05][DI-30] only the members a block schema declares are read for their type there: an object that declares none has none read, and 0332\'s walk refuses each member it holds as unknown', async () => {
    const value = { a: { lot: 'L2409-0017' } };
    expect([
      await containerProblem({ type: 'object' }, value, 'command.entry'),
      await unknownMember({ type: 'object' }, value, 'command.entry'),
      await containerProblem({ type: 'object', fields: { a: { type: 'string' } } }, value, 'command.entry'),
      await containerProblem({ type: 'object', fields: { b: { type: 'object', fields: {} } } }, { a: ['L2409-0017'], b: {} }, 'command.entry'),
    ]).toEqual([
      null,
      'command.entry.a is not a field of this block (unknown fields are refused)',
      'command.entry.a must be a single value (a text, a number, true or false), not an object',
      null,
    ]);
  });
});

describe('the evidence a row records (recipe.row_evidence_problem, 0335)', () => {
  const lot = { id: 'TEST-L26-0101', material: 'MAT-PCM', status: 'RELEASED', expiresAtUs: '1900000000000000', identityTested: true };
  const lotEvidence = { code: lot.id, material: lot.material, status: lot.status };
  const manual = { room: 'DISP-1', balance: 'TEST-BAL-01', declaredBalance: null, scales: [{ deviceCode: 'TEST-BAL-01', status: 'OFFLINE', lastHeartbeatUs: '1800000000000000' }] };
  const weighing = { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', container: 'TEST-B26-0001/C1', lot, gross: '26.250', tare: '1.250', unit: 'kg', balance: 'TEST-BAL-01', source: 'MANUAL' };
  const signature = { id: UUID(20), meaning: 'PERFORMED', signer: actor.id };
  const performed = { ...base, commandId: `ESIG:${UUID(20)}`, type: 'SIGN_PERFORMED', step: 'p-disp-pcm', context: [], signature };
  const verify = { ...base, commandId: `ESIG:${UUID(21)}`, type: 'VERIFY', step: 'p-disp-pcm', context: [], signature: { id: UUID(21), meaning: 'VERIFIED', signer: actor.id } };
  const correction = {
    ...base, commandId: UUID(6), type: 'CORRECT_ENTRY', point: 'DP-1', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, reason: 'typing error', signature: { id: UUID(22), meaning: 'CORRECTED', signer: actor.id },
    approval: { approver, signature: { id: UUID(23), meaning: 'CORRECTION_APPROVED', signer: approver.id } },
  };
  const cancel = { ...base, commandId: UUID(7), type: 'CANCEL_BATCH', reason: 'r', signature: { id: UUID(24), meaning: 'BATCH_CANCELLED', signer: actor.id } };
  const start = { ...base, type: 'START_STEP', step: 'p-disp-pcm', context: [] };

  it('[DI-05][DI-30][DI-35][DI-37] a signature id, or the refusal before signing, is evidence only of the commands the server signs through the signature ceremony (a step performed or verified, a hold point, a stage sign-off, an exception\'s disposition): beside a correction, a cancellation, a start or an entry it is refused, though its command carries that signature', async () => {
    const got = {
      performed: await rowProblem('COMMAND', performed.commandId, performed, true, { signatureId: signature.id }),
      verified: await rowProblem('COMMAND', verify.commandId, verify, true, { signatureId: UUID(21) }),
      correction: await rowProblem('COMMAND', UUID(6), correction, true, key),
      correctionSignatureId: await rowProblem('COMMAND', UUID(6), correction, true, { ...key, signatureId: UUID(22) }),
      cancel: await rowProblem('COMMAND', UUID(7), cancel, true, key),
      cancelSignatureId: await rowProblem('COMMAND', UUID(7), cancel, true, { signatureId: UUID(24) }),
      cancelRefusedBeforeSigning: await rowProblem('COMMAND', UUID(7), cancel, false, { signing: 'refused before signing', meaning: 'BATCH_CANCELLED' }),
      startRefusedBeforeSigning: await rowProblem('COMMAND', UUID(3), start, false, { signing: 'refused before signing', meaning: 'PERFORMED' }),
      startSignatureId: await rowProblem('COMMAND', UUID(3), start, true, { signatureId: UUID(20) }),
      clearanceSignatureId: await rowProblem('COMMAND', UUID(3), clearance, true, { signatureId: UUID(25) }),
    };
    expect(got).toEqual({
      performed: null,
      verified: null,
      correction: null,
      correctionSignatureId: 'evidence.signatureId is a member the server does not record with a CORRECT_ENTRY command',
      cancel: null,
      cancelSignatureId: 'evidence.signatureId is a member the server does not record with a CANCEL_BATCH command',
      cancelRefusedBeforeSigning: 'evidence.meaning is a member the server does not record with a CANCEL_BATCH command',
      startRefusedBeforeSigning: 'evidence.meaning is a member the server does not record with a START_STEP command',
      startSignatureId: 'evidence.signatureId is a member the server does not record with a START_STEP command',
      clearanceSignatureId: 'evidence.signatureId is a member the server does not record with a RECORD_ENTRY command of a CLEARANCE_CHECK entry',
    });
  });

  it('[DI-05][DI-30][PR-19] the evidence of an entry of a kind no block version records, or naming no kind, is not read here, accepted or refused: 0332 refuses that row in its own words; the same evidence beside an entry of a kind a block records is refused', async () => {
    const entry = (e: unknown) => ({ ...base, type: 'RECORD_ENTRY', step: 'p-disp-pcm', context: [], entry: e });
    const forged = { ...key, lotNumber: 'L2409-0017' };
    const renamed = entry({ ...weighing, kind: 'CONTAINER_WEIGHING_2' });
    const nameless = entry({ container: 'TEST-B26-0001/C2' });
    expect({
      renamed: await rowProblem('COMMAND', UUID(3), renamed, true, forged),
      renamedRefused: await rowProblem('COMMAND', UUID(3), renamed, false, forged),
      nameless: await rowProblem('COMMAND', UUID(3), nameless, true, forged),
      namelessRefused: await rowProblem('COMMAND', UUID(3), nameless, false, forged),
      weighing: await rowProblem('COMMAND', UUID(3), entry(weighing), true, forged),
      clearance: await rowProblem('COMMAND', UUID(3), clearance, true, forged),
    }).toEqual({
      renamed: null,
      renamedRefused: null,
      nameless: null,
      namelessRefused: null,
      weighing: 'evidence.lotNumber is a member the server does not record with a RECORD_ENTRY command of a CONTAINER_WEIGHING entry',
      clearance: 'evidence.lotNumber is a member the server does not record with a RECORD_ENTRY command of a CLEARANCE_CHECK entry',
    });
    // No block version of this release records those kinds (0332's table of which block records which kind).
    expect(await value<string>("select count(*)::text as p from recipe.block_data_schema where entry_kind in ('CONTAINER_WEIGHING_2', '')", [])).toBe('0');
  });

  it('[DI-05][DI-30][PR-18][PR-20] an entry is read only as the entry of a RECORD_ENTRY command, and only as an object: a weighing\'s evidence beside another command that carries a weighing, or beside an entry that is a text, is refused by what that command records', async () => {
    expect({
      // The honest weighing keyed by hand, for comparison.
      weighing: await evidenceProblem('COMMAND', { ...base, type: 'RECORD_ENTRY', step: 'p-disp-pcm', context: [], entry: weighing }, true, { ...key, manual, lot: lotEvidence }),
      verifyCarryingWeighing: await evidenceProblem('COMMAND', { ...verify, entry: weighing }, true, { manual, lot: lotEvidence }),
      entryText: await evidenceProblem('COMMAND', { ...base, type: 'RECORD_ENTRY', step: 'p-disp-pcm', context: [], entry: 'L2409-0017' }, false, { lotNumber: 'L2409-0017' }),
      prepareCarryingEntry: await evidenceProblem('PREPARE', { ...prepare, entry: { kind: 'L2409-0017' } }, true, { lotNumber: 'L2409-0017' }),
    }).toEqual({
      weighing: null,
      verifyCarryingWeighing: 'evidence.lot is a member the server does not record with a VERIFY command',
      entryText: 'evidence.lotNumber is a member the server does not record with a RECORD_ENTRY command',
      prepareCarryingEntry: 'evidence.lotNumber is a member the server does not record with a preparation for a signature',
    });
    // Through the row check, such commands are refused for their shape before their evidence is read.
    expect(await rowProblem('COMMAND', verify.commandId, { ...verify, entry: weighing }, true, { manual, lot: lotEvidence })).toBe('command.entry is a member a VERIFY command does not declare');
  });
});

describe('a row\'s command, command id and signatures (recipe.execution_row_problem, 0335)', () => {
  it('[DI-05][DI-30] a command whose type is no text names no type, and a row without a command id is refused whatever its kind', async () => {
    expect({
      typeNumber: await rowProblem('COMMAND', UUID(3), { ...clearance, type: 5 }, true, key),
      typeList: await rowProblem('COMMAND', UUID(3), { ...clearance, type: ['RECORD_ENTRY'] }, true, key),
      typeObject: await rowProblem('COMMAND', UUID(3), { ...clearance, type: { type: 'RECORD_ENTRY' } }, false, key),
      typeOther: await rowProblem('COMMAND', UUID(3), { ...clearance, type: 'L2409-0017' }, true, key),
      clearance: await rowProblem('COMMAND', UUID(3), clearance, true, key),
      noId: await rowProblem('COMMAND', null, clearance, true, key),
      noIdRefused: await rowProblem('COMMAND', null, clearance, false, key),
      prepareNoId: await rowProblem('PREPARE', null, prepare, true),
      issueNoId: await rowProblem('ISSUE', null, issueCommand, true, { packageHash: PKG }),
      issue: await rowProblem('ISSUE', `ISSUE:${UUID(2)}`, issueCommand, true, { packageHash: PKG }),
    }).toEqual({
      typeNumber: 'its command is of type (none), which a COMMAND row does not record',
      typeList: 'its command is of type (none), which a COMMAND row does not record',
      typeObject: 'its command is of type (none), which a COMMAND row does not record',
      typeOther: 'its command is of type L2409-0017, which a COMMAND row does not record',
      clearance: null,
      noId: 'its command id (none) is not one the server gives a COMMAND row',
      noIdRefused: 'its command id (none) is not one the server gives a COMMAND row',
      prepareNoId: 'its command id (none) is not one the server gives a PREPARE row',
      issueNoId: 'its command id (none) is not one the server gives a ISSUE row',
      issue: null,
    });
  });

  it('[DI-05][DI-30][DI-35][DI-37] every approval of an abort carries a signature id (or the dry run\'s placeholder), a meaning of the kernel and its approver as the signer, each read at its own place in the list', async () => {
    const approval = (who: typeof approver, id: string) => ({ approver: who, signature: { id, meaning: 'BATCH_ABORT_APPROVED', signer: who.id } });
    const abort = (approvals: unknown[]) => ({ ...base, commandId: UUID(9), type: 'ABORT_BATCH', reason: 'equipment failure', approvals });
    const first = approval(approver, UUID(25));
    const second = approval(qa, UUID(26));
    const sigOf = (a: typeof first, change: Json) => ({ ...a, signature: { ...a.signature, ...change } });
    expect({
      honest: await rowProblem('COMMAND', UUID(9), abort([first, second]), true, key),
      dryRun: await rowProblem('COMMAND', UUID(9), abort([sigOf(first, { id: '$dry-run' }), sigOf(second, { id: '$dry-run' })]), false, key),
      firstId: await rowProblem('COMMAND', UUID(9), abort([sigOf(first, { id: 'L2409-0017' }), second]), true, key),
      secondId: await rowProblem('COMMAND', UUID(9), abort([first, sigOf(second, { id: 'L2409-0017' })]), true, key),
      secondMeaning: await rowProblem('COMMAND', UUID(9), abort([first, sigOf(second, { meaning: 'L2409-0017' })]), true, key),
      secondSigner: await rowProblem('COMMAND', UUID(9), abort([first, sigOf(second, { signer: actor.id })]), true, key),
      none: await rowProblem('COMMAND', UUID(9), abort([]), false, key),
    }).toEqual({
      honest: null,
      dryRun: null,
      firstId: 'command.approvals[0].signature.id must be a signature id, or the placeholder of a dry run',
      secondId: 'command.approvals[1].signature.id must be a signature id, or the placeholder of a dry run',
      secondMeaning: 'command.approvals[1].signature.meaning "L2409-0017" is not a signature meaning of the kernel',
      secondSigner: 'command.approvals[1].signature.signer must be the person who gives it',
      none: null,
    });
  });
});

describe('an issue request its MBR accepts (recipe.issue_request_problem, 0337)', () => {
  const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
  const mbr = (inputs: unknown[], variants: unknown[] = [{ id: 'dest', values: ['DOMESTIC', 'US-EXPORT'] }]): MbrContent => {
    const m = mbrWith(seq('ops', phase('p')), { inputs: inputs as MbrContent['inputs'] });
    m.header.variants = variants as MbrContent['header']['variants'];
    return m;
  };
  const input = (id: string, valueType: string, extra: Json = {}) => ({ id, name: id, source: 'BATCH_HEADER', valueType, ...extra });
  const ALL = mbr([input('dec', 'DECIMAL', { unit: 'kg' }), input('cnt', 'COUNT'), input('flag', 'BOOLEAN'), input('grade', 'CATEGORY', { categories: ['A', 'B'] }), input('note', 'TEXT'), input('at', 'INSTANT')]);
  const given = (v: unknown) => ({ value: v, source: 'Batch header, entered at issue by TEST-ISSUER' });
  const HONEST: IssueRequest['inputs'] = {
    dec: given({ kind: 'DECIMAL', value: '1.5', unit: 'kg' }) as IssueRequest['inputs'][string],
    cnt: given({ kind: 'COUNT', value: '10' }) as IssueRequest['inputs'][string],
    flag: given({ kind: 'BOOLEAN', value: true }) as IssueRequest['inputs'][string],
    grade: given({ kind: 'CATEGORY', value: 'A' }) as IssueRequest['inputs'][string],
    note: given({ kind: 'TEXT', value: 'n' }) as IssueRequest['inputs'][string],
    at: given({ kind: 'INSTANT', us: 1_800_000_000_000_000n }) as IssueRequest['inputs'][string],
  };
  const request = (inputs: IssueRequest['inputs'], variants: Record<string, string> = { dest: 'DOMESTIC' }): IssueRequest => ({
    batchId: UUID(2), batchNumber: 'TEST-B26-0001', batchSize: 'BS', marketSet: ['IN'], variants, inputs, issuedBy: SUP1,
  });
  /** The engine's verdict at issue (engine batch.ts initialState): accepted, or the code it refuses with. */
  const engineVerdict = (content: MbrContent, req: IssueRequest): string => {
    try {
      issue(define(content), req, { nowUs: T0 });
      return 'accepted';
    } catch (e) {
      return e instanceof IssueRefusedError ? e.code : `error ${(e as Error).message}`;
    }
  };

  it('[DI-05][DI-10][DI-34] every input of the MBR is given as its declared type, as the engine reads it at issue: a request giving each of the six types as declared passes, and an input given with another kind, a decimal or count written otherwise, or a category its list does not hold is refused, as the engine refuses it; a decimal, count or category sent as a JSON number is refused as well', async () => {
    const forged: Record<string, [string, unknown]> = {
      decimalMalformed: ['dec', { kind: 'DECIMAL', value: '1.2.3', unit: 'kg' }],
      decimalNegativeZero: ['dec', { kind: 'DECIMAL', value: '-0', unit: 'kg' }],
      decimalAsText: ['dec', { kind: 'TEXT', value: '1.5' }],
      countFraction: ['cnt', { kind: 'COUNT', value: '1.5' }],
      countNegative: ['cnt', { kind: 'COUNT', value: '-1' }],
      countAsDecimal: ['cnt', { kind: 'DECIMAL', value: '100', unit: 'kg' }],
      countAsText: ['cnt', { kind: 'TEXT', value: '100' }],
      booleanAsText: ['flag', { kind: 'TEXT', value: 'true' }],
      categoryNotListed: ['grade', { kind: 'CATEGORY', value: 'L2409-0017' }],
      categoryAsText: ['grade', { kind: 'TEXT', value: 'A' }],
      textAsCategory: ['note', { kind: 'CATEGORY', value: 'A' }],
      instantAsText: ['at', { kind: 'TEXT', value: '2026-10-04T08:00:00Z' }],
    };
    // Values of another JSON type than the engine's DataValue declares (text): stored only past the engine's types, and
    // refused by 0335's shape of an issue request as well.
    const untyped: Record<string, [string, unknown]> = {
      decimalAsNumber: ['dec', { kind: 'DECIMAL', value: 1.5, unit: 'kg' }],
      countAsNumber: ['cnt', { kind: 'COUNT', value: 10 }],
      categoryAsNumber: ['grade', { kind: 'CATEGORY', value: 1 }],
    };
    const typeOf = (id: string): string => String(ALL.inputs.find((i) => i.id === id)?.valueType);
    /** As stored: the honest request encoded, input `id` as sent (the codec encodes no fraction as a number). */
    const sent = (id: string, v: unknown): Json => {
      const r = encode(request(HONEST)) as Json;
      (r['inputs'] as Json)[id] = given(v);
      return r;
    };
    const got: Record<string, [string | null, string]> = { honest: [await issueProblem(ALL, encode(request(HONEST))), engineVerdict(ALL, request(HONEST))] };
    const want: Record<string, [string | null, string]> = { honest: [null, 'accepted'] };
    for (const [n, [id, v]] of Object.entries(forged)) {
      got[n] = [await issueProblem(ALL, sent(id, v)), engineVerdict(ALL, request({ ...HONEST, [id]: given(v) as IssueRequest['inputs'][string] }))];
      want[n] = [`input ${id} is not given as its declared type ${typeOf(id)} (ENG-ISSUE-INPUT)`, 'ENG-ISSUE-INPUT'];
    }
    expect(got).toEqual(want);
    const shape = async (id: string, v: unknown) => rowProblem('ISSUE', `ISSUE:${UUID(2)}`, { type: 'ISSUE', request: sent(id, v) }, true, { packageHash: PKG });
    const untypedGot: Record<string, [string | null, string | null]> = {};
    for (const [n, [id, v]] of Object.entries(untyped)) untypedGot[n] = [await issueProblem(ALL, sent(id, v)), await shape(id, v)];
    expect(untypedGot).toEqual(Object.fromEntries(Object.entries(untyped).map(([n, [id]]) => [n, [`input ${id} is not given as its declared type ${typeOf(id)} (ENG-ISSUE-INPUT)`, `command.request.inputs.${id}.value.value must be a text`]])));
  });

  it('[DI-05][DI-10][DI-34] an input whose MBR declares a category without its list, or a type the engine has not, accepts no value, as the engine accepts none; a variant that declares no list of values accepts no choice', async () => {
    const noCategories = mbr([input('grade', 'CATEGORY')]);
    const otherType = mbr([input('odd', 'L2409-0017')]);
    const noType = mbr([{ id: 'odd', name: 'odd', source: 'BATCH_HEADER' }]);
    const grade = { grade: given({ kind: 'CATEGORY', value: 'A' }) as IssueRequest['inputs'][string] };
    const odd = { odd: given({ kind: 'TEXT', value: 'x' }) as IssueRequest['inputs'][string] };
    expect({
      noCategories: [await issueProblem(noCategories, encode(request(grade))), engineVerdict(noCategories, request(grade))],
      otherType: [await issueProblem(otherType, encode(request(odd))), engineVerdict(otherType, request(odd))],
      noType: await issueProblem(noType, encode(request(odd))),
    }).toEqual({
      noCategories: ['input grade is not given as its declared type CATEGORY (ENG-ISSUE-INPUT)', 'ENG-ISSUE-INPUT'],
      otherType: ['input odd is not given as its declared type L2409-0017 (ENG-ISSUE-INPUT)', 'ENG-ISSUE-INPUT'],
      noType: 'input odd is not given as its declared type (none) (ENG-ISSUE-INPUT)',
    });
    // A variant without its list of values (the engine's MbrContent always has one, so only the database reads this).
    const noValues = mbr([], [{ id: 'dest' }]);
    const emptyValues = mbr([], [{ id: 'dest', values: [] }]);
    const listed = mbr([]);
    expect({
      noValues: await issueProblem(noValues, encode(request({}))),
      emptyValues: await issueProblem(emptyValues, encode(request({}))),
      listed: await issueProblem(listed, encode(request({}))),
      listedOther: await issueProblem(listed, encode(request({}, { dest: 'L2409-0017' }))),
    }).toEqual({
      noValues: 'variant dest of its MBR is not given one of its values (ENG-ISSUE-VARIANT)',
      emptyValues: 'variant dest of its MBR is not given one of its values (ENG-ISSUE-VARIANT)',
      listed: null,
      listedOther: 'variant dest of its MBR is not given one of its values (ENG-ISSUE-VARIANT)',
    });
    expect([engineVerdict(listed, request({})), engineVerdict(emptyValues, request({}))]).toEqual(['accepted', 'ENG-ISSUE-VARIANT']);
  });
});
