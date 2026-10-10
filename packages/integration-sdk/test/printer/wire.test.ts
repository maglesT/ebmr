import { describe, expect, it } from 'vitest';
import {
  PrintJob,
  PrintJobsResponse,
  SIM_PRINTER_PROTOCOL,
  echoMismatches,
  gs1CheckDigit,
  parseSimPrinterAnswer,
  parseSimPrinterRequest,
  printEventsProblems,
  printJobAckPath,
  printJobAckProblems,
  type PrintEvent,
  type PrintFields,
  type SimPrinterRequest,
} from '@ebmr/integration-sdk/printer';
import { SimProtocolError } from '@ebmr/integration-sdk/process';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const fields: PrintFields = { batch: 'B2610-001', mfgDate: '2026-10-01', expiryDate: '2028-09', gtin: '08901234567890' };
const event = (over: Partial<PrintEvent> = {}): PrintEvent => ({ deviceSerial: 'PRN-0001', jobId: 'J-1', kind: 'PRINTED_COUNT', value: '12', sourceTime: '1790584618000000', sequence: '1', ...over });

describe('printer wire contract', () => {
  it('accepts a print job with the record fields and refuses a malformed date, GTIN check digit or unknown field', () => {
    const job = { id: 'J-1', deviceSerial: 'PRN-0001', packagingOrder: 'PO-1', artworkSet: 'ART-EU-3', fields, layoutRef: 'CARTON-EU-v3' };
    expect(PrintJob.safeParse(job).success).toBe(true);
    expect(PrintJobsResponse.safeParse({ jobs: [job, { id: 'J-2', anything: true }] }).success).toBe(true);
    expect(PrintJob.safeParse({ ...job, fields: { ...fields, expiryDate: '2028-02-30' } }).success).toBe(false);
    expect(PrintJob.safeParse({ ...job, fields: { ...fields, mfgDate: '01/10/2026' } }).success).toBe(false);
    expect(PrintJob.safeParse({ ...job, fields: { ...fields, gtin: '08901234567891' } }).success).toBe(false);
    expect(PrintJob.safeParse({ ...job, fields: { ...fields, lot: 'X' } }).success).toBe(false);
    expect(PrintJob.safeParse({ ...job, fields: { ...fields, mrp: '125.505' } }).success).toBe(false);
    expect(PrintJob.safeParse({ ...job, fields: { ...fields, mrp: '125.50', ndc: '12345-678-90' } }).success).toBe(true);
    expect(gs1CheckDigit('0890123456789')).toBe(0);
    expect(printJobAckPath('J/1')).toBe('/gw/v1/print-jobs/J%2F1/ack');
  });

  it('names every field whose echo differs from the job, an absent optional field included', () => {
    expect(echoMismatches(fields, { ...fields })).toEqual([]);
    expect(echoMismatches(fields, { ...fields, expiryDate: '2029-09' })).toEqual(['expiryDate']);
    const withoutGtin: PrintFields = { batch: fields.batch, mfgDate: fields.mfgDate, expiryDate: fields.expiryDate };
    expect(echoMismatches(fields, { ...withoutGtin, mrp: '10' })).toEqual(['mrp', 'gtin']);
  });

  it('checks an acknowledgement: LOADED carries the echo and no message, MISMATCH both, FAILED a message', () => {
    const base = { sessionId: SESSION, sourceTime: '1790584618000000' };
    expect(printJobAckProblems({ ...base, outcome: 'LOADED', echoedFields: fields, message: null })).toBeNull();
    expect(printJobAckProblems({ ...base, outcome: 'MISMATCH', echoedFields: fields, message: 'expiryDate differs' })).toBeNull();
    expect(printJobAckProblems({ ...base, outcome: 'FAILED', echoedFields: null, message: 'offline' })).toBeNull();
    expect(printJobAckProblems({ ...base, outcome: 'LOADED', echoedFields: null, message: null })?.map((p) => p.path)).toEqual(['echoedFields']);
    expect(printJobAckProblems({ ...base, outcome: 'FAILED', echoedFields: null, message: null })?.map((p) => p.path)).toEqual(['message']);
    expect(printJobAckProblems({ ...base, outcome: 'LOADED', echoedFields: fields, message: null, extra: 1 })).not.toBeNull();
  });

  it('[DI-31] refuses a print events batch with a malformed value, a missing job, or a repeated or reordered sequence', () => {
    expect(printEventsProblems({ sessionId: SESSION, events: [event(), event({ kind: 'VISION_RESULT', value: 'PASS', sequence: '2' }), event({ kind: 'FAULT', value: 'OFFLINE', jobId: null, sequence: '3' })] })).toBeNull();
    expect(printEventsProblems({ sessionId: SESSION, events: [event({ value: '12.5' })] })?.map((p) => p.path)).toEqual(['events.0.value']);
    expect(printEventsProblems({ sessionId: SESSION, events: [event({ value: 12 as unknown as string })] })).not.toBeNull();
    expect(printEventsProblems({ sessionId: SESSION, events: [event({ kind: 'READER_RESULT', value: 'OK' })] })?.map((p) => p.path)).toEqual(['events.0.value']);
    expect(printEventsProblems({ sessionId: SESSION, events: [event({ kind: 'CHALLENGE_RESULT', value: 'PASS', jobId: null })] })?.map((p) => p.path)).toEqual(['events.0.jobId']);
    expect(printEventsProblems({ sessionId: SESSION, events: [event({ kind: 'FAULT', value: 'offline' })] })?.map((p) => p.path)).toEqual(['events.0.value']);
    expect(printEventsProblems({ sessionId: SESSION, events: [event({ sequence: '2' }), event({ sequence: '2' })] })?.map((p) => p.path)).toEqual(['events.1.sequence']);
    expect(printEventsProblems({ sessionId: SESSION, events: [event({ sequence: '3' }), event({ sequence: '2' })] })?.map((p) => p.path)).toEqual(['events.1.sequence']);
    expect(printEventsProblems({ sessionId: SESSION, events: [] })).not.toBeNull();
    expect(printEventsProblems({ sessionId: 'nope', events: [event()] })).not.toBeNull();
  });

  it('codes the printer simulator protocol and refuses anything else, an answer to another request included', () => {
    const load = parseSimPrinterRequest(JSON.stringify({ id: '2', op: 'load', job: { jobId: 'J-1', layoutRef: 'L', fields } }));
    expect(load.op).toBe('load');
    expect(() => parseSimPrinterRequest('{"id":"1","op":"print"}')).toThrow(SimProtocolError);
    const hello: SimPrinterRequest = { id: '1', op: 'hello' };
    expect(parseSimPrinterAnswer(hello, JSON.stringify({ id: '1', ok: true, protocol: SIM_PRINTER_PROTOCOL, serial: 'PRN-0001', boot: '1' }))).toMatchObject({ serial: 'PRN-0001' });
    expect(() => parseSimPrinterAnswer(hello, JSON.stringify({ id: '9', ok: true, protocol: SIM_PRINTER_PROTOCOL, serial: 'PRN-0001', boot: '1' }))).toThrow(/request 9/);
    expect(() => parseSimPrinterAnswer({ id: '3', op: 'read' }, JSON.stringify({ id: '3', ok: true, scan: '1', running: true, jobId: null, printed: 1 }))).toThrow(SimProtocolError);
    expect(parseSimPrinterAnswer({ id: '4', op: 'events', after: '0' }, JSON.stringify({ id: '4', ok: false, error: 'NO_JOB', message: 'x' }))).toMatchObject({ ok: false });
    expect(() => parseSimPrinterAnswer(hello, '{"id":"1",\u0007}')).toThrow(/printable/);
  });
});
