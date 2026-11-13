/**
 * Namespace `plant` (Phase 3 slice 6, GMP): plant master data (areas, equipment classes, equipment, tooling sets,
 * detectors, test pieces, utilities) over the plant and tablets definers, and the plant acts recorded from the screens
 * (cleaning, line clearance, equipment events and repairs). The second person's verification of a cleaning, clearance or
 * repair is the signable action PLANT_VERIFY. Every rule is the database's (recipe-core 0400 to 0405, 0460; tablets
 * 0871, 0872).
 *
 * Phase 7 slice 7o (decision D-7o-1): served on both installations, each against its own database, so a master's test run
 * on the sandbox records its plant acts (the sandbox's DEMO-ONLY plant) as a GMP batch does; GMP behaviour is unchanged.
 */
import { z } from 'zod';
import { DecimalString, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';
import { plantFloor } from './plant-floor.ts';

const Code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/);
const Interval = z.string().regex(/^[0-9]{1,5} (minutes|hours|days)$/, 'an interval such as "72 hours"');

export const AreaView = z.strictObject({
  areaId: Uuid,
  code: z.string(),
  kind: z.enum(['ROOM', 'LINE']),
  name: z.string(),
  segregated: z.boolean(),
  negativePressure: z.boolean(),
  state: z.string(),
});
export type AreaView = z.infer<typeof AreaView>;
export const EquipmentClassView = z.strictObject({
  code: z.string(),
  kind: z.enum(['PROCESS', 'INSTRUMENT', 'UTILITY']),
  description: z.string(),
  cleanHold: z.string().nullable(),
  dirtyHold: z.string().nullable(),
  calibrationRequired: z.boolean(),
  checkRegime: z.enum(['PER_USE', 'DAILY']).nullable(),
  cipValidationRef: z.string().nullable(),
});
export type EquipmentClassView = z.infer<typeof EquipmentClassView>;
/**
 * Phase 7 slice 7h (WP-C, gap C4): a product of the plant's product list (plant.product, recipe-core 0400). The list is the
 * plant's own master data, kept by the master-data steward (MASTERDATA.CHANGE): the ERP's item master does not carry
 * whether a product is highly potent, which the clearance and segregation rules read (IN-26 (c)), and tooling sets and
 * equipment campaigns name a product of this list.
 */
export const ProductView = z.strictObject({
  code: z.string(),
  name: z.string(),
  highlyPotent: z.boolean(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type ProductView = z.infer<typeof ProductView>;
export const EquipmentView = z.strictObject({
  equipmentId: Uuid,
  code: z.string(),
  name: z.string(),
  classCode: z.string(),
  kind: z.enum(['PROCESS', 'INSTRUMENT', 'UTILITY']),
  areaCode: z.string().nullable(),
  state: z.string(),
  /** Why the unit may not be used now (the database's fitness check), or null. */
  fitness: z.string().nullable(),
});
export type EquipmentView = z.infer<typeof EquipmentView>;
export const ToolingSetView = z.strictObject({
  setId: Uuid,
  code: z.string(),
  product: z.string(),
  type: z.enum(['B', 'D', 'BB']),
  shape: z.string(),
  upperEmbossing: z.string(),
  lowerEmbossing: z.string(),
  score: z.string(),
  tips: z.number().int(),
  upperPunches: z.number().int(),
  lowerPunches: z.number().int(),
  dies: z.number().int(),
  strokeLimit: z.string(),
});
export type ToolingSetView = z.infer<typeof ToolingSetView>;
export const DetectorView = z.strictObject({
  equipmentId: Uuid,
  code: z.string(),
  name: z.string(),
  device: z.enum(['METAL_DETECTOR', 'REJECT_GATE']),
  classCode: z.string(),
  areaCode: z.string().nullable(),
});
export type DetectorView = z.infer<typeof DetectorView>;
export const TestPieceView = z.strictObject({
  testPieceId: Uuid,
  code: z.string(),
  kind: z.enum(['FERROUS', 'NON_FERROUS', 'STAINLESS', 'REJECT_SAMPLE']),
  size: z.strictObject({ value: DecimalString, unit: z.enum(['mm', 'mg', 'units']) }),
  certificateRef: z.string(),
  certifiedUntil: Instant,
});
export type TestPieceView = z.infer<typeof TestPieceView>;
export const CleaningView = z.strictObject({
  cleaningId: Uuid,
  target: z.enum(['EQUIPMENT', 'AREA']),
  code: z.string(),
  level: z.enum(['MINOR', 'MAJOR']),
  method: z.enum(['MANUAL', 'CIP']),
  state: z.string(),
  startedBy: PersonRef,
  startedAt: Instant,
});
export type CleaningView = z.infer<typeof CleaningView>;
export const ClearanceView = z.strictObject({
  clearanceId: Uuid,
  areaCode: z.string(),
  type: z.enum(['PRODUCT_CHANGE', 'CAMPAIGN', 'PACKAGING_ORDER']),
  batchNumber: z.string(),
  result: z.enum(['PASSED', 'FAILED']),
  state: z.string(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type ClearanceView = z.infer<typeof ClearanceView>;
export const PendingVerificationView = z.strictObject({
  act: z.enum(['CLEANING', 'CLEARANCE', 'REPAIR']),
  id: Uuid,
  /** The equipment or area code. */
  subject: z.string(),
  summary: z.string(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type PendingVerificationView = z.infer<typeof PendingVerificationView>;

const EquipmentEventKind = z.enum([
  'QUALIFIED',
  'QUALIFICATION_WITHDRAWN',
  'MAINTENANCE_STARTED',
  'MAINTENANCE_ENDED',
  'TAKEN_OUT_OF_SERVICE',
  'RETURNED_TO_SERVICE',
  'FAILURE_SIGNALLED',
  'RETIRED',
]);

const list = <K extends string, T extends z.ZodType>(id: string, path: string, summary: string, key: K, item: T) =>
  defineRoute({
    id,
    method: 'GET',
    path,
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary,
    response: z.strictObject({ [key]: z.array(item) } as Record<K, z.ZodArray<T>>),
  });

export const plant = {
  // Phase 7 slice 7h (WP-C, gap C4): the plant's product list and the definition of a product.
  products: list('plant.products', '/api/master-data/plant/products', 'The plant\'s product list, each product with whether it is highly potent', 'products', ProductView),
  defineProduct: defineRoute({
    id: 'plant.defineProduct',
    method: 'POST',
    path: '/api/master-data/plant/products',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Add a product to the plant\'s product list, stating whether it is highly potent (MASTERDATA.CHANGE; IN-26)',
    body: withAttribution({
      code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/),
      name: z.string().trim().min(1).max(200),
      highlyPotent: z.boolean(),
    }),
    response: ProductView,
  }),
  areas: list('plant.areas', '/api/master-data/plant/areas', 'Rooms and lines of the site', 'areas', AreaView),
  defineArea: defineRoute({
    id: 'plant.defineArea',
    method: 'POST',
    path: '/api/master-data/plant/areas',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Define a room or line',
    body: withAttribution({
      code: Code,
      kind: z.enum(['ROOM', 'LINE']),
      name: z.string().trim().min(1).max(200),
      segregated: z.boolean().optional(),
      segregationJustification: z.string().trim().min(1).max(2000).optional(),
      negativePressure: z.boolean().optional(),
    }),
    response: AreaView,
  }),
  equipmentClasses: list('plant.equipmentClasses', '/api/master-data/plant/equipment-classes', 'Equipment classes', 'classes', EquipmentClassView),
  defineEquipmentClass: defineRoute({
    id: 'plant.defineEquipmentClass',
    method: 'POST',
    path: '/api/master-data/plant/equipment-classes',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Define an equipment class (process, instrument or utility) with its hold times and regimes',
    body: withAttribution({
      code: Code,
      kind: z.enum(['PROCESS', 'INSTRUMENT', 'UTILITY']),
      description: z.string().trim().min(1).max(500),
      cleanHold: Interval.optional(),
      dirtyHold: Interval.optional(),
      calibrationRequired: z.boolean().optional(),
      checkRegime: z.enum(['PER_USE', 'DAILY']).optional(),
      cipValidationRef: z.string().trim().min(1).max(128).optional(),
    }),
    response: EquipmentClassView,
  }),
  equipment: list('plant.equipment', '/api/master-data/plant/equipment', 'Process equipment and instruments', 'equipment', EquipmentView),
  defineEquipment: defineRoute({
    id: 'plant.defineEquipment',
    method: 'POST',
    path: '/api/master-data/plant/equipment',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Define a unit of equipment of a class, in an area',
    body: withAttribution({ code: Code, name: z.string().trim().min(1).max(200), classCode: Code, areaCode: Code.optional() }),
    response: EquipmentView,
  }),
  toolingSets: list('plant.toolingSets', '/api/master-data/plant/tooling-sets', 'Punch and die sets of the tooling register', 'toolingSets', ToolingSetView),
  defineToolingSet: defineRoute({
    id: 'plant.defineToolingSet',
    method: 'POST',
    path: '/api/master-data/plant/tooling-sets',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Register a punch and die set for a product',
    body: withAttribution({
      code: Code,
      product: z.string().min(1).max(64),
      type: z.enum(['B', 'D', 'BB']),
      shape: z.string().trim().min(1).max(200),
      upperEmbossing: z.string().trim().min(1).max(200),
      lowerEmbossing: z.string().trim().min(1).max(200),
      score: z.string().trim().min(1).max(200),
      tips: z.number().int().min(1).max(64),
      upperPunches: z.number().int().min(1).max(200),
      lowerPunches: z.number().int().min(1).max(200),
      dies: z.number().int().min(1).max(200),
      strokeLimit: z.string().regex(/^[1-9][0-9]{0,17}$/),
    }),
    response: ToolingSetView,
  }),
  detectors: list('plant.detectors', '/api/master-data/plant/detectors', 'Metal detectors and reject gates', 'detectors', DetectorView),
  defineDetector: defineRoute({
    id: 'plant.defineDetector',
    method: 'POST',
    path: '/api/master-data/plant/detectors',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Define a metal detector or reject gate (a unit of an instrument class, with its device type)',
    body: withAttribution({
      code: Code,
      name: z.string().trim().min(1).max(200),
      device: z.enum(['METAL_DETECTOR', 'REJECT_GATE']),
      classCode: Code,
      areaCode: Code.optional(),
    }),
    response: DetectorView,
  }),
  testPieces: list('plant.testPieces', '/api/master-data/plant/test-pieces', 'Certified test pieces for detector challenges', 'testPieces', TestPieceView),
  defineTestPiece: defineRoute({
    id: 'plant.defineTestPiece',
    method: 'POST',
    path: '/api/master-data/plant/test-pieces',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Register a certified test piece',
    body: withAttribution({
      code: Code,
      kind: z.enum(['FERROUS', 'NON_FERROUS', 'STAINLESS', 'REJECT_SAMPLE']),
      size: z.strictObject({ value: DecimalString, unit: z.enum(['mm', 'mg', 'units']) }),
      certificateRef: z.string().trim().min(1).max(128),
      certifiedUntil: z.iso.datetime({ offset: true }),
    }),
    response: TestPieceView,
  }),
  utilities: list('plant.utilities', '/api/master-data/plant/utilities', 'Utilities (units of a UTILITY class)', 'utilities', EquipmentView),
  defineUtility: defineRoute({
    id: 'plant.defineUtility',
    method: 'POST',
    path: '/api/master-data/plant/utilities',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Define a utility (a unit of a UTILITY class)',
    body: withAttribution({ code: Code, name: z.string().trim().min(1).max(200), classCode: Code, areaCode: Code.optional() }),
    response: EquipmentView,
  }),
  startCleaning: defineRoute({
    id: 'plant.startCleaning',
    method: 'POST',
    path: '/api/plant/cleanings',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Start the cleaning of a unit or an area',
    body: withAttribution({ target: z.enum(['EQUIPMENT', 'AREA']), code: Code, level: z.enum(['MINOR', 'MAJOR']), method: z.enum(['MANUAL', 'CIP']).optional() }),
    response: CleaningView,
  }),
  completeCleaning: defineRoute({
    id: 'plant.completeCleaning',
    method: 'POST',
    path: '/api/plant/cleanings/:id/complete',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Complete a cleaning (a CIP cycle names its reference); a second person verifies it (PLANT_VERIFY)',
    params: z.strictObject({ id: Uuid }),
    body: withAttribution({ cycleReference: z.string().trim().min(1).max(128).optional() }),
    response: CleaningView,
  }),
  recordClearance: defineRoute({
    id: 'plant.recordClearance',
    method: 'POST',
    path: '/api/plant/clearances',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record a line or room clearance and its finding for the next batch; a second person verifies it (PLANT_VERIFY)',
    body: withAttribution({
      areaCode: Code,
      type: z.enum(['PRODUCT_CHANGE', 'CAMPAIGN', 'PACKAGING_ORDER']),
      batchId: Uuid,
      result: z.enum(['PASSED', 'FAILED']),
      order: z.string().trim().min(1).max(64).optional(),
      artworkSet: z.string().trim().min(1).max(64).optional(),
    }),
    response: ClearanceView,
  }),
  equipmentEvent: defineRoute({
    id: 'plant.equipmentEvent',
    method: 'POST',
    path: '/api/plant/equipment/:code/events',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record an equipment logbook event (EVENT with its kind), or the repair of the unit\'s open failure (REPAIR with its work-order reference; verified by a second person, PLANT_VERIFY)',
    params: z.strictObject({ code: Code }),
    body: withAttribution({
      event: z.enum(['EVENT', 'REPAIR']),
      /** EVENT only. */
      kind: EquipmentEventKind.optional(),
      detail: z.string().trim().min(1).max(2000),
      /** Required for a REPAIR (the work order). */
      reference: z.string().trim().min(1).max(128).optional(),
      /** A FAILURE_SIGNALLED from a step names the batch (number) it was signalled in (IN-25 (d)). */
      batchNumber: z.string().trim().min(1).max(64).optional(),
    }),
    response: z.strictObject({ id: Uuid, equipmentCode: z.string(), recorded: z.enum([...EquipmentEventKind.options, 'REPAIR_RECORDED']) }),
  }),
  // ST-33 (tablets 1912): after a failed media fill withdrew a line, the batches made on it since its last successful
  // APS (the impact list) and QA's review of them with the repeat APS runs, which comes before the line is QUALIFIED again.
  apsFailure: defineRoute({
    id: 'plant.apsFailure',
    method: 'GET',
    path: '/api/plant/equipment/:code/aps-failure',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The open withdrawal of a line after a failed media fill (ST-33): the failed batch, the last successful APS, the batches made on the line since, and whether QA has reviewed them; null when there is none',
    params: z.strictObject({ code: Code }),
    response: z.strictObject({
      withdrawal: z
        .strictObject({
          failedBatch: z.string(),
          lastSuccessfulAps: z.string().nullable(),
          withdrawnAt: Instant,
          batches: z.array(z.strictObject({ batchNumber: z.string(), lastUsedAt: Instant })),
          reviewed: z.boolean(),
        })
        .nullable(),
    }),
  }),
  apsFailureReview: defineRoute({
    id: 'plant.apsFailureReview',
    method: 'POST',
    path: '/api/plant/equipment/:code/aps-failure-review',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'QA records the review of a line\'s open withdrawal after a failed media fill (ST-33): the risk assessment of the batches made since the last successful APS, and the successful repeat APS runs (three, or fewer with a justification)',
    params: z.strictObject({ code: Code }),
    body: withAttribution({
      riskAssessmentRef: z.string().trim().min(1).max(128),
      repeatApsRefs: z.array(z.string().trim().min(1).max(128)).min(1).max(50),
      /** Required by the database when fewer than three runs are cited. */
      justification: z.string().trim().min(1).max(2000).optional(),
    }),
    response: z.strictObject({ equipmentCode: z.string(), withdrawalEventId: Uuid }),
  }),
  pendingVerifications: defineRoute({
    id: 'plant.pendingVerifications',
    method: 'GET',
    path: '/api/plant/pending-verifications',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'Cleanings, clearances and repairs recorded and waiting for the second person\'s verification',
    response: z.strictObject({ items: z.array(PendingVerificationView) }),
  }),
  // Phase 7 slice 7h (WP-A): the plant acts a person performs on the floor for a GMP batch (ns/plant-floor.ts).
  ...plantFloor,
} as const;
