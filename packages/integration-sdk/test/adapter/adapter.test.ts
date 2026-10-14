/**
 * The adapter contracts (Phase 6 slice 6a-0): the envelope, the retry rule, the reconciliation checksum and the system
 * contracts. The database checks the same envelope again (packages/kernel/test/inbound).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CLASSES,
  InboundEnvelope,
  SOURCE_SYSTEMS,
  SYSTEM_CONTRACTS,
  ackAction,
  classifyFailure,
  payloadSchema,
  rawPayloadHash,
  reconciliationChecksum,
  retryDelayMs,
  schemaRows,
} from '@ebmr/integration-sdk/adapter';

const raw = JSON.stringify({ orderNumber: 'PO-1', productCode: 'P1', plannedQuantity: { value: '100', unit: 'kg' }, bom: [{ materialCode: 'M1', quantity: { value: '1.5', unit: 'kg' } }], plannedStart: '1760000000000000' });
const envelope = {
  sourceSystem: 'ERP_WMS',
  messageType: 'erp.production_order',
  sourceRecordId: 'PO-1',
  sourceTimestamp: '1760000000000000',
  sequenceNo: '1',
  idempotencyKey: 'erp-PO-1-v1',
  schemaVersion: '1',
  payloadHash: rawPayloadHash(raw),
  payload: JSON.parse(raw) as Record<string, unknown>,
};

describe('inbound envelope', () => {
  it('[DI-31] a complete envelope parses and its payload matches the ERP order schema', () => {
    const e = InboundEnvelope.parse(envelope);
    const schema = payloadSchema(SYSTEM_CONTRACTS.ERP_WMS, e);
    expect(schema?.safeParse(e.payload).success).toBe(true);
  });

  it('[DI-31] an envelope without a field, with a number for text or an extra field is malformed', () => {
    const { idempotencyKey: _k, ...missing } = envelope;
    void _k;
    expect(InboundEnvelope.safeParse(missing).success).toBe(false);
    expect(InboundEnvelope.safeParse({ ...envelope, sequenceNo: 1 }).success).toBe(false);
    expect(InboundEnvelope.safeParse({ ...envelope, sequenceNo: '0' }).success).toBe(false);
    expect(InboundEnvelope.safeParse({ ...envelope, payloadHash: 'ABC' }).success).toBe(false);
    expect(InboundEnvelope.safeParse({ ...envelope, extra: 1 }).success).toBe(false);
    expect(InboundEnvelope.safeParse({ ...envelope, sourceSystem: 'SAP' }).success).toBe(false);
  });

  it('[DI-31] a payload value travels as decimal text with its unit, never as a JSON number', () => {
    const order = SYSTEM_CONTRACTS.ERP_WMS.inbound['erp.production_order']?.versions['1'];
    expect(order?.safeParse({ ...envelope.payload, plannedQuantity: { value: 100, unit: 'kg' } }).success).toBe(false);
  });

  it('[meta] the raw payload hash is the SHA-256 of the bytes received', () => {
    expect(rawPayloadHash(raw)).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
  });
});

describe('acknowledgment and retry rule', () => {
  it('[DI-31] only TRANSPORT is retried; every other class is recorded and negatively acknowledged', () => {
    for (const c of ERROR_CLASSES) expect(ackAction({ errorClass: c })).toBe(c === 'TRANSPORT' ? 'RETRY' : 'RECORD_REFUSAL_THEN_NACK');
    expect(ackAction({ outcome: 'ACCEPTED' })).toBe('ACK');
    expect(ackAction({ outcome: 'DUPLICATE' })).toBe('ACK');
  });

  it('[meta] back-off doubles from 1 s and stops growing at 5 minutes, without a limit on attempts', () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000]);
    expect(retryDelayMs(10_000)).toBe(300_000);
    expect(() => retryDelayMs(0)).toThrow(RangeError);
  });

  it('[meta] failures are classified by kernel code, system code or SQLSTATE; an unknown refusal is not guessed', () => {
    expect(classifyFailure({ ebmrCode: 'EBMR-INT-005' })).toBe('DUPLICATE');
    expect(classifyFailure({ ebmrCode: 'EBMR-SITE-900' }, { 'EBMR-SITE-900': 'WRONG_IDENTITY' })).toBe('WRONG_IDENTITY');
    expect(classifyFailure({ sqlState: '40001' })).toBe('TRANSPORT');
    expect(classifyFailure({ network: true })).toBe('TRANSPORT');
    expect(classifyFailure({ ebmrCode: 'EBMR-XYZ-001', sqlState: 'P0001' })).toBeUndefined();
  });
});

describe('reconciliation checksum', () => {
  it('[DI-31] the checksum is over distinct keys in byte order, so order and resends do not change it', () => {
    const a = { idempotencyKey: 'b', payloadHash: 'a'.repeat(64) };
    const b = { idempotencyKey: 'a', payloadHash: 'b'.repeat(64) };
    const one = reconciliationChecksum([a, b]);
    expect(reconciliationChecksum([b, a, b])).toEqual(one);
    expect(one).toEqual({ count: '2', checksum: createHash('sha256').update(`a|${'b'.repeat(64)}\nb|${'a'.repeat(64)}`).digest('hex') });
    expect(reconciliationChecksum([])).toEqual({ count: '0', checksum: createHash('sha256').update('').digest('hex') });
  });
});

describe('system contracts', () => {
  it('[meta] every source system has a contract whose message types carry its prefix', () => {
    const prefix: Record<string, string[]> = { ERP_WMS: ['erp', 'wms'], QMS: ['qms'], LIMS: ['lims'], LMS: ['lms'], CMMS: ['cmms'], EMS: ['ems'], OPCUA: ['opcua'], L3: ['l3'] };
    for (const s of SOURCE_SYSTEMS) {
      const c = SYSTEM_CONTRACTS[s];
      expect(c.system).toBe(s);
      for (const row of schemaRows(c)) expect(prefix[s]).toContain(row.messageType.split('.')[0]);
    }
  });
});
