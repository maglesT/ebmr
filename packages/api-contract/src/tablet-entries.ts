/**
 * The block entry kinds the browser may send as a BLOCK_ENTRY (Phase 3 slice 6, D-S6-2): every entry kind of the
 * tablet blocks TB-01 to TB-24 and of G-06@1, G-21@1 and G-24@2, as the edition's block registry declares them
 * (apps/tablets-server/test/execution/gmp-batch-routes.test.ts proves both lists equal the registry's).
 *
 * One generic variant with a closed kind instead of one typed variant per kind: the engine's block schemas stay the
 * single source of the fields, and the database's guards stay the deciders. Kinds whose facts the server resolves
 * have their own typed variant (CONTAINER_WEIGHING, POTENCY_CALCULATION); the server refuses them as a BLOCK_ENTRY.
 */
import { z } from 'zod';

/** The entry kinds of each block version, in the registry's order (for schema-driven renderers). */
export const TABLET_ENTRY_KINDS_BY_BLOCK = {
  'G-06@1': ['SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK'],
  'G-21@1': ['ISSUE', 'RECONCILIATION', 'FIRST_PRINT', 'CHALLENGE', 'SERIAL_POOL', 'SERIAL_RECONCILIATION'],
  'G-24@2': ['ADDITION'],
  'TB-01@1': ['POTENCY_CALCULATION', 'CONTAINER_WEIGHING'],
  'TB-02@1': ['SCREEN_CHECK', 'MATERIAL_PASS'],
  'TB-03@1': ['PREPARED', 'DISCARD'],
  'TB-04@1': ['SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'MASSING_START', 'END_POINT', 'BINDER_ADDITION', 'EXTRA_FLUID'],
  'TB-05@1': ['SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'DRYING_START', 'DRYING_END', 'LOD_SAMPLE', 'BAG_CHECK'],
  'TB-06@1': [
    'SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'RUN_START', 'FEED', 'RIBBON_CHECK', 'SCREEN_CHECK', 'GRANULE_OUTPUT',
    'FINES_RECYCLED', 'RUN_END', 'YIELD',
  ],
  'TB-07@1': ['SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'BLEND_START', 'BLEND_END', 'LUBRICANT_ADDED', 'LUBRICATION_END', 'BU_SAMPLE'],
  'TB-08@1': ['ADDITION'],
  'TB-09@1': ['TOOLING_INSPECTED', 'TOOLING_ISSUED', 'TOOLING_RETURNED'],
  'TB-10@1': ['SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'PRESS_SETUP', 'PRE_USE_CHECKLIST', 'HOPPER_CHARGE', 'FIRST_OFF', 'SETTING_CHANGE'],
  'TB-11@1': [
    'RUN_START', 'STOPPAGE_START', 'STOPPAGE_END', 'CHANGE', 'RUN_END', 'STATION_SWEEP', 'WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN',
    'DT_START', 'DT_END',
  ],
  'TB-12@1': ['WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE'],
  'TB-13@1': ['PHYSICAL_CHECK'],
  'TB-14@1': ['FRIABILITY_RUN'],
  'TB-15@1': ['DT_START', 'DT_END'],
  'TB-16@1': [
    'SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'HOPPER_CHARGE', 'RUN_START', 'STOPPAGE_START', 'STOPPAGE_END', 'CHANGE',
    'RUN_END', 'STATION_SWEEP', 'WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_START', 'DT_END',
  ],
  'TB-17@1': ['SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'CHALLENGE', 'REJECT_COUNT', 'DEDUSTING'],
  'TB-18@1': [
    'SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'ROOM_CHECK', 'PAN_LOAD', 'CORE_SAMPLE', 'SPRAY_START', 'SPRAY_END',
    'SUSPENSION_USED', 'APPLICATION', 'WEIGHT_CHECK',
  ],
  'TB-19@1': ['PRINT_SETUP', 'PRINT_CHECK'],
  'TB-20@1': ['INSPECTION_START', 'INSPECTION_END', 'SORT_RESULT', 'AQL_RESULT'],
  'TB-21@1': [
    'SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'LINE_SETUP', 'EQUIPMENT_CHECK', 'RUN_START', 'REEL_CHANGE', 'DEFECT_CHECK',
    'REJECTS', 'RUN_END', 'COUNT',
  ],
  'TB-22@1': ['RUN_START', 'EVENT', 'LEAK_TEST', 'RUN_END'],
  'TB-23@1': ['COUNT_CHECK', 'DESICCANT_CHECK', 'TORQUE_CHECK', 'SEAL_CHECK', 'CHALLENGE', 'REJECTS', 'BRIGHT_STOCK', 'BRIGHT_STOCK_USE', 'GOOD_OUTPUT'],
  'TB-24@1': ['CHALLENGE', 'ATD_CHECK', 'EXAMINATION', 'PACKS_MADE', 'REJECTS', 'PACK_SAMPLE', 'SET_ASIDE', 'RE_ENTRY', 'SHIPPER', 'RECONCILIATION'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type TabletEntryBlock = keyof typeof TABLET_ENTRY_KINDS_BY_BLOCK;

const ALL_KINDS = [...new Set(Object.values(TABLET_ENTRY_KINDS_BY_BLOCK).flat())].sort() as [
  (typeof TABLET_ENTRY_KINDS_BY_BLOCK)[TabletEntryBlock][number],
  ...(typeof TABLET_ENTRY_KINDS_BY_BLOCK)[TabletEntryBlock][number][],
];

/** Every entry kind of the blocks above (closed). */
export const TabletEntryKind = z.enum(ALL_KINDS);
export type TabletEntryKind = z.infer<typeof TabletEntryKind>;

/** Kinds with a typed ClientEntry variant of their own (server-resolved lots and readings): refused as a BLOCK_ENTRY. */
export const TYPED_ENTRY_KINDS: readonly TabletEntryKind[] = ['CONTAINER_WEIGHING', 'POTENCY_CALCULATION'];

/**
 * A block's entry schema as JSON (recipe-core blocks/schema.ts FieldSchema, with a pattern as its source text), so the
 * browser renders the entry form from the engine's own definition. A member marked `serverFilled` is a fact the server
 * reads (database or device) and the form never asks for: the server refuses or overwrites a value sent for it.
 */
export type BlockFieldSchemaWire =
  | { type: 'string'; description: string; enum?: string[] | undefined; pattern?: string | undefined; optional?: boolean | undefined; serverFilled?: boolean | undefined }
  | { type: 'decimal'; description: string; min?: string | undefined; minExclusive?: boolean | undefined; optional?: boolean | undefined; serverFilled?: boolean | undefined }
  | { type: 'integer'; description: string; min?: number | undefined; max?: number | undefined; optional?: boolean | undefined; serverFilled?: boolean | undefined }
  | { type: 'boolean'; description: string; optional?: boolean | undefined; default?: boolean | undefined; defaultText?: string | undefined; serverFilled?: boolean | undefined }
  | BlockObjectSchemaWire
  | { type: 'array'; description: string; items: BlockFieldSchemaWire; minItems?: number | undefined; maxItems?: number | undefined; optional?: boolean | undefined; serverFilled?: boolean | undefined }
  | { type: 'record'; description: string; values: BlockFieldSchemaWire; optional?: boolean | undefined; serverFilled?: boolean | undefined };
export interface BlockObjectSchemaWire {
  type: 'object';
  description: string;
  fields: Record<string, BlockFieldSchemaWire>;
  optional?: boolean | undefined;
  serverFilled?: boolean | undefined;
}

const flags = { optional: z.boolean().optional(), serverFilled: z.boolean().optional() };
export const BlockObjectSchemaWire: z.ZodType<BlockObjectSchemaWire> = z.lazy(() =>
  z.strictObject({ type: z.literal('object'), description: z.string(), fields: z.record(z.string(), BlockFieldSchemaWire), ...flags }),
);
export const BlockFieldSchemaWire: z.ZodType<BlockFieldSchemaWire> = z.lazy(() =>
  z.union([
    z.strictObject({ type: z.literal('string'), description: z.string(), enum: z.array(z.string()).optional(), pattern: z.string().optional(), ...flags }),
    z.strictObject({ type: z.literal('decimal'), description: z.string(), min: z.string().optional(), minExclusive: z.boolean().optional(), ...flags }),
    z.strictObject({ type: z.literal('integer'), description: z.string(), min: z.number().int().optional(), max: z.number().int().optional(), ...flags }),
    z.strictObject({ type: z.literal('boolean'), description: z.string(), default: z.boolean().optional(), defaultText: z.string().optional(), ...flags }),
    BlockObjectSchemaWire,
    z.strictObject({ type: z.literal('array'), description: z.string(), items: BlockFieldSchemaWire, minItems: z.number().int().optional(), maxItems: z.number().int().optional(), ...flags }),
    z.strictObject({ type: z.literal('record'), description: z.string(), values: BlockFieldSchemaWire, ...flags }),
  ]),
);

/** One entry kind a step offers as a BLOCK_ENTRY, with the block's own schema (Phase 3 slice 6). */
export const BlockEntryFormView = z.strictObject({
  kind: TabletEntryKind,
  title: z.string(),
  description: z.string(),
  schema: BlockObjectSchemaWire,
});
export type BlockEntryFormView = z.infer<typeof BlockEntryFormView>;
