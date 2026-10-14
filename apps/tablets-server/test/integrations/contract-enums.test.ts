/**
 * The integrations namespace repeats the adapter framework's enums (the contract package may not import the
 * integration SDK); this keeps the two equal (Phase 6 slice 6a-0).
 */
import { InboundErrorClass, IntegrationAlarmKind, IntegrationSourceSystem, MirrorDataClassName, routes } from '@ebmr/api-contract';
import { ALARM_KINDS, ERROR_CLASSES, MIRROR_DATA_CLASSES, SOURCE_SYSTEMS } from '@ebmr/integration-sdk/adapter';
import { describe, expect, it } from 'vitest';

describe('integrations contract and adapter framework', () => {
  it('[meta] the contract enums equal the adapter framework enums', () => {
    expect(IntegrationSourceSystem.options).toEqual([...SOURCE_SYSTEMS]);
    expect(MirrorDataClassName.options).toEqual([...MIRROR_DATA_CLASSES]);
    expect(IntegrationAlarmKind.options).toEqual([...ALARM_KINDS]);
    expect(InboundErrorClass.options).toEqual([...ERROR_CLASSES]);
  });

  it('[meta] the integrations routes are GMP-only reads plus one attributed acknowledgment', () => {
    const all = Object.values(routes.integrations);
    for (const r of all) expect(r.installation, r.id).toBe('GMP');
    expect(all.filter((r) => r.mutating).map((r) => [r.id, r.attribution])).toEqual([['integrations.acknowledgeAlarm', 'FRESH_ON_SHARED']]);
  });
});
