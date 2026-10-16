/**
 * The alarms and equipmentData namespaces repeat the equipment-data enums of the integration SDK (the contract package
 * may not import it: browser-safe rule); this keeps them equal (Phase 6 slice 6b-0).
 */
import { AlarmLimitKind, AlarmSubjectKind, EquipmentEventView, routes, SeriesSubjectKind } from '@ebmr/api-contract';
import { EQUIPMENT_EVENT_KINDS, EQUIPMENT_STATES, LIMIT_KINDS, SUBJECT_KINDS } from '@ebmr/integration-sdk/adapter';
import { describe, expect, it } from 'vitest';

describe('alarms and equipment-data contracts and the integration SDK', () => {
  it('[meta] the contract enums equal the SDK equipment-data enums', () => {
    expect(AlarmLimitKind.options).toEqual([...LIMIT_KINDS]);
    expect(AlarmSubjectKind.options).toEqual([...SUBJECT_KINDS]);
    expect(SeriesSubjectKind.options).toEqual([...SUBJECT_KINDS]);
    expect(EquipmentEventView.shape.kind.options).toEqual([...EQUIPMENT_EVENT_KINDS]);
    expect(EquipmentEventView.shape.state.unwrap().options).toEqual([...EQUIPMENT_STATES]);
  });

  it('[meta] the alarms and equipment-data routes are GMP-only reads plus one attributed acknowledgment', () => {
    const all = [...Object.values(routes.alarms), ...Object.values(routes.equipmentData)];
    for (const r of all) expect(r.installation, r.id).toBe('GMP');
    expect(all.filter((r) => r.mutating).map((r) => [r.id, r.attribution])).toEqual([['alarms.acknowledge', 'FRESH_ON_SHARED']]);
  });
});
