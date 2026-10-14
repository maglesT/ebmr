/**
 * ERP/WMS contract (Phase 6 slice 6a; builder A). JSON with ISA-95/B2MML field names where they exist (D-P6a-2).
 * Inbound: production orders with their BOM, product and material masters, goods receipts with supplier batches
 * (PR-17), stock moves (PR-46), lot status and shipments (distribution records, 6d). Outbound (outbox topics): goods
 * issues, yields, lot status and stock blocks.
 */
import { z } from 'zod';
import { CalendarDate, SourceCode, SourceText, SourceValue, type SystemContract } from '../contract.ts';
import type { ErrorClass } from '../errors.ts';
import { EpochMicrosText } from '../envelope.ts';

export const ErpBomLine = z.strictObject({ materialCode: SourceCode, quantity: SourceValue });

/**
 * Slice 6a builder A added optional fields (additive, version 1 unchanged for existing senders): the receiving command
 * (site services 0913) needs them to apply the message, and refuses it as MALFORMED (EBMR-ERP-001) without them.
 */
export const ErpProductionOrderV1 = z.strictObject({
  orderNumber: SourceCode,
  productCode: SourceCode,
  /** Needed by the receiving command (the order is for one strength of the product). */
  strength: SourceText.optional(),
  plannedQuantity: SourceValue,
  bom: z.array(ErpBomLine).min(1).max(500),
  plannedStart: EpochMicrosText,
});
export const MATERIAL_KINDS = ['API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING', 'INTERMEDIATE', 'FINISHED'] as const;
const WholeMonths = z.string().regex(/^[1-9][0-9]{0,2}$/, 'whole months as text');
export const ErpMaterialMasterV1 = z.strictObject({
  materialCode: SourceCode,
  name: SourceText,
  baseUnit: SourceValue.shape.unit,
  /** Needed by the receiving command (QA confirms a new or changed kind, site services 0802). */
  materialKind: z.enum(MATERIAL_KINDS).optional(),
  maxRetestMonths: WholeMonths.optional(),
});
export const ErpProductMasterV1 = z.strictObject({
  productCode: SourceCode,
  name: SourceText,
  strength: SourceText,
  /** Needed by the receiving command. */
  betaLactam: z.boolean().optional(),
  shelfLifeMonths: WholeMonths.optional(),
  reprocessingPermitted: z.boolean().optional(),
});

/** One supplier batch of a delivery: becomes one lot (PR-17). */
export const WmsSupplierBatch = z.strictObject({
  supplierLot: SourceCode,
  manufacturerCode: SourceCode,
  containers: z.string().regex(/^[1-9][0-9]{0,5}$/),
  quantity: SourceValue,
  /** Required by the receiving command (a lot is received with its expiry, PR-18); null is refused as MALFORMED. */
  expiryDate: CalendarDate.nullable(),
  retestDate: CalendarDate.nullable().optional(),
});
export const WmsGoodsReceiptV1 = z.strictObject({
  deliveryId: SourceCode,
  materialCode: SourceCode,
  supplierCode: SourceCode,
  supplierBatches: z.array(WmsSupplierBatch).min(1).max(100),
  receivedAt: EpochMicrosText,
  /** The name on the delivery note (part of the receipt record, PR-17). */
  deliveryNoteName: SourceText.optional(),
});
/** A move the WMS reports; one that already happened against the location rule raises an alarm (D-P6a-7). */
export const WmsStockMoveV1 = z.strictObject({
  lotNumber: SourceCode,
  fromLocation: SourceCode,
  toLocation: SourceCode,
  toLocationKind: z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'PRODUCTION', 'RETURNS']),
  quantity: SourceValue,
  movedAt: EpochMicrosText,
});
export const WmsLotStatusV1 = z.strictObject({ lotNumber: SourceCode, status: z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED']) });
export const ErpShipmentV1 = z.strictObject({
  shipmentId: SourceCode,
  lotNumber: SourceCode,
  consigneeCode: SourceCode,
  consigneeName: SourceText,
  consigneeAddress: SourceText,
  quantity: SourceValue,
  shippedAt: EpochMicrosText,
});

/**
 * The EBMR codes the receiving command (site.erp_wms_receive, site services 0913) and the domain commands it calls raise,
 * with their class. A code missing here is unclassified: the worker alarms and does not retry it.
 */
export const ERP_WMS_REFUSAL_CODES: Readonly<Record<string, ErrorClass>> = {
  'EBMR-ERP-001': 'MALFORMED',
  'EBMR-ERP-002': 'WRONG_IDENTITY',
  'EBMR-ERP-003': 'OUT_OF_RANGE',
  'EBMR-ERP-004': 'STALE',
  'EBMR-ERP-010': 'WRONG_IDENTITY',
  // Receipt (site services 0750, 0910) and the location rule (0911).
  'EBMR-SITE-104': 'OUT_OF_RANGE',
  'EBMR-SITE-105': 'WRONG_IDENTITY',
  'EBMR-SITE-171': 'WRONG_IDENTITY',
  'EBMR-SITE-172': 'WRONG_IDENTITY',
  'EBMR-SITE-914': 'MALFORMED',
  'EBMR-SITE-915': 'OUT_OF_RANGE',
  'EBMR-SITE-919': 'MALFORMED',
  // Masters and orders (site services 0802).
  'EBMR-SITE-170': 'MALFORMED',
  'EBMR-SITE-175': 'MALFORMED',
  'EBMR-SITE-176': 'MALFORMED',
  'EBMR-SITE-340': 'MALFORMED',
};

/** One pending outbound message as site.erp_outbound_pending lists it (site services 0912). */
export const ErpOutboundMessage = z.strictObject({
  messageId: z.uuid(),
  topic: z.enum(['erp.goods_issue', 'erp.yield', 'erp.lot_status', 'erp.stock_block']),
  lotId: z.uuid(),
  payload: z.record(z.string(), z.unknown()),
  attempts: z.string().regex(/^(0|[1-9][0-9]*)$/),
  createdAtUs: EpochMicrosText,
});
export type ErpOutboundMessage = z.infer<typeof ErpOutboundMessage>;

export const ERP_WMS: SystemContract = {
  system: 'ERP_WMS',
  inbound: {
    'erp.production_order': { summary: 'A production order with its BOM (compared with the MBR BOM at issue)', versions: { '1': ErpProductionOrderV1 } },
    'erp.material_master': { summary: 'A material master (QA confirms before use)', versions: { '1': ErpMaterialMasterV1 } },
    'erp.product_master': { summary: 'A product master (QA confirms before use)', versions: { '1': ErpProductMasterV1 } },
    'wms.goods_receipt': { summary: 'A delivery with its supplier batches (one lot each, PR-17)', versions: { '1': WmsGoodsReceiptV1 } },
    'wms.stock_move': { summary: 'A stock move between locations (PR-46)', versions: { '1': WmsStockMoveV1 } },
    'wms.lot_status': { summary: 'The WMS status of a lot (mirror data class ERP_LOT_STATUS)', versions: { '1': WmsLotStatusV1 } },
    'erp.shipment': { summary: 'A shipment of a finished lot to a consignee (distribution record, 6d)', versions: { '1': ErpShipmentV1 } },
  },
  outbound: ['erp.goods_issue', 'erp.yield', 'erp.lot_status', 'erp.stock_block'],
  refusalCodes: ERP_WMS_REFUSAL_CODES,
};
