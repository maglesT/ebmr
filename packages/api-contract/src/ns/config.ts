/**
 * Namespace `config` (Phase 6 slice 6f, builder A, GMP): configuration change control (DI-09; kernel 1195) and the
 * review-by-exception rules (DI-26, PR-52; recipe-core 1050).
 *
 *  - A change record (its number is the change-record id people cite) names the configuration areas it may change. It
 *    is raised (CONFIG.CHANGE_RAISE), approved by another person of the quality unit with an e-signature (signable action
 *    CONFIG_CHANGE_ACT APPROVE, meaning CONFIG_CHANGE_APPROVED, state OPEN) and closed. Every configuration change names
 *    an approved, open change record that covers its area; the database refuses it otherwise (EBMR-CFG-001 to -004).
 *  - Every configuration row is an insert-only version with the instant it became valid: the configuration of any past
 *    instant (`asOf`) and what changed between two instants with the change records in between (`diff`) are reads.
 *  - Platform settings (among them the adapter modes and mirror freshness bounds of slice 6a) and the RBE rules are
 *    changed here, each under a change record.
 *
 * Signed act (signable action CONFIG_CHANGE_ACT, signable.ts), aggregate `config_change_record`:
 *    config_change_record <number>   CONFIG_CHANGE_APPROVED (QA, never the raiser), state OPEN   platform.approve_change_record
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

export const ChangeRecordNumber = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'a change-record number (letters, digits, . _ / -)');
export const ConfigAreaCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
export const ChangeRecordState = z.enum(['OPEN', 'APPROVED', 'CLOSED']);
/** An instant as ISO 8601 with its offset, e.g. 2026-10-15T09:30:00+05:30. */
export const IsoInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/, 'an ISO 8601 instant with its offset');
export const RbeSeverity = z.enum(['ALERT', 'ACTION', 'CRITICAL']);

export const ChangeRecordView = z.strictObject({
  changeRecordId: Uuid,
  number: ChangeRecordNumber,
  title: z.string(),
  description: z.string(),
  areas: z.array(ConfigAreaCode),
  state: ChangeRecordState,
  raisedBy: PersonRef,
  raisedAt: Instant,
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
  closedAt: Instant.nullable(),
  /** The CONFIG_CHANGE_APPROVED signature's record (signable action CONFIG_CHANGE_ACT APPROVE). */
  signable: z.strictObject({
    aggregateType: z.literal('config_change_record'),
    aggregateId: ChangeRecordNumber,
    meaning: z.literal('CONFIG_CHANGE_APPROVED'),
    expectedState: z.literal('OPEN'),
  }),
});
export type ChangeRecordView = z.infer<typeof ChangeRecordView>;

/** One configuration item's version: its value columns (as the database stores them), from when it is valid. */
export const ConfigItemView = z.strictObject({
  area: ConfigAreaCode,
  itemKey: z.string(),
  value: z.record(z.string(), z.unknown()),
  validFrom: z.string(),
  basis: z.enum(['CHANGE_RECORD', 'RELEASE', 'BEFORE_CONTROL', 'PLATFORM_REGISTER']),
  changeRecord: z.string().nullable(),
});
export type ConfigItemView = z.infer<typeof ConfigItemView>;

export const ConfigDifferenceView = z.strictObject({
  area: ConfigAreaCode,
  itemKey: z.string(),
  /** null: the item had no version at the first instant. */
  before: z.record(z.string(), z.unknown()).nullable(),
  /** null: the item had no version at the second instant. */
  after: z.record(z.string(), z.unknown()).nullable(),
  changeRecords: z.array(z.string()),
});
export type ConfigDifferenceView = z.infer<typeof ConfigDifferenceView>;

export const PlatformSettingView = z.strictObject({
  key: z.string(),
  value: z.string(),
  defaultValue: z.string(),
  valueType: z.enum(['DECIMAL', 'INTEGER', 'TEXT']),
  allowedValues: z.array(z.string()).nullable(),
  /** Decimal strings (GMP values never travel as JSON numbers). */
  minValue: z.string().nullable(),
  maxValue: z.string().nullable(),
  unit: z.string().nullable(),
  description: z.string(),
  basis: z.string(),
});
export type PlatformSettingView = z.infer<typeof PlatformSettingView>;

export const RbeRuleView = z.strictObject({
  category: z.string(),
  mandatory: z.boolean(),
  included: z.boolean(),
  minSeverity: RbeSeverity,
  /** null: no rule version yet (listed, severity as raised). */
  version: z.number().int().positive().nullable(),
  rationale: z.string().nullable(),
  validFrom: z.string().nullable(),
});
export type RbeRuleView = z.infer<typeof RbeRuleView>;

const recordParams = z.strictObject({ number: ChangeRecordNumber });

export const config = {
  areas: defineRoute({
    id: 'config.areas',
    method: 'GET',
    path: '/api/config/areas',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The configuration areas under change control (DI-09)',
    response: z.strictObject({ areas: z.array(z.strictObject({ code: ConfigAreaCode, table: z.string(), description: z.string() })) }),
  }),
  changeRecords: defineRoute({
    id: 'config.changeRecords',
    method: 'GET',
    path: '/api/config/change-records',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Configuration change records, newest first, with their state',
    query: z.strictObject({ state: ChangeRecordState.optional() }),
    response: z.strictObject({ changeRecords: z.array(ChangeRecordView) }),
  }),
  raiseChangeRecord: defineRoute({
    id: 'config.raiseChangeRecord',
    method: 'POST',
    path: '/api/config/change-records',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Raise a configuration change record naming the areas it may change (CONFIG.CHANGE_RAISE)',
    body: withAttribution({
      number: ChangeRecordNumber,
      title: z.string().trim().min(1).max(500),
      description: z.string().trim().min(1).max(4000),
      areas: z.array(ConfigAreaCode).min(1),
    }),
    response: ChangeRecordView,
  }),
  closeChangeRecord: defineRoute({
    id: 'config.closeChangeRecord',
    method: 'POST',
    path: '/api/config/change-records/:number/closure',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Close a change record: nothing changes under it afterwards (CONFIG.CHANGE_CLOSE)',
    params: recordParams,
    body: withAttribution({ note: z.string().trim().min(1).max(2000) }),
    response: ChangeRecordView,
  }),
  asOf: defineRoute({
    id: 'config.asOf',
    method: 'GET',
    path: '/api/config/as-of',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The configuration valid at an instant (DI-09: any past date), optionally of one area',
    query: z.strictObject({ at: IsoInstant, area: ConfigAreaCode.optional() }),
    response: z.strictObject({ at: z.string(), items: z.array(ConfigItemView) }),
  }),
  diff: defineRoute({
    id: 'config.diff',
    method: 'GET',
    path: '/api/config/diff',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'What configuration differs between two instants, with the change records in between (DI-09)',
    query: z.strictObject({ from: IsoInstant, to: IsoInstant, area: ConfigAreaCode.optional() }),
    response: z.strictObject({ from: z.string(), to: z.string(), differences: z.array(ConfigDifferenceView) }),
  }),
  settings: defineRoute({
    id: 'config.settings',
    method: 'GET',
    path: '/api/config/settings',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Platform settings with their definitions and current values (adapter modes, mirror freshness bounds, reading ages)',
    response: z.strictObject({ settings: z.array(PlatformSettingView) }),
  }),
  setSetting: defineRoute({
    id: 'config.setSetting',
    method: 'POST',
    path: '/api/config/settings/:key',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Change a platform setting under an approved change record covering PLATFORM_SETTING (PLATFORM.SETTINGS_CHANGE)',
    params: z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/) }),
    body: withAttribution({ value: z.string().trim().min(1).max(200), changeRecord: ChangeRecordNumber, reason: z.string().trim().min(1).max(2000) }),
    response: PlatformSettingView,
  }),
  rbeRules: defineRoute({
    id: 'config.rbeRules',
    method: 'GET',
    path: '/api/config/rbe-rules',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The review-by-exception rule of every review category in force now or at a past instant (DI-26)',
    query: z.strictObject({ at: IsoInstant.optional() }),
    response: z.strictObject({ rules: z.array(RbeRuleView) }),
  }),
  setRbeRule: defineRoute({
    id: 'config.setRbeRule',
    method: 'POST',
    path: '/api/config/rbe-rules/:category',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'A new version of a category\'s RBE rule under an approved change record covering RBE_RULE (REVIEW.RBE_RULE_CHANGE); a mandatory category stays listed',
    params: z.strictObject({ category: z.string().regex(/^[A-Z][A-Z_]{1,39}$/) }),
    body: withAttribution({ included: z.boolean(), minSeverity: RbeSeverity, rationale: z.string().trim().min(1).max(2000), changeRecord: ChangeRecordNumber }),
    response: RbeRuleView,
  }),
} as const;
