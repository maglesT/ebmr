import { describe, expect, it } from 'vitest';
import {
  COATER_TAGS,
  JsonLineFramer,
  PRESS_TAGS,
  ProcessReadingsRequest,
  SetpointAckRequest,
  SetpointDownloadsResponse,
  SimProtocolError,
  encodeSimLine,
  parseSimAnswer,
  parseSimRequest,
  processReadingsProblems,
  setpointAckPath,
  tagSpec,
  type ProcessReading,
} from '../../src/process/index.ts';

const SESSION = '0b6a2b47-91a4-4b1e-8f55-6d7c0a3e2f19';

function reading(overrides: Partial<ProcessReading> = {}): ProcessReading {
  return { deviceSerial: 'PRESS-0001', tag: 'force.main_kN', value: '12.48', unit: 'kN', quality: 'GOOD', sourceTime: '1790584618000000', sequence: '1', kind: 'ACTUAL', ...overrides };
}

describe('process tags', () => {
  it('names the press and coater tags of the 3a interface, with units and decimals', () => {
    expect(PRESS_TAGS.map((t) => t.tag)).toEqual(['turret.speed_rpm', 'force.main_kN', 'force.pre_kN', 'fill.depth_mm', 'tablet.count', 'reject.count', 'stroke.count']);
    expect(COATER_TAGS.map((t) => t.tag)).toEqual(['pan.speed_rpm', 'inlet.temp_C', 'exhaust.temp_C', 'bed.temp_C', 'spray.rate_g_min', 'atomisation.bar', 'airflow.m3_h']);
    expect(tagSpec('stroke.count')).toMatchObject({ unit: 'count', scale: 0, counter: true, setpoint: false });
    expect(tagSpec('inlet.temp_C')).toMatchObject({ unit: 'degC', scale: 1, setpoint: true, equipment: 'COATER' });
    expect(tagSpec('nonsense')).toBeNull();
  });
});

describe('process-readings wire validator', () => {
  it('accepts the wire shape of the 3a interface', () => {
    const body = { sessionId: SESSION, readings: [reading(), reading({ tag: 'stroke.count', value: '1080', unit: 'count', sequence: '2' }), reading({ kind: 'SETPOINT_READBACK', value: '12.50', sequence: '3' })] };
    expect(processReadingsProblems(body)).toBeNull();
    expect(ProcessReadingsRequest.parse(body)).toEqual(body);
  });

  it('refuses a value as a JavaScript number, an exponent, an unknown member, a missing member or an empty batch', () => {
    expect(processReadingsProblems({ sessionId: SESSION, readings: [{ ...reading(), value: 12.48 }] })?.[0]?.path).toBe('readings.0.value');
    expect(processReadingsProblems({ sessionId: SESSION, readings: [reading({ value: '1.2e1' })] })).not.toBeNull();
    expect(processReadingsProblems({ sessionId: SESSION, readings: [{ ...reading(), extra: 1 }] })).not.toBeNull();
    const noQuality: Partial<ProcessReading> = reading();
    delete noQuality.quality;
    expect(processReadingsProblems({ sessionId: SESSION, readings: [noQuality] })).not.toBeNull();
    expect(processReadingsProblems({ sessionId: SESSION, readings: [] })).not.toBeNull();
    expect(processReadingsProblems({ sessionId: 'not-a-uuid', readings: [reading()] })).not.toBeNull();
    expect(processReadingsProblems({ sessionId: SESSION, readings: [reading({ quality: 'FINE' as never })] })).not.toBeNull();
    expect(processReadingsProblems({ sessionId: SESSION, readings: [reading({ kind: 'GUESS' as never })] })).not.toBeNull();
    expect(processReadingsProblems({ sessionId: SESSION, readings: [reading({ sequence: '0' })] })).not.toBeNull();
  });

  it('refuses an unknown tag, another unit, more decimals than the tag carries, a negative count and a read-back of a measured tag', () => {
    const problems = processReadingsProblems({
      sessionId: SESSION,
      readings: [
        reading({ tag: 'force.mian_kN', sequence: '1' }),
        reading({ unit: 'N', sequence: '2' }),
        reading({ value: '12.485', sequence: '3' }),
        reading({ tag: 'reject.count', unit: 'count', value: '-1', sequence: '4' }),
        reading({ tag: 'stroke.count', unit: 'count', value: '7', kind: 'SETPOINT_READBACK', sequence: '5' }),
      ],
    });
    expect(problems?.map((p) => p.path)).toEqual(['readings.0.tag', 'readings.1.unit', 'readings.2.value', 'readings.3.value', 'readings.4.kind']);
  });

  it('refuses a repeated or reordered sequence number of one device within a batch; devices count apart', () => {
    const problems = processReadingsProblems({
      sessionId: SESSION,
      readings: [reading({ sequence: '5' }), reading({ sequence: '5' }), reading({ sequence: '4' }), reading({ deviceSerial: 'COATER-0001', tag: 'inlet.temp_C', unit: 'degC', value: '60.0', sequence: '1' })],
    });
    expect(problems?.map((p) => p.path)).toEqual(['readings.1.sequence', 'readings.2.sequence']);
  });

  it('setpoint downloads and their acknowledgement', () => {
    expect(SetpointDownloadsResponse.parse({ downloads: [{ id: 'd-1', deviceSerial: 'PRESS-0001', tag: 'force.main_kN', value: '14.00', unit: 'kN', batchId: 'ignored' }] }).downloads[0]).toEqual({
      id: 'd-1',
      deviceSerial: 'PRESS-0001',
      tag: 'force.main_kN',
      value: '14.00',
      unit: 'kN',
    });
    expect(SetpointDownloadsResponse.safeParse({ downloads: [{ id: 'd-1', deviceSerial: 'PRESS-0001', tag: 'force.main_kN', value: 14, unit: 'kN' }] }).success).toBe(false);
    expect(SetpointAckRequest.safeParse({ sessionId: SESSION, outcome: 'APPLIED', readback: { value: '14.00', unit: 'kN', sourceTime: '1', sequence: '9' }, message: null }).success).toBe(true);
    expect(SetpointAckRequest.safeParse({ sessionId: SESSION, outcome: 'DONE', readback: null, message: null }).success).toBe(false);
    expect(setpointAckPath('a/b')).toBe('/gw/v1/setpoint-downloads/a%2Fb/ack');
  });
});

describe('ebmr.sim-process.v1 codec', () => {
  it('parses requests and answers, refusing another id, a wrong shape and bytes outside printable ASCII', () => {
    expect(parseSimRequest('{"id":"1","op":"read"}')).toEqual({ id: '1', op: 'read' });
    expect(() => parseSimRequest('{"id":"1","op":"write","tag":"x","value":1}')).toThrow(SimProtocolError);
    const hello = { id: '2', op: 'hello' } as const;
    expect(parseSimAnswer(hello, '{"id":"2","ok":true,"protocol":"ebmr.sim-process.v1","serial":"PRESS-0001","equipment":"PRESS"}')).toMatchObject({ serial: 'PRESS-0001' });
    expect(() => parseSimAnswer(hello, '{"id":"3","ok":true,"protocol":"ebmr.sim-process.v1","serial":"PRESS-0001","equipment":"PRESS"}')).toThrow(/request 3/);
    expect(parseSimAnswer(hello, '{"id":"2","ok":false,"error":"BAD_REQUEST","message":"no"}')).toMatchObject({ ok: false });
    expect(() => parseSimAnswer({ id: '4', op: 'read' }, '{"id":"4","ok":true,"scan":"1","running":true,"values":[{"tag":"t","value":"1\u0007","unit":"u","quality":"GOOD"}],"setpoints":[],"alarms":[]}')).toThrow(SimProtocolError);
    expect(() => parseSimAnswer({ id: '4', op: 'read' }, '{"id":"4","ok":true,"scan":"1","running":true,"values":[{"tag":"t","value":"1","unit":"u","quality":"STALE"}],"setpoints":[],"alarms":[]}')).toThrow(SimProtocolError);
  });

  it('frames LF-ended lines across chunks and sets an over-long line aside', () => {
    const lines: string[] = [];
    const garbage: string[] = [];
    const f = new JsonLineFramer(
      (l) => lines.push(l),
      (g) => garbage.push(g),
    );
    f.push(Buffer.from(encodeSimLine({ a: 1 }).slice(0, 4)));
    f.push(Buffer.from(`${encodeSimLine({ a: 1 }).slice(4)}{"b":2}\r\n`));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    f.push(Buffer.from('x'.repeat(9000)));
    expect(garbage).toHaveLength(1);
  });
});
