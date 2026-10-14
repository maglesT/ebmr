/**
 * ERP/WMS contract (Phase 6 slice 6a; builder A). JSON with ISA-95/B2MML field names where they exist (D-P6a-2).
 * Inbound: production orders with their BOM, product and material masters, goods receipts with supplier batches
 * (PR-17), stock moves (PR-46), lot status and shipments (distribution records, 6d). Outbound (outbox topics): goods
 * issues, yields, lot status and stock blocks.
 */
import { z } from 'zod';
import { CalendarDate, SourceCode, SourceText, SourceValue, type SystemContract } from '../contract.ts';
import { EpochMicrosText } from '../envelope.ts';

export const ErpBomLine = z.strictObject({ materialCode: SourceCode, quantity: SourceValue });

export const ErpProductionOrderV1 = z.strictObject({
  orderNumber: SourceCode,
  productCode: SourceCode,
  plannedQuantity: SourceValue,
  bom: z.array(ErpBomLine).min(1).max(500),
  plannedStart: EpochMicrosText,
});
export const ErpMaterialMasterV1 = z.strictObject({ materialCode: SourceCode, name: SourceText, baseUnit: SourceValue.shape.unit });
export const ErpProductMasterV1 = z.strictObject({ productCode: SourceCode, name: SourceText, strength: SourceText });

/** One supplier batch of a delivery: becomes one lot (PR-17). */
export const WmsSupplierBatch = z.strictObject({
  supplierLot: SourceCode,
  manufacturerCode: SourceCode,
  containers: z.string().regex(/^[1-9][0-9]{0,5}$/),
  quantity: SourceValue,
  expiryDate: CalendarDate.nullable(),
});
export const WmsGoodsReceiptV1 = z.strictObject({
  deliveryId: SourceCode,
  materialCode: SourceCode,
  supplierCode: SourceCode,
  supplierBatches: z.array(WmsSupplierBatch).min(1).max(100),
  receivedAt: EpochMicrosText,
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
  refusalCodes: {},
};
