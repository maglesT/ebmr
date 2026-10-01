/**
 * The offline true-copy verifier on bundles assembled here, without a database: every refusal the
 * verifier can give is produced by a bundle that differs from a correct one in that respect only, and
 * the test asserts the exact report. The bundles follow the format buildTrueCopyBundle writes (the
 * database-backed tests in true-copy.test.ts build real ones).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_FORMAT,
  omittedTables,
  serializeBundle,
  verifyChainPart,
  verifyRecordsPart,
  verifyTrueCopyBundle,
  verifyTrueCopyBundleText,
  type AuditChainPart,
  type BundleEvent,
  type Manifest,
  type RecordRow,
  type RecordTable,
  type RecordsPart,
  type TrueCopyBundle,
  type VerificationPart,
  type VerificationReport,
} from '../../src/records/true-copy.ts';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const eventHash = (prevHash: string, payload: string): string =>
  createHash('sha256').update(Buffer.from(prevHash, 'hex')).update(payload, 'utf8').digest('hex');

const KEY = 'tc_batch:B1';
const AT = '2026-09-30T10:00:00.123456Z';
const CORRELATION = '6f1c3c1e-0000-4000-8000-000000000001';
const ENTRY = 'stub.entry';
const READING = 'stub.reading';

interface EventSpec {
  action: string;
  table?: string | null;
  recordId?: string | null;
  /** The body as jsonb text (numbers keep their exact text). */
  body?: string;
  /** Payload fields replaced, as JSON text. */
  fields?: Record<string, string>;
  /** The whole payload text instead of the computed one. */
  payload?: string;
  seq?: string;
}

function payloadText(chainKey: string, seq: string, s: EventSpec): string {
  if (s.payload !== undefined) return s.payload;
  const fields: Record<string, string> = {
    seq,
    body: s.body ?? '{}',
    table: JSON.stringify(s.table ?? null),
    action: JSON.stringify(s.action),
    chain_key: JSON.stringify(chainKey),
    record_id: JSON.stringify(s.recordId ?? null),
    recorded_at: JSON.stringify(AT),
    correlation_id: JSON.stringify(CORRELATION),
    ...s.fields,
  };
  return `{${Object.entries(fields)
    .map(([k, v]) => `"${k}": ${v}`)
    .join(', ')}}`;
}

/** A chain whose genesis value, links, hashes, payload fields and head are all correct. */
function chainOf(specs: EventSpec[], chainKey = KEY): AuditChainPart {
  const genesis = sha(`genesis:${chainKey}`);
  let prev = genesis;
  const events = specs.map((s, i): BundleEvent => {
    const seq = s.seq ?? String(i + 1);
    const payload = payloadText(chainKey, seq, s);
    const hash = eventHash(prev, payload);
    const e = { seq, prevHash: prev, hash, recordedAt: AT, correlationId: CORRELATION, action: s.action, tableName: s.table ?? null, recordId: s.recordId ?? null, payload };
    prev = hash;
    return e;
  });
  const last = events[events.length - 1];
  return { chainKey, genesisPrevHash: genesis, events, head: last ? { seq: last.seq, hash: last.hash } : null, checkpoints: [] };
}

const eventAt = (chain: AuditChainPart, index: number): BundleEvent => chain.events[index] as BundleEvent;

const row = (recordId: string, content: string): RecordRow => ({ recordId, sha256: sha(content), content });
const entryTable = (rows: RecordRow[]): RecordTable => ({ table: ENTRY, aggregateColumn: 'batch_id', insertOnly: false, rows });
const readingTable = (rows: RecordRow[]): RecordTable => ({ table: READING, aggregateColumn: 'batch_id', insertOnly: true, rows });
const recordsOf = (tables: RecordTable[], chainKey = KEY): RecordsPart => ({ chainKey, aggregateType: 'tc_batch', aggregateId: 'B1', tables });

/** Row events as the audit trigger writes them: body.new for a mutable row, body.row_hash for an insert-only row. */
const inserted = (table: string, recordId: string, content: string): EventSpec => ({ action: 'INSERT', table, recordId, body: `{"new": ${content}}` });
const insertedOnly = (recordId: string, content: string): EventSpec => ({ action: 'INSERT', table: READING, recordId, body: `{"row_hash": "${sha(content)}"}` });
const updated = (recordId: string, changed: string): EventSpec => ({ action: 'UPDATE', table: ENTRY, recordId, body: `{"new": ${changed}, "old": {}}` });
const deleted = (table: string, recordId: string, content: string): EventSpec => ({ action: 'DELETE', table, recordId, body: `{"old": ${content}}` });

const R1_INSERTED = '{"id": "r1", "value": 12.5030, "batch_id": "B1", "step_ref": "S1"}';
const R1 = '{"id": "r1", "value": 12.5300, "batch_id": "B1", "step_ref": "S1"}';
const R2 = '{"id": "r2", "value": 7.10, "batch_id": "B1"}';
const R3 = '{"id": "r3", "value": 1.0, "batch_id": "B1", "step_ref": "S3"}';

/** The events of a corrected entry (mutable table) and an insert-only reading. */
const SAMPLE_EVENTS: EventSpec[] = [
  inserted(ENTRY, 'r1', R1_INSERTED),
  updated('r1', '{"value": 12.5300}'),
  insertedOnly('r2', R2),
  { action: 'BUSINESS', body: '{"message": "weighing recorded"}' },
];

/** A corrected entry, an insert-only reading, a business event and a checkpoint at seq 2. */
function sample(chainKey = KEY): { records: RecordsPart; chain: AuditChainPart } {
  const chain = chainOf(SAMPLE_EVENTS, chainKey);
  chain.checkpoints = [{ seq: '2', hash: eventAt(chain, 1).hash, eventCount: '2', sealedAt: AT, reason: 'stage closed' }];
  return { records: recordsOf([entryTable([row('r1', R1)]), readingTable([row('r2', R2)])]), chain };
}

const CLEAN: VerificationPart = { verifiedAt: AT, database: [], offline: { ok: true, problems: [] } };

/** A bundle as buildTrueCopyBundle assembles it; `parts` replaces part texts and `edit` changes the manifest before it is hashed. */
function bundleOf(
  records: RecordsPart,
  chain: AuditChainPart,
  opts: { verification?: VerificationPart; parts?: Record<string, string>; edit?: (m: Manifest) => void } = {},
): TrueCopyBundle {
  const parts: Record<string, string> = {
    'records.json': JSON.stringify(records, null, 2),
    'audit-chain.json': JSON.stringify(chain, null, 2),
    'verification.json': JSON.stringify(opts.verification ?? CLEAN, null, 2),
    ...opts.parts,
  };
  const manifest: Manifest = {
    format: BUNDLE_FORMAT,
    chainKey: chain.chainKey,
    aggregateType: records.aggregateType,
    aggregateId: records.aggregateId,
    generatedAt: AT,
    head: chain.head,
    tables: records.tables.map((t) => t.table),
    parts: Object.entries(parts).map(([name, text]) => ({ name, mediaType: 'application/json', bytes: Buffer.byteLength(text, 'utf8'), sha256: sha(text) })),
    hashAlgorithm: 'SHA-256',
    canonicalForm: 'PostgreSQL jsonb text output, UTF-8; event hash = SHA-256(previous hash bytes || payload bytes)',
    rendering: 'JSON only; the PDF/A-3 rendering is added in Phase 4',
  };
  opts.edit?.(manifest);
  const text = JSON.stringify(manifest, null, 2);
  return { format: BUNDLE_FORMAT, manifestSha256: sha(text), manifest: text, parts };
}

function sampleBundle(): TrueCopyBundle {
  const { records, chain } = sample();
  return bundleOf(records, chain);
}

/** The summary of a report that stopped before the bundle could be read. */
const NOTHING_READ: VerificationReport['summary'] = { chainKey: null, events: 0, rows: 0, headSeq: null, manifestSha256: null, omittedTables: [], reference: 'NONE' };

/** The summary of the sample bundle when every part was read. */
const sampleSummary = (bundle: TrueCopyBundle, reference: VerificationReport['summary']['reference'] = 'NONE'): VerificationReport['summary'] => ({
  chainKey: KEY,
  events: 4,
  rows: 2,
  headSeq: '4',
  manifestSha256: bundle.manifestSha256,
  omittedTables: [],
  reference,
});

/** The four top-level fields in the order of the bundle file. */
const fieldsOf = (b: TrueCopyBundle): Record<string, unknown> => ({ format: b.format, manifestSha256: b.manifestSha256, manifest: b.manifest, parts: b.parts });

describe('true-copy bundle file: what the offline verifier refuses before reading the record (groundwork for DI-40, DI-41, DI-46)', () => {
  it('[INV-08] a correct bundle verifies from its text or its bytes, unanchored', () => {
    const bundle = sampleBundle();
    const text = serializeBundle(bundle);
    expect(verifyTrueCopyBundleText(text)).toEqual({ ok: true, problems: [], summary: sampleSummary(bundle) });
    expect(verifyTrueCopyBundleText(Buffer.from(text, 'utf8'))).toEqual({ ok: true, problems: [], summary: sampleSummary(bundle) });
  });

  it('[INV-08] bytes that are not UTF-8 are refused as altered, before the JSON is read', () => {
    const bytes = Buffer.from(serializeBundle(sampleBundle()), 'utf8');
    bytes[bytes.indexOf('12.5300')] = 0xff;
    expect(verifyTrueCopyBundleText(bytes)).toEqual({ ok: false, problems: ['bundle is not valid UTF-8 (bytes altered)'], summary: NOTHING_READ });
  });

  it('[INV-08] a file that is not JSON is refused with the parser message', () => {
    const text = '{"format": ';
    let message = '';
    try {
      JSON.parse(text);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(verifyTrueCopyBundleText(text)).toEqual({ ok: false, problems: [`bundle is not valid JSON: ${message}`], summary: NOTHING_READ });
  });

  it.each([
    ['a list', '[]'],
    ['null', 'null'],
    ['a number', '5'],
    ['a string', '"bundle"'],
  ])('[INV-08] a file holding %s instead of a bundle object is refused', (_, text) => {
    expect(verifyTrueCopyBundleText(`${text}\n`)).toEqual({ ok: false, problems: ['bundle is not a JSON object'], summary: NOTHING_READ });
  });

  it.each<[string, (o: Record<string, unknown>) => Record<string, unknown>, string]>([
    ['an extra field', (o) => ({ ...o, note: 'x' }), 'bundle has unexpected top-level fields (format,manifestSha256,manifest,parts,note)'],
    ['no parts field', ({ format, manifestSha256, manifest }) => ({ format, manifestSha256, manifest }), 'bundle has unexpected top-level fields (format,manifestSha256,manifest)'],
    [
      'its fields in another order',
      ({ format, manifestSha256, manifest, parts }) => ({ manifest, format, manifestSha256, parts }),
      'bundle has unexpected top-level fields (manifest,format,manifestSha256,parts)',
    ],
    ['another format', (o) => ({ ...o, format: 'ebmr.true-copy-bundle/2' }), 'unknown bundle format ebmr.true-copy-bundle/2'],
    ['a manifest hash that is not text', (o) => ({ ...o, manifestSha256: 5 }), 'bundle manifest or manifest hash missing'],
    ['a manifest that is not text', (o) => ({ ...o, manifest: null }), 'bundle manifest or manifest hash missing'],
    ['parts that are null', (o) => ({ ...o, parts: null }), 'bundle parts missing'],
    ['parts that are a list', (o) => ({ ...o, parts: [] }), 'bundle parts missing'],
    ['parts that are text', (o) => ({ ...o, parts: 'records.json' }), 'bundle parts missing'],
    ['a part that is not text', (o) => ({ ...o, parts: { ...(o['parts'] as object), 'records.json': 5 } }), 'bundle part records.json is not text'],
  ])('[INV-08] a bundle file with %s is refused as malformed', (_, change, problem) => {
    const text = `${JSON.stringify(change(fieldsOf(sampleBundle())))}\n`;
    expect(verifyTrueCopyBundleText(text)).toEqual({ ok: false, problems: [problem], summary: NOTHING_READ });
  });

  it('[INV-08] a file that reads as the same bundle but is not its canonical serialisation is reported as altered', () => {
    const bundle = sampleBundle();
    const canonical = serializeBundle(bundle);
    for (const text of [`${JSON.stringify(fieldsOf(bundle), null, 1)}\n`, canonical.trimEnd(), `${canonical}\n`]) {
      expect(verifyTrueCopyBundleText(text)).toEqual({
        ok: false,
        problems: ['bundle bytes differ from its canonical serialisation (the file was altered)'],
        summary: sampleSummary(bundle),
      });
    }
  });
});

describe('true-copy manifest and parts (offline verifier)', () => {
  it('[INV-08] a manifest that does not match its SHA-256 is reported, and the summary shows the hash the bundle claims', () => {
    const bundle = { ...sampleBundle(), manifestSha256: sha('another manifest') };
    expect(verifyTrueCopyBundle(bundle)).toEqual({
      ok: false,
      problems: ['manifest SHA-256 does not match the manifest (manifest or its hash altered)'],
      summary: sampleSummary(bundle),
    });
  });

  it('[INV-08][DI-47] a reference from the register or an anchor is matched in either letter case, and each kind of mismatch is named', () => {
    const bundle = sampleBundle();
    const head = sample().chain.head?.hash ?? '';
    const other = sha('another record');
    const notRegistered = 'manifest SHA-256 differs from the expected reference (this is not the registered copy)';
    const notAnchored = 'chain head differs from the expected reference (this is not the anchored record)';
    const cases: [Parameters<typeof verifyTrueCopyBundle>[1], string[], VerificationReport['summary']['reference']][] = [
      [{}, [], 'NONE'],
      [{ manifestSha256: bundle.manifestSha256.toUpperCase() }, [], 'MATCHED'],
      [{ headHash: head.toUpperCase() }, [], 'MATCHED'],
      [{ manifestSha256: bundle.manifestSha256, headHash: head }, [], 'MATCHED'],
      [{ manifestSha256: other }, [notRegistered], 'MISMATCHED'],
      [{ headHash: other }, [notAnchored], 'MISMATCHED'],
      [{ manifestSha256: bundle.manifestSha256, headHash: other }, [notAnchored], 'MISMATCHED'],
      [{ manifestSha256: other, headHash: head }, [notRegistered], 'MISMATCHED'],
      [{ manifestSha256: other, headHash: other }, [notRegistered, notAnchored], 'MISMATCHED'],
    ];
    for (const [expected, problems, reference] of cases) {
      expect(verifyTrueCopyBundle(bundle, expected), JSON.stringify(expected)).toEqual({ ok: problems.length === 0, problems, summary: sampleSummary(bundle, reference) });
    }
  });

  it('[INV-08][DI-47] a bundle of an empty chain verifies without a head, and cannot match an anchored head', () => {
    const bundle = bundleOf(recordsOf([entryTable([]), readingTable([])]), chainOf([]));
    const summary = { chainKey: KEY, events: 0, rows: 0, headSeq: null, manifestSha256: bundle.manifestSha256, omittedTables: [], reference: 'NONE' as const };
    expect(verifyTrueCopyBundleText(serializeBundle(bundle))).toEqual({ ok: true, problems: [], summary });
    expect(verifyTrueCopyBundle(bundle, { headHash: sha('a head') })).toEqual({
      ok: false,
      problems: ['chain head differs from the expected reference (this is not the anchored record)'],
      summary: { ...summary, reference: 'MISMATCHED' },
    });
  });

  it('[INV-08] a manifest that is not JSON is reported, cannot match an anchored head, and nothing else is read', () => {
    const manifest = '{"format": "ebmr.true-copy-bundle/1"';
    const bundle = { ...sampleBundle(), manifest, manifestSha256: sha(manifest) };
    const summary = { ...NOTHING_READ, manifestSha256: sha(manifest) };
    expect(verifyTrueCopyBundle(bundle)).toEqual({ ok: false, problems: ['manifest is not valid JSON'], summary });
    expect(verifyTrueCopyBundle(bundle, { headHash: sample().chain.head?.hash ?? '' })).toEqual({
      ok: false,
      problems: ['chain head differs from the expected reference (this is not the anchored record)', 'manifest is not valid JSON'],
      summary: { ...summary, reference: 'MISMATCHED' },
    });
  });

  it('[INV-08] a manifest that lists no parts is reported for every part of the bundle and every required part', () => {
    const { records, chain } = sample();
    const bundle = bundleOf(records, chain, {
      edit: (m) => {
        delete (m as Partial<Manifest>).parts;
      },
    });
    expect(verifyTrueCopyBundle(bundle)).toEqual({
      ok: false,
      problems: [
        'part records.json is not listed in the manifest',
        'part audit-chain.json is not listed in the manifest',
        'part verification.json is not listed in the manifest',
        'manifest does not list the required part records.json',
        'manifest does not list the required part audit-chain.json',
        'manifest does not list the required part verification.json',
      ],
      summary: sampleSummary(bundle),
    });
  });

  it('[INV-08] a part listed in the manifest but missing from the bundle is reported, and the parts are not read', () => {
    const bundle = sampleBundle();
    const parts = { 'records.json': bundle.parts['records.json'] as string, 'audit-chain.json': bundle.parts['audit-chain.json'] as string };
    expect(verifyTrueCopyBundle({ ...bundle, parts })).toEqual({
      ok: false,
      problems: ['part verification.json listed in the manifest is missing'],
      summary: { ...NOTHING_READ, chainKey: KEY, manifestSha256: bundle.manifestSha256 },
    });
  });

  it('[INV-08] a part whose content no longer matches its SHA-256 is reported, and the parts are not read', () => {
    const bundle = sampleBundle();
    const parts = { ...bundle.parts, 'records.json': (bundle.parts['records.json'] as string).replace('12.5300', '12.5310') };
    expect(verifyTrueCopyBundle({ ...bundle, parts })).toEqual({
      ok: false,
      problems: ['part records.json: SHA-256 does not match the manifest (content altered)'],
      summary: { ...NOTHING_READ, chainKey: KEY, manifestSha256: bundle.manifestSha256 },
    });
  });

  it('[INV-08] a part whose size differs from the manifest is reported', () => {
    const { records, chain } = sample();
    const bundle = bundleOf(records, chain, {
      edit: (m) => {
        const part = m.parts.find((p) => p.name === 'records.json');
        if (part) part.bytes += 1;
      },
    });
    expect(verifyTrueCopyBundle(bundle)).toEqual({ ok: false, problems: ['part records.json: size differs from the manifest'], summary: sampleSummary(bundle) });
  });

  it('[INV-08] a part the manifest does not list is reported, and so is a required part it leaves out', () => {
    const bundle = sampleBundle();
    expect(verifyTrueCopyBundle({ ...bundle, parts: { ...bundle.parts, 'notes.txt': 'see the deviation report' } })).toEqual({
      ok: false,
      problems: ['part notes.txt is not listed in the manifest'],
      summary: sampleSummary(bundle),
    });
    const { records, chain } = sample();
    const unlisted = bundleOf(records, chain, {
      edit: (m) => {
        m.parts = m.parts.filter((p) => p.name !== 'verification.json');
      },
    });
    expect(verifyTrueCopyBundle(unlisted)).toEqual({
      ok: false,
      problems: ['part verification.json is not listed in the manifest', 'manifest does not list the required part verification.json'],
      summary: sampleSummary(unlisted),
    });
  });

  it('[INV-08] a part that is not JSON is reported, and the record is not read', () => {
    const { records, chain } = sample();
    const bundle = bundleOf(records, chain, { parts: { 'verification.json': '{"verifiedAt": ' } });
    expect(verifyTrueCopyBundle(bundle)).toEqual({
      ok: false,
      problems: ['a part is not valid JSON'],
      summary: { ...NOTHING_READ, chainKey: KEY, manifestSha256: bundle.manifestSha256 },
    });
  });

  it('[INV-08] an audit chain or records part of another chain than the manifest names is reported', () => {
    // The chain of batch B2 holding the same events: every part agrees with itself, only the chain key differs.
    const { records } = sample();
    const { chain: otherChain } = sample('tc_batch:B2');
    const foreignChain = bundleOf(records, otherChain, {
      edit: (m) => {
        m.chainKey = KEY;
      },
    });
    expect(verifyTrueCopyBundle(foreignChain)).toEqual({
      ok: false,
      problems: ['parts describe a different chain than the manifest'],
      summary: sampleSummary(foreignChain),
    });
    const { chain } = sample();
    const foreignRecords = bundleOf({ ...records, chainKey: 'tc_batch:B2' }, chain);
    expect(verifyTrueCopyBundle(foreignRecords)).toEqual({
      ok: false,
      problems: ['parts describe a different chain than the manifest'],
      summary: sampleSummary(foreignRecords),
    });
  });

  it('[INV-08] a manifest head other than the chain head is reported', () => {
    const { records, chain } = sample();
    const bundle = bundleOf(records, chain, {
      edit: (m) => {
        m.head = { seq: '3', hash: eventAt(chain, 2).hash };
      },
    });
    expect(verifyTrueCopyBundle(bundle)).toEqual({ ok: false, problems: ['manifest head differs from the chain head'], summary: sampleSummary(bundle) });
  });

  it('[INV-08] what the source database and the builder reported at build time is carried into the report; a passing builder verdict adds nothing', () => {
    const { records, chain } = sample();
    const failed = bundleOf(records, chain, {
      verification: {
        verifiedAt: AT,
        database: [{ seq: '2', problem: 'hash does not match the payload (event altered)' }],
        offline: { ok: false, problems: ['stub.entry row r1: row differs from the state recorded in the audit trail', 'event seq 2: payload time differs from the recorded time'] },
      },
    });
    expect(verifyTrueCopyBundle(failed)).toEqual({
      ok: false,
      problems: [
        'source database reported at build time: seq 2: hash does not match the payload (event altered)',
        'builder reported at build time: stub.entry row r1: row differs from the state recorded in the audit trail',
        'builder reported at build time: event seq 2: payload time differs from the recorded time',
      ],
      summary: sampleSummary(failed),
    });
    // The verifier re-checks the chain and rows itself; the builder's own list is relayed only with its failed verdict.
    const passed = bundleOf(records, chain, { verification: { ...CLEAN, offline: { ok: true, problems: ['checked 2 rows'] } } });
    expect(verifyTrueCopyBundle(passed)).toEqual({ ok: true, problems: [], summary: sampleSummary(passed) });
  });
});

describe('true-copy audit chain re-computed offline (verifyChainPart)', () => {
  it('[INV-08] the sample chain and a chain of more than nine events (sequence numbers of several digits) verify', () => {
    expect(verifyChainPart(sample().chain)).toEqual([]);
    const long = chainOf(Array.from({ length: 12 }, (_, i) => ({ action: 'BUSINESS', body: `{"message": "step ${i + 1}"}` })));
    long.checkpoints = [{ seq: '10', hash: eventAt(long, 9).hash, eventCount: '10', sealedAt: AT, reason: 'stage closed' }];
    expect(verifyChainPart(long)).toEqual([]);
  });

  it('[INV-08] a genesis value of another chain key is reported', () => {
    const { chain } = sample();
    expect(verifyChainPart({ ...chain, genesisPrevHash: sha('genesis:tc_batch:B2') })).toEqual(['genesis value does not belong to this chain key']);
  });

  it('[INV-08] a sequence with a gap, or a sequence number that is not a plain number, is reported', () => {
    expect(verifyChainPart(chainOf([{ action: 'BUSINESS', seq: '2' }]))).toEqual(['event seq 2: expected seq 1 (gap or reordering)']);
    expect(verifyChainPart(chainOf([{ action: 'BUSINESS' }, { action: 'BUSINESS', seq: '3' }]))).toEqual(['event seq 3: expected seq 2 (gap or reordering)']);
    for (const seq of ['x1', '1x', ' 1', '+1']) {
      expect(verifyChainPart(chainOf([{ action: 'BUSINESS', seq, fields: { seq: '1' } }])), seq).toEqual([
        `event seq ${seq}: expected seq 1 (gap or reordering)`,
        `event seq ${seq}: payload seq differs`,
      ]);
    }
  });

  it('[INV-08] an event that does not link to the previous one is reported even when its own hash fits its link', () => {
    const chain = chainOf([{ action: 'BUSINESS' }, { action: 'BUSINESS' }, { action: 'BUSINESS' }]);
    const second = eventAt(chain, 1);
    const third = eventAt(chain, 2);
    second.prevHash = sha('another event');
    second.hash = eventHash(second.prevHash, second.payload);
    third.prevHash = second.hash;
    third.hash = eventHash(third.prevHash, third.payload);
    chain.head = { seq: '3', hash: third.hash };
    expect(verifyChainPart(chain)).toEqual(['event seq 2: previous-hash link broken']);
  });

  it.each(['[1]', '"weighing recorded"', '{"seq": 1', ''])('[INV-08] a payload that is not a JSON object (%s) is reported', (payload) => {
    expect(verifyChainPart(chainOf([{ action: 'BUSINESS', payload }]))).toEqual(['event seq 1: payload is not a JSON object']);
  });

  it.each([
    ['its seq as text', { seq: '"1"' }, 'payload seq differs'],
    ['its seq spelled otherwise', { seq: '1.0' }, 'payload seq differs'],
    ['another seq', { seq: '2' }, 'payload seq differs'],
    ['another chain key', { chain_key: '"tc_batch:B2"' }, 'payload chain key differs'],
    ['another action', { action: '"UPDATE"' }, 'payload action differs'],
    ['another correlation id', { correlation_id: '"6f1c3c1e-0000-4000-8000-000000000002"' }, 'payload correlation id differs'],
    ['another time', { recorded_at: '"2026-09-30T10:00:00.123457Z"' }, 'payload time differs from the recorded time'],
    ['another table', { table: '"stub.reading"' }, 'payload table differs'],
    ['no table', { table: 'null' }, 'payload table differs'],
    ['another record id', { record_id: '"r9"' }, 'payload record id differs'],
  ])('[INV-08] a payload with %s than the event columns is reported', (_, fields, problem) => {
    expect(verifyChainPart(chainOf([{ ...inserted(ENTRY, 'r1', R1), fields }]))).toEqual([`event seq 1: ${problem}`]);
  });

  it('[INV-08] a head that is missing, or names another seq or hash than the last event, is reported; so is a head without events', () => {
    const { chain } = sample();
    const last = eventAt(chain, 3);
    const wrong = ['chain head does not match the last event'];
    expect(verifyChainPart({ ...chain, head: null })).toEqual(wrong);
    expect(verifyChainPart({ ...chain, head: { seq: '3', hash: last.hash } })).toEqual(wrong);
    expect(verifyChainPart({ ...chain, head: { seq: '4', hash: eventAt(chain, 2).hash } })).toEqual(wrong);
    expect(verifyChainPart({ ...chain, events: [], checkpoints: [] })).toEqual(['chain head present but no events']);
    expect(verifyChainPart({ ...chain, events: [], checkpoints: [], head: null })).toEqual([]);
  });

  it('[INV-08] a checkpoint at a seq the chain does not have, with another hash, or with a wrong event count is reported', () => {
    const { chain } = sample();
    const checkpoint = chain.checkpoints[0] as AuditChainPart['checkpoints'][number];
    expect(verifyChainPart({ ...chain, checkpoints: [{ ...checkpoint, seq: '9', eventCount: '9' }] })).toEqual(['checkpoint at seq 9 does not match the chain']);
    expect(verifyChainPart({ ...chain, checkpoints: [{ ...checkpoint, hash: eventAt(chain, 2).hash }] })).toEqual(['checkpoint at seq 2 does not match the chain']);
    expect(verifyChainPart({ ...chain, checkpoints: [{ ...checkpoint, eventCount: '3' }] })).toEqual(['checkpoint at seq 2 has a wrong event count']);
  });
});

describe('true-copy rows checked against the audit chain offline (verifyRecordsPart)', () => {
  const entryCheck = (rows: RecordRow[], events: EventSpec[]) => verifyRecordsPart(recordsOf([entryTable(rows)]), chainOf(events));
  const readingCheck = (rows: RecordRow[], events: EventSpec[]) => verifyRecordsPart(recordsOf([readingTable(rows)]), chainOf(events));

  it('[INV-08] the rows of the sample verify against its chain', () => {
    const { records, chain } = sample();
    expect(verifyRecordsPart(records, chain)).toEqual([]);
  });

  it('[INV-08] row content that is not JSON, or not a row object, is reported', () => {
    expect(entryCheck([row('r1', '{"id": "r1"')], SAMPLE_EVENTS)).toEqual(['stub.entry row r1: content is not valid JSON']);
    expect(entryCheck([row('r1', '["r1"]')], SAMPLE_EVENTS)).toEqual(['stub.entry row r1: content is not a row object']);
  });

  it('[INV-08] a row whose content names another record id or another aggregate is reported', () => {
    const otherId = '{"id": "r9", "value": 7.10, "batch_id": "B1"}';
    expect(readingCheck([row('r2', otherId)], [insertedOnly('r2', otherId)])).toEqual(['stub.reading row r2: record id differs from the row content']);
    const otherBatch = '{"id": "r2", "value": 7.10, "batch_id": "B2"}';
    expect(readingCheck([row('r2', otherBatch)], [insertedOnly('r2', otherBatch)])).toEqual(['stub.reading row r2: row belongs to another aggregate']);
  });

  it('[INV-08] a row without an id column is identified by its aggregate column', () => {
    const header = '{"batch_id": "B1", "label": "batch header"}';
    expect(readingCheck([row('B1', header)], [{ ...insertedOnly('B1', header) }])).toEqual([]);
    expect(readingCheck([row('B2', header)], [{ ...insertedOnly('B2', header) }])).toEqual(['stub.reading row B2: record id differs from the row content']);
  });

  it('[INV-08] a row the chain has no INSERT for is reported as not captured, even when the chain has an UPDATE for it', () => {
    const missing = ['stub.entry row r3: no INSERT event in the chain (row not captured by the audit trail)'];
    expect(entryCheck([row('r3', R3)], SAMPLE_EVENTS)).toEqual(missing);
    expect(entryCheck([row('r3', R3)], [...SAMPLE_EVENTS, updated('r3', '{"value": 1.0}')])).toEqual(missing);
  });

  it('[INV-08] a row the chain records as deleted is reported when it is still in the bundle', () => {
    expect(entryCheck([row('r3', R3)], [inserted(ENTRY, 'r3', R3), deleted(ENTRY, 'r3', R3)])).toEqual(['stub.entry row r3: the chain records this row as deleted']);
  });

  it('[INV-08] an insert-only row with an UPDATE event is reported', () => {
    expect(readingCheck([row('r2', R2)], [insertedOnly('r2', R2), { action: 'UPDATE', table: READING, recordId: 'r2', body: '{"new": {"value": 7.1}}' }])).toEqual([
      'stub.reading row r2: insert-only row has an UPDATE event',
    ]);
  });

  it('[INV-08] a mutable row whose INSERT event carries no row is reported as unreadable', () => {
    expect(entryCheck([row('r3', R3)], [{ action: 'INSERT', table: ENTRY, recordId: 'r3', body: `{"row_hash": "${sha(R3)}"}` }])).toEqual([
      'stub.entry row r3: its audit events cannot be read',
    ]);
  });

  it('[INV-08] an UPDATE that changed no column (no new values) leaves the row state as it was', () => {
    expect(entryCheck([row('r3', R3)], [inserted(ENTRY, 'r3', R3), { action: 'UPDATE', table: ENTRY, recordId: 'r3', body: '{"new": null, "old": null}' }])).toEqual([]);
  });

  it('[INV-08] only INSERT and later UPDATE events build a row state: an UPDATE before the INSERT and the body of a DELETE are not applied', () => {
    expect(entryCheck([row('r3', R3)], [updated('r3', '{"value": 9.9}'), inserted(ENTRY, 'r3', R3)])).toEqual([]);
    expect(entryCheck([row('r3', R3)], [inserted(ENTRY, 'r3', R3), { action: 'DELETE', table: ENTRY, recordId: 'r3', body: '{"new": {"value": 9.9}}' }])).toEqual([
      'stub.entry row r3: the chain records this row as deleted',
    ]);
  });

  it('[INV-08] completeness: a row inserted and not deleted must be in the bundle; a deleted row, or one the chain only updated, need not', () => {
    const { records } = sample();
    const check = (events: EventSpec[]) => verifyRecordsPart(records, chainOf([...SAMPLE_EVENTS, ...events]));
    expect(check([inserted(ENTRY, 'r3', R3), updated('r3', '{"value": 1.5}')])).toEqual(['stub.entry row r3: in the audit trail but missing from the bundle (incomplete copy)']);
    expect(check([insertedOnly('r4', R2)])).toEqual(['stub.reading row r4: in the audit trail but missing from the bundle (incomplete copy)']);
    expect(check([inserted(ENTRY, 'r3', R3), deleted(ENTRY, 'r3', R3)])).toEqual([]);
    expect(check([updated('r3', '{"batch_id": "B1"}'), updated('r3', '{"batch_id": "B2"}')])).toEqual([]);
  });

  it('[INV-08] an event that names no record, or no table, is never taken for a row event', () => {
    const { records } = sample();
    // An INSERT event of a table without a record id is not a row that the bundle misses.
    expect(verifyRecordsPart(records, chainOf([...SAMPLE_EVENTS, { action: 'INSERT', table: READING, recordId: null }]))).toEqual([]);
    // An event without a table does not reach a row, even of a table whose name is the text null.
    const nullNamed: RecordTable = { table: 'null', aggregateColumn: 'batch_id', insertOnly: false, rows: [row('r3', R3)] };
    const chain = chainOf([inserted('null', 'r3', R3), { action: 'DELETE', table: null, recordId: 'r3' }]);
    expect(verifyRecordsPart(recordsOf([nullNamed]), chain)).toEqual([]);
  });
});

describe('[meta] tables named by the audit trail but left out of the bundle (omittedTables)', () => {
  it('[meta] lists each omitted table once, in UTF-16 code-unit order (upper case before lower case), and never a held table or a business event', () => {
    const chain = chainOf(
      ['stub.zeta', 'stub.beta', 'stub.Beta', 'stub.alpha', 'stub.zeta', ENTRY, 'stub.gamma'].map((table, i) => ({ action: 'INSERT', table, recordId: `r${i}` })).concat([{ action: 'BUSINESS' }]),
    );
    expect(omittedTables(recordsOf([entryTable([])]), chain)).toEqual(['stub.Beta', 'stub.alpha', 'stub.beta', 'stub.gamma', 'stub.zeta']);
    expect(omittedTables(recordsOf([entryTable([])]), chainOf([inserted(ENTRY, 'r1', R1)]))).toEqual([]);
  });
});
