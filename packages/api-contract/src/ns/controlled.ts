/**
 * Namespace `controlled` (Phase 6 slice 6e, GMP): controlled-substance mode, draft control IN-53 (status U: the NDPS Act
 * and Rules are not verified). Every rule is the database's (recipe-core 1031 to 1034, site services 0970):
 *
 *  - products: QA records a product's controlled-substance flag and its controlled API materials under an approved change
 *    record (DI-09); a second QA person approves it (CONTROLLED_ACT FLAG_APPROVE, CONTROLLED_PRODUCT_APPROVED). A pending
 *    flag restricts at once; a pending unflagging only once approved.
 *  - custody: a dispensing, transfer, return or destruction of a controlled API lot is proposed by the first custodian, who
 *    signs it (CUSTODY_FIRST, CONTROLLED_CUSTODY_RECORDED), and countersigned by another person (CUSTODY_SECOND,
 *    CONTROLLED_CUSTODY_COUNTERSIGNED; the witness of a destruction). A dispensing is weighed only against a confirmed
 *    record of that lot, batch and exact net, one of whose custodians is the dispenser.
 *  - balance and checkpoints: the account of each controlled material of a batch (dispensed, consumed, in process,
 *    returned, destroyed, difference); a stage sign-off is refused until a signed checkpoint closes it, with no difference
 *    or with an explanation and the batch's deviation (BALANCE_SIGN, CONTROLLED_BALANCE_SIGNED).
 *  - register extracts: the reproducible export of the movements of a controlled material for the statutory registers
 *    (generic layout, D-P6e-3), each with its stored SHA-256 and whether it still reproduces.
 * Every quantity is decimal text in the lot's unit.
 */
import { z } from 'zod';
import { DecimalString, CalendarDate, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const ProductCode = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/);
const MaterialCode = z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/);
const Location = z.string().regex(/^[!-~]{1,64}$/);
const Text = (max: number) => z.string().trim().min(1).max(max);
const IsoDate = CalendarDate();
/** A quantity as entered: a positive or zero decimal, at most 12 integer and 6 fraction digits. */
const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/, 'a decimal quantity such as 1.250');

/** The banner every controlled screen and export shows while the control is a draft. */
export const CONTROLLED_DRAFT_BANNER = 'Draft: NDPS rules not verified (IN-53, status U)';

export const ControlledRecordState = z.enum(['RECORDED', 'APPROVED', 'SUPERSEDED']);
export const ControlledProductView = z.strictObject({
  productCode: z.string(),
  /** The controlled API materials in effect (fail-safe: pending flags included, pending unflagging not). */
  materialsInEffect: z.array(z.string()),
  records: z.array(
    z.strictObject({
      recordId: Uuid,
      controlled: z.boolean(),
      materialCodes: z.array(z.string()),
      basisRef: z.string(),
      recordedBy: PersonRef,
      recordedAt: Instant,
      state: ControlledRecordState,
      approvedBy: PersonRef.nullable(),
      approvedAt: Instant.nullable(),
    }),
  ),
});
export type ControlledProductView = z.infer<typeof ControlledProductView>;

export const CustodyKind = z.enum(['DISPENSE', 'TRANSFER', 'RETURN', 'DESTRUCTION']);
export const CustodyState = z.enum(['PROPOSED', 'AWAITING_COUNTERSIGN', 'CONFIRMED']);
export const CustodyView = z.strictObject({
  custodyId: Uuid,
  kind: CustodyKind,
  lotId: Uuid,
  lotCode: z.string(),
  materialCode: z.string(),
  quantity: DecimalString,
  unit: z.string(),
  batchId: Uuid.nullable(),
  batchNumber: z.string().nullable(),
  fromLocation: z.string().nullable(),
  toLocation: z.string().nullable(),
  note: z.string().nullable(),
  proposedBy: PersonRef,
  proposedAt: Instant,
  state: CustodyState,
  custodians: z.array(z.strictObject({ position: z.enum(['FIRST', 'SECOND']), person: PersonRef, at: Instant })),
  /** A confirmed dispensing or transfer has covered its consumption or WMS move (once). */
  used: z.boolean(),
});
export type CustodyView = z.infer<typeof CustodyView>;

export const CheckpointState = z.enum(['RECORDED', 'SIGNED', 'SUPERSEDED']);
export const CheckpointView = z.strictObject({
  checkpointId: Uuid,
  stageKey: z.string(),
  materialCode: z.string(),
  unit: z.string(),
  dispensed: DecimalString,
  consumed: DecimalString,
  inProcess: DecimalString,
  returned: DecimalString,
  destroyed: DecimalString,
  difference: DecimalString,
  explanation: z.string().nullable(),
  deviationId: Uuid.nullable(),
  deviationRef: z.string().nullable(),
  recordedBy: PersonRef,
  recordedAt: Instant,
  state: CheckpointState,
  /** The account has not moved since the checkpoint was recorded. */
  current: z.boolean(),
});
export type CheckpointView = z.infer<typeof CheckpointView>;

export const ControlledBalanceView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  productCode: z.string().nullable(),
  banner: z.string(),
  materials: z.array(
    z.strictObject({
      materialCode: z.string(),
      /** Null while the account holds no movement (or more than one unit). */
      unit: z.string().nullable(),
      dispensed: DecimalString,
      returned: DecimalString,
      destroyed: DecimalString,
      checkpoints: z.array(CheckpointView),
    }),
  ),
});
export type ControlledBalanceView = z.infer<typeof ControlledBalanceView>;

export const RegisterRow = z.strictObject({
  at: z.string(),
  movement: z.enum(['RECEIPT', 'TRANSFER', 'DISPENSE', 'RETURN', 'DESTRUCTION', 'LOT_DESTRUCTION']),
  ref: Uuid,
  lot: z.string(),
  quantity: DecimalString,
  unit: z.string(),
  batch: z.string().nullable(),
  persons: z.array(Uuid.nullable()),
  detail: z.string().nullable(),
});
export const RegisterExtractSummary = z.strictObject({
  extractId: Uuid,
  materialCode: z.string(),
  from: IsoDate,
  to: IsoDate,
  resultSha256: z.string().regex(/^[0-9a-f]{64}$/),
  runBy: PersonRef,
  runAt: Instant,
  rows: z.number().int().nonnegative(),
});
export const RegisterExtractView = RegisterExtractSummary.extend({
  banner: z.string(),
  /** The query run again now gives the same hash. */
  reproduces: z.boolean(),
  result: z.strictObject({
    queryVersion: z.literal(1),
    materialCode: z.string(),
    from: IsoDate,
    to: IsoDate,
    statusNote: z.string(),
    rows: z.array(RegisterRow),
    totals: z.record(z.string(), DecimalString),
  }),
});
export type RegisterExtractView = z.infer<typeof RegisterExtractView>;

export const controlled = {
  products: defineRoute({
    id: 'controlled.products',
    method: 'GET',
    path: '/api/controlled/products',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Products with a controlled-substance flag record: the materials in effect and every record, latest first (IN-53)',
    response: z.strictObject({ banner: z.string(), products: z.array(ControlledProductView) }),
  }),
  recordProduct: defineRoute({
    id: 'controlled.recordProduct',
    method: 'POST',
    path: '/api/controlled/products',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record a product\'s controlled-substance flag and its controlled API materials under an approved change record (QA; IN-53, DI-09)',
    body: withAttribution({
      productCode: ProductCode,
      controlled: z.boolean(),
      materialCodes: z.array(MaterialCode).max(20),
      basisRef: Text(200),
      changeRecord: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/),
    }),
    response: ControlledProductView,
  }),
  custody: defineRoute({
    id: 'controlled.custody',
    method: 'GET',
    path: '/api/controlled/custody',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Custody records of a controlled API lot or of a batch, latest first (IN-53)',
    query: z.strictObject({ lotId: Uuid.optional(), batchId: Uuid.optional() }),
    response: z.strictObject({ banner: z.string(), records: z.array(CustodyView) }),
  }),
  proposeCustody: defineRoute({
    id: 'controlled.proposeCustody',
    method: 'POST',
    path: '/api/controlled/custody',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Propose a dual-custody record (the first custodian): a dispensing, transfer, return or destruction of a controlled API lot (IN-53)',
    body: withAttribution({
      kind: CustodyKind,
      lotId: Uuid,
      quantity: Quantity,
      batchId: Uuid.optional(),
      fromLocation: Location.optional(),
      toLocation: Location.optional(),
      note: Text(2000).optional(),
    }),
    response: CustodyView,
  }),
  balance: defineRoute({
    id: 'controlled.balance',
    method: 'GET',
    path: '/api/controlled/batches/:batchId/balance',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The controlled-API account of a batch per material, with its yield checkpoints (IN-53)',
    params: z.strictObject({ batchId: Uuid }),
    response: ControlledBalanceView,
  }),
  recordCheckpoint: defineRoute({
    id: 'controlled.recordCheckpoint',
    method: 'POST',
    path: '/api/controlled/checkpoints',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record the controlled-API account at a yield checkpoint; a difference needs an explanation and the batch\'s deviation (IN-53)',
    body: withAttribution({
      batchId: Uuid,
      stageKey: z.string().regex(/^[!-~]{1,200}$/),
      materialCode: MaterialCode,
      consumed: Quantity,
      inProcess: Quantity,
      explanation: Text(4000).optional(),
      deviationId: Uuid.optional(),
    }),
    response: CheckpointView,
  }),
  registerExtracts: defineRoute({
    id: 'controlled.registerExtracts',
    method: 'GET',
    path: '/api/controlled/register-extracts',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The register exports run, latest first (IN-53)',
    response: z.strictObject({ banner: z.string(), extracts: z.array(RegisterExtractSummary) }),
  }),
  runRegister: defineRoute({
    id: 'controlled.runRegister',
    method: 'POST',
    path: '/api/controlled/register-extracts',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Run the register export of a controlled material for a period of UTC days; the result and its SHA-256 are stored (IN-53, D-P6e-3)',
    body: withAttribution({ materialCode: MaterialCode, from: IsoDate, to: IsoDate }),
    response: RegisterExtractView,
  }),
  registerExtract: defineRoute({
    id: 'controlled.registerExtract',
    method: 'GET',
    path: '/api/controlled/register-extracts/:extractId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One register export with its rows and whether it still reproduces (the same hash now)',
    params: z.strictObject({ extractId: Uuid }),
    response: RegisterExtractView,
  }),
} as const;
