/**
 * The OPC UA and EMS contracts (Phase 6 slice 6b-0): status quality, raw values against the shown value (DI-32), the
 * series chunk hash, the node ids derived from the released tag names, the alarm and event shapes (DI-49).
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalDecimal,
  DynamicDataRef,
  EMS,
  EquipmentAlarmV1,
  EquipmentEventV1,
  OPCUA,
  OPCUA_TAG_MAP,
  OpcuaEndpoint,
  opcuaNodeId,
  parseOpcuaNodeId,
  payloadSchema,
  qualityOfStatus,
  schemaRows,
  SeriesChunkV1,
  seriesChunkHash,
  seriesChunkText,
  shownValueProblem,
} from '../../src/adapter/index.ts';
import { PROCESS_TAG_NAMES } from '../../src/process/tags.ts';

const chunk = (over: Partial<SeriesChunkV1> = {}) => {
  const base = {
    subjectKind: 'EQUIPMENT' as const,
    subjectCode: 'PRESS-01',
    tag: 'force.main_kN',
    unit: 'kN',
    chunkNo: '1',
    samples: [
      { sourceTime: '1760000000000000', serverTime: '1760000000000100', raw: '1.25E1', value: '12.50', status: '0x00000000' },
      { sourceTime: '1760000000100000', serverTime: null, raw: '12.6', value: '12.6', status: '0x40000000' },
      { sourceTime: '1760000000200000', serverTime: null, raw: 'NaN', value: null, status: '0x80000000' },
    ],
    ...over,
  };
  return { ...base, chunkHash: over.chunkHash ?? seriesChunkHash(base) };
};

describe('equipment data (6b-0)', () => {
  it('[DI-32] a status code reads GOOD, UNCERTAIN or BAD from its severity bits', () => {
    expect(qualityOfStatus('0x00000000')).toBe('GOOD');
    expect(qualityOfStatus('0x00A80000')).toBe('GOOD');
    expect(qualityOfStatus('0x40920000')).toBe('UNCERTAIN');
    expect(qualityOfStatus('0x80000000')).toBe('BAD');
    expect(qualityOfStatus('0xC0000000')).toBe('BAD');
  });

  it('[DI-32] the shown value must be exactly the raw value the device sent: exponent forms are equal, a rounding is refused', () => {
    expect(canonicalDecimal('1.25E1')).toBe('12.5');
    expect(canonicalDecimal('-0.0')).toBe('0');
    expect(canonicalDecimal('125e-3')).toBe('0.125');
    expect(canonicalDecimal('+007.50')).toBe('7.5');
    expect(canonicalDecimal('abc')).toBeNull();
    expect(shownValueProblem('1.25E1', '12.50')).toBeNull();
    expect(shownValueProblem('12.499', '12.50')).toMatch(/is not the value 12.499 the device sent/);
    expect(shownValueProblem('12.5', '1.25E1')).toMatch(/is not decimal text/);
    expect(shownValueProblem('twelve', '12')).toMatch(/is not a number/);
  });

  it('[DI-32] a series chunk keeps raw values, source timestamps and status codes; its hash covers every sample', () => {
    const c = chunk();
    expect(SeriesChunkV1.safeParse(c).success).toBe(true);
    expect(seriesChunkText(c).split('\n')).toEqual([
      'EQUIPMENT|PRESS-01|force.main_kN|kN|1',
      '1760000000000000|1760000000000100|1.25E1|12.50|0x00000000',
      '1760000000100000||12.6|12.6|0x40000000',
      '1760000000200000||NaN||0x80000000',
    ]);
    // A changed sample, a rounded shown value or times out of order are refused.
    const tampered = { ...c, samples: c.samples.map((s, i) => (i === 1 ? { ...s, raw: '12.7', value: '12.7' } : s)) };
    expect(SeriesChunkV1.safeParse(tampered).success).toBe(false);
    expect(SeriesChunkV1.safeParse(chunk({ samples: [{ sourceTime: '1', serverTime: null, raw: '12.499', value: '12.50', status: '0x00000000' }] })).success).toBe(false);
    const backwards = chunk({ samples: [c.samples[1]!, c.samples[0]!] });
    expect(SeriesChunkV1.safeParse(backwards).success).toBe(false);
  });

  it('[meta] OPC UA node ids derive from the released tag names, both ways, for every tag', () => {
    for (const tag of PROCESS_TAG_NAMES) {
      const id = opcuaNodeId('PRESS-01', tag);
      expect(parseOpcuaNodeId(id)).toEqual({ equipmentCode: 'PRESS-01', tag });
      expect(OPCUA_TAG_MAP[tag]?.browseName).toBe(tag);
    }
    expect(opcuaNodeId('PRESS-01', 'force.main_kN')).toBe('nsu=urn:ebmr:process:tags:v1;s=PRESS-01/force.main_kN');
    expect(parseOpcuaNodeId('nsu=urn:ebmr:process:tags:v1;s=PRESS-01/force.renamed')).toBeNull();
    expect(parseOpcuaNodeId('ns=2;s=PRESS-01/force.main_kN')).toBeNull();
    expect(() => opcuaNodeId('press 1', 'force.main_kN')).toThrow();
  });

  it('[DI-20] an endpoint is SignAndEncrypt with an enrolled certificate thumbprint and its room; None mode is refused', () => {
    const ep = { endpointUrl: 'opc.tcp://press-01:4840/ua', securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: 'a'.repeat(64), equipmentCodes: ['PRESS-01'], areaCode: 'RM-COMP-1' };
    expect(OpcuaEndpoint.safeParse(ep).success).toBe(true);
    expect(OpcuaEndpoint.safeParse({ ...ep, securityMode: 'None' }).success).toBe(false);
    expect(OpcuaEndpoint.safeParse({ ...ep, certificateThumbprint: undefined }).success).toBe(false);
  });

  it('[DI-49] an alarm occurrence states its transition, code, limit and source time; an equipment event its kind and state', () => {
    const alarm = {
      subjectKind: 'EQUIPMENT', subjectCode: 'PRESS-01', occurrenceId: 'cond-1/evt-7', transition: 'RAISED', alarmCode: 'FORCE_MAIN_HIGH', severity: '800',
      tag: 'force.main_kN', value: { value: '18.40', unit: 'kN' }, limit: { value: '18.00', unit: 'kN' }, limitKind: 'HIGH', message: 'Main compression force high', occurredAt: '1760000000000000',
    };
    expect(EquipmentAlarmV1.safeParse(alarm).success).toBe(true);
    expect(EquipmentAlarmV1.safeParse({ ...alarm, limit: null }).success).toBe(false);
    expect(EquipmentAlarmV1.safeParse({ ...alarm, transition: 'ACKNOWLEDGED' }).success).toBe(false);
    expect(EquipmentAlarmV1.safeParse({ ...alarm, limit: null, limitKind: 'STATE', tag: null, value: null }).success).toBe(true);
    const ev = { equipmentCode: 'PRESS-01', eventId: 'e-1', kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'Running', occurredAt: '1760000000000000' };
    expect(EquipmentEventV1.safeParse(ev).success).toBe(true);
    expect(EquipmentEventV1.safeParse({ ...ev, state: null }).success).toBe(false);
    expect(EquipmentEventV1.safeParse({ ...ev, kind: 'RECIPE_LOADED', state: null }).success).toBe(false);
    expect(DynamicDataRef.safeParse({ kind: 'SERIES', subjectKind: 'AREA', subjectCode: 'RM-1', tag: 'room.rh_pct', fromUs: '2', toUs: '1', batchId: null, step: null }).success).toBe(false);
  });

  it('[meta] the OPCUA and EMS contracts list their message types with version 1 schemas', () => {
    expect(schemaRows(OPCUA).map((r) => r.messageType)).toEqual(['opcua.series_chunk', 'opcua.alarm', 'opcua.equipment_event']);
    expect(schemaRows(EMS).map((r) => r.messageType)).toEqual(['ems.series_chunk', 'ems.alarm']);
    expect(payloadSchema(EMS, { sourceSystem: 'EMS', messageType: 'ems.series_chunk', schemaVersion: '1' })).toBe(SeriesChunkV1);
  });
});
